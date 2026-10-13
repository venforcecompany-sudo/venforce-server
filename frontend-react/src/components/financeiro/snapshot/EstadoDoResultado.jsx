// frontend-react/src/components/financeiro/snapshot/EstadoDoResultado.jsx
//
// A faixa que diz DE QUANDO são os números na tela — o fim da confusão
// "isto acabou de ser processado ou é o que foi salvo?":
//
//   Processamento atual · ainda não salvo     (resultado em memória)
//   Processamento atual · salvo como v2       (acabou de virar revisão)
//   Revisão v2 · salva em 13/10 14:30 · Publicado: v1   (histórico)
//
// Mesma faixa nos dois lugares (resultado ao vivo e fechamento salvo), para
// a diferença ser a palavra, não o layout.

import { formatarDataHora } from "../../../utils/dates.js";
import { rotuloRevisao } from "../../../utils/financeiro/revisoes.js";

export function EstadoDoResultado({ estado }) {
  if (!estado) return null;

  if (estado.tipo === "atual") {
    const salvo = estado.salvo;
    return (
      <div className={`vf-fin-estado ${salvo ? "is-salvo" : "is-atual"}`} role="status" data-estado={salvo ? "atual-salvo" : "atual-nao-salvo"}>
        <span className={`vf-tag is-${salvo ? "success" : "warning"}`}>Processamento atual</span>
        {salvo ? (
          <span>
            Salvo como <strong>revisão {rotuloRevisao(salvo)}</strong> em {formatarDataHora(salvo.criadoEm)} — estes números agora são histórico.
          </span>
        ) : (
          <span>
            <strong>Ainda não salvo.</strong> Estes números ainda não são histórico.
            {estado.proximaRevisao ? ` Salvar cria a revisão v${estado.proximaRevisao}.` : ""}
          </span>
        )}
      </div>
    );
  }

  const s = estado.snapshot;
  const publicada = estado.publicada;
  return (
    <div className="vf-fin-estado is-revisao" role="status" data-estado="revisao" data-revisao={s?.revisao}>
      <span className="vf-tag is-info">Revisão {rotuloRevisao(s)}</span>
      <span>
        Salva em {formatarDataHora(s?.criadoEm)}
        {s?.criadoPorEmail ? ` por ${s.criadoPorEmail}` : ""} · processada em {formatarDataHora(s?.processadoEm)}. É o histórico gravado,
        não um processamento novo.
      </span>
      {s?.publicado ? (
        <span className="vf-tag is-success">Publicada</span>
      ) : publicada ? (
        <span className="vf-tag is-neutral">Publicado: {rotuloRevisao(publicada)}</span>
      ) : (
        <span className="vf-tag is-neutral">Não publicada</span>
      )}
    </div>
  );
}
