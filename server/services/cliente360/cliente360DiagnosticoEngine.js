// server/services/cliente360/cliente360DiagnosticoEngine.js
// Motor de diagnóstico/oportunidades — DETERMINÍSTICO, baseado em regras.
// Sem IA. Sem SQL (recebe `contexto` pronto). Sem chamadas ML.
//
// Usado em dois lugares:
//   1. GET unificado → issues/oportunidades/ações calculadas ao vivo (read-only, leve).
//   2. POST /diagnostico-automatico → mesmos itens, persistidos (admin only).

const repo = require("./cliente360Repository");

// Thresholds centralizados (espelham os do frontend).
const MC_OK = 15;     // MC% saudável
const MC_WARN = 8;    // MC% mínimo aceitável
const TACOS_WARN = 6; // TACoS acima disso → revisar Ads

// MC pode vir como fração (0.142) ou percentual (14.2). Normaliza para %.
function mcParaPercent(valor) {
  if (valor === null || valor === undefined) return null;
  const n = Number(valor);
  if (!Number.isFinite(n)) return null;
  return Math.abs(n) <= 1 ? n * 100 : n;
}

function item(tipo, severidade, titulo, extra = {}) {
  return {
    tipo,
    severidade,
    titulo,
    descricao: extra.descricao || null,
    fonte: extra.fonte || null,
    acaoRecomendada: extra.acaoRecomendada || null,
    impactoEstimado: extra.impactoEstimado || null,
  };
}

// Classifica a severidade textual em peso para o score.
function classificarSeveridade(severidade) {
  switch (severidade) {
    case "critico": return 25;
    case "atencao": return 10;
    default: return 0;
  }
}

// Score de saúde 0–100 a partir das penalidades dos itens.
function calcularScoreSaude(itens) {
  const penalidade = itens.reduce((s, it) => s + classificarSeveridade(it.severidade), 0);
  return Math.max(0, 100 - penalidade);
}

// Núcleo de regras. Retorna lista achatada de itens (issue/risk/opportunity/action).
function avaliarRegras(contexto) {
  const { setup, resumoMes, freteHistorico, dataQuality } = contexto;
  const itens = [];

  const temBase = !!setup?.temBase;
  const temGrant = !!setup?.temGrant;
  const temDiagnostico = !!setup?.temDiagnostico;
  const temFechamento = !!setup?.temFechamentoMes;

  // 1. Base ausente (crítico)
  if (!temBase) {
    itens.push(item("issue", "critico", "Sem base de custo vinculada", {
      descricao: "Sem base oficial, o cálculo de margem (MC/LC) não é confiável.",
      fonte: "base_cliente_vinculos",
      acaoRecomendada: "Vincular a base do cliente em Bases de Custo.",
      impactoEstimado: "Margem não confiável",
    }));
  }

  // 2. Grant ausente (crítico)
  if (!temGrant) {
    itens.push(item("issue", "critico", "Sem grant Mercado Livre", {
      descricao: "Sem grant não há pedidos nem métricas do ML para consolidar.",
      fonte: "ml_tokens",
      acaoRecomendada: "Enviar o link de conexão ML ao cliente.",
      impactoEstimado: "Sem faturamento/pedidos",
    }));
  }

  // 3. Base + grant mas sem diagnóstico (oportunidade)
  if (temBase && temGrant && !temDiagnostico) {
    itens.push(item("opportunity", "atencao", "Rodar primeiro diagnóstico", {
      descricao: "Cliente tem base e grant, mas nenhum diagnóstico rodado.",
      fonte: "relatorios",
      acaoRecomendada: "Rodar diagnóstico em Automações.",
    }));
  }

  // 4. Itens sem custo no último relatório (atenção)
  const semCusto = dataQuality?.flags?.itensSemCusto;
  if (semCusto && semCusto > 0) {
    itens.push(item("issue", "atencao", `${semCusto} anúncio(s) sem custo`, {
      descricao: "Itens sem custo inflam a MC média e mascaram a margem real.",
      fonte: "relatorio_itens.tem_base = false",
      acaoRecomendada: "Revisar a base vinculada e cadastrar custos faltantes.",
      impactoEstimado: "MC média inflada",
    }));
  }

  // 5. Relatório antigo (atenção)
  if (Array.isArray(contexto.relatorios) && contexto.relatorios.length &&
      dataQuality?.flags?.relatorioRecente === false) {
    itens.push(item("action", "atencao", "Diagnóstico desatualizado", {
      descricao: "Último diagnóstico tem mais de 30 dias.",
      fonte: "relatorios.created_at",
      acaoRecomendada: "Rodar novo diagnóstico.",
    }));
  }

  // 6. Métricas/base/grant mas sem fechamento do mês (oportunidade)
  if (temBase && temGrant && temDiagnostico && !temFechamento) {
    itens.push(item("opportunity", "atencao", "Fechamento do mês pendente", {
      descricao: "Cliente já tem base, grant e diagnóstico — pronto para fechar o mês.",
      fonte: "entregas_cliente",
      acaoRecomendada: "Criar fechamento mensal em Financeiro.",
    }));
  }

  // 7. TACoS alto (atenção)
  const tacos = resumoMes?.tacos;
  if (tacos !== null && tacos !== undefined && tacos > TACOS_WARN) {
    itens.push(item("risk", "atencao", `TACoS elevado (${tacos.toFixed(1)}%)`, {
      descricao: `TACoS acima do limite de ${TACOS_WARN}%.`,
      fonte: "ads_resumos_mensais",
      acaoRecomendada: "Revisar a estratégia de Ads do mês.",
      impactoEstimado: "Mídia consumindo margem",
    }));
  }

  // 8. MC média abaixo da margem alvo (crítico/atenção). Usa a margem alvo do
  // último relatório quando houver; só cai nos thresholds fixos sem alvo.
  // MC na margem alvo ou acima dela NUNCA gera problema.
  const mcPct = mcParaPercent(resumoMes?.mcMedia);
  const ultimoRel = Array.isArray(contexto.relatorios) ? contexto.relatorios[0] : null;
  const alvoPct = mcParaPercent(ultimoRel?.margemAlvo ?? ultimoRel?.margem_alvo);
  const limiteOk = alvoPct !== null ? alvoPct : MC_OK;
  const limiteCrit = alvoPct !== null ? Math.max(0, alvoPct - 4) : MC_WARN;
  if (mcPct !== null && mcPct < limiteOk) {
    if (mcPct < limiteCrit) {
      itens.push(item("issue", "critico", `MC média baixa (${mcPct.toFixed(1)}%)`, {
        descricao: `MC bem abaixo da margem alvo de ${limiteOk.toFixed(1)}%.`,
        fonte: "relatorios.mc_media",
        acaoRecomendada: "Subir preço ou revisar custo/frete dos anúncios críticos.",
        impactoEstimado: "Margem comprometida",
      }));
    } else {
      itens.push(item("risk", "atencao", `MC média em atenção (${mcPct.toFixed(1)}%)`, {
        descricao: `MC abaixo da margem alvo de ${limiteOk.toFixed(1)}%.`,
        fonte: "relatorios.mc_media",
        acaoRecomendada: "Acompanhar margem; revisar itens de menor MC.",
      }));
    }
  }

  // 9. Frete histórico divergente (atenção)
  if (freteHistorico?.status === "divergente") {
    itens.push(item("risk", "atencao", "Frete histórico divergente", {
      descricao: "Frete usado no cálculo difere do frete real observado.",
      fonte: "cliente_360_frete_historico",
      acaoRecomendada: "Revisar frete usado na precificação.",
      impactoEstimado: "Pode estar vazando margem",
    }));
  }

  // Insight de saúde quando nada crítico/atenção
  if (!itens.some((i) => i.severidade === "critico" || i.severidade === "atencao")) {
    itens.push(item("insight", "ok", "Operação saudável", {
      descricao: "Sem problemas críticos ou de atenção detectados.",
      fonte: "cliente360",
    }));
  }

  return itens;
}

// API pública: gera o diagnóstico (read-only, sem persistir).
function gerarDiagnosticoAutomatico(contexto) {
  const itens = avaliarRegras(contexto);
  const issues = itens.filter((i) => i.tipo === "issue" || i.tipo === "risk");
  const oportunidades = itens.filter((i) => i.tipo === "opportunity");
  const acoes = itens
    .filter((i) => i.acaoRecomendada)
    .map((i) => ({ titulo: i.titulo, acao: i.acaoRecomendada, severidade: i.severidade }));
  const scoreSaude = calcularScoreSaude(itens);

  return { itens, issues, oportunidades, acoes, scoreSaude };
}

function gerarOportunidades(contexto) {
  return avaliarRegras(contexto).filter((i) => i.tipo === "opportunity");
}

function gerarAcoesRecomendadas(contexto) {
  return avaliarRegras(contexto)
    .filter((i) => i.acaoRecomendada)
    .map((i) => ({ titulo: i.titulo, acao: i.acaoRecomendada, severidade: i.severidade }));
}

// Persiste o diagnóstico (usado só pelo POST admin-only).
async function persistirDiagnostico(clienteId, clienteSlug, competencia, contexto, userId) {
  const { itens, scoreSaude } = gerarDiagnosticoAutomatico(contexto);
  const criticos = itens.filter((i) => i.severidade === "critico").length;
  const resumo = `${itens.length} item(ns) · ${criticos} crítico(s) · score ${scoreSaude}`;

  const diag = await repo.insertDiagnostico({
    clienteId, clienteSlug, competencia,
    scoreSaude, status: "gerado", resumo,
    payloadJson: { total: itens.length, criticos },
    geradoPor: userId,
  });
  await repo.insertDiagnosticoItens(diag.id, itens);

  return { id: diag.id, criadoEm: diag.created_at, scoreSaude, resumo, itens };
}

module.exports = {
  gerarDiagnosticoAutomatico,
  gerarOportunidades,
  gerarAcoesRecomendadas,
  classificarSeveridade,
  calcularScoreSaude,
  persistirDiagnostico,
  MC_OK,
  MC_WARN,
  TACOS_WARN,
};
