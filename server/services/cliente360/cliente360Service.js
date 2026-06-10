// server/services/cliente360/cliente360Service.js
// Orquestrador do Cliente 360. Monta o payload unificado a partir do
// snapshot persistido + dados de leitura. NUNCA chama ML aqui (isso é só
// no cliente360SyncService, via POST). NUNCA devolve token/api_key.

const repo = require("./cliente360Repository");
const dataQuality = require("./cliente360DataQualityService");
const diagnosticoEngine = require("./cliente360DiagnosticoEngine");
const freteHistoricoService = require("./cliente360FreteHistoricoService");
const { calcularTacos } = require("./cliente360SyncService");
const { competenciaAtual, parseCompetencia } = require("../../utils/periodoUtils");

const SYNC_STALE_H = 18; // horas até considerar snapshot "stale"

function criarErroHttp(statusCode, mensagem) {
  const err = new Error(mensagem);
  err.statusCode = statusCode;
  return err;
}

// ─── Máscaras ─────────────────────────────────────────────────────────────

function maskMlUserId(id) {
  const s = String(id || "");
  if (s.length <= 6) return s ? "***" : null;
  return `${s.slice(0, 3)}***${s.slice(-3)}`;
}

function grantStatusDe(grant) {
  if (!grant) return { temGrant: false, status: "ausente", mlUserIdMascarado: null, expiresAt: null };
  const exp = grant.expires_at ? new Date(grant.expires_at).getTime() : null;
  const expirado = exp !== null && exp <= Date.now();
  return {
    temGrant: true,
    status: expirado ? "expirado" : "conectado",
    mlUserIdMascarado: maskMlUserId(grant.ml_user_id),
    expiresAt: grant.expires_at || null,
  };
}

// ─── Helpers de número ──────────────────────────────────────────────────

const numOrNull = (v) => (v === null || v === undefined ? null : Number(v));

// ─── Mapeamentos de leitura ───────────────────────────────────────────────

function mapBases(rows) {
  return rows.map((b) => ({
    id: b.id,
    nome: b.nome,
    slug: b.slug,
    marketplace: b.marketplace || null,
    origem: b.origem || null,
    atualizadaEm: b.vinculo_em || b.updated_at || null,
  }));
}

function mapRelatorios(rows) {
  return rows.map((r) => ({
    id: r.id,
    baseSlug: r.base_slug,
    escopo: r.escopo,
    status: r.status,
    totalItens: r.total_itens,
    itensSemBase: r.itens_sem_base,
    itensCriticos: r.itens_criticos,
    itensAtencao: r.itens_atencao,
    itensSaudaveis: r.itens_saudaveis,
    mcMedia: numOrNull(r.mc_media),
    margemAlvo: numOrNull(r.margem_alvo),
    criadoEm: r.created_at,
  }));
}

function mapEntregas(rows) {
  return rows.map((e) => ({
    id: e.id,
    tipo: e.tipo,
    titulo: e.titulo,
    periodo: e.periodo,
    status: e.status,
    tokenPublico: e.token_publico || null,
    publicado: e.publicado,
    criadoEm: e.created_at,
  }));
}

function mapAds(row, referencia = false) {
  if (!row) return null;
  return {
    mes: row.mes_ref,
    referencia,                              // true = de outro mês (não o atual)
    investimentoAds: numOrNull(row.investimento_ads),
    faturamentoTotal: numOrNull(row.faturamento_total),
    tacos: numOrNull(row.tacos),
    roas: numOrNull(row.roas),
    atualizadoEm: row.updated_at || null,
  };
}

// resumoMes a partir do snapshot. null = não sincronizado; 0 = zero real.
function mapResumoMes(snapshot) {
  if (!snapshot) {
    return {
      faturamento: null, mcMedia: null, pedidos: null, cancelados: null,
      problemas: null, adsInvestido: null, adsRef: null, tacos: null,
      fechamentosCount: 0, diagnosticosCount: 0, itensSemCusto: null, itensCriticos: null,
    };
  }
  // TACoS sem Ads é indefinido: defensivo contra snapshots antigos que
  // gravaram tacos=0 quando ads_investido era ausente.
  const adsInvestido = numOrNull(snapshot.ads_investido);
  let tacos = numOrNull(snapshot.tacos);
  if (adsInvestido === null) tacos = null;
  return {
    faturamento: numOrNull(snapshot.faturamento),
    mcMedia: numOrNull(snapshot.mc_media),
    pedidos: numOrNull(snapshot.pedidos),
    cancelados: numOrNull(snapshot.cancelados),
    problemas: numOrNull(snapshot.problemas),
    adsInvestido,
    adsRef: null,
    tacos,
    fechamentosCount: snapshot.fechamentos_count ?? 0,
    diagnosticosCount: snapshot.diagnosticos_count ?? 0,
    itensSemCusto: numOrNull(snapshot.itens_sem_custo),
    itensCriticos: numOrNull(snapshot.itens_criticos),
  };
}

// ─── Sync state ──────────────────────────────────────────────────────────

function deriveSyncState(snapshot) {
  if (!snapshot || !snapshot.sincronizado_em) {
    return {
      status: "ausente",
      precisaSincronizar: true,
      ultimaSincronizacao: snapshot?.sincronizado_em || null,
      motivo: "Nenhum snapshot encontrado para a competência atual",
    };
  }
  const horas = (Date.now() - new Date(snapshot.sincronizado_em).getTime()) / 3.6e6;
  if (horas > SYNC_STALE_H) {
    return {
      status: "stale",
      precisaSincronizar: true,
      ultimaSincronizacao: snapshot.sincronizado_em,
      motivo: "Snapshot antigo",
    };
  }
  return {
    status: "sincronizado",
    precisaSincronizar: false,
    ultimaSincronizacao: snapshot.sincronizado_em,
    motivo: null,
  };
}

// ─── Setup / saúde / próximo passo ────────────────────────────────────────

function computeSetup({ bases, grant, relatorios, entregas, ads, freteHistorico, competencia, dq }) {
  const temBase = bases.length > 0;
  const temGrant = !!grant?.temGrant;
  const temDiagnostico = relatorios.length > 0;
  const temFechamentoMes = dq.flags.temFechamento;
  const temAds = !!ads && (ads.investimentoAds || 0) > 0;
  const temFreteHistorico = freteHistorico?.status !== "sem_amostra";

  const checks = [temBase, temGrant, temDiagnostico, temFechamentoMes, temAds];
  const score = Math.round((checks.filter(Boolean).length / checks.length) * 100);

  return { score, temBase, temGrant, temDiagnostico, temFechamentoMes, temAds, temFreteHistorico };
}

function getSaudeOperacional({ setup, scoreSaude }) {
  const motivos = [];
  if (!setup.temBase) motivos.push("Sem base de custo");
  if (!setup.temGrant) motivos.push("Sem grant ML");

  let status, label;
  if (!setup.temBase && !setup.temGrant) { status = "critico"; label = "Crítico"; }
  else if (!setup.temBase || !setup.temGrant) { status = "atencao"; label = "Atenção"; }
  else if (setup.temDiagnostico) { status = "ok"; label = "Operável"; }
  else { status = "atencao"; label = "Atenção"; }

  return { status, score: scoreSaude, label, motivos };
}

function getProximoPasso({ setup, resumoMes }) {
  if (!setup.temGrant) {
    return { tipo: "conectar_grant", titulo: "Conectar Mercado Livre",
      descricao: "Sem grant ML não há pedidos nem métricas.", href: null };
  }
  if (!setup.temBase) {
    return { tipo: "vincular_base", titulo: "Vincular base de custo",
      descricao: "Sem base oficial, o cálculo de margem não é confiável.", href: "bases.html" };
  }
  if (!setup.temDiagnostico) {
    return { tipo: "rodar_diagnostico", titulo: "Rodar primeiro diagnóstico",
      descricao: "Cliente tem grant e base, mas nenhum diagnóstico.", href: "automacoes.html" };
  }
  if (!setup.temFechamentoMes) {
    return { tipo: "criar_fechamento", titulo: "Criar fechamento do mês",
      descricao: "Cliente pronto para fechar o mês.", href: "financeiro.html" };
  }
  if (resumoMes.tacos != null && resumoMes.tacos > diagnosticoEngine.TACOS_WARN) {
    return { tipo: "revisar_ads", titulo: "Revisar Ads",
      descricao: `TACoS em ${resumoMes.tacos.toFixed(1)}%, acima do limite.`, href: "ads.html" };
  }
  return { tipo: "ok", titulo: "Operação saudável",
    descricao: "Grant, base, diagnóstico e fechamento concluídos.", href: null };
}

// ─── Contexto bruto (reuso entre GET, oportunidades, diagnóstico) ─────────

async function montarContexto(slug, competencia) {
  const cliente = await repo.findClienteBySlug(slug);
  if (!cliente) throw criarErroHttp(404, "Cliente não encontrado.");

  const [basesRows, grantRow, relatoriosRows, entregasRows, adsRow, adsUltimoRow, snapshot, freteHistorico, diagsSalvos] =
    await Promise.all([
      repo.findBasesVinculadasByCliente(cliente.id),
      repo.findMlGrantByCliente(cliente.id),
      repo.findRelatoriosByCliente(slug, { limit: 20 }),
      repo.findEntregasByCliente(cliente.id, slug, { limit: 50 }),
      repo.findAdsResumoByCliente(slug, competencia),
      repo.findUltimoAdsResumoByCliente(slug),
      repo.findResumoMensal(cliente.id, competencia),
      freteHistoricoService.getFreteHistoricoCliente(slug, competencia),
      repo.findDiagnosticos(slug, 10),
    ]);

  // Itens do último relatório (para qualidade de dados / itens sem custo).
  let relatorioItens = [];
  if (relatoriosRows.length) {
    relatorioItens = await repo.findRelatorioItensResumo(relatoriosRows[0].id);
  }

  const grant = grantStatusDe(grantRow);
  const bases = mapBases(basesRows);
  const relatorios = mapRelatorios(relatoriosRows);
  const entregas = mapEntregas(entregasRows);
  // Ads do mês atual; se não houver, o mais recente como referência (outro mês).
  const ads = adsRow
    ? mapAds(adsRow, false)
    : (adsUltimoRow && adsUltimoRow.mes_ref !== competencia ? mapAds(adsUltimoRow, true) : mapAds(adsUltimoRow, false));

  return {
    cliente, grant, bases, relatorios, entregas, ads, snapshot, freteHistorico,
    diagsSalvos, relatorioItens,
  };
}

// ─── API pública ──────────────────────────────────────────────────────────

async function getCliente360(slug, options = {}) {
  await repo.ensureCliente360Tables();

  const periodo = options.competencia
    ? (parseCompetencia(options.competencia) || competenciaAtual())
    : competenciaAtual();

  const ctx = await montarContexto(slug, periodo.competencia);

  const dq = dataQuality.avaliarQualidadeDados({
    bases: ctx.bases, grant: ctx.grant, relatorios: ctx.relatorios,
    entregas: ctx.entregas, periodo, relatorioItens: ctx.relatorioItens,
  });

  const resumoMes = mapResumoMes(ctx.snapshot);

  // Enriquecimento de Ads: se o snapshot não consolidou Ads, usa a leitura viva
  // (mês atual ou referência de outro mês). Nunca transforma ausência em 0.
  if (resumoMes.adsInvestido === null && ctx.ads && ctx.ads.investimentoAds !== null) {
    resumoMes.adsInvestido = ctx.ads.investimentoAds;
    resumoMes.adsRef = ctx.ads.referencia ? ctx.ads.mes : null;
  }
  // TACoS sempre sobre o faturamento da Cliente 360 — nunca o TACoS do módulo
  // Ads (que divide pelo faturamento gerencial). Sem Ads ⇒ TACoS indefinido.
  if (resumoMes.adsInvestido === null) {
    resumoMes.tacos = null;
  } else if (resumoMes.tacos === null) {
    resumoMes.tacos = calcularTacos(resumoMes.faturamento, resumoMes.adsInvestido);
  }

  const setup = computeSetup({
    bases: ctx.bases, grant: ctx.grant, relatorios: ctx.relatorios,
    entregas: ctx.entregas, ads: ctx.ads, freteHistorico: ctx.freteHistorico,
    competencia: periodo.competencia, dq,
  });

  // Diagnóstico read-only (engine determinístico, sem persistir).
  const diag = diagnosticoEngine.gerarDiagnosticoAutomatico({
    setup, resumoMes, freteHistorico: ctx.freteHistorico, dataQuality: dq,
    relatorios: ctx.relatorios,
  });

  const saude = getSaudeOperacional({ setup, scoreSaude: diag.scoreSaude });
  const proximoPasso = getProximoPasso({ setup, resumoMes });
  const sync = deriveSyncState(ctx.snapshot);

  const ultimoDiagSalvo = ctx.diagsSalvos[0]
    ? {
        id: ctx.diagsSalvos[0].id,
        competencia: ctx.diagsSalvos[0].competencia,
        scoreSaude: ctx.diagsSalvos[0].score_saude,
        status: ctx.diagsSalvos[0].status,
        criadoEm: ctx.diagsSalvos[0].created_at,
      }
    : null;

  return {
    ok: true,
    fonte: "cliente360_unificado",
    cliente: { id: ctx.cliente.id, nome: ctx.cliente.nome, slug: ctx.cliente.slug, ativo: ctx.cliente.ativo },
    periodo,
    sync,
    resumoMes,
    setup,
    saude,
    grant: ctx.grant,
    bases: ctx.bases,
    diagnostico: {
      ultimo: ultimoDiagSalvo,
      automatico: null, // persistência fica no POST admin-only (TODO evolutivo)
      issues: diag.issues,
      oportunidades: diag.oportunidades,
      acoes: diag.acoes,
    },
    freteHistorico: ctx.freteHistorico,
    ads: ctx.ads || {},
    fechamentos: ctx.entregas.filter((e) => e.tipo === "fechamento_mensal"),
    relatorios: ctx.relatorios,
    historico: ctx.entregas,
    proximoPasso,
    dataQuality: { score: dq.score, problemas: dq.problemas },
    debug: {
      geradoEm: new Date().toISOString(),
      fontes: ["relatorios", "entregas_cliente", "ads_resumos_mensais", "cliente_360_resumos_mensais"],
    },
  };
}

// Oportunidades isoladas (endpoint dedicado).
async function getOportunidades(slug, options = {}) {
  await repo.ensureCliente360Tables();
  const periodo = options.competencia
    ? (parseCompetencia(options.competencia) || competenciaAtual())
    : competenciaAtual();
  const ctx = await montarContexto(slug, periodo.competencia);
  const dq = dataQuality.avaliarQualidadeDados({
    bases: ctx.bases, grant: ctx.grant, relatorios: ctx.relatorios,
    entregas: ctx.entregas, periodo, relatorioItens: ctx.relatorioItens,
  });
  const resumoMes = mapResumoMes(ctx.snapshot);
  const setup = computeSetup({
    bases: ctx.bases, grant: ctx.grant, relatorios: ctx.relatorios,
    entregas: ctx.entregas, ads: ctx.ads, freteHistorico: ctx.freteHistorico,
    competencia: periodo.competencia, dq,
  });
  const oportunidades = diagnosticoEngine.gerarOportunidades({
    setup, resumoMes, freteHistorico: ctx.freteHistorico, dataQuality: dq, relatorios: ctx.relatorios,
  });
  return { ok: true, competencia: periodo.competencia, oportunidades };
}

// Gera o diagnóstico determinístico e PERSISTE (usado só pelo POST admin-only).
async function gerarDiagnosticoPersistido(slug, options = {}, userId = null) {
  await repo.ensureCliente360Tables();
  const periodo = options.competencia
    ? (parseCompetencia(options.competencia) || competenciaAtual())
    : competenciaAtual();
  const ctx = await montarContexto(slug, periodo.competencia);
  const dq = dataQuality.avaliarQualidadeDados({
    bases: ctx.bases, grant: ctx.grant, relatorios: ctx.relatorios,
    entregas: ctx.entregas, periodo, relatorioItens: ctx.relatorioItens,
  });
  const resumoMes = mapResumoMes(ctx.snapshot);
  const setup = computeSetup({
    bases: ctx.bases, grant: ctx.grant, relatorios: ctx.relatorios,
    entregas: ctx.entregas, ads: ctx.ads, freteHistorico: ctx.freteHistorico,
    competencia: periodo.competencia, dq,
  });
  const persistido = await diagnosticoEngine.persistirDiagnostico(
    ctx.cliente.id, slug, periodo.competencia,
    { setup, resumoMes, freteHistorico: ctx.freteHistorico, dataQuality: dq, relatorios: ctx.relatorios },
    userId
  );
  return { ok: true, competencia: periodo.competencia, diagnostico: persistido };
}

async function getDiagnosticos(slug, limit = 10) {
  await repo.ensureCliente360Tables();
  const cliente = await repo.findClienteBySlug(slug);
  if (!cliente) throw criarErroHttp(404, "Cliente não encontrado.");
  const rows = await repo.findDiagnosticos(slug, limit);
  return {
    ok: true,
    diagnosticos: rows.map((d) => ({
      id: d.id, competencia: d.competencia, scoreSaude: d.score_saude,
      status: d.status, resumo: d.resumo, criadoEm: d.created_at,
    })),
  };
}

async function getFreteHistorico(slug, options = {}) {
  await repo.ensureCliente360Tables();
  const cliente = await repo.findClienteBySlug(slug);
  if (!cliente) throw criarErroHttp(404, "Cliente não encontrado.");
  const periodo = options.competencia
    ? (parseCompetencia(options.competencia) || competenciaAtual())
    : competenciaAtual();
  const freteHistorico = await freteHistoricoService.getFreteHistoricoCliente(slug, periodo.competencia);
  return { ok: true, competencia: periodo.competencia, freteHistorico };
}

// Lista operacional segura (admin/user/membro). Sem N+1.
async function getClientesOperacional() {
  await repo.ensureCliente360Tables();
  const periodo = competenciaAtual();

  const [clientes, grants, idsComBase, syncs] = await Promise.all([
    repo.findClientesAtivos(),
    repo.findGrantsResumo(),
    repo.findClienteIdsComBase(),
    repo.findSincronizacoesPorCompetencia(periodo.competencia),
  ]);

  const grantPorCliente = new Map(grants.map((g) => [g.cliente_id, g]));
  const baseSet = new Set(idsComBase);
  const syncPorCliente = new Map(syncs.map((s) => [s.cliente_id, s.sincronizado_em]));

  const lista = clientes.map((c) => {
    const grant = grantStatusDe(grantPorCliente.get(c.id));
    const temBase = baseSet.has(c.id);
    const pendencias = [];
    if (!grant.temGrant) pendencias.push("sem_grant");
    if (!temBase) pendencias.push("sem_base");

    const checks = [grant.temGrant, temBase];
    const setupScore = Math.round((checks.filter(Boolean).length / checks.length) * 100);

    let statusOperacional;
    if (!grant.temGrant && !temBase) statusOperacional = "critico";
    else if (!grant.temGrant || !temBase) statusOperacional = "atencao";
    else statusOperacional = "pronto";

    return {
      id: c.id,
      nome: c.nome,
      slug: c.slug,
      ativo: c.ativo,
      temGrant: grant.temGrant,
      grantStatus: grant.status,
      temBase,
      setupScore,
      statusOperacional,
      ultimaSincronizacao: syncPorCliente.get(c.id) || null,
      pendencias,
    };
  });

  return { ok: true, clientes: lista };
}

module.exports = {
  getCliente360,
  getClientesOperacional,
  getOportunidades,
  getDiagnosticos,
  getFreteHistorico,
  gerarDiagnosticoPersistido,
  // helpers reusados pelo SyncService / DiagnosticoController:
  montarContexto,
  computeSetup,
  mapResumoMes,
  criarErroHttp,
};
