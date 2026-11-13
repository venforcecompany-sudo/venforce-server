"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// Executa os renderizadores reais com o cache que /performance devolve.
const source = fs.readFileSync(path.join(__dirname, "anuncios-meli.js"), "utf8");
const context = vm.createContext({
  AM: { state: { performanceCache: {} } },
  MARGEM_CLASSE: { HEALTHY: "is-success", SUSPECT_DATA: "is-warning", UNVALIDATED: "is-neutral" },
  escapeHtml: (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
  escapeAttr: (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
  formatMoeda: (n) => `R$ ${n}`,
  formatarPercentualCompacto: (n) => `${n}%`,
  lucroMargemHtml: () => "",
  encontrarAnuncioNaTela: () => null,
  margemComposicaoLadderHtml: () => "COMPOSICAO_CARREGADA",
});
for (const name of ["infoDotHtml", "margemConteudoHtml", "margemAoVivoHtml", "margemComposicaoCarregandoHtml", "margemComposicaoConteudoHtml"]) {
  const start = source.indexOf(`  function ${name}(`);
  assert.ok(start >= 0, name);
  const end = source.indexOf("\n  }", start) + "\n  }".length;
  vm.runInContext(source.slice(start, end), context);
}

assert.strictEqual(context.margemAoVivoHtml("MLB1"), null, "sem leitura ao vivo, usa snapshot");
const cache = context.AM.state.performanceCache.MLB1 = {
  temMargem: true,
  temComposicao: true,
  composicao: null,
  margem: {
    marginPercent: null, profit: null, status: "SUSPECT_DATA", statusLabel: "Dado suspeito",
    margemIncompletaMotivo: "Frete não obtido: margem indisponível até um recálculo completo.",
  },
};
assert.match(context.margemAoVivoHtml("MLB1"), /Dado suspeito/, "leitura inválida substitui o snapshot saudável");
assert.doesNotMatch(context.margemAoVivoHtml("MLB1"), /is-success/);
const modal = context.margemComposicaoConteudoHtml("MLB1", "BRL");
assert.match(modal, /Frete não obtido/);
assert.doesNotMatch(modal, /Carregando|COMPOSICAO_CARREGADA/, "composição indisponível não simula carregamento");

cache.margem.margemIncompletaMotivo = null;
cache.margem.statusReasons = ["<script>motivo</script>"];
assert.doesNotMatch(context.margemComposicaoConteudoHtml("MLB1", "BRL"), /<script>/, "motivo escapado");
cache.margemIndisponivel = { mensagem: "Base não vinculada" };
assert.match(context.margemAoVivoHtml("MLB1"), /Base não vinculada/, "contexto atual também substitui snapshot");
cache.margemIndisponivel = null;
cache.composicao = { incompleta: true, venda: 89.9, custoProduto: 42, comissaoMl: 17.08, frete: null, freteAplicavel: true, taxaFixa: 0, impostoValor: 11.69 };
const parcial = context.margemComposicaoConteudoHtml("MLB1", "BRL");
assert.match(parcial, /Custos disponíveis/);
assert.match(parcial, /Frete<\/th><td>Indisponível/);
assert.match(parcial, /Custo do produto<\/th><td>R\$ 42/);
assert.match(parcial, /Custos adicionais<\/th><td>R\$ 0/, "zero conhecido continua zero");
assert.doesNotMatch(parcial, /<input|Simulação|COMPOSICAO_CARREGADA|<th scope="row">Margem/, "sem simulação nem total com custo ausente");
cache.composicao.freteAplicavel = false;
assert.match(context.margemComposicaoConteudoHtml("MLB1", "BRL"), /Frete<\/th><td>Não se aplica/);
cache.margem = { marginPercent: 20, profit: 18, status: "HEALTHY" };
cache.composicao = { venda: 89.9 };
assert.match(context.margemAoVivoHtml("MLB1"), /20%/);
assert.match(context.margemComposicaoConteudoHtml("MLB1", "BRL"), /COMPOSICAO_CARREGADA/);
cache.temComposicao = false;
assert.match(context.margemComposicaoConteudoHtml("MLB1", "BRL"), /Carregando/, "pedido pendente mantém carregamento");
console.log("anuncios-meli-margem-indisponivel: passed");
