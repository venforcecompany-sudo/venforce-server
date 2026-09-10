// server/tests/fechamentoIncidenteRepository.test.js
const assert = require("assert");
const repo = require("../repositories/fechamentoIncidenteRepository");

let checks = 0;
function ok(label, condition) { assert.ok(condition, label); checks += 1; console.log(`  ok  ${label}`); }

function fakeDb(rowsByQuery) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      const key = Object.keys(rowsByQuery).find((k) => sql.includes(k));
      return rowsByQuery[key] ? rowsByQuery[key](params) : { rows: [], rowCount: 0 };
    },
  };
}

async function testCreateIncidenteGeraCodigoComId() {
  const db = fakeDb({
    "INSERT INTO fechamento_incidentes": () => ({ rows: [{ id: 184 }] }),
    "UPDATE fechamento_incidentes SET codigo": () => ({ rows: [{ id: 184, codigo: "FIN-184" }] }),
  });
  const result = await repo.createIncidente({
    marketplace: "shopee",
    triggerTipo: "identidade_ambigua",
    expiresInDays: 15,
  }, db);
  ok("codigo gerado a partir do id", result.codigo === "FIN-184");
  ok("id preservado", result.id === 184);
}

async function testGetIncidenteByCodigoFiltraExpirado() {
  const db = fakeDb({
    "SELECT * FROM fechamento_incidentes WHERE codigo": (params) => ({
      rows: params[0] === "FIN-184" ? [{ id: 1, codigo: "FIN-184", expires_at: new Date(Date.now() + 86400000) }] : [],
    }),
  });
  const row = await repo.getIncidenteByCodigo("FIN-184", db);
  ok("encontra incidente não expirado", row && row.codigo === "FIN-184");
}

async function testAddArquivoEListarArquivos() {
  const db = fakeDb({
    "INSERT INTO fechamento_incidente_arquivos": () => ({ rows: [{ id: 1 }] }),
  });
  const result = await repo.addArquivo(184, {
    tipoArquivo: "sales",
    nomeOriginal: "sales.xlsx",
    mimeType: "application/octet-stream",
    tamanhoBytes: 10,
    sha256: "abc",
    conteudo: Buffer.from("abc"),
    conteudoTruncado: false,
  }, db);
  ok("addArquivo devolve id", result.id === 1);
}

async function testCleanupExpirados() {
  const db = fakeDb({
    "DELETE FROM fechamento_incidentes WHERE expires_at": () => ({ rowCount: 3 }),
  });
  const result = await repo.cleanupExpirados({}, db);
  ok("cleanup devolve contagem removida", result.incidentesRemovidos === 3);
}

(async () => {
  await testCreateIncidenteGeraCodigoComId();
  await testGetIncidenteByCodigoFiltraExpirado();
  await testAddArquivoEListarArquivos();
  await testCleanupExpirados();
  console.log(`\n${checks} checks ok`);
})();
