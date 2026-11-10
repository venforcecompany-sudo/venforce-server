// Contrato de rede do modo API do Fechamento: URL, método, corpo e o `code`
// do envelope de erro (que a tela usa para orientar, ex. CENTRAL_SEM_SYNC).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  intervaloDoMes,
  obterStatusFechamentoApi,
  processarFechamentoApi,
  iniciarSyncCentral,
  obterSyncRunCentral,
} from "./fechamentoViaApiApi.js";
import { FechamentoApiError } from "./financeiroFechamentoApi.js";

function respostaJson(corpo, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => corpo };
}

describe("fechamentoViaApiApi", () => {
  let fetchMock;

  beforeEach(() => {
    localStorage.setItem("vf-token", "tok-teste");
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.removeItem("vf-token");
  });

  it("intervaloDoMes cobre o mês inteiro (inclui fevereiro bissexto)", () => {
    expect(intervaloDoMes("2026-10")).toEqual({ dateFrom: "2026-10-01", dateTo: "2026-10-31" });
    expect(intervaloDoMes("2028-02")).toEqual({ dateFrom: "2028-02-01", dateTo: "2028-02-29" });
    expect(intervaloDoMes("agosto")).toBeNull();
  });

  it("status: GET com conta e período na query e o bearer do usuário", async () => {
    fetchMock.mockResolvedValue(respostaJson({ ok: true, sync: { disponivel: true } }));
    const dados = await obterStatusFechamentoApi({ clienteSlug: "zenite", clienteContaId: 42, periodo: "2026-08" });
    expect(dados.sync.disponivel).toBe(true);
    const [url, opcoes] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/financeiro\/zenite\/fechamento-api\/status\?conta=42&periodo=2026-08$/);
    expect(opcoes.method).toBe("GET");
    expect(opcoes.headers.Authorization).toBe("Bearer tok-teste");
  });

  it("processar: POST com a conta, o período e os ajustes como texto pt-BR (o backend faz o parse)", async () => {
    fetchMock.mockResolvedValue(respostaJson({ ok: true, summary: {} }));
    await processarFechamentoApi({
      clienteSlug: "zenite",
      clienteContaId: 42,
      periodo: "2026-08",
      ajustes: { ads: "1.234,56", venforce: "", affiliates: "0", fullCost: "", additionalCosts: "300" },
    });
    const [url, opcoes] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/financeiro\/zenite\/fechamento-api$/);
    expect(opcoes.method).toBe("POST");
    expect(JSON.parse(opcoes.body)).toEqual({
      clienteContaId: 42,
      periodo: "2026-08",
      ads: "1.234,56",
      venforce: "0",
      affiliates: "0",
      fullCost: "0",
      additionalCosts: "300",
    });
  });

  it("CENTRAL_SEM_SYNC chega como FechamentoApiError com o código, para a tela orientar o usuário", async () => {
    fetchMock.mockResolvedValue(respostaJson({ ok: false, error: "Sem sync.", code: "CENTRAL_SEM_SYNC" }, 409));
    const erro = await processarFechamentoApi({ clienteSlug: "zenite", clienteContaId: 42, periodo: "2026-08" }).catch((e) => e);
    expect(erro).toBeInstanceOf(FechamentoApiError);
    expect(erro.codigo).toBe("CENTRAL_SEM_SYNC");
    expect(erro.status).toBe(409);
    expect(erro.message).toBe("Sem sync.");
  });

  it("iniciar sync: POST na Central com o intervalo do mês e a conta, marketplace meli", async () => {
    fetchMock.mockResolvedValue(respostaJson({ ok: true, run: { id: 9, status: "queued" }, reaproveitado: false }, 202));
    const dados = await iniciarSyncCentral({ clienteSlug: "zenite", clienteContaId: 42, periodo: "2026-08" });
    expect(dados.run.id).toBe(9);
    const [url, opcoes] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/operacao\/central-vendas\/zenite\/sync-runs$/);
    expect(opcoes.method).toBe("POST");
    expect(JSON.parse(opcoes.body)).toEqual({ marketplace: "meli", clienteContaId: 42, dateFrom: "2026-08-01", dateTo: "2026-08-31" });
  });

  it("acompanhar o run: GET do run pela Central (a Central responde com `erro`, não `error`)", async () => {
    fetchMock.mockResolvedValue(respostaJson({ ok: false, erro: "Run não encontrado." }, 404));
    const erro = await obterSyncRunCentral({ clienteSlug: "zenite", runId: 9 }).catch((e) => e);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/operacao\/central-vendas\/zenite\/sync-runs\/9$/);
    expect(erro.message).toBe("Run não encontrado.");
    expect(erro.codigo).toBe("erro_api");
  });

  it("sessão expirada: sem token, nem chama a rede", async () => {
    localStorage.removeItem("vf-token");
    const erro = await obterStatusFechamentoApi({ clienteSlug: "zenite", clienteContaId: 42, periodo: "2026-08" }).catch((e) => e);
    expect(erro.codigo).toBe("nao_autenticado");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
