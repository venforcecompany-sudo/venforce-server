// frontend-react/src/pages/VisaoPage.jsx
//
// Visão operacional V3: "como está ESTA operação agora?" — nasce de
// Cliente+Operação escolhidos no Shell (vf-context), nunca tem seletor próprio
// de contexto (MASTER_SPEC §11.1/§16). Cada bloco vem de uma fonte real já
// auditada (server/services/visaoService.js) e aponta para o módulo que resolve.
//
// Redesign V3 (Direção A — executiva densa):
//   Topo → só eyebrow "Visão" + título + seletor de período.
//   "Resultado do período" → bloco principal, fora da grade.
//   Grade 2×2 → Saúde | Margem  /  Ads | Fechamento.
//   Atividade sai da renderização (o componente segue existindo no repo).
//   Sem status global, sem "pontos de atenção", sem linha Cliente→Operação
//   (o Shell já mostra).

import { useOperacaoAtual } from "../hooks/useVfContext.js";
import { useVisao } from "../hooks/useVisao.js";
import { competenciasRecentes, rotularCompetencia } from "../utils/dates.js";
import { BlocoCard, BlocoIndisponivel, BlocoSkeleton } from "../components/visao/BlocoCard.jsx";
import { SaudeOperacional } from "../components/visao/SaudeOperacional.jsx";
import { ResultadoPeriodo } from "../components/visao/ResultadoPeriodo.jsx";
import { MargemBloco } from "../components/visao/MargemBloco.jsx";
import { AdsBloco } from "../components/visao/AdsBloco.jsx";
import { FechamentoBloco } from "../components/visao/FechamentoBloco.jsx";

const PERIODOS = competenciasRecentes(13);

function Bloco({ envelope, render, ...props }) {
  if (!envelope) return null;
  return (
    <BlocoCard {...props}>
      {envelope.disponivel ? render(envelope.dados) : <BlocoIndisponivel motivo={envelope.motivo} />}
    </BlocoCard>
  );
}

export default function VisaoPage() {
  const { pronta, clienteSlug, clienteContaId } = useOperacaoAtual();
  const { periodo, setPeriodo, dados, carregando, erro } = useVisao({ clienteSlug, clienteContaId, pronta });

  // Contexto incompleto: o Shell (data-vf-scope="account") já esconde
  // `.vf-shell__main` e mostra o próprio banner de estado. Nada a renderizar
  // aqui — duplicar a mensagem seria "informação repetida".
  if (!pronta) return null;

  const qs = `cliente=${encodeURIComponent(clienteSlug)}&conta=${encodeURIComponent(clienteContaId)}`;
  const margemHref = `central-margem.html?cliente=${encodeURIComponent(clienteSlug)}`;
  const adsHref = `anuncios-meli.html?cliente=${encodeURIComponent(clienteSlug)}`;
  const fechamentoHref = `financeiro.html?cliente=${encodeURIComponent(clienteSlug)}`;

  return (
    <div className="vf-page-shell">
      <div className="vf-page-container vf-visao-page">
        <header className="vf-page-header">
          <div className="vf-page-header__main">
            <p className="vf-page-header__eyebrow">Visão</p>
            <h1 className="vf-page-header__title">Como está esta operação</h1>
          </div>
          <div className="vf-page-header__actions">
            <label className="vf-field" style={{ margin: 0 }}>
              <span className="vf-visually-hidden">Período</span>
              <select className="vf-select vf-select--sm" value={periodo} onChange={(e) => setPeriodo(e.target.value)}>
                {PERIODOS.map((c) => (
                  <option key={c} value={c}>{rotularCompetencia(c)}</option>
                ))}
              </select>
            </label>
          </div>
        </header>

        {erro && !dados && (
          <div className="vf-banner is-danger" role="alert">
            <div className="vf-banner__content">
              <p className="vf-banner__title">Não foi possível carregar a Visão</p>
              <p className="vf-banner__description">{erro.mensagem}</p>
            </div>
          </div>
        )}

        {!dados && carregando && (
          <>
            <section className="vf-section vf-visao-bloco vf-visao-principal">
              <BlocoSkeleton linhas={4} />
            </section>
            <div className="vf-visao-grid">
              {Array.from({ length: 4 }).map((_, i) => (
                <section key={i} className="vf-section vf-visao-bloco">
                  <BlocoSkeleton linhas={4} />
                </section>
              ))}
            </div>
          </>
        )}

        {dados && (
          <>
            <Bloco
              envelope={dados.resultado}
              titulo="Resultado do período"
              linkHref={`fechamentos-api.html?${qs}`}
              linkLabel="Ver detalhes"
              className="vf-visao-principal"
              render={(d) => <ResultadoPeriodo dados={d.filteredSummary} />}
            />

            <div className={`vf-visao-grid${carregando ? " is-atualizando" : ""}`}>
              <Bloco
                envelope={dados.saude}
                titulo="Saúde da operação"
                linkHref={`cliente-360-react.html?slug=${encodeURIComponent(clienteSlug)}&competencia=${encodeURIComponent(periodo)}`}
                linkLabel="Ver detalhes"
                render={(d) => <SaudeOperacional dados={d} />}
              />
              <Bloco
                envelope={dados.margem}
                titulo="Margem"
                linkHref={margemHref}
                linkLabel="Ver detalhes"
                render={(d) => <MargemBloco dados={d} revisarHref={margemHref} />}
              />
              <Bloco
                envelope={dados.ads}
                titulo="Ads"
                linkHref={adsHref}
                linkLabel="Ver detalhes"
                render={(d) => <AdsBloco dados={d} conectarHref={adsHref} />}
              />
              <Bloco
                envelope={dados.fechamento}
                titulo="Fechamento"
                linkHref={fechamentoHref}
                linkLabel="Ver detalhes"
                render={(d) => <FechamentoBloco dados={d} periodo={rotularCompetencia(periodo)} />}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
