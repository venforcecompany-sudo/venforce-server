// server/services/motorMargem/margemCotacaoEmP.js
// Cotação REAL de comissão e frete de UM anúncio em preços hipotéticos (P').
//
// Um cotador vive UMA requisição: guarda a cotação por (MLB, P'), então os
// mesmos P' repetidos (30 promoções com poucos preços distintos) viram uma
// consulta só. Só leitura: `GET /sites/MLB/listing_prices` e
// `GET /users/{seller}/shipping_options/free`, pela mesma função da Central
// (`buscarComissaoEFrete`) e por `mlFetch` — nenhum cliente HTTP novo.
//
// Falha NUNCA vira estimativa: o resultado traz `comissao`/`frete` null e o
// motivo (`ml_rate_limit`, `ml_indisponivel`, …) por componente; quem
// consome (core/marginScenario) bloqueia o cenário — não cai na taxa atual
// nem no frete atual.

// Mesma regra de marketplaceCurrentQuoteService: frete combinável não tem
// custo previsto pelo ML — ausência legítima, não defeito.
const LOGISTICA_SEM_FRETE_PREVISTO = new Set(["not_specified", "custom", ""]);

const MOTIVOS_COTACAO = Object.freeze({
  ANUNCIO_SEM_TIPO_OU_CATEGORIA: "anuncio_sem_tipo_ou_categoria",
  CONTA_SEM_SELLER: "conta_sem_seller",
  ML_RATE_LIMIT: "ml_rate_limit",
  // 401/403: o token usado não tem permissão sobre o recurso — no ML, quase
  // sempre "access token de outro usuário" (doc erro-403). Em multi-conta é o
  // sinal de que a chamada saiu com o grant de OUTRA conta do cliente.
  ML_SEM_PERMISSAO: "ml_sem_permissao",
  ML_TIMEOUT: "ml_timeout",
  ML_INDISPONIVEL: "ml_indisponivel",
  ML_NAO_ENCONTRADO: "ml_nao_encontrado",
  ML_SEM_TARIFA: "ml_sem_tarifa",
  ML_SEM_FRETE: "ml_sem_frete",
  LIMITE_DE_COTACOES: "limite_de_cotacoes_excedido",
  // Cotação por item_id comprovadamente subestimada e sem como recuperar
  // (ver shared/freteCotacaoConfiavel): frete DESCONHECIDO, nunca um número.
  FRETE_COTACAO_NAO_CONFIAVEL: "frete_cotacao_nao_confiavel",
});

function motivoDaResposta(registro, semValor) {
  if (!registro) return MOTIVOS_COTACAO.ML_INDISPONIVEL;
  if (registro.status === 429) return MOTIVOS_COTACAO.ML_RATE_LIMIT;
  if (registro.status === 401 || registro.status === 403) return MOTIVOS_COTACAO.ML_SEM_PERMISSAO;
  if (registro.timeout === true) return MOTIVOS_COTACAO.ML_TIMEOUT;
  if (registro.status === 404) return MOTIVOS_COTACAO.ML_NAO_ENCONTRADO;
  if (!registro.ok) return MOTIVOS_COTACAO.ML_INDISPONIVEL;
  return semValor;
}

function numOuNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function mapComLimite(itens, limite, fn) {
  const saida = new Array(itens.length);
  let proximo = 0;
  async function trabalhador() {
    while (proximo < itens.length) {
      const i = proximo++;
      saida[i] = await fn(itens[i], i);
    }
  }
  const n = Math.max(1, Math.min(limite, itens.length));
  await Promise.all(Array.from({ length: n }, trabalhador));
  return saida;
}

/**
 * @param {object} p
 * @param {number|string} p.clienteId
 * @param {string} p.itemId
 * @param {object|null} p.anuncio    linha de meli_anuncios (listing_type_id, category_id, logistic_type)
 * @param {string|null} p.sellerId
 * @param {string|null} p.mlUserId   conta cujo token consulta o ML
 * @param {Function} p.buscarComissaoEFrete
 * @param {Function} p.mlFetch
 * @param {Function} [p.now]
 * @param {number} [p.maxCotacoes]   preços DISTINTOS por requisição
 * @param {number} [p.concorrencia]
 * @param {number} [p.timeoutMs]
 */
function criarCotadorEmP({
  clienteId, itemId, anuncio, sellerId, mlUserId, buscarComissaoEFrete, mlFetch,
  now = () => new Date(), maxCotacoes = 40, concorrencia = 4, timeoutMs = 8000,
}) {
  const cache = new Map(); // "89.77" → Promise<cotação>
  const memoFrete = {}; // tags/envios históricos do MLB: independem do preço P'
  const tagsDoAnuncio = anuncio && Array.isArray(anuncio.shipping_tags) ? anuncio.shipping_tags : null;
  const stats = { chamadas: 0, listing_prices: 0, shipping_options: 0, precos_distintos: 0, limite_excedido: 0 };
  const logistica = anuncio ? String(anuncio.logistic_type || "") : "";
  const freteAplicavel = !LOGISTICA_SEM_FRETE_PREVISTO.has(logistica);

  async function consultar(preco) {
    const consultadoEm = now().toISOString();
    const resultado = {
      preco,
      comissao: null,
      frete: null,
      frete_aplicavel: freteAplicavel,
      limite_excedido: false,
      motivos: { comissao: null, frete: null },
      fonte: {
        comissao: "ml_listing_prices",
        frete: freteAplicavel ? "ml_shipping_options_free" : "logistica_combinavel",
      },
      consultado_em: consultadoEm,
    };
    if (!anuncio || !anuncio.listing_type_id || !anuncio.category_id) {
      resultado.motivos.comissao = MOTIVOS_COTACAO.ANUNCIO_SEM_TIPO_OU_CATEGORIA;
      if (freteAplicavel) resultado.motivos.frete = MOTIVOS_COTACAO.ANUNCIO_SEM_TIPO_OU_CATEGORIA;
      return resultado;
    }
    if (freteAplicavel && !sellerId) {
      resultado.motivos.frete = MOTIVOS_COTACAO.CONTA_SEM_SELLER;
    }

    // Registra o status de cada GET (mlFetch não lança em HTTP não-2xx), para o
    // motivo dizer "rate limit" em vez de um genérico "indisponível".
    const registros = { listing: null, frete: null };
    const fetchRegistrando = async (cId, caminho, opts = {}) => {
      const texto = String(caminho);
      const chave = texto.includes("/listing_prices") ? "listing" : texto.includes("/shipping_options/free") ? "frete" : null;
      // Leituras auxiliares do frete confiável (items/orders/shipments) não
      // sobrescrevem o status da cotação de frete.
      if (chave === null) return mlFetch(cId, caminho, { ...opts, ...(mlUserId ? { mlUserId } : {}), timeoutMs });
      if (chave === "listing") stats.listing_prices += 1; else stats.shipping_options += 1;
      try {
        const resp = await mlFetch(cId, caminho, { ...opts, ...(mlUserId ? { mlUserId } : {}), timeoutMs });
        registros[chave] = resp ? { ok: resp.ok === true, status: resp.status ?? null } : null;
        return resp;
      } catch (err) {
        registros[chave] = { ok: false, status: null, erro: err && (err.code || err.message), timeout: Boolean(err && err.name === "MlTimeoutError") };
        throw err;
      }
    };

    stats.chamadas += 1;
    let bruta = { comissaoValor: null, fretePrevisto: null };
    try {
      bruta = await buscarComissaoEFrete({
        clienteId,
        itemId,
        precoEfetivo: preco,
        listingTypeId: anuncio.listing_type_id,
        categoryId: anuncio.category_id,
        sellerId: sellerId || null,
        logisticType: logistica,
        mlUserId: mlUserId || null,
        shippingTags: tagsDoAnuncio,
        memoFrete,
      }, fetchRegistrando);
    } catch (_) {
      bruta = { comissaoValor: null, fretePrevisto: null };
    }

    resultado.comissao = numOuNull(bruta && bruta.comissaoValor);
    if (resultado.comissao === null) {
      resultado.motivos.comissao = motivoDaResposta(registros.listing, MOTIVOS_COTACAO.ML_SEM_TARIFA);
    }
    if (freteAplicavel) {
      resultado.frete = numOuNull(bruta && bruta.fretePrevisto);
      if (resultado.frete === null && !resultado.motivos.frete) {
        const motivoBruto = bruta && bruta.diagnostico && bruta.diagnostico.frete && bruta.diagnostico.frete.motivo;
        resultado.motivos.frete = motivoBruto || motivoDaResposta(registros.frete, MOTIVOS_COTACAO.ML_SEM_FRETE);
      }
      if (bruta && bruta.freteQualidade) resultado.frete_qualidade = bruta.freteQualidade;
    }
    return resultado;
  }

  function cotar(preco) {
    const chave = Number(preco).toFixed(2);
    if (cache.has(chave)) return cache.get(chave);
    if (cache.size >= maxCotacoes) {
      stats.limite_excedido += 1;
      return Promise.resolve({
        preco, comissao: null, frete: null, frete_aplicavel: freteAplicavel, limite_excedido: true,
        motivos: { comissao: MOTIVOS_COTACAO.LIMITE_DE_COTACOES, frete: freteAplicavel ? MOTIVOS_COTACAO.LIMITE_DE_COTACOES : null },
        fonte: { comissao: "ml_listing_prices", frete: freteAplicavel ? "ml_shipping_options_free" : "logistica_combinavel" },
        consultado_em: null,
      });
    }
    stats.precos_distintos += 1;
    const promessa = consultar(Number(chave));
    cache.set(chave, promessa);
    return promessa;
  }

  /** Cota vários preços (dedupe + concorrência limitada); devolve Map "89.77" → cotação. */
  async function cotarVarios(precos) {
    const distintos = Array.from(new Set(precos.filter((p) => Number.isFinite(Number(p)) && Number(p) > 0).map((p) => Number(p).toFixed(2))));
    const resultados = await mapComLimite(distintos, concorrencia, (chave) => cotar(Number(chave)));
    return new Map(distintos.map((chave, i) => [chave, resultados[i]]));
  }

  return { cotar, cotarVarios, estatisticas: () => ({ ...stats }), freteAplicavel };
}

/** Cotação → entrada `cotacao` do core.calcularCenario. */
function cotacaoParaNucleo(cotacao) {
  return {
    comissao: cotacao.comissao,
    frete: cotacao.frete,
    frete_aplicavel: cotacao.frete_aplicavel,
    limite_excedido: cotacao.limite_excedido,
  };
}

/** Evidência (fonte, data e motivo) de uma cotação, por componente. */
function evidenciaDaCotacao(cotacao) {
  if (!cotacao) return null;
  return {
    comissao: {
      fonte: cotacao.fonte.comissao,
      consultado_em: cotacao.consultado_em,
      motivo: cotacao.comissao === null ? cotacao.motivos.comissao : null,
    },
    frete: {
      fonte: cotacao.fonte.frete,
      consultado_em: cotacao.frete_aplicavel ? cotacao.consultado_em : null,
      motivo: cotacao.frete === null && cotacao.frete_aplicavel ? cotacao.motivos.frete : null,
      aplicavel: cotacao.frete_aplicavel,
      ...(cotacao.frete_qualidade ? { qualidade: cotacao.frete_qualidade } : {}),
    },
  };
}

module.exports = { criarCotadorEmP, cotacaoParaNucleo, evidenciaDaCotacao, motivoDaResposta, MOTIVOS_COTACAO, LOGISTICA_SEM_FRETE_PREVISTO, mapComLimite };
