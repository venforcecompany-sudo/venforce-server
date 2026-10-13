// frontend-react/src/components/financeiro/EntregaAcoes.jsx
//
// F4.2 — as ações de uma entrega de fechamento, num só lugar, para que a
// aba "Relatórios gerados" e a aba "Fechamento" não divirjam sobre o que
// significa publicar.
//
// Publicar e despublicar mudam o que um TERCEIRO enxerga: publicar cria um
// link público sem senha e sem validade (`expires_at` nunca é preenchido
// por este fluxo), despublicar o revoga. Por isso as duas passam por uma
// confirmação em dois tempos que NOMEIA a competência — a maior armadilha
// deste fluxo é publicar o mês errado, e um botão que não diz qual mês vai
// publicar é um convite a isso.
//
// A confirmação é inline, nunca `window.confirm`: um diálogo modal do
// navegador congela a página inteira e não dá para dizer nele de qual
// competência se trata.

import { useEffect, useState } from "react";
import { rotularCompetencia } from "../../utils/dates.js";

export function linkPublico(token) {
  return `${window.location.origin}/relatorio-publico.html?token=${encodeURIComponent(token)}`;
}

// `revisao`: a revisão do fechamento que esta entrega apresenta (vai no
// texto da confirmação — "Publicar Setembro/2026 (v2)?"). `avisos`: o que
// o operador precisa saber antes de publicar (revisão mais nova, cobertura
// baixa) — informam, não bloqueiam.
export function EntregaAcoes({ entrega, ocupada, bloqueada, erro, onPublicar, onDespublicar, revisao = null, avisos = [] }) {
  const [confirmando, setConfirmando] = useState(null); // "publicar" | "despublicar" | null
  const [copiado, setCopiado] = useState(false);

  // Trocou a entrega debaixo do componente (recarga autoritativa, troca de
  // período): nenhuma confirmação pendente sobrevive a isso.
  useEffect(() => {
    setConfirmando(null);
  }, [entrega?.id, entrega?.publicado]);

  useEffect(() => {
    if (!copiado) return undefined;
    const t = setTimeout(() => setCopiado(false), 1600);
    return () => clearTimeout(t);
  }, [copiado]);

  if (!entrega) return null;

  const competencia = rotularCompetencia(entrega.periodo);
  const publicado = !!entrega.publicado;

  async function copiar() {
    try {
      await navigator.clipboard.writeText(linkPublico(entrega.token_publico));
      setCopiado(true);
    } catch {
      /* clipboard indisponível (contexto não seguro) — sem quebrar a tela */
    }
  }

  if (confirmando) {
    const publicar = confirmando === "publicar";
    return (
      <div className="vf-cluster vf-fin-confirm" role="group" aria-label={`Confirmar ${confirmando}`}>
        <span className="vf-field__hint">
          {publicar
            ? `Publicar ${competencia}${revisao ? ` (${revisao})` : ""}? Gera um link público sem senha.`
            : `Despublicar ${competencia}${revisao ? ` (${revisao})` : ""}? O link atual deixa de abrir.`}
        </span>
        {publicar && avisos.length > 0 && (
          <span className="vf-status is-warning" data-testid="avisos-publicacao">{avisos.join(" ")}</span>
        )}
        <button
          type="button"
          className={`vf-btn vf-btn--sm ${publicar ? "vf-btn--primary" : "vf-btn--danger"}`}
          disabled={ocupada}
          onClick={() => {
            setConfirmando(null);
            (publicar ? onPublicar : onDespublicar)(entrega.id);
          }}
        >
          {ocupada ? "Enviando…" : publicar ? "Publicar" : "Despublicar"}
        </button>
        <button type="button" className="vf-btn vf-btn--ghost vf-btn--sm" onClick={() => setConfirmando(null)}>
          Cancelar
        </button>
      </div>
    );
  }

  return (
    <div className="vf-cluster vf-table__actions">
      {publicado && entrega.token_publico && (
        <>
          <a className="vf-btn vf-btn--ghost vf-btn--sm" href={linkPublico(entrega.token_publico)} target="_blank" rel="noreferrer">
            Abrir
          </a>
          <button type="button" className="vf-btn vf-btn--ghost vf-btn--sm" onClick={copiar}>
            {copiado ? "Copiado!" : "Copiar link"}
          </button>
        </>
      )}
      <button
        type="button"
        className={`vf-btn vf-btn--sm ${publicado ? "vf-btn--ghost" : "vf-btn--primary"}`}
        disabled={ocupada || bloqueada}
        aria-busy={ocupada ? "true" : undefined}
        title={bloqueada ? "Outra ação está em andamento." : undefined}
        onClick={() => setConfirmando(publicado ? "despublicar" : "publicar")}
      >
        {ocupada ? "Enviando…" : publicado ? "Despublicar" : "Publicar"}
      </button>
      {erro && (
        <span className="vf-status is-danger" role="alert">
          {erro}
        </span>
      )}
    </div>
  );
}
