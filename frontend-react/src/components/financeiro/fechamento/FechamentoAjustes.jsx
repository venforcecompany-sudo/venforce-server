// frontend-react/src/components/financeiro/fechamento/FechamentoAjustes.jsx
//
// "Ajustes do período" — valores adicionais que afetam o resultado deste
// fechamento. Prefixo R$, largura contida, zero confortável (placeholder
// "0,00", campo vazio vale zero no backend). FULL e Custos adicionais só
// aparecem no Mercado Livre.

import { useId } from "react";

function CampoMoeda({ rotulo, valor, onChange, secundario }) {
  const id = useId();
  return (
    <label className="vf-fin-ajuste" htmlFor={id} data-secundario={secundario ? "true" : undefined}>
      <span className="vf-fin-ajuste__label">{rotulo}</span>
      <span className="vf-fin-ajuste__campo">
        <span className="vf-fin-ajuste__prefixo" aria-hidden="true">R$</span>
        <input
          id={id}
          type="text"
          inputMode="decimal"
          className="vf-input"
          placeholder="0,00"
          value={valor}
          onChange={(e) => onChange(e.target.value)}
        />
      </span>
    </label>
  );
}

export function FechamentoAjustes({ marketplace, ajustes, onAjuste }) {
  const ehMeli = marketplace === "meli";
  return (
    <div className="vf-fin-ajustes">
      <div className="vf-fin-ajustes__grid">
        <CampoMoeda rotulo="ADS" valor={ajustes.ads} onChange={(v) => onAjuste("ads", v)} />
        <CampoMoeda rotulo="Venforce" valor={ajustes.venforce} onChange={(v) => onAjuste("venforce", v)} />
        <CampoMoeda rotulo="Afiliados" valor={ajustes.affiliates} onChange={(v) => onAjuste("affiliates", v)} />
        {ehMeli && (
          <>
            <CampoMoeda rotulo="FULL" valor={ajustes.fullCost} onChange={(v) => onAjuste("fullCost", v)} secundario />
            <CampoMoeda
              rotulo="Custos adicionais"
              valor={ajustes.additionalCosts}
              onChange={(v) => onAjuste("additionalCosts", v)}
              secundario
            />
          </>
        )}
      </div>
    </div>
  );
}
