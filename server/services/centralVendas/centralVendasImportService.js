const {
  processMeliForCentralVendas,
} = require("../fechamentoFinanceiro/meliFinanceiroService");

function getRepository() {
  return require("./centralVendasRepository");
}

function normalizeSlug(slug) {
  return String(slug || "").trim().toLowerCase();
}

function normalizeCompetencia(value) {
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}$/.test(text)) return text;
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function round2(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : 0;
}

function buildResumoCentralVendas(motorResult) {
  const pedidos = Array.isArray(motorResult?.pedidos) ? motorResult.pedidos : [];
  const resumoMotor = motorResult?.resumo || {};
  const receitaBloqueada = round2(
    pedidos
      .filter((pedido) => pedido.confianca === "bloqueado")
      .reduce((sum, pedido) => sum + Number(pedido.faturamento || 0), 0)
  );
  const faturamentoComCusto = round2(
    pedidos
      .filter((pedido) => pedido.confianca !== "bloqueado")
      .reduce((sum, pedido) => sum + Number(pedido.faturamento || 0), 0)
  );
  const faturamento = round2(faturamentoComCusto + receitaBloqueada);
  const lucroContribuicao =
    resumoMotor.lucroContribuicao === null || resumoMotor.lucroContribuicao === undefined
      ? null
      : round2(resumoMotor.lucroContribuicao);

  return {
    ...resumoMotor,
    faturamento,
    faturamentoComCusto,
    receitaBloqueada,
    lucroContribuicao,
    margemContribuicaoPercentual:
      lucroContribuicao !== null && faturamentoComCusto > 0
        ? round2((lucroContribuicao / faturamentoComCusto) * 100)
        : null,
    confianca:
      pedidos.some((pedido) => pedido.confianca === "bloqueado")
        ? "parcial"
        : pedidos.some((pedido) => pedido.confianca === "parcial")
          ? "parcial"
          : pedidos.length
            ? "confiavel"
            : "ausente",
  };
}

function createCentralVendasImportService(repository = getRepository()) {
  async function importarVendasMeli({
    salesRowsRaw,
    costRowsRaw,
    clienteSlug,
    competencia,
    marketplace = "meli",
  }) {
    const slug = normalizeSlug(clienteSlug);
    const competenciaNorm = normalizeCompetencia(competencia);
    const marketplaceNorm = String(marketplace || "meli").trim().toLowerCase();

    if (!slug) {
      const err = new Error("slug e obrigatorio.");
      err.statusCode = 400;
      throw err;
    }

    if (marketplaceNorm !== "meli") {
      const err = new Error("Marketplace invalido para Central de Vendas nesta fase.");
      err.statusCode = 400;
      throw err;
    }

    if (!Array.isArray(salesRowsRaw) || !Array.isArray(costRowsRaw)) {
      const err = new Error("Linhas de vendas e custos sao obrigatorias.");
      err.statusCode = 400;
      throw err;
    }

    await repository.ensureCentralVendasTables();

    const cliente = await repository.getClienteBySlug(slug);
    if (!cliente) {
      const err = new Error("Cliente nao encontrado.");
      err.statusCode = 404;
      throw err;
    }

    const motorResult = processMeliForCentralVendas({
      salesRowsRaw,
      costRowsRaw,
      clienteSlug: slug,
      competencia: competenciaNorm,
    });
    const resumo = buildResumoCentralVendas(motorResult);
    const motorPayload = {
      ...motorResult,
      resumo,
    };

    const persisted = await repository.persistCentralVendasImport({
      cliente,
      marketplace: marketplaceNorm,
      competencia: competenciaNorm,
      motorPayload,
      resumo,
    });

    return {
      ok: true,
      importId: persisted.importacao.id,
      cliente,
      marketplace: marketplaceNorm,
      competencia: competenciaNorm,
      resumo,
      pedidosPersistidos: persisted.pedidosPersistidos,
      itensPersistidos: persisted.itensPersistidos,
      componentesPersistidos: persisted.componentesPersistidos,
    };
  }

  return {
    importarVendasMeli,
  };
}

module.exports = {
  importarVendasMeli: (params) => createCentralVendasImportService().importarVendasMeli(params),
  createCentralVendasImportService,
  buildResumoCentralVendas,
};
