const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  { spawnSync } = require("node:child_process");
const { fixture, manifest } = require("./helpers/clientesUnificacaoFixture");
const { buildPlan } = require("../services/clientesUnificacao/planner");
const {
  candidatePairs,
  similarity,
} = require("../services/clientesUnificacao/candidates");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "unificacao-v1-cli-"));
try {
  const s = fixture(),
    m = manifest(),
    snap = path.join(directory, "snapshot.json"),
    man = path.join(directory, "manifest.json");
  fs.writeFileSync(snap, JSON.stringify(s));
  fs.writeFileSync(man, JSON.stringify(m));
  const args = ["--manifest", man, "--snapshot", snap],
    cli = path.resolve(__dirname, "../scripts/unificacaoClientes/cli.js");
  const run = (mode) =>
    spawnSync(process.execPath, [cli, mode, ...args], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        DATABASE_URL: "INVALID_NO_DATABASE_CONNECTION_ALLOWED",
      },
    });
  const p = run("--plan");
  assert.equal(p.status, 0, p.stderr);
  assert.equal(JSON.parse(p.stdout).planHash, buildPlan(s, m).planHash);
  assert.equal(run("--validate").status, 0);
  m.aprovacao.aprovada = false;
  fs.writeFileSync(man, JSON.stringify(m));
  const blocked = run("--validate");
  assert.equal(blocked.status, 2);
  assert.equal(JSON.parse(blocked.stdout).writeCapability, false);
  assert.equal(
    candidatePairs({
      clientes: [
        { id: 1, nome: "Empresa X ML 1", slug: "empresa-x-ml1" },
        { id: 2, nome: "Empresa X ML 2", slug: "empresa-x-ml2" },
      ],
      cliente_squad_history: [
        { cliente_id: 1, squad_id: 1 },
        { cliente_id: 2, squad_id: 1 },
      ],
    }).length,
    1,
  );
  const data = {
    clientes: [
      { id: 1, nome: "A", slug: "a" },
      { id: 2, nome: "B", slug: "b" },
    ],
    cliente_contas: [
      { cliente_id: 1, external_account_id: "SHARED" },
      { cliente_id: 2, external_account_id: "SHARED" },
    ],
  };
  assert.equal(candidatePairs(data)[0].classificacao, "DECISAO_HUMANA");
  assert.equal(candidatePairs(data)[0].cliente_canonico_aprovado, null);
  const python = spawnSync(
    "python3",
    [
      "-c",
      'import difflib,json;print(json.dumps([difflib.SequenceMatcher(None,a,b).ratio() for a,b in [("empresa abc","empresa abd"),("abcd","bcde"),("",""),("aaaaab","baaaaa")]]))',
    ],
    { encoding: "utf8" },
  );
  assert.equal(python.status, 0);
  assert.deepEqual(
    JSON.parse(python.stdout),
    [
      ["empresa abc", "empresa abd"],
      ["abcd", "bcde"],
      ["", ""],
      ["aaaaab", "baaaaa"],
    ].map(([a, b]) => similarity(a, b)),
  );
  console.log(
    "CLI v1 usa o mesmo hash/validator da API; triagem compartilha semântica com inventário offline.",
  );
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
