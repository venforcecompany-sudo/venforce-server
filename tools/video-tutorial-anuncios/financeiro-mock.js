// Backend falso da página Financeiro (financeiro-v3.html) para o vídeo:
// dados de demonstração no formato dos contratos usados por
// Portal/financeiro-v3-shell-ui.test.js. Nenhuma chamada chega ao servidor real.
"use strict";

const PROD_HOST = "venforce-server.onrender.com";

const CLIENTE = { id: 87, nome: "Casa Bella Utilidades", slug: "casabella", ativo: true, temGrant: true, grantStatus: "conectado", temBase: true, setupScore: 100, statusOperacional: "pronto", ultimaSincronizacao: null, pendencias: [] };
const CONTAS = [
  { id: 42, cliente_id: 87, marketplace: "meli", nome: "Mercado Livre", externalAccountLabel: "casabella_oficial", ativo: true, is_primary: true, grant: { token_status: "valid" }, base: { base_id: 9, nome: "Custos 2026" } },
];
const ME_CONTEXT = {
  ok: true,
  user: { id: 12, nome: "Ana Souza", email: null, role: "admin" },
  squads: [], squadPrincipalId: null,
  clientes: [{ id: 87, slug: "casabella", nome: CLIENTE.nome, squadId: null, responsavelDireto: true, contasAtivas: 1 }],
  portfolio: { totalClientes: 1 },
  permissoes: { podeAdministrar: true },
};
const BASE = { id: 9, slug: "custos-2026", nome: "Custos 2026", ativo: true,
  vinculo: { cliente_slug: "casabella", marketplace: "meli", cliente_conta_id: 42, conta_nome: "Mercado Livre" } };

// [título, preço, custo, emoji da miniatura]
const PRODUTOS = [
  ["Garrafa Térmica Inox 1 Litro Café Chá Parede Dupla", 89.9, 32.5, "🧉"],
  ["Copo Térmico 500ml com Tampa e Canudo", 69.9, 21, "🥤"],
  ["Jogo de Panelas Antiaderente Cerâmica 5 Peças", 289.9, 112, "🍲"],
  ["Kit 6 Potes Herméticos Vidro Tampa Bambu", 129.9, 54, "🫙"],
  ["Escorredor de Louça Inox 2 Andares", 179.9, 88, "🍽️"],
  ["Tábua de Corte Bambu Grande com Canaleta", 59.9, 18.9, "🪵"],
  ["Faqueiro Inox 24 Peças Cabo Madeira", 149.9, 61, "🍴"],
  ["Organizador de Gaveta Talheres Ajustável", 49.9, 17, "🗂️"],
  ["Jarra de Vidro 1,5 Litro com Tampa", 54.9, 19.5, "🫗"],
  ["Porta-Temperos Giratório 12 Potes", 119.9, 46, "🧂"],
  ["Pote Térmico Marmita Inox 3 Andares", 99.9, 38, "🍱"],
  ["Kit Utensílios de Silicone 12 Peças", 139.9, 51, "🥄"],
  ["Chaleira Elétrica Inox 1,8 Litro", 159.9, 67, "🫖"],
  ["Cafeteira Italiana Moka 6 Xícaras", 119.9, 44, "☕"],
  ["Forma de Bolo Antiaderente Furo Central", 64.9, 22, "🍰"],
  ["Jogo de Facas Chef 5 Peças com Cepo", 219.9, 86, "🔪"],
  ["Kit 3 Assadeiras Vidro Refratário", 109.9, 41, "🥘"],
  ["Lixeira Inox Pedal 5 Litros", 129.9, 52, "🗑️"],
  ["Escova de Garrafa com Cabo Longo Kit 3", 34.9, 9.8, "🧽"],
  ["Pipoqueira Antiaderente com Tampa de Vidro", 89.9, 33, "🍿"],
];
const VARIANTES = ["Preto", "Branco", "Inox", "Verde", "Rosa", "Azul", "Grafite", "Creme", "Vermelho"];
// Os 4 anúncios que chegam SEM custo na Base (viram pendência).
const SEM_CUSTO = ["MLB3456789040", "MLB3456789077", "MLB3456789113", "MLB3456789151"];
function linhas() {
  const out = [];
  for (let i = 0; i < 186; i++) {
    const p = PRODUTOS[i % PRODUTOS.length];
    const id = "MLB34567890" + String(i).padStart(2, "0").slice(-2);
    const itemId = "MLB3456789" + String(i).padStart(3, "0");
    const semCusto = SEM_CUSTO.includes(itemId);
    const un = 3 + ((i * 7) % 11) + (i < 20 ? 25 - i : 0);
    const venda = +(p[1] * un).toFixed(2);
    const total = +(venda * 0.79).toFixed(2);
    const custo = semCusto ? null : p[2];
    const lc = custo == null ? null : +(total - custo * un - venda * 0.06).toFixed(2);
    const variante = i >= PRODUTOS.length ? " " + VARIANTES[Math.floor(i / PRODUTOS.length) - 1] : "";
    out.push({
      "# de anúncio": itemId,
      "Título do anúncio": p[0] + variante,
      Unidades: un, "Venda Total": venda, "Total (BRL)": total,
      "Preço de custo": custo, "Preço de custo total": custo == null ? null : +(custo * un).toFixed(2),
      Imposto: 6, LC: lc, MC: lc == null ? null : +(lc / venda * 100).toFixed(1),
      "Cobertura de custo": custo == null ? "sem custo" : (i % 31 === 7 ? "financeiro pendente" : "com custo"),
    });
  }
  return out;
}
const EMOJI = {};
linhas().forEach((l, i) => { EMOJI[l["# de anúncio"]] = PRODUTOS[i % PRODUTOS.length][3]; });
function svg(emoji) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200"><rect width="200" height="200" fill="#f4f1fa"/><text x="100" y="128" font-size="96" text-anchor="middle">${emoji}</text></svg>`;
}

function processamento() {
  return {
    ok: true, marketplace: "meli", costsSource: "base",
    costsBase: { id: 9, slug: "custos-2026", nome: "Custos 2026" },
    summary: {
      marketplace: "meli", calculationMode: "real_meli_vendas", financialConfidence: "parcial",
      grossRevenueTotal: 186420.7, paidRevenueTotal: 171310.4, revenueWithCost: 179880, revenueWithoutCost: 6540.7,
      calculatedCoveragePercent: 96.5, revenueWithFinancialData: 181200, revenuePendingFinancial: 5220.7, financialDataCoveragePercent: 97.2,
      salesPendingFinancialCount: 14, contributionProfitTotal: 33120.4, contributionMarginCalculated: 0.1777, averageContributionMargin: 0.17,
      finalResult: 14980.6, finalMarginCalculated: 0.0804, tacos: 0.052, tacox: 0.081,
      adsTotal: 9700, venforceTotal: 4500, affiliatesTotal: 1240.3, fullCostTotal: 2700, additionalCostsTotal: 0,
      refundsCount: 17, refundsTotal: -2980.4, lostRevenueTotal: 2980.4, excludedStatusCount: 6,
      ambiguousCostIds: [], executiveNotes: ["6 vendas fora do LC por status (canceladas).", "ADS e Venforce informados manualmente."],
    },
    competencia: { periodoSolicitado: "2026-09", periodoDetectado: "2026-09", divergente: false },
    detailedRows: linhas(),
    unmatchedIds: SEM_CUSTO,
    unmatchedCosts: [],
  };
}

function entregasIniciais() {
  const e = (id, mes, nome, pub) => ({ id, tipo: "fechamento_mensal", cliente_id: 87, cliente_slug: "casabella", cliente_conta_id: 42,
    titulo: "Fechamento " + nome, periodo: "2026-" + mes, status: pub ? "publicado" : "rascunho", publicado: pub,
    token_publico: pub ? "tok-" + mes : null, created_at: "2026-" + mes + "-28T10:00:00Z", published_at: pub ? "2026-" + mes + "-28T12:00:00Z" : null });
  return [e(808, "08", "Agosto", true), e(807, "07", "Julho", true), e(806, "06", "Junho", true), e(805, "05", "Maio", true)];
}
let ENTREGAS = entregasIniciais();
let ULTIMO_RESUMO = null;

function payloadFinanceiro(periodo) {
  const relatorios = ENTREGAS.map((x) => ({ periodo: x.periodo, status: x.status, geradoEm: x.created_at, publicado: x.publicado, token: x.token_publico }));
  const salvo = ENTREGAS.find((x) => x.periodo === periodo);
  return {
    ok: true,
    contexto: { clienteId: 87, clienteSlug: "casabella", clienteContaId: 42, marketplace: "meli", periodo },
    resultado: salvo ? {
      disponivel: true, escopoConta: true,
      dados: { status: salvo.status, geradoEm: salvo.created_at, publicadoEm: salvo.published_at, cards: [],
        composicao: [
          { chave: "faturamento_bruto", rotulo: "Faturamento bruto", valor: 186420.7, disponivel: true },
          { chave: "comissao", rotulo: "Comissão", valor: -24234.7, disponivel: true },
          { chave: "frete", rotulo: "Frete", valor: -11800, disponivel: true },
          { chave: "custo_produto", rotulo: "Custo de produto", valor: -71400, disponivel: true },
          { chave: "resultado", rotulo: "Resultado", valor: 14980.6, disponivel: true },
        ] },
    } : {
      disponivel: false, escopoConta: false,
      dados: { status: "nao_gerado", geradoEm: null, publicadoEm: null, cards: [], composicao: [] },
      motivo: "Nenhum fechamento gerado para este período.",
    },
    conciliacao: { disponivel: true, escopoConta: true, dados: { mpReconciliationStatus: "partial", summary: {
      ordersTotal: 1412, ordersMatchedClean: 1301, ordersMatchedWithEvents: 72, ordersDivergent: 4,
      ordersSettlementPending: 35, coveragePercent: 97.5, paymentsUnique: 1380, paymentsSettlementPending: 35, totalPaymentNet: 168950.2 } } },
    relatorios: { disponivel: true, escopoConta: true, dados: relatorios },
  };
}

function rotear(page) {
  return page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.hostname === "http2.mlstatic.com") return route.fulfill({ status: 200, contentType: "image/svg+xml", body: svg(EMOJI[url.pathname.split("/").pop()] || "📦") });
    if (url.hostname !== PROD_HOST) return route.continue();
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization,content-type", "access-control-allow-methods": "GET,POST,PATCH,PUT,OPTIONS" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const json = (obj, status) => route.fulfill({ status: status || 200, headers: cors, contentType: "application/json", body: JSON.stringify(obj) });
    const p = url.pathname;
    let body = null;
    try { body = req.postDataJSON(); } catch (_) { body = null; }

    if (p.includes("/me/context")) return json(ME_CONTEXT);
    if (p.includes("/operacao/cliente-360/clientes")) return json({ ok: true, clientes: [CLIENTE] });
    if (/\/clientes\/[^/?]+\/contas/.test(p)) return json({ ok: true, cliente: CLIENTE, contas: CONTAS });
    const acao = p.match(/\/entregas-cliente\/(\d+)\/(publicar|despublicar)/);
    if (acao) {
      const alvo = ENTREGAS.find((e) => e.id === Number(acao[1]));
      if (acao[2] === "publicar") Object.assign(alvo, { publicado: true, status: "publicado", token_publico: alvo.token_publico || "tok-" + alvo.id, published_at: new Date().toISOString() });
      else Object.assign(alvo, { publicado: false, status: "rascunho", token_publico: null, published_at: null });
      return json({ ok: true, entrega: alvo });
    }
    if (p.includes("/fechamentos/financeiro")) {
      await new Promise((r) => setTimeout(r, 2200));
      const r = processamento();
      ULTIMO_RESUMO = r.summary;
      return json(r);
    }
    const uma = p.match(/\/entregas-cliente\/(\d+)$/);
    if (uma && req.method() === "GET") {
      const alvo = ENTREGAS.find((e) => e.id === Number(uma[1]));
      if (!alvo) return json({ ok: false, erro: "Entrega não encontrada." }, 404);
      return json({ ok: true, entrega: { ...alvo, payload_json: { summary: ULTIMO_RESUMO || processamento().summary, detailedRows: linhas(), unmatchedIds: SEM_CUSTO, entrega: {
        destaques: ["Margem de contribuição de 17,8% no mês", "Cobertura de custo de 96,5% da receita"],
        atencoes: ["2 anúncios ainda sem custo cadastrado na Base"],
        prioridades: { alta: ["Cadastrar custo do Faqueiro Inox 24 Peças"], media: ["Revisar ADS do Jogo de Panelas"], baixa: [] } } } } });
    }
    if (p.includes("/entregas-cliente")) {
      if (req.method() === "POST") {
        const nova = { id: 809, tipo: "fechamento_mensal", cliente_id: 87, cliente_slug: "casabella", cliente_conta_id: 42, titulo: "Fechamento Setembro",
          periodo: (body && body.periodo) || "2026-09", status: "rascunho", publicado: false, token_publico: null, created_at: new Date().toISOString(), published_at: null };
        ENTREGAS = [nova, ...ENTREGAS.filter((e) => e.id !== 809)];
        return json({ ok: true, entrega: nova }, 201);
      }
      return json({ ok: true, total: ENTREGAS.length, entregas: ENTREGAS });
    }
    if (p.includes("/base-vinculos")) return json({ ok: true, bases: [BASE] });
    if (/\/bases\/assistente\/preview/.test(p)) return json({ ok: true, dados_importacao: [], resumo: { linhas_lidas: 0, linhas_ignoradas: 0 }, alertas: [] });
    if (/\/bases\/[^/]+\/custos\/padrao/.test(p)) return json({ ok: true, padrao: { imposto_percentual: 0.06, taxa_fixa: 0 } });
    if (/\/bases\/[^/]+\/custos\/upsert/.test(p)) return json({ ok: true, acao: "criado" });
    if (/\/bases\/[^/?#]+$/.test(p) && req.method() === "GET") return json({ ok: true, baseId: "custos-2026", nome: "Custos 2026", marketplace: "meli", total: 0, dados: {} });
    if (/\/financeiro\/[^/]+\/ads$/.test(p)) return json({ disponivel: true, fonte: "mercado_ads", investimentoAds: 9700, gmvAds: 61230, roas: 6.31, campanhas: 4, consultadoEm: new Date().toISOString() });
    if (/\/financeiro\/[^/]+\/miniaturas$/.test(p)) {
      const miniaturas = {};
      (url.searchParams.get("itens") || "").split(",").filter(Boolean).forEach((id) => { miniaturas[id] = "https://http2.mlstatic.com/demo/" + id; });
      return json({ ok: true, miniaturas });
    }
    if (p.includes("/financeiro/")) return json(payloadFinanceiro(url.searchParams.get("periodo") || "2026-09"));
    return json({ ok: false, motivo: "demo" }, 404);
  });
}

module.exports = { rotear, ENTREGAS: () => ENTREGAS };
