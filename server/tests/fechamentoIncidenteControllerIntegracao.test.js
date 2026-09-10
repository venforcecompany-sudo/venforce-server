// server/tests/fechamentoIncidenteControllerIntegracao.test.js
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/vf-test";

const assert = require("assert");
const XLSX = require("xlsx");
const Module = require("module");

let checks = 0;
function ok(label, condition) { assert.ok(condition, label); checks += 1; console.log(`  ok  ${label}`); }

// Fake do storage service: nunca toca em Postgres de verdade nestes testes.
const originalLoad = Module._load;
const chamadasSaveIncidente = [];
let falharProximoSave = false;
const fakeStorage = {
  async saveIncidente(args) {
    chamadasSaveIncidente.push(args);
    if (falharProximoSave) return null;
    return { codigo: "FIN-184" };
  },
};
Module._load = function (request, parent, isMain) {
  if (request.endsWith("incidente/fechamentoIncidentStorageService")) return fakeStorage;
  return originalLoad(request, parent, isMain);
};
const { processarFechamentoFinanceiroController } = require("../controllers/fechamentosFinanceiroController");
Module._load = originalLoad;

function toBuffer(aoa) {
  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Planilha1");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}
function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (p) => { res.body = p; return res; };
  return res;
}

const SHOPEE_HEADERS = [
  "ID do pedido", "Status do pedido", "Status da devolução / reembolso",
  "Nome do produto", "SKU da variação", "Quantidade",
  "Preço acordado", "Subtotal do produto", "Repasse",
  "Taxa de transação", "Taxa de comissão líquida", "Taxa de serviço líquida",
  "Valor estimado do frete", "Imposto", "CMV",
];

const SALES_SHOPEE_SEM_CUSTO = toBuffer([
  SHOPEE_HEADERS,
  ["P-1", "Concluído", "", "Produto sem custo", "SKU-SEM-CUSTO", 1, 100, 100, 80, -2, -14, -4, "", "", ""],
]);
const COSTS_SHOPEE_VAZIO = toBuffer([["sku", "custo", "imposto"], ["SKU-OUTRO", 30, "0%"]]);

async function testFechamentoComCustoAusenteCriaIncidente() {
  chamadasSaveIncidente.length = 0;
  const req = {
    files: { sales: [{ buffer: SALES_SHOPEE_SEM_CUSTO, originalname: "sales.xlsx", mimetype: "application/vnd.ms-excel" }], costs: [{ buffer: COSTS_SHOPEE_VAZIO, originalname: "costs.xlsx" }] },
    body: { marketplace: "shopee", ads: "0", venforce: "0", affiliates: "0" },
    user: { id: 7 },
  };
  const res = fakeRes();
  await processarFechamentoFinanceiroController(req, res);
  ok("resposta continua ok:true", res.body.ok === true);
  ok("saveIncidente foi chamado", chamadasSaveIncidente.length === 1);
  ok("código do incidente foi devolvido na resposta", res.body.incidente?.codigo === "FIN-184");
  ok("arquivos exatos (buffers) foram passados ao storage", chamadasSaveIncidente[0].files.some((f) => f.tipoArquivo === "sales" && f.buffer === SALES_SHOPEE_SEM_CUSTO));
}

async function testFalhaAoSalvarIncidenteNaoQuebraResposta() {
  chamadasSaveIncidente.length = 0;
  falharProximoSave = true;
  const req = {
    files: { sales: [{ buffer: SALES_SHOPEE_SEM_CUSTO, originalname: "sales.xlsx" }], costs: [{ buffer: COSTS_SHOPEE_VAZIO, originalname: "costs.xlsx" }] },
    body: { marketplace: "shopee", ads: "0", venforce: "0", affiliates: "0" },
    user: { id: 7 },
  };
  const res = fakeRes();
  await processarFechamentoFinanceiroController(req, res);
  ok("resposta ok:true mesmo com falha de storage", res.body.ok === true);
  ok("resposta não tem campo incidente quando storage falhou", res.body.incidente === undefined);
  falharProximoSave = false;
}

async function testExcecaoDeProcessamentoTentaCriarIncidenteEDevolveErroOriginal() {
  chamadasSaveIncidente.length = 0;
  // clienteContaId sem cliente_slug faz validarContaDoCliente LANÇAR (throw
  // real, statusCode 400) depois que os arquivos já foram recebidos — é o
  // caminho de exceção real do controller, não um `return` de validação
  // precoce (esses últimos não tentam captura, de propósito: não são
  // anomalia de processamento).
  const req = {
    files: { sales: [{ buffer: SALES_SHOPEE_SEM_CUSTO, originalname: "sales.xlsx" }], costs: [{ buffer: COSTS_SHOPEE_VAZIO, originalname: "costs.xlsx" }] },
    body: { marketplace: "shopee", ads: "0", venforce: "0", affiliates: "0", clienteContaId: "5" },
    user: { id: 7 },
  };
  const res = fakeRes();
  await processarFechamentoFinanceiroController(req, res);
  ok("erro original é preservado (não veio ok:true)", res.body.ok === false);
  ok("statusCode do erro original preservado (400)", res.statusCode === 400);
  ok("saveIncidente foi tentado mesmo com exceção", chamadasSaveIncidente.length === 1);
  ok("trigger de exceção registrado", chamadasSaveIncidente[0].triggerPrincipal === "excecao_processamento");
}

async function testFechamentoNormalNaoCriaIncidente() {
  chamadasSaveIncidente.length = 0;
  const salesOk = toBuffer([
    SHOPEE_HEADERS,
    ["P-1", "Concluído", "", "Produto A", "SKU-A", 1, 100, 100, 80, -2, -14, -4, "", "", ""],
  ]);
  const costsOk = toBuffer([["sku", "custo", "imposto"], ["SKU-A", 30, "0%"]]);
  const req = {
    files: { sales: [{ buffer: salesOk, originalname: "sales.xlsx" }], costs: [{ buffer: costsOk, originalname: "costs.xlsx" }] },
    body: { marketplace: "shopee", ads: "0", venforce: "0", affiliates: "0" },
    user: { id: 7 },
  };
  const res = fakeRes();
  await processarFechamentoFinanceiroController(req, res);
  ok("fechamento sem anomalia não chama saveIncidente", chamadasSaveIncidente.length === 0);
  ok("resposta não tem campo incidente", res.body.incidente === undefined);
}

(async () => {
  await testFechamentoNormalNaoCriaIncidente();
  await testFechamentoComCustoAusenteCriaIncidente();
  await testFalhaAoSalvarIncidenteNaoQuebraResposta();
  await testExcecaoDeProcessamentoTentaCriarIncidenteEDevolveErroOriginal();
  console.log(`\n${checks} checks ok`);
})();
