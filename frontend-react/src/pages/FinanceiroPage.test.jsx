// Testes de render do Financeiro V3 (F4.1, só leitura) — React Testing
// Library + Vitest. Cobrem os contratos de honestidade do Master Spec M6:
// item de composição sem valor nunca vira R$0 · relatório/histórico com
// período inválido mostra "—", não quebra nem mostra a chave crua ·
// estado parcial/indisponível por seção (não a página inteira) · contexto
// Cliente/Conta chega correto nos links para o legado.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import FinanceiroPage from "./FinanceiroPage.jsx";
import { AUSENTE } from "../utils/numbers.js";

const mocks = vi.hoisted(() => ({
  useOperacaoAtual: vi.fn(),
  useFinanceiro: vi.fn(),
  useEntregasFechamento: vi.fn(),
}));

vi.mock("../hooks/useVfContext.js", () => ({ useOperacaoAtual: mocks.useOperacaoAtual }));
vi.mock("../hooks/useFinanceiro.js", () => ({ useFinanceiro: mocks.useFinanceiro }));
// A camada operacional (F4.2) é mockada aqui: o comportamento dela — duplo
// clique, contexto obsoleto, GET autoritativo — tem suíte própria em
// hooks/useEntregasFechamento.test.js. Aqui só interessa como a página
// REAGE ao estado que o hook publica.
vi.mock("../hooks/useEntregasFechamento.js", async (original) => ({
  ...(await original()),
  useEntregasFechamento: mocks.useEntregasFechamento,
}));

export function estadoDeEntregas(overrides = {}) {
  return {
    entregas: null, carregando: false, erro: null,
    recarregar: vi.fn(), acaoEmCurso: null, erroDeAcao: null,
    limparErroDeAcao: vi.fn(), publicar: vi.fn(), despublicar: vi.fn(),
    ...overrides,
  };
}

function operacaoPronta(overrides = {}) {
  return { pronta: true, clienteSlug: "n97", clienteContaId: 42, marketplace: "meli", ...overrides };
}

function envelope(disponivel, dados, motivo = null) {
  return { disponivel, motivo, dados };
}

function dadosBase(overrides = {}) {
  return {
    resultado: envelope(true, {
      composicao: [
        { chave: "faturamento", rotulo: "Faturamento", valor: 100000, disponivel: true },
        { chave: "frete", rotulo: "Frete", valor: null, disponivel: false },
        { chave: "comissao", rotulo: "Comissão", valor: -8000, disponivel: true },
      ],
      status: "publicado",
    }),
    conciliacao: envelope(true, {
      mpReconciliationStatus: "complete",
      summary: { ordersMatchedClean: 40, ordersMatchedWithEvents: 2, ordersTotal: 42, coveragePercent: 100, ordersDivergent: 0, paymentsSettlementPending: 0, totalPaymentNet: 95000 },
    }),
    relatorios: envelope(true, [
      { periodo: "2026-07", status: "publicado", geradoEm: "2026-08-01T10:00:00Z", publicado: true, token: "tok-1" },
      { periodo: null, status: "rascunho", geradoEm: "2026-08-02T10:00:00Z", publicado: false, token: null },
    ]),
    ...overrides,
  };
}

function mockarHooks({ dados = null, carregando = false, erro = null, operacao = operacaoPronta(), entregas = estadoDeEntregas(), periodo = "2026-08" } = {}) {
  mocks.useOperacaoAtual.mockReturnValue(operacao);
  mocks.useFinanceiro.mockReturnValue({ periodo, setPeriodo: vi.fn(), dados, carregando, erro });
  mocks.useEntregasFechamento.mockReturnValue(entregas);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("FinanceiroPage · Resultado/composição", () => {
  it("item de composição sem valor mostra '—', nunca 'R$ 0,00'", async () => {
    mockarHooks({ dados: dadosBase() });
    render(<FinanceiroPage />);

    await screen.findByText("Faturamento");
    const linhaFrete = screen.getByText("Frete").closest(".vf-fin-composicao__linha");
    expect(within(linhaFrete).getByText("—")).toBeInTheDocument();
    expect(linhaFrete.textContent).not.toContain("R$ 0,00");

    // itens com valor real continuam formatados normalmente
    expect(screen.getByText("R$ 100.000,00")).toBeInTheDocument();
  });

  it("sem fechamento processado: estado vazio com motivo e CTA que leva para a aba Fechamento (nativo), não para o legado", async () => {
    mockarHooks({
      dados: dadosBase({ resultado: envelope(false, null, "Nenhum fechamento publicado para agosto/2026.") }),
    });
    const usuario = userEvent.setup();
    render(<FinanceiroPage />);

    expect(await screen.findByText("Sem fechamento processado")).toBeInTheDocument();
    expect(screen.getByText("Nenhum fechamento publicado para agosto/2026.")).toBeInTheDocument();
    // Convergência #3 §10 — o caminho normal do V3 não manda o usuário de
    // volta para o Financeiro legado: o CTA abre a aba Fechamento nativa.
    expect(screen.queryByRole("link", { name: /Gerar no Financeiro \(legado\)/ })).not.toBeInTheDocument();
    await usuario.click(screen.getByRole("button", { name: "Gerar fechamento" }));
    // a aba Fechamento nativa abre — o formulário de geração começa pela
    // base de custos e pelos arquivos, sem seletor de marketplace
    expect(await screen.findByText("Base de custos")).toBeInTheDocument();
    expect(screen.getByText("Arquivos do fechamento")).toBeInTheDocument();
  });
});

describe("FinanceiroPage · Relatórios e Histórico (período inválido)", () => {
  it("relatório com período ausente mostra '—' na tabela, não a chave crua nem quebra", async () => {
    mockarHooks({ dados: dadosBase() });
    const usuario = userEvent.setup();
    render(<FinanceiroPage />);

    await screen.findByText("Faturamento");
    await usuario.click(screen.getByRole("tab", { name: "Relatórios gerados" }));

    const tabela = screen.getByRole("table");
    const linhas = within(tabela).getAllByRole("row").slice(1); // sem o cabeçalho
    expect(linhas[1]).toHaveTextContent("—"); // segundo relatório, periodo: null
  });

  it("histórico ordena mais recente primeiro e trata período ausente como '—'", async () => {
    mockarHooks({
      dados: dadosBase({
        relatorios: envelope(true, [
          { periodo: "2026-05", status: "publicado" },
          { periodo: "2026-07", status: "rascunho" },
          { periodo: undefined, status: "publicado" },
        ]),
      }),
    });
    const usuario = userEvent.setup();
    render(<FinanceiroPage />);

    await screen.findByText("Faturamento");
    await usuario.click(screen.getByRole("tab", { name: "Histórico" }));

    // ordenação é por localeCompare(String(periodo)) descendente — o
    // período ausente (undefined → "undefined") não quebra a ordenação,
    // só entra no lugar que a colação do locale escolhe, e some no rótulo
    const itens = screen.getAllByRole("listitem");
    const periodos = itens.map((li) => li.querySelector(".vf-fin-historico__periodo").textContent);
    expect(periodos).toEqual(["—", "Julho/2026", "Maio/2026"]);
    expect(periodos).toContain(AUSENTE);
  });
});

describe("FinanceiroPage · estado parcial/indisponível por seção", () => {
  it("conciliação indisponível não impede a aba Resultado de funcionar", async () => {
    mockarHooks({
      dados: dadosBase({ conciliacao: envelope(false, null, "Mercado Pago ainda não conectado.") }),
    });
    const usuario = userEvent.setup();
    render(<FinanceiroPage />);

    await screen.findByText("Faturamento");
    await usuario.click(screen.getByRole("tab", { name: "Conciliação" }));
    expect(screen.getByText("Mercado Pago ainda não conectado.")).toBeInTheDocument();

    await usuario.click(screen.getByRole("tab", { name: "Resultado" }));
    expect(screen.getByText("Faturamento")).toBeInTheDocument();
  });

  it("erro geral sem dados: banner de erro, não tela em branco", () => {
    mockarHooks({ dados: null, erro: { codigo: "rede", mensagem: "Falha ao carregar o Financeiro." } });
    render(<FinanceiroPage />);
    const alerta = screen.getByRole("alert");
    expect(alerta).toHaveTextContent("Não foi possível carregar o Financeiro");
    expect(alerta).toHaveTextContent("Falha ao carregar o Financeiro.");
  });

  it("contexto ainda não pronto: página não renderiza nada", () => {
    mockarHooks({ operacao: operacaoPronta({ pronta: false }), dados: null });
    const { container } = render(<FinanceiroPage />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("FinanceiroPage · contexto Cliente/Conta", () => {
  it("o cabeçalho linka pro Financeiro legado com o clienteSlug da operação atual, não outro", async () => {
    mockarHooks({ dados: dadosBase(), operacao: operacaoPronta({ clienteSlug: "extra-maquinas", clienteContaId: 51 }) });
    render(<FinanceiroPage />);

    const link = await screen.findByRole("link", { name: /Financeiro \(legado\)/ });
    expect(link).toHaveAttribute("href", "financeiro.html?cliente=extra-maquinas");
  });
});

/* ══════════════════════════════════════════════════════════════════════
   F4.2 — camada operacional das entregas de fechamento
   ══════════════════════════════════════════════════════════════════════ */

function entrega(overrides = {}) {
  return {
    id: 501, tipo: "fechamento_mensal", cliente_id: 87, cliente_slug: "n97",
    titulo: "Fechamento", periodo: "2026-08", status: "rascunho",
    publicado: false, token_publico: null,
    created_at: "2026-09-01T10:00:00Z", published_at: null,
    ...overrides,
  };
}

describe("FinanceiroPage · F4.2 publicar/despublicar", () => {
  it("rascunho do período em tela: oferece Publicar, e a confirmação NOMEIA a competência", async () => {
    const publicar = vi.fn();
    mockarHooks({ dados: dadosBase(), entregas: estadoDeEntregas({ entregas: [entrega()], publicar }) });
    const usuario = userEvent.setup();
    render(<FinanceiroPage />);

    await screen.findByText("Faturamento");
    await usuario.click(screen.getByRole("tab", { name: "Fechamento" }));
    await usuario.click(screen.getByRole("button", { name: "Publicar" }));

    // Publicar o mês errado é a armadilha deste fluxo: a pergunta diz qual é.
    expect(screen.getByText(/Publicar Agosto\/2026\?/)).toBeInTheDocument();
    expect(publicar).not.toHaveBeenCalled(); // um clique só nunca publica

    await usuario.click(screen.getByRole("button", { name: "Publicar" }));
    expect(publicar).toHaveBeenCalledWith(501);
  });

  it("Cancelar na confirmação não publica nada", async () => {
    const publicar = vi.fn();
    mockarHooks({ dados: dadosBase(), entregas: estadoDeEntregas({ entregas: [entrega()], publicar }) });
    const usuario = userEvent.setup();
    render(<FinanceiroPage />);

    await screen.findByText("Faturamento");
    await usuario.click(screen.getByRole("tab", { name: "Fechamento" }));
    await usuario.click(screen.getByRole("button", { name: "Publicar" }));
    await usuario.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(publicar).not.toHaveBeenCalled();
    expect(screen.queryByText(/Publicar Agosto\/2026\?/)).not.toBeInTheDocument();
  });

  it("entrega publicada: oferece Despublicar (a válvula que o legado nunca ligou), Abrir e Copiar link", async () => {
    const despublicar = vi.fn();
    mockarHooks({
      dados: dadosBase(),
      entregas: estadoDeEntregas({
        entregas: [entrega({ publicado: true, status: "publicado", token_publico: "tok-abc", published_at: "2026-09-02T12:00:00Z" })],
        despublicar,
      }),
    });
    const usuario = userEvent.setup();
    render(<FinanceiroPage />);

    await screen.findByText("Faturamento");
    await usuario.click(screen.getByRole("tab", { name: "Fechamento" }));

    expect(screen.getByRole("link", { name: "Abrir" })).toHaveAttribute(
      "href",
      expect.stringContaining("relatorio-publico.html?token=tok-abc")
    );
    await usuario.click(screen.getByRole("button", { name: "Despublicar" }));
    expect(screen.getByText(/Despublicar Agosto\/2026\?/)).toBeInTheDocument();
    await usuario.click(screen.getByRole("button", { name: "Despublicar" }));
    expect(despublicar).toHaveBeenCalledWith(501);
  });

  it("ação em curso numa linha desabilita a ação das OUTRAS (nada de duas escritas em voo)", async () => {
    mockarHooks({
      dados: dadosBase(),
      entregas: estadoDeEntregas({
        entregas: [entrega({ id: 501, periodo: "2026-08" }), entrega({ id: 502, periodo: "2026-07" })],
        acaoEmCurso: 501,
      }),
    });
    const usuario = userEvent.setup();
    render(<FinanceiroPage />);

    await screen.findByText("Faturamento");
    await usuario.click(screen.getByRole("tab", { name: "Relatórios gerados" }));

    const ocupada = screen.getByRole("button", { name: "Enviando…" });
    expect(ocupada).toBeDisabled();
    expect(ocupada).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Publicar" })).toBeDisabled();
  });

  it("erro de escrita fica NA LINHA que falhou e não derruba a lista", async () => {
    mockarHooks({
      dados: dadosBase(),
      entregas: estadoDeEntregas({
        entregas: [entrega({ id: 501, periodo: "2026-08" }), entrega({ id: 502, periodo: "2026-07" })],
        erroDeAcao: { id: 501, mensagem: "Cliente fora da sua carteira." },
      }),
    });
    const usuario = userEvent.setup();
    render(<FinanceiroPage />);

    await screen.findByText("Faturamento");
    await usuario.click(screen.getByRole("tab", { name: "Relatórios gerados" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Cliente fora da sua carteira.");
    expect(screen.getAllByRole("row")).toHaveLength(3); // cabeçalho + 2 entregas
  });

  it("a linha da competência em tela é marcada — a lista é do cliente inteiro, não do período", async () => {
    mockarHooks({
      dados: dadosBase(),
      entregas: estadoDeEntregas({ entregas: [entrega({ id: 501, periodo: "2026-08" }), entrega({ id: 502, periodo: "2026-06" })] }),
    });
    const usuario = userEvent.setup();
    render(<FinanceiroPage />);

    await screen.findByText("Faturamento");
    await usuario.click(screen.getByRole("tab", { name: "Relatórios gerados" }));

    const marcadas = screen.getAllByText("período em tela");
    expect(marcadas).toHaveLength(1);
    expect(marcadas[0].closest("tr")).toHaveTextContent("Agosto/2026");
    // Escopo honesto: entregas_cliente não tem cliente_conta_id.
    expect(screen.getByText(/não[\s\S]*é filtrada por conta/)).toBeInTheDocument();
  });

  it("rascunho nunca finge uma data de publicação", async () => {
    mockarHooks({ dados: dadosBase(), entregas: estadoDeEntregas({ entregas: [entrega({ published_at: null })] }) });
    const usuario = userEvent.setup();
    render(<FinanceiroPage />);

    await screen.findByText("Faturamento");
    await usuario.click(screen.getByRole("tab", { name: "Relatórios gerados" }));

    const linha = screen.getAllByRole("row")[1];
    expect(within(linha).getAllByText("—").length).toBeGreaterThan(0);
  });

  it("lista operacional falhou: tabela continua em LEITURA, com o motivo e um retry — não some", async () => {
    const recarregar = vi.fn();
    mockarHooks({
      dados: dadosBase(),
      entregas: estadoDeEntregas({ entregas: null, erro: { codigo: "rede", mensagem: "Sem conexão com o servidor." }, recarregar }),
    });
    const usuario = userEvent.setup();
    render(<FinanceiroPage />);

    await screen.findByText("Faturamento");
    await usuario.click(screen.getByRole("tab", { name: "Relatórios gerados" }));

    expect(screen.getByText("Ações indisponíveis no momento")).toBeInTheDocument();
    expect(screen.getByText("Sem conexão com o servidor.")).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument(); // a leitura sobrevive
    expect(screen.queryByRole("button", { name: "Publicar" })).not.toBeInTheDocument();

    await usuario.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(recarregar).toHaveBeenCalled();
  });

  it("sem entrega para o período em tela, a aba Fechamento explica em vez de mostrar um botão inerte", async () => {
    mockarHooks({
      dados: dadosBase(),
      periodo: "2026-08",
      entregas: estadoDeEntregas({ entregas: [entrega({ id: 502, periodo: "2026-03" })] }),
    });
    const usuario = userEvent.setup();
    render(<FinanceiroPage />);

    await screen.findByText("Faturamento");
    await usuario.click(screen.getByRole("tab", { name: "Fechamento" }));

    expect(screen.queryByRole("button", { name: "Publicar" })).not.toBeInTheDocument();
    expect(screen.getByText(/não apareceu na lista operacional/)).toBeInTheDocument();
  });
});
