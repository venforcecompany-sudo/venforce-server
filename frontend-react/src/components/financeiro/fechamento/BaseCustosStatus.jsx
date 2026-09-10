// frontend-react/src/components/financeiro/fechamento/BaseCustosStatus.jsx
//
// O estado da BASE DE CUSTOS da operação — o que responde, sem o usuário
// precisar pensar, a pergunta "preciso subir planilha de custos?".
//
// Estados (espelham server/services/bases/baseCustosService):
//   carregando  → "Verificando base vinculada…"
//   encontrada  → ✓ usa a base, upload não é necessário (+ override discreto)
//   ausente     → ⚠ sem base: o upload de custos vira obrigatório
//   ambigua     → ⚠ mais de uma conta possível; bloqueia até resolver
//   erro        → não deu para verificar; não vira "suba qualquer arquivo"
//
// NÃO mostra um dropzone gigante de custos aqui. Quando o upload é preciso,
// quem o renderiza é o passo "Arquivos", com o próprio card.

import { cx } from "../../../utils/cx.js";

const MK_LABEL = { meli: "Mercado Livre", shopee: "Shopee" };

export function BaseCustosStatus({ base, marketplace, clienteNome, usarUploadDeCustos, onAlternarUpload }) {
  const { status } = base;
  const canal = MK_LABEL[marketplace] || marketplace;

  if (status === "carregando" || status === "inativo") {
    return (
      <div className="vf-fin-base is-carregando">
        <span className="vf-spinner vf-spinner--sm" aria-hidden="true" />
        <span className="vf-fin-base__texto">Verificando base vinculada…</span>
      </div>
    );
  }

  if (status === "encontrada") {
    return (
      <div className={cx("vf-fin-base", "is-encontrada", usarUploadDeCustos && "is-override")}>
        <div className="vf-fin-base__principal">
          <span className="vf-fin-base__marca" aria-hidden="true">✓</span>
          <div className="vf-fin-base__corpo">
            <p className="vf-fin-base__titulo">
              {usarUploadDeCustos ? "Base vinculada disponível" : "Base vinculada"}
            </p>
            <p className="vf-fin-base__detalhe">
              <strong>{base.base?.nome || "Base de custos"}</strong>
              {clienteNome ? ` · ${clienteNome} — ${canal}` : ` · ${canal}`}
            </p>
            <p className="vf-fin-base__nota">
              {usarUploadDeCustos
                ? "Você optou por enviar outra planilha de custos abaixo."
                : "Os custos serão carregados automaticamente. Nenhum upload necessário."}
            </p>
          </div>
        </div>
        <button
          type="button"
          className="vf-btn vf-btn--ghost vf-btn--sm"
          onClick={() => onAlternarUpload(!usarUploadDeCustos)}
        >
          {usarUploadDeCustos ? "Voltar a usar a base vinculada" : "Usar outra planilha de custos"}
        </button>
      </div>
    );
  }

  if (status === "ambigua") {
    return (
      <div className="vf-fin-base is-ambigua">
        <span className="vf-fin-base__marca" aria-hidden="true">⚠</span>
        <div className="vf-fin-base__corpo">
          <p className="vf-fin-base__titulo">Mais de uma conta possível</p>
          <p className="vf-fin-base__nota">
            Existem bases de {canal} para {base.contas?.map((c) => c.nome).join(" e ") || "contas diferentes"}.
            Resolva a operação na barra de contexto para o fechamento saber qual base usar.
          </p>
        </div>
      </div>
    );
  }

  if (status === "erro") {
    return (
      <div className="vf-fin-base is-erro">
        <span className="vf-fin-base__marca" aria-hidden="true">⚠</span>
        <div className="vf-fin-base__corpo">
          <p className="vf-fin-base__titulo">Não foi possível verificar a base</p>
          <p className="vf-fin-base__nota">
            {base.erro || "Tente de novo em instantes."} Enquanto isso o processamento fica bloqueado —
            não vamos assumir que basta enviar um arquivo qualquer.
          </p>
        </div>
      </div>
    );
  }

  // ausente
  return (
    <div className="vf-fin-base is-ausente">
      <span className="vf-fin-base__marca" aria-hidden="true">⚠</span>
      <div className="vf-fin-base__corpo">
        <p className="vf-fin-base__titulo">Nenhuma base vinculada para esta operação</p>
        <p className="vf-fin-base__nota">
          O fechamento vai usar a planilha de custos que você enviar abaixo.
        </p>
      </div>
    </div>
  );
}
