// Backend falso para o vídeo: dados de demonstração no formato dos contratos
// usados pelos testes de UI do Portal (anuncios-meli-*.test.js).
"use strict";
const fs = require("fs");
const path = require("path");

const PROD_HOST = "venforce-server.onrender.com";
const IMG = (n) => "https://http2.mlstatic.com/demo/" + n + ".svg";

const CLIENTE = { id: 87, nome: "Casa Bella Utilidades", slug: "casabella", ativo: true, temGrant: true, grantStatus: "conectado", temBase: true, setupScore: 100, statusOperacional: "pronto", ultimaSincronizacao: null, pendencias: [] };
const CONTAS = [
  { id: 42, cliente_id: 87, marketplace: "meli", nome: "Mercado Livre", externalAccountLabel: "casabella_oficial", ativo: true, is_primary: true, grant: { token_status: "valid" }, base: { base_id: 9, nome: "Custos 2026" } },
];
const ME_CONTEXT = {
  ok: true,
  user: { id: 12, nome: "Ana Souza", email: null, role: "user" },
  squads: [], squadPrincipalId: null,
  clientes: [{ id: 87, slug: "casabella", nome: CLIENTE.nome, squadId: null, responsavelDireto: true, contasAtivas: 1 }],
  portfolio: { totalClientes: 1 },
  permissoes: { podeAdministrar: false },
};

function linha(id, titulo, img, o) {
  return Object.assign({
    tipo: "item", key: "item:" + id, item_id: id, family_id: null,
    titulo, sku: "CB-" + id.slice(-4), preco: 99.9, preco_original: null, moeda: "BRL",
    estoque: 40, vendidos: 120, status: "active",
    permalink: "https://produto.mercadolivre.com.br/" + id, thumbnail: IMG(img), pictures_count: 6,
    is_full: false, catalog_listing: false, family_name: null, variations_count: 0,
    listing_type_id: "gold_special", score_venforce: 82, revisado: false,
    total_itens: 1, total_user_products: 0,
    cover: { thumbnail: IMG(img), user_product_id: null },
  }, o || {}, { estoque_total: (o && o.estoque) || 40, vendidos_total: (o && o.vendidos) || 120 });
}

const FAM_ID = "FAM-PANELAS";
const LINHAS = [
  {
    tipo: "familia", key: "fam:" + FAM_ID, family_id: FAM_ID,
    family_name: "Jogo de Panelas Antiaderente Cerâmica", titulo: "Jogo de Panelas Antiaderente Cerâmica",
    total_user_products: 3, total_itens: 3, estoque_total: 186, vendidos_total: 742,
    preco_min: 289.9, preco_max: 349.9, moeda: "BRL", score_min: 74,
    status_contagem: { ativos: 3, pausados: 0, encerrados: 0 },
    cover: { thumbnail: IMG("panelas"), user_product_id: "MLBU-201" },
  },
  linha("MLB3456789012", "Garrafa Térmica Inox 1 Litro Café Chá Parede Dupla", "garrafa", { sku: "CB-GT1000", preco: 89.9, preco_original: 119.9, estoque: 230, vendidos: 1580, is_full: true, logistic_type: "fulfillment", score_venforce: 91 }),
  linha("MLB3456789013", "Kit 6 Potes Herméticos Vidro Tampa Bambu", "potes", { sku: "CB-PH06", preco: 129.9, estoque: 64, vendidos: 410, score_venforce: 68 }),
  linha("MLB3456789014", "Faqueiro Inox 24 Peças Cabo Madeira", "faqueiro", { sku: null, preco: 149.9, estoque: 18, vendidos: 95, score_venforce: 44, pictures_count: 2 }),
  linha("MLB3456789015", "Tábua de Corte Bambu Grande com Canaleta", "tabua", { sku: "CB-TB45", preco: 59.9, estoque: 0, vendidos: 302, status: "paused", score_venforce: 77 }),
  linha("MLB3456789016", "Escorredor de Louça Inox 2 Andares", "escorredor", { sku: "CB-ESC2", preco: 179.9, preco_original: 199.9, estoque: 41, vendidos: 220, is_full: true, logistic_type: "fulfillment", score_venforce: 86 }),
  linha("MLB3456789017", "Copo Térmico 500ml com Tampa e Canudo", "copo", { sku: "CB-CT500", preco: 69.9, estoque: 310, vendidos: 2104, score_venforce: 88, variations_count: 6 }),
  linha("MLB3456789018", "Organizador de Gaveta Talheres Ajustável", "organizador", { sku: "CB-ORG1", preco: 49.9, estoque: 12, vendidos: 58, score_venforce: 52 }),
];

function filho(id, titulo, up, o) {
  return Object.assign({
    item_id: id, user_product_id: up, family_id: FAM_ID, titulo,
    status: "active", preco: 289.9, moeda: "BRL", estoque: 60, vendidos: 240, score_venforce: 80, sku: "CB-PAN-" + id.slice(-2),
    thumbnail: IMG("panelas"), permalink: "https://produto.mercadolivre.com.br/" + id,
    listing_type_id: "gold_special", pictures_count: 7, is_full: false, revisado: false, catalog_listing: false,
  }, o || {});
}
const FAMILIA = {
  family_id: FAM_ID, family_name: "Jogo de Panelas Antiaderente Cerâmica",
  user_products: [
    { user_product_id: "MLBU-201", site_id: "MLB", domain_id: "MLB-COOKWARE_SETS", total_itens: 1,
      itens: [filho("MLB4100000001", "Jogo de Panelas Antiaderente Cerâmica 5 Peças Creme", "MLBU-201", { preco: 289.9, vendidos: 402, estoque: 88, is_full: true })] },
    { user_product_id: "MLBU-202", site_id: "MLB", domain_id: "MLB-COOKWARE_SETS", total_itens: 1,
      itens: [filho("MLB4100000002", "Jogo de Panelas Antiaderente Cerâmica 5 Peças Verde", "MLBU-202", { preco: 299.9, vendidos: 251, estoque: 64, listing_type_id: "gold_pro" })] },
    { user_product_id: "MLBU-203", site_id: "MLB", domain_id: "MLB-COOKWARE_SETS", total_itens: 1,
      itens: [filho("MLB4100000003", "Jogo de Panelas Antiaderente Cerâmica 7 Peças Grafite", "MLBU-203", { preco: 349.9, vendidos: 89, estoque: 34, score_venforce: 74 })] },
  ],
};

const TODOS = {};
LINHAS.filter((l) => l.tipo === "item").forEach((l) => { TODOS[l.item_id] = l; });
FAMILIA.user_products.forEach((u) => u.itens.forEach((i) => { TODOS[i.item_id] = i; }));

const MARGENS = {
  MLB3456789012: 27.4, MLB3456789013: 18.2, MLB3456789014: -3.1, MLB3456789015: 22.5,
  MLB3456789016: 15.8, MLB3456789017: 31.2, MLB3456789018: 9.4,
  MLB4100000001: 21.3, MLB4100000002: 19.6, MLB4100000003: 12.1,
};
const CUSTOS = {
  MLB3456789012: 32.5, MLB3456789013: 54, MLB3456789014: null, MLB3456789015: 18.9,
  MLB3456789016: 88, MLB3456789017: 21, MLB3456789018: null,
  MLB4100000001: 112, MLB4100000002: 118, MLB4100000003: 165,
};
const FAT = { MLB3456789017: [0.241, "A", 14707], MLB3456789012: [0.198, "A", 14204], MLB3456789016: [0.054, "B", 3957], MLB3456789013: [0.061, "B", 5326], MLB3456789015: [0.026, "C", 1810], MLB3456789014: [0.019, "C", 1424], MLB3456789018: [0.004, "C", 290] };

function margemDe(id) {
  const p = MARGENS[id];
  if (p == null) return { origem: "projected", margin: null, marginPercent: null, status: "UNVALIDATED", statusLabel: "Não validado", statusReasons: ["Variáveis obrigatórias ausentes: custo."] };
  const st = p < 0 ? ["LOSS", "Prejuízo"] : p < 10 ? ["LOW", "Margem baixa"] : ["HEALTHY", "Saudável"];
  const preco = (TODOS[id] && TODOS[id].preco) || 100;
  return { origem: "projected", margin: p / 100, marginPercent: p, profit: +(preco * p / 100).toFixed(2), status: st[0], statusLabel: st[1], statusReasons: p < 0 ? ["Margem negativa (" + p.toFixed(2) + "%)."] : [] };
}

function detalhe(id) {
  const l = TODOS[id] || LINHAS[1];
  return Object.assign({
    id: 1, cliente_id: 87, cliente_slug: "casabella", sub_status: null,
    marca: "Casa Bella", modelo: "Premium", category_id: "MLB1574",
    pictures_json: [l.thumbnail, IMG("garrafa2"), IMG("garrafa3"), IMG("garrafa4")],
    attributes_json: [
      { id: "BRAND", name: "Marca", value: "Casa Bella" },
      { id: "MODEL", name: "Modelo", value: "Premium" },
      { id: "COLOR", name: "Cor", value: "Preto fosco" },
      { id: "CAPACITY", name: "Capacidade", value: "1 L" },
      { id: "MATERIAL", name: "Material", value: "Aço inoxidável" },
      { id: "WEIGHT", name: "Peso", value: null },
    ],
    health: 0.88, score_motivo: "Ficha técnica incompleta",
    cliente_conta_id: 42, ml_user_id: "9001",
    last_synced_at: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
  }, l);
}

const PROMOS = [
  { id: "P-1", tipo: "DEAL", modoEscrita: "PRECO", refId: null, tipoLabel: "Campanha tradicional", nome: "Semana do Consumidor",
    status: "started", statusLabel: "ATIVA", statusExibicao: "ATIVA", inicio: "2026-10-20T12:00:00Z", fim: "2026-11-05T12:00:00Z",
    precoOriginal: 119.9, precoFinal: 89.9, descontoReais: 30, descontoPercentual: 25, meliPercentage: null, sellerPercentage: null, subsidioMl: null, editavelPrecoFinal: true },
  { id: "P-2", tipo: "DEAL", modoEscrita: "PRECO", refId: null, tipoLabel: "Campanha tradicional", nome: "Black Friday 2026",
    status: "candidate", statusLabel: "ELEGÍVEL", statusExibicao: "ELEGÍVEL", inicio: "2026-11-20T03:00:00Z", fim: "2026-11-30T02:59:00Z",
    precoOriginal: 119.9, precoFinal: 84.9, descontoReais: 35, descontoPercentual: 29, meliPercentage: null, sellerPercentage: null, subsidioMl: null, editavelPrecoFinal: true },
  { id: "PD-1", tipo: "PRICE_DISCOUNT", modoEscrita: null, refId: null, tipoLabel: "Desconto individual", nome: null,
    status: "candidate", statusLabel: "ELEGÍVEL", statusExibicao: "ELEGÍVEL", inicio: null, fim: null,
    precoOriginal: 119.9, precoFinal: 107.9, descontoReais: 12, descontoPercentual: 10, meliPercentage: null, sellerPercentage: null, subsidioMl: null, editavelPrecoFinal: true },
];

// --- Radar de subsídios -------------------------------------------------------
const REFERENCIAS = [
  { id: "C-OUT", tipo: "SELLER_CAMPAIGN", tipoLabel: "Campanha própria", nome: "Casa Bella - Outubro", status: "started", inicio: "2026-10-01T03:00:00Z", fim: "2026-11-01T02:59:00Z", padrao: true },
  { id: "C-SET", tipo: "SELLER_CAMPAIGN", tipoLabel: "Campanha própria", nome: "Casa Bella - Setembro", status: "started", inicio: "2026-09-01T03:00:00Z", fim: "2026-10-31T02:59:00Z", padrao: false },
];
function cand(pid, tipo, nome, preco, margem, lucro, gm, gl, extra) {
  return Object.assign({ promotionId: pid, tipo, tipoLabel: tipo === "SMART" ? "Campanha co-participada" : "Campanha do ML", nome,
    preco, subsidioMl: 4.99, meliPercentage: 5, margemPercent: margem, lucro, ganhoMargemPp: gm, ganhoLucro: gl, fim: "2026-10-31T02:59:00Z",
    melhorMargem: false, melhorLucro: false }, extra || {});
}
const REF = { preco: 89.9, subsidioMl: 0, margemPercent: 12.3, lucro: 11.06 };
const RESULTADO = {
  resumo: { recomendado: 2, escolha: 1, sem_ganho: 1, descartado: 1 },
  itens: [
    { itemId: "MLB3456789012", titulo: "Garrafa Térmica Inox 1 Litro Café Chá Parede Dupla", thumbnail: IMG("garrafa"), status: "recomendado", motivo: null, motivoTexto: null,
      referencia: REF, candidatas: [cand("P-S1", "SMART", "Smart Outubro", 86.9, 15.4, 13.38, 3.1, 2.32, { melhorMargem: true, melhorLucro: true })], sugestao: { porMargem: "P-S1", porLucro: "P-S1" } },
    { itemId: "MLB3456789017", titulo: "Copo Térmico 500ml com Tampa e Canudo", thumbnail: IMG("copo"), status: "recomendado", motivo: null, motivoTexto: null,
      referencia: { preco: 69.9, subsidioMl: 0, margemPercent: 31.2, lucro: 21.8 }, candidatas: [cand("P-S2", "MARKETPLACE_CAMPAIGN", "Ofertas Relâmpago", 66.9, 33.0, 22.1, 1.8, 0.3, { melhorMargem: true, melhorLucro: true })], sugestao: { porMargem: "P-S2", porLucro: "P-S2" } },
    { itemId: "MLB3456789013", titulo: "Kit 6 Potes Herméticos Vidro Tampa Bambu", thumbnail: IMG("potes"), status: "escolha", motivo: null, motivoTexto: null,
      referencia: { preco: 129.9, subsidioMl: 0, margemPercent: 18.2, lucro: 23.6 }, candidatas: [
        cand("P-3M", "SMART", "Smart margem", 124.9, 20.1, 25.1, 1.9, 1.5, { melhorMargem: true }),
        cand("P-3L", "PRICE_MATCHING", "Preço competitivo", 119.9, 18.0, 26.4, -0.2, 2.8, { melhorLucro: true }),
      ], sugestao: { porMargem: "P-3M", porLucro: "P-3L" } },
    { itemId: "MLB3456789016", titulo: "Escorredor de Louça Inox 2 Andares", thumbnail: IMG("escorredor"), status: "sem_ganho", motivo: "JA_EM_REBATE_MELHOR", motivoTexto: null,
      referencia: REF, candidatas: [], sugestao: { porMargem: null, porLucro: null } },
    { itemId: "MLB3456789014", titulo: "Faqueiro Inox 24 Peças Cabo Madeira", thumbnail: IMG("faqueiro"), status: "descartado", motivo: "SEM_CUSTO", motivoTexto: null,
      referencia: null, candidatas: [], sugestao: { porMargem: null, porLucro: null } },
  ],
};
const JOBS = {};
let proximoJob = 70;
function jobJson(job) {
  const base0 = { id: job.id, erro: null, referencia: { id: "C-OUT", tipo: "SELLER_CAMPAIGN", nome: "Casa Bella - Outubro" } };
  if (job.exec) {
    job.exec.polls += 1; const fim = job.exec.polls > 2;
    const itens = job.exec.escolhas.map((e, i) => (!fim && i > 0) ? { itemId: e.itemId, promotionId: e.promotionId, tipo: e.tipo, status: "pendente", codigo: null, motivo: null, precoConfirmado: null }
      : { itemId: e.itemId, promotionId: e.promotionId, tipo: e.tipo, status: "ok", codigo: null, motivo: null, precoConfirmado: 86.9 });
    return Object.assign(base0, { fase: "execucao", status: fim ? "concluido" : "processando", progresso: { total: 8, processados: 8 }, resultado: RESULTADO,
      execucao: { total: itens.length, processados: itens.filter((x) => x.status !== "pendente").length, itens } });
  }
  job.polls += 1;
  const base = { id: job.id, erro: null, referencia: { id: "C-OUT", tipo: "SELLER_CAMPAIGN", nome: "Casa Bella - Outubro" }, execucao: null };
  if (job.polls <= 2) return Object.assign(base, { fase: "analise", status: "processando", progresso: { total: 8, processados: job.polls * 3, resumo: { recomendado: 1, escolha: 0, sem_ganho: 0, descartado: 1 } }, resultado: null });
  return Object.assign(base, { fase: "analise", status: "concluido", progresso: { total: 8, processados: 8 }, resultado: RESULTADO });
}

// --- imagens dos produtos (SVG desenhado aqui, servido no lugar do mlstatic) ----
const CORES = {
  panelas: ["#F4E3C9", "#C9733B", "🍲"], garrafa: ["#E3ECF5", "#2F4A66", "🧉"], garrafa2: ["#E3ECF5", "#3D5A80", "☕"],
  garrafa3: ["#EDE7F6", "#5E4B8B", "🫖"], garrafa4: ["#E8F5E9", "#2E7D32", "🌿"], potes: ["#F1F8E9", "#7A8F3A", "🫙"],
  faqueiro: ["#ECEFF1", "#546E7A", "🍴"], tabua: ["#FFF3E0", "#A1662F", "🪵"], escorredor: ["#E0F7FA", "#00838F", "🍽️"],
  copo: ["#FCE4EC", "#AD1457", "🥤"], organizador: ["#F3E5F5", "#6A1B9A", "🗂️"],
};
function svg(nome) {
  const c = CORES[nome] || ["#EEE", "#888", "📦"];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">
<defs><radialGradient id="g" cx="50%" cy="40%" r="70%"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="${c[0]}"/></radialGradient></defs>
<rect width="400" height="400" fill="url(#g)"/><ellipse cx="200" cy="330" rx="120" ry="18" fill="${c[1]}" opacity=".15"/>
<text x="200" y="250" font-size="190" text-anchor="middle">${c[2]}</text></svg>`;
}

function rotear(page) {
  return page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.hostname === "http2.mlstatic.com") {
      const nome = path.basename(url.pathname, ".svg");
      return route.fulfill({ status: 200, contentType: "image/svg+xml", body: svg(nome) });
    }
    if (url.hostname !== PROD_HOST) return route.continue();
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization,content-type", "access-control-allow-methods": "GET,POST,PATCH,PUT,OPTIONS" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const json = (obj, status) => route.fulfill({ status: status || 200, headers: cors, contentType: "application/json", body: JSON.stringify(obj) });
    const p = url.pathname;
    const qs = url.searchParams;
    let body = null;
    try { body = req.postDataJSON(); } catch (_) { body = null; }

    if (p.includes("/me/context")) return json(ME_CONTEXT);
    if (p.includes("/operacao/cliente-360/clientes")) return json({ ok: true, clientes: [CLIENTE] });
    if (/\/clientes\/[^/?]+\/contas/.test(p)) return json({ ok: true, cliente: CLIENTE, contas: CONTAS });
    if (p === "/anuncios-meli/clientes") return json({ ok: true, clientes: [{ id: 87, nome: CLIENTE.nome, slug: "casabella", mlConectado: true, totalAnuncios: 10 }] });
    if (p === "/anuncios-meli/resumo") return json({ ok: true, resumo: { total: 10, ativos: 9, pausados: 1, scoreMuitoBom: 5, scoreFaixaMedia: 3, scoreBaixo: 2, semSku: 1, semCusto: 2, full: 3, ultimaSync: new Date(Date.now() - 40 * 60 * 1000).toISOString() } });
    if (p === "/anuncios-meli/sync") { await new Promise((r) => setTimeout(r, 1800)); return json({ ok: true, total: 10, novos: 0, atualizados: 10, sincronizados: 10 }); }
    const fam = p.match(/^\/anuncios-meli\/familias\/([^/]+)/);
    if (fam) return json({ ok: true, cliente: CLIENTE, familia: FAMILIA });
    if (p === "/anuncios-meli/familias") {
      const q = (qs.get("q") || "").toLowerCase();
      const status = qs.get("status") || "";
      const filtro = qs.get("filtro") || "";
      let linhas = LINHAS.filter((l) => !q || (l.titulo + " " + (l.item_id || "") + " " + (l.sku || "")).toLowerCase().includes(q));
      if (status.includes("paused")) linhas = linhas.filter((l) => l.status === "paused");
      else if (status.includes("active")) linhas = linhas.filter((l) => l.tipo === "familia" || l.status === "active");
      if (filtro.includes("full")) linhas = linhas.filter((l) => l.is_full);
      if (filtro.includes("sem_custo")) linhas = linhas.filter((l) => l.item_id && CUSTOS[l.item_id] == null);
      if (filtro.includes("sem_sku")) linhas = linhas.filter((l) => l.tipo === "item" && !l.sku);
      if (filtro.includes("score")) linhas = linhas.filter((l) => (l.score_venforce || l.score_min) < 60);
      return json({ ok: true, cliente: CLIENTE, anuncios: linhas, paginacao: { page: 1, limit: 24, total: linhas.length, totalPaginas: 1 } });
    }
    if (p === "/anuncios-meli/performance") {
      const ids = (qs.get("itemIds") || "").split(",").filter(Boolean);
      const metricas7d = {}, margem = {}, composicao = {};
      const fat = { periodoDias: 30, porItem: {}, porItemValor: {}, porItemUnidades: {}, porItemPrecoMedio: {}, porFamilia: {}, porFamiliaValor: {}, porFamiliaUnidades: {}, porFamiliaPrecoMedio: {} };
      const abc = { porItem: {}, porFamilia: {} };
      ids.forEach((id, i) => {
        if (qs.get("incluirMetricas") !== "0") metricas7d[id] = { views: 800 + i * 137, vendas: 12 + i * 3, conversao: 1.5 + (i % 4) * 0.4, anterior: { views: 760 + i * 120, vendas: 10 + i * 3, conversao: 1.4 + (i % 3) * 0.3 } };
        if (qs.get("incluirMargem") !== "0") margem[id] = margemDe(id);
        if (qs.get("incluirComposicao") === "1") { const pr = (TODOS[id] && TODOS[id].preco) || 89.9; composicao[id] = { venda: pr, custoProduto: CUSTOS[id] || 32.5, comissaoMl: +(pr * 0.14).toFixed(2), frete: 18.9, taxaFixa: null, impostoPercentual: 0.06, impostoValor: +(pr * 0.06).toFixed(2) }; }
        const f = FAT[id] || (TODOS[id] && TODOS[id].family_id ? [0.132, "A", 9490] : null);
        if (f) { const pr = (TODOS[id] && TODOS[id].preco) || 90; fat.porItem[id] = f[0]; abc.porItem[id] = f[1]; fat.porItemValor[id] = f[2]; fat.porItemUnidades[id] = Math.round(f[2] / pr); fat.porItemPrecoMedio[id] = pr; }
      });
      (qs.get("familias") || "").split(",").filter(Boolean).forEach((f) => { fat.porFamilia[f] = 0.397; abc.porFamilia[f] = "A"; fat.porFamiliaValor[f] = 28470; fat.porFamiliaUnidades[f] = 96; fat.porFamiliaPrecoMedio[f] = 296.5; });
      return json({ ok: true, metricas7d, margem, composicao, margemIndisponivel: null, faturamento: fat, curvaAbc: abc, margemPorFamilia: null });
    }
    if (p === "/anuncios-meli/precos-ao-vivo") {
      const precos = {};
      (qs.get("itemIds") || "").split(",").filter(Boolean).forEach((id) => { const t = TODOS[id]; if (t) precos[id] = { preco: t.preco, precoOriginal: id === "MLB4100000001" ? 339.9 : null }; });
      return json({ ok: true, precos });
    }
    if (p === "/anuncios-meli/custos") {
      const custos = {};
      (qs.get("itemIds") || "").split(",").filter(Boolean).forEach((id) => { custos[id] = CUSTOS[id] === undefined ? null : CUSTOS[id]; });
      return json({ ok: true, base: { slug: "custos-2026", nome: "Custos 2026" }, motivo: "OK", mensagem: null, custos });
    }
    if (p === "/anuncios-meli/custos/lote") {
      (body && (body.itens || body.custos) || []).forEach((it) => { if (it.itemId) CUSTOS[it.itemId] = it.custo; });
      return json({ ok: true, resultados: (body && (body.itens || body.custos) || []).map((it) => ({ itemId: it.itemId, ok: true })) });
    }
    if (p === "/anuncios-meli/promocoes-rebate/referencias") return json({ ok: true, referencias: REFERENCIAS, padraoId: "C-OUT" });
    if (p === "/anuncios-meli/promocoes-rebate/analises" && req.method() === "POST") {
      const id = proximoJob++; JOBS[id] = { id, polls: 0 };
      return json({ ok: true, jobId: id });
    }
    const job = p.match(/^\/anuncios-meli\/promocoes-rebate\/analises\/([^/]+)$/);
    const ex = p.match(/^\/anuncios-meli\/promocoes-rebate\/analises\/([^/]+)\/executar$/);
    if (ex) { JOBS[ex[1]].exec = { escolhas: (body && body.escolhas) || [], polls: 0 }; return json({ ok: true }); }
    if (job) { const j = JOBS[job[1]] || (JOBS[job[1]] = { id: job[1], polls: 5 }); return json({ ok: true, job: jobJson(j) }); }
    if (/^\/anuncios-meli\/[^/?]+\/promocoes/.test(p)) return json({ ok: true, promocoes: PROMOS });
    if (/^\/anuncios-meli\/[^/?]+\/variacoes-legado/.test(p)) {
      const cores = ["Preto", "Branco", "Rosa", "Azul", "Verde", "Lilás"];
      return json({ ok: true, variacoes: cores.map((c, i) => ({ id: 1000 + i, atributos: [{ id: "COLOR", nome: "Cor", valor: c }], preco: 69.9, estoque: 50 + i * 4, vendidos: 300 + i * 20, sku: "CB-CT500-" + c.slice(0, 3).toUpperCase(), thumbnail: IMG("copo") })) });
    }
    if (/^\/anuncios-meli\/[^/?]+\/fotos\/variacoes/.test(p)) {
      const fotos = ["garrafa", "garrafa2", "garrafa3", "garrafa4"].map((n, i) => ({ id: "F" + i, url: IMG(n) }));
      return json({ ok: true, modo: "simples", atributo: null, limite: { porGrupo: 12, origem: "categoria" }, grupos: [{ grupoVariacao: null, rotulo: "", combinacoes: [], quantidade: 4, principal: fotos[0], fotos }] });
    }
    if (/^\/anuncios-meli\/[^/?]+\/otimizacoes/.test(p)) return json({ ok: true, otimizacoes: [] });
    if (/^\/anuncios-meli\/[^/?]+\/simular-margem/.test(p)) {
      const pr = (body && body.preco) || 89.9; const c = (body && body.custoProduto) || 32.5;
      const lucro = pr - c - pr * 0.14 - 18.9 - pr * 0.06;
      return json({ ok: true, simulado: true, origem: "projected", entradas: { price: pr, cost: c, taxRate: 0.06, commission: +(pr * 0.14).toFixed(2), freight: 18.9, fixedFee: null, rebate: 0 },
        resultado: { computable: true, profit: +lucro.toFixed(2), margin: lucro / pr, marginPercent: +(lucro / pr * 100).toFixed(1), missing: [], assumed: [] } });
    }
    if (/^\/anuncios-meli\/[^/?]+\/seo\/titulos/.test(p)) {
      await new Promise((r) => setTimeout(r, 1500));
      const s = ["Garrafa Térmica Inox 1L Parede Dupla Café Chá Quente Frio", "Garrafa Térmica 1 Litro Aço Inox Café Chá 24h Quente", "Garrafa Térmica Inox 1L Casa Bella Café Chá Parede Dupla"];
      return json({ ok: true, limite: 60, sugestoes: s.map((t, i) => ({ titulo: t, chars: t.length, score: 93 - i * 6, breakdown: { cobertura: 32 - i * 2, relevancia: 24, eficiencia: 15 - i, especificidade: 10, clareza: 10, redundancia: 2 + i } })), recebidos: 6, descartadas: 3, motivosDescarte: {} });
    }
    const det = p.match(/^\/anuncios-meli\/([^/?]+)$/);
    if (det && req.method() === "GET") {
      return json({ ok: true, cliente: { slug: "casabella", nome: CLIENTE.nome }, anuncio: detalhe(det[1]),
        descricao: "Garrafa térmica em aço inoxidável com parede dupla a vácuo. Mantém bebidas quentes por até 12 horas e frias por até 24 horas.\n\n• Capacidade: 1 litro\n• Tampa rosqueável com vedação\n• Livre de BPA",
        descricaoEstado: "ok", descricaoErro: null, categoriaNome: "Garrafas Térmicas" });
    }
    if (/\/revisao$/.test(p)) return json({ ok: true, revisado: !!(body && body.revisado) });
    return json({ ok: false, motivo: "demo" }, 404);
  });
}

module.exports = { rotear, ME_CONTEXT };
