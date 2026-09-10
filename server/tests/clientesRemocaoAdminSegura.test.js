// server/tests/clientesRemocaoAdminSegura.test.js
//
// mission "fechar o contrato Cliente↔Squad + exclusão admin" (set/2026):
// antes desta missão, DELETE /clientes/:slug bloqueava com 409
// CLIENTE_COM_DEPENDENCIAS e o admin ficava sem alternativa — o cliente
// continuava preso na operação ativa para sempre. Esta missão adiciona
// uma saída segura sem tocar na lógica de bloqueio já existente
// (verificarDependenciasCliente / CLIENTE_COM_DEPENDENCIAS, cobertos em
// clienteContasGuards.test.js):
//
//   GET   /clientes/:slug/dependencias  → leitura prévia, não apaga nada
//   PATCH /clientes/:slug/desativar     → ativo=false, nunca DELETE em
//                                          tabela nenhuma
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

// ── DELETE /clientes/:slug (hard delete — comportamento preexistente,
//    não reescrito nesta missão) ────────────────────────────────────────
{
  const trecho = isolarRota('app.delete("/clientes/:slug"');
  ok("DELETE /clientes/:slug exige authMiddleware + requireAdmin", trecho.includes("authMiddleware") && trecho.includes("requireAdmin"));
  ok("DELETE /clientes/:slug continua verificando dependências antes de apagar", trecho.includes("verificarDependenciasCliente"));
  ok("DELETE /clientes/:slug continua bloqueando com 409 CLIENTE_COM_DEPENDENCIAS quando há dependências", /status\(409\)/.test(trecho) && trecho.includes("CLIENTE_COM_DEPENDENCIAS"));
  ok("DELETE /clientes/:slug só apaga de verdade (DELETE FROM clientes) quando dependencias.length é 0", trecho.includes("DELETE FROM clientes"));
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
