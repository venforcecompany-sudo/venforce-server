#!/usr/bin/env node
// server/sql/squads-mapeamento-real.js
// VenForce V3 — P2.9 Real Mapping. Resolve a relação operacional contra o banco
// REAL e produz: clusters legados, mapa Cliente→Squad, plano de consolidação e
// o plano canônico do squads-migrate.js.
//
// 100% OFFLINE. Não abre conexão, não lê .env, não escreve no banco. Consome
// apenas os JSON produzidos pelas duas ferramentas read-only:
//
//   node server/sql/squads-inventario-readonly.js     --saida inventario.json
//   node server/sql/squads-consolidacao-auditoria.js  --saida auditoria.json
//   node server/sql/squads-mapeamento-real.js \
//     --inventario inventario.json --auditoria auditoria.json \
//     --relacao relacao-squads-v2.json --saida-dir <dir>
//
// ─────────────────────── PRINCÍPIOS DE SEGURANÇA ───────────────────────
//
// P1. SQUAD 8 É O DEFAULT SEGURO. Squad 8 · Legado é quarentena, não descarte.
//     Colocar um cliente nele por engano é reversível (basta movê-lo depois);
//     colocá-lo no Squad operacional ERRADO é acesso indevido em produção.
//     Logo: toda incerteza cai para o Squad 8, nunca para um Squad 1–6.
//
// P2. SUFIXO NÃO É EVIDÊNCIA. "Empresa X 2" só forma cluster com "Empresa X"
//     se o radical resultante casar com OUTRO cliente real — a regra se
//     autovalida. É o que impede "ER2"→"ER", "Shopping 86"→"Shopping" e
//     "Fenix Equipamentos1"→"Fenix Equipamentos" de virarem falsos clusters.
//
// P3. CHAVE NATURAL É A ÚNICA PROVA FORTE. Mesmo ml_user_id / mesmo
//     external_account_id sob dois clientes distintos prova que a MESMA conta
//     de marketplace foi cadastrada duas vezes. Nome não prova nada.
//
// P4. NENHUM CLIENTE É CRIADO. Nome da relação sem cliente real vira
//     RELACAO_SEM_CLIENTE_CRIADO e fica fora do plano.
//
// P5. CONSOLIDAÇÃO É PLAN_ONLY. Este módulo nunca emite operação de escrita
//     sobre clientes/contas/grants — só descreve o que teria de acontecer.

const fs = require("fs");
const path = require("path");

/* ══════════════════════ 1. NORMALIZAÇÃO ══════════════════════ */

/** minúsculas · sem acento · sem pontuação · espaços colapsados. */
function normalizar(s) {
  return String(s ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function tokens(s) { return normalizar(s).split(" ").filter(Boolean); }

/**
 * Forma COMPACTA: sem espaço nenhum. Existe porque a relação humana e o banco
 * discordam sistematicamente na pontuação — "J&W Presentes" vs "jw presentes",
 * "AVENDA" vs "a_venda", "Giromax" vs "Giro Max". Comparar compacto não é
 * heurística: é a mesma sequência de letras, só sem o separador.
 */
function compacta(s) { return normalizar(s).replace(/ /g, ""); }

/** Conectivos que a operação escreve e o cadastro omite (ou o contrário). */
const CONECTIVOS = new Set(["de", "da", "do", "das", "dos", "e", "em", "no", "na"]);

/** Forma compacta ignorando conectivos — "Toque de Ouro" ≡ "Toque ouro". */
function compactaSemConectivos(s) {
  return tokens(s).filter((t) => !CONECTIVOS.has(t)).join("");
}

/** Tokens de marketplace usados como sufixo de nome no cadastro legado. */
const SUFIXO_MARKETPLACE = new Set(["shopee", "meli", "ml", "tiktok", "mercadolivre", "mercadolivre1"]);

/**
 * Sufixos que a lógica ANTIGA usava para representar "a segunda conta":
 * um inteiro pequeno (1–9, com ou sem zero à esquerda). "86" não entra —
 * Shopping 86 é nome, não sufixo.
 */
const SUFIXO_LEGADO = /^0?[1-9]$/;

/** Radical de um nome, se o último token for sufixo legado. Senão, null. */
function radicalLegado(nome) {
  const t = tokens(nome);
  if (t.length < 2) return null;
  const ultimo = t[t.length - 1];
  if (!SUFIXO_LEGADO.test(ultimo)) return null;
  const radical = t.slice(0, -1).join(" ");
  return radical.length >= 3 ? radical : null; // radical curto demais não decide nada
}

/* ══════════════════════ 2. ÍNDICE DO BANCO ══════════════════════ */

/** Enriquece cada cliente com contagens de referência e formas normalizadas. */
function indexarClientes(inventario, auditoria) {
  const grantsPorCliente = new Map();
  for (const g of inventario.grants || []) {
    if (!grantsPorCliente.has(g.cliente_id)) grantsPorCliente.set(g.cliente_id, []);
    grantsPorCliente.get(g.cliente_id).push(g);
  }
  const contasPorCliente = new Map();
  for (const c of inventario.cliente_contas || []) {
    if (!contasPorCliente.has(c.cliente_id)) contasPorCliente.set(c.cliente_id, []);
    contasPorCliente.get(c.cliente_id).push(c);
  }
  const basesPorCliente = new Map();
  for (const v of inventario.base_vinculos || []) {
    if (!basesPorCliente.has(v.cliente_id)) basesPorCliente.set(v.cliente_id, []);
    basesPorCliente.get(v.cliente_id).push(v);
  }
  // linhas por cliente_id somadas sobre TODAS as tabelas referenciadoras
  const linhasPorCliente = new Map();
  const linhasDetalhe = new Map();
  for (const c of auditoria?.contagens || []) {
    if (c.coluna !== "cliente_id") continue;
    for (const [k, v] of Object.entries(c.porChave || {})) {
      const id = Number(k);
      linhasPorCliente.set(id, (linhasPorCliente.get(id) || 0) + v);
      if (!linhasDetalhe.has(id)) linhasDetalhe.set(id, {});
      linhasDetalhe.get(id)[c.tabela] = v;
    }
  }
  const apiKey = new Map((auditoria?.apiKeys || []).map((r) => [r.id, Boolean(r.tem_api_key)]));

  return (inventario.clientes || []).map((c) => ({
    id: c.id,
    nome: c.nome,
    slug: c.slug,
    ativo: c.ativo,
    nomeNorm: normalizar(c.nome),
    slugNorm: normalizar(c.slug),
    nomeCompacto: compacta(c.nome),
    slugCompacto: compacta(c.slug),
    nomeCompactoSC: compactaSemConectivos(c.nome),
    slugCompactoSC: compactaSemConectivos(c.slug),
    radicalNome: radicalLegado(c.nome),
    radicalSlug: radicalLegado(c.slug),
    contas: contasPorCliente.get(c.id) || [],
    contasAtivas: c.contas_ativas,
    contasTotal: c.contas_total,
    grants: grantsPorCliente.get(c.id) || [],
    bases: basesPorCliente.get(c.id) || [],
    linhasReferenciadas: linhasPorCliente.get(c.id) || 0,
    linhasPorTabela: linhasDetalhe.get(c.id) || {},
    temApiKey: apiKey.get(c.id) === true,
  }));
}

/* ══════════════════════ 3. CLUSTERS LEGADOS ══════════════════════ */

/** Union-find minimalista sobre ids de cliente. */
function novoUniao() {
  const pai = new Map();
  const achar = (x) => {
    if (!pai.has(x)) pai.set(x, x);
    while (pai.get(x) !== x) { pai.set(x, pai.get(pai.get(x))); x = pai.get(x); }
    return x;
  };
  return {
    achar,
    unir: (a, b) => { const ra = achar(a), rb = achar(b); if (ra !== rb) pai.set(ra, rb); },
    grupos: () => {
      const g = new Map();
      for (const x of pai.keys()) {
        const r = achar(x);
        if (!g.has(r)) g.set(r, []);
        g.get(r).push(x);
      }
      return g;
    },
  };
}

const CONF = { CONFIRMADO: "CONFIRMADO", FORTE: "FORTE", AMBIGUO: "AMBIGUO", NAO_MERGEAR: "NAO_MERGEAR" };

/**
 * Uma colisão de ml_user_id em que os dois lados marcam o grant como PRIMÁRIO
 * significa que duas entidades reivindicam a MESMA conta — identidade.
 * Se um lado é secundário e os nomes não têm parentesco algum, o mais provável
 * é GRANT CRUZADO (alguém conectou a conta do cliente B dentro do cliente A):
 * defeito de dado, não identidade. Fundir seria pior que não fundir.
 */
function classificarColisaoGrant(colisao, porId) {
  const envolvidos = colisao.clientes.map((id) => porId.get(id)).filter(Boolean);
  if (envolvidos.length < 2) return null;
  const grantsDaColisao = envolvidos.map((c) => ({
    cliente: c,
    grant: c.grants.find((g) => String(g.ml_user_id) === String(colisao.ml_user_id)) || null,
  }));
  const todosPrimarios = grantsDaColisao.every((x) => x.grant && x.grant.is_primary);
  const radicais = envolvidos.map((c) => tokens(c.nome)[0] || "");
  const parentesco = new Set(radicais).size < radicais.length ||
    radicais.some((r, i) => radicais.some((o, j) => i !== j && r.length >= 3 && o.length >= 3 &&
      (o.startsWith(r) || r.startsWith(o))));

  if (todosPrimarios) {
    return { tipo: "IDENTIDADE", confianca: CONF.CONFIRMADO,
      evidencia: `mesmo ml_user_id ${colisao.ml_user_id} marcado PRIMÁRIO nos dois clientes — a mesma conta de marketplace está cadastrada duas vezes` };
  }
  if (!parentesco) {
    return { tipo: "GRANT_CRUZADO", confianca: CONF.NAO_MERGEAR,
      evidencia: `ml_user_id ${colisao.ml_user_id} aparece como grant SECUNDÁRIO em um cliente e PRIMÁRIO em outro, com nomes sem parentesco — assinatura de grant cruzado (defeito de dado), não de identidade` };
  }
  return { tipo: "IDENTIDADE", confianca: CONF.FORTE,
    evidencia: `mesmo ml_user_id ${colisao.ml_user_id} sob dois clientes com nomes aparentados, mas só um marca o grant como primário` };
}

function detectarClusters({ clientes, auditoria, relacao }) {
  const porId = new Map(clientes.map((c) => [c.id, c]));
  const u = novoUniao();
  const evidencias = new Map();   // "a|b" -> [evidencia]
  const naoMergear = [];          // pares explicitamente recusados
  const par = (a, b) => [a, b].sort((x, y) => x - y).join("|");
  const registrar = (a, b, ev) => {
    const k = par(a, b);
    if (!evidencias.has(k)) evidencias.set(k, []);
    evidencias.get(k).push(ev);
  };

  /* ── E1: colisão de external_account_id (a mais forte: a MESMA conta) ── */
  for (const col of auditoria?.colisoes?.contas_external_account_id || []) {
    const ids = col.clientes.filter((id) => porId.has(id));
    for (let i = 1; i < ids.length; i++) {
      registrar(ids[0], ids[i], {
        tipo: "EXTERNAL_ACCOUNT_ID",
        confianca: CONF.CONFIRMADO,
        detalhe: `cliente_contas com o mesmo external_account_id ${col.external_account_id} (${col.marketplace}) sob clientes distintos`,
      });
      u.unir(ids[0], ids[i]);
    }
  }

  /* ── E2: colisão de ml_user_id, classificada ── */
  for (const col of auditoria?.colisoes?.grants_ml_user_id || []) {
    const ids = col.clientes.filter((id) => porId.has(id));
    if (ids.length < 2) continue;
    const cls = classificarColisaoGrant(col, porId);
    if (!cls) continue;
    if (cls.tipo === "GRANT_CRUZADO") {
      naoMergear.push({ clientes: ids, motivo: cls.evidencia, confianca: cls.confianca,
        classe: "GRANT_CRUZADO_DEFEITO" });
      continue;
    }
    for (let i = 1; i < ids.length; i++) {
      registrar(ids[0], ids[i], { tipo: "ML_USER_ID", confianca: cls.confianca, detalhe: cls.evidencia });
      u.unir(ids[0], ids[i]);
    }
  }

  /* ── E3: sufixo legado AUTOVALIDADO ── */
  const porNorm = new Map();
  for (const c of clientes) {
    for (const forma of [c.nomeNorm, c.slugNorm]) {
      if (!porNorm.has(forma)) porNorm.set(forma, []);
      if (!porNorm.get(forma).includes(c.id)) porNorm.get(forma).push(c.id);
    }
  }
  for (const c of clientes) {
    for (const radical of [c.radicalNome, c.radicalSlug]) {
      if (!radical) continue;
      const alvos = (porNorm.get(radical) || []).filter((id) => id !== c.id);
      for (const alvo of alvos) {
        registrar(c.id, alvo, {
          tipo: "SUFIXO_LEGADO_AUTOVALIDADO",
          confianca: CONF.FORTE,
          detalhe: `"${c.nome}" reduz ao radical "${radical}", que É o nome/slug do cliente #${alvo} — sufixo confirmado por existir o original`,
        });
        u.unir(c.id, alvo);
      }
    }
  }
  // radicais iguais entre si ("maya 2" e "maya 3" ambos → "maya")
  const porRadical = new Map();
  for (const c of clientes) {
    for (const radical of [c.radicalNome, c.radicalSlug]) {
      if (!radical) continue;
      if (!porRadical.has(radical)) porRadical.set(radical, new Set());
      porRadical.get(radical).add(c.id);
    }
  }
  for (const [radical, set] of porRadical) {
    const ids = [...set];
    if (ids.length < 2) continue;
    for (let i = 1; i < ids.length; i++) {
      registrar(ids[0], ids[i], {
        tipo: "RADICAL_LEGADO_COMUM", confianca: CONF.FORTE,
        detalhe: `ambos reduzem ao mesmo radical legado "${radical}"`,
      });
      u.unir(ids[0], ids[i]);
    }
  }

  /* ── E4: sufixo de MARKETPLACE + casca vazia ──
     "zorza_shopee" ao lado de "zorza.loja" é o cadastro legado de "a conta
     Shopee da mesma empresa". Só fundimos quando a entidade sufixada é uma
     CASCA VAZIA — zero contas, zero grants, zero linhas referenciadas. Sem
     dado, fundir não pode perder nada; e deixá-la sozinha só produziria um
     cliente fantasma no Squad 8. Se tivesse dado, não seria automático. */
  for (const c of clientes) {
    const t = tokens(c.nome).length >= 2 ? tokens(c.nome) : tokens(c.slug);
    if (t.length < 2 || !SUFIXO_MARKETPLACE.has(t[t.length - 1])) continue;
    const vazia = c.contasTotal === 0 && c.grants.length === 0 &&
      c.bases.length === 0 && c.linhasReferenciadas === 0;
    if (!vazia) continue;
    const radical = t.slice(0, -1).join(" ");
    if (radical.length < 4) continue;
    const alvos = clientes.filter((o) => o.id !== c.id &&
      (o.nomeNorm === radical || o.slugNorm === radical ||
       o.nomeNorm.split(" ")[0] === radical || o.slugNorm.split(" ")[0] === radical));
    for (const alvo of alvos) {
      registrar(c.id, alvo.id, {
        tipo: "SUFIXO_MARKETPLACE_CASCA_VAZIA", confianca: CONF.FORTE,
        detalhe: `"${c.nome}" é o cadastro legado do marketplace "${t[t.length - 1]}" de "${alvo.nome}" e não tem conta, grant, base nem linha referenciada — casca vazia`,
      });
      u.unir(c.id, alvo.id);
    }
  }

  /* ── Monta clusters e pontua canonicidade ── */
  const nomesRelacaoNorm = new Set();
  for (const s of relacao?.squads || []) for (const n of s.clientes || []) nomesRelacaoNorm.add(normalizar(n));

  const clusters = [];
  for (const [, ids] of u.grupos()) {
    if (ids.length < 2) continue;
    const membros = ids.map((id) => porId.get(id)).filter(Boolean).sort((a, b) => a.id - b.id);
    if (membros.length < 2) continue;

    const evs = [];
    const vistas = new Set();
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        for (const e of evidencias.get(par(ids[i], ids[j])) || []) {
          // nome e slug produzem a MESMA evidência; registrar duas vezes só
          // inflaria o relatório e daria falsa sensação de corroboração.
          const chave = `${ids[i]}|${ids[j]}|${e.tipo}|${e.detalhe}`;
          if (vistas.has(chave)) continue;
          vistas.add(chave);
          evs.push({ entre: [ids[i], ids[j]], ...e });
        }
      }
    }

    const pontuados = membros.map((c) => ({ cliente: c, ...pontuarCanonicidade(c) }))
      .sort((a, b) => b.score - a.score || a.cliente.id - b.cliente.id);
    const canonico = pontuados[0].cliente;
    const aliases = pontuados.slice(1).map((p) => p.cliente);

    // A relação humana corrobora? Se a operação listou o radical UMA vez e o
    // cluster tem N entidades, a própria operação está dizendo que é 1 empresa.
    // Corroboração humana: a operação listou o radical UMA vez para um cluster
    // de N entidades — ela própria está dizendo que aquilo é uma empresa só.
    // Aceita também o nome da relação como PREFIXO de tokens do radical
    // ("Mercadao" para o radical "mercadao enxovais").
    const radicalComum = radicalComumDo(membros);
    const corroboradoPelaRelacao = radicalComum
      ? [...nomesRelacaoNorm].some((n) => {
          if (n === radicalComum) return true;
          const tn = n.split(" "); const tr = radicalComum.split(" ");
          return n.length >= 4 && tn.length < tr.length && tn.every((t, i) => tr[i] === t);
        })
      : false;

    let confianca = evs.some((e) => e.confianca === CONF.CONFIRMADO) ? CONF.CONFIRMADO : CONF.FORTE;
    if (confianca === CONF.FORTE && corroboradoPelaRelacao) confianca = CONF.CONFIRMADO;

    clusters.push({
      chave: canonico.slug,
      radicalComum,
      canonicalClienteId: canonico.id,
      canonicalSlug: canonico.slug,
      canonicalNome: canonico.nome,
      aliasClienteIds: aliases.map((a) => a.id),
      aliases: aliases.map((a) => ({ id: a.id, slug: a.slug, nome: a.nome })),
      membros: pontuados.map((p) => ({
        id: p.cliente.id, slug: p.cliente.slug, nome: p.cliente.nome,
        score: p.score, componentes: p.componentes,
        contasAtivas: p.cliente.contasAtivas, grants: p.cliente.grants.length,
        bases: p.cliente.bases.length, linhasReferenciadas: p.cliente.linhasReferenciadas,
        temApiKey: p.cliente.temApiKey,
      })),
      evidencias: evs,
      corroboradoPelaRelacao,
      confianca,
      acao: "PLAN_ONLY",
    });
  }

  return { clusters: clusters.sort((a, b) => a.canonicalClienteId - b.canonicalClienteId), naoMergear };
}

/** Radical comum a todos os membros, se existir. */
function radicalComumDo(membros) {
  const cands = new Set();
  for (const m of membros) {
    for (const r of [m.radicalNome, m.radicalSlug, m.nomeNorm, m.slugNorm]) if (r) cands.add(r);
  }
  // o radical comum é o candidato mais curto que é prefixo-token de todos
  const ordenados = [...cands].sort((a, b) => a.length - b.length);
  for (const c of ordenados) {
    const tc = c.split(" ");
    const todos = membros.every((m) => {
      const tn = m.nomeNorm.split(" ");
      const ts = m.slugNorm.split(" ");
      return tc.every((t, i) => tn[i] === t) || tc.every((t, i) => ts[i] === t);
    });
    if (todos) return c;
  }
  return null;
}

/**
 * Score de canonicidade. Não é "menor id ganha": é evidência de uso real.
 * O peso maior vai para NÃO ter sufixo legado, porque é a única propriedade
 * que fala da identidade comercial; o resto fala de volume de dados, que
 * importa para o custo da migração, não para quem é a empresa.
 */
function pontuarCanonicidade(c) {
  const comp = {
    semSufixoLegado: (!c.radicalNome && !c.radicalSlug) ? 1000 : 0,
    contasAtivas: c.contasAtivas * 60,
    grants: c.grants.length * 50,
    bases: c.bases.filter((b) => b.ativo).length * 25,
    volumeDados: c.linhasReferenciadas > 0 ? Math.round(Math.log10(c.linhasReferenciadas + 1) * 30) : 0,
    idMaisAntigo: Math.max(0, 200 - c.id),
  };
  return { score: Object.values(comp).reduce((a, b) => a + b, 0), componentes: comp };
}

/* ══════════════════════ 4. MATCH RELAÇÃO ↔ BANCO ══════════════════════ */

const CLASSE = {
  EXATO: "MATCH_EXATO",
  ALIAS: "MATCH_ALIAS_COMPROVADO",
  CLUSTER: "MATCH_CLUSTER_LEGADO",
  AMBIGUO: "MATCH_AMBIGUO",
  INEXISTENTE: "NAO_EXISTE_NO_BANCO",
};

/**
 * Casamento em CAMADAS. Cada camada é uma regra determinística; a primeira que
 * produzir EXATAMENTE UM candidato decide. Duas ou mais → AMBÍGUO (nunca
 * escolhe sozinho). Nenhuma camada com candidato → não existe.
 */
function casarNome(nomeRelacao, clientes, clusters, basesPorSlug = new Map()) {
  const alvo = normalizar(nomeRelacao);
  const tAlvo = tokens(nomeRelacao);
  const cAlvo = compacta(nomeRelacao);
  const cscAlvo = compactaSemConectivos(nomeRelacao);
  const clusterPorMembro = new Map();
  for (const cl of clusters) for (const m of cl.membros) clusterPorMembro.set(m.id, cl);

  const camadas = [
    { nome: "L1_IGUALDADE_EXATA", classe: CLASSE.EXATO,
      test: (c) => c.nomeNorm === alvo || c.slugNorm === alvo },

    // Mesma sequência de letras, separador diferente. Não é fuzzy.
    { nome: "L1B_IGUALDADE_COMPACTA", classe: CLASSE.EXATO,
      test: (c) => cAlvo.length >= 3 && (c.nomeCompacto === cAlvo || c.slugCompacto === cAlvo) },

    { nome: "L1C_IGUALDADE_COMPACTA_SEM_CONECTIVOS", classe: CLASSE.EXATO,
      test: (c) => cscAlvo.length >= 4 && (c.nomeCompactoSC === cscAlvo || c.slugCompactoSC === cscAlvo) },

    { nome: "L2_RADICAL_DO_CLUSTER", classe: CLASSE.CLUSTER,
      test: (c) => {
        const cl = clusterPorMembro.get(c.id);
        return Boolean(cl && cl.radicalComum === alvo && cl.canonicalClienteId === c.id);
      } },

    { nome: "L3_RADICAL_LEGADO", classe: CLASSE.ALIAS,
      test: (c) => c.radicalNome === alvo || c.radicalSlug === alvo },

    // A relação abrevia o cadastro: "Tenda" → "Tenda Medieval".
    { nome: "L4_PREFIXO_DE_TOKENS", classe: CLASSE.ALIAS,
      test: (c) => {
        if (tAlvo.length === 0 || alvo.length < 2) return false;
        const pref = (arr) => arr.length > tAlvo.length && tAlvo.every((t, i) => arr[i] === t);
        return pref(c.nomeNorm.split(" ")) || pref(c.slugNorm.split(" "));
      } },

    // O cadastro abrevia a relação: "DM Comércio" → cliente "DM".
    { nome: "L4B_CLIENTE_PREFIXO_DA_RELACAO", classe: CLASSE.ALIAS,
      test: (c) => {
        if (tAlvo.length < 2) return false;
        const pref = (arr) => arr.length >= 1 && arr.length < tAlvo.length &&
          arr.join("").length >= 2 && arr.every((t, i) => tAlvo[i] === t);
        return pref(c.nomeNorm.split(" ")) || pref(c.slugNorm.split(" "));
      } },

    { nome: "L5_CONTENCAO_DE_TOKENS", classe: CLASSE.ALIAS,
      test: (c) => {
        if (alvo.length < 5) return false; // nomes curtos não podem ser resolvidos por contenção
        const setN = new Set(c.nomeNorm.split(" "));
        const setS = new Set(c.slugNorm.split(" "));
        return tAlvo.every((t) => setN.has(t)) || tAlvo.every((t) => setS.has(t));
      } },

    // Evidência de BANCO, não de string: existe um vínculo de Base cujo slug é
    // literalmente o nome da relação. "Eletro in Matec" → base eletroinmatec_ml.
    { nome: "L6_EVIDENCIA_DE_BASE", classe: CLASSE.ALIAS,
      test: (c) => {
        if (cAlvo.length < 5) return false;
        const donos = basesPorSlug.get(cAlvo);
        return Boolean(donos && donos.has(c.id));
      } },

    // Última camada, a mais frouxa: UMA letra de diferença na forma compacta,
    // com no mínimo 5 letras. "Kirus" ↔ "Kirius".
    { nome: "L7_DISTANCIA_1_COMPACTA", classe: CLASSE.ALIAS,
      test: (c) => cAlvo.length >= 5 && (proximo(c.nomeCompacto, cAlvo) || proximo(c.slugCompacto, cAlvo)) },
  ];

  for (const camada of camadas) {
    const hits = clientes.filter(camada.test);
    if (hits.length === 0) continue;
    // colapsa candidatos que pertencem ao MESMO cluster: o cluster é 1 empresa
    const porCluster = new Map();
    for (const h of hits) {
      const cl = clusterPorMembro.get(h.id);
      const chave = cl ? `cluster:${cl.canonicalClienteId}` : `cliente:${h.id}`;
      if (!porCluster.has(chave)) porCluster.set(chave, []);
      porCluster.get(chave).push(h);
    }
    if (porCluster.size === 1) {
      const [chave, membros] = [...porCluster.entries()][0];
      const cl = chave.startsWith("cluster:") ? clusterPorMembro.get(membros[0].id) : null;
      const escolhido = cl ? clientes.find((c) => c.id === cl.canonicalClienteId) : membros[0];
      return {
        classe: cl ? CLASSE.CLUSTER : camada.classe,
        camada: camada.nome,
        clienteId: escolhido.id,
        clienteSlug: escolhido.slug,
        clienteNome: escolhido.nome,
        cluster: cl ? { canonicalClienteId: cl.canonicalClienteId, aliases: cl.aliasClienteIds, confianca: cl.confianca } : null,
        candidatos: hits.map((h) => ({ id: h.id, slug: h.slug, nome: h.nome })),
      };
    }
    return {
      classe: CLASSE.AMBIGUO,
      camada: camada.nome,
      clienteId: null,
      candidatos: hits.map((h) => ({ id: h.id, slug: h.slug, nome: h.nome,
        contasAtivas: h.contasAtivas, grants: h.grants.length, linhasReferenciadas: h.linhasReferenciadas })),
      motivo: `a camada ${camada.nome} encontrou ${porCluster.size} candidatos de empresas distintas — resolver por máquina seria adivinhar`,
    };
  }

  return { classe: CLASSE.INEXISTENTE, camada: null, clienteId: null, candidatos: [],
    motivo: "nenhuma camada de casamento encontrou cliente real com este nome" };
}

/** slug de base (compacto, sem sufixo de marketplace) → conjunto de cliente_id. */
function indexarBasesPorSlug(clientes) {
  const idx = new Map();
  const por = (chave, id) => {
    if (!chave || chave.length < 4) return;
    if (!idx.has(chave)) idx.set(chave, new Set());
    idx.get(chave).add(id);
  };
  for (const c of clientes) {
    for (const b of c.bases) {
      if (!b.base_slug) continue;
      const t = tokens(b.base_slug);
      por(compacta(b.base_slug), c.id);
      if (t.length >= 2 && SUFIXO_MARKETPLACE.has(t[t.length - 1])) por(t.slice(0, -1).join(""), c.id);
    }
  }
  return idx;
}

function casarRelacao({ relacao, clientes, clusters }) {
  const basesPorSlug = indexarBasesPorSlug(clientes);
  const linhas = [];
  for (const s of relacao.squads || []) {
    for (const nome of s.clientes || []) {
      linhas.push({ nomeRelacao: nome, squadSlug: s.slug, squadNumero: s.numero,
        ...casarNome(nome, clientes, clusters, basesPorSlug) });
    }
  }
  return linhas;
}

/* ══════════════════════ 5. MAPA CLIENTE→SQUAD ══════════════════════ */

const SQUAD_LEGADO = { slug: "squad-8-legado", nome: "Squad 8 · Legado", numero: 8 };

/**
 * Todo cliente REAL recebe exatamente um Squad.
 *  - resolvido pela relação  → Squad 1–6
 *  - alias de cluster        → HERDA o Squad do canônico (nunca Squad próprio)
 *  - qualquer outro caso     → Squad 8 · Legado
 *
 * O alias herdar em vez de ficar sem Squad é deliberado: a consolidação é
 * PLAN_ONLY e pode ser aplicada DEPOIS do mapa. Se o alias ficasse sem Squad,
 * ele viraria invisível no dia em que o enforcement ligasse — um cliente real,
 * com grant e dado, sumindo da carteira de todo mundo.
 */
function montarMapaClientes({ clientes, clusters, matches }) {
  const clusterPorMembro = new Map();
  for (const cl of clusters) for (const m of cl.membros) clusterPorMembro.set(m.id, cl);

  const squadPorCliente = new Map();
  const conflitos = [];

  for (const m of matches) {
    if (!m.clienteId) continue;
    const anterior = squadPorCliente.get(m.clienteId);
    if (anterior && anterior.squadSlug !== m.squadSlug) {
      conflitos.push({ clienteId: m.clienteId, squads: [anterior.squadSlug, m.squadSlug],
        nomes: [anterior.nomeRelacao, m.nomeRelacao] });
      continue;
    }
    squadPorCliente.set(m.clienteId, { squadSlug: m.squadSlug, nomeRelacao: m.nomeRelacao, origem: m.classe });
  }

  const mapa = [];
  for (const c of clientes) {
    const direto = squadPorCliente.get(c.id);
    if (direto) {
      mapa.push({ clienteId: c.id, slug: c.slug, nome: c.nome, squad: direto.squadSlug,
        origem: direto.origem, nomeRelacao: direto.nomeRelacao, papel: "CANONICO" });
      continue;
    }
    const cl = clusterPorMembro.get(c.id);
    if (cl && cl.canonicalClienteId !== c.id) {
      const doCanonico = squadPorCliente.get(cl.canonicalClienteId);
      if (doCanonico) {
        mapa.push({ clienteId: c.id, slug: c.slug, nome: c.nome, squad: doCanonico.squadSlug,
          origem: "ALIAS_HERDA_CANONICO", nomeRelacao: doCanonico.nomeRelacao, papel: "ALIAS",
          canonicalClienteId: cl.canonicalClienteId });
        continue;
      }
    }
    mapa.push({ clienteId: c.id, slug: c.slug, nome: c.nome, squad: SQUAD_LEGADO.slug,
      origem: "FORA_DA_RELACAO", nomeRelacao: null,
      papel: cl ? (cl.canonicalClienteId === c.id ? "CANONICO" : "ALIAS") : "CANONICO",
      canonicalClienteId: cl && cl.canonicalClienteId !== c.id ? cl.canonicalClienteId : undefined });
  }
  return { mapa: mapa.sort((a, b) => a.clienteId - b.clienteId), conflitos };
}

/* ══════════════════════ 6. PLANO DE CONSOLIDAÇÃO ══════════════════════ */

/**
 * Descreve — sem executar — o que precisaria acontecer para que um cluster
 * vire 1 Cliente com N ClienteContas, preservando tudo.
 *
 * Regra de ouro: um Grant NUNCA é reapontado para uma conta que não seja a
 * dele. Cada grant vai para a ClienteConta cujo external_account_id é o MESMO
 * ml_user_id do grant. Se essa conta não existir sob o canônico, o plano
 * REGISTRA a criação da ClienteConta correspondente com os dados reais já
 * existentes — normalizar operação existente, não criar cliente.
 */
function planoConsolidacao({ clusters, clientes, auditoria }) {
  const porId = new Map(clientes.map((c) => [c.id, c]));
  const semFk = new Set((auditoria?.matrizReferencias || []).filter((r) => !r.temFk)
    .map((r) => `${r.tabela}.${r.coluna}`));

  const operacoes = clusters.map((cl) => {
    const canonico = porId.get(cl.canonicalClienteId);
    const aliases = cl.aliasClienteIds.map((id) => porId.get(id)).filter(Boolean);

    // contas já existentes sob o canônico, indexadas por chave natural
    const contasCanonico = new Map();
    for (const cc of canonico.contas) {
      if (cc.external_account_id) contasCanonico.set(`${cc.marketplace}:${cc.external_account_id}`, cc);
    }

    const contasPlanejadas = [];
    const grantsPlanejados = [];
    const basesPlanejadas = [];

    for (const a of aliases) {
      for (const cc of a.contas) {
        const chave = cc.external_account_id ? `${cc.marketplace}:${cc.external_account_id}` : null;
        const jaExiste = chave ? contasCanonico.get(chave) : null;
        contasPlanejadas.push({
          contaId: cc.id, deClienteId: a.id, paraClienteId: canonico.id,
          marketplace: cc.marketplace, externalAccountId: cc.external_account_id || null,
          ativo: cc.ativo,
          acao: jaExiste
            ? "DEDUPLICAR_CONTA"      // mesma conta já existe sob o canônico
            : "MOVER_CONTA",          // reassociar cliente_id, preservando a conta
          contaDestinoExistente: jaExiste ? jaExiste.id : null,
          nota: jaExiste
            ? `conta ${cc.id} tem a mesma chave natural da conta ${jaExiste.id} do canônico — NÃO criar segunda; decidir qual sobrevive preservando as referências de ambas`
            : `conta ${cc.id} passa a pertencer ao cliente ${canonico.id}; is_primary tem de ser RECALCULADO (não herdar)`,
        });
      }
      for (const g of a.grants) {
        // destino: a conta cujo external_account_id === ml_user_id do grant
        const chave = `meli:${g.ml_user_id}`;
        const destinoNoCanonico = contasCanonico.get(chave) || null;
        const destinoNoAlias = a.contas.find(
          (cc) => String(cc.external_account_id) === String(g.ml_user_id)) || null;
        grantsPlanejados.push({
          grantId: g.id, deClienteId: a.id, paraClienteId: canonico.id,
          mlUserId: g.ml_user_id, contaAtual: g.cliente_conta_id,
          contaDestino: destinoNoCanonico ? destinoNoCanonico.id
            : destinoNoAlias ? `conta-movida:${destinoNoAlias.id}` : null,
          acao: destinoNoCanonico ? "REAPONTAR_PARA_CONTA_EXISTENTE"
            : destinoNoAlias ? "SEGUE_A_CONTA_MOVIDA"
              : "SEM_CONTA_CORRESPONDENTE",
          bloqueante: !destinoNoCanonico && !destinoNoAlias,
          nota: (!destinoNoCanonico && !destinoNoAlias)
            ? `grant ${g.id} (ml_user_id ${g.ml_user_id}) não tem ClienteConta correspondente em lugar nenhum — precisa que a conta seja CRIADA a partir do dado real antes de qualquer movimento`
            : `is_primary do grant tem de ser RECALCULADO sob o canônico — herdar criaria dois primários`,
        });
      }
      for (const b of a.bases) {
        basesPlanejadas.push({
          vinculoId: b.id, baseSlug: b.base_slug, deClienteId: a.id, paraClienteId: canonico.id,
          contaAtual: b.cliente_conta_id, marketplace: b.marketplace, ativo: b.ativo,
          classe: b.cliente_conta_id != null ? "ACCOUNT_EXACT" : "CLIENT_LEVEL_LEGACY",
          acao: "MOVER_VINCULO_PRESERVANDO_SEMANTICA",
          nota: b.cliente_conta_id != null
            ? "vínculo é de CONTA — segue a conta, não o cliente"
            : "vínculo é CLIENT-LEVEL legado — ao mover para o canônico passa a valer para TODAS as contas dele; verificar se isso amplia o alcance indevidamente",
        });
      }
    }

    const referencias = [];
    for (const a of aliases) {
      for (const [tabela, linhas] of Object.entries(a.linhasPorTabela)) {
        const chave = `${tabela}.cliente_id`;
        referencias.push({
          tabela, coluna: "cliente_id", deClienteId: a.id, linhas,
          temFk: !semFk.has(chave),
          risco: semFk.has(chave) ? "SEM_FK__ATUALIZACAO_MANUAL_OBRIGATORIA" : "COM_FK",
        });
      }
    }

    const grantsBloqueados = grantsPlanejados.filter((g) => g.bloqueante);

    return {
      cluster: cl.chave,
      confianca: cl.confianca,
      canonicalClienteId: cl.canonicalClienteId,
      canonicalSlug: cl.canonicalSlug,
      aliasClienteIds: cl.aliasClienteIds,
      evidencias: cl.evidencias.map((e) => ({ tipo: e.tipo, entre: e.entre, detalhe: e.detalhe })),
      clienteContas: contasPlanejadas,
      grants: grantsPlanejados,
      bases: basesPlanejadas,
      referencias,
      apiKeyLegacyDependency: [canonico, ...aliases].filter((c) => c.temApiKey).map((c) => c.id),
      bloqueadores: grantsBloqueados.map((g) => `grant ${g.grantId} sem conta correspondente`),
      acao: "PLAN_ONLY",
      aplicavelAutomaticamente: cl.confianca === CONF.CONFIRMADO && grantsBloqueados.length === 0,
    };
  });

  return {
    versao: 1,
    geradoEm: new Date().toISOString(),
    aviso: "PLAN_ONLY — nenhuma destas operações foi executada. Nenhum cliente é criado ou deletado por este plano.",
    operacoes,
  };
}

/* ══════════════════════ 7. IDENTIDADES DE USUÁRIO ══════════════════════ */

function resolverIdentidades({ relacao, usuarios }) {
  const ativos = (usuarios || []).filter((u) => u.ativo);
  const nomes = new Map();
  for (const s of relacao.squads || []) {
    for (const [papel, valor] of Object.entries(s.papeis || {})) {
      if (!valor || valor === "AUSENTE_NA_ESTRUTURA") continue;
      if (!nomes.has(valor)) nomes.set(valor, []);
      nomes.get(valor).push({ squad: s.slug, papel });
    }
  }

  // 1ª passada: candidatos EM CAMADAS. Igualdade de token vem antes de
  // qualquer aproximação — sem isso "Witor" empatava com "Vitor", que é outra
  // pessoa, e a ambiguidade era inventada pelo próprio matcher.
  const tokensDe = (u) => [...tokens(u.nome), ...tokens(String(u.email || "").split("@")[0])];
  const bruto = [];
  for (const [nome, ocorrencias] of nomes) {
    const alvo = normalizar(nome);
    let cands = ativos.filter((u) => tokensDe(u).includes(alvo));
    let camada = "TOKEN_EXATO";
    if (cands.length === 0) {
      cands = ativos.filter((u) => tokensDe(u).some((t) => proximo(t, alvo)));
      camada = "TOKEN_APROXIMADO";
    }
    bruto.push({ nome, ocorrencias, candidatos: cands, camada });
  }

  /**
   * 2ª passada: PROPAGAÇÃO POR EXCLUSÃO. Cada pessoa da planilha é uma pessoa
   * distinta e cada usuário do banco é uma pessoa só — logo o casamento é
   * injetivo. Um nome com candidato ÚNICO trava esse usuário, e os demais
   * nomes têm de liberá-lo. É o que resolve "Gabrielly" quando "Cavazzoto"
   * já é, sozinho, Gabrielly Cavazotto — sem nenhum chute.
   */
  // Um match aproximado sobre conta `admin` nunca é aceito sozinho: as contas
  // admin são as poucas contas de operação do sistema, e confundir uma pessoa
  // com uma delas por uma letra criaria membership para quem talvez nem esteja
  // no Squad. Esse caso não trava ninguém e volta para o humano.
  const aceitavel = (b, cands) => cands.length === 1 &&
    !(b.camada === "TOKEN_APROXIMADO" && String(cands[0].role || "").toLowerCase() === "admin");

  const atual = new Map(bruto.map((b) => [b.nome, b.candidatos.slice()]));
  const porExclusaoSet = new Set();
  for (let volta = 0; volta < bruto.length + 1; volta++) {
    const travados = new Map(); // userId -> nome
    for (const b of bruto) {
      const cands = atual.get(b.nome);
      if (aceitavel(b, cands)) travados.set(cands[0].id, b.nome);
    }
    let mudou = false;
    for (const b of bruto) {
      const cands = atual.get(b.nome);
      if (cands.length <= 1) continue;
      const filtrados = cands.filter((c) => !travados.has(c.id) || travados.get(c.id) === b.nome);
      if (filtrados.length >= 1 && filtrados.length < cands.length) {
        atual.set(b.nome, filtrados); porExclusaoSet.add(b.nome); mudou = true;
      }
    }
    if (!mudou) break;
  }

  const resultado = [];
  for (const b of bruto) {
    const cands = atual.get(b.nome);
    const porExclusao = porExclusaoSet.has(b.nome);
    const aproximadoEmAdmin = b.camada === "TOKEN_APROXIMADO" && cands.length === 1 &&
      String(cands[0].role || "").toLowerCase() === "admin";

    const classe = aproximadoEmAdmin ? "MATCH_AMBIGUO"
      : cands.length === 0 ? "NAO_ENCONTRADO"
        : cands.length > 1 ? "MATCH_AMBIGUO"
          : porExclusao ? "MATCH_POR_EXCLUSAO"
            : b.camada === "TOKEN_APROXIMADO" ? "MATCH_APROXIMADO"
              : "MATCH_EXATO";
    const resolvido = classe === "MATCH_EXATO" || classe === "MATCH_POR_EXCLUSAO" || classe === "MATCH_APROXIMADO";

    resultado.push({
      nomeRelacao: b.nome,
      ocorrencias: b.ocorrencias,
      classe,
      camada: b.camada,
      userId: resolvido ? cands[0].id : null,
      email: resolvido ? cands[0].email : null,
      role: resolvido ? cands[0].role : null,
      candidatos: b.candidatos.map((c) => ({ id: c.id, nome: c.nome, email: c.email, role: c.role })),
      multiSquad: b.ocorrencias.length > 1,
      ...(aproximadoEmAdmin ? { motivo: `único candidato (#${cands[0].id}) casou só por aproximação e é conta admin — exige confirmação humana` } : {}),
    });
  }
  return resultado.sort((a, b) => a.nomeRelacao.localeCompare(b.nomeRelacao, "pt-BR"));
}

/**
 * Distância de edição limitada. Tolerância proporcional ao tamanho: uma letra
 * a partir de 5 caracteres, duas a partir de 8 — "Cavazzoto"/"Cavazotto" é
 * distância 2 e é claramente a mesma pessoa; "Witor"/"Vitor" é distância 1 e
 * são pessoas diferentes, por isso a camada exata roda ANTES desta.
 */
function distancia(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let anterior = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const atual = [i];
    let melhor = i;
    for (let j = 1; j <= b.length; j++) {
      atual[j] = Math.min(
        anterior[j] + 1, atual[j - 1] + 1,
        anterior[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (atual[j] < melhor) melhor = atual[j];
    }
    if (melhor > max) return max + 1; // poda: já passou do orçamento
    anterior = atual;
  }
  return anterior[b.length];
}

function proximo(a, b) {
  if (a === b) return true;
  const n = Math.min(a.length, b.length);
  if (n < 5) return false;             // nomes curtos: só igualdade
  const max = n >= 8 ? 2 : 1;
  return distancia(a, b, max) <= max;
}

/* ══════════════════════ 8. PLANO CANÔNICO P2.9 ══════════════════════ */

const FUNCAO_SQUAD = { coordenador: "coordenador", gestor: "membro", auxiliar: "membro", auxiliar2: "membro", design: "membro" };

function montarPlanoP29({ relacao, identidades, mapaClientes, estrito }) {
  const porNome = new Map(identidades.map((i) => [i.nomeRelacao, i]));
  const bloqueios = [];

  const squads = (relacao.squads || []).map((s) => ({ slug: s.slug, nome: s.nome, ativo: true }));
  squads.push({ slug: SQUAD_LEGADO.slug, nome: SQUAD_LEGADO.nome, ativo: true });

  const membros = [];
  for (const s of relacao.squads || []) {
    for (const [papel, valor] of Object.entries(s.papeis || {})) {
      if (!valor || valor === "AUSENTE_NA_ESTRUTURA") continue;
      const ident = porNome.get(valor);
      if (!ident || ident.classe === "NAO_ENCONTRADO") {
        bloqueios.push({ tipo: "USUARIO_NAO_ENCONTRADO", nome: valor, squad: s.slug, papel });
        continue;
      }
      if (ident.classe === "MATCH_AMBIGUO") {
        bloqueios.push({ tipo: "USUARIO_AMBIGUO", nome: valor, squad: s.slug, papel,
          candidatos: ident.candidatos.map((c) => c.id) });
        continue;
      }
      const principal = ident.multiSquad ? null : true;
      if (principal === null) {
        bloqueios.push({ tipo: "SQUAD_PRINCIPAL_PENDENTE", nome: valor, userId: ident.userId,
          squads: ident.ocorrencias.map((o) => o.squad) });
      }
      membros.push({
        squad: s.slug, usuario: ident.email, funcao: FUNCAO_SQUAD[papel] || "membro",
        ...(principal === true ? { principal: true } : {}),
        _papelOperacional: papel,
        ...(principal === null ? { _principalPendente: true } : {}),
      });
    }
  }

  const clientes = mapaClientes.map((m) => ({
    cliente: m.slug, squad: m.squad,
    motivo: m.origem === "FORA_DA_RELACAO"
      ? "P2.9 — fora da relação operacional dos Squads 1–6; quarentena no Squad 8 · Legado"
      : m.origem === "ALIAS_HERDA_CANONICO"
        ? `P2.9 — entidade legada do cliente #${m.canonicalClienteId}; herda o Squad do canônico`
        : `P2.9 — relação operacional ("${m.nomeRelacao}")`,
  }));

  const plano = {
    versao: 1,
    descricao: `P2.9 — 6 Squads operacionais + Squad 8 · Legado · ${membros.length} memberships · ${clientes.length} clientes reais`,
    _geradoPor: "squads-mapeamento-real.js",
    _avisoResponsaveis: "responsaveis[] deliberadamente VAZIO — a regra de negócio que transformaria papel operacional (gestor/auxiliar/design) em cliente_responsaveis NÃO está documentada. Ver 12_CLIENT_CONSOLIDATION_PLAN.md.",
    squads, membros, clientes, responsaveis: [],
  };

  const emitivel = estrito ? bloqueios.length === 0 : bloqueios.filter((b) => b.tipo !== "SQUAD_PRINCIPAL_PENDENTE").length === 0;
  return { plano, bloqueios, emitivel };
}

/* ══════════════════════ 9. INVARIANTES ══════════════════════ */

function verificarInvariantes({ clientes, clusters, matches, mapaClientes, conflitos, planoConsolidacao: pc, planoP29 }) {
  const r = [];
  const ok = (id, titulo, passou, detalhe) => r.push({ id, titulo, passou, detalhe });

  const idsReais = new Set(clientes.map((c) => c.id));
  const noMapa = new Set(mapaClientes.map((m) => m.clienteId));

  const grantsAntes = clientes.reduce((s, c) => s + c.grants.length, 0);
  const grantsNoPlano = (pc.operacoes || []).reduce((s, o) => s + o.grants.length, 0);
  const grantsDeAlias = clusters.reduce((s, cl) =>
    s + cl.aliasClienteIds.reduce((t, id) => t + (clientes.find((c) => c.id === id)?.grants.length || 0), 0), 0);

  ok("I1", "nenhum Grant some", grantsNoPlano === grantsDeAlias,
    `grants de alias no banco=${grantsDeAlias} · grants endereçados no plano=${grantsNoPlano} · total no banco=${grantsAntes}`);

  const trocaSeller = (pc.operacoes || []).flatMap((o) => o.grants)
    .filter((g) => g.acao === "REAPONTAR_PARA_CONTA_EXISTENTE" && g.contaDestino == null);
  ok("I2", "nenhum Grant troca de seller/conta", trocaSeller.length === 0,
    `grants reapontados sem conta de mesmo ml_user_id: ${trocaSeller.length}`);

  const trocaMkt = (pc.operacoes || []).flatMap((o) => o.clienteContas)
    .filter((c) => c.acao === "MOVER_CONTA" && !c.marketplace);
  ok("I3", "nenhuma conta muda de marketplace", trocaMkt.length === 0,
    `contas movidas sem marketplace preservado: ${trocaMkt.length}`);

  const dedup = (pc.operacoes || []).flatMap((o) => o.clienteContas).filter((c) => c.acao === "DEDUPLICAR_CONTA");
  ok("I4", "nenhuma ClienteConta duplicada é criada", true,
    `${dedup.length} conta(s) com chave natural já existente marcadas DEDUPLICAR_CONTA (nunca criar segunda)`);

  const criaCliente = (pc.operacoes || []).some((o) => (o.clienteContas || []).some((c) => c.acao === "CRIAR_CLIENTE"));
  ok("I5", "nenhum Cliente novo é criado", !criaCliente, "plano não contém nenhuma operação de criação de cliente");

  const canonicosAtivos = clientes.filter((c) => c.ativo).map((c) => c.id);
  const semSquad = canonicosAtivos.filter((id) => !noMapa.has(id));
  const contagemSquad = new Map();
  for (const m of mapaClientes) contagemSquad.set(m.clienteId, (contagemSquad.get(m.clienteId) || 0) + 1);
  const duplicados = [...contagemSquad.entries()].filter(([, n]) => n > 1);
  ok("I6", "todo Cliente ativo termina em exatamente 1 Squad",
    semSquad.length === 0 && duplicados.length === 0 && conflitos.length === 0,
    `sem squad: ${semSquad.length} · com 2+ squads: ${duplicados.length} · conflitos de relação: ${conflitos.length}`);

  const relacionadosForaDe16 = mapaClientes.filter(
    (m) => m.origem === "MATCH_EXATO" || m.origem === "MATCH_ALIAS_COMPROVADO" || m.origem === "MATCH_CLUSTER_LEGADO")
    .filter((m) => m.squad === SQUAD_LEGADO.slug);
  ok("I7", "Cliente da relação vai para Squad 1–6", relacionadosForaDe16.length === 0,
    `clientes resolvidos pela relação que caíram no Squad 8: ${relacionadosForaDe16.length}`);

  const naoRelacionadosFora8 = mapaClientes.filter((m) => m.origem === "FORA_DA_RELACAO" && m.squad !== SQUAD_LEGADO.slug);
  ok("I8", "Cliente fora da relação vai para Squad 8", naoRelacionadosFora8.length === 0,
    `clientes fora da relação que NÃO foram para o Squad 8: ${naoRelacionadosFora8.length}`);

  const aliasComSquadProprio = mapaClientes.filter((m) => m.papel === "ALIAS" && m.origem !== "ALIAS_HERDA_CANONICO" && m.origem !== "FORA_DA_RELACAO");
  ok("I9", "alias não ganha Squad próprio", aliasComSquadProprio.length === 0,
    `aliases com Squad decidido independentemente do canônico: ${aliasComSquadProprio.length}`);

  const inexistentesNoPlano = (planoP29?.clientes || []).filter((c) => !clientes.some((x) => x.slug === c.cliente));
  ok("I14", "nenhum cliente inexistente entra no plano", inexistentesNoPlano.length === 0,
    `entradas do plano sem cliente real correspondente: ${inexistentesNoPlano.length}`);

  const squadsNoPlano = new Set((planoP29?.squads || []).map((s) => s.slug));
  const operacionais = [...squadsNoPlano].filter((s) => s !== SQUAD_LEGADO.slug);
  const legados = [...squadsNoPlano].filter((s) => s === SQUAD_LEGADO.slug);
  ok("I15", "exatamente 6 Squads operacionais + 1 legado",
    operacionais.length === 6 && legados.length === 1,
    `operacionais=${operacionais.length} (${operacionais.join(", ")}) · legado=${legados.length}`);

  const numerosProibidos = operacionais.filter((s) => !/^squad-[1-6]$/.test(s));
  ok("I16", "nenhum Squad 7 ou 9 acidental", numerosProibidos.length === 0,
    numerosProibidos.length ? `slugs fora de squad-1..6: ${numerosProibidos.join(", ")}` : "todos os operacionais são squad-1..squad-6");

  ok("I17", "todo id do mapa existe no banco",
    mapaClientes.every((m) => idsReais.has(m.clienteId)), `${mapaClientes.length} entradas conferidas`);

  return r;
}

/* ══════════════════════ 10. ORQUESTRAÇÃO ══════════════════════ */

function mapear({ inventario, auditoria, relacao, estrito = true }) {
  const clientes = indexarClientes(inventario, auditoria);
  const { clusters, naoMergear } = detectarClusters({ clientes, auditoria, relacao });
  const matches = casarRelacao({ relacao, clientes, clusters });
  const { mapa, conflitos } = montarMapaClientes({ clientes, clusters, matches });
  const identidades = resolverIdentidades({ relacao, usuarios: inventario.usuarios });
  const pc = planoConsolidacao({ clusters, clientes, auditoria });
  const { plano, bloqueios, emitivel } = montarPlanoP29({ relacao, identidades, mapaClientes: mapa, estrito });
  const invariantes = verificarInvariantes({
    clientes, clusters, matches, mapaClientes: mapa, conflitos, planoConsolidacao: pc, planoP29: plano });

  const porSquad = {};
  for (const m of mapa) porSquad[m.squad] = (porSquad[m.squad] || 0) + 1;

  return {
    clientes, clusters, naoMergear, matches, mapaClientes: mapa, conflitos,
    identidades, planoConsolidacao: pc, planoP29: plano, bloqueios, emitivel, invariantes,
    resumo: {
      clientesReais: clientes.length,
      clientesAtivos: clientes.filter((c) => c.ativo).length,
      nomesNaRelacao: matches.length,
      porClasse: matches.reduce((a, m) => { a[m.classe] = (a[m.classe] || 0) + 1; return a; }, {}),
      clusters: clusters.length,
      aliases: clusters.reduce((s, c) => s + c.aliasClienteIds.length, 0),
      canonicosProjetados: clientes.length - clusters.reduce((s, c) => s + c.aliasClienteIds.length, 0),
      clientesPorSquad: porSquad,
      identidades: identidades.reduce((a, i) => { a[i.classe] = (a[i.classe] || 0) + 1; return a; }, {}),
      invariantesFalhas: invariantes.filter((i) => !i.passou).length,
    },
  };
}

/* ─────────────────────────────── CLI ─────────────────────────────── */

function parseArgs(argv) {
  const a = { inventario: null, auditoria: null, relacao: null, saidaDir: null, estrito: true, help: false };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--inventario") a.inventario = argv[++i];
    else if (t === "--auditoria") a.auditoria = argv[++i];
    else if (t === "--relacao") a.relacao = argv[++i];
    else if (t === "--saida-dir") a.saidaDir = argv[++i];
    else if (t === "--nao-estrito") a.estrito = false;
    else if (t === "-h" || t === "--help") a.help = true;
  }
  return a;
}

function main() {
  const a = parseArgs(process.argv);
  if (a.help || !a.inventario || !a.auditoria || !a.relacao) {
    process.stdout.write(fs.readFileSync(__filename, "utf8").split("\n").slice(1, 20)
      .join("\n").replace(/^\/\/ ?/gm, "").trimEnd() + "\n");
    process.exit(a.help ? 0 : 1);
  }
  const ler = (p) => JSON.parse(fs.readFileSync(path.resolve(p), "utf8"));
  const r = mapear({
    inventario: ler(a.inventario), auditoria: ler(a.auditoria),
    relacao: ler(a.relacao), estrito: a.estrito,
  });

  if (a.saidaDir) {
    const dir = path.resolve(a.saidaDir);
    fs.mkdirSync(dir, { recursive: true });
    const escrever = (nome, obj) =>
      fs.writeFileSync(path.join(dir, nome), JSON.stringify(obj, null, 2) + "\n", "utf8");
    escrever("CLIENT_CONSOLIDATION_PLAN.json", r.planoConsolidacao);
    escrever("MAPA_P2_9_REAL.json", {
      geradoEm: new Date().toISOString(),
      resumo: r.resumo, mapaClientes: r.mapaClientes,
      clusters: r.clusters, naoMergear: r.naoMergear,
      matches: r.matches, identidades: r.identidades,
      bloqueios: r.bloqueios, invariantes: r.invariantes,
    });
    escrever("plano-p2-9.json", r.planoP29);
    process.stdout.write(`[mapeamento] artefatos escritos em ${dir}\n`);
  }
  process.stdout.write(JSON.stringify(r.resumo, null, 2) + "\n");
  process.exit(r.invariantes.some((i) => !i.passou) ? 2 : 0);
}

module.exports = {
  normalizar, tokens, compacta, compactaSemConectivos, radicalLegado, proximo, distancia,
  SUFIXO_LEGADO, SUFIXO_MARKETPLACE, CONECTIVOS, indexarBasesPorSlug,
  indexarClientes, detectarClusters, pontuarCanonicidade, radicalComumDo,
  casarNome, casarRelacao, montarMapaClientes, planoConsolidacao,
  resolverIdentidades, montarPlanoP29, verificarInvariantes, mapear,
  CLASSE, CONF, SQUAD_LEGADO, FUNCAO_SQUAD,
};

if (require.main === module) main();
