// server/services/cliente360/cliente360RecuperacaoEngine.js
// Motor de RECUPERAÇÃO OPERACIONAL — PURO. Recebe o resultado de montarPonte()
// + limiares (margem alvo) e devolve uma lista priorizada de oportunidades, cada
// uma com R$ recuperável ESTIMADO e o produto/fator exato para agir.
//
// Princípio: nada é inventado. Cada oportunidade só nasce de uma perda que já
// aparece na ponte ou de um produto que já está no perfil do período atual.
// O R$ recuperável é sempre um teto conservador ("se voltasse ao patamar do
// período anterior" ou "se atingisse a margem alvo"), nunca uma projeção.
//
// ADS ESTÁ FORA DESTE MOTOR, por decisão de produto:
//   - não existe "Ads sem retorno" como oportunidade;
//   - não existe "TACoS recuperável";
//   - não existe "cortar Ads" / "voltar Ads ao mês anterior";
//   - nenhuma oportunidade tem fator "ads";
//   - o total recuperável NUNCA inclui verba de mídia.
// O motivo é simples: o recuperável precisa ser comprovável na operação (custo,
// frete, preço, comissão, imposto, mix). Cortar mídia é uma decisão de investimento
// com efeito incerto sobre a receita — tratá-la como "dinheiro na mesa" seria
// prometer um resultado que o dado não sustenta.

const { round2 } = require("./cliente360PonteEngine");

// Telas reais do Portal para onde a ação leva.
const DESTINO = {
  custo: "bases.html",
  preco: "automacoes.html",
  frete: "financeiro-v3.html",
  comissao: "financeiro-v3.html",
  imposto: "bases.html",
  produto: "bases.html",
  fechamento: "financeiro-v3.html",
};

function op(tipo, severidade, titulo, extra = {}) {
  const { recuperavel, contaNoTotal, ...resto } = extra;
  return {
    tipo,
    severidade,
    titulo,
    recuperavelEstimado: round2(recuperavel || 0),
    contaNoTotal: contaNoTotal !== false,
    ...resto,
  };
}

// Oportunidade derivada de uma linha negativa da ponte (custo/frete/comissão/imposto).
function oportunidadeDeLinha(ponte, chave, config) {
  const linha = ponte.linhasBrutas.find((l) => l.chave === chave);
  if (!linha || linha.impacto >= 0) return null;

  const alvos = ponte.produtos
    .filter((p) => p.motivoDominante === chave && p.contribuicao < 0)
    .sort((a, b) => a.contribuicao - b.contribuicao)
    .slice(0, 8);

  return op(config.tipo, config.severidade, config.titulo, {
    fator: chave,
    recuperavel: -linha.impacto,
    descricao: config.descricao,
    produtos: alvos.map((p) => ({ mlb: p.mlb, titulo: p.titulo, impacto: p.contribuicao })),
    destino: config.destino,
    acaoRecomendada: config.acaoRecomendada,
  });
}

// ponte            = saída de montarPonte()
// alvoMargem       = margem de contribuição alvo em fração (ex.: 0,15)
// mcOk             = fallback do alvo em % quando alvoMargem não vier
// receitaBloqueada = faturamento do período atual sem custo/frete real (R$),
//                    vindo do motor de confiança — vira alerta sem R$ recuperável.
function avaliarRecuperacao(
  ponte,
  { alvoMargem = null, mcOk = 15, relevanciaSaida = 0.02, receitaBloqueada = 0 } = {}
) {
  const alvo = alvoMargem !== null && alvoMargem !== undefined ? Number(alvoMargem) : mcOk / 100;
  const perfil = ponte._perfis?.map1;
  const ops = [];

  // ── 1. Compressão de custo do produto ──────────────────────────────────────
  const opCusto = oportunidadeDeLinha(ponte, "custo", {
    tipo: "issue",
    severidade: "critico",
    titulo: "Custo do produto corroeu margem",
    descricao: "O custo unitário subiu frente ao período anterior. Recuperável = voltar ao custo anterior nos produtos afetados.",
    destino: DESTINO.custo,
    acaoRecomendada: "Revisar/atualizar a base de custo dos produtos listados.",
  });
  if (opCusto) ops.push(opCusto);

  // ── 2. Frete acima do padrão ───────────────────────────────────────────────
  const opFrete = oportunidadeDeLinha(ponte, "frete", {
    tipo: "risk",
    severidade: "atencao",
    titulo: "Frete consumindo mais resultado",
    descricao: "O frete por unidade subiu frente ao período anterior.",
    destino: DESTINO.frete,
    acaoRecomendada: "Revisar frete na precificação e checar mudança de logística.",
  });
  if (opFrete) ops.push(opFrete);

  // ── 3. Comissão acima do padrão ────────────────────────────────────────────
  const opComissao = oportunidadeDeLinha(ponte, "comissao", {
    tipo: "risk",
    severidade: "atencao",
    titulo: "Comissão consumindo mais resultado",
    descricao: "A comissão por unidade subiu frente ao período anterior (mudança de categoria, tipo de anúncio ou faixa de preço).",
    destino: DESTINO.comissao,
    acaoRecomendada: "Conferir tipo de anúncio e categoria dos itens com maior perda.",
  });
  if (opComissao) ops.push(opComissao);

  // ── 4. Imposto acima do padrão ─────────────────────────────────────────────
  const opImposto = oportunidadeDeLinha(ponte, "imposto", {
    tipo: "risk",
    severidade: "atencao",
    titulo: "Imposto consumindo mais resultado",
    descricao: "O imposto por unidade subiu frente ao período anterior.",
    destino: DESTINO.imposto,
    acaoRecomendada: "Revisar o percentual de imposto cadastrado na base do cliente.",
  });
  if (opImposto) ops.push(opImposto);

  // ── 5. Queda de preço médio ────────────────────────────────────────────────
  const lPreco = ponte.linhasBrutas.find((l) => l.chave === "preco");
  if (lPreco && lPreco.impacto < 0) {
    const alvos = ponte.produtos
      .filter((p) => p.motivoDominante === "preco" && p.contribuicao < 0)
      .sort((a, b) => a.contribuicao - b.contribuicao)
      .slice(0, 8);
    ops.push(op("opportunity", "atencao", "Preço médio caiu frente ao período anterior", {
      fator: "preco",
      recuperavel: -lPreco.impacto,
      descricao: "O preço médio praticado caiu. Recuperável = voltar ao preço do período anterior mantendo o volume.",
      produtos: alvos.map((p) => ({ mlb: p.mlb, titulo: p.titulo, impacto: p.contribuicao })),
      destino: DESTINO.preco,
      acaoRecomendada: "Revisar promoções/descontos e reprecificar os itens listados.",
    }));
  }

  // ── 6. Produtos relevantes que pararam de vender ───────────────────────────
  const saidas = ponte.produtos
    .filter((p) => p.tipo === "saida" && p.contribuicao < 0)
    .sort((a, b) => a.contribuicao - b.contribuicao);
  const baseFat = ponte.totais.anterior.faturamento;
  const saidasRelevantes = saidas.filter(
    (p) => baseFat <= 0 || Math.abs(p.contribuicao) / Math.abs(baseFat) >= relevanciaSaida * 0.1
  );
  if (saidasRelevantes.length) {
    const perdaSaidas = -saidasRelevantes.reduce((s, p) => s + p.contribuicao, 0);
    ops.push(op("issue", "atencao", `${saidasRelevantes.length} produto(s) relevante(s) pararam de vender`, {
      fator: "mix",
      recuperavel: perdaSaidas,
      descricao: "Itens que contribuíam no período anterior não venderam nada no período atual. Recuperável = retomar o patamar anterior.",
      produtos: saidasRelevantes.slice(0, 10).map((p) => ({
        mlb: p.mlb, titulo: p.titulo, impacto: p.contribuicao, unidadesAnterior: p.unidadesAnterior,
      })),
      destino: DESTINO.produto,
      acaoRecomendada: "Checar ruptura de estoque, anúncio pausado ou perda de posição.",
    }));
  }

  if (perfil) {
    // ── 7. Produtos abaixo da margem alvo ────────────────────────────────────
    const abaixo = [];
    for (const p of perfil.values()) {
      if (p.rec <= 0 || p.mcTotal < 0) continue; // negativo é tratado no item 8
      const margem = p.mcTotal / p.rec;
      if (margem < alvo) {
        abaixo.push({ mlb: p.mlb, titulo: p.titulo, margem, recuperavel: (alvo - margem) * p.rec, faturamento: p.rec });
      }
    }
    abaixo.sort((a, b) => b.recuperavel - a.recuperavel);
    const top = abaixo.slice(0, 10);
    if (top.length) {
      ops.push(op("opportunity", "atencao", `${abaixo.length} produto(s) abaixo da margem alvo`, {
        fator: "preco",
        recuperavel: top.reduce((s, x) => s + x.recuperavel, 0),
        descricao: `Elevar a margem de contribuição destes itens até ${(alvo * 100).toFixed(0)}% (via preço ou custo) recuperaria o valor estimado.`,
        produtos: top.map((x) => ({
          mlb: x.mlb, titulo: x.titulo,
          margem: x.margem, recuperavel: round2(x.recuperavel), faturamento: round2(x.faturamento),
        })),
        destino: DESTINO.preco,
        acaoRecomendada: "Reprecificar ou renegociar custo dos itens de maior gap de margem.",
      }));
    }

    // ── 8. Produtos com resultado negativo (sangrando) ───────────────────────
    const negativos = [];
    for (const p of perfil.values()) {
      if (p.mcTotal < 0) negativos.push({ mlb: p.mlb, titulo: p.titulo, resultado: p.mcTotal, faturamento: p.rec });
    }
    negativos.sort((a, b) => a.resultado - b.resultado);
    if (negativos.length) {
      ops.push(op("issue", "critico", `${negativos.length} produto(s) com resultado negativo`, {
        fator: "produto",
        recuperavel: -negativos.reduce((s, x) => s + x.resultado, 0),
        descricao: "Estes itens vendem abaixo do custo variável. Recuperável = parar a sangria (subir preço, corrigir custo ou pausar).",
        produtos: negativos.slice(0, 10).map((x) => ({
          mlb: x.mlb, titulo: x.titulo, resultado: round2(x.resultado), faturamento: round2(x.faturamento),
        })),
        destino: DESTINO.produto,
        acaoRecomendada: "Subir preço ao ponto de equilíbrio ou pausar o anúncio.",
      }));
    }
  }

  // ── 9. Qualidade/ausência de dados (sem R$; não entra no total) ────────────
  const bloqueada = Number(receitaBloqueada) || 0;
  if (bloqueada > 0) {
    ops.push(op("data", "atencao", "Parte do faturamento está sem custo ou frete real", {
      fator: "dados",
      recuperavel: 0,
      contaNoTotal: false,
      descricao: `R$ ${bloqueada.toFixed(2)} de receita sem dados suficientes para apurar resultado. O valor recuperável desses itens é desconhecido — não é somado.`,
      destino: DESTINO.fechamento,
      acaoRecomendada: "Sincronizar pedidos e completar a base de custo do cliente.",
    }));
  }

  // priorização por R$ recuperável (oportunidades sem R$ vão para o fim)
  ops.sort((a, b) => b.recuperavelEstimado - a.recuperavelEstimado);

  const totalRecuperavel = round2(
    ops.filter((o) => o.contaNoTotal).reduce((s, o) => s + o.recuperavelEstimado, 0)
  );

  return {
    totalRecuperavel,
    oportunidades: ops,
    // Explicita para a interface que o total é 100% operacional.
    escopo: "operacional",
    observacao:
      "Total recuperável considera apenas oportunidades operacionais comprováveis (custo, frete, preço, comissão, imposto, mix). Investimento em Ads não entra.",
  };
}

module.exports = { avaliarRecuperacao, DESTINO };
