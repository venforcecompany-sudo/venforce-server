// frontend-react/src/components/inicio/Blocos.jsx
// "Precisa de atenção", "Saúde do catálogo" e os rankings de produtos — porte
// do Início do Lucratto. Os links levam ao módulo do VenForce que resolve.

import { BlocoIndisponivel } from "../visao/BlocoCard.jsx";
import { itensDaReputacao } from "./Reputacao.jsx";
import { formatarDataHora } from "../../utils/dates.js";
import { noPlural, pct, reais } from "./formato.js";

// Os status do Motor de Margem, na ordem da barra, com a cor de cada um.
export const FAIXAS_CATALOGO = [
  { status: "saudavel", rotulo: "Saudável" },
  { status: "margem_baixa", rotulo: "Margem baixa" },
  { status: "prejuizo", rotulo: "Prejuízo" },
  { status: "dado_suspeito", rotulo: "Dado suspeito" },
  { status: "nao_validado", rotulo: "Não validado" },
  { status: "conciliando", rotulo: "Conciliando" },
];

export function Topo({ id, titulo, sub, children }) {
  return (
    <div className="vf-inicio-bloco__topo">
      <h2 id={id}>{titulo}{sub !== null && sub !== undefined && <small>{sub}</small>}</h2>
      {children}
    </div>
  );
}

// O que pede atenção, do mais grave ao menos; só entra o que tem número.
export function itensDeAtencao({ vendas, catalogo, reputacao, configuracao, links }) {
  const itens = [];
  const daReputacao = itensDaReputacao(reputacao, links.vendas);
  itens.push(...daReputacao.filter((i) => i.tom === "critico"));

  if (catalogo) {
    const prejuizo = catalogo.porStatus.prejuizo;
    if (prejuizo > 0) {
      itens.push({
        id: "prejuizo", tom: "critico", href: links.margem, acao: "Ver anúncios",
        titulo: `${prejuizo} ${noPlural(prejuizo, "anúncio vendendo", "anúncios vendendo")} com prejuízo`,
        detalhe: `Cada venda ${noPlural(prejuizo, "dele tira", "deles tira")} dinheiro do caixa.${catalogo.piorMargemPct !== null ? ` O pior está com margem de ${pct(catalogo.piorMargemPct)}.` : ""}`,
      });
    }
  }
  const semCusto = vendas?.totais?.semCusto ?? 0;
  if (semCusto > 0) {
    itens.push({
      id: "sem-custo", tom: "atencao", href: links.bases, acao: "Cadastrar custos",
      titulo: `${semCusto} ${noPlural(semCusto, "venda do período sem custo", "vendas do período sem custo")}`,
      detalhe: "Sem o custo do produto, o lucro dessas vendas não é calculado.",
    });
  }
  if (catalogo) {
    const suspeitos = catalogo.porStatus.dado_suspeito;
    if (suspeitos > 0) {
      itens.push({
        id: "suspeito", tom: "atencao", href: links.margem, acao: "Revisar custos",
        titulo: `${suspeitos} ${noPlural(suspeitos, "anúncio com dado suspeito", "anúncios com dado suspeito")}`,
        detalhe: "O custo ou a tarifa não batem com o preço de venda.",
      });
    }
    const baixos = catalogo.porStatus.margem_baixa;
    if (baixos > 0) {
      itens.push({
        id: "baixa", tom: "neutro", href: links.margem, acao: "Ver anúncios",
        titulo: `${baixos} ${noPlural(baixos, "anúncio abaixo", "anúncios abaixo")} da meta${catalogo.margemAlvoPct !== null ? ` de ${catalogo.margemAlvoPct.toLocaleString("pt-BR")}%` : ""}`,
        detalhe: "Um ajuste de preço ou de custo pode levá-lo de volta à meta.",
      });
    }
  }
  const sync = configuracao?.sync;
  if (sync?.precisaSincronizar) {
    itens.push({
      id: "sync", tom: "info", href: links.vendas, acao: "Sincronizar",
      titulo: "As vendas estão desatualizadas",
      detalhe: sync.ultimaSincronizacao ? `Última sincronização em ${formatarDataHora(sync.ultimaSincronizacao)}.` : "As vendas desta conta ainda não foram sincronizadas.",
    });
  }
  itens.push(...daReputacao.filter((i) => i.tom !== "critico"));
  return itens;
}

export function Atencao({ itens }) {
  return (
    <section className="vf-inicio-bloco" aria-labelledby="inicio-atencao">
      <Topo id="inicio-atencao" titulo="Precisa de atenção" sub={itens.length > 0 ? `${itens.length} ${noPlural(itens.length, "item", "itens")}` : null} />
      {itens.length === 0 ? (
        <p className="vf-inicio-vazio">Nada pede atenção agora. Os custos estão em dia e nenhum anúncio está no prejuízo.</p>
      ) : (
        <ul className="vf-inicio-atencao">
          {itens.map((i) => (
            <li key={i.id}>
              <i className={`vf-inicio-ponto vf-inicio-ponto--${i.tom}`} aria-hidden="true" />
              <div>
                <strong>{i.titulo}</strong>
                <span>{i.detalhe}</span>
              </div>
              {i.href && <a className="vf-btn vf-btn--sm" href={i.href}>{i.acao}</a>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function SaudeCatalogo({ envelope, href }) {
  const d = envelope?.disponivel ? envelope.dados : null;
  const faixas = d ? FAIXAS_CATALOGO.filter((f) => f.status !== "conciliando" || d.porStatus.conciliando > 0) : [];
  const total = d?.total ?? 0;
  const parte = (n) => (total > 0 ? (n / total) * 100 : 0);
  const descricao = faixas.map((f) => `${d.porStatus[f.status]} ${f.rotulo.toLowerCase()}`).join(", ");
  return (
    <section className="vf-inicio-bloco" aria-labelledby="inicio-catalogo">
      <Topo id="inicio-catalogo" titulo="Saúde do catálogo" sub={d ? `${total} ${noPlural(total, "anúncio", "anúncios")}` : null}>
        {d && href && <a className="vf-inicio-ver" href={href}>Ver na Central de Margem</a>}
      </Topo>
      {!d && <BlocoIndisponivel motivo={envelope?.motivo} />}
      {d && total === 0 && <p className="vf-inicio-vazio">Os anúncios aparecem aqui depois que a Central de Margem analisar a conta.</p>}
      {d && total > 0 && (
        <>
          <div className="vf-inicio-barra" role="img" aria-label={`Anúncios por status da margem: ${descricao}.`}>
            {faixas.map((f) => d.porStatus[f.status] > 0 && (
              <i key={f.status} className={`vf-inicio-faixa--${f.status}`} style={{ width: `${parte(d.porStatus[f.status])}%` }} />
            ))}
          </div>
          <ul className="vf-inicio-legenda">
            {faixas.map((f) => (
              <li key={f.status}>
                <a href={href}>
                  <i className={`vf-inicio-amostra vf-inicio-faixa--${f.status}`} aria-hidden="true" />
                  <span>{f.rotulo}</span>
                  <b className="vf-inicio-num">{d.porStatus[f.status]}</b>
                  <small className="vf-inicio-num">{pct(parte(d.porStatus[f.status]))}</small>
                </a>
              </li>
            ))}
          </ul>
          {d.cobertura?.parcial && (
            <p className="vf-field__hint">Amostra de {d.cobertura.itensAnalisados} de {d.cobertura.totalItensMl} anúncios do Mercado Livre.</p>
          )}
        </>
      )}
    </section>
  );
}

export function Ranking({ id, titulo, itens, vazio, tom, ver }) {
  return (
    <section className="vf-inicio-bloco" aria-labelledby={id}>
      <Topo id={id} titulo={titulo}>
        {ver?.href && <a className="vf-inicio-ver" href={ver.href}>{ver.rotulo}</a>}
      </Topo>
      {itens.length === 0 ? (
        <p className="vf-inicio-vazio">{vazio}</p>
      ) : (
        <ul className="vf-inicio-ranking">
          {itens.map((p) => (
            <li key={p.mlb}>
              <div>
                <b title={p.titulo ?? p.mlb}>{p.titulo ?? p.mlb}</b>
                <small>{p.mlb} · {p.unidades} un.</small>
              </div>
              <span className={`vf-inicio-num vf-inicio-lucro--${tom}`}>{p.lucro < 0 ? `− ${reais(Math.abs(p.lucro))}` : reais(p.lucro)}</span>
              <span className={`vf-inicio-num${tom === "negativo" ? " vf-inicio-lucro--negativo" : ""}`}>{pct(p.margemPct)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
