// server/services/automacoes/planilhaPrecificacaoSemBaseService.js
// Planilha de precificação (mesma matriz/fórmulas do relatório salvo) gerada
// direto do grant ML, sem exigir base de custos vinculada. Usada pela
// operação para preparar a base de custos de um cliente recém-conectado.
//
// Somente leitura em relação à conta ML: reaproveita o mesmo pipeline de
// enriquecimento e a mesma paginação por scroll do diagnóstico completo
// (server/services/automacoes/diagnosticoService.js). Não cria relatório,
// não roda diagnóstico assíncrono, não escreve nada no ML.

const pool = require("../../config/database");
const { mlFetch } = require("../../utils/mlClient");
const { exigirContextoGrantMl } = require("./contextoPrecificacaoService");
const { construirWorkbookMatrizPrecificacao, normalizarSlug } = require("./relatoriosService");
const {
  diagEnriquecerItem,
  diagChunk,
  diagPLimit,
  DIAG_SCROLL_LIMIT,
  DIAG_BATCH_DETAILS,
  DIAG_ENRICH_CONCURRENCY,
} = require("./diagnosticoService");

function criarErroHttp(statusCode, payload) {
  const err = new Error(payload?.erro || "Erro");
  err.statusCode = statusCode;
  err.payload = payload;
  return err;
}

async function carregarMapaCustosBase(baseId) {
  const custosMapExact = new Map();
  const custosMapNorm = new Map();
  const custosMapNumeric = new Map();
  if (!baseId) return { custosMapExact, custosMapNorm, custosMapNumeric };

  const custos = await pool.query(
    "SELECT produto_id, custo_produto, imposto_percentual, taxa_fixa FROM custos WHERE base_id = $1",
    [baseId]
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
  return { custosMapExact, custosMapNorm, custosMapNumeric };
}

function casarCustoDoItem(itemId, mapas) {
  const id = String(itemId || "").trim();
  const upper = id.toUpperCase();
  let baseRow = mapas.custosMapExact.get(id) || mapas.custosMapNorm.get(upper) || null;
  if (!baseRow && upper.startsWith("MLB") && !upper.startsWith("MLBU")) {
    const num = upper.slice(3).match(/^\d+/)?.[0] || "";
    if (num && mapas.custosMapNumeric.has(num)) baseRow = mapas.custosMapNumeric.get(num);
  }
  return baseRow;
}

// Busca TODOS os anúncios ativos do cliente via scroll (mesmo padrão do
// diagnóstico completo) e devolve as linhas já enriquecidas pelo pipeline
// somente-leitura padrão (preço, promoção, comissão, frete + custo da base,
// quando houver).
async function buscarTodosItensEnriquecidos({ clienteId, mlUserId, mapasCusto }) {
  const limitar = diagPLimit(DIAG_ENRICH_CONCURRENCY);
  const linhas = [];
  let scrollId = null;

  while (true) {
    const params = new URLSearchParams({
      search_type: "scan",
      limit: String(DIAG_SCROLL_LIMIT),
      status: "active",
    });
    if (scrollId) params.set("scroll_id", scrollId);

    const scan = await mlFetch(clienteId, `/users/${mlUserId}/items/search?${params.toString()}`);
    if (!scan.ok) {
      throw criarErroHttp(scan.status >= 400 ? scan.status : 502, {
        ok: false,
        erro: scan.data?.message || "Falha ao buscar anúncios no Mercado Livre.",
      });
    }

    const ids = Array.isArray(scan.data?.results) ? scan.data.results : [];
    if (!ids.length) break;

    for (const lote of diagChunk(ids, DIAG_BATCH_DETAILS)) {
      let detalhes = [];
      try {
        const batch = await mlFetch(clienteId, `/items?ids=${lote.join(",")}`);
        if (batch.ok && Array.isArray(batch.data)) detalhes = batch.data;
      } catch (_) {
        detalhes = [];
      }

      const tarefas = detalhes.map((entry) =>
        limitar(async () => {
          const body = entry?.body || null;
          if (!body?.id) return null;
          try {
            const baseRow = casarCustoDoItem(body.id, mapasCusto);
            return await diagEnriquecerItem({ clienteId, body, baseRow, margemAlvo: null });
          } catch (_) {
            return null;
          }
        })
      );

      const resultado = (await Promise.all(tarefas)).filter(Boolean);
      linhas.push(...resultado);
    }

    if (!scan.data?.scroll_id) break;
    scrollId = scan.data.scroll_id;
  }

  return linhas;
}

async function gerarPlanilhaPrecificacaoSemBase({ clienteSlugRaw }) {
  const clienteSlugStr = String(clienteSlugRaw || "").trim();
  if (!clienteSlugStr) throw criarErroHttp(400, { ok: false, erro: "clienteSlug é obrigatório." });

  const { cliente, mlUserId, basesMeli, base } = await exigirContextoGrantMl({
    clienteSlugRaw: clienteSlugStr,
  });

  let baseStatus = "ausente";
  if (basesMeli.length === 1) baseStatus = "ok";
  else if (basesMeli.length > 1) baseStatus = "multiplas";

  const mapasCusto = await carregarMapaCustosBase(baseStatus === "ok" ? base.id : null);

  const itens = await buscarTodosItensEnriquecidos({ clienteId: cliente.id, mlUserId, mapasCusto });

  const baseLabel =
    baseStatus === "ok"
      ? base.nome || base.slug
      : baseStatus === "multiplas"
        ? "Múltiplas bases vinculadas — corrija o vínculo em Bases de Custo"
        : "Nenhuma base vinculada";

  const resumoRows = [
    ["Planilha de precificação", ""],
    ["Cliente", cliente.nome || cliente.slug || "—"],
    ["Base de custos", baseLabel],
    ["Total de anúncios ativos", itens.length],
    ["Gerado em", new Date().toLocaleString("pt-BR")],
    ["Instrução", "Preencha custo, imposto e frete nas colunas em branco. As fórmulas recalculam automaticamente."],
  ];

  const buffer = construirWorkbookMatrizPrecificacao({
    resumoRows,
    resumoPctCells: [],
    itens,
    margemAlvoPadrao: null,
  });

  const clienteSlugNorm = normalizarSlug(cliente.slug || cliente.nome || "cliente");
  const data = new Date().toISOString().slice(0, 10);
  const filename = `matriz-precificacao-${clienteSlugNorm}-sem-base-${data}.xlsx`;

  return {
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    filename,
    buffer,
  };
}

module.exports = {
  gerarPlanilhaPrecificacaoSemBase,
};
