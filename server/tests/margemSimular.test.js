// server/tests/margemSimular.test.js
// POST /api/margem/simular e /api/margem/composicao — service, cotador,
// controller e rota. Sem banco real e sem Mercado Livre: carteira, snapshots,
// anúncios e ML são fakes injetados; o ML falso REGISTRA cada chamada.

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://127.0.0.1:1/dead";

const assert = require("assert");
const core = require("../services/motorMargem/core");
const read = require("../services/motorMargem/marginSnapshotReadService");
const service = require("../services/motorMargem/margemSimularService");
const { criarCotadorEmP } = require("../services/motorMargem/margemCotacaoEmP");
const { createMargemSimularController } = require("../controllers/margemSimularController");

const casos = [];
function cenario(nome, fn) {
  casos.push({ nome, fn });
}

// ── Mundo falso ──────────────────────────────────────────────────────────────
const CONTAS = {
  5: { id: 5, cliente_id: 1, marketplace: "meli", nome: "Loja A — principal", ativo: true, external_account_id: "1001" },
  6: { id: 6, cliente_id: 1, marketplace: "meli", nome: "Loja A — outlet", ativo: true, external_account_id: "1002" },
  7: { id: 7, cliente_id: 2, marketplace: "meli", nome: "Loja B", ativo: true, external_account_id: "2001" },
  8: { id: 8, cliente_id: 1, marketplace: "shopee", nome: "Loja A — Shopee", ativo: true, external_account_id: "9" },
  9: { id: 9, cliente_id: 1, marketplace: "meli", nome: "Loja A — sem grant", ativo: true, external_account_id: null },
};
const CARTEIRA = { 10: [1], 20: [2] }; // usuário → clientes
const USER_A = { id: 10, role: "user" };
const USER_B = { id: 20, role: "user" };

function erro(statusCode, code, message, extra = {}) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  Object.assign(err, extra);
  return err;
}

async function assertContaNaCarteira(user, contaId) {
  const conta = CONTAS[Number(contaId)];
  if (!conta) throw erro(404, "CLIENTE_NAO_ENCONTRADO", "Conta não encontrada.");
  if (!(CARTEIRA[user.id] || []).includes(conta.cliente_id)) {
    throw erro(403, "CLIENTE_FORA_DA_CARTEIRA", "Cliente fora da sua carteira.", { clienteContaId: conta.id });
  }
  return { contaId: conta.id, clienteId: conta.cliente_id, clienteSlug: `cliente-${conta.cliente_id}`, clienteNome: `Cliente ${conta.cliente_id}`, clienteAtivo: true };
}

const LINHA_BASE = {
  itemId: "MLB100", sku: "SKU-1", titulo: "Produto de teste", marketplace: "meli", baseId: 3,
  price: 94.9, cost: 21.35, taxRate: 0.06, fixedFee: 0, commission: 13.29, commissionRate: 0.14, freight: 10,
  profit: null, margin: null, status: "HEALTHY", confidenceLevel: "HIGH", assumed: [], missing: [], refreshStatus: "fresh",
  calculatedAt: "2026-10-13T06:00:00.000Z", observedAt: "2026-10-13T06:00:00.000Z", runId: 7,
  quality: { targetMargin: 0.1 }, catalogMissingSince: null,
};
{
  const m = core.computeMargin({ price: 94.9, cost: 21.35, taxRate: 0.06, fixedFee: 0, commission: 13.29, freight: 10 });
  LINHA_BASE.profit = m.profit;
  LINHA_BASE.margin = m.margin;
}

function promoLinha(chave, extra = {}) {
  return {
    itemId: "MLB100", promocaoChave: chave, promotionId: chave, refId: null, tipo: "SMART", tipoConhecido: true, nome: `Promo ${chave}`,
    status: "candidate", statusExibicao: "ELEGÍVEL", inicio: null, fim: "2026-11-01T00:00:00.000Z",
    precoOriginal: 94.9, precoFinal: 89.77, precoFinalFonte: "ml", descontoValor: 5.13, descontoPercentual: 5.4,
    sellerPercentage: 3, meliPercentage: 3.5, subsidioMl: 3.3, elegivel: true, ativa: false, programada: false, naoAplicada: null,
    observedAt: "2026-10-14T03:00:00.000Z", herdada: false, reaproveitadaDoRun: null, ...extra,
  };
}

// Cotação falsa: comissão 14% do preço; frete 10 a partir de R$ 79 (abaixo disso, 0 — a "faixa").
function cotacaoFalsa(preco) {
  return { comissaoValor: Math.round(preco * 0.14 * 100) / 100, comissaoPercentual: 0.14, fretePrevisto: preco >= 79 ? 10 : 0 };
}

function mundo({ promocoes = [promoLinha("P1")], promoSnapshot = true, snapshots, anuncios, rebates, buscar, mlFetch, linhaBase = LINHA_BASE } = {}) {
  const w = { cotacoes: [], promoLeituras: 0, mlChamadas: [] };
  const snaps = snapshots || new Map([["5:MLB100", { ...linhaBase }], ["6:MLB200", { ...linhaBase, itemId: "MLB200" }]]);
  const anuncs = anuncios || new Map([
    ["1:MLB100", { item_id: "MLB100", ml_user_id: "1001", listing_type_id: "gold_special", category_id: "MLB1234", logistic_type: "xd_drop_off", titulo: "Produto de teste" }],
    ["1:MLB200", { item_id: "MLB200", ml_user_id: "1002", listing_type_id: "gold_special", category_id: "MLB1234", logistic_type: "xd_drop_off" }],
    ["1:MLB300", { item_id: "MLB300", ml_user_id: "1002", listing_type_id: "gold_special", category_id: "MLB1234", logistic_type: "xd_drop_off" }],
  ]);
  w.deps = {
    db: {},
    now: () => new Date("2026-10-14T12:00:00.000Z"),
    logger: { error() {}, warn() {}, info() {} },
    assertContaNaCarteira,
    obterConta: async (id) => {
      const c = CONTAS[Number(id)];
      if (!c) throw erro(404, null, "Conta não encontrada.");
      return c;
    },
    snapshotRepo: { getProjectionSnapshot: async ({ clienteContaId, itemId }) => snaps.get(`${clienteContaId}:${itemId}`) || null },
    obterAnuncio: async (clienteId, itemId) => anuncs.get(`${clienteId}:${itemId}`) || null,
    promoService: {
      estadoSincronizacao: async () => (promoSnapshot
        ? { hasSnapshot: true, snapshotRunId: 31, snapshotAt: "2026-10-14T03:00:00.000Z", partial: false }
        : { hasSnapshot: false, snapshotRunId: null, snapshotAt: null, partial: false }),
    },
    promoRepo: { listarLinhasSnapshot: async () => { w.promoLeituras += 1; return { total: promocoes.length, linhas: promocoes }; } },
    carregarRebates: async () => rebates || { porItem: new Map(), indisponivel: null },
    buscarComissaoEFrete: buscar || (async (args) => {
      w.cotacoes.push(args.precoEfetivo);
      return cotacaoFalsa(args.precoEfetivo);
    }),
    mlFetch: mlFetch || (async (clienteId, caminho, opts) => { w.mlChamadas.push({ caminho, opts }); return { ok: true, status: 200, data: {} }; }),
  };
  return w;
}

const pedido = (cenarios, extra = {}) => ({ cliente_conta_id: 5, mlb: "MLB100", cenarios, ...extra });
const rodar = (w, body, user = USER_A) => service.simular({ user, body }, w.deps);

async function recusa(promessa, status, codigo) {
  try {
    await promessa;
  } catch (err) {
    assert.strictEqual(err.statusCode, status, `status ${err.statusCode} (${err.message})`);
    if (codigo) assert.strictEqual(err.code || (err.payload && err.payload.codigo), codigo);
    return err;
  }
  assert.fail(`deveria recusar com ${status}`);
  return null;
}

// ── Aceite ───────────────────────────────────────────────────────────────────

cenario("94,90 → 89,77 com retorno 3,30: ΔLC negativo, entrar_se_girar, empate ≈ +1,8% — pela promoção do Promo Snapshot", async () => {
  const w = mundo();
  const r = await rodar(w, pedido([{ tipo: "promo", promotion_id: "P1" }]));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.cenarios.length, 1);
  const c = r.cenarios[0];
  assert.strictEqual(c.veredito, "entrar_se_girar");
  assert.ok(c.delta_lc < 0);
  assert.ok(c.empate_volume > 0.017 && c.empate_volume < 0.019, String(c.empate_volume));
  assert.strictEqual(c.cenario.preco, 89.77);
  assert.strictEqual(c.cenario.comissao, 12.57);
  assert.strictEqual(c.cenario.frete, 10);
  assert.strictEqual(c.ml_banca, 3.3);
  assert.strictEqual(c.seller_banca, 1.83);
  assert.strictEqual(c.flags.mudou_faixa_frete, false);
  assert.deepStrictEqual(w.cotacoes, [89.77], "uma cotação, no preço da promoção");
  assert.strictEqual(r.atual.preco, 94.9);
  assert.strictEqual(r.atual.lc, LINHA_BASE.profit);
});

// ── Topo da Bancada: alíquota, preço cheio e Base de hoje vêm prontos em `atual` ──

cenario("atual: alíquota de hoje, preço cheio do item e a Base (id + nome) para o topo da Bancada", async () => {
  const w = mundo({ linhaBase: { ...LINHA_BASE, listPrice: 119.9 } });
  const consultas = [];
  w.deps.obterBaseNome = async (baseId) => { consultas.push(baseId); return baseId === 3 ? "Base Loja A" : null; };
  const r = await rodar(w, pedido([{ tipo: "preco", preco: 90 }]));
  assert.strictEqual(r.atual.aliquota, 0.06);
  assert.strictEqual(r.atual.imposto, 5.69, "o R$/un continua o da composição");
  assert.strictEqual(r.atual.preco_cheio, 119.9);
  assert.strictEqual(r.atual.preco_cheio_fonte, "margin_snapshot");
  assert.deepStrictEqual(r.atual.base, { id: 3, nome: "Base Loja A" });
  assert.deepStrictEqual(consultas, [3], "uma leitura do nome da Base");
});

cenario("atual: sem preço cheio no item ⇒ null (nunca o preço atual nem o original da promoção); nome da Base que falha ⇒ só o id", async () => {
  const w = mundo({ promocoes: [promoLinha("P1", { precoOriginal: 94.9 })] });
  w.deps.obterBaseNome = async () => { throw new Error("banco fora"); };
  const r = await rodar(w, pedido([{ tipo: "promo", promotion_id: "P1" }]));
  assert.strictEqual(r.atual.preco_cheio, null);
  assert.strictEqual(r.atual.preco_cheio_fonte, null);
  assert.deepStrictEqual(r.atual.base, { id: 3, nome: null });
  assert.strictEqual(r.cenarios[0].preco_cheio_fonte, "promo_snapshot", "o cenário continua usando o original_price");
});

cenario("atual: sem Margin Snapshot ⇒ alíquota, preço cheio e Base nulos (sem consultar a Base)", async () => {
  const w = mundo({ snapshots: new Map() });
  let consultou = false;
  w.deps.obterBaseNome = async () => { consultou = true; return "x"; };
  const r = await rodar(w, pedido([{ tipo: "preco", preco: 90 }]));
  assert.strictEqual(r.atual.aliquota, null);
  assert.strictEqual(r.atual.preco_cheio, null);
  assert.strictEqual(r.atual.base, null);
  assert.strictEqual(consultou, false);
});

// ── Quem banca: sobre o preço CHEIO do item, não sobre o preço atual (já promocional) ──

cenario("quem banca: preço atual 112,42 já em promoção, cheio 141,90 (do item): desconto 31,65 sobre o cheio, ML 6,62, seller 25,03; Δ vs hoje 2,17 à parte", async () => {
  const linha = { ...LINHA_BASE, price: 112.42, listPrice: 141.9, commission: 15.74, freight: 18.9, cost: 40 };
  const w = mundo({ linhaBase: linha, promocoes: [promoLinha("P1", { precoFinal: 110.25, subsidioMl: 6.62, precoOriginal: 141.9 })] });
  const r = await rodar(w, pedido([{ tipo: "promo", promotion_id: "P1" }]));
  const c = r.cenarios[0];
  assert.strictEqual(c.preco_cheio, 141.9);
  assert.strictEqual(c.preco_cheio_fonte, "margin_snapshot");
  assert.strictEqual(c.desconto_total, 31.65);
  assert.strictEqual(c.ml_banca, 6.62);
  assert.strictEqual(c.seller_banca, 25.03);
  assert.strictEqual(c.delta_preco_atual, 2.17);
  assert.strictEqual(c.banca_aviso, null);
  assert.deepStrictEqual(c.evidencia.preco_cheio, { fonte: "margin_snapshot", calculado_em: "2026-10-13T06:00:00.000Z" });
});

cenario("quem banca: o cheio do ITEM tem prioridade sobre o original_price da promoção (a fonte é dita)", async () => {
  const w = mundo({ linhaBase: { ...LINHA_BASE, listPrice: 100 }, promocoes: [promoLinha("P1", { precoOriginal: 94.9 })] });
  const c = (await rodar(w, pedido([{ tipo: "promo", promotion_id: "P1" }]))).cenarios[0];
  assert.strictEqual(c.preco_cheio, 100);
  assert.strictEqual(c.preco_cheio_fonte, "margin_snapshot");
  assert.strictEqual(c.desconto_total, 10.23);
});

cenario("quem banca: sem cheio no item, usa o original_price da promoção — declarado como promo_snapshot", async () => {
  const w = mundo({ promocoes: [promoLinha("P1", { precoOriginal: 94.9 })] });
  const c = (await rodar(w, pedido([{ tipo: "promo", promotion_id: "P1" }]))).cenarios[0];
  assert.strictEqual(c.preco_cheio_fonte, "promo_snapshot");
  assert.strictEqual(c.seller_banca, 1.83);
  assert.strictEqual(c.evidencia.preco_cheio.fonte, "promo_snapshot");
});

cenario("quem banca: sem cheio em lugar nenhum ⇒ seller banca null + sem_preco_cheio (o veredito continua)", async () => {
  const w = mundo({ promocoes: [promoLinha("P1", { precoOriginal: null })] });
  const c = (await rodar(w, pedido([{ tipo: "promo", promotion_id: "P1" }]))).cenarios[0];
  assert.strictEqual(c.preco_cheio, null);
  assert.strictEqual(c.seller_banca, null);
  assert.strictEqual(c.desconto_total, null);
  assert.strictEqual(c.banca_motivo, "sem_preco_cheio");
  assert.strictEqual(c.ml_banca, 3.3);
  assert.strictEqual(c.veredito, "entrar_se_girar");
  assert.deepStrictEqual(c.evidencia.preco_cheio, { fonte: null, motivo: "sem_preco_cheio" });
});

cenario("quem banca: cenário `preco` manual também usa o cheio do item (sem retorno ML: o seller banca todo o desconto)", async () => {
  const w = mundo({ linhaBase: { ...LINHA_BASE, listPrice: 100 } });
  const c = (await rodar(w, pedido([{ tipo: "preco", preco: 90 }]))).cenarios[0];
  assert.strictEqual(c.desconto_total, 10);
  assert.strictEqual(c.ml_banca, 0);
  assert.strictEqual(c.seller_banca, 10);
  assert.strictEqual(c.delta_preco_atual, 4.9);
});

// ── Grupo, escrita suportada, link do ML e hipótese de custo (Bancada) ──

cenario("cada promoção sai com o GRUPO (ativa · participa · pode · ml) e a escrita suportada pela Central", async () => {
  const promocoes = [
    promoLinha("P-ATIVA", { tipo: "DEAL", status: "started", statusExibicao: "ATIVA", precoFinal: 89.77 }),
    promoLinha("P-NAOAPL", { tipo: "DEAL", status: "started", statusExibicao: "NÃO APLICADA", precoFinal: 85 }),
    promoLinha("P-PROG", { tipo: "SELLER_CAMPAIGN", status: "pending", statusExibicao: "PROGRAMADA", precoFinal: 84 }),
    promoLinha("P-DEAL", { tipo: "DEAL", status: "candidate", statusExibicao: "ELEGÍVEL", precoFinal: 88 }),
    promoLinha("P-SELLER", { tipo: "SELLER_CAMPAIGN", status: "candidate", statusExibicao: "ELEGÍVEL", precoFinal: 87 }),
    promoLinha("P-SMART", { tipo: "SMART", status: "candidate", statusExibicao: "ELEGÍVEL", precoFinal: 86 }),
    promoLinha("P-LGH", { tipo: "LIGHTNING", status: "candidate", statusExibicao: "ELEGÍVEL", precoFinal: 83 }),
  ];
  const r = await rodar(mundo({ promocoes }), pedido([{ tipo: "todas_promos" }]));
  const por = Object.fromEntries(r.cenarios.map((c) => [c.promocao.id, c.promocao]));
  assert.deepStrictEqual(Object.fromEntries(Object.entries(por).map(([id, p]) => [id, p.grupo])), {
    "P-ATIVA": "ativa", "P-NAOAPL": "participa", "P-PROG": "participa", "P-DEAL": "pode", "P-SELLER": "pode", "P-SMART": "pode", "P-LGH": "ml",
  });
  assert.deepStrictEqual(por["P-DEAL"].escrita, { suportada: true, acao: "PARTICIPAR", modo: "preco", motivo: null });
  // SMART: o ML define o preço — a Central participa no modo ACEITE (preço sugerido, não editável).
  assert.deepStrictEqual(por["P-SMART"].escrita, { suportada: true, acao: "PARTICIPAR", modo: "aceite", motivo: null });
  assert.strictEqual(por["P-LGH"].escrita.suportada, false, "LIGHTNING: só pelo painel do ML");
  assert.ok(/Somente simulação: a oferta relâmpago/.test(por["P-LGH"].escrita.motivo));
  assert.strictEqual(por["P-ATIVA"].escrita.acao, "ALTERAR");
  assert.strictEqual(por["P-PROG"].escrita.suportada, false);
  assert.strictEqual(r.item.ml_promos_url, "https://www.mercadolivre.com.br/anuncios/lista/promos?page=1&search=100");
});

cenario("hipótese de custo: o cenário usa o custo informado, o `atual` segue real; vem marcado como hipótese", async () => {
  const w = mundo();
  const real = (await rodar(w, pedido([{ tipo: "promo", promotion_id: "P1" }]))).cenarios[0];
  const r = await rodar(mundo(), pedido([{ tipo: "promo", promotion_id: "P1", hipotese: { custo: 30, taxa_fixa: 2 } }]));
  const c = r.cenarios[0];
  assert.strictEqual(c.cenario.custo, 30);
  assert.strictEqual(c.cenario.taxa_fixa, 2);
  assert.strictEqual(r.atual.custo, 21.35, "Hoje continua com o custo real da Base");
  const esperado = core.computeMargin({ price: 89.77, cost: 30, taxRate: 0.06, fixedFee: 2, commission: 12.57, freight: 10, rebate: 3.3 });
  assert.strictEqual(c.cenario.lc, esperado.profit);
  assert.ok(c.cenario.lc < real.cenario.lc);
  assert.deepStrictEqual(c.entrada.hipotese, { custo: 30, taxa_fixa: 2 });
  assert.strictEqual(c.evidencia.hipotese, true);
  assert.deepStrictEqual(c.evidencia.custo, { fonte: "hipotese_do_operador", valor: 30 });
  // Também no preço manual.
  const m = (await rodar(mundo(), pedido([{ tipo: "preco", preco: 90, hipotese: { custo: 25 } }]))).cenarios[0];
  assert.strictEqual(m.cenario.custo, 25);
  assert.strictEqual(m.cenario.taxa_fixa, 0, "sem hipótese de taxa fixa: a da Base");
});

cenario("hipótese inválida é 400 (nada é ignorado em silêncio)", async () => {
  const w = mundo();
  await recusa(rodar(w, pedido([{ tipo: "preco", preco: 90, hipotese: { custo: -1 } }])), 400, "HIPOTESE_VALOR_INVALIDO");
  await recusa(rodar(w, pedido([{ tipo: "preco", preco: 90, hipotese: { custo: "abc" } }])), 400, "HIPOTESE_VALOR_INVALIDO");
  await recusa(rodar(w, pedido([{ tipo: "preco", preco: 90, hipotese: { frete: 1 } }])), 400, "HIPOTESE_CAMPO_DESCONHECIDO");
  await recusa(rodar(w, pedido([{ tipo: "promo", promotion_id: "P1", hipotese: [1] }])), 400, "HIPOTESE_INVALIDA");
  await recusa(rodar(w, pedido([{ tipo: "preco", preco: 90, hipotese: { custo: null } }])), 400, "HIPOTESE_VALOR_INVALIDO");
});

cenario("cenário `preco`: P' digitado; faixa de frete mudou ⇒ mudou_faixa_frete=true e frete' ≠ frete", async () => {
  const w = mundo();
  const r = await rodar(w, pedido([{ tipo: "preco", preco: 74.9 }]));
  const c = r.cenarios[0];
  assert.strictEqual(c.flags.mudou_faixa_frete, true);
  assert.strictEqual(r.atual.frete, 10);
  assert.strictEqual(c.cenario.frete, 0);
  assert.strictEqual(c.cenario.comissao, 10.49);
  assert.strictEqual(c.evidencia.frete.aplicavel, true);
  assert.deepStrictEqual(w.cotacoes, [74.9]);
});

cenario("a conta feita pelo serviço é a do núcleo: LC', margem' e ΔLC batem com computeMargin", async () => {
  const w = mundo();
  const r = await rodar(w, pedido([{ tipo: "preco", preco: 88.5 }]));
  const c = r.cenarios[0];
  const cot = cotacaoFalsa(88.5);
  const esperado = core.computeMargin({ price: 88.5, cost: 21.35, taxRate: 0.06, fixedFee: 0, commission: cot.comissaoValor, freight: cot.fretePrevisto });
  assert.strictEqual(c.cenario.lc, esperado.profit);
  assert.strictEqual(c.cenario.margem_ratio, esperado.margin);
  assert.strictEqual(c.delta_lc, Math.round((esperado.profit - LINHA_BASE.profit) * 100) / 100);
  assert.strictEqual(c.cenario.imposto, Math.round(88.5 * 0.06 * 100) / 100);
});

cenario("LC' ≤ 0: nao_entrar (preço abaixo do custo)", async () => {
  const w = mundo();
  const r = await rodar(w, pedido([{ tipo: "preco", preco: 20 }]));
  const c = r.cenarios[0];
  assert.ok(c.cenario.lc <= 0, `LC' ${c.cenario.lc}`);
  assert.strictEqual(c.veredito, "nao_entrar");
  assert.strictEqual(c.empate_volume, null);
});

// ── Cotação falhando: bloqueado, sem estimativa ──────────────────────────────

cenario("cotação falhando (ML 429): bloqueado com o motivo, SEM cair na taxa nem no frete atuais", async () => {
  const w = mundo({
    buscar: undefined,
    mlFetch: async (cId, caminho) => ({ ok: false, status: String(caminho).includes("listing_prices") ? 429 : 200, data: caminho.includes("shipping") ? { coverage: { all_country: { list_cost: 10 } } } : {} }),
  });
  // usa o buscarComissaoEFrete REAL com o ML falso
  w.deps.buscarComissaoEFrete = require("../services/shared/marketplaceCurrentQuoteService").buscarComissaoEFrete;
  const r = await rodar(w, pedido([{ tipo: "preco", preco: 80 }]));
  const c = r.cenarios[0];
  assert.strictEqual(c.veredito, "bloqueado");
  assert.strictEqual(c.motivo, "comissao_indisponivel");
  assert.strictEqual(c.evidencia.comissao.motivo, "ml_rate_limit");
  assert.strictEqual(c.cenario.comissao, null, "não estimou pela taxa atual (14%)");
  assert.strictEqual(c.cenario.lc, null);
  assert.strictEqual(c.delta_lc, null);
  assert.strictEqual(c.empate_volume, null);
  assert.ok(r.atual.lc !== null, "a composição de hoje segue visível");
});

cenario("frete indisponível (shipping 503): bloqueado frete_indisponivel — não reaproveita o frete atual", async () => {
  const w = mundo({
    mlFetch: async (cId, caminho) => (String(caminho).includes("listing_prices")
      ? { ok: true, status: 200, data: [{ sale_fee_amount: 11.2, sale_fee_details: { percentage_fee: 14 } }] }
      : { ok: false, status: 503, data: null }),
  });
  w.deps.buscarComissaoEFrete = require("../services/shared/marketplaceCurrentQuoteService").buscarComissaoEFrete;
  const r = await rodar(w, pedido([{ tipo: "preco", preco: 80 }]));
  const c = r.cenarios[0];
  assert.strictEqual(c.veredito, "bloqueado");
  assert.strictEqual(c.motivo, "frete_indisponivel");
  assert.strictEqual(c.evidencia.frete.motivo, "ml_indisponivel");
  assert.strictEqual(c.cenario.frete, null);
  assert.strictEqual(c.cenario.comissao, 11.2, "o que foi cotado fica; o que faltou não é estimado");
  assert.strictEqual(c.flags.mudou_faixa_frete, null);
});

cenario("buscarComissaoEFrete que LANÇA: bloqueado, nunca derruba a requisição", async () => {
  const w = mundo({ buscar: async () => { throw new Error("boom (token=APP_USR-1)"); } });
  const r = await rodar(w, pedido([{ tipo: "preco", preco: 80 }, { tipo: "preco", preco: 85 }]));
  assert.ok(r.cenarios.every((c) => c.veredito === "bloqueado" && c.motivo === "comissao_indisponivel"));
  assert.ok(!JSON.stringify(r).includes("APP_USR-1"));
});

cenario("anúncio sem listing_type/categoria no cadastro: bloqueado com o motivo, sem chamar o ML", async () => {
  const anuncios = new Map([["1:MLB100", { item_id: "MLB100", ml_user_id: "1001", listing_type_id: null, category_id: null, logistic_type: "xd_drop_off" }]]);
  const w = mundo({ anuncios });
  const r = await rodar(w, pedido([{ tipo: "preco", preco: 80 }]));
  assert.strictEqual(r.cenarios[0].veredito, "bloqueado");
  assert.strictEqual(r.cenarios[0].evidencia.comissao.motivo, "anuncio_sem_tipo_ou_categoria");
  assert.deepStrictEqual(w.cotacoes, []);
});

cenario("logística combinável (sem frete previsto): frete' é zero DECLARADO, não bloqueio", async () => {
  const anuncios = new Map([["1:MLB100", { item_id: "MLB100", ml_user_id: "1001", listing_type_id: "gold_special", category_id: "MLB1234", logistic_type: "custom" }]]);
  const linha = { ...LINHA_BASE, freight: null };
  const w = mundo({ anuncios, snapshots: new Map([["5:MLB100", linha]]) });
  const r = await rodar(w, pedido([{ tipo: "preco", preco: 80 }]));
  const c = r.cenarios[0];
  assert.notStrictEqual(c.veredito, "bloqueado");
  assert.strictEqual(c.cenario.frete, 0);
  assert.strictEqual(c.evidencia.frete.aplicavel, false);
  assert.strictEqual(c.evidencia.frete.fonte, "logistica_combinavel");
});

// ── Elegibilidade da promoção ────────────────────────────────────────────────

cenario("P' ≥ P: sem_desconto_efetivo, bloqueado e SEM gastar consulta ao ML", async () => {
  const w = mundo({ promocoes: [promoLinha("P4", { precoFinal: 99.9 }), promoLinha("P4b", { precoFinal: 94.9 })] });
  const r = await rodar(w, pedido([{ tipo: "todas_promos" }]));
  assert.strictEqual(r.cenarios.length, 2);
  for (const c of r.cenarios) {
    assert.strictEqual(c.flags.sem_desconto_efetivo, true);
    assert.strictEqual(c.veredito, "bloqueado");
    assert.strictEqual(c.motivo, "sem_desconto_efetivo");
  }
  assert.deepStrictEqual(w.cotacoes, []);
});

cenario("promoção que FORMA o preço de hoje (statusExibicao ATIVA): não bloqueia — cenário = hoje, Δ 0, sem gastar cotação", async () => {
  const w = mundo({ promocoes: [promoLinha("PA", { status: "started", statusExibicao: "ATIVA", precoFinal: 94.9, subsidioMl: 3.3 })] });
  const r = await rodar(w, pedido([{ tipo: "promo", promotion_id: "PA" }]));
  const c = r.cenarios[0];
  assert.strictEqual(c.flags.ativa, true);
  assert.strictEqual(c.veredito, "ativa");
  assert.strictEqual(c.motivo, null);
  assert.strictEqual(c.delta_lc, 0);
  assert.strictEqual(c.cenario.comissao, 13.29, "reusa a comissão de HOJE, não cotiza de novo");
  assert.strictEqual(c.cenario.frete, 10);
  assert.deepStrictEqual(w.cotacoes, []);
  assert.strictEqual(c.promocao.status, "started");
});

cenario("promoção inscrita mas NÃO APLICADA (status bruto started, não forma o preço): calcula normal — comissão, frete e LC preenchidos, veredito ≠ bloqueado", async () => {
  const w = mundo({ promocoes: [promoLinha("PNA", { status: "started", statusExibicao: "NÃO APLICADA" })] });
  const r = await rodar(w, pedido([{ tipo: "promo", promotion_id: "PNA" }]));
  const c = r.cenarios[0];
  assert.strictEqual(c.flags.ativa, false);
  assert.notStrictEqual(c.veredito, "bloqueado");
  assert.strictEqual(c.cenario.comissao, 12.57);
  assert.strictEqual(c.cenario.frete, 10);
  assert.ok(c.cenario.lc !== null);
  assert.deepStrictEqual(w.cotacoes, [89.77], "NÃO APLICADA cotiza em P', como qualquer outra promoção elegível");
});

cenario("promoção sem preço (ML não sugeriu): bloqueado promocao_sem_preco, sem cotar", async () => {
  const w = mundo({ promocoes: [promoLinha("P5", { precoFinal: null, subsidioMl: null })] });
  const r = await rodar(w, pedido([{ tipo: "promo", promotion_id: "P5" }]));
  assert.strictEqual(r.cenarios[0].motivo, "promocao_sem_preco");
  assert.deepStrictEqual(w.cotacoes, []);
});

cenario("retorno ML não informado: zero DECLARADO na evidência (não um zero escondido)", async () => {
  const w = mundo({ promocoes: [promoLinha("P6", { precoFinal: 85, subsidioMl: null })] });
  const r = await rodar(w, pedido([{ tipo: "promo", promotion_id: "P6" }]));
  const c = r.cenarios[0];
  assert.strictEqual(c.ml_banca, 0);
  assert.strictEqual(c.evidencia.rebate.informado, false);
  assert.strictEqual(c.evidencia.rebate.motivo, "ml_nao_informou_retorno");
});

cenario("sem Promo Snapshot: promo e todas_promos viram bloqueado sem_snapshot_promocoes", async () => {
  const w = mundo({ promoSnapshot: false });
  const r = await rodar(w, pedido([{ tipo: "promo", promotion_id: "P1" }, { tipo: "todas_promos" }, { tipo: "preco", preco: 85 }]));
  assert.strictEqual(r.cenarios.length, 3);
  assert.strictEqual(r.cenarios[0].veredito, "bloqueado");
  assert.strictEqual(r.cenarios[0].motivo, "sem_snapshot_promocoes");
  assert.strictEqual(r.cenarios[1].motivo, "sem_snapshot_promocoes");
  assert.notStrictEqual(r.cenarios[2].veredito, "bloqueado", "o cenário de preço independe do Promo Snapshot");
  assert.strictEqual(r.promocoes.disponivel, false);
  assert.strictEqual(r.promocoes.motivo, "sem_snapshot_promocoes");
  assert.strictEqual(w.promoLeituras, 0, "nem consulta as linhas");
});

cenario("promoção inexistente ou ambígua no snapshot: bloqueado com o motivo", async () => {
  const w = mundo({ promocoes: [promoLinha("PX"), promoLinha("PX-2", { promotionId: "PX" })] });
  const r = await rodar(w, pedido([{ tipo: "promo", promotion_id: "NAO-EXISTE" }, { tipo: "promo", promotion_id: "PX" }]));
  assert.strictEqual(r.cenarios[0].motivo, "promocao_nao_encontrada");
  assert.strictEqual(r.cenarios[1].motivo, "promocao_ambigua");
});

// ── Sem N+1 ──────────────────────────────────────────────────────────────────

cenario("30 promoções com 7 preços distintos: cotações ≤ preços distintos (cache por MLB+P')", async () => {
  const precos = [80, 81.5, 83, 84.25, 85, 86.9, 88];
  const promocoes = Array.from({ length: 30 }, (_, i) => promoLinha(`PM${i}`, { precoFinal: precos[i % 7], subsidioMl: i % 3 === 0 ? 2 : 0 }));
  const w = mundo({ promocoes });
  const r = await rodar(w, pedido([{ tipo: "todas_promos" }]));
  assert.strictEqual(r.cenarios.length, 30);
  assert.ok(w.cotacoes.length <= 7, `${w.cotacoes.length} cotações para 7 preços`);
  assert.strictEqual(w.cotacoes.length, 7);
  assert.strictEqual(r.cotacoes.precos_distintos, 7);
  assert.strictEqual(w.promoLeituras, 1, "as promoções vêm numa leitura só");
  assert.ok(r.cenarios.every((c) => c.veredito !== "bloqueado"));
  // mesmo P' pedido várias vezes no corpo = mesma cotação
  const w2 = mundo();
  await rodar(w2, pedido([{ tipo: "preco", preco: 80 }, { tipo: "preco", preco: 80 }, { tipo: "preco", preco: "80,00" }]));
  assert.deepStrictEqual(w2.cotacoes, [80]);
});

cenario("teto de cotações por requisição: o excedente é bloqueado (limite_de_cotacoes_excedido), nunca estimado", async () => {
  const promocoes = Array.from({ length: 45 }, (_, i) => promoLinha(`PL${i}`, { precoFinal: 50 + i }));
  const w = mundo({ promocoes });
  const r = await rodar(w, pedido([{ tipo: "todas_promos" }]));
  assert.strictEqual(w.cotacoes.length, service.MAX_COTACOES_POR_REQUISICAO);
  const limitados = r.cenarios.filter((c) => c.motivo === "limite_de_cotacoes_excedido");
  assert.strictEqual(limitados.length, 5);
  assert.ok(limitados.every((c) => c.cenario.comissao === null && c.cenario.lc === null));
  assert.strictEqual(r.cotacoes.limite_excedido, 5);
});

cenario("só leitura no ML: toda chamada é GET account-scoped (listing_prices + shipping_options/free)", async () => {
  const w = mundo({
    mlFetch: async (cId, caminho, opts) => {
      w.mlChamadas.push({ caminho, opts });
      return String(caminho).includes("listing_prices")
        ? { ok: true, status: 200, data: [{ sale_fee_amount: 11.5, sale_fee_details: { percentage_fee: 14 } }] }
        : { ok: true, status: 200, data: { coverage: { all_country: { list_cost: 9.5 } } } };
    },
  });
  w.deps.buscarComissaoEFrete = require("../services/shared/marketplaceCurrentQuoteService").buscarComissaoEFrete;
  const r = await rodar(w, pedido([{ tipo: "preco", preco: 82 }]));
  assert.strictEqual(r.cenarios[0].cenario.comissao, 11.5);
  assert.strictEqual(r.cenarios[0].cenario.frete, 9.5);
  assert.strictEqual(w.mlChamadas.length, 2);
  for (const ch of w.mlChamadas) {
    assert.ok(!ch.opts || !ch.opts.method || String(ch.opts.method).toUpperCase() === "GET", JSON.stringify(ch));
    assert.ok(/^\/sites\/MLB\/listing_prices\?|^\/users\/1001\/shipping_options\/free\?/.test(ch.caminho), ch.caminho);
    assert.strictEqual(ch.opts.mlUserId, "1001", "token da conta do escopo");
  }
});

// ── Escopo: usuário → cliente → conta → seller ───────────────────────────────

cenario("403: conta de cliente fora da carteira do usuário", async () => {
  const w = mundo();
  await recusa(rodar(w, pedido([{ tipo: "preco", preco: 80 }], { cliente_conta_id: 7 })), 403, "CLIENTE_FORA_DA_CARTEIRA");
  await recusa(rodar(w, pedido([{ tipo: "preco", preco: 80 }], { cliente_conta_id: 5 }), USER_B), 403, "CLIENTE_FORA_DA_CARTEIRA");
  assert.deepStrictEqual(w.cotacoes, []);
});

cenario("403: MLB de OUTRO seller do mesmo cliente (outra conta)", async () => {
  const w = mundo();
  // MLB300 é do seller 1002 (conta 6); pedido pela conta 5 (seller 1001)
  await recusa(rodar(w, pedido([{ tipo: "preco", preco: 80 }], { mlb: "MLB300" })), 403, "MLB_FORA_DA_CONTA");
  // MLB200 tem snapshot na conta 6, não na 5: mesmo bloqueio pelo cadastro do anúncio
  await recusa(rodar(w, pedido([{ tipo: "preco", preco: 80 }], { mlb: "MLB200" })), 403, "MLB_FORA_DA_CONTA");
  assert.deepStrictEqual(w.cotacoes, []);
});

cenario("404/422: conta inexistente, MLB desconhecido, conta de outro marketplace ou sem grant", async () => {
  const w = mundo();
  await recusa(rodar(w, pedido([{ tipo: "preco", preco: 80 }], { cliente_conta_id: 999 })), 404);
  await recusa(rodar(w, pedido([{ tipo: "preco", preco: 80 }], { mlb: "MLB9999" })), 404, "MLB_NAO_ENCONTRADO");
  await recusa(rodar(w, pedido([{ tipo: "preco", preco: 80 }], { cliente_conta_id: 8 })), 422, "MARKETPLACE_INCOMPATIVEL");
  await recusa(rodar(w, pedido([{ tipo: "preco", preco: 80 }], { cliente_conta_id: 9 })), 422, "CONTA_SEM_GRANT_ML");
});

cenario("validação do corpo: 400 explícito, nada ignorado em silêncio", async () => {
  const w = mundo();
  const ok = [{ tipo: "preco", preco: 80 }];
  await recusa(rodar(w, { mlb: "MLB100", cenarios: ok }), 400, "CLIENTE_CONTA_ID_OBRIGATORIO");
  await recusa(rodar(w, pedido(ok, { cliente_conta_id: "abc" })), 400, "CLIENTE_CONTA_ID_INVALIDO");
  await recusa(rodar(w, pedido(ok, { mlb: "XYZ" })), 400, "MLB_INVALIDO");
  await recusa(rodar(w, pedido([])), 400, "CENARIOS_OBRIGATORIOS");
  await recusa(rodar(w, pedido(undefined)), 400, "CENARIOS_OBRIGATORIOS");
  await recusa(rodar(w, pedido(Array.from({ length: 21 }, () => ({ tipo: "preco", preco: 80 })))), 400, "CENARIOS_DEMAIS");
  await recusa(rodar(w, pedido([{ tipo: "magia" }])), 400, "CENARIO_TIPO_INVALIDO");
  await recusa(rodar(w, pedido([{ tipo: "preco", preco: 0 }])), 400, "PRECO_INVALIDO");
  await recusa(rodar(w, pedido([{ tipo: "preco", preco: -5 }])), 400, "PRECO_INVALIDO");
  await recusa(rodar(w, pedido([{ tipo: "preco" }])), 400, "PRECO_AUSENTE");
  await recusa(rodar(w, pedido([{ tipo: "preco", preco: "114,999" }])), 400, "PRECO_CASAS_DECIMAIS");
  await recusa(rodar(w, pedido([{ tipo: "promo" }])), 400, "PROMOTION_ID_OBRIGATORIO");
  await recusa(rodar(w, pedido([{ tipo: "insumos", insumos: { magia: 1 } }])), 400, "INSUMOS_CAMPO_DESCONHECIDO");
  await recusa(rodar(w, pedido([{ tipo: "insumos", insumos: { custo: "abc" } }])), 400, "INSUMOS_VALOR_INVALIDO");
  // exatamente 20 passa
  const r = await rodar(w, pedido(Array.from({ length: 20 }, (_, i) => ({ tipo: "preco", preco: 70 + i }))));
  assert.strictEqual(r.cenarios.length, 20);
  assert.strictEqual(w.cotacoes.length, 20);
});

// ── Composição de hoje ───────────────────────────────────────────────────────

cenario("tabela = Composição: a margem atual do /simular é a MESMA do item da tabela, também com retorno ML em andamento", async () => {
  // Item em promoção ativa (preço 89,77, retorno 3,30), como a tabela o mostra.
  const sem = core.computeMargin({ price: 89.77, cost: 21.35, taxRate: 0.06, fixedFee: 0, commission: 12.57, freight: 10 });
  const linha = { ...LINHA_BASE, price: 89.77, commission: 12.57, profit: sem.profit, margin: sem.margin };
  const info = { promocoes: 1, rebate: 3.3 };
  const w = mundo({
    snapshots: new Map([["5:MLB100", linha]]),
    rebates: { porItem: new Map([["MLB100", info]]), indisponivel: null },
    promocoes: [promoLinha("PA", { status: "started", precoFinal: 89.77 })],
  });
  const r = await rodar(w, pedido([{ tipo: "preco", preco: 84.9 }]));
  const item = read.comporItem(linha, { porMlb: new Map(), reembolsoPorMlb: new Map(), fallbackObservedAt: null }, {}, info);
  assert.strictEqual(r.atual.margem_ratio, item.projected.margin, "margem: tabela = Composição");
  assert.strictEqual(r.atual.lc, item.projected.profit, "LC: tabela = Composição");
  assert.strictEqual(r.atual.rebate, 3.3);
  assert.notStrictEqual(r.atual.margem_ratio, sem.margin, "o retorno ML entra, como na tabela");
  assert.strictEqual(r.atual.evidencia.rebate.fonte, "promo_snapshot");
  assert.strictEqual(r.atual.evidencia.rebate.snapshot_em, "2026-10-14T03:00:00.000Z");
  // sem promoção em andamento: igual ao persistido
  const w2 = mundo();
  const r2 = await rodar(w2, pedido([{ tipo: "preco", preco: 84.9 }]));
  const item2 = read.comporItem(LINHA_BASE, { porMlb: new Map(), reembolsoPorMlb: new Map(), fallbackObservedAt: null }, {}, undefined);
  assert.strictEqual(r2.atual.margem_ratio, item2.projected.margin);
  assert.strictEqual(r2.atual.lc, item2.projected.profit);
});

cenario("rebate ambíguo (2+ promoções em andamento): flag e bloqueado — não adivinha qual fixa o preço", async () => {
  const w = mundo({ rebates: { porItem: new Map([["MLB100", { promocoes: 2, rebate: null }]]), indisponivel: null } });
  const r = await rodar(w, pedido([{ tipo: "promo", promotion_id: "P1" }]));
  const c = r.cenarios[0];
  assert.strictEqual(c.flags.rebate_ambiguo, true);
  assert.strictEqual(c.veredito, "bloqueado");
  assert.strictEqual(c.motivo, "rebate_ambiguo");
  assert.strictEqual(r.atual.rebate_motivo, "REBATE_AMBIGUO");
});

cenario("Promo Snapshot ilegível para o retorno atual: bloqueado rebate_atual_indisponivel", async () => {
  const w = mundo({ rebates: { porItem: new Map(), indisponivel: "PROMO_SNAPSHOT_INDISPONIVEL" } });
  const r = await rodar(w, pedido([{ tipo: "preco", preco: 85 }]));
  assert.strictEqual(r.cenarios[0].veredito, "bloqueado");
  assert.strictEqual(r.cenarios[0].motivo, "rebate_atual_indisponivel");
});

cenario("anúncio sem Margin Snapshot: todo cenário bloqueado sem_snapshot_margem, sem consulta ao ML", async () => {
  const w = mundo({ snapshots: new Map() });
  const r = await rodar(w, pedido([{ tipo: "preco", preco: 85 }, { tipo: "promo", promotion_id: "P1" }]));
  assert.ok(r.cenarios.every((c) => c.veredito === "bloqueado" && c.motivo === "sem_snapshot_margem"));
  assert.deepStrictEqual(w.cotacoes, []);
  assert.strictEqual(r.atual.lc, null);
  assert.deepStrictEqual(r.atual.bloqueios, ["sem_snapshot_margem"]);
});

cenario("alíquota fora da faixa no snapshot: bloqueado aliquota_fora_da_faixa (sem conversão)", async () => {
  const w = mundo({ snapshots: new Map([["5:MLB100", { ...LINHA_BASE, taxRate: 15 }]]) });
  const r = await rodar(w, pedido([{ tipo: "preco", preco: 85 }]));
  assert.strictEqual(r.cenarios[0].motivo, "aliquota_fora_da_faixa");
  assert.strictEqual(r.cenarios[0].cenario.lc, null);
});

cenario("meta: a do snapshot; ausente = padrão do Motor, DITO como padrão", async () => {
  const r1 = await rodar(mundo(), pedido([{ tipo: "preco", preco: 85 }]));
  assert.deepStrictEqual([r1.meta.margem_alvo, r1.meta.fonte], [0.1, "margin_snapshot"]);
  const r2 = await rodar(mundo({ snapshots: new Map([["5:MLB100", { ...LINHA_BASE, quality: {} }]]) }), pedido([{ tipo: "preco", preco: 85 }]));
  assert.deepStrictEqual([r2.meta.margem_alvo, r2.meta.fonte, r2.meta.motivo], [0.1, "padrao_do_motor", "meta_nao_informada"]);
  const r3 = await rodar(mundo({ snapshots: new Map([["5:MLB100", { ...LINHA_BASE, quality: { targetMargin: 12 } }]]) }), pedido([{ tipo: "preco", preco: 85 }]));
  assert.deepStrictEqual([r3.meta.margem_alvo, r3.meta.motivo], [0.1, "meta_fora_da_faixa"]);
});

cenario("evidência: cada número vem com fonte e data", async () => {
  const r = await rodar(mundo(), pedido([{ tipo: "promo", promotion_id: "P1" }]));
  assert.strictEqual(r.gerado_em, "2026-10-14T12:00:00.000Z");
  assert.strictEqual(r.atual.evidencia.preco.fonte, "margin_snapshot");
  assert.strictEqual(r.atual.evidencia.preco.calculado_em, "2026-10-13T06:00:00.000Z");
  assert.strictEqual(r.atual.evidencia.comissao.fonte, "margin_snapshot");
  assert.strictEqual(r.atual.evidencia.custo.fonte, "margin_snapshot");
  const ev = r.cenarios[0].evidencia;
  assert.strictEqual(ev.preco.fonte, "promo_snapshot");
  assert.strictEqual(ev.preco.observado_em, "2026-10-14T03:00:00.000Z");
  assert.strictEqual(ev.comissao.fonte, "ml_listing_prices");
  assert.strictEqual(ev.comissao.consultado_em, "2026-10-14T12:00:00.000Z");
  assert.strictEqual(ev.frete.fonte, "ml_shipping_options_free");
  assert.strictEqual(ev.rebate.fonte, "promo_snapshot");
  assert.strictEqual(r.promocoes.snapshot_em, "2026-10-14T03:00:00.000Z");
  assert.strictEqual(r.promocoes.run_id, 31);
});

cenario("margens e alíquota na resposta são frações 0–1; a promoção sai com o status bruto", async () => {
  const r = await rodar(mundo(), pedido([{ tipo: "promo", promotion_id: "P1" }]));
  assert.ok(r.atual.margem_ratio < 1 && r.cenarios[0].cenario.margem_ratio < 1);
  assert.strictEqual(r.meta.margem_alvo, 0.1);
  assert.strictEqual(r.cenarios[0].promocao.status, "candidate");
  assert.ok(!("margem_percent" in r.atual));
});

// ── Preço-alvo ("Subir p/ R$ X"): busca com a cotação real ───────────────────

function linhaPrejuizo(extra = {}) {
  const m = core.computeMargin({ price: 94.9, cost: 80, taxRate: 0.06, fixedFee: 0, commission: 13.29, freight: 10 });
  return { ...LINHA_BASE, cost: 80, profit: m.profit, margin: m.margin, status: "LOSS", ...extra };
}

cenario("preco_alvo: o menor preço que atinge a meta, com a cotação REAL; a conta do passo é a do computeTargetPrice", async () => {
  const w = mundo({ snapshots: new Map([["5:MLB100", linhaPrejuizo()]]) });
  const r = await rodar(w, pedido([{ tipo: "preco_alvo" }]));
  const c = r.cenarios[0];
  assert.strictEqual(c.tipo, "preco_alvo");
  assert.strictEqual(c.preco_alvo.encontrado, true);
  // (custo 80 + frete 10) / (1 − 0,06 − 0,14 − 0,10) = 128,5714… → 128,58
  assert.strictEqual(c.preco_alvo.preco, 128.58);
  assert.strictEqual(c.preco_alvo.margem_alvo, 0.1);
  assert.ok(c.cenario.margem_ratio >= 0.1, `margem' ${c.cenario.margem_ratio}`);
  assert.strictEqual(c.cenario.preco, 128.58);
  assert.strictEqual(c.cenario.comissao, 18);
  assert.strictEqual(c.cenario.frete, 10);
  assert.ok(c.delta_lc > 0);
  assert.strictEqual(c.evidencia.preco.fonte, "busca_preco_alvo");
  assert.strictEqual(c.evidencia.comissao.fonte, "ml_listing_prices");
  // cada preço tentado foi UMA cotação real
  assert.deepStrictEqual(w.cotacoes, c.preco_alvo.precos_tentados);
  assert.ok(!("atual" in c));
  // 1 centavo abaixo não atinge a meta: o preço devolvido é o mínimo (a 1 centavo de resolução)
  const abaixo = core.computeMargin({ price: 128.57, cost: 80, taxRate: 0.06, fixedFee: 0, commission: cotacaoFalsa(128.57).comissaoValor, freight: 10 });
  assert.ok(abaixo.margin < 0.1, `a 128,57 a margem seria ${abaixo.margin}`);
});

cenario("preco_alvo: a faixa de frete entra na busca — subir o preço cruza o limiar e o frete cotado muda o preço-alvo", async () => {
  // Hoje a R$ 70 (frete 0, abaixo de R$ 79) com custo 60: prejuízo. Com o frete de hoje o alvo seria 60/0,70 = 85,71 …
  const m = core.computeMargin({ price: 70, cost: 60, taxRate: 0.06, fixedFee: 0, commission: 9.8, freight: 0 });
  const w = mundo({ snapshots: new Map([["5:MLB100", linhaPrejuizo({ price: 70, cost: 60, commission: 9.8, freight: 0, profit: m.profit, margin: m.margin })]]) });
  const r = await rodar(w, pedido([{ tipo: "preco_alvo" }]));
  const c = r.cenarios[0];
  assert.ok(m.margin < 0, "premissa: prejuízo hoje");
  // … mas a R$ 85,71 o frete passa a ser R$ 10: o alvo real é (60+10)/0,70 = 100,00.
  assert.strictEqual(c.preco_alvo.encontrado, true);
  assert.strictEqual(c.preco_alvo.preco, 100);
  assert.strictEqual(c.cenario.frete, 10);
  assert.strictEqual(c.flags.mudou_faixa_frete, true);
  assert.deepStrictEqual(c.preco_alvo.precos_tentados, [85.71, 100]);
  assert.deepStrictEqual(w.cotacoes, [85.71, 100], "uma cotação real por preço tentado");
  assert.ok(c.cenario.margem_ratio >= 0.1);
});

cenario("preco_alvo: meta inviável (imposto + comissão + meta ≥ 100%) ou custo ausente → sem_preco_viavel, sem estimar", async () => {
  const w = mundo({ snapshots: new Map([["5:MLB100", linhaPrejuizo({ quality: { targetMargin: 0.9 } })]]) });
  const r = await rodar(w, pedido([{ tipo: "preco_alvo" }]));
  assert.strictEqual(r.cenarios[0].veredito, "bloqueado");
  assert.strictEqual(r.cenarios[0].motivo, "sem_preco_viavel");
  assert.strictEqual(r.cenarios[0].preco_alvo.encontrado, false);
  assert.strictEqual(r.cenarios[0].preco_alvo.preco, null);
  assert.strictEqual(r.cenarios[0].preco_alvo.causa, "meta_inviavel");
  assert.deepStrictEqual(w.cotacoes, [], "nem chega a cotar");
  const semCusto = mundo({ snapshots: new Map([["5:MLB100", linhaPrejuizo({ cost: null })]]) });
  const r2 = await rodar(semCusto, pedido([{ tipo: "preco_alvo" }]));
  assert.strictEqual(r2.cenarios[0].motivo, "custo_ausente");
  assert.strictEqual(r2.cenarios[0].preco_alvo.encontrado, false);
});

cenario("preco_alvo: cotação falhando → bloqueado com o motivo da cotação (não devolve preço)", async () => {
  const w = mundo({ snapshots: new Map([["5:MLB100", linhaPrejuizo()]]), buscar: async () => ({ comissaoValor: null, fretePrevisto: null }) });
  const r = await rodar(w, pedido([{ tipo: "preco_alvo" }]));
  const c = r.cenarios[0];
  assert.strictEqual(c.veredito, "bloqueado");
  assert.strictEqual(c.motivo, "comissao_indisponivel");
  assert.strictEqual(c.preco_alvo.encontrado, false);
  assert.strictEqual(c.preco_alvo.preco, null);
  assert.strictEqual(c.evidencia.comissao.motivo, "ml_indisponivel");
});

cenario("preco_alvo: cotação que torna a meta inalcançável (comissão cotada 95%) → sem_preco_viavel, dentro do teto de cotações", async () => {
  const w = mundo({
    snapshots: new Map([["5:MLB100", linhaPrejuizo()]]),
    buscar: async (args) => { w.cotacoes.push(args.precoEfetivo); return { comissaoValor: Math.round(args.precoEfetivo * 0.95 * 100) / 100, fretePrevisto: 10 }; },
  });
  const r = await rodar(w, pedido([{ tipo: "preco_alvo" }]));
  const c = r.cenarios[0];
  assert.strictEqual(c.motivo, "sem_preco_viavel");
  assert.strictEqual(c.preco_alvo.encontrado, false);
  assert.strictEqual(c.preco_alvo.preco, null);
  assert.strictEqual(c.preco_alvo.causa, "meta_inviavel");
  assert.ok(w.cotacoes.length >= 1 && w.cotacoes.length <= service.MAX_ITERACOES_PRECO_ALVO, `${w.cotacoes.length} cotações`);
});

cenario("preco_alvo: margem_alvo do pedido substitui a meta (validada em 0–1); coexiste com outros cenários no teto de cotações", async () => {
  const w = mundo({ snapshots: new Map([["5:MLB100", linhaPrejuizo()]]) });
  const r = await rodar(w, pedido([{ tipo: "preco_alvo", margem_alvo: 0.2 }, { tipo: "preco", preco: 100 }]));
  assert.strictEqual(r.cenarios[0].preco_alvo.margem_alvo, 0.2);
  assert.strictEqual(r.cenarios[0].preco_alvo.preco, 150, "(80+10)/(1−0,06−0,14−0,20) = 150");
  assert.ok(r.cenarios[0].cenario.margem_ratio >= 0.2);
  assert.strictEqual(r.cenarios[1].tipo, "preco");
  await recusa(rodar(w, pedido([{ tipo: "preco_alvo", margem_alvo: 20 }])), 400, "MARGEM_ALVO_INVALIDA");
  await recusa(rodar(w, pedido([{ tipo: "preco_alvo", margem_alvo: 0 }])), 400, "MARGEM_ALVO_INVALIDA");
});

// ── Insumos hipotéticos (simulação avançada) e composição em lote ───────────

cenario("cenário `insumos`: hipótese do operador, sem recotar nem tocar no ML", async () => {
  const w = mundo();
  const r = await rodar(w, pedido([{ tipo: "insumos", insumos: { custo: 25.35 } }]));
  const c = r.cenarios[0];
  assert.strictEqual(c.delta_lc, -4);
  assert.strictEqual(c.cenario.custo, 25.35);
  assert.strictEqual(c.evidencia.hipotese, true);
  assert.deepStrictEqual(w.cotacoes, []);
  assert.notStrictEqual(c.veredito, "bloqueado");
  const r2 = await rodar(w, pedido([{ tipo: "insumos", insumos: { aliquota: 15 } }]));
  assert.strictEqual(r2.cenarios[0].motivo, "aliquota_fora_da_faixa");
});

cenario("composicao em lote: mesma conta do núcleo, carteira respeitada, teto de itens", async () => {
  const w = mundo();
  const body = {
    cliente_conta_id: 5,
    itens: [
      { id: "a", insumos: { preco: 94.9, custo: 21.35, aliquota: 0.06, taxa_fixa: 0, comissao: 13.29, frete: 10 } },
      { id: "b", insumos: { preco: 94.9, aliquota: 0.06 } },
    ],
  };
  const r = await service.calcularComposicoes({ user: USER_A, body }, w.deps);
  const esperado = core.computeMargin({ price: 94.9, cost: 21.35, taxRate: 0.06, fixedFee: 0, commission: 13.29, freight: 10 });
  assert.strictEqual(r.itens[0].lc, esperado.profit);
  assert.strictEqual(r.itens[0].margem_ratio, esperado.margin);
  assert.strictEqual(r.itens[1].computavel, false);
  assert.strictEqual(r.itens[1].margem_ratio, null);
  assert.deepStrictEqual(r.itens[1].faltando, ["cost"]);
  // Δ contra a base e contra a meta: o núcleo calcula, em lote.
  const base = { preco: 100, custo: 40, aliquota: 0.06, taxa_fixa: 0, comissao: 16.5, frete: 23.4 };
  const comDelta = await service.calcularComposicoes({
    user: USER_A,
    body: { cliente_conta_id: 5, itens: [{ id: "0", insumos: { ...base, frete: 18.7 }, base_insumos: base, meta_margem: 0.12 }, { id: "1", insumos: base }] },
  }, w.deps);
  assert.deepStrictEqual([comDelta.itens[0].delta_lc, comDelta.itens[0].delta_margem_pp, comDelta.itens[0].delta_meta_pp], [4.7, 4.7, 6.8]);
  assert.deepStrictEqual([comDelta.itens[1].delta_lc, comDelta.itens[1].delta_margem_pp, comDelta.itens[1].delta_meta_pp], [null, null, null]);
  await recusa(service.calcularComposicoes({ user: USER_A, body: { cliente_conta_id: 5, itens: [{ id: "0", insumos: base, meta_margem: "x" }] } }, w.deps), 400, "META_MARGEM_INVALIDA");
  await recusa(service.calcularComposicoes({ user: USER_A, body: { cliente_conta_id: 5, itens: [{ id: "0", insumos: base, base_insumos: { magia: 1 } }] } }, w.deps), 400, "INSUMOS_CAMPO_DESCONHECIDO");
  await recusa(service.calcularComposicoes({ user: USER_B, body }, w.deps), 403);
  await recusa(service.calcularComposicoes({ user: USER_A, body: { cliente_conta_id: 5, itens: [] } }, w.deps), 400, "ITENS_OBRIGATORIOS");
  await recusa(service.calcularComposicoes({ user: USER_A, body: { cliente_conta_id: 5, itens: Array.from({ length: 201 }, (_, i) => ({ id: String(i), insumos: {} })) } }, w.deps), 400, "ITENS_DEMAIS");
  assert.deepStrictEqual(w.cotacoes, [], "composição não consulta o ML");
});

// ── Cotador isolado ──────────────────────────────────────────────────────────

cenario("cotador: cache por (MLB, P') — preços iguais em formatos diferentes são UMA consulta", async () => {
  const chamadas = [];
  const cotador = criarCotadorEmP({
    clienteId: 1, itemId: "MLB100", anuncio: { listing_type_id: "gold_special", category_id: "MLB1", logistic_type: "xd_drop_off" },
    sellerId: "1001", mlUserId: "1001", mlFetch: async () => ({ ok: true, status: 200, data: {} }),
    buscarComissaoEFrete: async (args) => { chamadas.push(args.precoEfetivo); return { comissaoValor: 10, fretePrevisto: 5 }; },
  });
  await Promise.all([cotador.cotar(80), cotador.cotar(80.0), cotador.cotar("80.00"), cotador.cotar(81)]);
  assert.deepStrictEqual(chamadas, [80, 81]);
  assert.strictEqual(cotador.estatisticas().precos_distintos, 2);
});

// ── Controller e rota ────────────────────────────────────────────────────────

function resFalsa() {
  const res = { statusCode: null, body: null };
  res.status = (s) => { res.statusCode = s; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

cenario("controller: 200 com o payload; erros do service viram o status e o payload (403/400/404)", async () => {
  const w = mundo();
  const ctrl = createMargemSimularController({ service });
  // O service real do controller usa deps default — troca por um service com os fakes.
  const ctrlFake = createMargemSimularController({
    service: {
      simular: (args) => service.simular(args, w.deps),
      calcularComposicoes: (args) => service.calcularComposicoes(args, w.deps),
    },
  });
  assert.ok(ctrl.simular && ctrl.composicao);
  const ok = resFalsa();
  await ctrlFake.simular({ user: USER_A, body: pedido([{ tipo: "preco", preco: 85 }]) }, ok);
  assert.strictEqual(ok.statusCode, 200);
  assert.strictEqual(ok.body.ok, true);
  const proibido = resFalsa();
  await ctrlFake.simular({ user: USER_A, body: pedido([{ tipo: "preco", preco: 85 }], { cliente_conta_id: 7 }) }, proibido);
  assert.strictEqual(proibido.statusCode, 403);
  assert.strictEqual(proibido.body.ok, false);
  const ruim = resFalsa();
  await ctrlFake.simular({ user: USER_A, body: pedido([]) }, ruim);
  assert.strictEqual(ruim.statusCode, 400);
  assert.strictEqual(ruim.body.codigo, "CENARIOS_OBRIGATORIOS");
  const nao = resFalsa();
  await ctrlFake.composicao({ user: USER_A, body: { cliente_conta_id: 999, itens: [{ id: "a", insumos: {} }] } }, nao);
  assert.strictEqual(nao.statusCode, 404);
  const interno = resFalsa();
  const logs = [];
  const errOriginal = console.error;
  console.error = (...a) => logs.push(a.join(" "));
  try {
    await createMargemSimularController({ service: { simular: async () => { throw new Error("segredo access_token=APP_USR-77"); } } }).simular({ user: USER_A, body: {} }, interno);
  } finally {
    console.error = errOriginal;
  }
  assert.strictEqual(interno.statusCode, 500);
  assert.ok(!JSON.stringify(interno.body).includes("APP_USR-77"));
  assert.ok(logs.length === 1 && !logs[0].includes("APP_USR-77"), "o log também sai redigido");
});

cenario("rota: POST /simular e /composicao atrás de JWT + acesso de automações (e nada de GET/PUT/DELETE)", () => {
  const router = require("../routes/margemSimularRoutes");
  const { authMiddleware } = require("../middlewares/authMiddleware");
  const { requireAutomacoesAccess } = require("../middlewares/accessMiddleware");
  const rotas = router.stack.filter((l) => l.route).map((l) => ({ path: l.route.path, metodos: Object.keys(l.route.methods), handlers: l.route.stack.map((s) => s.handle) }));
  assert.deepStrictEqual(rotas.map((r) => r.path).sort(), ["/composicao", "/simular"]);
  for (const r of rotas) {
    assert.deepStrictEqual(r.metodos, ["post"]);
    assert.strictEqual(r.handlers[0], authMiddleware);
    assert.strictEqual(r.handlers[1], requireAutomacoesAccess);
  }
});

(async () => {
  let falhas = 0;
  for (const { nome, fn } of casos) {
    try {
      await fn();
      console.log(`  ✓ ${nome}`);
    } catch (err) {
      falhas += 1;
      console.log(`  ✗ ${nome}\n    ${err.message}\n    ${(err.stack.split("\n").find((l) => l.includes(".test.js")) || "").trim()}`);
    }
  }
  if (falhas) {
    console.log(`margemSimular: ${falhas} de ${casos.length} cenários falharam`);
    process.exit(1);
  }
  console.log(`margemSimular: ok (${casos.length} cenários)`);
  process.exit(0);
})();
