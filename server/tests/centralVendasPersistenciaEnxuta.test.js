// server/tests/centralVendasPersistenciaEnxuta.test.js
//
// Persistência enxuta (centralVendasPersistenciaEnxuta) — testes puros, sem
// banco. A prova contra PostgreSQL real (paridade de leitura, tamanho em
// disco, várias noites) está em centralVendasPersistenciaEnxuta.postgres.test.js.

const assert = require("assert");
const pe = require("../services/centralVendas/centralVendasPersistenciaEnxuta");
const { buildMotorFromOrders, buildCostMap } = require("../services/centralVendas/centralVendasSyncService");

let checks = 0;
function ok(label, cond) { assert.ok(cond, `FALHOU: ${label}`); checks += 1; }
function eq(label, a, b) { assert.deepStrictEqual(a, b, `FALHOU: ${label} — recebido ${JSON.stringify(a)}`); checks += 1; }

// Simula exatamente o que insertItem/insertComponente gravam nas colunas e o
// que o pg devolve (NUMERIC volta como string; jsonb volta como objeto).
function linhaItem(item, payload) {
  const n = (v) => (v === null || v === undefined ? null : String(v));
  return {
    pedido_id: String(item.pedidoId), item_id: String(item.itemId), mlb: item.mlb || null, sku: item.sku || null,
    titulo: item.titulo || null, quantidade: n(item.quantidade ?? null), valor_unitario: n(item.valorUnitario ?? null),
    receita_produto: n(item.receitaProduto ?? null), custo_produto: n(item.custoProduto ?? null),
    imposto_interno: n(item.impostoInterno ?? null), lucro_contribuicao: n(item.lucroContribuicao ?? null),
    resultado: n(item.resultado ?? null), margem_contribuicao_percentual: n(item.margemContribuicaoPercentual ?? null),
    confianca: item.confianca, pendencias_json: JSON.parse(JSON.stringify(item.pendencias ?? [])),
    payload_json: JSON.parse(JSON.stringify(payload)),
  };
}
function linhaComponente(c, payload) {
  return {
    pedido_id: String(c.pedidoId), item_id: c.itemId || null, tipo: c.tipo,
    valor: c.valor === null || c.valor === undefined ? null : String(c.valor),
    fonte: c.fonte || null, confianca: c.confianca, obs: c.obs || null,
    payload_json: JSON.parse(JSON.stringify(payload)),
  };
}
// Normalização JSON (o que o banco guardaria do objeto original): undefined some.
const jsonNorm = (o) => JSON.parse(JSON.stringify(o));
// Chave ausente no original volta null na reconstrução (documentado).
function comNulls(original, reconstruido) {
  const out = { ...jsonNorm(original) };
  for (const k of Object.keys(reconstruido)) if (!(k in out)) out[k] = null;
  return out;
}

function orders() {
  const base = (id, mlb, qtd, preco, extra = {}) => ({
    id, date_created: "2026-09-10T10:00:00.000-03:00", status: "paid", tags: [],
    payments: [{ id: `PAY${id}`, transaction_amount_refunded: extra.reembolso || 0 }],
    shipping: { id: `S${id}`, logistic_type: extra.full ? "fulfillment" : "cross_docking" },
    order_items: [{ item: { id: mlb, seller_sku: extra.sku ?? "SKU-1", title: "Produto teste" }, quantity: qtd, unit_price: preco, sale_fee: 11.37 }],
    ...(extra.pack ? { pack_id: extra.pack } : {}),
  });
  return [
    base("1001", "MLB111", 1, 99.9),
    base("1002", "MLB222", 3, 33.333, { full: true }),
    base("1003", "MLB999", 2, 10, { sku: "" }),       // sem custo na base, sku vazio
    base("1004", "MLB111", 1, 50, { reembolso: 50 }),  // reembolso
  ];
}

async function run() {
  // 1 — flag: ausente/false = desligada; só vale para orders_api com run.
  eq("flag ausente = desligada", pe.isPersistenciaEnxutaHabilitada({}), false);
  eq("flag true = ligada", pe.isPersistenciaEnxutaHabilitada({ [pe.ENV_NAME]: "true" }), true);
  eq("flag false = desligada", pe.isPersistenciaEnxutaHabilitada({ [pe.ENV_NAME]: "false" }), false);
  const env = { [pe.ENV_NAME]: "true" };
  eq("aplica: orders_api + run", pe.aplicaPersistenciaEnxuta({ fonte: "orders_api", syncRunId: 7 }, env), true);
  eq("NÃO aplica: planilha manual", pe.aplicaPersistenciaEnxuta({ fonte: "planilha_vendas", syncRunId: null }, env), false);
  eq("NÃO aplica: orders_api sem run (legado)", pe.aplicaPersistenciaEnxuta({ fonte: "orders_api", syncRunId: null }, env), false);

  // 2 — motor real: extras + reconstrução sem perda.
  const costMap = buildCostMap([
    { produto_id: "MLB111", custo_produto: 40.1, imposto_percentual: 6 },
    { produto_id: "MLB222", custo_produto: 12.345, imposto_percentual: 4.5 },
  ]);
  const freteMap = new Map([["S1001", { valor: 18.9, status: "real", receitaComprador: 0 }], ["S1002", { valor: 0, status: "real" }]]);
  const motor = buildMotorFromOrders({ orders: orders(), costMap, freteMap, clienteSlug: "loja-teste", competencia: "2026-09" });
  ok("motor gerou itens e componentes", motor.itens.length === 4 && motor.componentes.length >= 20);

  let bytesAntes = 0, bytesDepois = 0;
  for (const item of motor.itens) {
    const extras = pe.extrasDoItem(item);
    bytesAntes += JSON.stringify(item).length; bytesDepois += JSON.stringify(extras).length;
    const rec = pe.reconstruirItem(linhaItem(item, extras));
    eq(`item ${item.itemId}: colunas + extras == original`, rec, comNulls(item, rec));
  }
  for (const c of motor.componentes) {
    const extras = pe.extrasDoComponente(c);
    bytesAntes += JSON.stringify(c).length; bytesDepois += JSON.stringify(extras).length;
    const rec = pe.reconstruirComponente(linhaComponente(c, extras));
    eq(`componente ${c.pedidoId}/${c.tipo}: colunas + extras == original`, rec, comNulls(c, rec));
  }
  ok(`payloads de item/componente encolhem (${bytesAntes} → ${bytesDepois} bytes)`, bytesDepois < bytesAntes * 0.1);

  // 3 — valores que a coluna NÃO reproduz vão para os extras (nunca perdidos).
  const itemEstranho = { ...motor.itens[0], quantidade: 1.23456, sku: "", mlb: 12345, extraNovo: { a: 1 } };
  const ex = pe.extrasDoItem(itemEstranho);
  eq("quantidade com 5 casas (coluna NUMERIC(14,4)) vai para extras", ex.quantidade, 1.23456);
  eq("sku vazio ('' || null vira NULL) vai para extras", ex.sku, "");
  eq("mlb numérico (coluna TEXT) vai para extras", ex.mlb, 12345);
  eq("chave sem coluna vai para extras", ex.extraNovo, { a: 1 });
  const recEstranho = pe.reconstruirItem(linhaItem(itemEstranho, ex));
  eq("item estranho reconstruído sem perda", recEstranho, comNulls(itemEstranho, recEstranho));
  const compEstranho = { ...motor.componentes[0], valor: 10.005, fonte: "", obs: "" };
  const exc = pe.extrasDoComponente(compEstranho);
  eq("valor com 3 casas vai para extras", exc.valor, 10.005);
  const recC = pe.reconstruirComponente(linhaComponente(compEstranho, exc));
  eq("componente estranho reconstruído sem perda", recC, comNulls(compEstranho, recC));

  // 4 — manifesto: digest por pedido; diff novos/alterados/inalterados/removidos.
  const m1 = pe.construirManifesto({ motorPayload: motor, resumo: { a: 1, syncRunId: 1 } });
  eq("manifesto tem 1 digest por pedido", Object.keys(m1.digests).length, motor.pedidos.length);
  const m1b = pe.construirManifesto({ motorPayload: jsonNorm(motor), resumo: { a: 1, syncRunId: 2 } });
  eq("digest estável após ida e volta JSON e com outro syncRunId", m1b.digests, m1.digests);
  eq("digestResumo ignora syncRunId", m1b.digestResumo, m1.digestResumo);
  eq("mesmo conteúdo ⇒ idêntico", pe.compararManifestos(m1b, m1),
    { comparavel: true, novos: 0, alterados: 0, inalterados: 4, removidos: 0, identico: true });

  const ordersN2 = orders();
  ordersN2[0].status = "cancelled";                // alterado
  ordersN2.splice(2, 1);                            // 1003 removido
  ordersN2.push({ ...orders()[0], id: "1005", shipping: { id: "S1005" } }); // novo
  const motor2 = buildMotorFromOrders({ orders: ordersN2, costMap, freteMap, clienteSlug: "loja-teste", competencia: "2026-09" });
  const m2 = pe.construirManifesto({ motorPayload: motor2, resumo: { a: 2 } });
  eq("diff detecta novo/alterado/inalterado/removido", pe.compararManifestos(m2, m1),
    { comparavel: true, novos: 1, alterados: 1, inalterados: 2, removidos: 1, identico: false });
  eq("sem manifesto anterior ⇒ não comparável", pe.compararManifestos(m2, null),
    { comparavel: false, motivo: "SEM_MANIFESTO_ANTERIOR" });

  console.log(`centralVendasPersistenciaEnxuta.test.js: ${checks} verificacoes OK`);
}

run().catch((err) => { console.error(err); process.exit(1); });
