// server/services/automacoes/diagnosticoService.js
// Service do diagnóstico completo da loja.
// Extraído de server/index.js sem alterar scroll, cálculos, SQL ou comportamento.

const pool = require("../../config/database");
const { mlFetch } = require("../../utils/mlClient");
const { exigirContextoPronto, criarErroHttp } = require("./contextoPrecificacaoService");
const { resolverPrecosItem } = require("./precoItemService");
// Comissão e frete: a MESMA cotação da Central de Margem (frete confiável por
// seller, P0 12/11/2026) — este arquivo não consulta mais o ML por conta própria.
const { buscarComissaoEFrete } = require("../shared/marketplaceCurrentQuoteService");
const { resumoDoFrete, MOTIVO_NAO_CONFIAVEL } = require("../shared/freteCotacaoConfiavel");

function extrairSkuMl(body) {
  const direto = [body?.seller_custom_field, body?.sku]
    .map((v) => String(v || "").trim())
    .find(Boolean);
  if (direto) return direto;

  const nomeEhSku = (txt) => String(txt || "").toLowerCase().includes("sku");
  const attrs = Array.isArray(body?.attributes) ? body.attributes : [];
  for (const a of attrs) {
    const id = String(a?.id || "");
    const name = String(a?.name || "");
    if (!nomeEhSku(id) && !nomeEhSku(name)) continue;
    const val = a?.value_name ?? a?.value_id ?? a?.value_struct?.number ?? a?.value_struct?.unit ?? null;
    const sku = String(val || "").trim();
    if (sku) return sku;
  }

  const vars = Array.isArray(body?.variations) ? body.variations : [];
  for (const v of vars) {
    const vDireto = [v?.seller_custom_field, v?.sku]
      .map((x) => String(x || "").trim())
      .find(Boolean);
    if (vDireto) return vDireto;

    const vAttrs = Array.isArray(v?.attributes) ? v.attributes : [];
    for (const a of vAttrs) {
      const id = String(a?.id || "");
      const name = String(a?.name || "");
      if (!nomeEhSku(id) && !nomeEhSku(name)) continue;
      const val = a?.value_name ?? a?.value_id ?? a?.value_struct?.number ?? a?.value_struct?.unit ?? null;
      const sku = String(val || "").trim();
      if (sku) return sku;
    }
  }

  return null;
}

const DIAG_SCROLL_LIMIT = 100;        // máximo aceito pelo ML por scroll
const DIAG_BATCH_DETAILS = 20;        // lote para GET /items?ids=
const DIAG_ENRICH_CONCURRENCY = 4;    // enriquecimentos paralelos

function diagChunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function diagPLimit(concorrencia) {
  const fila = [];
  let ativos = 0;
  const proximo = () => {
    ativos--;
    if (fila.length > 0) fila.shift()();
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      const run = () => {
        ativos++;
        Promise.resolve()
          .then(fn)
          .then((v) => { proximo(); resolve(v); })
          .catch((e) => { proximo(); reject(e); });
      };
      if (ativos < concorrencia) run();
      else fila.push(run);
    });
}

function diagClassificarItem({ temBase, lc, mc, frete, comissao, margemAlvo }) {
  if (!temBase) return "sem_base";
  if (frete === null || frete === undefined) return "sem_frete";
  if (comissao === null || comissao === undefined) return "sem_comissao";
  if (lc === null || lc === undefined || mc === null || mc === undefined) return "sem_dados";
  if (mc < 0) return "critico";
  const margem = Number(margemAlvo);
  if (Number.isFinite(margem) && mc < margem) return "atencao";
  return "saudavel";
}

function diagAcaoRecomendada({ diagnostico, precoEfetivo, precoAlvo, freteMotivo = null }) {
  if (diagnostico === "sem_base") return "Cadastrar item na base de custos.";
  if (diagnostico === "sem_frete" && freteMotivo === MOTIVO_NAO_CONFIAVEL) {
    return "Frete desconhecido: a cotação do Mercado Livre para este anúncio não é confiável. Declarar as medidas da embalagem no anúncio.";
  }
  if (diagnostico === "sem_frete") return "Verificar configuração de frete grátis no anúncio.";
  if (diagnostico === "sem_comissao") return "Verificar listing_type e categoria do anúncio.";
  if (diagnostico === "sem_dados") return "Revisar dados de entrada (custo, imposto, taxa).";
  if (precoAlvo == null || precoEfetivo == null) return "Manter preço atual.";
  const delta = Number(precoAlvo) - Number(precoEfetivo);
  if (!Number.isFinite(delta)) return "Manter preço atual.";
  if (Math.abs(delta / precoEfetivo) < 0.005) return "Manter preço atual.";
  if (delta > 0) return `Subir preço para R$ ${precoAlvo.toFixed(2)}.`;
  return "Manter preço atual (margem acima do alvo).";
}

// Replica EXATAMENTE o pipeline de enriquecimento da rota /automacoes/precificacao/preview-ml para 1 item.
// mlUserId (opcional): a conta ML já resolvida account-aware por
// executarDiagnosticoCompleto. Sem ele, o /users/{seller}/shipping_options e
// o /items/{id}/sale_price caem no token principal — "seller B + token A".
async function diagEnriquecerItem({ clienteId, body, baseRow, margemAlvo, mlUserId = null }) {
  const itemId = String(body?.id || "").trim();
  const sku = extrairSkuMl(body);
  const listingTypeId = body?.listing_type_id || null;
  const categoryId = body?.category_id || null;
  const sellerId = body?.seller_id || null;

  const precoListaFallbackNum = body?.price != null ? Number(body.price) : NaN;
  const precoListaFallback =
    Number.isFinite(precoListaFallbackNum) && precoListaFallbackNum > 0 ? precoListaFallbackNum : null;

  const {
    precoCheio: precoOriginal,
    precoPromocional,
    precoEfetivo,
  } = await resolverPrecosItem({ clienteId, itemId, precoListaFallback, mlUserId });

  // Falha de leitura continua virando `null` (nunca 0), como sempre foi aqui.
  let cotacao = { comissaoValor: null, comissaoPercentualMl: null, fretePrevisto: null, freteQualidade: null, diagnostico: null };
  try {
    cotacao = await buscarComissaoEFrete({
      clienteId, itemId, precoEfetivo, listingTypeId, categoryId, sellerId,
      logisticType: body?.shipping?.logistic_type || "", mlUserId,
      shippingTags: Array.isArray(body?.shipping?.tags) ? body.shipping.tags : null,
    }, mlFetch);
  } catch (_) { /* mantém tudo null */ }
  const comissao = cotacao.comissaoValor;
  const comissaoPercentual = cotacao.comissaoPercentualMl ?? null;
  const frete = cotacao.fretePrevisto;
  const freteDetalhe = resumoDoFrete({
    fretePrevisto: frete, freteQualidade: cotacao.freteQualidade,
    motivo: cotacao.diagnostico && cotacao.diagnostico.frete ? cotacao.diagnostico.frete.motivo : null,
  });

  const custoProduto = baseRow ? baseRow.custoProduto : null;
  const impostoPercentual = baseRow ? baseRow.impostoPercentual : null;
  const taxaFixa = baseRow ? baseRow.taxaFixa : null;

  const impostoNum = Number(impostoPercentual);
  const impostoAliquota =
    Number.isFinite(impostoNum) && impostoNum >= 0
      ? (impostoNum > 1 ? impostoNum / 100 : impostoNum)
      : null;

  const hasLcInputs =
    precoEfetivo !== null && custoProduto !== null && impostoAliquota !== null &&
    taxaFixa !== null && comissao !== null && frete !== null;

  const lc = hasLcInputs
    ? precoEfetivo - (precoEfetivo * impostoAliquota) - comissao - frete - taxaFixa - custoProduto
    : null;
  const mc = lc !== null && precoEfetivo ? lc / precoEfetivo : null;

  let precoAlvo = null;
  if (
    margemAlvo !== null && custoProduto !== null && frete !== null && taxaFixa !== null &&
    impostoAliquota !== null && comissaoPercentual !== null
  ) {
    const denom = 1 - impostoAliquota - (comissaoPercentual / 100) - margemAlvo;
    if (denom > 0) precoAlvo = (custoProduto + frete + taxaFixa) / denom;
  }

  const temBase = !!baseRow;
  const diagnostico = diagClassificarItem({
    temBase, lc, mc, frete, comissao, margemAlvo,
  });
  const acao = diagAcaoRecomendada({ diagnostico, precoEfetivo, precoAlvo, freteMotivo: freteDetalhe.motivo });
  const diferencaPreco =
    precoAlvo !== null && precoEfetivo !== null ? precoAlvo - precoEfetivo : null;

  return {
    item_id: itemId,
    sku,
    titulo: body?.title || null,
    status_anuncio: body?.status || null,
    listing_type_id: listingTypeId,
    preco_original: precoOriginal,
    preco_promocional: precoPromocional,
    preco_efetivo: precoEfetivo,
    custo: custoProduto,
    imposto_percentual: impostoPercentual,
    taxa_fixa: taxaFixa,
    frete,
    comissao,
    comissao_percentual: comissaoPercentual,
    lc,
    mc,
    preco_alvo: precoAlvo,
    preco_sugerido: precoAlvo,
    diferenca_preco: diferencaPreco,
    acao_recomendada: acao,
    // Origem do frete quando o seller tem a verificação ligada (vai para a
    // coluna já existente do relatório e das planilhas); fora dela, null.
    explicacao_calculo: freteDetalhe.avaliado ? freteDetalhe.texto : null,
    frete_detalhe: freteDetalhe,
    diagnostico,
    tem_base: temBase,
  };
}

async function diagInserirItensLote(relatorioId, linhas) {
  if (!linhas.length) return;
  const cols = [
    "relatorio_id", "item_id", "sku", "titulo", "status_anuncio", "listing_type_id",
    "preco_original", "preco_promocional", "preco_efetivo",
    "custo", "imposto_percentual", "taxa_fixa",
    "frete", "comissao", "comissao_percentual",
    "lc", "mc", "preco_alvo", "preco_sugerido", "diferenca_preco",
    "acao_recomendada", "explicacao_calculo", "diagnostico", "tem_base",
  ];
  const placeholders = [];
  const valores = [];
  let p = 1;
  for (const l of linhas) {
    const slots = [];
    for (let i = 0; i < cols.length; i++) slots.push(`$${p++}`);
    placeholders.push(`(${slots.join(",")})`);
    valores.push(
      relatorioId, l.item_id, l.sku, l.titulo, l.status_anuncio, l.listing_type_id,
      l.preco_original, l.preco_promocional, l.preco_efetivo,
      l.custo, l.imposto_percentual, l.taxa_fixa,
      l.frete, l.comissao, l.comissao_percentual,
      l.lc, l.mc, l.preco_alvo, l.preco_sugerido, l.diferenca_preco,
      l.acao_recomendada, l.explicacao_calculo, l.diagnostico, !!l.tem_base
    );
  }
  await pool.query(
    `INSERT INTO relatorio_itens (${cols.join(",")}) VALUES ${placeholders.join(",")}`,
    valores
  );
}

async function diagAtualizarContadores(relatorioId, deltas) {
  await pool.query(
    `UPDATE relatorios SET
       total_itens     = total_itens     + $2,
       itens_com_base  = itens_com_base  + $3,
       itens_sem_base  = itens_sem_base  + $4,
       itens_criticos  = itens_criticos  + $5,
       itens_atencao   = itens_atencao   + $6,
       itens_saudaveis = itens_saudaveis + $7
     WHERE id = $1`,
    [
      relatorioId,
      deltas.total || 0, deltas.comBase || 0, deltas.semBase || 0,
      deltas.criticos || 0, deltas.atencao || 0, deltas.saudaveis || 0,
    ]
  );
}

async function diagFinalizar(relatorioId) {
  const r = await pool.query(
    `SELECT AVG(mc)::float AS media FROM relatorio_itens WHERE relatorio_id = $1 AND mc IS NOT NULL`,
    [relatorioId]
  );
  await pool.query(
    `UPDATE relatorios SET status = 'concluido', mc_media = $2 WHERE id = $1`,
    [relatorioId, r.rows[0]?.media ?? null]
  );
}

async function diagMarcarErro(relatorioId, mensagem) {
  await pool.query(
    `UPDATE relatorios SET status = 'erro', observacoes = COALESCE(observacoes, '') || $2 WHERE id = $1`,
    [relatorioId, `\n[erro] ${String(mensagem || "desconhecido").slice(0, 800)}`]
  );
}

// Worker em background — roda dentro do mesmo processo via setImmediate.
//
// Revalida o contexto no início do worker. Um job antigo sem Conta só
// continua se houver uma única operação; nunca consulta Grant principal.
// Os IDs resolvidos pelo POST viajam em memória, sem alterar o schema.
async function executarDiagnosticoCompleto(relatorioId, options = {}) {
  let cliente, base, mlUserId, margemAlvo;
  try {
    const r = await pool.query(
      `SELECT r.cliente_id, r.base_id, r.margem_alvo, r.cliente_slug, r.base_slug
         FROM relatorios r
        WHERE r.id = $1`,
      [relatorioId]
    );
    if (!r.rows.length) throw new Error("Relatório não encontrado.");
    const row = r.rows[0];
    cliente = { id: row.cliente_id, slug: row.cliente_slug };
    base = { id: row.base_id, slug: row.base_slug };
    const contexto = await exigirContextoPronto({
      clienteSlugRaw: row.cliente_slug, baseSlugRaw: row.base_slug,
      clienteContaId: options.clienteContaId,
    });
    if (Number(contexto.cliente.id) !== Number(row.cliente_id) ||
        Number(contexto.base.id) !== Number(row.base_id)) {
      throw criarErroHttp(409, { code: "BASE_ACCOUNT_MISMATCH", erro: "Identidade do relatório diverge do contexto operacional." });
    }
    if (options.mlUserId != null && String(options.mlUserId) !== String(contexto.mlUserId)) {
      throw criarErroHttp(409, { code: "GRANT_ACCOUNT_MISMATCH", erro: "Seller do diagnóstico diverge da Conta resolvida." });
    }
    cliente = contexto.cliente;
    base = contexto.base;
    mlUserId = contexto.mlUserId;
    margemAlvo = row.margem_alvo != null ? Number(row.margem_alvo) : null;
    if (!mlUserId) throw new Error("Cliente sem conta ML vinculada.");
    if (!base.id) throw new Error("Base não encontrada.");
  } catch (err) {
    await diagMarcarErro(relatorioId, err.message);
    return;
  }

  console.log(
    `[diag ${relatorioId}] iniciando — cliente_id=${cliente.id} slug=${cliente.slug} mlUserId=${mlUserId} base_id=${base.id} base_slug=${base.slug}`
  );

  // Validar que o token pertence ao mlUserId esperado
  try {
    const meResp = await mlFetch(cliente.id, "/users/me", { mlUserId });
    if (!meResp.ok) {
      throw new Error(`Falha ao validar token ML: HTTP ${meResp.status}`);
    }
    const meData = meResp.data;
    const meId = String(meData?.id || "");
    const dbId = String(mlUserId || "");
    if (meId !== dbId) {
      throw new Error(
        `Token ML inválido: token pertence ao usuário ${meId}, mas esperado ${dbId}. ` +
        `Reconecte a conta ML do cliente "${cliente.slug}".`
      );
    }
    console.log(
      `[diag ${relatorioId}] token confirmado — ml_user_id_db=${mlUserId} ml_user_id_token=${meData.id}`
    );
  } catch (err) {
    await diagMarcarErro(relatorioId, err.message);
    return;
  }

  const custosMapExact = new Map();
  const custosMapNorm = new Map();
  const custosMapNumeric = new Map();
  try {
    const custos = await pool.query(
      "SELECT produto_id, custo_produto, imposto_percentual, taxa_fixa FROM custos WHERE base_id = $1",
      [base.id]
    );
    custos.rows.forEach((row) => {
      const key = String(row.produto_id || "").trim();
      if (!key) return;
      const payload = {
        custoProduto: Number(row.custo_produto),
        impostoPercentual: Number(row.imposto_percentual),
        taxaFixa: Number(row.taxa_fixa),
      };
      custosMapExact.set(key, payload);
      custosMapNorm.set(key.toUpperCase(), payload);
      if (/^\d+$/.test(key)) custosMapNumeric.set(key, payload);
    });
  } catch (err) {
    await diagMarcarErro(relatorioId, `Falha ao carregar base: ${err.message}`);
    return;
  }

  function matchBase(itemId) {
    const id = String(itemId || "").trim();
    const upper = id.toUpperCase();
    let baseRow = custosMapExact.get(id) || custosMapNorm.get(upper) || null;
    if (!baseRow && upper.startsWith("MLB") && !upper.startsWith("MLBU")) {
      const num = upper.slice(3).match(/^\d+/)?.[0] || "";
      if (num && custosMapNumeric.has(num)) baseRow = custosMapNumeric.get(num);
    }
    return baseRow;
  }

  const limitar = diagPLimit(DIAG_ENRICH_CONCURRENCY);
  let scrollId = null;

  try {
    while (true) {
      const params = new URLSearchParams({
        search_type: "scan",
        limit: String(DIAG_SCROLL_LIMIT),
        status: "active",
      });
      if (scrollId) params.set("scroll_id", scrollId);

      const scan = await mlFetch(
        cliente.id,
        `/users/${mlUserId}/items/search?${params.toString()}`,
        { mlUserId }
      );
      if (!scan.ok) {
        throw new Error(`Falha no scroll do ML (HTTP ${scan.status}): ${scan.data?.message || "erro"}`);
      }

      const ids = Array.isArray(scan.data?.results) ? scan.data.results : [];
      if (!ids.length) break;

      for (const lote of diagChunk(ids, DIAG_BATCH_DETAILS)) {
        let detalhes = [];
        try {
          const batch = await mlFetch(cliente.id, `/items?ids=${lote.join(",")}`, { mlUserId });
          if (batch.ok && Array.isArray(batch.data)) detalhes = batch.data;
        } catch (_) { detalhes = []; }

        const tarefas = detalhes.map((entry) =>
          limitar(async () => {
            const body = entry?.body || null;
            if (!body?.id) return null;
            try {
              const baseRow = matchBase(body.id);
              return await diagEnriquecerItem({
                clienteId: cliente.id, body, baseRow, margemAlvo, mlUserId,
              });
            } catch (err) {
              console.warn(`[diag ${relatorioId}] item ${body.id} falhou:`, err.message);
              return null;
            }
          })
        );

        const linhas = (await Promise.all(tarefas)).filter(Boolean);
        if (!linhas.length) continue;

        await diagInserirItensLote(relatorioId, linhas);
        await diagAtualizarContadores(relatorioId, {
          total: linhas.length,
          comBase: linhas.filter((l) => l.tem_base).length,
          semBase: linhas.filter((l) => !l.tem_base).length,
          criticos: linhas.filter((l) => l.diagnostico === "critico").length,
          atencao: linhas.filter((l) => l.diagnostico === "atencao").length,
          saudaveis: linhas.filter((l) => l.diagnostico === "saudavel").length,
        });
      }

      if (!scan.data?.scroll_id) break;
      scrollId = scan.data.scroll_id;
    }

    await diagFinalizar(relatorioId);
  } catch (err) {
    console.error(`[diag ${relatorioId}] erro fatal:`, err);
    await diagMarcarErro(relatorioId, err.message);
  }
}

module.exports = {
  executarDiagnosticoCompleto,
  // Exportados para reuso somente-leitura por outros fluxos que precisam do
  // mesmo pipeline de enriquecimento e da mesma paginação por scroll (ex.:
  // planilha de precificação sem base) — nenhum destes escreve no ML.
  diagEnriquecerItem,
  diagChunk,
  diagPLimit,
  extrairSkuMl,
  DIAG_SCROLL_LIMIT,
  DIAG_BATCH_DETAILS,
  DIAG_ENRICH_CONCURRENCY,
};
