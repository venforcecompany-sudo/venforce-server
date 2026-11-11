// server/tests/raioXCliente.postgres.test.js
//
// Raio-X do Cliente contra PostgreSQL LOCAL e descartável:
//   CENTRAL_VENDAS_PG_TEST_DATABASE_URL=postgres://vf@127.0.0.1:57651/postgres node tests/raioXCliente.postgres.test.js
// Sem a variável, a parte de PG PULA; a parte com client falso (timeout) roda sempre.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

let checks = 0;
const ok = (l, c) => { assert.ok(c, `FALHOU: ${l}`); checks += 1; };
const eq = (l, a, b) => { assert.deepStrictEqual(a, b, `FALHOU: ${l} — recebido ${JSON.stringify(a)}`); checks += 1; };
const LOCAL = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

const FIXTURES = `
CREATE TABLE users (id integer PRIMARY KEY);
CREATE TABLE clientes (id integer PRIMARY KEY, nome text, slug text UNIQUE, ativo boolean DEFAULT true);
CREATE TABLE cliente_contas (id integer PRIMARY KEY, cliente_id integer REFERENCES clientes(id), marketplace text, nome text,
  slug text, external_account_id text, is_primary boolean DEFAULT false, ativo boolean DEFAULT true, created_at timestamp DEFAULT now());
CREATE TABLE ml_tokens (id integer PRIMARY KEY, cliente_id integer, ml_user_id text, access_token text, refresh_token text,
  is_primary boolean, token_status text, refresh_failures int DEFAULT 0, superseded_at timestamptz, expires_at timestamp, updated_at timestamp DEFAULT now());
CREATE TABLE bases (id integer PRIMARY KEY);
CREATE TABLE painel_contas_lancamentos_manuais (id serial PRIMARY KEY, cliente_id integer, cliente_conta_id integer, competencia text, updated_at timestamptz DEFAULT now());
INSERT INTO users VALUES (1);
INSERT INTO clientes VALUES (1, 'Loja', 'loja', true), (2, 'Outra', 'outra', true);
INSERT INTO cliente_contas (id, cliente_id, marketplace, nome, slug, external_account_id, is_primary) VALUES
  (5, 1, 'meli', 'ML 1', 'loja-ml1', '111', true), (6, 1, 'meli', 'ML 2', 'loja-ml2', '222', false), (7, 2, 'meli', 'Outra', 'outra-ml', '333', true);
INSERT INTO ml_tokens (id, cliente_id, ml_user_id, access_token, refresh_token, is_primary, token_status, expires_at)
  VALUES (100, 1, '111', 'SEGREDO-ACCESS', 'SEGREDO-REFRESH', true, 'valid', now() + interval '1 day');
INSERT INTO painel_contas_lancamentos_manuais (cliente_id, cliente_conta_id, competencia) VALUES (1, 5, '2026-08');
`;

async function semBanco() {
  // Timeout de uma consulta vira status "timeout" e o restante continua.
  const { gerarRaioXCliente } = require("../services/raioX/raioXClienteService");
  const chamadas = [];
  const fake = {
    async query(sql) {
      chamadas.push(sql);
      if (/FROM clientes WHERE/.test(sql)) return { rows: [{ id: 1, nome: "Loja", slug: "loja", ativo: true }] };
      if (/FROM central_vendas_imports\s+WHERE cliente_id/.test(sql)) { const e = new Error("canceling statement due to statement timeout"); e.code = "57014"; throw e; }
      return { rows: [] };
    },
  };
  const r = await gerarRaioXCliente({ clienteSlug: "loja" }, { db: fake });
  eq("timeout vira status no bloco, não exceção", r.centralVendas, { status: "timeout" });
  ok("transação aberta como READ ONLY", chamadas[0] === "BEGIN READ ONLY");
  ok("termina com ROLLBACK (nunca COMMIT)", chamadas.includes("ROLLBACK") && !chamadas.some((s) => /^COMMIT/i.test(s)));
  ok("statement_timeout aplicado por consulta", chamadas.some((s) => /SET LOCAL statement_timeout = 3000/.test(s)));
  ok("nenhuma consulta seleciona access_token/refresh_token", !chamadas.some((s) => /access_token|refresh_token/.test(s)));
}

async function comBanco() {
  const baseUrl = process.env.CENTRAL_VENDAS_PG_TEST_DATABASE_URL;
  if (!baseUrl) { console.log("  parte PostgreSQL PULADA (defina CENTRAL_VENDAS_PG_TEST_DATABASE_URL)"); return; }
  if (!LOCAL.has(new URL(baseUrl).hostname)) throw new Error("LOCAL_DATABASE_REQUIRED");
  const { Client, Pool } = require("pg");
  const admin = new Client({ connectionString: baseUrl, ssl: false });
  await admin.connect();
  const nome = `vf_raiox_test_${Date.now()}`;
  await admin.query(`CREATE DATABASE "${nome}"`);
  const url = new URL(baseUrl); url.pathname = `/${nome}`;
  const pool = new Pool({ connectionString: url.toString(), ssl: false });
  try {
    await pool.query(FIXTURES);
    await pool.query(fs.readFileSync(path.join(__dirname, "..", "sql", "central_vendas_schema.sql"), "utf8"));
    const q = (s, p) => pool.query(s, p).then((r) => r.rows);
    const [r1, r2] = await q(`INSERT INTO central_vendas_sync_runs (cliente_id, cliente_slug, cliente_conta_id, marketplace, date_from, date_to, status, started_at, finished_at)
      VALUES (1,'loja',5,'meli','2026-09-01','2026-09-29','completed', now()-interval '2 min', now()), (1,'loja',5,'meli','2026-09-01','2026-09-30','completed', now()-interval '3 min', now()) RETURNING id`);
    const imp = async (o) => (await q(`INSERT INTO central_vendas_imports (cliente_id, cliente_slug, marketplace, competencia, fonte, cliente_conta_id,
        publication_status, coverage_date_from, coverage_date_to, published_at, sync_run_id, resumo_json, payload_json)
      VALUES ($1,$2,'meli',$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,'{}') RETURNING id`,
      [o.cid ?? 1, o.slug ?? "loja", o.comp ?? "2026-09", o.fonte ?? "orders_api", o.conta ?? 5, o.st ?? "published", "de" in o ? o.de : "2026-09-01", "ate" in o ? o.ate : "2026-09-30",
        o.st === "candidate" || o.st === "legacy" ? null : (o.pub ?? new Date().toISOString()), o.run ?? null, JSON.stringify({ pedidosTotal: o.pedidos ?? 10 })]))[0].id;
    const antigo = await imp({ run: r1.id, ate: "2026-09-29", pub: "2026-10-01T00:00:00Z", pedidos: 290 });
    const vigente = await imp({ run: r2.id, pub: "2026-10-02T00:00:00Z", pedidos: 300 });
    await imp({ fonte: "planilha_vendas", st: "legacy", comp: "2026-08", de: null, ate: null });     // manual
    await imp({ run: r2.id, st: "candidate", comp: "2026-10", de: "2026-10-01", ate: "2026-10-05" });   // candidate órfão
    await imp({ conta: 7, pedidos: 1, run: r2.id });                                                                    // conta de OUTRO cliente
    await q(`INSERT INTO central_vendas_pedidos (import_id, cliente_id, cliente_slug, competencia, pedido_id, confianca)
             SELECT $1, 1, 'loja', '2026-09', 'P'||g, 'confiavel' FROM generate_series(1,4) g`, [vigente]);
    await q(`INSERT INTO central_vendas_mp_payments (sync_run_id, cliente_id, cliente_conta_id, payment_id)
             SELECT r, 1, 5, 'PAY'||g FROM generate_series(1,3) g, unnest($1::bigint[]) r`, [[r1.id, r2.id]]);

    process.env.DATABASE_URL = url.toString(); // o service só usa o db injetado; isto evita qualquer pool padrão
    const { gerarRaioXCliente } = require("../services/raioX/raioXClienteService");
    const rx = await gerarRaioXCliente({ clienteSlug: "loja" }, { db: pool });
    if (process.env.SAIDA_EXEMPLO) fs.writeFileSync(process.env.SAIDA_EXEMPLO, JSON.stringify(rx, null, 2));
    ok("ok", rx.ok === true && rx.versao === "raio-x-cliente/v1");
    eq("contas do cliente", rx.contas.map((c) => c.id), [5, 6]);
    ok("grant sem token no retorno", JSON.stringify(rx).indexOf("SEGREDO") === -1);
    const g = rx.centralVendas.porContaCompetencia.find((x) => x.competencia === "2026-09" && x.clienteContaId === 5);
    eq("vigente = mesma seleção canônica dos leitores", g.vigente.importId, Number(vigente));
    eq("1 cópia superada, 290 pedidos nela", [g.copiasSuperadas, g.pedidosEmCopiasSuperadas], [1, 290]);
    const m = rx.centralVendas.porContaCompetencia.find((x) => x.competencia === "2026-08");
    eq("planilha manual aparece como protegida", m.manuaisProtegidos.length, 1);
    ok("candidate órfão listado", rx.centralVendas.totais.candidatesNaoPublicados === 1);
    const mp = rx.mercadoPago.porConta.find((x) => x.clienteContaId === 5);
    eq("MP: 6 linhas para 3 payments = 2 cópias por payment", [mp.linhas, mp.paymentsDistintos, mp.copiasPorPayment], [6, 3, 2]);
    const inc = Object.fromEntries(rx.inconsistencias.map((i) => [i.codigo, i.ocorrencias]));
    eq("import com conta de outro cliente detectado", inc.import_com_conta_de_outro_cliente, 1);
    eq("conta ML sem grant detectada (conta 6)", inc.conta_meli_sem_grant, 1);
    const tImports = rx.tabelas.find((t) => t.tabela === "central_vendas_imports");
    eq("contagem de imports do cliente", tImports.linhas, 5);
    ok("tamanho marcado como estimativa", rx.estimativaTamanho.exato === false && typeof tImports.bytesEstimados === "number");
    const tPedidos = rx.tabelas.find((t) => t.tabela === "central_vendas_pedidos");
    eq("modo rápido não conta tabela filha", tPedidos.status, "so_no_modo_detalhado");
    const manual = rx.tabelas.find((t) => t.tabela === "painel_contas_lancamentos_manuais");
    ok("lançamento manual contado e marcado manual", manual.linhas === 1 && manual.manual === true);
    ok("tabela inexistente não quebra", rx.tabelas.find((t) => t.tabela === "sentinel_pedidos").status === "nao_existe");

    const det = await gerarRaioXCliente({ clienteId: 1 }, { db: pool, detalhado: true });
    eq("modo detalhado conta pedidos via import_id", det.tabelas.find((t) => t.tabela === "central_vendas_pedidos").linhas, 4);

    // Read-only de verdade: nada mudou no banco.
    const [{ n }] = await q("SELECT COUNT(*)::int AS n FROM central_vendas_imports");
    eq("nenhuma linha alterada", n, 5);
    ok("antigo continua lá (Raio-X nunca apaga)", (await q("SELECT 1 FROM central_vendas_imports WHERE id = $1", [antigo])).length === 1);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS "${nome}" WITH (FORCE)`);
    await admin.end();
  }
}

(async () => {
  await semBanco();
  await comBanco();
  console.log(`raioXCliente.postgres.test.js: ${checks} verificacoes OK`);
})().catch((err) => { console.error(err); process.exit(1); });
