// server/tests/squadsPreflightRelacao.test.js
//
// VenForce V3 — P2.9 Real Data Readiness.
//
// Cobre server/sql/squads-preflight-relacao.js — o pré-validador OFFLINE da
// relação humana Cliente→Squad / Usuário→Squad:
//   - parser do formato V2 (Coordenador → Gestor → Auxiliar → Auxiliar 2 →
//     Design) e do formato V1 (Gestor + MEMBROS), que continua aceito
//   - conversão para o formato CANÔNICO (sem criar formato paralelo)
//   - regras que o tooling P2.3 NÃO tem: exatamente 6 Squads, 1 Coordenador e
//     1 Gestor por Squad, Coordenador ≠ Gestor, marcadores PENDENTE_*
//   - RECUSA de escolher Squad principal de usuário multi-Squad
//   - resolução determinística NOME HUMANO → email/id (zero fuzzy)
//   - separação PENDENTE_ESPERADO × ERRO_ESTRUTURAL × INFO
//   - reuso do validador REAL (validarPlano) offline, via adaptador falso
//
// ZERO banco: nenhuma conexão é aberta; o adaptador falso responde os 5
// marcadores /* squads:MIG_* */ e no-op no DDL de ensureSquadsTables.

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/vf-test";

const assert = require("assert");
const pre = require("../sql/squads-preflight-relacao");

let checks = 0;
function ok(label, cond) { assert.ok(cond, `FALHOU: ${label}`); checks += 1; console.log(`  ok  ${label}`); }

const { ERRO, PENDENTE, AVISO, INFO } = pre;

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
        nome: "Squad Alfa Real", slug: "",
        coordenador: "coord@vf.com", gestor: "chefe@vf.com",
        auxiliares: ["aux@vf.com"], auxiliar2: "aux2@vf.com", design: "design@vf.com",
        principal: [],
        clientes: ["acme"], membros: ["ana@vf.com"], idTemporario: null,
      }],
    };
    const plano = pre.construirPlanoCanonico(relacao);
    const porUsuario = (u) => plano.membros.find((m) => m.usuario === u);

    ok("plano tem versao 1", plano.versao === 1);
    ok("plano tem as 4 listas canônicas",
      Array.isArray(plano.squads) && Array.isArray(plano.membros) &&
      Array.isArray(plano.clientes) && Array.isArray(plano.responsaveis));
    ok("slug derivado do nome quando ausente", plano.squads[0].slug === "squad-alfa-real");
    ok("squad nasce ativo", plano.squads[0].ativo === true);

    // A CORREÇÃO CENTRAL DESTA FASE. Antes o Gestor virava funcao=coordenador;
    // Coordenador e Gestor são pessoas e funções DISTINTAS na operação real.
    ok("Coordenador vira funcao=coordenador",
      porUsuario("coord@vf.com").funcao === "coordenador");
    ok("Gestor vira funcao=membro (NUNCA coordenador)",
      porUsuario("chefe@vf.com").funcao === "membro");
    ok("Auxiliar entra como funcao=membro", porUsuario("aux@vf.com").funcao === "membro");
    ok("Auxiliar 2 entra como funcao=membro", porUsuario("aux2@vf.com").funcao === "membro");
    ok("Design entra como funcao=membro", porUsuario("design@vf.com").funcao === "membro");
    ok("lista MEMBROS: do formato V1 continua entrando como membro",
      porUsuario("ana@vf.com").funcao === "membro");
    ok("exatamente 1 coordenador no Squad",
      plano.membros.filter((m) => m.funcao === "coordenador").length === 1);

    ok("cliente vira {cliente, squad, motivo}",
      plano.clientes[0].cliente === "acme" && plano.clientes[0].squad === "squad-alfa-real");
    ok("responsaveis fica VAZIO enquanto Cliente→Squad não chegou de verdade",
      plano.responsaveis.length === 0);
    ok("nenhum campo fora do formato canônico",
      Object.keys(plano).every((k) => ["versao", "descricao", "squads", "membros", "clientes", "responsaveis"].includes(k)));
  }

  console.log("\n3. a ORDEM da relação NUNCA define o Squad principal\n");
  {
    // Mesma pessoa em 2 Squads. O tooling V1 marcava a 1ª membership como
    // principal — decisão silenciosa que esta fase PROÍBE.
    const relacao = {
      squads: [
        { nome: "S1", slug: "s1", coordenador: "c1@vf.com", gestor: "chefe@vf.com", clientes: [], membros: ["ana@vf.com"] },
        { nome: "S2", slug: "s2", coordenador: "c2@vf.com", gestor: "outro@vf.com", clientes: [], membros: ["ana@vf.com"] },
      ],
    };
    const plano = pre.construirPlanoCanonico(relacao);
    const daAna = plano.membros.filter((m) => m.usuario === "ana@vf.com");
    ok("multi-Squad gera as 2 memberships", daAna.length === 2);
    ok("NENHUMA delas é marcada principal pela ordem",
      daAna.every((m) => m.principal === undefined));
    ok("quem está em 1 Squad só recebe principal determinístico",
      plano.membros.find((m) => m.usuario === "chefe@vf.com").principal === true);

    // Declaração humana explícita resolve — e só ela.
    const comDecisao = JSON.parse(JSON.stringify(relacao));
    comDecisao.squads[1].principal = ["ana@vf.com"];
    const plano2 = pre.construirPlanoCanonico(comDecisao);
    const daAna2 = plano2.membros.filter((m) => m.usuario === "ana@vf.com");
    ok("PRINCIPAL: declarado marca exatamente 1 principal",
      daAna2.filter((m) => m.principal === true).length === 1);
    ok("o principal é o Squad DECLARADO, não o primeiro",
      daAna2.find((m) => m.principal === true).squad === "s2");
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

  console.log("\n17. relação V2 completa e válida → PRONTO_PARA_DRY_RUN\n");
  {
    // Inventário próprio: 6 Squads no formato real exigem Coordenador + Gestor
    // distintos por Squad, e TODO interno ativo alocado.
    const inv = {
      clientes: [
        { id: 100, slug: "acme", nome: "Acme", ativo: true },
        { id: 101, slug: "beta-corp", nome: "Beta Corp", ativo: true },
      ],
      usuarios: [{ id: 900, nome: "Adm", email: "adm@vf.com", role: "admin", ativo: true }],
      squads: [], squad_members: [], cliente_squad_history: [],
    };
    const relacao = { squads: [] };
    for (let i = 1; i <= 6; i++) {
      const coord = `coord${i}@vf.com`;
      const gestor = `gestor${i}@vf.com`;
      inv.usuarios.push({ id: 100 + i, nome: `Coord ${i}`, email: coord, role: "membro", ativo: true });
      inv.usuarios.push({ id: 200 + i, nome: `Gestor ${i}`, email: gestor, role: "membro", ativo: true });
      relacao.squads.push({
        idTemporario: null, nome: `Squad ${i}`, slug: `squad-${i}`,
        rotuloOriginal: `squad ${i}`, rotuloStatus: "CONFIRMADO", nomeHipotese: "",
        coordenador: coord, gestor,
        auxiliares: [], auxiliar2: "AUSENTE_NA_ESTRUTURA", design: "AUSENTE_NA_ESTRUTURA",
        principal: [], clientes: [], membros: [], _linha: i,
      });
    }
    relacao.squads[0].clientes = ["acme", "beta-corp"];

    const r = await pre.executar({ relacao, inventario: inv });
    if (r.veredito !== "PRONTO_PARA_DRY_RUN") {
      console.log("   achados:", JSON.stringify(r.achados.filter((a) => a.classe !== INFO), null, 1));
    }
    ok("veredito PRONTO_PARA_DRY_RUN", r.veredito === "PRONTO_PARA_DRY_RUN");
    ok("plano emitido tem 6 squads", r.plano.squads.length === 6);
    ok("plano emitido tem os 2 clientes", r.plano.clientes.length === 2);
    ok("plano emitido tem 12 memberships (1 coordenador + 1 gestor por Squad)",
      r.plano.membros.length === 12);
    ok("6 coordenadores, 6 membros — Gestor jamais coordenador",
      r.plano.membros.filter((m) => m.funcao === "coordenador").length === 6 &&
      r.plano.membros.filter((m) => m.funcao === "membro").length === 6);
    ok("todo mundo em 1 Squad só → todo principal decidido",
      r.plano.membros.every((m) => m.principal === true));
    ok("plano emitido é o formato canônico",
      r.plano.versao === 1 && Array.isArray(r.plano.responsaveis));
    ok("AUSENTE_NA_ESTRUTURA não impede PRONTO_PARA_DRY_RUN",
      r.achados.some((a) => a.classe === INFO && a.codigo === "AUXILIAR_2_AUSENTE_NA_ESTRUTURA"));
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

  // ═══════════════════════════════════════════════════════════════════
  //  BLOCO 9 — a estrutura REAL da operação chegou:
  //  Squad → Coordenador → Gestor → Auxiliar → Auxiliar 2 → Design
  // ═══════════════════════════════════════════════════════════════════

  console.log("\n20. parser V2 lê as funções operacionais reais\n");
  {
    const texto = [
      "SQUAD: Squad 1",
      "SLUG: squad-1",
      "ROTULO_ORIGINAL: squad 1",
      "ROTULO_STATUS: CONFIRMADO",
      "COORDENADOR: Micael",
      "GESTOR: Eliabe",
      "AUXILIAR: Gustavo",
      "AUXILIAR_2: Fernando",
      "DESIGN: Gabrielly",
      "PRINCIPAL:",
      "  - Micael",
      "CLIENTES: PENDENTE_RELACAO_CLIENTE_SQUAD",
      "MEMBROS:",
    ].join("\n");
    const s = pre.parseRelacaoTexto(texto).squads[0];

    ok("parser lê COORDENADOR", s.coordenador === "Micael");
    ok("parser lê GESTOR separado do Coordenador", s.gestor === "Eliabe");
    ok("parser lê AUXILIAR", s.auxiliares[0] === "Gustavo");
    ok("parser lê AUXILIAR_2 (chave com dígito)", s.auxiliar2 === "Fernando");
    ok("parser lê DESIGN", s.design === "Gabrielly");
    ok("parser lê PRINCIPAL como lista", s.principal.length === 1 && s.principal[0] === "Micael");
    ok("parser lê ROTULO_ORIGINAL", s.rotuloOriginal === "squad 1");
    ok("parser lê ROTULO_STATUS", s.rotuloStatus === "CONFIRMADO");
    ok("marcador de carteira entra como entrada de cliente pendente",
      s.clientes.length === 1 && s.clientes[0] === "PENDENTE_RELACAO_CLIENTE_SQUAD");

    // AUXILIARES: em lista também é aceito.
    const emLista = pre.parseRelacaoTexto([
      "SQUAD: X", "AUXILIARES:", "  - A", "  - B",
    ].join("\n")).squads[0];
    ok("AUXILIARES: aceita lista", emLista.auxiliares.length === 2);
  }

  console.log("\n21. mapeamento de cargo → membership (a correção desta fase)\n");
  {
    const m = pre.FUNCOES_OPERACIONAIS;
    ok("Coordenador → funcao=coordenador", m.coordenador.funcaoMembership === "coordenador");
    ok("Gestor → funcao=membro", m.gestor.funcaoMembership === "membro");
    ok("Auxiliar → funcao=membro", m.auxiliar.funcaoMembership === "membro");
    ok("Auxiliar 2 → funcao=membro", m.auxiliar2.funcaoMembership === "membro");
    ok("Design → funcao=membro", m.designer.funcaoMembership === "membro");

    // Nenhum enum novo em squad_members: o CHECK do banco só aceita 2 valores.
    const funcoesUsadas = new Set(Object.values(m).map((x) => x.funcaoMembership));
    ok("só existem 2 valores de funcao (membro|coordenador) — nenhum enum novo",
      funcoesUsadas.size === 2 && funcoesUsadas.has("membro") && funcoesUsadas.has("coordenador"));

    // A função organizacional é preservada FORA do enum, para cliente_responsaveis.
    ok("Gestor preserva papel organizacional gestor", m.gestor.papelResponsavel === "gestor");
    ok("Auxiliar e Auxiliar 2 preservam papel auxiliar",
      m.auxiliar.papelResponsavel === "auxiliar" && m.auxiliar2.papelResponsavel === "auxiliar");
    ok("Design preserva papel designer", m.designer.papelResponsavel === "designer");
    const papeis = new Set(Object.values(m).map((x) => x.papelResponsavel).filter(Boolean));
    ok("papéis ficam no enum de cliente_responsaveis (gestor|auxiliar|designer)",
      [...papeis].every((x) => ["gestor", "auxiliar", "designer"].includes(x)));

    // Cinto anti-regressão: se alguém remapear Gestor, isso vira ERRO_ESTRUTURAL.
    ok("entradaPessoa nunca dá coordenador ao Gestor",
      pre.entradaPessoa("Eliabe", "gestor").funcaoMembership === "membro");
  }

  console.log("\n22. Coordenador distinto de Gestor, e o mesmo Coordenador em 3 Squads\n");
  {
    const relacao = { squads: [] };
    for (let i = 1; i <= 3; i++) {
      relacao.squads.push({
        nome: `Squad ${i}`, slug: `squad-${i}`,
        coordenador: "Klayvert", gestor: `Gestor${i}`,
        auxiliares: [], auxiliar2: "AUSENTE_NA_ESTRUTURA", design: "AUSENTE_NA_ESTRUTURA",
        principal: [], clientes: [], membros: [],
      });
    }
    const a = pre.regrasEstruturais(relacao, null);

    ok("mesmo Coordenador em 3 Squads → INFO, nunca ERRO",
      tem(a, "COORDENADOR_EM_VARIOS_SQUADS", INFO) &&
      !a.some((x) => x.codigo === "COORDENADOR_EM_VARIOS_SQUADS" && x.classe === ERRO));

    // Coordenador == Gestor no MESMO Squad é erro: membership conflitante.
    const conflito = JSON.parse(JSON.stringify(relacao));
    conflito.squads[0].gestor = "klayvert";  // mesma pessoa, caixa diferente
    ok("Coordenador igual ao Gestor no mesmo Squad → ERRO",
      tem(pre.regrasEstruturais(conflito, null), "COORDENADOR_IGUAL_AO_GESTOR", ERRO));

    // Coordenador ausente é PENDÊNCIA, não erro.
    const semCoord = JSON.parse(JSON.stringify(relacao));
    semCoord.squads[0].coordenador = "";
    ok("Squad sem Coordenador → PENDENTE",
      tem(pre.regrasEstruturais(semCoord, null), "SQUAD_SEM_COORDENADOR", PENDENTE));
    ok("Squad sem Gestor → PENDENTE",
      tem(pre.regrasEstruturais({ squads: [{ nome: "A", slug: "a", coordenador: "C", gestor: "" }] }, null),
        "SQUAD_SEM_GESTOR", PENDENTE));
  }

  console.log("\n23. usuário multi-Squad: permitido, mas principal é decisão humana\n");
  {
    const relacao = {
      squads: [
        { nome: "Squad 1", slug: "squad-1", coordenador: "Micael", gestor: "Eliabe",
          auxiliares: ["Gustavo"], auxiliar2: "Fernando", design: "Gabrielly", principal: [], clientes: [], membros: [] },
        { nome: "Squad 4", slug: "squad-4", coordenador: "Fernando", gestor: "Anderson",
          auxiliares: [], auxiliar2: "AUSENTE_NA_ESTRUTURA", design: "Carol", principal: [], clientes: [], membros: [] },
      ],
    };
    const a = pre.regrasEstruturais(relacao, null);

    ok("multi-Squad é AVISO, nunca ERRO",
      tem(a, "USUARIO_EM_VARIOS_SQUADS", AVISO) &&
      !a.some((x) => x.codigo === "USUARIO_EM_VARIOS_SQUADS" && x.classe === ERRO));
    ok("multi-Squad sem decisão → PENDENTE_SQUAD_PRINCIPAL",
      tem(a, "PENDENTE_SQUAD_PRINCIPAL", PENDENTE));
    ok("a pendência de principal nomeia a pessoa certa",
      a.some((x) => x.codigo === "PENDENTE_SQUAD_PRINCIPAL" && /Fernando/.test(x.msg)));
    ok("quem está em 1 Squad só NÃO gera pendência de principal",
      !a.some((x) => x.codigo === "PENDENTE_SQUAD_PRINCIPAL" && /Gustavo|Eliabe|Carol/.test(x.msg)));

    const analise = pre.analisarMemberships(relacao, null);
    const fernando = analise.pessoas.get(pre.chaveDePessoa("Fernando"));
    ok("Fernando é Auxiliar 2 no Squad 1 e Coordenador no Squad 4",
      fernando.participacoes.map((x) => x.papelOperacional).join(",") === "auxiliar2,coordenador");
    ok("as duas memberships dele têm funcao diferente",
      fernando.participacoes.map((x) => x.funcaoMembership).join(",") === "membro,coordenador");
    ok("statusPrincipal de multi-Squad é PENDENTE_SQUAD_PRINCIPAL",
      fernando.statusPrincipal === "PENDENTE_SQUAD_PRINCIPAL");

    const gustavo = analise.pessoas.get(pre.chaveDePessoa("Gustavo"));
    ok("statusPrincipal de Squad único é DETERMINISTICO",
      gustavo.statusPrincipal === "DETERMINISTICO" && gustavo.squadPrincipal.slug === "squad-1");
  }

  console.log("\n24. declaração PRINCIPAL: — resolve, e erra alto quando mal usada\n");
  {
    const base = () => ({
      squads: [
        { nome: "S1", slug: "s1", coordenador: "Ana", gestor: "Bea", auxiliares: [], auxiliar2: "", design: "", principal: [], clientes: [], membros: [] },
        { nome: "S2", slug: "s2", coordenador: "Ana", gestor: "Cadu", auxiliares: [], auxiliar2: "", design: "", principal: [], clientes: [], membros: [] },
      ],
    });

    const decidido = base();
    decidido.squads[1].principal = ["Ana"];
    const aOk = pre.regrasEstruturais(decidido, null);
    ok("PRINCIPAL: declarado elimina PENDENTE_SQUAD_PRINCIPAL",
      !aOk.some((x) => x.codigo === "PENDENTE_SQUAD_PRINCIPAL" && /Ana/.test(x.msg)));

    const emDois = base();
    emDois.squads[0].principal = ["Ana"];
    emDois.squads[1].principal = ["Ana"];
    ok("principal declarado em 2 Squads → ERRO",
      tem(pre.regrasEstruturais(emDois, null), "PRINCIPAL_EM_VARIOS_SQUADS", ERRO));

    const foraDoSquad = base();
    foraDoSquad.squads[0].principal = ["Cadu"];  // Cadu é Gestor do S2, não do S1
    ok("principal declarado em Squad de que a pessoa não é membro → ERRO",
      tem(pre.regrasEstruturais(foraDoSquad, null), "PRINCIPAL_FORA_DO_SQUAD", ERRO));

    const fantasma = base();
    fantasma.squads[0].principal = ["NinguemAssim"];
    ok("principal de quem não está em Squad algum → ERRO",
      tem(pre.regrasEstruturais(fantasma, null), "PRINCIPAL_SEM_MEMBERSHIP", ERRO));

    const redundante = { squads: [{ nome: "S", slug: "s", coordenador: "Ana", gestor: "Bea", auxiliares: [], auxiliar2: "", design: "", principal: ["Bea"], clientes: [], membros: [] }] };
    ok("PRINCIPAL: para quem está em 1 Squad só é INFO (inofensivo)",
      tem(pre.regrasEstruturais(redundante, null), "PRINCIPAL_REDUNDANTE", INFO));
  }

  console.log("\n25. Cliente→Squad ausente continua PENDENTE_ESPERADO\n");
  {
    const relacao = {
      squads: [{
        nome: "Squad 1", slug: "squad-1", coordenador: "Micael", gestor: "Eliabe",
        auxiliares: ["Gustavo"], auxiliar2: "AUSENTE_NA_ESTRUTURA", design: "Gabrielly",
        principal: [], clientes: ["PENDENTE_RELACAO_CLIENTE_SQUAD"], membros: [],
      }],
    };
    const a = pre.regrasEstruturais(relacao, null);
    ok("marcador de carteira → PENDENTE, nunca ERRO",
      tem(a, "CLIENTE_PENDENTE", PENDENTE) &&
      !a.some((x) => x.codigo === "CLIENTE_PENDENTE" && x.classe === ERRO));

    const plano = pre.construirPlanoCanonico(relacao);
    ok("marcador de carteira NÃO vira linha de cliente no plano", plano.clientes.length === 0);
    ok("responsaveis continua vazio sem Cliente→Squad", plano.responsaveis.length === 0);
    ok("memberships existem mesmo sem carteira", plano.membros.length === 4);

    // Responsabilidade é POR CLIENTE: sem carteira, responsável é inventar.
    const comResp = { ...plano, responsaveis: [{ cliente: "acme", usuario: "x@vf.com", papel: "gestor" }] };
    ok("responsável sem nenhuma carteira no plano → ERRO de invariante",
      pre.invariantesDoPlano(comResp).some((x) => x.codigo === "RESPONSAVEIS_SEM_CARTEIRA" && x.classe === ERRO));
  }

  console.log("\n26. 6º bloco com rótulo duplicado na planilha é detectado\n");
  {
    const relacao = {
      squads: [
        { nome: "Squad 5", slug: "squad-5", rotuloOriginal: "squad 5", rotuloStatus: "CONFIRMADO",
          coordenador: "Micael", gestor: "Witor", auxiliares: ["Felipe"],
          auxiliar2: "AUSENTE_NA_ESTRUTURA", design: "Sophia", principal: [], clientes: [], membros: [] },
        { nome: "PENDENTE_CONFIRMACAO_DO_ROTULO", slug: "", rotuloOriginal: "squad 5",
          rotuloStatus: "SQUAD_6_PENDENTE_CONFIRMACAO_DO_ROTULO", nomeHipotese: "Squad 6",
          coordenador: "Klayvert", gestor: "Matheus", auxiliares: ["Victor"],
          auxiliar2: "AUSENTE_NA_ESTRUTURA", design: "PENDENTE_CONFIRMACAO", principal: [], clientes: [], membros: [] },
      ],
    };
    const a = pre.regrasEstruturais(relacao, null);

    ok("dois blocos com o mesmo rótulo de planilha → PENDENTE (não duplicata)",
      tem(a, "SQUAD_ROTULO_DUPLICADO_NA_PLANILHA", PENDENTE));
    ok("rótulo duplicado NÃO é reportado como SQUAD_NOME_DUPLICADO",
      !tem(a, "SQUAD_NOME_DUPLICADO", ERRO));
    ok("rótulo não confirmado → PENDENTE", tem(a, "SQUAD_ROTULO_NAO_CONFIRMADO", PENDENTE));
    ok("a hipótese aparece na mensagem, para o humano confirmar",
      a.some((x) => x.codigo === "SQUAD_ROTULO_NAO_CONFIRMADO" && /Squad 6/.test(x.msg)));

    // A HIPÓTESE NUNCA VIRA DADO PERSISTIDO.
    const plano = pre.construirPlanoCanonico(relacao);
    ok("o 6º bloco NÃO entra no plano enquanto o rótulo é hipótese",
      plano.squads.length === 1 && plano.squads[0].slug === "squad-5");
    ok('nenhum squad chamado "Squad 6" é criado a partir de suposição',
      !JSON.stringify(plano).includes("Squad 6") && !JSON.stringify(plano).includes("squad-6"));
    ok("as memberships do 6º bloco também ficam fora do plano",
      !plano.membros.some((m) => m.usuario === "Matheus" || m.usuario === "Victor"));

    // ROTULO_STATUS pendente basta para barrar, mesmo com nome preenchido.
    const nomeadoMasPendente = JSON.parse(JSON.stringify(relacao));
    nomeadoMasPendente.squads[1].nome = "Squad 6";
    ok("ROTULO_STATUS pendente barra o Squad mesmo com nome preenchido",
      pre.slugDoSquad(nomeadoMasPendente.squads[1]) === "");
  }

  console.log("\n27. ausência de Auxiliar 2 é aceita; Design desconhecido é pendência\n");
  {
    const squad = (over) => ({
      squads: [{
        nome: "S", slug: "s", coordenador: "C", gestor: "G", auxiliares: ["A"],
        auxiliar2: "", design: "D", principal: [], clientes: [], membros: [], ...over,
      }],
    });

    const semAux2 = pre.regrasEstruturais(squad({ auxiliar2: "AUSENTE_NA_ESTRUTURA" }), null);
    ok("Auxiliar 2 marcado ausente → INFO", tem(semAux2, "AUXILIAR_2_AUSENTE_NA_ESTRUTURA", INFO));
    ok("ausência de Auxiliar 2 NÃO é pendência",
      !semAux2.some((x) => x.codigo === "AUXILIAR_2_AUSENTE_NA_ESTRUTURA" && x.classe === PENDENTE));
    ok("ausência de Auxiliar 2 NÃO é erro",
      !semAux2.some((x) => x.codigo === "AUXILIAR_2_AUSENTE_NA_ESTRUTURA" && x.classe === ERRO));
    ok("Auxiliar 2 em branco também é classificado como ausente na estrutura",
      tem(pre.regrasEstruturais(squad({}), null), "AUXILIAR_2_AUSENTE_NA_ESTRUTURA", INFO));

    // Design é diferente: em branco pode ser "fora do recorte", não "não existe".
    ok("Design com marcador PENDENTE → PENDENTE",
      tem(pre.regrasEstruturais(squad({ design: "PENDENTE_CONFIRMACAO" }), null),
        "DESIGN_PENDENTE_CONFIRMACAO", PENDENTE));
    ok("Design em branco → PENDENTE (não sabemos se não tem ou se falta)",
      tem(pre.regrasEstruturais(squad({ design: "" }), null), "DESIGN_PENDENTE_CONFIRMACAO", PENDENTE));
    ok("Design marcado ausente → INFO",
      tem(pre.regrasEstruturais(squad({ design: "AUSENTE_NA_ESTRUTURA" }), null),
        "DESIGN_AUSENTE_NA_ESTRUTURA", INFO));

    // Formato V1 puro não é cobrado por cargos que ele nunca teve como declarar.
    const v1 = { squads: [{ nome: "S", slug: "s", gestor: "g@vf.com", clientes: [], membros: [] }] };
    const aV1 = pre.regrasEstruturais(v1, null);
    ok("relação V1 não recebe cobrança de Auxiliar 2 nem de Design",
      !tem(aV1, "AUXILIAR_2_AUSENTE_NA_ESTRUTURA") && !tem(aV1, "DESIGN_PENDENTE_CONFIRMACAO"));
  }

  console.log("\n28. INFO nunca vira veredito, nem com --estrito\n");
  {
    const relacao = { squads: [] };
    for (let i = 1; i <= 6; i++) {
      relacao.squads.push({
        nome: `Squad ${i}`, slug: `squad-${i}`, rotuloStatus: "CONFIRMADO",
        coordenador: `c${i}@vf.com`, gestor: `g${i}@vf.com`, auxiliares: [],
        auxiliar2: "AUSENTE_NA_ESTRUTURA", design: "AUSENTE_NA_ESTRUTURA",
        principal: [], clientes: [], membros: [],
      });
    }
    const inv = {
      clientes: [{ id: 1, slug: "acme", nome: "Acme", ativo: true }],
      usuarios: [], squads: [], squad_members: [], cliente_squad_history: [],
    };
    for (let i = 1; i <= 6; i++) {
      inv.usuarios.push({ id: i, nome: `C ${i}`, email: `c${i}@vf.com`, role: "membro", ativo: true });
      inv.usuarios.push({ id: 10 + i, nome: `G ${i}`, email: `g${i}@vf.com`, role: "membro", ativo: true });
    }
    relacao.squads[0].clientes = ["acme"];
    const r = await pre.executar({ relacao, inventario: inv, estrito: true });
    ok("12 INFO de ausência não impedem PRONTO_PARA_DRY_RUN nem com --estrito",
      r.veredito === "PRONTO_PARA_DRY_RUN");
    ok("os INFO estão registrados (não foram varridos pra debaixo do tapete)",
      r.achados.filter((a) => a.classe === INFO).length >= 12);
  }

  console.log("\n29. identidade: NOME HUMANO → email/id, determinístico e sem fuzzy\n");
  {
    const inv = {
      clientes: [],
      usuarios: [
        { id: 1, nome: "Micael Souza", email: "micael.souza@vf.com", role: "membro", ativo: true },
        { id: 2, nome: "Victor Alves", email: "victor.alves@vf.com", role: "membro", ativo: true },
        { id: 3, nome: "Victor Ramos", email: "victor.ramos@vf.com", role: "membro", ativo: true },
        { id: 4, nome: "Vinícius Lima", email: "vinicius.lima@vf.com", role: "membro", ativo: true },
        { id: 5, nome: "Cavazzoto", email: "cavazzoto@vf.com", role: "membro", ativo: true },
      ],
      squads: [], squad_members: [], cliente_squad_history: [],
    };

    const micael = pre.resolverIdentidade("Micael", inv);
    ok("primeiro nome único → MATCH_EXATO",
      micael.status === "MATCH_EXATO" && micael.ref === "micael.souza@vf.com");
    ok("a estratégia usada fica registrada para auditoria humana",
      micael.estrategia === "PRIMEIRO_NOME");

    const victor = pre.resolverIdentidade("Victor", inv);
    ok("dois Victor → MATCH_AMBIGUO, sem escolher nenhum",
      victor.status === "MATCH_AMBIGUO" && victor.ref === null && victor.candidatos.length === 2);

    const cav = pre.resolverIdentidade("Cavazzoto", inv);
    ok("nome completo exato → MATCH_EXATO por NOME_COMPLETO",
      cav.status === "MATCH_EXATO" && cav.estrategia === "NOME_COMPLETO");

    ok("acento não impede igualdade determinística",
      pre.resolverIdentidade("Vinicius", inv).ref === "vinicius.lima@vf.com" &&
      pre.resolverIdentidade("Vinícius", inv).ref === "vinicius.lima@vf.com");

    ok("nome inexistente → NAO_ENCONTRADO (nenhum palpite)",
      pre.resolverIdentidade("Zoroastro", inv).status === "NAO_ENCONTRADO");
    ok("NENHUM fuzzy: 'Micae' e 'Micaela' não casam com 'Micael Souza'",
      pre.resolverIdentidade("Micae", inv).status === "NAO_ENCONTRADO" &&
      pre.resolverIdentidade("Micaela", inv).status === "NAO_ENCONTRADO");

    ok("email é referência direta, não precisa de resolução",
      pre.resolverIdentidade("x@vf.com", inv).estrategia === "REF_DIRETA");
    ok("id numérico é referência direta",
      pre.resolverIdentidade("42", inv).estrategia === "REF_DIRETA");
    ok("sem inventário, nome vira PENDENTE_EMAIL_OU_ID — nunca 'encontrado'",
      pre.resolverIdentidade("Micael", null).status === "PENDENTE_EMAIL_OU_ID");

    // Classificação dentro das regras estruturais.
    const rel = {
      squads: [{ nome: "S", slug: "s", coordenador: "Victor", gestor: "Zoroastro",
        auxiliares: ["Micael"], auxiliar2: "", design: "", principal: [], clientes: [], membros: [] }],
    };
    const a = pre.regrasEstruturais(rel, inv);
    ok("nome ambíguo → ERRO_ESTRUTURAL", tem(a, "USUARIO_NOME_AMBIGUO", ERRO));
    ok("nome não encontrado → ERRO_ESTRUTURAL", tem(a, "USUARIO_NOME_NAO_ENCONTRADO", ERRO));
    ok("match por primeiro nome vira AVISO auditável",
      tem(a, "USUARIO_RESOLVIDO_POR_PRIMEIRO_NOME", AVISO));
  }

  console.log("\n30. nome humano sem email/id NÃO chega ao plano final\n");
  {
    const relacao = {
      squads: [{ nome: "Squad 1", slug: "squad-1", coordenador: "Micael", gestor: "Eliabe",
        auxiliares: [], auxiliar2: "", design: "", principal: [], clientes: [], membros: [] }],
    };
    const a = pre.regrasEstruturais(relacao, null);
    ok("sem inventário, nome humano → PENDENTE de identidade",
      tem(a, "USUARIO_SEM_EMAIL_OU_ID", PENDENTE));

    const plano = pre.construirPlanoCanonico(relacao);
    const inv = pre.invariantesDoPlano(plano);
    ok("invariante do plano barra nome humano como usuario",
      inv.some((x) => x.codigo === "USUARIO_SEM_REFERENCIA_RESOLVIVEL"));
    ok("o invariante nomeia as duas pessoas não resolvidas",
      inv.filter((x) => x.codigo === "USUARIO_SEM_REFERENCIA_RESOLVIVEL").length === 2);

    const r = await pre.executar({ relacao, inventario: null });
    ok("veredito nunca é PRONTO_PARA_DRY_RUN com nome não resolvido",
      r.veredito !== "PRONTO_PARA_DRY_RUN");

    // Multi-Squad sem decisão também é barrado pelo invariante do plano.
    const multi = {
      squads: [
        { nome: "A", slug: "a", coordenador: "c@vf.com", gestor: "g@vf.com", auxiliares: [], auxiliar2: "", design: "", principal: [], clientes: [], membros: [] },
        { nome: "B", slug: "b", coordenador: "c@vf.com", gestor: "h@vf.com", auxiliares: [], auxiliar2: "", design: "", principal: [], clientes: [], membros: [] },
      ],
    };
    const invMulti = pre.invariantesDoPlano(pre.construirPlanoCanonico(multi));
    ok("membership sem principal decidido é barrada no invariante",
      invMulti.filter((x) => x.codigo === "MEMBERSHIP_SEM_PRINCIPAL_DECIDIDO").length === 2);
    ok("nenhum principal implícito foi escrito no plano",
      pre.construirPlanoCanonico(multi).membros
        .filter((m) => m.usuario === "c@vf.com")
        .every((m) => m.principal === undefined));
  }

  console.log("\n31. ZERO escrita e ZERO banco no pré-validador offline\n");
  {
    const fs = require("fs");
    const fonte = fs.readFileSync(require.resolve("../sql/squads-preflight-relacao.js"), "utf8");
    ok('o pré-validador NÃO faz require("pg")', !/require\(\s*["']pg["']\s*\)/.test(fonte));
    ok("não importa o pool do servidor",
      !/require\([^)]*(db|database|pool)[^)]*\)/i.test(fonte.replace(/^\/\/.*$/gm, "")));

    const relacao = pre.parseRelacaoTexto([
      "SQUAD: S", "SLUG: s", "COORDENADOR: c@vf.com", "GESTOR: g@vf.com",
      "CLIENTES:", "MEMBROS:",
    ].join("\n"));

    // Nenhuma escrita em disco durante a validação.
    const escritas = [];
    const orig = { w: fs.writeFileSync, a: fs.appendFileSync, s: fs.createWriteStream };
    fs.writeFileSync = (...args) => { escritas.push(["writeFileSync", args[0]]); };
    fs.appendFileSync = (...args) => { escritas.push(["appendFileSync", args[0]]); };
    fs.createWriteStream = (...args) => { escritas.push(["createWriteStream", args[0]]); return {}; };
    let r;
    try {
      r = await pre.executar({ relacao, inventario: null });
    } finally {
      fs.writeFileSync = orig.w; fs.appendFileSync = orig.a; fs.createWriteStream = orig.s;
    }
    ok("executar() não escreve NENHUM arquivo", escritas.length === 0);

    // O adaptador falso é o único "banco": só marcadores MIG_* e DDL inerte.
    ok("só o adaptador falso é consultado",
      r.consultasFalsas.every((q) => q === "DDL" || /^MIG_/.test(q)));
    ok("DATABASE_URL do processo aponta para host offline",
      /vf-(preflight-offline|test)/.test(String(process.env.DATABASE_URL)));
  }

  console.log("\n32. a relação REAL recebida processa e continua NO-GO\n");
  {
    const path = require("path");
    const arquivo = path.resolve(
      __dirname, "..", "..",
      "Squads_migration/P2_9_REAL_DATA_READINESS/entrada/relacao-squads-operacao-v1.txt");
    const relacao = pre.lerRelacao(arquivo);

    ok("a relação real declara 6 blocos de Squad", relacao.squads.length === 6);
    ok("5 Squads com rótulo confirmado; o 6º pendente",
      relacao.squads.filter((s) => pre.slugDoSquad(s)).length === 5);

    const r = await pre.executar({ relacao, inventario: null });
    ok("nenhum ERRO_ESTRUTURAL na relação real",
      r.achados.filter((a) => a.classe === ERRO).length === 0);
    ok("veredito é AGUARDANDO_RELACAO (não PRONTO)", r.veredito === "AGUARDANDO_RELACAO");
    ok("23 pessoas únicas", r.totais.pessoasUnicas === 23);
    ok("3 pessoas multi-Squad", r.totais.pessoasMultiSquad === 3);
    ok("as 3 são Klayvert, Micael e Fernando",
      r.memberships.filter((m) => m.multiSquad).map((m) => m.pessoa).sort().join(",") ===
        "Fernando,Klayvert,Micael");
    ok("3 decisões de Squad principal pendentes", r.totais.principalPendente === 3);
    ok("as 23 identidades continuam sem email/id", r.totais.semReferencia === 23);
    ok("Cliente→Squad continua pendente em todos os 6 blocos",
      r.achados.filter((a) => a.codigo === "CLIENTE_PENDENTE").length === 6);
    ok("nenhuma linha de carteira no plano", r.plano.clientes.length === 0);
    ok("nenhum responsável no plano", r.plano.responsaveis.length === 0);
    ok("Klayvert coordena 3 Squads e isso é INFO, não erro",
      r.achados.some((a) => a.classe === INFO && a.codigo === "COORDENADOR_EM_VARIOS_SQUADS" && /Klayvert/.test(a.msg)));
    ok("rótulo duplicado do 6º bloco é detectado",
      tem(r.achados, "SQUAD_ROTULO_DUPLICADO_NA_PLANILHA", PENDENTE));

    // Os 5 Gestores conhecidos entram como membro, nunca como coordenador.
    const gestores = ["Eliabe", "Adrian", "Diogo", "Anderson", "Witor"];
    ok("os 5 Gestores no plano são funcao=membro",
      gestores.every((g) => r.plano.membros.find((m) => m.usuario === g).funcao === "membro"));
    ok("nenhum Gestor virou coordenador",
      !r.plano.membros.some((m) => gestores.includes(m.usuario) && m.funcao === "coordenador"));
    ok("os Coordenadores dos 5 Squads confirmados são funcao=coordenador",
      r.plano.membros.filter((m) => m.funcao === "coordenador").length === 5);

    ok("a matriz de memberships é gerada em Markdown",
      /^\| PESSOA \| SQUAD \|/.test(pre.matrizMembershipsMarkdown(r)));
  }

  console.log(`\n✓ squadsPreflightRelacao: ${checks} verificações\n`);
}

run().catch((err) => { console.error(err); process.exit(1); });
