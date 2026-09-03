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
//   node server/sql/squads-preflight-relacao.js --relacao <arq> --memberships   # matriz PESSOA×SQUAD
//   node server/sql/squads-preflight-relacao.js --esqueleto --inventario <inv.json> --saida <rel.txt>
//
// NÃO É UM SEGUNDO SISTEMA DE MIGRAÇÃO. É um pré-validador que:
//   1. lê a relação humana. A estrutura REAL da empresa é
//      Squad → Coordenador → Gestor → Auxiliar → Auxiliar 2 → Design,
//      e NÃO "Squad → Gestor → membros" (formato V1, ainda aceito);
//   2. converte para o formato CANÔNICO (Squads_migration/SQUADS_MIGRATION_TEMPLATE.json);
//   3. aplica as regras estruturais que o tooling P2.3 NÃO tem (exatamente 6 Squads,
//      1 Coordenador e 1 Gestor por Squad, Coordenador ≠ Gestor, marcadores
//      PENDENTE_*/SQUAD_N, completude Cliente/Usuário, e — principalmente —
//      RECUSA escolher o Squad principal de usuário multi-Squad);
//   4. roda o validador REAL (squadsMigracaoImportService.validarPlano) OFFLINE,
//      contra um snapshot de inventário, através de um adaptador de banco falso.
//
// A saída (--emitir-plano) alimenta o tooling existente:
//   node server/sql/squads-migrate.js --plan <plano.json>          # dry-run com banco
//
// DUAS DIMENSÕES, DELIBERADAMENTE SEPARADAS:
//   SQUAD MEMBERSHIP (squad_members.funcao ∈ membro|coordenador) = acesso ao Squad
//   CLIENT RESPONSIBILITY (cliente_responsaveis.papel ∈ gestor|auxiliar|designer)
//     = responsabilidade POR CLIENTE.
// Coordenador → funcao=coordenador. Gestor/Auxiliar/Design → funcao=membro, com a
// função ORGANIZACIONAL preservada fora do enum, para virar `responsaveis[]` só
// quando Cliente→Squad chegar. NENHUM enum novo é criado em squad_members.
// O Gestor NUNCA vira coordenador — esse era um pressuposto errado do V1.
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
// "o cargo NÃO EXISTE neste Squad" — diferente de "dado faltando". Squad 5 não
// tem Auxiliar 2, e isso não é pendência: é a estrutura real (BLOCO 4).
const MARCADOR_AUSENTE = "AUSENTE_NA_ESTRUTURA";
// ROTULO_STATUS e FAIL-CLOSED: so o valor exato CONFIRMADO libera o Squad. Um
// status ausente vale como confirmado (formato V1 nao tem o campo); qualquer
// outro texto -- SQUAD_6_PENDENTE_CONFIRMACAO_DO_ROTULO inclusive -- barra.
const ROTULO_CONFIRMADO = "CONFIRMADO";

function ehPendente(v) {
  return typeof v === "string" && v.trim().toUpperCase().startsWith(PREFIXO_PENDENTE);
}
function ehAusenteNaEstrutura(v) {
  return typeof v === "string" && v.trim().toUpperCase() === MARCADOR_AUSENTE;
}
function rotuloConfirmado(s) {
  const st = txt(s && s.rotuloStatus);
  return st === "" || st.toUpperCase() === ROTULO_CONFIRMADO;
}
function ehIdTemporario(v) {
  return typeof v === "string" && RE_ID_TEMPORARIO.test(v.trim());
}
function txt(v) { return String(v ?? "").trim(); }
function vazio(v) { return txt(v) === ""; }

// Referência que o plano canônico aceita de verdade: email ou id numérico.
// Nome humano NÃO é referência — o tooling não garante unicidade de nome.
function ehRefDireta(v) {
  const t = txt(v);
  return t.includes("@") || /^[0-9]+$/.test(t);
}
// Comparação determinística de nome humano: sem acento, minúsculo, espaço
// colapsado. NUNCA distância de edição, NUNCA substring — não há fuzzy aqui.
function normalizarNome(v) {
  return String(v ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/\s+/g, " ").trim();
}

/* ─────────────────────── parser da relação humana ─────────────────────── */

// Formato V2 — preserva as funções operacionais REAIS da empresa:
//
//   SQUAD: Squad 1
//   SLUG: squad-1                 (opcional — derivado do nome se ausente)
//   ROTULO_ORIGINAL: squad 1      (opcional — o que a planilha literalmente diz)
//   ROTULO_STATUS: CONFIRMADO     (opcional — marcador de rótulo não confirmado)
//   NOME_HIPOTESE: Squad 6        (opcional — hipótese; NUNCA vira dado de plano)
//   COORDENADOR: Micael
//   GESTOR: Eliabe
//   AUXILIAR: Gustavo
//   AUXILIAR_2: Fernando          (ou AUSENTE_NA_ESTRUTURA)
//   AUXILIARES:                   (alternativa em lista)
//     - Gustavo
//   DESIGN: Gabrielly             (ou PENDENTE_CONFIRMACAO)
//   PRINCIPAL:                    (para quem ESTE Squad é o principal)
//     - Klayvert
//   CLIENTES: PENDENTE_RELACAO_CLIENTE_SQUAD
//   MEMBROS:                      (V1 — lista livre, ainda aceita)
//     - pessoa@venforce.com
//
// Formato V1 (SQUAD/SLUG/GESTOR/CLIENTES/MEMBROS) continua parseável. O que
// mudou é a SEMÂNTICA: `GESTOR` nunca mais vira funcao=coordenador.
//
// Linhas iniciadas por # são comentários. Blocos são separados por `SQUAD:`.
function novoSquad(nome, linha) {
  return {
    idTemporario: null, nome, slug: "",
    rotuloOriginal: "", rotuloStatus: "", nomeHipotese: "",
    coordenador: "", gestor: "", auxiliares: [], auxiliar2: "", design: "",
    principal: [], clientes: [], membros: [], _linha: linha,
  };
}

function parseRelacaoTexto(conteudo) {
  const squads = [];
  let atual = null;
  let secao = null; // "clientes" | "membros" | "auxiliares" | "principal" | null

  const linhas = String(conteudo).split(/\r?\n/);
  for (const [i, cru] of linhas.entries()) {
    const linha = cru.replace(/\s+$/, "");
    const semComentario = linha.replace(/^\s*#.*$/, "");
    if (!txt(semComentario)) continue;

    // dígito no nome da chave é obrigatório para AUXILIAR_2.
    const cabecalho = semComentario.match(/^\s*([A-Za-zÀ-ÿ0-9_]+)\s*:\s*(.*)$/);
    const item = semComentario.match(/^\s*[-*]\s+(.+)$/);

    if (cabecalho) {
      const chave = cabecalho[1].trim().toUpperCase();
      const valor = txt(cabecalho[2]);

      if (chave === "SQUAD") {
        atual = novoSquad(valor, i + 1);
        squads.push(atual);
        secao = null;
        continue;
      }
      if (!atual) continue; // chave antes do primeiro SQUAD: ignorada

      if (chave === "ID_TEMPORARIO") { atual.idTemporario = valor; secao = null; continue; }
      if (chave === "SLUG") { atual.slug = valor; secao = null; continue; }
      if (chave === "ROTULO_ORIGINAL") { atual.rotuloOriginal = valor; secao = null; continue; }
      if (chave === "ROTULO_STATUS") { atual.rotuloStatus = valor; secao = null; continue; }
      if (chave === "NOME_HIPOTESE") { atual.nomeHipotese = valor; secao = null; continue; }
      if (chave === "COORDENADOR") { atual.coordenador = valor; secao = null; continue; }
      if (chave === "GESTOR") { atual.gestor = valor; secao = null; continue; }
      if (chave === "AUXILIAR" || chave === "AUXILIAR_1") {
        if (valor) atual.auxiliares.push(valor);
        secao = null;
        continue;
      }
      if (chave === "AUXILIAR_2" || chave === "AUXILIAR2") { atual.auxiliar2 = valor; secao = null; continue; }
      if (chave === "AUXILIARES") {
        secao = "auxiliares";
        if (valor) atual.auxiliares.push(valor);
        continue;
      }
      if (chave === "DESIGN" || chave === "DESIGNER") { atual.design = valor; secao = null; continue; }
      if (chave === "PRINCIPAL") {
        secao = "principal";
        if (valor) atual.principal.push(valor);
        continue;
      }
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
        rotuloOriginal: txt(s?.rotulo_original ?? s?.rotuloOriginal),
        rotuloStatus: txt(s?.rotulo_status ?? s?.rotuloStatus),
        nomeHipotese: txt(s?.nome_hipotese ?? s?.nomeHipotese),
        coordenador: txt(s?.coordenador),
        gestor: txt(s?.gestor),
        auxiliares: Array.isArray(s?.auxiliares) ? s.auxiliares.map(txt).filter(Boolean) : [],
        auxiliar2: txt(s?.auxiliar_2 ?? s?.auxiliar2),
        design: txt(s?.design ?? s?.designer),
        principal: Array.isArray(s?.principal) ? s.principal.map(txt).filter(Boolean) : [],
        clientes: Array.isArray(s?.clientes) ? s.clientes.map(txt).filter(Boolean) : [],
        membros: Array.isArray(s?.membros) ? s.membros.map(txt).filter(Boolean) : [],
        _linha: i + 1,
      })),
    };
  }
  return parseRelacaoTexto(conteudo);
}

/* ─────────── funções operacionais reais → modelo canônico ─────────── */

// A TABELA DE MAPEAMENTO É O CORAÇÃO DESTA FASE. Fica explícita de propósito.
//
//   funcaoMembership  → squad_members.funcao        (acesso/participação)
//   papelResponsavel  → cliente_responsaveis.papel  (responsabilidade POR CLIENTE)
//
// O Coordenador é o único cargo que o enum de membership representa. Gestor,
// Auxiliar e Design entram como "membro"; a função organizacional deles é
// preservada em papelResponsavel e SÓ vira responsaveis[] quando Cliente→Squad
// chegar. Nenhum enum novo é inventado em squad_members.
const FUNCOES_OPERACIONAIS = {
  coordenador: { funcaoMembership: "coordenador", papelResponsavel: null,       rotulo: "Coordenador" },
  gestor:      { funcaoMembership: "membro",      papelResponsavel: "gestor",   rotulo: "Gestor" },
  auxiliar:    { funcaoMembership: "membro",      papelResponsavel: "auxiliar", rotulo: "Auxiliar" },
  auxiliar2:   { funcaoMembership: "membro",      papelResponsavel: "auxiliar", rotulo: "Auxiliar 2" },
  designer:    { funcaoMembership: "membro",      papelResponsavel: "designer", rotulo: "Design" },
  membro:      { funcaoMembership: "membro",      papelResponsavel: null,       rotulo: "Membro (V1)" },
};

// Estados de uma célula da planilha. AUSENTE_NA_ESTRUTURA e VAZIO NÃO são erro;
// PENDENTE é a fronteira da informação, não defeito.
function entradaPessoa(token, papelOperacional) {
  const t = txt(token);
  const meta = FUNCOES_OPERACIONAIS[papelOperacional] || FUNCOES_OPERACIONAIS.membro;
  let estado = "PRESENTE";
  if (t === "") estado = "VAZIO";
  else if (ehAusenteNaEstrutura(t)) estado = "AUSENTE_NA_ESTRUTURA";
  else if (ehPendente(t)) estado = "PENDENTE";
  return {
    token: t,
    papelOperacional,
    rotuloFuncao: meta.rotulo,
    funcaoMembership: meta.funcaoMembership,
    papelResponsavel: meta.papelResponsavel,
    estado,
  };
}

// Ordem determinística: Coordenador, Gestor, Auxiliares, Auxiliar 2, Design, e
// por último a lista livre MEMBROS: do formato V1.
function pessoasDoSquad(s) {
  const out = [
    entradaPessoa(s && s.coordenador, "coordenador"),
    entradaPessoa(s && s.gestor, "gestor"),
  ];
  for (const a of (Array.isArray(s && s.auxiliares) ? s.auxiliares : [])) {
    out.push(entradaPessoa(a, "auxiliar"));
  }
  out.push(entradaPessoa(s && s.auxiliar2, "auxiliar2"));
  out.push(entradaPessoa(s && s.design, "designer"));
  for (const m of (Array.isArray(s && s.membros) ? s.membros : [])) {
    out.push(entradaPessoa(m, "membro"));
  }
  return out;
}

// Slug só existe quando o Squad tem nome CONFIRMADO. Rótulo pendente (o 6º
// bloco) não produz slug — e por isso não produz linha de plano.
function slugDoSquad(s) {
  if (!s) return "";
  if (ehPendente(s.nome) || vazio(s.nome)) return "";
  if (!rotuloConfirmado(s)) return "";
  return txt(s.slug) ? normalizarSlug(s.slug) : normalizarSlug(s.nome);
}

// Rótulo legível para relatório/matriz — nunca vira dado persistido.
function rotuloDoSquad(s, i) {
  const slug = slugDoSquad(s);
  if (slug) return slug;
  if (txt(s && s.nomeHipotese)) return `[hipótese: ${txt(s.nomeHipotese)}]`;
  if (txt(s && s.rotuloOriginal)) return `[planilha: "${txt(s.rotuloOriginal)}"]`;
  return "[squads[" + i + "]]";
}

/* ─────────────── identidade: NOME HUMANO → email/id real ─────────────── */

// A relação chegou por PRIMEIRO NOME. O plano canônico exige email ou id.
// Esta resolução é ESTRITAMENTE DETERMINÍSTICA e por estágios; qualquer empate
// é MATCH_AMBIGUO e NUNCA é desempatado pela máquina.
//
//   REF_DIRETA ..... o token já é email ou id → nada a resolver
//   NOME_COMPLETO .. igualdade exata de users.nome normalizado
//   PRIMEIRO_NOME .. igualdade exata do 1º token de users.nome
//   EMAIL_LOCAL .... igualdade exata da parte local do email
//
// Não existe distância de edição, substring nem "melhor palpite" em nenhum
// estágio. Sem inventário, tudo é PENDENTE_EMAIL_OU_ID — nunca "encontrado".
function chaveDePessoa(token) {
  const t = txt(token);
  return ehRefDireta(t) ? t.toLowerCase() : "nome:" + normalizarNome(t);
}

function resolverIdentidade(token, inventario) {
  const t = txt(token);
  const base = { token: t, estrategia: null, candidatos: [] };
  if (!t) return { ...base, tipo: "vazio", status: "VAZIO", ref: null };
  if (ehAusenteNaEstrutura(t)) return { ...base, tipo: "marcador", status: "AUSENTE_NA_ESTRUTURA", ref: null };
  if (ehPendente(t)) return { ...base, tipo: "marcador", status: "PENDENTE_NA_PLANILHA", ref: null };
  if (ehRefDireta(t)) return { ...base, tipo: "ref", status: "MATCH_EXATO", estrategia: "REF_DIRETA", ref: t };
  if (!inventario) return { ...base, tipo: "nome", status: "PENDENTE_EMAIL_OU_ID", ref: null };

  const alvo = normalizarNome(t);
  const usuarios = Array.isArray(inventario.usuarios) ? inventario.usuarios : [];
  const estagios = [
    ["NOME_COMPLETO", (u) => normalizarNome(u.nome) === alvo],
    ["PRIMEIRO_NOME", (u) => normalizarNome(u.nome).split(" ")[0] === alvo],
    ["EMAIL_LOCAL", (u) => normalizarNome(String(u.email || "").split("@")[0]) === alvo],
  ];
  for (const [estrategia, casa] of estagios) {
    const achados = usuarios.filter(casa);
    if (!achados.length) continue;
    const candidatos = achados.map((u) => ({
      id: u.id, nome: u.nome, email: u.email, role: u.role, ativo: u.ativo !== false,
    }));
    if (candidatos.length > 1) {
      return { ...base, tipo: "nome", status: "MATCH_AMBIGUO", estrategia, candidatos, ref: null };
    }
    const u = candidatos[0];
    return { ...base, tipo: "nome", status: "MATCH_EXATO", estrategia, candidatos, ref: u.email || String(u.id) };
  }
  return { ...base, tipo: "nome", status: "NAO_ENCONTRADO", ref: null };
}

/* ───────── matriz PESSOA × SQUAD e decisão de Squad principal ───────── */

// BLOCOS 5 e 12. Produz, para cada pessoa: em que Squads está, com que função em
// cada um, qual é o principal e qual o status dessa decisão.
//
// REGRA CENTRAL: a ORDEM DA PLANILHA NÃO DEFINE O PRINCIPAL. Com 1 Squad o
// principal é determinístico; com 2+ ele é PENDENTE até declaração humana
// explícita (PRINCIPAL: dentro do Squad escolhido).
function analisarMemberships(relacao, inventario) {
  const resolucoes = new Map();
  const pessoas = new Map();

  const registrar = (token) => {
    const chave = chaveDePessoa(token);
    if (!resolucoes.has(chave)) resolucoes.set(chave, resolverIdentidade(token, inventario));
    if (!pessoas.has(chave)) {
      pessoas.set(chave, {
        token: txt(token), chave, resolucao: resolucoes.get(chave),
        participacoes: [], declaradaPrincipalEm: [],
      });
    }
    return pessoas.get(chave);
  };

  for (const [i, s] of (relacao.squads || []).entries()) {
    const slug = slugDoSquad(s);
    const rotulo = rotuloDoSquad(s, i);
    for (const p of pessoasDoSquad(s)) {
      if (p.estado !== "PRESENTE") continue;
      registrar(p.token).participacoes.push({ ...p, squadIdx: i, slug, rotulo, noPlano: !!slug });
    }
    for (const nome of (Array.isArray(s.principal) ? s.principal : [])) {
      if (vazio(nome) || ehPendente(nome) || ehAusenteNaEstrutura(nome)) continue;
      registrar(nome).declaradaPrincipalEm.push({ squadIdx: i, slug, rotulo });
    }
  }

  for (const pes of pessoas.values()) {
    const n = pes.participacoes.length;
    const decl = pes.declaradaPrincipalEm;
    pes.multiSquad = n > 1;
    // Ordem importa: quem so aparece em PRINCIPAL:, sem funcao em Squad algum,
    // recebe o diagnostico preciso (nome errado/inexistente na relacao) em vez
    // do generico "fora do Squad".
    if (n === 0) {
      pes.statusPrincipal = "SEM_MEMBERSHIP";
      pes.squadPrincipal = null;
    } else if (decl.length > 1) {
      pes.statusPrincipal = "ERRO_PRINCIPAL_EM_VARIOS_SQUADS";
      pes.squadPrincipal = null;
    } else if (decl.length === 1) {
      const eMembro = pes.participacoes.some((x) => x.squadIdx === decl[0].squadIdx);
      pes.statusPrincipal = eMembro ? "CONFIRMADO_HUMANO" : "ERRO_PRINCIPAL_FORA_DO_SQUAD";
      pes.squadPrincipal = eMembro ? decl[0] : null;
    } else if (n === 1) {
      pes.statusPrincipal = "DETERMINISTICO";
      pes.squadPrincipal = pes.participacoes[0];
    } else {
      pes.statusPrincipal = "PENDENTE_SQUAD_PRINCIPAL";
      pes.squadPrincipal = null;
    }
  }

  return { pessoas, resolucoes };
}

// Ordem estável para relatórios/documentos: pela 1ª aparição na relação.
function pessoasOrdenadas(analise) {
  return [...analise.pessoas.values()].sort((a, b) => {
    const ia = a.participacoes.length ? a.participacoes[0].squadIdx : 99;
    const ib = b.participacoes.length ? b.participacoes[0].squadIdx : 99;
    return ia - ib || a.token.localeCompare(b.token, "pt-BR");
  });
}

/* ──────────────────── conversão para o formato canônico ──────────────────── */

// Produz exatamente o shape aceito por squadsMigracaoImportService.
//
// O Gestor do Squad NÃO vira funcao "coordenador" — Coordenador e Gestor são
// pessoas distintas na operação real, e essa era a incompatibilidade semântica
// do tooling V1. Só o Coordenador recebe funcao=coordenador.
//
// responsaveis sai VAZIO POR DECISÃO: responsabilidade é POR CLIENTE, e
// Cliente→Squad ainda não chegou. Assumir que todo membro do Squad responde por
// todo Cliente do Squad seria inventar carteira (BLOCO 8).
function construirPlanoCanonico(relacao, { descricao, inventario = null, analise = null } = {}) {
  const plano = {
    versao: 1,
    descricao: descricao || "P2.9 — migração inicial de Squads (memberships; carteira pendente)",
    squads: [],
    membros: [],
    clientes: [],
    responsaveis: [],
  };

  const info = analise || analisarMemberships(relacao, inventario);

  for (const [i, s] of relacao.squads.entries()) {
    // Squad ainda sem nome oficial CONFIRMADO não vira linha de plano — ele é
    // uma pendência, não um registro. Sem isso, os 6 marcadores
    // PENDENTE_NOME_OFICIAL colidiriam em slug, o gabarito em branco reportaria
    // "erro" onde só existe "aguardando", e a hipótese "Squad 6" do 6º bloco
    // seria persistida como se fosse dado.
    const slug = slugDoSquad(s);
    if (!slug) continue;

    plano.squads.push({ slug, nome: txt(s.nome), ativo: true });

    for (const p of pessoasDoSquad(s)) {
      if (p.estado !== "PRESENTE") continue;
      const pes = info.pessoas.get(chaveDePessoa(p.token));
      // Nome não resolvido entra CRU de propósito: o plano fica visivelmente
      // inutilizável e invariantesDoPlano o barra. Silenciar aqui esconderia a
      // pendência exatamente onde ela importa.
      const membro = {
        squad: slug,
        usuario: (pes && pes.resolucao && pes.resolucao.ref) || p.token,
        funcao: p.funcaoMembership,
      };
      // principal só é escrito quando a decisão EXISTE. Omitir é deliberado: o
      // importador auto-promove a 1ª membership, e é justamente essa escolha
      // silenciosa que não pode acontecer sem confirmação humana.
      if (pes && (pes.statusPrincipal === "DETERMINISTICO" || pes.statusPrincipal === "CONFIRMADO_HUMANO")) {
        membro.principal = !!pes.squadPrincipal && pes.squadPrincipal.squadIdx === i;
      }
      plano.membros.push(membro);
    }

    for (const c of (Array.isArray(s.clientes) ? s.clientes : [])) {
      // Marcador não é cliente.
      if (vazio(c) || ehPendente(c) || ehAusenteNaEstrutura(c)) continue;
      plano.clientes.push({ cliente: txt(c), squad: slug, motivo: "migração inicial P2.9" });
    }
  }

  return plano;
}

/* ─────────── invariantes do plano (cinto de segurança do APPLY) ─────────── */

// Última barreira antes de qualquer emissão. Independe do parser e das regras
// estruturais: olha só o plano pronto e responde "isto pode virar banco?".
function invariantesDoPlano(plano) {
  const v = [];
  const add = (classe, codigo, contexto, msg) => v.push({ classe, codigo, contexto, msg });

  for (const [i, m] of (plano.membros || []).entries()) {
    if (!ehRefDireta(m.usuario)) {
      add(PENDENTE, "USUARIO_SEM_REFERENCIA_RESOLVIVEL", `membros[${i}]`,
        `"${m.usuario}" é nome humano, não email nem id — o plano canônico exige ` +
        "email ou id, e o tooling não garante unicidade de nome.");
    }
    if (m.principal === undefined) {
      add(PENDENTE, "MEMBERSHIP_SEM_PRINCIPAL_DECIDIDO", `membros[${i}]`,
        `"${m.usuario}" em "${m.squad}" sem principal decidido — o importador ` +
        "auto-promoveria a 1ª membership, e essa escolha é humana.");
    }
  }

  const principaisPorUsuario = new Map();
  for (const m of plano.membros || []) {
    if (m.principal !== true) continue;
    const k = String(m.usuario).toLowerCase();
    principaisPorUsuario.set(k, (principaisPorUsuario.get(k) || 0) + 1);
  }
  for (const [u, qtd] of principaisPorUsuario) {
    if (qtd > 1) {
      add(ERRO, "PRINCIPAL_EM_VARIOS_SQUADS", "membros",
        `"${u}" marcado como principal em ${qtd} Squads no plano.`);
    }
  }

  // Responsabilidade é POR CLIENTE. Sem carteira no plano, não pode existir
  // responsável — seria inventar quem responde por quem.
  if ((plano.responsaveis || []).length && !(plano.clientes || []).length) {
    add(ERRO, "RESPONSAVEIS_SEM_CARTEIRA", "responsaveis",
      `${plano.responsaveis.length} responsável(is) sem nenhum vínculo Cliente→Squad no plano. ` +
      "Responsabilidade é POR CLIENTE — sem carteira, seria inventar quem responde por quem.");
  }

  return v;
}

/* ─────────────── regras estruturais que o tooling P2.3 não tem ─────────────── */

const ERRO = "ERRO_ESTRUTURAL";
const PENDENTE = "PENDENTE_ESPERADO";
const AVISO = "AVISO";
// INFO existe porque "ausência" e "erro" não são a mesma coisa: Squad 5 não tem
// Auxiliar 2, e isso é a ESTRUTURA REAL, não um dado faltando. INFO nunca afeta
// veredito nem com --estrito (BLOCO 4).
const INFO = "INFO";

function novoColetor() {
  const achados = [];
  return {
    achados,
    add: (classe, codigo, contexto, msg) => achados.push({ classe, codigo, contexto, msg }),
  };
}

function regrasEstruturais(relacao, inventario, analiseExterna) {
  const col = novoColetor();
  const squads = relacao.squads;
  const analise = analiseExterna || analisarMemberships(relacao, inventario);

  // Um bloco no formato V2 (Coordenador/Auxiliar/Design). O formato V1 (só
  // GESTOR/MEMBROS) continua válido, mas não gera cobranças de cargo que ele
  // nunca teve como declarar.
  const ehV2 = (s) =>
    !vazio(s.coordenador) || (s.auxiliares || []).length ||
    !vazio(s.auxiliar2) || !vazio(s.design);

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
  const algumSquadTemCliente = squads.some((s) =>
    (Array.isArray(s.clientes) ? s.clientes : [])
      .some((c) => !ehPendente(c) && !ehAusenteNaEstrutura(c) && !vazio(c)));

  // ── rótulo duplicado NA PLANILHA (é assim que o 6º bloco se revela) ──
  // Na planilha recebida o 6º bloco também está escrito "squad 5". Isso é
  // PENDÊNCIA DE RÓTULO, não erro de estrutura: os membros são distintos.
  const porRotuloOriginal = new Map();
  for (const [i, s] of squads.entries()) {
    const r = normalizarNome(s.rotuloOriginal);
    if (!r) continue;
    if (!porRotuloOriginal.has(r)) porRotuloOriginal.set(r, []);
    porRotuloOriginal.get(r).push(i);
  }
  for (const [rot, idxs] of porRotuloOriginal) {
    if (idxs.length < 2) continue;
    col.add(PENDENTE, "SQUAD_ROTULO_DUPLICADO_NA_PLANILHA", "squads",
      idxs.length + ' blocos distintos vêm rotulados "' + rot + '" na planilha ' +
      "(squads[" + idxs.join("], squads[") + "]) — os membros são diferentes, " +
      "então é um Squad a mais com rótulo errado, não uma duplicata. " +
      "Confirmar o rótulo verdadeiro antes de emitir plano.");
  }

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

    // ── rótulo não confirmado: a hipótese fica documentada, nunca persistida ──
    if (!rotuloConfirmado(s)) {
      col.add(PENDENTE, "SQUAD_ROTULO_NAO_CONFIRMADO", ctx,
        `rótulo do Squad não confirmado (status "${txt(s.rotuloStatus)}")` +
        (txt(s.nomeHipotese) ? `; hipótese registrada: "${txt(s.nomeHipotese)}"` : "") +
        (txt(s.rotuloOriginal) ? `; planilha diz "${txt(s.rotuloOriginal)}"` : "") +
        ". Enquanto pendente, o Squad NÃO entra no plano — suposição não vira dado.");
    }
    if (txt(s.nomeHipotese) && !ehPendente(s.nome) && !vazio(s.nome)) {
      col.add(AVISO, "SQUAD_HIPOTESE_COM_NOME_CONFIRMADO", ctx,
        `há NOME_HIPOTESE "${txt(s.nomeHipotese)}" mas o nome já está confirmado como ` +
        `"${txt(s.nome)}" — remova a hipótese para não confundir a operação.`);
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

    // ── exatamente 1 Coordenador por Squad (BLOCO 6) ──
    // Coordenador e Gestor são PESSOAS E FUNÇÕES DISTINTAS. A mesma pessoa
    // coordenando vários Squads é válida e NÃO é erro.
    if (Array.isArray(s.coordenador)) {
      col.add(ERRO, "SQUAD_MULTIPLOS_COORDENADORES", ctx,
        "um Squad tem exatamente 1 Coordenador.");
    } else if (vazio(s.coordenador)) {
      col.add(PENDENTE, "SQUAD_SEM_COORDENADOR", ctx, "Coordenador ainda não informado.");
    } else if (ehPendente(s.coordenador)) {
      col.add(PENDENTE, "SQUAD_SEM_COORDENADOR", ctx,
        `Coordenador ainda é o marcador "${s.coordenador}".`);
    }

    // ── L4: exatamente 1 Gestor por Squad (BLOCO 7) ──
    if (Array.isArray(s.gestor)) {
      col.add(ERRO, "SQUAD_MULTIPLOS_GESTORES", ctx, "um Squad tem exatamente 1 Gestor operacional.");
    } else if (vazio(s.gestor)) {
      col.add(PENDENTE, "SQUAD_SEM_GESTOR", ctx, "Gestor ainda não informado.");
    } else if (ehPendente(s.gestor)) {
      col.add(PENDENTE, "SQUAD_SEM_GESTOR", ctx, `Gestor ainda é o marcador "${s.gestor}".`);
    }

    // Coordenador e Gestor não podem ser a MESMA pessoa no MESMO Squad: seriam
    // duas memberships do mesmo usuário no mesmo Squad, com funcao conflitante.
    if (!vazio(s.coordenador) && !vazio(s.gestor) &&
        !ehPendente(s.coordenador) && !ehPendente(s.gestor) &&
        chaveDePessoa(s.coordenador) === chaveDePessoa(s.gestor)) {
      col.add(ERRO, "COORDENADOR_IGUAL_AO_GESTOR", ctx,
        `"${txt(s.coordenador)}" aparece como Coordenador E Gestor do mesmo Squad — ` +
        "são funções distintas na operação e geram membership conflitante.");
    }

    // Cinto contra regressão do pressuposto V1: se alguém voltar a mapear
    // Gestor para funcao=coordenador, isso falha aqui e não no banco.
    if (entradaPessoa(s.gestor, "gestor").funcaoMembership === "coordenador") {
      col.add(ERRO, "GESTOR_MAPEADO_COMO_COORDENADOR", ctx,
        "o Gestor foi mapeado para funcao=coordenador — regressão do pressuposto " +
        "V1. Gestor é membership funcao=membro; a função organizacional dele vira " +
        "cliente_responsaveis.papel=gestor quando Cliente→Squad chegar.");
    }

    // ── Auxiliar 2: ausência declarada NÃO é pendência (BLOCO 4) ──
    if (ehAusenteNaEstrutura(s.auxiliar2)) {
      col.add(INFO, "AUXILIAR_2_AUSENTE_NA_ESTRUTURA", ctx,
        "este Squad não tem Auxiliar 2 — ausência na estrutura, não dado faltando.");
    } else if (ehPendente(s.auxiliar2)) {
      col.add(PENDENTE, "AUXILIAR_2_PENDENTE_CONFIRMACAO", ctx,
        `Auxiliar 2 ainda é o marcador "${txt(s.auxiliar2)}".`);
    } else if (vazio(s.auxiliar2) && ehV2(s)) {
      col.add(INFO, "AUXILIAR_2_AUSENTE_NA_ESTRUTURA", ctx,
        "Auxiliar 2 não informado — classificado como ausente na estrutura até " +
        "indicação contrária.");
    }

    // ── Design: campo em branco aqui NÃO é o mesmo que ausente ──
    // No 6º bloco o Design não apareceu no recorte: não sabemos se o Squad não
    // tem Design ou se a informação ficou fora da captura → PENDÊNCIA.
    if (ehAusenteNaEstrutura(s.design)) {
      col.add(INFO, "DESIGN_AUSENTE_NA_ESTRUTURA", ctx, "este Squad não tem Design.");
    } else if (ehPendente(s.design)) {
      col.add(PENDENTE, "DESIGN_PENDENTE_CONFIRMACAO", ctx,
        `Design ainda é o marcador "${txt(s.design)}" — não sabemos se o Squad não ` +
        "tem Design ou se a informação ficou fora do recorte recebido.");
    } else if (vazio(s.design) && ehV2(s)) {
      col.add(PENDENTE, "DESIGN_PENDENTE_CONFIRMACAO", ctx,
        "Design em branco — confirmar se o Squad não tem Design (então marque " +
        "AUSENTE_NA_ESTRUTURA) ou se a informação falta.");
    }

    // ── clientes ──
    const clientesDoSquad = Array.isArray(s.clientes) ? s.clientes : [];
    if (!clientesDoSquad.length) {
      col.add(
        algumSquadTemCliente ? AVISO : PENDENTE,
        "SQUAD_SEM_CLIENTES",
        ctx,
        algumSquadTemCliente
          ? "Squad sem nenhum Cliente na carteira — confirme se é intencional."
          : "nenhum Cliente atribuído — aguardando relação Cliente→Squad."
      );
    }
    for (const c of clientesDoSquad) {
      if (vazio(c)) continue;
      if (ehPendente(c) || ehAusenteNaEstrutura(c)) {
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

    // ── memberships do Squad, já com a função operacional correta ──
    const vistosNoSquad = new Set();
    let presentes = 0;
    for (const pe of pessoasDoSquad(s)) {
      if (pe.estado === "AUSENTE_NA_ESTRUTURA" || pe.estado === "VAZIO") continue;
      if (pe.estado === "PENDENTE") {
        // Coordenador/Gestor/Design pendentes já têm código próprio acima.
        if (pe.papelOperacional === "membro" || pe.papelOperacional === "auxiliar") {
          col.add(PENDENTE, "MEMBRO_PENDENTE", ctx,
            `${pe.rotuloFuncao} ainda é o marcador "${pe.token}".`);
        }
        continue;
      }
      presentes += 1;
      const chave = chaveDePessoa(pe.token);
      if (vistosNoSquad.has(chave)) {
        col.add(ERRO, "MEMBERSHIP_DUPLICADA", ctx,
          `"${pe.token}" repetido no mesmo Squad (aparece de novo como ${pe.rotuloFuncao}).`);
        continue;
      }
      vistosNoSquad.add(chave);
      if (!membroParaSquads.has(chave)) membroParaSquads.set(chave, []);
      membroParaSquads.get(chave).push(slugEfetivo || rotuloDoSquad(s, i));
    }

    if (presentes === 1) {
      col.add(AVISO, "SQUAD_COM_UMA_PESSOA_SO", ctx, "Squad com uma única pessoa declarada.");
    }
  }

  // ── BLOCO 5: usuário em vários Squads é PERMITIDO; principal é decisão humana ──
  // A ORDEM DA PLANILHA NÃO DEFINE SQUAD PRINCIPAL. Com 1 Squad é
  // determinístico; com 2+ o pré-validador se RECUSA a escolher o primeiro.
  for (const pes of pessoasOrdenadas(analise)) {
    const onde = pes.participacoes.map((x) => `${x.rotulo} (${x.rotuloFuncao})`).join(" · ");

    if (pes.multiSquad) {
      col.add(AVISO, "USUARIO_EM_VARIOS_SQUADS", "membros",
        `"${pes.token}" participa de ${pes.participacoes.length} Squads: ${onde} — ` +
        "permitido pelo produto; o principal NÃO é escolhido pela máquina.");
    }

    switch (pes.statusPrincipal) {
      case "PENDENTE_SQUAD_PRINCIPAL":
        col.add(PENDENTE, "PENDENTE_SQUAD_PRINCIPAL", "membros",
          `"${pes.token}" está em ${pes.participacoes.length} Squads e nenhum foi ` +
          "declarado principal. Liste o nome em PRINCIPAL: dentro do Squad escolhido. " +
          "Sem isso o importador auto-promoveria a 1ª membership — escolha silenciosa " +
          "que esta fase proíbe.");
        break;
      case "ERRO_PRINCIPAL_EM_VARIOS_SQUADS":
        col.add(ERRO, "PRINCIPAL_EM_VARIOS_SQUADS", "membros",
          `"${pes.token}" foi declarado principal em ${pes.declaradaPrincipalEm.length} Squads ` +
          `(${pes.declaradaPrincipalEm.map((d) => d.rotulo).join(", ")}). O produto exige exatamente 1.`);
        break;
      case "ERRO_PRINCIPAL_FORA_DO_SQUAD":
        col.add(ERRO, "PRINCIPAL_FORA_DO_SQUAD", "membros",
          `"${pes.token}" foi declarado principal em "${pes.declaradaPrincipalEm[0].rotulo}" ` +
          "mas não é membro desse Squad.");
        break;
      case "SEM_MEMBERSHIP":
        col.add(ERRO, "PRINCIPAL_SEM_MEMBERSHIP", "membros",
          `"${pes.token}" aparece só em PRINCIPAL:, sem nenhuma função em Squad algum.`);
        break;
      default:
        if (!pes.multiSquad && pes.declaradaPrincipalEm.length === 1) {
          col.add(INFO, "PRINCIPAL_REDUNDANTE", "membros",
            `"${pes.token}" está em 1 Squad só — a declaração PRINCIPAL: é redundante ` +
            "(inofensiva).");
        }
        break;
    }

    // ── identidade: NOME HUMANO → email/id (nunca fuzzy, nunca palpite) ──
    const res = pes.resolucao || {};
    if (res.status === "PENDENTE_EMAIL_OU_ID") {
      col.add(PENDENTE, "USUARIO_SEM_EMAIL_OU_ID", "identidades",
        `"${pes.token}" chegou como NOME HUMANO e não há inventário para resolver ` +
        "para email/id. O plano canônico exige email ou id — nome puro não pode ir " +
        "ao plano final porque o tooling não garante unicidade de nome.");
    } else if (res.status === "MATCH_AMBIGUO") {
      col.add(ERRO, "USUARIO_NOME_AMBIGUO", "identidades",
        `"${pes.token}" casa com ${res.candidatos.length} usuários por ${res.estrategia} ` +
        `(${res.candidatos.map((c) => c.email || c.id).join(", ")}). Resolução humana ` +
        "obrigatória — a máquina não desempata dado de rollout.");
    } else if (res.status === "NAO_ENCONTRADO") {
      col.add(ERRO, "USUARIO_NOME_NAO_ENCONTRADO", "identidades",
        `"${pes.token}" não casa com nenhum usuário do inventário por nome completo, ` +
        "primeiro nome ou parte local do email. Nenhum fuzzy-match foi tentado.");
    } else if (res.status === "MATCH_EXATO" && res.estrategia === "PRIMEIRO_NOME") {
      col.add(AVISO, "USUARIO_RESOLVIDO_POR_PRIMEIRO_NOME", "identidades",
        `"${pes.token}" → ${res.ref} resolvido por igualdade exata do PRIMEIRO NOME ` +
        `("${res.candidatos[0].nome}"), único candidato. Confirme antes do apply.`);
    }
  }

  // ── BLOCO 6: mesmo Coordenador em vários Squads é VÁLIDO ──
  const coordenaSquads = new Map();
  for (const [i, s] of squads.entries()) {
    if (vazio(s.coordenador) || ehPendente(s.coordenador)) continue;
    const k = chaveDePessoa(s.coordenador);
    if (!coordenaSquads.has(k)) coordenaSquads.set(k, { nome: txt(s.coordenador), squads: [] });
    coordenaSquads.get(k).squads.push(rotuloDoSquad(s, i));
  }
  for (const info of coordenaSquads.values()) {
    if (info.squads.length > 1) {
      col.add(INFO, "COORDENADOR_EM_VARIOS_SQUADS", "coordenadores",
        `"${info.nome}" coordena ${info.squads.length} Squads (${info.squads.join(", ")}) — ` +
        "válido: a mesma pessoa pode coordenar múltiplos Squads.");
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
    // Só referências DIRETAS (email/id) são checadas por existência aqui; nome
    // humano passa pela resolução determinística, que tem códigos próprios
    // (USUARIO_NOME_AMBIGUO / USUARIO_NOME_NAO_ENCONTRADO). Cobrar existência de
    // um nome cru aqui duplicaria o achado com a mensagem errada.
    for (const pes of analise.pessoas.values()) {
      const res = pes.resolucao || {};
      if (res.estrategia !== "REF_DIRETA") continue;
      if (!usuariosRef.has(String(res.ref).toLowerCase())) {
        col.add(ERRO, "USUARIO_INEXISTENTE", "membros",
          `usuário "${res.ref}" não existe no inventário.`);
      }
    }
    // Refs efetivamente alocadas — email/id resolvido, não nome cru. Sem isto o
    // check de completude abaixo acusaria "sem membership" todo mundo que está
    // na relação só por nome.
    const refsAlocadas = new Set();
    for (const pes of analise.pessoas.values()) {
      if (!pes.participacoes.length) continue;
      const ref = pes.resolucao && pes.resolucao.ref;
      if (ref) refsAlocadas.add(String(ref).toLowerCase());
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
      const porEmail = u.email && refsAlocadas.has(String(u.email).toLowerCase());
      const porId = u.id != null && refsAlocadas.has(String(u.id).toLowerCase());
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
  L.push("#  COMO USAR: mova cada linha do CATÁLOGO (no fim do arquivo) para o campo");
  L.push("#  de cargo ou para a lista CLIENTES: do Squad correto, removendo o '#'.");
  L.push("#  Todo Cliente ativo precisa acabar em exatamente 1 Squad.");
  L.push("#");
  L.push("#  ESTRUTURA REAL: Coordenador → Gestor → Auxiliar → Auxiliar 2 → Design.");
  L.push("#  Coordenador e Gestor são PESSOAS DISTINTAS. Só o Coordenador vira");
  L.push("#  squad_members.funcao='coordenador'; os demais entram como 'membro'.");
  L.push("#");
  L.push("#  Cargo que NÃO EXISTE no Squad: escreva AUSENTE_NA_ESTRUTURA (não é");
  L.push("#  pendência). Cargo que existe mas você não sabe: deixe PENDENTE_*.");
  L.push("#");
  L.push("#  MULTI-SQUAD: a ordem deste arquivo NÃO define o Squad principal. Quem");
  L.push("#  estiver em 2+ Squads precisa ser listado em PRINCIPAL: do Squad que for");
  L.push("#  o principal dela — senão o plano fica bloqueado de propósito.");
  L.push("# ═══════════════════════════════════════════════════════════════════");
  L.push("");

  for (let i = 1; i <= TOTAL_SQUADS_ESPERADO; i++) {
    L.push(`# ── Squad ${i} de ${TOTAL_SQUADS_ESPERADO} ──`);
    L.push("SQUAD: PENDENTE_NOME_OFICIAL");
    L.push("COORDENADOR: PENDENTE_DADO_HUMANO");
    L.push("GESTOR: PENDENTE_DADO_HUMANO");
    L.push("AUXILIAR: PENDENTE_DADO_HUMANO");
    L.push("AUXILIAR_2: PENDENTE_DADO_HUMANO");
    L.push("DESIGN: PENDENTE_DADO_HUMANO");
    L.push("PRINCIPAL:");
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
  linha(`Squads:      ${r.totais.squads}/${TOTAL_SQUADS_ESPERADO} (${r.totais.squadsNoPlano} com rótulo confirmado)`);
  linha(`Clientes:    ${r.totais.clientes}`);
  linha(`Memberships: ${r.totais.membros}`);
  linha(`Pessoas:     ${r.totais.pessoasUnicas} única(s) · ${r.totais.pessoasMultiSquad} multi-Squad`);
  linha(`Principal:   ${r.totais.principalPendente} pendente(s) de decisão humana`);
  linha(`Identidade:  ${r.totais.semReferencia} sem email/id resolvido`);
  linha("");
  linha(`VEREDITO: ${r.veredito}`);

  const grupos = [
    [ERRO, "✗", r.achados.filter((a) => a.classe === ERRO)],
    [AVISO, "⚠", r.achados.filter((a) => a.classe === AVISO)],
    [PENDENTE, "…", r.achados.filter((a) => a.classe === PENDENTE)],
    [INFO, "·", r.achados.filter((a) => a.classe === INFO)],
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

// BLOCO 12 — matriz PESSOA × SQUAD, em Markdown, para colar no handoff.
function matrizMembershipsMarkdown(r) {
  const L = [];
  L.push("| PESSOA | SQUAD | FUNÇÃO OPERACIONAL | MEMBERSHIP funcao | EMAIL/ID | PRINCIPAL | STATUS |");
  L.push("|---|---|---|---|---|---|---|");
  for (const m of r.memberships) {
    const squads = m.squads.length ? m.squads.join("<br>") : "—";
    const funcoes = m.funcoes.length ? m.funcoes.join("<br>") : "—";
    const fmem = m.funcaoMembership.length ? m.funcaoMembership.join("<br>") : "—";
    const principal = m.squadPrincipal || "**" + m.statusPrincipal + "**";
    L.push(`| ${m.pessoa} | ${squads} | ${funcoes} | \`${fmem}\` | ${m.referencia} | ${principal} | ${m.statusResolucao} |`);
  }
  return L.join("\n");
}

/* ───────────────────────────── CLI ───────────────────────────── */

function parseArgs(argv) {
  const a = { relacao: null, inventario: null, emitirPlano: null, esqueleto: false,
    saida: null, json: false, estrito: false, memberships: false, help: false };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--relacao" || t === "-r") a.relacao = argv[++i];
    else if (t === "--inventario" || t === "-i") a.inventario = argv[++i];
    else if (t === "--emitir-plano" || t === "-o") a.emitirPlano = argv[++i];
    else if (t === "--esqueleto") a.esqueleto = true;
    else if (t === "--saida") a.saida = argv[++i];
    else if (t === "--json") a.json = true;
    else if (t === "--estrito") a.estrito = true;
    else if (t === "--memberships") a.memberships = true;
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
  // Uma única análise alimenta regras, plano e relatório — a decisão de Squad
  // principal precisa ser a MESMA nos três, senão o plano diverge do veredito.
  const analise = analisarMemberships(relacao, inventario);
  const achados = regrasEstruturais(relacao, inventario, analise);
  const plano = construirPlanoCanonico(relacao, { inventario, analise });

  // Cinto de segurança final: o plano pronto é reavaliado por si só.
  for (const inv of invariantesDoPlano(plano)) achados.push(inv);

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
  // INFO nunca conta para veredito: ausência declarada não é pendência.

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

  const pessoas = pessoasOrdenadas(analise);
  return {
    veredito,
    motivo,
    achados,
    plano,
    analise,
    memberships: pessoas.map((pes) => ({
      pessoa: pes.token,
      squads: pes.participacoes.map((x) => x.rotulo),
      funcoes: pes.participacoes.map((x) => x.rotuloFuncao),
      funcaoMembership: pes.participacoes.map((x) => x.funcaoMembership),
      papelResponsavelFuturo: pes.participacoes.map((x) => x.papelResponsavel),
      referencia: (pes.resolucao && pes.resolucao.ref) || "PENDENTE_EMAIL_OU_ID",
      statusResolucao: (pes.resolucao && pes.resolucao.status) || "DESCONHECIDO",
      estrategiaResolucao: (pes.resolucao && pes.resolucao.estrategia) || null,
      squadPrincipal: (pes.squadPrincipal && pes.squadPrincipal.rotulo) || null,
      statusPrincipal: pes.statusPrincipal,
      multiSquad: pes.multiSquad,
    })),
    totais: {
      squads: relacao.squads.length,
      squadsNoPlano: plano.squads.length,
      clientes: plano.clientes.length,
      membros: plano.membros.length,
      pessoasUnicas: pessoas.length,
      pessoasMultiSquad: pessoas.filter((x) => x.multiSquad).length,
      principalPendente: pessoas.filter((x) => x.statusPrincipal === "PENDENTE_SQUAD_PRINCIPAL").length,
      semReferencia: pessoas.filter((x) => !(x.resolucao && x.resolucao.ref)).length,
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

  if (args.json) {
    // `analise` carrega Maps (não serializam) e é redundante com `memberships`.
    const { analise, ...serializavel } = r;
    linha(JSON.stringify(serializavel, null, 2));
  } else {
    imprimirRelatorio(r);
    if (args.memberships) {
      linha("MATRIZ DE MEMBERSHIPS (BLOCO 12):");
      linha("");
      linha(matrizMembershipsMarkdown(r));
      linha("");
    }
  }

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
  invariantesDoPlano,
  criarDbFalso,
  gerarEsqueleto,
  executar,
  // estrutura real: Coordenador → Gestor → Auxiliar → Auxiliar 2 → Design
  FUNCOES_OPERACIONAIS,
  entradaPessoa,
  pessoasDoSquad,
  slugDoSquad,
  rotuloDoSquad,
  // identidade e Squad principal
  chaveDePessoa,
  rotuloConfirmado,
  normalizarNome,
  ehRefDireta,
  ehAusenteNaEstrutura,
  resolverIdentidade,
  analisarMemberships,
  pessoasOrdenadas,
  matrizMembershipsMarkdown,
  TOTAL_SQUADS_ESPERADO,
  ERRO, PENDENTE, AVISO, INFO,
};

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
