// frontend-react/src/components/visao/FechamentoBloco.jsx
// Bloco 5 — Fechamento do período. Fonte: entregasClienteService.
// escopoConta=false (entregas_cliente não tem cliente_conta_id).
//
// `dados` pode ser `null` mesmo com `disponivel:true`: significa "nenhum
// fechamento gerado para este período ainda" — estado vazio, não erro.

import { formatarDataHora } from "../../utils/dates.js";

const STATUS_TOM = { publicado: "success", rascunho: "neutral" };

export function FechamentoBloco({ dados, periodo }) {
  if (!dados) {
    // A ação "Ver detalhes →" já vem no cabeçalho do BlocoCard — não repetir aqui.
    return (
      <div className="vf-empty">
        <p className="vf-empty__description">Nenhum fechamento gerado para {periodo} ainda.</p>
      </div>
    );
  }

  const tom = STATUS_TOM[dados.status] || "neutral";

  return (
    <div className="vf-stack">
      <div className="vf-cluster">
        <span className={`vf-status is-${tom}`}>{dados.status === "publicado" ? "Publicado" : "Rascunho"}</span>
        <span className="vf-field__hint">{dados.titulo || dados.periodo}</span>
      </div>
      <p className="vf-field__hint">
        Atualizado em {formatarDataHora(dados.updated_at)}
        {dados.published_at ? ` · publicado em ${formatarDataHora(dados.published_at)}` : ""}
      </p>
    </div>
  );
}
