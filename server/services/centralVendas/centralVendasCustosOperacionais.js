// server/services/centralVendas/centralVendasCustosOperacionais.js
//
// Contrato de ADS e FULL na Central de Vendas (v1). Função PURA: recebe o que o
// Financeiro JÁ coletou (financeiro_ads_cache / financeiro_full_cache, ou o
// retorno de buscarPerformanceML numa janela exata) e o resultado de venda do
// período; devolve custos, métricas e o resultado operacional — ou diz,
// explicitamente, por que não pode.
//
// Regras (todas cobertas por teste):
//   1. ESCOPO: só fonte de UMA conta (cliente_conta_id) entra. ads_resumos_mensais
//      é a SOMA das contas do cliente — escopo "cliente" ⇒ recusado numa visão
//      de conta (nunca rateado).
//   2. TEMPO: fonte mensal só é compatível com período que cobre meses INTEIROS.
//      Período parcial com fonte mensal ⇒ o valor do mês é mostrado como
//      referência, mas `compativel:false` e o resultado operacional fica null.
//      Ads em janela exata ([dateFrom, dateTo] = período) é compatível.
//   3. AUSENTE ≠ ZERO: sem fonte ⇒ `disponivel:false` com o código. Zero só
//      quando a API respondeu e o custo é 0 ("zero_observado").
//   4. FULL: só armazenagem, prolongado, coleta, retirada (CHARGE). O frete das
//      vendas Full (CFFE/CFFI) já está no frete_seller de cada pedido e NUNCA é
//      somado aqui. Estornos (BONUS) não são abatidos pelo serviço atual: o custo
//      pode estar superestimado — declarado em `limitacoes`.
//   5. Nada é replicado por pedido: Ads e Full são da conta × período.
//   6. Denominadores explícitos em toda métrica.

const CONTRATO_VERSAO = 1;
const GRUPOS_FULL = Object.freeze(["armazenagem", "armazenamento_prolongado", "coleta", "retirada"]);
const SUBTIPOS_FRETE_FULL_EXCLUIDOS = Object.freeze(["CFFE", "CFFI", "BFFE", "BFFI"]);

const cent = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100));

function mesesDoPeriodo(dateFrom, dateTo) {
  const meses = [];
  let [a, m] = dateFrom.slice(0, 7).split("-").map(Number);
  const [aFim, mFim] = dateTo.slice(0, 7).split("-").map(Number);
  while (a < aFim || (a === aFim && m <= mFim)) {
    meses.push(`${a}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m === 13) { m = 1; a += 1; }
  }
  return meses;
}

function ultimoDia(mes) {
  const [a, m] = mes.split("-").map(Number);
  return new Date(Date.UTC(a, m, 0)).getUTCDate();
}

// O período cobre só meses inteiros? (fonte mensal só é compatível nesse caso)
function cobreMesesInteiros(dateFrom, dateTo) {
  const meses = mesesDoPeriodo(dateFrom, dateTo);
  const primeiro = meses[0];
  const ultimo = meses[meses.length - 1];
  return dateFrom === `${primeiro}-01` && dateTo === `${ultimo}-${String(ultimoDia(ultimo)).padStart(2, "0")}`;
}

// Uma fonte MENSAL só cobre o mês inteiro se foi consultada depois do fim
// dele (00:00 de Brasília do dia 1 seguinte = 03:00 UTC). Consultada antes ⇒
// só cobre até aquele instante: abatê-la de uma margem do mês inteiro mistura
// janelas (ex.: Ads de novembro consultado no dia 26). Sem data ⇒ não provado.
function cobreOMesInteiro(consultadoEm, mes) {
  const t = consultadoEm ? new Date(consultadoEm).getTime() : NaN;
  if (!Number.isFinite(t)) return false;
  const [a, m] = mes.split("-").map(Number);
  return t >= Date.UTC(a, m, 1, 3, 0, 0);
}

function metrica(numerador, denominador, { escala = 1, nomeNum, nomeDen }) {
  const ok = numerador !== null && denominador !== null && denominador > 0;
  return {
    valor: ok ? Math.round((numerador / denominador) * escala * 100) / 100 : null,
    numerador: { nome: nomeNum, centavos: numerador },
    denominador: { nome: nomeDen, centavos: denominador },
  };
}

// ─── Ads ────────────────────────────────────────────────────────────────────────────────
// fontesAds: lista de { escopo: "conta"|"cliente", clienteContaId, cobertura: {tipo:"mes", mes} | {tipo:"janela", dateFrom, dateTo},
//   disponivel, codigo?, investimentoAds, gmvAds, gmvDireto?, gmvIndireto?, consultadoEm?, consolidado? , anuncios? }
function avaliarAds({ periodo, clienteContaId, fontesAds = [], receitaProdutoCentavos }) {
  const doEscopo = fontesAds.filter((f) => f && f.escopo === "conta" && Number(f.clienteContaId) === Number(clienteContaId));
  const recusadas = fontesAds.filter((f) => f && !(f.escopo === "conta" && Number(f.clienteContaId) === Number(clienteContaId)))
    .map((f) => ({ motivo: f.escopo === "cliente" ? "escopo_cliente_nao_e_da_conta" : "outra_conta", escopo: f.escopo, clienteContaId: f.clienteContaId ?? null }));

  const janela = doEscopo.find((f) => f.cobertura?.tipo === "janela" && f.cobertura.dateFrom === periodo.dateFrom && f.cobertura.dateTo === periodo.dateTo);
  let usadas;
  let compativel;
  let motivoIncompativel = null;
  if (janela) {
    usadas = [janela];
    compativel = true;
  } else {
    const meses = mesesDoPeriodo(periodo.dateFrom, periodo.dateTo);
    usadas = meses.map((mes) => doEscopo.find((f) => f.cobertura?.tipo === "mes" && f.cobertura.mes === mes) || { faltando: true, mes });
    compativel = cobreMesesInteiros(periodo.dateFrom, periodo.dateTo);
    if (!compativel) motivoIncompativel = "periodo_parcial_com_fonte_mensal";
    else if (usadas.some((u) => !u.faltando && u.disponivel !== false && !cobreOMesInteiro(u.consultadoEm, u.cobertura?.mes || u.mes))) {
      compativel = false;
      motivoIncompativel = "fonte_consultada_antes_do_fim_do_mes";
    }
  }
  const faltando = usadas.filter((u) => u.faltando || u.disponivel === false);
  const base = {
    disponivel: faltando.length === 0,
    compativel,
    motivoIncompativel,
    cobertura: usadas.map((u) => (u.faltando ? { mes: u.mes, estado: "sem_fonte" } : { ...(u.cobertura || {}), estado: u.disponivel === false ? "indisponivel" : "ok", codigo: u.codigo || null, consolidado: u.consolidado ?? null, consultadoEm: u.consultadoEm ?? null })),
    recusadas,
  };
  if (!base.disponivel) {
    return { ...base, estado: "indisponivel", codigos: [...new Set(faltando.map((u) => u.codigo || "SEM_FONTE"))], investimento: { centavos: null }, receitaAtribuida: { centavos: null }, metricas: null, produtos: null };
  }
  const soma = (campo) => usadas.reduce((s, u) => (s === null || cent(u[campo]) === null ? null : s + cent(u[campo])), 0);
  const investimento = soma("investimentoAds");
  const receitaAtribuida = soma("gmvAds");
  const direta = soma("gmvDireto");
  const indireta = soma("gmvIndireto");
  const estado = investimento === 0 ? "zero_observado" : "observado";
  const metricas = {
    roas: metrica(receitaAtribuida, investimento, { nomeNum: "receita atribuída pelo Mercado Ads", nomeDen: "investimento em Ads" }),
    acos: metrica(investimento, receitaAtribuida, { escala: 100, nomeNum: "investimento em Ads", nomeDen: "receita atribuída pelo Mercado Ads" }),
    // TACOS só com o MESMO período: com fonte mensal em período parcial o denominador seria de outra janela.
    tacos: compativel
      ? metrica(investimento, receitaProdutoCentavos ?? null, { escala: 100, nomeNum: "investimento em Ads", nomeDen: "receita de produtos da Central (pedidos no resultado)" })
      : { valor: null, motivo: motivoIncompativel, numerador: { nome: "investimento em Ads", centavos: investimento }, denominador: { nome: "receita de produtos da Central", centavos: receitaProdutoCentavos ?? null } },
  };
  // Por produto: só com anúncios da MESMA janela compatível (custo do anúncio = MLB).
  let produtos = null;
  if (compativel && usadas.every((u) => Array.isArray(u.anuncios))) {
    const porMlb = new Map();
    for (const u of usadas) {
      for (const a of u.anuncios) {
        const mlb = a.itemId ? String(a.itemId) : null;
        if (!mlb) continue;
        const atual = porMlb.get(mlb) || { mlb, custoCentavos: 0, receitaDiretaCentavos: 0, receitaIndiretaCentavos: 0 };
        atual.custoCentavos += cent(a.metrics?.cost) || 0;
        atual.receitaDiretaCentavos += cent(a.metrics?.directAmount) || 0;
        atual.receitaIndiretaCentavos += cent(a.metrics?.indirectAmount) || 0;
        porMlb.set(mlb, atual);
      }
    }
    produtos = { atribuicao: "custo_por_anuncio_mercado_ads", nota: "receita indireta pode ser de outros produtos (atribuição do ML)", porMlb: [...porMlb.values()] };
  }
  return { ...base, estado, investimento: { centavos: investimento }, receitaAtribuida: { centavos: receitaAtribuida, diretaCentavos: direta, indiretaCentavos: indireta }, metricas, produtos };
}

// ─── Full ───────────────────────────────────────────────────────────────────────────────
// fontesFull: lista de { clienteContaId, mes, disponivel, codigo?, componentes:[{grupo, valor, lancamentos}], definitivo, consultadoEm }
function avaliarFull({ periodo, clienteContaId, fontesFull = [] }) {
  const meses = mesesDoPeriodo(periodo.dateFrom, periodo.dateTo);
  const doEscopo = fontesFull.filter((f) => f && Number(f.clienteContaId) === Number(clienteContaId));
  const porMes = meses.map((mes) => doEscopo.find((f) => f.mes === mes) || { mes, faltando: true });
  let compativel = cobreMesesInteiros(periodo.dateFrom, periodo.dateTo);
  let motivoIncompativel = compativel ? null : "periodo_parcial_com_fonte_mensal";
  if (compativel && porMes.some((f) => !f.faltando && f.disponivel !== false && !cobreOMesInteiro(f.consultadoEm, f.mes))) {
    compativel = false;
    motivoIncompativel = "fonte_consultada_antes_do_fim_do_mes";
  }
  const faltando = porMes.filter((f) => f.faltando || f.disponivel === false);
  const limitacoes = [
    "estornos_nao_abatidos: só lançamentos CHARGE entram; um estorno (BONUS) de armazenagem não é descontado",
    "frete_full_excluido: CFFE/CFFI ficam de fora porque já estão no frete_seller de cada venda",
    "competencia_por_data_do_lancamento: sobras que caem na fatura M+2 ficam fora",
  ];
  const base = {
    compativel,
    motivoIncompativel,
    subtiposExcluidos: SUBTIPOS_FRETE_FULL_EXCLUIDOS,
    limitacoes,
    cobertura: porMes.map((f) => (f.faltando ? { mes: f.mes, estado: "sem_fonte" } : { mes: f.mes, estado: f.disponivel === false ? "indisponivel" : (f.definitivo ? "consolidado" : "observado_faturas_abertas"), codigo: f.codigo || null, consultadoEm: f.consultadoEm ?? null })),
  };
  if (faltando.length) {
    // Sem fonte ⇒ indisponível, mesmo sem venda Full no período: a armazenagem é
    // cobrada pelo estoque parado, não pela venda.
    return { ...base, disponivel: false, estado: "indisponivel", codigos: [...new Set(faltando.map((f) => f.codigo || "SEM_FONTE"))], total: { centavos: null }, componentes: null };
  }
  const componentes = GRUPOS_FULL.map((grupo) => {
    let centavos = 0;
    let lancamentos = 0;
    for (const f of porMes) {
      const g = (f.componentes || []).find((x) => x.grupo === grupo);
      if (g) { centavos += cent(g.valor) || 0; lancamentos += Number(g.lancamentos) || 0; }
    }
    return { grupo, centavos, lancamentos };
  });
  const total = componentes.reduce((s, x) => s + x.centavos, 0);
  const consolidado = porMes.every((f) => f.definitivo === true);
  return { ...base, disponivel: true, estado: total === 0 ? "zero_observado" : consolidado ? "consolidado" : "observado_faturas_abertas", total: { centavos: total }, componentes };
}

// ─── Resultado operacional ─────────────────────────────────────────────────────────────
function resultadoOperacional({ periodo, clienteContaId, resultadoVendaCentavos, receitaProdutoCentavos, fontesAds, fontesFull }) {
  const ads = avaliarAds({ periodo, clienteContaId, fontesAds, receitaProdutoCentavos });
  const full = avaliarFull({ periodo, clienteContaId, fontesFull });
  const pend = [];
  if (!ads.disponivel) pend.push("ads_indisponivel");
  else if (!ads.compativel) pend.push(`ads_${ads.motivoIncompativel}`);
  if (!full.disponivel) pend.push("full_indisponivel");
  else if (full.disponivel && !full.compativel) pend.push(`full_${full.motivoIncompativel}`);

  const adsC = ads.disponivel && ads.compativel ? ads.investimento.centavos : null;
  const fullC = full.disponivel && full.compativel ? full.total.centavos : null;
  const margem = (v) => (v !== null && receitaProdutoCentavos > 0 ? Math.round((v / receitaProdutoCentavos) * 10000) / 100 : null);
  const aposAds = resultadoVendaCentavos !== null && adsC !== null ? resultadoVendaCentavos - adsC : null;
  const aposAdsEFull = aposAds !== null && fullC !== null ? aposAds - fullC : null;
  return {
    contrato: CONTRATO_VERSAO,
    periodo,
    clienteContaId,
    ads,
    full,
    resultadoVenda: { centavos: resultadoVendaCentavos, margemPercentual: margem(resultadoVendaCentavos) },
    resultadoAposAds: { centavos: aposAds, margemPercentual: margem(aposAds) },
    resultadoOperacional: { centavos: aposAdsEFull, margemPercentual: margem(aposAdsEFull) },
    denominador: "receita de produtos da Central (pedidos no resultado), mesma conta e período",
    pendencias: pend,
  };
}

// Adaptadores das linhas de cache do Financeiro (formato de linhaParaResposta).
function fonteAdsDoCacheFinanceiro(row, { clienteContaId, mes, agora = new Date() }) {
  if (!row || row.disponivel === false) return { escopo: "conta", clienteContaId, cobertura: { tipo: "mes", mes }, disponivel: false, codigo: row?.codigo || "SEM_FONTE" };
  const consolidaEm = new Date(Date.UTC(Number(mes.slice(0, 4)), Number(mes.slice(5, 7)), 4));
  return {
    escopo: "conta", clienteContaId, cobertura: { tipo: "mes", mes }, disponivel: true,
    investimentoAds: row.investimentoAds, gmvAds: row.gmvAds, consultadoEm: row.consultadoEm,
    consolidado: row.consultadoEm ? new Date(row.consultadoEm) >= consolidaEm : agora >= consolidaEm,
  };
}

// Linhas cruas dos caches do Financeiro (financeiro_ads_cache / _full_cache,
// valores como texto do NUMERIC) → fontes do contrato. Só da conta pedida.
function fontesDosCachesDoFinanceiro({ ads = [], full = [] }, clienteContaId) {
  const iso = (v) => (v ? new Date(v).toISOString() : null);
  return {
    fontesAds: ads.map((row) => fonteAdsDoCacheFinanceiro({
      disponivel: true, investimentoAds: Number(row.investimento_ads), gmvAds: Number(row.gmv_ads), consultadoEm: iso(row.consultado_em),
    }, { clienteContaId, mes: row.mes_ref })),
    fontesFull: full.map((row) => ({
      clienteContaId, mes: row.mes_ref, disponivel: true, definitivo: row.definitivo === true,
      componentes: typeof row.componentes === "string" ? JSON.parse(row.componentes) : row.componentes || [],
      consultadoEm: iso(row.consultado_em),
    })),
  };
}

module.exports = {
  CONTRATO_VERSAO,
  fontesDosCachesDoFinanceiro,
  GRUPOS_FULL,
  SUBTIPOS_FRETE_FULL_EXCLUIDOS,
  mesesDoPeriodo,
  cobreMesesInteiros,
  cobreOMesInteiro,
  avaliarAds,
  avaliarFull,
  resultadoOperacional,
  fonteAdsDoCacheFinanceiro,
};
