// server/tests/clienteContasAuthPerRoute.test.js
//
// Hardening do hotfix fd487d4 ("fix: impedir auth global-bloqueio").
//
// Contexto do bug real: clienteContasRoutes.js usava `router.use(authMiddleware)`
// sem path. Como o router é montado em app.use("/", clienteContasRoutes)
// (index.js), esse `.use()` roda para QUALQUER path que chegue até ele —
// não só para as rotas que o próprio router declara. Isso incluía rotas de
// outros routers montados depois na cadeia (ex.: GET /public/entregas/:token
// em entregasClienteRoutes.js, que é deliberadamente pública — usada pelo
// Fechamento V3 para abrir o relatório publicado via token, sem login).
// O resultado: toda requisição pública que ainda não tinha sido respondida
// por um router anterior caía no authMiddleware global de clienteContasRoutes
// e levava 401 "Token não informado" antes de alcançar sua rota real —
// o Fechamento V3 não conseguia gerar/abrir o relatório.
//
// O hotfix moveu authMiddleware para ser explícito em cada rota de
// clienteContasRoutes (fd487d4). Isso restringe o efeito do middleware às
// rotas que o próprio router expõe, e não mais a qualquer path que passe
// por ele.
//
// Este teste cobre as duas pontas, na MESMA ordem de montagem de index.js
// (clienteContasRoutes antes de entregasClienteRoutes):
//   1. GET /public/entregas/:token sem Authorization não é bloqueado pelo
//      authMiddleware de clienteContasRoutes (prova de que o global-bloqueio
//      não volta).
//   2. Toda rota protegida de clienteContasRoutes continua exigindo
//      Authorization (prova de que remover o `.use()` global não abriu
//      nenhuma rota).

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/vf-test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "venforce_secret_local";

const assert = require("assert");
const express = require("express");

let checks = 0;
function ok(label, condition) {
  assert.ok(condition, `FALHOU: ${label}`);
  checks += 1;
  console.log(`  ok  ${label}`);
}

const pool = require("../config/database");

class MockDb {
  async query(sql) {
    const q = String(sql).replace(/\s+/g, " ").trim();
    if (q.includes("FROM users WHERE id")) return { rows: [] };
    if (q.includes("FROM entregas_cliente") && q.includes("token_publico")) return { rows: [] };
    throw new Error(`Query não mapeada no mock: ${q}`);
  }
}

async function run() {
  const originalQuery = pool.query;
  const db = new MockDb();
  pool.query = (sql, params) => db.query(sql, params);

  let servidor;
  try {
    // Mesma ordem de index.js: clienteContasRoutes ("/") ANTES de
    // entregasClienteRoutes ("/"), que é onde a rota pública mora.
    const clienteContasRoutes = require("../routes/clienteContasRoutes");
    const entregasClienteRoutes = require("../routes/entregasClienteRoutes");

    const app = express();
    app.use(express.json());
    app.use("/", clienteContasRoutes);
    app.use("/", entregasClienteRoutes);

    servidor = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const base = `http://127.0.0.1:${servidor.address().port}`;

    console.log("\n▸ rota pública (Fechamento V3) não é bloqueada pelo router montado antes dela");
    const publica = await fetch(`${base}/public/entregas/token-inexistente`);
    const publicaBody = await publica.json();
    ok(
      "GET /public/entregas/:token sem Authorization NÃO retorna 401 'Token não informado' (não é interceptada por clienteContasRoutes)",
      !(publica.status === 401 && publicaBody?.erro === "Token não informado")
    );
    ok("GET /public/entregas/:token chegou de fato até a rota real (404 — token não encontrado)", publica.status === 404);

    console.log("\n▸ todas as rotas de clienteContasRoutes continuam exigindo Authorization");
    const rotasProtegidas = [
      { metodo: "GET", caminho: "/clientes/1/contas" },
      { metodo: "POST", caminho: "/clientes/1/contas" },
      { metodo: "GET", caminho: "/cliente-contas/1" },
      { metodo: "PATCH", caminho: "/cliente-contas/1" },
      { metodo: "PATCH", caminho: "/cliente-contas/1/principal" },
      { metodo: "GET", caminho: "/cliente-contas/1/base" },
      { metodo: "GET", caminho: "/cliente-contas/1/bases-elegiveis" },
      { metodo: "PUT", caminho: "/cliente-contas/1/base" },
      { metodo: "DELETE", caminho: "/cliente-contas/1/ml-grant" },
    ];

    for (const { metodo, caminho } of rotasProtegidas) {
      const res = await fetch(`${base}${caminho}`, { method: metodo });
      const body = await res.json().catch(() => null);
      ok(
        `${metodo} ${caminho} sem Authorization -> 401 'Token não informado'`,
        res.status === 401 && body?.erro === "Token não informado"
      );
    }

    console.log(`\n✓ clienteContasAuthPerRoute: ${checks} verificações`);
  } finally {
    pool.query = originalQuery;
    if (servidor) await new Promise((resolve) => servidor.close(resolve));
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
