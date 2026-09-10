// Testes de render da Visão operacional V3 (redesign Direção A) —
// React Testing Library + Vitest.
//
// Cobrem os contratos que já regrediram uma vez (acc3e92):
//   resultado lido de dados.filteredSummary (não de dados direto) ·
//   percentual ausente nunca vira "0,0%" (coerção null/undefined ÷ 100) ·
//   valor ausente nunca vira "R$ 0,00" · bloco indisponível não derruba os
//   outros da grade.
// E as travas do redesign:
//   "Resultado do período" fica FORA da grade 2×2 · Atividade não é
//   renderizada · nenhuma classe .vf-kpi na Visão · Ads tem dois estados.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import VisaoPage from "./VisaoPage.jsx";

const mocks = vi.hoisted(() => ({
  useOperacaoAtual: vi.fn(),
  useVisao: vi.fn(),
}));

vi.mock("../hooks/useVfContext.js", () => ({ useOperacaoAtual: mocks.useOperacaoAtual }));
vi.mock("../hooks/useVisao.js", () => ({ useVisao: mocks.useVisao }));

function operacaoPronta(overrides = {}) {
  return { pronta: true, clienteSlug: "n97", clienteContaId: 42, marketplace: "meli", ...overrides };
}

function envelope(disponivel, dados, escopoConta = true, motivo = null) {
  return { disponivel, escopoConta, motivo, dados };
}

// Shape REALISTA do bootstrap da Central de Vendas: um objeto grande com
// `filteredSummary` aninhado junto de outras chaves que a Visão não lê — igual
// ao payload real de getCentralVendasReadBootstrap, não um resumo já achatado
// (é essa diferença que a regressão de acc3e92 mascarava).
function bootstrapResultado(overridesFilteredSummary = {}) {
  return {
    rows: [{ id: 1 }, { id: 2 }],
    pagination: { page: 1, pageSize: 20, total: 2 },
    dias: [],
    filteredSummary: {
      faturamento: 412880.5,
      lucroContribuicao: 98000,
      margemContribuicaoPercentual: 23.7,
      ticket: 210.5,
      pedidosValidos: 1963,
      pedidosTotal: 2010,
      cancelados: 47,
      confiancaFechamento: "confiavel",
      ...overridesFilteredSummary,
    },
  };
}

function dadosBase(overrides = {}) {
  return {
    saude: envelope(true, {
      setup: { temGrant: true, temBase: true },
      sync: { status: "sincronizado", ultimaSincronizacao: "2026-08-26T10:00:00Z" },
    }, false),
    resultado: envelope(true, bootstrapResultado(), true),
    margem: envelope(true, { placar: {}, cobertura: {}, excecoes: [] }, false),
    ads: envelope(true, { semDados: true, codigo: "NO_TOKEN", motivo: "Ads não configurado." }, true),
    fechamento: envelope(true, null, false),
    atividade: envelope(true, [], true),
    ...overrides,
  };
}

function mockarHooks({ dados = null, carregando = false, erro = null, operacao = operacaoPronta() } = {}) {
  mocks.useOperacaoAtual.mockReturnValue(operacao);
  mocks.useVisao.mockReturnValue({ periodo: "2026-08", setPeriodo: vi.fn(), dados, carregando, erro });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// Valor de uma figura pelo seu rótulo, dentro de um escopo (a Visão não usa
// .vf-kpi — os números vivem em .vf-visao-figure__value).
function figuraValor(scope, label) {
  return within(scope).getByText(label).closest(".vf-visao-figure").querySelector(".vf-visao-figure__value");
}

describe("VisaoPage · Resultado do período (regressão acc3e92)", () => {
  it("lê o faturamento e a margem de dados.filteredSummary, não do bootstrap cru", async () => {
    mockarHooks({ dados: dadosBase() });
    render(<VisaoPage />);

    const bloco = (await screen.findByText("Resultado do período")).closest("section");
    expect(figuraValor(bloco, "Faturamento")).toHaveTextContent("412.880,50");
    expect(figuraValor(bloco, "Margem de contribuição")).toHaveTextContent("23,7%");
  });

  it("margemContribuicaoPercentual ausente mostra '—', nunca vira '0,0%'", async () => {
    mockarHooks({
      dados: dadosBase({
        resultado: envelope(true, bootstrapResultado({ margemContribuicaoPercentual: null }), true),
      }),
    });
    render(<VisaoPage />);

    const bloco = (await screen.findByText("Resultado do período")).closest("section");
    expect(bloco.textContent).not.toContain("0,0%");
    expect(figuraValor(bloco, "Margem de contribuição")).toHaveTextContent("—");
  });

  it("semCusto/semFrete = 0 não imprime um '0' solto no rodapé do card", async () => {
    mockarHooks({
      dados: dadosBase({
        resultado: envelope(true, bootstrapResultado({ semCusto: 0, semFrete: 0 }), true),
      }),
    });
    render(<VisaoPage />);

    const bloco = (await screen.findByText("Resultado do período")).closest("section");
    const stack = bloco.querySelector(".vf-stack");
    const textoSolto = Array.from(stack.childNodes).filter(
      (n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim() !== "",
    );
    expect(textoSolto).toHaveLength(0);
    // e o hint de custo/frete não aparece quando ambos são 0
    expect(bloco.textContent).not.toContain("Itens sem custo");
  });

  it("ticket/faturamento ausentes mostram '—', nunca 'R$ 0,00'", async () => {
    mockarHooks({
      dados: dadosBase({
        resultado: envelope(true, bootstrapResultado({ ticket: null, faturamento: undefined }), true),
      }),
    });
    render(<VisaoPage />);

    const bloco = (await screen.findByText("Resultado do período")).closest("section");
    expect(bloco.textContent).not.toContain("R$ 0,00");
    expect(within(bloco).getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });
});

describe("VisaoPage · estrutura do redesign", () => {
  it("'Resultado do período' fica FORA da grade 2×2 e é o bloco principal", async () => {
    mockarHooks({ dados: dadosBase() });
    render(<VisaoPage />);

    const bloco = (await screen.findByText("Resultado do período")).closest("section");
    expect(bloco).toHaveClass("vf-visao-principal");
    expect(bloco.closest(".vf-visao-grid")).toBeNull();
  });

  it("a grade tem exatamente 4 blocos: Saúde, Margem, Ads, Fechamento", async () => {
    mockarHooks({ dados: dadosBase() });
    const { container } = render(<VisaoPage />);
    await screen.findByText("Resultado do período");

    const naGrade = container.querySelectorAll(".vf-visao-grid > .vf-visao-bloco");
    expect(naGrade.length).toBe(4);
    for (const titulo of ["Saúde da operação", "Margem", "Ads", "Fechamento"]) {
      expect(screen.getByText(titulo)).toBeInTheDocument();
    }
  });

  it("Atividade não é renderizada (o componente segue existindo no repo)", async () => {
    mockarHooks({ dados: dadosBase() });
    render(<VisaoPage />);
    await screen.findByText("Resultado do período");
    expect(screen.queryByText("Atividade recente")).not.toBeInTheDocument();
  });

  it("não usa nenhuma classe .vf-kpi na Visão", async () => {
    mockarHooks({ dados: dadosBase() });
    const { container } = render(<VisaoPage />);
    await screen.findByText("Resultado do período");
    expect(container.querySelector('[class*="vf-kpi"]')).toBeNull();
  });

  it("o topo não mostra status global", async () => {
    mockarHooks({ dados: dadosBase() });
    const { container } = render(<VisaoPage />);
    await screen.findByText("Resultado do período");
    expect(container.querySelector(".vf-page-header__actions .vf-status")).toBeNull();
  });
});

describe("VisaoPage · Saúde da operação", () => {
  it("mostra 'N de 6 etapas concluídas' com base em setup.*", async () => {
    mockarHooks({ dados: dadosBase() });
    render(<VisaoPage />);
    const saude = (await screen.findByText("Saúde da operação")).closest("section");
    expect(within(saude).getByText("2 de 6 etapas concluídas")).toBeInTheDocument();
    expect(within(saude).queryByText(/Prontidão/)).not.toBeInTheDocument();
  });

  it("a barra de progresso preenche na proporção das etapas concluídas (2/6)", async () => {
    mockarHooks({ dados: dadosBase() });
    render(<VisaoPage />);
    const saude = (await screen.findByText("Saúde da operação")).closest("section");
    const barra = saude.querySelector(".vf-progress__bar");
    expect(barra).not.toBeNull();
    expect(barra.tagName).toBe("DIV"); // <span> inline ignoraria width/height
    expect(barra.style.width).toBe("33.3%");
  });

  it("sem sincronização registrada: frase neutra, nunca 'Nunca sincronizado'", async () => {
    mockarHooks({
      dados: dadosBase({
        saude: envelope(true, { setup: {}, sync: { status: "ausente", ultimaSincronizacao: null } }, false),
      }),
    });
    render(<VisaoPage />);
    const saude = (await screen.findByText("Saúde da operação")).closest("section");
    expect(saude.textContent).not.toContain("Nunca sincronizado");
    expect(within(saude).getByText("Sincronização ainda não realizada")).toBeInTheDocument();
  });
});

describe("VisaoPage · Margem", () => {
  function margemComDados(extra = {}) {
    return envelope(true, {
      placar: { margemMediaPercent: 16.2, itensComMargem: 842, itensSemMargem: 37, ...extra.placar },
      cobertura: { itensAnalisados: 879, totalItensMl: 900, parcial: true, ...extra.cobertura },
      excecoes: [],
    }, false);
  }

  it("a barra representa itens com margem / itens analisados (842/879 → 95.8%)", async () => {
    mockarHooks({ dados: dadosBase({ margem: margemComDados() }) });
    render(<VisaoPage />);
    const margem = (await screen.findByText("Margem")).closest("section");
    const barra = margem.querySelector(".vf-progress__bar");
    expect(barra).not.toBeNull();
    expect(barra.tagName).toBe("DIV");
    expect(barra.style.width).toBe("95.8%");
  });

  it("'Revisar →' aparece quando há itens sem margem", async () => {
    mockarHooks({ dados: dadosBase({ margem: margemComDados() }) });
    render(<VisaoPage />);
    const margem = (await screen.findByText("Margem")).closest("section");
    expect(within(margem).getByText("Revisar →")).toBeInTheDocument();
  });

  it("'Revisar →' some quando não há itens sem margem", async () => {
    mockarHooks({
      dados: dadosBase({
        margem: margemComDados({ placar: { itensComMargem: 879, itensSemMargem: 0 }, cobertura: { itensAnalisados: 879 } }),
      }),
    });
    render(<VisaoPage />);
    const margem = (await screen.findByText("Margem")).closest("section");
    expect(within(margem).queryByText("Revisar →")).not.toBeInTheDocument();
  });
});

describe("VisaoPage · Ads (dois estados)", () => {
  it("sem Ads: 'Ads não conectado' + CTA 'Conectar Ads', sem métricas", async () => {
    mockarHooks({ dados: dadosBase() });
    render(<VisaoPage />);
    const ads = (await screen.findByText("Ads")).closest("section");
    expect(within(ads).getByText("Ads não conectado")).toBeInTheDocument();
    expect(within(ads).getByText("Conectar Ads")).toBeInTheDocument();
    expect(within(ads).queryByText("ROAS")).not.toBeInTheDocument();
  });

  it("com Ads: ROAS/ACOS/GMV/Investimento numa única régua horizontal — nunca 'ROI'", async () => {
    mockarHooks({
      dados: dadosBase({
        ads: envelope(true, { roas: 6.8, acos: 14.8, gmvAds: 84300, investimentoAds: 12480, avisos: [] }, true),
      }),
    });
    render(<VisaoPage />);
    const ads = (await screen.findByText("Ads")).closest("section");
    expect(within(ads).getByText("ROAS")).toBeInTheDocument();
    expect(within(ads).getByText("6,8x")).toBeInTheDocument();
    expect(within(ads).getByText("14,8%")).toBeInTheDocument();
    expect(ads.textContent).not.toContain("ROI");

    // uma só régua, com as 4 figuras dentro dela (sem ROAS numa linha própria)
    const reguas = ads.querySelectorAll(".vf-visao-metricrow");
    expect(reguas.length).toBe(1);
    expect(reguas[0].querySelectorAll(".vf-visao-figure").length).toBe(4);
  });
});

describe("VisaoPage · Fechamento", () => {
  it("sem fechamento no período: estado vazio + UM único 'Ver detalhes →' (o do cabeçalho)", async () => {
    mockarHooks({ dados: dadosBase() });
    render(<VisaoPage />);
    const fechamento = (await screen.findByText("Fechamento")).closest("section");
    expect(within(fechamento).getByText(/Nenhum fechamento gerado/)).toBeInTheDocument();

    const acoes = within(fechamento).getAllByText("Ver detalhes →");
    expect(acoes).toHaveLength(1);
    expect(acoes[0].closest("header")).not.toBeNull(); // é o link do BlocoCard, não do corpo
    expect(acoes[0].getAttribute("href")).toMatch(/^financeiro\.html/);
  });
});

describe("VisaoPage · resiliência por bloco", () => {
  it("um bloco indisponível mostra o motivo e não impede os outros de renderizar", async () => {
    mockarHooks({
      dados: dadosBase({
        margem: envelope(false, null, false, "Base de custo ainda não vinculada."),
      }),
    });
    render(<VisaoPage />);

    const margem = (await screen.findByText("Margem")).closest("section");
    expect(within(margem).getByText("Base de custo ainda não vinculada.")).toBeInTheDocument();

    const resultado = screen.getByText("Resultado do período").closest("section");
    expect(figuraValor(resultado, "Faturamento")).toHaveTextContent("412.880,50");
    expect(screen.getByText("Saúde da operação")).toBeInTheDocument();
    expect(screen.getByText("Ads")).toBeInTheDocument();
    expect(screen.getByText("Fechamento")).toBeInTheDocument();
  });

  it("bloco indisponível sem motivo cai no texto genérico, não fica vazio", async () => {
    mockarHooks({
      dados: dadosBase({ ads: envelope(false, null, true, null) }),
    });
    render(<VisaoPage />);

    const ads = (await screen.findByText("Ads")).closest("section");
    expect(within(ads).getByText("Este bloco não está disponível no momento.")).toBeInTheDocument();
  });
});

describe("VisaoPage · estados de carregamento e erro", () => {
  it("sem dados e carregando: mostra os esqueletos (principal + 4 da grade), não a grade real", () => {
    mockarHooks({ dados: null, carregando: true });
    const { container } = render(<VisaoPage />);
    expect(container.querySelectorAll(".vf-visao-bloco").length).toBe(5);
    expect(screen.queryByText("Resultado do período")).not.toBeInTheDocument();
  });

  it("erro sem dados: banner com mensagem, não tela em branco", () => {
    mockarHooks({ dados: null, erro: { codigo: "rede", mensagem: "Não foi possível falar com o servidor." } });
    render(<VisaoPage />);
    const alerta = screen.getByRole("alert");
    expect(alerta).toHaveTextContent("Não foi possível carregar a Visão");
    expect(alerta).toHaveTextContent("Não foi possível falar com o servidor.");
  });

  it("contexto ainda não pronto: página não renderiza nada (Shell já cobre o estado)", () => {
    mockarHooks({ operacao: operacaoPronta({ pronta: false }), dados: null });
    const { container } = render(<VisaoPage />);
    expect(container).toBeEmptyDOMElement();
  });
});
