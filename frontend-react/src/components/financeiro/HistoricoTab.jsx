// frontend-react/src/components/financeiro/HistoricoTab.jsx
//
// HISTÓRICO — a SEQUÊNCIA de competências desta operação, mês a mês,
// inclusive os meses sem fechamento. É o que distingue esta aba de
// "Relatórios gerados" (que lista os artefatos e age sobre eles): aqui se
// vê o buraco ("Setembro sem fechamento") e se pula para o mês com um clique.
//
// Nenhuma escrita aqui de propósito: publicar/excluir têm UM lugar
// (Relatórios gerados / Fechamento). Escolher um mês passa pela mesma troca
// de competência da página — com confirmação se houver trabalho em andamento.
//
// O status do mês é o DESTA conta; entrega legada (sem operação registrada)
// é sinalizada, nunca contada como fechamento da conta.
//
// Com REVISÕES (snapshots), cada mês diz também: a revisão mais nova, qual
// está publicada, os números dela (Resultado, MC, cobertura) e, aberto, a
// lista de revisões (abrir qualquer uma) e a comparação com o mês anterior.
// Sem revisões o mês segue como antes (fechamentos anteriores a elas).

import { useState } from "react";
import { competenciaAnterior, competenciaNoFuso, ehCompetencia, rotularCompetencia, formatarDataHora } from "../../utils/dates.js";
import { kpisPrincipais } from "../../utils/financeiro/resumoFechamento.js";
import { resumoRevisoes, revisoesDoPeriodo, rotuloRevisao } from "../../utils/financeiro/revisoes.js";
import { METRICAS_COMPETENCIA, formatarValorDaMetrica } from "../../utils/financeiro/comparacao.js";
import { ComparacaoFechamentos } from "./snapshot/ComparacaoFechamentos.jsx";
import { normalizarCompetencia } from "../../utils/financeiro/competencia.js";
import { escopoDaEntrega, entregaDoPeriodo, entregaLegadaDoPeriodo, entregasDoPeriodo } from "../../hooks/useEntregasFechamento.js";
import { statusDaCompetencia } from "../../utils/financeiro/statusCompetencia.js";
import { BlocoIndisponivel, BlocoSkeleton } from "../visao/BlocoCard.jsx";

const MESES = 12;

// O bloco de leitura de GET /financeiro (`relatorios`) vira o mesmo formato
// das entregas para o modo degradado.
function daLeitura(dados) {
  return (dados || []).map((r) => ({
    id: r.id,
    periodo: r.periodo,
    cliente_conta_id: r.clienteContaId ?? null,
    publicado: !!r.publicado,
    token_publico: r.token || null,
    created_at: r.geradoEm || null,
  }));
}

function sequencia(fim, quantidade) {
  const lista = [];
  let cursor = fim;
  for (let i = 0; i < quantidade; i++) {
    lista.push(cursor);
    cursor = competenciaAnterior(cursor);
  }
  return lista;
}

// Os números de uma revisão numa linha: Resultado · MC · Cobertura.
function NumerosDaRevisao({ snapshot }) {
  const s = snapshot?.summary || {};
  const k = Object.fromEntries(kpisPrincipais(s).map((i) => [i.chave, i.valor]));
  return (
    <span className="vf-fin-historico__numeros">
      Resultado {formatarValorDaMetrica(k.finalResult, "moeda")} · MC {formatarValorDaMetrica(k.mcCalculada, "fracao")} · Cobertura{" "}
      {formatarValorDaMetrica(s.calculatedCoveragePercent, "pontos")}
    </span>
  );
}

// Revisões do mês + comparação com o mês anterior — só monta ao abrir.
function DetalheDoMes({ mes, revisoes, anterior, mesAnterior, onAbrir }) {
  const [aberto, setAberto] = useState(false);
  const r = resumoRevisoes(revisoes);
  return (
    <details className="vf-fin-disclosure vf-fin-historico__detalhe" onToggle={(e) => setAberto(e.currentTarget.open)}>
      <summary>
        {r.total} {r.total === 1 ? "revisão" : "revisões"}
        {anterior ? ` · comparar com ${rotularCompetencia(mesAnterior)}` : ""}
      </summary>
      {aberto && (
        <div className="vf-stack vf-stack--sm">
          <div className="vf-table-wrap">
            <table className="vf-table vf-table--compact" aria-label={`Revisões de ${rotularCompetencia(mes)}`}>
              <thead>
                <tr><th>Revisão</th><th>Salva em</th><th>Números</th><th>Status</th><th></th></tr>
              </thead>
              <tbody>
                {revisoes.map((s) => (
                  <tr key={s.id} data-revisao={s.revisao}>
                    <td><strong>{rotuloRevisao(s)}</strong></td>
                    <td>{formatarDataHora(s.criadoEm)}{s.criadoPorEmail ? ` · ${s.criadoPorEmail}` : ""}</td>
                    <td><NumerosDaRevisao snapshot={s} /></td>
                    <td>{s.publicado ? <span className="vf-tag is-success">Publicada</span> : <span className="vf-field__hint">—</span>}</td>
                    <td>
                      <button type="button" className="vf-btn vf-btn--ghost vf-btn--sm" onClick={() => onAbrir?.(mes, s.id)}>
                        Abrir {rotuloRevisao(s)}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {anterior && (
            <ComparacaoFechamentos
              anterior={anterior}
              atual={r.ultima}
              rotuloAnterior={`${rotularCompetencia(mesAnterior)} (${rotuloRevisao(anterior)})`}
              rotuloAtual={`${rotularCompetencia(mes)} (${rotuloRevisao(r.ultima)})`}
              metricas={METRICAS_COMPETENCIA}
              comFrases
            />
          )}
        </div>
      )}
    </details>
  );
}

export function HistoricoTab({ relatorios, entregas, periodo, clienteContaId, onEscolherCompetencia, snapshots = null }) {
  if (relatorios && !relatorios.disponivel && !Array.isArray(entregas?.entregas)) return <BlocoIndisponivel motivo={relatorios.motivo} />;
  if (entregas.carregando && !entregas.entregas) return <BlocoSkeleton linhas={6} />;

  const lista = Array.isArray(entregas.entregas) ? entregas.entregas : daLeitura(relatorios?.dados);
  const daConta = lista.filter((e) => escopoDaEntrega(e, clienteContaId) === "esta_conta");

  // A régua termina no mês mais recente entre hoje, a competência em tela e o
  // último fechamento desta conta — nada de mês futuro inventado.
  const candidatos = [competenciaNoFuso(), periodo, ...daConta.map((e) => normalizarCompetencia(e.periodo))].filter(ehCompetencia);
  const fim = candidatos.sort().slice(-1)[0];
  const meses = sequencia(fim, MESES);
  const semConta = lista.filter((e) => escopoDaEntrega(e, clienteContaId) === "legado" && !normalizarCompetencia(e.periodo));

  return (
    <div className="vf-stack vf-stack--sm">
      {!Array.isArray(entregas.entregas) && (
        <p className="vf-field__hint">Lista operacional indisponível — histórico montado a partir da leitura do Financeiro.</p>
      )}
      <ul className="vf-fin-historico" aria-label="Competências desta operação">
        {meses.map((m, i) => {
          const revisoes = revisoesDoPeriodo(snapshots?.snapshots, m);
          const rev = resumoRevisoes(revisoes);
          // Mês anterior com revisão (a régua vai do mais novo ao mais antigo).
          const mesAnterior = meses[i + 1] || competenciaAnterior(m);
          const anterior = resumoRevisoes(revisoesDoPeriodo(snapshots?.snapshots, mesAnterior)).ultima;
          const entrega = entregaDoPeriodo(lista, m, clienteContaId);
          const legada = entregaLegadaDoPeriodo(lista, m);
          const status = statusDaCompetencia({ entrega, entregaLegada: legada });
          const daContaNoMes = entregasDoPeriodo(lista, m).filter((e) => escopoDaEntrega(e, clienteContaId) === "esta_conta").length;
          const emTela = m === periodo;
          return (
            <li key={m} className={`vf-fin-historico__item${emTela ? " is-destacada" : ""}`} data-competencia={m}>
              <span className={`vf-fin-historico__dot is-${status.tom === "success" ? "success" : "neutral"}`} aria-hidden="true">
                {entrega ? "●" : "○"}
              </span>
              <button type="button" className="vf-fin-historico__periodo vf-btn vf-btn--ghost vf-btn--sm" disabled={emTela} onClick={() => onEscolherCompetencia?.(m)}>
                {rotularCompetencia(m)}
              </button>
              <span className="vf-field__hint">
                {status.label}
                {entrega?.published_at && entrega.publicado ? ` · ${formatarDataHora(entrega.published_at)}` : ""}
                {daContaNoMes > 1 ? ` · ${daContaNoMes} fechamentos gravados` : ""}
                {status.legado ? " · existe fechamento legado (sem conta)" : ""}
              </span>
              {emTela && <span className="vf-tag">em tela</span>}
              {rev.ultima && (
                <div className="vf-fin-historico__revisoes" data-revisoes={rev.total}>
                  <span>
                    <strong>{rotuloRevisao(rev.ultima)}</strong>
                    {rev.publicada
                      ? rev.publicada.id === rev.ultima.id
                        ? " · publicada"
                        : ` · publicado ${rotuloRevisao(rev.publicada)}`
                      : " · não publicada"}
                    {rev.publicada && rev.novaNaoPublicada ? ` · ${rotuloRevisao(rev.ultima)} mais nova` : ""}
                  </span>
                  <NumerosDaRevisao snapshot={rev.ultima} />
                  <DetalheDoMes mes={m} revisoes={revisoes} anterior={anterior} mesAnterior={mesAnterior} onAbrir={onEscolherCompetencia} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {semConta.length > 0 && (
        <p className="vf-field__hint">
          {semConta.length} {semConta.length === 1 ? "entrega legada sem competência reconhecível" : "entregas legadas sem competência reconhecível"} — veja em Relatórios gerados.
        </p>
      )}
    </div>
  );
}
