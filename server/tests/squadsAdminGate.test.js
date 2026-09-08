// server/tests/squadsAdminGate.test.js
//
// Gate de admin na API de Squads (mission "Administração de Squads V1"):
//   - requireSquadAdmin: admin sempre passa; coordenador do squad da rota
//     passa (e marca req.coordenadorDoSquad); qualquer outro -> 403.
// Isso é o portão que a nova tela "Configuração de Squads" atravessa em
// toda escrita — sem UI, é o backend quem decide.

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/vf-test";

const assert = require("assert");
const pool = require("../config/database");

let checks = 0;
function ok(label, cond) { assert.ok(cond, `FALHOU: ${label}`); checks += 1; console.log(`  ok  ${label}`); }

const { requireSquadAdmin } = require("../controllers/squadsController");

function fakeRes() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

async function run() {
  const originalQuery = pool.query;

  // membership fixa: user 200 é coordenador ativo do squad 10.
  pool.query = async (sql, params = []) => {
    const q = String(sql).replace(/\s+/g, " ");
    if (q.includes("squads:EH_COORDENADOR")) {
      const [userId, squadId] = params;
      const ehCoord = Number(userId) === 200 && Number(squadId) === 10;
      return { rows: ehCoord ? [{ "?column?": 1 }] : [] };
    }
    return { rows: [] };
  };

  // ── admin sempre passa, mesmo sem membership ──
  {
    const req = { params: { id: "10" }, user: { id: 999, role: "admin" } };
    const res = fakeRes();
    let chamouNext = false;
    await requireSquadAdmin(req, res, () => { chamouNext = true; });
    ok("admin: chama next()", chamouNext === true);
    ok("admin: não seta coordenadorDoSquad", req.coordenadorDoSquad === undefined);
  }

  // ── coordenador do squad da rota passa ──
  {
    const req = { params: { id: "10" }, user: { id: 200, role: "membro" } };
    const res = fakeRes();
    let chamouNext = false;
    await requireSquadAdmin(req, res, () => { chamouNext = true; });
    ok("coordenador do squad 10: chama next()", chamouNext === true);
    ok("coordenador do squad 10: marca req.coordenadorDoSquad", req.coordenadorDoSquad === 10);
  }

  // ── coordenador de OUTRO squad não passa na rota do squad 10 ──
  {
    const req = { params: { id: "10" }, user: { id: 200, role: "membro" } };
    // simula coordenador do squad 20, não do 10 pedido na rota
    pool.query = async (sql, params = []) => {
      const q = String(sql).replace(/\s+/g, " ");
      if (q.includes("squads:EH_COORDENADOR")) {
        const [userId, squadId] = params;
        return { rows: Number(userId) === 200 && Number(squadId) === 20 ? [{ "?column?": 1 }] : [] };
      }
      return { rows: [] };
    };
    const res = fakeRes();
    let chamouNext = false;
    await requireSquadAdmin(req, res, () => { chamouNext = true; });
    ok("coordenador de outro squad: NÃO chama next()", chamouNext === false);
    ok("coordenador de outro squad: 403", res.statusCode === 403);
    ok("coordenador de outro squad: ok:false", res.body && res.body.ok === false);
  }

  // ── membro comum (não-admin, não-coordenador) -> 403 ──
  {
    pool.query = async () => ({ rows: [] });
    const req = { params: { id: "10" }, user: { id: 1, role: "membro" } };
    const res = fakeRes();
    let chamouNext = false;
    await requireSquadAdmin(req, res, () => { chamouNext = true; });
    ok("membro comum: NÃO chama next()", chamouNext === false);
    ok("membro comum: responde 403", res.statusCode === 403);
    ok("membro comum: ok:false", res.body && res.body.ok === false);
  }

  pool.query = originalQuery;
  console.log(`\n${checks} verificações OK (squadsAdminGate)`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
