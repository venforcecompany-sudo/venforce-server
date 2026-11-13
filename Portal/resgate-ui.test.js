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
const det = (b = bancada(), ctx = {}, item = {}) => ({ item: { itemId: "MLB4427778060", titulo: "Saia", fingerprint: { precoVisto: 129.9 }, vendas30d: { unidades: 10 }, contrato: { componentes: { frete: { valor: 19.05, status: "estimado", nivel: "estimado_dimensoes_declaradas", confianca: "media" } } }, ...item }, bancada: b, contexto: { clienteSlug: "cliente-x", clienteContaId: 86, acoesHabilitadas: true, ...ctx } });
const CFG_ON = { acoesHabilitadas: true, preview: false, recotacaoSobDemanda: true, simulacaoPreliminar: true };
const CFG_OFF = { acoesHabilitadas: false, preview: false, recotacaoSobDemanda: true, simulacaoPreliminar: true };
const cof = () => bancada({ status: "ABAIXO_DA_META", precos: { cheio: 137.5, comprador: 114, promocionalVendedor: null, campanhaVendedor: { id: "C-1", nome: "PROMO - VENDEX", tipoRotulo: "Campanha própria do vendedor", preco: 118.8 } },
  promocao: { ativa: true, tipo: "SMART", tipoRotulo: "Campanha cofinanciada (SMART)", id: "P-1", nome: "Moda Nov26", financiamento: "ML_COFINANCIA", subsidio: 4.26, comprovado: true, modoEscrita: "ACEITE",
    iniciadas: [{ id: "C-1", tipo: "SELLER_CAMPAIGN", tipoRotulo: "Campanha própria do vendedor", nome: "PROMO - VENDEX", preco: 118.8, formaPreco: false }, { id: "P-1", tipo: "SMART", tipoRotulo: "Campanha cofinanciada (SMART)", nome: "Moda Nov26", preco: 114, mlPct: 3.1, vendPct: 14, formaPreco: true }] },
  resultado: { calculavel: true, lucro: 10.63, margemPercent: 9.32, confiavel: true, limiteInferior: false } });
const bloq = () => bancada({ status: "BLOQUEADO", resultado: { calculavel: false, lucro: null, margemPercent: null }, bloqueios: [{ codigo: "FRETE_DESCONHECIDO", texto: "Frete desconhecido.", resolveCom: "Declarar as medidas da embalagem no anúncio." }], sugerido: { status: "NAO_NECESSARIO", preco: null } });

t("ausente aparece como — (nunca R$ 0,00 / 0%); margens com 2 casas como na auditoria", () => {
  for (const v of [null, undefined, "", NaN]) { assert.strictEqual(R.moeda(v), "—"); assert.strictEqual(R.pct(v), "—"); }
  assert.strictEqual(R.pct(-0.25), "−0,25%"); assert.strictEqual(R.pct(13.99), "13,99%");
  const html = R.linhaTabelaHtml({ itemId: "MLB1", titulo: "x", bancada: { status: "BLOQUEADO", bloqueio: "CUSTO_AUSENTE", precoComprador: 100, margemPercent: null, sugerido: { status: "NAO_NECESSARIO", preco: null }, promocao: null } });
  assert.ok(!/0,00%/.test(html)); assert.ok(/Falta informação/.test(html));
});
t("lista: linha compacta com preço cheio riscado, promoção que forma o preço, margem mínima e escape", () => {
  const html = R.linhaTabelaHtml({ itemId: "MLB1", titulo: "<img src=x onerror=alert(1)>", bancada: { status: "MARGEM_DESCONHECIDA", limiteInferior: true, margemPercent: 5.61, precoComprador: 129.9, precoCheio: 149.9, promocao: { tipoRotulo: "Oferta", financiamento: "NAO_DETERMINADO" }, sugerido: { status: "PRELIMINAR", preco: 140 }, proximoPasso: "Ler as promoções" } });
  assert.ok(/≥ 5,61%/.test(html) && /<s/.test(html) && /ajuda do ML não comprovada/.test(html) && /Ler as promoções/.test(html));
  assert.ok(!/<img/.test(html) && /&lt;img/.test(html));
});
t("selos: frete do preço atual e preço recotado NUNCA compartilham o texto", () => {
  const f = R.seloFrete({ valor: 16.85, status: "ok", nivel: "cotado_ml", confianca: "alta" }).txt, p = R.seloPreco("RECOTADO").txt, pre = R.seloPreco("PRELIMINAR").txt;
  assert.strictEqual(f, "frete cotado no ML (preço atual)"); assert.strictEqual(p, "preço recotado no ML"); assert.strictEqual(pre, "preço preliminar");
  assert.notStrictEqual(f, p); assert.ok(!/preço/.test(R.seloFrete({ valor: 19, status: "estimado", nivel: "estimado_dimensoes_declaradas", confianca: "media" }).txt.replace("(preço atual)", "")));
  const lin = R.linhaTabelaHtml({ itemId: "MLB1", titulo: "x", bancada: { status: "ABAIXO_DA_META", margemPercent: 5, precoComprador: 100, sugerido: { status: "RECOTADO", preco: 120 } } });
  assert.ok(/preço recotado no ML/.test(lin));
});
t("entender: campanha própria → desconto todo do vendedor; cofinanciada → ML devolve uma única vez e campanha por baixo; bloqueado → motivo", () => {
  let x = R.entender(det(), { "149.9": { resultado: { calculavel: true, lucro: 32.57, margemPercent: 21.73 } } }, 15);
  assert.ok(/abaixo da sua meta de 15/.test(x.manchete)); const tx = x.frases.map((f) => f.t).join(" ");
  assert.ok(/criada por você/.test(tx) && /sai inteiro do seu lucro/.test(tx) && /Sem esse desconto/.test(tx) && /estimativa preliminar/.test(tx));
  x = R.entender(det(cof()), null, 15); const t2 = x.frases.map((f) => f.t).join(" ");
  assert.ok(/devolve R\$\s?4,26/.test(t2) && /uma única vez/.test(t2) && /não é ela que define o preço/.test(t2) && /118,80/.test(t2));
  x = R.entender(det(bloq()), null, 15); assert.ok(/Ainda não dá para saber/.test(x.manchete) && /frete deste anúncio/.test(x.frases.map((f) => f.t).join(" ")));
});
t("opções: só ações compatíveis (ACEITE cofinanciada não oferece ajustar promocional; bloqueado → completar)", () => {
  const ids = (b) => R.opcoes(det(b), 15).map((o) => o.id);
  assert.deepStrictEqual(ids(bancada({ promocao: { ...bancada().promocao, modoEscrita: "PRECO" } })), ["sair", "promo", "comparar", "manter"]);
  const c = R.opcoes(det(cof()), 15); assert.ok(!c.some((o) => o.id === "promo")); assert.strictEqual(c.find((o) => o.rec).id, "comparar");
  assert.ok(/118,80/.test(c.find((o) => o.id === "sair").desc));
  assert.deepStrictEqual(ids(bloq()), ["completar", "manter"]);
});
t("Antes × Depois: preliminar marcado; recotado com selo de PREÇO recotado; não calculável mostra o motivo", () => {
  const pre = R.antesDepoisHtml(det(), R.normalizarSim({ preco: 152.93, resultado: { calculavel: true, lucro: 22.94, margemPercent: 15 }, comissao: { valor: 29.06 }, frete: { valor: 19.05 }, avisos: ["Comissão e frete mantidos."] }, "PRELIMINAR"), 15);
  assert.ok(/Preço preliminar/.test(pre) && !/recotado/.test(pre) && /\+R\$\s?15,66/.test(pre));
  const rec = R.antesDepoisHtml(det(), R.normalizarSim({ status: "RECOTADO", preco: 137.66, margemPercent: 15.58, lucro: 21.44, comissao: 19.27, frete: 19.05, freteNivel: "cotado_ml", freteConfianca: "alta", recotadoEm: "2026-11-13T00:30:28Z" }, "CONFIRMADO"), 15);
  assert.ok(/Preço recotado no Mercado Livre/.test(rec) && /15,58%/.test(rec));
  assert.ok(/Não é possível simular/.test(R.antesDepoisHtml(det(), { preco: 100, calculavel: false, bloqueios: [{ texto: "Custo ausente." }] }, 15)));
});
t("promoções: agrupadas como em Anúncios (ativa / já participa / pode / só pelo ML)", () => {
  const l = R.linhasPromocao(det(cof()), null, { "118.8": { resultado: { calculavel: true, margemPercent: 8.11, lucro: 9.64 } } });
  assert.deepStrictEqual(l.map((x) => x.grupo), ["participa", "ativa"]); assert.strictEqual(l.find((x) => x.grupo === "ativa").margem, 9.32);
  const vivas = R.linhasPromocao(det(cof()), [{ statusExibicao: "ATIVA", status: "started", tipo: "SMART", precoFinal: 114, subsidioMl: 4.26, voceRecebe: { computable: true, marginPercent: 9.32, profit: 10.63 } }, { status: "candidate", modoEscrita: "ACEITE", tipo: "SMART", precoFinal: 99, subsidioMl: 5, voceRecebe: { computable: true, marginPercent: 7 } }, { status: "candidate", modoEscrita: null, tipo: "LIGHTNING", precoFinal: 90 }], null);
  assert.deepStrictEqual(vivas.map((x) => x.grupo), ["ativa", "pode", "ml"]);
  const html = R.compararHtml(vivas, vivas[1].chave, true, true); assert.ok(/Ativa agora/.test(html) && /Pode participar/.test(html) && /Só pelo Mercado Livre/.test(html));
});
t("pedidos: margem realizada, detalhe e não comprovado", () => {
  const p = { periodo: { dias: 60 }, pedidos: [{ rowId: 7, data: "2026-11-01", unidades: 1, precoUnitario: 92.33, resultado: 14.32, comprovado: true, margemRealizadaPercent: 15.51 }, { rowId: 8, data: "2026-11-02", unidades: 1, precoUnitario: 92.33, comprovado: false, motivoNaoComprovado: "Pedido cancelado." }],
    comparacao: { projetado: { margemPercent: 5.62 }, realizado: { pedidos: 118, margemPercent: 13.99, precoMedio: 92.76 }, faltantes: [], conclusao: "Realizado em linha." }, avisos: [] };
  const html = R.painelPedidosHtml(p, 7, { pedido: { comprovado: true }, componentes: [{ rotulo: "Comissão cobrada", valor: -12.93, efeito: "debito", incluidoNoResultado: true }], conferencia: { confere: true, resultadoPedido: 14.32 }, compensacoes: { observacao: "x", descontosEBonusDoMl: "y" } });
  assert.ok(/13,99%/.test(html) && /últimos 60 dias/.test(html) && /não confirmado/.test(html) && /Comissão cobrada/.test(html) && /soma bate/.test(html));
});
t("proposta: sair da campanha = 2 passos reais (sair → alterar cheio) e só aplicável com preço recotado", () => {
  Object.assign(R._estado, { cfg: CFG_ON, aberto: det(bancada({ promocao: { ...bancada().promocao, modoEscrita: "PRECO" } })), opcao: "sair", sim: R.normalizarSim({ preco: 152.93, resultado: { calculavel: true, lucro: 22.94, margemPercent: 15 } }, "PRELIMINAR") });
  let x = R._proposta(); assert.strictEqual(x.acoes.length, 2); assert.deepStrictEqual(x.acoes.map((a) => a.tipo), ["SAIR_DA_PROMOCAO", "ALTERAR_PRECO"]); assert.strictEqual(x.status, "PENDENTE");
  R._estado.sim = R.normalizarSim({ status: "RECOTADO", preco: 152.93, margemPercent: 15, lucro: 22.94, comissao: 29, frete: 19 }, "CONFIRMADO");
  x = R._proposta(); assert.strictEqual(x.status, "APROVADO"); assert.strictEqual(x.acoes[1].margemRecotadaPercent, 15);
  R._estado.aberto = null; R._estado.opcao = null; R._estado.sim = null;
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
  assert.strictEqual((src.match(/"\/preco"/g) || []).length, 1, "URL de preço montada num só lugar (planoDaAcao)");
  assert.strictEqual((src.match(/"\/aplicar"/g) || []).length, 1, "URL de aplicar montada num só lugar (planoDaAcao)");
  assert.strictEqual((src.match(/chamar\(p\.plano\.url/g) || []).length, 1, "um único ponto que envia o plano");
  const exec = src.slice(src.indexOf("function executarAcao"), src.indexOf("function iniciar"));
  assert.ok(/ciente\.checked/.test(exec) && /podeAgir\(/.test(exec));
});
t("preços digitados no formato brasileiro", () => {
  assert.deepStrictEqual(R.lerPrecos("89,90; 1.094,90 abc 0"), [89.9, 1094.9]);
  assert.strictEqual(R.lerNumero("152,92"), 152.92); assert.strictEqual(R.lerNumero("152.92"), 152.92); assert.strictEqual(R.lerNumero(""), null);
});
t("página no Shell V3 (scope global), menu 'Resgate', lista + bancada lateral e modal de confirmação", () => {
  const html = fs.readFileSync(path.join(__dirname, "resgate.html"), "utf8");
  assert.ok(/data-vf-scope="global"/.test(html) && /vf-shell\.js/.test(html) && /resgate\.js/.test(html) && /vf-tokens-v2\.css/.test(html));
  assert.ok(/class="vf-overlay" id="rg-modal"/.test(html) && /id="rg-modal-confirmar" disabled/.test(html) && /id="rg-bancada"/.test(html) && /id="rg-lote-barra"/.test(html));
  const shell = fs.readFileSync(path.join(__dirname, "vf-shell.js"), "utf8");
  assert.ok(/id: "resgate", label: "Resgate", rota: "resgate\.html"/.test(shell));
});
t("fonte: nenhuma fórmula de preço/margem na tela (simulação vem do servidor) e lote nunca chama /anuncios-meli", () => {
  const src = fs.readFileSync(path.join(__dirname, "resgate.js"), "utf8");
  assert.ok(!/comissaoPct\s*\*|impostoPct|computeTargetPrice/.test(src));
  const lote = src.slice(src.indexOf("function simularLote"), src.indexOf("// ── Avançado"));
  assert.ok(!/anuncios-meli/.test(lote) && /\/propostas"/.test(lote) && /\/revisao"/.test(lote));
  assert.ok(/preliminar: true/.test(src));
});

(async () => { for (const p of pendentes) await p(); console.log(`\n${ok} verificações da tela do Resgate`); process.exit(process.exitCode || 0); })();
