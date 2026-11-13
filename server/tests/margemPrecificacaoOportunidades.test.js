// server/tests/margemPrecificacaoOportunidades.test.js
// Oportunidades de preço/promoção da Central de Margem (sem N+1) e refresh
// pontual do Margin Snapshot pós-escrita. Fake db, nenhum ML.

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://127.0.0.1:1/vf-test";

const assert = require("assert");
const { listarOportunidades, motivoForaDoRanking, MOTIVO_FORA_DO_RANKING, rankearOportunidades, parseVeredito, parseOrdem, parseBusca } = require("../services/motorMargem/precificacao/precificacaoOportunidadesService");
const { atualizarSnapshotDoItem } = require("../services/motorMargem/precificacao/precificacaoSnapshotItem");
const { computeMargin } = require("../services/motorMargem/core/marginEngine");
const { elegiveisReferencia } = require("./helpers/oportunidadesReferencia");

const casos = [];
function cenario(nome, fn) {
  casos.push({ nome, fn });
}

cenario("oportunidade não recomenda ganho sobre retorno atual desconhecido", () => {
  const { montarCandidata } = require("../services/motorMargem/precificacao/precificacaoOportunidadesService");
  for (const modo of ["sem_leitura", "deal", "mudou", "vendedor"]) {
    const info = modo === "sem_leitura" ? null : { linhas: [{ status: "started", ativa: true,
      tipo: modo === "vendedor" ? "SELLER_CAMPAIGN" : "DEAL", precoOriginal: 120,
      precoFinal: modo === "mudou" ? 80 : 90 }], promocoes: 0 };
    const r = montarCandidata({ itemId: "MLB1", promocao: { status: "candidate" }, precoPromo: 85,
      precoOriginalPromo: 120, retornoMl: 10, vendasPorMlb: new Map(), rebateAtual: info,
      rebatePromoSnapshot: modo === "sem_leitura" ? null : { runId: 31 },
      snap: { price: 90, list_price: 120, cost: 40, tax_rate: 0.1, fixed_fee: 0,
        commission: 9, commission_rate: 0.1, freight: 10, anuncio_logistic_type: "xd_drop_off" } });
    assert.strictEqual(r.veredito, modo === "vendedor" ? "entrar" : "bloqueado", modo);
    if (modo !== "vendedor") assert.ok(r.bloqueios.includes("rebate_atual_indisponivel"), modo);
  }
});

function snapRow(itemId, o = {}) {
  const price = o.price ?? 100;
  const rate = o.rate === undefined ? 0.12 : o.rate;
  return {
    item_id: itemId, titulo: `Produto ${itemId}`, image_url: null, price, cost: o.cost === undefined ? 40 : o.cost,
    tax_rate: o.tax === undefined ? 0.1 : o.tax, fixed_fee: 0, commission_rate: rate, freight: o.freight === undefined ? 15 : o.freight,
    commission: o.commission === undefined ? Math.round(price * (rate ?? 0.12) * 100) / 100 : o.commission,
    margin: 0.2, status: "HEALTHY", quality_json: o.quality || {},
  };
}

function diagRow(itemId, o = {}) {
  return {
    item_id: itemId, titulo: null, campanha: o.campanha || "Campanha", campanha_id: o.id || `P-${itemId}`,
    tipo_promocao: o.tipo || "DEAL", preco_original: 100, preco_promocao: o.preco ?? 90, desconto_total: 10,
    seller_percentage: 5, meli_percentage: o.meli ?? 5, retorno_ml: o.retorno ?? 0, payload_raw: { status: o.status || "candidate" },
  };
}

const STATUS_OK = ["candidate", "started", "active", "pending"];

// As Oportunidades leem UMA consulta de ELEGÍVEIS (o banco só seleciona; o
// cálculo, a ordem e a página são do serviço); aqui ela é respondida pela
// referência JS da mesma seleção. O SQL real é conferido contra essa
// referência em scripts/promoSnapshotSqlCheck.js.
function fakeDb({ head = [{ id: 11, created_at: new Date().toISOString(), parcial: false, itens_scaneados: 120 }], itens = [], snaps = [], anuncios = [] } = {}) {
  const queries = [];
  return {
    queries,
    linhasDevolvidas: 0,
    async query(sql, params) {
      queries.push({ sql, params });
      if (/FROM promocoes_diagnosticos/.test(sql)) {
        if (head === "sem-tabela") { const e = new Error("relation does not exist"); e.code = "42P01"; throw e; }
        return { rows: head };
      }
      // Retorno ML das promoções em andamento (margem atual): por padrão, nenhuma.
      if (/FROM promo_snapshot_contas c/.test(sql)) return { rows: this.rebates || [] };
      if (/WITH promos AS/.test(sql) && /FROM promocoes_diagnostico_itens/.test(sql)) {
        const promos = itens
          .map((r, i) => ({ ...r, _status: String((r.payload_raw && (r.payload_raw.status || r.payload_raw.statusPromocao)) || "").toLowerCase(), _id: i + 1 }))
          .filter((r) => r.item_id && Number(r.preco_promocao) > 0 && (!r._status || STATUS_OK.includes(r._status)))
          .map((r) => ({
            item_id: r.item_id, chave: String(r._id).padStart(6, "0"), preco_promo: r.preco_promocao, retorno: r.retorno_ml,
            fonte_titulo: r.titulo, promo_nome: r.campanha, promo_id: r.campanha_id, promo_tipo: r.tipo_promocao, promo_status: r._status || null,
            promo_preco_original: r.preco_original === undefined ? null : r.preco_original,
          }));
        const snapPorItem = new Map(snaps.map((x) => [x.item_id, x]));
        const anuncioPorItem = new Map(anuncios.map((x) => [x.item_id, x]));
        const res = elegiveisReferencia({ promos, snapPorItem, anuncioPorItem });
        this.linhasDevolvidas = res.rows.length;
        return res;
      }
      throw new Error("SQL inesperado: " + sql);
    },
  };
}

function deps(db, vendas = new Map()) {
  return {
    db,
    resolverContaDoCliente: async () => ({ cliente: { id: 3, slug: "loja-a" }, conta: { id: 7, nome: "Conta A" } }),
    obterConta: async () => ({ id: 7, external_account_id: "555" }),
    carregarRealizada: async () => ({ porMlb: vendas, periodo: { dateFrom: "2026-08-31", dateTo: "2026-09-29" } }),
    now: () => new Date(),
    // Conta sem Promo Snapshot ainda: a Central cai no diagnóstico legado.
    promo: {
      estadoComAutoTrigger: async () => ({ estado: { state: "never_synced", hasSnapshot: false, workerEnabled: false }, gatilho: { acao: "worker_desabilitado" } }),
      syncPublico: (e, g) => ({ ...e, autoTrigger: g.acao }),
      listarElegiveis: async () => { throw new Error("não deveria ler o snapshot"); },
    },
  };
}

cenario("quem banca: cheio do item (list_price) → desconto sobre o cheio; sem ele, original_price da promoção; sem nenhum, null + sem_preco_cheio", async () => {
  const itens = [
    diagRow("MLB11", { preco: 90, retorno: 4.5 }),
    diagRow("MLB12", { preco: 90, retorno: 4.5 }),
    { ...diagRow("MLB13", { preco: 90, retorno: 4.5 }), preco_original: null },
  ];
  const snaps = [
    { ...snapRow("MLB11", { price: 100 }), list_price: 120 },
    snapRow("MLB12", { price: 100 }),
    snapRow("MLB13", { price: 100 }),
  ];
  const r = await listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 7, veredito: "todos" }, deps(fakeDb({ itens, snaps })));
  const por = Object.fromEntries(r.oportunidades.map((o) => [o.itemId, o]));
  assert.strictEqual(por.MLB11.preco_cheio, 120);
  assert.strictEqual(por.MLB11.preco_cheio_fonte, "margin_snapshot");
  assert.strictEqual(por.MLB11.desconto_total, 30);
  assert.strictEqual(por.MLB11.seller_banca, 25.5);
  assert.strictEqual(por.MLB11.delta_preco_atual, 10, "a queda contra o preço atual fica à parte");
  assert.strictEqual(por.MLB12.preco_cheio, 100, "diagRow: original_price 100");
  assert.strictEqual(por.MLB12.preco_cheio_fonte, "promo_snapshot");
  assert.strictEqual(por.MLB12.seller_banca, 5.5);
  assert.strictEqual(por.MLB13.seller_banca, null);
  assert.strictEqual(por.MLB13.banca_motivo, "sem_preco_cheio");
  assert.strictEqual(por.MLB13.ml_banca, 4.5);
  for (const o of r.oportunidades) {
    if (o.seller_banca !== null && o.seller_banca < 0) assert.ok(o.banca_aviso, `${o.itemId}: seller banca negativa sem aviso`);
  }
});

cenario("sem diagnóstico concluído (ou tabela inexistente): indisponível, com a explicação da dependência bulk", async () => {
  const r = await listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 7 }, deps(fakeDb({ head: [] })));
  assert.strictEqual(r.disponivel, false);
  // Sem Promo Snapshot e sem diagnóstico legado: indisponível, explicando o
  // estado da sincronização (não manda mais o operador para a tela antiga).
  assert.strictEqual(r.motivo, "SEM_SNAPSHOT_PROMOCOES");
  assert.ok(!/Promoções ML/.test(r.mensagem));
  const r2 = await listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 7 }, deps(fakeDb({ head: "sem-tabela" })));
  assert.strictEqual(r2.disponivel, false);
});

cenario("diagnóstico filtrado pela CONTA (seller_id = conta ML), nunca pelo cliente inteiro", async () => {
  const db = fakeDb({ head: [] });
  await listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 7 }, deps(db));
  const q = db.queries.find((x) => /promocoes_diagnosticos/.test(x.sql));
  assert.deepStrictEqual(q.params, [3, "555"]);
});

cenario("ranking explicável: veredito → com histórico → ΔLC × unidades; margem pelo marginEngine; 1 linha por item", async () => {
  const itens = [
    diagRow("MLB1", { retorno: 0 }),
    diagRow("MLB2", { retorno: 4.5 }),
    diagRow("MLB3", { retorno: 0 }),
    diagRow("MLB3", { id: "P-MLB3-b", retorno: 0, preco: 95 }),
    diagRow("MLB4", { retorno: 0, preco: 50 }), // LC' negativo → nao_entrar → fora da lista padrão
    diagRow("MLB5", { status: "finished" }), // indisponível → fora
    diagRow("MLB6", {}), // sem snapshot → fora
  ];
  const snaps = [snapRow("MLB1"), snapRow("MLB2"), snapRow("MLB3"), snapRow("MLB4"), snapRow("MLB5")];
  const vendas = new Map([["MLB1", { unidades: 3, receita: 300 }], ["MLB3", { unidades: 10, receita: 900 }]]);
  const r = await listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 7 }, deps(fakeDb({ itens, snaps }), vendas));
  assert.strictEqual(r.disponivel, true);
  // Os três perdem LC por unidade (entrar_se_girar): MLB1 (3 un × −7,80 = −23,40) antes de MLB3
  // (promoção de 95: 10 un × −3,90 = −39,00); MLB2 não tem histórico e vem depois dos que têm.
  assert.deepStrictEqual(r.oportunidades.map((o) => o.itemId), ["MLB1", "MLB3", "MLB2"]);
  assert.deepStrictEqual(r.oportunidades.map((o) => o.impacto_lc), [-23.4, -39, null]);
  assert.deepStrictEqual(r.oportunidades.map((o) => o.flags.sem_historico), [false, false, true]);
  const mlb2 = r.oportunidades[2];
  const esperado = computeMargin({ price: 90, cost: 40, taxRate: 0.1, fixedFee: 0, commission: 10.8, freight: 15, rebate: 4.5 });
  assert.strictEqual(mlb2.margemDepois, esperado.margin, "a conta é a do computeMargin (via calcularCenario)");
  assert.strictEqual(mlb2.lucroDepois, esperado.profit);
  assert.strictEqual(mlb2.estimado, true);
  assert.strictEqual(mlb2.cotacao.ao_vivo, false);
  assert.strictEqual(mlb2.flags.mudou_faixa_frete, null, "a faixa de frete só se sabe cotando: a lista não afirma");
  assert.strictEqual(mlb2.veredito, "entrar_se_girar");
  assert.strictEqual(mlb2.ml_banca, 4.5);
  assert.strictEqual(mlb2.seller_banca, 5.5);
  assert.ok(/retorno ML/.test(mlb2.motivo));
  const mlb3 = r.oportunidades[1];
  assert.strictEqual(mlb3.precoPromocao, 95, "MLB3: a melhor promoção do mesmo item (menor perda por unidade)");
  assert.strictEqual(mlb3.opcoes_total, 2);
  assert.strictEqual(r.fonte.frescor, "atual");
  assert.deepStrictEqual(r.filtro, { veredito: ["entrar", "entrar_se_girar"], tipo: null, busca: null, ordem: "impacto" });
  assert.deepStrictEqual(r.contagem, { entrar: 0, entrar_se_girar: 3, nao_entrar: 1, bloqueado: 0 });
});

cenario("`entrar` vem antes de `entrar_se_girar`; sem histórico, ΔLC por unidade; `veredito=todos` traz também nao_entrar", async () => {
  const itens = [
    diagRow("MLB1", { preco: 90, retorno: 0 }), // perde LC → entrar_se_girar
    diagRow("MLB2", { preco: 90, retorno: 12 }), // retorno cobre o desconto → entrar
    diagRow("MLB3", { preco: 90, retorno: 10 }), // entrar, ΔLC menor
    diagRow("MLB4", { preco: 30, retorno: 0 }), // nao_entrar
  ];
  const snaps = ["MLB1", "MLB2", "MLB3", "MLB4"].map((id) => snapRow(id));
  const vendas = new Map([["MLB1", { unidades: 50 }], ["MLB3", { unidades: 2 }]]);
  const padrao = await listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 7 }, deps(fakeDb({ itens, snaps }), vendas));
  // MLB3 tem histórico (2 un) e MLB2 não: dentro de `entrar`, quem tem histórico vem primeiro.
  assert.deepStrictEqual(padrao.oportunidades.map((o) => [o.itemId, o.veredito]), [["MLB3", "entrar"], ["MLB2", "entrar"], ["MLB1", "entrar_se_girar"]]);
  assert.ok(padrao.oportunidades[0].delta_lc >= 0 && padrao.oportunidades[2].delta_lc < 0);
  const todos = await listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 7, veredito: "todos" }, deps(fakeDb({ itens, snaps }), vendas));
  assert.deepStrictEqual(todos.oportunidades.map((o) => o.itemId), ["MLB3", "MLB2", "MLB1", "MLB4"]);
  assert.strictEqual(todos.oportunidades[3].veredito, "nao_entrar");
  assert.strictEqual(todos.oportunidades[3].empate_volume, null);
  assert.strictEqual(todos.filtro.veredito, "todos");
  assert.strictEqual(todos.total, 4);
  const so = await listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 7, veredito: "nao_entrar" }, deps(fakeDb({ itens, snaps }), vendas));
  assert.deepStrictEqual(so.oportunidades.map((o) => o.itemId), ["MLB4"]);
  assert.strictEqual(so.total, 1);
});

cenario("resumo (KPI Promos com +LC): quantos anúncios valem entrar e o impacto ΔLC × unidades dos que têm histórico", async () => {
  const itens = [
    diagRow("MLB1", { preco: 90, retorno: 12 }), // entrar, com histórico (2 un)
    diagRow("MLB2", { preco: 90, retorno: 12 }), // entrar, sem histórico
    diagRow("MLB3", { preco: 90, retorno: 0 }), // entrar_se_girar: não conta
  ];
  const snaps = ["MLB1", "MLB2", "MLB3"].map((id) => snapRow(id));
  const vendas = new Map([["MLB1", { unidades: 2 }], ["MLB3", { unidades: 9 }]]);
  const r = await listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 7, limit: 1 }, deps(fakeDb({ itens, snaps }), vendas));
  const mlb1 = (await listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 7, veredito: "todos" }, deps(fakeDb({ itens, snaps }), vendas))).oportunidades.find((o) => o.itemId === "MLB1");
  assert.strictEqual(r.resumo.entrar, 2);
  assert.strictEqual(r.resumo.com_historico, 1);
  assert.strictEqual(r.resumo.sem_historico, 1);
  assert.strictEqual(r.resumo.impacto_lc, mlb1.impacto_lc);
  assert.ok(mlb1.impacto_lc > 0);
  assert.strictEqual(r.oportunidades.length, 1, "o resumo não depende do tamanho da página");
  const vazio = await listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 7 }, deps(fakeDb({ itens: [diagRow("MLB9", { preco: 90 })], snaps: [snapRow("MLB9")] })));
  assert.deepStrictEqual(vazio.resumo, { entrar: 0, impacto_lc: 0, com_historico: 0, sem_historico: 0 });
});

cenario("sem histórico de vendas: flag sem_historico e ordem por ΔLC por unidade; vendas indisponíveis também não pesam", async () => {
  const itens = [diagRow("MLB1", { preco: 90, retorno: 1 }), diagRow("MLB2", { preco: 90, retorno: 6 })];
  const snaps = [snapRow("MLB1"), snapRow("MLB2")];
  const r = await listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 7, veredito: "todos" }, deps(fakeDb({ itens, snaps })));
  assert.deepStrictEqual(r.oportunidades.map((o) => o.itemId), ["MLB2", "MLB1"], "maior ΔLC por unidade primeiro");
  assert.ok(r.oportunidades.every((o) => o.flags.sem_historico === true && o.impacto_lc === null && o.unidades === 0));
  const d = deps(fakeDb({ itens, snaps }));
  d.carregarRealizada = async () => ({ porMlb: new Map(), periodo: null, indisponivel: { motivo: "SEM_SINCRONIZACAO", mensagem: "x" } });
  const indisp = await listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 7, veredito: "todos" }, d);
  assert.ok(indisp.oportunidades.every((o) => o.unidades === null && o.flags.sem_historico === true), "unidades null (não 0), sem peso no ranking");
});

cenario("insumo ausente não some da lista: vira `bloqueado` com o motivo (e nunca estima)", async () => {
  const itens = [diagRow("MLB1"), diagRow("MLB2"), diagRow("MLB3"), diagRow("MLB4")];
  const snaps = [
    snapRow("MLB1", { rate: null, commission: 12 }), // sem taxa de comissão: sem estimativa de comissão'
    snapRow("MLB2", { tax: null }), // sem imposto
    snapRow("MLB3", { freight: null }), // sem frete e logística desconhecida
    snapRow("MLB4", { cost: null }),
  ];
  const padrao = await listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 7 }, deps(fakeDb({ itens, snaps })));
  assert.strictEqual(padrao.oportunidades.length, 0, "a lista padrão só traz o que vale entrar");
  assert.strictEqual(padrao.contagem.bloqueado, 4);
  const todos = await listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 7, veredito: "bloqueado" }, deps(fakeDb({ itens, snaps })));
  const motivos = Object.fromEntries(todos.oportunidades.map((o) => [o.itemId, o.veredito_motivo]));
  assert.deepStrictEqual(motivos, { MLB1: "comissao_indisponivel", MLB2: "aliquota_ausente", MLB3: "frete_atual_ausente", MLB4: "custo_ausente" });
  assert.ok(todos.oportunidades.every((o) => o.margemDepois === null && o.lucroDepois === null && o.delta_lc === null));
});

cenario("logística combinável: frete ausente é zero DECLARADO (não bloqueia); o tipo vem do cadastro do anúncio", async () => {
  const itens = [diagRow("MLB1", { preco: 90 }), diagRow("MLB2", { preco: 90 })];
  const snaps = [snapRow("MLB1", { freight: null }), snapRow("MLB2", { freight: null })];
  const anuncios = [{ item_id: "MLB1", logistic_type: "custom" }]; // MLB2 sem cadastro
  const r = await listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 7, veredito: "todos" }, deps(fakeDb({ itens, snaps, anuncios })));
  const por = Object.fromEntries(r.oportunidades.map((o) => [o.itemId, o]));
  assert.notStrictEqual(por.MLB1.veredito, "bloqueado");
  assert.strictEqual(por.MLB1.cenario.frete, 0);
  assert.strictEqual(por.MLB2.veredito, "bloqueado");
});

cenario("margem atual com retorno ML da promoção em andamento: ΔLC parte da MESMA composição de hoje; rebate ambíguo bloqueia", async () => {
  const itens = [diagRow("MLB1", { preco: 90 }), diagRow("MLB2", { preco: 90 })];
  const snaps = [snapRow("MLB1"), snapRow("MLB2")];
  const sem = await listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 7 }, deps(fakeDb({ itens, snaps })));
  const db = fakeDb({ itens, snaps });
  // Promo Snapshot real: MLB1 com a SMART que forma o preço (100) cofinanciada
  // em 3% de 110 = 3,30; MLB2 com duas iniciadas no MESMO preço e financiamento
  // diferente (nenhuma confirmada pelo sale_price) → ambíguo.
  const promo = (o) => ({ current_run_id: 41, snapshot_at: "2026-11-12T18:00:00Z", status: "started", promotion_type: "SMART", preco_final: "100", preco_original: "110", seller_percentage: null, observed_at: "2026-11-12T18:00:00Z", ...o });
  db.rebates = [
    promo({ item_id: "MLB1", promotion_id: "P-1", ativa: true, meli_percentage: "3", subsidio_ml: "3.30" }),
    promo({ item_id: "MLB2", promotion_id: "P-2", ativa: null, meli_percentage: "3", subsidio_ml: "3.30" }),
    promo({ item_id: "MLB2", promotion_id: "P-3", ativa: null, meli_percentage: "5", subsidio_ml: "5.50" }),
  ];
  const com = await listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 7, veredito: "todos" }, deps(db));
  const a = Object.fromEntries(sem.oportunidades.map((o) => [o.itemId, o]));
  const b = Object.fromEntries(com.oportunidades.map((o) => [o.itemId, o]));
  assert.strictEqual(b.MLB1.margemAtualRebate, 3.3);
  assert.strictEqual(b.MLB1.atual.lc, Math.round((a.MLB1.atual.lc + 3.3) * 100) / 100, "LC de hoje inclui o retorno");
  assert.strictEqual(Math.round((a.MLB1.delta_lc - b.MLB1.delta_lc) * 100) / 100, 3.3, "ΔLC é medido contra a margem de hoje com retorno");
  assert.strictEqual(b.MLB2.veredito, "bloqueado");
  assert.strictEqual(b.MLB2.veredito_motivo, "rebate_ambiguo");
  assert.strictEqual(b.MLB2.flags.rebate_ambiguo, true);
});

cenario("filtro por tipo de promoção: considera só as promoções daquele tipo (melhor por anúncio), lista os tipos e as outras opções do anúncio", async () => {
  const itens = [
    diagRow("MLB1", { id: "A", tipo: "DEAL", preco: 90 }),
    diagRow("MLB1", { id: "B", tipo: "SMART", preco: 92, retorno: 6 }),
    diagRow("MLB1", { id: "C", tipo: "DEAL", preco: 88 }),
    diagRow("MLB2", { id: "D", tipo: "DEAL", preco: 90 }),
    diagRow("MLB3", { id: "E", tipo: "SMART", preco: 91, retorno: 6 }),
  ];
  const snaps = ["MLB1", "MLB2", "MLB3"].map((id) => snapRow(id));
  const todas = await listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 7, veredito: "todos" }, deps(fakeDb({ itens, snaps })));
  assert.deepStrictEqual(todas.tipos, [{ tipo: "DEAL", total: 3 }, { tipo: "SMART", total: 2 }]);
  const mlb1 = todas.oportunidades.find((o) => o.itemId === "MLB1");
  assert.strictEqual(mlb1.opcoes_total, 3);
  assert.strictEqual(mlb1.opcoes.length, 2, "as outras promoções do anúncio, para a linha expansível");
  assert.ok(mlb1.opcoes.every((o) => o.promocao && o.veredito && "delta_lc" in o && "seller_banca" in o && "flags" in o));
  assert.ok(!("opcoes" in mlb1.opcoes[0]), "a opção é um resumo, não uma linha completa");
  const so = await listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 7, veredito: "todos", tipo: "deal" }, deps(fakeDb({ itens, snaps })));
  assert.deepStrictEqual(so.oportunidades.map((o) => o.itemId).sort(), ["MLB1", "MLB2"]);
  assert.ok(so.oportunidades.every((o) => o.promocao.tipo === "DEAL"));
  assert.strictEqual(so.oportunidades.find((o) => o.itemId === "MLB1").opcoes_total, 2, "opções contadas dentro do tipo");
  assert.strictEqual(so.filtro.tipo, "deal");
  assert.deepStrictEqual(so.tipos.map((t) => t.tipo), ["DEAL", "SMART"], "a lista de tipos não depende do filtro");
});

function cotacaoViva({ falhaItens = [], freteBaixo = [] } = {}) {
  const chamadas = [];
  return {
    chamadas,
    buscarComissaoEFrete: async (args) => {
      chamadas.push(args);
      if (falhaItens.includes(args.itemId)) return { comissaoValor: null, fretePrevisto: null };
      return { comissaoValor: Math.round(args.precoEfetivo * 0.12 * 100) / 100, comissaoPercentual: 0.12, fretePrevisto: freteBaixo.includes(args.itemId) ? 0 : 15 };
    },
    mlFetch: async () => ({ ok: true, status: 200, data: {} }),
    obterAnuncios: async (clienteId, ids) => new Map(ids.map((id) => [id, { item_id: id, listing_type_id: "gold_special", category_id: "MLB1", logistic_type: "xd_drop_off" }])),
  };
}

cenario("?cotacao=viva: só a PÁGINA é cotada ao vivo; faixa de frete real; cotação que falha vira `bloqueado` na própria linha", async () => {
  const itens = [diagRow("MLB1", { preco: 90, retorno: 8 }), diagRow("MLB2", { preco: 90, retorno: 8 }), diagRow("MLB3", { preco: 90, retorno: 8 }), diagRow("MLB4", { preco: 90, retorno: 8 })];
  const snaps = itens.map((r) => snapRow(r.item_id));
  const vivo = cotacaoViva({ falhaItens: ["MLB2"], freteBaixo: ["MLB1"] });
  const d = { ...deps(fakeDb({ itens, snaps })), ...vivo };
  const estimada = await listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 7, veredito: "todos", limit: 3 }, d);
  assert.deepStrictEqual(vivo.chamadas, [], "sem ?cotacao=viva a lista não consulta o ML");
  assert.strictEqual(estimada.cotacao.modo, "estimada");
  assert.ok(estimada.oportunidades.every((o) => o.estimado === true && o.cotacao.ao_vivo === false && o.flags.mudou_faixa_frete === null));
  assert.ok(estimada.oportunidades.every((o) => o.numeros.origem === "estimativa" && o.numeros.motivo === "comissao_e_frete_do_snapshot"));

  const r = await listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 7, veredito: "todos", limit: 3, cotacao: "viva" }, d);
  assert.strictEqual(r.cotacao.modo, "viva");
  assert.strictEqual(vivo.chamadas.length, 3, "UMA cotação por linha da página (3), não do catálogo (4)");
  assert.deepStrictEqual(r.oportunidades.map((o) => o.itemId).sort(), estimada.oportunidades.map((o) => o.itemId).sort(), "mesma página da estimativa");
  const por = Object.fromEntries(r.oportunidades.map((o) => [o.itemId, o]));
  const ids = Object.keys(por);
  for (const id of ids) {
    const o = por[id];
    if (id === "MLB2") {
      assert.strictEqual(o.veredito, "bloqueado");
      assert.strictEqual(o.veredito_motivo, "comissao_indisponivel");
      assert.strictEqual(o.cenario.lc, null);
      assert.strictEqual(o.cotacao.evidencia.comissao.motivo, "ml_indisponivel");
      assert.strictEqual(o.estimado, false, "falha de cotação não volta para a estimativa");
      assert.strictEqual(o.cotacao.ao_vivo, false, "cotação que falhou NUNCA é rotulada ao vivo");
      assert.strictEqual(o.cotacao.falhou, true);
      assert.deepStrictEqual(o.numeros, { origem: "bloqueado", motivo: "cotacao_indisponivel" });
    } else {
      // Lista do DIAGNÓSTICO LEGADO: comissão e frete são reais, mas P' e o retorno ML não são os que o /simular lê.
      assert.strictEqual(o.estimado, true, "lista legada: a linha é estimativa mesmo com a cotação ao vivo");
      assert.deepStrictEqual(o.numeros, { origem: "estimativa", motivo: "lista_do_diagnostico_legado" });
      assert.strictEqual(o.lista.fonte, "diagnostico_legado");
      assert.strictEqual(o.cotacao.ao_vivo, true);
      assert.strictEqual(o.cenario.comissao, 10.8);
      assert.strictEqual(o.flags.mudou_faixa_frete, id === "MLB1", `${id}: o frete caiu de 15 para 0 só no MLB1`);
    }
  }
  assert.strictEqual(por.MLB1.cenario.frete, 0);
  assert.strictEqual(por.MLB1.atual.frete, 15);
  assert.ok(vivo.chamadas.every((c) => c.mlUserId === "555" && c.sellerId === "555" && c.precoEfetivo === 90 && c.listingTypeId === "gold_special"), "token e seller da conta");
  // a ordem da página é refeita pelo mesmo critério: bloqueado por último
  assert.strictEqual(r.oportunidades[r.oportunidades.length - 1].itemId, "MLB2");
});

// ── Origem dos números linha a linha: o que é "cotação ao vivo" de verdade ──────

// Mundo do /simular com os MESMOS dados da linha do Promo Snapshot abaixo (preço 100, custo 40,
// imposto 10%, comissão 12%, frete 15, preço cheio 120; promoção a 90 com retorno ML de 4,50).
function simularEquivalente(deps = {}) {
  const service = require("../services/motorMargem/margemSimularService");
  const conta = { id: 7, cliente_id: 3, marketplace: "meli", nome: "Conta A", ativo: true, external_account_id: "555" };
  const linhaBase = {
    itemId: "MLB1", sku: null, titulo: "Produto MLB1", marketplace: "meli", baseId: 3, price: 100, listPrice: 120, cost: 40, taxRate: 0.1,
    fixedFee: 0, commission: 12, commissionRate: 0.12, freight: 15, status: "HEALTHY", assumed: [], missing: [], refreshStatus: "fresh",
    calculatedAt: "2026-10-13T06:00:00.000Z", observedAt: "2026-10-13T06:00:00.000Z", runId: 7, quality: {}, catalogMissingSince: null,
  };
  const promocao = {
    itemId: "MLB1", promocaoChave: "k1", promotionId: "P-1", refId: null, tipo: "DEAL", tipoConhecido: true, nome: "Promo 1", status: "candidate",
    statusExibicao: "ELEGÍVEL", inicio: null, fim: null, precoOriginal: 120, precoFinal: 90, precoFinalFonte: "ml", sellerPercentage: 20, meliPercentage: 3.75,
    subsidioMl: 4.5, elegivel: true, observedAt: "2026-10-14T03:00:00.000Z", herdada: false,
  };
  const w = {
    db: {}, now: () => new Date("2026-10-14T12:00:00.000Z"), logger: { error() {}, warn() {}, info() {} },
    assertContaNaCarteira: async () => ({ contaId: 7, clienteId: 3, clienteSlug: "loja-a" }),
    obterConta: async () => conta,
    snapshotRepo: { getProjectionSnapshot: async () => ({ ...linhaBase }) },
    obterAnuncio: async () => ({ item_id: "MLB1", ml_user_id: "555", listing_type_id: "gold_special", category_id: "MLB1", logistic_type: "xd_drop_off" }),
    promoService: { estadoSincronizacao: async () => ({ hasSnapshot: true, snapshotRunId: 9, snapshotAt: "2026-10-14T03:00:00.000Z", partial: false }) },
    promoRepo: { listarLinhasSnapshot: async () => ({ total: 1, linhas: [promocao] }) },
    carregarRebates: async () => ({ porItem: new Map(), indisponivel: null }),
    buscarComissaoEFrete: async (args) => ({ comissaoValor: Math.round(args.precoEfetivo * 0.12 * 100) / 100, comissaoPercentual: 0.12, fretePrevisto: 15 }),
    mlFetch: async () => ({ ok: true, status: 200, data: {} }),
    ...deps,
  };
  return () => service.simular({ user: { id: 1 }, body: { cliente_conta_id: 7, mlb: "MLB1", cenarios: [{ tipo: "promo", promotion_id: "P-1" }] } }, w);
}

function depsSnapshot(d) {
  const promos = [{ item_id: "MLB1", chave: "k1", preco_promo: 90, retorno: 4.5, promo_status: "candidate", promo_id: "P-1", promo_tipo: "DEAL", promo_status_exibicao: "ELEGÍVEL", promo_preco_original: 120 }];
  const snapPorItem = new Map([["MLB1", { ...snapRow("MLB1", { price: 100 }), list_price: 120 }]]);
  d.promo = {
    estadoComAutoTrigger: async () => ({ estado: { state: "ready", hasSnapshot: true, snapshotRunId: 9, snapshotAt: new Date().toISOString(), total: 1, workerEnabled: true }, gatilho: { acao: "nenhuma" } }),
    syncPublico: (e) => ({ ...e }),
    listarElegiveis: async () => elegiveisReferencia({ promos, snapPorItem }),
  };
  return d;
}

cenario("fonte PROMO SNAPSHOT + cotação ao vivo completa: a linha É o /simular (mesmos números, mesmo veredito); sem cotação, é estimativa", async () => {
  const vivo = cotacaoViva();
  const d = depsSnapshot({ ...deps(fakeDb()), ...vivo });
  const estimada = (await listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 7, veredito: "todos" }, d)).oportunidades[0];
  assert.deepStrictEqual(estimada.numeros, { origem: "estimativa", motivo: "comissao_e_frete_do_snapshot" });
  assert.strictEqual(estimada.estimado, true);
  assert.strictEqual(estimada.lista.fonte, "promo_snapshot");

  const linha = (await listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 7, veredito: "todos", cotacao: "viva" }, d)).oportunidades[0];
  assert.deepStrictEqual(linha.numeros, { origem: "simular", motivo: null });
  assert.strictEqual(linha.estimado, false);
  assert.strictEqual(linha.cotacao.ao_vivo, true);

  const simulado = await simularEquivalente()();
  const sim = simulado.cenarios[0];
  for (const campo of ["veredito", "motivo", "delta_lc", "delta_margem_ratio", "empate_volume", "preco_cheio", "desconto_total", "desconto_ratio", "ml_banca", "seller_banca", "delta_preco_atual"]) {
    assert.deepStrictEqual(linha[campo === "motivo" ? "veredito_motivo" : campo], sim[campo], `campo ${campo}: a linha ao vivo difere do /simular`);
  }
  assert.deepStrictEqual(linha.cenario, sim.cenario, "mesma composição do cenário (comissão e frete cotados em P')");
  for (const campo of ["preco", "imposto", "comissao", "frete", "taxa_fixa", "custo", "rebate", "lc", "margem_ratio"]) {
    assert.strictEqual(linha.atual[campo], simulado.atual[campo], `Hoje.${campo}: a linha difere do /simular`);
  }
  assert.strictEqual(linha.flags.mudou_faixa_frete, sim.flags.mudou_faixa_frete);
});

cenario("cotação ao vivo INCOMPLETA (só a comissão veio): `ao_vivo` false, linha bloqueada com o porquê — nunca 'ao vivo'", async () => {
  const vivo = cotacaoViva();
  vivo.buscarComissaoEFrete = async (args) => ({ comissaoValor: Math.round(args.precoEfetivo * 0.12 * 100) / 100, comissaoPercentual: 0.12, fretePrevisto: null });
  const d = depsSnapshot({ ...deps(fakeDb()), ...vivo });
  const linha = (await listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 7, veredito: "todos", cotacao: "viva" }, d)).oportunidades[0];
  assert.strictEqual(linha.veredito, "bloqueado");
  assert.strictEqual(linha.cotacao.ao_vivo, false);
  assert.strictEqual(linha.cotacao.falhou, true);
  assert.strictEqual(linha.numeros.origem, "bloqueado");
  assert.strictEqual(linha.flags.mudou_faixa_frete, null);
});

cenario("?cotacao desconhecida: 400; padrão é a estimativa", async () => {
  const db = fakeDb({ itens: [diagRow("MLB1")], snaps: [snapRow("MLB1")] });
  await assert.rejects(
    () => listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 7, cotacao: "agora" }, deps(db)),
    (err) => err.statusCode === 400 && err.code === "FILTRO_INVALIDO"
  );
  assert.strictEqual(db.queries.length, 0);
});

cenario("filtro `veredito` desconhecido: 400 antes de qualquer leitura (nunca ignorado em silêncio)", async () => {
  const db = fakeDb({ itens: [diagRow("MLB1")], snaps: [snapRow("MLB1")] });
  await assert.rejects(
    () => listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 7, veredito: "talvez" }, deps(db)),
    (err) => err.statusCode === 400 && err.code === "FILTRO_INVALIDO"
  );
  assert.strictEqual(db.queries.length, 0);
  assert.deepStrictEqual(parseVeredito(undefined), ["entrar", "entrar_se_girar"]);
  assert.deepStrictEqual(parseVeredito("Entrar, nao_entrar"), ["entrar", "nao_entrar"]);
  assert.strictEqual(parseVeredito("todos"), null);
});

cenario("controllers repassam veredito, tipo, busca, ordem, cotacao, página e período ao serviço (e erro 400 do serviço chega como 400)", async () => {
  const { createPromoSnapshotController } = require("../controllers/promoSnapshotController");
  const { createMargemPrecificacaoController } = require("../controllers/margemPrecificacaoController");
  const query = { clienteContaId: "7", veredito: "todos", tipo: "DEAL", busca: "calça", ordem: "subsidio", cotacao: "viva", page: "2", limit: "10", periodo: "2026-09" };
  const esperado = { clienteSlug: "loja-a", clienteContaId: "7", periodo: "2026-09", veredito: "todos", tipo: "DEAL", busca: "calça", ordem: "subsidio", cotacao: "viva", page: "2", limit: "10" };
  for (const criar of [
    (oportunidades) => createPromoSnapshotController({ oportunidades }),
    (oportunidades) => createMargemPrecificacaoController({ oportunidades }),
  ]) {
    let recebido = null;
    const ctrl = criar({ listarOportunidades: async (p) => { recebido = p; return { ok: true, oportunidades: [] }; } });
    const res = { status(c) { this.codigo = c; return this; }, json(b) { this.corpo = b; return this; } };
    await ctrl.listarOportunidades({ params: { clienteSlug: "loja-a" }, query, user: { id: 1 } }, res);
    assert.deepStrictEqual(recebido, esperado);
    assert.strictEqual(res.codigo, 200);
    const ruim = criar({ listarOportunidades: async () => { const e = new Error("x"); e.statusCode = 400; e.payload = { ok: false, codigo: "FILTRO_INVALIDO" }; throw e; } });
    const res2 = { status(c) { this.codigo = c; return this; }, json(b) { this.corpo = b; return this; } };
    await ruim.listarOportunidades({ params: { clienteSlug: "loja-a" }, query: { clienteContaId: "7", veredito: "x" }, user: { id: 1 } }, res2);
    assert.strictEqual(res2.codigo, 400);
    assert.strictEqual(res2.corpo.codigo, "FILTRO_INVALIDO");
  }
});

cenario("rankearOportunidades é pura e estável: mesma entrada embaralhada → mesma página", () => {
  const mk = (itemId, delta, unidades) => ({
    itemId, veredito: delta >= 0 ? "entrar" : "entrar_se_girar", delta_lc: delta, impacto_lc: unidades ? delta * unidades : null,
    flags: { sem_historico: !unidades }, promocao: { chave: itemId },
  });
  const base = [mk("A", 2, 10), mk("B", 5, 1), mk("C", -1, 4), mk("D", 1, 0), mk("E", 3, 0), mk("F", -4, 9)];
  const esperado = rankearOportunidades(base, { page: 1, limit: 10 }).pagina.map((c) => c.itemId);
  assert.deepStrictEqual(esperado, ["A", "B", "E", "D", "C", "F"]);
  for (const shuffled of [[...base].reverse(), [base[3], base[0], base[5], base[1], base[4], base[2]]]) {
    assert.deepStrictEqual(rankearOportunidades(shuffled, { page: 1, limit: 10 }).pagina.map((c) => c.itemId), esperado);
  }
  const p2 = rankearOportunidades(base, { page: 2, limit: 4 });
  assert.deepStrictEqual([p2.total, p2.hasNext, p2.pagina.map((c) => c.itemId)], [6, false, ["C", "F"]]);
});

cenario("busca (título/MLB, sem acento) recorta ANTES da contagem; ordem só muda a sequência, nunca a melhor promoção", () => {
  const mk = (itemId, titulo, veredito, delta, unidades, extra = {}) => ({
    itemId, titulo, veredito, delta_lc: delta, impacto_lc: unidades ? delta * unidades : null,
    flags: { sem_historico: !unidades }, promocao: { chave: itemId + ":" + (extra.chave || "p"), fim: extra.fim || null, tipo: extra.tipo || "DEAL" },
    ml_banca: extra.ml === undefined ? null : extra.ml, margemDepois: extra.margem === undefined ? null : extra.margem,
    desconto_ratio: extra.desc === undefined ? null : extra.desc,
  });
  const base = [
    mk("MLB100", "Calça Jeans Mom Clara", "entrar", 2, 10, { ml: 5, margem: 0.2, desc: 0.1, fim: "2026-11-20T00:00:00Z" }),
    mk("MLB200", "Calça jeans skinny", "entrar_se_girar", -1, 4, { ml: 9, margem: 0.12, desc: 0.2, fim: "2026-11-10T00:00:00Z" }),
    mk("MLB300", "Jaqueta Jeans", "nao_entrar", -5, 3, { ml: null, margem: 0.01, desc: 0.3 }),
    mk("MLB400", "Bermuda Sarja", "entrar", 1, 0, { ml: 1, margem: 0.3, desc: 0.05, fim: "2026-11-05T00:00:00Z" }),
    // Mesmo anúncio, promoção pior: a melhor (impacto) continua sendo a linha, qualquer que seja a ordem.
    mk("MLB100", "Calça Jeans Mom Clara", "entrar_se_girar", -3, 10, { ml: 50, chave: "q" }),
  ];
  const r = rankearOportunidades(base, { page: 1, limit: 10, veredito: null, busca: "calca" });
  assert.deepStrictEqual(r.pagina.map((c) => c.itemId), ["MLB100", "MLB200"], "sem acento e sem caixa");
  assert.deepStrictEqual([r.total, r.contagem.entrar, r.contagem.entrar_se_girar, r.contagem.nao_entrar], [2, 1, 1, 0], "contagem do mesmo recorte");
  assert.strictEqual(r.pagina[0].promocao.chave, "MLB100:p", "a melhor promoção do anúncio não muda");
  assert.deepStrictEqual(rankearOportunidades(base, { page: 1, limit: 10, veredito: null, busca: "300" }).pagina.map((c) => c.itemId), ["MLB300"], "número do MLB sem o prefixo");
  assert.deepStrictEqual(rankearOportunidades(base, { page: 1, limit: 10, veredito: null, busca: "mlb4" }).pagina.map((c) => c.itemId), ["MLB400"]);
  const ordem = (o) => rankearOportunidades(base, { page: 1, limit: 10, veredito: null, ordem: o }).pagina.map((c) => c.itemId);
  assert.deepStrictEqual(ordem(null), ["MLB100", "MLB400", "MLB200", "MLB300"]);
  assert.deepStrictEqual(ordem("subsidio"), ["MLB200", "MLB100", "MLB400", "MLB300"], "maior ML banca primeiro; sem valor no fim");
  assert.deepStrictEqual(ordem("lucro"), ["MLB100", "MLB400", "MLB200", "MLB300"]);
  assert.deepStrictEqual(ordem("margem"), ["MLB400", "MLB100", "MLB200", "MLB300"]);
  assert.deepStrictEqual(ordem("desconto"), ["MLB300", "MLB200", "MLB100", "MLB400"]);
  assert.deepStrictEqual(ordem("fim"), ["MLB400", "MLB200", "MLB100", "MLB300"], "termina antes primeiro; sem data no fim");
  assert.strictEqual(parseOrdem("impacto"), null);
  assert.strictEqual(parseOrdem(""), null);
  assert.throws(() => parseOrdem("preco"), (e) => e.statusCode === 400 || e.status === 400 || /ordem/.test(e.message));
  assert.strictEqual(parseBusca("   "), null);
  assert.strictEqual(parseBusca("x".repeat(200)).length, 80);
});

cenario("motivoForaDoRanking: started/active = ativa; P' >= preço atual (ou sem preço atual) = sem_desconto_efetivo; senão elegível", () => {
  assert.strictEqual(motivoForaDoRanking({ status: "started", precoPromo: 90, precoAtual: 100 }), MOTIVO_FORA_DO_RANKING.ATIVA);
  assert.strictEqual(motivoForaDoRanking({ status: "ACTIVE", precoPromo: 90, precoAtual: 100 }), "ativa");
  assert.strictEqual(motivoForaDoRanking({ status: "candidate", precoPromo: 100, precoAtual: 100 }), "sem_desconto_efetivo", "P' igual ao atual não é desconto");
  assert.strictEqual(motivoForaDoRanking({ status: "candidate", precoPromo: 104, precoAtual: 100 }), "sem_desconto_efetivo");
  assert.strictEqual(motivoForaDoRanking({ status: "pending", precoPromo: 90, precoAtual: null }), "sem_desconto_efetivo", "sem preço atual não afirma desconto");
  assert.strictEqual(motivoForaDoRanking({ status: "candidate", precoPromo: 94.9 - 5.13, precoAtual: 94.9 }), null);
  assert.strictEqual(motivoForaDoRanking({ status: null, precoPromo: 90, precoAtual: 100 }), null, "status vazio (legado) segue aceito");
});

cenario("fonte LEGADA: promoção started/active e P' >= preço atual ficam fora do ranking", async () => {
  const itens = [
    diagRow("MLB1", { preco: 90 }), // elegível
    diagRow("MLB2", { preco: 90, status: "started" }), // ativa
    diagRow("MLB3", { preco: 90, status: "active" }), // ativa
    diagRow("MLB4", { preco: 100 }), // P' = preço atual
    diagRow("MLB5", { preco: 105 }), // P' > preço atual
    diagRow("MLB6", { preco: 90, status: "pending" }), // elegível
  ];
  const snaps = ["MLB1", "MLB2", "MLB3", "MLB4", "MLB5", "MLB6"].map((id) => snapRow(id));
  const r = await listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 7 }, deps(fakeDb({ itens, snaps })));
  assert.strictEqual(r.fonte.tipo, "diagnostico_legado");
  assert.deepStrictEqual(r.oportunidades.map((o) => o.itemId).sort(), ["MLB1", "MLB6"]);
  assert.ok(r.oportunidades.every((o) => o.precoPromocao < o.precoAtual));
  assert.strictEqual(r.total, 2);
});

cenario("fonte PROMO SNAPSHOT: mesma regra — started/active e P' >= preço atual fora; o resto entra", async () => {
  const promos = [
    { item_id: "MLB1", chave: "a", preco_promo: 90, retorno: 0, promo_status: "candidate" },
    { item_id: "MLB2", chave: "b", preco_promo: 90, retorno: 3.3, promo_status: "started" },
    { item_id: "MLB3", chave: "c", preco_promo: 90, retorno: 0, promo_status: "active" },
    { item_id: "MLB4", chave: "d", preco_promo: 100, retorno: 0, promo_status: "candidate" },
    { item_id: "MLB5", chave: "e", preco_promo: 99.99, retorno: 0, promo_status: "pending" },
  ];
  const snapPorItem = new Map(["MLB1", "MLB2", "MLB3", "MLB4", "MLB5"].map((id) => [id, snapRow(id)]));
  const d = deps(fakeDb());
  d.promo = {
    estadoComAutoTrigger: async () => ({ estado: { state: "ready", hasSnapshot: true, snapshotRunId: 9, snapshotAt: new Date().toISOString(), total: 5, workerEnabled: true }, gatilho: { acao: "nenhuma" } }),
    syncPublico: (e) => ({ ...e }),
    listarElegiveis: async () => elegiveisReferencia({ promos, snapPorItem }),
  };
  const r = await listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 7 }, d);
  assert.strictEqual(r.fonte.tipo, "promo_snapshot");
  assert.deepStrictEqual(r.oportunidades.map((o) => o.itemId).sort(), ["MLB1", "MLB5"]);
  assert.ok(r.oportunidades.every((o) => o.precoPromocao < o.precoAtual && !["started", "active"].includes(o.promocao.status)));
});

cenario("promoção SEM promotion_id no snapshot: o id da linha cai na chave do snapshot (a mesma identidade do /simular) — o chip da worklist seleciona a promoção na Bancada", async () => {
  const promos = [
    { item_id: "MLB1", chave: "MLB1::SMART::0", preco_promo: 90, retorno: 0, promo_status: "candidate", promo_id: null, promo_tipo: "SMART" },
    { item_id: "MLB2", chave: "MLB2::DEAL::7", preco_promo: 90, retorno: 0, promo_status: "candidate", promo_id: "P-777", promo_tipo: "DEAL", promo_status_exibicao: "ELEGÍVEL" },
  ];
  const snapPorItem = new Map(["MLB1", "MLB2"].map((id) => [id, snapRow(id)]));
  const d = deps(fakeDb());
  d.promo = {
    estadoComAutoTrigger: async () => ({ estado: { state: "ready", hasSnapshot: true, snapshotRunId: 9, snapshotAt: new Date().toISOString(), total: 2, workerEnabled: true }, gatilho: { acao: "nenhuma" } }),
    syncPublico: (e) => ({ ...e }),
    listarElegiveis: async () => elegiveisReferencia({ promos, snapPorItem }),
  };
  const r = await listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 7 }, d);
  const por = Object.fromEntries(r.oportunidades.map((o) => [o.itemId, o.promocao]));
  assert.strictEqual(por.MLB1.id, "MLB1::SMART::0", "sem promotion_id: a chave");
  assert.strictEqual(por.MLB2.id, "P-777", "com promotion_id: ele");
  // Grupo e escrita suportada acompanham a promoção (a lista decide "Participar" só pelo que a Central escreve).
  assert.strictEqual(por.MLB2.grupo, "pode");
  assert.deepStrictEqual(por.MLB2.escrita, { suportada: true, acao: "PARTICIPAR", modo: "preco", motivo: null });
  // SMART: o ML define o preço — a Central participa no modo ACEITE (mesma lista de /anuncios).
  assert.strictEqual(por.MLB1.grupo, "pode", "SMART: aceite pelo VenForce");
  assert.deepStrictEqual(por.MLB1.escrita, { suportada: true, acao: "PARTICIPAR", modo: "aceite", motivo: null });
});

cenario("busca e ordem no SERVIÇO (Promo Snapshot): recortam a conta inteira ANTES da página, isoladas por conta, nulos no fim e desempate estável; sem parâmetro, a ordem padrão de sempre", async () => {
  // Duas contas do MESMO cliente com catálogos diferentes (e um título repetido): cada uma lê só o que é seu.
  const catalogo = {
    7: Array.from({ length: 30 }, (_, i) => ({ id: `MLB7${String(i).padStart(3, "0")}`, titulo: i % 3 === 0 ? `Calça Jeans ${i}` : `Bermuda ${i}`, retorno: i % 4 === 0 ? null : i % 5, desc: 5 + (i % 7) })),
    8: Array.from({ length: 25 }, (_, i) => ({ id: `MLB8${String(i).padStart(3, "0")}`, titulo: i % 2 === 0 ? `Calça Jeans ${i}` : `Saia ${i}`, retorno: i % 3, desc: 4 + (i % 5) })),
  };
  const pedidosConta = [];
  const depsDaConta = (contaId) => {
    const d = deps(fakeDb());
    d.resolverContaDoCliente = async (p) => ({ cliente: { id: 3, slug: "loja-a" }, conta: { id: Number(p.clienteContaId), nome: `Conta ${p.clienteContaId}` } });
    d.obterConta = async (id) => ({ id, external_account_id: `55${id}` });
    d.promo = {
      estadoComAutoTrigger: async () => ({ estado: { state: "ready", hasSnapshot: true, snapshotRunId: 9, snapshotAt: new Date().toISOString(), total: 30, workerEnabled: true }, gatilho: { acao: "nenhuma" } }),
      syncPublico: (e) => ({ ...e }),
      listarElegiveis: async ({ clienteContaId }) => {
        pedidosConta.push(clienteContaId);
        const itens = catalogo[clienteContaId] || [];
        const promos = itens.map((it) => ({ item_id: it.id, chave: `${it.id}::DEAL`, preco_promo: 100 - it.desc, retorno: it.retorno, promo_status: "candidate", promo_tipo: "DEAL" }));
        const snapPorItem = new Map(itens.map((it) => [it.id, { ...snapRow(it.id), titulo: it.titulo }]));
        return elegiveisReferencia({ promos, snapPorItem });
      },
    };
    return d;
  };
  const listar = (conta, extra) => listarOportunidades({ clienteSlug: "loja-a", clienteContaId: conta, veredito: "todos", limit: 4, ...extra }, depsDaConta(conta));

  // Sem parâmetro: exatamente a ordem padrão (veredito → impacto → item), página a página.
  const padrao = await listar(7, {});
  const padraoExplicito = await listar(7, { ordem: "impacto" });
  assert.deepStrictEqual(padrao.oportunidades.map((o) => o.itemId), padraoExplicito.oportunidades.map((o) => o.itemId));
  assert.deepStrictEqual(padrao.filtro.ordem, "impacto");

  // Busca: conta inteira ANTES da página (10 "Calça" na conta 7 → 3 páginas de 4), só da conta pedida.
  const paginas = [];
  for (let page = 1; page <= 3; page += 1) paginas.push(await listar(7, { busca: "calca", page }));
  assert.deepStrictEqual(paginas.map((p) => [p.total, p.hasNext, p.oportunidades.length]), [[10, true, 4], [10, true, 4], [10, false, 2]]);
  const ids = paginas.flatMap((p) => p.oportunidades.map((o) => o.itemId));
  assert.strictEqual(new Set(ids).size, 10, "nenhuma linha repetida ou perdida entre páginas");
  assert.ok(ids.every((id) => id.startsWith("MLB7")), "nada da conta 8");
  assert.ok(paginas.every((p) => p.oportunidades.every((o) => /Calça/.test(o.titulo))));
  const conta8 = await listar(8, { busca: "calca" });
  assert.strictEqual(conta8.total, 13);
  assert.ok(conta8.oportunidades.every((o) => o.itemId.startsWith("MLB8")), "nada da conta 7");
  assert.ok(pedidosConta.every((c) => c === 7 || c === 8) && pedidosConta.includes(8), "cada leitura com a conta explícita");

  // Ordem por subsídio do ML: decrescente na conta inteira (entre páginas), nulos no fim, desempate estável.
  const porSubsidio = [];
  for (let page = 1; page <= 8; page += 1) {
    const r = await listar(7, { ordem: "subsidio", page });
    porSubsidio.push(...r.oportunidades);
    if (!r.hasNext) break;
  }
  assert.strictEqual(porSubsidio.length, 30);
  const valores = porSubsidio.map((o) => o.ml_banca);
  const primeiroNulo = valores.findIndex((v) => v === null || v === undefined);
  const naoNulos = primeiroNulo === -1 ? valores : valores.slice(0, primeiroNulo);
  for (let i = 1; i < naoNulos.length; i += 1) assert.ok(naoNulos[i - 1] >= naoNulos[i], `subsídio fora de ordem: ${valores.join(",")}`);
  if (primeiroNulo !== -1) assert.ok(valores.slice(primeiroNulo).every((v) => v === null || v === undefined), "nulos sempre no fim");
  const repetido = [];
  for (let page = 1; page <= 8; page += 1) {
    const r = await listar(7, { ordem: "subsidio", page });
    repetido.push(...r.oportunidades.map((o) => o.itemId));
    if (!r.hasNext) break;
  }
  assert.deepStrictEqual(repetido, porSubsidio.map((o) => o.itemId), "mesma entrada → mesma sequência");

  // Parâmetro inválido recusa (400) antes de qualquer leitura; texto livre nunca vira SQL (a busca é no serviço).
  const antes = pedidosConta.length;
  await assert.rejects(() => listar(7, { ordem: "preco; DROP TABLE x" }), (e) => e.statusCode === 400 && e.code === "FILTRO_INVALIDO");
  assert.strictEqual(pedidosConta.length, antes, "nada lido com parâmetro inválido");
  const injecao = await listar(7, { busca: "'; DROP TABLE promo_snapshot_itens; --" });
  assert.strictEqual(injecao.total, 0);
});

cenario("performance: 3 consultas ao banco (cabeçalho, elegíveis, rebates da conta) para a conta inteira, página fatiada no serviço, zero ML", async () => {
  const itens = Array.from({ length: 300 }, (_, i) => diagRow(`MLB${i + 1}`));
  const snaps = itens.map((r) => snapRow(r.item_id));
  const db = fakeDb({ itens, snaps });
  const r = await listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 7, page: 3, limit: 20 }, deps(db));
  assert.strictEqual(db.queries.length, 3, "cabeçalho do diagnóstico + UMA consulta de elegíveis + UMA de rebates da conta (nunca por item)");
  const elegiveis = db.queries.find((q) => /WITH promos AS/.test(q.sql));
  const rebates = db.queries.find((q) => /FROM promo_snapshot_contas c/.test(q.sql));
  assert.strictEqual(rebates.params[3], null, "rebates da conta inteira numa consulta só");
  assert.ok(!/LIMIT|OFFSET/.test(elegiveis.sql), "a página não é do banco: a ordem depende do cálculo do núcleo");
  assert.ok(!/ROUND\(|margem_depois|lucro/i.test(elegiveis.sql), "nenhuma fórmula financeira no SQL");
  assert.strictEqual(db.linhasDevolvidas, 300);
  assert.deepStrictEqual([r.page, r.limit, r.total, r.hasNext, r.oportunidades.length], [3, 20, 300, true, 20]);
  const ultima = await listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 7, page: 6, limit: 50 }, deps(fakeDb({ itens, snaps })));
  assert.deepStrictEqual([ultima.hasNext, ultima.oportunidades.length], [false, 50]);
  const alem = await listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 7, page: 7, limit: 50 }, deps(fakeDb({ itens, snaps })));
  assert.deepStrictEqual([alem.hasNext, alem.oportunidades.length, alem.total], [false, 0, 300]);
});

// ── Refresh pontual do snapshot ────────────────────────────────────────────

cenario("snapshot do item: contexto SEM vendas, 1 item, run_id nulo, upsert com a conta explícita", async () => {
  const chamadas = { prepare: null, enrich: null, upsert: null };
  const item = {
    identity: { itemId: "MLB100", sku: "S", titulo: "T", image: null },
    fields: { price: { projected: { value: 114.9 } } },
    margin: { projected: { profit: 19.6, margin: 0.17, marginPercent: 17, missing: [], assumed: [] }, target: { marginTarget: 0.1 } },
    quality: { status: "HEALTHY", confidence: "HIGH", confidenceByField: {}, reasons: [], divergences: [] },
  };
  const r = await atualizarSnapshotDoItem(
    { clienteSlug: "loja-a", clienteId: 3, clienteContaId: 7, itemId: "MLB100" },
    {
      limiter: { aguardarVez: async () => {} },
      prepareWorkspaceContext: async (params, d) => { chamadas.prepare = { params, vendas: await d.carregarVendas() }; return { base: { id: 4 }, now: new Date("2026-09-30T12:00:00Z") }; },
      enrichBatch: async (_p, opts) => { chamadas.enrich = opts; return { itens: [item] }; },
      upsertProjectionSnapshot: async (dados) => { chamadas.upsert = dados; },
    }
  );
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(chamadas.prepare.params, { clienteSlug: "loja-a", clienteContaId: 7 });
  assert.deepStrictEqual(chamadas.prepare.vendas.pedidos, []);
  assert.deepStrictEqual(chamadas.enrich, { itemIds: ["MLB100"] });
  assert.strictEqual(chamadas.upsert.runId, null);
  assert.strictEqual(chamadas.upsert.clienteContaId, 7);
  assert.strictEqual(chamadas.upsert.baseId, 4);
  assert.strictEqual(chamadas.upsert.margin, 0.17);
});

cenario("snapshot do item: chamadas concorrentes do mesmo item compartilham 1 leitura (single-flight)", async () => {
  let enrich = 0;
  let liberar;
  const trava = new Promise((r) => { liberar = r; });
  const d = {
    limiter: { aguardarVez: async () => {} },
    prepareWorkspaceContext: async () => ({ base: null, now: null }),
    enrichBatch: async () => { enrich += 1; await trava; return { itens: [] }; },
    upsertProjectionSnapshot: async () => {},
  };
  const p = { clienteSlug: "loja-a", clienteId: 3, clienteContaId: 7, itemId: "MLB200" };
  const a = atualizarSnapshotDoItem(p, d);
  const b = atualizarSnapshotDoItem(p, d);
  assert.strictEqual(a, b);
  await new Promise((r) => setImmediate(r));
  liberar();
  const r = await a;
  assert.strictEqual(r.ok, false);
  assert.strictEqual(enrich, 1);
});

async function main() {
  let falhas = 0;
  for (const caso of casos) {
    try {
      await caso.fn();
      console.log(`  ✓ ${caso.nome}`);
    } catch (err) {
      falhas += 1;
      console.error(`  ✗ ${caso.nome}\n    ${err.stack || err.message}`);
    }
  }
  if (falhas > 0) {
    console.error(`margemPrecificacaoOportunidades: ${falhas} de ${casos.length} cenários falharam`);
    process.exitCode = 1;
  } else {
    console.log(`margemPrecificacaoOportunidades: ok (${casos.length} cenários)`);
  }
}

main();
