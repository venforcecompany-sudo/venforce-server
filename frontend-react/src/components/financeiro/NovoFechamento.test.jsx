// Missão Financeiro V3 — o fluxo nativo de GERAR + SALVAR fechamento, agora
// com a experiência de BASE VINCULADA (MELI e Shopee): quando a operação já
// tem base, o formulário não pede upload de custos; sem base, o upload passa
// a ser obrigatório. Marketplace vem da operação (sem seletor na tela).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { useEffect } from "react";
import userEvent from "@testing-library/user-event";

import { NovoFechamento } from "./NovoFechamento.jsx";
import { montarPayloadFechamento, parseMoedaBR, cardsDoSummary } from "../../utils/fechamentoPayload.js";
import { FechamentoApiError } from "../../services/financeiroFechamentoApi.js";

const api = vi.hoisted(() => ({ processar: vi.fn(), salvar: vi.fn(), salvarSnapshot: vi.fn() }));
vi.mock("../../services/financeiroFechamentoApi.js", async (orig) => ({
  ...(await orig()),
  processarFechamento: api.processar,
  salvarEntregaFechamento: api.salvar,
  salvarSnapshotFechamento: api.salvarSnapshot,
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
    excelBase64: "UEsDB-planilha",
    // Selo do servidor (seloProcessamento.js) — sem ele não há revisão.
    processamento: { versao: 1, processadoEm: "2026-08-31T12:00:00.000Z", selo: "a".repeat(64), arquivos: [] },
    ...extra,
  };
}

const REVISAO_1 = { id: 77, revisao: 1, criadoEm: "2026-10-13T17:30:00.000Z", periodo: "2026-08", entregas: [] };

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
  api.salvarSnapshot.mockResolvedValue({ snapshot: REVISAO_1, reaproveitado: false });
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
    expect(p.cliente).toEqual({ slug: "zenite", nome: "Zenite" });
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
    expect(screen.getByText(/custos: base vinculada Base Zenite/)).toBeInTheDocument();
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

    expect(await screen.findByText("FIN-777")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copiar código" })).toBeInTheDocument();
    // custos da base continuam visíveis no preview (as duas features juntas)
    expect(screen.getByText(/custos: base vinculada Comprou_chegou_shopee1/)).toBeInTheDocument();
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

describe("NovoFechamento · identidade do cliente no payload", () => {
  it("salvar grava cliente.nome com o nome real do contexto (e o slug à parte)", async () => {
    rede.requisitar.mockResolvedValue(vinculosCom({ marketplace: "meli", contaId: 42 }));
    api.processar.mockResolvedValue(respostaOk());
    api.salvar.mockResolvedValue({ id: 5, publicado: false, token_publico: null });
    const usuario = userEvent.setup();
    render(<NovoFechamento {...props} />);
    await screen.findByText("Base vinculada");
    await subirVendas(usuario);
    await usuario.click(screen.getByRole("button", { name: "Processar fechamento" }));
    await screen.findByText(/Competência confere/);
    await usuario.click(screen.getByRole("button", { name: "Salvar fechamento" }));
    await waitFor(() => expect(api.salvar).toHaveBeenCalledTimes(1));
    expect(api.salvar.mock.calls[0][0].payload_json.cliente).toEqual({ slug: "zenite", nome: "Zenite Comercial" });
  });

  it("sem nome no contexto, cliente.nome fica null — nunca o slug", () => {
    const p = montarPayloadFechamento({ processamento: respostaOk(), clienteSlug: "zenite", clienteNome: null, periodo: "2026-08", marketplace: "meli" });
    expect(p.cliente).toEqual({ slug: "zenite", nome: null });
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
    // Substituir é sobre a ENTREGA: a revisão gravada antes do 409 é a mesma.
    expect(api.salvarSnapshot).toHaveBeenCalledTimes(1);
    expect(api.salvar.mock.calls[1][0].snapshot_id).toBe(77);
    expect(props.onSalvo).toHaveBeenCalled();
  });

  it("o 409 diz que a revisão já ficou salva (cancelar não a apaga)", async () => {
    rede.requisitar.mockResolvedValue(vinculosCom({ marketplace: "meli", contaId: 42 }));
    api.processar.mockResolvedValue(respostaOk());
    api.salvar.mockRejectedValueOnce(new FechamentoApiError("Já existe.", { status: 409, codigo: "ENTREGA_JA_EXISTE", entregaId: 78, publicado: false }));
    const usuario = userEvent.setup();
    render(<NovoFechamento {...props} />);
    await screen.findByText("Base vinculada");
    await subirVendas(usuario);
    await usuario.click(screen.getByRole("button", { name: "Processar fechamento" }));
    await screen.findByText(/Competência confere/);
    await usuario.click(screen.getByRole("button", { name: "Salvar fechamento" }));
    expect(await screen.findByText(/já está salva no histórico \(cancelar não a apaga\)/)).toBeInTheDocument();
  });
});

describe("NovoFechamento · revisão (snapshot)", () => {
  async function processarMeli(usuario, extraProps = {}) {
    rede.requisitar.mockResolvedValue(vinculosCom({ marketplace: "meli", contaId: 42 }));
    render(<NovoFechamento {...props} {...extraProps} />);
    await screen.findByText("Base vinculada");
    await subirVendas(usuario);
    await usuario.click(screen.getByRole("button", { name: "Processar fechamento" }));
    await screen.findByText(/Competência confere/);
  }

  it("grava a revisão com o resultado do motor + selo (sem a planilha) e a entrega aponta para ela", async () => {
    api.processar.mockResolvedValue(respostaOk());
    api.salvar.mockResolvedValue({ id: 5, publicado: false, token_publico: null });
    const usuario = userEvent.setup();
    await processarMeli(usuario);
    expect(screen.getByText(/Ainda não salvo\./)).toBeInTheDocument();
    await usuario.click(screen.getByRole("button", { name: "Salvar fechamento" }));
    await waitFor(() => expect(api.salvar).toHaveBeenCalledTimes(1));

    const corpo = api.salvarSnapshot.mock.calls[0][0];
    expect(corpo).toMatchObject({ clienteSlug: "zenite", clienteContaId: 42, periodo: "2026-08", marketplace: "meli" });
    expect(corpo.processamento.selo).toBe("a".repeat(64));
    expect(corpo.resultado.summary).toEqual(SUMMARY);
    expect(corpo.resultado.detailedRows).toEqual([{ id: "MLB1", mc: 0.2 }]);
    expect(corpo.resultado).not.toHaveProperty("excelBase64");
    expect(corpo.resultado).not.toHaveProperty("processamento");

    const entrega = api.salvar.mock.calls[0][0];
    expect(entrega.snapshot_id).toBe(77);
    expect(entrega.payload_json.metadados.snapshot).toEqual({ id: 77, revisao: 1 });
    expect(await screen.findByText(/Salvo como/)).toBeInTheDocument();
    expect(screen.getByText(/Revisão v1 salva e entrega gravada/)).toBeInTheDocument();
  });

  it("diz o número da próxima revisão antes de salvar", async () => {
    api.processar.mockResolvedValue(respostaOk());
    const usuario = userEvent.setup();
    await processarMeli(usuario, { revisoes: [{ id: 76, revisao: 2, periodo: "2026-08", publicado: true, entregas: [] }, { id: 70, revisao: 1, periodo: "2026-08", entregas: [] }] });
    expect(screen.getByRole("button", { name: "Salvar revisão v3" })).toBeInTheDocument();
    expect(screen.getByText(/Salvar cria a revisão v3\./)).toBeInTheDocument();
  });

  it("sem o selo do servidor não grava nada — pede para processar de novo", async () => {
    api.processar.mockResolvedValue(respostaOk({ processamento: undefined }));
    const usuario = userEvent.setup();
    await processarMeli(usuario);
    await usuario.click(screen.getByRole("button", { name: "Salvar fechamento" }));
    expect(await screen.findByText(/não veio com o selo do servidor/)).toBeInTheDocument();
    expect(api.salvarSnapshot).not.toHaveBeenCalled();
    expect(api.salvar).not.toHaveBeenCalled();
  });

  it("selo recusado (409 SELO_INVALIDO) não cria entrega", async () => {
    api.processar.mockResolvedValue(respostaOk());
    api.salvarSnapshot.mockRejectedValueOnce(new FechamentoApiError("Este resultado não corresponde a um processamento do motor.", { status: 409, codigo: "SELO_INVALIDO" }));
    const usuario = userEvent.setup();
    await processarMeli(usuario);
    await usuario.click(screen.getByRole("button", { name: "Salvar fechamento" }));
    expect(await screen.findByText(/não corresponde a um processamento do motor/)).toBeInTheDocument();
    expect(api.salvar).not.toHaveBeenCalled();
  });

  it("entrega falhou depois da revisão: tentar de novo NÃO cria outra revisão", async () => {
    api.processar.mockResolvedValue(respostaOk());
    api.salvar.mockRejectedValueOnce(new FechamentoApiError("Falha de rede.", { status: 0, codigo: "rede" })).mockResolvedValueOnce({ id: 5 });
    const usuario = userEvent.setup();
    await processarMeli(usuario);
    await usuario.click(screen.getByRole("button", { name: "Salvar fechamento" }));
    expect(await screen.findByText(/Revisão v1 salva, mas a entrega não foi gravada: Falha de rede\./)).toBeInTheDocument();
    await usuario.click(screen.getByRole("button", { name: "Salvar entrega da v1" }));
    await waitFor(() => expect(api.salvar).toHaveBeenCalledTimes(2));
    expect(api.salvarSnapshot).toHaveBeenCalledTimes(1);
    expect(api.salvar.mock.calls[1][0].snapshot_id).toBe(77);
  });
});

describe("NovoFechamento · substituir preserva a apresentação", () => {
  it("substituir leva destaques/prioridades da entrega existente para o novo payload (números novos)", async () => {
    const apresentacao = { destaques: ["Meta batida"], atencoes: [], prioridades: { alta: [{ titulo: "Repor", desc: "", data: "" }], media: [], baixa: [] } };
    rede.requisitar.mockImplementation(async (caminho) =>
      caminho === "/entregas-cliente/78"
        ? { ok: true, entrega: { id: 78, payload_json: { summary: { finalResult: 1 }, entrega: apresentacao } } }
        : semVinculos
    );
    api.processar.mockResolvedValue(respostaOk());
    api.salvar
      .mockRejectedValueOnce(new FechamentoApiError("Já existe.", { status: 409, codigo: "ENTREGA_JA_EXISTE", entregaId: 78, publicado: false }))
      .mockResolvedValueOnce({ id: 78 });
    const usuario = userEvent.setup();
    render(<NovoFechamento {...props} />);
    await subirVendas(usuario);
    await subirCustos(usuario);
    await usuario.click(screen.getByRole("button", { name: "Processar fechamento" }));
    await usuario.click(await screen.findByRole("button", { name: "Salvar fechamento" }));
    await usuario.click(await screen.findByRole("button", { name: "Substituir" }));
    await waitFor(() => expect(api.salvar).toHaveBeenCalledTimes(2));
    const body = api.salvar.mock.calls[1][0];
    expect(body.payload_json.entrega).toEqual(apresentacao);
    expect(body.payload_json.summary).toEqual(SUMMARY);
  });
});

describe("NovoFechamento · reprocessar e voltar aos arquivos", () => {
  it("Reprocessar chama o MESMO endpoint com os mesmos arquivos; Editar arquivos mantém a planilha escolhida", async () => {
    rede.requisitar.mockResolvedValue(vinculosCom({ marketplace: "meli", contaId: 42 }));
    api.processar.mockResolvedValue(respostaOk({ costsSource: "base", costsBase: { id: 900, slug: "base-zenite", nome: "Base Zenite" } }));
    const usuario = userEvent.setup();
    render(<NovoFechamento {...props} />);
    await screen.findByText("Base vinculada");
    await subirVendas(usuario, "vendas-out.xlsx");
    await usuario.click(screen.getByRole("button", { name: "Processar fechamento" }));
    await screen.findByText("Resultado do fechamento");

    await usuario.click(screen.getAllByRole("button", { name: "Reprocessar fechamento" })[0]);
    await waitFor(() => expect(api.processar).toHaveBeenCalledTimes(2));
    expect(api.processar.mock.calls[1][0].get("sales").name).toBe("vendas-out.xlsx");

    await usuario.click(await screen.findByRole("button", { name: "Editar arquivos e ajustes" }));
    expect(screen.getByText("Arquivos do fechamento")).toBeInTheDocument();
    expect(screen.getByText("vendas-out.xlsx")).toBeInTheDocument();
  });

  it("reprocessamento que falha não deixa o resultado anterior na tela", async () => {
    api.processar.mockResolvedValueOnce(respostaOk()).mockRejectedValueOnce(new FechamentoApiError("Planilha inválida.", { status: 400 }));
    const usuario = userEvent.setup();
    render(<NovoFechamento {...props} />);
    await subirVendas(usuario);
    await subirCustos(usuario);
    await usuario.click(screen.getByRole("button", { name: "Processar fechamento" }));
    await screen.findByText("Resultado do fechamento");
    await usuario.click(screen.getAllByRole("button", { name: "Reprocessar fechamento" })[0]);
    expect(await screen.findByRole("alert")).toHaveTextContent("Planilha inválida.");
    expect(screen.queryByText("Resultado do fechamento")).not.toBeInTheDocument();
  });
});

describe("NovoFechamento · hierarquia da página (UI/UX)", () => {
  const secoes = (container) => Array.from(container.querySelectorAll("[data-secao]")).map((e) => e.dataset.secao);
  const rows = Array.from({ length: 60 }, (_, i) => ({ "# de anúncio": `MLB${i}`, "Título do anúncio": `Produto ${i}`, "Venda Total": 10, "Preço de custo": i === 0 ? null : 3, LC: i === 0 ? null : 2, MC: 20, "Cobertura de custo": i === 0 ? "sem custo" : "com custo" }));

  async function processar(usuario) {
    await subirVendas(usuario);
    await subirCustos(usuario);
    await usuario.click(screen.getByRole("button", { name: "Processar fechamento" }));
    await screen.findByText("Resultado do fechamento");
  }

  it("produtos são a ÚLTIMA seção: depois de topo, composição, cobertura, pendências, ações e entrega", async () => {
    api.processar.mockResolvedValue(respostaOk({ detailedRows: rows, summary: { ...SUMMARY, calculatedCoveragePercent: 98, revenueWithoutCost: 10 }, unmatchedIds: ["MLB0"] }));
    const usuario = userEvent.setup();
    const { container } = render(<NovoFechamento {...props} entregaSlot={<section data-secao="entrega" />} />);
    await processar(usuario);
    expect(secoes(container)).toEqual(["resultado", "leitura", "composicao", "cobertura", "pendencias", "acoes", "entrega", "produtos"]);
  });

  it("a tabela de produtos é paginada (25 por vez), nunca as 60 linhas", async () => {
    api.processar.mockResolvedValue(respostaOk({ detailedRows: rows }));
    const usuario = userEvent.setup();
    render(<NovoFechamento {...props} />);
    await processar(usuario);
    const tabela = screen.getByRole("table", { name: "Produtos do fechamento" });
    expect(within(tabela).getAllByRole("row")).toHaveLength(26);
    expect(screen.getByText("Página 1 de 3")).toBeInTheDocument();
  });

  it("antes de processar não há produtos nem ações; só o slot da entrega, no mesmo lugar", async () => {
    const { container } = render(<NovoFechamento {...props} entregaSlot={<section data-secao="entrega" />} />);
    await screen.findByText("Arquivos do fechamento");
    expect(secoes(container)).toEqual(["entrega"]);
  });

  it("o painel da entrega NÃO é remontado ao processar (o que o operador digitou nele sobrevive)", async () => {
    api.processar.mockResolvedValue(respostaOk({ detailedRows: rows }));
    let montagens = 0;
    function Painel() {
      useEffect(() => { montagens += 1; }, []);
      return <textarea aria-label="Destaque" />;
    }
    const usuario = userEvent.setup();
    render(<NovoFechamento {...props} entregaSlot={<Painel />} />);
    await usuario.type(screen.getByRole("textbox", { name: "Destaque" }), "rascunho");
    await processar(usuario);
    expect(montagens).toBe(1);
    expect(screen.getByRole("textbox", { name: "Destaque" })).toHaveValue("rascunho");
  });

  it("corrigir um custo na linha NÃO reprocessa; o reprocesso é explícito", async () => {
    rede.requisitar.mockImplementation(async (url) => (String(url).includes("base-vinculos") ? vinculosCom({ marketplace: "meli", contaId: 42 }) : { ok: true, padrao: { imposto_percentual: 8, taxa_fixa: 0 } }));
    api.processar.mockResolvedValue(respostaOk({ detailedRows: rows, unmatchedIds: ["MLB0"], costsSource: "base", costsBase: { id: 900, slug: "base-zenite", nome: "Base Zenite" } }));
    const usuario = userEvent.setup();
    render(<NovoFechamento {...props} />);
    await screen.findByText("Base vinculada");
    await subirVendas(usuario);
    await usuario.click(screen.getByRole("button", { name: "Processar fechamento" }));
    await screen.findByText("Resultado do fechamento");
    expect(await screen.findByRole("textbox", { name: "Novo custo unitário de MLB0" })).toBeInTheDocument();
    expect(api.processar).toHaveBeenCalledTimes(1);
  });
});

describe("NovoFechamento · pré-check", () => {
  it("antes de processar: obrigatórios, recomendado e o aviso de MESMO arquivo do mês anterior (sha256 no navegador)", async () => {
    rede.requisitar.mockResolvedValue(vinculosCom({ marketplace: "shopee", contaId: 42 }));
    // sha256("a") — o conteúdo que subirVendas envia.
    const SHA_A = "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb";
    const snapshots = [{ id: 9, periodo: "2026-07", revisao: 1, ajustes: { ads: 0 }, contagens: { pendencias: 0 }, origemCustos: { costsSource: "base", costsBase: { id: 900 } }, arquivos: [{ tipo: "vendas", sha256: SHA_A }] }];
    const usuario = userEvent.setup();
    render(<NovoFechamento {...props} marketplace="shopee" snapshots={snapshots} />);
    await screen.findByText("Base vinculada");
    const pre = screen.getByRole("region", { name: "Antes de processar" });
    expect(within(pre).getByText("Planilha principal (Performance)").closest("li").dataset.estado).toBe("falta");
    expect(within(pre).getByText("Order.all").closest("li").dataset.estado).toBe("recomendado");
    await subirVendas(usuario, "Performance.xlsx");
    await waitFor(() => expect(within(pre).getByText(/MESMO arquivo usado em Julho\/2026 \(v1\)/)).toBeInTheDocument());
    // aviso não bloqueia: o botão segue habilitado
    expect(screen.getByRole("button", { name: "Processar fechamento" })).toBeEnabled();
  });
});
