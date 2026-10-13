// server/services/fechamentoSnapshot/fechamentoSnapshotService.js
//
// Snapshot do fechamento — "este foi o estado financeiro calculado naquele
// momento", por conta × competência × revisão. Desenho em
// docs/financeiro/SNAPSHOT_FECHAMENTO_V3.md.
//
// REGRAS QUE ESTE MÓDULO EXISTE PARA GARANTIR:
//   · só se grava o que o MOTOR devolveu: o selo do processamento tem que
//     bater (seloProcessamento.verificar), senão 409 SELO_INVALIDO;
//   · o snapshot é da CONTA: ela tem que existir, pertencer ao cliente, ser do
//     marketplace do processamento e estar ativa — nunca uma conta escolhida
//     sozinha, nunca o cliente inteiro;
//   · competência explícita e canônica (AAAA-MM); nunca "mês atual";
//   · TODAS as linhas são gravadas (o limite de 50 era da apresentação);
//   · revisão incremental e imutável (repositório + trigger).
//
// Nada aqui calcula número financeiro: as contagens por status são leitura
// das linhas (itemDoSnapshot), e o summary é gravado como veio.

"use strict";

const repo = require("../../repositories/fechamentoSnapshotRepository");
const { verificar, CAMPOS_DO_RESULTADO } = require("./seloProcessamento");
const { itemDoSnapshot, contarItens, normalizarBusca, STATUS_PRINCIPAIS } = require("./itemDoSnapshot");
const { resolverClientePorIdOuSlug, obterConta } = require("../clienteContas/clienteContaService");
const { normalizarCompetencia } = require("../../utils/competenciaCanonica");
const { CODIGOS_CANONICOS } = require("../../utils/erroContextoCanonico");
const { registrarLog } = require("../activityLogService");

const MARKETPLACES = new Set(["meli", "shopee", "tiktok"]);
// Teto de sanidade (o body já é limitado a 20 MB pelo express.json). Uma
// conta grande de Shopee Order.all fica na casa de 10–20 mil linhas.
const MAX_LINHAS = 100000;

function erro(statusCode, code, mensagem, extra = {}) {
  const e = new Error(mensagem);
  e.statusCode = statusCode;
  e.code = code;
  e.payload = { ok: false, code, erro: mensagem, ...extra };
  return e;
}

function competenciaObrigatoria(valor) {
  const c = normalizarCompetencia(valor);
  if (!c) throw erro(400, "COMPETENCIA_INVALIDA", "Informe a competência do fechamento (AAAA-MM).");
  return c;
}

function contaIdObrigatorio(valor) {
  const id = Number(valor);
  if (!Number.isInteger(id) || id <= 0) {
    throw erro(400, "CONTA_OBRIGATORIA", "O snapshot é por conta: informe a conta (clienteContaId) do fechamento.");
  }
  return id;
}

// Cliente + conta provados (mesma regra de validarContaDoCliente do
// processamento). `exigirAtiva`: gravar exige conta ativa; LER histórico de
// uma conta desativada continua permitido.
async function resolverContexto({ clienteSlug, clienteContaId, marketplace = null, exigirAtiva = false }, d) {
  const contaId = contaIdObrigatorio(clienteContaId);
  const cliente = await d.resolverClientePorIdOuSlug({ clienteSlug });
  const conta = await d.obterConta(contaId);
  if (Number(conta.cliente_id) !== Number(cliente.id)) {
    throw erro(409, CODIGOS_CANONICOS.CONTA_NAO_PERTENCE_AO_CLIENTE, "Esta conta não pertence ao cliente informado.");
  }
  if (exigirAtiva && conta.ativo === false) {
    throw erro(409, CODIGOS_CANONICOS.CONTA_INATIVA, `A conta "${conta.nome}" foi desativada.`);
  }
  if (marketplace && String(conta.marketplace || "").toLowerCase() !== marketplace) {
    throw erro(409, "MARKETPLACE_DIVERGENTE", "O marketplace do fechamento não é o desta conta.");
  }
  return { cliente, conta };
}

const ehObjeto = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// Linha do banco → contrato da API (camelCase, sem o selo).
function paraDto(row, { comSummary = false, comDiagnostico = false } = {}) {
  if (!row) return null;
  const entregas = Array.isArray(row.entregas) ? row.entregas : [];
  const dto = {
    id: Number(row.id),
    clienteId: row.cliente_id,
    clienteSlug: row.cliente_slug,
    clienteContaId: row.cliente_conta_id,
    marketplace: row.marketplace,
    periodo: row.periodo,
    revisao: row.revisao,
    totalItens: row.total_itens,
    contagens: row.contagens_json || {},
    origemCustos: row.origem_custos_json || {},
    ajustes: row.ajustes_json || {},
    arquivos: Array.isArray(row.arquivos_json) ? row.arquivos_json : [],
    origem: row.origem,
    processadoEm: row.processado_em,
    processadoPor: row.processado_por ?? null,
    criadoPor: row.criado_por ?? null,
    criadoPorEmail: row.criado_por_email ?? null,
    criadoEm: row.created_at,
    entregas,
    publicado: entregas.some((e) => e.publicado === true),
  };
  if (comSummary) dto.summary = row.summary_json || {};
  if (comDiagnostico) dto.diagnostico = row.diagnostico_json || {};
  return dto;
}

async function criarSnapshot({ user = {}, body = {}, ip = null }, deps = {}) {
  const d = { resolverClientePorIdOuSlug, obterConta, repo, registrarLog, ...deps };

  const marketplace = String(body.marketplace || "").trim().toLowerCase();
  if (!MARKETPLACES.has(marketplace)) throw erro(400, "MARKETPLACE_INVALIDO", "Marketplace inválido.");
  const periodoBruto = body.periodo;
  const periodo = competenciaObrigatoria(periodoBruto);
  const resultado = ehObjeto(body.resultado) ? body.resultado : null;
  const processamento = ehObjeto(body.processamento) ? body.processamento : null;
  if (!resultado || !processamento || !ehObjeto(resultado.summary) || !Array.isArray(resultado.detailedRows)) {
    throw erro(400, "PROCESSAMENTO_AUSENTE", "Envie o resultado do processamento (summary, detailedRows e o bloco processamento).");
  }
  if (resultado.detailedRows.length > MAX_LINHAS) {
    throw erro(413, "LINHAS_DEMAIS", `O fechamento tem ${resultado.detailedRows.length} linhas; o limite do snapshot é ${MAX_LINHAS}.`);
  }

  const { cliente, conta } = await resolverContexto(
    { clienteSlug: body.clienteSlug, clienteContaId: body.clienteContaId, marketplace, exigirAtiva: true },
    d
  );

  // O selo cobre o CONTEXTO do processamento: salvar o resultado do Cliente
  // A como Cliente B, ou de Agosto como Setembro, também invalida.
  const contexto = {
    clienteSlug: body.clienteSlug ?? null,
    clienteContaId: Number(body.clienteContaId),
    periodo: periodoBruto ?? null,
    marketplace,
  };
  if (!verificar({ contexto, resultado, processamento }, processamento.selo)) {
    throw erro(409, "SELO_INVALIDO",
      "Este resultado não corresponde a um processamento do motor para esta conta e competência. Processe novamente antes de salvar.");
  }
  if (!processamento.processadoEm || Number.isNaN(Date.parse(processamento.processadoEm))) {
    throw erro(400, "PROCESSAMENTO_AUSENTE", "Processamento sem data.");
  }

  const ambiguos = new Set((resultado.summary.ambiguousCostIds || []).map((x) => String(x)));
  const itens = resultado.detailedRows.map((row, i) => itemDoSnapshot(row, i + 1, { ambiguousIds: ambiguos }));

  // Tudo o que o motor devolveu além do summary e das linhas — sem
  // interpretação (competência declarada, unmatched*, avisos, Onhold…).
  const diagnostico = {};
  for (const campo of CAMPOS_DO_RESULTADO) {
    if (["summary", "detailedRows", "costsSource", "costsBase"].includes(campo)) continue;
    if (resultado[campo] !== undefined) diagnostico[campo] = resultado[campo];
  }

  const { snapshot, reaproveitado } = await d.repo.criarSnapshot(
    {
      clienteId: cliente.id,
      clienteSlug: cliente.slug,
      clienteContaId: conta.id,
      marketplace,
      periodo,
      summary: resultado.summary,
      origemCustos: {
        costsSource: resultado.costsSource ?? null,
        costsBase: resultado.costsBase ?? null,
        custos: processamento.custos ?? null,
      },
      ajustes: processamento.ajustes ?? {},
      arquivos: Array.isArray(processamento.arquivos) ? processamento.arquivos : [],
      diagnostico,
      contagens: contarItens(itens),
      selo: processamento.selo,
      origem: "financeiro-v3",
      processadoEm: processamento.processadoEm,
      processadoPor: processamento.processadoPor ?? null,
      criadoPor: user.id ?? null,
      criadoPorEmail: user.email ?? null,
    },
    itens
  );

  if (!reaproveitado) {
    // Trilha de auditoria reutilizada (activity_logs): nunca lança.
    d.registrarLog({
      userId: user.id ?? null,
      userEmail: user.email ?? null,
      userNome: user.nome ?? null,
      acao: "financeiro_snapshot_criado",
      detalhes: {
        snapshotId: Number(snapshot.id),
        clienteSlug: cliente.slug,
        clienteContaId: conta.id,
        marketplace,
        periodo,
        revisao: snapshot.revisao,
        totalItens: itens.length,
        resultadoFinal: resultado.summary.finalResult ?? null,
      },
      ip,
    });
  }

  return { snapshot: paraDto(snapshot), reaproveitado };
}

async function listarSnapshots({ query = {} }, deps = {}) {
  const d = { resolverClientePorIdOuSlug, obterConta, repo, ...deps };
  const { cliente, conta } = await resolverContexto(
    { clienteSlug: query.cliente_slug ?? query.clienteSlug, clienteContaId: query.cliente_conta_id ?? query.clienteContaId },
    d
  );
  const periodo = query.periodo ? competenciaObrigatoria(query.periodo) : null;
  const rows = await d.repo.listarSnapshotsDaConta({ clienteContaId: conta.id, periodo, limit: query.limit });
  // Defesa em profundidade: a conta já é do cliente, mas um snapshot nunca é
  // devolvido sob outro cliente.
  return rows.filter((r) => Number(r.cliente_id) === Number(cliente.id)).map((r) => paraDto(r, { comSummary: true }));
}

async function buscarSnapshot({ id }, deps = {}) {
  const d = { repo, ...deps };
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw erro(400, "ID_INVALIDO", "id inválido.");
  const row = await d.repo.buscarSnapshot(n);
  if (!row) throw erro(404, "SNAPSHOT_NAO_ENCONTRADO", "Snapshot não encontrado.");
  return paraDto(row, { comSummary: true, comDiagnostico: true });
}

const FILTROS = new Set([...STATUS_PRINCIPAIS, "cancelados"]);

async function listarItensDoSnapshot({ id, query = {} }, deps = {}) {
  const d = { repo, ...deps };
  const n = Number(id);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(query.offset, 10) || 0, 0);
  const status = query.status && query.status !== "todos" ? String(query.status) : null;
  if (status && !FILTROS.has(status)) throw erro(400, "FILTRO_INVALIDO", "Filtro de status inválido.");
  const busca = normalizarBusca(query.busca || "").slice(0, 120);
  const r = await d.repo.listarItens({ snapshotId: n, offset, limit, status, busca });
  return {
    total: r.total,
    offset,
    limit,
    itens: r.itens.map((i) => ({ ordem: i.ordem, linha: i.linha })),
  };
}

module.exports = {
  criarSnapshot,
  listarSnapshots,
  buscarSnapshot,
  listarItensDoSnapshot,
  resolverContexto,
  paraDto,
  MAX_LINHAS,
};
