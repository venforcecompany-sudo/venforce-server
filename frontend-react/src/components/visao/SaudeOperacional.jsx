// frontend-react/src/components/visao/SaudeOperacional.jsx
// Bloco "Saúde da operação". Fonte: cliente360Service.getCliente360()
// (escopoConta=false: é do CLIENTE inteiro, não desta conta específica).
//
// Redesign V3 (Direção A): progresso do setup operacional — barra + "X de 6
// etapas concluídas" + a lista das 6 etapas reais (setup.*). Sem pill de
// status, sem "Prontidão N/6", sem "próximo passo / Resolver" (isso vive no
// módulo Cliente 360). Uma linha de sincronização fecha o bloco.
//
// Deliberadamente NÃO repete números financeiros aqui — esses são o bloco
// "Resultado do período" (Central de Vendas, a fonte real e account-aware).

import { formatarDataHora } from "../../utils/dates.js";
import { syncStatusInfo } from "../../utils/visaoLabels.js";

const ITENS_PRONTIDAO = [
  ["temGrant", "Integração conectada"],
  ["temBase", "Base de custo vinculada"],
  ["temDiagnostico", "Diagnóstico inicial"],
  ["temFechamentoMes", "Fechamento do mês"],
  ["temAds", "Ads configurado"],
  ["temFreteHistorico", "Histórico de frete"],
];

const TOTAL = ITENS_PRONTIDAO.length;

function MarcaFeita() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

function MarcaPendente() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
    </svg>
  );
}

export function SaudeOperacional({ dados }) {
  const setup = dados.setup || {};
  const feitas = ITENS_PRONTIDAO.filter(([chave]) => setup[chave] === true).length;
  const pct = `${((feitas / TOTAL) * 100).toFixed(1)}%`;

  const sync = dados.sync || {};
  const quando = sync.ultimaSincronizacao ? formatarDataHora(sync.ultimaSincronizacao) : null;
  // Sem timestamp de sync (status "ausente" ou dado faltando): frase neutra de
  // ausência, nunca o alarme "Nunca sincronizado".
  const syncTexto = quando
    ? `${syncStatusInfo(sync.status).label} · última sync ${quando}`
    : "Sincronização ainda não realizada";

  return (
    <div className="vf-stack">
      <div className="vf-visao-progress">
        <div className="vf-visao-progress__meta">
          <span className="vf-visao-progress__count">{feitas} de {TOTAL} etapas concluídas</span>
          <span className="vf-field__hint">Setup operacional</span>
        </div>
        <div className="vf-progress">
          <div className={`vf-progress__bar${feitas === TOTAL ? " is-success" : ""}`} style={{ width: pct }} />
        </div>
      </div>

      <ul className="vf-visao-steps">
        {ITENS_PRONTIDAO.map(([chave, label]) => {
          const done = setup[chave] === true;
          return (
            <li key={chave} className={`vf-visao-step${done ? " vf-visao-step--done" : " vf-visao-step--todo"}`}>
              <span className="vf-visao-step__mark">{done ? <MarcaFeita /> : <MarcaPendente />}</span>
              {label}
            </li>
          );
        })}
      </ul>

      <p className="vf-field__hint">{syncTexto}</p>
    </div>
  );
}
