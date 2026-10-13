// frontend-react/src/components/financeiro/fechamento/AcoesFechamento.jsx
//
// O que fazer com o fechamento processado: salvar, reprocessar ou voltar
// para os arquivos/ajustes. Fica DEPOIS da leitura (resultado, pendências,
// composição) e ANTES dos produtos: quem decide salvar já viu o que está
// salvando. Duplicidade (409) mora aqui porque é uma decisão sobre salvar.
//
// Salvar grava uma REVISÃO nova (v1, v2, …) — a anterior nunca some — e a
// entrega desta competência passa a apresentá-la. Com entrega já publicada,
// a revisão nova vira uma entrega nova (rascunho): o link do cliente segue na
// revisão que ele recebeu até você publicar a nova.

import { useEffect, useState } from "react";
import { rotuloRevisao } from "../../../utils/financeiro/revisoes.js";
import { COBERTURA_MINIMA_ESPERADA } from "../../../utils/financeiro/preCheck.js";
import { numOuNull } from "../../../utils/financeiro/resumoFechamento.js";
import { formatarPercentual, pontosParaFracao } from "../../../utils/percentage.js";

export function AcoesFechamento({ f, periodoLabel, legado, proximaRevisao = null, revisaoPublicada = null }) {
  const salvando = f.estado === "salvando";
  const salvo = f.estado === "salvo";
  const reprocessando = f.estado === "processando";
  const revisaoSalva = f.snapshotSalvo || null;
  // Cobertura abaixo do esperado: salvar pede uma confirmação (não bloqueia).
  const cobertura = numOuNull(f.processamento?.summary?.calculatedCoveragePercent);
  const coberturaBaixa = cobertura !== null && cobertura < COBERTURA_MINIMA_ESPERADA;
  const [confirmouCobertura, setConfirmouCobertura] = useState(false);
  useEffect(() => setConfirmouCobertura(false), [f.processamento]);
  const rotuloSalvar = revisaoSalva ? `Salvar entrega da ${rotuloRevisao(revisaoSalva)}` : proximaRevisao ? `Salvar revisão v${proximaRevisao}` : "Salvar fechamento";

  return (
    <div className="vf-stack">
      {/* ── Duplicidade (409) ─────────────────────────────────────────── */}
      {f.duplicidade && (
        <div className={`vf-banner ${f.duplicidade.publicado ? "is-danger" : "is-warning"}`} role="alert">
          <div className="vf-banner__content">
            <p className="vf-banner__title">
              {f.duplicidade.publicado
                ? `${periodoLabel} já tem um fechamento PUBLICADO para esta operação`
                : `${periodoLabel} já tem um fechamento salvo para esta operação`}
            </p>
            <p className="vf-banner__description">
              {revisaoSalva ? (
                <>
                  A <strong>revisão {rotuloRevisao(revisaoSalva)}</strong> já está salva no histórico (cancelar não a apaga). Falta decidir a entrega.{" "}
                </>
              ) : null}
              {f.duplicidade.publicado
                ? `Substituir cria uma entrega nova com a ${revisaoSalva ? rotuloRevisao(revisaoSalva) : "revisão nova"}. O link que já está com o cliente continua abrindo ${revisaoPublicada ? `a ${rotuloRevisao(revisaoPublicada)}` : "o fechamento antigo"}; a entrega nova ganha um link próprio quando for publicada.`
                : `Substituir faz a entrega (rascunho) desta competência apresentar a ${revisaoSalva ? rotuloRevisao(revisaoSalva) : "revisão nova"}. As revisões anteriores continuam no histórico.`}
            </p>
            <div className="vf-cluster">
              <button type="button" className="vf-btn vf-btn--danger vf-btn--sm" disabled={salvando} onClick={f.substituir}>
                {salvando ? "Substituindo…" : "Substituir"}
              </button>
              <button type="button" className="vf-btn vf-btn--ghost vf-btn--sm" onClick={f.resetar}>
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {salvo ? (
        <div className="vf-cluster">
          <span className="vf-status is-success" role="status">
            {revisaoSalva ? `Revisão ${rotuloRevisao(revisaoSalva)} salva e entrega gravada.` : "Entrega salva."} Edite a apresentação e publique em “Entrega para o cliente”, logo abaixo.
          </span>
          <button type="button" className="vf-btn vf-btn--ghost vf-btn--sm" onClick={f.resetar}>
            Processar outro
          </button>
        </div>
      ) : !f.duplicidade ? (
        <div className="vf-stack vf-stack--sm">
        {coberturaBaixa && !revisaoSalva && (
          <label className="vf-fin-confirmacao-cobertura" data-testid="confirmar-cobertura">
            <input type="checkbox" checked={confirmouCobertura} onChange={(e) => setConfirmouCobertura(e.target.checked)} />
            <span className="vf-field__hint">
              Cobertura de custo de <strong>{formatarPercentual(pontosParaFracao(cobertura))}</strong>, abaixo dos {COBERTURA_MINIMA_ESPERADA}% esperados.
              Salvar mesmo assim (as pendências ficam registradas na revisão).
            </span>
          </label>
        )}
        <div className="vf-cluster vf-fin-acoes">
          <button
            type="button"
            className="vf-btn vf-btn--primary"
            disabled={salvando || reprocessando || (f.divergente && !f.confirmouDivergencia) || (coberturaBaixa && !revisaoSalva && !confirmouCobertura)}
            aria-busy={salvando ? "true" : undefined}
            onClick={() => f.salvar()}
          >
            {salvando ? "Salvando…" : rotuloSalvar}
          </button>
          <button type="button" className="vf-btn vf-btn--secondary vf-btn--sm" disabled={salvando || reprocessando} onClick={f.reprocessar}>
            {reprocessando ? "Reprocessando…" : "Reprocessar fechamento"}
          </button>
          <button type="button" className="vf-btn vf-btn--ghost vf-btn--sm" disabled={salvando} onClick={f.voltarAoFormulario}>
            Editar arquivos e ajustes
          </button>
        </div>
        </div>
      ) : null}

      <p className="vf-field__hint">
        Reprocessar pelo motor antigo continua possível no <a href={legado}>Financeiro (legado) →</a>
      </p>
    </div>
  );
}
