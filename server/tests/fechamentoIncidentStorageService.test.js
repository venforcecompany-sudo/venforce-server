// server/tests/fechamentoIncidentStorageService.test.js
const assert = require("assert");
const crypto = require("crypto");
const Module = require("module");

let checks = 0;
function ok(label, condition) { assert.ok(condition, label); checks += 1; console.log(`  ok  ${label}`); }

// Substitui o repository real por um fake ANTES do require do service, para
// não depender de Postgres real nestes testes (mesmo espírito dos outros
// testes do projeto que injetam um `db`/repo fake).
const originalLoad = Module._load;
const fakeRepo = {
  createCalls: [],
  arquivoCalls: [],
  async ensureFechamentoIncidenteTables() {},
  async createIncidente(data) {
    fakeRepo.createCalls.push(data);
    return { id: 184, codigo: "FIN-184" };
  },
  async addArquivo(incidenteId, arquivo) {
    fakeRepo.arquivoCalls.push({ incidenteId, arquivo });
    return { id: fakeRepo.arquivoCalls.length };
  },
  async getIncidenteByCodigo(codigo) {
    return codigo === "FIN-184" ? { id: 184, codigo: "FIN-184", marketplace: "shopee" } : null;
  },
  async listArquivosByIncidenteId() { return []; },
  async getArquivo(incidenteId, arquivoId) {
    if (incidenteId === 184 && arquivoId === 1) {
      return { id: 1, nome_original: "sales.xlsx", mime_type: "application/octet-stream", conteudo: Buffer.from("abc"), conteudo_truncado: false };
    }
    return null;
  },
  async listIncidentes() { return []; },
  async cleanupExpirados() { return { incidentesRemovidos: 0 }; },
};
Module._load = function (request, parent, isMain) {
  if (request.endsWith("fechamentoIncidenteRepository")) return fakeRepo;
  return originalLoad(request, parent, isMain);
};
const storage = require("../services/fechamentoFinanceiro/incidente/fechamentoIncidentStorageService");
Module._load = originalLoad;

async function testSaveIncidentePersisteBuffersESha256() {
  const buffer = Buffer.from("conteudo-da-planilha");
  const esperado = crypto.createHash("sha256").update(buffer).digest("hex");
  const resultado = await storage.saveIncidente({
    context: { clienteId: 1, clienteSlug: "wbs", clienteContaId: null, marketplace: "shopee", periodo: "2026-08", usuarioId: 7 },
    triggers: ["identidade_ambigua"],
    triggerPrincipal: "identidade_ambigua",
    resumo: { unmatchedIdsCount: 2 },
    diagnostico: {},
    files: [{ tipoArquivo: "sales", originalName: "sales.xlsx", mimeType: "application/octet-stream", buffer }],
  });
  ok("devolve código do incidente", resultado?.codigo === "FIN-184");
  ok("arquivo foi persistido com sha256 correto", fakeRepo.arquivoCalls[0].arquivo.sha256 === esperado);
  ok("tamanho em bytes bate com o buffer", fakeRepo.arquivoCalls[0].arquivo.tamanhoBytes === buffer.length);
}

async function testDownloadValidaIncidenteEArquivoDoMesmoCodigo() {
  const arquivo = await storage.getArquivoParaDownload("FIN-184", 1);
  ok("download encontra arquivo do incidente certo", arquivo?.nomeOriginal === "sales.xlsx");
  const inexistente = await storage.getArquivoParaDownload("FIN-999", 1);
  ok("código inexistente não baixa nada", inexistente === null);
}

async function testSaveIncidenteNuncaLanca() {
  fakeRepo.createIncidente = async () => { throw new Error("Postgres fora do ar"); };
  const resultado = await storage.saveIncidente({
    context: { marketplace: "meli" },
    triggers: ["custo_nao_encontrado"],
    triggerPrincipal: "custo_nao_encontrado",
    resumo: {},
    diagnostico: {},
    files: [],
  });
  ok("falha de storage devolve null em vez de lançar", resultado === null);
}

(async () => {
  await testSaveIncidentePersisteBuffersESha256();
  await testDownloadValidaIncidenteEArquivoDoMesmoCodigo();
  await testSaveIncidenteNuncaLanca();
  console.log(`\n${checks} checks ok`);
})();
