// Rotas de LEITURA da conciliação (S1): carteira, parâmetros, contratos e ausência de efeitos. Fakes; sem banco/ML.
const test = require("node:test");
const assert = require("node:assert/strict");
const { criarController } = require("../controllers/sentinelController");
const L = require("../services/sentinel/sentinelConciliacaoLeitura");

function resp() {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}
const user = { id: 1, role: "admin" };
const acesso = {
  contasAutorizadas: async () => ({ contaIds: [41], contas: [{ id: 41, ativo: true }] }),
  contaAutorizadaInfo: async (_u, contaId) => (Number(contaId) === 41 ? { id: 41, ativo: true } : null),
};
function fakeConc(over = {}) {
  const log = [];
  return { log, ESTADOS: L.ESTADOS,
    resumoConciliacao: async (_db, a) => { log.push(["resumo", a]); return { disponivel: true, contas: [], access_token: "NUNCA" }; },
    listarConciliacoes: async (_db, a) => { log.push(["listar", a]); return { disponivel: true, itens: [], total: 0 }; },
    obterConciliacaoPedido: async (_db, c, p) => { log.push(["obter", c, p]); return { contaId: c, pedidoId: p, estado: "DIVERGENTE" }; },
    ...over };
}
const ctl = (conc) => criarController({ db: {}, acesso, motor: {}, conciliacao: conc });

test("R1 resumo usa só as contas da CARTEIRA e remove segredos da resposta", async () => {
  const conc = fakeConc();
  const r = resp();
  await ctl(conc).conciliacaoResumo({ user, query: { conta: "999" } }, r);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(conc.log[0], ["resumo", { contaIds: [41] }]);
  assert.equal(JSON.stringify(r.body).includes("NUNCA"), false);
});

test("R2 listar valida estado/limit/offset (400) e repassa filtros", async () => {
  const conc = fakeConc();
  const r = resp();
  await ctl(conc).conciliacaoListar({ user, query: { estado: "PREJUIZO" } }, r);
  assert.equal(r.statusCode, 400);
  const r2 = resp();
  await ctl(conc).conciliacaoListar({ user, query: { estado: "DIVERGENTE", limit: "500", offset: "x" } }, r2);
  assert.equal(r2.statusCode, 400);
  const r3 = resp();
  await ctl(conc).conciliacaoListar({ user, query: { estado: "DIVERGENTE", limit: "500" } }, r3);
  assert.equal(r3.statusCode, 200);
  assert.deepEqual(conc.log.at(-1), ["listar", { contaIds: [41], estado: "DIVERGENTE", limit: 200, offset: 0 }]);
});

test("R3 por pedido: exige conta; fora da carteira, id inválido ou inexistente ⇒ 404 idêntico", async () => {
  const conc = fakeConc();
  const r0 = resp();
  await ctl(conc).conciliacaoPedido({ user, params: { pedidoId: "1" }, query: {} }, r0);
  assert.equal(r0.statusCode, 400);
  for (const [conta, pedidoId] of [["86", "2000"], ["41", "abc"], ["41", "1;DROP"]]) {
    const r = resp();
    await ctl(conc).conciliacaoPedido({ user, params: { pedidoId }, query: { conta } }, r);
    assert.equal(r.statusCode, 404, `${conta}/${pedidoId}`);
    assert.equal(r.body.code, "PEDIDO_NAO_ENCONTRADO");
  }
  const semPedido = fakeConc({ obterConciliacaoPedido: async () => null });
  const r4 = resp();
  await ctl(semPedido).conciliacaoPedido({ user, params: { pedidoId: "2000" }, query: { conta: "41" } }, r4);
  assert.equal(r4.statusCode, 404);
  const r5 = resp();
  await ctl(conc).conciliacaoPedido({ user, params: { pedidoId: "2000" }, query: { conta: "41" } }, r5);
  assert.equal(r5.statusCode, 200);
  assert.equal(r5.body.conciliacao.estado, "DIVERGENTE");
});

test("R4 erro interno vira 500 genérico (sem SQL/stack)", async () => {
  const conc = fakeConc({ resumoConciliacao: async () => { throw new Error('relation "x" does not exist SELECT ...'); } });
  const r = resp();
  const orig = console.error; console.error = () => {};
  try { await ctl(conc).conciliacaoResumo({ user, query: {} }, r); } finally { console.error = orig; }
  assert.equal(r.statusCode, 500);
  assert.equal(JSON.stringify(r.body).includes("SELECT"), false);
});

test("R5 rotas novas são só GET e as antigas continuam montadas", () => {
  const { criarSentinelRouter } = require("../routes/sentinelRoutes");
  const router = criarSentinelRouter({ auth: (_q, _s, n) => n(), db: {}, acesso: { ...acesso, papelPermitido: () => true }, motor: {}, conciliacao: fakeConc() });
  const rotas = router.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods).join(",").toUpperCase()} ${l.route.path}`);
  for (const r of ["GET /resumo", "GET /incidentes", "GET /incidentes/:id", "POST /incidentes/:id/reconhecer", "POST /incidentes/:id/resolver", "GET /contas", "GET /saude"])
    assert.ok(rotas.includes(r), r);
  for (const r of ["GET /conciliacao/resumo", "GET /conciliacao", "GET /conciliacao/pedidos/:pedidoId"]) assert.ok(rotas.includes(r), r);
  assert.equal(rotas.filter((r) => r.includes("conciliacao") && !r.startsWith("GET ")).length, 0);
});

test("L1 leitura: interpretação fixa; DIVERGENTE nunca é prejuízo; efeito na margem 'nenhum'", () => {
  assert.match(L.INTERPRETACAO.DIVERGENTE, /NÃO é prejuízo confirmado/);
  assert.deepEqual(Object.keys(L.INTERPRETACAO).sort(), [...L.ESTADOS].sort());
  const item = L.linhaParaItem({ cliente_conta_id: 41, pedido_id: "1", estado: "DIVERGENTE", motivos: ["sale_fee_pedido_difere_do_net", "coleta_billing_falhou"],
    rebate_incorporado: "desconhecido", documento: "PROCESSING", documento_definitivo: false, pedido_payload_hash: "a" }, "b");
  assert.equal(item.efeitoNaMargem, "nenhum");
  assert.equal(item.desatualizada, true);
  assert.equal(item.documento.definitivo, false);
  assert.deepEqual(item.motivos, [{ codigo: "sale_fee_pedido_difere_do_net", categoria: "divergencia" }, { codigo: "coleta_billing_falhou", categoria: "coleta" }]);
});

test("L2 motivo de pedido SEM conciliação vem da linha do Sentinel (escopo), nunca de suposição", () => {
  const base = { status_ml: "paid", comissao: "5.47", estado_margem: "confirmada", itens: [{ quantidade: 1 }] };
  assert.deepEqual(L.motivosSemConciliacao(base), ["ainda_nao_conciliado"]);
  assert.deepEqual(L.motivosSemConciliacao({ ...base, itens: [{ quantidade: 1 }, { quantidade: 1 }] }), ["multiplos_itens_nao_validado"]);
  assert.deepEqual(L.motivosSemConciliacao({ ...base, itens: [{ quantidade: 2 }] }), ["quantidade_maior_que_1_nao_validada"]);
  assert.deepEqual(L.motivosSemConciliacao({ ...base, status_ml: "partially_refunded" }), ["cancelamento_ou_reembolso_nao_validado"]);
  assert.deepEqual(L.motivosSemConciliacao({ ...base, comissao: null, estado_margem: "provisoria" }), ["comissao_ausente", "calculo_provisorio"]);
});
