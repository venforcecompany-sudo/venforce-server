// Portal/clientes-squad-coluna-ui.test.js
//
// mission "fechar o contrato Cliente↔Squad" (set/2026) — audita
// Portal/clientes.html e Portal/clientes.js por leitura de fonte (mesmo
// padrão de clientes-criar-com-squad-ui.test.js): a tabela de clientes
// precisa mostrar a coluna Squad de forma compacta, honesta quando o
// cliente não tem squad, e a busca por texto precisa encontrar pelo nome
// do squad (a busca já roda sobre tr.textContent — só precisa o squad
// estar no HTML da linha).

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

ok("thead da tabela tem uma coluna Squad", /<th[^>]*>\s*Squad\s*<\/th>/.test(html));
ok("renderClientes usa c.squad ao montar a linha", /c\.squad/.test(js));
ok("cliente sem squad mostra \"Sem Squad\" honesto (não inventa squad default)", /Sem Squad/.test(js));
ok("reaproveita isLegado() já existente (não duplica a regra de slug 'legado')", /isLegado\(c\.squad\)/.test(js));
ok(
  "célula do squad usa classe CSS dedicada e compacta (não card gigante)",
  /vf-cli-cell-squad/.test(js) && /vf-cli-cell-squad/.test(fs.readFileSync(path.join(__dirname, "css/pages/clientes-v2.css"), "utf8"))
);

console.log(`\nclientes-squad-coluna-ui.test.js: ${checks} verificações passaram.`);
