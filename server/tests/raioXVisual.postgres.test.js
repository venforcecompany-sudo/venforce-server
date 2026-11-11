// server/tests/raioXVisual.postgres.test.js
//
// Raio-X VISUAL no caminho REAL, contra PostgreSQL LOCAL descartável:
//   CENTRAL_VENDAS_PG_TEST_DATABASE_URL=postgres://vf@127.0.0.1:57651/postgres node tests/raioXVisual.postgres.test.js
// Sem a variável PULA. Cobre: visão geral (tamanhos reais, tabelas fora do
// inventário), lista de clientes/contas, Raio-X do cliente por conta (filtro),
// vínculos de reuso (fornece/referencia), garantia de somente-leitura e o
// servidor com --real (cache, só GET, nada escrito).

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const LOCAL = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
let checks = 0;
const ok = (l, c) => { assert.ok(c, `FALHOU: ${l}`); checks += 1; };
const eq = (l, a, b) => { assert.deepStrictEqual(a, b, `FALHOU: ${l} — recebido ${JSON.stringify(a)}`); checks += 1; };

const FIXTURES = `
CREATE TABLE users (id integer PRIMARY KEY);
CREATE TABLE clientes (id integer PRIMARY KEY, nome text, slug text UNIQUE, ativo boolean DEFAULT true);
CREATE TABLE cliente_contas (id integer PRIMARY KEY, cliente_id integer REFERENCES clientes(id), marketplace text, nome text,
  slug text, external_account_id text, is_primary boolean DEFAULT false, ativo boolean DEFAULT true, created_at timestamp DEFAULT now());
CREATE TABLE ml_tokens (id integer PRIMARY KEY, cliente_id integer, ml_user_id text, access_token text, refresh_token text,
  is_primary boolean, token_status text, refresh_failures int DEFAULT 0, superseded_at timestamptz, expires_at timestamp, updated_at timestamp DEFAULT now());
CREATE TABLE bases (id integer PRIMARY KEY);
CREATE TABLE tabela_que_ninguem_mapeou (id serial PRIMARY KEY, x text);
INSERT INTO tabela_que_ninguem_mapeou (x) SELECT repeat('a', 200) FROM generate_series(1, 500);
INSERT INTO users VALUES (1);
INSERT INTO clientes VALUES (1, 'Loja', 'loja', true), (2, 'Outra', 'outra', true);
INSERT INTO cliente_contas (id, cliente_id, marketplace, nome, slug, external_account_id, is_primary) VALUES
  (5, 1, 'meli', 'ML 1', 'loja-ml1', '111', true), (6, 1, 'meli', 'ML 2', 'loja-ml2', '222', false), (7, 2, 'meli', 'Outra', 'outra-ml', '333', true);
INSERT INTO ml_tokens (id, cliente_id, ml_user_id, access_token, refresh_token, is_primary, token_status, expires_at)
  VALUES (100, 1, '111', 'SEGREDO-ACCESS', 'SEGREDO-REFRESH', true, 'valid', now() + interval '1 day');
`;

function get(porta, caminho, metodo = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: porta, path: caminho, method: metodo }, (res) => {
      let b = ""; res.on("data", (d) => { b += d; }); res.on("end", () => resolve({ status: res.statusCode, corpo: b }));
    });
    req.on("error", reject); req.end();
  });
}

async function main() {
  const baseUrl = process.env.CENTRAL_VENDAS_PG_TEST_DATABASE_URL;
  if (!baseUrl) { console.log("raioXVisual.postgres.test.js: PULADO (defina CENTRAL_VENDAS_PG_TEST_DATABASE_URL)"); return; }
  if (!LOCAL.has(new URL(baseUrl).hostname)) throw new Error("LOCAL_DATABASE_REQUIRED");
  const { Client, Pool } = require("pg");
  const admin = new Client({ connectionString: baseUrl, ssl: false });
  await admin.connect();
  const nome = `vf_raiox_visual_${Date.now()}`;
  await admin.query(`CREATE DATABASE "${nome}"`);
  const url = new URL(baseUrl); url.pathname = `/${nome}`; url.searchParams.set("sslmode", "disable");
  const pool = new Pool({ connectionString: url.toString(), ssl: false });
  let srv = null;
  try {
    await pool.query(FIXTURES);
    await pool.query(fs.readFileSync(path.join(__dirname, "..", "sql", "central_vendas_schema.sql"), "utf8"));
    await pool.query(fs.readFileSync(path.join(__dirname, "..", "sql", "migrations", "20261111_central_vendas_import_pedidos.sql"), "utf8"));
    const q = (s, p) => pool.query(s, p).then((r) => r.rows);
    // Conta 5: fornecedor (A) e referenciador (B, vigente). Conta 6: um import simples.
    const imp = async (conta, comp, st, pub) => (await q(`INSERT INTO central_vendas_imports (cliente_id, cliente_slug, marketplace, competencia, fonte, cliente_conta_id, publication_status, coverage_date_from, coverage_date_to, published_at, resumo_json, payload_json)
      VALUES (1,'loja','meli',$1::text,'orders_api',$2,$3,($1::text||'-01')::date,($1::text||'-30')::date,$4,'{"pedidosTotal":2}','{}') RETURNING id`, [comp, conta, st, pub]))[0].id;
    const A = Number(await imp(5, "2026-09", "published", "2026-10-01T00:00:00Z"));
    const B = Number(await imp(5, "2026-09", "published", "2026-10-02T00:00:00Z"));
    const C = await imp(6, "2026-09", "published", "2026-10-02T00:00:00Z");
    const ped = async (importId, pid) => (await q(`INSERT INTO central_vendas_pedidos (import_id, cliente_id, cliente_slug, marketplace, competencia, pedido_id, confianca, data_pedido) VALUES ($1,1,'loja','meli','2026-09',$2,'confiavel','2026-09-05') RETURNING id`, [importId, pid]))[0].id;
    const p1 = await ped(A, "X1"); const p2 = await ped(A, "X2"); await ped(B, "X3"); await ped(C, "Y1");
    await pool.query(`INSERT INTO central_vendas_import_pedidos (import_id, pedido_row_id) VALUES ($1,$2),($1,$3)`, [B, p1, p2]);
    const tokens = (await q(`SELECT access_token FROM ml_tokens`))[0].access_token;
    const contagemAntes = (await q(`SELECT (SELECT COUNT(*) FROM central_vendas_imports)::int i, (SELECT COUNT(*) FROM central_vendas_import_pedidos)::int v, (SELECT COUNT(*) FROM clientes)::int c`))[0];

    process.env.DATABASE_URL = url.toString();
    const svc = require("../services/raioX/raioXVisualService");
    const dbApp = require("../config/database");

    // ---- visão geral
    const v = await svc.visaoGeral(dbApp);
    ok("visão geral: banco, tamanho real e versão", v.bytesBanco > 0 && /^\d+/.test(v.versaoPostgres));
    ok("visão geral: tabela fora do inventário aparece como não mapeada", v.tabelas.some((t) => t.tabela === "tabela_que_ninguem_mapeou" && !t.mapeada && t.bytesTotal > 0));
    ok("visão geral: tabelas do inventário agrupadas por domínio", v.porDominio.some((d) => d.dominio === "Central de Vendas" && d.bytes > 0));
    ok("visão geral: tabela de vínculos classificada como vínculo (reuso)", v.tabelas.find((t) => t.tabela === "central_vendas_import_pedidos").classe === "vinculo");
    ok("visão geral: lista o que o catálogo conhece e o banco não tem", v.resumo.tabelasDoCatalogoSemTabelaNoBanco.includes("sentinel_pedidos"));
    eq("visão geral: contagem de clientes/contas", [v.clientes, v.contas], [2, 3]);

    // ---- clientes
    const cs = await svc.listarClientes(dbApp);
    eq("clientes: contas agrupadas por cliente", cs.map((c) => [c.slug, c.contas.map((x) => x.id)]), [["loja", [5, 6]], ["outra", [7]]]);

    // ---- cliente (todas as contas) e por conta
    const todas = await svc.raioXDoCliente(dbApp, { clienteSlug: "loja" });
    ok("cliente: ok com motores e oportunidades", todas.ok && todas.motores.length >= 10 && todas.oportunidades.length > 0);
    const impsDoCliente = todas.vinculos.imports.map((i) => [i.importId, i.papel]).sort((a, b) => a[0] - b[0]);
    eq("vínculos: A fornece, B referencia", impsDoCliente, [[A, "fornece"], [B, "referencia"]]);
    ok("vínculos: A é usado por B", todas.vinculos.imports.find((i) => i.importId === A).usadoPorImports.includes(B));
    const vigente5 = todas.centralVendas.porContaCompetencia.find((p) => p.clienteContaId === 5);
    eq("central: vigente da conta 5 é o import mais recente (B)", Number(vigente5.vigente.importId), B);
    const conta6 = await svc.raioXDoCliente(dbApp, { clienteSlug: "loja", contaId: 6 });
    eq("por conta: vínculos da conta 5 não aparecem na conta 6", conta6.vinculos.imports, []);
    ok("por conta: tabela com identidade de conta é filtrada (escopo conta)", conta6.tabelas.find((t) => t.tabela === "central_vendas_imports").escopo === "conta" && conta6.tabelas.find((t) => t.tabela === "central_vendas_imports").linhas === 1);
    ok("por conta: tabela só de cliente fica marcada como escopo cliente", conta6.tabelas.find((t) => t.tabela === "ml_tokens").escopo === "cliente");
    eq("por conta: cliente inteiro vê as 3 linhas", todas.tabelas.find((t) => t.tabela === "central_vendas_imports").linhas, 3);
    const alheia = await svc.raioXDoCliente(dbApp, { clienteSlug: "loja", contaId: 7 });
    eq("conta de outro cliente é recusada", alheia.codigo, "CONTA_NAO_PERTENCE_AO_CLIENTE");
    ok("qualidade da Central é calculada com regra identificada", todas.motores.find((m) => m.id === "central_vendas").qualidade.regra.includes("heurística"));
    ok("nenhum token/segredo aparece em nenhuma resposta", !JSON.stringify([v, cs, todas, conta6]).includes("SEGREDO"));

    // ---- somente leitura: nada mudou
    const contagemDepois = (await q(`SELECT (SELECT COUNT(*) FROM central_vendas_imports)::int i, (SELECT COUNT(*) FROM central_vendas_import_pedidos)::int v, (SELECT COUNT(*) FROM clientes)::int c`))[0];
    eq("somente leitura: contagens idênticas", contagemDepois, contagemAntes);
    // …e a camada recusa escrita mesmo se pedirem (transação READ ONLY).
    let codigo = null;
    try { await svc.somenteLeitura(dbApp, (c) => c.query(`DELETE FROM clientes WHERE id = 2`)); } catch (e) { codigo = e.code; }
    eq("somente leitura: DELETE dentro da camada é recusado (25006)", codigo, "25006");
    ok("somente leitura: cliente 2 continua existindo", (await q(`SELECT 1 FROM clientes WHERE id = 2`)).length === 1);
    // Sem a tabela de vínculos: status 'tabela_ausente', nunca erro.
    await pool.query(`ALTER TABLE central_vendas_import_pedidos RENAME TO central_vendas_import_pedidos_off`);
    eq("tabela de vínculos ausente ⇒ tabela_ausente", (await svc.vinculosDoCliente(dbApp, "loja")).status, "tabela_ausente");
    await pool.query(`ALTER TABLE central_vendas_import_pedidos_off RENAME TO central_vendas_import_pedidos`);

    // ---- servidor com --real
    const porta = 48000 + Math.floor(Math.random() * 1000);
    srv = spawn(process.execPath, [path.join(__dirname, "..", "scripts", "raio-x-visual.js"), "--real", "--porta", String(porta)], { env: { PATH: process.env.PATH, RAIO_X_DATABASE_URL: url.toString() }, stdio: "ignore" });
    let pronto = false;
    for (let i = 0; i < 60 && !pronto; i++) { try { pronto = (await get(porta, "/api/meta")).status === 200; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    ok("servidor --real sobe", pronto);
    const meta = JSON.parse((await get(porta, "/api/meta")).corpo);
    eq("meta: modo real e host local", [meta.modo, meta.host], ["real", "127.0.0.1"]);
    const rc = JSON.parse((await get(porta, `/api/cliente?slug=loja&conta=5`)).corpo);
    ok("API real: cliente por conta", rc.ok && rc.escopoConta === 5 && rc.vinculos.imports.length === 2);
    ok("API real: nenhum segredo", !JSON.stringify(rc).includes("SEGREDO"));
    eq("API real: POST recusado", (await get(porta, "/api/clientes", "POST")).status, 405);
    eq("API real: contagens do banco inalteradas", (await q(`SELECT COUNT(*)::int n FROM central_vendas_imports`))[0].n, contagemAntes.i);
    ok("API real: token continua intacto", (await q(`SELECT access_token FROM ml_tokens`))[0].access_token === tokens);
  } finally {
    if (srv) srv.kill();
    await pool.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS "${nome}" WITH (FORCE)`).catch(() => {});
    await admin.end();
  }
  console.log(`raioXVisual.postgres.test.js: ${checks} verificacoes OK`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
