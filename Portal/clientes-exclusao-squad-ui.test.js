// Portal/clientes-exclusao-squad-ui.test.js
//
// mission "corrigir contrato Cliente↔Squad + exclusão admin" (set/2026):
// antes, o admin clicava em "Excluir" e, se o cliente tivesse
// dependências, só recebia um erro 409 sem alternativa — o cliente ficava
// preso na operação ativa para sempre. Agora o botão da linha
// (data-action="delete") checa GET /clientes/:slug/dependencias ANTES de
// abrir o modal, e decide entre dois caminhos:
//   - cliente vazio      → modal de hard delete (DELETE /clientes/:slug)
//   - cliente c/ histórico → modal de remoção segura
//                            (PATCH /clientes/:slug/desativar)
// Em ambos os casos o modal mostra Cliente + Squad, nunca "tem certeza?"
// genérico.
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

ok("botão de remoção continua existindo na linha do cliente (data-action=\"delete\")", /data-action="delete"/.test(js));

const inicio = js.indexOf("async function abrirModalRemoverCliente");
assert.ok(inicio >= 0, "abrirModalRemoverCliente não encontrada em clientes.js");
const fim = js.indexOf("\nasync function ", inicio + 10);
const trecho = js.slice(inicio, fim > 0 ? fim : inicio + 3000);

ok("busca o cliente em CLIENTES_LISTA pelo slug (nome/squad para o modal)", /CLIENTES_LISTA\.find/.test(trecho));
ok("consulta GET /clientes/:slug/dependencias ANTES de abrir qualquer modal", /apiFetch\(`\/clientes\/\$\{encodeURIComponent\(slug\)\}\/dependencias`\)/.test(trecho));
ok("subtitle do modal mostra Cliente e Squad (não só o slug)", /subtitle:\s*`\$\{nomeCliente\}.*Squad.*\$\{squadLabel\}`/.test(trecho));

ok(
  "cliente SEM dependências: oferece exclusão permanente (hard delete)",
  /dependencias\.length\)\s*\{[\s\S]*?confirmLabel:\s*"Excluir permanentemente"[\s\S]*?method:\s*"DELETE"/.test(trecho)
);
ok(
  "cliente COM dependências: oferece remoção segura preservando histórico (PATCH .../desativar, nunca DELETE)",
  /confirmLabel:\s*"Remover cliente"[\s\S]*?\/desativar`,\s*\{\s*method:\s*"PATCH"/.test(trecho)
);
ok(
  "mensagem para cliente com dependências explica que os dados serão preservados (não é \"tem certeza?\" genérico)",
  /não será apagado fisicamente/.test(trecho) && /preservados/.test(trecho)
);
ok("lista de dependências é passada ao modal (deps), não escondida", /deps:\s*dependencias/.test(trecho));

console.log(`\nclientes-exclusao-squad-ui.test.js: ${checks} verificações passaram.`);
