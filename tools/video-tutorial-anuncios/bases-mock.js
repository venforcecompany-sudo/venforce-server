// Backend falso da página Bases de Custo (bases.html) para o vídeo: dados de
// demonstração no formato dos contratos usados por
// Portal/bases-carteira-ui.test.js. Nenhuma chamada chega ao servidor real.
// O estado é mutável: editar/adicionar item, atualizar por planilha e importar
// uma base nova mudam o que a tela relê em seguida.
"use strict";

const PROD_HOST = "venforce-server.onrender.com";
const diasAtras = (n) => new Date(Date.now() - n * 864e5).toISOString();

const PORTFOLIO = {
  ok: true,
  squads: [],
  clientes: [
    { id: 87, slug: "casabella", nome: "Casa Bella Utilidades", squad: { nome: "Squad Fênix" }, contas: [
      { id: 42, marketplace: "meli", nome: "CASABELLA OFICIAL", external_account_id: "1823349011", ativo: true, baseVinculada: { id: 9 }, grant: { token_status: "valid" } },
      { id: 43, marketplace: "meli", nome: "CASABELLA OUTLET", external_account_id: "1904412873", ativo: true, baseVinculada: { id: 10 }, grant: { token_status: "valid" } },
      { id: 44, marketplace: "shopee", nome: "casabella.shop", external_account_id: "882301457", ativo: true, baseVinculada: null, grant: { token_status: "valid" } },
    ] },
    { id: 88, slug: "lumen", nome: "Lumen Iluminação", squad: { nome: "Squad Fênix" }, contas: [
      { id: 51, marketplace: "meli", nome: "LUMEN ILUMINACAO", external_account_id: "1550982214", ativo: true, baseVinculada: { id: 20 }, grant: { token_status: "valid" } },
    ] },
    { id: 89, slug: "petfeliz", nome: "Pet Feliz Store", squad: { nome: "Squad Eliza" }, contas: [
      { id: 61, marketplace: "meli", nome: "PETFELIZ STORE", external_account_id: "1677120345", ativo: true, baseVinculada: { id: 30 }, grant: { token_status: "valid" } },
      { id: 62, marketplace: "shopee", nome: "petfeliz.oficial", external_account_id: "730118842", ativo: true, baseVinculada: { id: 31 }, grant: { token_status: "valid" } },
    ] },
    { id: 90, slug: "ateliebambu", nome: "Ateliê Bambu", squad: { nome: "Squad Eliza" }, contas: [
      { id: 71, marketplace: "meli", nome: "ATELIE BAMBU", external_account_id: "1688003219", ativo: true, baseVinculada: null, grant: { token_status: "valid" } },
    ] },
  ],
};
const CLIENTE_POR_ID = Object.fromEntries(PORTFOLIO.clientes.map((c) => [c.id, c]));

const ME_CONTEXT = {
  ok: true,
  user: { id: 12, nome: "Ana Souza", email: null, role: "admin" },
  squads: [], squadPrincipalId: null,
  clientes: PORTFOLIO.clientes.map((c) => ({ id: c.id, slug: c.slug, nome: c.nome, squadId: null, responsavelDireto: true, contasAtivas: c.contas.length })),
  portfolio: { totalClientes: PORTFOLIO.clientes.length },
  permissoes: { podeAdministrar: true },
};

// [nome do produto, custo]
const PRODUTOS = [
  ["Garrafa Térmica Inox 1 Litro", 32.5], ["Copo Térmico 500ml com Tampa", 21], ["Jogo de Panelas Cerâmica 5 Peças", 112],
  ["Kit 6 Potes Herméticos Vidro", 54], ["Escorredor de Louça Inox", 88], ["Tábua de Corte Bambu Grande", 18.9],
  ["Faqueiro Inox 24 Peças", 61], ["Organizador de Gaveta Talheres", 17], ["Jarra de Vidro 1,5 Litro", 19.5],
  ["Porta-Temperos Giratório 12 Potes", 46], ["Marmita Inox 3 Andares", 38], ["Kit Utensílios de Silicone 12 Peças", 51],
  ["Chaleira Elétrica Inox 1,8 Litro", 67], ["Cafeteira Italiana Moka 6 Xícaras", 44], ["Forma de Bolo Furo Central", 22],
  ["Jogo de Facas Chef 5 Peças", 86], ["Kit 3 Assadeiras Vidro", 41], ["Lixeira Inox Pedal 5 Litros", 52],
  ["Escova de Garrafa Kit 3", 9.8], ["Pipoqueira Antiaderente", 33],
];

// Itens por base: { chave → { produto_id, custo_produto, imposto_percentual, taxa_fixa, produto_nome, id_model? } }
function gerarItens(prefixo, n, { imposto, taxa, zerados = [], shopee = false }) {
  const dados = {};
  for (let i = 0; i < n; i++) {
    const p = PRODUTOS[i % PRODUTOS.length];
    const id = shopee ? String(2280000000 + i * 37) : prefixo + String(3456789000 + i * 13);
    const ajuste = 1 + ((i * 7) % 5) / 20;
    dados[id] = {
      produto_id: id,
      custo_produto: zerados.includes(i) ? 0 : +(p[1] * ajuste).toFixed(2),
      imposto_percentual: imposto,
      taxa_fixa: taxa,
      produto_nome: p[0],
      ...(shopee ? { id_model: i % 3 === 0 ? String(170000 + i) : null } : {}),
    };
  }
  return dados;
}

const base = (id, slug, nome, marketplace, dias, dados) => ({ id, slug, nome, marketplace, ativo: true, created_at: diasAtras(dias + 60), updated_at: diasAtras(dias), dados });
const BASES = [
  base(9, "custos-2026", "Custos 2026", "meli", 6, gerarItens("MLB", 412, { imposto: 0.06, taxa: 6.75, zerados: [37, 81, 140, 199, 263, 301, 344, 388] })),
  base(10, "outlet-2026", "Outlet 2026", "meli", 41, gerarItens("MLB", 96, { imposto: 0.06, taxa: 6.75 })),
  base(11, "casabella-tiktok", "casabella_tiktok", "tiktok", 12, gerarItens("", 58, { imposto: 0.06, taxa: 0, shopee: true })),
  base(20, "lumen", "Lumen 2026", "meli", 9, gerarItens("MLB", 318, { imposto: 0.08, taxa: 6.75 })),
  base(30, "petfeliz", "Pet Feliz ML", "meli", 3, gerarItens("MLB", 254, { imposto: 0.06, taxa: 6.75, zerados: [12, 90] })),
  base(31, "petfeliz-shopee", "Pet Feliz Shopee", "shopee", 15, gerarItens("", 230, { imposto: 0.06, taxa: 4, shopee: true })),
  base(40, "teste_importacao", "teste_importacao", "shopee", 80, gerarItens("", 12, { imposto: 0, taxa: 0, shopee: true })),
];
const vinc = (clienteId, contaId) => {
  const c = CLIENTE_POR_ID[clienteId];
  const conta = contaId ? c.contas.find((x) => x.id === contaId) : null;
  return { cliente_id: c.id, cliente_nome: c.nome, cliente_slug: c.slug, marketplace: conta ? conta.marketplace : null,
    cliente_conta_id: conta ? conta.id : null, conta_nome: conta ? conta.nome : null, external_account_id: conta ? conta.external_account_id : null };
};
const VINCULOS = {
  9: vinc(87, 42), 10: vinc(87, 43), 11: { ...vinc(87, null), marketplace: "tiktok" },
  20: vinc(88, 51), 30: vinc(89, 61), 31: vinc(89, 62),
};

// GET /anuncios-meli/resumo por conta ML: anúncios sincronizados × sem custo.
const RESUMOS = { 43: { total: 100, semCusto: 0 }, 51: { total: 318, semCusto: 0 }, 61: { total: 260, semCusto: 6 } };

const resumoBase = (b) => {
  const itens = Object.values(b.dados);
  const { dados, ...resto } = b;
  return { ...resto, total_skus: itens.length, skus_com_custo: itens.filter((i) => Number(i.custo_produto) > 0).length };
};

// Planilha de atualização (botão "Atualizar por planilha" da Custos 2026):
// 9 itens que já existem com custo novo (inclui os zerados) + 3 novos.
function planilhaAtualizacao() {
  const b = BASES[0];
  const ids = Object.keys(b.dados);
  const existentes = [37, 81, 140, 199, 263, 301, 344, 388, 5].map((i) => ({ id: ids[i], custo: +(PRODUTOS[i % PRODUTOS.length][1] * 1.08).toFixed(2), imposto: 0.06 }));
  const novos = [0, 1, 2].map((k) => ({ id: "MLB" + String(4012345670 + k * 11), custo: [27.9, 63.5, 14.2][k], imposto: 0.06 }));
  return [...existentes, ...novos];
}

// Planilha da base nova (Shopee da Casa Bella).
function planilhaShopee() {
  const linhas = [];
  for (let i = 0; i < 236; i++) {
    const p = PRODUTOS[i % PRODUTOS.length];
    linhas.push({ id: String(2290000000 + i * 41), id_model: i % 4 === 0 ? String(180000 + i) : null, custo_produto: +(p[1] * 1.02).toFixed(2), imposto_percentual: 0.06, taxa_fixa: 4 });
  }
  return linhas;
}

function rotear(page) {
  return page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.hostname !== PROD_HOST) return route.continue();
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization,content-type", "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const json = (obj, status) => route.fulfill({ status: status || 200, headers: cors, contentType: "application/json", body: JSON.stringify(obj) });
    const p = url.pathname;
    const atraso = (ms) => new Promise((r) => setTimeout(r, ms));

    if (p === "/me/context") return json(ME_CONTEXT);
    if (p === "/me/portfolio") return json(PORTFOLIO);
    if (p === "/operacao/cliente-360/clientes") return json({ ok: true, clientes: PORTFOLIO.clientes.map((c) => ({ id: c.id, nome: c.nome, slug: c.slug, ativo: true, temGrant: true, grantStatus: "conectado", temBase: true, setupScore: 100, statusOperacional: "pronto", pendencias: [] })) });
    if (p === "/bases") return json({ ok: true, bases: BASES.map(resumoBase) });
    if (p === "/base-vinculos") return json({ ok: true, bases: BASES.map((b) => ({ id: b.id, slug: b.slug, vinculo: VINCULOS[b.id] || null, sugestao: null })) });
    if (p === "/base-vinculos/clientes") return json({ ok: true, clientes: PORTFOLIO.clientes.map((c) => ({ id: c.id, nome: c.nome, slug: c.slug, ativo: true })) });
    if (p === "/cliente-imagens") return json({ ok: true, imagens: [] });
    if (p === "/anuncios-meli/resumo") {
      await atraso(500);
      const conta = url.searchParams.get("clienteContaId");
      // Conta 42: "sem custo" acompanha os itens zerados da Custos 2026.
      const r = conta === "42" ? { total: 420, semCusto: Object.values(BASES[0].dados).filter((i) => !(Number(i.custo_produto) > 0)).length } : RESUMOS[conta];
      return r ? json({ ok: true, cliente: {}, resumo: r }) : json({ ok: false, motivo: "demo" }, 500);
    }
    const contas = p.match(/^\/clientes\/([^/]+)\/contas$/);
    if (contas) {
      const cli = PORTFOLIO.clientes.find((c) => String(c.id) === contas[1] || c.slug === contas[1]);
      const mp = url.searchParams.get("marketplace");
      return json({ ok: true, cliente: cli, contas: (cli ? cli.contas : []).filter((c) => !mp || c.marketplace === mp) });
    }
    if (p === "/bases/assistente/preview") {
      await atraso(1200);
      const dados = planilhaAtualizacao();
      return json({ ok: true, dados_importacao: dados, resumo: { linhas_lidas: dados.length + 1, linhas_ignoradas: 1 }, alertas: [] });
    }
    const upsert = p.match(/^\/bases\/([^/]+)\/custos\/upsert$/);
    if (upsert) {
      await atraso(250);
      const b = BASES.find((x) => x.slug === decodeURIComponent(upsert[1]));
      const body = req.postDataJSON() || {};
      const atual = b.dados[body.produto_id];
      b.dados[body.produto_id] = {
        produto_id: body.produto_id,
        custo_produto: body.custo_produto,
        imposto_percentual: body.imposto_percentual != null ? body.imposto_percentual : (atual ? atual.imposto_percentual : 0.06),
        taxa_fixa: body.taxa_fixa != null ? body.taxa_fixa : (atual ? atual.taxa_fixa : 6.75),
        produto_nome: atual ? atual.produto_nome : null,
      };
      b.updated_at = new Date().toISOString();
      return json({ ok: true, acao: atual ? "atualizado" : "criado" });
    }
    const custos = p.match(/^\/bases\/([^/]+)$/);
    if (custos && req.method() === "GET") {
      await atraso(350);
      const b = BASES.find((x) => x.slug === decodeURIComponent(custos[1]));
      return b ? json({ ok: true, baseId: b.slug, nome: b.nome, marketplace: b.marketplace, total: Object.keys(b.dados).length, dados: b.dados }) : json({ ok: false, erro: "Base não encontrada" }, 404);
    }
    if (p === "/importar-base") {
      await atraso(1400);
      const corpo = req.postData() || "";
      const linhas = planilhaShopee();
      if (!/name="confirmar"/.test(corpo)) {
        return json({ ok: true, marketplace: "shopee", total: 238, idsDetectados: linhas.length, preview: linhas.slice(0, 12).map((l) => ({ ...l })) });
      }
      const nome = (corpo.match(/name="nomeBase"\r?\n\r?\n([^\r\n]*)/) || [])[1] || "casabella_shopee";
      const dados = {};
      linhas.forEach((l, i) => { dados[l.id + "|" + (l.id_model || "")] = { produto_id: l.id, id_model: l.id_model, custo_produto: l.custo_produto, imposto_percentual: l.imposto_percentual, taxa_fixa: l.taxa_fixa, produto_nome: PRODUTOS[i % PRODUTOS.length][0] }; });
      const nova = base(12, nome, nome, "shopee", 0, dados);
      BASES.push(nova);
      VINCULOS[12] = vinc(87, 44);
      CLIENTE_POR_ID[87].contas.find((c) => c.id === 44).baseVinculada = { id: 12 };
      return json({ ok: true, mensagem: "Base importada", total: linhas.length, vinculo: VINCULOS[12] });
    }
    return json({ ok: false, motivo: "demo" }, 404);
  });
}

module.exports = { rotear };
