// Missão Financeiro V3 — a resolução de EXIBIÇÃO da base vinculada tem que
// espelhar server/services/bases/baseCustosService.resolverBaseVinculada:
// isola por clienteContaId, cai no legado (conta NULL) só quando a conta não
// tem vínculo próprio, e nunca usa a base de OUTRA conta em silêncio.

import { describe, it, expect } from "vitest";
import { resolverBaseDosVinculos } from "./useBaseVinculada.js";

const base = (id, contaId, nome = `Base ${id}`) => ({
  id,
  slug: `base-${id}`,
  nome,
  ativo: true,
  vinculo: { cliente_slug: "zenite", marketplace: "shopee", cliente_conta_id: contaId, conta_nome: `Conta ${contaId}` },
});

const args = (bases, clienteContaId) => ({ bases, clienteSlug: "zenite", marketplace: "shopee", clienteContaId });

describe("resolverBaseDosVinculos", () => {
  it("sem bases → ausente", () => {
    expect(resolverBaseDosVinculos(args([], 38)).status).toBe("ausente");
  });

  it("vínculo da conta → encontrada, com a base certa", () => {
    const r = resolverBaseDosVinculos(args([base(900, 38), base(901, 39)], 38));
    expect(r.status).toBe("encontrada");
    expect(r.base.id).toBe(900);
  });

  it("conta 39 nunca usa a base 900 da conta 38", () => {
    const r = resolverBaseDosVinculos(args([base(900, 38), base(901, 39)], 39));
    expect(r.base.id).toBe(901);
  });

  it("conta sem vínculo próprio, mas existe vínculo legado (conta NULL) → cai no legado", () => {
    const r = resolverBaseDosVinculos(args([base(902, null)], 77));
    expect(r.status).toBe("encontrada");
    expect(r.base.id).toBe(902);
  });

  it("conta sem vínculo próprio e sem legado → ausente (nunca a base de outra conta)", () => {
    const r = resolverBaseDosVinculos(args([base(900, 38)], 77));
    expect(r.status).toBe("ausente");
  });

  it("sem clienteContaId e 2+ contas distintas → ambigua", () => {
    const r = resolverBaseDosVinculos(args([base(900, 38), base(901, 39)], null));
    expect(r.status).toBe("ambigua");
    expect(r.contas.map((c) => c.id).sort()).toEqual([38, 39]);
  });

  it("marketplace diferente do vínculo não conta", () => {
    const b = { ...base(900, 38), vinculo: { ...base(900, 38).vinculo, marketplace: "meli" } };
    expect(resolverBaseDosVinculos(args([b], 38)).status).toBe("ausente");
  });

  it("base inativa não conta", () => {
    const b = { ...base(900, 38), ativo: false };
    expect(resolverBaseDosVinculos(args([b], 38)).status).toBe("ausente");
  });
});
