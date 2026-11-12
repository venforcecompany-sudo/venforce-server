// server/services/resgate/resgatePlanoXlsx.js
//
// XLSX de RECUPERAÇÃO do Resgate. Abas: Resumo, Plano de preços, Pendências,
// Todos os anúncios, Contas. Regras (mesmas da correção da Matriz):
//  · célula vazia = DESCONHECIDO; 0 só quando o valor é zero comprovado;
//  · toda fórmula exige ISNUMBER de cada entrada — nunca trata vazio como 0;
//  · a coluna "Confere com backend" compara a margem da fórmula com a do
//    contrato do servidor (divergência backend × planilha fica visível);
//  · o topo de cada aba diz que os dados são da AUDITORIA (com data/hora),
//    não de relatório histórico, e que a proposta só vale para o preço visto.

const XLSX = require("xlsx");
const { ORIGEM, SITUACAO, ACAO } = require("./resgateClassificacao");

const ROTULO_SITUACAO = Object.freeze({
  DADOS_INSUFICIENTES: "Dados insuficientes", MARGEM_DESCONHECIDA: "Margem desconhecida", MARGEM_ANTIGA_INFLADA: "Margem antiga inflada",
  SNAPSHOT_DESATUALIZADO: "Snapshot desatualizado", PROMOCAO_SUBSIDIADA: "Promoção subsidiada legítima", ABAIXO_DA_META: "Abaixo da meta (cálculo correto)",
  PREJUIZO: "Prejuízo (cálculo correto)", PRECO_OK: "Preço correto",
});
const ROTULO_ORIGEM = Object.freeze({
  SEM_ALTERACAO_REGISTRADA: "Sem alteração registrada", ALTERADO_MANUAL: "Alterado manualmente", ALTERADO_AUTOMACAO: "Alterado por automação",
  ALTERADO_ORIGEM_INDETERMINADA: "Alterado, origem indeterminada", HISTORICO_INSUFICIENTE: "Histórico insuficiente",
});
const STATUS_REVISAO = ["PENDENTE", "APROVADO", "REJEITADO", "AJUSTADO", "INVALIDADO"];

function n(v) { if (v === null || v === undefined || v === "") return null; const x = Number(v); return Number.isFinite(x) ? x : null; }
function pct(v) { const x = n(v); return x === null ? null : x / 100; }
function dataBr(iso) { if (!iso) return null; const d = new Date(iso); return Number.isFinite(d.getTime()) ? d.toISOString().replace("T", " ").slice(0, 16) + " UTC" : null; }

function textoPendencias(it) {
  const c = it.contrato || {};
  return [...(c.bloqueios || []).map((b) => b.texto), ...(c.pendencias || []).map((p) => p.texto), ...(c.inconsistencias || []).map((p) => p.texto)].join(" | ") || null;
}
function textoPromocao(it) {
  const p = (it.contrato && it.contrato.promocao) || {};
  if (p.ativa === true) return [p.tipo, p.nome].filter(Boolean).join(" — ") || "Promoção ativa";
  if (p.ativa === false) return "Sem promoção";
  return null;
}
function textoHistorico(it) {
  const h = it.historico || {};
  return `${ROTULO_ORIGEM[h.origem] || h.origem}: ${h.motivo || ""}`.trim();
}

// Definição das colunas da aba "Plano de preços" (ordem = letra).
const COLUNAS_PLANO = [
  ["Cliente", (it, x) => x.clienteNome], ["Conta", (it, x) => x.contaNome || String(it.clienteContaId)], ["Seller", (it) => it.sellerId],
  ["MLB", (it) => it.itemId], ["SKU", (it) => it.sku], ["Produto", (it) => it.titulo], ["Status anúncio", (it) => it.statusAnuncio], ["Logística", (it) => it.logistica],
  ["Preço atual", (it) => n(it.contrato.componentes.precoVigente.valor), "moeda"],               // I
  ["Preço proposto", (it) => (it.recomendacao && it.recomendacao.ok ? it.recomendacao.preco : null), "moeda"], // J
  ["Custo", (it) => n(it.contrato.componentes.custo.valor), "moeda"],                            // K
  ["Imposto %", (it) => n(it.contrato.componentes.imposto.valor), "pct"],                        // L
  ["Taxa fixa", (it) => n(it.contrato.componentes.taxaFixa.valor), "moeda"],                     // M
  ["Comissão atual", (it) => n(it.contrato.componentes.comissao.valor), "moeda"],                // N
  ["Frete atual", (it) => (it.contrato.componentes.frete.aplicavel === false ? 0 : n(it.contrato.componentes.frete.valor)), "moeda"], // O
  // O subsídio QUE O BACKEND CONSIDEROU (0 quando não há promoção ou quando é desconhecido — a margem
  // então é limite inferior e a coluna "Pendências" diz isso). Sem contrato calculável: vazio.
  ["Subsídio ML considerado /un", (it) => (it.contrato.resultado.calculavel ? n(it.contrato.resultado.subsidioConsiderado) : (it.contrato.componentes.subsidioMl.status === "nao_aplicavel" ? 0 : n(it.contrato.componentes.subsidioMl.valor))), "moeda"], // P
  ["Comissão no proposto", (it) => (it.recomendacao && it.recomendacao.ok ? n(it.recomendacao.comissaoApos) : null), "moeda"], // Q
  ["Frete no proposto", (it) => (it.recomendacao && it.recomendacao.ok ? n(it.recomendacao.freteApos) : null), "moeda"],       // R
  ["Margem atual (backend)", (it) => pct(it.contrato.resultado.margemPercent), "pct"],            // S
  ["Margem atual (fórmula)", null, "pct", (r) => `IF(AND(ISNUMBER(I${r}),I${r}>0,ISNUMBER(K${r}),ISNUMBER(L${r}),ISNUMBER(M${r}),ISNUMBER(N${r}),ISNUMBER(O${r}),ISNUMBER(P${r})),(I${r}-I${r}*L${r}-N${r}-O${r}-M${r}-K${r}+P${r})/I${r},"")`], // T
  ["Confere com backend", null, null, (r) => `IF(AND(ISNUMBER(S${r}),ISNUMBER(T${r})),IF(ABS(S${r}-T${r})<0.0001,"OK","DIVERGE"),IF(AND(ISNUMBER(S${r})=FALSE,ISNUMBER(T${r})=FALSE),"OK (ambos desconhecidos)","DIVERGE"))`], // U
  ["Margem projetada", null, "pct", (r) => `IF(AND(ISNUMBER(J${r}),J${r}>0,ISNUMBER(K${r}),ISNUMBER(L${r}),ISNUMBER(M${r}),ISNUMBER(Q${r}),ISNUMBER(R${r})),(J${r}-J${r}*L${r}-Q${r}-R${r}-M${r}-K${r})/J${r},"")`], // V
  ["Meta", (it) => (it.meta ? n(it.meta.valor) : null), "pct"],                                   // W
  ["Lucro atual /un", null, "moeda", (r) => `IF(ISNUMBER(T${r}),T${r}*I${r},"")`],                  // X
  ["Lucro projetado /un", null, "moeda", (r) => `IF(ISNUMBER(V${r}),V${r}*J${r},"")`],              // Y
  ["Diferença /un", null, "moeda", (r) => `IF(AND(ISNUMBER(X${r}),ISNUMBER(Y${r})),Y${r}-X${r},"")`], // Z
  ["Unidades 30d", (it) => n(it.vendas30d && it.vendas30d.unidades)],                             // AA
  ["Impacto 30d", null, "moeda", (r) => `IF(AND(ISNUMBER(Z${r}),ISNUMBER(AA${r})),Z${r}*AA${r},"")`], // AB
  ["Fonte do frete", (it) => it.contrato.componentes.frete.texto],
  ["Confiança", (it) => it.contrato.confiancaGeral],
  ["Promoção", (it) => textoPromocao(it)],
  ["Histórico de alteração", (it) => textoHistorico(it)],
  ["Última mudança", (it) => dataBr(it.historico && it.historico.ultimaMudancaEm)],
  ["Classificação", (it) => ROTULO_SITUACAO[it.situacao] || it.situacao],
  ["Motivo", (it) => (it.motivos || []).join(" ")],
  ["Restrições", (it) => (it.restricoes || []).map((r) => r.texto).join(" | ") || null],
  ["Pendências", (it) => textoPendencias(it)],
  ["Preço visto em", (it) => dataBr(it.fingerprint && it.fingerprint.vistoEm)],
  ["Status da revisão", (it) => (it.revisao && it.revisao.status) || "PENDENTE"],
  ["Nota do revisor", (it) => (it.revisao && it.revisao.nota) || null],
];

function linhaPlano(it, ctx, r) {
  return COLUNAS_PLANO.map(([, get, , formula]) => (formula ? { f: formula(r) } : get(it, ctx)));
}

function aplicarFormatos(ws, colunas, inicioLinha, fimLinha) {
  colunas.forEach(([, , fmt], c) => {
    if (!fmt) return;
    for (let r = inicioLinha; r <= fimLinha; r++) {
      const cell = ws[XLSX.utils.encode_cell({ c, r: r - 1 })];
      if (cell) cell.z = fmt === "pct" ? "0.00%" : "#,##0.00";
    }
  });
}

/**
 * @param {object} p
 *  contas[] { resumo, matriz }   (do store)
 *  itensPorConta Map(contaId → itens[])
 *  execucao { id, iniciadaEm, finalizadaEm }
 *  geradoEm Date
 */
function construirPlanoXlsx({ contas = [], itensPorConta = new Map(), execucao = {}, geradoEm = new Date() }) {
  const wb = XLSX.utils.book_new();
  const origem = `AUDITORIA VenForce Resgate — execução ${execucao.id ?? "?"} (${dataBr(execucao.iniciadaEm) || "?"} → ${dataBr(execucao.finalizadaEm) || "em andamento"}). ` +
    `Planilha gerada em ${dataBr(geradoEm.toISOString())}. DADOS DA AUDITORIA, não de relatório salvo. ` +
    "A proposta só vale para o \"preço visto\": se o preço do anúncio mudou depois, ela está INVALIDADA e precisa ser recalculada. " +
    "Célula vazia = desconhecido (nunca zero). Nada foi alterado no Mercado Livre.";

  // ── Resumo ────────────────────────────────────────────────────────────────
  const resumo = [[origem], [], ["Conta", "Cliente", "Seller", "Anúncios auditados", "Preços corretos", "Precisam revisão", "Sem margem confiável", "Alterados recentemente", "Com preço recomendado", "Risco estimado 30d (R$)", "Faturamento c/ margem desconhecida 30d (R$)", "Ativação do frete", "Validada financeiramente", "Meta usada", "Origem da meta"]];
  for (const c of contas) {
    const r = c.resumo || {};
    if (r.semAvaliacao) { resumo.push([r.contaNome || r.clienteContaId, r.clienteNome, r.sellerId, 0, null, null, null, null, null, null, null, `SEM AVALIAÇÃO: ${r.semAvaliacao}`, "NÃO", null, null]); continue; }
    resumo.push([r.contaNome || r.clienteContaId, r.clienteNome, r.sellerId, r.itens, r.precosCorretos, r.precisamRevisao, r.semMargemConfiavel, r.alteradosRecentemente, r.comRecomendacao,
      r.riscoFinanceiro30d, r.faturamentoComMargemDesconhecida30d, r.decisaoAtivacao, r.financeiramenteValidada ? "SIM" : "NÃO", r.meta ? r.meta.valor : null, r.meta ? r.meta.origem : null]);
  }
  resumo.push([], ["Classificações"], ...Object.entries(ROTULO_SITUACAO).map(([k, v]) => [k, v]), [], ["Origem do preço"], ...Object.entries(ROTULO_ORIGEM).map(([k, v]) => [k, v]),
    [], ["Status da revisão aceitos", STATUS_REVISAO.join(", ")],
    ["Ressalva", "Alterações de preço feitas em /anuncios não eram registradas antes desta versão: \"sem alteração registrada\" não prova que o preço nunca foi alterado."]);
  const wsResumo = XLSX.utils.aoa_to_sheet(resumo);
  XLSX.utils.book_append_sheet(wb, wsResumo, "Resumo");

  // ── Plano de preços (somente REVISAR_PRECO, contrato calculável) ─────────
  const plano = [[origem], COLUNAS_PLANO.map(([t]) => t)];
  const todos = [];
  const pend = [[origem], ["Cliente", "Conta", "MLB", "SKU", "Produto", "Status", "Unidades 30d", "Faturamento 30d", "O que falta", "Fonte que resolve", "Classificação", "Responsável", "Status"]];
  for (const c of contas) {
    const r = c.resumo || {};
    const ctx = { clienteNome: r.clienteNome, contaNome: r.contaNome };
    const itens = (itensPorConta.get(Number(r.clienteContaId)) || []).slice().sort((a, b) => b.prioridade - a.prioridade);
    for (const it of itens) {
      todos.push({ it, ctx });
      if (it.acao === ACAO.REVISAR_PRECO && it.contrato && it.contrato.resultado.calculavel) plano.push(linhaPlano(it, ctx, plano.length + 1));
      if (it.situacao === SITUACAO.DADOS_INSUFICIENTES || (it.situacao === SITUACAO.MARGEM_DESCONHECIDA && (it.vendas30d && it.vendas30d.unidades > 0))) {
        const bl = (it.contrato && it.contrato.bloqueios) || [];
        pend.push([ctx.clienteNome, ctx.contaNome || String(it.clienteContaId), it.itemId, it.sku, it.titulo, it.statusAnuncio, n(it.vendas30d && it.vendas30d.unidades), n(it.vendas30d && it.vendas30d.faturamento),
          bl.length ? bl.map((b) => b.texto).join(" | ") : (it.motivos || []).join(" "), bl.length ? bl.map((b) => b.resolveCom).join(" | ") : "Liberar/verificar o frete da conta (matriz de compatibilidade) ou recalcular o snapshot.",
          ROTULO_SITUACAO[it.situacao], null, "PENDENTE"]);
      }
    }
  }
  const wsPlano = XLSX.utils.aoa_to_sheet(plano);
  aplicarFormatos(wsPlano, COLUNAS_PLANO, 3, plano.length);
  XLSX.utils.book_append_sheet(wb, wsPlano, "Plano de preços");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(pend), "Pendências");

  // ── Todos os anúncios (mesmas colunas, todas as classificações) ─────────
  const tudo = [[origem], COLUNAS_PLANO.map(([t]) => t)];
  for (const { it, ctx } of todos) tudo.push(linhaPlano(it, ctx, tudo.length + 1));
  const wsTudo = XLSX.utils.aoa_to_sheet(tudo);
  aplicarFormatos(wsTudo, COLUNAS_PLANO, 3, tudo.length);
  XLSX.utils.book_append_sheet(wb, wsTudo, "Todos os anúncios");

  // ── Contas (matriz de compatibilidade) ───────────────────────────────────
  const cm = [[origem], ["Conta", "Cliente", "Seller", "Decisão de ativação", "Validada", "Motivos", "Modalidades (itens / comparações / concordância / status)", "Comparações c/ realizado", "Amostra ao vivo", "Cotação rejeitada ao vivo", "Ficariam desconhecidos", "Dependem do operador", "Chamadas ML", "HTTP 429"]];
  for (const c of contas) {
    const r = c.resumo || {}, m = c.matriz;
    if (!m) { cm.push([r.contaNome || r.clienteContaId, r.clienteNome, r.sellerId, r.semAvaliacao ? `SEM AVALIAÇÃO: ${r.semAvaliacao}` : null]); continue; }
    cm.push([r.contaNome || r.clienteContaId, r.clienteNome, r.sellerId, m.decisao, m.financeiramenteValidada ? "SIM" : "NÃO", (m.motivos || []).join(" "),
      Object.entries(m.modalidades || {}).map(([f, x]) => `${f}: ${x.itens} / ${x.comparacoes} / ${x.concordancia === null ? "—" : `${Math.round(x.concordancia * 100)}%`} / ${x.status}`).join("; "),
      m.totais.comparacoesComRealizado, m.totais.amostraAoVivo, m.totais.cotacaoRejeitadaAoVivo, m.totais.desconhecidoAoVivo, m.totais.dependemDoOperador,
      m.api ? m.api.chamadas : null, m.api ? m.api.status429 : null]);
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(cm), "Contas");
  return wb;
}

function planoParaBuffer(args) {
  return XLSX.write(construirPlanoXlsx(args), { type: "buffer", bookType: "xlsx" });
}

module.exports = { construirPlanoXlsx, planoParaBuffer, COLUNAS_PLANO, ROTULO_SITUACAO, ROTULO_ORIGEM, STATUS_REVISAO, ORIGEM };
