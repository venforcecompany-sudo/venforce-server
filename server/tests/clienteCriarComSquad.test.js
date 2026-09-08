// server/tests/clienteCriarComSquad.test.js
//
// squadService.criarClienteComSquad — criação de Cliente + vínculo de Squad
// como UMA transação (mission "V3 — criação de cliente com squad"):
//   - sucesso -> cliente criado E cliente_squad_history aberto
//   - squad inexistente/inativo -> rejeita, nada persiste
//   - slug duplicado -> 409, nada persiste
//   - falha na 2ª escrita (history) -> ROLLBACK também desfaz a 1ª (cliente)
//
// Mock em memória igual squadServiceMutacoes.test.js: connect()/BEGIN/COMMIT/
// ROLLBACK simulados, sem banco real.

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

function novoModelo() {
  return {
    squads: [
      { id: 10, nome: "Alpha", ativo: true },
      { id: 30, nome: "Inativo", ativo: false },
    ],
    clientes: [], // {id, nome, slug, api_key, ativo, created_at}
    history: [], // {id, cliente_id, squad_id, fim_em, alterado_por, motivo}
    seqCliente: 1,
    seqHistory: 1,
    // controla se a próxima INSERT INTO cliente_squad_history deve falhar
    // (simula a "falha na atribuição" pedida pela missão)
    falharNoHistory: false,
  };
}

function instalar(m) {
  const oq = pool.query;
  const oc = pool.connect;

  function query(sql, params = []) {
    const q = String(sql).replace(/\s+/g, " ").trim();

    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(q) || q.includes("pg_advisory") || /^(CREATE|ALTER|DROP|DO )/i.test(q)) {
      return { rows: [] };
    }

    if (q.startsWith("SELECT id, nome, ativo FROM squads WHERE id = $1")) {
      return { rows: m.squads.filter((s) => s.id === Number(params[0])) };
    }

    if (q.startsWith("INSERT INTO clientes")) {
      const [nome, slug, apiKey] = params;
      if (m.clientes.some((c) => c.slug === slug)) { const e = new Error("dup"); e.code = "23505"; throw e; }
      const c = { id: m.seqCliente++, nome, slug, api_key: apiKey, ativo: true, created_at: new Date() };
      m.clientes.push(c);
      return { rows: [c] };
    }

    if (q.startsWith("INSERT INTO cliente_squad_history")) {
      if (m.falharNoHistory) { const e = new Error("falha simulada na atribuição"); throw e; }
      const [cliente_id, squad_id, alterado_por, motivo] = params;
      const h = { id: m.seqHistory++, cliente_id: Number(cliente_id), squad_id: Number(squad_id), fim_em: null, alterado_por, motivo };
      m.history.push(h);
      return { rows: [h] };
    }

    return { rows: [] };
  }

  // connect() precisa simular ROLLBACK de verdade: se BEGIN foi chamado e
  // depois um erro ocorre antes do COMMIT, as escritas feitas nesse client
  // devem ser desfeitas. Como o "banco" aqui é m.clientes/m.history direto
  // (sem staging), simulamos commit/rollback com um buffer por conexão.
  pool.query = (s, p) => Promise.resolve().then(() => query(s, p));
  pool.connect = async () => {
    let buffer = null; // { clientesAntes, historyAntes }
    return {
      query: (s, p) => Promise.resolve().then(() => {
        const qUp = String(s).trim().toUpperCase();
        if (qUp === "BEGIN") { buffer = { clientesAntes: m.clientes.length, historyAntes: m.history.length }; return { rows: [] }; }
        if (qUp === "COMMIT") { buffer = null; return { rows: [] }; }
        if (qUp === "ROLLBACK") {
          if (buffer) {
            m.clientes.length = buffer.clientesAntes;
            m.history.length = buffer.historyAntes;
            buffer = null;
          }
          return { rows: [] };
        }
        return query(s, p);
      }),
      release() {},
    };
  };
  return () => { pool.query = oq; pool.connect = oc; };
}

const squadService = require("../services/squads/squadService");

async function run() {
  const m = novoModelo();
  const restaurar = instalar(m);
  try {
    // 1. criar Cliente + Squad -> Cliente já nasce vinculado
    const r1 = await squadService.criarClienteComSquad(
      { nome: "Loja A", slug: "loja-a", apiKey: "vf_abc", squadId: 10 },
      999
    );
    ok("cliente criado com id", Number.isInteger(r1.cliente.id));
    ok("cliente devolvido com o squad escolhido", r1.squad.id === 10 && r1.squad.nome === "Alpha");
    ok("cliente 1 persistiu no modelo", m.clientes.some((c) => c.id === r1.cliente.id));

    // 2. histórico Cliente->Squad registrado
    const hist = m.history.find((h) => h.cliente_id === r1.cliente.id);
    ok("histórico cliente_squad_history criado", !!hist && hist.squad_id === 10 && hist.fim_em === null);
    ok("histórico guarda quem fez (alterado_por)", hist.alterado_por === 999);

    // 4. Squad inexistente -> rejeita
    const clientesAntesDoTeste4 = m.clientes.length;
    await lanca(
      "squad inexistente (999) -> 404 SQUAD_NAO_ENCONTRADO",
      () => squadService.criarClienteComSquad({ nome: "X", slug: "loja-x", apiKey: "vf_x", squadId: 999 }, 1),
      "SQUAD_NAO_ENCONTRADO"
    );
    ok("squad inexistente: nenhum cliente novo persistiu", m.clientes.length === clientesAntesDoTeste4);

    // 5. Squad inativo -> rejeita
    const clientesAntesDoTeste5 = m.clientes.length;
    await lanca(
      "squad inativo (30) -> 409 SQUAD_INATIVO",
      () => squadService.criarClienteComSquad({ nome: "Y", slug: "loja-y", apiKey: "vf_y", squadId: 30 }, 1),
      "SQUAD_INATIVO"
    );
    ok("squad inativo: nenhum cliente novo persistiu", m.clientes.length === clientesAntesDoTeste5);

    // slug duplicado -> 409, nada persiste
    const clientesAntesDup = m.clientes.length;
    await lanca(
      "slug duplicado (loja-a) -> 409 CLIENTE_SLUG_DUPLICADO",
      () => squadService.criarClienteComSquad({ nome: "Loja A2", slug: "loja-a", apiKey: "vf_dup", squadId: 10 }, 1),
      "CLIENTE_SLUG_DUPLICADO"
    );
    ok("slug duplicado: nenhum cliente novo persistiu", m.clientes.length === clientesAntesDup);

    // 3. falha na atribuição -> rollback da criação inteira (não sobra cliente órfão)
    m.falharNoHistory = true;
    const clientesAntesFalha = m.clientes.length;
    const historyAntesFalha = m.history.length;
    let falhou = false;
    try {
      await squadService.criarClienteComSquad({ nome: "Loja Z", slug: "loja-z", apiKey: "vf_z", squadId: 10 }, 1);
    } catch (e) { falhou = true; }
    ok("falha na atribuição do squad propaga o erro", falhou);
    ok("ROLLBACK: nenhum cliente órfão sobrou após falha na atribuição", m.clientes.length === clientesAntesFalha);
    ok("ROLLBACK: nenhum histórico parcial sobrou após falha na atribuição", m.history.length === historyAntesFalha);
    m.falharNoHistory = false;

    // squadId inválido -> 400, sem tocar o banco
    await lanca(
      "squadId inválido (0) -> 400 SQUAD_ID_INVALIDO",
      () => squadService.criarClienteComSquad({ nome: "W", slug: "loja-w", apiKey: "vf_w", squadId: 0 }, 1),
      "SQUAD_ID_INVALIDO"
    );

    console.log(`\nclienteCriarComSquad.test.js: ${checks} verificações passaram.`);
  } finally {
    restaurar();
  }
}

run().catch((err) => { console.error(err); process.exitCode = 1; });
