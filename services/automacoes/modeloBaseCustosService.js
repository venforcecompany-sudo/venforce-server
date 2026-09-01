// Modelo simples para criação de uma base de custos MELI.
//
// Esta exportação consulta somente os IDs dos anúncios ativos. Não busca
// detalhes dos itens, preços, promoções, comissão ou frete; também não cria
// relatórios nem grava qualquer registro no banco.

const XLSX = require("xlsx");
const { mlFetch } = require("../../utils/mlClient");
const { exigirContextoGrantMl, normalizarSlug } = require("./contextoPrecificacaoService");

const ML_SCAN_LIMIT = 100;
const CONTENT_TYPE_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function criarErroHttp(statusCode, payload) {
  const err = new Error(payload?.erro || "Erro");
  err.statusCode = statusCode;
  err.payload = payload;
  return err;
}

function filtrarIdsMlbUnicos(ids) {
  const unicos = new Set();

  for (const idRaw of Array.isArray(ids) ? ids : []) {
    const id = String(idRaw ?? "").trim().toUpperCase();
    if (/^MLB\d+$/.test(id)) unicos.add(id);
  }

  return Array.from(unicos);
}

async function buscarTodosMlbsAtivos({ clienteId, mlUserId, mlFetchFn = mlFetch }) {
  const idsMlb = new Set();
  let scrollId = null;

  while (true) {
    const params = new URLSearchParams({
      search_type: "scan",
      limit: String(ML_SCAN_LIMIT),
      status: "active",
    });
    if (scrollId) params.set("scroll_id", scrollId);

    // noRefresh mantém esta rota estritamente sem escrita no banco: um token
    // expirado gera erro em vez de atualizar ml_tokens automaticamente.
    const resposta = await mlFetchFn(
      clienteId,
      `/users/${mlUserId}/items/search?${params.toString()}`,
      { noRefresh: true }
    );

    if (!resposta.ok) {
      throw criarErroHttp(resposta.status >= 400 ? resposta.status : 502, {
        ok: false,
        erro: resposta.data?.message || "Falha ao buscar anúncios ativos no Mercado Livre.",
      });
    }

    const resultados = Array.isArray(resposta.data?.results) ? resposta.data.results : [];
    if (!resultados.length) break;

    for (const id of filtrarIdsMlbUnicos(resultados)) idsMlb.add(id);

    const proximoScrollId = String(resposta.data?.scroll_id || "").trim();
    if (!proximoScrollId) break;
    scrollId = proximoScrollId;
  }

  return Array.from(idsMlb);
}

function construirWorkbookModeloBaseCustos(idsMlb) {
  const linhas = [
    ["MLB", "Custo", "Imposto", "Taxa Fixa"],
    ...filtrarIdsMlbUnicos(idsMlb).map((id) => [id, "", "", ""]),
  ];

  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet(linhas);

  // Força toda a coluna MLB para texto, inclusive no metadado de formato do
  // Excel, evitando conversão numérica e notação científica.
  for (let linha = 2; linha <= linhas.length; linha += 1) {
    const celula = `A${linha}`;
    worksheet[celula] = { t: "s", v: linhas[linha - 1][0], z: "@" };
  }

  worksheet["!cols"] = [
    { wch: 20 },
    { wch: 14 },
    { wch: 14 },
    { wch: 14 },
  ];
  worksheet["!autofilter"] = { ref: `A1:D${Math.max(1, linhas.length)}` };
  worksheet["!freeze"] = { xSplit: 0, ySplit: 1, topLeftCell: "A2", activePane: "bottomLeft", state: "frozen" };

  XLSX.utils.book_append_sheet(workbook, worksheet, "Base de Custos");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}

async function gerarModeloBaseCustos({ clienteSlugRaw, clienteContaId }) {
  const { cliente, mlUserId } = await exigirContextoGrantMl({ clienteSlugRaw, clienteContaId });
  const idsMlb = await buscarTodosMlbsAtivos({ clienteId: cliente.id, mlUserId });
  const buffer = construirWorkbookModeloBaseCustos(idsMlb);
  const clienteSlug = normalizarSlug(cliente.slug || cliente.nome || "cliente");
  const data = new Date().toISOString().slice(0, 10);

  return {
    contentType: CONTENT_TYPE_XLSX,
    filename: `modelo-base-custos-${clienteSlug}-${data}.xlsx`,
    buffer,
  };
}

module.exports = {
  filtrarIdsMlbUnicos,
  buscarTodosMlbsAtivos,
  construirWorkbookModeloBaseCustos,
  gerarModeloBaseCustos,
};
