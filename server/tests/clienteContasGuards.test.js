// server/tests/clienteContasGuards.test.js
//
// Verificações estáticas (mesmo padrão de mlGrantScope.test.js) para as
// proteções da Fase 1 que vivem em server/index.js e na migration
// versionada — coisas que não compensa levantar um servidor inteiro para
// testar ponta a ponta:
//  - DELETE /clientes/:slug bloqueia com dependências, não apaga em silêncio;
//  - DELETE /clientes/:slug/ml-token (legado) bloqueia quando há 2+ grants;
//  - as novas rotas de cliente-contas exigem admin;
//  - a migration é aditiva (não apaga linhas de ml_tokens, não faz DROP).

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

let checks = 0;
function ok(label, condition) {
  assert.ok(condition, `FALHOU: ${label}`);
  checks += 1;
  console.log(`  ok  ${label}`);
}

const indexJs = read("index.js");

{
  const offset = indexJs.indexOf('app.delete("/clientes/:slug/ml-token"');
  ok("rota legada de desconexão ML existe", offset >= 0);
  const trecho = indexJs.slice(offset, offset + 1400);
  ok("desconexão legada verifica quantidade de grants antes de apagar", trecho.includes("MULTIPLE_ML_GRANTS"));
  ok("desconexão legada bloqueia com 409 quando há mais de um grant", /status\(409\)/.test(trecho) && trecho.includes("MULTIPLE_ML_GRANTS"));
}

{
  const offset = indexJs.indexOf('app.delete("/clientes/:slug"');
  ok("rota de exclusão de cliente existe", offset >= 0);
  const trecho = indexJs.slice(offset, offset + 1600);
  ok("exclusão de cliente verifica dependências antes do hard delete", trecho.includes("verificarDependenciasCliente"));
  ok("exclusão de cliente bloqueia com 409 quando há dependências", trecho.includes("CLIENTE_COM_DEPENDENCIAS"));
}

ok("server/index.js monta as rotas de cliente-contas", indexJs.includes('require("./routes/clienteContasRoutes")') && indexJs.includes("clienteContasRoutes"));

const clienteContasRoutes = read("routes/clienteContasRoutes.js");

// Hotfix fd487d4 ("fix: impedir auth global-bloqueio") trocou
// `router.use(authMiddleware)` — que rodava para QUALQUER path que chegasse
// ao router (ele é montado em app.use("/", ...) em index.js), inclusive
// rotas públicas de OUTROS routers montados depois, como
// GET /public/entregas/:token (Fechamento V3) — por authMiddleware
// explícito em cada rota. Não pode haver `router.use(authMiddleware)`
// solto de novo, e toda rota declarada precisa trazer authMiddleware antes
// do gate de autorização (requireAdmin/requireAutomacoesAccess/carteira).
ok(
  "clienteContasRoutes NÃO usa router.use(authMiddleware) global (causa raiz do bloqueio de rotas públicas de outros routers)",
  !/router\.use\(\s*authMiddleware\s*\)/.test(clienteContasRoutes)
);

for (const [verbo, rota] of [
  ["get", '"/clientes/:cliente/contas"'],
  ["post", '"/clientes/:cliente/contas"'],
  ["get", '"/cliente-contas/:id"'],
  ["patch", '"/cliente-contas/:id"'],
  ["patch", '"/cliente-contas/:id/principal"'],
  ["get", '"/cliente-contas/:id/base"'],
  ["get", '"/cliente-contas/:id/bases-elegiveis"'],
  ["put", '"/cliente-contas/:id/base"'],
  ["delete", '"/cliente-contas/:id/ml-grant"'],
]) {
  // Pega o primeiro middleware nomeado logo após a rota literal.
  const rotaOffset = clienteContasRoutes.indexOf(rota);
  assert.ok(rotaOffset >= 0, `rota não encontrada: ${verbo} ${rota}`);
  const fimLinha = clienteContasRoutes.indexOf(");", rotaOffset);
  const trecho = clienteContasRoutes.slice(rotaOffset, fimLinha);
  const primeiroMiddleware = trecho
    .slice(rota.length)
    .split(",")
    .map((s) => s.trim())
    .find((s) => s.length > 0);
  ok(`${verbo.toUpperCase()} ${rota}: authMiddleware é o primeiro middleware após a rota (auth antes de authz)`, primeiroMiddleware === "authMiddleware");
}

// Leitura de metadados operacionais é liberada às roles internas
// (admin/user/membro); mutações continuam admin-only. Checa o middleware
// declarado logo após cada `router.<verbo>("<rota>"` — mesma técnica de
// mlGrantScope.test.js para as rotas /admin/ml-tokens.
function middlewareDaRota(routesSrc, verbo, rotaLiteral) {
  // Tolerante a `router.verbo("rota", ...)` numa linha só e a
  // `router.verbo(\n  "rota",\n  ...\n)` — hotfix fd487d4 reformatou cada
  // rota de auth global (router.use) para authMiddleware explícito e
  // multi-linha por rota.
  const declaracao = new RegExp(
    `router\\.${verbo}\\(\\s*${rotaLiteral.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`
  );
  const casada = routesSrc.match(declaracao);
  assert.ok(casada, `rota não encontrada: ${verbo} ${rotaLiteral}`);
  const offset = casada.index;
  const fimLinha = routesSrc.indexOf(");", offset);
  assert.ok(fimLinha > offset, `fim da declaração não encontrado: ${verbo} ${rotaLiteral}`);
  return routesSrc.slice(offset, fimLinha);
}

for (const [verbo, rota] of [
  ["get", '"/clientes/:cliente/contas"'],
  ["get", '"/cliente-contas/:id"'],
  ["get", '"/cliente-contas/:id/base"'],
]) {
  const trecho = middlewareDaRota(clienteContasRoutes, verbo, rota);
  ok(`leitura ${verbo.toUpperCase()} ${rota} usa requireAutomacoesAccess (admin/user/membro)`, trecho.includes("requireAutomacoesAccess"));
  ok(`leitura ${verbo.toUpperCase()} ${rota} NÃO exige requireAdmin`, !trecho.includes("requireAdmin"));
}

for (const [verbo, rota] of [
  ["post", '"/clientes/:cliente/contas"'],
  ["patch", '"/cliente-contas/:id"'],
  ["patch", '"/cliente-contas/:id/principal"'],
  ["put", '"/cliente-contas/:id/base"'],
  ["delete", '"/cliente-contas/:id/ml-grant"'],
]) {
  const trecho = middlewareDaRota(clienteContasRoutes, verbo, rota);
  ok(`mutação ${verbo.toUpperCase()} ${rota} exige requireAdmin`, trecho.includes("requireAdmin"));
}

const migration = read("sql/migrations/20260817_cliente_contas_foundation.sql");
ok("migration não apaga nem recria ml_tokens", !/DROP\s+TABLE\s+ml_tokens|TRUNCATE\s+ml_tokens/i.test(migration));
ok("migration não faz UPDATE de access_token/refresh_token/expires_at/token_status", !/access_token\s*=|refresh_token\s*=|expires_at\s*=|token_status\s*=/i.test(migration));
ok("migration adiciona cliente_conta_id de forma aditiva (ADD COLUMN IF NOT EXISTS)", /ALTER TABLE ml_tokens\s+ADD COLUMN IF NOT EXISTS cliente_conta_id/i.test(migration));
ok("migration cria cliente_contas com CREATE TABLE IF NOT EXISTS (idempotente)", /CREATE TABLE IF NOT EXISTS cliente_contas/i.test(migration));
ok("migration registra conflitos de ml_user_id em vez de resolver sozinha", migration.includes("ml_user_id_duplicado_entre_clientes") && migration.includes("cliente_contas_pendencias"));
ok("migration registra vínculos de base ambíguos em vez de escolher", migration.includes("base_vinculo_ambiguo"));
ok("migration não força NOT NULL em cliente_conta_id (permanece opcional na Fase 1)", !/cliente_conta_id[\s\S]{0,40}SET NOT NULL/i.test(migration));

console.log(`\n✓ clienteContasGuards: ${checks} verificações`);
