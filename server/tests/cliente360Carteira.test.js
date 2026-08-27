const assert = require("assert");
const {
  createCarteiraService,
  principalCausa,
  classificarSaude,
  montarResumo,
} = require("../services/cliente360/cliente360CarteiraService");

function resultadoBase(overrides = {}) {
  const base = {
    ok: true,
    cliente: { id: 1, slug: "cliente-a", nome: "Cliente A" },
    periodo: { competencia: "2026-07" },
    comparacao: { competencia: "2026-06" },
    estado: { chave: "ok", mensagem: null, bloqueante: false },
    thresholds: { margemAlvo: 0.15 },
    confianca: {
      nivel: "confiavel",
      coberturaResultado: 0.98,
      coberturaCusto: 0.98,
      coberturaFrete: 0.98,
      receitaBloqueada: 0,
      alertas: [],
    },
    fechamento: {
      atual: {
        faturamento: 100000,
        resultadoOperacional: 12000,
        resultadoAposAds: 9000,
        margemOperacional: 0.12,
        margemAposAds: 0.09,
        ads: 3000,
      },
      anterior: {
        faturamento: 105000,
        resultadoOperacional: 19000,
        resultadoAposAds: 16000,
        margemOperacional: 0.181,
      },
      variacoes: {
        faturamento: { abs: -5000 },
        resultadoOperacional: { abs: -7000 },
        resultadoAposAds: { abs: -7000 },
        margemOperacional: { pp: -6.1 },
      },
    },
    ponte: {
      linhas: [
        { chave: "frete", label: "Frete", impacto: -4200 },
        { chave: "preco", label: "Preço médio", impacto: -1800 },
      ],
    },
    produtos: {
      prejudicaram: [{ mlb: "MLB1", titulo: "Produto A", contribuicao: -2200 }],
      curvaAEmRisco: [{ mlb: "MLB1" }],
      totais: { noVermelho: 2, abaixoDaMargem: 6, analisados: 40 },
    },
    oportunidades: { totalRecuperavel: 9800 },
    narrativa: { texto: "O frete foi a maior pressão do período." },
  };

  return {
    ...base,
    ...overrides,
    confianca: { ...base.confianca, ...(overrides.confianca || {}) },
    fechamento: {
      ...base.fechamento,
      ...(overrides.fechamento || {}),
      atual: { ...base.fechamento.atual, ...(overrides.fechamento?.atual || {}) },
      anterior: { ...base.fechamento.anterior, ...(overrides.fechamento?.anterior || {}) },
      variacoes: { ...base.fechamento.variacoes, ...(overrides.fechamento?.variacoes || {}) },
    },
    produtos: { ...base.produtos, ...(overrides.produtos || {}) },
  };
}

(function testaPrincipalCausaUsaImpacto() {
  const causa = principalCausa(resultadoBase());
  assert.strictEqual(causa.chave, "frete");
  assert.strictEqual(causa.impacto, -4200);
  assert.strictEqual(causa.fonte, "ponte_resultado");
})();

(function testaClassificacaoPorQuedaMaterial() {
  const classificacao = classificarSaude(resultadoBase());
  assert.strictEqual(classificacao.status, "critico");
  assert(classificacao.motivos.some((m) => m.includes("Queda material")));
})();

(function testaConfiancaInsuficienteNaoViraCriticoFinanceiro() {
  const classificacao = classificarSaude(resultadoBase({
    confianca: { nivel: "insuficiente" },
  }));
  assert.strictEqual(classificacao.status, "sem_dados");
})();

(async function testaAgregacaoEOrdenacao() {
  const resultados = {
    "cliente-a": resultadoBase(),
    "cliente-b": resultadoBase({
      cliente: { id: 2, slug: "cliente-b", nome: "Cliente B" },
      fechamento: {
        atual: { faturamento: 50000, resultadoOperacional: 10000, resultadoAposAds: 8500, margemOperacional: 0.2 },
        anterior: { faturamento: 48000, resultadoOperacional: 9000, resultadoAposAds: 7500, margemOperacional: 0.1875 },
        variacoes: {
          faturamento: { abs: 2000 },
          resultadoOperacional: { abs: 1000 },
          resultadoAposAds: { abs: 1000 },
          margemOperacional: { pp: 1.25 },
        },
      },
      ponte: { linhas: [{ chave: "preco", label: "Preço médio", impacto: 1000 }] },
      produtos: { prejudicaram: [], curvaAEmRisco: [], totais: { noVermelho: 0, abaixoDaMargem: 0, analisados: 12 } },
      oportunidades: { totalRecuperavel: 0 },
    }),
  };

  const service = createCarteiraService({
    clientesService: {
      getClientesOperacional: async () => ({
        ok: true,
        clientes: [
          { id: 1, slug: "cliente-a", nome: "Cliente A", ativo: true },
          { id: 2, slug: "cliente-b", nome: "Cliente B", ativo: true },
        ],
      }),
    },
    resultadoService: {
      getResultado: async (slug) => resultados[slug],
    },
    acoesRepo: {
      listarAcoes: async (slug) => slug === "cliente-a"
        ? [{
            id: 10,
            competencia: "2026-07",
            fator: "frete",
            tipo: "correcao_frete",
            titulo: "Revisar logística",
            credito_apurado: 500,
            created_at: "2026-07-20T12:00:00Z",
          }]
        : [],
    },
    limiteConcorrencia: 2,
  });

  const carteira = await service.getCarteiraExecutiva({
    competencia: "2026-07",
    compararCom: "2026-06",
  });

  assert.strictEqual(carteira.ok, true);
  assert.strictEqual(carteira.contas.length, 2);
  assert.strictEqual(carteira.contas[0].cliente.slug, "cliente-a");
  assert.strictEqual(carteira.contas[0].status, "critico");
  assert.strictEqual(carteira.contas[1].status, "saudavel");
  assert.strictEqual(carteira.resumo.faturamento, 150000);
  assert.strictEqual(carteira.resumo.deltaResultadoLiquido, -6000);
  assert.strictEqual(carteira.resumo.acoesRegistradas, 1);
  assert.strictEqual(carteira.resumo.creditoApurado, 500);
  assert.strictEqual(carteira.causas[0].chave, "frete");
  assert(carteira.narrativa.includes("resultado operacional"));

  const resumo = montarResumo(carteira.contas);
  assert.strictEqual(resumo.melhoraram, 1);
  assert.strictEqual(resumo.pioraram, 1);

  console.log("✓ cliente360Carteira: contratos executivos válidos");
})().catch((erro) => {
  console.error(erro);
  process.exitCode = 1;
});
