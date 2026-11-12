// frontend-react/src/components/financeiro/fechamento/FechamentoAjustes.jsx
//
// "Ajustes do período" — valores adicionais que afetam o resultado deste
// fechamento. Prefixo R$, largura contida, zero confortável (placeholder
// "0,00", campo vazio vale zero no backend). FULL aparece no Mercado Livre
// (da API) e na Shopee (manual); Custos adicionais só no Mercado Livre.
//
// ADS no Mercado Livre (modelo B): o campo já vem com o investimento do
// Mercado Ads da conta na competência (selo "Mercado Ads"). ↻ consulta de
// novo ao vivo. Se a pessoa digitar outro valor, o selo vira "Manual" e a
// legenda oferece voltar ao da API. Sem dado da API, a legenda diz por quê
// e o campo segue manual.
//
// FULL no Mercado Livre: mesmo desenho, com o custo do Full da conta na
// competência lido do faturamento do ML (armazenagem, armazenamento
// prolongado, coleta, retirada; selo "FULL"), logo abaixo do ADS — os dois
// são custos extras vindos da API. O frete das vendas Full não entra — já é
// descontado em cada venda.

import { useId } from "react";
import { formatarMoeda } from "../../../utils/currency.js";

const MOTIVO_INDISPONIVEL = {
  NO_ADS_PERMISSION:
    "A conexão com o Mercado Livre não tem acesso ao Mercado Ads. Reconecte a conta em Clientes e Contas ou digite o valor.",
  NO_ADVERTISER_FOUND:
    "Esta conta não anuncia no Mercado Ads. Se houve investimento por outro canal, digite o valor.",
  NO_TOKEN: "A conta não está conectada ao Mercado Livre. Digite o valor.",
};
const MOTIVO_PADRAO = "O Mercado Livre não respondeu agora. Tente ↻ em alguns minutos ou digite o valor.";

const MOTIVO_FULL_INDISPONIVEL = {
  ML_BILLING_SEM_PERMISSAO:
    "A conexão com o Mercado Livre não tem acesso ao faturamento. Reconecte a conta em Clientes e Contas ou digite o valor.",
  ML_BILLING_LENTO: "O faturamento do Mercado Livre está lento agora. Tente ↻ em alguns minutos ou digite o valor.",
  ML_BILLING_INCOMPLETO: "O Mercado Livre devolveu o faturamento incompleto. Tente ↻ em alguns minutos ou digite o valor.",
  NO_TOKEN: "A conta não está conectada ao Mercado Livre. Digite o valor.",
};
const ROTULO_COMPONENTE_FULL = {
  armazenagem: "Armazenagem",
  armazenamento_prolongado: "Prolongado",
  coleta: "Coleta",
  retirada: "Retirada",
};

function quandoFoiConsultado(dados) {
  if (dados?.fonte === "ao_vivo") return "agora";
  const d = new Date(dados?.consultadoEm);
  if (Number.isNaN(d.getTime())) return null;
  const hora = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === new Date().toDateString()) return `hoje, ${hora}`;
  return `${d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })}, ${hora}`;
}

function LegendaAds({ ads, origem, onUsarAdsDaApi }) {
  if (ads.status === "carregando") {
    return <p className="vf-fin-ajuste__legenda" role="status">Buscando no Mercado Ads…</p>;
  }
  if (ads.status === "indisponivel" || ads.status === "erro") {
    return (
      <p className="vf-fin-ajuste__legenda vf-fin-ajuste__legenda--aviso" role="status">
        {MOTIVO_INDISPONIVEL[ads.codigo] || MOTIVO_PADRAO}
      </p>
    );
  }
  if (ads.status !== "ok") return null;
  if (origem === "manual") {
    return (
      <p className="vf-fin-ajuste__legenda">
        <span className="vf-fin-ajuste__ponto vf-fin-ajuste__ponto--manual" aria-hidden="true" />
        <span>Editado à mão · Mercado Ads: {formatarMoeda(ads.dados.investimentoAds)}</span>
        <button type="button" className="vf-fin-ajuste__link" onClick={onUsarAdsDaApi}>
          Usar o da API
        </button>
      </p>
    );
  }
  const quando = quandoFoiConsultado(ads.dados);
  const roas = Number(ads.dados.roas);
  const partes = [
    quando ? `consultado ${quando}` : null,
    roas > 0 ? `ROAS ${roas.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}` : null,
    `${ads.dados.campanhas} ${ads.dados.campanhas === 1 ? "campanha" : "campanhas"}`,
  ].filter(Boolean);
  return (
    <p className="vf-fin-ajuste__legenda">
      <span className="vf-fin-ajuste__ponto" aria-hidden="true" />
      <span>Mercado Ads · {partes.join(" · ")}</span>
    </p>
  );
}

function LegendaFull({ full, origem, onUsarFullDaApi }) {
  if (full.status === "carregando") {
    return (
      <p className="vf-fin-ajuste__legenda" role="status">
        Buscando no Mercado Livre… pode levar 1 min.
      </p>
    );
  }
  if (full.status === "indisponivel" || full.status === "erro") {
    return (
      <p className="vf-fin-ajuste__legenda vf-fin-ajuste__legenda--aviso" role="status">
        {MOTIVO_FULL_INDISPONIVEL[full.codigo] || MOTIVO_PADRAO}
      </p>
    );
  }
  if (full.status !== "ok") return null;
  if (origem === "manual") {
    return (
      <p className="vf-fin-ajuste__legenda">
        <span className="vf-fin-ajuste__ponto vf-fin-ajuste__ponto--manual" aria-hidden="true" />
        <span>Editado à mão · Mercado Livre: {formatarMoeda(full.dados.custoFull)}</span>
        <button type="button" className="vf-fin-ajuste__link" onClick={onUsarFullDaApi}>
          Usar o da API
        </button>
      </p>
    );
  }
  // Uma linha só, como a do ADS. A composição fica no title (passar o mouse).
  const componentes = (full.dados.componentes || [])
    .filter((c) => Number(c.valor) > 0)
    .map((c) => `${ROTULO_COMPONENTE_FULL[c.grupo] || c.rotulo} ${formatarMoeda(c.valor)}`);
  const quando = quandoFoiConsultado(full.dados);
  const partes = [
    quando ? `consultado ${quando}` : null,
    componentes.length ? null : "sem cobranças no mês",
    full.dados.definitivo ? null : "mês aberto",
  ].filter(Boolean);
  const detalhe = [
    componentes.length ? componentes.join(" · ") : "Sem cobranças do Full no mês.",
    "Armazenagem, coleta e retirada do Full pela data do lançamento; o frete das vendas Full já entra em cada venda.",
    full.dados.definitivo ? null : "O mês ainda está aberto no faturamento do ML.",
  ].filter(Boolean).join("\n");
  return (
    <p className="vf-fin-ajuste__legenda" title={detalhe}>
      <span className="vf-fin-ajuste__ponto" aria-hidden="true" />
      <span>Mercado Livre · {partes.join(" · ")}</span>
    </p>
  );
}

function CampoMoeda({ rotulo, valor, onChange, secundario }) {
  const id = useId();
  return (
    <label className="vf-fin-ajuste" htmlFor={id} data-secundario={secundario ? "true" : undefined}>
      <span className="vf-fin-ajuste__label">{rotulo}</span>
      <span className="vf-fin-ajuste__campo">
        <span className="vf-fin-ajuste__prefixo" aria-hidden="true">R$</span>
        <input
          id={id}
          type="text"
          inputMode="decimal"
          className="vf-input"
          placeholder="0,00"
          value={valor}
          onChange={(e) => onChange(e.target.value)}
        />
      </span>
    </label>
  );
}

// Campo cujo valor vem da API (ADS, FULL): selo de origem, ↻ e legenda.
function CampoDaApi({ rotulo, variante, valor, onChange, estado, origem, origemApi, seloApi, tituloAtualizar, secundario, children }) {
  const id = useId();
  const legendaId = useId();
  const ocupado = estado.status === "carregando" || estado.atualizando;
  const selo = !ocupado && estado.status === "ok" && origem ? origem : null;
  return (
    <div className={`vf-fin-ajuste vf-fin-ajuste--${variante}`} data-secundario={secundario ? "true" : undefined}>
      <label className="vf-fin-ajuste__label" htmlFor={id}>{rotulo}</label>
      <span className={`vf-fin-ajuste__campo vf-fin-ajuste__campo--${variante}`}>
        <span className="vf-fin-ajuste__prefixo" aria-hidden="true">R$</span>
        {selo && (
          <span className={`vf-fin-ajuste__selo vf-fin-ajuste__selo--${selo === origemApi ? "api" : "manual"}`}>
            {selo === origemApi ? seloApi : "Manual"}
          </span>
        )}
        <input
          id={id}
          type="text"
          inputMode="decimal"
          className="vf-input"
          placeholder="0,00"
          value={valor}
          aria-describedby={legendaId}
          aria-busy={ocupado || undefined}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className="vf-fin-ajuste__atualizar"
          onClick={estado.atualizar}
          disabled={ocupado}
          title={tituloAtualizar}
          aria-label={tituloAtualizar}
        >
          <span aria-hidden="true" className={ocupado ? "vf-fin-ajuste__giro" : undefined}>↻</span>
        </button>
      </span>
      <div id={legendaId}>{children}</div>
    </div>
  );
}

function CampoAds({ valor, onChange, ads, origem, onUsarAdsDaApi }) {
  return (
    <CampoDaApi
      rotulo="ADS"
      variante="ads"
      valor={valor}
      onChange={onChange}
      estado={ads}
      origem={origem}
      origemApi="mercado_ads"
      seloApi="Mercado Ads"
      tituloAtualizar="Atualizar do Mercado Ads agora"
    >
      <LegendaAds ads={ads} origem={origem} onUsarAdsDaApi={onUsarAdsDaApi} />
    </CampoDaApi>
  );
}

function CampoFull({ valor, onChange, full, origem, onUsarFullDaApi }) {
  return (
    <CampoDaApi
      rotulo="FULL"
      variante="full"
      valor={valor}
      onChange={onChange}
      estado={full}
      origem={origem}
      origemApi="ml_billing"
      seloApi="FULL"
      tituloAtualizar="Atualizar do faturamento do ML agora"
    >
      <LegendaFull full={full} origem={origem} onUsarFullDaApi={onUsarFullDaApi} />
    </CampoDaApi>
  );
}

export function FechamentoAjustes({ marketplace, ajustes, onAjuste, ads, adsOrigem, onUsarAdsDaApi, full, fullOrigem, onUsarFullDaApi }) {
  const ehMeli = marketplace === "meli";
  const adsDaApi = ehMeli && ads && ads.status !== "inativo";
  const fullDaApi = ehMeli && full && full.status !== "inativo";
  // Shopee ainda não tem API de custos do fulfillment: FULL manual, salvo
  // como o ADS e descontado do resultado final.
  const temFull = ehMeli || marketplace === "shopee";
  return (
    <div className="vf-fin-ajustes">
      <div className="vf-fin-ajustes__grid">
        {adsDaApi ? (
          <CampoAds
            valor={ajustes.ads}
            onChange={(v) => onAjuste("ads", v)}
            ads={ads}
            origem={adsOrigem}
            onUsarAdsDaApi={onUsarAdsDaApi}
          />
        ) : (
          <CampoMoeda rotulo="ADS" valor={ajustes.ads} onChange={(v) => onAjuste("ads", v)} />
        )}
        {temFull &&
          (fullDaApi ? (
            <CampoFull
              valor={ajustes.fullCost}
              onChange={(v) => onAjuste("fullCost", v)}
              full={full}
              origem={fullOrigem}
              onUsarFullDaApi={onUsarFullDaApi}
            />
          ) : (
            <CampoMoeda rotulo="FULL" valor={ajustes.fullCost} onChange={(v) => onAjuste("fullCost", v)} />
          ))}
        <CampoMoeda rotulo="Venforce" valor={ajustes.venforce} onChange={(v) => onAjuste("venforce", v)} />
        <CampoMoeda rotulo="Afiliados" valor={ajustes.affiliates} onChange={(v) => onAjuste("affiliates", v)} />
        {ehMeli && (
          <>
            <CampoMoeda
              rotulo="Custos adicionais"
              valor={ajustes.additionalCosts}
              onChange={(v) => onAjuste("additionalCosts", v)}
              secundario
            />
          </>
        )}
      </div>
    </div>
  );
}
