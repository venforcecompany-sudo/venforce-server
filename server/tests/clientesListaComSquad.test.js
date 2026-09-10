// server/tests/clientesListaComSquad.test.js
//
// GET /clientes (server/index.js) precisa devolver o Squad ativo de cada
// Cliente sem N+1 (mission "fechar o contrato Cliente↔Squad", set/2026):
// usa squadsRepository.squadsAtivosDeClientes (já existe, já batched —
// mesma função usada por meService.obterContexto) UMA vez para toda a
// lista, nunca um SELECT por cliente dentro de um loop/map com await.
//
// Teste de wiring por leitura de fonte — não sobe servidor real nem banco.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

let checks = 0;
function ok(label, cond) {
  assert.ok(cond, `FALHOU: ${label}`);
  checks += 1;
  console.log(`  ok  ${label}`);
}

const src = fs.readFileSync(path.join(__dirname, "../index.js"), "utf8");

const inicio = src.indexOf('app.get("/clientes",');
assert.ok(inicio >= 0, "rota GET /clientes não encontrada em server/index.js");
const proximaRota = src.indexOf("\napp.", inicio + 10);
const trecho = src.slice(inicio, proximaRota > 0 ? proximaRota : inicio + 3000);

ok("GET /clientes usa squadsAtivosDeClientes (batch, sem N+1)", trecho.includes("squadsAtivosDeClientes"));
ok(
  "não existe await dentro de um .map/.forEach nesse trecho (sinal de N+1 por cliente)",
  !/\.(map|forEach)\([^)]*=>\s*\{[^}]*await/.test(trecho)
);
ok("resposta inclui campo squad por cliente", /squad\s*:/.test(trecho));

ok(
  "squadsAtivosDeClientes está importado no topo do arquivo (squadsRepository)",
  /squadsAtivosDeClientes/.test(src.slice(0, inicio))
);

console.log(`\nclientesListaComSquad.test.js: ${checks} verificações passaram.`);
