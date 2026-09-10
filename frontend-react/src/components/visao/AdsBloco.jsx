// frontend-react/src/components/visao/AdsBloco.jsx
// Bloco "Ads" (mlAdsService). Só Mercado Livre; escopoConta=true.
//
// Dois estados, conforme o canvas (Direção A):
//   - sem Ads conectado: o backend NÃO lança — devolve `{semDados:true, codigo,
//     motivo}` dentro de um bloco `disponivel:true`. A UI mostra "Ads não
//     conectado" + o que fica indisponível + CTA "Conectar Ads".
//   - com Ads: leitura horizontal igual à Margem, na ordem
//     ROAS · ACOS · GMV Ads · Investimento. Nunca "ROI".

import { formatarMoeda } from "../../utils/currency.js";
import { formatarPercentual, pontosParaFracao } from "../../utils/percentage.js";
import { formatarNumero, ehAusente, AUSENTE } from "../../utils/numbers.js";

function Cifra({ valor }) {
  const txt = formatarMoeda(valor);
  if (txt === AUSENTE) return AUSENTE;
  const m = txt.match(/^(−?R\$)\s(.+)$/);
  if (!m) return txt;
  return (
    <>
      <span className="vf-visao-figure__cur">{m[1]}</span>
      {m[2]}
    </>
  );
}

export function AdsBloco({ dados, conectarHref }) {
  if (dados.semDados) {
    return (
      <div className="vf-stack">
        <span className="vf-status is-neutral">Ads não conectado</span>
        <p className="vf-field__hint">ACOS, ROAS e GMV Ads indisponíveis.</p>
        {conectarHref && (
          <a className="vf-btn vf-btn--sm" href={conectarHref} style={{ alignSelf: "flex-start" }}>
            Conectar Ads
          </a>
        )}
      </div>
    );
  }

  const roas = ehAusente(dados.roas) ? AUSENTE : `${formatarNumero(dados.roas, 1)}x`;

  // Uma única régua horizontal, na mesma estrutura do card de Margem: a figura
  // líder (ROAS) primeiro, maior e em cor primária; as demais no corpo base.
  return (
    <div className="vf-stack">
      <div className="vf-visao-metricrow">
        <div className="vf-visao-figure">
          <span className="vf-visao-figure__label">ROAS</span>
          <span className="vf-visao-figure__value vf-visao-figure__value--lg vf-visao-num--primary">{roas}</span>
        </div>
        <div className="vf-visao-figure">
          <span className="vf-visao-figure__label">ACOS</span>
          <span className="vf-visao-figure__value">{formatarPercentual(pontosParaFracao(dados.acos))}</span>
        </div>
        <div className="vf-visao-figure">
          <span className="vf-visao-figure__label">GMV Ads</span>
          <span className="vf-visao-figure__value"><Cifra valor={dados.gmvAds} /></span>
        </div>
        <div className="vf-visao-figure">
          <span className="vf-visao-figure__label">Investimento</span>
          <span className="vf-visao-figure__value vf-visao-num--warning"><Cifra valor={dados.investimentoAds} /></span>
        </div>
      </div>
      {dados.avisos?.length > 0 && <p className="vf-field__hint">{dados.avisos[0]}</p>}
    </div>
  );
}
