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

const CONTRATO_VERSAO = 2;
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

// ─── Segmentos e situação ───────────────────────────────────────────────────────────────
// O período é partido por mês: cada pedaço precisa de UMA fonte que o cubra
// exatamente — uma janela com as mesmas datas, ou a fonte mensal quando o
// pedaço é o mês inteiro. Situação de cada pedaço (e do todo):
//   consolidado   fonte consultada depois do mês consolidar (regra do Financeiro:
//                 fim do mês + 3 dias; Full: faturas fechadas)
//   provisorio    cobre exatamente a janela, mas o ML ainda pode mudar o valor
//   incompativel  há valor, mas de outra janela (mostrado só como referência)
//   indisponivel  sem fonte
const SITUACAO_ORDEM = { consolidado: 3, provisorio: 2, incompativel: 1, indisponivel: 0 };

function segmentosDoPeriodo(dateFrom, dateTo) {
  return mesesDoPeriodo(dateFrom, dateTo).map((mes) => {
    const ini = `${mes}-01`;
    const fim = `${mes}-${String(ultimoDia(mes)).padStart(2, "0")}`;
    const de = dateFrom > ini ? dateFrom : ini;
    const ate = dateTo < fim ? dateTo : fim;
    return { mes, dateFrom: de, dateTo: ate, mesInteiro: de === ini && ate === fim };
  });
}

// Instante em que o Financeiro considera o mês de Ads consolidado (financeiroAdsService).
function consolidacaoAds(mes) {
  const [a, m] = mes.split("-").map(Number);
  return Date.UTC(a, m, 4);
}

const consultadoDepois = (consultadoEm, t) => {
  const c = consultadoEm ? new Date(consultadoEm).getTime() : NaN;
  return Number.isFinite(c) && c >= t;
};

function situacaoAds(seg, f) {
  if (!f) return { situacao: "indisponivel", codigo: "SEM_FONTE" };
  if (f.disponivel === false) return { situacao: "indisponivel", codigo: f.codigo || "SEM_FONTE" };
  const consolidado = consultadoDepois(f.consultadoEm, consolidacaoAds(seg.mes));
  if (f.cobertura?.tipo === "janela") return { situacao: consolidado ? "consolidado" : "provisorio" };
  if (!seg.mesInteiro) return { situacao: "incompativel", motivo: "periodo_parcial_com_fonte_mensal" };
  if (!cobreOMesInteiro(f.consultadoEm, seg.mes)) return { situacao: "incompativel", motivo: "fonte_consultada_antes_do_fim_do_mes" };
  return { situacao: consolidado || f.consolidado === true ? "consolidado" : "provisorio" };
}

function situacaoGeral(pedacos) {
  if (pedacos.some((p) => p.situacao === "indisponivel")) return "indisponivel";
  if (pedacos.some((p) => p.situacao === "incompativel")) return "incompativel";
  return pedacos.every((p) => p.situacao === "consolidado") ? "consolidado" : "provisorio";
}

// ─── Ads ────────────────────────────────────────────────────────────────────────────────
// fontesAds: lista de { escopo: "conta"|"cliente", clienteContaId, cobertura: {tipo:"mes", mes} | {tipo:"janela", dateFrom, dateTo},
//   disponivel, codigo?, investimentoAds, gmvAds, gmvDireto?, gmvIndireto?, consultadoEm?, consolidado?, anuncios?, origem? }
function avaliarAds({ periodo, clienteContaId, fontesAds = [], receitaProdutoCentavos }) {
  const doEscopo = fontesAds.filter((f) => f && f.escopo === "conta" && Number(f.clienteContaId) === Number(clienteContaId));
  const recusadas = fontesAds.filter((f) => f && !(f.escopo === "conta" && Number(f.clienteContaId) === Number(clienteContaId)))
    .map((f) => ({ motivo: f.escopo === "cliente" ? "escopo_cliente_nao_e_da_conta" : "outra_conta", escopo: f.escopo, clienteContaId: f.clienteContaId ?? null }));

  // Janela exata do período inteiro (mesmo atravessando meses) vale como um pedaço só.
  const janelaTotal = doEscopo.find((f) => f.cobertura?.tipo === "janela" && f.cobertura.dateFrom === periodo.dateFrom && f.cobertura.dateTo === periodo.dateTo);
  const segs = janelaTotal
    ? [{ mes: periodo.dateTo.slice(0, 7), dateFrom: periodo.dateFrom, dateTo: periodo.dateTo, mesInteiro: false }]
    : segmentosDoPeriodo(periodo.dateFrom, periodo.dateTo);
  const pedacos = segs.map((seg) => {
    const candidatas = janelaTotal ? [janelaTotal] : doEscopo.filter((f) => (f.cobertura?.tipo === "janela" && f.cobertura.dateFrom === seg.dateFrom && f.cobertura.dateTo === seg.dateTo)
      || (f.cobertura?.tipo === "mes" && f.cobertura.mes === seg.mes));
    let melhor = { seg, fonte: null, ...situacaoAds(seg, null) };
    for (const f of candidatas) {
      const s = situacaoAds(seg, f);
      if (!melhor.fonte || SITUACAO_ORDEM[s.situacao] > SITUACAO_ORDEM[melhor.situacao]) melhor = { seg, fonte: f, ...s };
    }
    return melhor;
  });
  const situacao = situacaoGeral(pedacos);
  const disponivel = situacao !== "indisponivel";
  const compativel = situacao === "consolidado" || situacao === "provisorio";
  const motivoIncompativel = compativel ? null : (pedacos.find((p) => p.motivo)?.motivo || null);
  const base = {
    disponivel,
    compativel,
    situacao,
    motivoIncompativel,
    cobertura: pedacos.map((p) => (p.fonte
      ? { mes: p.seg.mes, dateFrom: p.seg.dateFrom, dateTo: p.seg.dateTo, tipoFonte: p.fonte.cobertura?.tipo || null, origem: p.fonte.origem || (p.fonte.cobertura?.tipo === "mes" ? "financeiro_ads_cache" : null),
          estado: p.fonte.disponivel === false ? "indisponivel" : "ok", situacao: p.situacao, codigo: p.codigo || p.fonte.codigo || null,
          consolidado: p.situacao === "consolidado", consultadoEm: p.fonte.consultadoEm ?? null }
      : { mes: p.seg.mes, dateFrom: p.seg.dateFrom, dateTo: p.seg.dateTo, estado: "sem_fonte", situacao: "indisponivel" })),
    recusadas,
  };
  if (!disponivel) {
    return { ...base, estado: "indisponivel", codigos: [...new Set(pedacos.filter((p) => p.situacao === "indisponivel").map((p) => p.codigo || "SEM_FONTE"))], investimento: { centavos: null }, receitaAtribuida: { centavos: null }, metricas: null, produtos: null };
  }
  const usadas = pedacos.map((p) => p.fonte);
  const soma = (campo) => usadas.reduce((s, u) => (s === null || cent(u[campo]) === null ? null : s + cent(u[campo])), 0);
  const investimento = soma("investimentoAds");
  const receitaAtribuida = soma("gmvAds");
  const direta = soma("gmvDireto");
  const indireta = soma("gmvIndireto");
  const estado = investimento === 0 ? "zero_observado" : "observado";
  const metricas = {
    roas: metrica(receitaAtribuida, investimento, { nomeNum: "receita atribuída pelo Mercado Ads", nomeDen: "investimento em Ads" }),
    acos: metrica(investimento, receitaAtribuida, { escala: 100, nomeNum: "investimento em Ads", nomeDen: "receita atribuída pelo Mercado Ads" }),
    // TACOS só com o MESMO período: com fonte de outra janela o denominador não corresponde.
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
// Só existe fonte MENSAL (faturas do Billing): pedaço que não é o mês inteiro ⇒ incompatível.
function avaliarFull({ periodo, clienteContaId, fontesFull = [] }) {
  const doEscopo = fontesFull.filter((f) => f && Number(f.clienteContaId) === Number(clienteContaId));
  const pedacos = segmentosDoPeriodo(periodo.dateFrom, periodo.dateTo).map((seg) => {
    const f = doEscopo.find((x) => x.mes === seg.mes) || null;
    if (!f) return { seg, f, situacao: "indisponivel", codigo: "SEM_FONTE" };
    if (f.disponivel === false) return { seg, f, situacao: "indisponivel", codigo: f.codigo || "SEM_FONTE" };
    if (!seg.mesInteiro) return { seg, f, situacao: "incompativel", motivo: "periodo_parcial_com_fonte_mensal" };
    if (!cobreOMesInteiro(f.consultadoEm, seg.mes)) return { seg, f, situacao: "incompativel", motivo: "fonte_consultada_antes_do_fim_do_mes" };
    return { seg, f, situacao: f.definitivo === true ? "consolidado" : "provisorio" };
  });
  const situacao = situacaoGeral(pedacos);
  const compativel = situacao === "consolidado" || situacao === "provisorio";
  const motivoIncompativel = compativel ? null : (pedacos.find((p) => p.motivo)?.motivo || null);
  const limitacoes = [
    "estornos_nao_abatidos: só lançamentos CHARGE entram; um estorno (BONUS) de armazenagem não é descontado",
    "frete_full_excluido: CFFE/CFFI ficam de fora porque já estão no frete_seller de cada venda",
    "competencia_por_data_do_lancamento: sobras que caem na fatura M+2 ficam fora",
    "sem_janela_parcial: o Billing do Full só existe por mês no Financeiro; mês aberto ⇒ Full fora do resultado",
  ];
  const base = {
    compativel,
    situacao,
    motivoIncompativel,
    subtiposExcluidos: SUBTIPOS_FRETE_FULL_EXCLUIDOS,
    limitacoes,
    cobertura: pedacos.map((p) => (!p.f ? { mes: p.seg.mes, estado: "sem_fonte", situacao: "indisponivel" }
      : { mes: p.seg.mes, estado: p.f.disponivel === false ? "indisponivel" : (p.f.definitivo ? "consolidado" : "observado_faturas_abertas"), situacao: p.situacao, codigo: p.codigo || p.f.codigo || null, consultadoEm: p.f.consultadoEm ?? null })),
  };
  if (situacao === "indisponivel") {
    // Sem fonte ⇒ indisponível, mesmo sem venda Full no período: a armazenagem é
    // cobrada pelo estoque parado, não pela venda.
    return { ...base, disponivel: false, estado: "indisponivel", codigos: [...new Set(pedacos.filter((p) => p.situacao === "indisponivel").map((p) => p.codigo))], total: { centavos: null }, componentes: null };
  }
  const componentes = GRUPOS_FULL.map((grupo) => {
    let centavos = 0;
    let lancamentos = 0;
    for (const { f } of pedacos) {
      const g = (f.componentes || []).find((x) => x.grupo === grupo);
      if (g) { centavos += cent(g.valor) || 0; lancamentos += Number(g.lancamentos) || 0; }
    }
    return { grupo, centavos, lancamentos };
  });
  const total = componentes.reduce((s, x) => s + x.centavos, 0);
  const consolidado = pedacos.every((p) => p.f.definitivo === true);
  return { ...base, disponivel: true, estado: total === 0 ? "zero_observado" : consolidado ? "consolidado" : "observado_faturas_abertas", total: { centavos: total }, componentes };
}

// ─── Resultado operacional ─────────────────────────────────────────────────────────────
// estado do resultado depois de Ads e Full:
//   consolidado   Ads e Full cobrem o período e nenhum valor muda mais
//   provisorio    Ads e Full cobrem exatamente o período, mas algum ainda pode mudar
//   parcial       só um dos dois cobre o período: `resultadoParcial` desconta SÓ o
//                 que tem fonte e diz o que faltou (nunca trata o que falta como zero);
//                 `resultadoOperacional` continua null
//   indisponivel  nenhum dos dois cobre o período
function resultadoOperacional({ periodo, clienteContaId, resultadoVendaCentavos, receitaProdutoCentavos, fontesAds, fontesFull, periodoSelecionado = null }) {
  const ads = avaliarAds({ periodo, clienteContaId, fontesAds, receitaProdutoCentavos });
  const full = avaliarFull({ periodo, clienteContaId, fontesFull });
  const pend = [];
  if (!ads.disponivel) pend.push("ads_indisponivel");
  else if (!ads.compativel) pend.push(`ads_${ads.motivoIncompativel}`);
  if (!full.disponivel) pend.push("full_indisponivel");
  else if (full.disponivel && !full.compativel) pend.push(`full_${full.motivoIncompativel}`);

  const adsOk = ads.disponivel && ads.compativel;
  const fullOk = full.disponivel && full.compativel;
  const adsC = adsOk ? ads.investimento.centavos : null;
  const fullC = fullOk ? full.total.centavos : null;
  const margem = (v) => (v !== null && receitaProdutoCentavos > 0 ? Math.round((v / receitaProdutoCentavos) * 10000) / 100 : null);
  const aposAds = resultadoVendaCentavos !== null && adsC !== null ? resultadoVendaCentavos - adsC : null;
  const aposAdsEFull = aposAds !== null && fullC !== null ? aposAds - fullC : null;
  const estado = adsOk && fullOk
    ? (ads.situacao === "consolidado" && full.situacao === "consolidado" ? "consolidado" : "provisorio")
    : (adsOk || fullOk) ? "parcial" : "indisponivel";
  let resultadoParcial = null;
  if (estado === "parcial" && resultadoVendaCentavos !== null && (adsOk ? adsC !== null : fullC !== null)) {
    const c = resultadoVendaCentavos - (adsOk ? adsC : 0) - (fullOk ? fullC : 0);
    resultadoParcial = { centavos: c, margemPercentual: margem(c), incluidos: [adsOk ? "ads" : null, fullOk ? "full" : null].filter(Boolean), faltando: [adsOk ? null : "ads", fullOk ? null : "full"].filter(Boolean) };
  }
  return {
    contrato: CONTRATO_VERSAO,
    periodo,
    periodoSelecionado: periodoSelecionado || periodo,
    clienteContaId,
    estado,
    ads,
    full,
    resultadoVenda: { centavos: resultadoVendaCentavos, margemPercentual: margem(resultadoVendaCentavos) },
    resultadoAposAds: { centavos: aposAds, margemPercentual: margem(aposAds) },
    resultadoOperacional: { centavos: aposAdsEFull, margemPercentual: margem(aposAdsEFull) },
    resultadoParcial,
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
  segmentosDoPeriodo,
  consolidacaoAds,
  avaliarAds,
  avaliarFull,
  resultadoOperacional,
  fonteAdsDoCacheFinanceiro,
};
