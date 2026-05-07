// server/utils/fechamento/meliConversaoService.js
// Processa a planilha de vendas do Mercado Livre ("Vendas BR")
// e retorna o mesmo shape de dados que buildResultadoFromBaseMetrics em process.js.

const XLSX = require("xlsx");

function toText(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function toNum(v) {
  if (v === null || v === undefined || v === "" || v === " " || v === "-") return 0;
  if (typeof v === "number") return v;
  const n = Number(String(v).replace(/[^\d.,-]/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function classifyCurve(current, previous) {
  if (current <= 80 || previous < 80) return "A";
  if (current <= 95 || previous < 95) return "B";
  return "C";
}

// Statuses de cancelamento/devolução a excluir
const EXCLUIR_REGEX = /cancelad|devolu|reembolso/i;

function getMeliBaseMetrics(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer)) {
    return { error: "Arquivo inválido." };
  }

  const wb = XLSX.read(buffer, { type: "buffer" });
  const ws = wb.Sheets["Vendas BR"];
  if (!ws) {
    return { error: 'Aba "Vendas BR" não encontrada. Envie a planilha de vendas do Mercado Livre.' };
  }

  // Header real está na linha 6 da planilha (índice 5, base 0)
  const rows = XLSX.utils.sheet_to_json(ws, { defval: "", range: 5 });

  if (!rows.length) {
    return { error: "A planilha está vazia ou com formato inesperado." };
  }

  // Filtra cancelamentos/devoluções
  const paid = rows.filter((r) => {
    const estado = toText(r["Estado"] || r["estado"] || "");
    return !EXCLUIR_REGEX.test(estado);
  });

  if (!paid.length) {
    return { error: "Nenhuma venda paga encontrada na planilha." };
  }

  // Agrega por # de anúncio (MLB...)
  const map = new Map();

  for (const r of paid) {
    const id = toText(r["# de anúncio"] || r["# de Anúncio"] || "");
    const nome = toText(r["Título do anúncio"] || r["Titulo do anuncio"] || r["Título"] || "");
    const sku = toText(r["SKU"] || "");
    const unid = toNum(r["Unidades"]);
    const fat = toNum(r["Receita por produtos (BRL)"]);
    const temAds = toText(r["Venda por publicidade"]).toLowerCase() === "sim";
    const tipoAnuncio = toText(r["Tipo de anúncio"] || r["Tipo de Anuncio"] || "");

    if (!id && !nome) continue;

    const key = id || nome;
    if (!map.has(key)) {
      map.set(key, {
        id,
        produto: nome,
        sku,
        faturamento: 0,
        unidades: 0,
        pedidos: 0,
        temAds: false,
        tipoAnuncio: "",
        // Meli não tem impressões/cliques/CTR/conversão na planilha de vendas
        impressoes: 0,
        cliques: 0,
        ctr: 0,
        conversao: 0,
      });
    }

    const acc = map.get(key);
    acc.faturamento += fat;
    acc.unidades += unid;
    acc.pedidos += 1;
    if (temAds) acc.temAds = true;
    if (tipoAnuncio && !acc.tipoAnuncio) acc.tipoAnuncio = tipoAnuncio;
    // Atualiza sku se ainda vazio
    if (!acc.sku && sku) acc.sku = sku;
  }

  const baseMetrics = Array.from(map.values()).filter((r) => r.faturamento > 0 || r.pedidos > 0);

  if (!baseMetrics.length) {
    return { error: "Não encontrei linhas com dados válidos." };
  }

  return { baseMetrics };
}

function buildMeliResultado(baseMetrics) {
  const faturamentoTotal = baseMetrics.reduce((s, r) => s + r.faturamento, 0);
  const unidadesTotais = baseMetrics.reduce((s, r) => s + r.unidades, 0);
  const pedidosTotais = baseMetrics.reduce((s, r) => s + r.pedidos, 0);

  // --- Curva ABC por faturamento ---
  const revSorted = [...baseMetrics].sort((a, b) => b.faturamento - a.faturamento || a.produto.localeCompare(b.produto, "pt-BR"));
  let runRev = 0, prevRev = 0;
  const revMap = new Map();
  for (const r of revSorted) {
    const pct = faturamentoTotal > 0 ? r.faturamento / faturamentoTotal : 0;
    runRev += pct;
    revMap.set(r.id || r.produto, { percentualFaturamento: pct, acumuladoFaturamento: runRev, curvaFat: classifyCurve(runRev * 100, prevRev * 100) });
    prevRev = runRev;
  }

  // --- Curva ABC por unidades ---
  const uniSorted = [...baseMetrics].sort((a, b) => b.unidades - a.unidades || a.produto.localeCompare(b.produto, "pt-BR"));
  let runUni = 0, prevUni = 0;
  const uniMap = new Map();
  for (const r of uniSorted) {
    const pct = unidadesTotais > 0 ? r.unidades / unidadesTotais : 0;
    runUni += pct;
    uniMap.set(r.id || r.produto, { percentualUnidades: pct, acumuladoUnidades: runUni, curvaUni: classifyCurve(runUni * 100, prevUni * 100) });
    prevUni = runUni;
  }

  const curvaAbcCompleta = baseMetrics
    .map((r) => {
      const key = r.id || r.produto;
      const rv = revMap.get(key) || {};
      const uv = uniMap.get(key) || {};
      return {
        id: r.id,
        produto: r.produto,
        faturamento: r.faturamento,
        unidades: r.unidades,
        percentualFaturamento: rv.percentualFaturamento ?? 0,
        acumuladoFaturamento: rv.acumuladoFaturamento ?? 0,
        percentualUnidades: uv.percentualUnidades ?? 0,
        acumuladoUnidades: uv.acumuladoUnidades ?? 0,
        curvaFat: rv.curvaFat ?? "C",
        curvaUni: uv.curvaUni ?? "C",
        curvaFinal: `${rv.curvaFat ?? "C"}${uv.curvaUni ?? "C"}`,
      };
    })
    .sort((a, b) => b.faturamento - a.faturamento);

  // --- Kits: unidades/pedidos > 1.2 ---
  const sugestaoKits = baseMetrics
    .map((r) => ({
      id: r.id,
      produto: r.produto,
      pedidosPagos: r.pedidos,
      unidadesPagas: r.unidades,
      unidadesPorPedido: r.pedidos > 0 ? r.unidades / r.pedidos : 0,
    }))
    .filter((r) => r.pedidosPagos > 0 && r.unidadesPorPedido > 1.2)
    .sort((a, b) => b.unidadesPorPedido - a.unidadesPorPedido)
    .slice(0, 50);

  // --- ADS baseado em curva + status de publicidade ---
  // adsObrigatorios: curva A sem ads ativos
  // adsPrioridade34: curva A com Clássico (sugerir upgrade para Premium)
  // adsPrioridade24: curva B sem ads ou com Clássico
  const adsObrigatorios = curvaAbcCompleta
    .filter((r) => {
      const m = baseMetrics.find((x) => (x.id || x.produto) === (r.id || r.produto));
      return r.curvaFat === "A" && m && !m.temAds;
    })
    .slice(0, 50)
    .map((r) => {
      const m = baseMetrics.find((x) => (x.id || x.produto) === (r.id || r.produto));
      return {
        id: r.id,
        produto: r.produto,
        cliques: 0,
        ctr: 0,
        conversao: 0,
        motivo: `Curva A sem ADS — faturamento ${r.faturamento.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}`,
      };
    });

  const adsPrioridade34 = curvaAbcCompleta
    .filter((r) => {
      const m = baseMetrics.find((x) => (x.id || x.produto) === (r.id || r.produto));
      return r.curvaFat === "A" && m && m.temAds && (m.tipoAnuncio || "").toLowerCase().includes("clássico");
    })
    .slice(0, 50)
    .map((r) => ({
      id: r.id,
      produto: r.produto,
      cliques: 0,
      ctr: 0,
      conversao: 0,
      motivo: "Curva A com Clássico — considerar upgrade para Premium",
    }));

  const adsPrioridade24 = curvaAbcCompleta
    .filter((r) => {
      const m = baseMetrics.find((x) => (x.id || x.produto) === (r.id || r.produto));
      return r.curvaFat === "B" && m && !m.temAds;
    })
    .slice(0, 50)
    .map((r) => ({
      id: r.id,
      produto: r.produto,
      cliques: 0,
      ctr: 0,
      conversao: 0,
      motivo: "Curva B sem ADS — candidato a teste de publicidade",
    }));

  return {
    resumo: { faturamentoTotal, unidadesTotais, pedidosTotais, produtosConsiderados: baseMetrics.length },
    curvaAbcCompleta,
    produtosMaisImpressoes: [], // não disponível na planilha Meli
    produtosMaisCliques: [], // não disponível
    produtosMaiorCtr: [], // não disponível
    produtosMaiorConversao: [], // não disponível
    sugestaoKits,
    adsObrigatorios,
    adsPrioridade34,
    adsPrioridade24,
  };
}

function processarFechamentoMeli(buffer) {
  try {
    const result = getMeliBaseMetrics(buffer);
    if (result.error) return result;
    return buildMeliResultado(result.baseMetrics);
  } catch (err) {
    console.error("ERRO meliConversaoService:", err);
    return { error: err instanceof Error ? err.message : "Erro ao processar planilha Meli." };
  }
}

function compilarFechamentosMeli(buffers) {
  if (!Array.isArray(buffers) || !buffers.length) {
    return { error: "Lista de arquivos inválida." };
  }

  const allMetrics = [];

  for (const buf of buffers) {
    const r = getMeliBaseMetrics(buf);
    if (r.error) continue;
    allMetrics.push(...r.baseMetrics);
  }

  if (!allMetrics.length) {
    return { error: "Nenhum arquivo Meli válido para compilar." };
  }

  // Mescla por id de anúncio
  const merged = new Map();
  for (const r of allMetrics) {
    const key = r.id || r.produto;
    if (!merged.has(key)) {
      merged.set(key, { ...r });
    } else {
      const acc = merged.get(key);
      acc.faturamento += r.faturamento;
      acc.unidades += r.unidades;
      acc.pedidos += r.pedidos;
      if (r.temAds) acc.temAds = true;
      if (r.tipoAnuncio && !acc.tipoAnuncio) acc.tipoAnuncio = r.tipoAnuncio;
    }
  }

  return buildMeliResultado(Array.from(merged.values()));
}

module.exports = { processarFechamentoMeli, compilarFechamentosMeli };

