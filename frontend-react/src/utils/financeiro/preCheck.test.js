import { describe, it, expect } from "vitest";
import { montarPreCheck, competenciasNoNome, precedenteDaConta } from "./preCheck.js";

const arquivo = (name) => ({ name });
const BASE = { status: "encontrada", base: { id: 9, slug: "zorza-shopee-3", nome: "zorza shopee 3" } };
const SET = {
  id: 1, periodo: "2026-09", revisao: 2, ajustes: { ads: 5000 }, contagens: { pendencias: 12 },
  origemCustos: { costsSource: "base", costsBase: { id: 9, nome: "zorza shopee 3" } },
  arquivos: [{ tipo: "vendas", sha256: "aaa" }, { tipo: "order_all", sha256: "bbb" }],
};
const base = { clienteNome: "Zorza", contaNome: "Shopee", clienteContaId: 121, periodo: "2026-10", marketplace: "shopee", base: BASE, arquivos: {}, ajustes: {} };
const item = (pc, id) => pc.itens.find((i) => i.id === id);

describe("pré-check", () => {
  it("obrigatório × recomendado × aviso; nada recomendado bloqueia", () => {
    const pc = montarPreCheck({ ...base, arquivos: { sales: arquivo("Performance.xlsx") }, ajustes: { ads: "1000" } });
    expect(item(pc, "cliente").estado).toBe("ok");
    expect(item(pc, "conta").estado).toBe("ok");
    expect(item(pc, "base").detalhe).toBe("base vinculada zorza shopee 3");
    expect(item(pc, "vendas").estado).toBe("ok");
    expect(item(pc, "order_all")).toMatchObject({ nivel: "recomendado", estado: "recomendado" });
    expect(pc.contagem.faltando).toBe(0);
  });

  it("falta a planilha principal → obrigatório faltando; sem conta → falta", () => {
    const pc = montarPreCheck({ ...base, clienteContaId: null, contaNome: null });
    expect(item(pc, "vendas").estado).toBe("falta");
    expect(item(pc, "conta").estado).toBe("falta");
    expect(pc.contagem.faltando).toBe(2);
  });

  it("arquivo com data de outro mês no nome → aviso", () => {
    const pc = montarPreCheck({ ...base, arquivos: { sales: arquivo("Order.all.20260901_20260930.xlsx") } });
    expect(item(pc, "vendas").estado).toBe("aviso");
    expect(item(pc, "vendas").detalhe).toMatch(/sugere Setembro\/2026, não Outubro\/2026/);
    expect(competenciasNoNome("Order.all.20261001_20261031.xlsx")).toEqual(["2026-10"]);
    expect(competenciasNoNome("vendas.xlsx")).toEqual([]);
    expect(competenciasNoNome("relatorio-2026-08.xlsx")).toEqual(["2026-08"]);
  });

  it("o MESMO arquivo (sha256) de outra competência → aviso", () => {
    const pc = montarPreCheck({ ...base, snapshots: [SET], arquivos: { sales: arquivo("p.xlsx"), ordersAll: arquivo("o.xlsx") }, assinaturas: { sales: "aaa", ordersAll: "zzz" } });
    expect(item(pc, "vendas").detalhe).toMatch(/MESMO arquivo usado em Setembro\/2026 \(v2\)/);
    expect(item(pc, "order_all").estado).toBe("ok");
  });

  it("como a conta costuma ser fechada (precedente): ADS vazio, Order.all usado antes, pendências que ficaram", () => {
    const pc = montarPreCheck({ ...base, snapshots: [SET], arquivos: { sales: arquivo("p.xlsx") } });
    expect(item(pc, "ajustes").estado).toBe("aviso");
    expect(item(pc, "ajustes").detalhe).toMatch(/ADS vazio — no último fechamento \(Setembro\/2026 v2\) foi R\$\s?5\.000,00/);
    expect(item(pc, "order_all").detalhe).toMatch(/o último fechamento \(Setembro\/2026 v2\) usou/);
    expect(item(pc, "pendencias_anteriores").rotulo).toBe("12 produtos ficaram sem custo");
  });

  it("base vinculada diferente da do último fechamento → aviso", () => {
    const pc = montarPreCheck({ ...base, base: { status: "encontrada", base: { id: 10, nome: "base nova" } }, snapshots: [SET], arquivos: { sales: arquivo("p.xlsx") } });
    expect(item(pc, "base").estado).toBe("aviso");
    expect(item(pc, "base").detalhe).toMatch(/a base foi zorza shopee 3/);
  });

  it("competência que já tem revisão → aviso com o número da próxima", () => {
    const out = { ...SET, id: 2, periodo: "2026-10", revisao: 1, publicado: true };
    const pc = montarPreCheck({ ...base, snapshots: [SET, out] });
    expect(item(pc, "competencia").estado).toBe("aviso");
    expect(item(pc, "competencia").detalhe).toMatch(/já tem v1 salva \(publicado v1\) — salvar cria v2/);
  });

  it("precedente = revisão mais nova de competência ANTERIOR", () => {
    const snaps = [{ periodo: "2026-08", revisao: 3 }, { periodo: "2026-09", revisao: 1 }, { periodo: "2026-09", revisao: 2 }, { periodo: "2026-11", revisao: 1 }];
    expect(precedenteDaConta(snaps, "2026-10")).toMatchObject({ periodo: "2026-09", revisao: 2 });
    expect(precedenteDaConta(snaps, "2026-07")).toMatchObject({ periodo: "2026-11" });
    expect(precedenteDaConta([], "2026-10")).toBeNull();
  });
});
