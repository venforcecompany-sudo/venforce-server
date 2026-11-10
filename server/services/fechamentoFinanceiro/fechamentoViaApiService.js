// server/services/fechamentoFinanceiro/fechamentoViaApiService.js
//
// Fechamento financeiro do Mercado Livre a partir da API (Central de Vendas),
// sem planilha. Lê o import PUBLISHED vigente da competência (o que o sync já
// trouxe da API do ML) e devolve o MESMO formato que POST /fechamentos/financeiro
// devolve para planilha ML (summary, detailedRows, unmatchedIds, metadados),
// para o front reusar montarPayloadFechamento e o relatório público renderizar
// igual. Ver docs/FECHAMENTO_VIA_API.md para o mapeamento chave a chave.
//
// Regras deste serviço:
// - Nenhum cálculo novo de faturamento: FAT e cobertura saem de
//   buildResumoCentralVendas e buildCoverage. O LC segue a planilha: é a soma
//   do LC dos pedidos com financeiro completo (tarifa de venda e frete
//   sincronizados) e com custo. Pedido com financeiro pendente fica FORA do LC
//   (nunca descontado como zero) e continua no faturamento. ADS, Venforce,
//   afiliados e custos fixos entram só no Resultado Final e nos índices
//   (computeTacos/computeTacox), com os mesmos helpers da planilha.
// - Quando a API não traz a fonte de uma chave do summary da planilha, a chave
//   vai como null. Nunca 0 inventado (Master Spec M6).
// - Custos (custosOrigem): "sync" usa os custos que o sync gravou; "base"
//   reaplica AGORA a base vinculada atual da conta; "upload" reaplica a
//   planilha enviada. A reaplicação usa as MESMAS funções do sync
//   (calcularResultadoItem & cia.) sobre receita/tarifa/frete persistidos:
//   só custo, imposto e o que deriva deles mudam.
// - Somente leitura: nada é gravado aqui (nem a base de custos — salvar a
//   planilha como base é o POST /importar-base). Salvar a entrega é do front.
// - Sync incompleto NÃO é erro: responde com sync.completo=false e o front pede
//   confirmação. Só a falta total de sync publicado vira 409 CENTRAL_SEM_SYNC.

const pool = require("../../config/database");
const {
  resolverClientePorIdOuSlug,
  obterConta,
  obterBaseDaConta,
} = require("../clienteContas/clienteContaService");
const centralVendasRepository = require("../centralVendas/centralVendasRepository");
const { buildResumoCentralVendas } = require("../centralVendas/centralVendasImportService");
const { pedidoEntraNoResultado } = require("../centralVendas/centralVendasService");
const {
  calcularResultadoItem,
  acumularItemNoPedido,
  finalizarResultadoPedido,
  buildCostMap,
  getCost,
  buscarCustosPorBaseId,
} = require("../centralVendas/centralVendasSyncService");
const { buildCentralCostMap, getCentralCostForAd } = require("./meliFinanceiroService");
const { parseSpreadsheet } = require("../../utils/excelUtils");
const {
  buildCoverage,
  safeRatio,
  computeTacos,
  computeTacox,
} = require("../../utils/fechamento/financeiroShared");
const { rangeDaCompetencia } = require("../../utils/competenciaCanonica");
const { compararCompetencias } = require("../../utils/competenciaDetectada");
const { parseMoneyValue } = require("../../utils/numberUtils");
const { CODIGOS_CANONICOS } = require("../../utils/erroContextoCanonico");

// Mesma regra da planilha: venda com tarifa de venda ou frete pendentes entra
// no faturamento, mas fica fora do LC, do MC e do Resultado Final.
const AVISO_FINANCEIRO_PENDENTE =
  "Parte das vendas ainda não possui tarifa de venda ou frete sincronizados da API do " +
  "Mercado Livre. Essas vendas entram no faturamento, mas ficam fora do LC, do MC e do " +
  "Resultado Final até os dados completarem.";

const AVISO_FONTE_API =
  "Fechamento calculado a partir da API do Mercado Livre (Central de Vendas). " +
  "As diferenças conhecidas em relação à planilha estão em docs/FECHAMENTO_VIA_API.md.";

// ─── utilidades ─────────────────────────────────────────────────────────────

function criarErro(statusCode, mensagem, extra = {}) {
  const err = new Error(mensagem);
  err.statusCode = statusCode;
  Object.assign(err, extra);
  return err;
}

function round2(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function numOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }
  return [];
}

// Data de calendário sem deslocamento de fuso: pg devolve DATE como Date à
// meia-noite LOCAL, então leio com getters locais (toISOString deslocaria o dia).
function isoDay(value) {
  if (!value) return null;
  if (value instanceof Date) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  return String(value).slice(0, 10);
}

function isoTimestamp(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function diaAnterior(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

// "Hoje" no fuso do negócio (America/Sao_Paulo), nunca o fuso do container.
function hojeSaoPaulo(agora = new Date()) {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(agora);
  const get = (type) => partes.find((p) => p.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function temPendencia(row, nome) {
  return asArray(row?.pendencias_json).includes(nome);
}

// Pedido com tarifa de venda e frete sincronizados. Sem qualquer um dos dois,
// o financeiro dele ainda está pendente (mesmo conceito da planilha).
function financeiroCompleto(pedido) {
  return !temPendencia(pedido, "tarifa_venda_ausente") && !temPendencia(pedido, "frete_seller_ausente");
}

function somaFaturamento(pedidos) {
  return round2(pedidos.reduce((s, p) => s + Number(p.faturamento || 0), 0));
}

// ─── parâmetros ─────────────────────────────────────────────────────────────

// Ajustes do fechamento: texto pt-BR ou número. Campo vazio vale zero; valor
// ambíguo é erro (nunca chuta o separador decimal).
function parseAjustesFechamentoApi(body) {
  const campos = [
    ["ads", "ADS"],
    ["venforce", "Venforce"],
    ["affiliates", "Afiliados"],
    ["fullCost", "FULL"],
    ["additionalCosts", "Custos adicionais"],
  ];
  const out = {};
  for (const [campo, label] of campos) {
    const parsed = parseMoneyValue(body?.[campo]);
    if (!parsed.valid) {
      throw criarErro(
        400,
        `${label}: formato monetário inválido ou ambíguo. Use, por exemplo, 3011, 3011.00 ou 3.011,00.`,
        { code: "AJUSTE_INVALIDO" }
      );
    }
    out[campo] = parsed.value;
  }
  return out;
}

// Cliente + conta + competência, com as mesmas travas do Financeiro visão:
// conta obrigatória, pertencer ao cliente, ativa e Mercado Livre.
async function resolverContextoFechamentoApi({ clienteSlugRaw, clienteContaIdRaw, periodoRaw, hojeIso = null }, deps) {
  // Período primeiro: PERIODO_OBRIGATORIO / PERIODO_INVALIDO já vêm do canônico.
  const { competencia, dateFrom, dateTo } = rangeDaCompetencia(periodoRaw);

  const cliente = await deps.resolverClientePorIdOuSlug({ clienteSlug: clienteSlugRaw });

  const clienteContaId = Number(clienteContaIdRaw);
  if (!Number.isInteger(clienteContaId) || clienteContaId <= 0) {
    throw criarErro(400, "conta é obrigatória (clienteContaId da conta do Mercado Livre).", {
      code: "CONTA_OBRIGATORIA",
    });
  }

  const contaRaw = await deps.obterConta(clienteContaId);
  if (Number(contaRaw.cliente_id) !== Number(cliente.id)) {
    throw criarErro(403, "Esta conta não pertence ao cliente informado.", {
      code: CODIGOS_CANONICOS.CONTA_NAO_PERTENCE_AO_CLIENTE,
    });
  }
  if (contaRaw.ativo === false) {
    throw criarErro(409, `A conta "${contaRaw.nome}" foi desativada.`, {
      code: CODIGOS_CANONICOS.CONTA_INATIVA,
    });
  }
  if (String(contaRaw.marketplace || "").toLowerCase() !== "meli") {
    throw criarErro(400, "O fechamento pela API só existe para contas do Mercado Livre.", {
      code: "FECHAMENTO_API_SO_MELI",
    });
  }

  // "Esperado" = o que o sync deveria ter coberto: o mês inteiro, ou até ontem
  // no mês em andamento (mesma regra do noturno: nunca o dia de hoje).
  const hoje = hojeIso || deps.hojeIso || hojeSaoPaulo();
  const ontem = diaAnterior(hoje);
  const esperadoAte = dateTo <= ontem ? dateTo : ontem;

  return {
    cliente,
    conta: { id: Number(contaRaw.id), nome: contaRaw.nome, marketplace: "meli" },
    competencia,
    inicio: dateFrom,
    fim: dateTo,
    esperadoAte,
  };
}

// ─── seleção do import vigente ──────────────────────────────────────────────

async function buscarImportPublicadoPorId(id, ctx, deps) {
  const { rows } = await deps.db.query(
    `SELECT id, competencia, resumo_json, publication_status, coverage_date_from,
            coverage_date_to, published_at, sync_run_id
       FROM central_vendas_imports
      WHERE id = $1 AND cliente_slug = $2 AND cliente_conta_id = $3
        AND marketplace = 'meli' AND publication_status = 'published'`,
    [id, ctx.cliente.slug, ctx.conta.id]
  );
  return rows[0] || null;
}

// Import que a Central usaria para a competência, pela MESMA seleção M4
// (resolveImportsForRange). Primeiro tenta o trecho esperado completo; se
// nenhum publicado cobre, usa o publicado mais recente da competência que o
// próprio diagnóstico da seleção aponta, e o sync sai como incompleto.
// Legado nunca conta: não tem cobertura comprovada.
async function selecionarImportVigente(ctx, deps) {
  const segmentoAte = ctx.esperadoAte >= ctx.inicio ? ctx.esperadoAte : ctx.fim;
  const resolvido = await deps.resolveImportsForRange(
    {
      clienteSlug: ctx.cliente.slug,
      dateFrom: ctx.inicio,
      dateTo: segmentoAte,
      marketplace: "meli",
      clienteContaId: ctx.conta.id,
      includeLegacy: false,
    },
    deps.db
  );

  const cobre = (resolvido.imports || []).find(
    (row) => row.competencia === ctx.competencia && row.publication_status === "published"
  );
  if (cobre) return cobre;

  const diagnostico = (resolvido.competencias || []).find((c) => c.competencia === ctx.competencia);
  const publicadoMaisRecente = diagnostico?.publicadoMaisRecente;
  if (!publicadoMaisRecente?.id) return null;
  return buscarImportPublicadoPorId(publicadoMaisRecente.id, ctx, deps);
}

function montarSync(imp, ctx) {
  const coberturaDe = isoDay(imp.coverage_date_from);
  const coberturaAte = isoDay(imp.coverage_date_to);
  const motivos = [];
  if (coberturaDe && coberturaDe > ctx.inicio) {
    motivos.push(`A sincronização começa em ${coberturaDe}; o período começa em ${ctx.inicio}.`);
  }
  if (ctx.esperadoAte >= ctx.inicio && (!coberturaAte || coberturaAte < ctx.esperadoAte)) {
    motivos.push(
      `A sincronização cobre até ${coberturaAte || "—"}; o esperado é até ${ctx.esperadoAte}.`
    );
  }
  const completo = motivos.length === 0;
  return {
    disponivel: true,
    importId: Number(imp.id),
    publicadoEm: isoTimestamp(imp.published_at),
    coberturaDe,
    coberturaAte,
    completo,
    motivoIncompleto: completo ? null : motivos.join(" "),
  };
}

const SYNC_INDISPONIVEL = Object.freeze({
  disponivel: false,
  importId: null,
  publicadoEm: null,
  coberturaDe: null,
  coberturaAte: null,
  completo: false,
  motivoIncompleto: "Mês ainda não sincronizado.",
});

// Base de custos que o sync usou (central_vendas_sync_runs.base_id, ou a do
// próprio import) e o instante em que os custos foram lidos: o início do run.
// Uso o início, não o publicadoEm, porque o sync lê a base no começo — uma
// alteração durante o run já não entrou.
async function buscarBaseDoSync(imp, deps) {
  const { rows } = await deps.db.query(
    `SELECT b.id, b.slug, b.nome,
            COALESCE(r.started_at, r.created_at, i.published_at) AS aplicada_em
       FROM central_vendas_imports i
       LEFT JOIN central_vendas_sync_runs r ON r.id = i.sync_run_id
       JOIN bases b ON b.id = COALESCE(r.base_id, i.base_id)
      WHERE i.id = $1`,
    [imp.id]
  );
  const base = rows[0];
  if (!base) return null;
  return {
    id: Number(base.id),
    slug: base.slug ?? null,
    nome: base.nome ?? null,
    aplicadaEm: isoTimestamp(base.aplicada_em),
  };
}

// Base vinculada ATUAL da conta (mesma resolução do sync: obterBaseDaConta) e
// quando ela mudou pela última vez: o maior entre bases.updated_at e o
// updated_at dos custos dela (as telas de custo nem sempre tocam a base).
// As colunas são TIMESTAMP sem fuso; o cast para timestamptz no banco usa o
// mesmo fuso de sessão que gravou o CURRENT_TIMESTAMP.
async function buscarBaseAtual(ctx, deps) {
  const vinculo = await deps.obterBaseDaConta(ctx.conta.id, deps.db);
  if (!vinculo?.base_id) return null;
  const { rows } = await deps.db.query(
    `SELECT b.id, b.slug, b.nome,
            GREATEST(b.updated_at, (SELECT MAX(c.updated_at) FROM custos c WHERE c.base_id = b.id))::timestamptz
              AS atualizada_em
       FROM bases b
      WHERE b.id = $1`,
    [vinculo.base_id]
  );
  const base = rows[0];
  return {
    id: Number(vinculo.base_id),
    slug: base?.slug ?? vinculo.slug ?? null,
    nome: base?.nome ?? vinculo.nome ?? null,
    atualizadaEm: isoTimestamp(base?.atualizada_em),
  };
}

// status.base: a base que vale HOJE e se foi ela (sem alteração posterior) que
// o sync aplicou. Sem import, sem base no run, base trocada ou base alterada
// depois do sync ⇒ aplicadaNoSync=false (o front oferece custosOrigem=base).
// Sem data de alteração conhecida não dá para provar que mudou: conta como
// aplicada se for a mesma base.
function montarBaseStatus(baseAtual, baseDoSync) {
  if (!baseAtual) {
    return { vinculada: false, id: null, slug: null, nome: null, atualizadaEm: null, aplicadaNoSync: false };
  }
  const mesmaBase = !!baseDoSync && baseDoSync.id === baseAtual.id;
  const mudouDepois =
    !!baseAtual.atualizadaEm &&
    !!baseDoSync?.aplicadaEm &&
    new Date(baseAtual.atualizadaEm).getTime() > new Date(baseDoSync.aplicadaEm).getTime();
  return {
    vinculada: true,
    id: baseAtual.id,
    slug: baseAtual.slug,
    nome: baseAtual.nome,
    atualizadaEm: baseAtual.atualizadaEm,
    aplicadaNoSync: mesmaBase && !mudouDepois,
  };
}

function baseResumo(base) {
  return base ? { id: base.id, slug: base.slug ?? null, nome: base.nome ?? null } : null;
}

// ─── origem dos custos ──────────────────────────────────────────────────────

const CUSTOS_ORIGENS = ["sync", "base", "upload"];

function parseCustosOrigem(raw, arquivo) {
  const texto = raw === undefined || raw === null ? "" : String(raw).trim().toLowerCase();
  const origem = texto || "sync";
  if (!CUSTOS_ORIGENS.includes(origem)) {
    throw criarErro(400, `custosOrigem inválido: use ${CUSTOS_ORIGENS.join(", ")}.`, {
      code: "CUSTOS_ORIGEM_INVALIDA",
    });
  }
  if (origem === "upload" && !arquivo?.buffer?.length) {
    throw criarErro(400, "Envie a planilha de custos (campo costs) para usar custosOrigem=upload.", {
      code: "CUSTOS_ARQUIVO_OBRIGATORIO",
    });
  }
  // Arquivo com outra origem seria ignorado em silêncio — e a pessoa acharia
  // que o fechamento usou a planilha dela.
  if (origem !== "upload" && arquivo?.buffer?.length) {
    throw criarErro(400, "A planilha de custos só é usada com custosOrigem=upload.", {
      code: "CUSTOS_ORIGEM_INVALIDA",
    });
  }
  return origem;
}

// Planilha de custos enviada: o MESMO parser do upload de custos ML do
// fechamento por planilha (parseSpreadsheet do arquivo inteiro) e o mesmo
// mapa de custos que o motor de planilha da Central usa (buildCentralCostMap,
// que entende as mesmas colunas de parseMeliCostRows).
function lerPlanilhaCustos(arquivo) {
  let linhas;
  try {
    linhas = parseSpreadsheet(arquivo.buffer);
  } catch (_) {
    linhas = null;
  }
  const mapa = Array.isArray(linhas) ? buildCentralCostMap(linhas) : new Map();
  // O mapa guarda 3 chaves por MLB; conto entradas distintas com custo.
  const comCusto = new Set([...mapa.values()].filter((e) => e.hasCost)).size;
  if (comCusto === 0) {
    throw criarErro(
      422,
      "Nenhuma linha de custo reconhecida na planilha. Ela precisa de uma coluna de anúncio (ex.: \"# de anúncio\" ou \"MLB\") e uma de custo (ex.: \"Preço de custo\").",
      { code: "CUSTOS_PLANILHA_INVALIDA" }
    );
  }
  return {
    obterCusto: (mlb) => getCentralCostForAd(mapa, mlb),
    fonte: "planilha_custos",
    custosReconhecidos: comCusto,
  };
}

async function lerCustosDaBase(base, deps) {
  const custos = await deps.buscarCustosPorBaseId(base.id, deps.db);
  const mapa = buildCostMap(custos);
  return {
    obterCusto: (mlb) => getCost(mapa, mlb),
    fonte: "base_vinculada",
    custosReconhecidos: new Set([...mapa.values()].filter((e) => e.hasCost)).size,
  };
}

// ─── reaplicação de custos sobre os itens sincronizados ─────────────────────

// Pendências que calcularResultadoItem decide. Qualquer outra persistida no
// item é preservada como veio.
const PENDENCIAS_DO_MOTOR = new Set([
  "produto_ausente",
  "custo_produto_ausente",
  "tarifa_venda_ausente",
  "imposto_interno_ausente",
  "frete_seller_ausente",
  "frete_pack_incompleto",
]);

function valorPositivoDoComponente(componente) {
  if (!componente || componente.valor === null || componente.valor === undefined) return null;
  const n = Number(componente.valor);
  return Number.isFinite(n) ? -n : null;
}

// Troca custo_produto/imposto_interno dos itens pelos de `obterCusto` e
// recalcula o que deriva deles (LC, margem, confiança, pendências), item e
// pedido, com as MESMAS funções do sync (calcularResultadoItem,
// acumularItemNoPedido, finalizarResultadoPedido). Receita, tarifa, frete e
// reembolso continuam os persistidos (vieram da API). Função pura: devolve
// novas linhas no formato do banco, não grava nada.
function reaplicarCustos({ pedidos, itens, componentes, obterCusto, fonte = "base_vinculada" }) {
  const chaveItem = (pedidoRowId, itemId) => `${pedidoRowId}|${itemId}`;
  const porItem = new Map();
  for (const c of componentes) {
    if (c.tipo !== "tarifa_venda" && c.tipo !== "frete_seller") continue;
    const chaves = [];
    if (c.item_row_id != null) chaves.push(`row:${c.item_row_id}`);
    if (c.item_id != null) chaves.push(chaveItem(c.pedido_row_id, c.item_id));
    for (const k of chaves) {
      if (!porItem.has(k)) porItem.set(k, {});
      porItem.get(k)[c.tipo] = c;
    }
  }
  const componentesDoItem = (item) =>
    (item.id != null && porItem.get(`row:${item.id}`)) || porItem.get(chaveItem(item.pedido_row_id, item.item_id)) || {};

  const acumuladores = new Map();
  for (const p of pedidos) {
    acumuladores.set(String(p.id), {
      quantidadeItens: 0,
      faturamento: 0,
      lucroContribuicao: 0,
      resultado: 0,
      margemContribuicaoPercentual: null,
      confianca: "confiavel",
      pendencias: [],
      _temResultado: false,
    });
  }

  const recalculadoPorItem = new Map();
  const novosItens = itens.map((item) => {
    const quantidade = Number(item.quantidade || 0);
    const receitaProduto = numOrNull(item.receita_produto);
    const pendenciasPersistidas = asArray(item.pendencias_json);
    const comps = componentesDoItem(item);
    const r = calcularResultadoItem({
      // Mesma regra de "produto presente" do motor.
      hasProduct: !!item.mlb && quantidade > 0 && receitaProduto != null,
      quantidade,
      receitaProduto,
      tarifaVendaTotal: valorPositivoDoComponente(comps.tarifa_venda),
      freteItem: valorPositivoDoComponente(comps.frete_seller),
      costEntry: item.mlb ? obterCusto(item.mlb) : null,
      packIncompleto: pendenciasPersistidas.includes("frete_pack_incompleto"),
    });
    const pendencias = [
      ...r.pendencias,
      ...pendenciasPersistidas.filter((p) => !PENDENCIAS_DO_MOTOR.has(p) && !r.pendencias.includes(p)),
    ];

    const acc = acumuladores.get(String(item.pedido_row_id));
    if (acc) {
      acumularItemNoPedido(acc, {
        quantidade,
        receitaProduto,
        lucroContribuicao: r.lucroContribuicao,
        pendencias,
        confianca: r.confianca,
      });
    }
    if (item.id != null) recalculadoPorItem.set(String(item.id), r);
    recalculadoPorItem.set(chaveItem(item.pedido_row_id, item.item_id), r);

    return {
      ...item,
      custo_produto: r.custoProduto,
      imposto_interno: r.impostoInterno,
      lucro_contribuicao: r.lucroContribuicao,
      resultado: r.lucroContribuicao,
      margem_contribuicao_percentual: r.margemContribuicaoPercentual,
      confianca: r.confianca,
      pendencias_json: pendencias,
    };
  });

  const novosPedidos = pedidos.map((p) => {
    const acc = acumuladores.get(String(p.id));
    finalizarResultadoPedido(acc);
    const extras = asArray(p.pendencias_json).filter((x) => !PENDENCIAS_DO_MOTOR.has(x) && !acc.pendencias.includes(x));
    return {
      ...p,
      // Faturamento é da API e não depende de custo: fica o persistido.
      confianca: acc.confianca,
      lucro_contribuicao: acc.lucroContribuicao,
      resultado: acc.resultado,
      margem_contribuicao_percentual: acc.margemContribuicaoPercentual,
      pendencias_json: [...acc.pendencias, ...extras],
    };
  });

  // Componentes de custo/imposto acompanham o item (consistência do payload);
  // os demais ficam como vieram.
  const novosComponentes = componentes.map((c) => {
    if (c.tipo !== "custo_produto" && c.tipo !== "imposto_interno") return c;
    const r =
      (c.item_row_id != null && recalculadoPorItem.get(String(c.item_row_id))) ||
      recalculadoPorItem.get(chaveItem(c.pedido_row_id, c.item_id));
    if (!r) return c;
    const temValor = c.tipo === "custo_produto" ? r.hasCost : r.hasTax;
    const valor = c.tipo === "custo_produto" ? r.custoProduto : r.impostoInterno;
    return {
      ...c,
      valor: temValor && valor !== null ? round2(-valor) : null,
      fonte: temValor ? fonte : "ausente",
      confianca: temValor ? "real" : c.tipo === "custo_produto" ? "bloqueado" : "ausente",
    };
  });

  return { pedidos: novosPedidos, itens: novosItens, componentes: novosComponentes };
}

async function buscarRunEmAndamento(ctx, deps) {
  const { rows } = await deps.db.query(
    `SELECT id, status, created_at
       FROM central_vendas_sync_runs
      WHERE cliente_conta_id = $1 AND marketplace = 'meli' AND status IN ('queued','running')
      ORDER BY id DESC
      LIMIT 1`,
    [ctx.conta.id]
  );
  const run = rows[0];
  return run ? { id: Number(run.id), status: run.status, criadoEm: isoTimestamp(run.created_at) } : null;
}

// ─── consolidação (função pura, testável sem banco) ─────────────────────────

const TIPO_FINANCEIRO_PENDENTE = "financeiro pendente";

function coberturaDoItem(item) {
  if (temPendencia(item, "custo_produto_ausente")) return "sem custo";
  if (temPendencia(item, "tarifa_venda_ausente") || temPendencia(item, "frete_seller_ausente")) {
    return TIPO_FINANCEIRO_PENDENTE;
  }
  return "com custo";
}

// Mesma regra de agrupamento da planilha: o rótulo do grupo só fica "puro" se
// todos os itens do anúncio tiverem o mesmo estado; misturado vira "parcial".
function coberturaDoGrupo(coberturas) {
  const unicos = new Set(coberturas);
  if (unicos.size === 1) return [...unicos][0];
  return "parcial";
}

// `pedidoRowIdsBaseLc`: pedidos que entram na base do LC (financeiro completo e
// com custo). LC e MC do anúncio só somam esses itens; a receita fora da base
// continua em "Venda Total".
function agregarDetalhamento(itensValidos, pedidoRowIdsBaseLc) {
  const porAnuncio = new Map();
  for (const item of itensValidos) {
    const id = item.mlb || "SEM_ID";
    if (!porAnuncio.has(id)) {
      porAnuncio.set(id, {
        "# de anúncio": id,
        "Título do anúncio": item.titulo || null,
        SKU: item.sku || null,
        Unidades: 0,
        "Preço unitário de venda do anúncio (BRL)": numOrNull(item.valor_unitario),
        "Venda Total": 0,
        "Total (BRL)": null,
        "Preço de custo total": null,
        "Ajuste plataforma (BRL)": null,
        LC: null,
        _receitaBaseLc: 0,
        _coberturas: [],
      });
    }
    const acc = porAnuncio.get(id);
    acc.Unidades = round2(acc.Unidades + Number(item.quantidade || 0));
    acc["Venda Total"] = round2(acc["Venda Total"] + Number(item.receita_produto || 0));

    // null + null = null (desconhecido), null + número = número: um anúncio
    // inteiro sem custo não pode virar custo total 0.
    const custo = numOrNull(item.custo_produto);
    if (custo !== null) acc["Preço de custo total"] = round2((acc["Preço de custo total"] || 0) + custo);

    if (pedidoRowIdsBaseLc.has(String(item.pedido_row_id))) {
      const lc = numOrNull(item.lucro_contribuicao);
      if (lc !== null) acc.LC = round2((acc.LC || 0) + lc);
      acc._receitaBaseLc = round2(acc._receitaBaseLc + Number(item.receita_produto || 0));
    }

    acc._coberturas.push(coberturaDoItem(item));
  }

  return [...porAnuncio.values()].map(({ _coberturas, _receitaBaseLc, ...row }) => ({
    ...row,
    "Cobertura de custo": coberturaDoGrupo(_coberturas),
    MC:
      row.LC === null
        ? null
        : _receitaBaseLc > 0
          ? round2((row.LC / _receitaBaseLc) * 100)
          : 0,
  }));
}

// Consolida o summary com as MESMAS chaves de processMeli (planilha). Função
// pura: recebe pedidos/itens/componentes já lidos do banco (linhas snake_case).
function consolidarFechamentoApi({ pedidos, itens, componentes, ajustes }) {
  const validos = pedidos.filter(pedidoEntraNoResultado);
  const foraDoResultado = pedidos.filter((p) => !pedidoEntraNoResultado(p));

  // FAT, com/sem custo e bloqueada: o cálculo oficial da Central (o LC do
  // resumo não é usado — ver base do LC abaixo).
  const resumo = buildResumoCentralVendas({ pedidos });
  const grossRevenueTotal = resumo.faturamento;
  const revenueWithCost = resumo.faturamentoComCusto;
  const revenueWithoutCost = resumo.receitaBloqueada;
  const coverage = buildCoverage({ revenueWithCost, revenueWithoutCost });

  // Financeiro (tarifa/frete) disponível × pendente, por pedido válido.
  const completos = validos.filter(financeiroCompleto);
  const pendentes = validos.filter((p) => !financeiroCompleto(p));
  const revenueWithFinancialData = somaFaturamento(completos);
  const revenuePendingFinancial = somaFaturamento(pendentes);
  const financialDataCoveragePercent =
    grossRevenueTotal > 0 ? round2((revenueWithFinancialData / grossRevenueTotal) * 100) : null;

  // Base do LC, como na planilha: pedidos válidos com financeiro completo E com
  // custo (LC calculado). Pendente fica fora, nunca descontado como zero. Sem
  // nenhum pedido na base, o LC é null (não zero).
  const baseLc = validos.filter(
    (p) => financeiroCompleto(p) && p.lucro_contribuicao !== null && p.lucro_contribuicao !== undefined
  );
  const pedidoRowIdsBaseLc = new Set(baseLc.map((p) => String(p.id)));
  const LC = baseLc.length
    ? round2(baseLc.reduce((s, p) => s + Number(p.lucro_contribuicao || 0), 0))
    : null;
  const revenueCalculable = somaFaturamento(baseLc);

  const ads = round2(ajustes.ads);
  const venforce = round2(ajustes.venforce);
  const affiliates = round2(ajustes.affiliates);
  const fullCost = round2(ajustes.fullCost);
  const additionalCosts = round2(ajustes.additionalCosts);

  // Resultado Final só existe com LC. LC null vira null, nunca 0.
  const finalResult =
    LC === null ? null : round2(LC - ads - venforce - affiliates - fullCost - additionalCosts);

  // Reembolsos: componente pedido-level (Orders API payments). A planilha
  // mede por linha; a API mede por pedido — diferença documentada.
  const reembolsos = componentes.filter((c) => c.tipo === "cancelamento_reembolso" && c.valor !== null);
  const refundsTotal = round2(reembolsos.reduce((s, c) => s + Number(c.valor || 0), 0));
  const pedidosComReembolso = new Set(reembolsos.map((c) => String(c.pedido_row_id)));
  const lostRevenueTotal = round2(
    itens
      .filter((i) => pedidosComReembolso.has(String(i.pedido_row_id)))
      .reduce((s, i) => s + Number(i.receita_produto || 0), 0)
  );

  const validosRowIds = new Set(validos.map((p) => String(p.id)));
  const itensValidos = itens.filter((i) => validosRowIds.has(String(i.pedido_row_id)));
  const detailedRows = agregarDetalhamento(itensValidos, pedidoRowIdsBaseLc);

  const unmatchedIds = [
    ...new Set(
      itensValidos
        .filter((i) => temPendencia(i, "custo_produto_ausente"))
        .map((i) => i.mlb || "SEM_ID")
    ),
  ];

  const excludedStatusRevenue = somaFaturamento(foraDoResultado);

  const coberturaFinanceiraConfianca =
    revenuePendingFinancial > 0 && coverage.financialConfidence === "confiavel"
      ? "parcial"
      : coverage.financialConfidence;

  const executiveNotes = [];
  if (unmatchedIds.length > 0) {
    executiveNotes.push(
      `Fechamento parcial: ${unmatchedIds.length} anúncio(s) sem custo cadastrado. ` +
        "O faturamento total está completo; LC, MC e Resultado Final cobrem apenas a receita com custo e financeiro completo."
    );
  }
  if (revenuePendingFinancial > 0) executiveNotes.push(AVISO_FINANCEIRO_PENDENTE);
  if (foraDoResultado.length > 0) {
    executiveNotes.push(
      `${foraDoResultado.length} venda(s) fora do resultado por status (cancelado/devolvido/reembolsado/mediação). ` +
        "Não entram no faturamento do fechamento."
    );
  }
  executiveNotes.push(AVISO_FONTE_API);

  const summary = {
    grossRevenueTotal,
    refundsTotal,
    cancelledRevenue: refundsTotal,
    refundsCount: pedidosComReembolso.size,
    lostRevenueTotal,
    // Não gravado pelo motor da API (Total (BRL) do relatório de vendas): sem fonte honesta.
    paidRevenueTotal: null,
    contributionProfitTotal: LC,
    // Mesma função da planilha; sem LC a margem é null, nunca 0.
    averageContributionMargin: LC === null ? null : safeRatio(LC, revenueCalculable),
    finalResult,
    fullCostTotal: fullCost,
    additionalCostsTotal: additionalCosts,
    tacos: computeTacos(ads, grossRevenueTotal),
    tacox: computeTacox(ads, venforce, affiliates, grossRevenueTotal),
    // Ajuste de plataforma é só do motor da planilha; a API não o grava.
    platformAdjustmentTotal: null,
    platformAdjustmentRowsCount: null,
    calculationMode: "real_meli_vendas",
    revenueWithCost: coverage.revenueWithCost,
    revenueWithoutCost: coverage.revenueWithoutCost,
    calculatedCoveragePercent: coverage.calculatedCoveragePercent,
    financialConfidence: coberturaFinanceiraConfianca,
    revenueWithFinancialData,
    revenuePendingFinancial,
    revenueCalculable,
    financialDataCoveragePercent,
    salesWithFinancialDataCount: completos.length,
    salesPendingFinancialCount: pendentes.length,
    pendingFinancialWarning: revenuePendingFinancial > 0 ? AVISO_FINANCEIRO_PENDENTE : null,
    // Conflito de custo por MLB não é gravado pelo sync: null = não avaliado, não "sem conflito".
    costConflicts: null,
    costConflictWarnings: null,
    ambiguousCostIds: null,
    contributionMarginCalculated: LC === null ? null : safeRatio(LC, revenueCalculable),
    finalMarginCalculated: finalResult === null ? null : safeRatio(finalResult, revenueCalculable),
    profitCoversRevenue: revenueCalculable,
    excludedStatusRevenue,
    excludedStatusCount: foraDoResultado.length,
    adsTotal: ads,
    venforceTotal: venforce,
    affiliatesTotal: affiliates,
    executiveNotes,
  };

  return {
    summary,
    detailedRows,
    unmatchedIds,
    ignoredRowsWithoutCost: unmatchedIds.length,
    ignoredRevenue: revenueWithoutCost,
    emptySales: validos.length === 0,
    message:
      validos.length === 0
        ? "Sincronização válida sem vendas no período."
        : unmatchedIds.length > 0
          ? "Alguns anúncios do MELI não possuem custo cadastrado. O faturamento foi preservado; LC e MC cobrem apenas a receita com custo."
          : "OK",
  };
}

// ─── entradas públicas ──────────────────────────────────────────────────────

function defaultDeps() {
  return {
    db: pool,
    resolverClientePorIdOuSlug,
    obterConta,
    resolveImportsForRange: centralVendasRepository.resolveImportsForRange,
    loadPedidosByImportIds: centralVendasRepository.loadPedidosByImportIds,
    obterBaseDaConta,
    buscarCustosPorBaseId,
    hojeIso: null,
  };
}

// GET /financeiro/:cliente/fechamento-api/status — o que a API tem para a
// competência, sem calcular nada.
async function obterStatusFechamentoViaApi({ clienteSlugRaw, clienteContaIdRaw, periodoRaw }, depsOverride = {}) {
  const deps = { ...defaultDeps(), ...depsOverride };
  const ctx = await resolverContextoFechamentoApi({ clienteSlugRaw, clienteContaIdRaw, periodoRaw }, deps);
  const imp = await selecionarImportVigente(ctx, deps);
  const runEmAndamento = await buscarRunEmAndamento(ctx, deps);
  const baseAtual = await buscarBaseAtual(ctx, deps);
  const baseDoSync = imp ? await buscarBaseDoSync(imp, deps) : null;
  return {
    marketplace: "meli",
    periodo: ctx.competencia,
    sync: imp ? montarSync(imp, ctx) : { ...SYNC_INDISPONIVEL },
    runEmAndamento,
    base: montarBaseStatus(baseAtual, baseDoSync),
  };
}

// Custos que valem para este fechamento, conforme custosOrigem:
// - sync: os gravados pelo sync (nada é recalculado);
// - base: a base vinculada ATUAL da conta, reaplicada agora;
// - upload: a planilha enviada, reaplicada agora.
// Devolve as linhas (talvez recalculadas), a base declarada e uma nota.
async function resolverCustos({ origem, arquivo, planilhaCustos, imp, ctx, linhas, deps }) {
  if (origem === "sync") {
    return { linhas, costsBase: baseResumo(await buscarBaseDoSync(imp, deps)), nota: null };
  }

  if (origem === "base") {
    const baseAtual = await buscarBaseAtual(ctx, deps);
    if (!baseAtual) {
      throw criarErro(
        409,
        "Esta conta não tem base de custos vinculada. Envie uma planilha de custos ou vincule uma base.",
        { code: "BASE_NAO_VINCULADA" }
      );
    }
    const custos = await lerCustosDaBase(baseAtual, deps);
    const nomeBase = baseAtual.nome || baseAtual.slug || `#${baseAtual.id}`;
    return {
      linhas: reaplicarCustos({ ...linhas, obterCusto: custos.obterCusto, fonte: custos.fonte }),
      costsBase: baseResumo(baseAtual),
      nota:
        custos.custosReconhecidos > 0
          ? `Custos recalculados agora com a base vinculada atual "${nomeBase}".`
          : `A base vinculada "${nomeBase}" não tem custos cadastrados: as vendas ficam sem custo.`,
    };
  }

  const custos = planilhaCustos || lerPlanilhaCustos(arquivo);
  const nomeArquivo = arquivo?.originalname ? ` (${arquivo.originalname})` : "";
  return {
    linhas: reaplicarCustos({ ...linhas, obterCusto: custos.obterCusto, fonte: custos.fonte }),
    costsBase: null,
    nota: `Custos da planilha enviada${nomeArquivo}: ${custos.custosReconhecidos} anúncio(s) com custo.`,
  };
}

// POST /financeiro/:cliente/fechamento-api — gera o resultado a partir do
// import publicado. Leitura pura: o front salva a entrega pelo fluxo atual.
async function gerarFechamentoViaApi(
  { clienteSlugRaw, clienteContaIdRaw, periodoRaw, ajustesRaw, custosOrigemRaw, custosArquivo = null },
  depsOverride = {}
) {
  const deps = { ...defaultDeps(), ...depsOverride };
  const ctx = await resolverContextoFechamentoApi({ clienteSlugRaw, clienteContaIdRaw, periodoRaw }, deps);
  const ajustes = parseAjustesFechamentoApi(ajustesRaw);
  const custosOrigem = parseCustosOrigem(custosOrigemRaw, custosArquivo);
  // Planilha inválida falha antes de qualquer leitura pesada.
  const planilhaCustos = custosOrigem === "upload" ? lerPlanilhaCustos(custosArquivo) : null;

  const imp = await selecionarImportVigente(ctx, deps);
  if (!imp) {
    throw criarErro(
      409,
      "Não há sincronização da Central de Vendas para esta competência. Sincronize o mês antes de fechar pela API.",
      { code: "CENTRAL_SEM_SYNC" }
    );
  }

  const persistidas = await deps.loadPedidosByImportIds(
    { importIds: [imp.id], dateFrom: ctx.inicio, dateTo: ctx.fim },
    deps.db
  );

  const custos = await resolverCustos({
    origem: custosOrigem,
    arquivo: custosArquivo,
    planilhaCustos,
    imp,
    ctx,
    linhas: persistidas,
    deps,
  });

  const consolidado = consolidarFechamentoApi({
    pedidos: custos.linhas.pedidos,
    itens: custos.linhas.itens,
    componentes: custos.linhas.componentes,
    ajustes,
  });
  if (custos.nota) consolidado.summary.executiveNotes.push(custos.nota);

  const sync = montarSync(imp, ctx);
  if (!sync.completo) consolidado.summary.executiveNotes.push(`Sincronização incompleta: ${sync.motivoIncompleto}`);

  return {
    ok: true,
    fonteVendas: "api",
    summary: consolidado.summary,
    competencia: compararCompetencias({
      periodoSolicitado: ctx.competencia,
      deteccao: { competencia: ctx.competencia, multiplasCompetencias: false, dataMin: null, dataMax: null },
    }),
    detailedRows: consolidado.detailedRows,
    unmatchedIds: consolidado.unmatchedIds,
    unmatchedCosts: [],
    ignoredRowsWithoutCost: consolidado.ignoredRowsWithoutCost,
    ignoredRevenue: consolidado.ignoredRevenue,
    emptySales: consolidado.emptySales,
    message: consolidado.message,
    costsSource: custosOrigem,
    costsBase: custos.costsBase,
    sync,
    runEmAndamento: await buscarRunEmAndamento(ctx, deps),
    // Planilha em Excel não é gerada pela API; o front monta o que precisar.
    excelBase64: null,
  };
}

module.exports = {
  obterStatusFechamentoViaApi,
  gerarFechamentoViaApi,
  consolidarFechamentoApi,
  reaplicarCustos,
  montarBaseStatus,
  parseCustosOrigem,
  lerPlanilhaCustos,
  parseAjustesFechamentoApi,
  resolverContextoFechamentoApi,
  selecionarImportVigente,
  montarSync,
  hojeSaoPaulo,
  financeiroCompleto,
  AVISO_FINANCEIRO_PENDENTE,
};
