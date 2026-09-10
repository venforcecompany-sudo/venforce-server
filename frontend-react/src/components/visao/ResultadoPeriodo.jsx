// frontend-react/src/components/visao/ResultadoPeriodo.jsx
// Bloco principal — resultado do período. Fonte: Central de Vendas Read API
// (getCentralVendasReadBootstrap → filteredSummary), escopoConta=true (é desta
// operação específica).
//
// Redesign V3 (Direção A): números como "figuras" sem caixa (classes
// .vf-visao-figure*, nunca os cards KPI da Fundação). Linha principal
// (Faturamento / Lucro de contribuição / Margem de contribuição) + régua
// secundária (Ticket / Pedidos válidos / Cancelados / Confiança do
// fechamento). Sem barra financeira, sem custos/despesas, sem gráfico.

import { formatarMoeda } from "../../utils/currency.js";
import { formatarPercentual, pontosParaFracao } from "../../utils/percentage.js";
import { formatarNumero, AUSENTE } from "../../utils/numbers.js";
import { CONFIANCA_FECHAMENTO } from "../../utils/visaoLabels.js";

// Valor monetário com o símbolo "R$" em corpo menor (igual ao canvas), sem
// perder a regra de ausência ("—", nunca "R$ 0,00").
function Cifra({ valor }) {
  const txt = formatarMoeda(valor);
  if (txt === AUSENTE) return AUSENTE;
  const m = txt.match(/^(−?R\$)\s(.+)$/);
  if (!m) return txt;
  return (
    <>
      <span className="vf-visao-figure__cur">{m[1]}</span>
      {m[2]}
    </>
  );
}

export function ResultadoPeriodo({ dados }) {
  const confianca = CONFIANCA_FECHAMENTO[dados.confiancaFechamento] || null;
  // `semCusto`/`semFrete` podem chegar como número (contagem) — `(0 || 0)` é
  // `0`, e `0 && <p>` faz o React imprimir um "0" solto. Coage para booleano.
  const temSemCusto = Boolean(dados.semCusto);
  const temSemFrete = Boolean(dados.semFrete);
  const lcClasse =
    dados.lucroContribuicao < 0
      ? " vf-visao-num--danger"
      : dados.lucroContribuicao > 0
        ? " vf-visao-num--success"
        : "";

  return (
    <div className="vf-stack">
      <div className="vf-visao-figures">
        <div className="vf-visao-figure">
          <span className="vf-visao-figure__label">Faturamento</span>
          <span className="vf-visao-figure__value vf-visao-figure__value--lg">
            <Cifra valor={dados.faturamento} />
          </span>
        </div>
        <div className="vf-visao-figure">
          <span className="vf-visao-figure__label">Lucro de contribuição</span>
          <span className={`vf-visao-figure__value vf-visao-figure__value--lg${lcClasse}`}>
            <Cifra valor={dados.lucroContribuicao} />
          </span>
        </div>
        <div className="vf-visao-figure">
          <span className="vf-visao-figure__label">Margem de contribuição</span>
          <span className="vf-visao-figure__value vf-visao-figure__value--lg">
            {formatarPercentual(pontosParaFracao(dados.margemContribuicaoPercentual))}
          </span>
        </div>
      </div>

      <hr className="vf-divider" />

      <div className="vf-visao-metricrow">
        <div className="vf-visao-figure">
          <span className="vf-visao-figure__label">Ticket médio</span>
          <span className="vf-visao-figure__value">
            <Cifra valor={dados.ticket} />
          </span>
        </div>
        <div className="vf-visao-figure">
          <span className="vf-visao-figure__label">Pedidos válidos</span>
          <span className="vf-visao-figure__value">
            {formatarNumero(dados.pedidosValidos)}
            <span className="vf-visao-figure__sub"> / {formatarNumero(dados.pedidosTotal)}</span>
          </span>
        </div>
        <div className="vf-visao-figure">
          <span className="vf-visao-figure__label">Cancelados</span>
          <span className={`vf-visao-figure__value${dados.cancelados > 0 ? " vf-visao-num--warning" : ""}`}>
            {formatarNumero(dados.cancelados)}
          </span>
        </div>
        <div className="vf-visao-figure">
          <span className="vf-visao-figure__label">Confiança do fechamento</span>
          {confianca ? (
            <span className={`vf-tag is-${confianca.tom}`} style={{ alignSelf: "flex-start" }}>
              {confianca.label}
            </span>
          ) : (
            <span className="vf-visao-figure__value vf-visao-figure__value--sm">{AUSENTE}</span>
          )}
        </div>
      </div>

      {(temSemCusto || temSemFrete) && (
        <p className="vf-field__hint">
          {temSemCusto ? "Itens sem custo cadastrado neste período." : ""}
          {temSemCusto && temSemFrete ? " " : ""}
          {temSemFrete ? "Itens sem frete neste período." : ""}
        </p>
      )}
    </div>
  );
}
