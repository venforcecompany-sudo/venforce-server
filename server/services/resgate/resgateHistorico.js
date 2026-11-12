// server/services/resgate/resgateHistorico.js
//
// Reconstrução do histórico de preço de UM anúncio a partir das fontes que
// EXISTEM (puro; as leituras ficam no repositório). Nunca inventa histórico:
// cada afirmação cita a fonte e o horário. Fontes, por ordem de força:
//   1. eventos do VenForce (activity_logs: rebate/transferência/alteração
//      manual; margem_precificacao_aplicacoes: Central de Margem);
//   2. Prices API do ML (GET /items/{id}/prices → last_updated do preço padrão);
//   3. preço visto em momentos diferentes: snapshot do Motor (calculated_at),
//      cadastro sincronizado (meli_anuncios.last_synced_at), leitura ao vivo,
//      relatórios salvos (Automações);
//   4. preço unitário das vendas reais (Central de Vendas).
// Ressalva permanente: até esta versão, o PUT de preço de /anuncios NÃO gravava
// log — "sem alteração registrada" nunca significa "nunca alterado".

const JANELA_RECENTE_DIAS = 14;
const TOLERANCIA_PRECO = 0.01; // R$

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function iso(v) {
  if (!v) return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
function diff(a, b) { return a !== null && b !== null && Math.abs(a - b) >= TOLERANCIA_PRECO; }

/**
 * Troca de REGIME no preço vendido: as 2 vendas mais recentes num preço e as 2
 * anteriores noutro (≥ 1%). Variação de uma venda isolada (cupom, promoção
 * relâmpago) não conta.
 */
function ultimaTrocaNasVendas(precos) {
  const s = (precos || []).filter((p) => num(p.preco) !== null);
  for (let i = s.length - 2; i >= 2; i--) {
    const novo = num(s[i].preco), novo2 = num(s[i + 1].preco), velho = num(s[i - 1].preco), velho2 = num(s[i - 2].preco);
    if (Math.abs(novo - novo2) < TOLERANCIA_PRECO && Math.abs(velho - velho2) < TOLERANCIA_PRECO && Math.abs(novo - velho) / velho >= 0.01) {
      return { em: `${s[i].data}T00:00:00.000Z`, de: velho, para: novo };
    }
  }
  return null;
}

/**
 * @param {object} p
 *  eventos[]          eventos do VenForce (repositório.eventosDePreco)
 *  snapshot           { preco, em }
 *  sync               { preco, em }
 *  aoVivo             { preco, em, precoBaseAtualizadoEm }   (tier 2; opcional)
 *  relatorios[]       { em, preco }
 *  vendas             { precos:[{data, preco}] }
 *  agora              Date
 */
function montarHistoricoItem({ eventos = [], snapshot = null, sync = null, aoVivo = null, relatorios = [], vendas = null, promocaoAtiva = false, agora = new Date(), janelaDias = JANELA_RECENTE_DIAS } = {}) {
  const fontes = [];
  const linha = [];
  const evs = (eventos || []).map((e) => ({ ...e, em: iso(e.em) })).filter((e) => e.em);
  if (evs.length) fontes.push("eventos_venforce");
  for (const e of evs) linha.push({ em: e.em, preco: e.precoNovo ?? null, fonte: e.fonte, tipo: e.tipo, descricao: e.descricao, alteraPreco: Boolean(e.alteraPreco) });

  // Duas séries que NÃO se comparam entre si: preço EFETIVO (o que o comprador paga,
  // sale_price — muda com promoção) e preço CHEIO/de cadastro (preço base do anúncio).
  const pontos = [];
  const ponto = (serie, preco, em, fonte, rotulo) => { if (num(preco) !== null && iso(em)) pontos.push({ serie, em: iso(em), preco: num(preco), fonte, rotulo }); };
  if (snapshot) { ponto("efetivo", snapshot.preco, snapshot.em, "margin_projection_snapshots", "preço efetivo no snapshot"); ponto("cheio", snapshot.precoCheio, snapshot.em, "margin_projection_snapshots", "preço cheio no snapshot"); if (num(snapshot.preco) !== null) fontes.push("snapshot_motor"); }
  if (sync && num(sync.preco) !== null) { ponto("cheio", sync.preco, sync.em, "meli_anuncios", "preço de cadastro sincronizado"); fontes.push("cadastro_sincronizado"); }
  for (const r of relatorios || []) if (num(r.preco) !== null && iso(r.em)) { if (!fontes.includes("relatorios_salvos")) fontes.push("relatorios_salvos"); ponto("efetivo", r.preco, r.em, "relatorio_itens", "preço efetivo em relatório salvo"); }
  if (aoVivo && num(aoVivo.preco) !== null) { fontes.push("mercado_livre_ao_vivo"); ponto("efetivo", aoVivo.preco, aoVivo.em, "sale_price (ao vivo)", "preço efetivo ao vivo"); ponto("cheio", aoVivo.precoCheio, aoVivo.em, "sale_price (ao vivo)", "preço cheio ao vivo"); }
  // Com promoção em andamento, o preço vendido oscila por desenho: não vira sinal de mudança.
  const trocaVendas = vendas && !promocaoAtiva ? ultimaTrocaNasVendas(vendas.precos) : null;
  if (vendas && vendas.precos && vendas.precos.length) fontes.push("vendas_reais");

  pontos.sort((a, b) => (a.em < b.em ? -1 : 1));
  for (const p of pontos) linha.push({ em: p.em, preco: p.preco, fonte: p.fonte, tipo: "preco_observado", serie: p.serie, descricao: p.rotulo, alteraPreco: false });

  // Mudança detectada entre observações DA MESMA SÉRIE (sem dizer quem mudou).
  let mudanca = null;
  for (const serie of ["efetivo", "cheio"]) {
    const ps = pontos.filter((p) => p.serie === serie);
    for (let i = ps.length - 1; i > 0; i--) {
      if (diff(ps[i].preco, ps[i - 1].preco)) {
        const m = { em: ps[i].em, serie, entre: [ps[i - 1].em, ps[i].em], de: ps[i - 1].preco, para: ps[i].preco, fonte: `${ps[i - 1].fonte} → ${ps[i].fonte}`,
          descricao: `${serie === "efetivo" ? "Preço efetivo" : "Preço cheio"} mudou de R$ ${ps[i - 1].preco.toFixed(2)} (${ps[i - 1].fonte}, ${ps[i - 1].em.slice(0, 10)}) para R$ ${ps[i].preco.toFixed(2)} (${ps[i].fonte}, ${ps[i].em.slice(0, 10)}).` };
        if (!mudanca || m.em > mudanca.em) mudanca = m;
        break;
      }
    }
  }
  const precoBaseEm = aoVivo ? iso(aoVivo.precoBaseAtualizadoEm) : null;
  if (precoBaseEm) linha.push({ em: precoBaseEm, preco: null, fonte: "items/{id}/prices.last_updated", tipo: "preco_base_atualizado_ml", alteraPreco: false, descricao: "Mercado Livre informa atualização do preço padrão" });
  if (trocaVendas) linha.push({ em: trocaVendas.em, preco: trocaVendas.para, fonte: "central_vendas (preço unitário)", tipo: "troca_preco_vendas", alteraPreco: false, descricao: `Preço vendido mudou de R$ ${trocaVendas.de.toFixed(2)} para R$ ${trocaVendas.para.toFixed(2)}` });
  linha.sort((a, b) => (a.em < b.em ? -1 : 1));

  // Data mais recente com sinal de mudança (qualquer fonte), para priorizar.
  const sinais = [
    ...evs.filter((e) => e.alteraPreco).map((e) => e.em),
    mudanca ? mudanca.em : null, precoBaseEm, trocaVendas ? trocaVendas.em : null,
  ].filter(Boolean).sort();
  const ultimaMudancaEm = sinais.length ? sinais[sinais.length - 1] : null;
  const recente = ultimaMudancaEm ? (agora.getTime() - Date.parse(ultimaMudancaEm)) <= janelaDias * 86400000 : false;

  // Mudança observada sem evento VenForce que a explique → origem indeterminada.
  let mudancaDetectada = null;
  if (mudanca) {
    const explicada = evs.some((e) => e.alteraPreco && e.precoNovo !== null && Math.abs(e.precoNovo - mudanca.para) < TOLERANCIA_PRECO && e.em <= mudanca.entre[1]);
    if (!explicada) mudancaDetectada = mudanca;
  } else if (precoBaseEm && !evs.some((e) => e.alteraPreco)) {
    const dias = (agora.getTime() - Date.parse(precoBaseEm)) / 86400000;
    if (dias <= janelaDias) mudancaDetectada = { em: precoBaseEm, fonte: "items/{id}/prices", descricao: `Mercado Livre registra atualização do preço padrão em ${precoBaseEm.slice(0, 10)}, sem evento do VenForce.` };
  }

  return {
    fontesConsultadas: [...new Set(fontes)],
    eventos: evs,
    linhaDoTempo: linha,
    mudancaDetectada,
    ultimaMudancaEm,
    mudancaRecente: recente,
    trocaNasVendas: trocaVendas,
    ressalvaSemLogManual: true,
  };
}

module.exports = { montarHistoricoItem, ultimaTrocaNasVendas, JANELA_RECENTE_DIAS };
