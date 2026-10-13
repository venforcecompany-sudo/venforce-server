// server/services/visaoService.js
//
// GET /operacao/visao/:cliente?conta=&periodo= (VenForce V3 Master Spec
// §11.4, §18.3). Composição SERVER-SIDE de fontes já existentes — nenhum
// cálculo novo, nenhum dado inventado. Nome deliberadamente `/visao`, não
// `/workspace` (já ocupado por `GET /operacao/central-margem/:slug/workspace`,
// Motor de Margem — Master Spec §3.8 #2).
//
// Cada bloco é resolvido de forma INDEPENDENTE (uma falha não derruba os
// outros, mesmo padrão de `carregarConciliacaoMercadoPago` em
// fechamentos-api.js) e carrega `disponivel` + `escopoConta`:
//   - `escopoConta: true`  → o bloco já é account-aware (recebeu clienteContaId
//     e respeita a conta pedida: Central de Vendas, Ads, atividade/sync runs).
//   - `escopoConta: false` → o bloco ainda é só por CLIENTE (Cliente 360,
//     fechamento/relatórios) — nunca finge filtrar por
//     conta o que não filtra. Documentado, não escondido (ver
//     Squads_migration/VENFORCE_V3_BACKEND_READINESS.md §14).
//
// Este service NUNCA escolhe a conta sozinho: clienteContaId é obrigatório
// (a Visão só renderiza com o contexto já completo — Master Spec §7.2,
// estado READY) e é validado contra o cliente/ativo antes de qualquer
// composição, com os códigos canônicos já estabelecidos.

const {
  resolverClientePorIdOuSlug,
  obterConta,
  sanitizarConta,
} = require("./clienteContas/clienteContaService");
const { CODIGOS_CANONICOS } = require("../utils/erroContextoCanonico");
const { competenciaAtual } = require("../utils/periodoUtils");
const {
  normalizarCompetenciaEstrita,
  rangeDaCompetencia,
  mesmaCompetencia,
} = require("../utils/competenciaCanonica");
const { getCliente360 } = require("./cliente360/cliente360Service");
const { getCentralVendasReadBootstrap } = require("./centralVendas/centralVendasReadService");
const { obterResumo: obterResumoMargem } = require("./motorMargem/motorMargemService");
const { buscarPerformanceML } = require("./ads/mlAdsService");
const { listarEntregas } = require("./entregasClienteService");
const { listarSyncRuns } = require("./centralVendas/centralVendasSyncRunService");

function criarErroHttp(statusCode, mensagem, extra = {}) {
  const err = new Error(mensagem);
  err.statusCode = statusCode;
  Object.assign(err, extra);
  return err;
}

// Resolve e valida a conta pedida — marketplace é DERIVADO da conta (D10 do
// Master Spec), nunca um parâmetro separado. clienteContaId é obrigatório:
// a Visão nunca escolhe uma conta em silêncio.
async function resolverContaObrigatoria({ clienteSlugRaw, clienteContaIdRaw }, deps) {
  const cliente = await deps.resolverClientePorIdOuSlug({ clienteSlug: clienteSlugRaw });

  const clienteContaId = Number(clienteContaIdRaw);
  if (!Number.isInteger(clienteContaId) || clienteContaId <= 0) {
    throw criarErroHttp(400, "conta é obrigatória (?conta=<clienteContaId>).");
  }

  const contaRaw = await deps.obterConta(clienteContaId);
  if (contaRaw.cliente_id !== cliente.id) {
    throw criarErroHttp(403, "Esta conta não pertence ao cliente informado.", {
      code: CODIGOS_CANONICOS.CONTA_NAO_PERTENCE_AO_CLIENTE,
    });
  }
  if (contaRaw.ativo === false) {
    throw criarErroHttp(409, `A conta "${contaRaw.nome}" foi desativada.`, {
      code: CODIGOS_CANONICOS.CONTA_INATIVA,
    });
  }

  return { cliente, conta: deps.sanitizarConta(contaRaw) };
}

// V3 P2.5/P2.6 BLOCO C — competência nunca é inferida EM SILÊNCIO.
//
// Antes: `parseCompetencia(periodoRaw) || competenciaAtual()`. Isso tratava
// "não mandou" e "mandou errado" da mesma forma — `?periodo=lixo` respondia o
// MÊS ATUAL sem avisar. O usuário pedia Julho e recebia Agosto rotulado como
// se fosse o que ele pediu.
//
// Agora:
//   - período INVÁLIDO → 400 explícito. Não é breaking change para o frontend
//     já mergeado: `frontend-react/src/utils/periodoUrl.js` valida com
//     `ehCompetencia` antes de enviar, então só um cliente já quebrado manda
//     lixo — e esse merece o 400.
//   - período AUSENTE → segue no mês corrente (o contrato de /operacao/visao
//     sempre permitiu omitir; exigir agora quebraria consumidores legítimos),
//     mas isso passa a ser DECLARADO em `contexto.periodoInferido: true`.
//     Inferir e avisar é diferente de inferir em silêncio.
function resolverPeriodo(periodoRaw) {
  const informado = periodoRaw !== undefined && periodoRaw !== null && String(periodoRaw).trim() !== "";

  if (!informado) {
    const atual = competenciaAtual();
    return {
      competencia: atual.competencia,
      dateFrom: atual.dateFrom,
      dateTo: atual.dateTo,
      inferido: true,
    };
  }

  if (!normalizarCompetenciaEstrita(periodoRaw)) {
    // Mesmo erro canônico do Financeiro: PERIODO_INVALIDO / 400.
    throw criarErroHttp(400, "periodo inválido: use o formato YYYY-MM.", {
      code: CODIGOS_CANONICOS.PERIODO_INVALIDO,
    });
  }

  const { competencia, dateFrom, dateTo } = rangeDaCompetencia(periodoRaw);
  return { competencia, dateFrom, dateTo, inferido: false };
}

// Envelope uniforme de bloco — nunca lança para fora, nunca inventa dado
// quando a fonte falha ou não existe para este marketplace.
// Mesma ordem determinística do Financeiro (financeiroVisaoService): sem
// UNIQUE na tabela, duplicatas existem; o que não pode existir é a resposta
// MUDAR entre dois requests idênticos.
function compararEntregas(a, b) {
  const pubA = a.publicado === true || a.status === "publicado" ? 1 : 0;
  const pubB = b.publicado === true || b.status === "publicado" ? 1 : 0;
  if (pubA !== pubB) return pubB - pubA;
  const tA = Date.parse(a.created_at || "") || 0;
  const tB = Date.parse(b.created_at || "") || 0;
  if (tA !== tB) return tB - tA;
  return Number(b.id || 0) - Number(a.id || 0);
}

async function bloco({ escopoConta, aplicavel = true, motivoInaplicavel = null }, fn) {
  if (!aplicavel) {
    return { disponivel: false, escopoConta, motivo: motivoInaplicavel || "Não aplicável a este marketplace." };
  }
  try {
    const dados = await fn();
    return { disponivel: true, escopoConta, dados };
  } catch (err) {
    return { disponivel: false, escopoConta, motivo: err?.message || "Falha ao carregar este bloco." };
  }
}

async function obterVisao({ clienteSlugRaw, clienteContaIdRaw, periodoRaw }, deps = {}) {
  const d = {
    resolverClientePorIdOuSlug,
    obterConta,
    sanitizarConta,
    getCliente360,
    getCentralVendasReadBootstrap,
    obterResumoMargem,
    buscarPerformanceML,
    listarEntregas,
    listarSyncRuns,
    ...deps,
  };

  const { cliente, conta } = await resolverContaObrigatoria({ clienteSlugRaw, clienteContaIdRaw }, d);
  const periodo = resolverPeriodo(periodoRaw);
  const isMeli = conta.marketplace === "meli";

  const [saude, resultado, margem, ads, fechamento, atividade] = await Promise.all([
    // Cliente 360 não é account-aware — prontidão do CLIENTE inteiro, não
    // desta conta especificamente. Sempre disponível quando o cliente existe.
    bloco({ escopoConta: false }, () => d.getCliente360(cliente.slug, { competencia: periodo.competencia })),

    // Central de Vendas: account-aware de verdade.
    bloco({ escopoConta: true }, () =>
      d.getCentralVendasReadBootstrap(cliente.slug, {
        dateFrom: periodo.dateFrom, dateTo: periodo.dateTo,
        marketplace: conta.marketplace, clienteContaId: conta.id,
      })
    ),

    // Central de Margem: Conta explícita até o workspace, que valida Base/Grant.
    bloco({ escopoConta: true, aplicavel: isMeli, motivoInaplicavel: "Central de Margem está disponível só para operações Mercado Livre." }, () =>
      d.obterResumoMargem({ clienteSlug: cliente.slug, clienteContaId: conta.id, dateFrom: periodo.dateFrom, dateTo: periodo.dateTo })
    ),

    // Ads: só MELI, account-aware.
    bloco({ escopoConta: true, aplicavel: isMeli, motivoInaplicavel: "Ads está disponível só para operações Mercado Livre." }, () =>
      d.buscarPerformanceML(cliente.slug, periodo.competencia, null, conta.id, { strictIdentity: true })
    ),

    // Fechamento: entregas_cliente não tem cliente_conta_id — escopo é o
    // cliente inteiro. Filtra pela competência pedida no chamador (a query
    // do serviço não filtra por período).
    bloco({ escopoConta: false }, async () => {
      const { entregas } = await d.listarEntregas({
        query: { cliente_slug: cliente.slug, tipo: "fechamento_mensal", limit: 12 },
      });
      // BLOCO E — era `String(e.periodo).includes(competencia)`, que fazia uma
      // entrega gravada como "2026-07 a 2026-08" responder por Julho E por
      // Agosto. Agora é igualdade sobre a competência normalizada, com a mesma
      // ordem determinística do Financeiro quando há duplicata.
      const doPeriodo = (entregas || []).filter((e) => mesmaCompetencia(e.periodo, periodo.competencia));
      if (!doPeriodo.length) return null;
      return doPeriodo.sort(compararEntregas)[0];
    }),

    // Atividade (sync runs): account-aware.
    bloco({ escopoConta: true }, () =>
      d.listarSyncRuns({ clienteSlug: cliente.slug, clienteContaId: conta.id, limit: 10 })
    ),
  ]);

  return {
    contexto: { clienteId: cliente.id, clienteSlug: cliente.slug, clienteContaId: conta.id, marketplace: conta.marketplace, competencia: periodo.competencia, periodoInferido: periodo.inferido === true },
    saude,
    resultado,
    margem,
    ads,
    fechamento,
    atividade,
  };
}

module.exports = { obterVisao, resolverContaObrigatoria, resolverPeriodo };
