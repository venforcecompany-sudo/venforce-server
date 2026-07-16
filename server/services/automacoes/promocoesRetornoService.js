// server/services/automacoes/promocoesRetornoService.js
// Service MVP (somente leitura) da tela "Promoções com Retorno ML".
//
// Cruza anúncios ativos do Mercado Livre com a base de custo do cliente e as
// promoções oficiais disponíveis (GET /seller-promotions/items/{MLB}?app_version=v2)
// para decidir se vale a pena entrar na promoção considerando o retorno do ML.
//
// IMPORTANTE:
//   - Não persiste nada no banco.
//   - Não altera preço, estoque, anúncio ou campanha.
//   - Não entra em promoções: apenas LÊ.
//   - Refresh de token OAuth é permitido (via mlFetch) só para não quebrar por
//     expiração do access_token — isso não altera dados do cliente.

const pool = require("../../config/database");
const { mlFetch } = require("../../utils/mlClient");
const { exigirContextoPronto } = require("./contextoPrecificacaoService");

// ─── Helpers ────────────────────────────────────────────────────────────────

function normalizarSlug(nome) {
  return String(nome || "").trim().toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\-]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
}

function criarErroHttp(statusCode, payload) {
  const err = new Error(payload?.erro || "Erro");
  err.statusCode = statusCode;
  err.payload = payload;
  return err;
}

// Aceita margem/tolerância em duas convenções: 0.10 (fração) ou 10 (percentual).
// > 1  → trata como percentual e divide por 100.
// 0..1 → usa direto.
function toAliquota(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n > 1) return n / 100;
  return n;
}

// Interpreta valores "verdadeiros" vindos da query string.
function isTrueLike(value) {
  return value === true || value === "true" || value === "1" || value === 1;
}

// Retorna o número se for finito; caso contrário null (nunca NaN no JSON).
function fin(n) {
  return Number.isFinite(n) ? n : null;
}

// Arredonda para 2 casas mantendo null quando não há valor.
function round2OrNull(n) {
  return Number.isFinite(n) ? Number(n.toFixed(2)) : null;
}

// Arredonda para 4 casas (margens em fração) mantendo null.
function round4OrNull(n) {
  return Number.isFinite(n) ? Number(n.toFixed(4)) : null;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Limitador de concorrência simples (mesmo padrão usado no diagnóstico).
function pLimit(concorrencia) {
  const fila = [];
  let ativos = 0;
  const proximo = () => {
    ativos--;
    if (fila.length > 0) fila.shift()();
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      const run = () => {
        ativos++;
        Promise.resolve()
          .then(fn)
          .then((v) => { proximo(); resolve(v); })
          .catch((e) => { proximo(); reject(e); });
      };
      if (ativos < concorrencia) run();
      else fila.push(run);
    });
}

// Extração de SKU do corpo do item (variação reduzida do diagnóstico).
function extrairSkuMl(body) {
  const direto = [body?.seller_custom_field, body?.sku]
    .map((v) => String(v || "").trim())
    .find(Boolean);
  if (direto) return direto;

  const nomeEhSku = (txt) => String(txt || "").toLowerCase().includes("sku");
  const attrs = Array.isArray(body?.attributes) ? body.attributes : [];
  for (const a of attrs) {
    const id = String(a?.id || "");
    const name = String(a?.name || "");
    if (!nomeEhSku(id) && !nomeEhSku(name)) continue;
    const val = a?.value_name ?? a?.value_id ?? a?.value_struct?.number ?? a?.value_struct?.unit ?? null;
    const sku = String(val || "").trim();
    if (sku) return sku;
  }
  return null;
}

const PROMO_ENRICH_CONCURRENCY = 4; // chamadas ML por item em paralelo controlado

// Classifica a ORIGEM da promoção (quem a criou) a partir do objeto de oferta
// retornado por /seller-promotions/items/{MLB}. Nunca "inventa": quando não há
// sinal confiável, devolve criadaPorMim=null e origem "Origem não identificada".
//
// Prioridade (documentada no produto):
//   1) type/campaign_type/promotion_type === SELLER_CAMPAIGN → criada pelo seller.
//   2) created_by/owner/source/creator/promotion_source/campaign_owner indicando
//      seller/user (ou meli/marketplace) → usa esse sinal.
//   3) Tipos claramente do Mercado Livre (DEAL, DOD, MARKETPLACE_CAMPAIGN, …).
//   4) Sem sinal confiável → "Origem não identificada".
function classificarOrigemPromocao(promo) {
  const tipoRaw = String(
    promo?.type || promo?.campaign_type || promo?.promotion_type || ""
  ).trim();
  const tipoUpper = tipoRaw.toUpperCase();

  if (tipoUpper === "SELLER_CAMPAIGN") {
    return { criadaPorMim: true, origemPromocao: "Criada por mim (SELLER_CAMPAIGN)" };
  }

  // 2) Campos alternativos de autoria (usados só quando existirem).
  const candidatos = [
    promo?.created_by, promo?.owner, promo?.source, promo?.creator,
    promo?.promotion_source, promo?.campaign_owner,
  ];
  for (const c of candidatos) {
    const v = String(c || "").trim().toLowerCase();
    if (!v) continue;
    if (v.includes("seller") || v.includes("user")) {
      return { criadaPorMim: true, origemPromocao: `Criada por mim (${String(c).trim()})` };
    }
    if (v.includes("meli") || v.includes("marketplace") || v.includes("mercado")) {
      return { criadaPorMim: false, origemPromocao: `Mercado Livre (${String(c).trim()})` };
    }
  }

  // 3) Tipos reconhecidamente do Mercado Livre.
  const TIPOS_ML = ["MARKETPLACE_CAMPAIGN", "DEAL", "DOD", "LIGHTNING", "SMART", "PRICE_MATCHING", "MELI"];
  if (tipoUpper && TIPOS_ML.some((t) => tipoUpper.includes(t))) {
    return { criadaPorMim: false, origemPromocao: `Mercado Livre (${tipoRaw})` };
  }

  // 4) Sem sinal confiável — não inventar.
  return {
    criadaPorMim: null,
    origemPromocao: tipoRaw ? `Origem não identificada (${tipoRaw})` : "Origem não identificada",
  };
}

// Seleciona a promoção relevante para o item, aplicando filtros opcionais.
function escolherPromocao(lista, { campanha, status }) {
  if (!Array.isArray(lista) || !lista.length) return null;

  let candidatos = lista.filter((p) => p && typeof p === "object");

  if (status) {
    const alvo = String(status).toLowerCase();
    const filtrado = candidatos.filter(
      (p) => String(p?.status || "").toLowerCase() === alvo
    );
    if (filtrado.length) candidatos = filtrado;
  }

  if (campanha) {
    const alvo = String(campanha).toLowerCase();
    const filtrado = candidatos.filter((p) => {
      const nome = String(p?.name || "").toLowerCase();
      const tipo = String(p?.type || "").toLowerCase();
      return nome.includes(alvo) || tipo.includes(alvo);
    });
    if (filtrado.length) candidatos = filtrado;
  }

  // Preferir promoções em andamento; senão a primeira disponível.
  const ativos = candidatos.filter((p) => {
    const st = String(p?.status || "").toLowerCase();
    return st === "started" || st === "active";
  });
  const pool_ = ativos.length ? ativos : candidatos;

  // Entre as candidatas, escolher a de maior meli_percentage (maior retorno ML).
  let escolhida = null;
  let melhorMeli = -Infinity;
  for (const p of pool_) {
    const meli = Number(p?.meli_percentage);
    const score = Number.isFinite(meli) ? meli : -1;
    if (score > melhorMeli) {
      melhorMeli = score;
      escolhida = p;
    }
  }
  return escolhida || pool_[0] || null;
}

// ─── Enriquecimento por item ─────────────────────────────────────────────────

async function enriquecerItem({
  clienteId,
  body,
  baseRow,
  matchedBy = null,
  snapshot = null,
  snapshotMatchedBy = null,
  skuExtraido = null,
  margemAlvo,
  tolerancia,
  filtros,
}) {
  const itemId = String(body?.id || "").trim();
  const sku = extrairSkuMl(body);
  const listingTypeId = body?.listing_type_id || null;
  const categoryId = body?.category_id || null;
  const sellerId = body?.seller_id || null;
  const titulo = body?.title || null;

  // 1) Promoções oficiais do item (somente leitura).
  let lista = [];
  try {
    if (itemId) {
      const resp = await mlFetch(
        clienteId,
        `/seller-promotions/items/${encodeURIComponent(itemId)}?app_version=v2`
      );
      if (resp?.ok) {
        lista = Array.isArray(resp.data)
          ? resp.data
          : Array.isArray(resp.data?.results)
            ? resp.data.results
            : [];
      }
    }
  } catch (err) {
    console.warn(`[promocoes-retorno] item ${itemId} — falha ao buscar promoções: ${err.message}`);
    lista = [];
  }

  // Contadores por item (independentes do filtro), para o resumo agregado.
  // Retorno ML = oferta com meli_percentage numérico maior que zero.
  // meli_percentage ausente NÃO conta como retorno (não vira zero forçado).
  const ofertasTotalItem = lista.filter((o) => o && typeof o === "object").length;
  const ofertasComRetornoItem = lista.filter((o) => Number(o?.meli_percentage) > 0).length;

  // Filtro "apenas com retorno ML": só ofertas com meli_percentage > 0.
  const ofertasFiltradas = filtros.apenasComRetorno
    ? lista.filter((o) => Number(o?.meli_percentage) > 0)
    : lista;

  const promo = escolherPromocao(ofertasFiltradas, filtros);

  // Sem promoção elegível → não vira linha, mas mantém os contadores do item.
  if (!promo) return { linha: null, ofertasTotalItem, ofertasComRetornoItem };

  const precoOriginal = fin(Number(promo?.original_price));
  const precoPromocao = fin(Number(promo?.price));
  if (precoPromocao === null || precoPromocao <= 0) {
    return { linha: null, ofertasTotalItem, ofertasComRetornoItem };
  }

  const meliPercentage = fin(Number(promo?.meli_percentage));
  const sellerPercentage = fin(Number(promo?.seller_percentage));
  const campanha = promo?.name || null;
  const promotionId = promo?.id || null;
  const promotionType = promo?.type || null;
  const promotionStatus = promo?.status || null;
  const offerRefId = promo?.ref_id || null;

  // Origem da promoção (quem criou) — ver classificarOrigemPromocao.
  const { criadaPorMim, origemPromocao } = classificarOrigemPromocao(promo);
  // Retorno ML numérico > 0 marca a oferta como "com retorno ML".
  const temRetornoMl = Number(meliPercentage) > 0;

  const descontoTotal =
    precoOriginal !== null && precoPromocao !== null
      ? precoOriginal - precoPromocao
      : null;

  // retornoMl = original_price * (meli_percentage / 100)
  const retornoMl =
    precoOriginal !== null && meliPercentage !== null
      ? precoOriginal * (meliPercentage / 100)
      : null;
  const retornoPctSobreFinal =
    retornoMl !== null && precoPromocao ? retornoMl / precoPromocao : null;

  // retornoMl como número seguro para somar (somado UMA vez no rebate).
  const retMl = Number.isFinite(retornoMl) ? retornoMl : 0;

  // 2) FONTE FINANCEIRA PRINCIPAL: snapshot do último relatorio_itens salvo.
  // custos (baseRow) é fallback APENAS para custo/imposto/taxa_fixa.
  const temSnapshot = !!snapshot;
  const temBase = !!baseRow;

  const precoEfetivoRelatorio = temSnapshot ? snapshot.precoEfetivo : null;

  const custoProduto =
    temSnapshot && snapshot.custo != null
      ? snapshot.custo
      : (temBase ? fin(Number(baseRow.custoProduto)) : null);

  const impostoPercentual =
    temSnapshot && snapshot.impostoPercentual != null
      ? snapshot.impostoPercentual
      : (temBase ? fin(Number(baseRow.impostoPercentual)) : null);
  const impostoAliquota = impostoPercentual != null ? toAliquota(impostoPercentual) : null;

  // Taxa fixa: snapshot → base → 0 (taxa ausente é tratada como zero).
  const taxaFixa =
    temSnapshot && snapshot.taxaFixa != null
      ? snapshot.taxaFixa
      : (temBase && baseRow.taxaFixa != null ? fin(Number(baseRow.taxaFixa)) : 0);

  // Frete: SOMENTE do snapshot (não inventar, não usar API/custos).
  const frete = temSnapshot ? snapshot.frete : null;

  // Comissão: preferir comissao_percentual do snapshot; senão derivar de comissao/preco_efetivo.
  let comissaoAliquota = null;
  let comissaoDerivadaDeValor = false;
  if (temSnapshot) {
    if (snapshot.comissaoPercentual != null) {
      comissaoAliquota = toAliquota(snapshot.comissaoPercentual);
    } else if (snapshot.comissao != null && snapshot.precoEfetivo) {
      comissaoAliquota = snapshot.comissao / snapshot.precoEfetivo;
      comissaoDerivadaDeValor = true;
    }
  }
  const comissaoPercentual =
    comissaoAliquota != null ? Number((comissaoAliquota * 100).toFixed(4)) : null;
  const fonteComissao =
    comissaoAliquota == null ? null : (comissaoDerivadaDeValor ? "relatorio_itens(derivada)" : "relatorio_itens");

  // 3) MARGEM PRINCIPAL — fórmula da planilha sobre o PREÇO DA PROMOÇÃO:
  // LC = preço - preço*imposto% - preço*comissão% - frete - taxaFixa - custo + retornoMl
  const temInsumos =
    temSnapshot &&
    custoProduto !== null &&
    impostoAliquota !== null &&
    comissaoAliquota !== null &&
    frete !== null &&
    taxaFixa !== null;

  let impostoValor = null;
  let comissaoValor = null;
  let lcSemRebate = null;
  let mcSemRebate = null;
  let lcComRebate = null;
  let mcComRebate = null;
  let lucroAlvo = null;
  let retornoNecessario = null;
  let faltaRetorno = null;
  let diferencaPp = null;

  if (temInsumos) {
    impostoValor = precoPromocao * impostoAliquota;
    comissaoValor = precoPromocao * comissaoAliquota;

    lcSemRebate =
      precoPromocao - impostoValor - comissaoValor - frete - taxaFixa - custoProduto;
    mcSemRebate = precoPromocao ? lcSemRebate / precoPromocao : null;

    // Com rebate: soma o retorno ML UMA única vez. Denominador = preço promocional.
    lcComRebate = lcSemRebate + retMl;
    mcComRebate = precoPromocao ? lcComRebate / precoPromocao : null;

    if (margemAlvo !== null) {
      lucroAlvo = precoPromocao * margemAlvo;
      retornoNecessario = lucroAlvo - lcSemRebate;
      faltaRetorno = retornoNecessario - retMl;
      diferencaPp = mcComRebate !== null ? mcComRebate - margemAlvo : null;
    }
  }

  // 4) Classificação / decisão — usa a margem de rebate (mcComRebate).
  let decisao;
  let motivo;
  if (!temSnapshot) {
    decisao = "sem_relatorio";
    motivo = "Produto sem relatório financeiro salvo. Rode um diagnóstico/relatório antes de decidir esta promoção.";
  } else if (
    custoProduto === null || impostoAliquota === null ||
    frete === null || comissaoAliquota === null
  ) {
    decisao = "dados_incompletos";
    motivo = "Relatório encontrado, mas faltou custo, imposto, frete ou comissão para calcular a margem de rebate.";
  } else if (mcComRebate === null) {
    decisao = "dados_incompletos";
    motivo = "Relatório sem dados suficientes para calcular a margem de rebate.";
  } else if (margemAlvo !== null && mcComRebate >= margemAlvo) {
    decisao = "entrar_seguro";
    motivo = "Margem de rebate (com retorno ML) igual ou acima do alvo.";
  } else if (
    margemAlvo !== null &&
    tolerancia !== null &&
    mcComRebate >= margemAlvo - tolerancia
  ) {
    decisao = "entrar_com_tolerancia";
    motivo = "Margem de rebate (com retorno ML) dentro da tolerância do alvo.";
  } else if (mcComRebate >= 0) {
    decisao = "baixo_mesmo_com_rebate";
    motivo = "Margem positiva, porém baixa mesmo com o rebate do ML.";
  } else {
    decisao = "nao_entrar";
    motivo = "Mesmo com o rebate do ML, a margem fica negativa.";
  }

  return {
   ofertasTotalItem,
   ofertasComRetornoItem,
   linha: {
    itemId: itemId || null,
    sku: sku || null,
    titulo,
    campanha,
    promotionId,
    promotionType,
    promotionStatus,
    offerRefId,
    criadaPorMim,
    origemPromocao,
    temRetornoMl,
    precoOriginal: round2OrNull(precoOriginal),
    precoPromocao: round2OrNull(precoPromocao),
    descontoTotal: round2OrNull(descontoTotal),
    meliPercentage,
    sellerPercentage,
    retornoMl: round2OrNull(retornoMl),
    retornoPctSobreFinal: round4OrNull(retornoPctSobreFinal),
    comissaoPercentual,
    comissaoValor: round2OrNull(comissaoValor),
    impostoValor: round2OrNull(impostoValor),
    frete: round2OrNull(frete),
    custo: round2OrNull(custoProduto),
    impostoPercentual,
    taxaFixa: round2OrNull(taxaFixa),
    // Margem de rebate (nomes novos da planilha)
    lcSemRebate: round2OrNull(lcSemRebate),
    mcSemRebate: round4OrNull(mcSemRebate),
    lcComRebate: round2OrNull(lcComRebate),
    mcComRebate: round4OrNull(mcComRebate),
    // Compatibilidade com o frontend atual (apontam para os mesmos valores)
    lcSemRetorno: round2OrNull(lcSemRebate),
    mcSemRetorno: round4OrNull(mcSemRebate),
    lcComRetorno: round2OrNull(lcComRebate),
    mcComRetorno: round4OrNull(mcComRebate),
    margemAlvo,
    diferencaPp: round4OrNull(diferencaPp),
    retornoNecessario: round2OrNull(retornoNecessario),
    faltaRetorno: round2OrNull(faltaRetorno),
    decisao,
    motivo,
    temBase,
    temSnapshot,
    relatorioId: temSnapshot ? snapshot.relatorioId : null,
    relatorioCreatedAt: temSnapshot ? snapshot.relatorioCreatedAt : null,
    debug: {
      fonteFinanceira: temSnapshot ? "relatorio_itens" : null,
      relatorioId: temSnapshot ? snapshot.relatorioId : null,
      relatorioCreatedAt: temSnapshot ? snapshot.relatorioCreatedAt : null,
      itemIdUsadoNoMatch: temSnapshot ? (snapshot.itemId || null) : null,
      skuUsadoNoMatch: snapshotMatchedBy === "sku" ? (snapshot?.sku || skuExtraido || null) : null,
      snapshotMatchedBy,
      custoFonte: temSnapshot && snapshot.custo != null ? "relatorio_itens" : (temBase ? "custos(fallback)" : null),
      custo: round2OrNull(custoProduto),
      frete: round2OrNull(frete),
      taxaFixa: round2OrNull(taxaFixa),
      impostoPercentual,
      comissaoPercentual,
      comissaoFonte: fonteComissao,
      comissaoDerivadaDeValor,
      precoEfetivoRelatorio: round2OrNull(precoEfetivoRelatorio),
      precoPromocao: round2OrNull(precoPromocao),
      retornoMl: round2OrNull(retornoMl),
      impostoValor: round2OrNull(impostoValor),
      comissaoValor: round2OrNull(comissaoValor),
      lcSemRebate: round2OrNull(lcSemRebate),
      lcComRebate: round2OrNull(lcComRebate),
      mcComRebate: round4OrNull(mcComRebate),
      formula: "precoPromo - precoPromo*imposto - precoPromo*comissao - frete - taxaFixa - custo + retornoMl",
      // auditoria do casamento de custo na base (fallback):
      baseProdutoIdMatch: temBase ? (baseRow.produtoId || null) : null,
      baseMatchedBy: matchedBy,
    },
   },
  };
}

// ─── Contexto financeiro (custos + snapshot de relatorio_itens) ──────────────
// Monta os mapas de match de custo (base) e de snapshot financeiro (último
// relatório concluído por item) e devolve as funções de casamento matchBase /
// matchSnapshot. Usado tanto pelo preview paginado quanto pelo diagnóstico.
async function carregarContextoFinanceiro({ clienteId, baseId }) {
  const numOrNull = (v) =>
    v != null && Number.isFinite(Number(v)) ? Number(v) : null;

  // Custos da base → mapas de match (exato, normalizado, numérico).
  const custosMapExact = new Map();
  const custosMapNorm = new Map();
  const custosMapNumeric = new Map();
  const custosRes = await pool.query(
    "SELECT produto_id, custo_produto, imposto_percentual, taxa_fixa FROM custos WHERE base_id = $1",
    [baseId]
  );
  custosRes.rows.forEach((row) => {
    const key = String(row.produto_id || "").trim();
    if (!key) return;
    // comissão/frete: lidos de forma defensiva (a tabela `custos` atual não tem
    // essas colunas → ficam null; se a base passar a fornecê-las, são aproveitadas).
    const comissaoRaw = row.comissao_percentual ?? row.comissao_marketplace ?? row.comissao;
    const freteRaw = row.frete ?? row.frete_valor;
    const payload = {
      produtoId: key,
      custoProduto: Number(row.custo_produto),
      impostoPercentual: Number(row.imposto_percentual),
      taxaFixa: Number(row.taxa_fixa),
      comissaoPercentual: numOrNull(comissaoRaw),
      frete: numOrNull(freteRaw),
    };
    custosMapExact.set(key, payload);
    custosMapNorm.set(key.toUpperCase(), payload);
    if (/^\d+$/.test(key)) custosMapNumeric.set(key, payload);
  });

  // Retorna { row, matchedBy } expondo COMO o custo foi casado (para auditoria/debug).
  function matchBase(itemId, sku) {
    const id = String(itemId || "").trim();
    const upper = id.toUpperCase();
    let row = custosMapExact.get(id) || custosMapNorm.get(upper) || null;
    if (row) return { row, matchedBy: "mlb_exato" };

    if (upper.startsWith("MLB") && !upper.startsWith("MLBU")) {
      const num = upper.slice(3).match(/^\d+/)?.[0] || "";
      if (num && custosMapNumeric.has(num)) {
        return { row: custosMapNumeric.get(num), matchedBy: "mlb_numero" };
      }
    }
    if (sku) {
      const sk = String(sku).trim();
      row = custosMapExact.get(sk) || custosMapNorm.get(sk.toUpperCase()) || null;
      if (row) return { row, matchedBy: "sku" };
    }
    return { row: null, matchedBy: null };
  }

  // FONTE PRINCIPAL DA MARGEM: último snapshot financeiro salvo em relatorio_itens.
  const snapExact = new Map();   // item_id (e UPPER) -> snapshot
  const snapNumeric = new Map(); // número do MLB -> snapshot
  const snapSku = new Map();     // sku -> snapshot
  try {
    const snapRes = await pool.query(
      `SELECT DISTINCT ON (ri.item_id)
              ri.item_id, ri.sku, ri.preco_efetivo, ri.custo, ri.imposto_percentual,
              ri.taxa_fixa, ri.frete, ri.comissao, ri.comissao_percentual,
              r.id AS relatorio_id, r.created_at AS relatorio_created_at
         FROM relatorio_itens ri
         JOIN relatorios r ON r.id = ri.relatorio_id
        WHERE r.status = 'concluido'
          AND r.cliente_id = $1
          AND r.base_id = $2
        ORDER BY ri.item_id, r.created_at DESC, ri.id DESC`,
      [clienteId, baseId]
    );
    snapRes.rows.forEach((row) => {
      const itemId = String(row.item_id || "").trim();
      const snap = {
        itemId,
        sku: row.sku ? String(row.sku).trim() : null,
        precoEfetivo: numOrNull(row.preco_efetivo),
        custo: numOrNull(row.custo),
        impostoPercentual: numOrNull(row.imposto_percentual),
        taxaFixa: numOrNull(row.taxa_fixa),
        frete: numOrNull(row.frete),
        comissao: numOrNull(row.comissao),
        comissaoPercentual: numOrNull(row.comissao_percentual),
        relatorioId: row.relatorio_id,
        relatorioCreatedAt: row.relatorio_created_at,
      };
      if (itemId) {
        snapExact.set(itemId, snap);
        const up = itemId.toUpperCase();
        snapExact.set(up, snap);
        if (up.startsWith("MLB") && !up.startsWith("MLBU")) {
          const num = up.slice(3).match(/^\d+/)?.[0];
          if (num) snapNumeric.set(num, snap);
        } else if (/^\d+$/.test(itemId)) {
          snapNumeric.set(itemId, snap);
        }
      }
      if (snap.sku) snapSku.set(snap.sku, snap);
    });
  } catch (err) {
    console.warn(`[promocoes-retorno] falha ao carregar snapshots de relatorio_itens: ${err.message}`);
  }

  function matchSnapshot(itemId, sku) {
    const id = String(itemId || "").trim();
    const up = id.toUpperCase();
    let snap = snapExact.get(id) || snapExact.get(up) || null;
    if (snap) return { snap, by: "item_id" };
    if (up.startsWith("MLB") && !up.startsWith("MLBU")) {
      const num = up.slice(3).match(/^\d+/)?.[0];
      if (num && snapNumeric.has(num)) return { snap: snapNumeric.get(num), by: "item_id_numerico" };
    }
    if (sku) {
      const sk = String(sku).trim();
      if (snapSku.has(sk)) return { snap: snapSku.get(sk), by: "sku" };
    }
    return { snap: null, by: null };
  }

  return { matchBase, matchSnapshot };
}

// ─── Entrada principal ───────────────────────────────────────────────────────

async function gerarPreviewPromocoesRetorno({
  clienteSlugRaw,
  baseSlugRaw,
  margemAlvoRaw,
  toleranciaRaw,
  pageRaw,
  limitRaw,
  campanhaRaw,
  statusRaw,
  apenasComRetornoRaw,
}) {
  const clienteSlugRawStr = String(clienteSlugRaw || "").trim();
  const baseSlugRawStr = String(baseSlugRaw || "").trim();

  if (!clienteSlugRawStr) throw criarErroHttp(400, { ok: false, erro: "clienteSlug é obrigatório" });

  const page = Math.max(1, parseInt(pageRaw) || 1);
  const limit = Math.min(Math.max(1, parseInt(limitRaw) || 20), 50);
  const offset = (page - 1) * limit;

  const margemAlvo = toAliquota(margemAlvoRaw);
  const tolerancia = toAliquota(toleranciaRaw);

  // Padrão recomendado: true (focar em promoções com retorno do ML).
  const apenasComRetorno =
    apenasComRetornoRaw === undefined ? true : isTrueLike(apenasComRetornoRaw);

  const filtros = {
    campanha: String(campanhaRaw || "").trim() || null,
    status: String(statusRaw || "").trim() || null,
    apenasComRetorno,
  };

  // 1-3) Cliente + grant ML + base MELI: resolução única via contextoPrecificacaoService.
  // baseSlugRawStr ausente → resolve automaticamente a base MELI vinculada ao cliente.
  // baseSlugRawStr informado (compat) → valida se pertence ao cliente + MELI + ativa.
  const contexto = await exigirContextoPronto({
    clienteSlugRaw: clienteSlugRawStr,
    baseSlugRaw: baseSlugRawStr,
  });
  const cliente = contexto.cliente;
  const mlUserId = contexto.mlUserId;
  const base = contexto.base;

  // 4) Contexto financeiro (custos da base + último snapshot de relatorio_itens).
  // Extraído para carregarContextoFinanceiro para ser reutilizado pelo diagnóstico.
  const { matchBase, matchSnapshot } = await carregarContextoFinanceiro({
    clienteId: cliente.id,
    baseId: base.id,
  });

  // 5) Anúncios ativos do seller (paginado)
  const search = await mlFetch(
    cliente.id,
    `/users/${mlUserId}/items/search?status=active&offset=${offset}&limit=${limit}`
  );
  if (!search.ok) {
    throw criarErroHttp(search.status || 502, {
      ok: false,
      erro: search.data?.message || "Erro ao buscar itens no ML.",
      status: search.status,
    });
  }

  const totalItensMl = search.data?.paging?.total ?? 0;
  const ids = Array.isArray(search.data?.results) ? search.data.results : [];

  // 6) Detalhes dos itens em lote
  let details = [];
  if (ids.length > 0) {
    for (const lote of chunk(ids, 20)) {
      try {
        const batch = await mlFetch(cliente.id, `/items?ids=${lote.join(",")}`);
        if (batch.ok && Array.isArray(batch.data)) details.push(...batch.data);
      } catch (err) {
        console.warn(`[promocoes-retorno] falha ao buscar lote de detalhes: ${err.message}`);
      }
    }
  }

  // 7) Enriquecimento por item (concorrência limitada)
  const limitar = pLimit(PROMO_ENRICH_CONCURRENCY);
  const tarefas = details.map((entry) =>
    limitar(async () => {
      const body = entry?.body || null;
      if (!body?.id) return null;
      try {
        const sku = extrairSkuMl(body);
        const match = matchBase(body.id, sku);
        const snapMatch = matchSnapshot(body.id, sku);
        return await enriquecerItem({
          clienteId: cliente.id,
          body,
          baseRow: match.row,
          matchedBy: match.matchedBy,
          snapshot: snapMatch.snap,
          snapshotMatchedBy: snapMatch.by,
          skuExtraido: sku,
          margemAlvo,
          tolerancia,
          filtros,
        });
      } catch (err) {
        console.warn(`[promocoes-retorno] item ${body.id} falhou: ${err.message}`);
        return null;
      }
    })
  );

  const resultados = (await Promise.all(tarefas)).filter(Boolean);
  const linhas = resultados.map((r) => r.linha).filter(Boolean);

  // Contadores agregados de ofertas (independentes de qual virou linha).
  const ofertasEncontradasTotal = resultados.reduce(
    (acc, r) => acc + (Number.isFinite(r.ofertasTotalItem) ? r.ofertasTotalItem : 0),
    0
  );
  const ofertasComRetornoMl = resultados.reduce(
    (acc, r) => acc + (Number.isFinite(r.ofertasComRetornoItem) ? r.ofertasComRetornoItem : 0),
    0
  );

  // 8) Resumo agregado (sobre as ofertas da página atual)
  const resumo = {
    ofertasEncontradasTotal,
    ofertasComRetornoMl,
    filtroApenasComRetorno: apenasComRetorno,
    ofertasEncontradas: linhas.length,
    produtosComBase: linhas.filter((l) => l.temBase).length,
    entrarSeguro: linhas.filter((l) => l.decisao === "entrar_seguro").length,
    entrarComTolerancia: linhas.filter((l) => l.decisao === "entrar_com_tolerancia").length,
    baixoMesmoComRebate: linhas.filter((l) => l.decisao === "baixo_mesmo_com_rebate").length,
    naoEntrar: linhas.filter((l) => l.decisao === "nao_entrar").length,
    semRelatorio: linhas.filter((l) => l.decisao === "sem_relatorio").length,
    dadosIncompletos: linhas.filter((l) => l.decisao === "dados_incompletos").length,
    produtosComSnapshot: linhas.filter((l) => l.temSnapshot).length,
    retornoMlTotal: round2OrNull(
      linhas.reduce((acc, l) => acc + (Number.isFinite(l.retornoMl) ? l.retornoMl : 0), 0)
    ),
    lucroTotalEstimado: round2OrNull(
      linhas.reduce((acc, l) => acc + (Number.isFinite(l.lcComRetorno) ? l.lcComRetorno : 0), 0)
    ),
    mcMediaPromocao: (() => {
      const mcs = linhas
        .map((l) => l.mcComRetorno)
        .filter((n) => Number.isFinite(n));
      if (!mcs.length) return null;
      return round4OrNull(mcs.reduce((a, b) => a + b, 0) / mcs.length);
    })(),
  };

  return {
    ok: true,
    cliente: { id: cliente.id, slug: cliente.slug, nome: cliente.nome },
    base: { id: base.id, slug: base.slug, nome: base.nome },
    page,
    limit,
    totalItensMl,
    resumo,
    linhas,
  };
}

module.exports = {
  gerarPreviewPromocoesRetorno,
  // Reutilizados pelo diagnóstico/snapshot de promoções:
  carregarContextoFinanceiro,
  enriquecerItem,
  escolherPromocao,
  classificarOrigemPromocao,
  extrairSkuMl,
  toAliquota,
  normalizarSlug,
  criarErroHttp,
  pLimit,
  chunk,
  round2OrNull,
  round4OrNull,
};
