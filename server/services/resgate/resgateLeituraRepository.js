// server/services/resgate/resgateLeituraRepository.js
//
// Leituras do Resgate — SOMENTE SELECT. Todas as consultas são limitadas por
// conta (cliente_conta_id) e paginadas por keyset (item_id), com
// statement_timeout próprio, para a auditoria global não varrer o banco nem
// segurar conexões (incidentes de PG de out–nov/2026). Nada aqui seleciona
// tokens nem dados de compradores (só item, preço, quantidade, data e frete).

const TIMEOUT_MS = 15000;

/** Competências (AAAA-MM) cobertas por uma janela de `dias` até `agora`. */
function competenciasJanela(agora, dias) {
  const c = (d) => d.toISOString().slice(0, 7);
  return [...new Set([c(agora), c(new Date(agora.getTime() - dias * 86400000))])];
}

async function consultar(db, sql, params) {
  // SET LOCAL só vale dentro de transação; aqui usamos o parâmetro por sessão
  // quando o cliente é dedicado, e por consulta (statement_timeout) via comentário
  // é impossível — então o chamador passa um client com timeout já definido
  // (ver criarConexaoLeitura) ou um pool cujo statement_timeout é configurado.
  return db.query(sql, params);
}

/** Contas Mercado Livre (sem nenhum campo de token). `clienteIds` opcional (carteira). */
async function listarContasMeli(db, { clienteIds = null } = {}) {
  const filtro = Array.isArray(clienteIds) ? "AND cc.cliente_id = ANY($1::int[])" : "";
  const { rows } = await consultar(db, `
    SELECT cc.id AS cliente_conta_id, cc.cliente_id, c.nome AS cliente_nome, c.slug AS cliente_slug,
           cc.nome AS conta_nome, cc.external_account_id AS seller_id, cc.ativo, cc.is_primary,
           EXISTS (SELECT 1 FROM ml_tokens t WHERE t.cliente_conta_id = cc.id AND t.superseded_by_grant_id IS NULL) AS tem_grant,
           (SELECT t.token_status FROM ml_tokens t WHERE t.cliente_conta_id = cc.id AND t.superseded_by_grant_id IS NULL
             ORDER BY t.id DESC LIMIT 1) AS grant_status
      FROM cliente_contas cc JOIN clientes c ON c.id = cc.cliente_id
     WHERE cc.marketplace = 'meli' ${filtro}
     ORDER BY cc.id`, Array.isArray(clienteIds) ? [clienteIds] : []);
  return rows.map((r) => ({
    clienteContaId: Number(r.cliente_conta_id), clienteId: Number(r.cliente_id), clienteNome: r.cliente_nome, clienteSlug: r.cliente_slug,
    contaNome: r.conta_nome, sellerId: r.seller_id ? String(r.seller_id) : null, ativo: r.ativo === true, isPrimary: r.is_primary === true,
    temGrant: r.tem_grant === true, grantStatus: r.grant_status || null,
  }));
}

/** Contagens por conta (1 consulta agregada por tabela, sem join cartesiano). */
async function resumoPorConta(db, contaIds) {
  const ids = (contaIds || []).map(Number).filter(Number.isInteger);
  if (!ids.length) return new Map();
  const [an, sn] = await Promise.all([
    consultar(db, `
      SELECT cliente_conta_id, count(*)::int AS anuncios,
             count(*) FILTER (WHERE status = 'active')::int AS ativos,
             array_remove(array_agg(DISTINCT logistic_type) FILTER (WHERE status = 'active'), NULL) AS logisticas,
             max(last_synced_at) AS ultimo_sync
        FROM meli_anuncios WHERE cliente_conta_id = ANY($1::int[]) GROUP BY 1`, [ids]),
    consultar(db, `
      SELECT cliente_conta_id, count(*)::int AS snapshots,
             count(*) FILTER (WHERE refresh_status = 'fresh')::int AS fresh,
             count(*) FILTER (WHERE refresh_status = 'failed')::int AS failed,
             count(*) FILTER (WHERE jsonb_typeof(quality_json->'freteQualidade') = 'object')::int AS frete_avaliado,
             count(*) FILTER (WHERE quality_json->'freteQualidade'->>'nivel' = 'cotado_ml')::int AS frete_cotado,
             count(*) FILTER (WHERE quality_json->'freteQualidade'->>'nivel' LIKE 'estimado_%')::int AS frete_estimado,
             count(*) FILTER (WHERE quality_json->'freteQualidade'->>'nivel' = 'desconhecido' OR (freight IS NULL AND COALESCE(quality_json->>'freteAplicavel','') = 'true'))::int AS frete_desconhecido,
             count(*) FILTER (WHERE cost IS NULL)::int AS sem_custo,
             count(*) FILTER (WHERE margin_percent IS NOT NULL)::int AS com_margem,
             min(calculated_at) AS calculo_mais_antigo, max(calculated_at) AS calculo_mais_recente
        FROM margin_projection_snapshots WHERE cliente_conta_id = ANY($1::bigint[]) GROUP BY 1`, [ids]),
  ]);
  const m = new Map(ids.map((id) => [id, { clienteContaId: id }]));
  for (const r of an.rows) Object.assign(m.get(Number(r.cliente_conta_id)), { anuncios: r.anuncios, ativos: r.ativos, logisticas: r.logisticas || [], ultimoSync: r.ultimo_sync });
  for (const r of sn.rows) Object.assign(m.get(Number(r.cliente_conta_id)), {
    snapshots: r.snapshots, fresh: r.fresh, failed: r.failed, freteAvaliado: r.frete_avaliado, freteCotado: r.frete_cotado,
    freteEstimado: r.frete_estimado, freteDesconhecido: r.frete_desconhecido, semCusto: r.sem_custo, comMargem: r.com_margem,
    calculoMaisAntigo: r.calculo_mais_antigo, calculoMaisRecente: r.calculo_mais_recente,
  });
  return m;
}

/** Uma página de anúncios da conta (snapshot + cadastro), keyset por item_id. */
async function paginaItens(db, { clienteContaId, aposItemId = "", limite = 300, itemIds = null }) {
  const params = [clienteContaId, aposItemId || "", Math.min(1000, Math.max(1, limite))];
  let filtroItens = "";
  if (Array.isArray(itemIds)) { params.push(itemIds); filtroItens = "AND s.item_id = ANY($4::text[])"; }
  const { rows } = await consultar(db, `
    SELECT s.item_id, s.cliente_id, s.cliente_conta_id, s.sku, s.titulo, s.price, s.list_price, s.promo_price, s.cost,
           s.fixed_fee, s.commission, s.freight, s.profit, s.tax_rate, s.commission_rate, s.margin, s.margin_percent,
           s.status AS status_motor, s.confidence_level, s.refresh_status, s.last_error, s.calculated_at, s.observed_at,
           s.quality_json->'freteQualidade' AS frete_qualidade, s.quality_json->>'freteAplicavel' AS frete_aplicavel,
           s.quality_json->>'logisticType' AS logistic_type_snapshot, s.quality_json->>'statusAnuncio' AS status_anuncio_snapshot,
           (s.quality_json->>'targetMargin')::numeric AS target_margin, s.assumed_json, s.missing_json,
           a.status AS status_anuncio, a.logistic_type, a.listing_type_id, a.preco AS preco_sync, a.preco_original AS preco_original_sync,
           a.last_synced_at, a.variations_count, a.estoque
      FROM margin_projection_snapshots s
      LEFT JOIN meli_anuncios a ON a.cliente_conta_id = s.cliente_conta_id AND a.item_id = s.item_id
     WHERE s.cliente_conta_id = $1 AND s.marketplace = 'meli' AND s.item_id > $2 ${filtroItens}
     ORDER BY s.item_id LIMIT $3`, params);
  return rows;
}

/** Import publicado canônico (maior cobertura) por competência, para a conta. */
async function importsCanonicos(db, { clienteContaId, competencias }) {
  const { rows } = await consultar(db, `
    SELECT DISTINCT ON (competencia) id, competencia, coverage_date_from, coverage_date_to, published_at
      FROM central_vendas_imports
     WHERE cliente_conta_id = $1 AND publication_status = 'published' AND competencia = ANY($2::text[])
     ORDER BY competencia, coverage_date_to DESC NULLS LAST, published_at DESC NULLS LAST, id DESC`, [clienteContaId, competencias]);
  return rows;
}

/**
 * Vendas reais por item (Central de Vendas), pedidos pagos a partir de `desde`.
 * Devolve Map(item_id → { unidades, faturamento, ultimaVenda, amostras:[{data, precoUnitario, frete}] })
 * `amostras` só de pedidos com UM item e quantidade 1 (frete do envio inteiro = do item).
 */
async function vendasPorItem(db, { clienteContaId, desde, competencias }) {
  const imps = await importsCanonicos(db, { clienteContaId, competencias });
  const ids = imps.map((r) => Number(r.id));
  const m = new Map();
  if (!ids.length) return { porItem: m, imports: imps };
  const { rows } = await consultar(db, `
    SELECT i.mlb AS item_id, p.data_pedido, i.quantidade, i.valor_unitario, p.quantidade_itens,
           (SELECT c.valor FROM central_vendas_componentes c WHERE c.item_row_id = i.id AND c.tipo = 'frete_seller' AND c.fonte = 'shipments_api' LIMIT 1) AS frete_seller
      FROM central_vendas_pedido_itens i
      JOIN central_vendas_pedidos p ON p.id = i.pedido_row_id
     WHERE i.import_id = ANY($1::bigint[]) AND p.status = 'paid' AND p.data_pedido >= $2::date AND i.mlb IS NOT NULL`, [ids, desde]);
  for (const r of rows) {
    const id = r.item_id;
    if (!m.has(id)) m.set(id, { unidades: 0, faturamento: 0, ultimaVenda: null, amostras: [], precos: [] });
    const x = m.get(id);
    const q = Number(r.quantidade) || 0;
    const pu = r.valor_unitario === null ? null : Number(r.valor_unitario);
    x.unidades += q;
    if (pu !== null) x.faturamento += pu * q;
    const d = r.data_pedido instanceof Date ? r.data_pedido.toISOString().slice(0, 10) : String(r.data_pedido).slice(0, 10);
    if (!x.ultimaVenda || d > x.ultimaVenda) x.ultimaVenda = d;
    if (pu !== null) x.precos.push({ data: d, preco: pu });
    if (pu !== null && q === 1 && Number(r.quantidade_itens) === 1 && r.frete_seller !== null) {
      x.amostras.push({ data: d, precoUnitario: pu, frete: Math.abs(Number(r.frete_seller)) });
    }
  }
  for (const x of m.values()) { x.faturamento = Math.round(x.faturamento * 100) / 100; x.precos.sort((a, b) => (a.data < b.data ? -1 : 1)); }
  return { porItem: m, imports: imps };
}

/**
 * Eventos de preço registrados pelo VenForce para a conta, desde `desde`.
 * Fontes: activity_logs (rebate, transferência, criação de promoção, alteração
 * manual de preço — esta última só existe a partir desta versão) e
 * margem_precificacao_aplicacoes (Central de Margem, auditada).
 * Devolve Map(item_id → eventos[] em ordem cronológica).
 */
async function eventosDePreco(db, { clienteContaId, desde }) {
  const m = new Map();
  const add = (itemId, ev) => { if (!itemId) return; if (!m.has(itemId)) m.set(itemId, []); m.get(itemId).push(ev); };
  const logs = await consultar(db, `
    SELECT acao, created_at, status, detalhes->>'item_id' AS item_id, detalhes->>'preco_confirmado' AS preco_confirmado,
           detalhes->>'preco_anterior' AS preco_anterior, detalhes->>'tipo' AS tipo, detalhes->>'codigo' AS codigo
      FROM activity_logs
     WHERE acao IN ('anuncios_meli.promocoes_rebate.participar','anuncios_meli.promocoes.transferir','anuncios_meli.preco.alterar')
       AND detalhes->>'cliente_conta_id' = $1::text AND created_at >= $2::timestamptz
     ORDER BY created_at`, [String(clienteContaId), desde]);
  for (const r of logs.rows) {
    const confirmado = r.preco_confirmado === null ? null : Number(r.preco_confirmado);
    const ok = r.status !== "erro" && !r.codigo && confirmado !== null;
    const tipo = r.acao.endsWith("rebate.participar") ? "rebate_participacao" : r.acao.endsWith("transferir") ? "promocao_transferencia" : "preco_manual";
    add(r.item_id, {
      tipo, em: new Date(r.created_at).toISOString(), alteraPreco: ok, precoNovo: confirmado,
      precoAnterior: r.preco_anterior === null ? null : Number(r.preco_anterior),
      descricao: tipo === "rebate_participacao" ? `Participação em promoção (${r.tipo || "rebate"}) pelo VenForce` : tipo === "promocao_transferencia" ? "Transferência de promoção pelo VenForce" : "Preço alterado manualmente em /anuncios",
      fonte: "activity_logs",
    });
  }
  const apl = await consultar(db, `
    SELECT item_id, COALESCE(aplicado_em, criado_em) AS created_at, status, tipo_acao, preco_anterior, preco_confirmado, preco_solicitado
      FROM margem_precificacao_aplicacoes
     WHERE cliente_conta_id = $1 AND criado_em >= $2::timestamptz AND status <> 'preview'
     ORDER BY criado_em`, [clienteContaId, desde]);
  for (const r of apl.rows) {
    add(r.item_id, {
      tipo: "central_margem_aplicacao", em: new Date(r.created_at).toISOString(),
      alteraPreco: r.preco_confirmado !== null, precoNovo: r.preco_confirmado === null ? null : Number(r.preco_confirmado),
      precoAnterior: r.preco_anterior === null ? null : Number(r.preco_anterior),
      descricao: `Central de Margem (${r.tipo_acao}, ${r.status})`, fonte: "margem_precificacao_aplicacoes",
    });
  }
  for (const evs of m.values()) evs.sort((a, b) => (a.em < b.em ? -1 : 1));
  return m;
}

/** Saved reports (Automações) que citam itens da conta — para histórico de preço visto. */
async function precosEmRelatorios(db, { clienteId, itemIds, desde }) {
  if (!itemIds || !itemIds.length) return new Map();
  const { rows } = await consultar(db, `
    SELECT ri.item_id, r.created_at, ri.preco_efetivo, ri.frete, ri.mc
      FROM relatorio_itens ri JOIN relatorios r ON r.id = ri.relatorio_id
     WHERE r.cliente_id = $1 AND ri.item_id = ANY($2::text[]) AND r.created_at >= $3::timestamptz
     ORDER BY r.created_at`, [clienteId, itemIds, desde]);
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.item_id)) m.set(r.item_id, []);
    m.get(r.item_id).push({ em: new Date(r.created_at).toISOString(), preco: r.preco_efetivo === null ? null : Number(r.preco_efetivo), frete: r.frete === null ? null : Number(r.frete), mc: r.mc === null ? null : Number(r.mc) });
  }
  return m;
}

/** Meta de margem da conta: última margem_alvo de relatório salvo do cliente (origem explícita). */
async function metaDoUltimoRelatorio(db, { clienteId }) {
  const { rows } = await consultar(db, `
    SELECT margem_alvo, created_at FROM relatorios WHERE cliente_id = $1 AND margem_alvo IS NOT NULL ORDER BY created_at DESC LIMIT 1`, [clienteId]);
  return rows[0] ? { valor: Number(rows[0].margem_alvo), em: new Date(rows[0].created_at).toISOString() } : null;
}


/** Eventos de preço do VenForce por conta (agregado), para o inventário. */
async function eventosPorConta(db, { desde }) {
  const logs = await consultar(db, `
    SELECT detalhes->>'cliente_conta_id' AS conta, acao, count(*)::int AS n, count(DISTINCT detalhes->>'item_id')::int AS itens, max(created_at) AS ultimo
      FROM activity_logs
     WHERE acao IN ('anuncios_meli.promocoes_rebate.participar','anuncios_meli.promocoes.transferir','anuncios_meli.preco.alterar','anuncios_meli.promocoes.criar')
       AND created_at >= $1::timestamptz
     GROUP BY 1, 2`, [desde]);
  const apl = await consultar(db, `
    SELECT cliente_conta_id::text AS conta, count(*)::int AS n, count(DISTINCT item_id)::int AS itens, max(criado_em) AS ultimo
      FROM margem_precificacao_aplicacoes WHERE criado_em >= $1::timestamptz AND status <> 'preview' GROUP BY 1`, [desde]);
  const m = new Map();
  const add = (conta, chave, r) => { if (!conta) return; if (!m.has(conta)) m.set(conta, {}); m.get(conta)[chave] = { eventos: r.n, itens: r.itens, ultimo: r.ultimo }; };
  for (const r of logs.rows) add(r.conta, r.acao.replace("anuncios_meli.", ""), r);
  for (const r of apl.rows) add(r.conta, "central_margem.aplicacao", r);
  return m;
}

/** Vendas pagas da conta desde `desde` (agregado: pedidos, unidades, faturamento). */
async function vendasResumoConta(db, { clienteContaId, desde, competencias }) {
  const imps = await importsCanonicos(db, { clienteContaId, competencias });
  const ids = imps.map((r) => Number(r.id));
  if (!ids.length) return { pedidos: 0, unidades: 0, faturamento: 0, itensVendidos: 0, cobertura: null };
  const { rows } = await consultar(db, `
    SELECT count(DISTINCT p.pedido_id)::int AS pedidos, COALESCE(sum(i.quantidade),0)::numeric AS unidades,
           COALESCE(sum(i.quantidade * i.valor_unitario),0)::numeric AS faturamento, count(DISTINCT i.mlb)::int AS itens
      FROM central_vendas_pedido_itens i JOIN central_vendas_pedidos p ON p.id = i.pedido_row_id
     WHERE i.import_id = ANY($1::bigint[]) AND p.status = 'paid' AND p.data_pedido >= $2::date`, [ids, desde]);
  const r = rows[0] || {};
  const ate = imps.map((x) => x.coverage_date_to).filter(Boolean).sort().pop() || null;
  return { pedidos: r.pedidos || 0, unidades: Number(r.unidades || 0), faturamento: Math.round(Number(r.faturamento || 0) * 100) / 100, itensVendidos: r.itens || 0, cobertura: ate };
}

/** Snapshots mais velhos que `horas`. */
async function snapshotsAntigos(db, { contaIds, horas }) {
  const { rows } = await consultar(db, `
    SELECT cliente_conta_id, count(*)::int AS n FROM margin_projection_snapshots
     WHERE cliente_conta_id = ANY($1::bigint[]) AND calculated_at < now() - ($2::int * interval '1 hour') GROUP BY 1`, [contaIds, horas]);
  return new Map(rows.map((r) => [Number(r.cliente_conta_id), r.n]));
}

module.exports = {
  competenciasJanela, eventosPorConta, vendasResumoConta, snapshotsAntigos,
  TIMEOUT_MS, listarContasMeli, resumoPorConta, paginaItens, importsCanonicos, vendasPorItem,
  eventosDePreco, precosEmRelatorios, metaDoUltimoRelatorio,
};
