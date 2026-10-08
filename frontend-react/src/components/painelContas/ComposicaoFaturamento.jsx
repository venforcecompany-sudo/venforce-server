// frontend-react/src/components/painelContas/ComposicaoFaturamento.jsx
//
// Demonstrativo do faturamento POR CONTA, dentro da expansão do cliente:
//
//   [Soma das contas] [Mercado Livre 1] [Mercado Livre 2] [Mercado Livre 3]
//
//   Faturamento bruto            3.646.296,49
//   − Cancelamentos               −202.267,15
//   − Devoluções concluídas …
//   − Devoluções em andamento …
//   − Mediações em aberto   …
//   = FAT                        3.377.999,97
//   Conferência                  ✓ fecha
//
// UM demonstrativo por vez: com várias contas, abre na soma e o seletor troca
// para cada conta — 1, 3 ou 10 contas ocupam o mesmo espaço (lado a lado, a
// partir de 3 contas, as colunas ficavam espremidas). Apresentado como SEÇÃO
// de detalhe da linha do cliente: demonstrativo à esquerda (valor e pedidos
// na mesma linha) e, na largura que sobra, a leitura — pedidos, definições e
// notas. Valores em centavos (é uma conferência, não um resumo). O FAT é o
// oficial do import; a conferência só diz se bruto − exclusões chega nele.
// Nada aqui é recalculado no navegador.

import { useState } from "react";
import { formatarMoeda } from "../../utils/currency.js";
import { formatarNumero } from "../../utils/numbers.js";
import { formatarData, rotularCompetenciaCurta } from "../../utils/dates.js";

export const LINHAS_EXCLUSAO = [
  { chave: "cancelamentos", rotulo: "Cancelamentos", ajuda: "Pedido cancelado sem reclamação." },
  { chave: "devolucoes", rotulo: "Devoluções concluídas", ajuda: "Reclamação encerrada com devolução ou reembolso." },
  { chave: "devolucoesEmAndamento", rotulo: "Devoluções em andamento", ajuda: "Reclamação aberta com devolução — ainda pode reverter." },
  { chave: "mediacoes", rotulo: "Mediações em aberto", ajuda: "Reclamação aberta sem devolução — ainda pode reverter." },
  { chave: "outrosProblemas", rotulo: "Outros pedidos com problema", ajuda: "Fora do resultado sem tipo de pós-venda identificado.", soSeExistir: true },
];

function pedidos(n) {
  return `${formatarNumero(n)} ${Number(n) === 1 ? "pedido" : "pedidos"}`;
}

function periodoCurto(periodo) {
  if (!periodo?.de || !periodo?.ate) return null;
  return `${formatarData(periodo.de).slice(0, 5)}–${formatarData(periodo.ate).slice(0, 5)}`;
}

function CelulaValor({ grupo, negativo = false, forte = false }) {
  const zero = !grupo || Number(grupo.valor) === 0;
  return (
    <td className={`num vf-ph-comp__valor${zero ? " is-zero" : ""}${forte ? " is-forte" : ""}`}>
      <span className="vf-ph-comp__moeda">
        {negativo && !zero ? "− " : ""}{formatarMoeda(grupo?.valor ?? 0)}
      </span>
      <span className="vf-ph-comp__pedidos">{pedidos(grupo?.pedidos ?? 0)}</span>
    </td>
  );
}

function CelulaConferencia({ reconciliacao }) {
  if (reconciliacao?.fecha) {
    return (
      <td className="num vf-ph-comp__conferencia is-ok">
        <span className="vf-status is-success">fecha</span>
      </td>
    );
  }
  const dif = reconciliacao?.diferenca;
  return (
    <td className="num vf-ph-comp__conferencia is-erro" title="O FAT do import e a soma dos pedidos válidos não batem. Nenhum dos dois foi ajustado.">
      <span className="vf-status is-danger">
        {dif === null || dif === undefined ? "não confere" : `difere ${formatarMoeda(dif, { sinalPositivo: true })}`}
      </span>
    </td>
  );
}

export function DemonstrativoComposicao({ contas = [], somaDasContas = null, competencia }) {
  const comComposicao = contas.filter((c) => c.composicao);
  const semComposicao = contas.filter((c) => !c.composicao);
  const opcoes = comComposicao.map((c) => ({ chave: c.contaId, rotulo: c.rotulo, comp: c.composicao }));
  if (somaDasContas && comComposicao.length > 1) {
    opcoes.unshift({ chave: "soma", rotulo: "Soma das contas", comp: somaDasContas, soma: true });
  }
  // Abre na soma (ou na conta única). Se a conta escolhida sumir num
  // recarregamento, volta para a primeira opção em vez de mostrar vazio.
  const [escolhida, setEscolhida] = useState(null);
  const atual = opcoes.find((o) => o.chave === escolhida) || opcoes[0];

  const notas = [];
  if (somaDasContas?.periodo?.diferente) {
    notas.push("As contas cobrem períodos diferentes (ver o período de cada uma) — a soma junta esses períodos como estão.");
  }
  if (Number(somaDasContas?.sobreposicao?.pedidos) > 0) {
    const n = Number(somaDasContas.sobreposicao.pedidos);
    notas.push(`${n === 1 ? "1 pedido aparece" : `${formatarNumero(n)} pedidos aparecem`} em mais de uma conta (${formatarMoeda(somaDasContas.sobreposicao.valor)} a mais na soma). A soma não deduplica: confira o cadastro das contas.`);
  }
  const semValor = comComposicao.reduce((s, c) => s + (Number(c.composicao.pedidosSemValor) || 0), 0);
  if (semValor > 0) {
    notas.push(`${semValor === 1 ? "1 pedido sem valor registrado entra" : `${formatarNumero(semValor)} pedidos sem valor registrado entram`} na contagem com R$ 0,00.`);
  }

  if (!atual) {
    return (
      <p className="vf-ph-comp__vazio">
        Nenhuma conta tem pedidos importados em {rotularCompetenciaCurta(competencia)} — não há o que compor.
        {semComposicao.length > 0 && " Contas com lançamento manual informam só o FAT."}
      </p>
    );
  }

  const comp = atual.comp;
  const exclusoes = LINHAS_EXCLUSAO.filter((l) => !l.soSeExistir || Number(comp.exclusoes?.[l.chave]?.pedidos) > 0);
  const periodo = periodoCurto(comp.periodo);
  const escopo = comComposicao.length === 1 ? comComposicao[0].rotulo : `${comComposicao.length} contas`;
  return (
    <section className="vf-ph-comp" aria-label={`Composição do faturamento em ${rotularCompetenciaCurta(competencia)}`}>
      <header className="vf-ph-comp__cabecalho">
        <p className="vf-ph-comp__titulo">
          Composição do faturamento
          <span className="vf-ph-comp__escopo"> · {escopo} · {rotularCompetenciaCurta(competencia)}</span>
        </p>
        <p className="vf-ph-comp__formula" aria-hidden="true">bruto − exclusões = FAT</p>
      </header>

      {opcoes.length > 1 && (
        <div className="vf-ph-comp__seletor" role="group" aria-label="Demonstrativo exibido">
          {opcoes.map((o) => (
            <button
              key={o.chave}
              type="button"
              className={`vf-ph-comp__opcao${o.soma ? " is-soma" : ""}`}
              aria-pressed={o.chave === atual.chave}
              onClick={() => setEscolhida(o.chave)}
            >
              {o.rotulo}
            </button>
          ))}
        </div>
      )}

      <div className="vf-ph-comp__corpo">
        <table className="vf-ph-comp__tabela">
          <caption className="vf-visually-hidden">
            Composição do faturamento — {atual.rotulo} — em {rotularCompetenciaCurta(competencia)}: faturamento bruto, exclusões e FAT.
          </caption>
          <thead>
            <tr>
              <th scope="col" className="vf-ph-comp__rotulo-col">
                <span className="vf-visually-hidden">Linha</span>
              </th>
              <th scope="col" className="num">
                <span className="vf-ph-comp__conta">{atual.rotulo}</span>
                {periodo && (
                  <span className="vf-ph-comp__periodo">
                    {periodo}
                    {atual.soma && comp.periodo?.diferente ? " · períodos diferentes" : ""}
                  </span>
                )}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr className="vf-ph-comp__linha is-bruto">
              <th scope="row" title="Todos os pedidos, cancelados inclusos · regra da Cliente 360 V1">Faturamento bruto</th>
              <CelulaValor grupo={comp.bruto} forte />
            </tr>
            {exclusoes.map((l) => (
              <tr key={l.chave} className="vf-ph-comp__linha is-exclusao">
                <th scope="row" title={l.ajuda}>− {l.rotulo}</th>
                <CelulaValor grupo={comp.exclusoes?.[l.chave]} negativo />
              </tr>
            ))}
            <tr className="vf-ph-comp__linha is-total">
              <th scope="row" title="Pedidos válidos · Central de Vendas">= FAT</th>
              <td className="num vf-ph-comp__valor is-forte">
                <span className="vf-ph-comp__moeda">{comp.fat === null ? "—" : formatarMoeda(comp.fat)}</span>
                <span className="vf-ph-comp__pedidos">{pedidos(comp.validos?.pedidos ?? 0)}</span>
              </td>
            </tr>
            <tr className="vf-ph-comp__linha is-conferencia">
              <th scope="row" title="Faturamento bruto menos as exclusões, comparado ao FAT oficial do import.">Conferência</th>
              <CelulaConferencia reconciliacao={comp.reconciliacao} />
            </tr>
          </tbody>
        </table>

        <aside className="vf-ph-comp__lado" aria-label="Como ler a composição">
          <p className="vf-ph-comp__fluxo" aria-label="Pedidos">
            <span className="vf-ph-comp__fluxo-conta">Pedidos · {atual.soma ? "soma das contas" : atual.rotulo}</span>
            <span className="vf-ph-comp__fluxo-numeros">
              {pedidos(comp.bruto?.pedidos ?? 0)} → {formatarNumero(comp.validos?.pedidos ?? 0)} válidos
              {comp.totalExcluido?.pedidos != null && ` · ${formatarNumero(comp.totalExcluido.pedidos)} fora do FAT`}
            </span>
          </p>
          <dl className="vf-ph-comp__definicoes">
            <div><dt>Faturamento bruto</dt><dd>todos os pedidos, cancelados inclusos (regra da Cliente 360 V1)</dd></div>
            <div>
              <dt>Exclusões</dt>
              <dd>
                cancelamento sem reclamação; devolução concluída; reclamação aberta — com devolução em andamento ou em
                mediação — que ainda pode reverter
              </dd>
            </div>
            <div><dt>FAT</dt><dd>pedidos válidos (Central de Vendas)</dd></div>
          </dl>
          <ul className="vf-ph-comp__notas">
            {semComposicao.map((c) => (
              <li key={c.contaId}>{c.rotulo}: {c.motivo || "sem pedidos para compor"} — fora do demonstrativo.</li>
            ))}
            {notas.map((n) => <li key={n}>{n}</li>)}
            <li>
              Mesmo import e mesmos pedidos do FAT de cada conta; cada pedido cai em um só grupo. O valor do pedido é a soma
              dos itens (a base do FAT) — a Cliente 360 V1 ao vivo usa o total do pedido.
            </li>
          </ul>
        </aside>
      </div>
    </section>
  );
}
