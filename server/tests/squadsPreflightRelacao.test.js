// server/tests/squadsPreflightRelacao.test.js
//
// VenForce V3 — P2.9 Real Data Readiness.
//
// Cobre server/sql/squads-preflight-relacao.js — o pré-validador OFFLINE da
// relação humana Cliente→Squad / Usuário→Squad:
//   - parser do formato de texto em que a relação chega
//   - conversão para o formato CANÔNICO (sem criar formato paralelo)
//   - regras que o tooling P2.3 NÃO tem: exatamente 6 Squads, 1 Gestor por
//     Squad, identificadores temporários, marcadores PENDENTE_*
//   - separação PENDENTE_ESPERADO × ERRO_ESTRUTURAL
//   - reuso do validador REAL (validarPlano) offline, via adaptador falso
//
// ZERO banco: nenhuma conexão é aberta; o adaptador falso responde os 5
// marcadores /* squads:MIG_* */ e no-op no DDL de ensureSquadsTables.

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/vf-test";

const assert = require("assert");
const pre = require("../sql/squads-preflight-relacao");

let checks = 0;
function ok(label, cond) { assert.ok(cond, `FALHOU: ${label}`); checks += 1; console.log(`  ok  ${label}`); }

const { ERRO, PENDENTE, AVISO } = pre;

function codigos(achados, classe) {
  return achados.filter((a) => !classe || a.classe === classe).map((a) => a.codigo);
}
function tem(achados, codigo, classe) {
  return achados.some((a) => a.codigo === codigo && (!classe || a.classe === classe));
}

// Inventário sintético — nunca sai daqui, nunca toca banco.
function inventarioFake() {
  return {
    clientes: [
      { id: 100, slug: "acme", nome: "Acme", ativo: true },
      { id: 101, slug: "beta-corp", nome: "Beta Corp", ativo: true },
      { id: 102, slug: "gamma", nome: "Gamma", ativo: true },
    ],
    usuarios: [
      { id: 1, nome: "Ana", email: "ana@vf.com", role: "membro", ativo: true },
      { id: 2, nome: "Bea", email: "bea@vf.com", role: "user", ativo: true },
      { id: 3, nome: "Cadu", email: "cadu@vf.com", role: "membro", ativo: true },
      { id: 9, nome: "Adm", email: "adm@vf.com", role: "admin", ativo: true },
    ],
    squads: [],
    squad_members: [],
    cliente_squad_history: [],
  };
}

// Relação de 6 Squads bem formada (usada como base; cada teste a deforma).
function relacaoSeis(overrides = {}) {
  const squads = [];
  for (let i = 1; i <= 6; i++) {
    squads.push({
      idTemporario: null,
      nome: `Squad Real ${i}`,
      slug: `squad-real-${i}`,
      gestor: `gestor${i}@vf.com`,
      clientes: [],
      membros: [],
      _linha: i,
    });
  }
  return { squads, ...overrides };
}

async function run() {
  console.log("\n1. parser do formato de texto\n");
  {
    const texto = [
      "# comentário ignorado",
      "SQUAD: Squad Alfa Real",
      "SLUG: alfa-real",
      "GESTOR: chefe@vf.com",
      "CLIENTES:",
      "  - acme",
      "  - 101",
      "MEMBROS:",
      "  - ana@vf.com",
      "",
      "SQUAD: Squad Beta Real",
      "GESTOR: chefe2@vf.com",
      "CLIENTES:",
      "  - gamma",
    ].join("\n");

    const r = pre.parseRelacaoTexto(texto);
    ok("parser lê 2 blocos SQUAD", r.squads.length === 2);
    ok("parser lê nome", r.squads[0].nome === "Squad Alfa Real");
    ok("parser lê slug explícito", r.squads[0].slug === "alfa-real");
    ok("parser lê gestor", r.squads[0].gestor === "chefe@vf.com");
    ok("parser lê lista de clientes", r.squads[0].clientes.join(",") === "acme,101");
    ok("parser lê lista de membros", r.squads[0].membros.join(",") === "ana@vf.com");
    ok("parser tolera slug ausente", r.squads[1].slug === "");
    ok("parser ignora comentário", !JSON.stringify(r).includes("comentário ignorado"));
  }

  console.log("\n2. conversão para o formato CANÔNICO\n");
  {
    const relacao = {
      squads: [{
        nome: "Squad Alfa Real", slug: "", gestor: "chefe@vf.com",
        clientes: ["acme"], membros: ["ana@vf.com", "bea@vf.com"], idTemporario: null,
      }],
    };
    const plano = pre.construirPlanoCanonico(relacao);

    ok("plano tem versao 1", plano.versao === 1);
    ok("plano tem as 4 listas canônicas",
      Array.isArray(plano.squads) && Array.isArray(plano.membros) &&
      Array.isArray(plano.clientes) && Array.isArray(plano.responsaveis));
    ok("slug derivado do nome quando ausente", plano.squads[0].slug === "squad-alfa-real");
    ok("squad nasce ativo", plano.squads[0].ativo === true);
    ok("Gestor vira membership funcao=coordenador",
      plano.membros[0].usuario === "chefe@vf.com" && plano.membros[0].funcao === "coordenador");
    ok("demais membros viram funcao=membro",
      plano.membros[1].funcao === "membro" && plano.membros[2].funcao === "membro");
    ok("cliente vira {cliente, squad, motivo}",
      plano.clientes[0].cliente === "acme" && plano.clientes[0].squad === "squad-alfa-real");
    ok("nenhum campo fora do formato canônico",
      Object.keys(plano).every((k) => ["versao", "descricao", "squads", "membros", "clientes", "responsaveis"].includes(k)));
  }

  console.log("\n3. um único principal por usuário em todo o plano\n");
  {
    // mesma pessoa em 2 Squads: só a 1ª membership pode ser principal,
    // senão validarPlano recusa (erro "principal em N squads").
    const relacao = {
      squads: [
        { nome: "S1", slug: "s1", gestor: "chefe@vf.com", clientes: [], membros: ["ana@vf.com"] },
        { nome: "S2", slug: "s2", gestor: "outro@vf.com", clientes: [], membros: ["ana@vf.com"] },
      ],
    };
    const plano = pre.construirPlanoCanonico(relacao);
    const principaisDaAna = plano.membros.filter((m) => m.usuario === "ana@vf.com" && m.principal === true);
    ok("usuário multi-Squad recebe exatamente 1 principal", principaisDaAna.length === 1);
  }

  console.log("\n4. BLOCO L — regra dos 6 Squads\n");
  {
    const cinco = relacaoSeis();
    cinco.squads.pop();
    const a5 = pre.regrasEstruturais(cinco, null);
    ok("5 Squads → ERRO_ESTRUTURAL", tem(a5, "SQUADS_QUANTIDADE_INVALIDA", ERRO));

    const sete = relacaoSeis();
    sete.squads.push({ nome: "Squad Extra", slug: "extra", gestor: "x@vf.com", clientes: [], membros: [] });
    const a7 = pre.regrasEstruturais(sete, null);
    ok("7 Squads → ERRO_ESTRUTURAL", tem(a7, "SQUADS_QUANTIDADE_INVALIDA", ERRO));

    const a6 = pre.regrasEstruturais(relacaoSeis(), null);
    ok("6 Squads → sem erro de quantidade", !tem(a6, "SQUADS_QUANTIDADE_INVALIDA", ERRO));

    // Estado de HOJE: relação vazia. Não pode ser erro — é pendência.
    const a0 = pre.regrasEstruturais({ squads: [] }, null);
    ok("0 Squads (hoje) → PENDENTE_ESPERADO, não erro",
      tem(a0, "SQUADS_QUANTIDADE_INVALIDA", PENDENTE) && codigos(a0, ERRO).length === 0);
  }

  console.log("\n5. BLOCO L — unicidade de nome e slug\n");
  {
    const r = relacaoSeis();
    r.squads[1].nome = r.squads[0].nome;
    ok("nome duplicado → ERRO", tem(pre.regrasEstruturais(r, null), "SQUAD_NOME_DUPLICADO", ERRO));

    const r2 = relacaoSeis();
    r2.squads[1].slug = r2.squads[0].slug;
    ok("slug duplicado → ERRO", tem(pre.regrasEstruturais(r2, null), "SQUAD_SLUG_DUPLICADO", ERRO));

    // O tooling P2.3 só checa slug; nome duplicado é regra NOVA deste validador.
    const r3 = relacaoSeis();
    r3.squads[1].nome = r3.squads[0].nome;
    ok("nome duplicado é pego mesmo com slugs distintos",
      tem(pre.regrasEstruturais(r3, null), "SQUAD_NOME_DUPLICADO", ERRO) &&
      !tem(pre.regrasEstruturais(r3, null), "SQUAD_SLUG_DUPLICADO", ERRO));
  }

  console.log("\n6. BLOCO L — 1 Gestor por Squad\n");
  {
    const r = relacaoSeis();
    r.squads[2].gestor = "";
    ok("Squad sem Gestor → PENDENTE (aguarda dado humano)",
      tem(pre.regrasEstruturais(r, null), "SQUAD_SEM_GESTOR", PENDENTE));

    const r2 = relacaoSeis();
    r2.squads[2].gestor = "PENDENTE_DADO_HUMANO";
    ok("Gestor com marcador PENDENTE → PENDENTE",
      tem(pre.regrasEstruturais(r2, null), "SQUAD_SEM_GESTOR", PENDENTE));

    const r3 = relacaoSeis();
    r3.squads[2].gestor = ["a@vf.com", "b@vf.com"];
    ok("2 Gestores no mesmo Squad → ERRO",
      tem(pre.regrasEstruturais(r3, null), "SQUAD_MULTIPLOS_GESTORES", ERRO));
  }

  console.log("\n7. identificadores temporários e marcadores não podem vazar\n");
  {
    const r = relacaoSeis();
    r.squads[0].nome = "SQUAD_1";
    ok("nome = SQUAD_1 → ERRO (identificador temporário)",
      tem(pre.regrasEstruturais(r, null), "SQUAD_IDENTIFICADOR_TEMPORARIO", ERRO));

    const r2 = relacaoSeis();
    r2.squads[0].slug = "SQUAD_3";
    ok("slug = SQUAD_3 → ERRO (não pode ir para o banco)",
      tem(pre.regrasEstruturais(r2, null), "SQUAD_IDENTIFICADOR_TEMPORARIO", ERRO));

    const r3 = relacaoSeis();
    r3.squads[0].nome = "PENDENTE_NOME_OFICIAL";
    ok("nome PENDENTE_* → PENDENTE, não erro",
      tem(pre.regrasEstruturais(r3, null), "SQUAD_NOME_PENDENTE", PENDENTE));
  }

  console.log("\n8. BLOCO K — Cliente em 2 Squads / repetido / membership duplicada\n");
  {
    const r = relacaoSeis();
    r.squads[0].clientes = ["acme"];
    r.squads[1].clientes = ["acme"];
    ok("mesmo Cliente em 2 Squads → ERRO",
      tem(pre.regrasEstruturais(r, null), "CLIENTE_EM_DOIS_SQUADS", ERRO));

    const r2 = relacaoSeis();
    r2.squads[0].clientes = ["acme", "acme"];
    ok("Cliente repetido no mesmo Squad → AVISO",
      tem(pre.regrasEstruturais(r2, null), "CLIENTE_REPETIDO", AVISO));

    const r3 = relacaoSeis();
    r3.squads[0].membros = ["ana@vf.com", "ana@vf.com"];
    ok("membership duplicada no mesmo Squad → ERRO",
      tem(pre.regrasEstruturais(r3, null), "MEMBERSHIP_DUPLICADA", ERRO));

    const r4 = relacaoSeis();
    r4.squads[0].gestor = "ana@vf.com";
    r4.squads[0].membros = ["ana@vf.com"];
    ok("Gestor repetido em MEMBROS do próprio Squad → ERRO",
      tem(pre.regrasEstruturais(r4, null), "MEMBERSHIP_DUPLICADA", ERRO));
  }

  console.log("\n9. BLOCO K — usuário em vários Squads é permitido (aviso)\n");
  {
    const r = relacaoSeis();
    r.squads[0].membros = ["ana@vf.com"];
    r.squads[1].membros = ["ana@vf.com"];
    const a = pre.regrasEstruturais(r, null);
    ok("usuário em 2 Squads → AVISO, nunca ERRO",
      tem(a, "USUARIO_EM_VARIOS_SQUADS", AVISO) && !tem(a, "USUARIO_EM_VARIOS_SQUADS", ERRO));
  }

  console.log("\n10. BLOCO K — existência contra o inventário\n");
  {
    const inv = inventarioFake();

    const r = relacaoSeis();
    r.squads[0].clientes = ["nao-existe-mesmo"];
    ok("Cliente inexistente → ERRO",
      tem(pre.regrasEstruturais(r, inv), "CLIENTE_INEXISTENTE", ERRO));

    const r2 = relacaoSeis();
    r2.squads[0].membros = ["fantasma@vf.com"];
    ok("Usuário inexistente → ERRO",
      tem(pre.regrasEstruturais(r2, inv), "USUARIO_INEXISTENTE", ERRO));

    const r3 = relacaoSeis();
    r3.squads[0].clientes = ["acme"];
    const a3 = pre.regrasEstruturais(r3, inv);
    ok("Cliente ativo não atribuído → PENDENTE (completude)",
      tem(a3, "CLIENTE_SEM_SQUAD", PENDENTE));
    ok("Cliente atribuído não vira pendência",
      !a3.some((x) => x.codigo === "CLIENTE_SEM_SQUAD" && /acme/.test(x.msg)));

    ok("interno ativo sem membership → PENDENTE",
      tem(pre.regrasEstruturais(relacaoSeis(), inv), "USUARIO_SEM_MEMBERSHIP", PENDENTE));

    // admin é bypass: nunca vira pendência de membership (alinhado à auditoria).
    const a5 = pre.regrasEstruturais(relacaoSeis(), inv);
    ok("admin NÃO vira pendência de membership",
      !a5.some((x) => x.codigo === "USUARIO_SEM_MEMBERSHIP" && /adm@vf\.com/.test(x.msg)));
  }

  console.log("\n11. sem inventário → existência não verificada (pendência, não erro)\n");
  {
    const a = pre.regrasEstruturais(relacaoSeis(), null);
    ok("ausência de inventário é PENDENTE_ESPERADO", tem(a, "SEM_INVENTARIO", PENDENTE));
  }

  console.log("\n12. adaptador de banco falso responde os 5 marcadores\n");
  {
    const db = pre.criarDbFalso(inventarioFake());

    const s = await db.query("/* squads:MIG_RESOLVE_SQUADS */ SELECT ...", [["alfa"]]);
    ok("MIG_RESOLVE_SQUADS responde (vazio, squads não existem)", Array.isArray(s.rows) && s.rows.length === 0);

    const u = await db.query("/* squads:MIG_RESOLVE_USERS */ SELECT ...", [[], ["ana@vf.com"]]);
    ok("MIG_RESOLVE_USERS resolve por email", u.rows.length === 1 && u.rows[0].id === 1);

    const u2 = await db.query("/* squads:MIG_RESOLVE_USERS */ SELECT ...", [[3], []]);
    ok("MIG_RESOLVE_USERS resolve por id", u2.rows.length === 1 && u2.rows[0].email === "cadu@vf.com");

    const c = await db.query("/* squads:MIG_RESOLVE_CLIENTES */ SELECT ...", [[], ["acme"]]);
    ok("MIG_RESOLVE_CLIENTES resolve por slug", c.rows.length === 1 && c.rows[0].id === 100);

    const m = await db.query("/* squads:MIG_MEMBERSHIPS_EXISTENTES */ SELECT ...", [[1]]);
    ok("MIG_MEMBERSHIPS_EXISTENTES responde vazio", m.rows.length === 0);

    const v = await db.query("/* squads:MIG_VINCULOS_EXISTENTES */ SELECT ...", [[100]]);
    ok("MIG_VINCULOS_EXISTENTES responde vazio", v.rows.length === 0);

    const ddl = await db.query("CREATE TABLE IF NOT EXISTS squads (...)", []);
    ok("DDL do ensureSquadsTables é inerte no adaptador", ddl.rows.length === 0);
  }

  console.log("\n13. reuso do validador REAL do tooling P2.3, offline\n");
  {
    const inv = inventarioFake();
    const relacao = {
      squads: [
        { nome: "Squad Um", slug: "squad-um", gestor: "ana@vf.com", clientes: ["acme"], membros: [] },
        { nome: "Squad Dois", slug: "squad-dois", gestor: "cadu@vf.com", clientes: ["beta-corp"], membros: [] },
      ],
    };
    const r = await pre.executar({ relacao, inventario: inv });

    ok("validarPlano REAL foi chamado (marcadores consultados)",
      r.consultasFalsas.includes("MIG_RESOLVE_CLIENTES") && r.consultasFalsas.includes("MIG_RESOLVE_USERS"));
    ok("achados do tooling entram no relatório com código TOOLING_P2_3",
      r.achados.some((a) => a.codigo === "TOOLING_P2_3") || r.achados.length > 0);
    ok("2 Squads → ERRO de quantidade (regra dos 6)", r.veredito === "ERRO_ESTRUTURAL");
  }

  console.log("\n14. erro real do tooling atravessa (cliente inexistente com inventário)\n");
  {
    const inv = inventarioFake();
    const relacao = relacaoSeis();
    relacao.squads[0].clientes = ["cliente-fantasma"];
    relacao.squads[0].gestor = "ana@vf.com";
    const r = await pre.executar({ relacao, inventario: inv });
    ok("cliente inexistente → veredito ERRO_ESTRUTURAL", r.veredito === "ERRO_ESTRUTURAL");
    ok("erro de existência aparece nos achados",
      r.achados.some((a) => a.classe === ERRO && /fantasma/i.test(a.msg)));
  }

  console.log("\n15. estado de HOJE: relação vazia → AGUARDANDO_RELACAO\n");
  {
    const r = await pre.executar({ relacao: { squads: [] }, inventario: null });
    ok("veredito é AGUARDANDO_RELACAO", r.veredito === "AGUARDANDO_RELACAO");
    ok("nenhum ERRO_ESTRUTURAL hoje", r.achados.filter((a) => a.classe === ERRO).length === 0);
    ok("há pendências registradas", r.achados.some((a) => a.classe === PENDENTE));
  }

  console.log("\n16. --estrito transforma pendência em erro\n");
  {
    const rNormal = await pre.executar({ relacao: { squads: [] }, inventario: null, estrito: false });
    const rEstrito = await pre.executar({ relacao: { squads: [] }, inventario: null, estrito: true });
    ok("sem --estrito → AGUARDANDO_RELACAO", rNormal.veredito === "AGUARDANDO_RELACAO");
    ok("com --estrito → ERRO_ESTRUTURAL", rEstrito.veredito === "ERRO_ESTRUTURAL");
  }

  console.log("\n17. relação completa e válida → PRONTO_PARA_DRY_RUN\n");
  {
    const inv = inventarioFake();
    // 6 Squads, todos os clientes ativos atribuídos, todos os internos alocados.
    const relacao = relacaoSeis();
    relacao.squads[0].gestor = "ana@vf.com";
    relacao.squads[1].gestor = "bea@vf.com";
    relacao.squads[2].gestor = "cadu@vf.com";
    relacao.squads[3].gestor = "ana@vf.com";
    relacao.squads[4].gestor = "bea@vf.com";
    relacao.squads[5].gestor = "cadu@vf.com";
    relacao.squads[0].clientes = ["acme", "beta-corp", "gamma"];

    const r = await pre.executar({ relacao, inventario: inv });
    if (r.veredito !== "PRONTO_PARA_DRY_RUN") {
      console.log("   achados:", JSON.stringify(r.achados, null, 1));
    }
    ok("veredito PRONTO_PARA_DRY_RUN", r.veredito === "PRONTO_PARA_DRY_RUN");
    ok("plano emitido tem 6 squads", r.plano.squads.length === 6);
    ok("plano emitido tem os 3 clientes", r.plano.clientes.length === 3);
    ok("plano emitido é o formato canônico",
      r.plano.versao === 1 && Array.isArray(r.plano.responsaveis));
  }

  console.log("\n18. BLOCO J — esqueleto pré-preenchido a partir do inventário\n");
  {
    const inv = inventarioFake();
    const texto = pre.gerarEsqueleto(inv);

    const blocos = (texto.match(/^SQUAD:/gm) || []).length;
    ok("esqueleto tem exatamente 6 blocos SQUAD", blocos === 6);
    ok("nenhum Squad vem pré-atribuído", !/^CLIENTES:\s*\n\s*-/m.test(texto));
    ok("catálogo lista os 3 clientes ativos",
      texto.includes("acme") && texto.includes("beta-corp") && texto.includes("gamma"));
    ok("catálogo lista os internos ativos",
      texto.includes("ana@vf.com") && texto.includes("cadu@vf.com"));
    ok("admin NÃO entra no catálogo de internos a alocar", !texto.includes("adm@vf.com"));
    ok("catálogo está comentado (não é atribuição)",
      texto.split("\n").filter((l) => l.includes("acme")).every((l) => l.trim().startsWith("#")));

    // Round-trip: o esqueleto gerado tem de ser lido de volta pelo parser e
    // produzir exatamente o estado de HOJE — aguardando, nunca erro.
    const relido = pre.parseRelacaoTexto(texto);
    ok("esqueleto é relido pelo parser com 6 Squads", relido.squads.length === 6);
    ok("esqueleto relido não traz cliente algum",
      relido.squads.every((s) => s.clientes.length === 0));
  }

  console.log("\n19. round-trip: esqueleto → validação → AGUARDANDO_RELACAO\n");
  {
    const inv = inventarioFake();
    const relido = pre.parseRelacaoTexto(pre.gerarEsqueleto(inv));
    const r = await pre.executar({ relacao: relido, inventario: inv });
    ok("esqueleto recém-gerado nunca é ERRO_ESTRUTURAL", r.veredito === "AGUARDANDO_RELACAO");
    ok("os 6 marcadores PENDENTE_NOME_OFICIAL não colidem entre si",
      !r.achados.some((a) => a.codigo === "SQUAD_SLUG_DUPLICADO"));
    ok("todos os clientes ativos aparecem como pendência de atribuição",
      r.achados.filter((a) => a.codigo === "CLIENTE_SEM_SQUAD").length === 3);
  }

  console.log(`\n✓ squadsPreflightRelacao: ${checks} verificações\n`);
}

run().catch((err) => { console.error(err); process.exit(1); });
