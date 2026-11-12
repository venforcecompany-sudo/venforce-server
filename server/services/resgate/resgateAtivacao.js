// server/services/resgate/resgateAtivacao.js
//
// PLANO DE ATIVAÇÃO por conta, a partir da matriz de compatibilidade. Não
// altera nada: produz a próxima onda e os VALORES EXPLÍCITOS das variáveis
// existentes (nunca `*`), preservando os controles de segurança atuais:
//   FRETE_COTACAO_CONFIAVEL_SELLERS  (ml_user_id) — liga a avaliação do frete;
//   FRETE_LEGADO_BLOQUEAR_CONTAS     (cliente_conta_id) — esconde a margem das
//                                    linhas antigas até o recálculo da conta.
// Liberar um seller sem bloquear as linhas legadas da conta deixaria margens
// antigas (possivelmente infladas) visíveis até o refresh: as duas listas
// andam juntas, sempre.

const { DECISAO } = require("./resgateCompatibilidade");

function listaEnv(valor) { return String(valor || "").split(",").map((x) => x.trim()).filter(Boolean); }

/**
 * @param {object} p
 *  contas[] { resumo, matriz }
 *  env      process.env (somente leitura)
 *  tamanhoOnda  máximo de contas por onda (default 5)
 */
function planoDeAtivacao({ contas = [], env = process.env, tamanhoOnda = 5 } = {}) {
  const sellersHoje = listaEnv(env.FRETE_COTACAO_CONFIAVEL_SELLERS);
  const contasLegadoHoje = listaEnv(env.FRETE_LEGADO_BLOQUEAR_CONTAS).filter((x) => /^[0-9]+$/.test(x));
  const curinga = sellersHoje.includes("*");

  const linhas = contas.map((c) => {
    const r = c.resumo || {}, m = c.matriz || null;
    const seller = r.sellerId ? String(r.sellerId) : null;
    const naFlag = seller ? (curinga || sellersHoje.includes(seller)) : false;
    // A flag do Render não é visível fora do servidor: JA_LIBERADA da matriz (linhas com
    // freteQualidade gravadas pela produção) também conta como liberada.
    const porEvidencia = Boolean(m && m.decisao === DECISAO.JA_LIBERADA);
    const liberadoSeller = naFlag || porEvidencia;
    const bloqueioLegado = contasLegadoHoje.includes(String(r.clienteContaId));
    return {
      clienteContaId: r.clienteContaId, clienteNome: r.clienteNome || null, contaNome: r.contaNome || null, sellerId: seller,
      decisao: m ? m.decisao : (r.semAvaliacao ? DECISAO.SEM_DADOS : null), semAvaliacao: r.semAvaliacao || null,
      liberadoSeller, liberadoPor: naFlag ? "flag" : porEvidencia ? "evidencia_no_banco" : null, bloqueioLegado, inconsistente: liberadoSeller && !bloqueioLegado,
      motivos: m ? m.motivos : (r.semAvaliacao ? [`Sem avaliação: ${r.semAvaliacao}.`] : []),
      risco: Number(r.riscoFinanceiro30d || 0) + Number(r.faturamentoComMargemDesconhecida30d || 0) / 20,
      desconhecidosAposLiberar: m ? m.totais.desconhecidoAoVivo : null,
    };
  });

  const candidatas = (dec) => linhas.filter((l) => !l.liberadoSeller && l.sellerId && l.decisao === dec).sort((a, b) => b.risco - a.risco);
  const onda1 = candidatas(DECISAO.LIBERAVEL).slice(0, tamanhoOnda);
  const restoTam = Math.max(0, tamanhoOnda - onda1.length);
  const onda2 = candidatas(DECISAO.LIBERAVEL_COM_RESSALVAS).slice(0, restoTam);
  const proxima = [...onda1, ...onda2];

  const novosSellers = [...new Set([...sellersHoje.filter((s) => s !== "*"), ...linhas.filter((l) => l.liberadoSeller && l.sellerId).map((l) => l.sellerId), ...proxima.map((l) => l.sellerId)])];
  const novasContas = [...new Set([...contasLegadoHoje, ...linhas.filter((l) => l.liberadoSeller).map((l) => String(l.clienteContaId)), ...proxima.map((l) => String(l.clienteContaId))])];

  const alertas = [];
  if (curinga) alertas.push("FRETE_COTACAO_CONFIAVEL_SELLERS contém `*` em produção: substituir pela lista explícita abaixo.");
  for (const l of linhas.filter((x) => x.inconsistente)) {
    alertas.push(l.liberadoPor === "evidencia_no_banco"
      ? `Conta ${l.clienteContaId} (seller ${l.sellerId}) está liberada em produção (há linhas avaliadas): CONFIRMAR no Render que ela também está em FRETE_LEGADO_BLOQUEAR_CONTAS.`
      : `Conta ${l.clienteContaId} (seller ${l.sellerId}) liberada sem FRETE_LEGADO_BLOQUEAR_CONTAS: margens antigas visíveis até o recálculo.`);
  }

  return {
    geradoEm: new Date().toISOString(),
    hoje: { sellers: sellersHoje, contasLegado: contasLegadoHoje },
    proximaOnda: proxima.map((l) => ({ clienteContaId: l.clienteContaId, sellerId: l.sellerId, clienteNome: l.clienteNome, decisao: l.decisao, motivos: l.motivos, desconhecidosAposLiberar: l.desconhecidosAposLiberar })),
    envProposto: proxima.length ? { FRETE_COTACAO_CONFIAVEL_SELLERS: novosSellers.join(","), FRETE_LEGADO_BLOQUEAR_CONTAS: novasContas.join(",") } : null,
    passos: proxima.length ? [
      "1. Conferir a matriz de cada conta da onda (Resgate → Ativação).",
      "2. No Render: atualizar as DUAS variáveis com os valores propostos (listas explícitas, sem `*`) e reiniciar.",
      "3. Recalcular SÓ as contas da onda (botão de recálculo por conta), uma por vez.",
      "4. Acompanhar no Resgate: % de linhas com frete avaliado, falhas e desconhecidos por conta.",
      "5. Só então passar à próxima onda. Reverter = remover os ids das duas listas e reiniciar.",
    ] : [],
    naoLiberar: linhas.filter((l) => !l.liberadoSeller && (l.decisao === DECISAO.NAO_LIBERAVEL || l.decisao === DECISAO.SEM_DADOS || !l.sellerId)).map((l) => ({ clienteContaId: l.clienteContaId, sellerId: l.sellerId, decisao: l.decisao, motivos: l.motivos })),
    contas: linhas,
    alertas,
  };
}

module.exports = { planoDeAtivacao, listaEnv };
