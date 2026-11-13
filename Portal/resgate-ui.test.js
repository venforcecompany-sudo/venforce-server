// VenForce Resgate — tela (bancada): ausente = "—" (nunca 0), escape de HTML,
// sugerido só "recotado" quando o servidor diz, ações DESLIGADAS por padrão e
// um único caminho de escrita (endpoints existentes de /anuncios-meli) com
// releitura do preço + confirmação explícita. Shell V3 e item no menu.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const R = require("./resgate.js");

let ok = 0;
const pendentes = [];
function t(n, fn) {
  const run = async () => { try { await fn(); ok++; console.log(`  ✓ ${n}`); } catch (e) { console.error(`  ✗ ${n}\n    ${e.stack}`); process.exitCode = 1; } };
  pendentes.push(run);
}

// Bancada no formato do servidor (resgate-bancada/1), números do caso real MLB4427778060.
const bancada = (extra = {}) => ({
  versao: "resgate-bancada/1", itemId: "MLB4427778060", status: "ABAIXO_DA_META", motivoStatus: "Margem 5,61% abaixo da meta de 15,00%.",
  meta: { valor: 0.15 }, precos: { cheio: 149.9, comprador: 129.9, promocionalVendedor: 129.9 },
  promocao: { ativa: true, tipo: "SELLER_CAMPAIGN", tipoRotulo: "Campanha própria do vendedor", id: "C-MLB6270746", financiamento: "VENDEDOR_100", subsidio: 0, comprovado: true, texto: "do vendedor", fonte: "GET" },
  cascata: [
    { chave: "precoCheio", rotulo: "Preço cheio (controlado pelo vendedor)", operacao: "base", valor: 149.9, status: "ok" },
    { chave: "descontoVendedor", rotulo: "Desconto bancado pelo vendedor", operacao: "menos", valor: 20, status: "ok" },
    { chave: "descontoMl", rotulo: "Desconto bancado pelo Mercado Livre", operacao: "menos", valor: 0, status: "ok" },
    { chave: "precoComprador", rotulo: "Preço pago pelo comprador", operacao: "igual", valor: 129.9, status: "ok" },
    { chave: "subsidioMl", rotulo: "Subsídio/rebate do ML repassado ao vendedor", operacao: "mais", valor: 0, status: "ok" },
    { chave: "comissao", rotulo: "Comissão (19%)", operacao: "menos", valor: 24.68, status: "ok" },
    { chave: "frete", rotulo: "Frete", operacao: "menos", valor: 19.05, status: "ok" },
    { chave: "lucro", rotulo: "Lucro por unidade", operacao: "igual", valor: 7.28, status: "ok" },
  ],
  resultado: { calculavel: true, lucro: 7.28, margem: 0.056066, margemPercent: 5.61, confiavel: true, limiteInferior: false },
  bloqueios: [], pendencias: [],
  sugerido: { status: "PRELIMINAR", preco: 152.92, texto: "Simulação preliminar." },
  acoes: [
    { tipo: "SAIR_DA_PROMOCAO", rotulo: "Sair da promoção", promocaoId: "C-MLB6270746", promocaoTipo: "SELLER_CAMPAIGN", endpoint: "POST /anuncios-meli/:itemId/promocoes/:promotionId/sair", suportada: true, resultadoEsperado: { precoComprador: 149.9, recotado: false } },
    { tipo: "ALTERAR_PRECO", rotulo: "Depois de sair, alterar o preço cheio para R$ 152,92", precoAlvo: 152.92, endpoint: "PATCH /anuncios-meli/:itemId/preco", suportada: true, requerAntes: "SAIR_DA_PROMOCAO" },
  ],
  precoMudou: null, ...extra,
});
const det = (b = bancada(), ctx = {}) => ({ item: { itemId: "MLB4427778060", titulo: "Saia", fingerprint: { precoVisto: 129.9 }, contrato: { componentes: {} }, historico: { linhaDoTempo: [] } }, bancada: b, contexto: { clienteSlug: "cliente-x", clienteContaId: 86, acoesHabilitadas: true, ...ctx } });
const CFG_ON = { acoesHabilitadas: true, preview: false, recotacaoSobDemanda: true };
const CFG_OFF = { acoesHabilitadas: false, preview: false, recotacaoSobDemanda: true };

t("ausente aparece como — (nunca R$ 0,00 / 0%); zero comprovado aparece como R$ 0,00", () => {
  for (const v of [null, undefined, "", NaN]) { assert.strictEqual(R.moeda(v), "—"); assert.strictEqual(R.pct(v), "—"); }
  const html = R.linhaItem({ itemId: "MLB1", titulo: "x", bancada: { status: "BLOQUEADO", motivoStatus: "Custo ausente", precoComprador: 100, margemPercent: null, sugerido: { status: "NAO_NECESSARIO", preco: null }, promocao: null } });
  assert.ok(!/0,00%/.test(html)); assert.ok(/Sem cálculo/.test(html)); assert.ok(/Custo ausente/.test(html));
  assert.ok(/R\$&nbsp;0,00|R\$ 0,00/.test(R.cascataHtml(bancada())), "subsídio 0 comprovado é exibido");
});
t("lista: margem mínima quando o subsídio não foi comprovado; preço cheio riscado na promoção; escape de HTML", () => {
  const html = R.linhaItem({ itemId: "MLB1", titulo: "<img src=x onerror=alert(1)>", bancada: { status: "MARGEM_DESCONHECIDA", limiteInferior: true, margemPercent: 5.61, precoComprador: 129.9, precoCheio: 149.9, promocao: { tipoRotulo: "Oferta", financiamento: "NAO_DETERMINADO" }, sugerido: { status: "NAO_NECESSARIO", preco: null } } });
  assert.ok(/mín\./.test(html)); assert.ok(/rg-riscado/.test(html)); assert.ok(/não comprovado/.test(html));
  assert.ok(!/<img/.test(html)); assert.ok(/&lt;img/.test(html));
});
t("bancada: cascata cheio → comprador → lucro, preços do vendedor e do comprador separados, sugerido PRELIMINAR = não usar", () => {
  const html = R.bancadaHtml(det(), CFG_OFF);
  for (const k of ["precoCheio", "descontoVendedor", "precoComprador", "subsidioMl", "lucro"]) assert.ok(html.includes(`data-rg-linha="${k}"`), k);
  assert.ok(/Preço cheio do vendedor/.test(html) && /Promocional do vendedor/.test(html) && /Comprador paga/.test(html) && /Subsídio ML comprovado/.test(html));
  assert.ok(/Simulação preliminar: não usar/.test(html)); assert.ok(!/Recotado no ML/.test(html));
  const rec = R.bancadaHtml(det(bancada({ sugerido: { status: "RECOTADO", preco: 140.5, margemPercent: 15.02, comissao: 26.7, frete: 19.05, recotadoEm: "2026-11-12T23:40:00Z" } })), CFG_OFF);
  assert.ok(/Recotado no ML/.test(rec) && /140,50/.test(rec));
});
t("bloqueio mostra o motivo exato e o que resolve", () => {
  const html = R.bancadaHtml(det(bancada({ status: "BLOQUEADO", bloqueios: [{ codigo: "CUSTO_AUSENTE", texto: "Custo do produto ausente.", resolveCom: "Preencher a Base de custos." }] })), CFG_OFF);
  assert.ok(/Custo do produto ausente/.test(html) && /Resolve: Preencher a Base de custos/.test(html));
});
t("ações DESLIGADAS: botões desabilitados e aviso; preview também desliga; ligadas só com servidor + contexto + slug", () => {
  const off = R.acoesHtml(bancada(), det().contexto, CFG_OFF);
  assert.ok(/desligadas neste ambiente/.test(off)); assert.strictEqual((off.match(/data-rg-acao="\d" disabled/g) || []).length, 2);
  assert.ok(/somente leitura/.test(R.acoesHtml(bancada(), { ...det().contexto, preview: true }, { ...CFG_ON, preview: true })));
  assert.strictEqual(R.podeAgir(det().contexto, CFG_ON), true);
  assert.strictEqual(R.podeAgir({ ...det().contexto, clienteSlug: null }, CFG_ON), false);
  assert.strictEqual(R.podeAgir({ ...det().contexto, acoesHabilitadas: false }, CFG_ON), false);
  assert.strictEqual(R.podeAgir(det().contexto, { ...CFG_ON, preview: true }), false);
  const on = R.acoesHtml(bancada(), det().contexto, CFG_ON);
  assert.strictEqual((on.match(/data-rg-acao="\d" disabled/g) || []).length, 0);
});
t("plano da ação = endpoint EXISTENTE de /anuncios-meli com o corpo que ele espera", () => {
  const ctx = det().contexto;
  assert.deepStrictEqual(R.planoDaAcao({ tipo: "ALTERAR_PRECO", precoAlvo: 152.92 }, ctx, "MLB1"), { method: "PATCH", url: "/anuncios-meli/MLB1/preco", body: { clienteSlug: "cliente-x", clienteContaId: 86, preco: 152.92 } });
  assert.deepStrictEqual(R.planoDaAcao({ tipo: "ALTERAR_PRECO_PROMOCIONAL", precoAlvo: 140.5, promocaoId: "C-MLB6270746" }, ctx, "MLB1").body, { clienteSlug: "cliente-x", clienteContaId: 86, precoNovo: 140.5, alterarParticipacao: true });
  assert.strictEqual(R.planoDaAcao({ tipo: "SAIR_DA_PROMOCAO", promocaoId: "C-1", promocaoTipo: "SELLER_CAMPAIGN" }, ctx, "MLB1").url, "/anuncios-meli/MLB1/promocoes/C-1/sair");
  assert.strictEqual(R.planoDaAcao({ tipo: "PARTICIPAR", promocaoId: "P-1", promocaoTipo: "SMART" }, ctx, "MLB1").body.tipo, "SMART");
  assert.strictEqual(R.planoDaAcao({ tipo: "OUTRA" }, ctx, "MLB1"), null);
});
t("releitura: preço mudou → bloqueia; ainda em promoção antes de alterar o cheio → bloqueia; igual → segue", () => {
  const b = bancada(), alterar = b.acoes[1];
  assert.strictEqual(R.conferirReleitura(b.acoes[0], b, null).ok, false);
  assert.ok(/mudou/.test(R.conferirReleitura(b.acoes[0], b, { precoAtual: 119.9 }).motivo));
  assert.ok(/saia da promoção/.test(R.conferirReleitura(alterar, b, { precoAtual: 129.9, precoOriginal: 149.9 }).motivo));
  assert.strictEqual(R.conferirReleitura(b.acoes[0], b, { precoAtual: 129.9, precoOriginal: 149.9 }).ok, true);
});

// ── Caminho de escrita com DOM e fetch falsos ──────────────────────────────
function domFalso() {
  const els = {};
  const el = (id) => els[id] || (els[id] = { id, innerHTML: "", textContent: "", hidden: false, disabled: false, checked: false, value: "", dataset: {}, _l: {},
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); }, toggle() {} },
    setAttribute() {}, addEventListener(ev, fn) { this._l[ev] = fn; }, appendChild() {}, remove() {} });
  return { els, document: { getElementById: el, createElement: () => el("tmp" + Math.random()), querySelectorAll: () => [], querySelector: () => null } };
}
async function cenario({ cfg, ctx = {}, precoRelido = 129.9, marcarCiente = true }) {
  const { els, document } = domFalso();
  const chamadas = [];
  globalThis.document = document;
  globalThis.fetch = async (url, init) => {
    chamadas.push({ url, method: (init && init.method) || "GET", body: init && init.body ? JSON.parse(init.body) : null });
    const data = /precos-ao-vivo/.test(url) ? { ok: true, precos: { MLB4427778060: { precoAtual: precoRelido, precoOriginal: 149.9 } } } : { ok: true, item: det().item, bancada: bancada(), contexto: det().contexto };
    return { ok: true, status: 200, json: async () => data };
  };
  Object.assign(R._estado, { cfg, contaId: 86, aberto: det(bancada(), ctx), acaoPendente: null });
  await R._prepararAcao(R._estado.aberto.bancada.acoes[0]);
  if (marcarCiente && els["rg-modal-ciente"]) els["rg-modal-ciente"].checked = true;
  if (marcarCiente) { els["rg-modal-ciente"] = els["rg-modal-ciente"] || { checked: false }; els["rg-modal-ciente"].checked = marcarCiente; }
  await R._executarAcao();
  return chamadas.filter((c) => c.method !== "GET");
}
t("escrita: desligada no servidor, no preview ou no contexto → nenhuma escrita enviada", async () => {
  assert.deepStrictEqual(await cenario({ cfg: CFG_OFF }), []);
  assert.deepStrictEqual(await cenario({ cfg: { ...CFG_ON, preview: true } }), []);
  assert.deepStrictEqual(await cenario({ cfg: CFG_ON, ctx: { acoesHabilitadas: false } }), []);
});
t("escrita: preço mudou na releitura → nada enviado; sem o 'Revisei' marcado → nada enviado", async () => {
  assert.deepStrictEqual(await cenario({ cfg: CFG_ON, precoRelido: 119.9 }), []);
  assert.deepStrictEqual(await cenario({ cfg: CFG_ON, marcarCiente: false }), []);
});
t("escrita: tudo certo → UMA chamada ao endpoint existente (sair da promoção) e a revisão vira AJUSTADO", async () => {
  const w = await cenario({ cfg: CFG_ON });
  assert.strictEqual(w[0].url, "https://venforce-server.onrender.com/anuncios-meli/MLB4427778060/promocoes/C-MLB6270746/sair");
  assert.deepStrictEqual(w[0].body, { clienteSlug: "cliente-x", clienteContaId: 86, tipo: "SELLER_CAMPAIGN" });
  assert.strictEqual(w.filter((c) => /anuncios-meli/.test(c.url)).length, 1);
  assert.ok(/\/resgate\/contas\/86\/itens\/MLB4427778060\/revisao$/.test(w[1].url) && w[1].body.status === "AJUSTADO");
});
t("fonte: escrita no ML só via planoDaAcao/executarAcao; nenhuma URL de escrita montada fora deles", () => {
  const src = fs.readFileSync(path.join(__dirname, "resgate.js"), "utf8");
  assert.strictEqual((src.match(/method:\s*"PATCH"/g) || []).length, 1, "PATCH só no plano de alterar preço");
  assert.strictEqual((src.match(/\/preco"/g) || []).length, 1);
  assert.strictEqual((src.match(/"\/aplicar"|\/aplicar"/g) || []).length, 1);
  assert.strictEqual((src.match(/chamar\(p\.plano\.url/g) || []).length, 1, "um único ponto que envia o plano");
  const exec = src.slice(src.indexOf("function executarAcao"), src.indexOf("function iniciar"));
  assert.ok(/ciente\.checked/.test(exec) && /podeAgir\(/.test(exec));
});
t("preços digitados no formato brasileiro", () => {
  assert.deepStrictEqual(R.lerPrecos("89,90; 1.094,90 abc 0"), [89.9, 1094.9]);
  assert.strictEqual(R.lerNumero("152,92"), 152.92); assert.strictEqual(R.lerNumero("152.92"), 152.92); assert.strictEqual(R.lerNumero(""), null);
});
t("página no Shell V3 (scope global), menu 'Resgate' e modal/drawer da Fundação V2", () => {
  const html = fs.readFileSync(path.join(__dirname, "resgate.html"), "utf8");
  assert.ok(/data-vf-scope="global"/.test(html) && /vf-shell\.js/.test(html) && /resgate\.js/.test(html) && /vf-tokens-v2\.css/.test(html));
  assert.ok(/class="vf-overlay" id="rg-modal"/.test(html) && /id="rg-modal-confirmar" disabled/.test(html) && /vf-drawer vf-drawer--lg/.test(html));
  for (const f of ["abaixo_meta", "prejuizo", "desconhecida", "promocao"]) assert.ok(html.includes(`data-rg-filtro="${f}"`), f);
  const shell = fs.readFileSync(path.join(__dirname, "vf-shell.js"), "utf8");
  assert.ok(/id: "resgate", label: "Resgate", rota: "resgate\.html"/.test(shell));
  assert.ok(/"promocoes-ml", "resgate"\]/.test(shell));
});

(async () => { for (const p of pendentes) await p(); console.log(`\n${ok} verificações da tela do Resgate`); process.exit(process.exitCode || 0); })();
