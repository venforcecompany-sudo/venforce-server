// server/services/cliente360/cliente360V3SaudeAdsService.js
//
// FASE 5A (Ads account-scoped) + FASE 5C (Saúde leve), Projeto_cliente360.
// LAZY — nunca chamado no bootstrap da Fase 1 (Ads faz chamadas reais ao
// Mercado Livre, mesmo custo/latência que o Motor de Margem na Fase 3).
//
// ADS: reaproveita `mlAdsService.buscarPerformanceML` — a MESMA função que
// visaoService.js já usa para o bloco "ads" account-aware da Visão
// (resolverContextoConta interno = resolveMarketplaceAccountContext real,
// nunca escolhe conta em silêncio). Isto é o "Ads account-scoped
// comprovado" do prompt master — DIFERENTE do `dados.ads` que já vem no
// bootstrap da Fase 1 (esse é `cliente360AdsService.js`, client_legacy,
// nunca recebe clienteContaId — mantido rotulado como tal na apresentação).
//
// SAÚDE: três dimensões INDEPENDENTES, cada uma com escopo/fonte próprios —
// nunca fundidas num score único (prompt master Fase 5C). Deliberadamente
// NÃO reaproveita o campo "saude" de visaoService.js: aquele é
// cliente360Service.getCliente360 (V1, cliente inteiro, não esta conta) —
// exatamente o "score sintético do Cliente Operação" que o prompt master
// proíbe usar como verdade da nova 360.

const { listarContasDoCliente } = require("../clienteContas/clienteContaService");
const { listarSyncRuns } = require("../centralVendas/centralVendasSyncRunService");
const { listarEntregas } = require("../entregasClienteService");
const { buscarPerformanceML } = require("../ads/mlAdsService");
const { blocoSeguro, envelopeIndisponivel } = require("./cliente360V3Envelope");

async function obterAds({ clienteSlug, marketplace, competencia, clienteContaId }, deps = {}) {
  if (marketplace !== "meli") {
    return envelopeIndisponivel({
      motivo: "Ads está disponível só para operações Mercado Livre.",
      codigo: "MARKETPLACE_NAO_SUPORTADO",
      escopo: "account",
    });
  }
  return blocoSeguro(async () => {
    const performance = await (deps.buscarPerformanceML || buscarPerformanceML)(
      clienteSlug, competencia, null, clienteContaId, { strictIdentity: true }
    );
    if (performance.semDados) {
      throw Object.assign(new Error(performance.motivo), { code: performance.codigo });
    }
    return performance;
  }, { escopo: "account", fonteNome: "ml_ads_service" });
}

async function obterSaude({ clienteId, clienteSlug, clienteContaId, marketplace }, deps = {}) {
  const [grantBase, sync, entrega] = await Promise.all([
    blocoSeguro(async () => {
      const contas = await (deps.listarContasDoCliente || listarContasDoCliente)({
        clienteId, marketplace, incluirInativas: true,
      });
      const conta = contas.find((c) => c.id === clienteContaId);
      if (!conta) throw new Error("Conta não encontrada para compor a saúde da operação.");
      return {
        grantConectado: conta.grant_token_status === "valid",
        grantStatus: conta.grant_token_status || null,
        baseVinculada: Boolean(conta.vinculo_base_slug),
        baseSlug: conta.vinculo_base_slug || null,
      };
    }, { escopo: "account", fonteNome: "cliente_conta_service" }),

    blocoSeguro(async () => {
      const runs = await (deps.listarSyncRuns || listarSyncRuns)({ clienteSlug, clienteContaId, limit: 5 });
      return { ultimasExecucoes: runs || [] };
    }, { escopo: "account", fonteNome: "central_vendas_sync_run_service" }),

    // CORREÇÃO (achado na investigação da Fase 6): entregas_cliente TEM
    // cliente_conta_id desde a P2.6 (ver entregasClienteService.js e
    // schemaReadiness.js — coluna REQUIRED, auto-ensured no boot). O
    // comentário anterior desta linha ("não tem cliente_conta_id") estava
    // desatualizado. Corrigido para filtrar pela conta ativa (com fallback
    // para entregas legadas, cliente_conta_id NULL, nunca escondidas) e
    // rotular o escopo REAL da linha encontrada — não uma etiqueta fixa.
    blocoSeguro(async () => {
      const { entregas } = await (deps.listarEntregas || listarEntregas)({
        query: { cliente_slug: clienteSlug, cliente_conta_id: clienteContaId, tipo: "fechamento_mensal", limit: 1 },
      });
      const ultimaEntrega = entregas?.[0] || null;
      return {
        ultimaEntrega,
        escopoEntrega: ultimaEntrega ? (ultimaEntrega.cliente_conta_id != null ? "account" : "client_legacy") : null,
      };
    }, { escopo: "account", fonteNome: "entregas_cliente_service" }),
  ]);

  return { grantBase, sync, entrega };
}

module.exports = { obterAds, obterSaude };
