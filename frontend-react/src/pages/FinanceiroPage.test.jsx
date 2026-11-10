// Testes de render do Financeiro V3 — paridade operacional.
//
// Modelo B: uma tela só (a mesa do fechamento), sem abas; Histórico e
// Relatórios abrem drawers pelo cabeçalho. O que se protege aqui:
//   · honestidade M6: item sem valor nunca vira R$ 0,00;
//   · contexto do Shell (cliente/conta na sidebar) — sem seletor próprio;
//   · competência por extenso, status DESTA conta e troca com confirmação;
//   · publicar/despublicar só na entrega desta conta, nomeando a competência.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import FinanceiroPage from "./FinanceiroPage.jsx";

const mocks = vi.hoisted(() => ({
  useOperacaoAtual: vi.fn(),
  useFinanceiro: vi.fn(),
  useEntregasFechamento: vi.fn(),
  requisitar: vi.fn(),
  setPeriodo: vi.fn(),
}));

vi.mock("../hooks/useVfContext.js", () => ({ useOperacaoAtual: mocks.useOperacaoAtual }));
vi.mock("../hooks/useFinanceiro.js", () => ({ useFinanceiro: mocks.useFinanceiro }));
// A camada operacional é mockada aqui: o comportamento dela — duplo clique,
// contexto obsoleto, GET autoritativo — tem suíte própria em
// hooks/useEntregasFechamento.test.js. Aqui só interessa como a página REAGE.
vi.mock("../hooks/useEntregasFechamento.js", async (original) => ({
  ...(await original()),
  useEntregasFechamento: mocks.useEntregasFechamento,
}));
// GET /base-vinculos (verificação da base no formulário) — sem vínculo.
vi.mock("../services/apiClient.js", async (orig) => ({
  ...(await orig()),
  requisitar: mocks.requisitar,
}));
// Modo API (padrão em MELI): a competência tem pedidos sincronizados. Os testes
// desta página exercitam a tela, não o sync — o status é fixo e completo.
vi.mock("../services/fechamentoViaApiApi.js", async (orig) => ({
  ...(await orig()),
  obterStatusFechamentoApi: vi.fn(async () => ({
    ok: true,
    sync: { disponivel: true, importId: 7, publicadoEm: "2026-09-02T03:12:00Z", coberturaDe: "2026-08-01", coberturaAte: "2026-08-31", completo: true, motivoIncompleto: null },
    runEmAndamento: null,
  })),
}));

// Abre o preparo pela etapa "Base de custos" (sempre presente no painel) e
// escolhe a origem planilha (o padrão é a API).
async function escolherPlanilhaNoPreparo(usuario) {
  await usuario.click(screen.getByRole("button", { name: /: Base de custos$/ }));
  const drawer = screen.getByRole("dialog", { name: "Preparar fechamento" });
  await usuario.click(within(within(drawer).getByRole("group", { name: "Origem das vendas" })).getByRole("button", { name: "Planilha de vendas" }));
  return drawer;
}

export function estadoDeEntregas(overrides = {}) {
  return {
    entregas: null, carregando: false, erro: null,
    recarregar: vi.fn(), acaoEmCurso: null, erroDeAcao: null,
    limparErroDeAcao: vi.fn(), publicar: vi.fn(), despublicar: vi.fn(), excluir: vi.fn(),
    ...overrides,
  };
}

function operacaoPronta(overrides = {}) {
  return {
    pronta: true,
    clienteId: 87,
    clienteSlug: "n97",
    // contrato real de useOperacaoAtual(): o nome vem de snapshot.cliente
    // (carteira do Shell), nunca de snapshot.context — que só tem identidade.
    clienteNome: "Influência Jeans",
    clienteContaId: 42,
    marketplace: "meli",
    snapshot: {
      state: "READY",
      context: { clienteId: 87, clienteSlug: "n97", clienteContaId: 42 },
      cliente: { id: 87, slug: "n97", nome: "Influência Jeans" },
      meta: { nome: "Mercado Livre 1", externalAccountLabel: "2574840252" },
    },
    ...overrides,
  };
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
        { chave: "mc", rotulo: "MC Calculada (%)", valor: 20, disponivel: true },
      ],
      status: "publicado",
    }),
    conciliacao: envelope(true, {
      mpReconciliationStatus: "complete",
      summary: { ordersMatchedClean: 40, ordersMatchedWithEvents: 2, ordersTotal: 42, coveragePercent: 100, ordersDivergent: 0, paymentsSettlementPending: 0, totalPaymentNet: 95000 },
    }),
    relatorios: envelope(true, [
      { periodo: "2026-07", status: "publicado", geradoEm: "2026-08-01T10:00:00Z", publicado: true, token: "tok-1", clienteContaId: 42 },
      { periodo: null, status: "rascunho", geradoEm: "2026-08-02T10:00:00Z", publicado: false, token: null, clienteContaId: null },
    ]),
    ...overrides,
  };
}

function mockarHooks({ dados = null, carregando = false, erro = null, operacao = operacaoPronta(), entregas = estadoDeEntregas(), periodo = "2026-08" } = {}) {
  mocks.useOperacaoAtual.mockReturnValue(operacao);
  mocks.useFinanceiro.mockReturnValue({ periodo, setPeriodo: mocks.setPeriodo, dados, carregando, erro, recarregar: vi.fn() });
  mocks.useEntregasFechamento.mockReturnValue(entregas);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requisitar.mockResolvedValue({ ok: true, bases: [] });
});

describe("FinanceiroPage · modelo B (mesa sem abas)", () => {
  it("uma tela só: sem abas; Histórico e Relatórios abrem drawers pelo cabeçalho", async () => {
    const usuario = userEvent.setup();
    mockarHooks({ dados: dadosBase() });
    render(<FinanceiroPage />);
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    await usuario.click(screen.getByRole("button", { name: "Histórico" }));
    expect(screen.getByRole("dialog", { name: "Histórico" })).toBeInTheDocument();
  });

  it("o painel lateral lista as seis etapas do fechamento e o próximo passo", async () => {
    mockarHooks({ dados: dadosBase(), entregas: estadoDeEntregas({ entregas: [] }) });
    render(<FinanceiroPage />);
    const painel = screen.getByRole("complementary", { name: "Etapas do fechamento" });
    const etapas = Array.from(painel.querySelectorAll("[data-etapa]")).map((e) => e.dataset.etapa);
    expect(etapas).toEqual(["base", "arquivos", "ajustes", "processar", "pendencias", "publicar"]);
    // Na API, com o sync do mês presente, o próximo passo é processar (a base não é exigida).
    expect(await within(painel).findByRole("button", { name: /Processar fechamento/ })).toBeInTheDocument();
  });

  it("a etapa Base de custos abre o drawer com a origem (API por padrão), base e ajustes", async () => {
    const usuario = userEvent.setup();
    mockarHooks({ dados: dadosBase(), entregas: estadoDeEntregas({ entregas: [] }) });
    render(<FinanceiroPage />);
    await usuario.click(screen.getByRole("button", { name: /: Base de custos$/ }));
    const drawer = screen.getByRole("dialog", { name: "Preparar fechamento" });
    const grupo = within(drawer).getByRole("group", { name: "Origem das vendas" });
    expect(within(grupo).getByRole("button", { name: "API do Mercado Livre" })).toHaveAttribute("aria-pressed", "true");
    expect(within(drawer).getByText("Custos")).toBeInTheDocument();
    expect(within(drawer).getByText("Ajustes do período")).toBeInTheDocument();
  });

  it("na origem planilha, o drawer de preparo traz o card de vendas", async () => {
    const usuario = userEvent.setup();
    mockarHooks({ dados: dadosBase(), entregas: estadoDeEntregas({ entregas: [] }) });
    render(<FinanceiroPage />);
    const drawer = await escolherPlanilhaNoPreparo(usuario);
    expect(within(drawer).getByLabelText(/Planilha de vendas/)).toBeInTheDocument();
  });
});

describe("FinanceiroPage · fechamento salvo", () => {
  it("item de composição sem valor mostra '—', nunca 'R$ 0,00'; percentual não vira R$", () => {
    mockarHooks({ dados: dadosBase() });
    render(<FinanceiroPage />);
    const linhaFrete = screen.getByText("Frete").closest(".vf-fin-composicao__linha");
    expect(within(linhaFrete).getByText("—")).toBeInTheDocument();
    expect(within(linhaFrete).queryByText("R$ 0,00")).not.toBeInTheDocument();
    expect(screen.getByText("R$ 100.000,00")).toBeInTheDocument();
    const linhaMc = screen.getByText("MC Calculada (%)").closest(".vf-fin-composicao__linha");
    expect(within(linhaMc).getByText("20,0%")).toBeInTheDocument();
  });

  it("sem fechamento salvo: a mesa diz que o mês ainda não foi fechado", () => {
    mockarHooks({ dados: dadosBase({ resultado: envelope(false, null, "Nenhum fechamento gerado para este período.") }) });
    render(<FinanceiroPage />);
    expect(screen.getByText("Agosto/2026 ainda não foi fechado")).toBeInTheDocument();
    expect(screen.queryByText(/não tem linhas de composição/)).not.toBeInTheDocument();
  });

  it("conciliação Mercado Pago continua à vista (MELI) e indisponível não derruba o resto", () => {
    mockarHooks({ dados: dadosBase({ conciliacao: envelope(false, null, "Mercado Pago ainda não conectado.") }) });
    render(<FinanceiroPage />);
    expect(screen.getByText("Conciliação Mercado Pago (Central de Vendas)")).toBeInTheDocument();
    expect(screen.getByText("Mercado Pago ainda não conectado.")).toBeInTheDocument();
    expect(screen.getByText("Faturamento")).toBeInTheDocument();
  });

  it("Shopee não mostra o bloco de conciliação Mercado Pago", () => {
    mockarHooks({ dados: dadosBase(), operacao: operacaoPronta({ marketplace: "shopee" }) });
    render(<FinanceiroPage />);
    expect(screen.queryByText("Conciliação Mercado Pago (Central de Vendas)")).not.toBeInTheDocument();
  });

  it("erro geral sem dados: banner de erro e a mesa continua disponível", () => {
    mockarHooks({ erro: { mensagem: "Falha de rede." } });
    render(<FinanceiroPage />);
    expect(screen.getByRole("alert")).toHaveTextContent("Falha de rede.");
    expect(screen.getByRole("complementary", { name: "Etapas do fechamento" })).toBeInTheDocument();
  });

  it("contexto ainda não pronto: página não renderiza nada", () => {
    mockarHooks({ operacao: { pronta: false, snapshot: { state: "LOADING" } } });
    const { container } = render(<FinanceiroPage />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("FinanceiroPage · contexto do Shell", () => {
  it("cliente e conta ficam na sidebar: a página não tem barra de contexto nem seletores próprios", () => {
    mockarHooks({ dados: dadosBase() });
    render(<FinanceiroPage />);
    expect(screen.queryByTestId("contexto-fechamento")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByText("Mercado Livre · Financeiro")).toBeInTheDocument();
  });

  it("nome do cliente aparece na entrega para o cliente", async () => {
    const usuario = userEvent.setup();
    mockarHooks({
      dados: dadosBase(),
      entregas: estadoDeEntregas({ entregas: [{ id: 7, periodo: "2026-08", cliente_conta_id: 42, publicado: false, token_publico: null, created_at: "2026-08-20T10:00:00Z" }] }),
    });
    render(<FinanceiroPage />);
    await usuario.click(screen.getByRole("button", { name: "Editar apresentação" }));
    const identidade = screen.getByTestId("identidade-entrega");
    expect(within(identidade).getByText("Cliente").nextSibling).toHaveTextContent("Influência Jeans");
  });

  it("troca de operação no Shell atualiza o marketplace do cabeçalho — nada stale", () => {
    mockarHooks({ dados: dadosBase() });
    const { rerender } = render(<FinanceiroPage />);
    expect(screen.getByText("Mercado Livre · Financeiro")).toBeInTheDocument();
    mockarHooks({
      dados: dadosBase(),
      operacao: operacaoPronta({
        clienteId: 90, clienteSlug: "zenite", clienteNome: "Zenite Comercial", clienteContaId: 77, marketplace: "shopee",
        snapshot: { state: "READY", context: { clienteId: 90, clienteSlug: "zenite", clienteContaId: 77 }, cliente: { id: 90, slug: "zenite", nome: "Zenite Comercial" }, meta: { nome: "Shopee Zenite", externalAccountLabel: null } },
      }),
    });
    rerender(<FinanceiroPage />);
    expect(screen.getByText("Shopee · Financeiro")).toBeInTheDocument();
    expect(screen.queryByText("Mercado Livre · Financeiro")).not.toBeInTheDocument();
  });

  it("sem nome na carteira: fallback neutro '—' na entrega, nunca o slug no lugar do nome", async () => {
    const usuario = userEvent.setup();
    mockarHooks({
      dados: dadosBase(),
      operacao: operacaoPronta({ clienteSlug: "influencia-jeans", clienteNome: null, snapshot: { state: "READY", context: { clienteId: 87, clienteSlug: "influencia-jeans", clienteContaId: 42 }, cliente: { id: 87, slug: "influencia-jeans", nome: null }, meta: { nome: "Mercado Livre 1" } } }),
      entregas: estadoDeEntregas({ entregas: [{ id: 7, periodo: "2026-08", cliente_conta_id: 42, publicado: false, token_publico: null, created_at: "2026-08-20T10:00:00Z" }] }),
    });
    render(<FinanceiroPage />);
    await usuario.click(screen.getByRole("button", { name: "Editar apresentação" }));
    expect(within(screen.getByTestId("identidade-entrega")).getByText("Cliente").nextSibling).toHaveTextContent(/^—$/);
  });

  it("o cabeçalho linka pro Financeiro legado com o clienteSlug da operação atual", () => {
    mockarHooks({ dados: dadosBase(), operacao: operacaoPronta({ clienteSlug: "zenite" }) });
    render(<FinanceiroPage />);
    expect(screen.getAllByRole("link", { name: /Financeiro \(legado\)/ })[0]).toHaveAttribute("href", "financeiro.html?cliente=zenite");
  });
});

describe("FinanceiroPage · competência do fechamento", () => {
  it("competência por extenso e status 'Sem fechamento' quando a conta não tem entrega", () => {
    mockarHooks({ dados: dadosBase(), entregas: estadoDeEntregas({ entregas: [] }) });
    render(<FinanceiroPage />);
    expect(screen.getByTestId("competencia-extenso")).toHaveTextContent("Agosto/2026");
    expect(screen.getByTestId("status-competencia")).toHaveTextContent("Sem fechamento");
  });

  it("status vem da entrega DESTA conta: rascunho e publicado", () => {
    mockarHooks({
      dados: dadosBase(),
      entregas: estadoDeEntregas({ entregas: [{ id: 7, periodo: "2026-08", publicado: false, cliente_conta_id: 42 }] }),
    });
    const { rerender } = render(<FinanceiroPage />);
    expect(screen.getByTestId("status-competencia")).toHaveTextContent("Rascunho salvo");

    mockarHooks({
      dados: dadosBase(),
      entregas: estadoDeEntregas({ entregas: [{ id: 7, periodo: "2026-08", publicado: true, token_publico: "t", cliente_conta_id: 42 }] }),
    });
    rerender(<FinanceiroPage />);
    expect(screen.getByTestId("status-competencia")).toHaveTextContent("Publicado");
  });

  it("entrega legada (sem conta) e de OUTRA conta não viram status desta conta", () => {
    mockarHooks({
      dados: dadosBase(),
      entregas: estadoDeEntregas({
        entregas: [
          { id: 8, periodo: "2026-08", publicado: true, token_publico: "a", cliente_conta_id: null },
          { id: 9, periodo: "2026-08", publicado: true, token_publico: "b", cliente_conta_id: 77 },
        ],
      }),
    });
    render(<FinanceiroPage />);
    expect(screen.getByTestId("status-competencia")).toHaveTextContent("Sem fechamento");
    expect(screen.getByText(/fechamento legado desta competência sem operação registrada/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Despublicar" })).not.toBeInTheDocument();
  });

  it("sem trabalho em andamento, trocar a competência troca direto", async () => {
    const usuario = userEvent.setup();
    mockarHooks({ dados: dadosBase(), entregas: estadoDeEntregas({ entregas: [] }) });
    render(<FinanceiroPage />);
    await usuario.click(screen.getByRole("button", { name: "Ago 2026" }));
    await usuario.click(screen.getByRole("button", { name: "Set" }));
    expect(mocks.setPeriodo).toHaveBeenCalledWith("2026-09");
  });

  it("com arquivo escolhido, trocar a competência pede confirmação nomeando os dois meses", async () => {
    const usuario = userEvent.setup();
    mockarHooks({ dados: dadosBase(), entregas: estadoDeEntregas({ entregas: [] }) });
    render(<FinanceiroPage />);
    await escolherPlanilhaNoPreparo(usuario);
    await usuario.upload(screen.getByLabelText(/Planilha de vendas/), new File(["a"], "vendas.xlsx"));
    await usuario.click(screen.getByRole("button", { name: "Cancelar" }));

    await usuario.click(screen.getByRole("button", { name: "Ago 2026" }));
    await usuario.click(screen.getByRole("button", { name: "Nov" }));
    expect(mocks.setPeriodo).not.toHaveBeenCalled();
    const confirmacao = screen.getByRole("alertdialog", { name: "Confirmar troca de competência" });
    expect(confirmacao).toHaveTextContent("Trocar para Novembro/2026 irá limpar o processamento atual de Agosto/2026");

    await usuario.click(within(confirmacao).getByRole("button", { name: "Manter Agosto/2026" }));
    expect(mocks.setPeriodo).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

    await usuario.click(screen.getByRole("button", { name: "Ago 2026" }));
    await usuario.click(screen.getByRole("button", { name: "Nov" }));
    await usuario.click(screen.getByRole("button", { name: "Trocar e limpar" }));
    expect(mocks.setPeriodo).toHaveBeenCalledWith("2026-11");
  });
});

describe("FinanceiroPage · publicar/despublicar a entrega desta conta", () => {
  it("rascunho desta conta: Publicar pede confirmação que NOMEIA a competência", async () => {
    const usuario = userEvent.setup();
    const entregas = estadoDeEntregas({ entregas: [{ id: 7, periodo: "2026-08", publicado: false, cliente_conta_id: 42 }] });
    mockarHooks({ dados: dadosBase(), entregas });
    render(<FinanceiroPage />);
    await usuario.click(screen.getByRole("button", { name: /^Publicar/ }));
    expect(screen.getByText(/Publicar Agosto\/2026\?/)).toBeInTheDocument();
    await usuario.click(screen.getByRole("button", { name: "Publicar" }));
    expect(entregas.publicar).toHaveBeenCalledWith(7);
  });

  it("Cancelar na confirmação não publica nada", async () => {
    const usuario = userEvent.setup();
    const entregas = estadoDeEntregas({ entregas: [{ id: 7, periodo: "2026-08", publicado: false, cliente_conta_id: 42 }] });
    mockarHooks({ dados: dadosBase(), entregas });
    render(<FinanceiroPage />);
    await usuario.click(screen.getByRole("button", { name: /^Publicar/ }));
    await usuario.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(entregas.publicar).not.toHaveBeenCalled();
  });

  it("entrega publicada: Copiar link e Abrir link no painel; Despublicar na entrega", async () => {
    const usuario = userEvent.setup();
    const entregas = estadoDeEntregas({
      entregas: [{ id: 7, periodo: "2026-08", publicado: true, token_publico: "tok-abc", published_at: "2026-09-01T10:00:00Z", cliente_conta_id: 42 }],
    });
    mockarHooks({ dados: dadosBase(), entregas });
    render(<FinanceiroPage />);
    const painel = screen.getByRole("complementary", { name: "Etapas do fechamento" });
    expect(within(painel).getByRole("link", { name: "Abrir link" })).toHaveAttribute("href", expect.stringContaining("relatorio-publico.html?token=tok-abc"));
    expect(within(painel).getByRole("button", { name: /Copiar link/ })).toBeInTheDocument();
    await usuario.click(within(painel).getByRole("button", { name: "Apresentação e link" }));
    const drawer = screen.getByRole("dialog", { name: "Entrega para o cliente" });
    await usuario.click(within(drawer).getByRole("button", { name: "Despublicar" }));
    expect(within(drawer).getByText(/Despublicar Agosto\/2026\?/)).toBeInTheDocument();
    await usuario.click(within(drawer).getByRole("button", { name: "Despublicar" }));
    expect(entregas.despublicar).toHaveBeenCalledWith(7);
  });
});

describe("FinanceiroPage · Relatórios e Histórico (drawers do cabeçalho)", () => {
  it("Relatórios identifica a conta da operação e o legado, linha a linha", async () => {
    const usuario = userEvent.setup();
    mockarHooks({
      dados: dadosBase(),
      operacao: operacaoPronta({ marketplace: "shopee", clienteNome: "Loja", snapshot: { state: "READY", context: { clienteId: 87, clienteSlug: "n97", clienteContaId: 42 }, cliente: { id: 87, slug: "n97", nome: "Loja" }, meta: { nome: "Shopee 2", externalAccountLabel: "shop-2" } } }),
      entregas: estadoDeEntregas({
        entregas: [
          { id: 11, periodo: "2026-08", cliente_conta_id: 42, publicado: false, modo_calculo: "real_financial", cobertura_custo_percentual: "97.5" },
          { id: 12, periodo: "Julho 2026", cliente_conta_id: null, publicado: false, marketplace_payload: "shopee" },
        ],
      }),
    });
    render(<FinanceiroPage />);
    await usuario.click(screen.getByRole("button", { name: "Relatórios" }));
    const tabela = within(screen.getByRole("dialog", { name: "Relatórios" })).getByRole("table");
    expect(within(tabela).getByText("Shopee · Shopee 2 · shop-2")).toBeInTheDocument();
    expect(within(tabela).getByText("Legado · operação não registrada (Shopee)")).toBeInTheDocument();
    expect(within(tabela).getByText("97,5%")).toBeInTheDocument();
  });

  it("abrir e fechar o Histórico não perde o arquivo escolhido no preparo", async () => {
    const usuario = userEvent.setup();
    mockarHooks({ dados: dadosBase(), entregas: estadoDeEntregas({ entregas: [] }) });
    render(<FinanceiroPage />);
    await escolherPlanilhaNoPreparo(usuario);
    await usuario.upload(screen.getByLabelText(/Planilha de vendas/), new File(["a"], "vendas-agosto.xlsx"));
    await usuario.click(screen.getByRole("button", { name: "Cancelar" }));
    await usuario.click(screen.getByRole("button", { name: "Histórico" }));
    await usuario.keyboard("{Escape}");
    const painel = screen.getByRole("complementary", { name: "Etapas do fechamento" });
    expect(within(painel).getByText("vendas-agosto.xlsx")).toBeInTheDocument();
  });

  it("Histórico: escolher um mês sem trabalho em andamento troca a competência e fecha o drawer", async () => {
    const usuario = userEvent.setup();
    mockarHooks({ dados: dadosBase(), entregas: estadoDeEntregas({ entregas: [] }) });
    render(<FinanceiroPage />);
    await usuario.click(screen.getByRole("button", { name: "Histórico" }));
    await usuario.click(screen.getByRole("button", { name: "Julho/2026" }));
    expect(mocks.setPeriodo).toHaveBeenCalledWith("2026-07");
    expect(screen.queryByRole("dialog", { name: "Histórico" })).not.toBeInTheDocument();
  });
});
