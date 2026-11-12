// VenForce Resgate — tela: ausente = "—" (nunca 0), escape de HTML, nenhuma
// chamada que altere preço, entrada no menu e página no Shell V3.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const R = require("./resgate.js");

let ok = 0;
function t(n, fn) { try { fn(); ok++; console.log(`  ✓ ${n}`); } catch (e) { console.error(`  ✗ ${n}\n    ${e.stack}`); process.exitCode = 1; } }

t("ausente aparece como — (nunca R$ 0,00 / 0%)", () => {
  for (const v of [null, undefined, "", NaN]) { assert.strictEqual(R.moeda(v), "—"); assert.strictEqual(R.pct(v), "—"); assert.strictEqual(R.inteiro(v), "—"); }
  assert.strictEqual(R.moeda(0), "R$ 0,00");
  const html = R.linhaItem({ itemId: "MLB1", titulo: "x", preco: 100, margemPercent: null, margemExibida: 25.2, frete: null, situacao: "DADOS_INSUFICIENTES", origem: "HISTORICO_INSUFICIENTE", unidades30d: 0, exposicao: { tipo: "faturamento_exposto", valor: null }, recomendacao: null });
  assert.ok(!/0,00%/.test(html)); assert.ok(/25,20%/.test(html)); assert.ok(/Dados insuficientes/.test(html));
});
t("escape de HTML em título/SKU vindos do ML", () => {
  const html = R.linhaItem({ itemId: "MLB1", titulo: "<img src=x onerror=alert(1)>", situacao: "PRECO_OK" });
  assert.ok(!/<img/.test(html)); assert.ok(/&lt;img/.test(html));
});
t("conta sem avaliação aparece com o motivo (não some do mapa)", () => {
  const html = R.linhaConta({ clienteContaId: 81, clienteNome: "Cliente", sellerId: "1", semAvaliacao: "sem_snapshots_do_motor" });
  assert.ok(/Sem avaliação/.test(html) && /sem_snapshots_do_motor/.test(html));
});
t("detalhe: limite inferior da margem e preço visto da proposta", () => {
  const html = R.detalheItem({ itemId: "MLB1", situacao: "MARGEM_DESCONHECIDA", acao: "VERIFICAR_SUBSIDIO", motivos: ["m"], contrato: { resultado: { margemPercent: 5.68, lucro: 4.5, limiteInferior: true }, componentes: {}, bloqueios: [], pendencias: [], inconsistencias: [] }, fingerprint: { precoVisto: 79.99, vistoEm: "2026-11-12T10:00:00Z" }, historico: { linhaDoTempo: [] } });
  assert.ok(/limite inferior/.test(html)); assert.ok(/R\$ 79,99/.test(html)); assert.ok(/não altera o anúncio/.test(html));
});
t("preços digitados no formato brasileiro", () => { assert.deepStrictEqual(R.lerPrecos("89,90; 1.094,90 abc 0"), [89.9, 1094.9]); });
t("a tela não tem chamada que altere preço; só GET e os POST de simular/revisão/dry-run do Resgate", () => {
  const src = fs.readFileSync(path.join(__dirname, "resgate.js"), "utf8");
  assert.ok(!/method:\s*"(PUT|PATCH|DELETE)"/.test(src));
  const posts = src.match(/method:\s*"POST"/g) || [];
  assert.strictEqual(posts.length, 3);
  assert.ok(!/\/anuncios-meli\/|\/preco"/.test(src));
});
t("página no Shell V3 (scope global) e item 'Resgate' no menu", () => {
  const html = fs.readFileSync(path.join(__dirname, "resgate.html"), "utf8");
  assert.ok(/data-vf-scope="global"/.test(html) && /vf-shell\.js/.test(html) && /resgate\.js/.test(html) && /vf-tokens-v2\.css/.test(html));
  const shell = fs.readFileSync(path.join(__dirname, "vf-shell.js"), "utf8");
  assert.ok(/id: "resgate", label: "Resgate", rota: "resgate\.html"/.test(shell));
  assert.ok(/"promocoes-ml", "resgate"\]/.test(shell));
});
console.log(`\n${ok} verificações da tela do Resgate`);
