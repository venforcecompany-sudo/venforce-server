// server/tests/fechamentoIncidentesController.test.js
const assert = require("assert");
const Module = require("module");

let checks = 0;
function ok(label, condition) { assert.ok(condition, label); checks += 1; console.log(`  ok  ${label}`); }

const originalLoad = Module._load;
const fakeStorage = {
  async listarIncidentes() { return [{ id: 1, codigo: "FIN-184", marketplace: "shopee" }]; },
  async getIncidenteDetalhado(codigo) {
    return codigo === "FIN-184" ? { id: 1, codigo: "FIN-184", marketplace: "shopee", arquivos: [] } : null;
  },
  async getArquivoParaDownload(codigo, arquivoId) {
    return codigo === "FIN-184" && Number(arquivoId) === 1
      ? { buffer: Buffer.from("dados"), nomeOriginal: "sales.xlsx", mimeType: "application/octet-stream" }
      : null;
  },
};
Module._load = function (request, parent, isMain) {
  if (request.endsWith("incidente/fechamentoIncidentStorageService")) return fakeStorage;
  return originalLoad(request, parent, isMain);
};
const controller = require("../controllers/fechamentoIncidentesController");
Module._load = originalLoad;

function fakeRes() {
  const res = { statusCode: 200, body: null, headers: {} };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (p) => { res.body = p; return res; };
  res.set = (h) => { Object.assign(res.headers, h); return res; };
  res.send = (b) => { res.body = b; return res; };
  return res;
}

async function testListarIncidentes() {
  const res = fakeRes();
  await controller.listarIncidentesController({ query: {} }, res);
  ok("lista incidentes", Array.isArray(res.body.incidentes) && res.body.incidentes[0].codigo === "FIN-184");
}

async function testDetalharIncidenteExistente() {
  const res = fakeRes();
  await controller.detalharIncidenteController({ params: { codigo: "FIN-184" } }, res);
  ok("detalha incidente existente", res.body.incidente.codigo === "FIN-184");
}

async function testDetalharIncidenteInexistenteDevolve404() {
  const res = fakeRes();
  await controller.detalharIncidenteController({ params: { codigo: "FIN-999" } }, res);
  ok("incidente inexistente devolve 404", res.statusCode === 404);
}

async function testDownloadArquivoExistente() {
  const res = fakeRes();
  await controller.baixarArquivoIncidenteController({ params: { codigo: "FIN-184", arquivoId: "1" } }, res);
  ok("download devolve conteúdo", Buffer.isBuffer(res.body) && res.body.toString() === "dados");
  ok("Content-Disposition presente", String(res.headers["Content-Disposition"] || "").includes("sales.xlsx"));
}

async function testDownloadArquivoInexistenteOuExpiradoDevolve404() {
  const res = fakeRes();
  await controller.baixarArquivoIncidenteController({ params: { codigo: "FIN-184", arquivoId: "999" } }, res);
  ok("arquivo inexistente/expirado devolve 404", res.statusCode === 404);
}

(async () => {
  await testListarIncidentes();
  await testDetalharIncidenteExistente();
  await testDetalharIncidenteInexistenteDevolve404();
  await testDownloadArquivoExistente();
  await testDownloadArquivoInexistenteOuExpiradoDevolve404();
  console.log(`\n${checks} checks ok`);
})();
