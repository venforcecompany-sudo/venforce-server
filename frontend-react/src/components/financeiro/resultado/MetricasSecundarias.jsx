// Eventos do período específicos do marketplace (Shopee: cancelados/não
// pagos/devoluções; MELI: fora do LC, ajustes, aguardando financeiro). Nunca
// cards Shopee no MELI. Um bloco único com título, abaixo da composição.
import { metricasSecundarias } from "../../../utils/financeiro/resumoFechamento.js";
import { formatarValor } from "../shared/ValorFinanceiro.jsx";

export function MetricasSecundarias({ summary, marketplace }) {
  const itens = metricasSecundarias(summary, marketplace);
  if (!itens.length) return null;
  return (
    <section className="vf-fin-eventos" aria-label="Eventos do período">
      <h5 className="vf-fin-bloco__titulo">Eventos do período</h5>
      <dl className="vf-fin-eventos__lista">
        {itens.map((m) => (
          <div className="vf-fin-eventos__item" key={m.chave} data-metrica={m.chave}>
            <dt>{m.rotulo}</dt>
            <dd>{formatarValor(m.valor, m.tipo)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
