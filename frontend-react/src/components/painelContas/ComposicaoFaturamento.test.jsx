// Composição do faturamento POR CONTA (bruto V1 → exclusões → FAT, com
// conferência) e a marca discreta de cálculo parcial em LC/MC.

import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DemonstrativoComposicao } from "./ComposicaoFaturamento.jsx";
import { TabelaHierarquica, useExpansao, temComposicao, textoCoberturaParcial } from "./TabelaHierarquica.jsx";
import { colunasVisiveis, GRUPOS_PADRAO } from "./colunas.js";

const g = (pedidos, valor) => ({ pedidos, valor });

function composicao(over = {}) {
  return {
    importId: 483,
    periodo: { de: "2026-09-01", ate: "2026-09-30" },
    bruto: g(947, 552142.78),
    exclusoes: {
      cancelamentos: g(42, 18601.48),
      devolucoes: g(14, 2320.95),
      devolucoesEmAndamento: g(2, 122.67),
      mediacoes: g(5, 3108.41),
      outrosProblemas: g(0, 0),
    },
    totalExcluido: g(63, 24153.51),
    validos: g(884, 527989.27),
    fat: 527989.27,
    pedidosSemValor: 0,
    reconciliacao: { fecha: true, diferenca: 0 },
    ...over,
  };
}

const conta1 = { contaId: 81, rotulo: "Mercado Livre 1 · AMR", marketplace: "meli", motivo: null,
  composicao: composicao({ importId: 375, periodo: { de: "2026-09-01", ate: "2026-09-29" }, bruto: g(10, 100), validos: g(9, 90), fat: 90,
    exclusoes: { cancelamentos: g(1, 10), devolucoes: g(0, 0), devolucoesEmAndamento: g(0, 0), mediacoes: g(0, 0), outrosProblemas: g(0, 0) } }) };
const conta2 = { contaId: 82, rotulo: "Mercado Livre 2 · AMR", marketplace: "meli", motivo: null, composicao: composicao() };
const shopee = { contaId: 90, rotulo: "Shopee 1 · AMR", marketplace: "shopee", motivo: "Sem pedidos importados nesta competência", composicao: null };
const soma = {
  ...composicao({
    bruto: g(957, 552242.78), validos: g(893, 528079.27), fat: 528079.27,
    exclusoes: { cancelamentos: g(43, 18611.48), devolucoes: g(14, 2320.95), devolucoesEmAndamento: g(2, 122.67), mediacoes: g(5, 3108.41), outrosProblemas: g(0, 0) },
  }),
  contas: 2,
  periodo: { de: "2026-09-01", ate: "2026-09-30", diferente: true },
  sobreposicao: { pedidos: 0, valor: 0 },
};

// Um demonstrativo por vez: abre na soma; o seletor troca para cada conta.
const opcao = (nome) => screen.getByRole("button", { name: nome });

describe("demonstrativo: um por vez, soma por padrão e seletor por conta", () => {
  it("abre na soma das contas, com o seletor [Soma] [conta 1] [conta 2]", () => {
    render(<DemonstrativoComposicao contas={[conta1, conta2]} somaDasContas={soma} competencia="2026-09" />);
    const seletor = screen.getByRole("group", { name: "Demonstrativo exibido" });
    expect(within(seletor).getAllByRole("button").map((b) => b.textContent))
      .toEqual(["Soma das contas", "Mercado Livre 1 · AMR", "Mercado Livre 2 · AMR"]);
    expect(opcao("Soma das contas")).toHaveAttribute("aria-pressed", "true");
    const cab = screen.getAllByRole("columnheader").map((th) => th.textContent);
    expect(cab).toHaveLength(2); // rótulo + UMA coluna de valores
    expect(cab[1]).toContain("Soma das contas");
    const bruto = screen.getByRole("rowheader", { name: /Faturamento bruto/ }).closest("tr");
    expect(within(bruto).getByText("R$ 552.242,78")).toBeInTheDocument();
    expect(within(bruto).getByText("957 pedidos")).toBeInTheDocument();
  });

  it("cada conta tem bruto, exclusões, FAT e conferência próprios", async () => {
    render(<DemonstrativoComposicao contas={[conta1, conta2]} somaDasContas={soma} competencia="2026-09" />);
    await userEvent.click(opcao("Mercado Livre 2 · AMR"));
    expect(opcao("Mercado Livre 2 · AMR")).toHaveAttribute("aria-pressed", "true");
    expect(opcao("Soma das contas")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getAllByRole("columnheader")[1]).toHaveTextContent("Mercado Livre 2 · AMR");
    const bruto = screen.getByRole("rowheader", { name: /Faturamento bruto/ }).closest("tr");
    expect(within(bruto).getByText("R$ 552.142,78")).toBeInTheDocument();
    expect(within(bruto).getByText("947 pedidos")).toBeInTheDocument();
    const canc = screen.getByRole("rowheader", { name: /Cancelamentos/ }).closest("tr");
    expect(within(canc).getByText("− R$ 18.601,48")).toBeInTheDocument();
    expect(within(canc).getByText("42 pedidos")).toBeInTheDocument();
    const fat = screen.getByRole("rowheader", { name: /= FAT/ }).closest("tr");
    expect(within(fat).getByText("R$ 527.989,27")).toBeInTheDocument();
    const conf = screen.getByRole("rowheader", { name: "Conferência" }).closest("tr");
    expect(within(conf).getAllByText("fecha")).toHaveLength(1);
  });

  it("10 contas: continua UMA coluna de valores; o seletor só ganha opções", async () => {
    const dez = Array.from({ length: 10 }, (_, i) => ({ ...conta2, contaId: 200 + i, rotulo: `Mercado Livre ${i + 1} · AMR` }));
    render(<DemonstrativoComposicao contas={dez} somaDasContas={{ ...soma, contas: 10 }} competencia="2026-09" />);
    expect(within(screen.getByRole("group", { name: "Demonstrativo exibido" })).getAllByRole("button")).toHaveLength(11);
    expect(screen.getAllByRole("columnheader")).toHaveLength(2);
    await userEvent.click(opcao("Mercado Livre 7 · AMR"));
    expect(screen.getAllByRole("columnheader")).toHaveLength(2);
    expect(screen.getAllByRole("columnheader")[1]).toHaveTextContent("Mercado Livre 7 · AMR");
  });

  it("período de cada conta no cabeçalho e aviso quando a soma mistura períodos", async () => {
    render(<DemonstrativoComposicao contas={[conta1, conta2]} somaDasContas={soma} competencia="2026-09" />);
    expect(screen.getByText(/01\/09–30\/09 · períodos diferentes/)).toBeInTheDocument();
    expect(screen.getByText(/As contas cobrem períodos diferentes/)).toBeInTheDocument();
    await userEvent.click(opcao("Mercado Livre 1 · AMR"));
    expect(screen.getByText("01/09–29/09")).toBeInTheDocument();
    expect(screen.queryByText(/períodos diferentes$/)).not.toBeInTheDocument();
  });

  it("conta sem pedidos (manual) fica fora, com o motivo escrito", () => {
    render(<DemonstrativoComposicao contas={[conta2, shopee]} somaDasContas={{ ...soma, contas: 1 }} competencia="2026-09" />);
    expect(screen.queryByText("Soma das contas")).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Demonstrativo exibido" })).not.toBeInTheDocument();
    expect(screen.getByText(/Shopee 1 · AMR: Sem pedidos importados nesta competência — fora do demonstrativo/)).toBeInTheDocument();
  });

  it("conferência que não fecha mostra a diferença, sem ajustar nada", () => {
    const ruim = { ...conta2, composicao: composicao({ fat: 528000, reconciliacao: { fecha: false, diferenca: 10.73 } }) };
    render(<DemonstrativoComposicao contas={[ruim]} competencia="2026-09" />);
    expect(screen.getByText("difere +R$ 10,73")).toBeInTheDocument();
    expect(screen.getByText("R$ 528.000,00")).toBeInTheDocument();
  });

  it("'Outros pedidos com problema' só aparece se existir", () => {
    const { rerender } = render(<DemonstrativoComposicao contas={[conta2]} competencia="2026-09" />);
    expect(screen.queryByRole("group", { name: "Demonstrativo exibido" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Outros pedidos com problema/)).not.toBeInTheDocument();
    const comOutros = { ...conta2, composicao: composicao({ exclusoes: { ...composicao().exclusoes, outrosProblemas: g(1, 5) } }) };
    rerender(<DemonstrativoComposicao contas={[comOutros]} competencia="2026-09" />);
    expect(screen.getByText(/Outros pedidos com problema/)).toBeInTheDocument();
  });

  it("pedido em duas contas é avisado, não escondido", () => {
    render(<DemonstrativoComposicao contas={[conta1, conta2]} somaDasContas={{ ...soma, sobreposicao: { pedidos: 1, valor: 70 } }} competencia="2026-09" />);
    expect(screen.getByText(/1 pedido aparece em mais de uma conta \(R\$ 70,00 a mais na soma\)/)).toBeInTheDocument();
  });

  it("seção de detalhe: título com o escopo e, ao lado, os pedidos do demonstrativo exibido (contagens do servidor)", async () => {
    render(<DemonstrativoComposicao contas={[conta1, conta2]} somaDasContas={soma} competencia="2026-09" />);
    const secao = screen.getByRole("region", { name: /Composição do faturamento em set\/2026/ });
    expect(within(secao).getByText(/· 2 contas · set\/2026/)).toBeInTheDocument();
    expect(screen.getByLabelText("Pedidos")).toHaveTextContent("Pedidos · soma das contas");
    await userEvent.click(opcao("Mercado Livre 2 · AMR"));
    expect(screen.getByLabelText("Pedidos")).toHaveTextContent("Mercado Livre 2 · AMR");
    expect(screen.getByLabelText("Pedidos")).toHaveTextContent("947 pedidos → 884 válidos · 63 fora do FAT");
  });

  it("conta única: o título nomeia a conta", () => {
    render(<DemonstrativoComposicao contas={[conta2]} somaDasContas={null} competencia="2026-09" />);
    expect(screen.getByRole("region", { name: /Composição do faturamento/ })).toHaveTextContent("Composição do faturamento · Mercado Livre 2 · AMR · set/2026");
  });

  it("nenhuma conta com pedidos: diz que não há o que compor", () => {
    render(<DemonstrativoComposicao contas={[shopee]} competencia="2026-09" />);
    expect(screen.getByText(/Nenhuma conta tem pedidos importados em set\/2026/)).toBeInTheDocument();
  });
});

// ── Integração com a tabela ───────────────────────────────────────────────
function resumo(over = {}) {
  return { fat: 1000, lc: 62, mc: 0.1, ads: null, acos: null, tacos: null, com: null, atv: null, nps: null, ...over };
}

function contaTabela(id, over = {}) {
  return {
    id, rotulo: `Mercado Livre ${id} · LOJA`, marketplace: "meli", marketplaceRotulo: "Mercado Livre",
    ativa: true, conectada: true, principal: id === 1, avisos: [],
    status: { codigo: "sincronizado", rotulo: "Sincronizado", motivo: null },
    fonte: { tipo: "api", rotulo: "API" }, resumo: resumo(), importId: 100 + id, custos: null,
    atualizadoEm: "2026-09-29T06:10:00.000Z", dadosAte: "2026-09-28", manual: null, podeLancarManual: false, ...over,
  };
}

function clienteTabela(over = {}) {
  return {
    id: 1, slug: "amr", nome: "AMR", squad: null, legado: false, competencia: "2026-09",
    escopo: { tipo: "consolidado", rotulo: "Consolidado · 2 contas", contasOperacionais: 2, contasComDado: 2 },
    status: { codigo: "sincronizado", rotulo: "Sincronizado", motivo: null, precisaAtencao: false },
    fonte: { tipo: "api", rotulo: "API" }, atualizadoEm: null, dadosAte: "2026-09-28",
    resumo: resumo({ fat: 2000, lc: 100 }), custos: null,
    contas: [contaTabela(1), contaTabela(2)], podeLancarManual: false, ...over,
  };
}

function Casca({ clientes, composicaoPorCliente = {}, carregarComposicao = vi.fn() }) {
  const expansao = useExpansao();
  return (
    <TabelaHierarquica
      clientes={clientes}
      competencia="2026-09"
      colunas={colunasVisiveis(GRUPOS_PADRAO)}
      grupos={GRUPOS_PADRAO}
      expansao={expansao}
      mesesPorCliente={{}}
      carregarMeses={vi.fn()}
      semanasPorChave={{}}
      carregarSemanas={vi.fn()}
      composicaoPorCliente={composicaoPorCliente}
      carregarComposicao={carregarComposicao}
    />
  );
}

const parcial = { estado: "parcial", cobertura: 0.62, faturamentoComCusto: 620, faturamentoSemCusto: 380 };

describe("tabela: linha de composição e marca de cálculo parcial", () => {
  it("composição é lazy: só busca ao abrir a linha, uma vez por cliente × competência", async () => {
    const carregar = vi.fn();
    render(<Casca clientes={[clienteTabela()]} carregarComposicao={carregar} />);
    await userEvent.click(screen.getByRole("button", { name: /Cliente AMR/ }));
    expect(carregar).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /Composição do faturamento de AMR/ }));
    expect(carregar).toHaveBeenCalledWith(1, "2026-09");
  });

  it("renderiza o demonstrativo carregado dentro da expansão do cliente", async () => {
    render(<Casca
      clientes={[clienteTabela()]}
      composicaoPorCliente={{ "1:2026-09": { carregando: false, erro: null, contas: [conta1, conta2], somaDasContas: soma } }}
    />);
    await userEvent.click(screen.getByRole("button", { name: /Cliente AMR/ }));
    await userEvent.click(screen.getByRole("button", { name: /Composição do faturamento de AMR/ }));
    expect(screen.getByRole("rowheader", { name: /Faturamento bruto/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Soma das contas" })).toHaveAttribute("aria-pressed", "true");
  });

  it("sem conta com pedidos importados (só manual) não há linha de composição", () => {
    const manual = contaTabela(1, { importId: null, fonte: { tipo: "manual", rotulo: "Manual" }, marketplace: "shopee" });
    expect(temComposicao(clienteTabela({ contas: [manual] }))).toBe(false);
    expect(temComposicao(clienteTabela({ contas: [contaTabela(1, { ativa: false })] }))).toBe(false);
    expect(temComposicao(clienteTabela())).toBe(true);
  });

  it("LC e MC parciais ganham a marca ◐ com a cobertura; o número não muda e o FAT não é marcado", async () => {
    render(<Casca clientes={[clienteTabela({
      custos: { ...parcial, cobertura: 0.5, faturamentoComCusto: 1000, faturamentoSemCusto: 1000 },
      contas: [contaTabela(1, { custos: parcial }), contaTabela(2, { custos: { estado: "completa", cobertura: 1, faturamentoComCusto: 1000, faturamentoSemCusto: 0 } })],
    })]} />);
    const linhaCliente = screen.getByText("AMR").closest("tr");
    expect(within(linhaCliente).getAllByText("◐ 50,0%")).toHaveLength(2); // LC e MC
    expect(within(linhaCliente).getByText("R$ 100")).toBeInTheDocument();
    expect(linhaCliente.querySelector(".vf-ph-col--fat .vf-ph-parcial")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /Cliente AMR/ }));
    const conta1Linha = screen.getByText("Mercado Livre 1").closest("tr");
    expect(within(conta1Linha).getAllByText("◐ 62,0%")).toHaveLength(2);
    expect(within(conta1Linha).getAllByLabelText(/Cálculo parcial: os custos cobrem 62,0% do FAT/)).toHaveLength(2);
    const conta2Linha = screen.getByText("Mercado Livre 2").closest("tr");
    expect(conta2Linha.querySelector(".vf-ph-parcial")).toBeNull();
  });

  it("MC do fechamento oficial: só o LC é marcado", () => {
    render(<Casca clientes={[clienteTabela({ custos: { ...parcial, indicadores: ["lc"] } })]} />);
    const linha = screen.getByText("AMR").closest("tr");
    expect(linha.querySelector(".vf-ph-col--lc .vf-ph-parcial")).not.toBeNull();
    expect(linha.querySelector(".vf-ph-col--mc .vf-ph-parcial")).toBeNull();
  });

  it("LC ausente continua '—', sem marca", () => {
    render(<Casca clientes={[clienteTabela({ resumo: resumo({ lc: null, mc: null }), custos: null })]} />);
    const linha = screen.getByText("AMR").closest("tr");
    expect(linha.querySelector(".vf-ph-parcial")).toBeNull();
  });

  it("o texto explica a fórmula sem alterá-la", () => {
    expect(textoCoberturaParcial(parcial)).toMatch(/R\$ 620,00 de R\$ 1\.000,00/);
    expect(textoCoberturaParcial(parcial)).toMatch(/MC é LC ÷ faturamento com custo/);
  });
});
