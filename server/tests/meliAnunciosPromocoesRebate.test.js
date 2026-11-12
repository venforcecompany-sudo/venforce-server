// server/tests/meliAnunciosPromocoesRebate.test.js
//
// "Promoções com rebate" (docs/specs/2026-10-15-anuncios-ml-promocoes-rebate.md).
//
// Regras protegidas por este teste:
//
//  1. referência padrão: "vendex" + mês atual (America/Sao_Paulo), sem acento
//     e sem caixa; sem ela, a Vendex ativa mais recente; sem Vendex, nenhuma;
//  2. candidatas: tipo ACEITE, subsídio ML > 0, candidate, preço conhecido e
//     ESTRITAMENTE menor que o da referência (igual/maior = PRECO_NAO_MENOR);
//  3. margem de cada preço = mesma composição do Simular (computeMargin com
//     comissão/frete cotados naquele preço); cotação falha → COTACAO_INDISPONIVEL,
//     sem custo → SEM_CUSTO, nunca estimativa;
//  4. classificação pura: recomendado / escolha / sem_ganho;
//  5. job: uma análise ativa por cliente, universo = itens ativos na
//     referência (∩ itemIds), progresso, resumo;
//  6. execução: escolha fora das candidatas = 400 ESCOLHA_INVALIDA, uma por
//     item, sequencial, falha de um não para o lote, revalidação antes de
//     gravar bloqueia, a referência NUNCA recebe escrita;
//  7. rotas registradas antes de "/:itemId".

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/vf-test";

const assert = require("assert");
const svc = require("../services/meliAnuncios/meliPromocoesRebateService");
const { normalizarPromocao } = require("../services/meliAnuncios/meliPromocoesService");
const { computeMargin } = require("../services/motorMargem/core/marginEngine");

let checks = 0;
function ok(msg) { checks += 1; console.log(`  ✓ ${msg}`); }

const OUTUBRO = new Date("2026-10-15T15:00:00Z");

// ─── Fixtures ────────────────────────────────────────────────────────────────

const REF = { id: "C-MLB1", tipo: "SELLER_CAMPAIGN" };

function promo(bruta, i = 0) {
  return normalizarPromocao(bruta, i, null);
}

function refAtiva(price = 100, extra = {}) {
  return promo({ id: "C-MLB1", type: "SELLER_CAMPAIGN", status: "started", price, original_price: 120, name: "Vendex - Outubro", ...extra });
}

// SMART candidate sem sugestão: preço = original × (1 − (meli+seller)/100), subsídio = original × meli/100.
function smart(id, { original = 100, meli = 5, seller = 0, status = "candidate", ref = `CANDIDATE-${id}` } = {}) {
  return promo({ id, type: "SMART", status, ref_id: ref, original_price: original, meli_percentage: meli, seller_percentage: seller, name: `Smart ${id}` });
}

// Comissão 12% do preço, frete fixo 10 (logística com frete previsto).
function fakeCotacao({ falharEm = null, rateLimitVezes = 0 } = {}) {
  const chamadas = [];
  let rl = rateLimitVezes;
  async function buscarComissaoEFrete(args, fetchFn) {
    chamadas.push(args.precoEfetivo);
    if (rl > 0) {
      rl -= 1;
      // Faz o cotador registrar status 429 nas duas leituras.
      await fetchFn(1, "/sites/MLB/listing_prices?price=" + args.precoEfetivo);
      await fetchFn(1, "/users/1/shipping_options/free");
      return { comissaoValor: null, fretePrevisto: null };
    }
    if (falharEm !== null && Math.abs(args.precoEfetivo - falharEm) < 0.001) return { comissaoValor: null, fretePrevisto: null };
    return { comissaoValor: Math.round(args.precoEfetivo * 0.12 * 100) / 100, fretePrevisto: 10 };
  }
  const mlFetch = async () => (rl >= 0 ? { ok: false, status: 429, data: {} } : { ok: true, status: 200, data: {} });
  return { buscarComissaoEFrete, mlFetch, chamadas };
}

const ANUNCIO = { item_id: "MLB1", titulo: "Camiseta", thumbnail: "http://img/1.jpg", listing_type_id: "gold_pro", category_id: "MLB123", logistic_type: "fulfillment", ml_user_id: "111" };
const CUSTOS = { custo: 50, aliquota: 0.1, taxaFixa: 2 };

function repoMemoria() {
  const jobs = new Map();
  let seq = 0;
  const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
  return {
    jobs,
    async limparOrfaos() {},
    async emAndamento(clienteId) {
      for (const j of jobs.values()) if (j.cliente_id === clienteId && j.status === "processando") return j.id;
      return null;
    },
    async criar(p) {
      seq += 1;
      jobs.set(seq, {
        id: seq, cliente_id: p.clienteId, cliente_slug: p.clienteSlug, cliente_conta_id: p.clienteContaId,
        ml_user_id: String(p.mlUserId), referencia: clone(p.referencia), item_ids: clone(p.itemIds),
        fase: "analise", status: "processando", erro: null, progresso_total: 0, progresso_processados: 0,
        resultado: null, execucao: null, progressos: [],
      });
      return seq;
    },
    async obter(id) { return clone(jobs.get(Number(id)) || null); },
    async atualizarProgresso(id, total, processados, resumoParcial = null) {
      const j = jobs.get(id);
      j.progresso_total = total;
      j.progresso_processados = Math.max(j.progresso_processados, processados);
      j.progressos.push(processados);
      if (resumoParcial) j.progresso_resumo = clone(resumoParcial);
    },
    async concluirAnalise(id, resultado) {
      const j = jobs.get(id);
      j.status = "concluido"; j.resultado = clone(resultado); j.progresso_processados = j.progresso_total;
    },
    async marcarErro(id, msg) { const j = jobs.get(id); j.status = "erro"; j.erro = msg; },
    async iniciarExecucao(id, execucao) {
      const j = jobs.get(id);
      if (j.status === "processando" || !j.resultado) return false;
      j.fase = "execucao"; j.status = "processando"; j.erro = null; j.execucao = clone(execucao);
      return true;
    },
    async atualizarExecucao(id, execucao) { jobs.get(id).execucao = clone(execucao); },
    async concluirExecucao(id, execucao) { const j = jobs.get(id); j.status = "concluido"; j.execucao = clone(execucao); },
  };
}

async function run() {
  // ── 1. Referência padrão ──────────────────────────────────────────────────
  assert.strictEqual(svc.mesAtualSaoPaulo(OUTUBRO), 10);
  assert.strictEqual(svc.mesAtualSaoPaulo(new Date("2026-11-01T02:30:00Z")), 10, "23h30 de 31/10 em SP ainda é outubro");
  ok("mês atual calculado em America/Sao_Paulo");

  for (const nome of ["Outubro - Vendex", "Vendex Outubro", "VENDEX - OUTUBRO", "vendex/outubro 2026"]) {
    assert.ok(svc.ehVendexDoMes(nome, OUTUBRO), `${nome} deveria casar em outubro`);
  }
  for (const nome of ["Vendex - Setembro", "Outubro Black", "Vendexx Outubro", ""]) {
    assert.ok(!svc.ehVendexDoMes(nome, OUTUBRO), `${nome} não deveria casar`);
  }
  assert.ok(svc.ehVendexDoMes("Vendex Março", new Date("2026-03-10T12:00:00Z")), "sem acento: Março casa com marco");
  ok("Vendex do mês: sem acento, sem caixa, palavra inteira");

  const refs = [
    { id: "A", tipo: "DEAL", nome: "Black Friday", status: "started", inicio: "2026-10-10T00:00:00Z" },
    { id: "B", tipo: "SELLER_CAMPAIGN", nome: "Vendex - Setembro", status: "started", inicio: "2026-09-01T00:00:00Z" },
    { id: "C", tipo: "SELLER_CAMPAIGN", nome: "Outubro - Vendex", status: "started", inicio: "2026-10-01T00:00:00Z" },
    { id: "D", tipo: "SELLER_CAMPAIGN", nome: "Vendex Agosto", status: "started", inicio: "2026-08-01T00:00:00Z" },
  ];
  assert.strictEqual(svc.escolherReferenciaPadrao(refs, OUTUBRO).id, "C");
  assert.strictEqual(svc.escolherReferenciaPadrao(refs.filter((r) => r.id !== "C"), OUTUBRO).id, "B", "sem a do mês: Vendex ativa mais recente");
  assert.strictEqual(
    svc.escolherReferenciaPadrao([{ ...refs[1], status: "pending" }, refs[0]], OUTUBRO), null,
    "Vendex só agendada (não ativa) e sem a do mês: nada pré-selecionado"
  );
  assert.strictEqual(svc.escolherReferenciaPadrao([refs[0]], OUTUBRO), null, "sem Vendex: nenhuma");
  const ordenadas = svc.ordenarReferencias(refs, svc.escolherReferenciaPadrao(refs, OUTUBRO));
  assert.deepStrictEqual(ordenadas.map((r) => r.id), ["C", "B", "D", "A"], "padrão, Vendex (início desc), demais");
  assert.deepStrictEqual(ordenadas.map((r) => r.padrao), [true, false, false, false]);
  ok("referência padrão e ordem do seletor");

  // ── 2. Candidatas ─────────────────────────────────────────────────────────
  {
    const ref = refAtiva(100);
    const lista = [
      ref,
      smart("P-OK", { original: 100, meli: 5 }),                       // 95, subsídio 5 → entra
      smart("P-IGUAL", { original: 105, meli: 4.7619 }),               // ≈100 → não menor
      smart("P-SEMSUB", { original: 100, meli: 0, seller: 10 }),       // sem subsídio
      smart("P-ATIVA", { original: 100, meli: 5, status: "started" }), // não é candidate
      promo({ id: "P-DEAL", type: "DEAL", status: "candidate", original_price: 100, suggested_discounted_price: 90, meli_percentage: 3 }), // tipo PRECO
      promo({ id: "P-SEMPRECO", type: "PRE_NEGOTIATED", status: "candidate", original_price: null, meli_percentage: 3 }),
    ];
    const r = svc.filtrarCandidatas(lista, ref);
    assert.deepStrictEqual(r.candidatas.map((c) => c.id), ["P-OK"]);
    assert.strictEqual(r.motivo, null);

    const soIgual = svc.filtrarCandidatas([ref, promo({ id: "P-EQ", type: "MARKETPLACE_CAMPAIGN", status: "candidate", original_price: 100, suggested_discounted_price: 100, meli_percentage: 2 })], ref);
    assert.strictEqual(soIgual.candidatas.length, 0);
    assert.strictEqual(soIgual.motivo, "PRECO_NAO_MENOR", "preço igual ao da referência (centavos) nunca forma o preço");

    const umCentavo = svc.filtrarCandidatas([ref, promo({ id: "P-1C", type: "MARKETPLACE_CAMPAIGN", status: "candidate", original_price: 100, suggested_discounted_price: 99.99, meli_percentage: 2 })], ref);
    assert.strictEqual(umCentavo.candidatas.length, 1, "1 centavo abaixo já é estritamente menor");

    const nada = svc.filtrarCandidatas([ref, lista[3], lista[4], lista[5]], ref);
    assert.strictEqual(nada.motivo, "SEM_CANDIDATA");
    ok("filtro de candidatas: ACEITE, subsídio > 0, candidate, preço estritamente menor");
  }

  // localizar referência: id+tipo, só ativa e com preço
  {
    assert.ok(svc.localizarReferencia([refAtiva(100)], REF));
    assert.strictEqual(svc.localizarReferencia([refAtiva(100)], { id: "C-MLB1", tipo: "DEAL" }), null, "mesmo id, outro tipo");
    assert.strictEqual(svc.localizarReferencia([promo({ id: "C-MLB1", type: "SELLER_CAMPAIGN", status: "pending", price: 90 })], REF), null);
    assert.strictEqual(svc.localizarReferencia([promo({ id: "C-MLB1", type: "SELLER_CAMPAIGN", status: "started", price: 0 })], REF), null);
    ok("referência localizada por id+tipo, ativa e com preço");
  }

  // ── 3. Margem num preço ───────────────────────────────────────────────────
  {
    const cot = { comissao: 11.4, frete: 10, frete_aplicavel: true, limite_excedido: false, motivos: {} };
    const m = svc.margemNoPreco({ preco: 95, rebate: 5, custo: 50, aliquota: 0.1, taxaFixa: 2, cotacao: cot });
    const esperado = computeMargin({ price: 95, cost: 50, taxRate: 0.1, fixedFee: 2, commission: 11.4, freight: 10, rebate: 5 });
    assert.ok(m.ok);
    assert.strictEqual(m.lucro, esperado.profit);
    assert.strictEqual(m.margemRatio, esperado.margin);
    assert.strictEqual(m.lucro, 17.1);

    const semFrete = svc.margemNoPreco({ preco: 95, rebate: 0, custo: 50, aliquota: 0.1, taxaFixa: 0, cotacao: { comissao: 11.4, frete: null, frete_aplicavel: false, motivos: {} } });
    assert.ok(semFrete.ok, "logística sem frete previsto = frete 0 declarado");
    assert.strictEqual(semFrete.lucro, computeMargin({ price: 95, cost: 50, taxRate: 0.1, fixedFee: 0, commission: 11.4, freight: 0 }).profit);

    assert.strictEqual(svc.margemNoPreco({ preco: 95, custo: 50, aliquota: 0.1, cotacao: { comissao: null, frete: 10, motivos: { comissao: "ml_rate_limit" } } }).ok, false);
    assert.strictEqual(svc.margemNoPreco({ preco: 95, custo: 50, aliquota: 0.1, cotacao: { comissao: 11, frete: null, frete_aplicavel: true, motivos: {} } }).ok, false);

    // P0 12/11/2026: frete estimado de confiança baixa / histórico antigo NÃO decide participação (não vira escrita);
    // confiança média e cotação do ML seguem valendo.
    const comQ = (q) => svc.margemNoPreco({ preco: 95, custo: 50, aliquota: 0.1, cotacao: { ...cot, frete_qualidade: q } });
    const baixa = comQ({ nivel: "estimado_custo_cobrado", confianca: "baixa" });
    assert.deepStrictEqual([baixa.ok, baixa.motivo], [false, "frete_confianca_baixa"]);
    assert.strictEqual(comQ({ nivel: "estimado_dimensoes_historicas", confianca: "media", historicoAntigo: true }).ok, false);
    assert.strictEqual(comQ({ nivel: "estimado_dimensoes_declaradas", confianca: "media" }).ok, true);
    assert.strictEqual(comQ({ nivel: "cotado_ml" }).ok, true);
    assert.strictEqual(svc.margemNoPreco({ preco: 95, custo: 50, aliquota: 0.1, cotacao: { ...cot, frete_aplicavel: false, frete: null, frete_qualidade: { confianca: "baixa" } } }).ok, true, "logística combinável: sem frete a avaliar");
    assert.strictEqual(svc.margemNoPreco({ preco: 95, custo: 50, aliquota: 0.1, cotacao: { ...cot, limite_excedido: true } }).ok, false);
    assert.strictEqual(svc.margemNoPreco({ preco: 95, custo: null, aliquota: 0.1, cotacao: cot }).ok, false);
    ok("margem num preço: computeMargin com comissão/frete cotados; ausência bloqueia");
  }

  // ── 4. Classificação pura ─────────────────────────────────────────────────
  {
    const cand = (id, margemRatio, lucro, extra = {}) => ({ id, tipo: "SMART", nome: id, precoFinal: 90, subsidioMl: 3, margemRatio, lucro, ...extra });
    const ref = { margemRatio: 0.16, lucro: 16 };

    const rec = svc.classificarItem({ referencia: ref, candidatas: [cand("A", 0.18, 17.1), cand("B", 0.17, 16.5), cand("C", 0.1, 9)] });
    assert.strictEqual(rec.status, "recomendado");
    assert.deepStrictEqual(rec.candidatas.map((c) => c.promotionId), ["A", "B"], "C não melhora nada → fora da lista");
    assert.deepStrictEqual(rec.sugestao, { porMargem: "A", porLucro: "A" });
    assert.strictEqual(rec.candidatas[0].melhorMargem, true);
    assert.strictEqual(rec.candidatas[0].melhorLucro, true);
    assert.strictEqual(rec.candidatas[0].margemPercent, 18);
    assert.strictEqual(rec.candidatas[0].ganhoMargemPp, 2);
    assert.strictEqual(rec.candidatas[0].ganhoLucro, 1.1);

    const esc = svc.classificarItem({ referencia: ref, candidatas: [cand("M", 0.2, 15), cand("L", 0.165, 18)] });
    assert.strictEqual(esc.status, "escolha", "melhor em margem ≠ melhor em lucro");
    assert.deepStrictEqual(esc.sugestao, { porMargem: "M", porLucro: "L" });

    const piora = svc.classificarItem({ referencia: ref, candidatas: [cand("X", 0.2, 15.5)] });
    assert.strictEqual(piora.status, "escolha", "a melhor nas duas medidas ainda piora o lucro → usuário escolhe");

    const sem = svc.classificarItem({ referencia: ref, candidatas: [cand("Y", 0.15, 15), cand("Z", 0.16, 16)] });
    assert.strictEqual(sem.status, "sem_ganho", "igual não é melhora");
    assert.deepStrictEqual(sem.candidatas, []);
    assert.strictEqual(sem.sugestao, null);

    assert.deepStrictEqual(svc.resumir([{ status: "recomendado" }, { status: "escolha" }, { status: "descartado" }, { status: "descartado" }]),
      { recomendado: 1, escolha: 1, sem_ganho: 0, descartado: 2 });
    ok("classificação: recomendado / escolha / sem_ganho + resumo");
  }

  // ── 5. Paginação do ML (os dois formatos) ─────────────────────────────────
  {
    const chamadas = [];
    const mlFetch = async (_c, path) => {
      chamadas.push(path);
      if (/offset=50/.test(path)) return { ok: true, status: 200, data: { results: [{ id: "P3", type: "DEAL", status: "started", name: "X" }], paging: { offset: 50, limit: 50, total: 51 } } };
      return { ok: true, status: 200, data: { results: Array.from({ length: 50 }, (_, i) => ({ id: `P${i}`, type: "DEAL", status: i === 0 ? "finished" : "started", name: `N${i}` })), paging: { offset: 0, limit: 50, total: 51 } } };
    };
    const r = await svc.listarReferencias({ clienteId: 1, mlUserId: "111" }, { mlFetch, now: () => OUTUBRO });
    assert.ok(r.ok);
    assert.strictEqual(chamadas.length, 2, "offset/limit/total: segunda página");
    assert.ok(!r.referencias.some((x) => x.id === "P0"), "finished fica fora do seletor");
    assert.ok(r.referencias.some((x) => x.id === "P3"));
    assert.strictEqual(r.padraoId, null);

    const sa = [];
    const mlFetchSa = async (_c, path) => {
      sa.push(path);
      if (/search_after=TK2/.test(path)) return { ok: true, status: 200, data: { results: [{ id: "MLB3", status: "started", price: 10 }], paging: {} } };
      if (/search_after=TK1/.test(path)) return { ok: true, status: 200, data: { results: [{ id: "MLB2", status: "started", price: 10 }], paging: { searchAfter: "TK2" } } };
      return { ok: true, status: 200, data: { results: [{ id: "MLB1", status: "started", price: 10 }], searchAfter: "TK1" } };
    };
    const p = await svc.paginarSellerPromotions({ mlFetch: mlFetchSa, sleep: async () => {} }, { clienteId: 1, mlUserId: "1", caminho: "/x?a=1" });
    assert.deepStrictEqual(p.resultados.map((x) => x.id), ["MLB1", "MLB2", "MLB3"]);
    assert.strictEqual(sa.length, 3, "search_after: segue o token até a última página (sem token)");

    let n429 = 0;
    const mlFetch429 = async () => { n429 += 1; return n429 === 1 ? { ok: false, status: 429, retryAfter: 0, data: {} } : { ok: true, status: 200, data: { results: [], paging: [] } }; };
    const p2 = await svc.paginarSellerPromotions({ mlFetch: mlFetch429, sleep: async () => {} }, { clienteId: 1, mlUserId: "1", caminho: "/x" });
    assert.ok(p2.ok && n429 === 2, "429 é respeitado e tentado de novo");
    ok("paginação offset/total e search_after; 429 com nova tentativa");

    const padrao = await svc.listarReferencias({ clienteId: 1, mlUserId: "111" }, {
      now: () => OUTUBRO,
      mlFetch: async () => ({ ok: true, status: 200, data: { results: [
        { id: "C-1", type: "SELLER_CAMPAIGN", status: "started", name: "Vendex - Setembro", start_date: "2026-09-01T03:00:00Z" },
        { id: "C-2", type: "SELLER_CAMPAIGN", status: "started", name: "Outubro - Vendex", start_date: "2026-10-01T03:00:00Z", finish_date: "2026-11-01T02:59:00Z" },
      ], paging: { offset: 0, limit: 50, total: 2 } } }),
    });
    assert.strictEqual(padrao.padraoId, "C-2");
    assert.deepStrictEqual(padrao.referencias[0], {
      id: "C-2", tipo: "SELLER_CAMPAIGN", tipoLabel: "Campanha própria", nome: "Outubro - Vendex", status: "started",
      inicio: "2026-10-01T03:00:00Z", fim: "2026-11-01T02:59:00Z", padrao: true,
    });
    ok("GET referencias: contrato JSON e padrão do mês");
  }

  // ── 6. avaliarItem (I/O injetado) ─────────────────────────────────────────
  const listaPadrao = () => [refAtiva(100), smart("P-OK", { original: 100, meli: 5 }), smart("P-RUIM", { original: 100, meli: 1, seller: 9 })];
  function depsItem({ lista = listaPadrao(), cot = fakeCotacao(), listar = null } = {}) {
    return {
      listarPromocoesDoItemDetalhado: listar || (async () => ({ ok: true, status: 200, promocoes: lista })),
      buscarComissaoEFrete: cot.buscarComissaoEFrete,
      mlFetch: cot.mlFetch,
      sleep: async () => {},
      now: () => OUTUBRO,
    };
  }
  const entrada = (extra = {}) => ({ itemId: "MLB1", anuncio: ANUNCIO, naReferencia: true, referencia: REF, custos: CUSTOS, clienteId: 1, mlUserId: "111", ...extra });

  {
    const r = await svc.avaliarItem(entrada(), depsItem());
    assert.strictEqual(r.status, "recomendado");
    assert.strictEqual(r.titulo, "Camiseta");
    assert.strictEqual(r.thumbnail, "http://img/1.jpg");
    assert.deepStrictEqual(r.referencia, { preco: 100, subsidioMl: 0, meliPercentage: null, margemPercent: 16, lucro: 16 });
    assert.strictEqual(r.candidatas.length, 1, "P-RUIM (90, subsídio 1) piora as duas medidas → fora");
    const c = r.candidatas[0];
    assert.deepStrictEqual(
      { promotionId: c.promotionId, tipo: c.tipo, preco: c.preco, subsidioMl: c.subsidioMl, margemPercent: c.margemPercent, lucro: c.lucro, ganhoMargemPp: c.ganhoMargemPp, ganhoLucro: c.ganhoLucro, melhorMargem: c.melhorMargem, melhorLucro: c.melhorLucro },
      { promotionId: "P-OK", tipo: "SMART", preco: 95, subsidioMl: 5, margemPercent: 18, lucro: 17.1, ganhoMargemPp: 2, ganhoLucro: 1.1, melhorMargem: true, melhorLucro: true }
    );
    assert.strictEqual(c.meliPercentage, 5, "taxa de rebate do ML exposta para a tela");
    assert.deepStrictEqual(r.sugestao, { porMargem: "P-OK", porLucro: "P-OK" });
    ok("avaliarItem: caminho completo → recomendado com números da fórmula do Motor");
  }
  {
    const r = await svc.avaliarItem(entrada(), depsItem({ cot: fakeCotacao({ falharEm: 100 }) }));
    assert.strictEqual(r.status, "descartado");
    assert.strictEqual(r.motivo, "COTACAO_INDISPONIVEL", "cotação da referência falhou → nunca estima");
    assert.strictEqual(r.referencia.margemPercent, null);

    const r2 = await svc.avaliarItem(entrada(), depsItem({ lista: [refAtiva(100), smart("P-OK", { original: 100, meli: 5 })], cot: fakeCotacao({ falharEm: 95 }) }));
    assert.strictEqual(r2.status, "descartado");
    assert.strictEqual(r2.motivo, "COTACAO_INDISPONIVEL", "única candidata útil sem cotação → descartado");
    assert.ok(r2.candidatasIgnoradas.some((x) => x.promotionId === "P-OK"));
    ok("cotação falha → COTACAO_INDISPONIVEL (referência ou todas as candidatas)");
  }
  {
    const r = await svc.avaliarItem(entrada({ custos: { custo: null, aliquota: 0.1, taxaFixa: 0 } }), depsItem());
    assert.strictEqual(r.motivo, "SEM_CUSTO");
    const r2 = await svc.avaliarItem(entrada({ custos: { erro: "Base não vinculada" } }), depsItem());
    assert.strictEqual(r2.motivo, "SEM_CUSTO");
    assert.ok(/Base não vinculada/.test(r2.motivoTexto));
    ok("sem custo → SEM_CUSTO (inclusive Base indisponível)");
  }
  {
    assert.strictEqual((await svc.avaliarItem(entrada({ naReferencia: false }), depsItem())).motivo, "FORA_DA_REFERENCIA");
    assert.strictEqual((await svc.avaliarItem(entrada(), depsItem({ lista: [smart("P-OK")] }))).motivo, "FORA_DA_REFERENCIA", "referência ausente na leitura ao vivo");
    assert.strictEqual((await svc.avaliarItem(entrada({ anuncio: null }), depsItem())).motivo, "ANUNCIO_NAO_SINCRONIZADO");
    assert.strictEqual((await svc.avaliarItem(entrada(), depsItem({ lista: [refAtiva(100)] }))).motivo, "SEM_CANDIDATA");
    assert.strictEqual((await svc.avaliarItem(entrada(), depsItem({ lista: [refAtiva(90), smart("P-OK")] }))).motivo, "PRECO_NAO_MENOR");
    const erroMl = await svc.avaliarItem(entrada(), depsItem({ listar: async () => ({ ok: false, status: 500, promocoes: [] }) }));
    assert.strictEqual(erroMl.motivo, "ERRO_ML");
    ok("descartes: FORA_DA_REFERENCIA, ANUNCIO_NAO_SINCRONIZADO, SEM_CANDIDATA, PRECO_NAO_MENOR, ERRO_ML");
  }
  {
    let n = 0;
    const listar = async () => { n += 1; return n === 1 ? { ok: false, status: 429, retryAfter: 0, promocoes: [] } : { ok: true, status: 200, promocoes: listaPadrao() }; };
    const r = await svc.avaliarItem(entrada(), depsItem({ listar }));
    assert.strictEqual(r.status, "recomendado");
    assert.strictEqual(n, 2, "429 nas promoções do item é tentado de novo, não vira descarte");

    const cot = fakeCotacao({ rateLimitVezes: 1 });
    const r2 = await svc.avaliarItem(entrada(), depsItem({ cot }));
    assert.strictEqual(r2.status, "recomendado", "429 na cotação é tentado de novo");
    ok("429 respeitado: promoções e cotação com nova tentativa");
  }
  {
    // Anúncio que JÁ está numa promoção com rebate ativa (fora da referência):
    // ela forma o preço hoje (sale_price → ATIVA) e é a base da comparação.
    const jaAtiva = normalizarPromocao({ id: "P-JA", type: "SMART", status: "started", ref_id: "OFFER-JA", price: 95, original_price: 100, meli_percentage: 5, seller_percentage: 0, name: "Smart já ativa" }, 0, "OFFER-JA");
    assert.strictEqual(jaAtiva.statusExibicao, "ATIVA");
    const lista = (...extra) => [refAtiva(100), jaAtiva, ...extra];

    assert.strictEqual(svc.localizarPromoAtual(lista(), refAtiva(100)).id, "P-JA");
    assert.strictEqual(svc.localizarPromoAtual([refAtiva(100)], refAtiva(100)).id, "C-MLB1", "sem ATIVA → base = referência");

    const igual = await svc.avaliarItem(entrada(), depsItem({ lista: lista(smart("P-OK", { original: 100, meli: 5 })) }));
    assert.strictEqual(igual.status, "sem_ganho", "candidata a 95 não é menor que o preço de hoje (95) — antes saía recomendada contra a Vendex");
    assert.strictEqual(igual.motivo, "JA_EM_REBATE_MELHOR");
    assert.ok(/rebate melhor/.test(igual.motivoTexto));
    assert.deepStrictEqual(
      { id: igual.atual.promotionId, nome: igual.atual.nome, ref: igual.atual.ehReferencia, preco: igual.atual.preco, sub: igual.atual.subsidioMl, pct: igual.atual.meliPercentage },
      { id: "P-JA", nome: "Smart já ativa", ref: false, preco: 95, sub: 5, pct: 5 }
    );

    const pior = await svc.avaliarItem(entrada(), depsItem({ lista: lista(smart("P-RUIM", { original: 100, meli: 1, seller: 9 })) }));
    assert.strictEqual(pior.status, "sem_ganho");
    assert.strictEqual(pior.motivo, "JA_EM_REBATE_MELHOR", "candidata mais barata mas pior que a promoção atual");
    assert.strictEqual(pior.atual.lucro, 17.1);

    const melhor = await svc.avaliarItem(entrada(), depsItem({ lista: lista(smart("P-MELHOR", { original: 100, meli: 10 })) }));
    assert.strictEqual(melhor.status, "recomendado");
    assert.deepStrictEqual({ m: melhor.atual.margemPercent, l: melhor.atual.lucro }, { m: 18, l: 17.1 }, "margem/lucro de hoje = na promoção ativa");
    assert.deepStrictEqual({ m: melhor.referencia.margemPercent, l: melhor.referencia.lucro }, { m: null, l: null }, "a Vendex não forma o preço: sem margem dela");
    const c = melhor.candidatas[0];
    assert.deepStrictEqual({ id: c.promotionId, preco: c.preco, l: c.lucro, gL: c.ganhoLucro }, { id: "P-MELHOR", preco: 90, l: 18.2, gL: 1.1 }, "ganho contra o preço de hoje, não contra a Vendex");

    const naRef = await svc.avaliarItem(entrada(), depsItem({ lista: [normalizarPromocao({ id: "C-MLB1", type: "SELLER_CAMPAIGN", status: "started", price: 100, original_price: 120, name: "Vendex - Outubro" }, 0, "C-MLB1"), smart("P-OK")] }));
    assert.strictEqual(naRef.status, "recomendado");
    assert.strictEqual(naRef.atual.ehReferencia, true);
    assert.strictEqual(naRef.referencia.margemPercent, 16);
    ok("já numa promoção com rebate: base = preço de hoje, sem_ganho JA_EM_REBATE_MELHOR, ganho contra a ativa");
  }

  // ── 7. Job: iniciar análise + worker ──────────────────────────────────────
  const cliente = { id: 1, slug: "cliente-a" };
  const contexto = { mlUserId: "111", contaId: 10 };
  function mlFetchConta({ itens = [{ id: "MLB1", status: "started", price: 100 }, { id: "MLB2", status: "started", price: 50 }, { id: "MLB3", status: "started", price: 70 }] } = {}) {
    return async (_c, path) => {
      if (path.startsWith("/seller-promotions/users/")) {
        return { ok: true, status: 200, data: { results: [{ id: "C-MLB1", type: "SELLER_CAMPAIGN", status: "started", name: "Vendex - Outubro" }], paging: { offset: 0, limit: 50, total: 1 } } };
      }
      if (path.startsWith("/seller-promotions/promotions/C-MLB1/items")) {
        assert.ok(/promotion_type=SELLER_CAMPAIGN/.test(path) && /status=started/.test(path) && /app_version=v2/.test(path));
        return { ok: true, status: 200, data: { results: itens, paging: { offset: 0, limit: 50, total: itens.length } } };
      }
      return { ok: true, status: 200, data: {} };
    };
  }
  function depsJob(extra = {}) {
    const repo = extra.repo || repoMemoria();
    const agendados = [];
    const cot = fakeCotacao();
    const promosPorItem = extra.promosPorItem || {
      MLB1: listaPadrao(),
      MLB2: [refAtiva(50)],
      MLB3: listaPadrao(),
    };
    return {
      repo,
      agendados,
      deps: {
        repo,
        ensureSchema: async () => {},
        agendar: (fn) => agendados.push(fn),
        now: () => OUTUBRO,
        sleep: async () => {},
        logger: { error() {}, warn() {}, log() {} },
        mlFetch: extra.mlFetch || mlFetchConta(),
        buscarComissaoEFrete: cot.buscarComissaoEFrete,
        listarPromocoesDoItemDetalhado: async ({ itemId }) => ({ ok: true, status: 200, promocoes: promosPorItem[itemId] || [] }),
        carregarAnuncios: async (_cid, ids) => new Map(ids.filter((id) => id !== "MLB3").map((id) => [id, { ...ANUNCIO, item_id: id, titulo: `T ${id}` }])),
        criarCarregadorCustos: () => async (ids) => new Map(ids.map((id) => [id, CUSTOS])),
        participarPromocaoAceite: extra.participar || (async () => ({ ok: true, precoConfirmado: 95 })),
        registrarLog: extra.registrarLog || (async () => {}),
      },
    };
  }

  {
    const t = depsJob();
    const inval = await svc.iniciarAnalise({ cliente, contexto, body: { referencia: { id: "C-MLB1" } } }, t.deps);
    assert.strictEqual(inval.httpStatus, 400);
    assert.strictEqual(inval.codigo, "REFERENCIA_INVALIDA");

    const naoAchou = await svc.iniciarAnalise({ cliente, contexto, body: { referencia: { id: "C-OUTRA", tipo: "DEAL" } } }, t.deps);
    assert.strictEqual(naoAchou.ok, false);
    assert.strictEqual(naoAchou.codigo, "REFERENCIA_NAO_ENCONTRADA");

    const r = await svc.iniciarAnalise({ cliente, contexto, body: { referencia: { id: "C-MLB1", tipo: "SELLER_CAMPAIGN" } }, user: { id: 7 } }, t.deps);
    assert.deepStrictEqual(r, { ok: true, jobId: 1 });
    assert.strictEqual(t.agendados.length, 1, "worker agendado em background, não executado na requisição");
    assert.deepStrictEqual(t.repo.jobs.get(1).referencia, { id: "C-MLB1", tipo: "SELLER_CAMPAIGN", nome: "Vendex - Outubro" });

    const dup = await svc.iniciarAnalise({ cliente, contexto, body: { referencia: { id: "C-MLB1", tipo: "SELLER_CAMPAIGN" } } }, t.deps);
    assert.strictEqual(dup.ok, false);
    assert.strictEqual(dup.codigo, "ANALISE_EM_ANDAMENTO", "uma análise ativa por cliente");
    assert.strictEqual(dup.jobId, 1);

    const durante = await svc.lerJob({ jobId: 1, cliente, mlUserId: "111" }, t.deps);
    assert.strictEqual(durante.job.status, "processando");
    assert.strictEqual(durante.job.resultado, null, "resultado só quando a análise conclui");

    await t.agendados[0]();
    const job = t.repo.jobs.get(1);
    assert.strictEqual(job.status, "concluido");
    assert.strictEqual(job.progresso_total, 3);
    assert.deepStrictEqual(job.progressos.slice(1).sort(), [1, 2, 3], "progresso gravado a cada item");
    assert.deepStrictEqual(job.resultado.resumo, { recomendado: 1, escolha: 0, sem_ganho: 0, descartado: 2 });
    assert.deepStrictEqual(job.resultado.itens.map((i) => [i.itemId, i.status, i.motivo]), [
      ["MLB1", "recomendado", null],
      ["MLB2", "descartado", "SEM_CANDIDATA"],
      ["MLB3", "descartado", "ANUNCIO_NAO_SINCRONIZADO"],
    ]);

    const lido = await svc.lerJob({ jobId: 1, cliente, mlUserId: "111" }, t.deps);
    assert.deepStrictEqual(Object.keys(lido.job).sort(), ["erro", "execucao", "fase", "id", "progresso", "referencia", "resultado", "status"]);
    assert.deepStrictEqual(job.progresso_resumo, { recomendado: 1, escolha: 0, sem_ganho: 0, descartado: 2 }, "placar parcial por status");
    assert.deepStrictEqual(lido.job.progresso, { total: 3, processados: 3, resumo: { recomendado: 1, escolha: 0, sem_ganho: 0, descartado: 2 } });
    assert.strictEqual(lido.job.fase, "analise");
    assert.strictEqual(lido.job.execucao, null);

    const outro = await svc.lerJob({ jobId: 1, cliente: { id: 2, slug: "b" }, mlUserId: "111" }, t.deps);
    assert.strictEqual(outro.httpStatus, 404, "job só é lido pelo mesmo cliente");
    const outraConta = await svc.lerJob({ jobId: 1, cliente, mlUserId: "999" }, t.deps);
    assert.strictEqual(outraConta.httpStatus, 404, "nem por outra conta ML do mesmo cliente");
    ok("job: iniciar, uma análise por cliente, worker, progresso, resumo, leitura restrita");
  }

  {
    // itemIds: interseção com a referência — fora dela vira FORA_DA_REFERENCIA.
    const t = depsJob();
    const r = await svc.iniciarAnalise({ cliente, contexto, body: { referencia: { id: "C-MLB1", tipo: "SELLER_CAMPAIGN" }, itemIds: ["mlb1", "MLB9"] } }, t.deps);
    await t.agendados[0]();
    const itens = t.repo.jobs.get(r.jobId).resultado.itens;
    assert.deepStrictEqual(itens.map((i) => [i.itemId, i.motivo]), [["MLB1", null], ["MLB9", "FORA_DA_REFERENCIA"]]);
    const inval = await svc.iniciarAnalise({ cliente, contexto, body: { referencia: { id: "C-MLB1", tipo: "SELLER_CAMPAIGN" }, itemIds: ["abc"] } }, depsJob().deps);
    assert.strictEqual(inval.httpStatus, 400);
    ok("itemIds: interseção com a referência; formato validado");
  }

  {
    // Universo ilegível → job em erro (nunca analisa um universo parcial).
    const t = depsJob({ mlFetch: async (_c, path) => (path.startsWith("/seller-promotions/users/")
      ? { ok: true, status: 200, data: { results: [{ id: "C-MLB1", type: "SELLER_CAMPAIGN", status: "started", name: "Vendex" }], paging: {} } }
      : { ok: false, status: 500, data: {} }) });
    await svc.iniciarAnalise({ cliente, contexto, body: { referencia: { id: "C-MLB1", tipo: "SELLER_CAMPAIGN" } } }, t.deps);
    await t.agendados[0]();
    assert.strictEqual(t.repo.jobs.get(1).status, "erro");
    assert.ok(/HTTP 500/.test(t.repo.jobs.get(1).erro));
    ok("itens da referência ilegíveis → job em erro com motivo");
  }

  // ── 8. Execução ───────────────────────────────────────────────────────────
  async function jobConcluido(extra = {}) {
    const promosPorItem = {
      MLB1: listaPadrao(),
      MLB2: [refAtiva(100), smart("P-B", { original: 100, meli: 5 })],
      MLB3: listaPadrao(),
      MLB4: [refAtiva(100), smart("P-D", { original: 100, meli: 5 })],
    };
    const t = depsJob({ ...extra, promosPorItem, mlFetch: mlFetchConta({ itens: ["MLB1", "MLB2", "MLB4"].map((id) => ({ id, status: "started", price: 100 })) }) });
    await svc.iniciarAnalise({ cliente, contexto, body: { referencia: { id: "C-MLB1", tipo: "SELLER_CAMPAIGN" } } }, t.deps);
    await t.agendados.shift()();
    return t;
  }

  {
    const t = await jobConcluido();
    const body = (escolhas) => ({ clienteSlug: "cliente-a", escolhas });
    const naoCandidata = await svc.iniciarExecucao({ jobId: 1, cliente, mlUserId: "111", body: body([{ itemId: "MLB1", promotionId: "P-RUIM", tipo: "SMART" }]) }, t.deps);
    assert.strictEqual(naoCandidata.httpStatus, 400);
    assert.strictEqual(naoCandidata.codigo, "ESCOLHA_INVALIDA", "promoção fora das candidatas do resultado");
    const tipoErrado = await svc.iniciarExecucao({ jobId: 1, cliente, mlUserId: "111", body: body([{ itemId: "MLB1", promotionId: "P-OK", tipo: "PRICE_MATCHING" }]) }, t.deps);
    assert.strictEqual(tipoErrado.codigo, "ESCOLHA_INVALIDA", "id certo com tipo errado");
    const duplicada = await svc.iniciarExecucao({ jobId: 1, cliente, mlUserId: "111", body: body([{ itemId: "MLB1", promotionId: "P-OK", tipo: "SMART" }, { itemId: "MLB1", promotionId: "P-OK", tipo: "SMART" }]) }, t.deps);
    assert.strictEqual(duplicada.codigo, "ESCOLHA_INVALIDA", "uma por item");
    const referencia = await svc.iniciarExecucao({ jobId: 1, cliente, mlUserId: "111", body: body([{ itemId: "MLB1", promotionId: "C-MLB1", tipo: "SELLER_CAMPAIGN" }]) }, t.deps);
    assert.strictEqual(referencia.codigo, "ESCOLHA_INVALIDA", "a referência nunca é escolha");
    const vazia = await svc.iniciarExecucao({ jobId: 1, cliente, mlUserId: "111", body: body([]) }, t.deps);
    assert.strictEqual(vazia.codigo, "ESCOLHA_INVALIDA");
    assert.strictEqual(t.agendados.length, 0, "escolha inválida não agenda nada");
    ok("execução: ESCOLHA_INVALIDA (fora das candidatas, tipo, duplicada, referência, vazia)");
  }

  {
    // Falha de um item não para os outros; cada participação vai ao log; a
    // referência nunca recebe escrita.
    const chamadas = [];
    const logs = [];
    const participar = async (args) => {
      chamadas.push(args);
      if (args.itemId === "MLB2") throw new Error("rede caiu");
      if (args.itemId === "MLB4") return { ok: false, codigo: "PROMOCAO_JA_PARTICIPA", motivo: "já participa" };
      return { ok: true, acao: "PARTICIPAR", promotionId: args.promotionId, tipo: args.tipo, precoConfirmado: 95 };
    };
    const t = await jobConcluido({ participar, registrarLog: async (l) => logs.push(l) });
    const escolhas = [
      { itemId: "MLB2", promotionId: "P-B", tipo: "SMART" },
      { itemId: "MLB1", promotionId: "P-OK", tipo: "SMART" },
      { itemId: "MLB4", promotionId: "P-D", tipo: "SMART" },
    ];
    const r = await svc.iniciarExecucao({ jobId: 1, cliente, mlUserId: "111", body: { escolhas }, user: { id: 7, email: "a@b", nome: "A" } }, t.deps);
    assert.deepStrictEqual(r, { ok: true });
    const emAndamento = await svc.iniciarExecucao({ jobId: 1, cliente, mlUserId: "111", body: { escolhas } }, t.deps);
    assert.strictEqual(emAndamento.codigo, "EXECUCAO_EM_ANDAMENTO");

    const pendente = (await svc.lerJob({ jobId: 1, cliente, mlUserId: "111" }, t.deps)).job;
    assert.strictEqual(pendente.fase, "execucao");
    assert.strictEqual(pendente.status, "processando");
    assert.deepStrictEqual(pendente.execucao.itens.map((i) => i.status), ["pendente", "pendente", "pendente"]);
    assert.ok(pendente.resultado, "o resultado da análise continua no job durante a execução");

    await t.agendados.shift()();
    assert.deepStrictEqual(chamadas.map((c) => c.itemId), ["MLB2", "MLB1", "MLB4"], "sequencial, na ordem, sem parar na falha");
    assert.ok(chamadas.every((c) => typeof c.antesDeEscrever === "function"), "toda escrita leva a revalidação");
    assert.ok(chamadas.every((c) => c.promotionId !== "C-MLB1"), "a referência nunca recebe escrita");

    const job = (await svc.lerJob({ jobId: 1, cliente, mlUserId: "111" }, t.deps)).job;
    assert.strictEqual(job.status, "concluido");
    assert.deepStrictEqual(job.execucao.itens.map((i) => [i.itemId, i.status, i.codigo, i.precoConfirmado]), [
      ["MLB2", "falha", "ERRO_INTERNO", null],
      ["MLB1", "ok", null, 95],
      ["MLB4", "falha", "PROMOCAO_JA_PARTICIPA", null],
    ]);
    assert.deepStrictEqual({ total: job.execucao.total, processados: job.execucao.processados }, { total: 3, processados: 3 });
    assert.strictEqual(logs.length, 3, "cada participação vai para o log de atividade");
    assert.ok(logs.every((l) => l.acao === "anuncios_meli.promocoes_rebate.participar" && l.userId === 7));
    assert.deepStrictEqual(logs.map((l) => l.status), ["erro", "sucesso", "erro"]);

    // Reexecutar só as falhas: novo POST; `execucao` passa a trazer só ele.
    chamadas.length = 0;
    const r2 = await svc.iniciarExecucao({ jobId: 1, cliente, mlUserId: "111", body: { escolhas: [escolhas[0]] } }, t.deps);
    assert.deepStrictEqual(r2, { ok: true });
    const marcado = (await svc.lerJob({ jobId: 1, cliente, mlUserId: "111" }, t.deps)).job;
    assert.deepStrictEqual([marcado.fase, marcado.status], ["execucao", "processando"], "marcado antes de responder");
    await t.agendados.shift()();
    const job2 = (await svc.lerJob({ jobId: 1, cliente, mlUserId: "111" }, t.deps)).job;
    assert.deepStrictEqual(chamadas.map((c) => c.itemId), ["MLB2"]);
    assert.deepStrictEqual(job2.execucao.itens.map((i) => [i.itemId, i.promotionId, i.tipo, i.status]), [["MLB2", "P-B", "SMART", "falha"]]);
    assert.deepStrictEqual({ total: job2.execucao.total, processados: job2.execucao.processados }, { total: 1, processados: 1 });
    ok("execução: sequencial, falha isolada, log por item, referência intocada, reexecução das falhas");
  }

  {
    // Revalidação antes de gravar: o gancho bloqueia com a releitura ao vivo.
    const revalidar = svc.criarRevalidacao(REF);
    const cand = smart("P-OK", { original: 100, meli: 5 });
    assert.deepStrictEqual(revalidar({ promo: cand, lista: [refAtiva(100), cand] }), { ok: true });
    assert.strictEqual(revalidar({ promo: cand, lista: [refAtiva(95), cand] }).codigo, "PRECO_NAO_MENOR", "referência baixou para o mesmo preço");
    assert.strictEqual(revalidar({ promo: cand, lista: [cand] }).codigo, "REFERENCIA_INATIVA");
    assert.strictEqual(revalidar({ promo: { ...cand, status: "started" }, lista: [refAtiva(100)] }).codigo, "PROMOCAO_JA_PARTICIPA");
    assert.strictEqual(revalidar({ promo: { ...cand, subsidioMl: 0 }, lista: [refAtiva(100)] }).codigo, "SEM_SUBSIDIO");
    const jaAtiva = normalizarPromocao({ id: "P-JA", type: "SMART", status: "started", ref_id: "OFFER-JA", price: 95, original_price: 100, meli_percentage: 5, name: "Smart já ativa" }, 0, "OFFER-JA");
    const r = revalidar({ promo: cand, lista: [refAtiva(100), jaAtiva, cand] });
    assert.strictEqual(r.codigo, "PRECO_NAO_MENOR", "promoção com rebate ativa a 95 — candidata a 95 não entraria");
    assert.ok(/Smart já ativa/.test(r.motivo));
    const barata = smart("P-B", { original: 100, meli: 10 });
    assert.deepStrictEqual(revalidar({ promo: barata, lista: [refAtiva(100), jaAtiva, barata] }), { ok: true });
    ok("revalidação antes de gravar: preço (contra o de hoje), referência ativa, candidate, subsídio");
  }

  {
    // Job interrompido no meio da execução: pendentes aparecem como falha.
    const row = {
      id: 3, fase: "execucao", status: "erro", erro: "Interrompido", referencia: { id: "C", tipo: "DEAL", nome: "x" },
      progresso_total: 2, progresso_processados: 2, resultado: { resumo: {}, itens: [] },
      execucao: { total: 2, processados: 1, itens: [
        { itemId: "MLB1", promotionId: "P", tipo: "SMART", status: "ok", codigo: null, motivo: null, precoConfirmado: 9 },
        { itemId: "MLB2", promotionId: "P", tipo: "SMART", status: "pendente", codigo: null, motivo: null, precoConfirmado: null },
      ] },
    };
    const j = svc.serializarJob(row);
    assert.strictEqual(j.execucao.itens[1].status, "falha");
    assert.strictEqual(j.execucao.itens[1].codigo, "INTERROMPIDO");
    assert.strictEqual(j.execucao.processados, 2);
    ok("execução interrompida: pendentes viram falha INTERROMPIDO na leitura");
  }

  {
    // Análise não concluída não executa.
    const t = depsJob();
    await svc.iniciarAnalise({ cliente, contexto, body: { referencia: { id: "C-MLB1", tipo: "SELLER_CAMPAIGN" } } }, t.deps);
    const r = await svc.iniciarExecucao({ jobId: 1, cliente, mlUserId: "111", body: { escolhas: [{ itemId: "MLB1", promotionId: "P-OK", tipo: "SMART" }] } }, t.deps);
    assert.strictEqual(r.codigo, "ANALISE_NAO_CONCLUIDA");
    ok("execução exige análise concluída");
  }

  // ── 9. Repositório SQL: forma das consultas ───────────────────────────────
  {
    const qs = [];
    const db = { async query(sql, params) { qs.push({ sql: String(sql).replace(/\s+/g, " "), params }); return { rows: [{ id: 5 }] }; } };
    const repo = svc.criarRepositorio(db);
    await repo.limparOrfaos({ clienteId: 1 });
    assert.ok(/status = 'erro'/.test(qs[0].sql) && /INTERVAL '1 minute'/.test(qs[0].sql));
    assert.strictEqual(qs[0].params[0], svc.JOB_ORFAO_MINUTOS);
    assert.strictEqual(svc.JOB_ORFAO_MINUTOS, 10, "órfão depois de 10 min sem atualização");
    assert.strictEqual(await repo.criar({ clienteId: 1, mlUserId: 111, referencia: REF, itemIds: null }), 5);
    assert.ok(/INSERT INTO promocoes_rebate_jobs/.test(qs[1].sql));
    assert.strictEqual(qs[1].params[4], "111");
    assert.strictEqual(await repo.iniciarExecucao(5, { itens: [] }), true);
    assert.ok(/status <> 'processando' AND resultado IS NOT NULL/.test(qs[2].sql), "execução só a partir de análise concluída e parada");
    ok("repositório: órfão 10 min, insert, transição condicional para execução");
  }

  // ── 10. Rotas antes de /:itemId ───────────────────────────────────────────
  {
    const router = require("../routes/meliAnunciosRoutes");
    const rotas = router.stack.filter((c) => c.route).map((c) => `${Object.keys(c.route.methods)[0]} ${c.route.path}`);
    const idx = (r) => rotas.indexOf(r);
    const primeiroItemId = rotas.findIndex((r) => r.split(" ")[1].startsWith("/:itemId"));
    for (const r of [
      "get /promocoes-rebate/referencias",
      "post /promocoes-rebate/analises",
      "get /promocoes-rebate/analises/:jobId",
      "post /promocoes-rebate/analises/:jobId/executar",
    ]) {
      assert.ok(idx(r) !== -1, `${r} registrada`);
      assert.ok(idx(r) < primeiroItemId, `${r} precisa vir antes de qualquer /:itemId`);
    }
    const idxCarteira = router.stack.findIndex((l) => !l.route && l.handle && l.handle.name === "carteiraClienteGuard");
    const idxRebate = router.stack.findIndex((l) => l.route && l.route.path === "/promocoes-rebate/referencias");
    assert.ok(idxCarteira !== -1 && idxCarteira < idxRebate, "mesma trava de carteira do módulo");
    ok("rotas de promoções com rebate registradas antes de /:itemId, atrás da carteira");
  }

  console.log(`\nmeliAnunciosPromocoesRebate.test.js: ${checks} verificações passaram.`);
}

run().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
