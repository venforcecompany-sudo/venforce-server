// server/services/meliAnuncios/meliCustosPlanilhaService.js
// -----------------------------------------------------------------------------
// "Importar base de custo" da lista de Anúncios ML — a mesma ideia da correção
// em lote do Financeiro (baixar → preencher → enviar → gravar), só que com a
// planilha da CONTA INTEIRA: todo MLB do cliente/conta, com e sem custo.
//
//   GET  /anuncios-meli/custos/planilha         gera o XLSX (somente leitura)
//   POST /anuncios-meli/custos/planilha/previa  lê o XLSX preenchido e diz o
//                                               que mudaria — NÃO grava
//
// A gravação NÃO mora aqui: o front envia as linhas aprovadas na prévia para
// POST /anuncios-meli/custos/lote (meliCustosLoteService), que revalida tudo
// (MLB do cliente, conta certa, custo válido), grava pela mesma Base do
// contexto do Motor, registra o log e enfileira o Margin Snapshot. Uma porta
// de escrita só.
//
// Regras da leitura:
//  - chave = MLB (coluna "ID"); custo = coluna "Custo" (ou "Novo custo");
//  - célula de custo VAZIA = ignorada: nada é zerado nem apagado;
//  - mesmo valor que já está na Base = "inalterado" (não vai para gravação);
//  - MLB que não é deste cliente/conta = recusado na prévia;
//  - MLB repetido com valores diferentes = recusado (nenhuma versão vale).
// -----------------------------------------------------------------------------

const XLSX = require("xlsx");
const pool = require("../../config/database");
const anunciosService = require("./meliAnunciosService");
const custosLoteService = require("./meliCustosLoteService");

const CUSTO_MAXIMO = 1e9;
const COLUNAS = ["ID", "Título", "SKU", "Status", "Custo"];

function criarErroHttp(statusCode, payload) {
  const err = new Error(payload?.motivo || "Erro");
  err.statusCode = statusCode;
  err.payload = payload;
  return err;
}

function semAcento(s) {
  return String(s == null ? "" : s).normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
}

// "MLB123", "mlb 123" ou só o número (planilha legada) → "MLB123".
function normalizarMlb(valor) {
  const s = String(valor == null ? "" : valor).replace(/\s+/g, "").toUpperCase();
  if (/^MLB\d+$/.test(s)) return s;
  if (/^\d+$/.test(s)) return `MLB${s}`;
  return "";
}

// Número da célula: número nativo do Excel ou texto pt-BR ("R$ 1.234,56").
function lerCusto(valor) {
  if (valor === null || valor === undefined) return { vazio: true };
  if (typeof valor === "number") {
    if (!Number.isFinite(valor) || valor <= 0 || valor > CUSTO_MAXIMO) return { invalido: true };
    return { n: Math.round(valor * 100) / 100 };
  }
  let s = String(valor).trim().replace(/[R$\s]/g, "");
  if (!s) return { vazio: true };
  if (s.indexOf(",") >= 0) s = s.replace(/\./g, "").replace(",", ".");
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0 || n > CUSTO_MAXIMO) return { invalido: true };
  return { n: Math.round(n * 100) / 100 };
}

// Cliente + conta + Base, do jeito que o resumo/lista já resolvem. Sem Base
// pronta não há o que baixar nem importar: 409 com a mensagem do contexto.
async function resolverEscopo({ clienteSlug, clienteContaId }, deps) {
  const resolverCliente = deps.resolverCliente || anunciosService.resolverCliente;
  const resolverConta = deps.resolverContextoConta || anunciosService.resolverContextoConta;
  const resolverBase = deps.resolverBaseDeCustos || custosLoteService.resolverBaseDeCustos;

  const cliente = await resolverCliente(clienteSlug);
  if (!cliente) throw criarErroHttp(404, { ok: false, codigo: "CLIENTE_NAO_ENCONTRADO", motivo: "Cliente não encontrado." });

  let contaId = null;
  let includeLegacy = true;
  if (clienteContaId != null) {
    const ctx = await resolverConta({ clienteId: cliente.id, clienteContaId, requireUsableGrant: false });
    contaId = ctx.contaId;
    includeLegacy = ctx.includeLegacy;
  }

  const { base, mensagem } = await resolverBase({ clienteSlug: cliente.slug, clienteContaId });
  if (!base) {
    throw criarErroHttp(409, {
      ok: false,
      codigo: "SEM_BASE",
      motivo: mensagem || "Esta conta não tem Base de custos vinculada.",
    });
  }
  return { cliente, contaId, includeLegacy, base };
}

// Todo MLB do cliente/conta (mesma cláusula de conta da listagem) + o custo
// que a Base tem para ele (mesma tolerância de chave legada sem prefixo).
async function carregarAnunciosComCusto(db, { cliente, contaId, includeLegacy, base }) {
  const params = [cliente.id];
  let contaSql = "";
  if (contaId != null) {
    params.push(contaId);
    contaSql = includeLegacy
      ? " AND (a.cliente_conta_id = $2 OR a.cliente_conta_id IS NULL)"
      : " AND a.cliente_conta_id = $2";
  }
  const { rows: anuncios } = await db.query(
    `SELECT a.item_id, a.titulo, a.sku, a.status
       FROM meli_anuncios a
      WHERE a.cliente_id = $1${contaSql}
      ORDER BY a.titulo NULLS LAST, a.item_id`,
    params
  );

  const ids = anuncios.map((a) => String(a.item_id).toUpperCase());
  const chaves = ids.flatMap((id) => [id, id.replace(/^MLB/, "")]);
  const custos = new Map();
  if (chaves.length) {
    const { rows } = await db.query(
      `SELECT produto_id, custo_produto FROM custos WHERE base_id = $1 AND sku_id = '' AND produto_id = ANY($2::text[])`,
      [base.id, chaves]
    );
    for (const r of rows) {
      const chave = String(r.produto_id).trim().toUpperCase();
      const itemId = /^MLB/.test(chave) ? chave : `MLB${chave}`;
      if (custos.has(itemId) && !/^MLB/.test(chave)) continue; // a chave canônica ganha
      custos.set(itemId, r.custo_produto == null ? null : Number(r.custo_produto));
    }
  }

  return anuncios.map((a) => {
    const itemId = String(a.item_id).toUpperCase();
    return {
      itemId,
      titulo: a.titulo || null,
      sku: a.sku || null,
      status: a.status || null,
      custo: custos.has(itemId) ? custos.get(itemId) : null,
    };
  });
}

function nomeDoArquivo(cliente) {
  const hoje = new Date().toISOString().slice(0, 10);
  return `custos-anuncios-ml-${cliente.slug}-${hoje}.xlsx`;
}

/**
 * XLSX com todos os anúncios da conta, já com o custo atual da Base.
 * @returns {Promise<{ buffer: Buffer, filename: string, total: number, comCusto: number }>}
 */
async function gerarPlanilha({ clienteSlug, clienteContaId = null }, deps = {}) {
  const db = deps.db || pool;
  const escopo = await resolverEscopo({ clienteSlug, clienteContaId }, deps);
  const linhas = await carregarAnunciosComCusto(db, escopo);

  const ws = XLSX.utils.aoa_to_sheet([
    COLUNAS,
    ...linhas.map((l) => [l.itemId, l.titulo, l.sku, l.status, l.custo]),
  ]);
  ws["!cols"] = [{ wch: 16 }, { wch: 60 }, { wch: 20 }, { wch: 10 }, { wch: 12 }];
  // Custo como número com 2 casas (o Excel mostra 42,90 em pt-BR).
  for (let r = 1; r <= linhas.length; r += 1) {
    const cel = ws[XLSX.utils.encode_cell({ r, c: 4 })];
    if (cel && typeof cel.v === "number") cel.z = "0.00";
  }

  const como = XLSX.utils.aoa_to_sheet([
    ["Como usar"],
    ["1. Preencha ou altere a coluna \"Custo\" (custo do produto, em R$)."],
    ["2. Não altere a coluna \"ID\" nem os cabeçalhos."],
    ["3. Célula de custo vazia é ignorada — nada é zerado ou apagado da Base."],
    ["4. Envie a planilha em Anúncios ML → Importar base de custo. Você vê a prévia antes de gravar."],
    [`Base de custos: ${escopo.base.nome || escopo.base.slug}`],
  ]);
  como["!cols"] = [{ wch: 90 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Custos");
  XLSX.utils.book_append_sheet(wb, como, "Como usar");

  return {
    buffer: XLSX.write(wb, { type: "buffer", bookType: "xlsx" }),
    filename: nomeDoArquivo(escopo.cliente),
    total: linhas.length,
    comCusto: linhas.filter((l) => l.custo != null).length,
  };
}

// Primeira aba com cabeçalho reconhecível (ID + Custo) nas 10 primeiras linhas.
function localizarTabela(wb) {
  for (const nome of wb.SheetNames) {
    const matriz = XLSX.utils.sheet_to_json(wb.Sheets[nome], { header: 1, raw: true, defval: null, blankrows: false });
    for (let i = 0; i < Math.min(matriz.length, 10); i += 1) {
      const cab = (matriz[i] || []).map(semAcento);
      const colId = cab.findIndex((c) => c === "id" || c === "mlb" || c === "item id" || c === "id do anuncio");
      let colCusto = cab.findIndex((c) => c === "novo custo");
      if (colCusto < 0) colCusto = cab.findIndex((c) => c === "custo" || c === "custo do produto" || c === "custo produto");
      if (colId >= 0 && colCusto >= 0) return { linhas: matriz.slice(i + 1), colId, colCusto, primeiraLinha: i + 2 };
    }
  }
  return null;
}

/**
 * Lê a planilha preenchida e classifica cada linha contra os anúncios e a
 * Base desta conta. Nada é gravado.
 *
 * @returns {Promise<{ base, resumo, linhas: Array }>}
 *   linha: { linha, itemId, titulo, custoAtual, custo, acao, motivo }
 *   acao:  "atualizar" | "adicionar" | "inalterado" | "recusada"
 *   (custo vazio não vira linha — só conta em resumo.vazias)
 */
async function lerPlanilha({ clienteSlug, clienteContaId = null, buffer }, deps = {}) {
  const db = deps.db || pool;
  if (!buffer || !buffer.length) {
    throw criarErroHttp(400, { ok: false, codigo: "ARQUIVO_OBRIGATORIO", motivo: "Envie a planilha (.xlsx, .xls ou .csv)." });
  }

  let wb;
  try {
    wb = XLSX.read(buffer, { type: "buffer" });
  } catch (_) {
    throw criarErroHttp(400, { ok: false, codigo: "ARQUIVO_ILEGIVEL", motivo: "Não foi possível ler o arquivo. Envie .xlsx, .xls ou .csv." });
  }
  const tabela = localizarTabela(wb);
  if (!tabela) {
    throw criarErroHttp(400, {
      ok: false,
      codigo: "COLUNAS_AUSENTES",
      motivo: "A planilha precisa das colunas \"ID\" e \"Custo\". Baixe o modelo nesta tela e preencha nele.",
    });
  }

  const escopo = await resolverEscopo({ clienteSlug, clienteContaId }, deps);
  const anuncios = await carregarAnunciosComCusto(db, escopo);
  const porId = new Map(anuncios.map((a) => [a.itemId, a]));

  let vazias = 0;
  const vistas = new Map(); // itemId -> linha já classificada
  const linhas = [];

  tabela.linhas.forEach((bruta, idx) => {
    const numeroLinha = tabela.primeiraLinha + idx;
    const idBruto = bruta[tabela.colId];
    const custoBruto = bruta[tabela.colCusto];
    if ((idBruto === null || String(idBruto).trim() === "") && (custoBruto === null || String(custoBruto).trim() === "")) return;

    const itemId = normalizarMlb(idBruto);
    const c = lerCusto(custoBruto);
    if (c.vazio) { vazias += 1; return; }

    const anuncio = itemId ? porId.get(itemId) : null;
    const base = { linha: numeroLinha, itemId: itemId || String(idBruto == null ? "" : idBruto), titulo: anuncio ? anuncio.titulo : null, custoAtual: anuncio ? anuncio.custo : null, custo: c.n ?? null };

    if (!itemId) { linhas.push({ ...base, acao: "recusada", motivo: "ID inválido: use o código MLB do anúncio." }); return; }
    if (c.invalido) { linhas.push({ ...base, acao: "recusada", motivo: "Custo inválido: use um valor maior que zero, ex.: 42,90." }); return; }
    if (!anuncio) { linhas.push({ ...base, acao: "recusada", motivo: "Anúncio não encontrado nesta conta. Sincronize os anúncios ou confira o ID." }); return; }

    const anterior = vistas.get(itemId);
    if (anterior) {
      if (anterior.custo !== c.n && anterior.acao !== "recusada") {
        anterior.acao = "recusada";
        anterior.motivo = "MLB repetido na planilha com custos diferentes — nenhuma versão foi considerada.";
      }
      return; // repetida igual: conta uma vez só
    }

    let acao;
    if (anuncio.custo == null) acao = "adicionar";
    else if (anuncio.custo === c.n) acao = "inalterado";
    else acao = "atualizar";
    const linha = { ...base, acao, motivo: null };
    vistas.set(itemId, linha);
    linhas.push(linha);
  });

  const conta = (a) => linhas.filter((l) => l.acao === a).length;
  return {
    base: { slug: escopo.base.slug, nome: escopo.base.nome },
    resumo: {
      atualizar: conta("atualizar"),
      adicionar: conta("adicionar"),
      inalterado: conta("inalterado"),
      recusadas: conta("recusada"),
      vazias,
      anunciosNaConta: anuncios.length,
    },
    linhas,
  };
}

module.exports = {
  gerarPlanilha,
  lerPlanilha,
  COLUNAS,
  // exportados para teste
  normalizarMlb,
  lerCusto,
};
