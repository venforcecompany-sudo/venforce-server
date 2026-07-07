// server/services/automacoes/promocoesDiagnosticoService.js
// "Diagnóstico de Promoções" ASSÍNCRONO da tela Promoções ML.
//
// Segue o mesmo padrão do diagnóstico completo (diagnosticoService.js):
//   1) POST start  → cria um job (linha em promocoes_diagnosticos, status
//      'processando') e responde rápido com o id.
//   2) worker      → varre TODAS as promoções da conta em lotes (scroll do ML),
//      com concorrência limitada, gravando as linhas e atualizando o progresso.
//      Ao terminar, agrega o resumo e marca status 'concluido' (ou 'erro'). Em
//      erro parcial, guarda o que conseguiu e marca `parcial` + `aviso`.
//   3) GET status  → o front faz polling do progresso/estado.
//   4) GET snapshot→ lê o último diagnóstico 'concluido' (com as linhas) para
//      reuso sem varrer o ML de novo.
//
// Reaproveita o enriquecimento/decisão de promocoesRetornoService (mesma
// fórmula, mesma fonte financeira via relatorio_itens). Não altera nada no ML.

const fs = require("fs");
const path = require("path");
const pool = require("../../config/database");
const { mlFetch } = require("../../utils/mlClient");
const {
  carregarContextoFinanceiro,
  enriquecerItem,
  extrairSkuMl,
  toAliquota,
  normalizarSlug,
  criarErroHttp,
  pLimit,
  chunk,
} = require("./promocoesRetornoService");

const schemaPath = path.join(__dirname, "..", "..", "sql", "promocoes_diagnostico_schema.sql");

const DIAG_PROMO_SCROLL_LIMIT = 100;     // máximo por scroll do ML
const DIAG_PROMO_BATCH_DETAILS = 20;     // lote de GET /items?ids=
const DIAG_PROMO_ENRICH_CONCURRENCY = 4; // enriquecimentos paralelos
const SNAPSHOT_INSERT_CHUNK = 400;       // linhas por INSERT em lote

let tabelasProntas = false;
async function ensurePromocoesDiagnosticoTables(db = pool) {
  if (tabelasProntas) return;
  const sql = fs.readFileSync(schemaPath, "utf8");
  await db.query(sql);
  tabelasProntas = true;
}

function numOrNull(v) {
  return v != null && Number.isFinite(Number(v)) ? Number(v) : null;
}

// Resolve cliente + base + ml_user_id (mesmas validações do preview).
async function resolverClienteBase(clienteSlugRaw, baseSlugRaw) {
  const clienteSlugRawStr = String(clienteSlugRaw || "").trim();
  const baseSlugRawStr = String(baseSlugRaw || "").trim();
  if (!clienteSlugRawStr) throw criarErroHttp(400, { ok: false, erro: "clienteSlug é obrigatório" });
  if (!baseSlugRawStr) throw criarErroHttp(400, { ok: false, erro: "baseSlug é obrigatório" });

  const clienteSlug = normalizarSlug(clienteSlugRawStr);
  const baseSlug = normalizarSlug(baseSlugRawStr);

  const c = await pool.query("SELECT id, nome, slug FROM clientes WHERE slug = $1", [clienteSlug]);
  if (!c.rows.length) throw criarErroHttp(404, { ok: false, erro: "Cliente não encontrado." });
  const cliente = c.rows[0];

  const tokenRow = await pool.query("SELECT ml_user_id FROM ml_tokens WHERE cliente_id = $1", [cliente.id]);
  if (!tokenRow.rows.length || !tokenRow.rows[0].ml_user_id) {
    throw criarErroHttp(400, { ok: false, erro: "Cliente sem conta ML vinculada." });
  }
  const mlUserId = tokenRow.rows[0].ml_user_id;

  const b = await pool.query("SELECT id, nome, slug FROM bases WHERE slug = $1", [baseSlug]);
  if (!b.rows.length) throw criarErroHttp(404, { ok: false, erro: "Base não encontrada." });
  const base = b.rows[0];

  return { cliente, base, mlUserId };
}

// ─── 1) Criar o job (start) ──────────────────────────────────────────────────
async function criarJobDiagnostico({ userId, body }) {
  const b = body || {};
  await ensurePromocoesDiagnosticoTables();
  const { cliente, base, mlUserId } = await resolverClienteBase(b.clienteSlug, b.baseSlug);

  // Evita jobs duplicados: se já há um 'processando' p/ este cliente+base,
  // devolve-o para o front apenas fazer polling (start idempotente).
  const emAndamento = await pool.query(
    `SELECT id FROM promocoes_diagnosticos
      WHERE cliente_id = $1 AND base_slug = $2 AND status = 'processando'
      ORDER BY id DESC LIMIT 1`,
    [cliente.id, base.slug]
  );
  if (emAndamento.rows.length) {
    return {
      id: emAndamento.rows[0].id,
      status: "processando",
      jaEmAndamento: true,
      cliente: { id: cliente.id, slug: cliente.slug, nome: cliente.nome },
      base: { id: base.id, slug: base.slug, nome: base.nome },
    };
  }

  const margemAlvo = b.margemAlvo != null ? toAliquota(b.margemAlvo) : null;
  const tolerancia = b.tolerancia != null ? toAliquota(b.tolerancia) : null;

  const ins = await pool.query(
    `INSERT INTO promocoes_diagnosticos
       (user_id, cliente_id, cliente_slug, base_id, base_slug, seller_id,
        margem_alvo, tolerancia, status, origem)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'processando','scan')
     RETURNING id, created_at`,
    [
      userId ?? null,
      cliente.id,
      cliente.slug,
      base.id,
      base.slug,
      mlUserId != null ? String(mlUserId) : null,
      margemAlvo,
      tolerancia,
    ]
  );

  return {
    id: ins.rows[0].id,
    status: "processando",
    jaEmAndamento: false,
    created_at: ins.rows[0].created_at,
    cliente: { id: cliente.id, slug: cliente.slug, nome: cliente.nome },
    base: { id: base.id, slug: base.slug, nome: base.nome },
  };
}

// ─── Persistência das linhas ─────────────────────────────────────────────────
const ITEM_COLS = [
  "diagnostico_id", "item_id", "titulo", "campanha", "campanha_id", "tipo_promocao",
  "criada_por_mim", "origem_promocao", "preco_original", "preco_promocao", "desconto_total",
  "seller_percentage", "meli_percentage", "retorno_ml", "custo", "frete",
  "imposto_percentual", "taxa_fixa", "comissao_percentual", "comissao_valor",
  "lc_com_retorno", "mc_com_retorno", "margem_alvo", "diferenca_pp",
  "decisao", "motivo", "payload_raw",
];

function mapLinhaParaColunas(l) {
  return [
    l.itemId ?? null,
    l.titulo ?? null,
    l.campanha ?? null,
    l.promotionId ?? null,
    l.promotionType ?? null,
    typeof l.criadaPorMim === "boolean" ? l.criadaPorMim : null,
    l.origemPromocao ?? null,
    numOrNull(l.precoOriginal),
    numOrNull(l.precoPromocao),
    numOrNull(l.descontoTotal),
    numOrNull(l.sellerPercentage),
    numOrNull(l.meliPercentage),
    numOrNull(l.retornoMl),
    numOrNull(l.custo),
    numOrNull(l.frete),
    numOrNull(l.impostoPercentual),
    numOrNull(l.taxaFixa),
    numOrNull(l.comissaoPercentual),
    numOrNull(l.comissaoValor),
    numOrNull(l.lcComRetorno ?? l.lcComRebate),
    numOrNull(l.mcComRetorno ?? l.mcComRebate),
    numOrNull(l.margemAlvo),
    numOrNull(l.diferencaPp),
    l.decisao ?? null,
    l.motivo ?? null,
    JSON.stringify(l ?? {}),
  ];
}

async function inserirItensLote(diagnosticoId, linhas) {
  const rows = Array.isArray(linhas) ? linhas : [];
  for (const parte of chunk(rows, SNAPSHOT_INSERT_CHUNK)) {
    const placeholders = [];
    const valores = [];
    let p = 1;
    for (const l of parte) {
      const cols = [diagnosticoId, ...mapLinhaParaColunas(l)];
      const slots = cols.map(() => `$${p++}`);
      placeholders.push(`(${slots.join(",")})`);
      valores.push(...cols);
    }
    await pool.query(
      `INSERT INTO promocoes_diagnostico_itens (${ITEM_COLS.join(",")}) VALUES ${placeholders.join(",")}`,
      valores
    );
  }
}

async function atualizarProgresso(diagnosticoId, itensProcessados, totalEstimado) {
  await pool.query(
    `UPDATE promocoes_diagnosticos
        SET itens_processados = $2,
            total_estimado = COALESCE($3, total_estimado),
            updated_at = NOW()
      WHERE id = $1`,
    [diagnosticoId, itensProcessados, totalEstimado ?? null]
  );
}

// Agrega os contadores a partir das linhas gravadas e conclui o job.
async function finalizarDiagnostico(diagnosticoId, { parcial = false, aviso = null } = {}) {
  const agg = await pool.query(
    `SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE meli_percentage > 0)::int AS com_retorno,
        COUNT(*) FILTER (WHERE criada_por_mim IS TRUE)::int AS criadas,
        COUNT(*) FILTER (WHERE criada_por_mim IS NULL)::int AS nao_ident,
        COUNT(*) FILTER (WHERE decisao = 'entrar_seguro')::int AS entrar_seguro,
        COUNT(*) FILTER (WHERE decisao = 'entrar_com_tolerancia')::int AS entrar_tol,
        COUNT(*) FILTER (WHERE decisao = 'baixo_mesmo_com_rebate')::int AS baixo,
        COUNT(*) FILTER (WHERE decisao = 'nao_entrar')::int AS nao_entrar,
        COUNT(*) FILTER (WHERE decisao = 'sem_relatorio')::int AS sem_rel,
        COUNT(*) FILTER (WHERE decisao = 'dados_incompletos')::int AS dados_inc
       FROM promocoes_diagnostico_itens WHERE diagnostico_id = $1`,
    [diagnosticoId]
  );
  const a = agg.rows[0] || {};
  const total = a.total || 0;
  const resumo = {
    totalPromocoes: total,
    totalComRetorno: a.com_retorno || 0,
    totalSemRetorno: total - (a.com_retorno || 0),
    totalCriadasPorMim: a.criadas || 0,
    totalOrigemNaoIdentificada: a.nao_ident || 0,
    entrarSeguro: a.entrar_seguro || 0,
    entrarComTolerancia: a.entrar_tol || 0,
    baixoMesmoComRebate: a.baixo || 0,
    naoEntrar: a.nao_entrar || 0,
    semRelatorio: a.sem_rel || 0,
    dadosIncompletos: a.dados_inc || 0,
  };

  await pool.query(
    `UPDATE promocoes_diagnosticos SET
        status = 'concluido',
        total_promocoes = $2,
        total_com_retorno = $3,
        total_sem_retorno = $4,
        total_criadas_por_mim = $5,
        total_entrar_seguro = $6,
        total_entrar_tolerancia = $7,
        total_nao_entrar = $8,
        total_dados_incompletos = $9,
        itens_scaneados = itens_processados,
        parcial = $10,
        aviso = $11,
        payload_resumo = $12,
        updated_at = NOW()
      WHERE id = $1`,
    [
      diagnosticoId,
      resumo.totalPromocoes,
      resumo.totalComRetorno,
      resumo.totalSemRetorno,
      resumo.totalCriadasPorMim,
      resumo.entrarSeguro,
      resumo.entrarComTolerancia,
      resumo.naoEntrar,
      resumo.semRelatorio + resumo.dadosIncompletos,
      !!parcial,
      aviso,
      JSON.stringify(resumo),
    ]
  );
}

async function marcarErroDiagnostico(diagnosticoId, mensagem) {
  await pool.query(
    `UPDATE promocoes_diagnosticos
        SET status = 'erro', aviso = $2, updated_at = NOW()
      WHERE id = $1`,
    [diagnosticoId, String(mensagem || "Erro desconhecido").slice(0, 800)]
  );
}

// ─── 2) Worker (background) ──────────────────────────────────────────────────
async function executarDiagnosticoPromocoes(diagnosticoId) {
  let cliente, base, mlUserId, margemAlvo, tolerancia;
  try {
    const r = await pool.query(
      `SELECT d.cliente_id, d.base_id, d.cliente_slug, d.base_slug,
              d.margem_alvo, d.tolerancia, d.seller_id,
              t.ml_user_id
         FROM promocoes_diagnosticos d
         LEFT JOIN ml_tokens t ON t.cliente_id = d.cliente_id
        WHERE d.id = $1`,
      [diagnosticoId]
    );
    if (!r.rows.length) throw new Error("Diagnóstico não encontrado.");
    const row = r.rows[0];
    cliente = { id: row.cliente_id, slug: row.cliente_slug };
    base = { id: row.base_id, slug: row.base_slug };
    mlUserId = row.ml_user_id || row.seller_id;
    margemAlvo = row.margem_alvo != null ? Number(row.margem_alvo) : null;
    tolerancia = row.tolerancia != null ? Number(row.tolerancia) : null;
    if (!mlUserId) throw new Error("Cliente sem conta ML vinculada.");
    if (!base.id) throw new Error("Base não encontrada.");
  } catch (err) {
    await marcarErroDiagnostico(diagnosticoId, err.message);
    return;
  }

  console.log(`[promo-diag ${diagnosticoId}] iniciando — cliente_id=${cliente.id} mlUserId=${mlUserId} base_id=${base.id}`);

  // Diagnóstico varre TODAS as promoções (com e sem retorno) para os filtros.
  const filtros = { campanha: null, status: null, apenasComRetorno: false };

  let matchBase, matchSnapshot;
  try {
    ({ matchBase, matchSnapshot } = await carregarContextoFinanceiro({
      clienteId: cliente.id,
      baseId: base.id,
    }));
  } catch (err) {
    await marcarErroDiagnostico(diagnosticoId, `Falha ao carregar base/relatórios: ${err.message}`);
    return;
  }

  const limitar = pLimit(DIAG_PROMO_ENRICH_CONCURRENCY);
  let itensProcessados = 0;
  let totalEstimado = null;
  let scrollId = null;

  try {
    while (true) {
      const params = new URLSearchParams({
        search_type: "scan",
        limit: String(DIAG_PROMO_SCROLL_LIMIT),
        status: "active",
      });
      if (scrollId) params.set("scroll_id", scrollId);

      const scan = await mlFetch(cliente.id, `/users/${mlUserId}/items/search?${params.toString()}`);
      if (!scan.ok) {
        throw new Error(`Falha no scroll do ML (HTTP ${scan.status}): ${scan.data?.message || "erro"}`);
      }
      if (Number.isFinite(Number(scan.data?.paging?.total))) {
        totalEstimado = Number(scan.data.paging.total);
      }

      const ids = Array.isArray(scan.data?.results) ? scan.data.results : [];
      if (!ids.length) break;

      for (const lote of chunk(ids, DIAG_PROMO_BATCH_DETAILS)) {
        let detalhes = [];
        try {
          const batch = await mlFetch(cliente.id, `/items?ids=${lote.join(",")}`);
          if (batch.ok && Array.isArray(batch.data)) detalhes = batch.data;
        } catch (_) { detalhes = []; }

        const tarefas = detalhes.map((entry) =>
          limitar(async () => {
            const body = entry?.body || null;
            if (!body?.id) return null;
            try {
              const sku = extrairSkuMl(body);
              const match = matchBase(body.id, sku);
              const snapMatch = matchSnapshot(body.id, sku);
              return await enriquecerItem({
                clienteId: cliente.id,
                body,
                baseRow: match.row,
                matchedBy: match.matchedBy,
                snapshot: snapMatch.snap,
                snapshotMatchedBy: snapMatch.by,
                skuExtraido: sku,
                margemAlvo,
                tolerancia,
                filtros,
              });
            } catch (err) {
              console.warn(`[promo-diag ${diagnosticoId}] item ${body.id} falhou: ${err.message}`);
              return null;
            }
          })
        );

        const resultados = (await Promise.all(tarefas)).filter(Boolean);
        itensProcessados += resultados.length;
        const linhas = resultados.map((r) => r.linha).filter(Boolean);
        if (linhas.length) await inserirItensLote(diagnosticoId, linhas);
        await atualizarProgresso(diagnosticoId, itensProcessados, totalEstimado);
      }

      if (!scan.data?.scroll_id) break;
      scrollId = scan.data.scroll_id;
    }

    await finalizarDiagnostico(diagnosticoId, { parcial: false, aviso: null });
    console.log(`[promo-diag ${diagnosticoId}] concluído — ${itensProcessados} anúncios varridos.`);
  } catch (err) {
    console.error(`[promo-diag ${diagnosticoId}] erro na varredura:`, err.message);
    if (itensProcessados > 0) {
      // Erro parcial: guarda o que conseguiu e marca aviso.
      await finalizarDiagnostico(diagnosticoId, {
        parcial: true,
        aviso: `Varredura interrompida (${err.message}). Diagnóstico parcial com ${itensProcessados} anúncios.`,
      });
    } else {
      await marcarErroDiagnostico(diagnosticoId, err.message);
    }
  }
}

// ─── 3) Status (polling) ─────────────────────────────────────────────────────
async function buscarStatusDiagnostico({ idRaw }) {
  await ensurePromocoesDiagnosticoTables();
  const id = parseInt(idRaw, 10);
  if (!Number.isFinite(id) || id <= 0) {
    throw criarErroHttp(400, { ok: false, erro: "id inválido." });
  }
  const r = await pool.query(
    `SELECT id, cliente_slug, base_slug, seller_id, status,
            itens_processados, total_estimado, itens_scaneados,
            total_promocoes, parcial, aviso, payload_resumo,
            created_at, updated_at
       FROM promocoes_diagnosticos WHERE id = $1`,
    [id]
  );
  if (!r.rows.length) throw criarErroHttp(404, { ok: false, erro: "Diagnóstico não encontrado." });
  const d = r.rows[0];
  return {
    ok: true,
    diagnostico: {
      id: d.id,
      status: d.status,
      clienteSlug: d.cliente_slug,
      baseSlug: d.base_slug,
      sellerId: d.seller_id,
      itensProcessados: d.itens_processados,
      totalEstimado: d.total_estimado,
      itensScaneados: d.itens_scaneados,
      totalPromocoes: d.total_promocoes,
      parcial: d.parcial,
      aviso: d.aviso,
      resumo: (d.payload_resumo && typeof d.payload_resumo === "object") ? d.payload_resumo : {},
      createdAt: d.created_at,
      updatedAt: d.updated_at,
    },
  };
}

// ─── 4) Leitura do snapshot (último concluído) ───────────────────────────────
async function buscarUltimoSnapshotPromocoes({ clienteSlugRaw, baseSlugRaw }) {
  await ensurePromocoesDiagnosticoTables();
  const clienteSlug = normalizarSlug(String(clienteSlugRaw || "").trim());
  const baseSlug = normalizarSlug(String(baseSlugRaw || "").trim());
  if (!clienteSlug) throw criarErroHttp(400, { ok: false, erro: "clienteSlug é obrigatório" });
  if (!baseSlug) throw criarErroHttp(400, { ok: false, erro: "baseSlug é obrigatório" });

  const head = await pool.query(
    `SELECT * FROM promocoes_diagnosticos
      WHERE cliente_slug = $1 AND base_slug = $2 AND status = 'concluido'
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [clienteSlug, baseSlug]
  );
  if (!head.rows.length) return { ok: true, existe: false, snapshot: null };
  const snap = head.rows[0];

  const itensRes = await pool.query(
    `SELECT payload_raw FROM promocoes_diagnostico_itens
      WHERE diagnostico_id = $1 ORDER BY id ASC`,
    [snap.id]
  );
  const linhas = itensRes.rows.map((r) => r.payload_raw).filter(Boolean);

  return {
    ok: true,
    existe: true,
    origem: "snapshot",
    snapshot_id: snap.id,
    cliente: { id: snap.cliente_id, slug: snap.cliente_slug },
    base: { id: snap.base_id, slug: snap.base_slug },
    meta: {
      sellerId: snap.seller_id,
      margemAlvo: numOrNull(snap.margem_alvo),
      tolerancia: numOrNull(snap.tolerancia),
      itensScaneados: snap.itens_scaneados,
      totalEstimado: snap.total_estimado,
      parcial: snap.parcial,
      aviso: snap.aviso,
      geradoEm: snap.created_at,
      atualizadoEm: snap.updated_at,
      avisos: snap.aviso ? [snap.aviso] : [],
    },
    resumo: (snap.payload_resumo && typeof snap.payload_resumo === "object")
      ? snap.payload_resumo
      : {},
    linhas,
  };
}

module.exports = {
  ensurePromocoesDiagnosticoTables,
  criarJobDiagnostico,
  executarDiagnosticoPromocoes,
  buscarStatusDiagnostico,
  buscarUltimoSnapshotPromocoes,
};
