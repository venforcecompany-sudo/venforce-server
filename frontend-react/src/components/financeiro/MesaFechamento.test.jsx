// A mesa do fechamento (modelo B): o fluxo nativo de GERAR + SALVAR +
// PUBLICAR, com a BASE VINCULADA (MELI e Shopee) decidindo se a planilha de
// custos é pedida. Base, arquivos e ajustes moram no drawer "Preparar
// fechamento"; o painel de etapas leva ao próximo passo. Marketplace vem da
// operação (sem seletor na tela).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { MesaFechamento } from "./MesaFechamento.jsx";
import { montarPayloadFechamento, parseMoedaBR, cardsDoSummary } from "../../utils/fechamentoPayload.js";
import { FechamentoApiError } from "../../services/financeiroFechamentoApi.js";
import { formatarValorCampo, origemDoAds } from "../../hooks/useAdsMercadoAds.js";
import { origemDoFull } from "../../hooks/useFullMercadoLivre.js";

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

// Modo API: status do sync da competência, processamento pelos dados
// sincronizados e o "Sincronizar agora" (sync-runs da Central).
const viaApi = vi.hoisted(() => ({
  status: vi.fn(),
  processar: vi.fn(),
  iniciarSync: vi.fn(),
  runSync: vi.fn(),
}));
vi.mock("../../services/fechamentoViaApiApi.js", async (orig) => ({
  ...(await orig()),
  obterStatusFechamentoApi: viaApi.status,
  processarFechamentoApi: viaApi.processar,
  iniciarSyncCentral: viaApi.iniciarSync,
  obterSyncRunCentral: viaApi.runSync,
}));

// Salvar a planilha de custos como base (POST /importar-base) — controlado por teste.
const bases = vi.hoisted(() => ({ importar: vi.fn() }));
vi.mock("../../services/basesCustoApi.js", async (orig) => ({
  ...(await orig()),
  importarBaseDeCustos: bases.importar,
}));

const STATUS_SINCRONIZADO = {
  ok: true,
  marketplace: "meli",
  periodo: "2026-08",
  sync: {
    disponivel: true,
    importId: 7,
    publicadoEm: "2026-09-02T03:12:00Z",
    coberturaDe: "2026-08-01",
    coberturaAte: "2026-08-31",
    completo: true,
    motivoIncompleto: null,
  },
  runEmAndamento: null,
};
const STATUS_SEM_SYNC = { ...STATUS_SINCRONIZADO, sync: { disponivel: false, importId: null, publicadoEm: null, coberturaDe: null, coberturaAte: null, completo: false, motivoIncompleto: "Mês ainda não sincronizado." } };

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
  entregas: { publicar: vi.fn(), despublicar: vi.fn(), acaoEmCurso: null, erroDeAcao: null },
};

beforeEach(() => {
  vi.clearAllMocks();
  rede.requisitar.mockResolvedValue(semVinculos);
  rede.ehAdmin.mockReturnValue(false);
  viaApi.status.mockResolvedValue(STATUS_SINCRONIZADO);
  viaApi.processar.mockResolvedValue(respostaOk({ sync: STATUS_SINCRONIZADO.sync }));
  viaApi.iniciarSync.mockResolvedValue({ ok: true, reaproveitado: false, run: { id: 301, status: "queued" } });
  viaApi.runSync.mockResolvedValue({ ok: true, run: { id: 301, status: "completed", completenessStatus: "complete" } });
});

// O drawer de preparo abre pela etapa "Base de custos" do painel. Em MELI a
// origem das vendas (API | planilha) é escolhida no próprio drawer; `origem`
// seleciona a que o teste quer (o padrão é a planilha: são os testes do fluxo de
// planilha; os de API escolhem "api" explicitamente ou ficam com o padrão).
async function abrirPreparo(usuario, { origem = "planilha" } = {}) {
  await usuario.click(screen.getByRole("button", { name: /: Base de custos$/ }));
  const drawer = screen.getByRole("dialog", { name: "Preparar fechamento" });
  const grupo = within(drawer).queryByRole("group", { name: "Origem das vendas" });
  if (grupo && origem) {
    const rotulo = origem === "api" ? "API do Mercado Livre" : "Planilha de vendas";
    await usuario.click(within(grupo).getByRole("button", { name: rotulo }));
  }
  return drawer;
}
// Fecha o drawer depois de trocar a origem, como quem configura e sai.
async function preferirPlanilha() {
  const usuario = userEvent.setup();
  const drawer = await abrirPreparo(usuario);
  await usuario.click(within(drawer).getByRole("button", { name: "Cancelar" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Preparar fechamento" })).not.toBeInTheDocument());
}
// A mesa já na origem planilha (a origem padrão é a API).
async function renderPlanilha(ui) {
  const resultado = render(ui);
  await preferirPlanilha();
  return resultado;
}
async function subirVendas(usuario, nome = "vendas.xlsx") {
  const arquivo = new File(["a"], nome, { type: "application/vnd.ms-excel" });
  await usuario.upload(screen.getByLabelText(/Planilha de vendas/), arquivo);
}
async function subirCustos(usuario) {
  const arquivo = new File(["a"], "custos.xlsx", { type: "application/vnd.ms-excel" });
  await usuario.upload(screen.getByLabelText("Planilha de custos"), arquivo);
}
// Abre o preparo, sobe o que for preciso e processa pelo botão do drawer.
async function processarPeloPreparo(usuario, { custos = false, nome } = {}) {
  const drawer = await abrirPreparo(usuario);
  await subirVendas(usuario, nome);
  if (custos) await subirCustos(usuario);
  await usuario.click(within(drawer).getByRole("button", { name: "Processar fechamento" }));
}
const painel = () => screen.getByRole("complementary", { name: "Etapas do fechamento" });

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

describe("Mesa · base vinculada decide o upload de custos", () => {
  it("MELI com base vinculada: não pede planilha de custos e mostra a base", async () => {
    rede.requisitar.mockResolvedValue(vinculosCom({ marketplace: "meli", contaId: 42 }));
    const usuario = userEvent.setup();
    await renderPlanilha(<MesaFechamento {...props} />);
    expect(await within(painel()).findByText("Base Zenite · vinculada")).toBeInTheDocument();
    await abrirPreparo(usuario);
    expect(screen.getByText("Base vinculada")).toBeInTheDocument();
    expect(screen.queryByLabelText("Planilha de custos")).not.toBeInTheDocument();
  });

  it("MELI sem base vinculada: planilha de custos vira obrigatória", async () => {
    rede.requisitar.mockResolvedValue(semVinculos);
    const usuario = userEvent.setup();
    await renderPlanilha(<MesaFechamento {...props} />);
    expect(await within(painel()).findByText(/Sem base vinculada/)).toBeInTheDocument();
    await abrirPreparo(usuario);
    expect(screen.getByText(/Nenhuma base vinculada para esta operação/)).toBeInTheDocument();
    expect(screen.getByLabelText("Planilha de custos")).toBeInTheDocument();
  });

  it("Shopee com base vinculada: não pede custos; Order.all é recomendado", async () => {
    rede.requisitar.mockResolvedValue(vinculosCom({ marketplace: "shopee", contaId: 42 }));
    const usuario = userEvent.setup();
    await renderPlanilha(<MesaFechamento {...props} marketplace="shopee" />);
    await within(painel()).findByText("Base Zenite · vinculada");
    await abrirPreparo(usuario);
    expect(screen.queryByLabelText("Planilha de custos")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Order.all (Shopee)")).toBeInTheDocument();
  });

  it("base de OUTRA conta não conta como base desta operação (pede upload)", async () => {
    rede.requisitar.mockResolvedValue(vinculosCom({ marketplace: "meli", contaId: 99 }));
    await renderPlanilha(<MesaFechamento {...props} clienteContaId={42} />);
    expect(await within(painel()).findByText(/Sem base vinculada/)).toBeInTheDocument();
  });

  it("trocar de operação re-verifica a base", async () => {
    rede.requisitar.mockResolvedValue(vinculosCom({ contaId: 42 }));
    const { rerender } = await renderPlanilha(<MesaFechamento {...props} clienteContaId={42} />);
    await within(painel()).findByText("Base Zenite · vinculada");
    rerender(<MesaFechamento {...props} clienteContaId={77} />);
    expect(await within(painel()).findByText(/Sem base vinculada/)).toBeInTheDocument();
  });

  it("override: 'Usar outra planilha de custos' reabre o card de upload", async () => {
    rede.requisitar.mockResolvedValue(vinculosCom({ marketplace: "meli", contaId: 42 }));
    const usuario = userEvent.setup();
    await renderPlanilha(<MesaFechamento {...props} />);
    await within(painel()).findByText("Base Zenite · vinculada");
    await abrirPreparo(usuario);
    await usuario.click(screen.getByRole("button", { name: "Usar outra planilha de custos" }));
    expect(await screen.findByLabelText("Planilha de custos")).toBeInTheDocument();
    await usuario.click(screen.getByRole("button", { name: "Voltar a usar a base vinculada" }));
    await waitFor(() => expect(screen.queryByLabelText("Planilha de custos")).not.toBeInTheDocument());
  });
});

describe("Mesa · marketplace vem da operação", () => {
  it("não existe seletor de marketplace na tela", async () => {
    const usuario = userEvent.setup();
    render(<MesaFechamento {...props} />);
    await within(painel()).findByText(/Sem base vinculada/);
    await abrirPreparo(usuario);
    expect(screen.queryByLabelText(/Marketplace/)).not.toBeInTheDocument();
  });

  it("TikTok cai no legado, sem mesa", () => {
    render(<MesaFechamento {...props} marketplace="tiktok" />);
    expect(screen.getByText(/Financeiro \(legado\)/)).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Etapas do fechamento" })).not.toBeInTheDocument();
  });
});

describe("Mesa · antes de processar", () => {
  it("o mês ainda não foi fechado: sem destaque nem produtos; o painel aponta o próximo passo", async () => {
    rede.requisitar.mockResolvedValue(vinculosCom({ contaId: 42 }));
    await renderPlanilha(<MesaFechamento {...props} />);
    await within(painel()).findByText("Base Zenite · vinculada");
    expect(screen.getByText("Agosto/2026 ainda não foi fechado")).toBeInTheDocument();
    expect(screen.getByText(/só falta a planilha de vendas do mês/)).toBeInTheDocument();
    expect(screen.queryByTestId("kpis-processamento")).not.toBeInTheDocument();
    expect(document.querySelector(".vf-fin-mesa-produtos")).toBeNull();
    expect(painel().querySelector('[data-etapa="arquivos"]')).toHaveAttribute("data-estado", "atual");
    expect(within(painel()).getByRole("button", { name: /Enviar planilha de vendas/ })).toBeInTheDocument();
  });

  it("o preparo diz o motivo do bloqueio e não deixa processar", async () => {
    rede.requisitar.mockResolvedValue(semVinculos);
    const usuario = userEvent.setup();
    await renderPlanilha(<MesaFechamento {...props} />);
    await within(painel()).findByText(/Sem base vinculada/);
    expect(within(painel()).getByText(/Falta 2 itens obrigatórios para processar\./)).toBeInTheDocument();
    const drawer = await abrirPreparo(usuario);
    expect(within(drawer).getByText("Planilha de vendas necessária.", { selector: ".vf-fin-mesa-drawer__motivo" })).toBeInTheDocument();
    expect(within(drawer).getByRole("button", { name: "Processar fechamento" })).toBeDisabled();
  });

  it("com base vinculada, só a planilha de vendas falta", async () => {
    rede.requisitar.mockResolvedValue(vinculosCom({ contaId: 42 }));
    await renderPlanilha(<MesaFechamento {...props} />);
    await within(painel()).findByText("Base Zenite · vinculada");
    expect(within(painel()).getByText(/Falta 1 item obrigatório para processar\./)).toBeInTheDocument();
  });

  it("trocar e remover arquivo de vendas", async () => {
    rede.requisitar.mockResolvedValue(vinculosCom({ contaId: 42 }));
    const usuario = userEvent.setup();
    await renderPlanilha(<MesaFechamento {...props} />);
    await within(painel()).findByText("Base Zenite · vinculada");
    const drawer = await abrirPreparo(usuario);
    await subirVendas(usuario, "Performance_Agosto.xlsx");
    expect(within(drawer).getByText("Performance_Agosto.xlsx")).toBeInTheDocument();
    await usuario.click(within(drawer).getByRole("button", { name: "Remover Planilha de vendas" }));
    await waitFor(() => expect(within(drawer).queryByText("Performance_Agosto.xlsx")).not.toBeInTheDocument());
    await usuario.click(within(drawer).getByRole("button", { name: "Cancelar" }));
    expect(await within(painel()).findByText("Falta a planilha de vendas")).toBeInTheDocument();
  });
});

describe("Mesa · processar", () => {
  it("envia multipart com periodo + clienteContaId + marketplace e mostra o resultado na mesa", async () => {
    rede.requisitar.mockResolvedValue(vinculosCom({ marketplace: "meli", contaId: 42 }));
    api.processar.mockResolvedValue(respostaOk({ costsSource: "base", costsBase: { id: 900, nome: "Base Zenite" } }));
    const usuario = userEvent.setup();
    await renderPlanilha(<MesaFechamento {...props} />);
    await within(painel()).findByText("Base Zenite · vinculada");
    await processarPeloPreparo(usuario);

    await waitFor(() => expect(api.processar).toHaveBeenCalled());
    const form = api.processar.mock.calls[0][0];
    expect(form.get("periodo")).toBe("2026-08");
    expect(form.get("clienteContaId")).toBe("42");
    expect(form.get("marketplace")).toBe("meli");
    expect(form.get("costs")).toBeNull(); // base cobre — nada de upload
    expect(await within(painel()).findByText(/competência confere/)).toBeInTheDocument();
    expect(screen.getByTestId("kpis-processamento")).toHaveTextContent("custos: base Base Zenite");
    expect(screen.queryByRole("dialog", { name: "Preparar fechamento" })).not.toBeInTheDocument();
  });

  it("sem base: o upload de custos vai junto no multipart", async () => {
    rede.requisitar.mockResolvedValue(semVinculos);
    api.processar.mockResolvedValue(respostaOk());
    const usuario = userEvent.setup();
    await renderPlanilha(<MesaFechamento {...props} marketplace="shopee" />);
    await within(painel()).findByText(/Sem base vinculada/);
    await processarPeloPreparo(usuario, { custos: true });
    await waitFor(() => expect(api.processar).toHaveBeenCalled());
    expect(api.processar.mock.calls[0][0].get("costs")).toBeInstanceOf(File);
  });

  it("Refazer chama o MESMO endpoint com os mesmos arquivos; o preparo mantém a planilha escolhida", async () => {
    rede.requisitar.mockResolvedValue(vinculosCom({ marketplace: "meli", contaId: 42 }));
    api.processar.mockResolvedValue(respostaOk({ costsSource: "base", costsBase: { id: 900, slug: "base-zenite", nome: "Base Zenite" } }));
    const usuario = userEvent.setup();
    await renderPlanilha(<MesaFechamento {...props} />);
    await within(painel()).findByText("Base Zenite · vinculada");
    await processarPeloPreparo(usuario, { nome: "vendas-out.xlsx" });
    await screen.findByTestId("kpis-processamento");

    await usuario.click(within(painel()).getByRole("button", { name: "Refazer: Processar" }));
    await waitFor(() => expect(api.processar).toHaveBeenCalledTimes(2));
    expect(api.processar.mock.calls[1][0].get("sales").name).toBe("vendas-out.xlsx");

    await usuario.click(within(painel()).getByRole("button", { name: "Trocar: Arquivos" }));
    expect(within(screen.getByRole("dialog", { name: "Preparar fechamento" })).getByText("vendas-out.xlsx")).toBeInTheDocument();
  });

  it("reprocessamento que falha não deixa o resultado anterior na tela", async () => {
    api.processar.mockResolvedValueOnce(respostaOk()).mockRejectedValueOnce(new FechamentoApiError("Planilha inválida.", { status: 400 }));
    const usuario = userEvent.setup();
    await renderPlanilha(<MesaFechamento {...props} />);
    await within(painel()).findByText(/Sem base vinculada/);
    await processarPeloPreparo(usuario, { custos: true });
    await screen.findByTestId("kpis-processamento");
    await usuario.click(within(painel()).getByRole("button", { name: "Refazer: Processar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Planilha inválida.");
    expect(screen.queryByTestId("kpis-processamento")).not.toBeInTheDocument();
  });

  it("Baixar planilha usa o excelBase64 do backend, com nome por marketplace e competência", async () => {
    rede.requisitar.mockResolvedValue(vinculosCom({ marketplace: "shopee", contaId: 42 }));
    api.processar.mockResolvedValue(respostaOk({ excelBase64: btoa("xlsx") }));
    const criar = vi.fn(() => "blob:x");
    globalThis.URL.createObjectURL = criar;
    globalThis.URL.revokeObjectURL = vi.fn();
    const clique = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const usuario = userEvent.setup();
    await renderPlanilha(<MesaFechamento {...props} marketplace="shopee" />);
    await within(painel()).findByText("Base Zenite · vinculada");
    await processarPeloPreparo(usuario);
    await usuario.click(await screen.findByRole("button", { name: "Baixar planilha" }));
    expect(criar).toHaveBeenCalled();
    expect(clique.mock.instances[0].download).toBe("fechamento-shopee-2026-08.xlsx");
    clique.mockRestore();
  });
});

describe("Mesa · caixa-preta (incidente FIN-xxx) + base vinculada", () => {
  it("Shopee com base vinculada: se o backend devolve incidente, o aviso FIN-xxx aparece na mesa", async () => {
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
    await renderPlanilha(<MesaFechamento {...props} marketplace="shopee" />);
    await within(painel()).findByText("Comprou_chegou_shopee1 · vinculada");
    await processarPeloPreparo(usuario);

    expect(await screen.findByText("FIN-777")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copiar código" })).toBeInTheDocument();
    expect(screen.getByTestId("kpis-processamento")).toHaveTextContent("custos: base Comprou_chegou_shopee1");
    expect(screen.queryByRole("link", { name: "Abrir diagnóstico" })).not.toBeInTheDocument();
  });

  it("admin vê o link 'Abrir diagnóstico' apontando para o código do incidente", async () => {
    rede.ehAdmin.mockReturnValue(true);
    rede.requisitar.mockResolvedValue(semVinculos);
    api.processar.mockResolvedValue(respostaOk({ incidente: { codigo: "FIN-42" } }));
    const usuario = userEvent.setup();
    await renderPlanilha(<MesaFechamento {...props} />);
    await within(painel()).findByText(/Sem base vinculada/);
    await processarPeloPreparo(usuario, { custos: true });
    const link = await screen.findByRole("link", { name: "Abrir diagnóstico" });
    expect(link).toHaveAttribute("href", "financeiro-debug.html?incidente=FIN-42");
  });

  it("sem incidente na resposta, nenhum aviso FIN aparece", async () => {
    rede.requisitar.mockResolvedValue(vinculosCom({ contaId: 42 }));
    api.processar.mockResolvedValue(respostaOk());
    const usuario = userEvent.setup();
    await renderPlanilha(<MesaFechamento {...props} />);
    await within(painel()).findByText("Base Zenite · vinculada");
    await processarPeloPreparo(usuario);
    await within(painel()).findByText(/competência confere/);
    expect(screen.queryByText(/Ocorrência de suporte/)).not.toBeInTheDocument();
  });
});

describe("Mesa · competência divergente", () => {
  it("não deixa salvar até confirmar a divergência", async () => {
    rede.requisitar.mockResolvedValue(vinculosCom({ contaId: 42 }));
    api.processar.mockResolvedValue(
      respostaOk({
        competencia: { periodoSolicitado: "2026-08", periodoDetectado: "2026-07", divergente: true, motivo: "Datas em julho/2026." },
      })
    );
    const usuario = userEvent.setup();
    await renderPlanilha(<MesaFechamento {...props} />);
    await within(painel()).findByText("Base Zenite · vinculada");
    await processarPeloPreparo(usuario);

    expect(await screen.findByText(/não bate com o período em tela/)).toBeInTheDocument();
    const rascunho = within(painel()).getByRole("button", { name: "Salvar como rascunho" });
    const publicar = within(painel()).getByRole("button", { name: /Salvar e publicar/ });
    expect(rascunho).toBeDisabled();
    expect(publicar).toBeDisabled();
    await usuario.click(screen.getByRole("checkbox"));
    expect(rascunho).toBeEnabled();
    expect(publicar).toBeEnabled();
  });
});

// GET /financeiro/:cliente/ads responde o Mercado Ads; o resto da rede
// (base-vinculos) segue o vínculo de sempre.
function redeComAds(ads, vinculos = vinculosCom({ marketplace: "meli", contaId: 42 })) {
  rede.requisitar.mockImplementation(async (caminho, opcoes = {}) => {
    if (/\/financeiro\/[^/]+\/ads$/.test(caminho)) return typeof ads === "function" ? ads(opcoes) : ads;
    return vinculos;
  });
}
const ADS_OK = { ok: true, disponivel: true, fonte: "cache", investimentoAds: 4812.4, gmvAds: 38017.96, roas: 7.9, campanhas: 14, consultadoEm: "2026-09-04T03:12:00Z" };
const campoAds = () => screen.getByLabelText("ADS");
const chamadasAds = () => rede.requisitar.mock.calls.filter(([c]) => /\/ads$/.test(c));

describe("Mesa · ADS do Mercado Ads (modelo B)", () => {
  it("formatarValorCampo e origemDoAds", () => {
    expect(formatarValorCampo(4812.4)).toBe("4.812,40");
    expect(formatarValorCampo(0)).toBe("0,00");
    const ads = { status: "ok", valorCampo: "4.812,40" };
    expect(origemDoAds("4.812,40", ads)).toBe("mercado_ads");
    expect(origemDoAds("5.000,00", ads)).toBe("manual");
    expect(origemDoAds("", ads)).toBeNull();
    expect(origemDoAds("100,00", { status: "indisponivel" })).toBe("manual");
  });

  it("MELI: o campo já vem com o valor do Mercado Ads da conta e da competência", async () => {
    redeComAds(ADS_OK);
    const usuario = userEvent.setup();
    await renderPlanilha(<MesaFechamento {...props} />);
    await within(painel()).findByText("Base Zenite · vinculada");
    await abrirPreparo(usuario);
    await waitFor(() => expect(campoAds()).toHaveValue("4.812,40"));
    expect(screen.getByText("Mercado Ads")).toBeInTheDocument();
    expect(screen.getByText(/ROAS 7,9 · 14 campanhas/)).toBeInTheDocument();
    const [caminho, opcoes] = chamadasAds()[0];
    expect(caminho).toBe("/financeiro/zenite/ads");
    expect(opcoes.params).toMatchObject({ conta: 42, periodo: "2026-08" });
  });

  it("editar vira Manual; 'Usar o da API' volta ao valor do Mercado Ads", async () => {
    redeComAds(ADS_OK);
    const usuario = userEvent.setup();
    await renderPlanilha(<MesaFechamento {...props} />);
    await abrirPreparo(usuario);
    await waitFor(() => expect(campoAds()).toHaveValue("4.812,40"));
    await usuario.clear(campoAds());
    await usuario.type(campoAds(), "5.000,00");
    expect(screen.getByText("Manual")).toBeInTheDocument();
    expect(screen.getByText(/Editado à mão · Mercado Ads: R\$ 4\.812,40/)).toBeInTheDocument();
    await usuario.click(screen.getByRole("button", { name: "Usar o da API" }));
    expect(campoAds()).toHaveValue("4.812,40");
    expect(screen.getByText("Mercado Ads")).toBeInTheDocument();
  });

  it("↻ consulta ao vivo e troca o valor que veio da API", async () => {
    redeComAds((opcoes) => (opcoes.params?.atualizar ? { ...ADS_OK, fonte: "ao_vivo", investimentoAds: 4907.15 } : ADS_OK));
    const usuario = userEvent.setup();
    await renderPlanilha(<MesaFechamento {...props} />);
    await abrirPreparo(usuario);
    await waitFor(() => expect(campoAds()).toHaveValue("4.812,40"));
    await usuario.click(screen.getByRole("button", { name: "Atualizar do Mercado Ads agora" }));
    await waitFor(() => expect(campoAds()).toHaveValue("4.907,15"));
    expect(chamadasAds().at(-1)[1].params.atualizar).toBe(1);
    expect(screen.getByText(/consultado agora/)).toBeInTheDocument();
  });

  it("↻ não passa por cima de um valor digitado", async () => {
    redeComAds((opcoes) => (opcoes.params?.atualizar ? { ...ADS_OK, investimentoAds: 4907.15 } : ADS_OK));
    const usuario = userEvent.setup();
    await renderPlanilha(<MesaFechamento {...props} />);
    await abrirPreparo(usuario);
    await waitFor(() => expect(campoAds()).toHaveValue("4.812,40"));
    await usuario.clear(campoAds());
    await usuario.type(campoAds(), "100,00");
    await usuario.click(screen.getByRole("button", { name: "Atualizar do Mercado Ads agora" }));
    await screen.findByText(/Editado à mão · Mercado Ads: R\$ 4\.907,15/);
    expect(campoAds()).toHaveValue("100,00");
  });

  it("sem permissão de Ads: campo vazio e manual, a legenda diz como resolver", async () => {
    redeComAds({ ok: true, disponivel: false, codigo: "NO_ADS_PERMISSION", motivo: "x" });
    const usuario = userEvent.setup();
    await renderPlanilha(<MesaFechamento {...props} />);
    await abrirPreparo(usuario);
    expect(await screen.findByText(/não tem acesso ao Mercado Ads/)).toBeInTheDocument();
    expect(campoAds()).toHaveValue("");
    expect(screen.queryByText("Mercado Ads")).not.toBeInTheDocument();
  });

  it("Shopee: ADS segue manual e nem consulta o Mercado Ads", async () => {
    redeComAds(ADS_OK, vinculosCom({ marketplace: "shopee", contaId: 42 }));
    const usuario = userEvent.setup();
    await renderPlanilha(<MesaFechamento {...props} marketplace="shopee" />);
    await within(painel()).findByText("Base Zenite · vinculada");
    await abrirPreparo(usuario);
    expect(screen.getByLabelText(/^ADS/)).toHaveValue("");
    expect(screen.queryByText("Mercado Ads")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Atualizar do Mercado Ads agora" })).not.toBeInTheDocument();
    expect(chamadasAds()).toHaveLength(0);
  });

  it("o fechamento salvo guarda a origem do ADS", async () => {
    redeComAds(ADS_OK);
    api.processar.mockResolvedValue(respostaOk());
    api.salvar.mockResolvedValue({ id: 5, publicado: false, token_publico: null });
    const usuario = userEvent.setup();
    await renderPlanilha(<MesaFechamento {...props} />);
    await within(painel()).findByText("Base Zenite · vinculada");
    const drawer = await abrirPreparo(usuario);
    await waitFor(() => expect(campoAds()).toHaveValue("4.812,40"));
    await subirVendas(usuario);
    await usuario.click(within(drawer).getByRole("button", { name: "Processar fechamento" }));
    await waitFor(() => expect(api.processar).toHaveBeenCalled());
    expect(api.processar.mock.calls[0][0].get("ads")).toBe("4.812,40");
    await within(painel()).findByText(/competência confere/);
    await usuario.click(within(painel()).getByRole("button", { name: "Salvar como rascunho" }));
    await waitFor(() => expect(api.salvar).toHaveBeenCalledTimes(1));
    const meta = api.salvar.mock.calls[0][0].payload_json.metadados;
    expect(meta.ads).toBe(4812.4);
    expect(meta.adsOrigem).toEqual({ origem: "mercado_ads", consultadoEm: "2026-09-04T03:12:00Z" });
  });
});

// GET /financeiro/:cliente/full responde o faturamento do ML; /ads fica
// indisponível para não misturar os dois campos.
function redeComFull(full, vinculos = vinculosCom({ marketplace: "meli", contaId: 42 })) {
  rede.requisitar.mockImplementation(async (caminho, opcoes = {}) => {
    if (/\/financeiro\/[^/]+\/full$/.test(caminho)) return typeof full === "function" ? full(opcoes) : full;
    if (/\/financeiro\/[^/]+\/ads$/.test(caminho)) return { ok: true, disponivel: false, codigo: "NO_ADVERTISER_FOUND" };
    return vinculos;
  });
}
const FULL_OK = {
  ok: true,
  disponivel: true,
  fonte: "cache",
  custoFull: 1005.78,
  lancamentos: 1493,
  componentes: [
    { grupo: "armazenagem", rotulo: "Armazenagem", tipos: ["CFWA"], valor: 593.17, lancamentos: 1439 },
    { grupo: "armazenamento_prolongado", rotulo: "Armazenamento prolongado", tipos: ["CFBA"], valor: 121, lancamentos: 9 },
    { grupo: "coleta", rotulo: "Coleta", tipos: ["CFCBI", "CFCBE"], valor: 291.61, lancamentos: 45 },
    { grupo: "retirada", rotulo: "Retirada ou descarte", tipos: ["CFRS"], valor: 0, lancamentos: 0 },
  ],
  faturas: [{ key: "2026-08-01", status: "CLOSED" }, { key: "2026-09-01", status: "CLOSED" }],
  definitivo: true,
  consultadoEm: "2026-09-04T03:12:00Z",
};
const campoFull = () => screen.getByLabelText("FULL");
const seloFull = () => document.querySelector(".vf-fin-ajuste--full .vf-fin-ajuste__selo--api");
const chamadasFull = () => rede.requisitar.mock.calls.filter(([c]) => /\/full$/.test(c));

describe("Mesa · FULL do faturamento do ML", () => {
  it("origemDoFull", () => {
    const full = { status: "ok", valorCampo: "1.005,78" };
    expect(origemDoFull("1.005,78", full)).toBe("ml_billing");
    expect(origemDoFull("900,00", full)).toBe("manual");
    expect(origemDoFull("", full)).toBeNull();
    expect(origemDoFull("10,00", { status: "indisponivel" })).toBe("manual");
  });

  it("MELI: o campo já vem com o custo do Full da conta e da competência, com a composição", async () => {
    redeComFull(FULL_OK);
    const usuario = userEvent.setup();
    await renderPlanilha(<MesaFechamento {...props} />);
    await within(painel()).findByText("Base Zenite · vinculada");
    await abrirPreparo(usuario);
    await waitFor(() => expect(campoFull()).toHaveValue("1.005,78"));
    // Selo "FULL" dentro da caixa (além do rótulo do campo).
    expect(seloFull()).toBeInTheDocument();
    const rotulos = [...document.querySelectorAll(".vf-fin-ajustes__grid .vf-fin-ajuste__label")].map((e) => e.textContent);
    expect(rotulos.slice(0, 2)).toEqual(["ADS", "FULL"]);
    // Legenda de uma linha; a composição fica no title.
    const legenda = screen.getByText(/^Mercado Livre · consultado/).closest("p");
    expect(legenda.textContent).not.toMatch(/Armazenagem|mês aberto/);
    expect(legenda.getAttribute("title")).toMatch(/Armazenagem R\$\s593,17 · Prolongado R\$\s121,00 · Coleta R\$\s291,61/);
    expect(legenda.getAttribute("title")).not.toMatch(/Retirada R/);
    const [caminho, opcoes] = chamadasFull()[0];
    expect(caminho).toBe("/financeiro/zenite/full");
    expect(opcoes.params).toMatchObject({ conta: 42, periodo: "2026-08" });
  });

  it("mês aberto no ML aparece na legenda", async () => {
    redeComFull({ ...FULL_OK, definitivo: false });
    const usuario = userEvent.setup();
    await renderPlanilha(<MesaFechamento {...props} />);
    await abrirPreparo(usuario);
    expect(await screen.findByText(/Mercado Livre · consultado .* · mês aberto/)).toBeInTheDocument();
  });

  it("editar vira Manual; 'Usar o da API' volta; ↻ não passa por cima do digitado", async () => {
    redeComFull((opcoes) => (opcoes.params?.atualizar ? { ...FULL_OK, fonte: "ao_vivo", custoFull: 1010 } : FULL_OK));
    const usuario = userEvent.setup();
    await renderPlanilha(<MesaFechamento {...props} />);
    await abrirPreparo(usuario);
    await waitFor(() => expect(campoFull()).toHaveValue("1.005,78"));
    await usuario.clear(campoFull());
    await usuario.type(campoFull(), "800,00");
    expect(screen.getByText(/Editado à mão · Mercado Livre: R\$\s1\.005,78/)).toBeInTheDocument();
    await usuario.click(screen.getByRole("button", { name: "Atualizar do faturamento do ML agora" }));
    await screen.findByText(/Editado à mão · Mercado Livre: R\$\s1\.010,00/);
    expect(campoFull()).toHaveValue("800,00");
    expect(chamadasFull().at(-1)[1].params.atualizar).toBe(1);
    await usuario.click(screen.getByRole("button", { name: "Usar o da API" }));
    expect(campoFull()).toHaveValue("1.010,00");
  });

  it("faturamento lento: campo vazio e manual, a legenda diz o que fazer", async () => {
    redeComFull({ ok: true, disponivel: false, codigo: "ML_BILLING_LENTO", motivo: "x" });
    const usuario = userEvent.setup();
    await renderPlanilha(<MesaFechamento {...props} />);
    await abrirPreparo(usuario);
    expect(await screen.findByText(/faturamento do Mercado Livre está lento/)).toBeInTheDocument();
    expect(campoFull()).toHaveValue("");
    expect(seloFull()).toBeNull();
  });

  it("Shopee: FULL manual ao lado do ADS, sem consultar o faturamento do ML", async () => {
    redeComFull(FULL_OK, vinculosCom({ marketplace: "shopee", contaId: 42 }));
    const usuario = userEvent.setup();
    await renderPlanilha(<MesaFechamento {...props} marketplace="shopee" />);
    await within(painel()).findByText("Base Zenite · vinculada");
    await abrirPreparo(usuario);
    expect(screen.getByLabelText(/^FULL/)).toHaveValue("");
    const rotulos = [...document.querySelectorAll(".vf-fin-ajustes__grid .vf-fin-ajuste__label")].map((e) => e.textContent);
    expect(rotulos).toEqual(["ADS", "FULL", "Venforce", "Afiliados"]);
    expect(seloFull()).toBeNull();
    expect(screen.queryByRole("button", { name: "Atualizar do faturamento do ML agora" })).not.toBeInTheDocument();
    expect(chamadasFull()).toHaveLength(0);
  });

  it("Shopee: o FULL digitado vai para o processamento e fica salvo, como o ADS", async () => {
    redeComFull(FULL_OK, vinculosCom({ marketplace: "shopee", contaId: 42 }));
    api.processar.mockResolvedValue(respostaOk());
    api.salvar.mockResolvedValue({ id: 5, publicado: false, token_publico: null });
    const usuario = userEvent.setup();
    await renderPlanilha(<MesaFechamento {...props} marketplace="shopee" />);
    await within(painel()).findByText("Base Zenite · vinculada");
    const drawer = await abrirPreparo(usuario);
    await usuario.type(screen.getByLabelText(/^ADS/), "11.407,13");
    await usuario.type(screen.getByLabelText(/^FULL/), "350,00");
    await subirVendas(usuario);
    await usuario.click(within(drawer).getByRole("button", { name: "Processar fechamento" }));
    await waitFor(() => expect(api.processar).toHaveBeenCalled());
    const form = api.processar.mock.calls[0][0];
    expect(form.get("fullCost")).toBe("350,00");
    expect(form.get("ads")).toBe("11.407,13");
    expect(form.get("additionalCosts")).toBeNull();
    await within(painel()).findByText(/competência confere/);
    await usuario.click(within(painel()).getByRole("button", { name: "Salvar como rascunho" }));
    await waitFor(() => expect(api.salvar).toHaveBeenCalledTimes(1));
    const meta = api.salvar.mock.calls[0][0].payload_json.metadados;
    expect(meta.fullCost).toBe(350);
    expect(meta.fullCostOrigem).toEqual({ origem: "manual" });
    expect(meta.ads).toBe(11407.13);
  });

  it("o fechamento envia o FULL da API e guarda a origem", async () => {
    redeComFull(FULL_OK);
    api.processar.mockResolvedValue(respostaOk());
    api.salvar.mockResolvedValue({ id: 5, publicado: false, token_publico: null });
    const usuario = userEvent.setup();
    await renderPlanilha(<MesaFechamento {...props} />);
    await within(painel()).findByText("Base Zenite · vinculada");
    const drawer = await abrirPreparo(usuario);
    await waitFor(() => expect(campoFull()).toHaveValue("1.005,78"));
    await subirVendas(usuario);
    await usuario.click(within(drawer).getByRole("button", { name: "Processar fechamento" }));
    await waitFor(() => expect(api.processar).toHaveBeenCalled());
    expect(api.processar.mock.calls[0][0].get("fullCost")).toBe("1.005,78");
    await within(painel()).findByText(/competência confere/);
    await usuario.click(within(painel()).getByRole("button", { name: "Salvar como rascunho" }));
    await waitFor(() => expect(api.salvar).toHaveBeenCalledTimes(1));
    const meta = api.salvar.mock.calls[0][0].payload_json.metadados;
    expect(meta.fullCost).toBe(1005.78);
    expect(meta.fullCostOrigem).toEqual({
      origem: "ml_billing",
      consultadoEm: "2026-09-04T03:12:00Z",
      definitivo: true,
      componentes: [
        { grupo: "armazenagem", valor: 593.17 },
        { grupo: "armazenamento_prolongado", valor: 121 },
        { grupo: "coleta", valor: 291.61 },
        { grupo: "retirada", valor: 0 },
      ],
    });
  });
});

describe("Mesa · salvar e publicar", () => {
  it("Salvar como rascunho grava cliente.nome com o nome real do contexto (e o slug à parte)", async () => {
    rede.requisitar.mockResolvedValue(vinculosCom({ marketplace: "meli", contaId: 42 }));
    api.processar.mockResolvedValue(respostaOk());
    api.salvar.mockResolvedValue({ id: 5, publicado: false, token_publico: null });
    const usuario = userEvent.setup();
    await renderPlanilha(<MesaFechamento {...props} />);
    await within(painel()).findByText("Base Zenite · vinculada");
    await processarPeloPreparo(usuario);
    await within(painel()).findByText(/competência confere/);
    await usuario.click(within(painel()).getByRole("button", { name: "Salvar como rascunho" }));
    await waitFor(() => expect(api.salvar).toHaveBeenCalledTimes(1));
    expect(api.salvar.mock.calls[0][0].payload_json.cliente).toEqual({ slug: "zenite", nome: "Zenite Comercial" });
    expect(props.entregas.publicar).not.toHaveBeenCalled();
  });

  it("Salvar e publicar confirma nomeando a competência, salva e publica a entrega recém-gravada", async () => {
    rede.requisitar.mockResolvedValue(vinculosCom({ marketplace: "meli", contaId: 42 }));
    api.processar.mockResolvedValue(respostaOk());
    api.salvar.mockResolvedValue({ id: 91, publicado: false, token_publico: null });
    const usuario = userEvent.setup();
    await renderPlanilha(<MesaFechamento {...props} />);
    await within(painel()).findByText("Base Zenite · vinculada");
    await processarPeloPreparo(usuario);
    await usuario.click(await within(painel()).findByRole("button", { name: /Salvar e publicar/ }));
    expect(within(painel()).getByText("Salvar e publicar Agosto/2026? Gera um link público sem senha.")).toBeInTheDocument();
    expect(api.salvar).not.toHaveBeenCalled();
    await usuario.click(within(painel()).getByRole("button", { name: "Salvar e publicar" }));
    await waitFor(() => expect(props.entregas.publicar).toHaveBeenCalledWith(91));
    expect(api.salvar).toHaveBeenCalledTimes(1);
  });

  it("sem nome no contexto, cliente.nome fica null — nunca o slug", () => {
    const p = montarPayloadFechamento({ processamento: respostaOk(), clienteSlug: "zenite", clienteNome: null, periodo: "2026-08", marketplace: "meli" });
    expect(p.cliente).toEqual({ slug: "zenite", nome: null });
  });
});

describe("Mesa · duplicidade 409", () => {
  it("409 ENTREGA_JA_EXISTE vira cancelar/substituir; substituir manda substituir:true + cliente_conta_id", async () => {
    rede.requisitar.mockResolvedValue(vinculosCom({ marketplace: "shopee", contaId: 42 }));
    api.processar.mockResolvedValue(respostaOk({ summary: { ...SUMMARY, marketplace: "shopee" } }));
    api.salvar
      .mockRejectedValueOnce(new FechamentoApiError("Já existe.", { status: 409, codigo: "ENTREGA_JA_EXISTE", entregaId: 78, publicado: true }))
      .mockResolvedValueOnce({ id: 78, token_publico: "tok-x", publicado: true });
    const usuario = userEvent.setup();
    await renderPlanilha(<MesaFechamento {...props} marketplace="shopee" />);
    await within(painel()).findByText("Base Zenite · vinculada");
    await processarPeloPreparo(usuario);
    await usuario.click(await within(painel()).findByRole("button", { name: "Salvar como rascunho" }));

    expect(await screen.findByText(/já tem um fechamento PUBLICADO/)).toBeInTheDocument();
    await usuario.click(screen.getByRole("button", { name: "Substituir" }));
    await waitFor(() => expect(api.salvar).toHaveBeenCalledTimes(2));
    expect(api.salvar.mock.calls[1][0].substituir).toBe(true);
    expect(api.salvar.mock.calls[1][0].cliente_conta_id).toBe(42);
    expect(props.onSalvo).toHaveBeenCalled();
  });

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
    await renderPlanilha(<MesaFechamento {...props} />);
    await within(painel()).findByText(/Sem base vinculada/);
    await processarPeloPreparo(usuario, { custos: true });
    await usuario.click(await within(painel()).findByRole("button", { name: "Salvar como rascunho" }));
    await usuario.click(await screen.findByRole("button", { name: "Substituir" }));
    await waitFor(() => expect(api.salvar).toHaveBeenCalledTimes(2));
    const body = api.salvar.mock.calls[1][0];
    expect(body.payload_json.entrega).toEqual(apresentacao);
    expect(body.payload_json.summary).toEqual(SUMMARY);
  });
});

describe("Mesa · disposição (modelo B)", () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({ "# de anúncio": `MLB${i}`, "Título do anúncio": `Produto ${i}`, "Venda Total": 10, "Preço de custo": i === 0 ? null : 3, LC: i === 0 ? null : 2, MC: 20, "Cobertura de custo": i === 0 ? "sem custo" : "com custo" }));

  it("topo: destaque, aviso de pendências e cascata à esquerda; painel à direita; produtos depois, em largura total", async () => {
    api.processar.mockResolvedValue(respostaOk({ detailedRows: rows, summary: { ...SUMMARY, calculatedCoveragePercent: 98, revenueWithoutCost: 10 }, unmatchedIds: ["MLB0"] }));
    const usuario = userEvent.setup();
    const { container } = await renderPlanilha(<MesaFechamento {...props} />);
    await within(painel()).findByText(/Sem base vinculada/);
    await processarPeloPreparo(usuario, { custos: true });
    await screen.findByTestId("kpis-processamento");

    const topo = container.querySelector(".vf-fin-mesa__topo");
    const principal = topo.querySelector(".vf-fin-mesa__principal");
    expect(principal.querySelector('[data-testid="kpis-processamento"]')).not.toBeNull();
    expect(principal.querySelector('[data-testid="aviso-pendencias"]')).toHaveTextContent("1 produto sem custo confiável · R$ 10,00 de receita fora da LC");
    expect(principal.querySelector(".vf-fin-mesa-cascata")).not.toBeNull();
    expect(topo.querySelector('aside[aria-label="Etapas do fechamento"]')).not.toBeNull();
    const produtos = container.querySelector(".vf-fin-mesa-produtos");
    expect(topo.contains(produtos)).toBe(false);
    expect(topo.compareDocumentPosition(produtos) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("a lista de produtos é paginada (25 por vez), nunca as 60 linhas", async () => {
    api.processar.mockResolvedValue(respostaOk({ detailedRows: rows }));
    const usuario = userEvent.setup();
    const { container } = await renderPlanilha(<MesaFechamento {...props} />);
    await within(painel()).findByText(/Sem base vinculada/);
    await processarPeloPreparo(usuario, { custos: true });
    await screen.findByTestId("kpis-processamento");
    expect(container.querySelectorAll(".vf-fin-mesa-lista__linha")).toHaveLength(25);
    expect(screen.getByText("Página 1 de 3")).toBeInTheDocument();
  });

  it("Ver e corrigir abre as pendências; corrigir um custo NÃO reprocessa (o reprocesso é explícito)", async () => {
    rede.requisitar.mockImplementation(async (url) => (String(url).includes("base-vinculos") ? vinculosCom({ marketplace: "meli", contaId: 42 }) : { ok: true, padrao: { imposto_percentual: 8, taxa_fixa: 0 } }));
    api.processar.mockResolvedValue(respostaOk({ detailedRows: rows, unmatchedIds: ["MLB0"], costsSource: "base", costsBase: { id: 900, slug: "base-zenite", nome: "Base Zenite" } }));
    const usuario = userEvent.setup();
    await renderPlanilha(<MesaFechamento {...props} />);
    await within(painel()).findByText("Base Zenite · vinculada");
    await processarPeloPreparo(usuario);
    await usuario.click(await screen.findByRole("button", { name: "Ver e corrigir" }));
    const drawer = screen.getByRole("dialog", { name: "Pendências de custo" });
    expect(await within(drawer).findByRole("textbox", { name: "Novo custo unitário de MLB0" })).toBeInTheDocument();
    expect(api.processar).toHaveBeenCalledTimes(1);
  });

  it("Detalhes abre o detalhamento completo (composição, cobertura) num drawer", async () => {
    api.processar.mockResolvedValue(respostaOk());
    const usuario = userEvent.setup();
    await renderPlanilha(<MesaFechamento {...props} />);
    await within(painel()).findByText(/Sem base vinculada/);
    await processarPeloPreparo(usuario, { custos: true });
    await usuario.click(await screen.findByRole("button", { name: "Detalhes" }));
    const drawer = screen.getByRole("dialog", { name: "Detalhes do fechamento" });
    expect(within(drawer).getByRole("region", { name: "Composição financeira" })).toBeInTheDocument();
  });
});

describe("Mesa · fechamento salvo (sem processar)", () => {
  it("lê o summary gravado na entrega e mostra o mesmo destaque, com a amostra de produtos", async () => {
    const salvoSummary = { ...SUMMARY, finalResult: 4321 };
    rede.requisitar.mockImplementation(async (caminho) =>
      caminho === "/entregas-cliente/7"
        ? { ok: true, entrega: { id: 7, payload_json: { summary: salvoSummary, detailedRows: [{ "# de anúncio": "MLB1", "Título do anúncio": "Calça", "Venda Total": 10, LC: 2, MC: 20, "Cobertura de custo": "com custo" }] } } }
        : semVinculos
    );
    const entrega = { id: 7, periodo: "2026-08", cliente_conta_id: 42, publicado: false, token_publico: null, created_at: "2026-08-20T10:00:00Z" };
    render(<MesaFechamento {...props} entrega={entrega} />);
    expect(await screen.findByTestId("kpis-processamento")).toHaveTextContent("R$ 4.321,00");
    expect(screen.getByText(/Fechamento salvo em/)).toBeInTheDocument();
    expect(screen.getByText(/Amostra de 1 linhas gravadas no fechamento salvo/)).toBeInTheDocument();
    expect(painel().querySelector('[data-etapa="publicar"]')).toHaveAttribute("data-estado", "atual");
    expect(within(painel()).getByRole("button", { name: /^Publicar/ })).toBeInTheDocument();
  });
});

// ── Origem API do Mercado Livre (padrão em MELI) ──────────────────────────
// Processa pelo drawer, esperando o botão habilitar (o status do sync chega
// de forma assíncrona).
async function processarPelaApi(usuario) {
  const drawer = await abrirPreparo(usuario, { origem: null });
  await waitFor(() => expect(within(drawer).getByRole("button", { name: "Processar fechamento" })).toBeEnabled());
  await usuario.click(within(drawer).getByRole("button", { name: "Processar fechamento" }));
  await waitFor(() => expect(viaApi.processar).toHaveBeenCalled());
  return drawer;
}

describe("Mesa · origem API do Mercado Livre (padrão em MELI)", () => {
  it("MELI abre pela API: o controle mostra a API ativa, sem upload de vendas nem de custos", async () => {
    rede.requisitar.mockResolvedValue(vinculosCom({ contaId: 42 }));
    const usuario = userEvent.setup();
    render(<MesaFechamento {...props} />);
    expect(await within(painel()).findByText(/API do Mercado Livre · dados até 31\/08/)).toBeInTheDocument();
    const drawer = await abrirPreparo(usuario, { origem: null });
    const grupo = within(drawer).getByRole("group", { name: "Origem das vendas" });
    expect(within(grupo).getByRole("button", { name: "API do Mercado Livre" })).toHaveAttribute("aria-pressed", "true");
    expect(within(drawer).queryByLabelText(/Planilha de vendas/)).not.toBeInTheDocument();
    expect(within(drawer).queryByLabelText("Planilha de custos")).not.toBeInTheDocument();
    expect(viaApi.status).toHaveBeenCalledWith({ clienteSlug: "zenite", clienteContaId: 42, periodo: "2026-08" }, expect.any(Object));
  });

  it("Shopee não tem seletor de origem e não consulta o sync da API", async () => {
    rede.requisitar.mockResolvedValue(vinculosCom({ marketplace: "shopee", contaId: 42 }));
    const usuario = userEvent.setup();
    render(<MesaFechamento {...props} marketplace="shopee" />);
    await within(painel()).findByText("Base Zenite · vinculada");
    const drawer = await abrirPreparo(usuario, { origem: null });
    expect(within(drawer).queryByRole("group", { name: "Origem das vendas" })).not.toBeInTheDocument();
    expect(within(drawer).getByLabelText(/Planilha de vendas/)).toBeInTheDocument();
    expect(viaApi.status).not.toHaveBeenCalled();
  });

  it("mês sem sync: a mesa diz que falta sincronizar, não deixa processar e não chama o processamento", async () => {
    viaApi.status.mockResolvedValue(STATUS_SEM_SYNC);
    rede.requisitar.mockResolvedValue(vinculosCom({ contaId: 42 }));
    const usuario = userEvent.setup();
    render(<MesaFechamento {...props} />);
    expect(await within(painel()).findByText(/Mês não sincronizado/)).toBeInTheDocument();
    expect(within(painel()).getByRole("button", { name: /Preparar vendas/ })).toBeInTheDocument();
    expect(screen.getByText("Agosto/2026 ainda não foi fechado")).toBeInTheDocument();
    const drawer = await abrirPreparo(usuario, { origem: null });
    expect(within(drawer).getByText("Mês ainda não sincronizado")).toBeInTheDocument();
    expect(within(drawer).getByText("Este mês ainda não foi sincronizado. Use “Sincronizar agora”.", { selector: ".vf-fin-mesa-drawer__motivo" })).toBeInTheDocument();
    expect(within(drawer).getByRole("button", { name: "Processar fechamento" })).toBeDisabled();
    expect(viaApi.processar).not.toHaveBeenCalled();
  });

  it("não admin não vê 'Sincronizar agora': a Central é só do admin", async () => {
    rede.requisitar.mockResolvedValue(vinculosCom({ contaId: 42 }));
    const usuario = userEvent.setup();
    render(<MesaFechamento {...props} />);
    const drawer = await abrirPreparo(usuario, { origem: null });
    expect(await within(drawer).findByText(/Só um administrador sincroniza/)).toBeInTheDocument();
    expect(within(drawer).queryByRole("button", { name: "Sincronizar agora" })).not.toBeInTheDocument();
  });

  it("admin sincroniza o mês: dispara o sync da competência, acompanha até o fim e relê o status", async () => {
    rede.ehAdmin.mockReturnValue(true);
    rede.requisitar.mockResolvedValue(vinculosCom({ contaId: 42 }));
    viaApi.status.mockResolvedValueOnce(STATUS_SEM_SYNC).mockResolvedValueOnce(STATUS_SINCRONIZADO);
    const usuario = userEvent.setup();
    render(<MesaFechamento {...props} />);
    const drawer = await abrirPreparo(usuario, { origem: null });
    await usuario.click(await within(drawer).findByRole("button", { name: "Sincronizar agora" }));
    await waitFor(() => expect(viaApi.status).toHaveBeenCalledTimes(2));
    expect(viaApi.iniciarSync).toHaveBeenCalledWith({ clienteSlug: "zenite", clienteContaId: 42, periodo: "2026-08" });
    expect(viaApi.runSync).toHaveBeenCalledWith({ clienteSlug: "zenite", runId: 301 }, expect.any(Object));
    expect(await within(drawer).findByText("Vendas sincronizadas da API do Mercado Livre")).toBeInTheDocument();
    expect(within(drawer).getByText("Sincronização concluída.")).toBeInTheDocument();
  });

  it("sync incompleto: processa, mas não salva sem confirmar a cobertura parcial", async () => {
    rede.requisitar.mockResolvedValue(vinculosCom({ contaId: 42 }));
    viaApi.processar.mockResolvedValue(
      respostaOk({
        sync: { ...STATUS_SINCRONIZADO.sync, completo: false, coberturaAte: "2026-08-20", motivoIncompleto: "Pedidos depois de 20/08 ainda não sincronizados." },
      })
    );
    api.salvar.mockResolvedValue({ id: 5, publicado: false, token_publico: null });
    const usuario = userEvent.setup();
    render(<MesaFechamento {...props} />);
    await processarPelaApi(usuario);
    expect(await within(painel()).findByText(/competência confere/)).toBeInTheDocument();
    expect(await screen.findByText(/Os dados sincronizados não cobrem o mês inteiro/)).toBeInTheDocument();
    const rascunho = within(painel()).getByRole("button", { name: "Salvar como rascunho" });
    expect(rascunho).toBeDisabled();
    expect(within(painel()).getByText("Confirme a cobertura incompleta dos dados para salvar.")).toBeInTheDocument();
    await usuario.click(screen.getByRole("checkbox", { name: /Entendo que o fechamento está incompleto/ }));
    expect(rascunho).toBeEnabled();
  });

  it("processar pela API manda o período, a conta e os ajustes; a mesa mostra o resultado como na planilha", async () => {
    rede.requisitar.mockResolvedValue(vinculosCom({ contaId: 42 }));
    const usuario = userEvent.setup();
    render(<MesaFechamento {...props} />);
    await processarPelaApi(usuario);
    expect(viaApi.processar).toHaveBeenCalledWith(
      expect.objectContaining({ clienteSlug: "zenite", clienteContaId: 42, periodo: "2026-08" }),
      expect.any(Object)
    );
    expect(api.processar).not.toHaveBeenCalled();
    expect(await screen.findByTestId("kpis-processamento")).toHaveTextContent("R$ 12.000,00");
  });

  it("salvar grava a origem API no metadado: fonteVendas, origem e o sync usado", async () => {
    rede.requisitar.mockResolvedValue(vinculosCom({ contaId: 42 }));
    api.salvar.mockResolvedValue({ id: 5, publicado: false, token_publico: null });
    const usuario = userEvent.setup();
    render(<MesaFechamento {...props} />);
    await processarPelaApi(usuario);
    await usuario.click(await within(painel()).findByRole("button", { name: "Salvar como rascunho" }));
    await waitFor(() => expect(api.salvar).toHaveBeenCalledTimes(1));
    const meta = api.salvar.mock.calls[0][0].payload_json.metadados;
    expect(meta.fonteVendas).toBe("api");
    expect(meta.origem).toBe("financeiro-v3-api");
    expect(meta.sync).toEqual({ importId: 7, publicadoEm: "2026-09-02T03:12:00Z", coberturaDe: "2026-08-01", coberturaAte: "2026-08-31" });
  });

  it("CENTRAL_SEM_SYNC vira orientação para sincronizar, não erro técnico", async () => {
    rede.requisitar.mockResolvedValue(vinculosCom({ contaId: 42 }));
    viaApi.processar.mockRejectedValue(new FechamentoApiError("Sem sync.", { status: 409, codigo: "CENTRAL_SEM_SYNC" }));
    const usuario = userEvent.setup();
    render(<MesaFechamento {...props} />);
    await processarPelaApi(usuario);
    expect(await screen.findByText(/Este mês ainda não foi sincronizado com a API do Mercado Livre/)).toBeInTheDocument();
  });

  it("trocar a origem com arquivo escolhido pede confirmação e só troca depois", async () => {
    rede.requisitar.mockResolvedValue(vinculosCom({ contaId: 42 }));
    const usuario = userEvent.setup();
    render(<MesaFechamento {...props} />);
    const drawer = await abrirPreparo(usuario, { origem: "planilha" });
    await subirVendas(usuario, "vendas.xlsx");
    await usuario.click(within(within(drawer).getByRole("group", { name: "Origem das vendas" })).getByRole("button", { name: "API do Mercado Livre" }));
    const alerta = within(drawer).getByRole("alertdialog", { name: "Confirmar troca de origem" });
    expect(alerta).toHaveTextContent("descarta o arquivo escolhido");
    await usuario.click(within(alerta).getByRole("button", { name: "Manter Planilha de vendas" }));
    expect(within(drawer).getByText("vendas.xlsx")).toBeInTheDocument();
    await usuario.click(within(within(drawer).getByRole("group", { name: "Origem das vendas" })).getByRole("button", { name: "API do Mercado Livre" }));
    await usuario.click(within(within(drawer).getByRole("alertdialog", { name: "Confirmar troca de origem" })).getByRole("button", { name: "Trocar e limpar" }));
    expect(within(within(drawer).getByRole("group", { name: "Origem das vendas" })).getByRole("button", { name: "API do Mercado Livre" })).toHaveAttribute("aria-pressed", "true");
    expect(within(drawer).queryByText("vendas.xlsx")).not.toBeInTheDocument();
  });
});

describe("fechamentoPayload · origem das vendas", () => {
  it("sem origem informada, grava a planilha de sempre e não inventa sync", () => {
    const p = montarPayloadFechamento({ processamento: respostaOk(), clienteSlug: "zenite", periodo: "2026-08", marketplace: "meli", ajustes: {} });
    expect(p.metadados.origem).toBe("financeiro-v3-nativo");
    expect(p.metadados.fonteVendas).toBe("planilha");
    expect(p.metadados.sync).toBeNull();
  });

  it("origem API: origem financeiro-v3-api e o sync do mês que o processamento usou", () => {
    const p = montarPayloadFechamento({
      processamento: respostaOk({ sync: STATUS_SINCRONIZADO.sync }),
      clienteSlug: "zenite",
      periodo: "2026-08",
      marketplace: "meli",
      ajustes: {},
      fonteVendas: "api",
    });
    expect(p.metadados.origem).toBe("financeiro-v3-api");
    expect(p.metadados.fonteVendas).toBe("api");
    expect(p.metadados.sync).toEqual({ importId: 7, publicadoEm: "2026-09-02T03:12:00Z", coberturaDe: "2026-08-01", coberturaAte: "2026-08-31" });
  });
});

// ── Modo API · custos (fase 2) ─────────────────────────────────────────
// status.base: a base que o backend do fechamento enxerga para a conta.
const BASE_DO_STATUS = { vinculada: true, id: 900, slug: "base-zenite", nome: "Base Zenite", atualizadaEm: "2026-08-15T12:00:00Z", aplicadaNoSync: true };
const SEM_BASE_DO_STATUS = { vinculada: false, id: null, slug: null, nome: null, atualizadaEm: null, aplicadaNoSync: false };
const statusComBase = (base) => ({ ...STATUS_SINCRONIZADO, base });

async function escolherPlanilhaDeCustos(usuario, drawer) {
  await usuario.click(within(drawer).getByRole("button", { name: "Usar planilha de custos" }));
  const arquivo = new File(["a"], "custos-rikam.xlsx", { type: "application/vnd.ms-excel" });
  await usuario.upload(within(drawer).getByLabelText("Planilha de custos"), arquivo);
  return arquivo;
}

describe("Mesa · modo API · card Custos", () => {
  it("conta sem base: o card avisa que sem custos o lucro não é calculado e destaca a planilha de custos", async () => {
    viaApi.status.mockResolvedValue(statusComBase(SEM_BASE_DO_STATUS));
    const usuario = userEvent.setup();
    render(<MesaFechamento {...props} />);
    expect(await within(painel()).findByText("Sem base vinculada · lucro não calculado")).toBeInTheDocument();
    const drawer = await abrirPreparo(usuario, { origem: null });
    const card = within(drawer).getByTestId("custos-modo-api");
    expect(within(card).getByText("Esta conta não tem base de custos vinculada")).toBeInTheDocument();
    expect(within(card).getByText(/Sem custos, o lucro .* não é calculado/)).toBeInTheDocument();
    // Em destaque: o botão primário do card.
    expect(within(card).getByRole("button", { name: "Usar planilha de custos" })).toHaveClass("vf-btn--primary");
    // Sem planilha, processa com os custos do sync (nenhum, aqui) — não bloqueia.
    expect(within(drawer).getByRole("button", { name: "Processar fechamento" })).toBeEnabled();
  });

  it("padrão: processa com os custos do sync (custosOrigem=sync), sem arquivo", async () => {
    viaApi.status.mockResolvedValue(statusComBase(BASE_DO_STATUS));
    const usuario = userEvent.setup();
    render(<MesaFechamento {...props} />);
    await processarPelaApi(usuario);
    expect(viaApi.processar).toHaveBeenCalledWith(
      expect.objectContaining({ custosOrigem: "sync", arquivoCustos: null }),
      expect.any(Object)
    );
  });

  it("planilha de custos: sem arquivo não processa; com arquivo envia custosOrigem=upload e o arquivo", async () => {
    viaApi.status.mockResolvedValue(statusComBase(SEM_BASE_DO_STATUS));
    viaApi.processar.mockResolvedValue(respostaOk({ sync: STATUS_SINCRONIZADO.sync, costsSource: "upload", costsBase: null }));
    const usuario = userEvent.setup();
    render(<MesaFechamento {...props} />);
    const drawer = await abrirPreparo(usuario, { origem: null });
    await usuario.click(within(drawer).getByRole("button", { name: "Usar planilha de custos" }));
    expect(within(drawer).getByRole("button", { name: "Processar fechamento" })).toBeDisabled();
    expect(within(drawer).getByText("Planilha de custos necessária.", { selector: ".vf-fin-mesa-drawer__motivo" })).toBeInTheDocument();
    const arquivo = new File(["a"], "custos-rikam.xlsx", { type: "application/vnd.ms-excel" });
    await usuario.upload(within(drawer).getByLabelText("Planilha de custos"), arquivo);
    await usuario.click(within(drawer).getByRole("button", { name: "Processar fechamento" }));
    await waitFor(() => expect(viaApi.processar).toHaveBeenCalledTimes(1));
    const [args] = viaApi.processar.mock.calls[0];
    expect(args.custosOrigem).toBe("upload");
    expect(args.arquivoCustos).toBe(arquivo);
    expect(bases.importar).not.toHaveBeenCalled();
  });

  it("salvar como base: chama /importar-base com o arquivo, o nome, a conta e o cliente, e processa com custosOrigem=base", async () => {
    viaApi.status.mockResolvedValue(statusComBase(SEM_BASE_DO_STATUS));
    bases.importar.mockResolvedValue({ ok: true, base: "custos-zenite-comercial-meli", total: 120, vinculo: { base_id: 777, cliente_conta_id: 42 } });
    viaApi.processar.mockResolvedValue(
      respostaOk({ sync: STATUS_SINCRONIZADO.sync, costsSource: "base", costsBase: { id: 777, slug: "custos-zenite-comercial-meli", nome: "Custos - Zenite Comercial - MeLi" } })
    );
    api.salvar.mockResolvedValue({ id: 5, publicado: false, token_publico: null });
    const usuario = userEvent.setup();
    render(<MesaFechamento {...props} clienteId={31} />);
    const drawer = await abrirPreparo(usuario, { origem: null });
    const arquivo = await escolherPlanilhaDeCustos(usuario, drawer);
    const salvar = within(drawer).getByRole("checkbox", { name: "Salvar como base de custos de Zenite Comercial · Loja Principal" });
    expect(salvar).toBeEnabled();
    await usuario.click(salvar);
    expect(within(drawer).getByLabelText("Nome da base")).toHaveValue("Custos - Zenite Comercial - MeLi");
    await usuario.click(within(drawer).getByRole("button", { name: "Processar fechamento" }));

    await waitFor(() => expect(viaApi.processar).toHaveBeenCalledTimes(1));
    expect(bases.importar).toHaveBeenCalledWith(
      { arquivo, nomeBase: "Custos - Zenite Comercial - MeLi", marketplace: "meli", clienteId: 31, clienteContaId: 42 },
      expect.any(Object)
    );
    // A base é gravada ANTES do processamento, que já usa a base nova.
    expect(bases.importar.mock.invocationCallOrder[0]).toBeLessThan(viaApi.processar.mock.invocationCallOrder[0]);
    const [args] = viaApi.processar.mock.calls[0];
    expect(args.custosOrigem).toBe("base");
    expect(args.arquivoCustos).toBeNull();
    // A base vinculada e o status são relidos (a conta agora tem base).
    await waitFor(() => expect(viaApi.status.mock.calls.length).toBeGreaterThanOrEqual(2));

    await usuario.click(await within(painel()).findByRole("button", { name: "Salvar como rascunho" }));
    await waitFor(() => expect(api.salvar).toHaveBeenCalledTimes(1));
    const meta = api.salvar.mock.calls[0][0].payload_json.metadados;
    expect(meta.costsSource).toBe("base");
    expect(meta.baseSalva).toEqual({ id: 777, nome: "Custos - Zenite Comercial - MeLi" });
  });

  it("erro ao salvar a base (409): aparece no card, o arquivo continua escolhido e nada é processado", async () => {
    viaApi.status.mockResolvedValue(statusComBase(SEM_BASE_DO_STATUS));
    bases.importar.mockRejectedValue(new Error("Já existe uma base com este nome. Escolha outro nome ou atualize a base existente na tela Bases."));
    const usuario = userEvent.setup();
    render(<MesaFechamento {...props} />);
    const drawer = await abrirPreparo(usuario, { origem: null });
    await escolherPlanilhaDeCustos(usuario, drawer);
    await usuario.click(within(drawer).getByRole("checkbox", { name: /Salvar como base de custos de/ }));
    await usuario.click(within(drawer).getByRole("button", { name: "Processar fechamento" }));
    // O drawer fecha ao processar e volta a abrir com o erro no card.
    const reaberto = await screen.findByRole("dialog", { name: "Preparar fechamento" });
    const card = await within(reaberto).findByTestId("custos-modo-api");
    expect(await within(card).findByRole("alert")).toHaveTextContent(/Não foi possível salvar a base: Já existe uma base com este nome/);
    expect(within(card).getByText("custos-rikam.xlsx")).toBeInTheDocument();
    expect(viaApi.processar).not.toHaveBeenCalled();
  });

  it("conta com base: salvar como base fica desabilitado e aponta para a tela Bases", async () => {
    viaApi.status.mockResolvedValue(statusComBase(BASE_DO_STATUS));
    const usuario = userEvent.setup();
    render(<MesaFechamento {...props} />);
    const drawer = await abrirPreparo(usuario, { origem: null });
    const card = within(drawer).getByTestId("custos-modo-api");
    expect(within(card).getByText("Base Zenite")).toBeInTheDocument();
    expect(within(card).getByText(/atualizada em/)).toBeInTheDocument();
    await escolherPlanilhaDeCustos(usuario, drawer);
    expect(within(drawer).getByRole("checkbox", { name: /Salvar como base de custos de/ })).toBeDisabled();
    expect(within(drawer).getByText(/Para atualizar a base existente, use a tela Bases/)).toBeInTheDocument();
    expect(within(drawer).getByRole("link", { name: /Abrir Bases/ })).toHaveAttribute("href", "bases.html");
  });

  it("base mudou depois do sync: avisa e o padrão vira recalcular com a base atual (custosOrigem=base)", async () => {
    viaApi.status.mockResolvedValue(statusComBase({ ...BASE_DO_STATUS, aplicadaNoSync: false }));
    const usuario = userEvent.setup();
    render(<MesaFechamento {...props} />);
    expect(await within(painel()).findByText("Base Zenite · recalcula com a base atual")).toBeInTheDocument();
    const drawer = await abrirPreparo(usuario, { origem: null });
    expect(within(drawer).getByText("A base mudou depois da última sincronização")).toBeInTheDocument();
    await usuario.click(within(drawer).getByRole("button", { name: "Processar fechamento" }));
    await waitFor(() => expect(viaApi.processar).toHaveBeenCalledTimes(1));
    expect(viaApi.processar.mock.calls[0][0].custosOrigem).toBe("base");
  });

  it("base mudou, mas a pessoa prefere os custos do sync: custosOrigem=sync", async () => {
    viaApi.status.mockResolvedValue(statusComBase({ ...BASE_DO_STATUS, aplicadaNoSync: false }));
    const usuario = userEvent.setup();
    render(<MesaFechamento {...props} />);
    const drawer = await abrirPreparo(usuario, { origem: null });
    await usuario.click(await within(drawer).findByRole("button", { name: "Manter os custos do sync" }));
    await usuario.click(within(drawer).getByRole("button", { name: "Processar fechamento" }));
    await waitFor(() => expect(viaApi.processar).toHaveBeenCalledTimes(1));
    expect(viaApi.processar.mock.calls[0][0].custosOrigem).toBe("sync");
  });

  it.each([
    ["CUSTOS_PLANILHA_INVALIDA", 422, /Nenhuma linha de custo foi reconhecida na planilha/],
    ["CUSTOS_ARQUIVO_GRANDE", 413, /passa do limite de 20 MB/],
    ["UPLOAD_INVALIDO", 400, /chegou incompleto/],
    ["CUSTOS_ORIGEM_INVALIDA", 400, /não aceitou a origem dos custos/],
  ])("%s: o erro aparece no card Custos (o preparo reabre) e o arquivo continua escolhido", async (codigo, status, texto) => {
    viaApi.status.mockResolvedValue(statusComBase(SEM_BASE_DO_STATUS));
    viaApi.processar.mockRejectedValue(new FechamentoApiError("x", { status, codigo }));
    const usuario = userEvent.setup();
    render(<MesaFechamento {...props} />);
    const drawer = await abrirPreparo(usuario, { origem: null });
    await escolherPlanilhaDeCustos(usuario, drawer);
    await usuario.click(within(drawer).getByRole("button", { name: "Processar fechamento" }));
    const reaberto = await screen.findByRole("dialog", { name: "Preparar fechamento" });
    const erro = await within(reaberto).findByTestId("custos-erro");
    expect(erro).toHaveTextContent(texto);
    expect(within(reaberto).getByText("custos-rikam.xlsx")).toBeInTheDocument();
  });

  it("planilha de custos acima de 20 MB não é enviada", async () => {
    viaApi.status.mockResolvedValue(statusComBase(SEM_BASE_DO_STATUS));
    const usuario = userEvent.setup();
    render(<MesaFechamento {...props} />);
    const drawer = await abrirPreparo(usuario, { origem: null });
    await usuario.click(within(drawer).getByRole("button", { name: "Usar planilha de custos" }));
    const grande = new File(["a"], "custos-enorme.xlsx", { type: "application/vnd.ms-excel" });
    Object.defineProperty(grande, "size", { value: 21 * 1024 * 1024 });
    await usuario.upload(within(drawer).getByLabelText("Planilha de custos"), grande);
    expect(within(drawer).getByRole("button", { name: "Processar fechamento" })).toBeDisabled();
    expect(within(drawer).getByText("A planilha de custos passa do limite de 20 MB.", { selector: ".vf-fin-mesa-drawer__motivo" })).toBeInTheDocument();
    expect(viaApi.processar).not.toHaveBeenCalled();
  });

  it("backend sem status.base: cai na base de /base-vinculos", async () => {
    rede.requisitar.mockResolvedValue(vinculosCom({ contaId: 42 }));
    const usuario = userEvent.setup();
    render(<MesaFechamento {...props} />);
    const drawer = await abrirPreparo(usuario, { origem: null });
    const card = within(drawer).getByTestId("custos-modo-api");
    expect(await within(card).findByText("Base Zenite")).toBeInTheDocument();
    expect(within(card).getByText("Os custos vêm da base aplicada na última sincronização.")).toBeInTheDocument();
  });
});

describe("fechamentoPayload · custos do modo API", () => {
  it("costsSource=sync guarda a base que o sync aplicou; upload não tem base", () => {
    const comSync = montarPayloadFechamento({
      processamento: respostaOk({ costsSource: "sync", costsBase: { id: 900, slug: "base-zenite", nome: "Base Zenite" } }),
      clienteSlug: "zenite",
      periodo: "2026-08",
      marketplace: "meli",
      fonteVendas: "api",
    });
    expect(comSync.metadados.costsSource).toBe("sync");
    expect(comSync.metadados.costsBase).toEqual({ id: 900, slug: "base-zenite", nome: "Base Zenite" });
    expect(comSync.metadados.baseSalva).toBeNull();

    const comUpload = montarPayloadFechamento({
      processamento: respostaOk({ costsSource: "upload", costsBase: null }),
      clienteSlug: "zenite",
      periodo: "2026-08",
      marketplace: "meli",
      fonteVendas: "api",
    });
    expect(comUpload.metadados.costsSource).toBe("upload");
    expect(comUpload.metadados.costsBase).toBeNull();
  });

  it("baseSalva sem id do vínculo usa o id da base declarada pelo processamento (mesmo slug)", () => {
    const p = montarPayloadFechamento({
      processamento: respostaOk({ costsSource: "base", costsBase: { id: 777, slug: "custos-x", nome: "Custos X" } }),
      clienteSlug: "zenite",
      periodo: "2026-08",
      marketplace: "meli",
      fonteVendas: "api",
      baseSalva: { id: null, slug: "custos-x", nome: "Custos X" },
    });
    expect(p.metadados.baseSalva).toEqual({ id: 777, nome: "Custos X" });
  });
});
