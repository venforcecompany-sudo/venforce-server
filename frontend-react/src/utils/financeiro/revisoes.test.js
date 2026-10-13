import { describe, it, expect } from "vitest";
import { revisoesDoPeriodo, resumoRevisoes, revisaoDaEntrega, processamentoDoSnapshot, contagemDosFiltros, STATUS_DO_FILTRO } from "./revisoes.js";
import { FILTROS_PRODUTO } from "./produtos.js";

const S = [
  { id: 1, periodo: "2026-09", revisao: 1, publicado: true, entregas: [{ id: 10, publicado: true }] },
  { id: 2, periodo: "2026-09", revisao: 2, publicado: false, entregas: [{ id: 11, publicado: false }] },
  { id: 3, periodo: "2026-10", revisao: 1, publicado: false, entregas: [] },
];

describe("revisões do fechamento", () => {
  it("revisões da competência, mais nova primeiro; nunca de outro mês", () => {
    expect(revisoesDoPeriodo(S, "2026-09").map((s) => s.revisao)).toEqual([2, 1]);
    expect(revisoesDoPeriodo(S, "2026-10").map((s) => s.id)).toEqual([3]);
    expect(revisoesDoPeriodo(null, "2026-09")).toEqual([]);
  });

  it("resumo: última, publicada e 'há revisão mais nova não publicada'", () => {
    const r = resumoRevisoes(revisoesDoPeriodo(S, "2026-09"));
    expect(r.ultima.revisao).toBe(2);
    expect(r.publicada.revisao).toBe(1);
    expect(r.novaNaoPublicada).toBe(true);
    const so1 = resumoRevisoes(revisoesDoPeriodo(S, "2026-10"));
    expect(so1.publicada).toBeNull();
    expect(resumoRevisoes([]).ultima).toBeNull();
  });

  it("revisão de uma entrega (pela lista de entregas do snapshot); entrega antiga → null", () => {
    expect(revisaoDaEntrega(S, 11).revisao).toBe(2);
    expect(revisaoDaEntrega(S, 999)).toBeNull();
    expect(revisaoDaEntrega(null, 11)).toBeNull();
  });

  it("snapshot → formato do processamento (summary, origem dos custos, diagnóstico), sem linhas nem planilha", () => {
    const p = processamentoDoSnapshot({ summary: { finalResult: 1 }, origemCustos: { costsSource: "base", costsBase: { nome: "B" } }, diagnostico: { unmatchedIds: ["X"], competencia: { periodoDetectado: "2026-09" } } });
    expect(p.summary.finalResult).toBe(1);
    expect(p.costsSource).toBe("base");
    expect(p.costsBase.nome).toBe("B");
    expect(p.unmatchedIds).toEqual(["X"]);
    expect(p.detailedRows).toEqual([]);
    expect(p.excelBase64).toBeNull();
  });

  it("todo filtro da tabela tem status no backend e contagem gravada", () => {
    for (const f of FILTROS_PRODUTO) expect(f.id in STATUS_DO_FILTRO).toBe(true);
    const c = contagemDosFiltros({ total: 9, saudavel: 2, critico: 1, sem_custo: 3, cancelados: 1 });
    for (const f of FILTROS_PRODUTO) expect(typeof c[f.id]).toBe("number");
    expect(c.criticos).toBe(1);
    expect(c.todos).toBe(9);
  });
});
