// server/tests/squadsInventarioReadonly.test.js
//
// VenForce V3 — P2.9 Real Data Readiness.
//
// Cobre server/sql/squads-inventario-readonly.js:
//   - classificação de Grants (BLOCO F), Bases (BLOCO G) e duplicatas D4 (BLOCO H)
//     — funções puras, exercitadas com fixtures em memória;
//   - as GARANTIAS DE SEGURANÇA do script, verificadas estaticamente sobre o
//     próprio texto do arquivo: nenhuma escrita, transação read-only, rollback.
//
// ZERO banco: nada aqui abre conexão.

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/vf-test";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const inv = require("../sql/squads-inventario-readonly");

let checks = 0;
function ok(label, cond) { assert.ok(cond, `FALHOU: ${label}`); checks += 1; console.log(`  ok  ${label}`); }

function run() {
  console.log("\n1. BLOCO F — classificação de Grants\n");
  {
    const fixture = {
      cliente_contas: [
        // cliente 1: uma conta meli ativa (caso legado resolúvel)
        { id: 11, cliente_id: 1, marketplace: "meli", ativo: true },
        // cliente 2: DUAS contas meli ativas (caso ambíguo)
        { id: 21, cliente_id: 2, marketplace: "meli", ativo: true },
        { id: 22, cliente_id: 2, marketplace: "meli", ativo: true },
      ],
      grants: [
        { id: 100, cliente_id: 1, cliente_conta_id: 11, ml_user_id: "A", token_status: "valid" },
        { id: 101, cliente_id: 1, cliente_conta_id: null, ml_user_id: "B", token_status: "valid" },
        { id: 102, cliente_id: 2, cliente_conta_id: null, ml_user_id: "C", token_status: "valid" },
        { id: 103, cliente_id: 2, cliente_conta_id: 21, ml_user_id: "D", token_status: "revoked" },
      ],
    };
    const r = inv.classificarGrants(fixture);
    ok("grant com cliente_conta_id → EXATO", r.EXATO === 1);
    ok("grant sem conta, cliente com 1 conta → LEGADO_SINGLE_ACCOUNT", r.LEGADO_SINGLE_ACCOUNT === 1);
    ok("grant sem conta, cliente com 2 contas → AMBIGUO", r.AMBIGUO === 1);
    ok("token revogado → DESCONECTADO (mesmo com conta resolvida)", r.DESCONECTADO === 1);
    ok("casos ambíguos/desconectados são listados", r.casos.length === 2);
    ok("caso ambíguo identifica o cliente",
      r.casos.some((c) => c.classe === "AMBIGUO" && c.cliente_id === 2));
  }

  console.log("\n2. BLOCO G — classificação de Bases\n");
  {
    const fixture = {
      clientes: [
        { id: 1, slug: "um", ativo: true, contas_ativas: 1 },
        { id: 2, slug: "dois", ativo: true, contas_ativas: 2 },
        { id: 3, slug: "tres", ativo: true, contas_ativas: 1 }, // sem vínculo de base
        { id: 4, slug: "quatro", ativo: false, contas_ativas: 1 }, // inativo: não conta
      ],
      cliente_contas: [
        { id: 11, cliente_id: 1, marketplace: "meli", ativo: true },
        { id: 21, cliente_id: 2, marketplace: "meli", ativo: true },
        { id: 22, cliente_id: 2, marketplace: "meli", ativo: true },
        { id: 31, cliente_id: 3, marketplace: "meli", ativo: true },
      ],
      base_vinculos: [
        { id: 900, base_id: 1, base_slug: "b1", cliente_id: 1, cliente_conta_id: 11, marketplace: "meli", ativo: true },
        { id: 901, base_id: 2, base_slug: "b2", cliente_id: 1, cliente_conta_id: null, marketplace: "meli", ativo: true },
        { id: 902, base_id: 3, base_slug: "b3", cliente_id: 2, cliente_conta_id: null, marketplace: "meli", ativo: true },
        { id: 903, base_id: 4, base_slug: "b4", cliente_id: 2, cliente_conta_id: null, marketplace: "meli", ativo: false },
      ],
    };
    const r = inv.classificarBases(fixture);
    ok("vínculo com cliente_conta_id → EXATA", r.EXATA === 1);
    ok("cliente_conta_id NULL + 1 conta → CLIENT_LEVEL_LEGADA", r.CLIENT_LEVEL_LEGADA === 1);
    ok("cliente_conta_id NULL + 2 contas → AMBIGUA", r.AMBIGUA === 1);
    ok("cliente ativo com conta e sem vínculo → AUSENTE", r.AUSENTE === 1);
    ok("cliente INATIVO não vira AUSENTE",
      !r.casos.some((c) => c.cliente_slug === "quatro"));
    ok("vínculo inativo é ignorado", r.EXATA + r.CLIENT_LEVEL_LEGADA + r.AMBIGUA === 3);
  }

  console.log("\n3. BLOCO H — classificação D4\n");
  {
    ok("sem duplicatas → classe A", inv.classificarD4({ d4_duplicatas: [] }).A_sem_duplicata === 1);

    const r = inv.classificarD4({
      d4_duplicatas: [
        { cliente_id: 1, cliente_conta_id: 11, periodo: "2026-05", total: 2, publicadas: 0, ids: [9, 8] },
        { cliente_id: 2, cliente_conta_id: null, periodo: "2026-05", total: 3, publicadas: 1, ids: [7, 6, 5] },
        { cliente_id: 3, cliente_conta_id: 31, periodo: "2026-06", total: 2, publicadas: 2, ids: [4, 3] },
      ],
    });
    ok("nenhuma publicada → classe B", r.B_nenhuma_publicada === 1);
    ok("uma publicada → classe C", r.C_uma_publicada === 1);
    ok("duas publicadas → classe D", r.D_multiplas_publicadas === 1);
    ok("classe D é listada com os ids para decisão humana",
      r.casos.some((c) => c.classe === "D_multiplas_publicadas" && c.ids.length === 2));
  }

  console.log("\n4. resumo consolidado\n");
  {
    const r = inv.resumir({
      clientes: [{ id: 1, ativo: true, contas_ativas: 2 }, { id: 2, ativo: false, contas_ativas: 0 }],
      cliente_contas: [{ id: 1, cliente_id: 1, marketplace: "meli", ativo: true }],
      usuarios: [
        { id: 1, role: "membro", ativo: true },
        { id: 2, role: "admin", ativo: true },
        { id: 3, role: "seller", ativo: true },
        { id: 4, role: "membro", ativo: false },
      ],
      squads: [], squad_members: [], cliente_squad_history: [], cliente_responsaveis: [],
      grants: [], base_vinculos: [], d4_duplicatas: [], pendencias_contas: [],
    });
    ok("conta clientes ativos", r.clientes.ativos === 1);
    ok("conta clientes multi-conta", r.cliente_contas.multiConta === 1);
    ok("internos ativos exclui admin, seller e inativo", r.usuarios.internosAtivos === 1);
    ok("admin é contado à parte", r.usuarios.admins === 1);
    ok("schema de squads vazio é refletido", r.squads.squads === 0 && r.squads.memberships === 0);
  }

  console.log("\n5. destino é descrito sem credenciais\n");
  {
    const d = inv.descreverDestino("postgres://usuario:senhasecreta@host.example.com:5432/venforce");
    ok("host e base aparecem", d === "host.example.com:5432/venforce");
    ok("usuário não vaza", !d.includes("usuario"));
    ok("senha não vaza", !d.includes("senhasecreta"));
  }

  console.log("\n6. GARANTIAS DE SEGURANÇA verificadas no texto do script\n");
  {
    const arquivo = path.join(__dirname, "..", "sql", "squads-inventario-readonly.js");
    const src = fs.readFileSync(arquivo, "utf8");
    // As proibições valem para CÓDIGO, não para prosa: os comentários do script
    // citam legitimamente "COMMIT", "DDL" e "ensureSquadsTables()" para
    // explicar o que ele deliberadamente NÃO faz. Removemos comentários antes
    // de checar, senão a documentação da garantia derrubaria a garantia.
    const codigo = src
      .replace(/\/\*[\s\S]*?\*\//g, "")   // blocos /* ... */
      .replace(/^\s*\/\/.*$/gm, "");      // linhas // ...
    const proibidos = [
      /\bINSERT\s+INTO\b/i, /\bUPDATE\s+\w+\s+SET\b/i, /\bDELETE\s+FROM\b/i,
      /\bCREATE\s+(TABLE|INDEX|UNIQUE)\b/i, /\bALTER\s+TABLE\b/i,
      /\bDROP\s+(TABLE|INDEX)\b/i, /\bTRUNCATE\b/i,
      // COMMIT só importa se for EXECUTADO — a palavra aparece legitimamente
      // nos comentários ("termina em ROLLBACK, nunca COMMIT").
      /query\(\s*["'`]\s*COMMIT/i,
    ];
    for (const re of proibidos) {
      ok(`script não executa ${re.source}`, !re.test(codigo));
    }
    ok("script abre transação READ ONLY", /SET TRANSACTION READ ONLY/.test(codigo));
    ok("script termina em ROLLBACK", /ROLLBACK/.test(codigo));
    ok("script NÃO chama ensureSquadsTables (que aplicaria DDL)",
      !/ensureSquadsTables\s*\(/.test(codigo));
    ok("script nunca seleciona access_token", !/\baccess_token\b/.test(codigo));
    ok("script nunca seleciona refresh_token", !/\brefresh_token\b/.test(codigo));
  }

  console.log(`\n✓ squadsInventarioReadonly: ${checks} verificações\n`);
}

run();
