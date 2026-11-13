// server/tests/xlsxMatrizFreteIntegridade.test.js
//
// P0 12/11/2026 — integridade financeira do XLSX de Automações (Matriz Mercado Livre).
// Defeito comprovado: no Excel uma célula VAZIA entra como 0 na aritmética. Em
// `IFERROR(P-P*I-P*K-J-H-L,"")` um frete vazio inflava o lucro (R$ 18 → R$ 33, MC 18% → 33%),
// custo vazio chegava a 58%, e preço vazio gerava "Subir preço" com "Preço adotado" inventado.
//
// A) fórmulas recalculadas por um motor de planilha REAL (LibreOffice headless) sobre o XLSX gerado;
//    sem `soffice` na máquina essa parte é pulada (dito na saída) e só a checagem estrutural roda;
// B) fluxo ponta a ponta (planilha recém-gerada × Diagnóstico × Central) da Alianza 1 (conta 86), com
//    Mercado Livre e banco falsos: mesmo frete, mesmo lucro, bloqueio quando falta informação, e só
//    dados da própria conta;
// C) exportações de relatório salvo (CSV/XLSX) são rotuladas como HISTÓRICAS, não recotadas.
//
// Fixtures SIMULADOS no formato real (handoff frete_modalidades_2026-11-12).

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://nobody@127.0.0.1:1/teste-sem-banco";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync, execFileSync } = require("child_process");

let checks = 0;
const casos = [];
const cenario = (n, f) => casos.push({ n, f });
const ok = (c, m) => { assert.ok(c, m); checks += 1; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); checks += 1; };
const perto = (a, b, tol, m) => { assert.ok(typeof a === "number" && Math.abs(a - b) <= tol, `${m || ""} esperado ≈${b}, veio ${a}`); checks += 1; };

const S86 = "1587129755";
const S87 = "2433262404";
const TAGS_PROX = ["self_service_in", "mandatory_free_shipping", "proximity"];
const NONE = { list_cost: 7.75, billable_weight: 430, discount: { rate: 0, type: "none", promoted_amount: 7.75 } };
const MAND = (v, rate = 0.5) => ({ list_cost: v, billable_weight: 430, discount: { rate, type: "mandatory", promoted_amount: v } });

// ── Mundo falso (precisa existir ANTES de carregar os serviços) ──────────────
const mundo = { itens: {}, custos: [], chamadas: [], seller: S86 };
function stub(rel, exportsObj) {
  const abs = require.resolve(rel);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: exportsObj };
}
stub("../config/database", { query: async (sql) => (/FROM custos/.test(sql) ? { rows: mundo.custos } : { rows: [] }) });
stub("../services/automacoes/precoItemService", {
  resolverPrecosItem: async ({ itemId }) => {
    const it = mundo.itens[itemId];
    return { precoCheio: it.preco, precoPromocional: null, precoEfetivo: it.preco, fonte: "sale_price", promotionIdAtivo: null };
  },
});
const contexto = () => ({
  cliente: { id: 133, slug: "alianza_jeans", nome: "Alianza Jeans" }, mlUserId: mundo.seller,
  base: { id: 1, slug: "base-1", nome: "Base 1", ativo: true }, basesConta: [{ id: 1 }],
});
stub("../services/automacoes/contextoPrecificacaoService", {
  exigirContextoGrantMl: async () => contexto(),
  exigirContextoPronto: async () => contexto(),
  criarErroHttp: (status, payload) => Object.assign(new Error(payload && payload.erro), { statusCode: status, payload }),
});
const atributos = (dims) => {
  if (!dims) return [];
  const [d, peso] = dims.split(",");
  const [h, w, l] = d.split("x").map(Number);
  const at = (id, n, unit) => ({ id, values: [{ struct: { number: n, unit } }] });
  return [at("SELLER_PACKAGE_HEIGHT", h, "cm"), at("SELLER_PACKAGE_WIDTH", w, "cm"), at("SELLER_PACKAGE_LENGTH", l, "cm"), at("SELLER_PACKAGE_WEIGHT", Number(peso), "g")];
};
const corpo = (id) => {
  const it = mundo.itens[id];
  return { id, title: `Anúncio ${id}`, status: "active", price: it.preco, listing_type_id: "gold_special", category_id: "MLB1", seller_id: Number(it.seller),
    seller_custom_field: `SKU-${id}`, attributes: [], variations: [], shipping: { logistic_type: "cross_docking", tags: it.tags } };
};
async function mlFetch(clienteId, caminho, opts = {}) {
  const p = String(caminho);
  mundo.chamadas.push({ p, mlUserId: opts.mlUserId || null, method: opts.method || "GET" });
  const doSeller = (id) => String(mundo.itens[id].seller) === String(opts.mlUserId);
  if (p.includes("/items/search")) {
    return p.includes("scroll_id=") ? { ok: true, status: 200, data: { results: [] } }
      : { ok: true, status: 200, data: { results: Object.keys(mundo.itens).filter((id) => p.startsWith(`/users/${mundo.itens[id].seller}/`) && doSeller(id)) } };
  }
  if (p.startsWith("/items?ids=")) return { ok: true, status: 200, data: p.split("=")[1].split(",").map((id) => ({ code: 200, body: corpo(id) })) };
  const unico = p.match(/^\/items\/([^?]+)\?/);
  if (unico) return { ok: true, status: 200, data: { id: unico[1], shipping: { tags: mundo.itens[unico[1]].tags }, attributes: atributos(mundo.itens[unico[1]].dims) } };
  if (p.startsWith("/sites/MLB/listing_prices")) {
    const preco = Number(new URLSearchParams(p.split("?")[1]).get("price"));
    return { ok: true, status: 200, data: { sale_fee_amount: Math.round(preco * 14) / 100, sale_fee_details: { percentage_fee: 14 } } };
  }
  if (p.includes("/shipping_options/free")) {
    const q = new URLSearchParams(p.split("?")[1]);
    if (String(opts.mlUserId) !== p.match(/^\/users\/(\d+)\//)[1]) return { ok: false, status: 403, data: null };
    if (q.get("dimensions")) return { ok: true, status: 200, data: { coverage: { all_country: MAND(13.85) } } };
    return { ok: true, status: 200, data: { coverage: { all_country: mundo.itens[q.get("item_id")].cotacaoItem } } };
  }
  if (p.startsWith("/orders/search")) return { ok: true, status: 200, data: { results: [] } };
  return { ok: false, status: 404, data: null };
}
stub("../utils/mlClient", { mlFetch });

const XLSX = require("xlsx");
const { construirWorkbookMatrizPrecificacao, gerarExportRelatorioCsv, gerarExportRelatorioXlsx } = require("../services/automacoes/relatoriosService");
const { gerarPlanilhaPrecificacaoSemBase } = require("../services/automacoes/planilhaPrecificacaoSemBaseService");
const { diagEnriquecerItem } = require("../services/automacoes/diagnosticoService");
const { obterCotacaoAtual } = require("../services/shared/marketplaceCurrentQuoteService");

// ── Motor de planilha real: LibreOffice recalcula o XLSX que o servidor gerou ─
const TEM_SOFFICE = spawnSync("soffice", ["--version"], { encoding: "utf8", timeout: 60000 }).status === 0;
function recalcular(buffer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vf-xlsx-"));
  try {
    fs.writeFileSync(path.join(dir, "in.xlsx"), buffer);
    execFileSync("soffice", ["--headless", `-env:UserInstallation=file://${dir}/perfil`, "--convert-to", "xlsx:Calc MS Excel 2007 XML",
      "--outdir", path.join(dir, "out"), path.join(dir, "in.xlsx")], { stdio: "ignore", timeout: 180000 });
    return XLSX.read(fs.readFileSync(path.join(dir, "out", "in.xlsx")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
// Valor da célula depois do recálculo; "" (texto vazio) e célula ausente = vazio.
const celula = (ws, addr) => {
  const c = ws[addr];
  return !c || c.v === undefined || c.v === "" ? "" : c.v;
};

const BASE = { item_id: "MLB1", titulo: "t", preco_efetivo: 100, custo: 40, imposto_percentual: 13, taxa_fixa: 0, frete: 15, comissao_percentual: 14 };
const CASOS = [
  ["completo", BASE],
  ["sem_frete", { ...BASE, frete: null }],
  ["sem_custo", { ...BASE, custo: null }],
  ["sem_comissao", { ...BASE, comissao_percentual: null }],
  ["sem_imposto", { ...BASE, imposto_percentual: null }],
  ["sem_taxa_fixa", { ...BASE, taxa_fixa: null }],
  ["sem_preco", { ...BASE, preco_efetivo: null }],
  ["frete_zero_comprovado", { ...BASE, frete: 0 }],
  ["sem_nada", { item_id: "MLB1" }],
];

cenario("A0. estrutura: toda fórmula financeira exige ISNUMBER nas entradas (sem soffice também)", () => {
  const buf = construirWorkbookMatrizPrecificacao({ resumoRows: [["x", 1]], itens: [{ ...BASE }], margemAlvoPadrao: 0.1 });
  const ws = XLSX.read(buf).Sheets["Matriz Mercado Livre"];
  for (const col of ["R", "S", "V", "W", "Y", "Z", "AA", "AB"]) {
    const f = ws[`${col}4`].f;
    ok(/ISNUMBER/.test(f), `${col}4 sem ISNUMBER: ${f}`);
  }
  ok(!/IFERROR\(P4-P4\*I4/.test(ws.R4.f), "fórmula antiga de lucro não existe mais");
  for (const col of ["J", "H", "I", "K", "L", "P"]) ok(new RegExp(`ISNUMBER\\(${col}4\\)`).test(ws.R4.f), `lucro exige ${col}`);
  for (const col of ["J", "H", "I", "K", "L", "U"]) ok(new RegExp(`ISNUMBER\\(${col}4\\)`).test(ws.V4.f), `preço sugerido exige ${col}`);
  ok(/Subir preço/.test(ws.Y4.f) && !/AC4/.test(ws.Y4.f), "decisão depende das células, não de um diagnóstico estático");
});

cenario("A1. LibreOffice real: entrada vazia = desconhecido (lucro, MC, sugerido, adotado em branco); zero digitado vale", () => {
  if (!TEM_SOFFICE) { console.log("    (soffice ausente: recálculo real PULADO)"); return; }
  const itens = CASOS.map(([k, v]) => ({ ...v, item_id: k }));
  const wb = recalcular(construirWorkbookMatrizPrecificacao({ resumoRows: [["x", 1]], itens, margemAlvoPadrao: 0.1 }));
  const ws = wb.Sheets["Matriz Mercado Livre"];
  const linha = (k) => 4 + CASOS.findIndex(([n]) => n === k);
  const lido = (k) => { const r = linha(k); return { lucro: celula(ws, `R${r}`), mc: celula(ws, `S${r}`), sug: celula(ws, `V${r}`), lsug: celula(ws, `W${r}`), acao: celula(ws, `Y${r}`), adot: celula(ws, `Z${r}`), dif: celula(ws, `AA${r}`), difp: celula(ws, `AB${r}`) }; };

  const c = lido("completo");
  perto(c.lucro, 18, 1e-9, "lucro completo"); perto(c.mc, 0.18, 1e-9, "MC completo"); perto(c.sug, 55 / 0.63, 1e-9, "sugerido"); perto(c.lsug, (55 / 0.63) * 0.1, 1e-9, "lucro no sugerido");
  eq(c.acao, "Avaliar redução"); eq(c.adot, 100); eq(c.dif, 0);

  const z = lido("frete_zero_comprovado");
  perto(z.lucro, 33, 1e-9, "frete 0 DIGITADO é zero comprovado e vale"); perto(z.mc, 0.33, 1e-9);

  for (const [k, acao] of [["sem_frete", "Revisar frete"], ["sem_custo", "Revisar custo/base"], ["sem_comissao", "Revisar comissão"],
    ["sem_imposto", "Revisar imposto/taxa fixa"], ["sem_taxa_fixa", "Revisar imposto/taxa fixa"]]) {
    const r = lido(k);
    eq([r.lucro, r.mc, r.sug, r.lsug], ["", "", "", ""], `${k}: nada financeiro é apresentado como válido`);
    eq(r.acao, acao, `${k}: decisão`);
    eq(r.adot, 100, `${k}: preço mantido`);
  }
  const sp = lido("sem_preco");
  eq([sp.lucro, sp.mc, sp.acao, sp.adot, sp.dif, sp.difp], ["", "", "Revisar preço", "", "", ""], "sem preço: nem 'Subir preço' nem preço adotado inventado");
  const nada = lido("sem_nada");
  eq([nada.lucro, nada.mc, nada.sug, nada.adot], ["", "", "", ""]);
  ok(/^Revisar/.test(nada.acao), nada.acao);

  // Sem margem alvo (planilha "sem base"): o preço sugerido NÃO pode virar o ponto de equilíbrio com U vazio tratado como 0%.
  const semAlvo = recalcular(construirWorkbookMatrizPrecificacao({ resumoRows: [["x", 1]], itens: [{ ...BASE }], margemAlvoPadrao: null })).Sheets["Matriz Mercado Livre"];
  eq([celula(semAlvo, "V4"), celula(semAlvo, "W4"), celula(semAlvo, "Y4")], ["", "", "Defina a margem alvo"], "margem alvo vazia ≠ 0%");
  perto(celula(semAlvo, "R4"), 18, 1e-9, "o lucro atual segue calculável sem margem alvo");
});

cenario("B. Alianza 1 (conta 86): frete da Central = Diagnóstico = planilha; lucro coerente; sem medidas bloqueia; só dados da conta", async () => {
  mundo.chamadas = [];
  mundo.seller = S86;
  process.env.FRETE_COTACAO_CONFIAVEL_SELLERS = S86;
  mundo.itens = {
    MLB4445939340: { preco: 84.9, seller: S86, tags: TAGS_PROX, cotacaoItem: NONE, dims: "28x23x4,324" },   // estimado pelas medidas declaradas
    MLB9000000002: { preco: 84.9, seller: S86, tags: TAGS_PROX, cotacaoItem: NONE, dims: null },            // sem medidas: desconhecido
    MLB7699058364: { preco: 104.92, seller: S86, tags: ["mandatory_free_shipping"], cotacaoItem: MAND(16.85), dims: null }, // controle sem proximity
    MLB7892951136: { preco: 169.66, seller: S87, tags: TAGS_PROX, cotacaoItem: NONE, dims: "40x30x8,1200" }, // OUTRA conta
  };
  mundo.custos = ["MLB4445939340", "MLB9000000002", "MLB7699058364", "MLB7892951136"].map((id) => ({ produto_id: id, custo_produto: 40, imposto_percentual: 13, taxa_fixa: 0 }));

  const { buffer } = await gerarPlanilhaPrecificacaoSemBase({ clienteSlugRaw: "alianza_jeans", clienteContaId: 86 });
  const wsEstatico = XLSX.read(buffer).Sheets["Matriz Mercado Livre"];
  const linhas = {};
  for (let r = 4; wsEstatico[`A${r}`]; r++) linhas[wsEstatico[`A${r}`].v] = r;
  eq(Object.keys(linhas).sort(), ["MLB4445939340", "MLB7699058364", "MLB9000000002"], "só os anúncios da conta 86 (o da 87 nem aparece)");

  // Central (cotação compartilhada) e Diagnóstico para o mesmo anúncio e preço.
  const central = await obterCotacaoAtual({ clienteId: 133, itemId: "MLB4445939340", listingTypeId: "gold_special", categoryId: "MLB1", sellerId: S86, logisticType: "cross_docking", mlUserId: S86, shippingTags: TAGS_PROX },
    { mlFetchFn: mlFetch, resolverPrecosItemFn: async () => ({ precoCheio: 84.9, precoPromocional: null, precoEfetivo: 84.9, fonte: "sale_price", promotionIdAtivo: null }) });
  const diag = await diagEnriquecerItem({ clienteId: 133, body: corpo("MLB4445939340"), baseRow: { custoProduto: 40, impostoPercentual: 13, taxaFixa: 0 }, margemAlvo: 0.1, mlUserId: S86 });
  const rEst = linhas.MLB4445939340;
  eq([central.fretePrevisto, diag.frete, wsEstatico[`J${rEst}`].v], [13.85, 13.85, 13.85], "frete: Central = Diagnóstico = célula da planilha (não 7,75)");
  eq(wsEstatico[`J${linhas.MLB7699058364}`].v, 16.85, "controle sem proximity: cotação do ML mantida");

  // Sem medidas: frete desconhecido nos três.
  const rDesc = linhas.MLB9000000002;
  const diagDesc = await diagEnriquecerItem({ clienteId: 133, body: corpo("MLB9000000002"), baseRow: { custoProduto: 40, impostoPercentual: 13, taxaFixa: 0 }, margemAlvo: 0.1, mlUserId: S86 });
  eq([diagDesc.frete, diagDesc.lc, diagDesc.diagnostico, wsEstatico[`J${rDesc}`]], [null, null, "sem_frete", undefined], "frete desconhecido: nulo no Diagnóstico e CÉLULA VAZIA na planilha");

  if (TEM_SOFFICE) {
    const ws = recalcular(buffer).Sheets["Matriz Mercado Livre"];
    perto(celula(ws, `R${rEst}`), diag.lc, 0.01, "lucro da planilha = lucro do Diagnóstico (84,90 → ≈ 8,12)");
    perto(celula(ws, `R${rEst}`), 8.12, 0.02, "caso de regressão MLB4445939340");
    perto(celula(ws, `S${rEst}`), diag.mc, 0.001, "MC da planilha = MC do Diagnóstico");
    eq([celula(ws, `R${rDesc}`), celula(ws, `S${rDesc}`), celula(ws, `V${rDesc}`), celula(ws, `Y${rDesc}`)], ["", "", "", "Revisar frete"],
      "sem medidas: lucro/MC/sugerido ausentes e decisão 'Revisar frete' (antes: lucro inflado com frete 0)");
  }

  // Dados só da conta: nenhuma chamada fora do token e do seller da 86; somente GET.
  ok(mundo.chamadas.length > 0 && mundo.chamadas.every((c) => c.mlUserId === S86 && c.method === "GET"), "só GET, sempre com a conta 86");
  ok(!mundo.chamadas.some((c) => c.p.includes("MLB7892951136") || c.p.includes(`/users/${S87}/`)), "nenhuma leitura de anúncio ou seller da conta 87");
  delete process.env.FRETE_COTACAO_CONFIAVEL_SELLERS;
});

cenario("B2. seller NÃO liberado: planilha segue o comportamento antigo (frete do item_id), sem mudar de conta", async () => {
  mundo.chamadas = [];
  mundo.seller = S86;
  delete process.env.FRETE_COTACAO_CONFIAVEL_SELLERS;
  mundo.itens = { MLB4445939340: { preco: 84.9, seller: S86, tags: TAGS_PROX, cotacaoItem: NONE, dims: "28x23x4,324" } };
  mundo.custos = [{ produto_id: "MLB4445939340", custo_produto: 40, imposto_percentual: 13, taxa_fixa: 0 }];
  const { buffer } = await gerarPlanilhaPrecificacaoSemBase({ clienteSlugRaw: "alianza_jeans", clienteContaId: 86 });
  const ws = XLSX.read(buffer).Sheets["Matriz Mercado Livre"];
  eq(ws.J4.v, 7.75, "fora da liberação nada muda (7,75 do item_id)");
});

cenario("C. exportação de relatório SALVO é identificável como histórica; planilha recém-gerada, como recotada", async () => {
  const pool = require("../config/database");
  const relatorio = { id: 7, cliente_slug: "alianza_jeans", base_slug: "base-1", escopo: "loja_completa", status: "concluido", margem_alvo: 0.1, total_itens: 1, itens_com_base: 1,
    itens_sem_base: 0, itens_criticos: 0, itens_atencao: 0, itens_saudaveis: 1, mc_media: 0.18, observacoes: null, created_at: "2026-10-01T12:00:00.000Z" };
  const item = { id: 1, item_id: "MLB1", sku: null, titulo: "t", status_anuncio: "active", listing_type_id: "gold_special", preco_original: 100, preco_promocional: null, preco_efetivo: 100,
    custo: 40, imposto_percentual: 13, taxa_fixa: 0, frete: 7.75, comissao: 14, comissao_percentual: 14, lc: 33, mc: 0.33, preco_alvo: null, preco_sugerido: null, diferenca_preco: null,
    acao_recomendada: null, explicacao_calculo: null, diagnostico: "saudavel", tem_base: true };
  const original = pool.query;
  pool.query = async (sql) => (/FROM relatorios/.test(sql) ? { rows: [relatorio] } : { rows: [item] });
  try {
    const csv = await gerarExportRelatorioCsv({ idRaw: "7" });
    const texto = csv.bufferOrText;
    ok(/Origem dos dados,"?DADOS HISTÓRICOS/.test(texto) && /NÃO foram recotados/.test(texto), "CSV rotula o relatório salvo como histórico");
    ok(/7\.75/.test(texto), "o valor histórico é preservado como está (relatório antigo não é atualizado em silêncio)");
    const x = await gerarExportRelatorioXlsx({ idRaw: "7" });
    const wb = XLSX.read(x.buffer, { cellNF: true });
    const resumo = XLSX.utils.sheet_to_json(wb.Sheets.Resumo, { header: 1 });
    ok(resumo.some((l) => l[0] === "Origem dos dados" && /HISTÓRICO/.test(l[1])), "resumo do XLSX: origem histórica");
    ok(resumo.some((l) => l[0] === "Recotado agora?" && /^NÃO/.test(l[1])), "resumo do XLSX: 'Recotado agora? NÃO'");
    ok(/DADOS HISTÓRICOS/.test(wb.Sheets["Matriz Mercado Livre"].A1.v), "topo da matriz avisa que são dados históricos");
    eq(wb.Sheets["Matriz Mercado Livre"].J4.v, 7.75, "frete histórico preservado na célula");
    eq(wb.Sheets.Resumo.B5.z, "0.00%", "formatos do resumo não se deslocaram (B5 = margem alvo)");
  } finally { pool.query = original; }
  // Planilha recém-gerada (sem base): rótulo de recotada.
  mundo.seller = S86; delete process.env.FRETE_COTACAO_CONFIAVEL_SELLERS;
  mundo.itens = { MLB4445939340: { preco: 84.9, seller: S86, tags: TAGS_PROX, cotacaoItem: NONE, dims: null } };
  mundo.custos = [];
  const { buffer } = await gerarPlanilhaPrecificacaoSemBase({ clienteSlugRaw: "alianza_jeans", clienteContaId: 86 });
  const wb2 = XLSX.read(buffer);
  ok(/DADOS RECOTADOS/.test(wb2.Sheets["Matriz Mercado Livre"].A1.v), "planilha nova: dados recotados");
  ok(XLSX.utils.sheet_to_json(wb2.Sheets.Resumo, { header: 1 }).some((l) => l[0] === "Origem dos dados" && /RECOTADO/.test(l[1])), "resumo: recotado");
});

cenario("D. Portal de relatórios salvos: frete/comissão NULOS não viram 0 (Number(null) === 0) — código real do relatorios.js", () => {
  const vm = require("vm");
  const fonte = fs.readFileSync(path.join(__dirname, "../../Portal/relatorios.js"), "utf8");
  const corte = (ini, fim) => { const i = fonte.indexOf(ini); const j = fonte.indexOf(fim, i); assert.ok(i >= 0 && j > i, `trecho ${ini}`); return fonte.slice(i, j); };
  const ctx = vm.createContext({});
  vm.runInContext(corte("function numOuNulo", "const PRIORIDADE_RANK"), ctx);
  eq([ctx.numOuNulo(null), ctx.numOuNulo(undefined), ctx.numOuNulo(""), ctx.numOuNulo("x"), ctx.numOuNulo(0), ctx.numOuNulo("13.85")], [null, null, null, null, 0, 13.85], "zero é zero; ausente é nulo");
  const d = (item) => ctx.diagnosticoItemSalvo({ tem_base: true, diagnostico: "saudavel", frete: 10, comissao: 14, ...item }).key;
  eq(d({ frete: null }), "sem_frete", "frete nulo = 'Sem frete' (antes: tratado como R$ 0 e 'saudável')");
  eq(d({ comissao: null }), "sem_comissao");
  eq(d({ frete: 0 }), "saudavel", "frete 0 comprovado continua válido");
  eq(d({}), "saudavel");
  ok(!/Number\.isFinite\(Number\(it\.(frete|comissao)\)\)/.test(fonte), "filtros 'sem frete'/'sem comissão' não usam mais Number(null)");
});

(async () => {
  let falhas = 0;
  for (const { n, f } of casos) {
    try { await f(); console.log(`  ✓ ${n}`); } catch (e) { falhas += 1; console.log(`  ✗ ${n}\n    ${e && e.stack ? e.stack.split("\n").slice(0, 6).join("\n    ") : e}`); }
  }
  console.log(`\nxlsxMatrizFreteIntegridade: ${casos.length - falhas}/${casos.length} cenários, ${checks} checks${TEM_SOFFICE ? "" : " (recálculo real pulado: sem soffice)"}`);
  if (falhas) process.exit(1);
  process.exit(0);
})();
