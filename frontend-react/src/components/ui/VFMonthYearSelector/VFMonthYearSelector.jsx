// @ts-check
// VFMonthYearSelector — seletor de competência (mês + ano) da Fundação Global V2.
// Retorna/recebe competência no formato "AAAA-MM". Diferente do VFButton, este
// componente introduz um padrão visual novo (não existe .vf-calendar na
// Fundação ainda), então tem CSS próprio — só com var(--vf-*), sem token novo.
//
// value é a fonte da verdade: quando ausente ou inválido, o componente cai no
// mês atual apenas como proteção visual — isso NUNCA dispara onChange. Só o
// clique num mês confirma uma competência (sem botão de OK/confirmar).
//
// O popover é montado via createPortal em document.body, não como filho do
// trigger. `.vf-month-year-selector__trigger` normalmente vive dentro de um
// item de flex/grid de página (ex.: `.vf-page-header`, `.vf-page-header__actions`)
// que não é um stacking context próprio — um `z-index` no popover só domina
// irmãos de página quando não há, no caminho até a raiz, nenhum ancestral que
// já tenha "prendido" o conteúdo num nível de pintura mais baixo (comum com
// itens de flex/grid). Portal evita depender de qualquer hierarquia de
// stacking fora deste componente: o popover sempre nasce direto em <body>,
// então `--vf-z-dropdown` vale sozinho, sem checar cada tela que o usa.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cx } from "../../../utils/cx.js";
import "./VFMonthYearSelector.css";

const MESES = [
  "Jan", "Fev", "Mar", "Abr", "Mai", "Jun",
  "Jul", "Ago", "Set", "Out", "Nov", "Dez",
];

const JANELA_ANOS = 2; // mostra viewYear-2 .. viewYear+2 no dropdown de ano

/**
 * @param {string | undefined} value
 * @returns {{ year: number, month: number } | null}
 */
function parseValue(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return { year, month };
}

function competenciaAtual() {
  const hoje = new Date();
  return { year: hoje.getFullYear(), month: hoje.getMonth() + 1 };
}

/**
 * @param {{ year: number, month: number }} competencia
 */
function formatarValue({ year, month }) {
  return `${year}-${String(month).padStart(2, "0")}`;
}

/**
 * @param {{ year: number, month: number }} competencia
 */
function formatarRotulo({ year, month }) {
  return `${MESES[month - 1]} ${year}`;
}

/**
 * @typedef {Object} VFMonthYearSelectorProps
 * @property {string} [value]  Competência no formato "AAAA-MM". Ausente/inválido cai no mês atual (sem disparar onChange).
 * @property {(value: string) => void} [onChange]  Chamado assim que um mês é clicado — sem passo de confirmação.
 * @property {boolean} [disabled=false]
 * @property {string} [className]
 */

/**
 * Seletor de competência (mês + ano) da Fundação Global V2.
 * @param {VFMonthYearSelectorProps} props
 */
export function VFMonthYearSelector({ value, onChange, disabled = false, className }) {
  const competencia = parseValue(value) ?? competenciaAtual();

  const [open, setOpen] = useState(false);
  const [yearMenuOpen, setYearMenuOpen] = useState(false);
  const [viewYear, setViewYear] = useState(competencia.year);
  const [popoverPos, setPopoverPos] = useState(/** @type {{ top: number, left: number } | null} */ (null));
  const rootRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const triggerRef = useRef(/** @type {HTMLButtonElement | null} */ (null));
  const popoverRef = useRef(/** @type {HTMLDivElement | null} */ (null));

  function fechar() {
    setOpen(false);
    setYearMenuOpen(false);
  }

  // Reposiciona o popover contra o trigger a cada abertura/resize/scroll —
  // necessário porque, montado em <body> via portal, ele é `position: fixed`
  // e não acompanha o fluxo/scroll da página sozinho como um `absolute`
  // filho acompanharia.
  function posicionarPopover() {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    setPopoverPos({ top: rect.bottom + 8, left: rect.left + rect.width / 2 });
  }

  function abrirOuFechar() {
    if (disabled) return;
    if (open) {
      fechar();
      return;
    }
    setViewYear(competencia.year);
    setOpen(true);
  }

  function selecionarMes(month) {
    onChange?.(formatarValue({ year: viewYear, month }));
    fechar();
  }

  // Posiciona antes do paint (sem flash em 0,0) e mantém colado no trigger
  // enquanto aberto, já que o portal tira o popover do fluxo desta página.
  useLayoutEffect(() => {
    if (!open) return undefined;

    posicionarPopover();
    window.addEventListener("resize", posicionarPopover);
    window.addEventListener("scroll", posicionarPopover, true);
    return () => {
      window.removeEventListener("resize", posicionarPopover);
      window.removeEventListener("scroll", posicionarPopover, true);
    };
  }, [open]);

  // Fecha ao clicar fora ou pressionar Esc — sem disparar onChange. "Fora"
  // considera trigger E popover: o popover mora em <body> (portal), fora de
  // rootRef, então um clique nele conta como clique fora se não checarmos os
  // dois.
  useEffect(() => {
    if (!open) return undefined;

    function aoClicarFora(event) {
      const alvo = /** @type {Node} */ (event.target);
      const dentroDoTrigger = rootRef.current?.contains(alvo);
      const dentroDoPopover = popoverRef.current?.contains(alvo);
      if (!dentroDoTrigger && !dentroDoPopover) fechar();
    }

    function aoPressionarTecla(event) {
      if (event.key === "Escape") fechar();
    }

    document.addEventListener("mousedown", aoClicarFora);
    document.addEventListener("keydown", aoPressionarTecla);
    return () => {
      document.removeEventListener("mousedown", aoClicarFora);
      document.removeEventListener("keydown", aoPressionarTecla);
    };
  }, [open]);

  const anos = [];
  for (let a = viewYear - JANELA_ANOS; a <= viewYear + JANELA_ANOS; a += 1) {
    anos.push(a);
  }

  return (
    <div ref={rootRef} className={cx("vf-month-year-selector", className)}>
      <button
        ref={triggerRef}
        type="button"
        className={cx(
          "vf-month-year-selector__trigger",
          open && "vf-month-year-selector__trigger--open",
          disabled && "vf-month-year-selector__trigger--disabled"
        )}
        disabled={disabled || undefined}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={abrirOuFechar}
      >
        <span>{formatarRotulo(competencia)}</span>
        <svg
          className="vf-month-year-selector__chevron"
          width="11"
          height="11"
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
        >
          <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && popoverPos && createPortal(
        <div
          ref={popoverRef}
          className="vf-month-year-selector__popover"
          style={{ top: popoverPos.top, left: popoverPos.left }}
          role="dialog"
          aria-label="Selecionar competência"
        >
          <div className="vf-month-year-selector__header">
            <button
              type="button"
              className="vf-month-year-selector__nav"
              aria-label="Ano anterior"
              onClick={() => setViewYear((y) => y - 1)}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M10 3L5 8L10 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <button
              type="button"
              className={cx(
                "vf-month-year-selector__year-button",
                yearMenuOpen && "vf-month-year-selector__year-button--open"
              )}
              aria-haspopup="listbox"
              aria-expanded={yearMenuOpen}
              onClick={() => setYearMenuOpen((v) => !v)}
            >
              {viewYear}
              <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <button
              type="button"
              className="vf-month-year-selector__nav"
              aria-label="Próximo ano"
              onClick={() => setViewYear((y) => y + 1)}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M6 3L11 8L6 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>

          <div className="vf-month-year-selector__grid">
            {MESES.map((mes, index) => {
              const month = index + 1;
              const selecionado = viewYear === competencia.year && month === competencia.month;
              return (
                <button
                  key={mes}
                  type="button"
                  className={cx(
                    "vf-month-year-selector__month",
                    selecionado && "vf-month-year-selector__month--selected"
                  )}
                  aria-current={selecionado || undefined}
                  onClick={() => selecionarMes(month)}
                >
                  {mes}
                </button>
              );
            })}
          </div>

          {yearMenuOpen && (
            <div className="vf-month-year-selector__year-menu" role="listbox" aria-label="Selecionar ano">
              {anos.map((ano) => (
                <div
                  key={ano}
                  role="option"
                  aria-selected={ano === viewYear}
                  tabIndex={0}
                  className={cx(
                    "vf-month-year-selector__year-item",
                    ano === viewYear && "vf-month-year-selector__year-item--active"
                  )}
                  onClick={() => {
                    setViewYear(ano);
                    setYearMenuOpen(false);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      setViewYear(ano);
                      setYearMenuOpen(false);
                    }
                  }}
                >
                  {ano}
                </div>
              ))}
            </div>
          )}
        </div>,
        document.body
      )}
    </div>
  );
}
