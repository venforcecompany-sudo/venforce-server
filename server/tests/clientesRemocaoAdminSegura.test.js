// server/tests/clientesRemocaoAdminSegura.test.js
//
// mission "fechar o contrato Cliente↔Squad + exclusão admin" (set/2026),
// corrigida pela mission "admin precisa poder excluir cliente de verdade"
// (mesmo dia): DELETE /clientes/:slug oferece hoje 3 caminhos —
//
//   GET   /clientes/:slug/dependencias        → leitura prévia, não apaga nada
//   DELETE /clientes/:slug                    → sem dependências: apaga direto
//   DELETE /clientes/:slug?confirmarPurge=true
//          + body {confirmar: slug|nome}      → com dependências: purge real
//          (server/services/clientes/clientePurgeService.js, testado à parte
//          em clientePurgeService.test.js — aqui só verificamos o WIRING da
//          rota, não a lógica transacional)
//   PATCH /clientes/:slug/desativar           → ativo=false, nunca DELETE em
//                                                tabela nenhuma
//
// Teste de wiring por leitura de fonte — mesmo padrão de
// clienteContasGuards.test.js — não sobe servidor real nem banco.

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

function isolarRota(marcador) {
  const inicio = src.indexOf(marcador);
  assert.ok(inicio >= 0, `rota não encontrada: ${marcador}`);
  const proximaRota = src.indexOf("\napp.", inicio + 10);
  return src.slice(inicio, proximaRota > 0 ? proximaRota : inicio + 2000);
}

// ── GET /clientes/:slug/dependencias ──────────────────────────────────
{
  const trecho = isolarRota('app.get("/clientes/:slug/dependencias"');
  ok("GET /clientes/:slug/dependencias exige authMiddleware", trecho.includes("authMiddleware"));
  ok("GET /clientes/:slug/dependencias exige requireAdmin", trecho.includes("requireAdmin"));
  ok("usa verificarDependenciasCliente (não duplica a regra de dependências)", trecho.includes("verificarDependenciasCliente"));
  ok("é só leitura: não contém DELETE FROM nem UPDATE de cliente", !/DELETE\s+FROM|UPDATE\s+clientes/i.test(trecho));
}

// ── DELETE /clientes/:slug (admin tem a palavra final: sem dependências
//    apaga direto; com dependências, exige confirmarPurge=true + o admin
//    ter digitado nome/slug — nunca um beco sem saída) ───────────────────
{
  const trecho = isolarRota('app.delete("/clientes/:slug"');
  ok("DELETE /clientes/:slug exige authMiddleware + requireAdmin", trecho.includes("authMiddleware") && trecho.includes("requireAdmin"));
  ok("DELETE /clientes/:slug continua auditando dependências antes de decidir (verificarDependenciasCliente)", trecho.includes("verificarDependenciasCliente"));
  ok(
    "sem ?confirmarPurge=true, dependências bloqueiam com 409 CLIENTE_COM_DEPENDENCIAS (nunca apaga em silêncio)",
    /status\(409\)/.test(trecho) && trecho.includes("CLIENTE_COM_DEPENDENCIAS") && trecho.includes("confirmarPurge")
  );
  ok(
    "com dependências + confirmarPurge=true, exige uma 2ª confirmação (nome/slug digitado) antes do purge",
    trecho.includes("CONFIRMACAO_INVALIDA") && /req\.body\??\.\s*confirmar/.test(trecho)
  );
  ok(
    "a exclusão de verdade (com ou sem dependências) delega para purgarClientePermanentemente — não há DELETE FROM clientes direto na rota",
    trecho.includes("purgarClientePermanentemente(slug)") && !/DELETE\s+FROM\s+clientes/i.test(trecho)
  );
  ok("erro do purge (ex.: dependência que o Postgres recusou apagar) propaga o statusCode e o code originais", /err\?\.\s*statusCode/.test(trecho) && /err\.code/.test(trecho));
  ok("log de auditoria distingue purge de exclusão simples (admin.cliente.purgar vs admin.cliente.excluir)", trecho.includes("admin.cliente.purgar") && trecho.includes("admin.cliente.excluir"));
}

// ── PATCH /clientes/:slug/desativar (remoção segura — a saída nova) ────
{
  const trecho = isolarRota('app.patch("/clientes/:slug/desativar"');
  ok("PATCH /clientes/:slug/desativar exige authMiddleware", trecho.includes("authMiddleware"));
  ok("PATCH /clientes/:slug/desativar exige requireAdmin (só admin remove cliente)", trecho.includes("requireAdmin"));
  ok("desativação faz UPDATE ... SET ativo = false (mesma flag usada em todo o backend p/ filtrar operação ativa)", /UPDATE\s+clientes\s+SET\s+ativo\s*=\s*false/i.test(trecho));
  ok(
    "desativação NÃO apaga Grants/ClienteContas/Bases/Financeiro (nenhum DELETE FROM no handler)",
    !/DELETE\s+FROM/i.test(trecho)
  );
  ok(
    "desativação não mexe em cliente_contas, ml_tokens, base_cliente_vinculos nem entregas_cliente",
    !/(cliente_contas|ml_tokens|base_cliente_vinculos|entregas_cliente)/i.test(trecho)
  );
  ok("desativação registra log de auditoria", trecho.includes("registrarLog") && trecho.includes("admin.cliente.desativar"));
}

console.log(`\nclientesRemocaoAdminSegura.test.js: ${checks} verificações passaram.`);
