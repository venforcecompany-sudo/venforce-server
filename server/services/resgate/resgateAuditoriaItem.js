// server/services/resgate/resgateAuditoriaItem.js
//
// Auditoria de UM anúncio: monta o contrato (do snapshot e, quando houver, da
// leitura ao vivo), reconstrói o histórico, compara com o realizado, classifica,
// estima exposição/prioridade e — só com entradas essenciais conhecidas e
// cotação ao vivo — recomenda preço. Puro, exceto pelo `cotarEmPreco` injetado.

const { montarContratoFinanceiro } = require("./resgateContrato");
const { compararComRealizado, familiaLogistica } = require("./resgateEvidencias");
const { montarHistoricoItem } = require("./resgateHistorico");
const { classificarOrigem, classificarSituacao, exposicao, prioridade, SITUACAO, ACAO } = require("./resgateClassificacao");
const { recomendarPreco } = require("./resgateRecomendacao");

const VERSAO_AUDITORIA = "resgate-auditoria/1";

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function iso(v) { if (!v) return null; const t = v instanceof Date ? v.getTime() : Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : null; }
function jsonOuNull(v) { if (v === null || v === undefined) return null; if (typeof v === "object") return v; try { return JSON.parse(v); } catch (_) { return null; } }

/** Entrada do contrato a partir da linha do snapshot (paginaItens). */
function entradaDoSnapshot(row, conta, { contaLiberada = false } = {}) {
  const fq = jsonOuNull(row.frete_qualidade);
  const fqObj = fq && typeof fq === "object" ? fq : null;
  const em = iso(row.calculated_at);
  const logistic = row.logistic_type ?? row.logistic_type_snapshot ?? undefined;
  return {
    conta,
    anuncio: { itemId: row.item_id, sku: row.sku, titulo: row.titulo, status: row.status_anuncio || row.status_anuncio_snapshot || null, logisticType: logistic === null ? undefined : logistic, listingTypeId: row.listing_type_id || null },
    precos: { cheio: num(row.list_price), vigente: num(row.price), promocional: num(row.promo_price), fonte: "snapshot do Motor (sale_price)", observadoEm: em },
    // Promo Snapshot por conta: quando não há leitura, o subsídio fica desconhecido (nunca 0).
    promocao: row._promocao || (num(row.promo_price) !== null ? { ativa: true, subsidioMl: null, indisponivel: "promo_snapshot_sem_dados" } : { ativa: false }),
    comissao: { valor: num(row.commission), percentual: num(row.commission_rate), precoBase: num(row.price), fonte: "snapshot (listing_prices)", observadoEm: em },
    frete: { valor: num(row.freight), freteQualidade: fqObj, observadoEm: em, motivo: num(row.freight) === null ? "frete_ausente_no_snapshot" : null },
    custo: { valor: num(row.cost), fonte: num(row.cost) !== null ? "base de custos (gravada no snapshot)" : null, observadoEm: em },
    imposto: { percentual: num(row.tax_rate), fonte: num(row.tax_rate) !== null ? "base de custos (gravada no snapshot)" : null, observadoEm: em },
    taxaFixa: { valor: num(row.fixed_fee), fonte: num(row.fixed_fee) !== null ? "base de custos (gravada no snapshot)" : null, observadoEm: em },
    // Linha anterior à avaliação numa conta liberada: frete possivelmente subestimado.
    legadoNaoVerificado: contaLiberada && !fqObj && num(row.freight) !== null,
  };
}

/** Entrada a partir da leitura ao vivo + custos do snapshot (a base não muda com o ML). */
function entradaAoVivo(vivo, row, conta) {
  const base = entradaDoSnapshot(row, conta);
  const c = vivo.cotacao || {};
  return {
    ...base,
    anuncio: { ...base.anuncio, ...vivo.anuncio, logisticType: vivo.anuncio.logisticType === null ? undefined : vivo.anuncio.logisticType },
    precos: { ...vivo.precos, fonte: `ao vivo (${vivo.precos.fonte})` },
    promocao: vivo.promocao,
    comissao: { valor: num(c.comissaoValor), percentual: num(c.comissaoPercentual), precoBase: num(vivo.precos.vigente), fonte: "listing_prices (ao vivo)", observadoEm: c.observadoEm, motivo: c.diagnostico && c.diagnostico.comissao ? c.diagnostico.comissao.motivo : null },
    frete: { valor: num(c.fretePrevisto), freteQualidade: c.freteQualidade || null, observadoEm: c.observadoEm, motivo: c.diagnostico && c.diagnostico.frete ? c.diagnostico.frete.motivo : null },
    legadoNaoVerificado: false,
  };
}

/**
 * Quando não há leitura ao vivo: se as vendas reais comparáveis (≥3, ±3%,
 * dispersão ≤10% — a mesma régua do passo "custo cobrado" do cotador) mostram
 * frete MAIOR que o do snapshot, refaz o contrato com o frete cobrado.
 */
function contratoCorrigidoPeloRealizado(entrada, vendas) {
  const amostras = (vendas && vendas.amostras) || [];
  const preco = num(entrada.precos.vigente);
  if (preco === null) return null;
  const comp = amostras.filter((a) => Math.abs(a.precoUnitario - preco) <= preco * 0.03).map((a) => a.frete).sort((x, y) => x - y);
  if (comp.length < 3) return null;
  const med = comp.length % 2 ? comp[(comp.length - 1) / 2] : (comp[comp.length / 2 - 1] + comp[comp.length / 2]) / 2;
  if ((comp[comp.length - 1] - comp[0]) / med > 0.10) return null;
  const atual = num(entrada.frete.valor);
  if (atual !== null && med <= atual + Math.max(0.05, med * 0.05)) return null;
  const e = JSON.parse(JSON.stringify(entrada));
  e.frete = {
    valor: Math.round(med * 100) / 100,
    freteQualidade: { nivel: "estimado_custo_cobrado", confianca: "baixa", fonte: "central_vendas frete_seller (shipments_api), item único, preço ±3%", amostras: comp.length, cotacaoRejeitada: atual, avaliadoEm: new Date().toISOString() },
    observadoEm: new Date().toISOString(),
  };
  e.legadoNaoVerificado = false;
  return montarContratoFinanceiro(e);
}

/**
 * @param {object} p
 *  row, conta, contaLiberada, vendas (Map item → …), eventos, relatorios, meta {valor, origem},
 *  vivo (lerAnuncioAoVivo, opcional), agora, ttlHoras, limiteVariacao
 */
async function auditarItem({ row, conta, contaLiberada = false, vendas = null, eventos = [], relatorios = [], meta = null, vivo = null, agora = new Date(), ttlHoras = 48, limiteVariacao = 0.30 }) {
  const entradaSnap = entradaDoSnapshot(row, conta, { contaLiberada });
  const contratoSnapshot = montarContratoFinanceiro(entradaSnap);
  let contrato = contratoSnapshot;
  let fonteAvaliacao = "snapshot";
  let entradaAtual = entradaSnap;
  if (vivo && vivo.ok) {
    entradaAtual = entradaAoVivo(vivo, row, conta);
    contrato = montarContratoFinanceiro(entradaAtual);
    fonteAvaliacao = "ao_vivo";
  } else {
    const corrigido = contratoCorrigidoPeloRealizado(entradaSnap, vendas);
    if (corrigido) { contrato = corrigido; fonteAvaliacao = "snapshot_corrigido_pelo_realizado"; }
  }

  const historico = montarHistoricoItem({
    eventos, relatorios, vendas,
    snapshot: { preco: row.price, precoCheio: row.list_price, em: row.calculated_at },
    sync: { preco: row.preco_sync, em: row.last_synced_at },
    aoVivo: vivo && vivo.ok ? { preco: vivo.precos.vigente, precoCheio: vivo.precos.cheio, em: vivo.observadoEm, precoBaseAtualizadoEm: vivo.precoBaseAtualizadoEm } : null,
    promocaoAtiva: num(contrato.componentes.precoPromocional.valor) !== null || num(row.promo_price) !== null,
    agora,
  });
  const origem = classificarOrigem(historico);

  let comparacaoFrete = compararComRealizado({ projetado: contrato.componentes.frete.valor, realizados: (vendas && vendas.amostras) || [], preco: contrato.componentes.precoVigente.valor });
  // Frete do snapshot sem avaliação, mas que BATE com o cobrado em ≥2 vendas reais
  // comparáveis: verificado pelo realizado (confiança média), sem trocar o valor.
  if (fonteAvaliacao === "snapshot" && contrato.componentes.frete.status === "nao_verificado" && comparacaoFrete && comparacaoFrete.bate && comparacaoFrete.amostras >= 2 && !entradaSnap.legadoNaoVerificado) {
    const e = JSON.parse(JSON.stringify(entradaSnap));
    e.frete.freteQualidade = { nivel: "cotado_ml", confianca: "media", fonte: `cotação gravada conferida com ${comparacaoFrete.amostras} venda(s) real(is) a preço comparável`, verificadoPeloRealizado: true, avaliadoEm: agora.toISOString() };
    contrato = montarContratoFinanceiro(e);
    fonteAvaliacao = "snapshot_verificado_pelo_realizado";
    comparacaoFrete = compararComRealizado({ projetado: contrato.componentes.frete.valor, realizados: vendas.amostras, preco: contrato.componentes.precoVigente.valor });
  }
  const calcEm = Date.parse(row.calculated_at);
  const snapshotVelho = row.refresh_status !== "fresh" || !Number.isFinite(calcEm) || (agora.getTime() - calcEm) > ttlHoras * 3600000;
  const comparaComExibida = fonteAvaliacao === "ao_vivo" || fonteAvaliacao === "snapshot_corrigido_pelo_realizado";
  const margemExibida = comparaComExibida ? num(row.margin_percent) : null;
  const sit = classificarSituacao({ contrato, margemExibida, precoExibido: comparaComExibida ? num(row.price) : null, comparacaoFrete, snapshotVelho, meta });
  // Sem leitura ao vivo, o snapshot "é" a margem exibida: se a própria linha está bloqueada/legada, vira desconhecida.
  if (fonteAvaliacao === "snapshot" && entradaSnap.legadoNaoVerificado && contrato.resultado.calculavel && sit.situacao !== SITUACAO.DADOS_INSUFICIENTES) {
    sit.situacao = SITUACAO.MARGEM_DESCONHECIDA; sit.acao = ACAO.RECALCULAR_SNAPSHOT;
    sit.motivos = ["Snapshot gravado antes da correção do frete nesta conta: recalcular antes de decidir.", ...(sit.motivos || [])];
  }

  const v = vendas || {};
  const exp = exposicao({ contrato, situacao: sit.situacao, unidades30d: v.unidades ?? null, faturamento30d: v.faturamento ?? null, meta, margemExibida: sit.margemExibida ?? null });
  const prio = prioridade({ situacao: sit.situacao, origem: origem.origem, mudancaRecente: historico.mudancaRecente, unidades30d: v.unidades || 0, exposicaoValor: exp.valor, faturamento30d: v.faturamento ?? null });

  // Recomendação: só ao vivo (cotação no preço candidato) e só se a ação é revisar preço.
  let recomendacao = null;
  const restricoes = [];
  if (num(contrato.componentes.precoPromocional.valor) !== null) restricoes.push({ codigo: "PROMOCAO_ATIVA", texto: "Preço formado por promoção: alterar o preço base exige sair/ajustar a promoção." });
  const variacoes = vivo && vivo.ok ? vivo.anuncio.variacoes : num(row.variations_count);
  if (variacoes !== null && variacoes > 0) restricoes.push({ codigo: "ANUNCIO_COM_VARIACOES", texto: "Anúncio com variações: o preço é por variação (escrita em lote não suportada)." });
  if (sit.acao === ACAO.REVISAR_PRECO) {
    if (vivo && vivo.ok && typeof vivo.cotarEmPreco === "function" && meta && num(meta.valor) !== null) {
      recomendacao = await recomendarPreco(entradaAtual, { meta: num(meta.valor), cotarEmPreco: vivo.cotarEmPreco, limiteVariacao });
    } else {
      recomendacao = { ok: false, motivo: vivo ? "LEITURA_AO_VIVO_FALHOU" : "REQUER_COTACAO_AO_VIVO" };
    }
  }

  const precoVisto = num(contrato.componentes.precoVigente.valor);
  return {
    versao: VERSAO_AUDITORIA,
    clienteId: conta.clienteId, clienteContaId: conta.clienteContaId, sellerId: conta.sellerId ? String(conta.sellerId) : null,
    itemId: row.item_id, sku: contrato.anuncio.sku, titulo: contrato.anuncio.titulo, statusAnuncio: contrato.anuncio.status,
    logistica: contrato.anuncio.logisticType, familiaLogistica: familiaLogistica(contrato.anuncio.logisticType),
    fonteAvaliacao, avaliadoEm: agora.toISOString(),
    contrato, contratoSnapshot: fonteAvaliacao === "snapshot" ? null : contratoSnapshot,
    snapshot: { preco: num(row.price), margemConfiavelNaTela: num(row.margin_percent) !== null, margemPercent: num(row.margin_percent), frete: num(row.freight), calculadoEm: iso(row.calculated_at), refreshStatus: row.refresh_status, statusMotor: row.status_motor, ultimoErro: row.last_error ? String(row.last_error).slice(0, 200) : null },
    historico: { origem: origem.origem, motivo: origem.motivo, mudancaRecente: historico.mudancaRecente, ultimaMudancaEm: historico.ultimaMudancaEm, fontes: historico.fontesConsultadas, linhaDoTempo: historico.linhaDoTempo.slice(-12), ressalvaSemLogManual: historico.ressalvaSemLogManual },
    vendas30d: { unidades: v.unidades ?? 0, faturamento: v.faturamento ?? 0, ultimaVenda: v.ultimaVenda ?? null, amostrasFrete: (v.amostras || []).length },
    comparacaoFrete,
    situacao: sit.situacao, acao: sit.acao, motivos: sit.motivos || [],
    meta: meta ? { valor: num(meta.valor), origem: meta.origem || null } : null,
    exposicao: exp, prioridade: prio,
    recomendacao: recomendacao ? {
      ok: recomendacao.ok, motivo: recomendacao.motivo || null, preco: recomendacao.preco ?? null, variacao: recomendacao.variacao ?? null,
      acimaDoLimite: Boolean(recomendacao.acimaDoLimite), margemPercentApos: recomendacao.contrato && recomendacao.contrato.resultado ? recomendacao.contrato.resultado.margemPercent : null,
      lucroApos: recomendacao.contrato && recomendacao.contrato.resultado ? recomendacao.contrato.resultado.lucro : null,
      freteApos: recomendacao.contrato ? recomendacao.contrato.componentes.frete.valor : null, comissaoApos: recomendacao.contrato ? recomendacao.contrato.componentes.comissao.valor : null,
      trilha: recomendacao.trilha || [],
    } : null,
    restricoes,
    // Impressão digital da proposta: preço visto + horário. A revalidação antes de
    // qualquer escrita exige o MESMO preço; se mudou, a proposta é invalidada.
    fingerprint: { precoVisto, vistoEm: fonteAvaliacao === "ao_vivo" ? vivo.observadoEm : iso(row.calculated_at), fonte: fonteAvaliacao },
  };
}

module.exports = { auditarItem, entradaDoSnapshot, entradaAoVivo, contratoCorrigidoPeloRealizado, VERSAO_AUDITORIA };
