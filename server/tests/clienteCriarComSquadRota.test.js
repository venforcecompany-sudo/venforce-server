// server/tests/clienteCriarComSquadRota.test.js
//
// Audita a rota POST /clientes (server/index.js): confirma que o caminho
// com squadId delega para squadService.criarClienteComSquad, que o caminho
// legado (sem squadId) continua intacto, e que a rota continua exigindo
// requireAdmin (mission: "Preserve as regras atuais de quem pode criar
// Cliente. Não amplie permissões nesta missão.").
//
// Teste de wiring por leitura de fonte — igual clienteContasGuards.test.js —
// não sobe servidor real nem banco.

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

// Isola o handler de POST /clientes até a próxima rota app.<verbo>(
const inicio = src.indexOf('app.post("/clientes",');
assert.ok(inicio >= 0, "rota POST /clientes não encontrada em server/index.js");
const proximaRota = src.indexOf("\napp.", inicio + 10);
const trecho = src.slice(inicio, proximaRota > 0 ? proximaRota : inicio + 4000);

ok("POST /clientes continua exigindo authMiddleware", trecho.includes("authMiddleware"));
ok("POST /clientes continua exigindo requireAdmin (não amplia permissões)", trecho.includes("requireAdmin"));
ok("rota lê squadId do corpo", /const\s*\{[^}]*squadId[^}]*\}\s*=\s*req\.body/.test(trecho));
ok("caminho com squadId delega para squadService.criarClienteComSquad", trecho.includes("squadService.criarClienteComSquad"));
ok("caminho legado ainda faz INSERT INTO clientes direto (compat, sem squadId)", trecho.includes("INSERT INTO clientes"));

ok("squadService está importado no topo do arquivo", src.includes('require("./services/squads/squadService")'));

console.log(`\nclienteCriarComSquadRota.test.js: ${checks} verificações passaram.`);
