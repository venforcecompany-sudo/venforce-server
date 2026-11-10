// frontend-react/src/components/financeiro/ConciliacaoTab.jsx
// Conciliação com Mercado Pago — centralVendasMp3ReadService, só MELI,
// account-aware. Mesmo vocabulário de status já usado em resultadoConciliadoMp.

import { formatarMoeda } from "../../utils/currency.js";
import { formatarPercentual } from "../../utils/percentage.js";
import { formatarNumero } from "../../utils/numbers.js";
import { BlocoIndisponivel } from "../visao/BlocoCard.jsx";

const STATUS_INFO = {
  complete: { label: "Completa", tom: "success" },
  partial: { label: "Parcial", tom: "warning" },
  pending: { label: "Pendente", tom: "warning" },
  divergent: { label: "Divergente", tom: "danger" },
  not_available: { label: "Indisponível", tom: "neutral" },
};

export function ConciliacaoTab({ conciliacao }) {
  if (!conciliacao.disponivel) {
    return <BlocoIndisponivel motivo={conciliacao.motivo} />;
  }

  const { mpReconciliationStatus, summary } = conciliacao.dados || {};
  const status = STATUS_INFO[mpReconciliationStatus] || STATUS_INFO.not_available;

  return (
    <div className="vf-stack">
      <span className={`vf-status is-${status.tom}`}>Conciliação {status.label.toLowerCase()}</span>

      <div className="vf-kpi-grid">
        <div className="vf-kpi">
          <span className="vf-kpi__label">Pedidos conciliados</span>
          <span className="vf-kpi__value">
            {formatarNumero((summary?.ordersMatchedClean || 0) + (summary?.ordersMatchedWithEvents || 0))}
            <span className="vf-field__hint"> / {formatarNumero(summary?.ordersTotal)}</span>
          </span>
        </div>
        <div className="vf-kpi">
          <span className="vf-kpi__label">Cobertura</span>
          <span className="vf-kpi__value">{formatarPercentual((summary?.coveragePercent ?? null) / 100)}</span>
        </div>
        <div className={summary?.ordersDivergent > 0 ? "vf-kpi vf-kpi--danger" : "vf-kpi"}>
          <span className="vf-kpi__label">Divergentes</span>
          <span className="vf-kpi__value">{formatarNumero(summary?.ordersDivergent)}</span>
        </div>
        <div className={summary?.paymentsSettlementPending > 0 ? "vf-kpi vf-kpi--warning" : "vf-kpi"}>
          <span className="vf-kpi__label">Settlement pendente</span>
          <span className="vf-kpi__value">{formatarNumero(summary?.paymentsSettlementPending)}</span>
        </div>
        <div className="vf-kpi">
          <span className="vf-kpi__label">Valor líquido recebido</span>
          <span className="vf-kpi__value vf-kpi__value--currency">{formatarMoeda(summary?.totalPaymentNet)}</span>
        </div>
      </div>

      <p className="vf-field__hint">
        <a href="painel-contas.html">Ver sincronização no Painel de Contas →</a>
      </p>
    </div>
  );
}
