// frontend-react/src/components/visao/MargemBloco.jsx
// Bloco "Margem" (Motor de Margem). Só Mercado Livre; escopoConta=false
// (o motor ainda resolve base por cliente, não por conta — ver
// visaoService.js). Foco em qualidade de item, não em total financeiro
// (isso é o bloco Resultado).
//
// Redesign V3 (Direção A): régua horizontal de figuras + barra "itens com
// margem / itens analisados" + CTA "Revisar" quando há itens sem margem.

import { formatarPercentual, pontosParaFracao } from "../../utils/percentage.js";
import { formatarNumero } from "../../utils/numbers.js";

export function MargemBloco({ dados, revisarHref }) {
  const placar = dados.placar || {};
  const cobertura = dados.cobertura || {};

  const comMargem = Number(placar.itensComMargem) || 0;
  const semMargem = Number(placar.itensSemMargem) || 0;
  // itensAnalisados = com margem + sem margem (contrato do motorMargemService).
  // Preferimos o campo explícito da cobertura e caímos na soma se faltar.
  const analisados = Number(cobertura.itensAnalisados) || comMargem + semMargem;
  const temBarra = analisados > 0;
  const pctComMargem = temBarra
    ? `${Math.min(100, (comMargem / analisados) * 100).toFixed(1)}%`
    : "0%";

  return (
    <div className="vf-stack">
      <div className="vf-visao-metricrow">
        <div className="vf-visao-figure">
          <span className="vf-visao-figure__label">Margem média</span>
          <span className="vf-visao-figure__value vf-visao-figure__value--lg vf-visao-num--primary">
            {formatarPercentual(pontosParaFracao(placar.margemMediaPercent))}
          </span>
        </div>
        <div className="vf-visao-figure">
          <span className="vf-visao-figure__label">Itens com margem</span>
          <span className="vf-visao-figure__value">{formatarNumero(placar.itensComMargem)}</span>
        </div>
        <div className="vf-visao-figure">
          <span className="vf-visao-figure__label">Itens sem margem</span>
          <span className={`vf-visao-figure__value${semMargem > 0 ? " vf-visao-num--warning" : ""}`}>
            {formatarNumero(placar.itensSemMargem)}
          </span>
        </div>
      </div>

      {temBarra && (
        <div className="vf-visao-cobertura">
          <div className="vf-progress">
            <div className="vf-progress__bar is-success" style={{ width: pctComMargem }} />
          </div>
          <div className="vf-visao-cobertura__meta">
            <span className="vf-field__hint"><b>{formatarNumero(comMargem)}</b> com margem</span>
            <span className="vf-field__hint">de {formatarNumero(analisados)} itens analisados</span>
          </div>
        </div>
      )}

      {semMargem > 0 && (
        <div className="vf-cluster vf-cluster--between">
          <span className="vf-field__hint">
            {formatarNumero(semMargem)} {semMargem === 1 ? "item sem margem precisa" : "itens sem margem precisam"} de revisão.
          </span>
          {revisarHref && (
            <a className="vf-btn vf-btn--ghost vf-btn--sm" href={revisarHref}>
              Revisar →
            </a>
          )}
        </div>
      )}
    </div>
  );
}
