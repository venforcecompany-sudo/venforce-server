// frontend-react/src/components/financeiro/entrega/EntregaPainel.jsx
//
// ENTREGA PARA O CLIENTE — o passo depois de Salvar, para a entrega DESTA
// conta na competência em tela:
//
//   Salvar entrega → Editar apresentação → Salvar alterações → Publicar →
//   Copiar/Abrir link
//
// Identidade (cliente, marketplace, conta, competência) é só LEITURA: vem do
// Shell e a entrega pertence a esse contexto. Não há "Gerar link" paralelo ao
// "Salvar" (os dois caminhos concorrentes do legado): publicar é sempre sobre
// a entrega salva, por `id`.
//
// Entrega que já teve link é histórica (ENTREGA_PUBLICADA_IMUTAVEL no
// backend): a apresentação fica em leitura. Publicar com edição não salva é
// bloqueado — o link nasceria sem o que está na tela.

import { useEffect } from "react";
import { formatarDataHora } from "../../../utils/dates.js";
import { useEntregaApresentacao } from "../../../hooks/useEntregaApresentacao.js";
import { EntregaAcoes } from "../EntregaAcoes.jsx";
import { MK_LABEL } from "../fechamento/FechamentoContextoBar.jsx";
import { EntregaEditor } from "./EntregaEditor.jsx";
import { avisosDePublicacao, resumoRevisoes, revisaoDaEntrega, rotuloRevisao } from "../../../utils/financeiro/revisoes.js";
import { COBERTURA_MINIMA_ESPERADA } from "../../../utils/financeiro/preCheck.js";

export function EntregaPainel({ entrega, entregas, clienteNome, marketplace, contaNome, clienteContaId, periodo, periodoLabel, onAlterado, revisoes = null, snapshots = null }) {
  const historica = !!entrega?.token_publico;
  const apresentacao = useEntregaApresentacao({
    entregaId: entrega?.id ?? null,
    imutavel: historica,
    identidade: { cliente: clienteNome || null, periodo: periodo || null },
  });

  const alterado = !!entrega && apresentacao.alterado;
  useEffect(() => {
    onAlterado?.(alterado);
  }, [onAlterado, alterado]);

  if (!entrega) {
    if (entregas?.carregando && !entregas?.entregas) {
      return <p className="vf-field__hint">Carregando a entrega desta competência…</p>;
    }
    if (entregas?.erro) {
      return <p className="vf-field__hint">Entrega indisponível: {entregas.erro.mensagem}</p>;
    }
    return null;
  }

  const status = entrega.publicado ? "Publicado" : historica ? "Despublicado" : "Rascunho";
  // Qual REVISÃO financeira esta entrega apresenta (e se já existe uma mais nova).
  const revisao = revisaoDaEntrega(snapshots, entrega.id);
  const ultima = resumoRevisoes(revisoes).ultima;
  const haMaisNova = !!revisao && !!ultima && ultima.revisao > revisao.revisao;

  return (
    <section className="vf-section vf-section--inset vf-stack" aria-label="Entrega para o cliente">
      <div className="vf-cluster vf-cluster--between">
        <h3 className="vf-fin-novo__passo-titulo">Entrega para o cliente</h3>
        <span className={`vf-tag is-${entrega.publicado ? "success" : "neutral"}`}>{status}</span>
      </div>
      <dl className="vf-fin-contexto vf-fin-contexto--compacto" data-testid="identidade-entrega">
        <div className="vf-fin-contexto__item"><dt>Cliente</dt><dd>{clienteNome || "—"}</dd></div>
        <div className="vf-fin-contexto__item"><dt>Marketplace</dt><dd>{MK_LABEL[marketplace] || marketplace || "—"}</dd></div>
        <div className="vf-fin-contexto__item"><dt>Conta</dt><dd>{contaNome || (clienteContaId ? `Operação #${clienteContaId}` : "—")}</dd></div>
        <div className="vf-fin-contexto__item"><dt>Competência</dt><dd>{periodoLabel}</dd></div>
        <div className="vf-fin-contexto__item">
          <dt>Revisão</dt>
          <dd data-testid="revisao-entrega">{revisao ? rotuloRevisao(revisao) : Array.isArray(snapshots) ? "anterior às revisões" : "—"}</dd>
        </div>
      </dl>
      {haMaisNova && (
        <p className="vf-field__hint" data-aviso="revisao-mais-nova">
          Esta entrega apresenta a {rotuloRevisao(revisao)}; a {rotuloRevisao(ultima)} é mais nova.
          {historica ? " O link do cliente continua na revisão que ele recebeu." : " A entrega não muda sozinha: continua apresentando a revisão dela até ser trocada."}
        </p>
      )}
      <p className="vf-field__hint">
        Salva em {formatarDataHora(entrega.created_at)}
        {entrega.publicado ? ` · publicada em ${formatarDataHora(entrega.published_at)}` : ""}
      </p>

      <details className="vf-fin-disclosure" open={!historica || undefined}>
        <summary>Apresentação para o cliente</summary>
        {apresentacao.carregando ? (
          <p className="vf-field__hint">Carregando a apresentação…</p>
        ) : (
          <div className="vf-stack vf-stack--sm">
            {historica && (
              <p className="vf-field__hint">
                Esta entrega já teve link público: o conteúdo é histórico e não pode ser alterado. Para mudar a apresentação,
                salve um novo fechamento desta competência.
              </p>
            )}
            <EntregaEditor conteudo={apresentacao.conteudo} onChange={apresentacao.setConteudo} somenteLeitura={historica} />
            {!historica && (
              <div className="vf-cluster">
                <button
                  type="button"
                  className="vf-btn vf-btn--primary vf-btn--sm"
                  disabled={!apresentacao.alterado || apresentacao.salvando}
                  aria-busy={apresentacao.salvando ? "true" : undefined}
                  onClick={apresentacao.salvar}
                >
                  {apresentacao.salvando ? "Salvando…" : apresentacao.alterado ? "Salvar alterações" : "Rascunho salvo"}
                </button>
                {apresentacao.alterado && (
                  <button type="button" className="vf-btn vf-btn--ghost vf-btn--sm" disabled={apresentacao.salvando} onClick={apresentacao.descartar}>
                    Descartar alterações
                  </button>
                )}
                {apresentacao.salvoAgora && !apresentacao.alterado && <span className="vf-status is-success" role="status">Apresentação salva.</span>}
              </div>
            )}
            {apresentacao.erro && <span className="vf-status is-danger" role="alert">{apresentacao.erro.mensagem}</span>}
          </div>
        )}
      </details>

      <div className="vf-stack vf-stack--sm">
        <EntregaAcoes
          entrega={entrega}
          ocupada={entregas.acaoEmCurso === entrega.id}
          bloqueada={alterado || (entregas.acaoEmCurso != null && entregas.acaoEmCurso !== entrega.id)}
          erro={entregas.erroDeAcao?.id === entrega.id ? entregas.erroDeAcao.mensagem : null}
          onPublicar={entregas.publicar}
          onDespublicar={entregas.despublicar}
          revisao={revisao ? rotuloRevisao(revisao) : null}
          avisos={avisosDePublicacao({ revisao, ultima, coberturaMinima: COBERTURA_MINIMA_ESPERADA })}
        />
        <p className="vf-field__hint">
          {alterado
            ? "Salve as alterações da apresentação antes de publicar."
            : "Publicar gera um link público sem senha e sem validade. Despublicar revoga o link atual — e o conteúdo continua histórico."}
        </p>
      </div>
    </section>
  );
}
