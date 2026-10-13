// frontend-react/src/components/financeiro/snapshot/ApresentarRevisao.jsx
//
// "Apresentar esta revisão na entrega" — a entrega (apresentação) passa a
// mostrar uma revisão JÁ SALVA, sem reprocessar. Fecha o caminho
// "salvei a v2 e cancelei o Substituir" / "quero publicar a v2" sem voltar
// às planilhas.
//
// O payload é montado do SNAPSHOT (summary gravado + as 50 primeiras linhas
// como amostra do relatório público) — o backend confere que os números são
// os da revisão (409 SNAPSHOT_DIVERGENTE se não forem). Sempre com
// substituir: rascunho é trocado no lugar; entrega que já teve link ganha
// uma entrega NOVA (o link do cliente segue na revisão que ele recebeu).
// A apresentação já escrita (destaques/prioridades) é levada junto.

import { useState } from "react";
import { listarItensDoSnapshot } from "../../../services/fechamentoSnapshotApi.js";
import { buscarEntrega } from "../../../services/entregasApi.js";
import { salvarEntregaFechamento } from "../../../services/financeiroFechamentoApi.js";
import { montarPayloadFechamento } from "../../../utils/fechamentoPayload.js";
import { avisosDePublicacao, processamentoDoSnapshot, rotuloRevisao } from "../../../utils/financeiro/revisoes.js";
import { COBERTURA_MINIMA_ESPERADA } from "../../../utils/financeiro/preCheck.js";

export function ApresentarRevisao({ snapshot, entregaAtual, revisaoDaEntregaAtual, contexto, onApresentado }) {
  const [fase, setFase] = useState("parado"); // parado | confirmando | enviando | feito
  const [erro, setErro] = useState(null);
  if (!snapshot || !contexto?.clienteContaId) return null;
  const jaApresenta = !!entregaAtual && revisaoDaEntregaAtual?.id === snapshot.id;
  if (jaApresenta) return null;

  const v = rotuloRevisao(snapshot);
  const comLink = !!entregaAtual?.token_publico;
  const acao = !entregaAtual ? `Criar a entrega com a ${v}` : comLink ? `Criar nova entrega com a ${v}` : `Trocar a entrega para a ${v}`;
  const explicacao = !entregaAtual
    ? `Esta competência ainda não tem entrega. A entrega nova apresenta a ${v}.`
    : comLink
      ? `A entrega com link (${revisaoDaEntregaAtual ? rotuloRevisao(revisaoDaEntregaAtual) : "anterior às revisões"}) não muda — o cliente segue vendo o que recebeu. Uma entrega nova (rascunho) passa a apresentar a ${v}; publique-a quando estiver pronta.`
      : `O rascunho desta competência (${revisaoDaEntregaAtual ? rotuloRevisao(revisaoDaEntregaAtual) : "anterior às revisões"}) passa a apresentar a ${v}. A apresentação já escrita é mantida.`;
  const avisos = avisosDePublicacao({ revisao: snapshot, coberturaMinima: COBERTURA_MINIMA_ESPERADA });

  async function apresentar() {
    setFase("enviando");
    setErro(null);
    try {
      const amostra = await listarItensDoSnapshot(snapshot.id, { offset: 0, limit: 50 });
      const processamento = { ...processamentoDoSnapshot(snapshot), detailedRows: (amostra?.itens || []).map((i) => i.linha) };
      const ajustes = Object.fromEntries(Object.entries(snapshot.ajustes || {}).map(([k, val]) => [k, val == null ? "" : String(val)]));
      const payload = montarPayloadFechamento({
        processamento, clienteSlug: contexto.clienteSlug, clienteNome: contexto.clienteNome, periodo: snapshot.periodo,
        marketplace: snapshot.marketplace, ajustes, snapshot, totalLinhas: snapshot.totalItens ?? null,
      });
      if (entregaAtual?.id) {
        try {
          const existente = await buscarEntrega(entregaAtual.id);
          const apresentacao = existente?.entrega?.payload_json?.entrega;
          if (apresentacao && typeof apresentacao === "object") payload.entrega = apresentacao;
        } catch {
          /* sem a apresentação anterior, segue sem ela */
        }
      }
      await salvarEntregaFechamento({
        tipo: "fechamento_mensal",
        titulo: payload.titulo,
        periodo: snapshot.periodo,
        cliente_slug: contexto.clienteSlug,
        cliente_conta_id: contexto.clienteContaId,
        status: "rascunho",
        payload_json: payload,
        origem_tipo: "fechamento_financeiro",
        snapshot_id: snapshot.id,
        substituir: true,
      });
      setFase("feito");
      onApresentado?.();
    } catch (err) {
      setErro(err?.message || "Não foi possível montar a entrega desta revisão.");
      setFase("confirmando");
    }
  }

  if (fase === "feito") return <span className="vf-status is-success" role="status">Entrega gravada com a {v}. Publique em “Entrega para o cliente”.</span>;

  return (
    <div className="vf-stack vf-stack--sm vf-fin-apresentar" data-testid="apresentar-revisao">
      {fase === "parado" ? (
        <div className="vf-cluster">
          <button type="button" className="vf-btn vf-btn--secondary vf-btn--sm" onClick={() => setFase("confirmando")}>{acao}</button>
          <span className="vf-field__hint">{entregaAtual ? `A entrega desta competência apresenta ${revisaoDaEntregaAtual ? `a ${rotuloRevisao(revisaoDaEntregaAtual)}` : "um fechamento anterior às revisões"}.` : "Sem entrega nesta competência."}</span>
        </div>
      ) : (
        <div className="vf-stack vf-stack--sm" role="group" aria-label={`Confirmar: ${acao}`}>
          <p className="vf-field__hint">{explicacao}</p>
          {avisos.length > 0 && <span className="vf-status is-warning">{avisos.join(" ")}</span>}
          <div className="vf-cluster">
            <button type="button" className="vf-btn vf-btn--primary vf-btn--sm" disabled={fase === "enviando"} aria-busy={fase === "enviando" ? "true" : undefined} onClick={apresentar}>
              {fase === "enviando" ? "Gravando…" : "Confirmar"}
            </button>
            <button type="button" className="vf-btn vf-btn--ghost vf-btn--sm" disabled={fase === "enviando"} onClick={() => setFase("parado")}>Cancelar</button>
          </div>
          {erro && <span className="vf-status is-danger" role="alert">{erro}</span>}
        </div>
      )}
    </div>
  );
}
