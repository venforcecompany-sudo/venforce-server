// server/tests/inicioServiceComposicao.test.js
//
// GET /operacao/inicio/:cliente — tela de Início (substitui a Visão).
// Testa a composição com injeção de dependência, sem SQL: períodos, totais
// com comparação, série diária, ranking por produto, catálogo, reputação,
// Ads/configuração preservados e isolamento de falha entre blocos.

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/vf-test";

const assert = require("assert");
const { obterInicio, resolverPeriodoInicio, lerReputacaoMl } = require("../services/inicioService");

let checks = 0;
function ok(label, condition) {
  assert.ok(condition, `FALHOU: ${label}`);
  checks += 1;
  console.log(`  ok  ${label}`);
}
async function rejeitaCom(label, promise, verificar) {
  let erro = null;
  try { await promise; } catch (e) { erro = e; }
  assert.ok(erro, `FALHOU (não rejeitou): ${label}`);
  if (verificar) assert.ok(verificar(erro), `FALHOU (erro inesperado): ${label} — ${erro.message}`);
  checks += 1;
  console.log(`  ok  ${label}`);
}

const cliente = { id: 1, nome: "N97 Comercial", slug: "n97", ativo: true };
const contaMeli = { id: 10, cliente_id: 1, marketplace: "meli", nome: "ML 1", ativo: true, externalAccountLabel: "N97LOJA" };
const contaShopee = { id: 11, cliente_id: 1, marketplace: "shopee", nome: "Shopee", ativo: true };

// 11/11/2026 15h em São Paulo (18h UTC).
const AGORA = new Date("2026-11-11T18:00:00Z");

function item(mlb, receita, resultado, quantidade = 1) {
  return { itemId: `${mlb}-i`, mlb, titulo: `Produto ${mlb}`, quantidade, receitaProduto: receita, resultado, confianca: resultado === null ? "bloqueado" : "confiavel" };
}
function pedido(data, valor, resultado, itens, status = "pago") {
  return { data, valor, resultado, status, unidades: itens.reduce((s, i) => s + i.quantidade, 0), itens, componentes: [], mlb: itens[0]?.mlb, custoStatus: resultado === null ? "ausente" : "real", frete: 10, confianca: resultado === null ? "bloqueado" : "confiavel" };
}

const PEDIDOS = [
  // período atual (7d = 05/11..11/11)
  pedido("2026-11-11", 100, 20, [item("MLB1", 100, 20)]),
  pedido("2026-11-10", 200, -30, [item("MLB2", 200, -30)]),
  pedido("2026-11-05", 300, null, [item("MLB3", 300, null)]),
  pedido("2026-11-06", 50, 5, [item("MLB1", 50, 5)], "cancelado"),
  // período anterior (29/10..04/11)
  pedido("2026-11-01", 400, 40, [item("MLB1", 400, 40)]),
  // só na janela do MercadoLíder (desde 01/08)
  pedido("2026-08-15", 1000, 100, [item("MLB1", 1000, 100)]),
];

function depsBase(overrides = {}) {
  return {
    agora: () => AGORA,
    resolverClientePorIdOuSlug: async () => cliente,
    obterConta: async (id) => [contaMeli, contaShopee].find((c) => c.id === Number(id)),
    sanitizarConta: (row) => row,
    carregarPedidos: async () => ({ sincronizado: true, atualizadoEm: "2026-11-11T12:00:00Z", pedidos: PEDIDOS }),
    obterResumoMargem: async () => ({
      margemAlvo: 0.15,
      placar: { porStatus: { HEALTHY: 6, LOW_MARGIN: 2, LOSS: 1, SUSPECT_DATA: 1, UNVALIDATED: 3 } },
      excecoes: [{ status: "LOSS", margemRealizadaPercent: -12.5 }, { status: "LOW_MARGIN", margemRealizadaPercent: 4 }],
      cobertura: { itensAnalisados: 13, totalItensMl: 13, parcial: false },
    }),
    buscarPerformanceML: async (...args) => ({ args, roas: 4, acos: 25, gmvAds: 1000, investimentoAds: 250 }),
    getCliente360: async () => ({ setup: { temGrant: true, temBase: true }, sync: { status: "ok" }, outros: "x" }),
    resolveMarketplaceAccountContext: async () => ({ cliente: { id: 1 }, mlUserId: "555" }),
    mlFetch: async (_id, path) => ({
      ok: true, status: 200, path,
      data: {
        registration_date: "2020-01-01T00:00:00.000-04:00",
        seller_reputation: {
          level_id: "5_green", power_seller_status: "gold",
          metrics: { sales: { period: "60 days", completed: 800 }, claims: { rate: 0.0031, value: 2 }, cancellations: { rate: 0, value: 0 }, delayed_handling_time: { rate: 0.012, value: 9 } },
        },
      },
    }),
    ...overrides,
  };
}

async function run() {
  console.log("períodos");
  const p30 = resolverPeriodoInicio(undefined, AGORA);
  ok("padrão é 30 dias", p30.id === "30d" && p30.atual.de === "2026-10-13" && p30.atual.ate === "2026-11-11");
  ok("anterior de 30d são os 30 dias antes", p30.anterior.de === "2026-09-13" && p30.anterior.ate === "2026-10-12");
  const ph = resolverPeriodoInicio("hoje", AGORA);
  ok("hoje compara com ontem", ph.atual.de === "2026-11-11" && ph.anterior.de === "2026-11-10" && ph.anterior.ate === "2026-11-10");
  ok("janela do MercadoLíder: 1º do mês, 3 meses antes", p30.lider.de === "2026-08-01");
  ok("data em São Paulo, não UTC", resolverPeriodoInicio("hoje", new Date("2026-11-12T01:00:00Z")).hoje === "2026-11-11");
  await rejeitaCom("período inválido dá 400", obterInicio({ clienteSlugRaw: "n97", clienteContaIdRaw: "10", periodoRaw: "lixo" }, depsBase()), (e) => e.statusCode === 400);
  await rejeitaCom("conta é obrigatória", obterInicio({ clienteSlugRaw: "n97", periodoRaw: "7d" }, depsBase()), (e) => e.statusCode === 400);

  console.log("composição (7 dias)");
  let cargaPedida = null;
  const r = await obterInicio(
    { clienteSlugRaw: "n97", clienteContaIdRaw: "10", periodoRaw: "7d" },
    depsBase({ carregarPedidos: async (a) => { cargaPedida = a.intervalo; return depsBase().carregarPedidos(); } })
  );
  ok("uma carga cobre anterior + janela do MercadoLíder", cargaPedida.de === "2026-08-01" && cargaPedida.ate === "2026-11-11");
  const v = r.vendas.dados;
  ok("faturamento só das válidas do período", v.totais.faturamento === 600 && v.totais.vendas === 3);
  ok("lucro só das calculadas", v.totais.lucro === -10 && v.totais.vendasCalculadas === 2 && v.totais.incompletas === 1);
  ok("margem sobre o faturamento calculado", v.totais.margemPct === round2(-10 / 300 * 100));
  ok("cancelada conta à parte", v.totais.canceladas === 1);
  ok("período anterior para comparação", v.anterior && v.anterior.faturamento === 400 && v.anterior.lucro === 40);
  ok("série tem os 7 dias, com zeros", v.serie.length === 7 && v.serie[0].dia === "2026-11-05" && v.serie[2].faturamento === 0);
  ok("série soma lucro do dia", v.serie[6].lucro === 20 && v.serie[5].lucro === -30);
  ok("ranking: lucraram", v.lucraram.length === 1 && v.lucraram[0].mlb === "MLB1" && v.lucraram[0].lucro === 20);
  ok("ranking: perdem", v.perdem.length === 1 && v.perdem[0].mlb === "MLB2" && v.perdem[0].margemPct === -15);
  ok("produto sem resultado fica fora do ranking", ![...v.lucraram, ...v.perdem].some((p) => p.mlb === "MLB3"));
  ok("MercadoLíder conta vendas e faturamento da janela", v.lider.vendas === 5 && v.lider.faturamento === 2000);

  const c = r.catalogo.dados;
  ok("catálogo nos status da tela", c.porStatus.saudavel === 6 && c.porStatus.prejuizo === 1 && c.porStatus.nao_validado === 3 && c.total === 13);
  ok("margem alvo em %", c.margemAlvoPct === 15);
  ok("pior margem dos prejuízos", c.piorMargemPct === -12.5);

  const rep = r.reputacao.dados;
  ok("reputação lida de /users/{id}", rep.nivel === "5_green" && rep.mercadoLider === "gold" && rep.periodoDias === 60);
  ok("taxa do ML em %", rep.reclamacoes.taxaPct === 0.31 && rep.atrasos.quantidade === 9);

  ok("Ads no mesmo período", r.ads.disponivel && r.ads.dados.args[2].from === "2026-11-05" && r.ads.dados.args[3] === 10);
  ok("configuração só com setup e sync", r.configuracao.dados.setup.temGrant === true && !("outros" in r.configuracao.dados));
  ok("metas do MercadoLíder vão junto", r.metasMercadoLider.length === 3);

  console.log("isolamento de falha");
  const falha = await obterInicio(
    { clienteSlugRaw: "n97", clienteContaIdRaw: "10", periodoRaw: "30d" },
    depsBase({ mlFetch: async () => ({ ok: false, status: 403 }), obterResumoMargem: async () => { throw new Error("motor fora"); } })
  );
  ok("reputação indisponível não derruba", falha.reputacao.disponivel === false && /403/.test(falha.reputacao.motivo));
  ok("catálogo indisponível não derruba", falha.catalogo.disponivel === false && falha.vendas.disponivel === true);

  const shopee = await obterInicio({ clienteSlugRaw: "n97", clienteContaIdRaw: "11", periodoRaw: "30d" }, depsBase());
  ok("Shopee: blocos só-ML não se aplicam", !shopee.catalogo.disponivel && !shopee.reputacao.disponivel && !shopee.ads.disponivel && shopee.vendas.disponivel);

  const semAnterior = await obterInicio({ clienteSlugRaw: "n97", clienteContaIdRaw: "10", periodoRaw: "hoje" }, depsBase());
  ok("hoje: compara com ontem, série de 1 dia", semAnterior.vendas.dados.anterior !== null && semAnterior.vendas.dados.serie.length === 1);
  const vazio = await obterInicio({ clienteSlugRaw: "n97", clienteContaIdRaw: "10", periodoRaw: "hoje" }, depsBase({ carregarPedidos: async () => ({ sincronizado: false, atualizadoEm: null, pedidos: [] }) }));
  ok("nunca sincronizado é declarado", vazio.vendas.dados.sincronizado === false && vazio.vendas.dados.anterior === null && vazio.vendas.dados.totais.lucro === null);

  console.log("leitura da reputação");
  const nada = lerReputacaoMl({});
  ok("sem reputação: tudo null, nunca zero inventado", nada.nivel === null && nada.reclamacoes.taxaPct === null && nada.vendasPeriodo === null);

  console.log(`\n${checks} verificações ok`);
}

function round2(n) { return Math.round(n * 100) / 100; }

run().catch((err) => { console.error(err); process.exit(1); });
