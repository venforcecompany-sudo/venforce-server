// Agregador executivo da carteira Cliente 360.
//
// A Central Executiva não cria uma matemática financeira paralela: cada conta é
// calculada pelo cliente360ResultadoService e este serviço apenas normaliza,
// prioriza e resume os contratos oficiais já usados pela Cliente 360 V2.

const LIMITE_CONCORRENCIA_PADRAO = 4;
const MATERIALIDADE_REAIS = 0.01;

function numeroOuNull(valor) {
  if (valor === null || valor === undefined || valor === "") return null;
  const n = Number(valor);
  return Number.isFinite(n) ? n : null;
}

function somaConhecidos(itens, seletor) {
  return itens.reduce((total, item) => {
    const valor = numeroOuNull(seletor(item));
    return total + (valor === null ? 0 : valor);
  }, 0);
}

function formatarReais(valor) {
  const n = Number(valor) || 0;
  return `R$ ${Math.abs(n).toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function primeiraMensagem(dados) {
  return dados?.narrativa?.texto
    || dados?.confianca?.alertas?.[0]?.mensagem
    || dados?.estado?.mensagem
    || null;
}

function principalCausa(dados) {
  const linhas = Array.isArray(dados?.ponte?.linhas) ? dados.ponte.linhas : [];
  const materiais = linhas
    .map((linha) => ({ ...linha, impactoNormalizado: numeroOuNull(linha?.impacto) }))
    .filter((linha) => linha.impactoNormalizado !== null && Math.abs(linha.impactoNormalizado) > MATERIALIDADE_REAIS)
    .sort((a, b) => Math.abs(b.impactoNormalizado) - Math.abs(a.impactoNormalizado));

  const pior = materiais.find((linha) => linha.impactoNormalizado < 0) || materiais[0];
  if (pior) {
    return {
      chave: pior.chave || "variacao_operacional",
      titulo: pior.label || pior.titulo || "Variação operacional",
      impacto: pior.impactoNormalizado,
      fonte: "ponte_resultado",
    };
  }

  const produto = dados?.produtos?.prejudicaram?.[0];
  if (produto) {
    return {
      chave: "produto",
      titulo: produto.titulo || produto.mlb || "Produto com impacto negativo",
      impacto: numeroOuNull(produto.contribuicao),
      fonte: "produto_prejudicou",
    };
  }

  const alerta = dados?.confianca?.alertas?.[0];
  if (alerta) {
    return {
      chave: alerta.chave || "dados",
      titulo: alerta.mensagem || "Dados insuficientes",
      impacto: null,
      fonte: "confianca",
    };
  }

  return {
    chave: null,
    titulo: dados?.estado?.mensagem || "Sem causa material identificada",
    impacto: null,
    fonte: null,
  };
}

function classificarSaude(dados) {
  if (!dados || dados?.estado?.chave === "sem_fechamento") {
    return { status: "sem_dados", motivos: ["Sem fechamento na competência"] };
  }
  if (dados?.confianca?.nivel === "insuficiente") {
    return { status: "sem_dados", motivos: ["Confiança insuficiente para priorização financeira"] };
  }

  const atual = dados?.fechamento?.atual || {};
  const anterior = dados?.fechamento?.anterior || {};
  const variacoes = dados?.fechamento?.variacoes || {};
  const margem = numeroOuNull(atual.margemOperacional);
  const resultado = numeroOuNull(atual.resultadoOperacional);
  const resultadoAnterior = numeroOuNull(anterior.resultadoOperacional);
  const deltaResultado = numeroOuNull(variacoes.resultadoOperacional?.abs);
  const faturamento = numeroOuNull(atual.faturamento) || 0;
  const alvoMargem = numeroOuNull(dados?.thresholds?.margemAlvo) ?? 0.15;
  const negativos = Number(dados?.produtos?.totais?.noVermelho || 0);
  const abaixoMeta = Number(dados?.produtos?.totais?.abaixoDaMargem || 0);
  const curvaAEmRisco = Array.isArray(dados?.produtos?.curvaAEmRisco)
    ? dados.produtos.curvaAEmRisco.length
    : 0;
  const potencial = numeroOuNull(dados?.oportunidades?.totalRecuperavel) || 0;

  const baseMaterialidade = Math.max(
    5000,
    Math.abs(resultadoAnterior || 0) * 0.2,
    faturamento * 0.03
  );
  const quedaMaterial = deltaResultado !== null
    && deltaResultado < -baseMaterialidade;

  const motivosCriticos = [];
  if (resultado !== null && resultado < 0) motivosCriticos.push("Resultado operacional negativo");
  if (margem !== null && margem < 0) motivosCriticos.push("Margem operacional negativa");
  if (quedaMaterial) motivosCriticos.push("Queda material de resultado contra o período comparado");
  if (curvaAEmRisco > 0 && potencial >= 5000) motivosCriticos.push("Produtos de Curva A concentram recuperação material");

  if (motivosCriticos.length) return { status: "critico", motivos: motivosCriticos };

  const motivosAtencao = [];
  if (dados?.confianca?.nivel === "parcial") motivosAtencao.push("Confiança parcial");
  if (margem !== null && margem < alvoMargem) motivosAtencao.push("Margem abaixo da meta");
  if (deltaResultado !== null && deltaResultado < -MATERIALIDADE_REAIS) motivosAtencao.push("Resultado piorou no período");
  if (negativos > 0) motivosAtencao.push(`${negativos} produto(s) no vermelho`);
  if (abaixoMeta > 0) motivosAtencao.push(`${abaixoMeta} produto(s) abaixo da margem-alvo`);

  if (motivosAtencao.length) return { status: "atencao", motivos: motivosAtencao };
  return { status: "saudavel", motivos: ["Sem desvio material identificado"] };
}

function normalizarAcoes(acoes, competencia) {
  const lista = Array.isArray(acoes) ? acoes : [];
  const noPeriodo = lista.filter((acao) => acao.competencia === competencia);
  const ultima = lista.length ? lista[lista.length - 1] : null;
  const creditoApurado = somaConhecidos(lista, (acao) => acao.credito_apurado);

  return {
    total: lista.length,
    noPeriodo: noPeriodo.length,
    creditoApurado,
    ultima: ultima
      ? {
          id: ultima.id,
          competencia: ultima.competencia,
          fator: ultima.fator || null,
          tipo: ultima.tipo || null,
          titulo: ultima.titulo || ultima.descricao || null,
          autor: ultima.autor || null,
          criadaEm: ultima.created_at || null,
          creditoApurado: numeroOuNull(ultima.credito_apurado),
        }
      : null,
  };
}

function calcularScorePrioridade(conta) {
  const pesoStatus = {
    critico: 4_000_000_000,
    atencao: 3_000_000_000,
    sem_dados: 2_000_000_000,
    saudavel: 1_000_000_000,
  }[conta.status] || 0;

  const perda = Math.max(0, -(conta.deltaResultado || 0));
  const potencial = Math.max(0, conta.potencialRecuperacao || 0);
  const bloqueada = Math.max(0, conta.receitaBloqueada || 0);
  return Math.round(pesoStatus + perda * 100 + potencial * 10 + bloqueada);
}

function normalizarConta(cliente, dados, acoes = [], erro = null) {
  if (erro || !dados) {
    const conta = {
      cliente: { id: cliente.id, nome: cliente.nome, slug: cliente.slug },
      status: "sem_dados",
      motivosStatus: [erro?.message || "Resultado indisponível"],
      erro: erro?.message || "Resultado indisponível.",
      carregado: false,
      confianca: "insuficiente",
      acoes: normalizarAcoes(acoes, null),
      href: `cliente-360-react.html?slug=${encodeURIComponent(cliente.slug)}`,
    };
    conta.scorePrioridade = calcularScorePrioridade(conta);
    return conta;
  }

  const atual = dados.fechamento?.atual || {};
  const variacoes = dados.fechamento?.variacoes || {};
  const classificacao = classificarSaude(dados);
  const causa = principalCausa(dados);
  const competencia = dados.periodo?.competencia || null;

  const conta = {
    cliente: dados.cliente || { id: cliente.id, nome: cliente.nome, slug: cliente.slug },
    status: classificacao.status,
    motivosStatus: classificacao.motivos,
    carregado: true,
    estado: dados.estado || null,
    periodo: dados.periodo || null,
    comparacao: dados.comparacao || null,
    faturamento: numeroOuNull(atual.faturamento),
    resultadoOperacional: numeroOuNull(atual.resultadoOperacional),
    resultadoAposAds: numeroOuNull(atual.resultadoAposAds),
    margemOperacional: numeroOuNull(atual.margemOperacional),
    margemAposAds: numeroOuNull(atual.margemAposAds),
    ads: numeroOuNull(atual.ads),
    deltaFaturamento: numeroOuNull(variacoes.faturamento?.abs),
    deltaResultado: numeroOuNull(variacoes.resultadoOperacional?.abs),
    deltaResultadoAposAds: numeroOuNull(variacoes.resultadoAposAds?.abs),
    deltaMargemPp: numeroOuNull(variacoes.margemOperacional?.pp),
    confianca: dados.confianca?.nivel || "insuficiente",
    coberturaResultado: numeroOuNull(dados.confianca?.coberturaResultado),
    coberturaCusto: numeroOuNull(dados.confianca?.coberturaCusto),
    coberturaFrete: numeroOuNull(dados.confianca?.coberturaFrete),
    receitaBloqueada: numeroOuNull(dados.confianca?.receitaBloqueada),
    alertas: dados.confianca?.alertas || [],
    produtosNegativos: Number(dados.produtos?.totais?.noVermelho || 0),
    produtosAbaixoMeta: Number(dados.produtos?.totais?.abaixoDaMargem || 0),
    produtosCurvaAEmRisco: Array.isArray(dados.produtos?.curvaAEmRisco)
      ? dados.produtos.curvaAEmRisco.length
      : 0,
    potencialRecuperacao: numeroOuNull(dados.oportunidades?.totalRecuperavel),
    causa,
    narrativa: primeiraMensagem(dados),
    acoes: normalizarAcoes(acoes, competencia),
    href: `cliente-360-react.html?slug=${encodeURIComponent(cliente.slug)}&competencia=${encodeURIComponent(competencia || "")}&compararCom=${encodeURIComponent(dados.comparacao?.competencia || "")}`,
  };
  conta.scorePrioridade = calcularScorePrioridade(conta);
  return conta;
}

async function executarComLimite(itens, tarefa, limite = LIMITE_CONCORRENCIA_PADRAO) {
  if (!itens.length) return [];
  const resultados = new Array(itens.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const indice = cursor;
      cursor += 1;
      if (indice >= itens.length) return;
      resultados[indice] = await tarefa(itens[indice], indice);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limite, itens.length) }, () => worker()));
  return resultados;
}

function agregarCausas(contas) {
  const mapa = new Map();
  for (const conta of contas) {
    const causa = conta.causa;
    if (!conta.carregado || !causa?.chave || causa.impacto === null || causa.impacto >= -MATERIALIDADE_REAIS) continue;
    const atual = mapa.get(causa.chave) || {
      chave: causa.chave,
      titulo: causa.titulo,
      impacto: 0,
      contas: 0,
      clientes: [],
    };
    atual.impacto += causa.impacto;
    atual.contas += 1;
    atual.clientes.push({
      slug: conta.cliente.slug,
      nome: conta.cliente.nome,
      impacto: causa.impacto,
    });
    mapa.set(causa.chave, atual);
  }

  return [...mapa.values()]
    .map((causa) => ({
      ...causa,
      impacto: Math.round(causa.impacto * 100) / 100,
      clientes: causa.clientes.sort((a, b) => a.impacto - b.impacto).slice(0, 5),
    }))
    .sort((a, b) => a.impacto - b.impacto);
}

function montarResumo(contas) {
  const validas = contas.filter((conta) => conta.carregado);
  const pioraram = validas.filter((conta) => (conta.deltaResultado || 0) < -MATERIALIDADE_REAIS).length;
  const melhoraram = validas.filter((conta) => (conta.deltaResultado || 0) > MATERIALIDADE_REAIS).length;
  const estaveis = validas.length - pioraram - melhoraram;

  return {
    totalContas: contas.length,
    contasComLeitura: validas.length,
    coberturaContas: contas.length ? validas.length / contas.length : 0,
    faturamento: somaConhecidos(validas, (conta) => conta.faturamento),
    resultadoOperacional: somaConhecidos(validas, (conta) => conta.resultadoOperacional),
    resultadoAposAds: somaConhecidos(validas, (conta) => conta.resultadoAposAds),
    deltaResultadoLiquido: somaConhecidos(validas, (conta) => conta.deltaResultado),
    perdaBruta: Math.abs(somaConhecidos(
      validas.filter((conta) => (conta.deltaResultado || 0) < 0),
      (conta) => conta.deltaResultado
    )),
    ganhoBruto: somaConhecidos(
      validas.filter((conta) => (conta.deltaResultado || 0) > 0),
      (conta) => conta.deltaResultado
    ),
    potencialRecuperacao: somaConhecidos(validas, (conta) => conta.potencialRecuperacao),
    receitaBloqueada: somaConhecidos(validas, (conta) => conta.receitaBloqueada),
    criticas: contas.filter((conta) => conta.status === "critico").length,
    atencao: contas.filter((conta) => conta.status === "atencao").length,
    saudaveis: contas.filter((conta) => conta.status === "saudavel").length,
    semDados: contas.filter((conta) => conta.status === "sem_dados").length,
    pioraram,
    melhoraram,
    estaveis,
    produtosNegativos: validas.reduce((s, conta) => s + (conta.produtosNegativos || 0), 0),
    produtosAbaixoMeta: validas.reduce((s, conta) => s + (conta.produtosAbaixoMeta || 0), 0),
    produtosCurvaAEmRisco: validas.reduce((s, conta) => s + (conta.produtosCurvaAEmRisco || 0), 0),
    acoesRegistradas: validas.reduce((s, conta) => s + (conta.acoes?.noPeriodo || 0), 0),
    creditoApurado: somaConhecidos(validas, (conta) => conta.acoes?.creditoApurado),
  };
}

function gerarNarrativaCarteira(resumo, causas) {
  if (!resumo.totalContas) return "Nenhuma conta ativa foi encontrada para compor a carteira.";
  if (!resumo.contasComLeitura) {
    return "Nenhuma conta possui fechamento suficiente para uma leitura executiva nesta competência.";
  }

  const movimento = resumo.deltaResultadoLiquido < -MATERIALIDADE_REAIS
    ? `caiu ${formatarReais(resumo.deltaResultadoLiquido)}`
    : resumo.deltaResultadoLiquido > MATERIALIDADE_REAIS
      ? `subiu ${formatarReais(resumo.deltaResultadoLiquido)}`
      : "ficou estável";

  const topCausas = causas.slice(0, 2).map((causa) =>
    `${causa.titulo.toLowerCase()} (${formatarReais(causa.impacto)} em ${causa.contas} conta${causa.contas === 1 ? "" : "s"})`
  );

  let texto = `O resultado operacional da carteira ${movimento}: ${resumo.pioraram} conta${resumo.pioraram === 1 ? " piorou" : "s pioraram"} e ${resumo.melhoraram} melhoraram.`;
  if (topCausas.length) texto += ` As maiores pressões vieram de ${topCausas.join(" e ")}.`;
  if (resumo.potencialRecuperacao > 0) {
    texto += ` Há ${formatarReais(resumo.potencialRecuperacao)} de recuperação operacional mapeada.`;
  }
  if (resumo.semDados > 0) {
    texto += ` ${resumo.semDados} conta${resumo.semDados === 1 ? " está" : "s estão"} sem leitura confiável.`;
  }
  return texto;
}

function createCarteiraService({
  clientesService = null,
  resultadoService = null,
  acoesRepo = null,
  limiteConcorrencia = LIMITE_CONCORRENCIA_PADRAO,
} = {}) {
  const clientes = clientesService || require("./cliente360Service");
  const resultados = resultadoService || require("./cliente360ResultadoService");
  const acoes = acoesRepo || require("./cliente360AcoesRepository");

  async function getCarteiraExecutiva(options = {}) {
    const listagem = await clientes.getClientesOperacional();
    const clientesAtivos = (listagem?.clientes || []).filter((cliente) => cliente?.ativo !== false);
    const marketplace = String(options.marketplace || "meli").trim().toLowerCase();

    const contas = await executarComLimite(clientesAtivos, async (cliente) => {
      try {
        const [dados, acoesCliente] = await Promise.all([
          resultados.getResultado(cliente.slug, {
            competencia: options.competencia,
            compararCom: options.compararCom,
            margemAlvo: options.margemAlvo,
            marketplace,
          }),
          acoes.listarAcoes(cliente.slug, {
            desde: options.compararCom || null,
            marketplace,
          }),
        ]);
        return normalizarConta(cliente, dados, acoesCliente);
      } catch (erro) {
        return normalizarConta(cliente, null, [], erro);
      }
    }, limiteConcorrencia);

    contas.sort((a, b) => b.scorePrioridade - a.scorePrioridade);
    const resumo = montarResumo(contas);
    const causas = agregarCausas(contas);

    return {
      ok: true,
      fonte: "cliente360_resultado_carteira",
      periodo: {
        competencia: options.competencia || contas.find((conta) => conta.periodo)?.periodo?.competencia || null,
        compararCom: options.compararCom || contas.find((conta) => conta.comparacao)?.comparacao?.competencia || null,
        marketplace,
      },
      resumo,
      narrativa: gerarNarrativaCarteira(resumo, causas),
      causas,
      contas,
      geradoEm: new Date().toISOString(),
    };
  }

  return { getCarteiraExecutiva };
}

module.exports = {
  getCarteiraExecutiva: (...args) => createCarteiraService().getCarteiraExecutiva(...args),
  createCarteiraService,
  principalCausa,
  classificarSaude,
  normalizarConta,
  executarComLimite,
  agregarCausas,
  montarResumo,
  gerarNarrativaCarteira,
  LIMITE_CONCORRENCIA_PADRAO,
};
