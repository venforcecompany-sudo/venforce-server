// Missão Financeiro V3 — o fluxo nativo de GERAR + SALVAR fechamento, agora
// com a experiência de BASE VINCULADA (MELI e Shopee): quando a operação já
// tem base, o formulário não pede upload de custos; sem base, o upload passa
// a ser obrigatório. Marketplace vem da operação (sem seletor na tela).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { NovoFechamento } from "./NovoFechamento.jsx";
import { montarPayloadFechamento, parseMoedaBR, cardsDoSummary } from "../../utils/fechamentoPayload.js";
import { FechamentoApiError } from "../../services/financeiroFechamentoApi.js";

const api = vi.hoisted(() => ({ processar: vi.fn(), salvar: vi.fn() }));
vi.mock("../../services/financeiroFechamentoApi.js", async (orig) => ({
  ...(await orig()),
  processarFechamento: api.processar,
  salvarEntregaFechamento: api.salvar,
}));

// A verificação da base vinculada bate em GET /base-vinculos via
// apiClient.requisitar — controlada por teste. `ehAdmin` idem (controla o
// link "Abrir diagnóstico" do banner de incidente).
const rede = vi.hoisted(() => ({ requisitar: vi.fn(), ehAdmin: vi.fn(() => false) }));
vi.mock("../../services/apiClient.js", async (orig) => ({
  ...(await orig()),
  requisitar: rede.requisitar,
  ehAdmin: rede.ehAdmin,
}));

const SUMMARY = {
  marketplace: "meli",
  grossRevenueTotal: 100000,
  paidRevenueTotal: 92000,
  contributionProfitTotal: 18000,
  averageContributionMargin: 0.2,
  finalResult: 12000,
  tacos: 0.05,
};

function respostaOk(extra = {}) {
  return {
    ok: true,
    summary: SUMMARY,
    competencia: { periodoSolicitado: "2026-08", periodoDetectado: "2026-08", divergente: false },
    detailedRows: [{ id: "MLB1", mc: 0.2 }],
    unmatchedIds: [],
    ...extra,
  };
}

// GET /base-vinculos com um vínculo para (slug, marketplace, conta).
function vinculosCom({ slug = "zenite", marketplace = "meli", contaId = 42, nome = "Base Zenite" } = {}) {
  return {
    ok: true,
    bases: [
      {
        id: 900,
        slug: "base-zenite",
        nome: nome,
        ativo: true,
        vinculo: { cliente_slug: slug, marketplace, cliente_conta_id: contaId, conta_nome: "Conta " + contaId },
      },
    ],
  };
}
const semVinculos = { ok: true, bases: [] };

const props = {
  clienteSlug: "zenite",
  clienteNome: "Zenite Comercial",
  clienteContaId: 42,
  marketplace: "meli",
  contaNome: "Loja Principal",
  periodo: "2026-08",
  periodoLabel: "Agosto/2026",
  onSalvo: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  rede.requisitar.mockResolvedValue(semVinculos);
  rede.ehAdmin.mockReturnValue(false);
});

async function subirVendas(usuario, nome = "vendas.xlsx") {
  const arquivo = new File(["a"], nome, { type: "application/vnd.ms-excel" });
  await usuario.upload(screen.getByLabelText(/Planilha de vendas/), arquivo);
}
async function subirCustos(usuario) {
  const arquivo = new File(["a"], "custos.xlsx", { type: "application/vnd.ms-excel" });
  await usuario.upload(screen.getByLabelText("Planilha de custos"), arquivo);
}

describe("fechamentoPayload", () => {
  it("parseMoedaBR entende pt-BR, vazio e número simples", () => {
    expect(parseMoedaBR("3.011,00")).toBe(3011);
    expect(parseMoedaBR("50")).toBe(50);
    expect(parseMoedaBR("")).toBeNull();
    expect(parseMoedaBR(null)).toBeNull();
  });

  it("montarPayloadFechamento congela a identidade e registra a origem dos custos", () => {
    const p = montarPayloadFechamento({
      processamento: respostaOk({ costsSource: "base", costsBase: { id: 900, slug: "base-zenite", nome: "Base Zenite" } }),
      clienteSlug: "zenite",
      clienteNome: "Zenite",
      periodo: "2026-08",
      marketplace: "meli",
      ajustes: { ads: "1.000,00" },
    });
    expect(p.cliente.slug).toBe("zenite");
    expect(p.metadados.origem).toBe("financeiro-v3-nativo");
    expect(p.metadados.ads).toBe(1000);
    expect(p.metadados.costsSource).toBe("base");
    expect(p.metadados.costsBase).toEqual({ id: 900, slug: "base-zenite", nome: "Base Zenite" });
  });

  it("costsBase fica null quando os custos vieram de upload", () => {
    const p = montarPayloadFechamento({
      processamento: respostaOk({ costsSource: "upload", costsBase: null }),
      clienteSlug: "zenite",
      periodo: "2026-08",
      marketplace: "shopee",
      ajustes: {},
    });
    expect(p.metadados.costsSource).toBe("upload");
    expect(p.metadados.costsBase).toBeNull();
  });

  it("cardsDoSummary nunca inventa R$0 para campo ausente", () => {
    const cards = cardsDoSummary({ grossRevenueTotal: 100000 });
    const semReceita = cards.find((c) => c.titulo === "Receita Líquida");
    expect(semReceita.disponivel).toBe(false);
  });
});

describe("NovoFechamento · base vinculada decide o upload de custos", () => {
  it("MELI com base vinculada: não pede planilha de custos e mostra a base", async () => {
    rede.requisitar.mockResolvedValue(vinculosCom({ marketplace: "meli", contaId: 42 }));
    render(<NovoFechamento {...props} />);
    expect(await screen.findByText("Base vinculada")).toBeInTheDocument();
    expect(screen.queryByLabelText("Planilha de custos")).not.toBeInTheDocument();
  });

  it("MELI sem base vinculada: planilha de custos vira obrigatória", async () => {
    rede.requisitar.mockResolvedValue(semVinculos);
    render(<NovoFechamento {...props} />);
    expect(await screen.findByText(/Nenhuma base vinculada para esta operação/)).toBeInTheDocument();
    expect(screen.getByLabelText("Planilha de custos")).toBeInTheDocument();
  });

  it("Shopee com base vinculada: não pede planilha de custos", async () => {
    rede.requisitar.mockResolvedValue(vinculosCom({ marketplace: "shopee", contaId: 42 }));
    render(<NovoFechamento {...props} marketplace="shopee" />);
    expect(await screen.findByText("Base vinculada")).toBeInTheDocument();
    expect(screen.queryByLabelText("Planilha de custos")).not.toBeInTheDocument();
    // Order.all é recomendado, não obrigatório
    expect(screen.getByLabelText("Order.all (Shopee)")).toBeInTheDocument();
  });

  it("Shopee sem base vinculada: planilha de custos obrigatória", async () => {
    rede.requisitar.mockResolvedValue(semVinculos);
    render(<NovoFechamento {...props} marketplace="shopee" />);
    expect(await screen.findByText(/Nenhuma base vinculada/)).toBeInTheDocument();
    expect(screen.getByLabelText("Planilha de custos")).toBeInTheDocument();
  });

  it("base de OUTRA conta não conta como base desta operação (pede upload)", async () => {
    rede.requisitar.mockResolvedValue(vinculosCom({ marketplace: "meli", contaId: 99 }));
    render(<NovoFechamento {...props} clienteContaId={42} />);
    expect(await screen.findByText(/Nenhuma base vinculada para esta operação/)).toBeInTheDocument();
  });

  it("trocar de operação re-verifica a base", async () => {
    rede.requisitar.mockResolvedValue(vinculosCom({ contaId: 42 }));
    const { rerender } = render(<NovoFechamento {...props} clienteContaId={42} />);
    await screen.findByText("Base vinculada");
    rede.requisitar.mockResolvedValue(vinculosCom({ contaId: 42 })); // vínculo é da 42
    rerender(<NovoFechamento {...props} clienteContaId={77} />);
    expect(await screen.findByText(/Nenhuma base vinculada para esta operação/)).toBeInTheDocument();
  });

  it("override: 'Usar outra planilha de custos' reabre o card de upload", async () => {
    rede.requisitar.mockResolvedValue(vinculosCom({ marketplace: "meli", contaId: 42 }));
    const usuario = userEvent.setup();
    render(<NovoFechamento {...props} />);
    await screen.findByText("Base vinculada");
    await usuario.click(screen.getByRole("button", { name: "Usar outra planilha de custos" }));
    expect(await screen.findByLabelText("Planilha de custos")).toBeInTheDocument();
    await usuario.click(screen.getByRole("button", { name: "Voltar a usar a base vinculada" }));
    await waitFor(() => expect(screen.queryByLabelText("Planilha de custos")).not.toBeInTheDocument());
  });
});

describe("NovoFechamento · marketplace vem da operação", () => {
  it("não existe seletor de marketplace na tela", async () => {
    render(<NovoFechamento {...props} />);
    await screen.findByText(/Nenhuma base vinculada/);
    expect(screen.queryByLabelText(/Marketplace/)).not.toBeInTheDocument();
  });

  it("TikTok cai no legado, sem formulário", () => {
    render(<NovoFechamento {...props} marketplace="tiktok" />);
    expect(screen.getByText(/Financeiro \(legado\)/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Planilha de vendas")).not.toBeInTheDocument();
  });
});

describe("NovoFechamento · validação e envio", () => {
  it("o botão Processar mostra o motivo do bloqueio", async () => {
    rede.requisitar.mockResolvedValue(semVinculos);
    render(<NovoFechamento {...props} />);
    await screen.findByText(/Nenhuma base vinculada/);
    // vendas + custos faltando
    expect(screen.getByText(/Falta 2 itens obrigatórios para processar\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Processar fechamento" })).toBeDisabled();
  });

  it("com base vinculada, só a planilha de vendas falta", async () => {
    rede.requisitar.mockResolvedValue(vinculosCom({ contaId: 42 }));
    render(<NovoFechamento {...props} />);
    await screen.findByText("Base vinculada");
    expect(screen.getByText(/Falta 1 item obrigatório para processar\./)).toBeInTheDocument();
  });

  it("envia multipart com periodo + clienteContaId + marketplace e mostra o preview", async () => {
    rede.requisitar.mockResolvedValue(vinculosCom({ marketplace: "meli", contaId: 42 }));
    api.processar.mockResolvedValue(respostaOk({ costsSource: "base", costsBase: { id: 900, nome: "Base Zenite" } }));
    const usuario = userEvent.setup();
    render(<NovoFechamento {...props} />);
    await screen.findByText("Base vinculada");
    await subirVendas(usuario);
    await usuario.click(screen.getByRole("button", { name: "Processar fechamento" }));

    await waitFor(() => expect(api.processar).toHaveBeenCalled());
    const form = api.processar.mock.calls[0][0];
    expect(form.get("periodo")).toBe("2026-08");
    expect(form.get("clienteContaId")).toBe("42");
    expect(form.get("marketplace")).toBe("meli");
    expect(form.get("costs")).toBeNull(); // base cobre — nada de upload
    expect(await screen.findByText(/Competência confere/)).toBeInTheDocument();
    expect(screen.getByText(/Custos da base vinculada/)).toBeInTheDocument();
  });

  it("sem base: o upload de custos vai junto no multipart", async () => {
    rede.requisitar.mockResolvedValue(semVinculos);
    api.processar.mockResolvedValue(respostaOk());
    const usuario = userEvent.setup();
    render(<NovoFechamento {...props} marketplace="shopee" />);
    await screen.findByText(/Nenhuma base vinculada/);
    await subirVendas(usuario);
    await subirCustos(usuario);
    await usuario.click(screen.getByRole("button", { name: "Processar fechamento" }));

    await waitFor(() => expect(api.processar).toHaveBeenCalled());
    const form = api.processar.mock.calls[0][0];
    expect(form.get("costs")).toBeInstanceOf(File);
  });

  it("trocar e remover arquivo de vendas", async () => {
    rede.requisitar.mockResolvedValue(vinculosCom({ contaId: 42 }));
    const usuario = userEvent.setup();
    render(<NovoFechamento {...props} />);
    await screen.findByText("Base vinculada");
    await subirVendas(usuario, "Performance_Agosto.xlsx");
    expect(screen.getByText("Performance_Agosto.xlsx")).toBeInTheDocument();
    await usuario.click(screen.getByRole("button", { name: "Remover Planilha de vendas" }));
    await waitFor(() => expect(screen.queryByText("Performance_Agosto.xlsx")).not.toBeInTheDocument());
  });
});

describe("NovoFechamento · caixa-preta (incidente FIN-xxx) + base vinculada", () => {
  it("Shopee com base vinculada: se o backend devolve incidente, o banner FIN-xxx aparece no preview", async () => {
    rede.requisitar.mockResolvedValue(vinculosCom({ marketplace: "shopee", contaId: 42, nome: "Comprou_chegou_shopee1" }));
    api.processar.mockResolvedValue(
      respostaOk({
        summary: { ...SUMMARY, marketplace: "shopee" },
        costsSource: "base",
        costsBase: { id: 55, slug: "comprou_chegou_shopee1", nome: "Comprou_chegou_shopee1" },
        incidente: { codigo: "FIN-777", mensagem: "Ocorrência de suporte FIN-777 criada." },
      })
    );
    const usuario = userEvent.setup();
    render(<NovoFechamento {...props} marketplace="shopee" />);
    await screen.findByText("Base vinculada");
    await subirVendas(usuario);
    await usuario.click(screen.getByRole("button", { name: "Processar fechamento" }));

    expect(await screen.findByText("Ocorrência de suporte FIN-777 criada")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copiar código" })).toBeInTheDocument();
    // custos da base continuam visíveis no preview (as duas features juntas)
    expect(screen.getByText(/Custos da base vinculada/)).toBeInTheDocument();
    // não-admin não vê o link de diagnóstico
    expect(screen.queryByRole("link", { name: "Abrir diagnóstico" })).not.toBeInTheDocument();
  });

  it("admin vê o link 'Abrir diagnóstico' apontando para o código do incidente", async () => {
    rede.ehAdmin.mockReturnValue(true);
    rede.requisitar.mockResolvedValue(semVinculos);
    api.processar.mockResolvedValue(respostaOk({ incidente: { codigo: "FIN-42" } }));
    const usuario = userEvent.setup();
    render(<NovoFechamento {...props} />);
    await screen.findByText(/Nenhuma base vinculada/);
    await subirVendas(usuario);
    await subirCustos(usuario);
    await usuario.click(screen.getByRole("button", { name: "Processar fechamento" }));

    const link = await screen.findByRole("link", { name: "Abrir diagnóstico" });
    expect(link).toHaveAttribute("href", "financeiro-debug.html?incidente=FIN-42");
  });

  it("sem incidente na resposta, nenhum banner FIN aparece", async () => {
    rede.requisitar.mockResolvedValue(vinculosCom({ contaId: 42 }));
    api.processar.mockResolvedValue(respostaOk());
    const usuario = userEvent.setup();
    render(<NovoFechamento {...props} />);
    await screen.findByText("Base vinculada");
    await subirVendas(usuario);
    await usuario.click(screen.getByRole("button", { name: "Processar fechamento" }));
    await screen.findByText(/Competência confere/);
    expect(screen.queryByText(/Ocorrência de suporte/)).not.toBeInTheDocument();
  });
});

describe("NovoFechamento · competência divergente", () => {
  it("não deixa salvar até confirmar a divergência", async () => {
    rede.requisitar.mockResolvedValue(vinculosCom({ contaId: 42 }));
    api.processar.mockResolvedValue(
      respostaOk({
        competencia: { periodoSolicitado: "2026-08", periodoDetectado: "2026-07", divergente: true, motivo: "Datas em julho/2026." },
      })
    );
    const usuario = userEvent.setup();
    render(<NovoFechamento {...props} />);
    await screen.findByText("Base vinculada");
    await subirVendas(usuario);
    await usuario.click(screen.getByRole("button", { name: "Processar fechamento" }));

    expect(await screen.findByText(/não bate com o período em tela/)).toBeInTheDocument();
    const salvar = screen.getByRole("button", { name: "Salvar fechamento" });
    expect(salvar).toBeDisabled();
    await usuario.click(screen.getByRole("checkbox"));
    expect(salvar).toBeEnabled();
  });
});

describe("NovoFechamento · duplicidade 409", () => {
  it("409 ENTREGA_JA_EXISTE vira cancelar/substituir; substituir manda substituir:true + cliente_conta_id", async () => {
    rede.requisitar.mockResolvedValue(vinculosCom({ marketplace: "shopee", contaId: 42 }));
    api.processar.mockResolvedValue(respostaOk({ summary: { ...SUMMARY, marketplace: "shopee" } }));
    api.salvar
      .mockRejectedValueOnce(
        new FechamentoApiError("Já existe.", { status: 409, codigo: "ENTREGA_JA_EXISTE", entregaId: 78, publicado: true })
      )
      .mockResolvedValueOnce({ id: 78, token_publico: "tok-x", publicado: true });
    const usuario = userEvent.setup();
    render(<NovoFechamento {...props} marketplace="shopee" />);
    await screen.findByText("Base vinculada");
    await subirVendas(usuario);
    await usuario.click(screen.getByRole("button", { name: "Processar fechamento" }));
    await screen.findByText(/Competência confere/);
    await usuario.click(screen.getByRole("button", { name: "Salvar fechamento" }));

    expect(await screen.findByText(/já tem um fechamento PUBLICADO/)).toBeInTheDocument();
    await usuario.click(screen.getByRole("button", { name: "Substituir" }));
    await waitFor(() => expect(api.salvar).toHaveBeenCalledTimes(2));
    expect(api.salvar.mock.calls[1][0].substituir).toBe(true);
    expect(api.salvar.mock.calls[1][0].cliente_conta_id).toBe(42);
    expect(props.onSalvo).toHaveBeenCalled();
  });
});
