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

/** Última troca de preço na série de vendas (diferença ≥ 1% entre vendas consecutivas). */
function ultimaTrocaNasVendas(precos) {
  const s = (precos || []).filter((p) => num(p.preco) !== null);
  for (let i = s.length - 1; i > 0; i--) {
    const a = num(s[i - 1].preco), b = num(s[i].preco);
    if (Math.abs(b - a) / a >= 0.01) return { em: `${s[i].data}T00:00:00.000Z`, de: a, para: b };
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
function montarHistoricoItem({ eventos = [], snapshot = null, sync = null, aoVivo = null, relatorios = [], vendas = null, agora = new Date(), janelaDias = JANELA_RECENTE_DIAS } = {}) {
  const fontes = [];
  const linha = [];
  const evs = (eventos || []).map((e) => ({ ...e, em: iso(e.em) })).filter((e) => e.em);
  if (evs.length) fontes.push("eventos_venforce");
  for (const e of evs) linha.push({ em: e.em, preco: e.precoNovo ?? null, fonte: e.fonte, tipo: e.tipo, descricao: e.descricao, alteraPreco: Boolean(e.alteraPreco) });

  const pontos = [];
  if (snapshot && num(snapshot.preco) !== null && iso(snapshot.em)) { fontes.push("snapshot_motor"); pontos.push({ em: iso(snapshot.em), preco: num(snapshot.preco), fonte: "margin_projection_snapshots" }); }
  if (sync && num(sync.preco) !== null && iso(sync.em)) { fontes.push("cadastro_sincronizado"); pontos.push({ em: iso(sync.em), preco: num(sync.preco), fonte: "meli_anuncios" }); }
  for (const r of relatorios || []) if (num(r.preco) !== null && iso(r.em)) { if (!fontes.includes("relatorios_salvos")) fontes.push("relatorios_salvos"); pontos.push({ em: iso(r.em), preco: num(r.preco), fonte: "relatorio_itens" }); }
  if (aoVivo && num(aoVivo.preco) !== null && iso(aoVivo.em)) { fontes.push("mercado_livre_ao_vivo"); pontos.push({ em: iso(aoVivo.em), preco: num(aoVivo.preco), fonte: "sale_price (ao vivo)" }); }
  const trocaVendas = vendas ? ultimaTrocaNasVendas(vendas.precos) : null;
  if (vendas && vendas.precos && vendas.precos.length) fontes.push("vendas_reais");

  pontos.sort((a, b) => (a.em < b.em ? -1 : 1));
  for (const p of pontos) linha.push({ ...p, tipo: "preco_observado", alteraPreco: false });

  // Mudança detectada entre observações (sem dizer quem mudou).
  let mudanca = null;
  for (let i = pontos.length - 1; i > 0; i--) {
    if (diff(pontos[i].preco, pontos[i - 1].preco)) {
      mudanca = { em: pontos[i].em, entre: [pontos[i - 1].em, pontos[i].em], de: pontos[i - 1].preco, para: pontos[i].preco, fonte: `${pontos[i - 1].fonte} → ${pontos[i].fonte}`,
        descricao: `Preço observado mudou de R$ ${pontos[i - 1].preco.toFixed(2)} (${pontos[i - 1].fonte}, ${pontos[i - 1].em.slice(0, 10)}) para R$ ${pontos[i].preco.toFixed(2)} (${pontos[i].fonte}, ${pontos[i].em.slice(0, 10)}).` };
      break;
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
