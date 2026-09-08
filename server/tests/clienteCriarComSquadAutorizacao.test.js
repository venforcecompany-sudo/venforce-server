// server/tests/clienteCriarComSquadAutorizacao.test.js
//
// mission "criação de cliente com squad" — pontos de autorização:
//   6. usuário sem acesso ao squad -> rejeita (a rota é requireAdmin-only;
//      quem não é admin nem chega no squadService)
//   7. admin consegue escolher squad permitido (admin = qualquer squad ativo)
//   8/9. seleção de squad no frontend nunca escolhe silenciosamente (não é
//      testável aqui — coberto por leitura do JS na Task 4/5; aqui fica só
//      o contrato de que o backend aceita qualquer squad ATIVO vindo do
//      admin, sem lista fixa/hardcoded de squads permitidos)

const assert = require("assert");
const { requireAdmin } = require("../middlewares/authMiddleware");

let checks = 0;
function ok(label, cond) {
  assert.ok(cond, `FALHOU: ${label}`);
  checks += 1;
  console.log(`  ok  ${label}`);
}

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

async function run() {
  // 6. não-admin nunca chega no squadService — bloqueado antes, por requireAdmin
  const resNaoAdmin = fakeRes();
  let nextChamado = false;
  requireAdmin({ user: { role: "user" } }, resNaoAdmin, () => { nextChamado = true; });
  ok("requireAdmin bloqueia role=user com 403 antes de qualquer lógica de squad", resNaoAdmin.statusCode === 403 && !nextChamado);

  const resCoordenador = fakeRes();
  let nextCoord = false;
  requireAdmin({ user: { role: "coordenador" } }, resCoordenador, () => { nextCoord = true; });
  ok("requireAdmin bloqueia role=coordenador (não é 'admin')", resCoordenador.statusCode === 403 && !nextCoord);

  // 7. admin passa e pode escolher qualquer squad ativo — o backend
  // (criarClienteComSquad) não filtra por membership do admin, só por
  // squad.ativo (ver clienteCriarComSquad.test.js).
  const resAdmin = fakeRes();
  let nextAdmin = false;
  requireAdmin({ user: { role: "admin" } }, resAdmin, () => { nextAdmin = true; });
  ok("requireAdmin libera role=admin (pode então escolher qualquer squad ativo)", nextAdmin);

  console.log(`\nclienteCriarComSquadAutorizacao.test.js: ${checks} verificações passaram.`);
}

run().catch((err) => { console.error(err); process.exitCode = 1; });
