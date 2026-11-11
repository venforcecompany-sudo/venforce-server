// frontend-react/src/components/inicio/Cartoes.jsx
// Faixa de quatro números do período (Faturamento · Lucro · Margem · Ticket
// médio), cada um com a variação contra o período anterior. O Lucro é o único
// cartão em destaque — como no Início do Lucratto.

import { AUSENTE } from "../../utils/numbers.js";
import { noPlural, pct, reais, variacoes } from "./formato.js";

function Variacao({ v }) {
  const sentido = Math.abs(v.delta) < 0.05 ? "igual" : v.delta > 0 ? "sobe" : "desce";
  const numero = Math.abs(v.delta).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const texto = sentido === "igual" ? "Igual" : `${sentido === "sobe" ? "▲" : "▼"} ${numero}${v.unidade === "%" ? "%" : " p.p."}`;
  return (
    <small className={`vf-inicio-variacao vf-inicio-variacao--${sentido}`} title={`${v.contra[0].toUpperCase()}${v.contra.slice(1)}: ${v.antes}`}>
      <span className="vf-inicio-num">{texto}</span> vs. {v.contra}
    </small>
  );
}

function Cartao({ rotulo, valor, detalhe, negativo, destaque, variacao }) {
  return (
    <div className={`vf-inicio-cartao${destaque ? " vf-inicio-cartao--destaque" : ""}`}>
      <dt>{rotulo}</dt>
      <dd className={`vf-inicio-num${negativo ? " vf-inicio-negativo" : ""}`}>{valor}</dd>
      {detalhe && <small>{detalhe}</small>}
      {variacao && <Variacao v={variacao} />}
    </div>
  );
}

export function Cartoes({ totais: t, anterior }) {
  const v = variacoes(t, anterior);
  const calculadas = t.vendasCalculadas > 0;
  return (
    <dl className="vf-inicio-cartoes" aria-label="Resumo do período">
      <Cartao
        rotulo="Faturamento"
        valor={reais(t.faturamento)}
        detalhe={`${t.vendas} ${noPlural(t.vendas, "venda", "vendas")} · ${t.unidades} ${noPlural(t.unidades, "unidade", "unidades")}`}
        variacao={v.faturamento}
      />
      <Cartao
        destaque
        rotulo="Lucro"
        valor={calculadas ? reais(t.lucro) : AUSENTE}
        negativo={calculadas && t.lucro < 0}
        detalhe={calculadas ? `em ${t.vendasCalculadas} ${noPlural(t.vendasCalculadas, "venda calculada", "vendas calculadas")}` : "nenhuma venda com todos os dados"}
        variacao={v.lucro}
      />
      <Cartao
        rotulo="Margem"
        valor={pct(t.margemPct)}
        negativo={t.margemPct !== null && t.margemPct < 0}
        detalhe="lucro ÷ faturamento calculado"
        variacao={v.margem}
      />
      <Cartao rotulo="Ticket médio" valor={t.ticket === null ? AUSENTE : reais(t.ticket)} detalhe="por venda" variacao={v.ticket} />
    </dl>
  );
}
