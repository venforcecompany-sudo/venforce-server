// server/services/resgate/resgateClassificacao.js
//
// Classificação de UM anúncio no Resgate. Puro. Dois eixos independentes:
//
//  ORIGEM DO PREÇO (o que o histórico disponível prova — nunca inventado):
//   SEM_ALTERACAO_REGISTRADA   nenhuma evidência de mudança (com a ressalva de que
//                              as alterações de preço feitas em /anuncios NÃO eram
//                              registradas antes desta versão);
//   ALTERADO_MANUAL            evento de alteração manual registrado (/anuncios, a partir desta versão);
//   ALTERADO_AUTOMACAO         Central de Margem (aplicação auditada), rebate, transferência de promoção;
//   ALTERADO_ORIGEM_INDETERMINADA  o preço mudou (fontes divergem no tempo), sem evento que explique;
//   HISTORICO_INSUFICIENTE     não há fonte suficiente para afirmar nada.
//
//  SITUAÇÃO FINANCEIRA:
//   DADOS_INSUFICIENTES        componente essencial desconhecido (fila de pendências);
//   MARGEM_DESCONHECIDA        calculável, mas a confiança não permite decidir (frete não verificado);
//   MARGEM_ANTIGA_INFLADA      a margem gravada/exibida é maior que a real (frete/comissão subestimados);
//   SNAPSHOT_DESATUALIZADO     o snapshot é de outro preço / velho, mas a margem real está ok;
//   PROMOCAO_SUBSIDIADA        promoção com subsídio do ML legítimo explica a margem;
//   ABAIXO_DA_META             margem correta, abaixo da meta configurada (não é erro por si só);
//   PREJUIZO                   margem correta e negativa;
//   PRECO_OK                   margem correta e na meta.

const { CONFIANCA } = require("./resgateEvidencias");

const ORIGEM = Object.freeze({
  SEM_ALTERACAO_REGISTRADA: "SEM_ALTERACAO_REGISTRADA",
  ALTERADO_MANUAL: "ALTERADO_MANUAL",
  ALTERADO_AUTOMACAO: "ALTERADO_AUTOMACAO",
  ALTERADO_ORIGEM_INDETERMINADA: "ALTERADO_ORIGEM_INDETERMINADA",
  HISTORICO_INSUFICIENTE: "HISTORICO_INSUFICIENTE",
});

const SITUACAO = Object.freeze({
  DADOS_INSUFICIENTES: "DADOS_INSUFICIENTES",
  MARGEM_DESCONHECIDA: "MARGEM_DESCONHECIDA",
  MARGEM_ANTIGA_INFLADA: "MARGEM_ANTIGA_INFLADA",
  SNAPSHOT_DESATUALIZADO: "SNAPSHOT_DESATUALIZADO",
  PROMOCAO_SUBSIDIADA: "PROMOCAO_SUBSIDIADA",
  ABAIXO_DA_META: "ABAIXO_DA_META",
  PREJUIZO: "PREJUIZO",
  PRECO_OK: "PRECO_OK",
});

const ACAO = Object.freeze({
  REVISAR_PRECO: "REVISAR_PRECO",
  COMPLETAR_DADOS: "COMPLETAR_DADOS",
  VERIFICAR_FRETE: "VERIFICAR_FRETE",
  VERIFICAR_SUBSIDIO: "VERIFICAR_SUBSIDIO",
  RECALCULAR_SNAPSHOT: "RECALCULAR_SNAPSHOT",
  NENHUMA: "NENHUMA",
});

// Margem gravada maior que a real por mais que isto (pontos percentuais) = inflada.
const LIMIAR_INFLACAO_PP = 1;

const TIPOS_AUTOMACAO = new Set(["central_margem_aplicacao", "rebate_participacao", "promocao_transferencia", "promocao_criada"]);

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Eixo 1 — origem do preço. `historico` vem de resgateHistorico.montarHistoricoItem. */
function classificarOrigem(historico) {
  const h = historico || {};
  const eventos = Array.isArray(h.eventos) ? h.eventos : [];
  if (!h.fontesConsultadas || !h.fontesConsultadas.length) return { origem: ORIGEM.HISTORICO_INSUFICIENTE, motivo: "Nenhuma fonte de histórico disponível." };
  const alteracoes = eventos.filter((e) => e.alteraPreco);
  const ultimo = alteracoes.length ? alteracoes[alteracoes.length - 1] : null;
  if (ultimo && ultimo.tipo === "preco_manual") return { origem: ORIGEM.ALTERADO_MANUAL, motivo: `Alteração manual registrada em ${ultimo.em}.`, evento: ultimo };
  if (ultimo && TIPOS_AUTOMACAO.has(ultimo.tipo)) return { origem: ORIGEM.ALTERADO_AUTOMACAO, motivo: `${ultimo.descricao || ultimo.tipo} em ${ultimo.em}.`, evento: ultimo };
  if (h.mudancaDetectada) return { origem: ORIGEM.ALTERADO_ORIGEM_INDETERMINADA, motivo: h.mudancaDetectada.descricao || "O preço mudou entre fontes, sem evento que explique a origem.", evento: h.mudancaDetectada };
  return {
    origem: ORIGEM.SEM_ALTERACAO_REGISTRADA,
    motivo: "Nenhuma alteração registrada nas fontes consultadas." + (h.ressalvaSemLogManual ? " Alterações manuais em /anuncios não eram registradas antes desta versão." : ""),
  };
}

/**
 * Eixo 2 — situação financeira.
 * @param {object} p
 *  - contrato         contrato ATUAL (o melhor disponível: ao vivo > snapshot)
 *  - margemExibida    margem % que a tela/planilha mostrava (snapshot), null se nenhuma
 *  - precoExibido     preço do snapshot
 *  - comparacaoFrete  resgateEvidencias.compararComRealizado (ou null)
 *  - snapshotVelho    boolean (TTL vencido / refresh_status ≠ fresh)
 *  - meta             { valor (decimal), origem }
 */
function classificarSituacao({ contrato, margemExibida = null, precoExibido = null, comparacaoFrete = null, snapshotVelho = false, meta = null } = {}) {
  const motivos = [];
  const c = contrato || {};
  const res = c.resultado || {};
  const metaV = meta ? num(meta.valor) : null;

  if (!res.calculavel) {
    const bl = (c.bloqueios || []).map((b) => b.codigo);
    return { situacao: SITUACAO.DADOS_INSUFICIENTES, acao: ACAO.COMPLETAR_DADOS, motivos: (c.bloqueios || []).map((b) => b.texto), bloqueios: bl,
      inflada: margemExibida !== null, margemExibida };
  }
  const margemReal = num(res.margemPercent);
  const exibida = num(margemExibida);

  // Frete projetado abaixo do realmente cobrado em vendas comparáveis = subestimado.
  if (comparacaoFrete && comparacaoFrete.subestimado) {
    motivos.push(`Frete projetado R$ ${Number(c.componentes.frete.valor).toFixed(2)} abaixo do cobrado em vendas comparáveis (mediana R$ ${comparacaoFrete.medianaRealizada.toFixed(2)}, ${comparacaoFrete.amostras} amostra(s)).`);
  }

  // Inflação: margem que estava sendo mostrada × margem real.
  if (exibida !== null && margemReal !== null && exibida - margemReal > LIMIAR_INFLACAO_PP) {
    const mesmoPreco = precoExibido === null || num(c.componentes.precoVigente.valor) === null || Math.abs(num(precoExibido) - num(c.componentes.precoVigente.valor)) < 0.01;
    if (mesmoPreco) {
      motivos.unshift(`Margem exibida ${exibida.toFixed(2)}% × real ${margemReal.toFixed(2)}% (${(exibida - margemReal).toFixed(2)} p.p. a mais).`);
      return { situacao: SITUACAO.MARGEM_ANTIGA_INFLADA, acao: margemReal < (metaV ?? 0) * 100 || margemReal < 0 ? ACAO.REVISAR_PRECO : ACAO.RECALCULAR_SNAPSHOT, motivos, margemReal, margemExibida: exibida, inflada: true };
    }
  }

  if (!c.margemConfiavel) {
    const verificar = c.componentes && c.componentes.frete && c.componentes.frete.status === "nao_verificado";
    motivos.push(verificar ? "Frete ainda não verificado para esta conta: a margem não serve para decidir." : "Margem calculada, mas com evidência que não permite decidir.");
    return { situacao: SITUACAO.MARGEM_DESCONHECIDA, acao: verificar ? ACAO.VERIFICAR_FRETE : ACAO.RECALCULAR_SNAPSHOT, motivos, margemReal, margemExibida: exibida, inflada: false };
  }
  if (c.confiancaGeral === CONFIANCA.DESCONHECIDA) {
    return { situacao: SITUACAO.MARGEM_DESCONHECIDA, acao: ACAO.RECALCULAR_SNAPSHOT, motivos: ["Confiança desconhecida."], margemReal, margemExibida: exibida, inflada: false };
  }

  // Margem de promoção com subsídio desconhecido é limite inferior: abaixo da meta/prejuízo não é conclusivo.
  if (res.limiteInferior && (margemReal < 0 || (metaV !== null && margemReal < metaV * 100))) {
    motivos.push(`Margem mínima ${margemReal.toFixed(2)}% (promoção ativa com subsídio do ML desconhecido): não conclusivo.`);
    return { situacao: SITUACAO.MARGEM_DESCONHECIDA, acao: ACAO.VERIFICAR_SUBSIDIO, motivos, margemReal, margemExibida: exibida, inflada: false };
  }
  if (margemReal < 0) {
    motivos.push(`Prejuízo de ${margemReal.toFixed(2)}% com dados verificados.`);
    return { situacao: SITUACAO.PREJUIZO, acao: ACAO.REVISAR_PRECO, motivos, margemReal, margemExibida: exibida, inflada: false };
  }
  const subsidio = c.componentes && c.componentes.subsidioMl ? num(c.componentes.subsidioMl.valor) : null;
  if (subsidio !== null && subsidio > 0 && (metaV === null || margemReal >= metaV * 100)) {
    motivos.push(`Promoção com subsídio do ML (R$ ${subsidio.toFixed(2)}/un) contabilizado uma vez.`);
    return { situacao: SITUACAO.PROMOCAO_SUBSIDIADA, acao: ACAO.NENHUMA, motivos, margemReal, margemExibida: exibida, inflada: false };
  }
  if (metaV !== null && margemReal < metaV * 100 - 1e-6) {
    motivos.push(`Margem ${margemReal.toFixed(2)}% abaixo da meta ${(metaV * 100).toFixed(2)}% (${meta.origem || "meta"}). Abaixo da meta não é, por si só, erro de cálculo.`);
    return { situacao: SITUACAO.ABAIXO_DA_META, acao: ACAO.REVISAR_PRECO, motivos, margemReal, margemExibida: exibida, inflada: false };
  }
  const precoMudou = precoExibido !== null && num(c.componentes.precoVigente.valor) !== null && Math.abs(num(precoExibido) - num(c.componentes.precoVigente.valor)) >= 0.01;
  if (snapshotVelho || precoMudou) {
    motivos.push(precoMudou ? `Snapshot calculado em R$ ${num(precoExibido).toFixed(2)}, preço atual R$ ${num(c.componentes.precoVigente.valor).toFixed(2)}.` : "Snapshot vencido.");
    return { situacao: SITUACAO.SNAPSHOT_DESATUALIZADO, acao: ACAO.RECALCULAR_SNAPSHOT, motivos, margemReal, margemExibida: exibida, inflada: false };
  }
  return { situacao: SITUACAO.PRECO_OK, acao: ACAO.NENHUMA, motivos: motivos.length ? motivos : ["Margem verificada dentro da meta."], margemReal, margemExibida: exibida, inflada: false };
}

/**
 * Exposição financeira estimada (por 30 dias, pelas vendas reais recentes).
 * - margem calculável: unidades × (lucro na meta − lucro real) quando abaixo da meta;
 *   inflada: unidades × (lucro exibido − lucro real) = quanto se "achava" que ganhava a mais.
 * - margem desconhecida: devolve o FATURAMENTO exposto, rotulado como tal (não é perda).
 */
function exposicao({ contrato, situacao, unidades30d = null, faturamento30d = null, meta = null, margemExibida = null }) {
  const u = num(unidades30d), fat = num(faturamento30d);
  const res = (contrato && contrato.resultado) || {};
  const preco = contrato && contrato.componentes ? num(contrato.componentes.precoVigente.valor) : null;
  if (!res.calculavel || preco === null || situacao === SITUACAO.MARGEM_DESCONHECIDA || situacao === SITUACAO.DADOS_INSUFICIENTES) {
    return { tipo: "faturamento_exposto", valor: fat, texto: fat === null ? "Sem vendas registradas na Central de Vendas." : "Faturamento de 30 dias com margem desconhecida (não é perda calculada)." };
  }
  const lucroReal = num(res.lucro);
  const metaV = meta ? num(meta.valor) : null;
  let porUnidade = null, tipo = null;
  if (situacao === SITUACAO.MARGEM_ANTIGA_INFLADA && num(margemExibida) !== null) {
    porUnidade = Math.max(0, (num(margemExibida) / 100) * preco - lucroReal); tipo = "lucro_superestimado";
  } else if ((situacao === SITUACAO.ABAIXO_DA_META || situacao === SITUACAO.PREJUIZO) && metaV !== null) {
    porUnidade = Math.max(0, metaV * preco - lucroReal); tipo = "distancia_da_meta";
  } else {
    return { tipo: "nenhuma", valor: 0, porUnidade: 0, texto: "Sem exposição calculada." };
  }
  const valor = u === null ? null : Math.round(porUnidade * u * 100) / 100;
  return { tipo, porUnidade: Math.round(porUnidade * 100) / 100, valor, texto: u === null ? "Sem vendas registradas: exposição por unidade apenas." : `${u} un. em 30 dias × R$ ${porUnidade.toFixed(2)}/un.` };
}

/** Prioridade 0–100: mudança recente, volume, distância/inflação, prejuízo, dados faltando com vendas. */
function prioridade({ situacao, origem, mudancaRecente = false, unidades30d = 0, exposicaoValor = null, faturamento30d = null }) {
  let p = 0;
  if (mudancaRecente) p += 30;
  if (origem === ORIGEM.ALTERADO_ORIGEM_INDETERMINADA || origem === ORIGEM.ALTERADO_MANUAL || origem === ORIGEM.ALTERADO_AUTOMACAO) p += 10;
  const peso = { MARGEM_ANTIGA_INFLADA: 30, PREJUIZO: 30, ABAIXO_DA_META: 15, DADOS_INSUFICIENTES: 12, MARGEM_DESCONHECIDA: 10, SNAPSHOT_DESATUALIZADO: 5 };
  p += peso[situacao] || 0;
  const u = num(unidades30d) || 0;
  p += Math.min(20, Math.round(Math.log10(1 + u) * 10));
  const ex = num(exposicaoValor) ?? (situacao === SITUACAO.DADOS_INSUFICIENTES || situacao === SITUACAO.MARGEM_DESCONHECIDA ? (num(faturamento30d) || 0) / 20 : 0);
  p += Math.min(10, Math.round(Math.log10(1 + ex) * 3));
  return Math.min(100, p);
}

module.exports = { ORIGEM, SITUACAO, ACAO, LIMIAR_INFLACAO_PP, classificarOrigem, classificarSituacao, exposicao, prioridade };
