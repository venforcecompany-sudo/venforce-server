// Helper mínimo de composição de classes condicionais.
// Não é biblioteca externa: junta strings, ignora valores falsy.

import { describe, it, expect } from "vitest";
import { cx } from "./cx.js";

describe("cx", () => {
  it("junta classes verdadeiras separadas por espaço", () => {
    expect(cx("vf-btn", "vf-btn--primary")).toBe("vf-btn vf-btn--primary");
  });

  it("ignora valores falsy (false, null, undefined, string vazia)", () => {
    expect(cx("vf-btn", false && "vf-btn--lg", null, undefined, "")).toBe("vf-btn");
  });

  it("mantém apenas o modificador quando a condição é verdadeira", () => {
    const grande = true;
    expect(cx("vf-btn", grande && "vf-btn--lg")).toBe("vf-btn vf-btn--lg");
  });

  it("colapsa espaços extras entre tokens", () => {
    expect(cx("vf-btn   vf-btn--sm", "  is-loading  ")).toBe("vf-btn vf-btn--sm is-loading");
  });

  it("sem argumentos retorna string vazia", () => {
    expect(cx()).toBe("");
  });
});
