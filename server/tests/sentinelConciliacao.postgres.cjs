// server/tests/sentinelConciliacao.postgres.cjs
//
// Conciliação da comissão (S1) contra um PostgreSQL LOCAL descartável (fora do run-all):
//   SENTINEL_TEST_DATABASE_URL=postgres://vf@127.0.0.1:57652/postgres node tests/sentinelConciliacao.postgres.cjs
// Roda o COLETOR REAL (executarColeta → lock próprio → SQL → conciliador puro → upsert) com um ML FALSO.
// Nunca lê server/.env, nunca chama o Mercado Livre e nunca toca produção.

const assert = require("assert");
const { Pool, Client } = require("pg");

const baseUrl = process.env.SENTINEL_TEST_DATABASE_URL;
if (!baseUrl) throw new Error("Defina SENTINEL_TEST_DATABASE_URL (PostgreSQL local).");
const parsed = new URL(baseUrl);
if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) throw new Error("LOCAL_DATABASE_REQUIRED");
console.log(`[sentinel.conciliacao.postgres] host=${parsed.hostname} port=${parsed.port}`);
const dbName = `vf_sentinel_conc_${Date.now()}`;
const testUrl = new URL(baseUrl);
testUrl.pathname = `/${dbName}`;
process.env.DATABASE_URL = testUrl.toString();

const { ensureSentinelSchema, ensureSentinelConciliacaoSchema, conciliacaoSchemaPronto } = require("../services/sentinel/sentinelSchema");
const { executarColeta, CONCILIACAO_LOCK_KEY } = require("../services/sentinel/sentinelConciliacaoColetor");
const { LOCK_KEY: POLLING_LOCK_KEY } = require("../services/sentinel/sentinelPollingWorker");
const L = require("../services/sentinel/sentinelConciliacaoLeitura");

let checks = 0;
function ok(label, cond) { assert.ok(cond, `FALHOU: ${label}`); checks += 1; console.log(`  ok  ${label}`); }
function eq(label, a, b) { assert.deepStrictEqual(a, b, `FALHOU: ${label}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); checks += 1; console.log(`  ok  ${label}`); }

const HORA = 3600000;
const DIA = 24 * HORA;
const T0 = Date.now();
const SELLER = { 10: "5551", 20: "5552" };

const FIXTURE_SQL = `
CREATE TABLE clientes (id integer PRIMARY KEY, nome text, slug text UNIQUE, ativo boolean DEFAULT true);
CREATE TABLE cliente_contas (id integer PRIMARY KEY, cliente_id integer REFERENCES clientes(id) ON DELETE CASCADE, marketplace text,
  nome text, slug text, external_account_id text, is_primary boolean, ativo boolean);
INSERT INTO clientes VALUES (1, 'Cliente A', 'cliente-a', true), (2, 'Cliente B', 'cliente-b', true);
INSERT INTO cliente_contas VALUES (10, 1, 'meli', 'Conta A', 'conta-a', '5551', true, true), (20, 2, 'meli', 'Conta B', 'conta-b', '5552', true, true);
`;

// ── ML FALSO ──────────────────────────────────────────────────────────────────────────────────────
// billing[seller][pedido] = { gross, net, rebate, discount, charges:[[sub, valor, doc, detailId?]], item }
// descontos[seller][pedido] = data | { status }
function criarMl() {
  const billing = { 5551: {}, 5552: {} };
  const descontos = { 5551: {}, 5552: {} };
  const dono = { 5551: new Set(), 5552: new Set() }; // pedidos de cada seller (para detectar lote misturado)
  const log = [];
  const violacoes = [];
  const ml = {
    billing, descontos, dono, log, violacoes, atrasoMs: 0,
    billingResposta: null,   // (seller, ids) => resposta forçada
    descontosResposta: null, // (seller, id) => resposta forçada
  };
  ml.fn = async (_clienteId, path, opts = {}) => {
    const seller = String(opts.mlUserId);
    log.push({ seller, path });
    if (opts.noRefresh !== true) violacoes.push(`sem noRefresh: ${path}`);
    if (ml.atrasoMs) await new Promise((r) => setTimeout(r, ml.atrasoMs));
    if (path.startsWith("/billing/integration/group/ML/order/details?order_ids=")) {
      const ids = path.split("order_ids=")[1].split(",");
      if (ids.length > 60) violacoes.push(`lote com ${ids.length} ids`);
      for (const id of ids) if (!dono[seller].has(id)) violacoes.push(`lote do seller ${seller} contém pedido alheio ${id}`);
      if (ml.billingResposta) { const f = ml.billingResposta(seller, ids); if (f) return f; }
      const results = ids.filter((id) => billing[seller][id]).map((id) => {
        const b = billing[seller][id];
        return {
          order_id: id,
          payment_info: [{ payment_id: `P${id}`, status: "approved", payer_id: 999, money_release_status: "pending" }],
          sale_fee: { gross: b.gross, net: b.net, rebate: b.rebate, discount: b.discount ?? 0, discount_reason: null },
          details: b.charges.map(([sub, valor, doc, detailId]) => ({
            charge_info: { detail_id: detailId ?? `${id}-${sub}`, detail_amount: valor, detail_type: "CHARGE", detail_sub_type: sub, status: null, charge_bonified_id: null, legal_document_status: doc || "PROCESSING" },
            discount_info: { rebate: null }, sales_info: [{ order_id: id, payer_nickname: "COMPRADOR", state_name: "SP" }],
            items_info: [{ item_id: b.item || `MLB${id}`, order_id: id, item_title: "Produto" }], marketplace_info: { marketplace: sub === "CXDE" ? "SHIPPING" : "CORE" },
          })),
        };
      });
      return { ok: true, status: 200, data: { offset: 0, limit: 250, total: results.length, last_id: 0, results, errors: [] } };
    }
    const m = path.match(/^\/orders\/(\d+)\/discounts$/);
    if (m) {
      if (!dono[seller].has(m[1])) violacoes.push(`descontos de pedido alheio ${m[1]} pelo seller ${seller}`);
      if (ml.descontosResposta) { const f = ml.descontosResposta(seller, m[1]); if (f) return f; }
      const d = descontos[seller][m[1]];
      if (!d) return { ok: false, status: 404, data: null };
      if (d.status) return { ok: false, status: d.status, data: null, retryAfter: d.retryAfter ?? null };
      return { ok: true, status: 200, data: d };
    }
    violacoes.push(`rota inesperada ${path}`);
    return { ok: false, status: 404, data: null };
  };
  ml.contar = (filtro) => log.filter((l) => (filtro === "billing" ? l.path.startsWith("/billing") : filtro === "descontos" ? l.path.includes("/discounts") : true)).length;
  ml.zerar = () => { log.length = 0; };
  return ml;
}
const desc = (itemId, total, seller, fm = "sale_fee", extra = []) => ({ details: [{ type: "discount", supplier: { funding_mode: fm }, items: [{ id: itemId, quantity: 1, amounts: { total, seller } }] }, ...extra] });

async function main() {
  const admin = new Pool({ connectionString: baseUrl, ssl: false, max: 1 });
  const avisos = [];
  admin.on("error", (e) => avisos.push(`admin: ${e.message}`));
  await admin.query(`CREATE DATABASE "${dbName}"`);
  const pool = new Pool({ connectionString: testUrl.toString(), ssl: false, max: 6 });
  pool.on("error", (e) => avisos.push(`pool: ${e.message}`));
  const q = async (sql, p) => (await pool.query(sql, p)).rows;
  const criarClient = () => new Client({ connectionString: testUrl.toString(), ssl: false });
  const ml = criarMl();
  const resolverConta = async (contaId) => ({ clienteId: contaId === 10 ? 1 : 2, clienteContaId: contaId, sellerId: SELLER[contaId] });
  const silenciar = async (fn) => { const o = [console.log, console.warn]; console.log = () => {}; console.warn = () => {}; try { return await fn(); } finally { [console.log, console.warn] = o; } };
  const cfgBase = { intervaloEntreChamadasMs: 0, maxChamadasExecucao: 50, maxChamadasConta: 20, maxFalhas: 3, backoffFalhaMs: HORA };
  const coletar = (agoraMs, extra = {}) => silenciar(() => executarColeta({
    db: pool, contaIds: [10, 20], mlFetchBase: ml.fn, resolverConta, criarClient, dormir: async () => {}, agoraMs,
    ...extra, config: { ...cfgBase, ...(extra.config || {}) },
  }));
  const linhas = async (conta) => Object.fromEntries((await q("SELECT * FROM sentinel_conciliacao_comissao WHERE cliente_conta_id = $1 ORDER BY pedido_id", [conta])).map((r) => [r.pedido_id, r]));
  const snapshotConc = async () => JSON.stringify(await q("SELECT * FROM sentinel_conciliacao_comissao ORDER BY cliente_conta_id, pedido_id"));
  const snapshotMargem = async () => JSON.stringify(await q("SELECT cliente_conta_id, pedido_id, faturamento, comissao, frete, custo, imposto, margem_valor, margem_pct, estado_margem, payload_hash FROM sentinel_pedidos ORDER BY 1, 2"));

  try {
    await q(FIXTURE_SQL);
    await ensureSentinelSchema(pool);
    // pedido no Sentinel (o polling é quem grava; aqui inserimos direto)
    const pedido = async (conta, id, { comissao = 6.21, itens = null, status = "paid", estado = "confirmada", diasAtras = 2, hash = `h-${id}` } = {}) => {
      ml.dono[SELLER[conta]].add(String(id));
      await q(`INSERT INTO sentinel_pedidos (cliente_id, cliente_conta_id, pedido_id, competencia, data_pedido, status_ml, itens, faturamento, comissao, frete, custo, imposto, margem_valor, margem_pct, estado_margem, payload_hash)
               VALUES ($1, $2, $3, '2026-11', $4, $5, $6::jsonb, 57.54, $7, 8.15, 30, 7.48, 6.44, 11.19, $8, $9)`,
      [conta === 10 ? 1 : 2, conta, String(id), new Date(T0 - diasAtras * DIA).toISOString(), status,
        JSON.stringify(itens || [{ item_id: `MLB${id}`, variation_id: null, quantidade: 1, sku: null, preco: 57.54 }]), comissao, estado, hash]);
    };
    const S10 = SELLER[10], S20 = SELLER[20];
    const cofin = (id, net, gross, rebate, c1, c2, doc = "PROCESSING") => ({ gross, net, rebate, discount: 0, charges: [["CVVML", c1, doc], ["CVVPRC", c2, doc]] });

    // Conta 10 — os seis cenários do S1-A + adversariais; Conta 20 — MESMO pedido_id "101" com valores diferentes.
    await pedido(10, 101, { comissao: 5.47 }); ml.billing[S10][101] = cofin(101, 5.47, 6.62, 1.15, 5.42, 0.05); ml.descontos[S10][101] = desc("MLB101", 20.46, 19.31);
    await pedido(10, 102, { comissao: 10.48 }); ml.billing[S10][102] = cofin(102, 10.48, 12.68, 2.2, 10.39, 0.09, "PROCESSED"); ml.descontos[S10][102] = desc("MLB102", 39.64, 37.44);
    await pedido(10, 103, { comissao: 6.21 }); ml.billing[S10][103] = cofin(103, 6.21, 6.21, 0, 6.16, 0.05); ml.descontos[S10][103] = desc("MLB103", 25.9, 25.9, "seller");
    await pedido(10, 104, { comissao: 4.32 }); ml.billing[S10][104] = cofin(104, 5.47, 6.62, 1.15, 5.42, 0.05); ml.descontos[S10][104] = desc("MLB104", 20.46, 19.31);
    await pedido(10, 105, { comissao: 6.66 }); ml.billing[S10][105] = { gross: 6.66, net: 6.66, rebate: 0, charges: [["CVVML", 4.9], ["CVVPRC", 1.59], ["CVVFNU", 0.17, "NOT_APPLICABLE"]] };
    ml.descontos[S10][105] = desc("MLB105", 12, 12, "seller", [{ type: "coupon", supplier: {}, items: [{ id: "MLB105", quantity: 1, amounts: { total: 2, seller: 2 } }] }]);
    await pedido(10, 106, { comissao: 6.21 }); // sem registro no Billing ainda
    await pedido(10, 107, { comissao: 9, itens: [{ item_id: "MLB1", quantidade: 1 }, { item_id: "MLB2", quantidade: 1 }] }); // vários itens
    await pedido(10, 108, { comissao: 9, itens: [{ item_id: "MLB108", quantidade: 2 }] }); // quantidade 2
    await pedido(10, 109, { estado: "provisoria" });
    await pedido(10, 110, { diasAtras: 0.1 }); // ainda sem maturidade (2,4 h)
    await pedido(10, 111, { diasAtras: 40 }); // fora da janela
    await pedido(10, 112, { status: "cancelled" });
    await pedido(10, 113, { comissao: 6.21 }); ml.billing[S10][113] = cofin(113, 6.21, 6.21, 0, 6.16, 0.05);
    ml.descontos[S10][113] = desc("MLB113", 5, 5, "seller", [{ type: "cashback", supplier: {}, items: [{ id: "MLB113", quantity: 1, amounts: { total: 1, seller: 0 } }] }]);
    await pedido(10, 114, { comissao: 5.47 }); ml.billing[S10][114] = { gross: 6.62, net: 5.47, rebate: 1.15, charges: [["CVVML", 5.42, "PROCESSING", "D1"], ["CVVML", 5.42, "PROCESSING", "D1"], ["CVVPRC", 0.05]] };
    ml.descontos[S10][114] = desc("MLB114", 20.46, 19.31);
    await pedido(10, 115, { comissao: 6.62 }); ml.billing[S10][115] = cofin(115, 5.47, 6.62, 1.15, 5.42, 0.05); ml.descontos[S10][115] = desc("MLB115", 20.46, 19.31);
    await pedido(20, 101, { comissao: 7 }); ml.billing[S20][101] = cofin(101, 7, 7, 0, 6.95, 0.05, "PROCESSED"); ml.descontos[S20][101] = desc("MLB101", 3, 3, "seller");

    const margemAntes = await snapshotMargem();

    console.log("\n1) sem a migration 20261119: suspenso, nenhuma chamada");
    eq("schema pronto = false", await conciliacaoSchemaPronto(pool), false);
    const r0 = await coletar(T0);
    eq("motivo schema_ausente", r0.motivo, "schema_ausente");
    eq("0 chamadas ao ML", ml.contar(), 0);
    const leituraSem = await L.resumoConciliacao(pool, { contaIds: [10] });
    eq("leitura sem migration: disponivel=false (não 500)", [leituraSem.disponivel, leituraSem.motivo], [false, "migration_20261119_nao_aplicada"]);

    console.log("\n2) migration aplicada (local) e idempotente");
    await ensureSentinelConciliacaoSchema(pool);
    await ensureSentinelConciliacaoSchema(pool);
    eq("schema pronto = true", await conciliacaoSchemaPronto(pool), true);

    console.log("\n3) primeira execução: estados, lotes por seller, descontos só com registro de Billing");
    const r1 = await coletar(T0);
    eq("executado, sem abortar, sem 429", [r1.executado, r1.abortado, r1.parou429], [true, null, false]);
    eq("violações do ML falso (lote misturado, sem noRefresh, rota inesperada, >60 ids)", ml.violacoes, []);
    eq("billing: 1 lote por conta", ml.contar("billing"), 2);
    eq("descontos: só para pedidos com registro (8 na conta 10 + 1 na conta 20)", ml.contar("descontos"), 9);
    const c10 = await linhas(10);
    eq("conta 10: só os 9 elegíveis ganharam linha", Object.keys(c10), ["101", "102", "103", "104", "105", "106", "113", "114", "115"]);
    eq("101 cofinanciado: LÍQUIDA, rebate comprovado, PROCESSING ⇒ reconsultar", [c10["101"].estado, c10["101"].rebate_incorporado, c10["101"].documento_definitivo, c10["101"].status_coleta], ["TARIFA_LIQUIDA_COMPROVADA", "comprovado", false, "reconsultar"]);
    eq("101 centavos", [c10["101"].comissao_centavos, c10["101"].gross_centavos, c10["101"].net_centavos, c10["101"].rebate_centavos, c10["101"].rebate_calculado_centavos, c10["101"].cobrancas_tarifa_centavos], [547, 662, 547, 115, 115, 547]);
    eq("102 documento PROCESSED ⇒ concluida definitiva", [c10["102"].estado, c10["102"].documento_definitivo, c10["102"].status_coleta, c10["102"].proxima_tentativa_em], ["TARIFA_LIQUIDA_COMPROVADA", true, "concluida", null]);
    eq("103 controle: rebate nao_aplicavel", [c10["103"].estado, c10["103"].rebate_incorporado], ["TARIFA_LIQUIDA_COMPROVADA", "nao_aplicavel"]);
    eq("104 rebate em dobro: DIVERGENTE", c10["104"].estado, "DIVERGENTE");
    ok("104 motivos de divergência", c10["104"].motivos.includes("rebate_possivelmente_contado_duas_vezes") && c10["104"].motivos.includes("sale_fee_pedido_difere_do_net"));
    eq("105 cupom: NAO_CONCILIADO concluida (escopo estável)", [c10["105"].estado, c10["105"].status_coleta, c10["105"].motivos.includes("cupom_nao_validado")], ["NAO_CONCILIADO", "concluida", true]);
    eq("106 sem registro: NAO_CONCILIADO reconsultar, sem chamada de descontos", [c10["106"].estado, c10["106"].status_coleta, c10["106"].motivos.includes("sem_registro_billing"), c10["106"].descontos_min], ["NAO_CONCILIADO", "reconsultar", true, null]);
    eq("113 cashback: NAO_CONCILIADO", [c10["113"].estado, c10["113"].motivos.includes("cashback_nao_validado")], ["NAO_CONCILIADO", true]);
    eq("114 cobrança duplicada: NAO_CONCILIADO reconsultar", [c10["114"].estado, c10["114"].motivos.includes("cobranca_duplicada"), c10["114"].status_coleta], ["NAO_CONCILIADO", true, "reconsultar"]);
    eq("115 tarifa bruta: TARIFA_BRUTA_COMPROVADA, rebate 'nao'", [c10["115"].estado, c10["115"].rebate_incorporado], ["TARIFA_BRUTA_COMPROVADA", "nao"]);
    const c20 = await linhas(20);
    eq("conta 20: o MESMO pedido_id 101 com os valores DELA (isolamento)", [c20["101"].estado, c20["101"].comissao_centavos, c20["101"].net_centavos, c20["101"].rebate_centavos], ["TARIFA_LIQUIDA_COMPROVADA", 700, 700, 0]);
    ok("conta 10 / 101 não foi contaminada pela conta 20", c10["101"].net_centavos === 547);
    const json = await snapshotConc();
    ok("nenhum dado de comprador persistido (nickname, payer, estado)", !/COMPRADOR|payer|nickname|"SP"/.test(json));
    eq("descontos_min compacto (sem offer/campaign/títulos)", c10["101"].descontos_min, { details: [{ type: "discount", supplier: { funding_mode: "sale_fee" }, items: [{ id: "MLB101", variation_id: null, quantity: 1, amounts: { total: 20.46, seller: 19.31 } }] }] });
    eq("margem/comissão/estado oficiais INTOCADOS", await snapshotMargem(), margemAntes);
    eq("checkpoints do polling intocados (nenhuma linha)", (await q("SELECT COUNT(*)::int n FROM sentinel_checkpoints"))[0].n, 0);

    console.log("\n4) idempotência: mesma hora ⇒ nada a fazer, 0 chamadas, linhas idênticas");
    ml.zerar();
    const antes = await snapshotConc();
    const r2 = await coletar(T0);
    eq("0 chamadas", [r2.chamadas, ml.contar()], [0, 0]);
    eq("linhas idênticas", await snapshotConc(), antes);

    console.log("\n5) reconsulta de PROCESSING (+25 h): documento virou PROCESSED; descontos REAPROVEITADOS");
    ml.billing[S10][101] = cofin(101, 5.47, 6.62, 1.15, 5.42, 0.05, "PROCESSED");
    ml.zerar();
    const r3 = await coletar(T0 + 25 * HORA);
    eq("1 lote de Billing (só a conta 10 tem vencidos), 0 descontos", [ml.contar("billing"), ml.contar("descontos")], [1, 0]);
    ok("execução ok", r3.executado && !r3.abortado);
    const c10b = await linhas(10);
    eq("101 agora concluida e definitiva, 2 observações", [c10b["101"].status_coleta, c10b["101"].documento_definitivo, c10b["101"].observacoes], ["concluida", true, 2]);
    eq("103 segue PROCESSING ⇒ reconsultar, 2 observações", [c10b["103"].status_coleta, c10b["103"].observacoes], ["reconsultar", 2]);
    eq("102 e 105 (concluidas) não foram reconsultadas", [c10b["102"].observacoes, c10b["105"].observacoes], [1, 1]);

    console.log("\n6) concorrência: dois coletores ao mesmo tempo ⇒ um é pulado; o lock do POLLING não bloqueia o coletor");
    await q("UPDATE sentinel_pedidos SET payload_hash = 'h-103-v2' WHERE cliente_conta_id = 10 AND pedido_id = '103'");
    ml.zerar(); ml.atrasoMs = 300;
    const polling = criarClient(); await polling.connect();
    eq("lock do polling tomado por outra sessão", (await polling.query("SELECT pg_try_advisory_lock(hashtext($1)) ok", [POLLING_LOCK_KEY])).rows[0].ok, true);
    const [a, b] = await Promise.all([coletar(T0 + 26 * HORA), coletar(T0 + 26 * HORA)]);
    await polling.query("SELECT pg_advisory_unlock(hashtext($1))", [POLLING_LOCK_KEY]); await polling.end();
    ml.atrasoMs = 0;
    const motivos = [a.motivo || "executado", b.motivo || "executado"].sort();
    eq("um executou, o outro: lock_ocupado", motivos, ["executado", "lock_ocupado"]);
    eq("pedido 103 (hash mudou) consultado UMA vez", ml.contar("billing"), 1);
    eq("hash mudou ⇒ observações recomeçam", (await linhas(10))["103"].observacoes, 1);
    ok("chaves de lock distintas", CONCILIACAO_LOCK_KEY !== POLLING_LOCK_KEY);

    console.log("\n7) falhas do Billing (5xx, 206, errors[], timeout): preservam a conciliação, backoff e esgotada");
    // 103 fica vencida (+24 h) e o Billing da conta 10 cai
    ml.billingResposta = (seller) => (seller === S10 ? { ok: false, status: 503, data: null } : null);
    const r5xx = await coletar(T0 + 51 * HORA);
    const f1 = (await linhas(10))["103"];
    eq("503: estado anterior preservado, status falha, 1 falha", [f1.estado, f1.status_coleta, f1.falhas_consecutivas, f1.net_centavos], ["TARIFA_LIQUIDA_COMPROVADA", "falha", 1, 621]);
    ok("503: erro registrado e próxima tentativa em +1 h", /503/.test(f1.ultimo_erro) && new Date(f1.proxima_tentativa_em).getTime() === T0 + 51 * HORA + HORA);
    eq("503: conta 10 parou na própria conta", r5xx.contas.find((c) => c.contaId === 10).parada, "billing_erro_servidor");
    ml.billingResposta = (seller) => (seller === S10 ? { ok: false, status: 206, data: { results: [] } } : null);
    await coletar(T0 + 52 * HORA + 1000);
    const f2 = (await linhas(10))["103"];
    eq("206: 2ª falha, backoff dobra (+2 h)", [f2.falhas_consecutivas, new Date(f2.proxima_tentativa_em).getTime()], [2, T0 + 52 * HORA + 1000 + 2 * HORA]);
    ml.billingResposta = (seller) => (seller === S10 ? { ok: true, status: 200, data: { results: [], errors: [{ code: "x" }] } } : null);
    await coletar(T0 + 55 * HORA);
    const f3 = (await linhas(10))["103"];
    eq("errors[]: 3ª falha ⇒ esgotada (maxFalhas 3), sem próxima tentativa", [f3.status_coleta, f3.falhas_consecutivas, f3.proxima_tentativa_em, f3.estado], ["esgotada", 3, null, "TARIFA_LIQUIDA_COMPROVADA"]);
    ml.zerar();
    await coletar(T0 + 80 * HORA);
    ok("esgotada não é mais consultada", !ml.log.some((l) => l.path.includes("103")));
    // timeout em pedido NOVO: nasce NAO_CONCILIADO com motivo de coleta (nunca zero)
    await pedido(10, 201, { comissao: 6.21 });
    ml.billingResposta = (seller) => { if (seller === S10) throw Object.assign(new Error("prazo"), { name: "MlTimeoutError" }); return null; };
    await coletar(T0 + 81 * HORA);
    const f4 = (await linhas(10))["201"];
    eq("timeout em pedido novo: NAO_CONCILIADO, coleta_billing_falhou, sem valores", [f4.estado, f4.motivos, f4.net_centavos, f4.status_coleta], ["NAO_CONCILIADO", ["coleta_billing_falhou"], null, "falha"]);
    ml.billingResposta = null;

    console.log("\n8) token (401) e grant sem acesso (403): a conta para sem gravar; a outra conta segue");
    await pedido(10, 202, { comissao: 6.21 }); ml.billing[S10][202] = cofin(202, 6.21, 6.21, 0, 6.16, 0.05); ml.descontos[S10][202] = desc("MLB202", 1, 1, "seller");
    await pedido(20, 302, { comissao: 6.21 }); ml.billing[S20][302] = cofin(302, 6.21, 6.21, 0, 6.16, 0.05, "PROCESSED"); ml.descontos[S20][302] = desc("MLB302", 1, 1, "seller");
    ml.billingResposta = (seller) => (seller === S10 ? { ok: false, status: 401, data: null } : null);
    const r401 = await coletar(T0 + 82 * HORA);
    eq("401: conta 10 parada por token, nada gravado para 202", [r401.contas.find((c) => c.contaId === 10).parada, (await linhas(10))["202"]], ["token_indisponivel", undefined]);
    eq("401: conta 20 processada na mesma execução", (await linhas(20))["302"].estado, "TARIFA_LIQUIDA_COMPROVADA");
    ml.billingResposta = (seller) => (seller === S10 ? { ok: false, status: 403, data: null } : null);
    const r403 = await coletar(T0 + 83 * HORA);
    eq("403: conta 10 parada (sem permissão de Billing), nada gravado", [r403.contas.find((c) => c.contaId === 10).parada, (await linhas(10))["202"]], ["sem_permissao_billing", undefined]);
    ml.billingResposta = (seller) => { if (seller === S10) throw Object.assign(new Error("grant ausente"), { code: "ML_GRANT_NOT_FOUND" }); return null; };
    const rGrant = await coletar(T0 + 83 * HORA + 1000);
    eq("exceção de grant/conta (não HTTP): conta 10 parada, nada gravado, sem gastar tentativas", [rGrant.contas.find((c) => c.contaId === 10).parada, (await linhas(10))["202"]], ["erro_cliente_ml", undefined]);
    await q(`INSERT INTO sentinel_pedidos (cliente_id, cliente_conta_id, pedido_id, competencia, data_pedido, status_ml, itens, comissao, estado_margem, payload_hash)
             VALUES (2, 20, '12a/../x', '2026-11', $1, 'paid', '[{"item_id":"MLB1","quantidade":1}]', 6.21, 'confirmada', 'hx')`, [new Date(T0 - 2 * DIA).toISOString()]);
    ml.billingResposta = null; ml.zerar();
    const rId = await coletar(T0 + 83 * HORA + 2000, { contaIds: [20] });
    ok("pedido_id não numérico nunca vai para a URL do ML", !ml.log.some((l) => l.path.includes("12a")) && rId.contas.find((c) => c.contaId === 20).ignoradosIdInvalido === 1);
    await q("DELETE FROM sentinel_pedidos WHERE pedido_id = '12a/../x'");
    ml.billingResposta = null;

    console.log("\n9) 429: nenhuma nova chamada (todas as contas), pausa GLOBAL persistida e respeitada; backoff exponencial");
    await pedido(20, 303, { comissao: 6.21 }); ml.billing[S20][303] = cofin(303, 6.21, 6.21, 0, 6.16, 0.05, "PROCESSED"); ml.descontos[S20][303] = desc("MLB303", 1, 1, "seller");
    ml.billingResposta = (seller) => (seller === S10 ? { ok: false, status: 429, data: null, retryAfter: 120 } : null);
    ml.zerar();
    const antes429 = await snapshotConc();
    const r429 = await coletar(T0 + 84 * HORA);
    eq("429: parou429 e 1 única chamada na execução (conta 20 não foi chamada)", [r429.parou429, ml.contar()], [true, 1]);
    eq("429: nenhuma linha alterada", await snapshotConc(), antes429);
    const pausa = (await q("SELECT pausado_ate, ocorrencias FROM sentinel_conciliacao_controle WHERE chave = 'billing_429'"))[0];
    ok("429: pausa ≥ 30 min (base > Retry-After de 120 s)", new Date(pausa.pausado_ate).getTime() - Date.now() > 29 * 60000);
    eq("429: 1 ocorrência", pausa.ocorrencias, 1);
    ml.billingResposta = null; ml.zerar();
    const rp = await coletar(T0 + 85 * HORA);
    eq("execução seguinte respeita a pausa: 0 chamadas", [rp.motivo, ml.contar()], ["pausa_429", 0]);
    const resumoPausa = await L.resumoConciliacao(pool, { contaIds: [10, 20] });
    ok("leitura mostra a pausa ativa", resumoPausa.pausa && resumoPausa.pausa.ocorrencias === 1);
    await q("UPDATE sentinel_conciliacao_controle SET pausado_ate = now() - interval '1 second'");
    ml.billingResposta = (seller) => (seller === S10 ? { ok: false, status: 429, data: null } : null);
    await coletar(T0 + 86 * HORA);
    const pausa2 = (await q("SELECT pausado_ate, ocorrencias FROM sentinel_conciliacao_controle"))[0];
    ok("2º 429 seguido: pausa dobra (≥ 60 min)", new Date(pausa2.pausado_ate).getTime() - Date.now() > 59 * 60000 && pausa2.ocorrencias === 2);
    await q("UPDATE sentinel_conciliacao_controle SET pausado_ate = now() - interval '1 second'");
    ml.billingResposta = null;
    await coletar(T0 + 87 * HORA);
    eq("Billing normal zera a sequência de 429", (await q("SELECT ocorrencias FROM sentinel_conciliacao_controle"))[0].ocorrencias, 0);
    eq("depois da pausa, 202 (conta 10) e 303 (conta 20) conciliados", [(await linhas(10))["202"].estado, (await linhas(20))["303"].estado], ["TARIFA_LIQUIDA_COMPROVADA", "TARIFA_LIQUIDA_COMPROVADA"]);
    // 429 nos DESCONTOS: o pedido não é gravado (adiado) e a pausa vale
    await q("UPDATE sentinel_conciliacao_controle SET pausado_ate = NULL");
    await pedido(10, 203, { comissao: 6.21 }); ml.billing[S10][203] = cofin(203, 6.21, 6.21, 0, 6.16, 0.05); ml.descontos[S10][203] = { status: 429 };
    const r429d = await coletar(T0 + 88 * HORA);
    eq("429 em /discounts: pedido adiado (sem linha) e pausa registrada", [(await linhas(10))["203"], r429d.parou429, r429d.contas[0].adiados], [undefined, true, 1]);
    await q("UPDATE sentinel_conciliacao_controle SET pausado_ate = NULL");
    ml.descontos[S10][203] = desc("MLB203", 1, 1, "seller");

    console.log("\n10) orçamento por conta: o que não coube é ADIADO (sem gastar observação) e retomado depois");
    for (const id of [204, 205, 206]) { await pedido(10, id, { comissao: 6.21 }); ml.billing[S10][id] = cofin(id, 6.21, 6.21, 0, 6.16, 0.05); ml.descontos[S10][id] = desc(`MLB${id}`, 1, 1, "seller"); }
    ml.zerar();
    const rOrc = await coletar(T0 + 89 * HORA, { config: { maxChamadasConta: 2 } });
    const conta10 = rOrc.contas.find((c) => c.contaId === 10);
    eq("2 chamadas na conta 10 (1 Billing + 1 descontos), parada por orçamento", [ml.log.filter((l) => l.seller === S10).length, conta10.parada], [2, "orcamento"]);
    const gravadosOrc = Object.keys(await linhas(10)).filter((id) => ["203", "204", "205", "206"].includes(id));
    eq("só 1 dos 4 pedidos novos gravado (203, o mais antigo); os outros 3 adiados", [gravadosOrc, conta10.adiados], [["203"], 3]);
    await coletar(T0 + 90 * HORA, { config: { maxChamadasConta: 20 } });
    eq("execução seguinte completa os adiados", Object.keys(await linhas(10)).filter((id) => ["203", "204", "205", "206"].includes(id)).length, 4);
    eq("adiados nascem com 1 observação (o adiamento não gastou tentativa)", Object.values(await linhas(10)).filter((r) => ["204", "205", "206"].includes(r.pedido_id)).map((r) => r.observacoes), [1, 1, 1]);
    eq("orçamento da EXECUÇÃO (1 chamada) também é respeitado", await (async () => { ml.zerar(); await pedido(10, 207, { comissao: 6.21 }); ml.billing[S10][207] = cofin(207, 6.21, 6.21, 0, 6.16, 0.05); await coletar(T0 + 91 * HORA, { config: { maxChamadasExecucao: 1 } }); return ml.contar(); })(), 1);

    console.log("\n11) integridade no banco: FK por conta, CHECK de comprovação, purge em cascata");
    let erro = null;
    try { await q("INSERT INTO sentinel_conciliacao_comissao (cliente_conta_id, pedido_id, estado, contrato_versao, evidencia_versao, status_coleta) VALUES (20, '105', 'NAO_CONCILIADO', 1, 1, 'concluida')"); } catch (e) { erro = e.code; }
    eq("FK: conta 20 não pode ter conciliação de pedido que só existe na conta 10", erro, "23503");
    erro = null;
    try { await q("INSERT INTO sentinel_conciliacao_comissao (cliente_conta_id, pedido_id, estado, contrato_versao, evidencia_versao, status_coleta) VALUES (10, '107', 'TARIFA_LIQUIDA_COMPROVADA', 1, 1, 'concluida')"); } catch (e) { erro = e.code; }
    eq("CHECK: 'comprovada' sem valores do Billing é recusada", erro, "23514");
    await q("DELETE FROM sentinel_pedidos WHERE cliente_conta_id = 10 AND pedido_id = '105'");
    eq("purge do pedido apaga a conciliação (cascata)", (await linhas(10))["105"], undefined);
    await q("DELETE FROM cliente_contas WHERE id = 20");
    eq("purge da Conta apaga as conciliações dela", (await q("SELECT COUNT(*)::int n FROM sentinel_conciliacao_comissao WHERE cliente_conta_id = 20"))[0].n, 0);
    ok("conta 10 intacta após o purge da conta 20", Object.keys(await linhas(10)).length > 5);

    console.log("\n12) leitura (backend): resumo, lista por estado, pedido; isolamento e explicação");
    const res = await L.resumoConciliacao(pool, { contaIds: [10] });
    const cr = res.contas[0];
    ok("resumo disponível, efeito na margem 'nenhum', alertas desligados", res.disponivel && res.efeitoNaMargem === "nenhum" && res.alertasFinanceiros === "desligados");
    eq("resumo soma por estado = total", Object.values(cr.porEstado).reduce((s, n) => s + n, 0), cr.total);
    const div = await L.listarConciliacoes(pool, { contaIds: [10], estado: "DIVERGENTE" });
    eq("lista DIVERGENTE = [104]", div.itens.map((i) => i.pedidoId), ["104"]);
    ok("DIVERGENTE explicado como inconsistência, não prejuízo", /NÃO é prejuízo confirmado/.test(div.itens[0].interpretacao));
    const p107 = await L.obterConciliacaoPedido(pool, 10, "107");
    eq("pedido com vários itens: NAO_CONCILIADO derivado da linha (sem coleta)", [p107.estado, p107.motivos.map((m) => m.codigo), p107.coleta], ["NAO_CONCILIADO", ["multiplos_itens_nao_validado"], null]);
    eq("pedido inexistente na conta ⇒ null (404)", await L.obterConciliacaoPedido(pool, 10, "999"), null);
    await q("UPDATE sentinel_pedidos SET payload_hash = 'h-101-novo' WHERE cliente_conta_id = 10 AND pedido_id = '101'");
    eq("pedido mudou depois da conciliação ⇒ desatualizada", (await L.obterConciliacaoPedido(pool, 10, "101")).desatualizada, true);
    // margem oficial: as ÚNICAS diferenças vs. o início são as que o próprio teste fez (hash de 101/103, pedidos 105 e conta 20 apagados, pedidos novos)
    const inicio = new Map(JSON.parse(margemAntes).map((r) => [`${r.cliente_conta_id}:${r.pedido_id}`, r]));
    const mudou = JSON.parse(await snapshotMargem()).filter((r) => inicio.has(`${r.cliente_conta_id}:${r.pedido_id}`))
      .filter((r) => JSON.stringify({ ...r, payload_hash: null }) !== JSON.stringify({ ...inicio.get(`${r.cliente_conta_id}:${r.pedido_id}`), payload_hash: null }));
    eq("o coletor nunca alterou faturamento/comissão/frete/custo/imposto/margem/estado de nenhum pedido", mudou, []);
    eq("violações do ML falso ao final", ml.violacoes, []);
  } finally {
    await pool.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  }
  if (avisos.length) console.log(`(avisos de conexão no encerramento: ${avisos.length})`);
  console.log(`\n✓ sentinelConciliacao.postgres: ${checks} verificações`);
}

main().catch((err) => { console.error(err); process.exit(1); });
