import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HistoricoTab } from "./HistoricoTab.jsx";

function estado(overrides = {}) {
  return { entregas: [], carregando: false, erro: null, recarregar: vi.fn(), ...overrides };
}
const mes = (m) => document.querySelector(`li[data-competencia="${m}"]`);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-15T12:00:00-03:00"));
});
afterEach(() => vi.useRealTimers());

describe("HistoricoTab", () => {
  it("sequência de 12 competências, inclusive meses sem fechamento", () => {
    render(<HistoricoTab relatorios={null} entregas={estado({ entregas: [{ id: 1, periodo: "2026-08", cliente_conta_id: 1, publicado: true, token_publico: "t" }] })} periodo="2026-10" clienteContaId={1} />);
    const itens = screen.getAllByRole("listitem");
    expect(itens).toHaveLength(12);
    expect(itens[0]).toHaveAttribute("data-competencia", "2026-10");
    expect(mes("2026-08")).toHaveTextContent("Publicado");
    expect(mes("2026-09")).toHaveTextContent("Sem fechamento");
    expect(mes("2026-10")).toHaveTextContent("em tela");
  });

  it("status é DESTA conta: outra conta não conta; legado é sinalizado", () => {
    const entregas = [
      { id: 2, periodo: "2026-09", cliente_conta_id: 2, publicado: true },
      { id: 3, periodo: "Setembro 2026", cliente_conta_id: null, publicado: false },
    ];
    render(<HistoricoTab relatorios={null} entregas={estado({ entregas })} periodo="2026-10" clienteContaId={1} />);
    expect(mes("2026-09")).toHaveTextContent("Sem fechamento");
    expect(mes("2026-09")).toHaveTextContent("existe fechamento legado (sem conta)");
  });

  it("duplicatas da conta no mesmo mês são declaradas", () => {
    const entregas = [
      { id: 4, periodo: "2026-07", cliente_conta_id: 1, publicado: false },
      { id: 5, periodo: "2026-07", cliente_conta_id: 1, publicado: false },
    ];
    render(<HistoricoTab relatorios={null} entregas={estado({ entregas })} periodo="2026-10" clienteContaId={1} />);
    expect(mes("2026-07")).toHaveTextContent("2 fechamentos gravados");
  });

  it("clicar num mês pede a troca de competência pela página", async () => {
    vi.useRealTimers();
    const usuario = userEvent.setup();
    const escolher = vi.fn();
    render(<HistoricoTab relatorios={null} entregas={estado()} periodo="2026-10" clienteContaId={1} onEscolherCompetencia={escolher} />);
    await usuario.click(within(mes("2026-08")).getByRole("button", { name: "Agosto/2026" }));
    expect(escolher).toHaveBeenCalledWith("2026-08");
  });

  it("modo degradado usa a leitura do GET /financeiro", () => {
    const relatorios = { disponivel: true, dados: [{ id: 9, periodo: "2026-06", clienteContaId: 1, publicado: true, token: "t", geradoEm: "2026-07-01T00:00:00Z" }] };
    render(<HistoricoTab relatorios={relatorios} entregas={estado({ entregas: null, erro: { mensagem: "x" } })} periodo="2026-10" clienteContaId={1} />);
    expect(screen.getByText(/histórico montado a partir da leitura/)).toBeInTheDocument();
    expect(mes("2026-06")).toHaveTextContent("Publicado");
  });
});

describe("HistoricoTab · revisões", () => {
  const snap = (periodo, revisao, extra = {}) => ({
    id: Number(periodo.replace("-", "")) * 10 + revisao, periodo, revisao, publicado: false, criadoEm: "2026-10-13T17:30:00.000Z", entregas: [],
    summary: { finalResult: 25000 + revisao * 1000, contributionMarginCalculated: 0.15, calculatedCoveragePercent: 90 + revisao, grossRevenueTotal: 100000 },
    contagens: { pendencias: 10 - revisao },
    ...extra,
  });

  it("mês mostra a revisão mais nova, a publicada e os números; meses sem revisão seguem iguais", () => {
    const snapshots = { snapshots: [snap("2026-09", 2), snap("2026-09", 1, { publicado: true }), snap("2026-08", 1)] };
    render(<HistoricoTab relatorios={null} entregas={estado()} periodo="2026-10" clienteContaId={1} snapshots={snapshots} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(12);
    expect(mes("2026-09")).toHaveTextContent("v2 · publicado v1 · v2 mais nova");
    expect(mes("2026-09")).toHaveTextContent(/Resultado R\$\s?27\.000,00 · MC 15,0% · Cobertura 92,0%/);
    expect(mes("2026-09")).toHaveTextContent("2 revisões · comparar com Agosto/2026");
    expect(mes("2026-08")).toHaveTextContent("v1 · não publicada");
    const so1Publicada = { snapshots: [snap("2026-07", 1, { publicado: true })] };
    render(<HistoricoTab relatorios={null} entregas={estado()} periodo="2026-10" clienteContaId={1} snapshots={so1Publicada} />);
    expect(document.querySelectorAll('li[data-competencia="2026-07"]')[1]).toHaveTextContent("v1 · publicada");
    expect(mes("2026-07").querySelector("[data-revisoes]")).toBeNull();
  });

  it("abrir lista as revisões (Abrir vN pede competência + revisão) e compara com o mês anterior", async () => {
    vi.useRealTimers();
    const usuario = userEvent.setup();
    const escolher = vi.fn();
    const snapshots = { snapshots: [snap("2026-09", 2), snap("2026-09", 1, { publicado: true }), snap("2026-08", 1)] };
    render(<HistoricoTab relatorios={null} entregas={estado()} periodo="2026-10" clienteContaId={1} snapshots={snapshots} onEscolherCompetencia={escolher} />);
    await usuario.click(within(mes("2026-09")).getByText(/2 revisões/));
    const tabela = within(mes("2026-09")).getByRole("table", { name: "Revisões de Setembro/2026" });
    expect(within(tabela).getAllByRole("row")).toHaveLength(3);
    await usuario.click(within(tabela).getByRole("button", { name: "Abrir v1" }));
    expect(escolher).toHaveBeenCalledWith("2026-09", 202609 * 10 + 1);
    // Setembro (v2) × Agosto (v1): frases determinísticas
    expect(within(mes("2026-09")).getByText(/Resultado Final subiu 3,8%\./)).toBeInTheDocument();
    expect(within(mes("2026-09")).getByText("Cobertura melhorou de 91,0% para 92,0%.")).toBeInTheDocument();
  });
});
