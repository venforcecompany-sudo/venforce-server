// Testes de render da tela de Início (cópia do Início do Lucratto 360, que
// substituiu a Visão) — React Testing Library + Vitest.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import InicioPage from "./InicioPage.jsx";

const mocks = vi.hoisted(() => ({ useOperacaoAtual: vi.fn(), useInicio: vi.fn(), setPeriodo: vi.fn() }));

vi.mock("../hooks/useVfContext.js", () => ({ useOperacaoAtual: mocks.useOperacaoAtual }));
vi.mock("../hooks/useInicio.js", async (original) => ({ ...(await original()), useInicio: mocks.useInicio }));

const env = (dados, disponivel = true, motivo = null) => ({ disponivel, escopoConta: true, motivo, dados });

function totais(over = {}) {
  return { faturamento: 12500.5, vendas: 100, unidades: 120, canceladas: 2, vendasCalculadas: 90, incompletas: 10, faturamentoCalculado: 11000, lucro: 2200, margemPct: 20, ticket: 125.01, semCusto: 4, ...over };
}

function dadosBase(over = {}) {
  return {
    periodo: { id: "30d", de: "2026-10-13", ate: "2026-11-11", anterior: { de: "2026-09-13", ate: "2026-10-12" } },
    metasMercadoLider: [
      { nivel: "silver", rotulo: "MercadoLíder", vendas: 230, faturamento: 37000 },
      { nivel: "gold", rotulo: "MercadoLíder Gold", vendas: 575, faturamento: 118400 },
      { nivel: "platinum", rotulo: "MercadoLíder Platinum", vendas: 1725, faturamento: 296000 },
    ],
    limitesMercadoLider: { reclamacoesPct: 0.5, cancelamentosPct: 0.5, atrasosPct: 6, mesesDeConta: 4 },
    vendas: env({
      sincronizado: true,
      atualizadoEm: "2026-11-11T12:00:00Z",
      totais: totais(),
      anterior: { ...totais({ faturamento: 10000, lucro: 2000, margemPct: 18, ticket: 100 }), periodo: { de: "2026-09-13", ate: "2026-10-12" } },
      serie: [
        { dia: "2026-11-10", vendas: 3, faturamento: 300, lucro: 60 },
        { dia: "2026-11-11", vendas: 1, faturamento: 100, lucro: -10 },
      ],
      lucraram: [{ mlb: "MLB1", titulo: "Garrafa térmica", unidades: 10, lucro: 500, margemPct: 25, vendasCalculadas: 10 }],
      perdem: [{ mlb: "MLB2", titulo: "Copo", unidades: 3, lucro: -45, margemPct: -15, vendasCalculadas: 3 }],
      lider: { de: "2026-08-01", ate: "2026-11-11", vendas: 300, faturamento: 40000 },
    }),
    catalogo: env({ porStatus: { saudavel: 6, margem_baixa: 2, prejuizo: 1, dado_suspeito: 0, nao_validado: 1, conciliando: 0 }, total: 10, margemAlvoPct: 15, piorMargemPct: -12.5, cobertura: { parcial: false } }),
    reputacao: env({
      nivel: "3_yellow", mercadoLider: "silver", periodoDias: 60, vendasPeriodo: 800,
      reclamacoes: { taxaPct: 0.31, quantidade: 2 }, cancelamentos: { taxaPct: 0, quantidade: 0 }, atrasos: { taxaPct: 1.2, quantidade: 9 },
      contaDesde: "2020-01-01T00:00:00Z", lidaEm: "2026-11-11T15:00:00Z",
    }),
    ads: env({ roas: 4, acos: 25, gmvAds: 1000, investimentoAds: 250 }),
    configuracao: env({ setup: { temGrant: true, temBase: true }, sync: { status: "ok", precisaSincronizar: false } }),
    ...over,
  };
}

function montar({ dados = dadosBase(), carregando = false, erro = null, pronta = true, periodo = "30d" } = {}) {
  mocks.useOperacaoAtual.mockReturnValue({ pronta, clienteSlug: "n97", clienteContaId: 42 });
  mocks.useInicio.mockReturnValue({ periodo, setPeriodo: mocks.setPeriodo, dados, carregando, erro });
  return render(<InicioPage />);
}

const bloco = (titulo) => screen.getByRole("heading", { name: new RegExp(`^${titulo}`) }).closest("section");

beforeEach(() => vi.clearAllMocks());

describe("InicioPage", () => {
  it("sem contexto pronto não renderiza nada (o Shell cuida)", () => {
    const { container } = montar({ pronta: false });
    expect(container).toBeEmptyDOMElement();
  });

  it("mostra os quatro números do período com variação", () => {
    montar();
    const resumo = screen.getByLabelText("Resumo do período");
    expect(within(resumo).getByText("R$ 12.500,50")).toBeInTheDocument();
    expect(within(resumo).getByText("R$ 2.200,00")).toBeInTheDocument();
    expect(within(resumo).getByText("20,0%")).toBeInTheDocument();
    expect(within(resumo).getAllByText("▲ 25,0%")).toHaveLength(2); // faturamento 10.000 → 12.500,50 e ticket 100 → 125,01
    expect(within(resumo).getByText("▲ 2,0 p.p.")).toBeInTheDocument();
  });

  it("sem venda calculada, o lucro é ausente — nunca R$ 0,00", () => {
    const d = dadosBase();
    d.vendas.dados.totais = totais({ vendasCalculadas: 0, lucro: null, margemPct: null });
    montar({ dados: d });
    const resumo = screen.getByLabelText("Resumo do período");
    expect(within(resumo).getByText("nenhuma venda com todos os dados")).toBeInTheDocument();
    expect(within(resumo).queryByText("R$ 0,00")).toBeNull();
  });

  it("Precisa de atenção junta reputação, prejuízo, sem custo e margem baixa com links para o VenForce", () => {
    montar();
    const atencao = bloco("Precisa de atenção");
    expect(within(atencao).getByText("1 anúncio vendendo com prejuízo")).toBeInTheDocument();
    expect(within(atencao).getByText("4 vendas do período sem custo")).toBeInTheDocument();
    expect(within(atencao).getByText("2 anúncios abaixo da meta de 15%")).toBeInTheDocument();
    expect(within(atencao).getByText("O termômetro está amarelo")).toBeInTheDocument();
    expect(within(atencao).getAllByRole("link", { name: "Ver anúncios" })[0]).toHaveAttribute("href", "central-margem.html?cliente=n97");
  });

  it("Saúde da conta mostra termômetro e métricas do ML", () => {
    montar();
    const conta = bloco("Saúde da conta");
    expect(within(conta).getByRole("img", { name: /Termômetro amarelo/ })).toBeInTheDocument();
    expect(within(conta).getByText("0,31%")).toBeInTheDocument();
    expect(within(conta).getByText("9 de 800")).toBeInTheDocument();
  });

  it("MercadoLíder mostra o próximo nível e a meta de vendas", () => {
    montar();
    const lider = bloco("MercadoLíder");
    expect(within(lider).getByText("MercadoLíder Gold")).toBeInTheDocument();
    expect(within(lider).getByRole("progressbar", { name: "Vendas" })).toHaveAttribute("aria-valuenow", "300");
  });

  it("Saúde do catálogo distribui os anúncios por status", () => {
    montar();
    const cat = bloco("Saúde do catálogo");
    expect(within(cat).getByRole("img", { name: /6 saudável, 2 margem baixa, 1 prejuízo/ })).toBeInTheDocument();
    expect(within(cat).queryByText("Conciliando")).toBeNull();
  });

  it("bloco indisponível mostra o motivo e não derruba os outros", () => {
    montar({ dados: dadosBase({ catalogo: env(null, false, "Cliente sem base MELI vinculada.") }) });
    expect(within(bloco("Saúde do catálogo")).getByText("Cliente sem base MELI vinculada.")).toBeInTheDocument();
    expect(bloco("Saúde da conta")).toBeInTheDocument();
    expect(screen.getByLabelText("Resumo do período")).toBeInTheDocument();
  });

  it("gráfico e rankings do período", () => {
    montar();
    expect(screen.getByRole("heading", { name: "Faturamento e lucro por dia" })).toBeInTheDocument();
    expect(within(bloco("Os que mais lucraram")).getByText("Garrafa térmica")).toBeInTheDocument();
    expect(within(bloco("Os que mais perdem dinheiro")).getByText("− R$ 45,00")).toBeInTheDocument();
  });

  it("Hoje não mostra o gráfico por dia (um dia só)", () => {
    const d = dadosBase();
    d.periodo = { ...d.periodo, id: "hoje", de: "2026-11-11", ate: "2026-11-11" };
    montar({ dados: d, periodo: "hoje" });
    expect(screen.queryByRole("heading", { name: "Faturamento e lucro por dia" })).toBeNull();
  });

  it("Ads e a checklist de configuração continuam na tela", () => {
    montar();
    expect(within(bloco("Ads")).getByText("4,0x")).toBeInTheDocument();
    expect(within(bloco("Configuração da operação")).getByText(/2 de 6 etapas concluídas/)).toBeInTheDocument();
  });

  it("os atalhos trocam o período", async () => {
    montar();
    const grupo = screen.getByRole("group", { name: "Período" });
    expect(within(grupo).getByRole("button", { name: "30 dias" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(within(grupo).getByRole("button", { name: "7 dias" }));
    expect(mocks.setPeriodo).toHaveBeenCalledWith("7d");
  });

  it("vendas sincronizadas até ontem: o topo diz até quando", () => {
    const d = dadosBase();
    d.periodo = { ...d.periodo, hoje: "2026-11-11", ate: "2026-11-10" };
    d.vendas.dados.dadosAte = "2026-11-10";
    d.vendas.dados.atualizadoEm = "2026-11-10T21:05:00Z";
    montar({ dados: d });
    expect(screen.getByText(/Vendas até 10\/11 · sincronizadas em/)).toBeInTheDocument();
    expect(screen.getByLabelText("Resumo do período")).toBeInTheDocument();
  });

  it("Hoje sem pedidos sincronizados avisa em vez de mostrar zero", () => {
    const d = dadosBase();
    d.periodo = { ...d.periodo, id: "hoje", hoje: "2026-11-11", de: "2026-11-11", ate: "2026-11-11" };
    Object.assign(d.vendas.dados, { dadosAte: "2026-11-10", hojePendente: true, totais: totais({ faturamento: 0, vendas: 0, lucro: null }) });
    montar({ dados: d, periodo: "hoje" });
    expect(screen.getByRole("status")).toHaveTextContent("Os pedidos de hoje ainda não foram sincronizados — as vendas vão até 10/11.");
    expect(screen.getByRole("link", { name: "Sincronize no Financeiro" })).toHaveAttribute("href", "financeiro-v3.html?cliente=n97&conta=42");
    expect(screen.queryByLabelText("Resumo do período")).toBeNull();
    expect(screen.queryByRole("heading", { name: /^Os que mais lucraram/ })).toBeNull();
  });

  it("erro sem dados mostra o banner", () => {
    montar({ dados: null, erro: { mensagem: "Falhou geral." } });
    expect(screen.getByRole("alert")).toHaveTextContent("Falhou geral.");
  });
});
