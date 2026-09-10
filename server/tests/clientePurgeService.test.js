// server/tests/clientePurgeService.test.js
//
// clientePurgeService.purgarClientePermanentemente — exclusão administrativa
// REAL de Cliente (mission "admin precisa poder excluir cliente de
// verdade", set/2026): apaga explicitamente as tabelas SEM FK para
// clientes(id) (que o Postgres não cuida sozinho) e deixa o
// DELETE FROM clientes final cascatear o resto — tudo numa transação só,
// com ROLLBACK completo se qualquer etapa falhar.
//
// Mock em memória igual clienteCriarComSquad.test.js: connect()/BEGIN/
// COMMIT/ROLLBACK simulados com snapshot de todas as "tabelas" envolvidas,
// sem banco real.

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/vf-test";

const assert = require("assert");
const pool = require("../config/database");

let checks = 0;
function ok(label, cond) {
  assert.ok(cond, `FALHOU: ${label}`);
  checks += 1;
  console.log(`  ok  ${label}`);
}
async function lanca(label, fn, codeEsperado) {
  let e;
  try { await fn(); } catch (err) { e = err; }
  assert.ok(e, `FALHOU (não lançou): ${label}`);
  if (codeEsperado) assert.ok(e.code === codeEsperado, `FALHOU (code): ${label} — veio ${e.code}`);
  checks += 1;
  console.log(`  ok  ${label}`);
}

// Mesmo conjunto de tabelas "sem FK" do serviço real.
const TABELAS_POR_ID = [
  "relatorios",
  "meli_anuncios",
  "meli_anuncio_otimizacoes",
  "meli_anuncio_publicacoes",
  "cliente_360_acoes",
  "promocoes_diagnosticos",
  "central_vendas_imports",
];
const TABELAS_POR_SLUG = ["ads_acompanhamentos", "ads_resumos_mensais"];
const TODAS_TABELAS = [...TABELAS_POR_ID, ...TABELAS_POR_SLUG];

function novoModelo() {
  const m = {
    clientes: [{ id: 1, nome: "Extra Máquinas", slug: "extra-maquinas" }],
    // falhar a etapa final (DELETE FROM clientes) simula FK violation de
    // uma dependência CASCADE que o teste não está modelando diretamente
    // (ex.: migração não aplicada nesse ambiente) — deve dar ROLLBACK total.
    falharDeleteClientes: false,
  };
  for (const t of TODAS_TABELAS) m[t] = [];
  return m;
}

function instalar(m) {
  const oc = pool.connect;

  function deletarPorColuna(tabela, coluna, valor) {
    const antes = m[tabela].length;
    m[tabela] = m[tabela].filter((row) => row[coluna] !== valor);
    return antes - m[tabela].length;
  }

  pool.connect = async () => {
    let snapshot = null;
    return {
      query: (sqlRaw, params = []) => Promise.resolve().then(() => {
        const sql = String(sqlRaw).replace(/\s+/g, " ").trim();
        const qUp = sql.toUpperCase();

        if (qUp === "BEGIN") {
          snapshot = { clientes: [...m.clientes] };
          for (const t of TODAS_TABELAS) snapshot[t] = [...m[t]];
          return { rows: [] };
        }
        if (qUp === "COMMIT") { snapshot = null; return { rows: [] }; }
        if (qUp === "ROLLBACK") {
          if (snapshot) {
            m.clientes = snapshot.clientes;
            for (const t of TODAS_TABELAS) m[t] = snapshot[t];
            snapshot = null;
          }
          return { rows: [] };
        }

        if (sql.startsWith("SELECT id, nome, slug FROM clientes WHERE slug = $1 FOR UPDATE")) {
          return { rows: m.clientes.filter((c) => c.slug === params[0]) };
        }

        for (const tabela of TABELAS_POR_ID) {
          if (sql === `DELETE FROM ${tabela} WHERE cliente_id = $1`) {
            const total = deletarPorColuna(tabela, "cliente_id", Number(params[0]));
            return { rowCount: total };
          }
        }
        for (const tabela of TABELAS_POR_SLUG) {
          if (sql === `DELETE FROM ${tabela} WHERE cliente_slug = $1`) {
            const total = deletarPorColuna(tabela, "cliente_slug", params[0]);
            return { rowCount: total };
          }
        }

        if (sql === "DELETE FROM clientes WHERE id = $1 RETURNING id") {
          if (m.falharDeleteClientes) {
            const e = new Error(
              'update or delete on table "clientes" violates foreign key constraint'
            );
            e.code = "23503";
            e.detail = "Key (id)=(1) is still referenced from table \"alguma_tabela_nao_mapeada\".";
            throw e;
          }
          const antes = m.clientes.length;
          const id = Number(params[0]);
          m.clientes = m.clientes.filter((c) => c.id !== id);
          return { rows: antes !== m.clientes.length ? [{ id }] : [] };
        }

        return { rows: [] };
      }),
      release() {},
    };
  };
  return () => { pool.connect = oc; };
}

const { purgarClientePermanentemente } = require("../services/clientes/clientePurgeService");

async function run() {
  const m = novoModelo();
  const restaurar = instalar(m);
  try {
    // 1. cliente inexistente -> 404, nada é tocado
    await lanca(
      "cliente inexistente -> 404 CLIENTE_NAO_ENCONTRADO",
      () => purgarClientePermanentemente("nao-existe"),
      "CLIENTE_NAO_ENCONTRADO"
    );

    // 2. cliente "vazio" (sem nenhuma dependência) -> apaga direto, apagados=[]
    m.clientes.push({ id: 2, nome: "Cliente Vazio", slug: "cliente-vazio" });
    const r1 = await purgarClientePermanentemente("cliente-vazio");
    ok("cliente vazio: purge apaga o cliente", !m.clientes.some((c) => c.slug === "cliente-vazio"));
    ok("cliente vazio: nada para relatar em apagados", r1.apagados.length === 0);

    // 3. cliente COM dependências em tabelas sem FK -> apaga tudo, relata cada tabela
    m.clientes.push({ id: 1, nome: "Extra Máquinas", slug: "extra-maquinas" });
    m.relatorios.push({ id: 10, cliente_id: 1 }, { id: 11, cliente_id: 1 });
    m.meli_anuncios.push({ id: 20, cliente_id: 1 });
    m.cliente_360_acoes.push({ id: 30, cliente_id: 1 });
    m.central_vendas_imports.push({ id: 40, cliente_id: 1 });
    m.ads_acompanhamentos.push({ id: 50, cliente_slug: "extra-maquinas" });
    m.ads_resumos_mensais.push({ id: 51, cliente_slug: "extra-maquinas" });
    // dado de OUTRO cliente na mesma tabela não pode ser afetado
    m.relatorios.push({ id: 99, cliente_id: 999 });
    m.ads_acompanhamentos.push({ id: 98, cliente_slug: "outro-cliente" });

    const r2 = await purgarClientePermanentemente("extra-maquinas");
    ok("purge com dependências: cliente foi apagado", !m.clientes.some((c) => c.slug === "extra-maquinas"));
    ok("purge apagou os 2 relatórios do cliente", !m.relatorios.some((x) => x.cliente_id === 1));
    ok("purge NÃO tocou relatório de outro cliente", m.relatorios.some((x) => x.id === 99));
    ok("purge apagou meli_anuncios do cliente", m.meli_anuncios.length === 0);
    ok("purge apagou cliente_360_acoes do cliente", m.cliente_360_acoes.length === 0);
    ok("purge apagou central_vendas_imports do cliente", m.central_vendas_imports.length === 0);
    ok("purge apagou ads_acompanhamentos (por slug) do cliente", !m.ads_acompanhamentos.some((x) => x.id === 50));
    ok("purge NÃO tocou ads_acompanhamentos de outro cliente (slug)", m.ads_acompanhamentos.some((x) => x.id === 98));
    ok("purge apagou ads_resumos_mensais (por slug) do cliente", m.ads_resumos_mensais.length === 0);
    ok(
      "apagados relata tabela+total para cada tabela com dado real",
      r2.apagados.some((a) => a.tabela === "relatorios" && a.total === 2) &&
      r2.apagados.some((a) => a.tabela === "meli_anuncios" && a.total === 1) &&
      r2.apagados.some((a) => a.tabela === "ads_acompanhamentos" && a.total === 1)
    );
    ok("apagados NÃO lista tabelas sem dado nenhum (ex.: promocoes_diagnosticos)", !r2.apagados.some((a) => a.tabela === "promocoes_diagnosticos"));

    // 4. falha na etapa final (DELETE FROM clientes) -> ROLLBACK completo:
    //    nenhuma das deleções explícitas anteriores fica persistida.
    m.clientes.push({ id: 3, nome: "Cliente Instável", slug: "cliente-instavel" });
    m.relatorios.push({ id: 60, cliente_id: 3 });
    m.meli_anuncios.push({ id: 61, cliente_id: 3 });
    m.falharDeleteClientes = true;
    const relatoriosAntes = m.relatorios.length;
    const meliAntes = m.meli_anuncios.length;
    await lanca(
      "falha no DELETE final (FK violation simulada) -> 409 PURGE_BLOQUEADO_POR_DEPENDENCIA",
      () => purgarClientePermanentemente("cliente-instavel"),
      "PURGE_BLOQUEADO_POR_DEPENDENCIA"
    );
    ok("ROLLBACK: cliente instável NÃO foi apagado", m.clientes.some((c) => c.slug === "cliente-instavel"));
    ok("ROLLBACK: relatórios do cliente instável voltaram (nenhum apagado ficou)", m.relatorios.length === relatoriosAntes);
    ok("ROLLBACK: meli_anuncios do cliente instável voltaram (nenhum apagado ficou)", m.meli_anuncios.length === meliAntes);
    m.falharDeleteClientes = false;

    console.log(`\nclientePurgeService.test.js: ${checks} verificações passaram.`);
  } finally {
    restaurar();
  }
}

run().catch((err) => { console.error(err); process.exitCode = 1; });
