// server/services/automacoes/diagnosticoService.js
// Service do diagnóstico completo da loja.
// Extraído de server/index.js sem alterar scroll, cálculos, SQL ou comportamento.

const pool = require("../../config/database");
const { mlFetch } = require("../../utils/mlClient");

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

  const vars = Array.isArray(body?.variations) ? body.variations : [];
  for (const v of vars) {
    const vDireto = [v?.seller_custom_field, v?.sku]
      .map((x) => String(x || "").trim())
      .find(Boolean);
    if (vDireto) return vDireto;

    const vAttrs = Array.isArray(v?.attributes) ? v.attributes : [];
    for (const a of vAttrs) {
      const id = String(a?.id || "");
      const name = String(a?.name || "");
      if (!nomeEhSku(id) && !nomeEhSku(name)) continue;
      const val = a?.value_name ?? a?.value_id ?? a?.value_struct?.number ?? a?.value_struct?.unit ?? null;
      const sku = String(val || "").trim();
      if (sku) return sku;
    }
  }

  return null;
}

const DIAG_SCROLL_LIMIT = 100;        // máximo aceito pelo ML por scroll
const DIAG_BATCH_DETAILS = 20;        // lote para GET /items?ids=
const DIAG_ENRICH_CONCURRENCY = 4;    // enriquecimentos paralelos

function diagChunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function diagPLimit(concorrencia) {
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

function diagClassificarItem({ temBase, lc, mc, frete, comissao, margemAlvo }) {
  if (!temBase) return "sem_base";
  if (frete === null || frete === undefined) return "sem_frete";
  if (comissao === null || comissao === undefined) return "sem_comissao";
  if (lc === null || lc === undefined || mc === null || mc === undefined) return "sem_dados";
  if (mc < 0) return "critico";
  const margem = Number(margemAlvo);
  if (Number.isFinite(margem) && mc < margem) return "atencao";
  return "saudavel";
}

function diagAcaoRecomendada({ diagnostico, precoEfetivo, precoAlvo }) {
  if (diagnostico === "sem_base") return "Cadastrar item na base de custos.";
  if (diagnostico === "sem_frete") return "Verificar configuração de frete grátis no anúncio.";
  if (diagnostico === "sem_comissao") return "Verificar listing_type e categoria do anúncio.";
  if (diagnostico === "sem_dados") return "Revisar dados de entrada (custo, imposto, taxa).";
  if (precoAlvo == null || precoEfetivo == null) return "Manter preço atual.";
  const delta = Number(precoAlvo) - Number(precoEfetivo);
  if (!Number.isFinite(delta)) return "Manter preço atual.";
  if (Math.abs(delta / precoEfetivo) < 0.005) return "Manter preço atual.";
  if (delta > 0) return `Subir preço para R$ ${precoAlvo.toFixed(2)}.`;
  return `Reduzir preço para R$ ${precoAlvo.toFixed(2)}.`;
}

// Replica EXATAMENTE o pipeline de enriquecimento da rota /automacoes/precificacao/preview-ml para 1 item.
async function diagEnriquecerItem({ clienteId, body, baseRow, margemAlvo }) {
  const itemId = String(body?.id || "").trim();
  const sku = extrairSkuMl(body);
  const listingTypeId = body?.listing_type_id || null;
  const categoryId = body?.category_id || null;
  const sellerId = body?.seller_id || null;
  const condition = body?.condition || "new";
  const logisticType = body?.shipping?.logistic_type || "xd_drop_off";
  const freeShipping = body?.shipping?.free_shipping ?? true;

  const precoOriginalNum = body?.price != null ? Number(body.price) : NaN;
  const precoOriginal =
    Number.isFinite(precoOriginalNum) && precoOriginalNum > 0 ? precoOriginalNum : null;

  let precoPromocional = null;
  try {
    if (itemId) {
      const r = await mlFetch(clienteId, `/items/${encodeURIComponent(itemId)}/prices`);
      const lista = Array.isArray(r?.data?.prices) ? r.data.prices : [];
      const valores = lista.map((p) => Number(p?.amount)).filter((n) => Number.isFinite(n) && n > 0);
      if (valores.length > 0) precoPromocional = Math.min(...valores);
    }
  } catch (_) { precoPromocional = null; }

  const precoEfetivo = precoPromocional ?? precoOriginal;

  const [listingPricesResp, shippingResp] = await Promise.all([
    (async () => {
      if (precoEfetivo === null || !listingTypeId || !categoryId) return null;
      try {
        return await mlFetch(
          clienteId,
          `/sites/MLB/listing_prices?price=${encodeURIComponent(precoEfetivo)}&listing_type_id=${encodeURIComponent(listingTypeId)}&category_id=${encodeURIComponent(categoryId)}`
        );
      } catch (_) { return null; }
    })(),
    (async () => {
      if (precoEfetivo === null || !sellerId || !listingTypeId || !itemId) return null;
      try {
        return await mlFetch(
          clienteId,
          `/users/${encodeURIComponent(sellerId)}/shipping_options/free?item_id=${encodeURIComponent(itemId)}&verbose=true&item_price=${encodeURIComponent(precoEfetivo)}&listing_type_id=${encodeURIComponent(listingTypeId)}&mode=me2&condition=${encodeURIComponent(condition)}&logistic_type=${encodeURIComponent(logisticType)}&free_shipping=${encodeURIComponent(freeShipping)}`
        );
      } catch (_) { return null; }
    })(),
  ]);

  const lpData = listingPricesResp && listingPricesResp.ok ? listingPricesResp.data : null;
  const lpRoot = Array.isArray(lpData)
    ? lpData[0]
    : Array.isArray(lpData?.results) ? lpData.results[0] : lpData;
  const comissao = lpRoot?.sale_fee_amount != null ? Number(lpRoot.sale_fee_amount) : null;
  const comissaoPercentual =
    lpRoot?.sale_fee_details?.percentage_fee != null
      ? Number(lpRoot.sale_fee_details.percentage_fee)
      : null;

  const frete =
    shippingResp && shippingResp.ok && shippingResp.data?.coverage?.all_country?.list_cost != null
      ? Number(shippingResp.data.coverage.all_country.list_cost)
      : null;

  const custoProduto = baseRow ? baseRow.custoProduto : null;
  const impostoPercentual = baseRow ? baseRow.impostoPercentual : null;
  const taxaFixa = baseRow ? baseRow.taxaFixa : null;

  const impostoNum = Number(impostoPercentual);
  const impostoAliquota =
    Number.isFinite(impostoNum) && impostoNum >= 0
      ? (impostoNum > 1 ? impostoNum / 100 : impostoNum)
      : null;

  const hasLcInputs =
    precoEfetivo !== null && custoProduto !== null && impostoAliquota !== null &&
    taxaFixa !== null && comissao !== null && frete !== null;

  const lc = hasLcInputs
    ? precoEfetivo - (precoEfetivo * impostoAliquota) - comissao - frete - taxaFixa - custoProduto
    : null;
  const mc = lc !== null && precoEfetivo ? lc / precoEfetivo : null;

  let precoAlvo = null;
  if (
    margemAlvo !== null && custoProduto !== null && frete !== null && taxaFixa !== null &&
    impostoAliquota !== null && comissaoPercentual !== null
  ) {
    const denom = 1 - impostoAliquota - (comissaoPercentual / 100) - margemAlvo;
    if (denom > 0) precoAlvo = (custoProduto + frete + taxaFixa) / denom;
  }

  const temBase = !!baseRow;
  const diagnostico = diagClassificarItem({
    temBase, lc, mc, frete, comissao, margemAlvo,
  });
  const acao = diagAcaoRecomendada({ diagnostico, precoEfetivo, precoAlvo });
  const diferencaPreco =
    precoAlvo !== null && precoEfetivo !== null ? precoAlvo - precoEfetivo : null;

  return {
    item_id: itemId,
    sku,
    titulo: body?.title || null,
    status_anuncio: body?.status || null,
    listing_type_id: listingTypeId,
    preco_original: precoOriginal,
    preco_promocional: precoPromocional,
    preco_efetivo: precoEfetivo,
    custo: custoProduto,
    imposto_percentual: impostoPercentual,
    taxa_fixa: taxaFixa,
    frete,
    comissao,
    comissao_percentual: comissaoPercentual,
    lc,
    mc,
    preco_alvo: precoAlvo,
    preco_sugerido: precoAlvo,
    diferenca_preco: diferencaPreco,
    acao_recomendada: acao,
    explicacao_calculo: null,
    diagnostico,
    tem_base: temBase,
  };
}

async function diagInserirItensLote(relatorioId, linhas) {
  if (!linhas.length) return;
  const cols = [
    "relatorio_id", "item_id", "sku", "titulo", "status_anuncio", "listing_type_id",
    "preco_original", "preco_promocional", "preco_efetivo",
    "custo", "imposto_percentual", "taxa_fixa",
    "frete", "comissao", "comissao_percentual",
    "lc", "mc", "preco_alvo", "preco_sugerido", "diferenca_preco",
    "acao_recomendada", "explicacao_calculo", "diagnostico", "tem_base",
  ];
  const placeholders = [];
  const valores = [];
  let p = 1;
  for (const l of linhas) {
    const slots = [];
    for (let i = 0; i < cols.length; i++) slots.push(`$${p++}`);
    placeholders.push(`(${slots.join(",")})`);
    valores.push(
      relatorioId, l.item_id, l.sku, l.titulo, l.status_anuncio, l.listing_type_id,
      l.preco_original, l.preco_promocional, l.preco_efetivo,
      l.custo, l.imposto_percentual, l.taxa_fixa,
      l.frete, l.comissao, l.comissao_percentual,
      l.lc, l.mc, l.preco_alvo, l.preco_sugerido, l.diferenca_preco,
      l.acao_recomendada, l.explicacao_calculo, l.diagnostico, !!l.tem_base
    );
  }
  await pool.query(
    `INSERT INTO relatorio_itens (${cols.join(",")}) VALUES ${placeholders.join(",")}`,
    valores
  );
}

async function diagAtualizarContadores(relatorioId, deltas) {
  await pool.query(
    `UPDATE relatorios SET
       total_itens     = total_itens     + $2,
       itens_com_base  = itens_com_base  + $3,
       itens_sem_base  = itens_sem_base  + $4,
       itens_criticos  = itens_criticos  + $5,
       itens_atencao   = itens_atencao   + $6,
       itens_saudaveis = itens_saudaveis + $7
     WHERE id = $1`,
    [
      relatorioId,
      deltas.total || 0, deltas.comBase || 0, deltas.semBase || 0,
      deltas.criticos || 0, deltas.atencao || 0, deltas.saudaveis || 0,
    ]
  );
}

async function diagFinalizar(relatorioId) {
  const r = await pool.query(
    `SELECT AVG(mc)::float AS media FROM relatorio_itens WHERE relatorio_id = $1 AND mc IS NOT NULL`,
    [relatorioId]
  );
  await pool.query(
    `UPDATE relatorios SET status = 'concluido', mc_media = $2 WHERE id = $1`,
    [relatorioId, r.rows[0]?.media ?? null]
  );
}

async function diagMarcarErro(relatorioId, mensagem) {
  await pool.query(
    `UPDATE relatorios SET status = 'erro', observacoes = COALESCE(observacoes, '') || $2 WHERE id = $1`,
    [relatorioId, `\n[erro] ${String(mensagem || "desconhecido").slice(0, 800)}`]
  );
}

// Worker em background — roda dentro do mesmo processo via setImmediate.
async function executarDiagnosticoCompleto(relatorioId) {
  let cliente, base, mlUserId, margemAlvo;
  try {
    const r = await pool.query(
      `SELECT r.cliente_id, r.base_id, r.margem_alvo, r.cliente_slug, r.base_slug,
              t.ml_user_id
         FROM relatorios r
         LEFT JOIN ml_tokens t ON t.cliente_id = r.cliente_id
        WHERE r.id = $1`,
      [relatorioId]
    );
    if (!r.rows.length) throw new Error("Relatório não encontrado.");
    const row = r.rows[0];
    cliente = { id: row.cliente_id, slug: row.cliente_slug };
    base = { id: row.base_id, slug: row.base_slug };
    mlUserId = row.ml_user_id;
    margemAlvo = row.margem_alvo != null ? Number(row.margem_alvo) : null;
    if (!mlUserId) throw new Error("Cliente sem conta ML vinculada.");
    if (!base.id) throw new Error("Base não encontrada.");
  } catch (err) {
    await diagMarcarErro(relatorioId, err.message);
    return;
  }

  const custosMapExact = new Map();
  const custosMapNorm = new Map();
  const custosMapNumeric = new Map();
  try {
    const custos = await pool.query(
      "SELECT produto_id, custo_produto, imposto_percentual, taxa_fixa FROM custos WHERE base_id = $1",
      [base.id]
    );
    custos.rows.forEach((row) => {
      const key = String(row.produto_id || "").trim();
      if (!key) return;
      const payload = {
        custoProduto: Number(row.custo_produto),
        impostoPercentual: Number(row.imposto_percentual),
        taxaFixa: Number(row.taxa_fixa),
      };
      custosMapExact.set(key, payload);
      custosMapNorm.set(key.toUpperCase(), payload);
      if (/^\d+$/.test(key)) custosMapNumeric.set(key, payload);
    });
  } catch (err) {
    await diagMarcarErro(relatorioId, `Falha ao carregar base: ${err.message}`);
    return;
  }

  function matchBase(itemId) {
    const id = String(itemId || "").trim();
    const upper = id.toUpperCase();
    let baseRow = custosMapExact.get(id) || custosMapNorm.get(upper) || null;
    if (!baseRow && upper.startsWith("MLB") && !upper.startsWith("MLBU")) {
      const num = upper.slice(3).match(/^\d+/)?.[0] || "";
      if (num && custosMapNumeric.has(num)) baseRow = custosMapNumeric.get(num);
    }
    return baseRow;
  }

  const limitar = diagPLimit(DIAG_ENRICH_CONCURRENCY);
  let scrollId = null;

  try {
    while (true) {
      const params = new URLSearchParams({
        search_type: "scan",
        limit: String(DIAG_SCROLL_LIMIT),
        status: "active",
      });
      if (scrollId) params.set("scroll_id", scrollId);

      const scan = await mlFetch(
        cliente.id,
        `/users/${mlUserId}/items/search?${params.toString()}`
      );
      if (!scan.ok) {
        throw new Error(`Falha no scroll do ML (HTTP ${scan.status}): ${scan.data?.message || "erro"}`);
      }

      const ids = Array.isArray(scan.data?.results) ? scan.data.results : [];
      if (!ids.length) break;

      for (const lote of diagChunk(ids, DIAG_BATCH_DETAILS)) {
        let detalhes = [];
        try {
          const batch = await mlFetch(cliente.id, `/items?ids=${lote.join(",")}`);
          if (batch.ok && Array.isArray(batch.data)) detalhes = batch.data;
        } catch (_) { detalhes = []; }

        const tarefas = detalhes.map((entry) =>
          limitar(async () => {
            const body = entry?.body || null;
            if (!body?.id) return null;
            try {
              const baseRow = matchBase(body.id);
              return await diagEnriquecerItem({
                clienteId: cliente.id, body, baseRow, margemAlvo,
              });
            } catch (err) {
              console.warn(`[diag ${relatorioId}] item ${body.id} falhou:`, err.message);
              return null;
            }
          })
        );

        const linhas = (await Promise.all(tarefas)).filter(Boolean);
        if (!linhas.length) continue;

        await diagInserirItensLote(relatorioId, linhas);
        await diagAtualizarContadores(relatorioId, {
          total: linhas.length,
          comBase: linhas.filter((l) => l.tem_base).length,
          semBase: linhas.filter((l) => !l.tem_base).length,
          criticos: linhas.filter((l) => l.diagnostico === "critico").length,
          atencao: linhas.filter((l) => l.diagnostico === "atencao").length,
          saudaveis: linhas.filter((l) => l.diagnostico === "saudavel").length,
        });
      }

      if (!scan.data?.scroll_id) break;
      scrollId = scan.data.scroll_id;
    }

    await diagFinalizar(relatorioId);
  } catch (err) {
    console.error(`[diag ${relatorioId}] erro fatal:`, err);
    await diagMarcarErro(relatorioId, err.message);
  }
}

module.exports = {
  executarDiagnosticoCompleto,
};

