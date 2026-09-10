// frontend-react/src/components/financeiro/FechamentoTab.jsx
//
// Status do fechamento do período — leitura vinda de
// server/services/financeiroVisaoService.js — e, desde F4.2, a publicação
// do período EM TELA.
//
// Convergência #3 — GERAR um fechamento (upload + cálculo) passou a
// acontecer AQUI, no <NovoFechamento>: o endpoint POST /fechamentos/financeiro
// já era o mesmo motor dos dois lados; o que faltava era o formulário V3
// mandar `periodo` + `clienteContaId` (que o cabeçalho mostra) e tratar a
// competência declarada + a duplicidade. Backend Readiness pós-Conv.#2 §5.
// O Financeiro legado continua existindo como fallback (link em NovoFechamento),
// só deixou de ser o caminho obrigatório.
//
// Publicar/despublicar agem sobre uma entrega concreta, por `id`, e cada
// entrega carrega o próprio período — nada é inferido.

import { formatarDataHora } from "../../utils/dates.js";
import { entregaDoPeriodo } from "../../hooks/useEntregasFechamento.js";
import { EntregaAcoes } from "./EntregaAcoes.jsx";
import { NovoFechamento } from "./NovoFechamento.jsx";

const STATUS_INFO = {
  publicado: { label: "Publicado", tom: "success" },
  rascunho: { label: "Rascunho", tom: "warning" },
  nao_gerado: { label: "Não gerado", tom: "neutral" },
};

export function FechamentoTab({ resultado, clienteSlug, clienteNome, clienteContaId, marketplace, contaNome, periodo, periodoLabel, entregas, onSalvo }) {
  const dados = resultado.dados;
  const semFechamento = !resultado.disponivel || !dados || dados.status === "nao_gerado";

  // A entrega operável do período em tela. Enquanto a lista carrega, não
  // existe ação — e o status vem do payload de leitura, que já chegou.
  const entrega = entregaDoPeriodo(entregas?.entregas, periodo, clienteContaId);
  const statusAtual = entrega ? (entrega.publicado ? "publicado" : "rascunho") : dados?.status;
  const status = STATUS_INFO[statusAtual] || STATUS_INFO.nao_gerado;

  return (
    <div className="vf-stack">
      <div className="vf-cluster" style={{ justifyContent: "space-between" }}>
        <span className={`vf-status is-${status.tom}`}>{status.label}</span>
        <span className="vf-field__hint">{periodoLabel}</span>
      </div>

      <section className="vf-section vf-section--inset">
        <NovoFechamento
          clienteSlug={clienteSlug}
          clienteNome={clienteNome}
          clienteContaId={clienteContaId}
          marketplace={marketplace}
          contaNome={contaNome}
          periodo={periodo}
          periodoLabel={periodoLabel}
          onSalvo={onSalvo}
        />
      </section>

      {semFechamento && !entrega ? (
        <div className="vf-empty">
          <p className="vf-empty__title">Nenhum fechamento gerado</p>
          <p className="vf-empty__description">
            {resultado.motivo || `${periodoLabel} ainda não tem fechamento processado. Use o formulário acima.`}
          </p>
        </div>
      ) : (
        <>
          <p className="vf-field__hint">
            Gerado em {formatarDataHora(entrega?.created_at || dados?.geradoEm)}
            {entrega?.publicado || dados?.publicadoEm
              ? ` · publicado em ${formatarDataHora(entrega?.published_at || dados?.publicadoEm)}`
              : ""}
          </p>

          {entrega ? (
            <div className="vf-stack vf-stack--sm">
              <EntregaAcoes
                entrega={entrega}
                ocupada={entregas.acaoEmCurso === entrega.id}
                bloqueada={entregas.acaoEmCurso != null && entregas.acaoEmCurso !== entrega.id}
                erro={entregas.erroDeAcao?.id === entrega.id ? entregas.erroDeAcao.mensagem : null}
                onPublicar={entregas.publicar}
                onDespublicar={entregas.despublicar}
              />
              <p className="vf-field__hint">
                Publicar gera um link público sem senha e sem validade. Despublicar revoga o link atual.
              </p>
            </div>
          ) : (
            // Sem `id` não existe ação — e dizer por quê é melhor do que um
            // botão que não faz nada.
            <p className="vf-field__hint">
              {entregas?.carregando
                ? "Carregando as ações desta entrega…"
                : entregas?.erro
                ? `Ações indisponíveis: ${entregas.erro.mensagem}`
                : "Esta entrega não apareceu na lista operacional do cliente."}
            </p>
          )}

          <p className="vf-field__hint">
            Para substituir este fechamento, processe de novo no formulário acima — o backend
            oferece a troca preservando o link público.
          </p>
        </>
      )}
    </div>
  );
}
