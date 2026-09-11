// VFMonthYearSelector — testes de comportamento (classes/atributos/interação),
// seguindo o mesmo padrão de VFButton.test.jsx: sem asserção de estilo
// computado, já que os tokens --vf-* só existem via <link> no HTML real.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VFMonthYearSelector } from "./VFMonthYearSelector.jsx";

beforeEach(() => {
  // Só a Date é congelada — setTimeout/setInterval seguem reais, senão o
  // userEvent (que usa timers internamente para simular interação) trava.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 8, 11)); // 2026-09-11
});

afterEach(() => {
  vi.useRealTimers();
});

describe("VFMonthYearSelector", () => {
  it("sem value, mostra o mês/ano atual como fallback", () => {
    render(<VFMonthYearSelector onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Set 2026" })).toBeInTheDocument();
  });

  it("com value válido, formata o rótulo como 'Mon AAAA'", () => {
    render(<VFMonthYearSelector value="2026-06" onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Jun 2026" })).toBeInTheDocument();
  });

  it("com value ausente ou inválido, não dispara onChange ao montar (fallback é só proteção)", () => {
    const onChange = vi.fn();
    const { rerender } = render(<VFMonthYearSelector onChange={onChange} />);
    rerender(<VFMonthYearSelector value="não-é-competência" onChange={onChange} />);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("clique na caixa abre o popover com os 12 meses", async () => {
    const user = userEvent.setup();
    render(<VFMonthYearSelector value="2026-06" onChange={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Jun 2026" }));
    const meses = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
    for (const mes of meses) {
      expect(screen.getByRole("button", { name: mes })).toBeInTheDocument();
    }
  });

  it("não existe botão de confirmar/OK/cancelar — a seleção do mês é a única ação", async () => {
    const user = userEvent.setup();
    render(<VFMonthYearSelector value="2026-06" onChange={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Jun 2026" }));
    expect(screen.queryByRole("button", { name: /^(ok|confirmar|aplicar|cancelar)$/i })).not.toBeInTheDocument();
  });

  it("clicar num mês aplica a competência (onChange) e fecha o popover, sem confirmação", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<VFMonthYearSelector value="2026-06" onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "Jun 2026" }));
    await user.click(screen.getByRole("button", { name: "Set" }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("2026-09");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("o mês da competência atual aparece marcado como selecionado (aria-current)", async () => {
    const user = userEvent.setup();
    render(<VFMonthYearSelector value="2026-06" onChange={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Jun 2026" }));
    expect(screen.getByRole("button", { name: "Jun" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: "Set" })).not.toHaveAttribute("aria-current");
  });

  it("clicar fora fecha o popover sem disparar onChange", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <div>
        <VFMonthYearSelector value="2026-06" onChange={onChange} />
        <button type="button">fora</button>
      </div>
    );
    await user.click(screen.getByRole("button", { name: "Jun 2026" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "fora" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("Esc fecha o popover sem disparar onChange", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<VFMonthYearSelector value="2026-06" onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "Jun 2026" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("navegar de ano (‹ ›) só troca a grade exibida — não dispara onChange", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<VFMonthYearSelector value="2026-06" onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "Jun 2026" }));
    await user.click(screen.getByRole("button", { name: "Próximo ano" }));

    expect(screen.getByRole("button", { name: "2027" })).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("abrir o dropdown de ano e escolher um ano atualiza a grade sem fechar o popover nem disparar onChange", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<VFMonthYearSelector value="2026-06" onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "Jun 2026" }));
    await user.click(screen.getByRole("button", { name: "2026" }));
    await user.click(screen.getByRole("option", { name: "2028" }));

    expect(screen.getByRole("button", { name: "2028" })).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("disabled bloqueia a abertura do popover e nunca dispara onChange", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<VFMonthYearSelector value="2026-06" onChange={onChange} disabled />);
    const trigger = screen.getByRole("button", { name: "Jun 2026" });
    expect(trigger).toBeDisabled();

    await user.click(trigger);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("é controlado: mudar o value externamente atualiza o rótulo exibido", () => {
    const { rerender } = render(<VFMonthYearSelector value="2026-06" onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Jun 2026" })).toBeInTheDocument();

    rerender(<VFMonthYearSelector value="2026-12" onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Dez 2026" })).toBeInTheDocument();
  });
});
