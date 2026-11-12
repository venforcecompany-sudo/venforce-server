// server/services/resgate/resgateCompatibilidade.js
//
// MATRIZ DE COMPATIBILIDADE por conta/seller (pura). Responde, com evidência:
//  · quais modalidades existem na conta;
//  · quais cotações batem com o que o ML cobrou em vendas reais comparáveis;
//  · quantos anúncios têm evidência suficiente para margem;
//  · quantos falham por limite/erro da API;
//  · quantos dependem do operador (custo, imposto, medidas);
//  · se a avaliação de frete pode ser LIBERADA com segurança para a conta.
// Nunca declara a conta validada sem comparações reais nas modalidades com volume.

const { CONFIANCA } = require("./resgateEvidencias");

const MIN_COMPARACOES_MODALIDADE = 5;
const CONCORDANCIA_VALIDA = 0.9;
const LIMITE_SUBESTIMADOS_DIVERGENTE = 0.2;
const LIMITE_SUBESTIMADOS_RESSALVA = 0.1;

const STATUS_MODALIDADE = Object.freeze({ VALIDADA: "VALIDADA", CONSERVADORA: "CONSERVADORA", INCONCLUSIVA: "INCONCLUSIVA", DIVERGENTE: "DIVERGENTE", SEM_EVIDENCIA: "SEM_EVIDENCIA", PARCIAL: "PARCIAL", NAO_APLICAVEL: "NAO_APLICAVEL" });
const DECISAO = Object.freeze({
  LIBERAVEL: "LIBERAVEL",
  LIBERAVEL_COM_RESSALVAS: "LIBERAVEL_COM_RESSALVAS",
  NAO_LIBERAVEL: "NAO_LIBERAVEL",
  SEM_DADOS: "SEM_DADOS",
  JA_LIBERADA: "JA_LIBERADA",
});

function inc(o, k, n = 1) { o[k] = (o[k] || 0) + n; }

/**
 * @param {object} p
 *  conta        { clienteContaId, sellerId, ... }
 *  itens        resultados de auditarItem
 *  liberadaHoje boolean (seller em FRETE_COTACAO_CONFIAVEL_SELLERS)
 *  resumo       resumoPorConta (contagens do banco)
 *  metricasApi  { chamadas, status429, erros, porStatus }
 *  falhasSnapshot { [mensagem]: n }
 */
function montarMatriz({ conta = {}, itens = [], liberadaHoje = false, resumo = {}, metricasApi = null, falhasSnapshot = {} } = {}) {
  const porModalidade = {};
  const niveisFrete = {};
  const confianca = {};
  const situacoes = {};
  const bloqueios = {};
  let ativos = 0, comVendas = 0, comMargemConfiavel = 0, aoVivo = 0, aoVivoFalhou = 0;
  let cotacaoRejeitadaAoVivo = 0, desconhecidoAoVivo = 0;

  for (const it of itens) {
    const fam = it.familiaLogistica || "desconhecida";
    const m = porModalidade[fam] || (porModalidade[fam] = { itens: 0, ativos: 0, comVendas: 0, comparacoes: 0, batem: 0, subestimados: 0, superestimados: 0, unidades30d: 0 });
    m.itens++;
    const ativo = it.statusAnuncio === "active";
    if (ativo) { m.ativos++; ativos++; }
    if ((it.vendas30d && it.vendas30d.unidades) > 0) { m.comVendas++; comVendas++; m.unidades30d += it.vendas30d.unidades; }
    if (it.comparacaoFrete) {
      m.comparacoes++;
      if (it.comparacaoFrete.bate) m.batem++;
      if (it.comparacaoFrete.subestimado) m.subestimados++;
      if (it.comparacaoFrete.superestimado) m.superestimados++;
    }
    const fr = it.contrato && it.contrato.componentes ? it.contrato.componentes.frete : null;
    inc(niveisFrete, fr ? fr.nivel || "?" : "?");
    inc(confianca, it.contrato ? it.contrato.confiancaGeral : "?");
    inc(situacoes, it.situacao);
    for (const b of (it.contrato && it.contrato.bloqueios) || []) inc(bloqueios, b.codigo);
    if (it.contrato && it.contrato.margemConfiavel) comMargemConfiavel++;
    if (it.fonteAvaliacao === "ao_vivo") {
      aoVivo++;
      if (fr && fr.cotacaoRejeitada !== null && fr.cotacaoRejeitada !== undefined) cotacaoRejeitadaAoVivo++;
      if (fr && fr.valor === null && fr.aplicavel !== false) desconhecidoAoVivo++;
    }
    if (it.aoVivoFalhou) aoVivoFalhou++;
  }

  const modalidades = {};
  for (const [fam, m] of Object.entries(porModalidade)) {
    const taxa = m.comparacoes ? m.batem / m.comparacoes : null;
    let status;
    if (fam === "a_combinar") status = STATUS_MODALIDADE.NAO_APLICAVEL;
    else if (fam === "flex") status = STATUS_MODALIDADE.PARCIAL; // entregador próprio fora da margem
    else if (m.comparacoes < MIN_COMPARACOES_MODALIDADE) status = STATUS_MODALIDADE.SEM_EVIDENCIA;
    else if (taxa >= CONCORDANCIA_VALIDA) status = STATUS_MODALIDADE.VALIDADA;
    // O PERIGO é o frete projetado ABAIXO do cobrado (margem inflada). Projeção acima do
    // cobrado (desconto aplicado depois da venda, medido em Agência ~12–17%) subestima a
    // margem: é conservadora, não bloqueia — mas também não "valida" a conta.
    else if (m.subestimados / m.comparacoes >= LIMITE_SUBESTIMADOS_DIVERGENTE) status = STATUS_MODALIDADE.DIVERGENTE;
    else if (m.subestimados / m.comparacoes >= LIMITE_SUBESTIMADOS_RESSALVA) status = STATUS_MODALIDADE.INCONCLUSIVA;
    else status = STATUS_MODALIDADE.CONSERVADORA;
    modalidades[fam] = { ...m, concordancia: taxa === null ? null : Math.round(taxa * 1000) / 1000, status };
  }

  // Modalidades com volume (≥ 5% das unidades vendidas) decidem a validação.
  const unidadesTotal = Object.values(porModalidade).reduce((a, m) => a + m.unidades30d, 0);
  // Logística desconhecida (anúncio fora do cadastro sincronizado) não decide a validação.
  const relevantes = Object.entries(modalidades).filter(([fam, m]) => fam !== "a_combinar" && fam !== "desconhecida" && (unidadesTotal ? m.unidades30d / unidadesTotal >= 0.05 : m.ativos > 0));
  const comparacoesTotal = Object.values(modalidades).reduce((a, m) => a + m.comparacoes, 0);
  const divergentes = relevantes.filter(([, m]) => m.status === STATUS_MODALIDADE.DIVERGENTE).map(([f]) => f);
  const semEvidencia = relevantes.filter(([, m]) => m.status === STATUS_MODALIDADE.SEM_EVIDENCIA).map(([f]) => f);
  const desc = (f) => `${f} (${Math.round(modalidades[f].concordancia * 100)}% batem, ${modalidades[f].subestimados} abaixo e ${modalidades[f].superestimados} acima do cobrado, de ${modalidades[f].comparacoes})`;
  const inconclusivas = relevantes.filter(([, m]) => m.status === STATUS_MODALIDADE.INCONCLUSIVA).map(([f]) => desc(f));
  const conservadoras = relevantes.filter(([, m]) => m.status === STATUS_MODALIDADE.CONSERVADORA).map(([f]) => desc(f));
  const divergentesDesc = divergentes.map(desc);
  const validadas = relevantes.filter(([, m]) => m.status === STATUS_MODALIDADE.VALIDADA).map(([f]) => f);

  const motivos = [];
  let decisao;
  if (liberadaHoje) {
    decisao = DECISAO.JA_LIBERADA; motivos.push("Seller já está na liberação do frete confiável.");
    if (divergentes.length) motivos.push(`Mesmo liberada, frete abaixo do cobrado em: ${divergentesDesc.join("; ")}.`);
    if (inconclusivas.length) motivos.push(`Frete abaixo do cobrado em 10–20% das vendas: ${inconclusivas.join("; ")}.`);
    if (conservadoras.length) motivos.push(`Projeção acima do cobrado (conservadora): ${conservadoras.join("; ")}.`);
  }
  else if (!itens.length || (comparacoesTotal < MIN_COMPARACOES_MODALIDADE && aoVivo === 0)) { decisao = DECISAO.SEM_DADOS; motivos.push("Sem vendas comparáveis nem amostra ao vivo suficientes para medir a conta."); }
  else if (divergentes.length) { decisao = DECISAO.NAO_LIBERAVEL; motivos.push(`Frete projetado ABAIXO do cobrado em ≥20% das vendas comparáveis: ${divergentesDesc.join("; ")}. Investigar antes de liberar.`); }
  else if (relevantes.length && validadas.length === relevantes.length) { decisao = DECISAO.LIBERAVEL; motivos.push(`Cotações batem com o cobrado em todas as modalidades com volume (${validadas.join(", ")}).`); }
  else {
    decisao = DECISAO.LIBERAVEL_COM_RESSALVAS;
    if (inconclusivas.length) motivos.push(`Frete abaixo do cobrado em 10–20% das vendas comparáveis: ${inconclusivas.join("; ")}.`);
    if (conservadoras.length) motivos.push(`Projeção acima do cobrado (margem subestimada, conservadora): ${conservadoras.join("; ")}.`);
    if (semEvidencia.length) motivos.push(`Menos de ${MIN_COMPARACOES_MODALIDADE} vendas comparáveis em: ${semEvidencia.join(", ")}.`);
    if (!inconclusivas.length && !semEvidencia.length && !conservadoras.length) motivos.push("Evidência parcial.");
  }
  if (cotacaoRejeitadaAoVivo) motivos.push(`${cotacaoRejeitadaAoVivo} anúncio(s) da amostra ao vivo têm cotação por anúncio rejeitada (Envios Agora/proximity).`);
  if (desconhecidoAoVivo) motivos.push(`${desconhecidoAoVivo} anúncio(s) ficariam com frete desconhecido após a liberação (margem bloqueada até declarar medidas).`);

  const operador = (bloqueios.CUSTO_AUSENTE || 0) + (bloqueios.IMPOSTO_AUSENTE || 0) + (bloqueios.TAXA_FIXA_AUSENTE || 0) + (bloqueios.FRETE_DESCONHECIDO || 0);
  return {
    clienteContaId: conta.clienteContaId ?? null,
    sellerId: conta.sellerId ? String(conta.sellerId) : null,
    geradaEm: new Date().toISOString(),
    liberadaHoje: Boolean(liberadaHoje),
    decisao,
    motivos,
    financeiramenteValidada: decisao !== DECISAO.SEM_DADOS && divergentes.length === 0 && relevantes.length > 0 && validadas.length === relevantes.length,
    modalidades,
    totais: {
      itensAuditados: itens.length, ativos, comVendas, comMargemConfiavel, comparacoesComRealizado: comparacoesTotal,
      amostraAoVivo: aoVivo, aoVivoFalhou, cotacaoRejeitadaAoVivo, desconhecidoAoVivo,
      dependemDoOperador: operador,
    },
    niveisFrete, confianca, situacoes, bloqueios,
    api: metricasApi || null,
    falhasSnapshot,
    snapshot: resumo || {},
  };
}

module.exports = { montarMatriz, DECISAO, STATUS_MODALIDADE, MIN_COMPARACOES_MODALIDADE, CONCORDANCIA_VALIDA };
