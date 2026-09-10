// server/tests/fechamentoIncidenteBaseVinculada.test.js
//
// Integração das DUAS features que se cruzaram na main:
//   · Caixa-preta do fechamento (incidente FIN-xxx) — vinda da main;
//   · Base de custos vinculada no Shopee, isolada por clienteContaId — vinda
//     desta branch.
//
// Cenário exato pedido na missão de integração:
//   SHOPEE + clienteContaId + base vinculada + SEM upload de custos
//   + processamento com anomalia (SKU sem custo)
//   → usa a base da conta certa
//   → cria FIN-xxx
//   → o incidente registra costsSource="base" e a identificação da base
//   → (frontend: banner FIN — coberto em NovoFechamento.test.jsx)

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/vf-test";

const assert = require("assert");
const XLSX = require("xlsx");
const Module = require("module");

let checks = 0;
function ok(label, condition) { assert.ok(condition, label); checks += 1; console.log(`  ok  ${label}`); }

// ── Fake do storage do incidente (nunca toca Postgres) ────────────────────
const chamadasSaveIncidente = [];
const originalLoad = Module._load;
const fakeStorage = {
  async saveIncidente(args) {
    chamadasSaveIncidente.push(args);
    return { codigo: "FIN-777" };
  },
};
Module._load = function (request, parent, isMain) {
  if (request.endsWith("incidente/fechamentoIncidentStorageService")) return fakeStorage;
  return originalLoad(request, parent, isMain);
};
const { processarFechamentoFinanceiroController } = require("../controllers/fechamentosFinanceiroController");
Module._load = originalLoad;

// ── Mock de pool.query: cliente + conta (validarContaDoCliente) + o vínculo
//    Shopee da conta 38 + os custos da base. A conta 39 tem OUTRA base — o
//    teste prova que a conta 38 nunca usa a base da 39. ─────────────────────
const pool = require("../config/database");
const CLIENTE = { id: 1, nome: "Zenite", slug: "zenite", ativo: true };
const CONTA_38 = { id: 38, cliente_id: 1, marketplace: "shopee", nome: "Shopee 38", ativo: true, is_primary: true };
const BASE_38 = { id: 55, slug: "comprou_chegou_shopee1", nome: "Comprou_chegou_shopee1" };
const BASE_39 = { id: 66, slug: "shopee_conta_39", nome: "Shopee Conta 39" };
const CUSTOS_BASE_38 = [
  // Só SKU-A tem custo → a venda de SKU-SEM-CUSTO fica sem custo → anomalia.
  { produto_id: "1001", sku_id: "", sku: "SKU-A", custo_produto: 30, imposto_percentual: 0, id_model: "5001", produto_nome: "Produto A", variacao_nome: "P" },
];
const CUSTOS_BASE_39 = [
  { produto_id: "9999", sku_id: "", sku: "SKU-SEM-CUSTO", custo_produto: 30, imposto_percentual: 0, id_model: "6001", produto_nome: "Outra", variacao_nome: "U" },
];

const originalQuery = pool.query;
pool.query = async (sql, params = []) => {
  const q = String(sql).replace(/\s+/g, " ").trim();

  if (q.startsWith("SELECT id, nome, slug, ativo FROM clientes WHERE slug = $1")) {
    return { rows: params[0] === "zenite" ? [CLIENTE] : [] };
  }
  if (q.startsWith("SELECT * FROM cliente_contas WHERE id = $1")) {
    return { rows: Number(params[0]) === 38 ? [CONTA_38] : [] };
  }
  if (q.includes("FROM bases b") && q.includes("JOIN base_cliente_vinculos v")) {
    const [slug, mkt] = params;
    if (slug === "zenite" && mkt === "shopee") {
      return {
        rows: [
          { id: BASE_39.id, slug: BASE_39.slug, nome: BASE_39.nome, cliente_conta_id: 39, updated_at: "2026-09-05" },
          { id: BASE_38.id, slug: BASE_38.slug, nome: BASE_38.nome, cliente_conta_id: 38, updated_at: "2026-09-01" },
        ],
      };
    }
    return { rows: [] };
  }
  if (q.includes("FROM custos") && q.includes("WHERE base_id = $1")) {
    if (Number(params[0]) === BASE_38.id) return { rows: CUSTOS_BASE_38 };
    if (Number(params[0]) === BASE_39.id) return { rows: CUSTOS_BASE_39 };
    return { rows: [] };
  }
  throw new Error(`Query nao mockada no teste de integracao: ${q.slice(0, 140)}`);
};

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
const SALES_COM_SKU_SEM_CUSTO = toBuffer([
  SHOPEE_HEADERS,
  ["P-1", "Concluído", "", "Produto A", "SKU-A", 1, 100, 100, 80, -2, -14, -4, "", "", ""],
  ["P-2", "Concluído", "", "Produto Sem Custo", "SKU-SEM-CUSTO", 1, 100, 100, 80, -2, -14, -4, "", "", ""],
]);

async function run() {
  chamadasSaveIncidente.length = 0;
  const req = {
    // SEM arquivo de custos: o backend resolve pela base vinculada DA CONTA.
    files: { sales: [{ buffer: SALES_COM_SKU_SEM_CUSTO, originalname: "vendas.xlsx", mimetype: "application/vnd.ms-excel" }] },
    body: {
      marketplace: "shopee",
      cliente_slug: "zenite",
      clienteContaId: "38",
      periodo: "2026-08",
      ads: "0", venforce: "0", affiliates: "0",
    },
    user: { id: 7 },
  };
  const res = fakeRes();
  await processarFechamentoFinanceiroController(req, res);

  ok("resposta continua ok:true (incidente nunca afeta o resultado)", res.body.ok === true);
  ok("os custos vieram da BASE, não de upload", res.body.costsSource === "base");
  ok("usou a base da CONTA 38 (nunca a base 66 da conta 39)", res.body.costsBase && res.body.costsBase.id === BASE_38.id);
  ok("base resolvida traz slug/nome", res.body.costsBase.slug === BASE_38.slug && res.body.costsBase.nome === BASE_38.nome);
  ok("houve anomalia (SKU sem custo) → incidente criado", chamadasSaveIncidente.length === 1);
  ok("o código FIN-xxx voltou na resposta", res.body.incidente && res.body.incidente.codigo === "FIN-777");

  const ctx = chamadasSaveIncidente[0].context;
  ok("incidente carrega o clienteContaId da operação", ctx.clienteContaId === 38);
  ok("incidente registra costsSource='base'", ctx.metadata.costsSource === "base");
  ok("incidente registra costsBaseId da base da conta 38", ctx.metadata.costsBaseId === BASE_38.id);
  ok(
    "incidente registra slug/nome da base",
    ctx.metadata.costsBase && ctx.metadata.costsBase.slug === BASE_38.slug && ctx.metadata.costsBase.nome === BASE_38.nome
  );
  ok("o arquivo de vendas (buffer exato) foi preservado", chamadasSaveIncidente[0].files.some((f) => f.tipoArquivo === "sales" && f.buffer === SALES_COM_SKU_SEM_CUSTO));
  ok("nenhum arquivo de custos foi anexado (não houve upload)", !chamadasSaveIncidente[0].files.some((f) => f.tipoArquivo === "costs"));

  // Segunda passada: falha no storage do incidente NUNCA quebra o fechamento.
  chamadasSaveIncidente.length = 0;
  const storageOriginal = fakeStorage.saveIncidente;
  fakeStorage.saveIncidente = async () => { throw new Error("storage indisponível"); };
  const res2 = fakeRes();
  await processarFechamentoFinanceiroController(req, res2);
  fakeStorage.saveIncidente = storageOriginal;
  ok("storage do incidente lançou, mas o fechamento seguiu ok:true", res2.body.ok === true);
  ok("sem código de incidente quando o storage falha (não inventa)", res2.body.incidente === undefined);
  ok("o resultado (costsSource=base) continua correto mesmo com a caixa-preta fora do ar", res2.body.costsSource === "base");

  console.log(`\n${checks} checks ok — fechamentoIncidenteBaseVinculada`);
}

run()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => { pool.query = originalQuery; });
