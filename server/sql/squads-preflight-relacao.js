#!/usr/bin/env node
// server/sql/squads-preflight-relacao.js
// VenForce V3 — P2.9 Real Data Readiness. Pré-validador OFFLINE da relação humana.
//
// Uso:
//   node server/sql/squads-preflight-relacao.js --relacao <arquivo.txt|.json>
//   node server/sql/squads-preflight-relacao.js --relacao <arq> --inventario <inv.json>
//   node server/sql/squads-preflight-relacao.js --relacao <arq> --emitir-plano <plano.json>
//   node server/sql/squads-preflight-relacao.js --relacao <arq> --estrito     # pendências viram erro
//   node server/sql/squads-preflight-relacao.js --relacao <arq> --json
//   node server/sql/squads-preflight-relacao.js --esqueleto --inventario <inv.json> --saida <rel.txt>
//
// NÃO É UM SEGUNDO SISTEMA DE MIGRAÇÃO. É um pré-validador que:
//   1. lê a relação humana (Squad → Gestor → Clientes → Membros);
//   2. converte para o formato CANÔNICO (Squads_migration/SQUADS_MIGRATION_TEMPLATE.json);
//   3. aplica as regras estruturais que o tooling P2.3 NÃO tem (exatamente 6 Squads,
//      1 Gestor por Squad, marcadores PENDENTE_*/SQUAD_N, completude Cliente/Usuário);
//   4. roda o validador REAL (squadsMigracaoImportService.validarPlano) OFFLINE,
//      contra um snapshot de inventário, através de um adaptador de banco falso.
//
// A saída (--emitir-plano) alimenta o tooling existente:
//   node server/sql/squads-migrate.js --plan <plano.json>          # dry-run com banco
//
// SEGURANÇA: ZERO banco, ZERO escrita, ZERO DDL. Não carrega .env, não abre
// conexão. `validarPlano` sempre recebe o adaptador falso, nunca o pool real.
//
// Exit codes: 0 ok · 2 ERRO_ESTRUTURAL (ou pendência com --estrito) · 3 entrada ilegível.

// Cinto de segurança: mesmo padrão de server/tests/*, garante que nenhum require
// abaixo herde uma DATABASE_URL de produção do ambiente do operador.
process.env.DATABASE_URL = "postgres://localhost/vf-preflight-offline";

const fs = require("fs");
const path = require("path");

const { normalizarSlug } = require("../services/squads/squadService");
const migImport = require("../services/squads/squadsMigracaoImportService");

/* ───────────────────────────── marcadores ───────────────────────────── */

const PREFIXO_PENDENTE = "PENDENTE";
const RE_ID_TEMPORARIO = /^SQUAD_[1-6]$/i;
const TOTAL_SQUADS_ESPERADO = 6;

function ehPendente(v) {
  return typeof v === "string" && v.trim().toUpperCase().startsWith(PREFIXO_PENDENTE);
}
function ehIdTemporario(v) {
  return typeof v === "string" && RE_ID_TEMPORARIO.test(v.trim());
}
function txt(v) { return String(v ?? "").trim(); }
function vazio(v) { return txt(v) === ""; }

/* ─────────────────────── parser da relação humana ─────────────────────── */

// Formato de texto aceito (é exatamente a forma em que a relação costuma chegar):
//
//   SQUAD: Nome Oficial
//   SLUG: nome-oficial            (opcional — derivado do nome se ausente)
//   GESTOR: fulano@venforce.com
//   CLIENTES:
//     - cliente-slug-a
//     - 123
//   MEMBROS:
//     - pessoa@venforce.com
//     - 45
//
// Linhas iniciadas por # são comentários. Blocos são separados por `SQUAD:`.
function parseRelacaoTexto(conteudo) {
  const squads = [];
  let atual = null;
  let secao = null; // "clientes" | "membros" | null

  const linhas = String(conteudo).split(/\r?\n/);
  for (const [i, cru] of linhas.entries()) {
    const linha = cru.replace(/\s+$/, "");
    const semComentario = linha.replace(/^\s*#.*$/, "");
    if (!txt(semComentario)) continue;

    const cabecalho = semComentario.match(/^\s*([A-Za-zÀ-ÿ_]+)\s*:\s*(.*)$/);
    const item = semComentario.match(/^\s*[-*]\s+(.+)$/);

    if (cabecalho) {
      const chave = cabecalho[1].trim().toUpperCase();
      const valor = txt(cabecalho[2]);

      if (chave === "SQUAD") {
        atual = { idTemporario: null, nome: valor, slug: "", gestor: "", clientes: [], membros: [], _linha: i + 1 };
        squads.push(atual);
        secao = null;
        continue;
      }
      if (!atual) continue; // chave antes do primeiro SQUAD: ignorada

      if (chave === "ID_TEMPORARIO") { atual.idTemporario = valor; secao = null; continue; }
      if (chave === "SLUG") { atual.slug = valor; secao = null; continue; }
      if (chave === "GESTOR") { atual.gestor = valor; secao = null; continue; }
      if (chave === "CLIENTES") {
        secao = "clientes";
        if (valor) atual.clientes.push(valor);
        continue;
      }
      if (chave === "MEMBROS") {
        secao = "membros";
        if (valor) atual.membros.push(valor);
        continue;
      }
      secao = null;
      continue;
    }

    if (item && atual && secao) {
      const valor = txt(item[1]);
      if (valor) atual[secao].push(valor);
    }
  }
  return { squads };
}

function lerRelacao(arquivo) {
  const conteudo = fs.readFileSync(arquivo, "utf8");
  if (path.extname(arquivo).toLowerCase() === ".json") {
    const bruto = JSON.parse(conteudo);
    const squads = Array.isArray(bruto?.squads) ? bruto.squads : [];
    return {
      squads: squads.map((s, i) => ({
        idTemporario: s?.id_temporario ?? s?.idTemporario ?? null,
        nome: txt(s?.nome),
        slug: txt(s?.slug),
        gestor: txt(s?.gestor),
        clientes: Array.isArray(s?.clientes) ? s.clientes.map(txt).filter(Boolean) : [],
        membros: Array.isArray(s?.membros) ? s.membros.map(txt).filter(Boolean) : [],
        _linha: i + 1,
      })),
    };
  }
  return parseRelacaoTexto(conteudo);
}

/* ──────────────────── conversão para o formato canônico ──────────────────── */

// Produz exatamente o shape aceito por squadsMigracaoImportService.
// O Gestor do Squad vira a membership com funcao "coordenador" — é assim que o
// modelo representa "quem responde pelo Squad" (01_DADOS_HUMANOS_NECESSARIOS §4:
// coordenador é atributo da membership, não de cliente_responsaveis).
function construirPlanoCanonico(relacao, { descricao } = {}) {
  const plano = {
    versao: 1,
    descricao: descricao || "P2.9 — migração inicial de Squads",
    squads: [],
    membros: [],
    clientes: [],
    responsaveis: [],
  };

  const principalJaUsado = new Set(); // usuário → só 1 principal em todo o plano

  for (const s of relacao.squads) {
    // Squad ainda sem nome oficial não vira linha de plano — ele é uma
    // pendência, não um registro. Sem isso, os 6 marcadores
    // PENDENTE_NOME_OFICIAL colidiriam em slug e o gabarito em branco
    // reportaria "erro" onde só existe "aguardando".
    if (ehPendente(s.nome) || vazio(s.nome)) continue;

    const slug = txt(s.slug) || normalizarSlug(s.nome);
    plano.squads.push({ slug, nome: txt(s.nome), ativo: true });

    if (!vazio(s.gestor)) {
      plano.membros.push({
        squad: slug,
        usuario: txt(s.gestor),
        funcao: "coordenador",
        principal: !principalJaUsado.has(txt(s.gestor).toLowerCase()),
      });
      principalJaUsado.add(txt(s.gestor).toLowerCase());
    }

    for (const m of s.membros) {
      const chave = txt(m).toLowerCase();
      plano.membros.push({
        squad: slug,
        usuario: txt(m),
        funcao: "membro",
        principal: !principalJaUsado.has(chave),
      });
      principalJaUsado.add(chave);
    }

    for (const c of s.clientes) {
      plano.clientes.push({ cliente: txt(c), squad: slug, motivo: "migração inicial P2.9" });
    }
  }

  return plano;
}

/* ─────────────── regras estruturais que o tooling P2.3 não tem ─────────────── */

const ERRO = "ERRO_ESTRUTURAL";
const PENDENTE = "PENDENTE_ESPERADO";
const AVISO = "AVISO";

function novoColetor() {
  const achados = [];
  return {
    achados,
    add: (classe, codigo, contexto, msg) => achados.push({ classe, codigo, contexto, msg }),
  };
}

function regrasEstruturais(relacao, inventario) {
  const col = novoColetor();
  const squads = relacao.squads;

  // ── L1: exatamente 6 Squads ──
  if (squads.length !== TOTAL_SQUADS_ESPERADO) {
    const classe = squads.length === 0 ? PENDENTE : ERRO;
    col.add(
      classe,
      "SQUADS_QUANTIDADE_INVALIDA",
      "squads",
      `a relação declara ${squads.length} Squad(s); o produto tem exatamente ${TOTAL_SQUADS_ESPERADO}.` +
        (squads.length === 0 ? " Relação ainda não preenchida." : "")
    );
  }

  const nomesVistos = new Map();
  const slugsVistos = new Map();
  const clienteParaSquad = new Map();   // ref normalizada → slug
  const membroParaSquads = new Map();   // ref normalizada → [slug]

  // Um Squad sem clientes só é "pendência" enquanto NENHUM Squad tem cliente —
  // aí a relação claramente ainda não chegou. Depois que ela chega, um Squad
  // legitimamente sem carteira é AVISO, não bloqueio: a regra de produto é
  // "todo Cliente ativo tem 1 Squad", não "todo Squad tem Cliente".
  const algumSquadTemCliente = squads.some((s) => (s.clientes || []).some((c) => !ehPendente(c)));

  for (const [i, s] of squads.entries()) {
    const ctx = `squads[${i}]${s.nome ? ` "${s.nome}"` : ""}`;

    // ── marcadores não resolvidos ──
    if (vazio(s.nome)) {
      col.add(ERRO, "SQUAD_NOME_VAZIO", ctx, "nome do Squad obrigatório.");
    } else if (ehPendente(s.nome)) {
      col.add(PENDENTE, "SQUAD_NOME_PENDENTE", ctx, `nome ainda é o marcador "${s.nome}".`);
    } else if (ehIdTemporario(s.nome)) {
      col.add(ERRO, "SQUAD_IDENTIFICADOR_TEMPORARIO", ctx,
        `"${s.nome}" é identificador temporário de documentação, não nome oficial.`);
    }

    if (ehIdTemporario(s.slug)) {
      col.add(ERRO, "SQUAD_IDENTIFICADOR_TEMPORARIO", ctx,
        `slug "${s.slug}" é identificador temporário de documentação — não pode ir para o banco.`);
    }

    // ── L2/L3: unicidade de nome e slug ──
    const nomeChave = txt(s.nome).toLowerCase();
    if (nomeChave && !ehPendente(s.nome)) {
      if (nomesVistos.has(nomeChave)) {
        col.add(ERRO, "SQUAD_NOME_DUPLICADO", ctx,
          `nome "${s.nome}" repetido (já usado em squads[${nomesVistos.get(nomeChave)}]).`);
      } else nomesVistos.set(nomeChave, i);
    }

    // Um Squad ainda sem nome oficial NÃO participa das checagens de unicidade:
    // os 6 marcadores PENDENTE_NOME_OFICIAL colidiriam entre si e o gabarito em
    // branco reportaria "erro" onde só existe pendência.
    const aguardandoNome = ehPendente(s.nome) || vazio(s.nome);

    const slugEfetivo = txt(s.slug) ? normalizarSlug(s.slug) : normalizarSlug(s.nome);
    if (!slugEfetivo && !aguardandoNome) {
      col.add(ERRO, "SQUAD_SLUG_INVALIDO", ctx, "slug vazio ou inválido após normalização.");
    } else if (slugEfetivo && !aguardandoNome) {
      if (slugsVistos.has(slugEfetivo)) {
        col.add(ERRO, "SQUAD_SLUG_DUPLICADO", ctx,
          `slug "${slugEfetivo}" repetido (já usado em squads[${slugsVistos.get(slugEfetivo)}]).`);
      } else slugsVistos.set(slugEfetivo, i);
      if (txt(s.slug) && normalizarSlug(s.slug) !== txt(s.slug)) {
        col.add(AVISO, "SQUAD_SLUG_NORMALIZADO", ctx,
          `slug "${s.slug}" será normalizado para "${slugEfetivo}".`);
      }
    }

    // ── L4: exatamente 1 Gestor por Squad ──
    if (vazio(s.gestor)) {
      col.add(PENDENTE, "SQUAD_SEM_GESTOR", ctx, "Gestor ainda não informado.");
    } else if (ehPendente(s.gestor)) {
      col.add(PENDENTE, "SQUAD_SEM_GESTOR", ctx, `Gestor ainda é o marcador "${s.gestor}".`);
    } else if (Array.isArray(s.gestor)) {
      col.add(ERRO, "SQUAD_MULTIPLOS_GESTORES", ctx, "um Squad tem exatamente 1 Gestor principal.");
    }

    // ── clientes ──
    if (!s.clientes.length) {
      col.add(
        algumSquadTemCliente ? AVISO : PENDENTE,
        "SQUAD_SEM_CLIENTES",
        ctx,
        algumSquadTemCliente
          ? "Squad sem nenhum Cliente na carteira — confirme se é intencional."
          : "nenhum Cliente atribuído — aguardando relação Cliente→Squad."
      );
    }
    for (const c of s.clientes) {
      if (ehPendente(c)) {
        col.add(PENDENTE, "CLIENTE_PENDENTE", ctx, `entrada de cliente ainda é o marcador "${c}".`);
        continue;
      }
      const chave = txt(c).toLowerCase();
      if (clienteParaSquad.has(chave) && clienteParaSquad.get(chave) !== slugEfetivo) {
        col.add(ERRO, "CLIENTE_EM_DOIS_SQUADS", ctx,
          `cliente "${c}" aparece em 2 Squads ("${clienteParaSquad.get(chave)}" e "${slugEfetivo}").`);
      } else if (clienteParaSquad.has(chave)) {
        col.add(AVISO, "CLIENTE_REPETIDO", ctx, `cliente "${c}" repetido no mesmo Squad.`);
      } else {
        clienteParaSquad.set(chave, slugEfetivo);
      }
    }

    // ── membros ──
    const refsMembro = [...(vazio(s.gestor) || ehPendente(s.gestor) ? [] : [s.gestor]), ...s.membros];
    const vistosNoSquad = new Set();
    for (const m of refsMembro) {
      if (ehPendente(m)) {
        col.add(PENDENTE, "MEMBRO_PENDENTE", ctx, `entrada de membro ainda é o marcador "${m}".`);
        continue;
      }
      const chave = txt(m).toLowerCase();
      if (vistosNoSquad.has(chave)) {
        col.add(ERRO, "MEMBERSHIP_DUPLICADA", ctx, `usuário "${m}" repetido no mesmo Squad.`);
        continue;
      }
      vistosNoSquad.add(chave);
      if (!membroParaSquads.has(chave)) membroParaSquads.set(chave, []);
      membroParaSquads.get(chave).push(slugEfetivo);
    }

    if (!s.membros.length && !vazio(s.gestor) && !ehPendente(s.gestor)) {
      col.add(AVISO, "SQUAD_SO_COM_GESTOR", ctx, "Squad sem membros além do Gestor.");
    }
  }

  // ── usuário em vários Squads (permitido; exige 1 principal) ──
  for (const [ref, slugs] of membroParaSquads) {
    if (slugs.length > 1) {
      col.add(AVISO, "USUARIO_EM_VARIOS_SQUADS", "membros",
        `"${ref}" participa de ${slugs.length} Squads (${slugs.join(", ")}) — permitido; ` +
        `o plano marca o primeiro como principal.`);
    }
  }

  // ── completude contra o inventário (só quando há inventário) ──
  if (!inventario) {
    col.add(PENDENTE, "SEM_INVENTARIO", "inventario",
      "sem snapshot de inventário: existência de Cliente/Usuário não verificada offline. " +
      "Gere com: node server/sql/squads-inventario-readonly.js --saida inventario.json");
  } else {
    const clientesAtivos = (inventario.clientes || []).filter((c) => c.ativo !== false);
    const porRef = new Set();
    for (const c of inventario.clientes || []) {
      if (c.slug) porRef.add(String(c.slug).toLowerCase());
      if (c.id != null) porRef.add(String(c.id));
    }
    for (const [ref] of clienteParaSquad) {
      if (!porRef.has(ref)) {
        col.add(ERRO, "CLIENTE_INEXISTENTE", "clientes",
          `cliente "${ref}" não existe no inventário.`);
      }
    }
    for (const c of clientesAtivos) {
      const porSlug = c.slug && clienteParaSquad.has(String(c.slug).toLowerCase());
      const porId = c.id != null && clienteParaSquad.has(String(c.id));
      if (!porSlug && !porId) {
        col.add(PENDENTE, "CLIENTE_SEM_SQUAD", "clientes",
          `cliente ativo "${c.slug || c.id}" não foi atribuído a nenhum Squad.`);
      }
    }

    const usuariosRef = new Set();
    for (const u of inventario.usuarios || []) {
      if (u.email) usuariosRef.add(String(u.email).toLowerCase());
      if (u.id != null) usuariosRef.add(String(u.id));
    }
    for (const [ref] of membroParaSquads) {
      if (!usuariosRef.has(ref)) {
        col.add(ERRO, "USUARIO_INEXISTENTE", "membros",
          `usuário "${ref}" não existe no inventário.`);
      }
    }
    // ATENÇÃO: ROLES_INTERNAS existe em TRÊS cópias divergentes no código —
    //   squadsMigracaoService.js:14   ["user","membro","interno"]          ← auditoria (gate `pronto`)
    //   authorizationService.js:17    ["user","membro","interno"]          ← autorização
    //   squadsMigracaoImportService.js:31 ["user","membro","interno","admin"]  ← importador (+admin)
    // Aqui usamos a do AUDITORIA, porque é ela que decide `pronto` e, portanto,
    // o rollout gate. admin é bypass e NÃO precisa de membership.
    // Ver 12_ROLLOUT_GATE_ATUAL.md (risco T-2).
    const ROLES_INTERNAS = new Set(["user", "membro", "interno"]);
    for (const u of inventario.usuarios || []) {
      if (u.ativo === false) continue;
      if (!ROLES_INTERNAS.has(String(u.role || "").toLowerCase())) continue;
      const porEmail = u.email && membroParaSquads.has(String(u.email).toLowerCase());
      const porId = u.id != null && membroParaSquads.has(String(u.id));
      if (!porEmail && !porId) {
        col.add(PENDENTE, "USUARIO_SEM_MEMBERSHIP", "membros",
          `interno ativo "${u.email || u.id}" não entrou em nenhum Squad.`);
      }
    }
  }

  return col.achados;
}

/* ───────────── adaptador de banco falso (inventário → validarPlano) ───────────── */

// Responde exatamente às 5 queries marcadas de resolverEntidades().
// Qualquer outra query (o DDL idempotente de ensureSquadsTables) devolve vazio.
function criarDbFalso(inventario) {
  const inv = inventario || {};
  const clientes = inv.clientes || [];
  const usuarios = inv.usuarios || [];
  const squads = inv.squads || [];
  const members = inv.squad_members || [];
  const history = inv.cliente_squad_history || [];

  return {
    _consultas: [],
    async query(sql, params = []) {
      this._consultas.push(String(sql).match(/squads:([A-Z_]+)/)?.[1] || "DDL");

      if (sql.includes("MIG_RESOLVE_SQUADS")) {
        const alvo = new Set((params[0] || []).map(String));
        return { rows: squads.filter((s) => alvo.has(String(s.slug)))
          .map((s) => ({ id: s.id, slug: s.slug, nome: s.nome, ativo: s.ativo !== false })) };
      }
      if (sql.includes("MIG_RESOLVE_USERS")) {
        const ids = new Set((params[0] || []).map(Number));
        const emails = new Set((params[1] || []).map((e) => String(e).toLowerCase()));
        return { rows: usuarios
          .filter((u) => ids.has(Number(u.id)) || emails.has(String(u.email || "").toLowerCase()))
          .map((u) => ({ id: u.id, nome: u.nome, email: u.email, role: u.role, ativo: u.ativo !== false })) };
      }
      if (sql.includes("MIG_RESOLVE_CLIENTES")) {
        const ids = new Set((params[0] || []).map(Number));
        const slugs = new Set((params[1] || []).map((s) => String(s).toLowerCase()));
        return { rows: clientes
          .filter((c) => ids.has(Number(c.id)) || slugs.has(String(c.slug || "").toLowerCase()))
          .map((c) => ({ id: c.id, slug: c.slug, nome: c.nome, ativo: c.ativo !== false })) };
      }
      if (sql.includes("MIG_MEMBERSHIPS_EXISTENTES")) {
        const ids = new Set((params[0] || []).map(Number));
        const squadPorId = new Map(squads.map((s) => [Number(s.id), s]));
        return { rows: members.filter((m) => ids.has(Number(m.user_id))).map((m) => {
          const s = squadPorId.get(Number(m.squad_id)) || {};
          return { user_id: m.user_id, squad_id: m.squad_id, is_primary: !!m.is_primary,
            funcao: m.funcao, ativo: m.ativo !== false, squad_slug: s.slug, squad_ativo: s.ativo !== false };
        }) };
      }
      if (sql.includes("MIG_VINCULOS_EXISTENTES")) {
        const ids = new Set((params[0] || []).map(Number));
        const squadPorId = new Map(squads.map((s) => [Number(s.id), s]));
        return { rows: history
          .filter((h) => h.fim_em == null && ids.has(Number(h.cliente_id)))
          .map((h) => {
            const s = squadPorId.get(Number(h.squad_id)) || {};
            return { cliente_id: h.cliente_id, squad_id: h.squad_id, squad_slug: s.slug, squad_ativo: s.ativo !== false };
          }) };
      }
      return { rows: [] }; // DDL de ensureSquadsTables — inerte no adaptador falso
    },
  };
}

/* ─────────── esqueleto pré-preenchido a partir do inventário ─────────── */

// BLOCO J: gera a relação com TODOS os campos objetivos já preenchidos —
// os 6 blocos de Squad vazios, mais o catálogo comentado de Clientes ativos e
// internos ativos. A operação só precisa MOVER linhas para dentro dos Squads.
function gerarEsqueleto(inventario) {
  const inv = inventario || {};
  const clientes = (inv.clientes || []).filter((c) => c.ativo !== false);
  const ROLES_INTERNAS = new Set(["user", "membro", "interno"]);
  const internos = (inv.usuarios || []).filter(
    (u) => u.ativo !== false && ROLES_INTERNAS.has(String(u.role || "").toLowerCase()));

  const L = [];
  L.push("# ═══════════════════════════════════════════════════════════════════");
  L.push("#  P2.9 — RELAÇÃO DEFINITIVA DOS 6 SQUADS (esqueleto pré-preenchido)");
  L.push(`#  Gerado de inventário de ${inv.geradoEm || "(sem data)"}`);
  L.push("#");
  L.push(`#  Clientes ativos a distribuir: ${clientes.length}`);
  L.push(`#  Internos ativos a alocar:     ${internos.length}`);
  L.push("#");
  L.push("#  COMO USAR: mova cada linha do CATÁLOGO (no fim do arquivo) para a");
  L.push("#  lista CLIENTES: ou MEMBROS: do Squad correto, removendo o '#'.");
  L.push("#  Todo Cliente ativo precisa acabar em exatamente 1 Squad.");
  L.push("# ═══════════════════════════════════════════════════════════════════");
  L.push("");

  for (let i = 1; i <= TOTAL_SQUADS_ESPERADO; i++) {
    L.push(`# ── Squad ${i} de ${TOTAL_SQUADS_ESPERADO} ──`);
    L.push("SQUAD: PENDENTE_NOME_OFICIAL");
    L.push("GESTOR: PENDENTE_DADO_HUMANO");
    L.push("CLIENTES:");
    L.push("MEMBROS:");
    L.push("");
  }

  L.push("# ═══════════════════════════════════════════════════════════════════");
  L.push(`#  CATÁLOGO — ${clientes.length} CLIENTES ATIVOS (nenhum atribuído)`);
  L.push("#  formato:  slug  ·  nome  ·  contas ativas  ·  marketplaces");
  L.push("# ═══════════════════════════════════════════════════════════════════");
  for (const c of clientes) {
    const mkts = Array.isArray(c.marketplaces_ativos) ? c.marketplaces_ativos.join("/") : "";
    L.push(`#   - ${c.slug}   ·  ${c.nome}  ·  ${c.contas_ativas ?? 0} conta(s)  ·  ${mkts || "sem conta"}`);
  }
  L.push("");
  L.push("# ═══════════════════════════════════════════════════════════════════");
  L.push(`#  CATÁLOGO — ${internos.length} INTERNOS ATIVOS (nenhum alocado)`);
  L.push("#  admin NÃO precisa de Squad (bypass). seller/shopee_reviewer também não.");
  L.push("# ═══════════════════════════════════════════════════════════════════");
  for (const u of internos) {
    L.push(`#   - ${u.email}   ·  ${u.nome}  ·  role=${u.role}`);
  }
  L.push("");
  return L.join("\n");
}

/* ───────────────────────────── relatório ───────────────────────────── */

function linha(t = "") { process.stdout.write(t + "\n"); }

function imprimirRelatorio(r) {
  linha("");
  linha("═══════════════════════════════════════════════════════════");
  linha(`  P2.9 — PRÉ-VALIDAÇÃO DA RELAÇÃO (OFFLINE, ZERO BANCO)`);
  linha("═══════════════════════════════════════════════════════════");
  linha("");
  linha(`Relação:     ${r.arquivoRelacao}`);
  linha(`Inventário:  ${r.arquivoInventario || "(nenhum — existência não verificada)"}`);
  linha(`Squads:      ${r.totais.squads}/${TOTAL_SQUADS_ESPERADO}`);
  linha(`Clientes:    ${r.totais.clientes}`);
  linha(`Memberships: ${r.totais.membros}`);
  linha("");
  linha(`VEREDITO: ${r.veredito}`);

  const grupos = [
    [ERRO, "✗", r.achados.filter((a) => a.classe === ERRO)],
    [AVISO, "⚠", r.achados.filter((a) => a.classe === AVISO)],
    [PENDENTE, "…", r.achados.filter((a) => a.classe === PENDENTE)],
  ];
  for (const [classe, simbolo, itens] of grupos) {
    if (!itens.length) continue;
    linha("");
    linha(`${classe} (${itens.length}):`);
    for (const a of itens) linha(`  ${simbolo} [${a.codigo}] ${a.contexto}: ${a.msg}`);
  }

  linha("");
  linha(">> " + r.motivo);
  linha("");
}

/* ───────────────────────────── CLI ───────────────────────────── */

function parseArgs(argv) {
  const a = { relacao: null, inventario: null, emitirPlano: null, esqueleto: false,
    saida: null, json: false, estrito: false, help: false };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--relacao" || t === "-r") a.relacao = argv[++i];
    else if (t === "--inventario" || t === "-i") a.inventario = argv[++i];
    else if (t === "--emitir-plano" || t === "-o") a.emitirPlano = argv[++i];
    else if (t === "--esqueleto") a.esqueleto = true;
    else if (t === "--saida") a.saida = argv[++i];
    else if (t === "--json") a.json = true;
    else if (t === "--estrito") a.estrito = true;
    else if (t === "-h" || t === "--help") a.help = true;
  }
  return a;
}

function lerInventario(caminho) {
  const p = path.resolve(caminho);
  if (!fs.existsSync(p)) {
    console.error(`Erro: inventário não encontrado: ${p}`);
    process.exit(3);
  }
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    console.error(`Erro: inventário ilegível: ${e.message}`);
    process.exit(3);
  }
}

async function executar({ relacao, inventario, estrito = false }) {
  const achados = regrasEstruturais(relacao, inventario);
  const plano = construirPlanoCanonico(relacao);

  // Validador REAL do tooling P2.3, offline, contra o adaptador falso.
  const dbFalso = criarDbFalso(inventario);
  let validacaoTooling = { ok: true, erros: [], avisos: [] };
  if (plano.squads.length) {
    validacaoTooling = await migImport.validarPlano(plano, dbFalso);
  }

  // Sem inventário, "não encontrado" é consequência do inventário vazio, não do
  // plano — vira PENDENTE, não ERRO. Com inventário, o veredito do tooling vale.
  const semInventario = !inventario;
  for (const e of validacaoTooling.erros || []) {
    const deExistencia = /não encontrado|não existe/i.test(e.msg);
    achados.push({
      classe: semInventario && deExistencia ? PENDENTE : ERRO,
      codigo: "TOOLING_P2_3",
      contexto: e.contexto,
      msg: e.msg,
    });
  }
  for (const w of validacaoTooling.avisos || []) {
    achados.push({ classe: AVISO, codigo: "TOOLING_P2_3", contexto: w.contexto, msg: w.msg });
  }

  const erros = achados.filter((a) => a.classe === ERRO);
  const pendentes = achados.filter((a) => a.classe === PENDENTE);

  let veredito;
  let motivo;
  if (erros.length) {
    veredito = "ERRO_ESTRUTURAL";
    motivo = `${erros.length} erro(s) estrutural(is). Corrija a relação e rode de novo. Nenhum plano emitido.`;
  } else if (pendentes.length && estrito) {
    veredito = "ERRO_ESTRUTURAL";
    motivo = `--estrito: ${pendentes.length} pendência(s) tratadas como erro. A relação ainda não está completa.`;
  } else if (pendentes.length) {
    veredito = "AGUARDANDO_RELACAO";
    motivo = `Estrutura íntegra; ${pendentes.length} pendência(s) esperada(s) aguardando dado humano. ` +
      `Nada aqui é erro — é a fronteira da informação.`;
  } else {
    veredito = "PRONTO_PARA_DRY_RUN";
    motivo = "Relação completa e estruturalmente válida. Próximo passo: " +
      "node server/sql/squads-migrate.js --plan <plano.json> (dry-run com banco).";
  }

  return {
    veredito,
    motivo,
    achados,
    plano,
    totais: {
      squads: relacao.squads.length,
      clientes: plano.clientes.length,
      membros: plano.membros.length,
    },
    consultasFalsas: dbFalso._consultas,
  };
}

async function main() {
  const args = parseArgs(process.argv);

  // Modo esqueleto (BLOCO J): inventário → relação pré-preenchida.
  if (args.esqueleto) {
    if (!args.inventario) {
      console.error("Erro: --esqueleto exige --inventario <inventario.json>.");
      process.exit(3);
    }
    const texto = gerarEsqueleto(lerInventario(args.inventario));
    if (args.saida) {
      fs.writeFileSync(path.resolve(args.saida), texto, "utf8");
      linha(`Esqueleto da relação escrito em: ${path.resolve(args.saida)}`);
    } else {
      process.stdout.write(texto);
    }
    process.exit(0);
  }

  if (args.help || !args.relacao) {
    linha(fs.readFileSync(__filename, "utf8").split("\n").slice(1, 26).join("\n").replace(/^\/\/ ?/gm, "").trimEnd());
    process.exit(args.help ? 0 : 3);
  }

  const caminhoRelacao = path.resolve(args.relacao);
  if (!fs.existsSync(caminhoRelacao)) {
    console.error(`Erro: relação não encontrada: ${caminhoRelacao}`);
    process.exit(3);
  }

  let relacao;
  try {
    relacao = lerRelacao(caminhoRelacao);
  } catch (e) {
    console.error(`Erro: relação ilegível (${caminhoRelacao}): ${e.message}`);
    process.exit(3);
  }

  const inventario = args.inventario ? lerInventario(args.inventario) : null;

  const r = await executar({ relacao, inventario, estrito: args.estrito });
  r.arquivoRelacao = caminhoRelacao;
  r.arquivoInventario = args.inventario ? path.resolve(args.inventario) : null;

  if (args.json) linha(JSON.stringify(r, null, 2));
  else imprimirRelatorio(r);

  // Só emite o plano se ele for utilizável — nunca um plano com pendência.
  if (args.emitirPlano) {
    if (r.veredito === "PRONTO_PARA_DRY_RUN") {
      fs.writeFileSync(path.resolve(args.emitirPlano), JSON.stringify(r.plano, null, 2) + "\n", "utf8");
      if (!args.json) linha(`Plano canônico emitido em: ${path.resolve(args.emitirPlano)}\n`);
    } else if (!args.json) {
      linha(`Plano NÃO emitido: veredito é ${r.veredito}.\n`);
    }
  }

  process.exit(r.veredito === "ERRO_ESTRUTURAL" ? 2 : 0);
}

module.exports = {
  parseRelacaoTexto,
  lerRelacao,
  construirPlanoCanonico,
  regrasEstruturais,
  criarDbFalso,
  gerarEsqueleto,
  executar,
  TOTAL_SQUADS_ESPERADO,
  ERRO, PENDENTE, AVISO,
};

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
