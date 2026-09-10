// Portal/clientes-exclusao-squad-ui.test.js
//
// mission "fechar o contrato Cliente↔Squad" (set/2026) — a exclusão de
// Cliente já existia e já funcionava (botão "Excluir", modal de confirmação
// com bloqueio por dependências); esta tarefa só melhora a UX: o modal
// precisa mostrar o Squad do cliente (não só o slug) e a mensagem de
// dependências precisa ser uma lista humana, não "label: total" cru.
//
// Teste de leitura de fonte — mesmo padrão dos demais *-ui.test.js desta
// tela.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

let checks = 0;
function ok(label, cond) {
  assert.ok(cond, `FALHOU: ${label}`);
  checks += 1;
  console.log(`  ok  ${label}`);
}

const js = fs.readFileSync(path.join(__dirname, "clientes.js"), "utf8");

ok("botão Excluir continua existindo na linha do cliente", /data-action="delete"/.test(js));
ok("handler de exclusão busca o cliente em CLIENTES_LISTA pelo slug", /CLIENTES_LISTA\.find/.test(js));
ok("subtitle do modal de exclusão mostra o Squad do cliente (não só o slug)", /Squad\s*:?\s*\$\{/.test(js) || /subtitle.*squad/i.test(js));
ok(
  "mensagem de dependências é formatada como lista (bullet •), não 'label: total' cru",
  /•/.test(js)
);

console.log(`\nclientes-exclusao-squad-ui.test.js: ${checks} verificações passaram.`);
