// frontend-react/src/components/financeiro/snapshot/ComparacaoFechamentos.jsx
//
// Comparação objetiva entre dois fechamentos salvos — duas revisões da mesma
// competência (v1 → v2) ou duas competências (Setembro × Outubro). Tabela
// compacta + frases determinísticas (utils/financeiro/comparacao.js). Sem IA,
// sem fórmula nova: diferença entre números que o motor já calculou.

import { compararSnapshots, formatarDelta, formatarValorDaMetrica, frasesDaComparacao, METRICAS_REVISAO } from "../../../utils/financeiro/comparacao.js";

const TOM = { melhora: "is-success", piora: "is-danger", neutro: "", igual: "", sem_dado: "" };

export function ComparacaoFechamentos({ anterior, atual, rotuloAnterior, rotuloAtual, metricas = METRICAS_REVISAO, comFrases = false }) {
  if (!anterior || !atual) return null;
  const linhas = compararSnapshots(anterior, atual, metricas);
  const frases = comFrases ? frasesDaComparacao(linhas) : [];
  return (
    <div className="vf-stack vf-stack--sm vf-fin-comparacao" data-comparacao={`${rotuloAnterior}→${rotuloAtual}`}>
      {frases.length > 0 && (
        <ul className="vf-fin-comparacao__frases">
          {frases.map((f) => <li key={f}>{f}</li>)}
        </ul>
      )}
      <div className="vf-table-wrap">
        <table className="vf-table vf-table--compact" aria-label={`Comparação ${rotuloAnterior} → ${rotuloAtual}`}>
          <thead>
            <tr>
              <th>Métrica</th>
              <th className="is-numeric">{rotuloAnterior}</th>
              <th className="is-numeric">{rotuloAtual}</th>
              <th className="is-numeric">Diferença</th>
            </tr>
          </thead>
          <tbody>
            {linhas.map((l) => (
              <tr key={l.chave} data-metrica={l.chave} data-tom={l.tom}>
                <td>{l.rotulo}</td>
                <td className="is-numeric">{formatarValorDaMetrica(l.de, l.tipo)}</td>
                <td className="is-numeric">{formatarValorDaMetrica(l.para, l.tipo)}</td>
                <td className={`is-numeric vf-fin-comparacao__delta ${TOM[l.tom] || ""}`.trim()}>{formatarDelta(l)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
