// server/services/centralVendas/retencao/centralVendasRetencaoPlanner.js
// Retenção controlada da Central de Vendas — PLANO (função pura, sem banco).
//
// Cada sync regrava o mês inteiro como um import novo; os imports antigos da
// mesma tupla (cliente_slug, marketplace, competencia, cliente_conta_id)
// continuam no banco sem que leitor nenhum consiga mais selecioná-los. A
// elegibilidade NÃO é por idade: é "nunca mais selecionável", decidido pela
// MESMA função de seleção da leitura (selecionarMelhorImportPorCompetencia):
//
//   published P com cobertura → substituído ⟺ a seleção sobre os imports da
//     tupla, para o segmento = a própria cobertura de P, devolve OUTRO import.
//     (Esse outro é um published mais recente que contém a cobertura de P;
//     então ele vence P em qualquer segmento que P poderia servir.)
//   legacy L → substituído ⟺ a seleção só entre os legacy da tupla não é L
//     (existe legacy mais recente), OU a seleção do mês inteiro é um published
//     (cobertura do mês todo: legacy nunca mais é fallback).
//   candidate C → resíduo ⟺ run terminal E (run failed OU existe published na
//     tupla mais novo que C). Candidate de run queued/running nunca.
//   published (ou candidate de run terminal) com cobertura INVERTIDA
//     (from > to) → resíduo "cobertura_vazia": nunca selecionável.
//
// A tupla é EXATA (cliente_conta_id NULL comparado como valor). Dominância
// dentro da tupla exata vale em qualquer variante de leitura de conta
// (exata, ou conta OR NULL com includeLegacy): o import que domina está na
// mesma tupla, portanto em qualquer união que contenha o dominado.
//
// Essencial (nunca elegível, mesmo dominado): selecionável hoje; citado por
// outra persistência (refsProtegidas); de run ativo; mais novo que
// minIdadeHoras; dominado há menos de minIdadeHoras (o DOMINADOR é mais novo
// que isso — carência desde a substituição; não se aplica a cobertura vazia
// nem a candidate, que nunca foram selecionáveis); os manterUltimosSubstituidos published mais recentes abaixo
// do vigente, por tupla (margem de rollback).

const { selecionarMelhorImportPorCompetencia, coberturaContemSegmento, monthBounds, asDate } = require("../centralVendasRepository");

const RUN_TERMINAIS = new Set(["completed", "failed", "cancelled"]);
const RUN_ATIVOS = new Set(["queued", "running"]);

const POLITICA_PADRAO = Object.freeze({
  minIdadeHoras: 72,
  manterUltimosSubstituidos: 1,
  incluirLegacy: true,
  incluirCandidates: true,
  incluirMpPayments: true,
});

function lerBool(valor, padrao) {
  if (valor === undefined || valor === null || valor === "") return padrao;
  if (typeof valor === "boolean") return valor;
  const v = String(valor).trim().toLowerCase();
  if (["true", "1", "sim", "yes"].includes(v)) return true;
  if (["false", "0", "nao", "não", "no"].includes(v)) return false;
  return padrao;
}

function lerInteiroNaoNegativo(valor, padrao) {
  if (valor === undefined || valor === null || valor === "") return padrao;
  const n = Number(valor);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : padrao;
}

// Política: args (CLI/chamador) > env > padrão. Um valor inválido cai no
// padrão — nunca numa política mais agressiva por engano de digitação.
function lerPolitica(env = process.env, args = {}) {
  const pick = (arg, envName) => (args[arg] !== undefined ? args[arg] : env[envName]);
  return {
    minIdadeHoras: lerInteiroNaoNegativo(pick("minIdadeHoras", "CENTRAL_VENDAS_RETENCAO_MIN_IDADE_HORAS"), POLITICA_PADRAO.minIdadeHoras),
    manterUltimosSubstituidos: lerInteiroNaoNegativo(
      pick("manterUltimosSubstituidos", "CENTRAL_VENDAS_RETENCAO_MANTER_ULTIMOS"), POLITICA_PADRAO.manterUltimosSubstituidos
    ),
    incluirLegacy: lerBool(pick("incluirLegacy", "CENTRAL_VENDAS_RETENCAO_INCLUIR_LEGACY"), POLITICA_PADRAO.incluirLegacy),
    incluirCandidates: lerBool(pick("incluirCandidates", "CENTRAL_VENDAS_RETENCAO_INCLUIR_CANDIDATES"), POLITICA_PADRAO.incluirCandidates),
    incluirMpPayments: lerBool(pick("incluirMpPayments", "CENTRAL_VENDAS_RETENCAO_INCLUIR_MP_PAYMENTS"), POLITICA_PADRAO.incluirMpPayments),
  };
}

function ms(value) {
  if (!value) return null;
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

function chaveTupla(row) {
  const conta = row.cliente_conta_id == null ? "NULL" : String(Number(row.cliente_conta_id));
  return `${row.cliente_slug}|${row.marketplace}|${String(row.competencia).trim()}|${conta}`;
}

// Aceita Map(id → fontes[]), objeto { id: fontes[] } ou lista de
// { importId, fonte } — o repository devolve Map, os testes usam o que for
// mais legível.
function normalizarRefsImports(refs) {
  const out = new Map();
  const add = (id, fonte) => {
    const n = Number(id);
    if (!Number.isFinite(n)) return;
    if (!out.has(n)) out.set(n, []);
    if (fonte && !out.get(n).includes(fonte)) out.get(n).push(fonte);
  };
  if (!refs) return out;
  if (refs instanceof Map) {
    for (const [id, fontes] of refs) (Array.isArray(fontes) && fontes.length ? fontes : ["ref"]).forEach((f) => add(id, f));
  } else if (Array.isArray(refs)) {
    for (const r of refs) add(r.importId ?? r.id ?? r, r.fonte || "ref");
  } else {
    for (const [id, fontes] of Object.entries(refs)) (Array.isArray(fontes) ? fontes : [fontes]).forEach((f) => add(id, f));
  }
  return out;
}

// Cobertura INVERTIDA (from > to, ex.: competência 2026-09 com 2026-10-01 →
// 2026-09-30 — bug de fuso da busca de Orders): nenhum segmento real
// (start ≤ end) cabe nela, então coberturaContemSegmento nunca a aceita. Sem
// este caso explícito, a seleção sobre o "segmento" invertido da própria
// cobertura devolveria o import e ele pareceria selecionável.
function coberturaVazia(row) {
  const from = asDate(row.coverage_date_from);
  const to = asDate(row.coverage_date_to);
  return Boolean(from && to && from > to);
}

function ordemCriacaoDesc(a, b) {
  const ca = ms(a.created_at) || 0;
  const cb = ms(b.created_at) || 0;
  if (cb !== ca) return cb - ca;
  return Number(b.id) - Number(a.id);
}

// Menor instante válido (ms) ou null — sem instante conhecido, a carência não vence.
function menorMs(valores) {
  const t = valores.map(ms).filter((v) => Number.isFinite(v) && v > 0);
  return t.length ? Math.min(...t) : null;
}

function ordemPublicacaoDesc(a, b) {
  const pa = ms(a.published_at) || 0;
  const pb = ms(b.published_at) || 0;
  if (pb !== pa) return pb - pa;
  return Number(b.id) - Number(a.id);
}

// Avalia a dominância de cada import de UMA tupla. Devolve Map(id →
// { motivo, desde } | null). `motivo` cita o dominador ATUAL (o que a seleção
// devolve). `desde` é quando P deixou de ser selecionável: o published_at do
// PRIMEIRO import que passou a vencê-lo (para legacy, o created_at do primeiro
// legacy mais novo ou o published_at do primeiro published do mês inteiro).
// Base da carência desde a substituição: quem leu P como vigente o fez antes
// desse instante. Usar o dominador atual reiniciava a carência a cada sync do
// mês aberto (republicado todo dia) e nada do mês corrente ficava elegível.
// Um dominador já removido só atrasa `desde` (nunca o adianta).
function avaliarTupla(rows) {
  const competencia = String(rows[0].competencia).trim();
  const mes = monthBounds(competencia);
  const selMes = selecionarMelhorImportPorCompetencia(rows, { segmentStart: mes.inicio, segmentEnd: mes.fim });
  const legados = rows.filter((r) => r.publication_status === "legacy");
  const legacyMaisRecente = selecionarMelhorImportPorCompetencia(legados, { segmentStart: mes.inicio, segmentEnd: mes.fim });

  const dominancia = new Map();
  for (const row of rows) {
    const id = Number(row.id);
    if (row.publication_status === "published") {
      const from = asDate(row.coverage_date_from);
      const to = asDate(row.coverage_date_to);
      if (!from || !to || coberturaVazia(row)) { dominancia.set(id, null); continue; }
      const sel = selecionarMelhorImportPorCompetencia(rows, { segmentStart: from, segmentEnd: to });
      if (!sel || Number(sel.id) === id) { dominancia.set(id, null); continue; }
      // Quem vence P na cobertura de P: published que a contém e vem antes na ordem da seleção.
      const vencedores = rows.filter((r) => r !== row && r.publication_status === "published"
        && coberturaContemSegmento(r, from, to) && ordemPublicacaoDesc(r, row) < 0);
      dominancia.set(id, { motivo: `dominado_por:${Number(sel.id)}`, desde: menorMs(vencedores.map((r) => r.published_at)) });
    } else if (row.publication_status === "legacy") {
      // Legacy deixa de ser selecionável quando surge um legacy mais novo ou um published do mês inteiro.
      const desde = menorMs([
        ...legados.filter((r) => r !== row && ordemCriacaoDesc(r, row) < 0).map((r) => r.created_at),
        ...rows.filter((r) => r.publication_status === "published" && coberturaContemSegmento(r, mes.inicio, mes.fim))
          .map((r) => r.published_at),
      ]);
      if (legacyMaisRecente && Number(legacyMaisRecente.id) !== id) {
        dominancia.set(id, { motivo: `legacy_mais_recente:${Number(legacyMaisRecente.id)}`, desde });
      } else if (selMes && selMes.publication_status === "published") {
        dominancia.set(id, { motivo: `published_mes_inteiro:${Number(selMes.id)}`, desde });
      } else {
        dominancia.set(id, null);
      }
    }
  }
  return { dominancia };
}

function planejarRetencao({ imports = [], refsProtegidas = {}, runs = [], cfg = {} } = {}) {
  const politica = { ...POLITICA_PADRAO, ...cfg };
  const agora = cfg.agora != null ? ms(cfg.agora) : Date.now();
  const limiteIdade = agora - politica.minIdadeHoras * 3600 * 1000;
  const refsImports = normalizarRefsImports(refsProtegidas.imports);
  const refsRuns = new Set((refsProtegidas.runs ? [...refsProtegidas.runs] : []).map(Number));
  const runsPorId = new Map(runs.map((r) => [Number(r.id), r]));

  const porTupla = new Map();
  for (const row of imports) {
    const k = chaveTupla(row);
    if (!porTupla.has(k)) porTupla.set(k, []);
    porTupla.get(k).push(row);
  }

  const motivos = {};
  const classes = { essencial: [], substituido: [], residuo: [], retido: [] };
  const tuplas = [];

  for (const [chave, rows] of porTupla) {
    const { dominancia } = avaliarTupla(rows);

    // Margem de rollback: os N published dominados mais recentes da tupla.
    const margem = new Set(
      rows
        .filter((r) => r.publication_status === "published" && dominancia.get(Number(r.id)))
        .sort(ordemPublicacaoDesc)
        .slice(0, politica.manterUltimosSubstituidos)
        .map((r) => Number(r.id))
    );
    const publicados = rows.filter((r) => r.publication_status === "published");
    const resumoTupla = { chave, cliente_slug: rows[0].cliente_slug, marketplace: rows[0].marketplace,
      competencia: String(rows[0].competencia).trim(), cliente_conta_id: rows[0].cliente_conta_id == null ? null : Number(rows[0].cliente_conta_id),
      total: rows.length, essencial: 0, substituido: 0, residuo: 0, retido: 0 };

    for (const row of rows) {
      const id = Number(row.id);
      const status = row.publication_status;
      const essenciais = [];
      let elegivel = null; // "substituido" | "residuo"
      const retidos = [];

      if (status === "published" && coberturaVazia(row)) {
        elegivel = "residuo";
        retidos.push("cobertura_vazia");
      } else if (status === "published" || status === "legacy") {
        const dom = dominancia.get(id);
        if (!dom) {
          if (status === "published" && (!asDate(row.coverage_date_from) || !asDate(row.coverage_date_to))) {
            retidos.push("published_sem_cobertura");
          } else {
            essenciais.push("selecionavel");
          }
        } else {
          elegivel = "substituido";
          retidos.push(dom.motivo); // registra quem domina (vira só informativo se elegível)
          if (margem.has(id)) essenciais.push("margem_rollback");
          // Carência desde a substituição: quem leu este import como vigente
          // (Painel/Cliente 360 gravando centralImportIds, leitura em voo) o
          // fez antes do dominador existir — há mais de minIdadeHoras.
          if (!dom.desde || dom.desde > limiteIdade) essenciais.push("carencia_substituicao");
          if (status === "legacy" && !politica.incluirLegacy) { elegivel = null; retidos.push("politica:legacy_desligado"); }
        }
      } else if (status === "candidate") {
        const run = row.sync_run_id != null ? runsPorId.get(Number(row.sync_run_id)) : null;
        if (!politica.incluirCandidates) {
          retidos.push("politica:candidates_desligado");
        } else if (!run) {
          retidos.push("candidate_sem_run_conhecido");
        } else if (!RUN_TERMINAIS.has(run.status)) {
          retidos.push(`candidate_run_${run.status || "desconhecido"}`);
        } else {
          const criado = ms(row.created_at) || 0;
          const maisNovo = publicados.find((p) => Number(p.id) > id || (ms(p.published_at) || 0) > criado);
          if (coberturaVazia(row)) { elegivel = "residuo"; retidos.push("cobertura_vazia"); }
          else if (run.status === "failed") { elegivel = "residuo"; retidos.push("run_failed"); }
          else if (maisNovo) { elegivel = "residuo"; retidos.push(`published_mais_novo:${Number(maisNovo.id)}`); }
          else retidos.push("candidate_sem_published_mais_novo");
        }
      } else {
        retidos.push(`status_desconhecido:${status}`);
      }

      if (elegivel) {
        if (refsImports.has(id)) essenciais.push(...refsImports.get(id).map((f) => `referenciado:${f}`));
        const run = row.sync_run_id != null ? runsPorId.get(Number(row.sync_run_id)) : null;
        if (run && RUN_ATIVOS.has(run.status)) essenciais.push("run_ativo");
        const idade = Math.max(ms(row.created_at) || 0, ms(row.published_at) || 0);
        if (!idade || idade > limiteIdade) essenciais.push("recente");
      } else if (refsImports.has(id) && essenciais.length) {
        essenciais.push(...refsImports.get(id).map((f) => `referenciado:${f}`));
      }

      let classe;
      if (essenciais.length) classe = "essencial";
      else if (elegivel) classe = elegivel;
      else classe = "retido";
      classes[classe].push(id);
      resumoTupla[classe] += 1;
      motivos[id] = { classe, motivos: [...essenciais, ...retidos], tupla: chave, publicationStatus: status,
        syncRunId: row.sync_run_id == null ? null : Number(row.sync_run_id) };
    }
    tuplas.push(resumoTupla);
  }

  // mp_payments — por sync_run. Um run continua necessário enquanto QUALQUER
  // import retido (tudo que não é substituído/resíduo) apontar para ele: é por
  // esses runs que listMpPaymentsWithChargesTotalByRunIds lê.
  const eliminados = new Set([...classes.substituido, ...classes.residuo]);
  const runsRetidos = new Set();
  for (const row of imports) {
    if (row.sync_run_id != null && !eliminados.has(Number(row.id))) runsRetidos.add(Number(row.sync_run_id));
  }
  const mp = { elegiveis: [], retidos: [], motivos: {} };
  for (const run of runs) {
    if (!run.tem_mp_payments) continue;
    const id = Number(run.id);
    const m = [];
    if (!politica.incluirMpPayments) m.push("politica:mp_payments_desligado");
    if (runsRetidos.has(id)) m.push("run_de_import_retido");
    if (refsRuns.has(id)) m.push("run_referenciado_fora_do_escopo");
    if (!RUN_TERMINAIS.has(run.status)) m.push(`run_${run.status || "desconhecido"}`);
    const idade = ms(run.finished_at) || ms(run.created_at);
    if (!idade || idade > limiteIdade) m.push("run_recente");
    (m.length ? mp.retidos : mp.elegiveis).push(id);
    mp.motivos[id] = m.length ? m : ["sem_import_retido"];
  }

  for (const k of Object.keys(classes)) classes[k].sort((a, b) => a - b);
  mp.elegiveis.sort((a, b) => a - b);
  mp.retidos.sort((a, b) => a - b);
  return {
    politica: { ...politica, agora: new Date(agora).toISOString() },
    ...classes,
    elegiveis: [...classes.substituido, ...classes.residuo].sort((a, b) => a - b),
    motivos,
    tuplas: tuplas.sort((a, b) => a.chave.localeCompare(b.chave)),
    mp,
  };
}

module.exports = {
  planejarRetencao,
  lerPolitica,
  chaveTupla,
  POLITICA_PADRAO,
  RUN_TERMINAIS,
  RUN_ATIVOS,
};
