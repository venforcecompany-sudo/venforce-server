// Filtros: cliente, competência, comparação e margem-alvo.
// Todos são controlados e refletidos na query string pelo hook useCliente360,
// para a tela ser linkável a partir do Portal legado. Token nunca vai na URL.

import { VFMonthYearSelector } from "../ui/index.js";

// A UI fala em % inteiro; o contrato do backend é fração (0,15).
function paraPercentual(margemAlvo) {
  if (margemAlvo === "" || margemAlvo === null || margemAlvo === undefined) return "";
  const n = Number(margemAlvo);
  if (!Number.isFinite(n)) return "";
  return String(n > 1 ? n : n * 100);
}

export default function Cliente360Filters({
  filtros, clientes, clientesCarregando, carregando, onAtualizar, onRecarregar,
}) {
  return (
    <section className="vf-toolbar c360-filtros" aria-label="Filtros do fechamento">
      <div className="vf-toolbar__filters">
        <label className="vf-field c360-filtros__campo">
          <span className="vf-field__label">Cliente</span>
          <select
            className="vf-select"
            value={filtros.slug}
            disabled={clientesCarregando || !clientes.length}
            onChange={(e) => onAtualizar({ slug: e.target.value })}
          >
            {!clientes.length && <option value={filtros.slug}>{filtros.slug || "—"}</option>}
            {clientes.map((c) => (
              <option key={c.slug} value={c.slug}>{c.nome || c.slug}</option>
            ))}
          </select>
        </label>

        <label className="vf-field c360-filtros__campo">
          <span className="vf-field__label">Competência</span>
          <VFMonthYearSelector
            value={filtros.competencia}
            onChange={(competencia) => onAtualizar({ competencia })}
          />
        </label>

        <label className="vf-field c360-filtros__campo">
          <span className="vf-field__label">Comparar com</span>
          <VFMonthYearSelector
            value={filtros.compararCom}
            onChange={(compararCom) => onAtualizar({ compararCom })}
          />
        </label>

        <label className="vf-field c360-filtros__campo c360-filtros__campo--curto">
          <span className="vf-field__label">Margem-alvo</span>
          <div className="vf-input-group">
            <input
              className="vf-input vf-input--sm"
              type="number" min="0" max="100" step="0.5" inputMode="decimal" placeholder="15"
              value={paraPercentual(filtros.margemAlvo)}
              onChange={(e) => {
                const n = Number(e.target.value);
                onAtualizar({ margemAlvo: Number.isFinite(n) && n > 0 ? n / 100 : "" });
              }}
            />
            <span className="vf-input-suffix">%</span>
          </div>
        </label>
      </div>

      <div className="vf-toolbar__actions">
        <button
          type="button"
          className="vf-btn vf-btn--secondary vf-btn--sm"
          disabled={carregando}
          onClick={onRecarregar}
        >
          {carregando ? "Atualizando…" : "Atualizar"}
        </button>
      </div>
    </section>
  );
}
