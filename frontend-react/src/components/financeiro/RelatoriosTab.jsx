// frontend-react/src/components/financeiro/RelatoriosTab.jsx
//
// RELATÓRIOS GERADOS — as entregas (artefatos que podem ser abertos,
// publicados e enviados) DESTA operação, mais as entregas legadas sem
// operação registrada. Cada linha responde de cara: de qual mês, de qual
// marketplace e conta, em que modo, com que cobertura, se está publicada e
// quando foi gerada.
//
// Account-aware: a lista vem filtrada por `cliente_conta_id` (+ legadas) e
// cada linha é rotulada pelo escopo — uma entrega da Conta 1 nunca aparece
// como se fosse da Conta 2, e uma legada nunca é atribuída à conta em tela.
//
// Ações por `id`: Abrir, Copiar link, Publicar/Despublicar (EntregaAcoes) e
// Excluir (DELETE /entregas-cliente/:id, com confirmação).
//
// Modo degradado: se a lista operacional falhar, a tabela continua a partir
// do bloco `relatorios` de GET /financeiro, em leitura, dizendo por quê.

import { formatarDataHora, rotularCompetencia } from "../../utils/dates.js";
import { mesmaCompetencia } from "../../utils/financeiro/competencia.js";
import { descreverEntrega } from "../../utils/financeiro/relatorios.js";
import { formatarValor } from "./shared/ValorFinanceiro.jsx";
import { BlocoIndisponivel, BlocoSkeleton } from "../visao/BlocoCard.jsx";
import { EntregaAcoes, linkPublico } from "./EntregaAcoes.jsx";
import { ExcluirEntrega } from "./relatorios/ExcluirEntrega.jsx";
import { avisosDePublicacao, resumoRevisoes, revisaoDaEntrega, revisoesDoPeriodo, rotuloRevisao } from "../../utils/financeiro/revisoes.js";
import { COBERTURA_MINIMA_ESPERADA } from "../../utils/financeiro/preCheck.js";

function Vazio() {
  return (
    <div className="vf-empty">
      <p className="vf-empty__description">Nenhum relatório gerado para esta operação ainda.</p>
    </div>
  );
}

function TabelaSomenteLeitura({ lista, motivo, onTentarDeNovo, clienteContaId }) {
  return (
    <div className="vf-stack">
      <div className="vf-banner is-warning" role="status">
        <div className="vf-banner__content">
          <p className="vf-banner__title">Ações indisponíveis no momento</p>
          <p className="vf-banner__description">{motivo}</p>
        </div>
        <div className="vf-banner__actions">
          <button type="button" className="vf-btn vf-btn--sm" onClick={onTentarDeNovo}>
            Tentar novamente
          </button>
        </div>
      </div>
      <div className="vf-table-wrap">
        <table className="vf-table vf-table--compact">
          <thead>
            <tr><th>Competência</th><th>Operação</th><th>Status</th><th>Gerado em</th><th></th></tr>
          </thead>
          <tbody>
            {lista.map((r, i) => (
              <tr key={`${r.id ?? r.periodo}-${i}`}>
                <td>{rotularCompetencia(r.periodo)}</td>
                <td>{r.clienteContaId == null ? "Legado · operação não registrada" : Number(r.clienteContaId) === Number(clienteContaId) ? "Esta conta" : `Outra conta (#${r.clienteContaId})`}</td>
                <td>{r.publicado ? "Publicado" : "Rascunho"}</td>
                <td>{formatarDataHora(r.geradoEm)}</td>
                <td className="vf-table__actions">
                  {r.publicado && r.token ? (
                    <a className="vf-btn vf-btn--ghost vf-btn--sm" href={linkPublico(r.token)} target="_blank" rel="noreferrer">
                      Abrir
                    </a>
                  ) : (
                    <span className="vf-field__hint">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function RelatoriosTab({ relatorios, entregas, periodo, clienteContaId, marketplace, contaNome, contaRotuloExterno, snapshots = null }) {
  if (relatorios && !relatorios.disponivel) return <BlocoIndisponivel motivo={relatorios.motivo} />;
  const leitura = relatorios?.dados || [];

  if (entregas.carregando && !entregas.entregas) return <BlocoSkeleton linhas={4} />;

  if (!Array.isArray(entregas.entregas)) {
    if (!leitura.length) return <Vazio />;
    return (
      <TabelaSomenteLeitura
        lista={leitura}
        clienteContaId={clienteContaId}
        motivo={entregas.erro?.mensagem || "A lista operacional de entregas não está disponível."}
        onTentarDeNovo={entregas.recarregar}
      />
    );
  }

  const lista = entregas.entregas;
  if (!lista.length) return <Vazio />;
  const ctx = { clienteContaId, marketplace, contaNome, contaRotuloExterno };

  return (
    <div className={`vf-stack vf-stack--sm${entregas.carregando ? " is-atualizando" : ""}`}>
      <p className="vf-field__hint">
        Entregas desta operação e as legadas do cliente (salvas antes de a operação ser registrada), identificadas por linha.
      </p>
      <div className="vf-table-wrap vf-table-scroll">
        <table className="vf-table vf-table--compact vf-fin-relatorios">
          <thead>
            <tr>
              <th>Competência</th>
              <th>Operação</th>
              <th>Modo</th>
              <th className="is-numeric">Cobertura custo</th>
              <th>Status</th>
              <th>Gerado em</th>
              <th>Publicado em</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {lista.map((e) => {
              const d = descreverEntrega(e, ctx);
              const doPeriodoEmTela = mesmaCompetencia(e.periodo, periodo);
              const ocupada = entregas.acaoEmCurso === e.id;
              const bloqueada = entregas.acaoEmCurso != null && entregas.acaoEmCurso !== e.id;
              // A revisão financeira que esta entrega apresenta (entregas antigas não têm).
              const revisao = revisaoDaEntrega(snapshots, e.id);
              return (
                <tr key={e.id} className={doPeriodoEmTela ? "is-destacada" : undefined} data-escopo={d.escopo} data-entrega={e.id}>
                  <td>
                    <strong>{d.competenciaLabel}</strong>
                    {d.periodoBruto && <span className="vf-field__hint"> ({d.periodoBruto})</span>}
                    {revisao && <span className="vf-tag is-info" style={{ marginLeft: 8 }} data-revisao={revisao.revisao} title="Revisão do fechamento que esta entrega apresenta">{rotuloRevisao(revisao)}</span>}
                    {doPeriodoEmTela && <span className="vf-tag" style={{ marginLeft: 8 }}>em tela</span>}
                  </td>
                  <td>
                    <span className={d.escopo === "esta_conta" ? undefined : "vf-field__hint"}>{d.operacao}</span>
                  </td>
                  <td>{d.modo || "—"}</td>
                  <td className="is-numeric">{formatarValor(d.cobertura, "pontos")}</td>
                  <td>
                    <span className={`vf-status is-${d.status.tom}`}>{d.status.label}</span>
                  </td>
                  <td>{formatarDataHora(d.geradoEm)}</td>
                  {/* Ausência é ausência: um rascunho nunca teve published_at. */}
                  <td>{d.publicadoEm ? formatarDataHora(d.publicadoEm) : "—"}</td>
                  <td>
                    <div className="vf-cluster vf-fin-relatorios__acoes">
                      <EntregaAcoes
                        entrega={e}
                        ocupada={ocupada}
                        bloqueada={bloqueada}
                        erro={entregas.erroDeAcao?.id === e.id ? entregas.erroDeAcao.mensagem : null}
                        onPublicar={entregas.publicar}
                        onDespublicar={entregas.despublicar}
                        revisao={revisao ? rotuloRevisao(revisao) : null}
                        avisos={avisosDePublicacao({ revisao, ultima: resumoRevisoes(revisoesDoPeriodo(snapshots, e.periodo)).ultima, coberturaMinima: COBERTURA_MINIMA_ESPERADA })}
                      />
                      <ExcluirEntrega descricao={d} publicado={!!e.publicado} ocupada={ocupada} bloqueada={bloqueada} onExcluir={entregas.excluir} />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
