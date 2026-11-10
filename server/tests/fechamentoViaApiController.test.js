// server/tests/fechamentoViaApiController.test.js
//
// Contrato HTTP do fechamento pela API (Central de Vendas):
//   - rotas registradas com os mesmos middlewares das demais de /financeiro;
//   - controller repassa cliente/conta/período/ajustes ao service;
//   - envelope de erro { ok:false, error, code } com o status do service;
//   - sucesso devolve o JSON do service com ok:true (status) ou direto (POST);
//   - POST aceita JSON e multipart (planilha de custos em `costs`, 20 MB),
//     testado por HTTP de verdade com o multer da rota.
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
  eq("POST tem 5 etapas (3 middlewares + upload de custos + controller)", postRota.route.stack.length, 5);
  eq("GET status termina no controller fechamentoApiStatus", statusRota.route.stack[3].handle, controller.fechamentoApiStatus);
  eq("POST termina no controller fechamentoApi", postRota.route.stack[4].handle, controller.fechamentoApi);

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
  eq("POST JSON: custosOrigem ausente vai como undefined (padrão sync no service)", ultimo.custosOrigemRaw, undefined);
  eq("POST JSON: sem arquivo de custos", ultimo.custosArquivo, null);

  console.log("\n▸ POST por HTTP: JSON e multipart");

  const express = require("express");
  const app = express();
  app.use(express.json());
  // Só o upload de custos + controller da rota real (auth/carteira ficam de fora).
  app.post("/financeiro/:cliente/fechamento-api", postRota.route.stack[3].handle, controller.fechamentoApi);
  const servidor = await new Promise((resolve) => {
    const srv = app.listen(0, "127.0.0.1", () => resolve(srv));
  });
  const url = `http://127.0.0.1:${servidor.address().port}/financeiro/dual/fechamento-api`;
  try {
    let http = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clienteContaId: 48, periodo: "2026-10", custosOrigem: "base" }),
    });
    eq("HTTP JSON: 200", http.status, 200);
    eq("HTTP JSON: custosOrigem repassado", chamadas.gerar.at(-1).custosOrigemRaw, "base");
    eq("HTTP JSON: sem arquivo", chamadas.gerar.at(-1).custosArquivo, null);

    const conteudo = Buffer.from("planilha de custos fake");
    const form = new FormData();
    form.append("clienteContaId", "48");
    form.append("periodo", "2026-10");
    form.append("ads", "10,50");
    form.append("custosOrigem", "upload");
    form.append("costs", new Blob([conteudo]), "Custos - RIKAM - MeLi.xlsx");
    http = await fetch(url, { method: "POST", body: form });
    eq("HTTP multipart: 200", http.status, 200);
    const viaForm = chamadas.gerar.at(-1);
    eq("HTTP multipart: conta e período do form", [viaForm.clienteContaIdRaw, viaForm.periodoRaw], ["48", "2026-10"]);
    eq("HTTP multipart: ajuste do form", viaForm.ajustesRaw.ads, "10,50");
    eq("HTTP multipart: custosOrigem upload", viaForm.custosOrigemRaw, "upload");
    eq("HTTP multipart: buffer do arquivo chega inteiro", Buffer.compare(viaForm.custosArquivo.buffer, conteudo), 0);
    eq("HTTP multipart: nome do arquivo", viaForm.custosArquivo.originalname, "Custos - RIKAM - MeLi.xlsx");

    const antes = chamadas.gerar.length;
    const grande = new FormData();
    grande.append("custosOrigem", "upload");
    grande.append("costs", new Blob([Buffer.alloc(20 * 1024 * 1024 + 1)]), "grande.xlsx");
    http = await fetch(url, { method: "POST", body: grande });
    eq("HTTP multipart > 20 MB: 413", http.status, 413);
    eq("HTTP multipart > 20 MB: envelope do fechamento", await http.json(), {
      ok: false,
      error: "A planilha de custos passa de 20 MB.",
      code: "CUSTOS_ARQUIVO_GRANDE",
    });
    eq("HTTP multipart > 20 MB: service não é chamado", chamadas.gerar.length, antes);

    const outroCampo = new FormData();
    outroCampo.append("sales", new Blob([conteudo]), "vendas.xlsx");
    http = await fetch(url, { method: "POST", body: outroCampo });
    eq("HTTP multipart com campo de arquivo desconhecido: 400", http.status, 400);
    eq("HTTP multipart com campo desconhecido: código", (await http.json()).code, "UPLOAD_INVALIDO");
  } finally {
    await new Promise((resolve) => servidor.close(resolve));
  }

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
