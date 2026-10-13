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
import { ComparacaoFechamentos } from "./ComparacaoFechamentos.jsx";

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

// Revisões v(n-1) → v(n) para a comparação: a anterior à escolhida (ou, se a
// escolhida é a v1, a v1 → a mais nova).
function parDeComparacao(revisoes, meta) {
  const ordenadas = [...(revisoes || [])].sort((a, b) => a.revisao - b.revisao);
  const i = ordenadas.findIndex((s) => s.id === meta?.id);
  if (ordenadas.length < 2 || i < 0) return null;
  return i > 0 ? [ordenadas[i - 1], ordenadas[i]] : [ordenadas[0], ordenadas[ordenadas.length - 1]];
}

export function SnapshotFechamento({ revisoes, marketplace, periodo, periodoLabel, revisaoPreferida = null }) {
  const resumo = resumoRevisoes(revisoes);
  const inicial = (revisoes || []).some((s) => s.id === revisaoPreferida) ? revisaoPreferida : resumo.ultima?.id ?? null;
  const [escolhida, setEscolhida] = useState(inicial);
  const [detalhe, setDetalhe] = useState(null);
  const [erro, setErro] = useState(null);

  // Nova revisão salva (ou troca de competência): volta para a mais nova.
  // Vindo do Histórico com uma revisão específica, abre nela.
  const ultimaId = resumo.ultima?.id ?? null;
  useEffect(() => {
    setEscolhida((revisoes || []).some((s) => s.id === revisaoPreferida) ? revisaoPreferida : ultimaId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ultimaId, revisaoPreferida]);

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

      {(() => {
        const par = parDeComparacao(revisoes, meta);
        if (!par) return null;
        const [a, b] = par;
        return (
          <details className="vf-fin-disclosure" data-testid="comparar-revisoes">
            <summary>Comparar revisões · {rotuloRevisao(a)} → {rotuloRevisao(b)}</summary>
            <ComparacaoFechamentos anterior={a} atual={b} rotuloAnterior={rotuloRevisao(a)} rotuloAtual={rotuloRevisao(b)} />
          </details>
        );
      })()}

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
