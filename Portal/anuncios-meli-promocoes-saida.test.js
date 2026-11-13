"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.join(__dirname, "anuncios-meli.js"), "utf8");
let selecionada;
let confirmacao;
const escritas = [];
const context = vm.createContext({
  DET: { itemId: "MLB1", anuncio: { moeda: "BRL" }, simulacaoMargem: { preco: 90 } },
  AM: { state: { performanceCache: { MLB1: { composicao: { venda: 90 } } } } },
  BOTAO_SAIR: { acao: "promo-sair", rotulo: "Deixar de participar" },
  promocaoSelecionadaDoItem: () => selecionada,
  formatMoeda: (n) => `R$ ${n}`,
  abrirConfirmacaoEscrita: (opts) => { confirmacao = opts; },
  escreverPromocao: (...args) => escritas.push(args),
});
for (const name of ["promocaoParticipa", "margemAcaoAtual", "abrirConfirmacaoAceite"]) {
  const start = source.indexOf(`  function ${name}(`);
  assert.ok(start >= 0, name);
  const end = source.indexOf("\n  }", start) + "\n  }".length;
  vm.runInContext(source.slice(start, end), context);
}

for (const tipo of ["DEAL", "SELLER_CAMPAIGN", "SMART", "MARKETPLACE_CAMPAIGN", "PRICE_DISCOUNT", "DOD", "LIGHTNING", "VOLUME", "BANK", "NOVO_TIPO_ML"]) {
  for (const status of ["started", "active", "pending"]) {
    selecionada = {
      id: "P1", tipo, status, statusExibicao: status === "pending" ? "PROGRAMADA" : "ATIVA",
      modoEscrita: ["DEAL", "SELLER_CAMPAIGN"].includes(tipo) ? "PRECO"
        : ["SMART", "MARKETPLACE_CAMPAIGN"].includes(tipo) ? "ACEITE" : null,
      precoFinal: 90, precoOriginal: 100,
    };
    const acoes = context.margemAcaoAtual("MLB1");
    assert.ok(acoes.botoes.some((b) => b.acao === "promo-sair"), `${tipo}/${status}: oferece saída`);
    confirmacao = null;
    const antes = escritas.length;
    context.abrirConfirmacaoAceite("MLB1", selecionada, true);
    assert.ok(confirmacao, `${tipo}/${status}: abre confirmação`);
    assert.strictEqual(escritas.length, antes, "abrir confirmação não escreve");
    confirmacao.aoConfirmar(() => {});
    const [itemId, rota, body] = escritas.at(-1);
    assert.strictEqual(itemId, "MLB1");
    assert.strictEqual(rota, "/promocoes/P1/sair");
    assert.strictEqual(body.tipo, tipo);
    assert.strictEqual(body.precoNovo, undefined);
  }
  for (const status of ["candidate", "finished"]) {
    confirmacao = null;
    context.abrirConfirmacaoAceite("MLB1", { ...selecionada, status }, true);
    assert.strictEqual(confirmacao, null, `${tipo}/${status}: não permite saída sem participação`);
  }
}
console.log("anuncios-meli-promocoes-saida: passed");
