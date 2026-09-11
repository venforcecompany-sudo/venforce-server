// Testes de render da Cliente 360 (React Testing Library + Vitest).
//
// Cobrem as regras que não podem regredir na interface:
//   loading · erro · fechamento completo · ausência de Ads sem zero ·
//   ponte sem Ads · simulador sem input de Ads · sem botão de corte de Ads ·
//   resultado operacional visível sem Ads · pt-BR em moeda e percentual ·
//   filtros recarregam · requisição anterior cancelada.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, within, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Cliente360Page from "./Cliente360Page.jsx";
import { payloadCliente360 } from "../test/payload.js";

const mocks = vi.hoisted(() => ({
  obterResultado: vi.fn(),
  listarClientes: vi.fn(),
  simular: vi.fn(),
  obterElasticidades: vi.fn(),
  obterPlacar: vi.fn(),
}));

vi.mock("../services/cliente360Api.js", () => mocks);

vi.mock("../services/apiClient.js", async () => {
  const real = await vi.importActual("../services/apiClient.js");
  return {
    ...real,
    ehAdmin: () => globalThis.__EH_ADMIN__ === true,
    getToken: () => "token-de-teste",
    irParaLogin: vi.fn(),
  };
});

function urlPadrao() {
  window.history.replaceState({}, "", "/cliente-360-react.html?slug=cliente-x&competencia=2026-06&compararCom=2026-05");
}

async function renderizar(payload = payloadCliente360()) {
  mocks.listarClientes.mockResolvedValue({ ok: true, clientes: [{ slug: "cliente-x", nome: "Cliente X" }] });
  mocks.obterResultado.mockResolvedValue(payload);
  mocks.obterElasticidades.mockResolvedValue({ ok: true, elasticidades: {} });
  const utils = render(<Cliente360Page />);
  await screen.findByText("Fechamento do mês");
  return utils;
}

beforeEach(() => {
  globalThis.__EH_ADMIN__ = false;
  urlPadrao();
  vi.clearAllMocks();
});

afterEach(() => { delete globalThis.__EH_ADMIN__; });

describe("Cliente 360 · estados", () => {
  it("1. renderiza o loading enquanto o fechamento não chega", async () => {
    mocks.listarClientes.mockResolvedValue({ ok: true, clientes: [] });
    mocks.obterResultado.mockReturnValue(new Promise(() => {})); // nunca resolve
    mocks.obterElasticidades.mockResolvedValue({ ok: true, elasticidades: {} });

    render(<Cliente360Page />);
    expect(await screen.findByRole("status")).toHaveTextContent("Carregando fechamento");
  });

  it("2. renderiza o erro com mensagem específica e botão de retry", async () => {
    mocks.listarClientes.mockResolvedValue({ ok: true, clientes: [] });
    mocks.obterElasticidades.mockResolvedValue({ ok: true, elasticidades: {} });
    mocks.obterResultado.mockRejectedValue(
      Object.assign(new Error("Não foi possível falar com o servidor."), { codigo: "rede" })
    );

    render(<Cliente360Page />);
    const alerta = await screen.findByRole("alert");
    expect(alerta).toHaveTextContent("Não foi possível carregar o resultado");
    expect(within(alerta).getByRole("button", { name: /tentar novamente/i })).toBeInTheDocument();
  });

  it("estado de competência sem fechamento não renderiza o simulador", async () => {
    const payload = payloadCliente360();
    payload.estado = {
      chave: "sem_fechamento",
      mensagem: "Não há fechamento sincronizado para esta competência.",
      bloqueante: true,
    };
    mocks.listarClientes.mockResolvedValue({ ok: true, clientes: [] });
    mocks.obterResultado.mockResolvedValue(payload);
    mocks.obterElasticidades.mockResolvedValue({ ok: true, elasticidades: {} });

    render(<Cliente360Page />);
    expect(await screen.findByText("Competência sem fechamento")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Simulador" })).not.toBeInTheDocument();
  });
});

describe("Cliente 360 · fechamento", () => {
  it("3. renderiza o fechamento completo, na ordem da página", async () => {
    await renderizar();

    const secoes = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(secoes).toEqual([
      "Fechamento do mês",
      "Comparação com o mês anterior",
      "Ads no fechamento",
      "Ponte do resultado operacional",
      "Produtos que mais ajudaram",
      "Produtos que mais prejudicaram",
      "Produtos no vermelho",
      "Produtos abaixo da margem-alvo (15%)",
      "Oportunidades de recuperação operacional",
      "Simulador",
      "Confiança dos dados",
    ]);
  });

  it("separa Resultado operacional de Resultado após Ads e nega 'lucro líquido'", async () => {
    await renderizar();
    expect(screen.getAllByText("Resultado operacional").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Resultado após Ads").length).toBeGreaterThan(0);
    expect(screen.getByText(/Resultado após Ads não é lucro líquido/)).toBeInTheDocument();
  });

  it("9. formata moeda em pt-BR", async () => {
    await renderizar();
    const fechamento = screen.getByText("Fechamento do mês").closest("section");
    expect(within(fechamento).getByText("R$ 100.000,00")).toBeInTheDocument();
    expect(within(fechamento).getByText("R$ 22.000,00")).toBeInTheDocument();
    expect(within(fechamento).getByText("R$ 4.100,00")).toBeInTheDocument();
    // resultado após Ads = 22.000 − 4.100
    expect(within(fechamento).getByText("R$ 17.900,00")).toBeInTheDocument();
  });

  it("10. formata percentual em pt-BR", async () => {
    await renderizar();
    const fechamento = screen.getByText("Fechamento do mês").closest("section");
    expect(within(fechamento).getByText("22,0%")).toBeInTheDocument(); // margem operacional
    expect(within(fechamento).getByText("4,1%")).toBeInTheDocument();  // TACoS
    expect(within(fechamento).getByText("17,9%")).toBeInTheDocument(); // margem após Ads
  });
});

describe("Cliente 360 · Ads", () => {
  it("4. sem Ads: mostra travessão e o motivo, nunca R$ 0,00 ou 0%", async () => {
    await renderizar(payloadCliente360({ ads: null, adsStatus: "sem_dados" }));

    const fechamento = screen.getByText("Fechamento do mês").closest("section");
    const grupoAds = fechamento.querySelector(".c360-kpis--ads");

    expect(within(grupoAds).getAllByText("—").length).toBe(4);
    expect(grupoAds.textContent).not.toContain("R$ 0,00");
    expect(grupoAds.textContent).not.toContain("0,0%");
    expect(screen.getAllByText("Sem dados de Ads").length).toBeGreaterThan(0);
  });

  it("8. resultado operacional continua visível sem Ads", async () => {
    await renderizar(payloadCliente360({ ads: null, adsStatus: "sem_grant" }));

    const fechamento = screen.getByText("Fechamento do mês").closest("section");
    expect(within(fechamento).getByText("R$ 22.000,00")).toBeInTheDocument();
    expect(within(fechamento).getByText("22,0%")).toBeInTheDocument();

    // e o restante da análise operacional segue de pé
    expect(screen.getByRole("heading", { name: "Ponte do resultado operacional" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Simulador" })).toBeInTheDocument();
    expect(screen.getByText(/Resultado após Ads indisponível/)).toBeInTheDocument();
  });

  it("o bloco de Ads é descritivo: nenhum juízo de valor", async () => {
    await renderizar();
    const bloco = screen.getByText("Ads no fechamento").closest("section");
    expect(bloco.textContent).toMatch(/O investimento em Ads passou de/);
    expect(bloco.textContent).not.toMatch(/prejudic|sem retorno|corte|cortar|reduzir|recuperar|ideal|ruim/i);
  });
});

describe("Cliente 360 · ponte", () => {
  it("5. a ponte não mostra nenhuma linha de Ads", async () => {
    await renderizar();
    const ponte = screen.getByText("Ponte do resultado operacional").closest("section");
    const linhas = ponte.querySelector(".c360-ponte__linhas");
    expect(linhas.textContent.toLowerCase()).not.toMatch(/\bads\b|tacos|campanha/);
  });

  it("começa e termina no resultado operacional", async () => {
    await renderizar();
    const ponte = screen.getByText("Ponte do resultado operacional").closest("section");
    const extremos = ponte.querySelector(".c360-ponte__extremos");
    expect(extremos.textContent).toContain("R$ 19.800,00");
    expect(extremos.textContent).toContain("R$ 22.000,00");
  });

  it("expande a linha e mostra fórmula e produtos responsáveis", async () => {
    const usuario = userEvent.setup();
    await renderizar();

    const botao = screen.getByRole("button", { name: /Custo do produto/ });
    await usuario.click(botao);

    expect(botao).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/O custo unitário dos produtos comparáveis mudou/)).toBeInTheDocument();
    expect(screen.getByText(/custo unitário atual − custo unitário anterior/)).toBeInTheDocument();
    expect(screen.getByText("R$ 150,00")).toBeInTheDocument();
    expect(screen.getByText("R$ 155,00")).toBeInTheDocument();
  });

  it("'Outros' declara a composição em vez de ser caixa-preta", async () => {
    const usuario = userEvent.setup();
    await renderizar();

    await usuario.click(screen.getByRole("button", { name: /Outros/ }));
    expect(screen.getByText("Componente agrupado")).toBeInTheDocument();
    expect(screen.getByText("Comissão")).toBeInTheDocument();
    expect(screen.getByText("Imposto")).toBeInTheDocument();
    expect(screen.getByText("+R$ 160,00")).toBeInTheDocument();
    expect(screen.getByText("−R$ 47,00")).toBeInTheDocument();
  });

  it("resíduo acima de R$ 0,01 é declarado, não escondido", async () => {
    await renderizar(payloadCliente360({ ponteFecha: false }));
    expect(screen.getByText("A soma dos fatores não fecha")).toBeInTheDocument();
    expect(screen.getByText(/Resíduo R\$ 47,50/)).toBeInTheDocument();
  });
});

describe("Cliente 360 · simulador", () => {
  it("6. o simulador não tem nenhum input de Ads", async () => {
    await renderizar();
    const simulador = screen.getByText("Simulador").closest("section");
    const inputs = [...simulador.querySelectorAll("input")];

    expect(inputs.length).toBeGreaterThan(0); // há controles, e nenhum é de Ads
    for (const input of inputs) {
      const atributos = JSON.stringify({
        name: input.name, id: input.id, label: input.getAttribute("aria-label"), placeholder: input.placeholder,
      }).toLowerCase();
      expect(atributos).not.toMatch(/ads|tacos/);
    }
  });

  it("7. não existe botão 'Cortar Ads ao TACoS-alvo'", async () => {
    await renderizar();
    expect(screen.queryByRole("button", { name: /cortar ads/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /tacos/i })).not.toBeInTheDocument();

    const cenarios = screen.getByText("Simulador").closest("section").querySelector(".c360-sim-cenarios");
    expect(cenarios.textContent).toBe(
      "Parar produtos no vermelhoSubir preços 5%Reduzir custos 5%Limpar"
    );
  });

  it("mantém Ads fixo no bloco secundário e simula pelo servidor", async () => {
    const usuario = userEvent.setup();
    await renderizar();

    mocks.simular.mockResolvedValue({
      ok: true,
      antes: { resultadoOperacional: 22000, resultadoAposAds: 17900, ads: 4100, margemOperacional: 0.22 },
      depois: { resultadoOperacional: 23550, resultadoAposAds: 19450, ads: 4100, margemOperacional: 0.24 },
      delta: { resultadoOperacional: 1550, resultadoAposAds: 1550 },
      adsMantido: 4100,
      avisos: [],
    });

    await usuario.click(screen.getByRole("button", { name: "Parar produtos no vermelho" }));

    await waitFor(() => expect(mocks.simular).toHaveBeenCalled());
    const [, argumentos] = mocks.simular.mock.calls[0];
    expect(argumentos.cenarioRapido).toBe("parar_vermelho");
    expect(argumentos.cenario.intervencoes).toEqual([{ mlb: "MLB3", pausar: true }]);
    expect(JSON.stringify(argumentos)).not.toMatch(/adsNovo|tacosAlvo/);

    const blocoAds = screen.getByText("Simulador").closest("section").querySelector(".c360-sim-ads");
    await waitFor(() => expect(blocoAds.textContent).toContain("R$ 19.450,00"));
    expect(blocoAds.textContent).toContain("R$ 4.100,00"); // Ads mantido, constante
  });
});

// VFMonthYearSelector não é um <select> nativo: escolher uma competência é
// clicar na caixa (abre o popover) e depois no mês desejado (aplica e fecha
// na hora, sem confirmação). O ano já parte correto porque a URL/estado
// inicial ("2026-06"/"2026-05") já ancora a grade no ano certo.
async function escolherCompetencia(usuario, rotuloCampo, mesAbreviado) {
  await usuario.click(screen.getByLabelText(rotuloCampo));
  await usuario.click(screen.getByRole("button", { name: mesAbreviado }));
}

describe("Cliente 360 · filtros", () => {
  it("11. alterar o filtro recarrega os dados com a nova competência", async () => {
    const usuario = userEvent.setup();
    await renderizar();

    expect(mocks.obterResultado).toHaveBeenCalledTimes(1);

    await escolherCompetencia(usuario, "Competência", "Mai");

    await waitFor(() => expect(mocks.obterResultado).toHaveBeenCalledTimes(2));
    const [slug, opcoes] = mocks.obterResultado.mock.calls[1];
    expect(slug).toBe("cliente-x");
    expect(opcoes.competencia).toBe("2026-05");
    // trocar a competência re-ancora a comparação no mês anterior
    expect(opcoes.compararCom).toBe("2026-04");
  });

  it("12. a requisição anterior é cancelada quando os filtros mudam rápido", async () => {
    const usuario = userEvent.setup();
    const sinais = [];
    mocks.listarClientes.mockResolvedValue({ ok: true, clientes: [{ slug: "cliente-x", nome: "Cliente X" }] });
    mocks.obterElasticidades.mockResolvedValue({ ok: true, elasticidades: {} });
    mocks.obterResultado.mockImplementation((_slug, opcoes) => {
      sinais.push(opcoes.signal);
      return Promise.resolve(payloadCliente360());
    });

    render(<Cliente360Page />);
    await screen.findByText("Fechamento do mês");

    await escolherCompetencia(usuario, "Competência", "Mai");
    await escolherCompetencia(usuario, "Competência", "Abr");

    await waitFor(() => expect(sinais.length).toBeGreaterThanOrEqual(3));
    // todos os sinais anteriores ao último foram abortados
    const anteriores = sinais.slice(0, -1);
    expect(anteriores.every((s) => s.aborted)).toBe(true);
    expect(sinais[sinais.length - 1].aborted).toBe(false);
  });
});

describe("Cliente 360 · placar", () => {
  it("não mostra o placar para usuário sem permissão de admin", async () => {
    await renderizar();
    expect(screen.queryByText("Placar do consultor")).not.toBeInTheDocument();
  });

  it("mostra o placar para admin sem apurar automaticamente", async () => {
    globalThis.__EH_ADMIN__ = true;
    await renderizar();
    expect(screen.getByText("Placar do consultor")).toBeInTheDocument();
    expect(mocks.obterPlacar).not.toHaveBeenCalled();
  });

  it("apura sob demanda e separa o histórico legado de Ads", async () => {
    globalThis.__EH_ADMIN__ = true;
    const usuario = userEvent.setup();
    await renderizar();

    mocks.obterPlacar.mockResolvedValue({
      ok: true, escopo: "operacional", totalRecuperado: 2640, aindaNaMesa: 500, porFator: { custo: 2640 },
      acoes: [{ id: 1, competencia: "2026-06", competenciaMedida: "2026-07", fator: "custo", tipo: "correcao_custo", mlb: "MLB2", titulo: "Produto 2", creditoApurado: 2640, contaNoTotal: true, medido: true }],
      legado: [{ id: 2, competencia: "2026-05", fator: "ads", tipo: "corte_ads", titulo: "Corte de verba", creditoApurado: 0, contaNoTotal: false }],
      observacao: "Placar ativo considera apenas ações operacionais. Investimento em Ads não é creditado.",
    });

    await usuario.click(screen.getByRole("button", { name: "Apurar placar" }));

    const placar = (await screen.findByText("Placar do consultor")).closest("section");
    // aparece no KPI do total e na linha da ação
    await waitFor(() => expect(within(placar).getAllByText("R$ 2.640,00").length).toBe(2));
    expect(within(placar).getByText(/Histórico legado/)).toBeInTheDocument();
    expect(within(placar).getByText(/Investimento em Ads não é creditado/)).toBeInTheDocument();
  });
});

describe("Cliente 360 · oportunidades", () => {
  it("o total recuperável não inclui Ads", async () => {
    await renderizar();
    const secao = screen.getByText("Oportunidades de recuperação operacional").closest("section");
    // 1550 + 500, sem verba de mídia
    expect(within(secao).getByText("R$ 2.050,00")).toBeInTheDocument();
    expect(secao.textContent.toLowerCase()).not.toMatch(/cortar ads|ads sem retorno|tacos recuper/);
    expect(within(secao).getByText(/Investimento em Ads não entra/)).toBeInTheDocument();
  });
});
