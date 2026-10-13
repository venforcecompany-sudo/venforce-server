// frontend-react/src/components/financeiro/snapshot/SnapshotFechamento.jsx
//
// O FECHAMENTO SALVO de uma competência, por revisão. Os MESMOS componentes
// do resultado ao vivo (KPIs, leitura, reconciliação, composição, cobertura)
// leem o snapshot — a diferença é a faixa de estado ("Revisão v2 · salva em
// …"), que nunca deixa o histórico parecer um processamento novo.
//
// Somente leitura: corrigir custo é sobre o processamento atual (acima). Os
// produtos são TODAS as linhas da revisão, paginadas no backend.

import { useEffect, useState } from "react";
import { buscarSnapshot } from "../../../services/fechamentoSnapshotApi.js";
import { processamentoDoSnapshot, resumoRevisoes, rotuloRevisao } from "../../../utils/financeiro/revisoes.js";
import { ResultadoProcessado } from "../resultado/ResultadoProcessado.jsx";
import { SecaoFinanceira } from "../shared/SecaoFinanceira.jsx";
import { ProdutosSnapshot } from "./ProdutosSnapshot.jsx";

function PendenciasDaRevisao({ snapshot }) {
  const c = snapshot?.contagens || {};
  const pend = c.pendencias ?? 0;
  return (
    <SecaoFinanceira id="pendencias" titulo="Pendências desta revisão" className="vf-fin-secao--compacta">
      {pend > 0 ? (
        <p className="vf-field__hint" data-pendencias={pend}>
          Quando foi salva, esta revisão tinha <strong>{pend} {pend === 1 ? "produto pendente" : "produtos pendentes"} de custo</strong> ({c.linhasPendentes ?? pend}{" "}
          {(c.linhasPendentes ?? pend) === 1 ? "linha" : "linhas"}). Veja quais em Produtos (filtro “Sem custo” / “Custo ambíguo”). Para corrigir, processe de novo
          acima — a correção vira uma revisão nova.
        </p>
      ) : (
        <p className="vf-field__hint" data-pendencias="0">Sem pendências de custo quando esta revisão foi salva.</p>
      )}
    </SecaoFinanceira>
  );
}

export function SnapshotFechamento({ revisoes, marketplace, periodo, periodoLabel }) {
  const resumo = resumoRevisoes(revisoes);
  const [escolhida, setEscolhida] = useState(resumo.ultima?.id ?? null);
  const [detalhe, setDetalhe] = useState(null);
  const [erro, setErro] = useState(null);

  // Nova revisão salva (ou troca de competência): volta para a mais nova.
  const ultimaId = resumo.ultima?.id ?? null;
  useEffect(() => {
    setEscolhida(ultimaId);
  }, [ultimaId]);

  const meta = (revisoes || []).find((s) => s.id === escolhida) || resumo.ultima;

  useEffect(() => {
    if (!meta?.id) return undefined;
    const controlador = new AbortController();
    setDetalhe(null);
    setErro(null);
    buscarSnapshot(meta.id, { signal: controlador.signal })
      .then((r) => setDetalhe(r?.snapshot || null))
      .catch((err) => {
        if (err?.name === "AbortError") return;
        setErro(err?.message || "Não foi possível abrir esta revisão.");
      });
    return () => controlador.abort();
  }, [meta?.id]);

  if (!meta) return null;
  const snapshot = detalhe && detalhe.id === meta.id ? { ...meta, ...detalhe } : null;

  return (
    <div className="vf-stack vf-stack--sm" data-snapshot={meta.id}>
      <div className="vf-cluster vf-cluster--between">
        <h3 className="vf-fin-novo__passo-titulo">Fechamento salvo de {periodoLabel}</h3>
        {revisoes.length > 1 && (
          <div className="vf-segmented vf-fin-revisoes" role="group" aria-label="Revisões desta competência">
            {revisoes.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`vf-segmented__item${s.id === meta.id ? " is-active" : ""}`}
                aria-pressed={s.id === meta.id}
                onClick={() => setEscolhida(s.id)}
              >
                {rotuloRevisao(s)}
                {s.publicado ? " · publicada" : ""}
              </button>
            ))}
          </div>
        )}
      </div>

      {erro && <div className="vf-status is-danger" role="alert">{erro}</div>}
      {!snapshot && !erro && (
        <div className="vf-stack vf-stack--sm" aria-busy="true">
          <div className="vf-skeleton vf-skeleton--title" />
          <div className="vf-skeleton vf-skeleton--row" />
        </div>
      )}
      {snapshot && (
        <>
          <ResultadoProcessado
            processamento={processamentoDoSnapshot(snapshot)}
            marketplace={marketplace}
            periodo={periodo}
            linhas={[]}
            estado={{ tipo: "revisao", snapshot, publicada: resumo.publicada }}
            pendencias={<PendenciasDaRevisao snapshot={snapshot} />}
          />
          <ProdutosSnapshot snapshot={snapshot} />
        </>
      )}
    </div>
  );
}
