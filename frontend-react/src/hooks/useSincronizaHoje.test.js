// Disparo automático do sync dos pedidos de hoje no Início.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useSincronizaHoje } from "./useSincronizaHoje.js";

const mocks = vi.hoisted(() => ({ ehAdmin: vi.fn(), useSyncCentral: vi.fn(), iniciar: vi.fn() }));
vi.mock("../services/apiClient.js", () => ({ ehAdmin: mocks.ehAdmin }));
vi.mock("./useSyncCentral.js", () => ({ useSyncCentral: mocks.useSyncCentral }));

function dados({ dadosAte = "2026-11-10", marketplace = "meli" } = {}) {
  return {
    contexto: { marketplace },
    periodo: { hoje: "2026-11-11" },
    vendas: { disponivel: true, dados: { dadosAte } },
  };
}

function montar(props = {}, { admin = true, fase = "ocioso" } = {}) {
  mocks.ehAdmin.mockReturnValue(admin);
  mocks.useSyncCentral.mockReturnValue({ fase, erro: null, emAndamento: fase === "acompanhando", iniciar: mocks.iniciar });
  return renderHook((p) => useSincronizaHoje(p), { initialProps: { clienteSlug: "n97", clienteContaId: 42, dados: dados(), onConcluido: vi.fn(), ...props } });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
});

describe("useSincronizaHoje", () => {
  it("admin + ML + faltam os pedidos de hoje: dispara o sync do mês corrente uma vez", () => {
    const { rerender } = montar();
    expect(mocks.iniciar).toHaveBeenCalledTimes(1);
    expect(mocks.useSyncCentral).toHaveBeenLastCalledWith(expect.objectContaining({ periodo: "2026-11", clienteContaId: 42, habilitado: true }));
    rerender({ clienteSlug: "n97", clienteContaId: 42, dados: dados(), onConcluido: vi.fn() });
    expect(mocks.iniciar).toHaveBeenCalledTimes(1);
  });

  it("dados já cobrem hoje: não sincroniza", () => {
    montar({ dados: dados({ dadosAte: "2026-11-11" }) });
    expect(mocks.iniciar).not.toHaveBeenCalled();
  });

  it("não admin: não sincroniza (o servidor não deixaria)", () => {
    const { result } = montar({}, { admin: false });
    expect(mocks.iniciar).not.toHaveBeenCalled();
    expect(result.current.podeSincronizar).toBe(false);
  });

  it("Shopee: não sincroniza", () => {
    montar({ dados: dados({ marketplace: "shopee" }) });
    expect(mocks.iniciar).not.toHaveBeenCalled();
  });

  it("recarregar a página logo depois não dispara outro sync (10 min)", () => {
    montar().unmount();
    expect(mocks.iniciar).toHaveBeenCalledTimes(1);
    montar();
    expect(mocks.iniciar).toHaveBeenCalledTimes(1);
  });

  it("sync já em curso: não dispara outro", () => {
    montar({}, { fase: "acompanhando" });
    expect(mocks.iniciar).not.toHaveBeenCalled();
  });
});
