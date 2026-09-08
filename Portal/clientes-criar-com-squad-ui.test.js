// Portal/clientes-criar-com-squad-ui.test.js
//
// mission "criação de cliente com squad" — audita Portal/clientes.html e
// Portal/clientes.js por leitura de fonte (mesmo padrão de
// squads-config-hotfix-ui.test.js): sem Jest/jsdom neste repo, então a
// garantia de UX ("nunca selecionar squad silenciosamente", "Squad 8 ·
// Legado", "botão só habilita com squad escolhido") é travada no texto-fonte.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

let checks = 0;
function ok(label, cond) {
  assert.ok(cond, `FALHOU: ${label}`);
  checks += 1;
  console.log(`  ok  ${label}`);
}

const html = fs.readFileSync(path.join(__dirname, "clientes.html"), "utf8");
const js = fs.readFileSync(path.join(__dirname, "clientes.js"), "utf8");

ok("HTML tem um campo select para squad no bloco de criação", /id="cliente-squad"/.test(html));
ok("JS busca squads via GET /squads", /apiFetch\(\s*["']\/squads["']\s*\)/.test(js));
ok("JS filtra só squads ativos (s.ativo === true)", /\.ativo\s*===\s*true/.test(js));
ok("JS aplica sufixo · Legado (mesma regra de squads-config.js: slug contém 'legado')", /legado/i.test(js));
ok("JS NÃO seleciona o primeiro item silenciosamente quando há múltiplos squads (sem selectedIndex = 0 forçado)", !/selectedIndex\s*=\s*0/.test(js));
ok("createCliente envia squadId no corpo do POST /clientes", /squadId/.test(js) && /JSON\.stringify\(\s*\{[^}]*squadId/.test(js));
ok("mensagem de sucesso cita o nome do squad escolhido", /criado no Squad/.test(js));
ok("botão de criar é desabilitado até squad válido ser escolhido (lógica de habilitação nova)", /atualizarEstadoBotaoCriar|validarFormCriarCliente/.test(js));

console.log(`\nclientes-criar-com-squad-ui.test.js: ${checks} verificações passaram.`);
