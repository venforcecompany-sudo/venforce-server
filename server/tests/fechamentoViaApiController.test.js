// server/tests/fechamentoViaApiController.test.js
//
// Contrato HTTP do fechamento pela API (Central de Vendas):
//   - rotas registradas com os mesmos middlewares das demais de /financeiro;
//   - controller repassa cliente/conta/período/ajustes ao service;
//   - envelope de erro { ok:false, error, code } com o status do service;
//   - sucesso devolve o JSON do service com ok:true (status) ou direto (POST).
//
// O service é trocado por um stub no require.cache antes de carregar o
// controller: nenhum banco, nenhuma chamada real.

process.env.DATABASE_URL = "postgres://nobody@127.0.0.1:1/teste-sem-banco";

const assert = require("assert");

let checks = 0;
let concluido = false;
process.on("exit", () => {
  if (!concluido) {
    console.error(`fechamentoViaApiController.test.js: NÃO concluiu (parou após ${checks} verificações)`);
    process.exitCode = 1;
  }
});
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, `${label}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  checks += 1;
  console.log(`  ok  ${label}`);
}
function ok(label, condition) {
  assert.ok(condition, `FALHOU: ${label}`);
  checks += 1;
  console.log(`  ok  ${label}`);
}

// ─── stub do service ────────────────────────────────────────────────────────

const chamadas = { status: [], gerar: [] };
let modoErro = null;

const servicePath = require.resolve("../services/fechamentoFinanceiro/fechamentoViaApiService");
require.cache[servicePath] = {
  id: servicePath,
  filename: servicePath,
  loaded: true,
  exports: {
    async obterStatusFechamentoViaApi(args) {
      chamadas.status.push(args);
      if (modoErro) throw modoErro;
      return { marketplace: "meli", periodo: args.periodoRaw, sync: { disponivel: false, completo: false }, runEmAndamento: null };
    },
    async gerarFechamentoViaApi(args) {
      chamadas.gerar.push(args);
      if (modoErro) throw modoErro;
      return { ok: true, fonteVendas: "api", summary: { finalResult: 1 } };
    },
  },
};

const controller = require("../controllers/financeiroVisaoController");
const router = require("../routes/financeiroVisaoRoutes");

function resposta() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

(async function main() {
  console.log("\n▸ Rotas e middlewares");

  const rotaDe = (caminho, metodo) =>
    router.stack.find((layer) => layer.route && layer.route.path === caminho && layer.route.methods[metodo]);

  const statusRota = rotaDe("/:cliente/fechamento-api/status", "get");
  const postRota = rotaDe("/:cliente/fechamento-api", "post");
  ok("GET status registrado", !!statusRota);
  ok("POST fechamento registrado", !!postRota);

  // authMiddleware, requireAutomacoesAccess, requireClienteNaCarteira(...) e o handler
  eq("GET status tem 4 etapas (3 middlewares + controller)", statusRota.route.stack.length, 4);
  eq("POST tem 4 etapas (3 middlewares + controller)", postRota.route.stack.length, 4);
  eq("GET status termina no controller fechamentoApiStatus", statusRota.route.stack[3].handle, controller.fechamentoApiStatus);
  eq("POST termina no controller fechamentoApi", postRota.route.stack[3].handle, controller.fechamentoApi);

  console.log("\n▸ Status: repasse e envelope");

  let res = resposta();
  await controller.fechamentoApiStatus(
    { params: { cliente: "dual" }, query: { conta: "48", periodo: "2026-10" } },
    res
  );
  eq("status: HTTP 200", res.statusCode, 200);
  eq("status: ok true no envelope", res.body.ok, true);
  eq("status: repassa cliente, conta e período", chamadas.status.at(-1), {
    clienteSlugRaw: "dual",
    clienteContaIdRaw: "48",
    periodoRaw: "2026-10",
  });

  console.log("\n▸ POST: repasse do body");

  res = resposta();
  await controller.fechamentoApi(
    {
      params: { cliente: "dual" },
      body: { clienteContaId: 48, periodo: "2026-10", ads: "1.234,56", venforce: "0" },
    },
    res
  );
  eq("POST: HTTP 200", res.statusCode, 200);
  eq("POST: resposta é a do service", res.body, { ok: true, fonteVendas: "api", summary: { finalResult: 1 } });
  const ultimo = chamadas.gerar.at(-1);
  eq("POST: cliente", ultimo.clienteSlugRaw, "dual");
  eq("POST: conta do body", ultimo.clienteContaIdRaw, 48);
  eq("POST: período do body", ultimo.periodoRaw, "2026-10");
  eq("POST: ajustes vão crus (parse fica no service)", ultimo.ajustesRaw.ads, "1.234,56");

  console.log("\n▸ Erros: envelope { ok, error, code }");

  const erro = Object.assign(new Error("Não há sincronização da Central de Vendas para esta competência."), {
    statusCode: 409,
    code: "CENTRAL_SEM_SYNC",
  });
  modoErro = erro;
  res = resposta();
  await controller.fechamentoApi({ params: { cliente: "dual" }, body: { clienteContaId: 48, periodo: "2026-10" } }, res);
  eq("erro: HTTP do service", res.statusCode, 409);
  eq("erro: envelope ok false", res.body.ok, false);
  eq("erro: campo error (não erro)", res.body.error, erro.message);
  eq("erro: código canônico", res.body.code, "CENTRAL_SEM_SYNC");
  ok("erro: não usa o campo erro do módulo", !("erro" in res.body));

  const semCodigo = Object.assign(new Error("falha inesperada"), {});
  modoErro = semCodigo;
  res = resposta();
  await controller.fechamentoApiStatus({ params: { cliente: "dual" }, query: {} }, res);
  eq("erro sem statusCode vira 500", res.statusCode, 500);
  ok("erro sem código não inventa code", !("code" in res.body));
  modoErro = null;

  concluido = true;
  console.log(`\n✓ fechamentoViaApiController.test.js — ${checks} verificações`);
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
