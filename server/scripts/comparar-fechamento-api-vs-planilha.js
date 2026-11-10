#!/usr/bin/env node
// server/scripts/comparar-fechamento-api-vs-planilha.js
//
// Validação do fechamento pela API (Central de Vendas) contra a planilha de
// vendas do Mercado Livre, para a MESMA conta e competência. Roda os dois
// caminhos e imprime:
//   - a diferença por chave do summary (planilha × API);
//   - as maiores divergências de LC por MLB.
//
// SOMENTE LEITURA: nenhum INSERT/UPDATE/DELETE. O caminho da API só faz SELECT
// (ver fechamentoViaApiService). Os custos da planilha vêm da base vinculada,
// igual ao fluxo real. Não rodar contra produção sem autorização.
//
// Uso:
//   node server/scripts/comparar-fechamento-api-vs-planilha.js \
//     --cliente <slug> --conta <clienteContaId> --periodo YYYY-MM --planilha <vendas.xlsx> \
//     [--ads 0] [--venforce 0] [--affiliates 0] [--fullCost 0] [--additionalCosts 0] [--top 10]
//
// Requer DATABASE_URL no ambiente do shell (não é lido do .env).

const fs = require("fs");
const path = require("path");

function lerArgumentos(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const chave = argv[i];
    if (!chave.startsWith("--")) continue;
    const nome = chave.slice(2);
    const valor = argv[i + 1];
    if (valor === undefined || valor.startsWith("--")) {
      args[nome] = true;
    } else {
      args[nome] = valor;
      i += 1;
    }
  }
  return args;
}

function exigir(args, campo) {
  if (!args[campo] || args[campo] === true) {
    throw new Error(`Parâmetro obrigatório ausente: --${campo}`);
  }
  return args[campo];
}

const CHAVES_NUMERICAS = [
  "grossRevenueTotal",
  "contributionProfitTotal",
  "averageContributionMargin",
  "finalResult",
  "tacos",
  "tacox",
  "revenueWithCost",
  "revenueWithoutCost",
  "calculatedCoveragePercent",
  "revenueWithFinancialData",
  "revenuePendingFinancial",
  "revenueCalculable",
  "contributionMarginCalculated",
  "finalMarginCalculated",
  "refundsTotal",
  "lostRevenueTotal",
  "excludedStatusRevenue",
];

function numero(valor) {
  if (valor === null || valor === undefined || valor === "") return null;
  const n = Number(valor);
  return Number.isFinite(n) ? n : null;
}

function formatar(valor) {
  if (valor === null || valor === undefined) return "—";
  return typeof valor === "number" ? valor.toFixed(4) : String(valor);
}

async function caminhoPlanilha({ buffer, clienteSlug, clienteContaId, ajustes }) {
  const { detectMeliHeader, validateMeliHeaderAtRow, parseSpreadsheet } = require("../utils/excelUtils");
  const { buildCostRowsFromBase } = require("../services/bases/baseCustosService");
  const { processFechamentoFinanceiro } = require("../services/fechamentoFinanceiro");

  const cabecalho = detectMeliHeader(buffer);
  const validado = validateMeliHeaderAtRow(buffer, cabecalho.rowIndex);
  if (cabecalho.found && !validado.valid) {
    throw new Error("Cabeçalho da planilha do Mercado Livre não reconhecido.");
  }
  const salesRowsRaw = parseSpreadsheet(buffer, cabecalho.rowIndex);

  const custos = await buildCostRowsFromBase({
    baseId: null,
    clienteSlug,
    marketplace: "meli",
    clienteContaId,
  });

  return processFechamentoFinanceiro({
    marketplace: "meli",
    salesRowsRaw,
    costRowsRaw: custos.costRows,
    ...ajustes,
    ordersAllRowsRaw: null,
    salesBufferRaw: null,
    onholdBufferRaw: null,
    debugCollector: null,
  });
}

async function caminhoApi({ clienteSlug, clienteContaId, periodo, ajustes }) {
  const { gerarFechamentoViaApi } = require("../services/fechamentoFinanceiro/fechamentoViaApiService");
  return gerarFechamentoViaApi({
    clienteSlugRaw: clienteSlug,
    clienteContaIdRaw: clienteContaId,
    periodoRaw: periodo,
    ajustesRaw: ajustes,
  });
}

function imprimirDiferencas(planilha, api) {
  console.log("\n── Diferença por chave do summary (planilha × API) ──");
  console.log(["chave".padEnd(30), "planilha".padStart(16), "api".padStart(16), "delta".padStart(14)].join(" "));
  for (const chave of CHAVES_NUMERICAS) {
    const p = numero(planilha.summary?.[chave]);
    const a = numero(api.summary?.[chave]);
    const delta = p !== null && a !== null ? (a - p).toFixed(4) : "—";
    console.log([chave.padEnd(30), formatar(p).padStart(16), formatar(a).padStart(16), String(delta).padStart(14)].join(" "));
  }
}

function imprimirTopDivergencias(planilha, api, top) {
  const porMlbPlanilha = new Map((planilha.detailedRows || []).map((r) => [String(r["# de anúncio"]), r]));
  const porMlbApi = new Map((api.detailedRows || []).map((r) => [String(r["# de anúncio"]), r]));
  const mlbs = new Set([...porMlbPlanilha.keys(), ...porMlbApi.keys()]);

  const linhas = [];
  for (const mlb of mlbs) {
    const lcP = numero(porMlbPlanilha.get(mlb)?.LC);
    const lcA = numero(porMlbApi.get(mlb)?.LC);
    const delta = lcP !== null && lcA !== null ? lcA - lcP : null;
    linhas.push({ mlb, lcP, lcA, delta });
  }
  linhas.sort((x, y) => Math.abs(y.delta ?? Infinity) - Math.abs(x.delta ?? Infinity));

  console.log(`\n── Top ${top} divergências de LC por MLB ──`);
  console.log(["MLB".padEnd(16), "LC planilha".padStart(14), "LC API".padStart(14), "delta".padStart(12)].join(" "));
  for (const l of linhas.slice(0, top)) {
    console.log([l.mlb.padEnd(16), formatar(l.lcP).padStart(14), formatar(l.lcA).padStart(14), formatar(l.delta).padStart(12)].join(" "));
  }
}

async function main() {
  const args = lerArgumentos(process.argv);
  const clienteSlug = exigir(args, "cliente");
  const clienteContaId = Number(exigir(args, "conta"));
  const periodo = exigir(args, "periodo");
  const arquivo = path.resolve(exigir(args, "planilha"));
  const top = Number(args.top) || 10;

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL não definido no ambiente do shell. O script não lê o .env.");
  }
  if (!fs.existsSync(arquivo)) throw new Error(`Planilha não encontrada: ${arquivo}`);

  const ajustes = {
    ads: args.ads ?? "0",
    venforce: args.venforce ?? "0",
    affiliates: args.affiliates ?? "0",
    fullCost: args.fullCost ?? "0",
    additionalCosts: args.additionalCosts ?? "0",
  };
  const ajustesNumericos = {
    ads: Number(ajustes.ads),
    venforce: Number(ajustes.venforce),
    affiliates: Number(ajustes.affiliates),
    fullCost: Number(ajustes.fullCost),
    additionalCosts: Number(ajustes.additionalCosts),
  };

  const buffer = fs.readFileSync(arquivo);
  const pool = require("../config/database");
  try {
    console.log(`Comparando ${clienteSlug} · conta ${clienteContaId} · ${periodo} · ${path.basename(arquivo)}`);
    const planilha = await caminhoPlanilha({ buffer, clienteSlug, clienteContaId, ajustes: ajustesNumericos });
    const api = await caminhoApi({ clienteSlug, clienteContaId, periodo, ajustes });

    if (api.sync && !api.sync.completo) {
      console.log(`\nAviso: sync incompleto — ${api.sync.motivoIncompleto}`);
    }
    imprimirDiferencas(planilha, api);
    imprimirTopDivergencias(planilha, api, top);
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`Falha na comparação: ${err.message}`);
  process.exitCode = 1;
});
