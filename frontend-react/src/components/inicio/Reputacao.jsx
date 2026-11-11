// frontend-react/src/components/inicio/Reputacao.jsx
// Saúde da conta (termômetro + MercadoLíder + as três métricas oficiais do
// ML) e o progresso até o próximo nível do MercadoLíder — porte dos blocos do
// Início do Lucratto. A reputação é lida do ML na hora (GET /users/{id});
// vendas e faturamento da janela do MercadoLíder saem da Central de Vendas.

import { BlocoIndisponivel } from "../visao/BlocoCard.jsx";
import { horario, num, reais } from "./formato.js";

export const NIVEL = {
  "1_red": { rotulo: "Vermelho", tom: "critico" },
  "2_orange": { rotulo: "Laranja", tom: "critico" },
  "3_yellow": { rotulo: "Amarelo", tom: "atencao" },
  "4_light_green": { rotulo: "Verde-claro", tom: "neutro" },
  "5_green": { rotulo: "Verde", tom: null },
};
const NIVEIS = Object.keys(NIVEL);
const LIDER = { silver: "MercadoLíder", gold: "MercadoLíder Gold", platinum: "MercadoLíder Platinum" };

// A reputação mexe nas casas decimais (0,13%), então vão duas.
const taxa = (n) => `${Number(n).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
const diaMes = (dia) => `${dia.slice(8, 10)}/${dia.slice(5, 7)}`;

function Termometro({ nivel }) {
  return (
    <div className="vf-inicio-termometro" role="img" aria-label={`Termômetro ${NIVEL[nivel].rotulo.toLowerCase()}, nível ${nivel[0]} de 5.`}>
      {NIVEIS.map((n, i) => (
        <i key={n} className={`vf-inicio-termometro--${i + 1}${n === nivel ? " is-atual" : ""}`} />
      ))}
    </div>
  );
}

function Metrica({ rotulo, m, vendas }) {
  return (
    <li>
      <span>{rotulo}</span>
      <b className="vf-inicio-num">{m.taxaPct === null ? "—" : taxa(m.taxaPct)}</b>
      <small className="vf-inicio-num">
        {m.quantidade === null ? "sem dado do ML" : vendas === null ? `${m.quantidade}` : `${m.quantidade} de ${vendas.toLocaleString("pt-BR")}`}
      </small>
    </li>
  );
}

function Topo({ id, titulo, sub, children }) {
  return (
    <div className="vf-inicio-bloco__topo">
      <h2 id={id}>{titulo}{sub && <small>{sub}</small>}</h2>
      {children}
    </div>
  );
}

export function SaudeConta({ envelope, vendasHref }) {
  const d = envelope?.disponivel ? envelope.dados : null;
  return (
    <section className="vf-inicio-bloco" aria-labelledby="inicio-conta">
      <Topo id="inicio-conta" titulo="Saúde da conta" sub={d?.periodoDias ? `últimos ${d.periodoDias} dias` : null} />
      {!d && <BlocoIndisponivel motivo={envelope?.motivo} />}
      {d && (
        <>
          {d.nivel ? (
            <div className="vf-inicio-conta__cabeca">
              <Termometro nivel={d.nivel} />
              <p>
                <strong>Termômetro {NIVEL[d.nivel].rotulo.toLowerCase()}</strong>
                {d.mercadoLider && <span className="vf-tag">{LIDER[d.mercadoLider]}</span>}
              </p>
            </div>
          ) : (
            <p className="vf-field__hint">A conta ainda não tem termômetro: o Mercado Livre o calcula depois das primeiras vendas.</p>
          )}
          <ul className="vf-inicio-conta__metricas">
            <Metrica rotulo="Reclamações" m={d.reclamacoes} vendas={d.vendasPeriodo} />
            <Metrica rotulo="Cancelamentos" m={d.cancelamentos} vendas={d.vendasPeriodo} />
            <Metrica rotulo="Atrasos no envio" m={d.atrasos} vendas={d.vendasPeriodo} />
          </ul>
          <p className="vf-inicio-rodape">
            {vendasHref && <a href={vendasHref}>Ver as vendas</a>}
            <span>Números do Mercado Livre · lidos em {horario(d.lidaEm)}</span>
          </p>
        </>
      )}
    </section>
  );
}

// Itens para "Precisa de atenção": só quando o termômetro sai do verde.
export function itensDaReputacao(d, href) {
  if (!d?.nivel || !NIVEL[d.nivel].tom) return [];
  const piores = [["reclamacoes", "reclamações"], ["cancelamentos", "cancelamentos"], ["atrasos", "atrasos no envio"]]
    .filter(([k]) => (d[k].quantidade ?? 0) > 0)
    .map(([k, nome]) => `${d[k].quantidade} ${nome}`);
  return [{
    id: "reputacao", tom: NIVEL[d.nivel].tom, href, acao: "Ver vendas",
    titulo: `O termômetro está ${NIVEL[d.nivel].rotulo.toLowerCase()}`,
    detalhe: piores.length ? `No período, o Mercado Livre contou ${piores.join(", ")}.` : "Veja o que pesou na reputação nas vendas recentes.",
  }];
}

// Meses inteiros entre o cadastro e agora.
function mesesDeConta(desde, agora = Date.now()) {
  const d = new Date(desde);
  const a = new Date(agora);
  return (a.getUTCFullYear() - d.getUTCFullYear()) * 12 + (a.getUTCMonth() - d.getUTCMonth()) - (a.getUTCDate() < d.getUTCDate() ? 1 : 0);
}

function Barra({ rotulo, atual, meta, formatar }) {
  const feito = atual >= meta;
  const parte = Math.min(100, (atual / meta) * 100);
  return (
    <div className="vf-inicio-lider__barra">
      <div className="vf-inicio-lider__barra-topo">
        <span>{rotulo}</span>
        <b className="vf-inicio-num">{formatar(atual)} <small>de {formatar(meta)}</small></b>
      </div>
      <div className={`vf-inicio-lider__trilho${feito ? " is-feito" : ""}`} role="progressbar" aria-label={rotulo}
        aria-valuemin={0} aria-valuemax={meta} aria-valuenow={Math.min(atual, meta)} aria-valuetext={`${formatar(atual)} de ${formatar(meta)}`}>
        <i style={{ width: `${parte}%` }} />
      </div>
      <small className={feito ? "vf-inicio-lider__ok" : "vf-inicio-lider__falta"}>{feito ? "Meta batida" : `Faltam ${formatar(meta - atual)}`}</small>
    </div>
  );
}

function requisitos(d, L) {
  const abaixo = (v, limite) => (v === null ? null : v < limite);
  const meses = d.contaDesde ? mesesDeConta(d.contaDesde) : null;
  return [
    { rotulo: "Termômetro verde", valor: d.nivel === "5_green" ? "sim" : d.nivel ? "não" : "—", ok: d.nivel ? d.nivel === "5_green" : null },
    { rotulo: `Reclamações < ${taxa(L.reclamacoesPct)}`, valor: d.reclamacoes.taxaPct === null ? "—" : taxa(d.reclamacoes.taxaPct), ok: abaixo(d.reclamacoes.taxaPct, L.reclamacoesPct) },
    { rotulo: `Cancelamentos < ${taxa(L.cancelamentosPct)}`, valor: d.cancelamentos.taxaPct === null ? "—" : taxa(d.cancelamentos.taxaPct), ok: abaixo(d.cancelamentos.taxaPct, L.cancelamentosPct) },
    { rotulo: `Atrasos < ${num(L.atrasosPct)}%`, valor: d.atrasos.taxaPct === null ? "—" : taxa(d.atrasos.taxaPct), ok: abaixo(d.atrasos.taxaPct, L.atrasosPct) },
    { rotulo: `Conta > ${L.mesesDeConta} meses`, valor: meses === null ? "—" : meses >= 24 ? `${Math.floor(meses / 12)} anos` : `${meses} ${meses === 1 ? "mês" : "meses"}`, ok: meses === null ? null : meses >= L.mesesDeConta },
  ];
}

export function MercadoLider({ envelope, janela, metas, limites }) {
  const d = envelope?.disponivel ? envelope.dados : null;
  const atual = d?.mercadoLider ? metas.findIndex((m) => m.nivel === d.mercadoLider) : -1;
  const alvo = metas[Math.min(atual + 1, metas.length - 1)];
  const mantendo = atual === metas.length - 1;
  const lista = d ? requisitos(d, limites) : [];
  const pendentes = lista.filter((q) => q.ok === false);

  return (
    <section className="vf-inicio-bloco" aria-labelledby="inicio-lider">
      <Topo id="inicio-lider" titulo="MercadoLíder" sub={janela ? `${diaMes(janela.de)} a ${diaMes(janela.ate)}` : null} />
      {!d && <BlocoIndisponivel motivo={envelope?.motivo} />}
      {d && !janela && <p className="vf-field__hint">O progresso aparece quando as vendas da conta estiverem sincronizadas.</p>}
      {d && janela && (
        <>
          <ol className="vf-inicio-lider__escada" aria-label="Níveis do MercadoLíder">
            {metas.map((m, i) => (
              <li key={m.nivel} className={i <= atual ? "is-feito" : m === alvo ? "is-alvo" : undefined} aria-current={i === atual ? "step" : undefined}>
                <i aria-hidden="true" />
                <span>{m.rotulo.replace("MercadoLíder ", "")}</span>
              </li>
            ))}
          </ol>
          <p className="vf-inicio-lider__status">
            {atual >= 0 ? <>A conta é <strong>{metas[atual].rotulo}</strong>. </> : <>A conta ainda não é MercadoLíder. </>}
            {mantendo ? "Para manter o selo:" : <>Próximo nível: <strong>{alvo.rotulo}</strong>.</>}
            {janela.vendas >= alvo.vendas && janela.faturamento >= alvo.faturamento && pendentes.length > 0 && (
              <> Vendas e faturamento já batem a meta: falta {pendentes.map((q) => q.rotulo.split(" ")[0].toLowerCase()).join(" e ")}.</>
            )}
          </p>
          <div className="vf-inicio-lider__barras">
            <Barra rotulo="Vendas" atual={janela.vendas} meta={alvo.vendas} formatar={num} />
            <Barra rotulo="Faturamento" atual={janela.faturamento} meta={alvo.faturamento} formatar={(n) => reais(n).replace(/,\d{2}$/, "")} />
          </div>
          <ul className="vf-inicio-lider__requisitos" aria-label={pendentes.length ? `${pendentes.length} requisitos pendentes` : "Requisitos de qualidade"}>
            {lista.map((q) => (
              <li key={q.rotulo} className={q.ok === false ? "is-falta" : q.ok ? "is-ok" : undefined}>
                <i aria-hidden="true">{q.ok === false ? "!" : q.ok ? "✓" : "–"}</i>
                <span>{q.rotulo}</span>
                <b className="vf-inicio-num">{q.valor}</b>
              </li>
            ))}
          </ul>
          <p className="vf-inicio-rodape">
            <span>Metas do Mercado Livre · vendas e faturamento pelos pedidos sincronizados</span>
          </p>
        </>
      )}
    </section>
  );
}
