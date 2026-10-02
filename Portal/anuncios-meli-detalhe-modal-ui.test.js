/*
 * Detalhe do anúncio (Anúncios ML) — o drawer lateral com 5 abas virou um
 * MODAL CENTRAL de superfície única, e Título/Modelo/Descrição passaram a ser
 * editáveis DE VERDADE (escrita no Mercado Livre via PATCH /:itemId/conteudo).
 *
 * O que só um navegador comprova, e por isso está aqui:
 *
 *   · clicar numa linha abre o modal novo — e o drawer/tabs sumiram do DOM,
 *     não ficaram escondidos por baixo;
 *   · alteração pendente é DETECTADA, aparece na barra e some ao descartar;
 *   · salvar leva o clienteSlug + clienteContaId do contexto, e só vira
 *     "salvo" o campo que o backend confirmou — erro não produz falso sucesso;
 *   · fechar com alteração pendente não perde dado em silêncio;
 *   · resposta atrasada da Conta A não pinta a tela da Conta B, e o estado do
 *     anúncio A (inclusive sugestões de IA) não vaza para o anúncio B;
 *   · usuário sem IA (403) usa o modal inteiro — a região de IA se explica em
 *     vez de ficar muda (achado F-02 da auditoria);
 *   · "descrição ausente" e "erro ao carregar descrição" são estados
 *     diferentes na tela (achado F-06).
 */
"use strict";

const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");

const PORTAL_DIR = __dirname;
const PROD_HOST = "venforce-server.onrender.com";

const N97 = { id: 87, nome: "N97 Comercial", slug: "n97", ativo: true, temGrant: true, grantStatus: "conectado", temBase: true, setupScore: 100, statusOperacional: "pronto", ultimaSincronizacao: null, pendencias: [] };
const N97_CONTAS = [
  { id: 42, cliente_id: 87, marketplace: "meli", nome: "Loja A", externalAccountLabel: "lojaa", ativo: true, grant: { token_status: "valid" }, base: { base_id: 9, nome: "Custo" } },
  { id: 43, cliente_id: 87, marketplace: "meli", nome: "Loja B", externalAccountLabel: "lojab", ativo: true, grant: { token_status: "valid" }, base: { base_id: 9, nome: "Custo" } },
];
const ME_CONTEXT = {
  ok: true,
  user: { id: 12, nome: "Pedro Gomes", email: null, role: "user" },
  squads: [], squadPrincipalId: null,
  clientes: [{ id: 87, slug: "n97", nome: "N97 Comercial", squadId: null, responsavelDireto: false, contasAtivas: 2 }],
  portfolio: { totalClientes: 1 },
  permissoes: { podeAdministrar: false },
};

const TITULO_A = "Fone Bluetooth TWS Prime X200 ANC 30h Bateria Original";
const TITULO_B = "Cafeteira Expressa B300 Inox 220V Compacta";
const DESC_A = "Fone Bluetooth TWS Prime X200 com cancelamento ativo de ruído (ANC) e bateria de até 30 horas.";
const SUG_DESC_A = "Fone Bluetooth TWS Prime X200 com ANC, 30h de bateria, Bluetooth 5.3 e estojo USB-C.";
const SUG_TITULO_A = "Fone Bluetooth TWS Prime X200 Cancelamento Ruído 30h";
// POST /:itemId/seo/titulos — sugestões do Title Engine (score do backend).
const SUG_TITULOS = [
  "Fone Bluetooth TWS Prime Audio X200 ANC 30h Bateria Preto",
  "Fone de Ouvido Bluetooth Prime Audio X200 ANC Preto 30h",
  "Fone TWS Prime Audio X200 Bluetooth ANC Bateria 30h",
  "Fone Bluetooth Prime Audio X200 Preto ANC",
].map((titulo, i) => ({
  titulo, chars: titulo.length, score: 94 - i * 7,
  breakdown: { cobertura: 33 - i * 3, relevancia: 24, eficiencia: 15 - i * 2, especificidade: 10, clareza: 10 - i, redundancia: 2 + i },
}));

function anuncio(conta) {
  const a = conta === "43"
    ? { item_id: "MLB-B1", titulo: TITULO_B, sku: "CF-B300", marca: "BrewCo", modelo: "B300", preco: 399.9, cliente_conta_id: 43, ml_user_id: "9002" }
    : { item_id: "MLB-A1", titulo: TITULO_A, sku: "FN-X200-PRT", marca: "Prime Audio", modelo: "X200", preco: 189.9, cliente_conta_id: 42, ml_user_id: "9001" };
  if (semModeloComVariacoes) a.modelo = null;
  return {
    id: 1, cliente_id: 87, cliente_slug: "n97",
    item_id: a.item_id, titulo: a.titulo, sku: a.sku, marca: a.marca, modelo: a.modelo,
    variations_count: semModeloComVariacoes ? 4 : 0,
    preco: a.preco, preco_original: precoOriginalAtivo ? 249.9 : null, moeda: "BRL", estoque: 42, vendidos: 187,
    status: "active", sub_status: null,
    listing_type_id: "gold_special", category_id: "MLB1055",
    permalink: "https://produto.mercadolivre.com.br/" + a.item_id,
    thumbnail: null, pictures_count: 2,
    pictures_json: ["https://img.example/1.jpg", "https://img.example/2.jpg"],
    logistic_type: "fulfillment", is_full: true,
    attributes_json: [
      { id: "BRAND", name: "Marca", value: a.marca },
      ...(a.modelo == null ? [] : [{ id: "MODEL", name: "Modelo", value: a.modelo }]),
      { id: "COLOR", name: "Cor", value: "Preto" },
      { id: "WEIGHT", name: "Peso", value: null },
      { id: "WARRANTY_TIME", name: "Garantia do fabricante", value: null },
    ],
    health: 0.82, score_venforce: 61, score_motivo: "Menos de 3 fotos",
    revisado: false, cliente_conta_id: a.cliente_conta_id, ml_user_id: a.ml_user_id,
    last_synced_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
    catalog_listing: catalogoModo === "catalog_listing" || catalogoModo === "ambos",
    family_name: (catalogoModo === "family_name" || catalogoModo === "ambos" || catalogoModo === "produto") ? "Serum Ácido Salicílico" : null,
    user_product_id: catalogoModo === "produto" ? "MLBU77" : null,
  };
}

const OTIMIZACOES_A = [
  {
    id: 501, tipo: "seo", status: "rascunho", ai_model: "claude",
    titulo_sugerido: SUG_TITULO_A, titulo_sugerido_chars: SUG_TITULO_A.length,
    modelo_sugerido: "X200 Pro",
    melhorias_json: { titulos_alternativos: ["Fone TWS Prime X200 ANC Bluetooth 5.3 30h", "Fone Bluetooth Prime X200 ANC Preto 30 Horas"] },
    alertas_json: ["Falta menção à cor"],
    score_seo: 78, motivo: "boas palavras-chave, falta menção à cor",
    aprovado_at: null,
  },
  {
    id: 502, tipo: "descricao", status: "rascunho", ai_model: "claude",
    descricao_sugerida: SUG_DESC_A,
    melhorias_json: { itens: ["Inclui benefícios concretos (ANC, autonomia)"] },
    alertas_json: ["Ainda não menciona a cor disponível"],
    aprovado_at: null,
  },
  {
    id: 503, tipo: "ficha_tecnica", status: "rascunho", ai_model: "claude",
    ficha_tecnica_sugerida_json: [
      { campo: "Peso", valor_atual: "", valor_sugerido: "38 g", confianca: "alta", precisa_revisao: false },
      { campo: "Garantia do fabricante", valor_atual: "", valor_sugerido: "12 meses", confianca: "media", precisa_revisao: true },
    ],
    alertas_json: [],
    aprovado_at: null,
  },
];

// ── interruptores do cenário, ligados por cada verificação ──────────────────
let iaProibida = false;
let descricaoEstado = "ok";          // ok | sem_descricao | erro
let categoriaNomeResposta = "Celulares e Smartphones"; // null = simula falha de resolução
let precoOriginalAtivo = true;       // false = anúncio sem promoção (preco_original nulo)
let variationsCountAtivo = 0;        // > 0 = item legado com variations[] reais no ML (ver anuncio.variations_count)
// "nenhum" | "catalog_listing" | "family_name" | "ambos" — os dois sinais são
// testados em separado porque a causa raiz da tag divergente era exatamente
// um lugar olhar só catalog_listing e o outro olhar catalog_listing||family_name.
let catalogoModo = "nenhum";
// Anúncio SEM modelo (MODEL ausente na ficha) e COM variações legadas — ver 7d.
let semModeloComVariacoes = false;
let detalheAtrasoPorItem = {};       // itemId -> ms
let titulosHandler = null;           // (itemId, body) => { status, corpo } do POST /seo/titulos
// Todo POST /seo/modelo (removido na F4R) ou /seo/termos-complementares
// (sem UI nesta fase). O front não pode chamar nenhum dos dois — ver 45e.
const seoModeloOuTermosChamadas = []; // { caminho, body }
let titulosAtrasoMs = 0;             // segura a resposta para o teste ver "Gerando…"
const titulosChamadas = [];          // { itemId, body } de todo POST /seo/titulos
let descricaoSeoHandler = null;      // (itemId, body) => { status, corpo } do POST /seo/descricao
let descricaoSeoAtrasoMs = 0;        // segura a resposta para o teste ver "Gerando…"
const descricaoSeoChamadas = [];     // { itemId, body } de todo POST /seo/descricao
let conteudoResultado = null;        // resposta forçada do PATCH /conteudo
let precoResultado = null;           // resposta forçada do PATCH /preco
const precoChamadas = [];            // { itemId, body } de todo PATCH /preco
let simularMargemHandler = null;     // (itemId, body) => resposta do POST /simular-margem
const simularMargemChamadas = [];    // { itemId, body } de todo POST /simular-margem
// GET /anuncios-meli/:itemId/promocoes — bloco "Promoções disponíveis". Lista
// já no formato NORMALIZADO que o backend devolve (a normalização em si é
// coberta por server/tests/meliAnunciosPromocoes.test.js; aqui só interessa
// como o FRONTEND renderiza e edita o que o backend já entregou).
let promocoesRespostaPadrao = [];
const promocoesChamadas = [];        // itemId de cada GET /promocoes
// POST /anuncios-meli/:itemId/promocoes/:promotionId/aplicar — escrita real
// (Participar/Alterar confirmados). `aplicarPromocaoResultado`, quando
// setado, substitui a resposta padrão inteira (pra simular recusa do ML).
let aplicarPromocaoResultado = null;
const aplicarPromocaoChamadas = [];  // { itemId, promotionId, body } de toda chamada
const pedidos = [];                  // toda URL de API disparada
const corpos = [];                   // { url, body } de toda escrita

// GET /anuncios-meli/performance — só a seção "Composição da margem" do
// modal chama isto (a lista tem arquivo de teste próprio). `performanceHandler`,
// quando setado, substitui a resposta padrão inteira; `chamadasPerformance`
// registra cada chamada com os flags exatos que vieram na query string.
let performanceHandler = null;
// POST /anuncios-meli/:itemId/imagens — null = sucesso (anúncio volta com 3
// fotos); { status, corpo } = resposta forçada (erro do ML, bloqueio...).
let imagemResultado = null;
let imagemAtrasoMs = 0;              // segura a resposta para o teste ver "Processando"
// true = o POST /imagens é desviado para o servidor LOCAL do teste (rede de
// verdade) em vez de respondido pelo Fetch do CDP. Motivo: com o pedido
// pausado no CDP o corpo nunca é transmitido, então xhr.upload não dispara
// progress/load — e é esse evento que leva a tela de "Enviando" a
// "Processando". Só com rede real dá para ver a transição.
let imagemViaRede = false;
let portaLocal = 0;
const imagemChamadas = [];           // { url, metodo, contentType } de todo POST /imagens
// GET /anuncios-meli/:itemId/fotos/variacoes — leitura do editor de fotos.
// variationsCountAtivo > 0 → três grupos (Robalo P/M com 3 fotos, Preto P com
// 1, Verde P sem fotos); senão a galeria simples (A, B).
// fotosLeituraResultado = { status, corpo } força a resposta (erro, vazio…).
let fotosLeituraResultado = null;
let fotosLeituraAtrasoMs = 0;
let fotosLeituraChamadas = 0;
const fotosEscritas = [];            // todo PUT /fotos visto pelo interceptador
// PUT /fotos vai pela rede real até o servidor local (/__fotos), que lê o
// multipart. fotosResultado = { status, corpo } força a resposta; senão, ok.
const fotosChamadas = [];            // { url, plano, arquivos: [{ campo, nome, tipo, bytes }] }
let fotosResultado = null;
let fotosAtrasoMs = 0;
const FOTO = (id) => ({ id, url: `https://img.example/${id}.jpg` });
function grupoFotos(valor, valueId, combinacoes, ids) {
  const fotos = ids.map(FOTO);
  return { grupoVariacao: { attribute_id: "COLOR", value_id: valueId, value_name: valor }, rotulo: valor,
    combinacoes, quantidade: fotos.length, principal: fotos[0] || null, fotos };
}
function leituraFotos() {
  if (variationsCountAtivo > 0) {
    return { ok: true, modo: "variacoes", atributo: { id: "COLOR", nome: "Cor" }, limite: { porGrupo: 10, origem: "categoria" },
      grupos: [
        grupoFotos("Robalo", null, ["P", "M"], ["R1", "R2", "R3"]),
        grupoFotos("Preto", "52028", ["P"], ["P1"]),
        grupoFotos("Verde", "52030", ["P"], []),
      ] };
  }
  const fotos = ["A", "B"].map(FOTO);
  return { ok: true, modo: "simples", atributo: null, limite: { porGrupo: 12, origem: "categoria" },
    grupos: [{ grupoVariacao: null, rotulo: "", combinacoes: [], quantidade: 2, principal: fotos[0], fotos }] };
}
// GET /anuncios-meli/:itemId/imagens/variacoes — null = dois grupos de Cor
// (Azul: P, M; Preto: P); { status, corpo } = resposta forçada.
let imagemGruposResultado = null;
let imagemGruposChamadas = 0;
const GRUPOS_IMAGEM = {
  ok: true,
  atributo: { id: "COLOR", nome: "Cor" },
  grupos: [
    { chave: "id:52049", valor: "Azul", variacoes: [{ id: "101", rotulo: "P" }, { id: "102", rotulo: "M" }],
      pictureIds: ["AZ1"], fotos: ["https://img.example/azul.jpg"] },
    { chave: "id:52028", valor: "Preto", variacoes: [{ id: "103", rotulo: "P" }],
      pictureIds: ["PR1"], fotos: ["https://img.example/preto.jpg"] },
  ],
};
const chamadasPerformance = [];
// MLB-A1 (item padrão desta suíte, conta 42): margem PROJETADA saudável,
// com ladder completo — Margem = Margem Projetada, somente, nesta tela (o
// backend nunca manda "realized" para esta rota, ver montarMapaMargem).
const MARGEM_MLA1 = { origem: "projected", margin: 0.35, marginPercent: 35, profit: 70, status: "HEALTHY", statusLabel: "Saudável", statusReasons: [] };
const COMPOSICAO_MLA1 = { venda: 200, custoProduto: 80, comissaoMl: 25, frete: 15, taxaFixa: null, impostoPercentual: 0.05, impostoValor: 10 };

// Fixtures do bloco "Promoções disponíveis" — já no formato normalizado que
// GET /:itemId/promocoes devolve (ver server/services/meliAnuncios/meliPromocoesService.js).
const PROMO_ATIVA = {
  id: "P-1", tipo: "DEAL", tipoLabel: "Campanha tradicional", nome: "HOTSALE",
  status: "started", statusLabel: "ATIVA", statusExibicao: "ATIVA", inicio: "2026-09-01T12:00:00Z", fim: "2026-09-30T12:00:00Z",
  precoOriginal: 249.9, precoFinal: 199.9, descontoReais: 50, descontoPercentual: 20,
  meliPercentage: 5, sellerPercentage: 10, subsidioMl: 2.5, editavelPrecoFinal: true,
};
// Igual a PROMO_ATIVA, mas SEM subsidioMl — usada para provar que a escrita
// real (Alterar → PUT) continua funcionando quando não há retorno ML (ver
// check 40b). PROMO_ATIVA (com subsidioMl) passou a testar o AVISO de
// bloqueio em vez da escrita (ver check 40e — regra revisada: rebate nunca
// pode chegar a um PUT real).
const PROMO_ATIVA_SEM_REBATE = {
  id: "P-1", tipo: "DEAL", tipoLabel: "Campanha tradicional", nome: "HOTSALE",
  status: "started", statusLabel: "ATIVA", statusExibicao: "ATIVA", inicio: "2026-09-01T12:00:00Z", fim: "2026-09-30T12:00:00Z",
  precoOriginal: 249.9, precoFinal: 199.9, descontoReais: 50, descontoPercentual: 20,
  meliPercentage: null, sellerPercentage: null, subsidioMl: null, editavelPrecoFinal: true,
};
const PROMO_CANDIDATE = {
  id: "PD-1", tipo: "PRICE_DISCOUNT", tipoLabel: "Desconto individual", nome: null,
  status: "candidate", statusLabel: "ELEGÍVEL", statusExibicao: "ELEGÍVEL", inicio: null, fim: null,
  precoOriginal: 249.9, precoFinal: 224.9, descontoReais: 25, descontoPercentual: 10,
  meliPercentage: null, sellerPercentage: null, subsidioMl: null, editavelPrecoFinal: true,
};
// Mesmo tipo de PROMO_ATIVA (DEAL) mas candidate — usada nos testes de
// escrita real (POST participar), já que PD-1 (PRICE_DISCOUNT) está fora do
// escopo de escrita desta v1 (ver meliPromocoesEscritaService.TIPOS_COM_ESCRITA).
const PROMO_CANDIDATE_DEAL = {
  id: "P-2", tipo: "DEAL", tipoLabel: "Campanha tradicional", nome: "Semana do Cliente",
  status: "candidate", statusLabel: "ELEGÍVEL", statusExibicao: "ELEGÍVEL", inicio: null, fim: null,
  precoOriginal: 249.9, precoFinal: 224.9, descontoReais: 25, descontoPercentual: 10,
  meliPercentage: null, sellerPercentage: null, subsidioMl: null, editavelPrecoFinal: true,
};
// DEAL started (tipo com escrita), mas o sale_price aponta pra OUTRA
// promoção — statusExibicao: NÃO APLICADA. Regra revisada: o vendedor já
// PARTICIPA desta promoção (status bruto started/active) mesmo que ela não
// seja a que forma o preço atual agora — "Alterar" tem de aparecer e a
// escrita real precisa funcionar do mesmo jeito que PROMO_ATIVA_SEM_REBATE
// (ver check 41b). Só PROGRAMADA (pending, ainda não começou) continua
// bloqueada (ver check 41).
const PROMO_NAO_APLICADA = {
  id: "P-3", tipo: "DEAL", tipoLabel: "Campanha tradicional", nome: "Campanha Paralela",
  status: "started", statusLabel: "ATIVA", statusExibicao: "NÃO APLICADA", inicio: null, fim: null,
  precoOriginal: 249.9, precoFinal: 219.9, descontoReais: 30, descontoPercentual: 12,
  meliPercentage: null, sellerPercentage: null, subsidioMl: null, editavelPrecoFinal: true,
};
// DEAL pending (tipo com escrita) — statusExibicao: PROGRAMADA. Mesma prova
// que PROMO_NAO_APLICADA, para o outro caso que o gate também bloqueia.
const PROMO_PROGRAMADA = {
  id: "P-4", tipo: "DEAL", tipoLabel: "Campanha tradicional", nome: "Campanha Futura",
  status: "pending", statusLabel: "AGENDADA", statusExibicao: "PROGRAMADA", inicio: "2026-10-01T00:00:00Z", fim: "2026-10-31T00:00:00Z",
  precoOriginal: 249.9, precoFinal: 199.9, descontoReais: 50, descontoPercentual: 20,
  meliPercentage: null, sellerPercentage: null, subsidioMl: null, editavelPrecoFinal: true,
};
// Tipos SEM contrato de escrita simétrico nesta v1 (ver PROMO_TIPOS_COM_ESCRITA
// em anuncios-meli.js) — mesmo já PARTICIPADOS (started/ATIVA) pelo vendedor,
// nunca podem oferecer "Alterar": o backend recusaria o PUT mesmo que o botão
// tentasse (ver meliPromocoesEscritaService.TIPOS_COM_ESCRITA). subsidioMl
// fica null de propósito, para isolar este teste do bloqueio de rebate (ver
// check 40e) — aqui o bloqueio tem de vir só do TIPO (ver checks 42/42b).
const PROMO_TIPOS_SEM_ESCRITA_JA_PARTICIPADOS = [
  { id: "T-SMART", tipo: "SMART", tipoLabel: "Campanha cofinanciada automatizada" },
  { id: "T-PD", tipo: "PRICE_DISCOUNT", tipoLabel: "Desconto individual" },
  { id: "T-PN", tipo: "PRE_NEGOTIATED", tipoLabel: "Desconto pré-acordado" },
  { id: "T-PM", tipo: "PRICE_MATCHING", tipoLabel: "Preços competitivos" },
  { id: "T-LN", tipo: "LIGHTNING", tipoLabel: "Oferta relâmpago" },
].map((base) => Object.assign({
  nome: null, status: "started", statusLabel: "ATIVA", statusExibicao: "ATIVA", inicio: null, fim: null,
  precoOriginal: 249.9, precoFinal: 199.9, descontoReais: 50, descontoPercentual: 20,
  meliPercentage: null, sellerPercentage: null, subsidioMl: null, editavelPrecoFinal: true,
}, base));

// Identidade de uma linha de promoção na tela — mesma chave de
// anuncios-meli.js (promocaoChave): id sozinho não é único entre TIPOS
// diferentes de campanha (ver auditoria de deduplicação no backend), então
// data-promo-key sempre carrega id+tipo, nunca só o id.
function chave(p) { return p.id + "::" + p.tipo; }

const SEMENTE = `
  try {
    localStorage.setItem("vf-token", "detalhe-modal-token");
    localStorage.setItem("vf-user", JSON.stringify({ id: 12, nome: "Pedro Gomes", role: "user" }));
    sessionStorage.removeItem("vf-ctx");
  } catch (e) {}
`;

function startServer() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://localhost");
    if (u.pathname === "/__imagens") { servirImagemLocal(req, res, u); return; }
    if (u.pathname === "/__fotos") { servirFotosLocal(req, res, u); return; }
    const target = path.resolve(PORTAL_DIR, u.pathname.replace(/^\/+/, ""));
    if (!target.startsWith(path.resolve(PORTAL_DIR) + path.sep)) { res.writeHead(403).end("forbidden"); return; }
    fs.readFile(target, (err, contents) => {
      if (err) { res.writeHead(404).end("not found"); return; }
      const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
      res.writeHead(200, { "Content-Type": types[path.extname(target)] || "application/octet-stream", "Cache-Control": "no-store" });
      res.end(contents);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Destino do POST /imagens quando imagemViaRede=true (ver acima). Lê o corpo
// multipart inteiro — é isso que faz o navegador concluir o upload — e só
// então responde, depois de imagemAtrasoMs.
function servirImagemLocal(req, res, u) {
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization,content-type",
    "access-control-allow-methods": "POST,OPTIONS",
  };
  if (req.method === "OPTIONS") { res.writeHead(204, cors).end(); return; }
  let bytes = 0;
  req.on("data", (c) => { bytes += c.length; });
  req.on("end", async () => {
    imagemBytesRecebidos = bytes;
    if (imagemAtrasoMs) await sleep(imagemAtrasoMs);
    const base = anuncio(u.searchParams.get("clienteContaId") || "42");
    base.pictures_json = base.pictures_json.concat(["https://img.example/nova.jpg"]);
    base.pictures_count = base.pictures_json.length;
    res.writeHead(200, Object.assign({ "content-type": "application/json" }, cors));
    res.end(JSON.stringify({ ok: true, pictureId: "999-MLB", anuncio: base, confirmacaoPendente: false,
      imagem: { width: 800, height: 800, bytes, abaixoDoMinimoMl: false } }));
  });
}
let imagemBytesRecebidos = 0;

// Destino do PUT /fotos (editor de fotos). Lê o multipart inteiro: o campo
// `plano` (JSON) e cada arquivo (campo, nome, tipo, tamanho), na ordem.
function servirFotosLocal(req, res, u) {
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization,content-type",
    "access-control-allow-methods": "PUT,OPTIONS",
  };
  if (req.method === "OPTIONS") { res.writeHead(204, cors).end(); return; }
  const partes = [];
  req.on("data", (c) => partes.push(c));
  req.on("end", async () => {
    const corpoBin = Buffer.concat(partes);
    const m = String(req.headers["content-type"] || "").match(/boundary=(?:"([^"]+)"|([^;]+))/);
    const fronteira = Buffer.from("--" + (m ? (m[1] || m[2]) : ""));
    let plano = null;
    const arquivos = [];
    let pos = corpoBin.indexOf(fronteira);
    while (pos >= 0) {
      const ini = pos + fronteira.length + 2;
      const fim = corpoBin.indexOf(fronteira, ini);
      if (fim < 0) break;
      const parte = corpoBin.slice(ini, fim - 2);
      const sep = parte.indexOf("\r\n\r\n");
      if (sep > 0) {
        const cab = parte.slice(0, sep).toString("utf8");
        const conteudo = parte.slice(sep + 4);
        const nome = (cab.match(/name="([^"]*)"/) || [])[1];
        const arquivo = (cab.match(/filename="([^"]*)"/) || [])[1];
        if (arquivo !== undefined) {
          arquivos.push({ campo: nome, nome: arquivo, tipo: ((cab.match(/Content-Type:\s*([^\r\n]+)/i) || [])[1] || "").trim(), bytes: conteudo.length });
        } else if (nome === "plano") {
          plano = JSON.parse(conteudo.toString("utf8"));
        }
      }
      pos = fim;
    }
    fotosChamadas.push({ url: u.pathname + u.search, plano, arquivos });
    if (fotosAtrasoMs) await sleep(fotosAtrasoMs);
    const resposta = fotosResultado || { status: 200, corpo: null };
    res.writeHead(resposta.status, Object.assign({ "content-type": "application/json" }, cors));
    if (resposta.corpo) { res.end(JSON.stringify(resposta.corpo)); return; }
    const base = anuncio(u.searchParams.get("clienteContaId") || "42");
    base.variations_count = variationsCountAtivo;
    res.end(JSON.stringify({ ok: true, anuncio: base, fotos: null, confirmacaoPendente: false, novas: [] }));
  });
}
async function waitChrome(port) {
  for (let i = 0; i < 200; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) return; } catch (_) { /* aguardando */ }
    await sleep(50);
  }
  throw new Error("Chrome DevTools não iniciou.");
}

class Cdp {
  constructor(url) { this.socket = new WebSocket(url); this.nextId = 1; this.pending = new Map(); this.onEvent = null; }
  async open() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const m = JSON.parse(event.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
        return;
      }
      if (m.method && this.onEvent) this.onEvent(m.method, m.params);
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Falha na avaliação do navegador");
    return result.result.value;
  }
  close() { this.socket.close(); }
}

async function waitFor(cdp, expression, message) {
  for (let i = 0; i < 200; i++) {
    let ok = false;
    try { ok = await cdp.evaluate(`Boolean(${expression})`); } catch (_) { ok = false; }
    if (ok) return;
    await sleep(50);
  }
  throw new Error(message || `Timeout: ${expression}`);
}

async function esperarPedido(padrao, desde, mensagem) {
  for (let i = 0; i < 200; i++) {
    if (pedidos.slice(desde).some((u) => padrao.test(u))) return pedidos.slice(desde).filter((u) => padrao.test(u));
    await sleep(50);
  }
  throw new Error(mensagem || `Nenhuma requisição casou ${padrao}. Vistas: ${JSON.stringify(pedidos.slice(desde))}`);
}

let checks = 0;
async function check(name, fn) {
  await fn();
  checks += 1;
  console.log(`ok ${checks} - ${name}`);
}

// Texto visível do modal + o VALOR atual dos campos editáveis: título e
// modelo moram em inputs (inclusive na coluna "Atual" da comparação com a
// IA), cujo valor não entra no innerText.
function textoModal(cdp) {
  return cdp.evaluate(`(function(){
    var m = document.querySelector('.am-det-modal');
    if (!m) return '';
    var valores = Array.prototype.map.call(m.querySelectorAll('input, textarea'), function (e) { return e.value; });
    return m.innerText + ' | ' + valores.join(' | ');
  })()`);
}

async function clicar(cdp, seletor, mensagem) {
  const ok = await cdp.evaluate(`(function(){ var e = document.querySelector(${JSON.stringify(seletor)}); if(!e) return false; e.click(); return true; })()`);
  assert.ok(ok, mensagem || `não achei ${seletor} para clicar`);
}

async function digitar(cdp, seletor, valor) {
  await cdp.evaluate(`(function(){
    var e = document.querySelector(${JSON.stringify(seletor)});
    e.value = ${JSON.stringify(valor)};
    e.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
}

// Custo do produto/Custos adicionais (simulação) só confirmam no Enter —
// sair do campo CANCELA (mesma regra do estoque da lista). `digitar` sozinho
// não basta: precisa do keydown real. Preço NÃO usa mais esse caminho —
// tem botão próprio, ver salvarPreco/abrirEdicaoPreco abaixo.
async function digitarEConfirmar(cdp, seletor, valor) {
  await cdp.evaluate(`(function(){
    var e = document.querySelector(${JSON.stringify(seletor)});
    e.value = ${JSON.stringify(valor)};
    e.dispatchEvent(new Event('input', { bubbles: true }));
    e.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  })()`);
}

async function abrirEdicaoMargem(cdp, campo) {
  await clicar(cdp, `#am-det-margem-body [data-margem-campo="${campo}"] .am-margem-edit__btn`,
    `botão de editar "${campo}" não encontrado na composição`);
  await waitFor(cdp, `document.querySelector('#am-det-margem-body [data-margem-campo="${campo}"] .am-margem-edit__input')`,
    `o input de edição de "${campo}" não apareceu`);
}

async function confirmarEdicaoMargem(cdp, campo, valor) {
  await abrirEdicaoMargem(cdp, campo);
  await digitarEConfirmar(cdp, `#am-det-margem-body [data-margem-campo="${campo}"] .am-margem-edit__input`, valor);
}

// Preço da composição: hoje é só mais um campo de simulação
// ([data-margem-campo="preco"], sem data-promo-key) — usar
// abrirEdicaoMargem/confirmarEdicaoMargem("preco", ...) direto. A escrita
// real só acontece via "Aplicar preço" + diálogo de confirmação, abaixo.
async function clicarAplicarPreco(cdp) {
  await clicar(cdp, '#am-det-margem-body [data-acao="aplicar-preco"]',
    "botão \"Aplicar preço no Mercado Livre\" não encontrado");
}

// Diálogo de confirmação (preço da composição OU promoção) — mesmo overlay
// pros dois casos, ver abrirConfirmacaoEscrita em anuncios-meli.js.
async function lerLinhasDialogoEscrita(cdp) {
  await waitFor(cdp, "document.querySelector('.am-confirm-overlay')", "o diálogo de confirmação não abriu");
  return cdp.evaluate(`Array.from(document.querySelectorAll('.am-confirm__linha')).map(function(e){
    return { rotulo: e.querySelector('.am-confirm__rotulo').textContent.trim(), valor: e.querySelector('.am-confirm__valor').textContent.trim() };
  })`);
}

async function confirmarDialogoEscrita(cdp) {
  await clicar(cdp, '.am-confirm-overlay [data-acao="confirm-ok"]', "botão \"Confirmar\" do diálogo não encontrado");
}

async function cancelarDialogoEscrita(cdp) {
  await clicar(cdp, '.am-confirm-overlay [data-acao="confirm-cancelar"]', "botão \"Cancelar\" do diálogo não encontrado");
  await waitFor(cdp, "!document.querySelector('.am-confirm-overlay')", "o diálogo de confirmação não fechou ao cancelar");
}

// Promoções disponíveis: célula "Preço final" reaproveita a MESMA moldura de
// edição da composição (.am-margem-edit), só que com data-promo-key extra —
// os helpers abaixo só trocam o seletor, a mecânica é idêntica a
// abrirEdicaoMargem/confirmarEdicaoMargem. `promoChave` é sempre "id::tipo"
// (ver função chave() acima), nunca só o id.
async function abrirEdicaoPromoPreco(cdp, promoChave) {
  await clicar(cdp, `.am-promo__linha[data-promo-key="${promoChave}"] .am-promo__preco .am-margem-edit__btn`,
    `botão de editar o preço final da promoção ${promoChave} não encontrado`);
  await waitFor(cdp, `document.querySelector('.am-promo__linha[data-promo-key="${promoChave}"] .am-promo__preco .am-margem-edit__input')`,
    `o input de edição do preço final da promoção ${promoChave} não apareceu`);
}

async function confirmarEdicaoPromoPreco(cdp, promoChave, valor) {
  await abrirEdicaoPromoPreco(cdp, promoChave);
  await digitarEConfirmar(cdp, `.am-promo__linha[data-promo-key="${promoChave}"] .am-promo__preco .am-margem-edit__input`, valor);
}

// A tela tem UMA lista: anúncio agrupado e anúncio individual são linhas da
// mesma listagem, sem aba. Havia aqui um passo extra para trocar da aba
// "Famílias" para a aba "Sem agrupamento" antes de achar uma linha; o
// seletor de modo não existe mais. O modal aberto pela linha de MLB dentro
// de um agrupador é o mesmo e está em anuncios-meli-listagem-unificada-ui.test.js.
async function esperarLista(cdp) {
  // Esperar o Shell liberar a tela: logo depois de um Page.navigate a
  // consulta cairia no documento anterior.
  await waitFor(cdp, "document.querySelector('.vf-shell__sidebar')", "Shell V3 não montou");
  await waitFor(cdp, "document.getElementById('vf-shell-main').hidden === false", "gating de conta não liberou a tela");
  await waitFor(cdp, "document.querySelector('.am-row')", "a lista não renderizou nenhuma linha");
}

async function abrirPrimeiroAnuncio(cdp) {
  await esperarLista(cdp);
  await clicar(cdp, ".am-row");
  await waitFor(cdp, "document.querySelector('.am-det-modal')", "o modal de detalhe não abriu");
  await waitFor(cdp, "document.getElementById('am-det-titulo')", "o modal não terminou de carregar o detalhe");
}

// Texto de cada linha da composição, SEM o tooltip do vf-info-dot (a linha
// do Imposto tem um selo de explicação cujo texto vive num <span> sempre no
// DOM — só escondido por CSS até o hover; ler .textContent puro contaminaria
// a asserção com esse texto). Clona antes de remover, então a página real
// não perde o tooltip.
async function lerLinhasComposicao(cdp) {
  return cdp.evaluate(`Array.from(document.querySelectorAll('#am-det-margem-body .am-margem-comp__linha')).map(function(e){
    var rotulo = e.querySelector('.am-margem-comp__rotulo').cloneNode(true);
    rotulo.querySelectorAll('.vf-info__tip').forEach(function(t){ t.remove(); });
    var valor = e.querySelector('.am-margem-comp__valor').textContent.trim();
    return rotulo.textContent.replace(/\\s+/g, ' ').trim() + ' ' + valor;
  })`);
}

async function fecharModal(cdp) {
  await cdp.evaluate(`(function(){
    var b = document.querySelector('.am-det-modal [data-acao="descartar-e-fechar"]');
    if (b) { b.click(); return; }
    var f = document.querySelector('.am-det-close'); if (f) f.click();
    var d = document.querySelector('.am-det-modal [data-acao="descartar-e-fechar"]'); if (d) d.click();
    // Rascunho de fotos pendente: o fechar pede decisão — descarta.
    var pf = document.querySelector('.am-det-modal [data-acao="foto-pendente-descartar"]'); if (pf) pf.click();
  })()`);
  await waitFor(cdp, "!document.querySelector('.am-det-modal')", "o modal não fechou");
}

function wireInterception(cdp) {
  const excecoes = [];
  const respond = async (m, p) => {
    try { await cdp.send(m, p); } catch (err) { if (!/Invalid InterceptionId/.test(err.message || "")) throw err; }
  };
  cdp.onEvent = async (method, params) => {
    if (method === "Runtime.exceptionThrown") {
      excecoes.push(`${params?.exceptionDetails?.text || ""} ${params?.exceptionDetails?.exception?.description || ""}`.trim());
    }
    if (method !== "Fetch.requestPaused") return;
    const url = params.request.url;
    if (!url.includes(PROD_HOST)) { await respond("Fetch.continueRequest", { requestId: params.requestId }); return; }
    const cors = [
      { name: "access-control-allow-origin", value: "*" },
      { name: "access-control-allow-headers", value: "authorization,content-type" },
      { name: "access-control-allow-methods", value: "GET,POST,PATCH,PUT,OPTIONS" },
    ];
    if (params.request.method === "OPTIONS") { await respond("Fetch.fulfillRequest", { requestId: params.requestId, responseCode: 204, responseHeaders: cors }); return; }
    const corpo = (obj, code) => respond("Fetch.fulfillRequest", {
      requestId: params.requestId, responseCode: code || 200,
      responseHeaders: [...cors, { name: "content-type", value: "application/json" }],
      body: Buffer.from(JSON.stringify(obj)).toString("base64"),
    });

    const caminho = url.replace(`https://${PROD_HOST}`, "");
    pedidos.push(caminho);
    let body = null;
    if (params.request.postData) {
      try { body = JSON.parse(params.request.postData); } catch (_) { body = params.request.postData; }
      corpos.push({ url: caminho, metodo: params.request.method, body });
    }

    if (url.includes("/me/context")) { await corpo(ME_CONTEXT); return; }
    if (url.includes("/operacao/cliente-360/clientes")) { await corpo({ ok: true, clientes: [N97] }); return; }
    if (/\/clientes\/[^/?]+\/contas/.test(url)) { await corpo({ ok: true, cliente: N97, contas: N97_CONTAS }); return; }

    if (url.includes("/anuncios-meli/clientes")) {
      await corpo({ ok: true, clientes: [{ id: 87, nome: "N97 Comercial", slug: "n97", mlConectado: true, totalAnuncios: 2 }] });
      return;
    }
    if (url.includes("/anuncios-meli/resumo")) {
      await corpo({ ok: true, resumo: { total: 2, ativos: 2, ultimaSync: new Date().toISOString() } });
      return;
    }

    // A LISTA da tela. GET /anuncios-meli/familias devolve a listagem
    // unificada: cada linha é um agrupador (tipo "familia") ou o próprio
    // anúncio (tipo "item"). Aqui só interessa o anúncio individual — o
    // agrupador tem arquivo próprio (anuncios-meli-listagem-unificada-ui.test.js).
    // Precisa vir ANTES do matcher genérico de detalhe, senão /familias
    // receberia um anúncio como resposta.
    if (caminho.startsWith("/anuncios-meli/familias")) {
      const conta = new URL(url).searchParams.get("clienteContaId") || "42";
      const a = anuncio(conta);
      await corpo({
        ok: true, cliente: { slug: "n97", nome: "N97 Comercial" },
        anuncios: [Object.assign({}, a, {
          tipo: "item", key: "item:" + a.item_id, family_id: null,
          total_itens: 1, total_user_products: 0,
          estoque_total: a.estoque, vendidos_total: a.vendidos,
        })],
        paginacao: { page: 1, limit: 20, total: 1, totalPaginas: 1 },
      });
      return;
    }

    // GET /anuncios-meli/performance — precisa vir ANTES do matcher genérico
    // de detalhe (mDetalhe, abaixo), senão "performance" seria lido como um
    // itemId. Só a seção "Composição da margem" do modal chama isto.
    if (caminho.startsWith("/anuncios-meli/performance")) {
      const qs = new URL(url).searchParams;
      const idsPedidos = (qs.get("itemIds") || "").split(",").filter(Boolean);
      const incluirMetricas = qs.get("incluirMetricas") !== "0";
      const incluirMargem = qs.get("incluirMargem") !== "0";
      const incluirComposicao = qs.get("incluirComposicao") === "1";
      chamadasPerformance.push({ itemIds: idsPedidos, incluirMetricas, incluirMargem, incluirComposicao });
      if (performanceHandler) { await corpo(performanceHandler(idsPedidos, { incluirMetricas, incluirMargem, incluirComposicao })); return; }

      const metricas7d = {};
      const margem = {};
      const composicao = {};
      idsPedidos.forEach((id) => {
        if (incluirMetricas) metricas7d[id] = { views: 10, vendas: 1, conversao: 10 };
        // precoOriginal segue o MESMO toggle do corpo do item (precoOriginalAtivo)
        // — sem isso, o preço cheio ao vivo (agora a mesma fonte do cabeçalho,
        // ver Portal/anuncios-meli.js precoDetalheHtml) ficaria dessincronizado
        // do snapshot que o mock do item devolve.
        if (incluirMargem) margem[id] = id === "MLB-A1"
          ? Object.assign({}, MARGEM_MLA1, { precoOriginal: precoOriginalAtivo ? 249.9 : null })
          : { origem: "projected", margin: 0.2, marginPercent: 20, profit: 30, status: "HEALTHY", statusLabel: "Saudável", statusReasons: [] };
        if (incluirComposicao) composicao[id] = id === "MLB-A1" ? COMPOSICAO_MLA1 : { venda: 150, custoProduto: 60, comissaoMl: 18, frete: 12, taxaFixa: 3, impostoPercentual: 0.04, impostoValor: 6 };
      });
      await corpo({ ok: true, metricas7d, margem, margemIndisponivel: null, composicao });
      return;
    }

    // PATCH /anuncios-meli/:itemId/conteudo — a escrita real no ML
    const mConteudo = caminho.match(/\/anuncios-meli\/([^/?]+)\/conteudo/);
    if (mConteudo) {
      if (conteudoResultado) { await corpo(conteudoResultado.corpo, conteudoResultado.status); return; }
      const conta = String((body && body.clienteContaId) || "42");
      const base = anuncio(conta);
      const resultados = {};
      ["titulo", "modelo", "descricao"].forEach((c) => {
        if (body && body[c] !== undefined) { resultados[c] = { ok: true }; if (c !== "descricao") base[c] = body[c]; }
      });
      // Espelha o contrato real: a descrição só volta quando ela mudou.
      const resposta = { ok: true, resultados, anuncio: base };
      if (body && body.descricao !== undefined) {
        resposta.descricao = body.descricao;
        resposta.descricaoEstado = "ok";
        resposta.descricaoErro = null;
      }
      await corpo(resposta);
      return;
    }

    // POST /anuncios-meli/:itemId/imagens — adicionar imagem (multipart).
    // O corpo binário não interessa aqui (o backend tem teste próprio:
    // server/tests/meliAnunciosImagens.test.js); só a rota, o método, a query
    // e o tipo multipart.
    // GET /anuncios-meli/:itemId/imagens/variacoes — grupos de foto (anúncio
    // com variações). Contrato: server/tests/meliAnunciosImagensVariacoes.test.js.
    if (/^\/anuncios-meli\/[^/?]+\/imagens\/variacoes(\?|$)/.test(caminho)) {
      imagemGruposChamadas += 1;
      if (imagemGruposResultado) { await corpo(imagemGruposResultado.corpo, imagemGruposResultado.status); return; }
      await corpo(GRUPOS_IMAGEM);
      return;
    }

    // GET /anuncios-meli/:itemId/fotos/variacoes — leitura do editor de fotos.
    // Contrato: server/tests/meliAnunciosFotosHttp.test.js.
    if (/^\/anuncios-meli\/[^/?]+\/fotos\/variacoes(\?|$)/.test(caminho)) {
      fotosLeituraChamadas += 1;
      if (fotosLeituraAtrasoMs) await sleep(fotosLeituraAtrasoMs);
      if (fotosLeituraResultado) { await corpo(fotosLeituraResultado.corpo, fotosLeituraResultado.status); return; }
      await corpo(leituraFotos());
      return;
    }
    // PUT /anuncios-meli/:itemId/fotos — escrita do editor. Nesta etapa (só
    // leitura) nenhuma chamada pode chegar aqui.
    if (/^\/anuncios-meli\/[^/?]+\/fotos(\?|$)/.test(caminho)) {
      fotosEscritas.push({ url: caminho, metodo: params.request.method });
      const qs = caminho.slice(caminho.indexOf("/fotos") + "/fotos".length);
      await respond("Fetch.continueRequest", { requestId: params.requestId, url: `http://127.0.0.1:${portaLocal}/__fotos${qs}` });
      return;
    }

    const mImagem = caminho.match(/^\/anuncios-meli\/([^/?]+)\/imagens(\?|$)/);
    if (mImagem) {
      const hs = params.request.headers || {};
      imagemChamadas.push({
        url: caminho, metodo: params.request.method,
        contentType: hs["Content-Type"] || hs["content-type"] || "",
      });
      if (imagemViaRede) {
        const qs = caminho.slice(caminho.indexOf("/imagens") + "/imagens".length);
        await respond("Fetch.continueRequest", { requestId: params.requestId, url: `http://127.0.0.1:${portaLocal}/__imagens${qs}` });
        return;
      }
      if (imagemAtrasoMs) await sleep(imagemAtrasoMs);
      if (imagemResultado) { await corpo(imagemResultado.corpo, imagemResultado.status); return; }
      const conta = new URL(url).searchParams.get("clienteContaId") || "42";
      const base = anuncio(conta);
      base.variations_count = variationsCountAtivo; // a linha real volta com a coluna do sync
      base.pictures_json = base.pictures_json.concat(["https://img.example/nova.jpg"]);
      base.pictures_count = base.pictures_json.length;
      const grupoQs = new URL(url).searchParams.get("grupoVariacao");
      const grupoEnv = grupoQs ? GRUPOS_IMAGEM.grupos.find((g) => g.chave === grupoQs) : null;
      await corpo({ ok: true, pictureId: "999-MLB", anuncio: base, confirmacaoPendente: false,
        imagem: { width: 600, height: 400, bytes: 1234, abaixoDoMinimoMl: true },
        grupo: grupoEnv ? { chave: grupoEnv.chave, valor: grupoEnv.valor, atributo: "Cor", variacoes: grupoEnv.variacoes.length } : null });
      return;
    }

    if (/\/anuncios-meli\/[^/?]+\/revisao/.test(caminho)) { await corpo({ ok: true, revisado: !!(body && body.revisado) }); return; }

    // POST /anuncios-meli/:itemId/seo/titulos — Title Engine. Contrato:
    // server/tests/tituloSeoHttp.test.js e server/tests/tituloEngine.test.js.
    if (/^\/anuncios-meli\/[^/?]+\/seo\/titulos(\?|$)/.test(caminho)) {
      const itemId = caminho.match(/^\/anuncios-meli\/([^/?]+)\/seo/)[1];
      titulosChamadas.push({ itemId, body });
      if (iaProibida) { await corpo({ ok: false, motivo: "Acesso restrito." }, 403); return; }
      if (titulosAtrasoMs) await sleep(titulosAtrasoMs);
      const r = titulosHandler
        ? titulosHandler(itemId, body)
        : { status: 200, corpo: { ok: true, limite: 60, sugestoes: SUG_TITULOS, recebidos: 8, descartadas: 2, motivosDescarte: { NAO_COMPROVADO: 2 } } };
      await corpo(r.corpo, r.status);
      return;
    }

    // POST /anuncios-meli/:itemId/seo/descricao — Description Engine. Contrato:
    // server/tests/descricaoSeoHttp.test.js e server/tests/descricaoEngine.test.js.
    if (/^\/anuncios-meli\/[^/?]+\/seo\/descricao(\?|$)/.test(caminho)) {
      const itemId = caminho.match(/^\/anuncios-meli\/([^/?]+)\/seo/)[1];
      descricaoSeoChamadas.push({ itemId, body });
      if (iaProibida) { await corpo({ ok: false, motivo: "Acesso restrito." }, 403); return; }
      if (descricaoSeoAtrasoMs) await sleep(descricaoSeoAtrasoMs);
      const r = descricaoSeoHandler
        ? descricaoSeoHandler(itemId, body)
        : { status: 200, corpo: { ok: true, descricao: SUG_DESC_A, chars: SUG_DESC_A.length, limite: 2500,
          fatosUsados: [{ id: "brand", label: "Marca", value: "Prime" }, { id: "attr:BATTERY", label: "Duração da bateria", value: "30 h" }] } };
      await corpo(r.corpo, r.status);
      return;
    }

    // Sentinela F4R: o Modelo não tem mais geração (POST /seo/modelo saiu) e os
    // Termos Complementares ainda não têm UI. Qualquer chamada fica registrada
    // e o teste 45e exige zero.
    if (/^\/anuncios-meli\/[^/?]+\/seo\/(modelo|termos-complementares)(\?|$)/.test(caminho)) {
      seoModeloOuTermosChamadas.push({ caminho, body });
      await corpo({ ok: false, motivo: "Rota fora do contrato do front." }, 404);
      return;
    }

    if (/\/anuncios-meli\/[^/?]+\/otimizacoes/.test(caminho)) {
      if (iaProibida) { await corpo({ ok: false, motivo: "Acesso restrito." }, 403); return; }
      const itemId = caminho.match(/\/anuncios-meli\/([^/?]+)\/otimizacoes/)[1];
      await corpo({ ok: true, otimizacoes: itemId === "MLB-A1" ? OTIMIZACOES_A : [] });
      return;
    }

    if (/\/anuncios-meli\/[^/?]+\/otimizar/.test(caminho)) {
      if (iaProibida) { await corpo({ ok: false, motivo: "Acesso restrito." }, 403); return; }
      const tipo = (body && body.tipo) || "seo";
      await corpo({ ok: true, tipo, otimizacao: OTIMIZACOES_A.find((o) => o.tipo === tipo) });
      return;
    }

    if (/\/anuncios-meli\/otimizacoes\/\d+\/aprovar/.test(caminho)) {
      const id = Number(caminho.match(/otimizacoes\/(\d+)\/aprovar/)[1]);
      const base = OTIMIZACOES_A.find((o) => o.id === id) || OTIMIZACOES_A[0];
      await corpo({ ok: true, otimizacao: { ...base, status: "aprovado", aprovado_at: "2026-09-12T09:14:00Z" } });
      return;
    }

    // PATCH /anuncios-meli/:itemId/preco — escrita REAL de preço (API dedicada
    // de Preços do ML por baixo, ver meliPrecoService). O resultado devolvido
    // aqui NUNCA precisa ser o valor enviado — o service real relê do ML antes
    // de responder, e é isso que `precoResultado` simula quando setado.
    const mPreco = caminho.match(/\/anuncios-meli\/([^/?]+)\/preco$/);
    if (mPreco) {
      precoChamadas.push({ itemId: mPreco[1], body });
      if (precoResultado) { await corpo(precoResultado.corpo, precoResultado.status); return; }
      await corpo({ ok: true, preco: (body && body.preco) || 0, moeda: "BRL" });
      return;
    }

    // POST /anuncios-meli/:itemId/simular-margem — simulação pura de
    // custo/custos adicionais (nunca escreve no ML, nunca grava na Base).
    const mSimular = caminho.match(/\/anuncios-meli\/([^/?]+)\/simular-margem$/);
    if (mSimular) {
      simularMargemChamadas.push({ itemId: mSimular[1], body });
      if (simularMargemHandler) { await corpo(simularMargemHandler(mSimular[1], body)); return; }
      await corpo({
        ok: true, simulado: true, origem: "projected",
        resultado: { computable: true, profit: 99, margin: 0.33, marginPercent: 33, missing: [], assumed: [] },
      });
      return;
    }

    // POST /anuncios-meli/:itemId/promocoes/:promotionId/aplicar — escrita
    // real de participação/alteração. Precisa vir ANTES do matcher genérico
    // de GET /promocoes logo abaixo, senão a URL cairia nele por engano.
    const mAplicarPromocao = caminho.match(/^\/anuncios-meli\/([^/?]+)\/promocoes\/([^/?]+)\/aplicar$/);
    if (mAplicarPromocao) {
      aplicarPromocaoChamadas.push({ itemId: mAplicarPromocao[1], promotionId: mAplicarPromocao[2], body });
      if (aplicarPromocaoResultado) { await corpo(aplicarPromocaoResultado.corpo, aplicarPromocaoResultado.status); return; }
      await corpo({
        ok: true, metodo: "POST", promotionId: mAplicarPromocao[2], tipo: "DEAL",
        precoConfirmado: (body && body.precoNovo) || 0, precoOriginal: 249.9,
      });
      return;
    }

    // GET /anuncios-meli/:itemId/promocoes — precisa vir ANTES do matcher
    // genérico de detalhe (mDetalhe, abaixo), senão "promocoes" seria lido
    // como querystring de um itemId.
    const mPromocoes = caminho.match(/^\/anuncios-meli\/([^/?]+)\/promocoes/);
    if (mPromocoes) {
      promocoesChamadas.push(mPromocoes[1]);
      await corpo({ ok: true, itemId: mPromocoes[1], promocoes: promocoesRespostaPadrao });
      return;
    }

    // GET /anuncios-meli/:itemId (detalhe)
    const mDetalhe = caminho.match(/^\/anuncios-meli\/([^/?]+)(\?|$)/);
    if (mDetalhe && mDetalhe[1] !== "") {
      const itemId = mDetalhe[1];
      const atraso = detalheAtrasoPorItem[itemId];
      if (atraso) await sleep(atraso);
      const conta = new URL(url).searchParams.get("clienteContaId") || "42";
      const base = anuncio(conta);
      base.item_id = itemId;
      base.titulo = itemId === "MLB-B1" ? TITULO_B : TITULO_A;
      base.variations_count = variationsCountAtivo;
      const resposta = {
        ok: true, cliente: { slug: "n97", nome: "N97 Comercial" }, anuncio: base,
        descricao: descricaoEstado === "ok" ? DESC_A : null,
        descricaoEstado,
        descricaoErro: descricaoEstado === "erro" ? "O Mercado Livre não devolveu a descrição (HTTP 500)." : null,
        categoriaNome: categoriaNomeResposta,
      };
      await corpo(resposta);
      return;
    }

    if (url.includes("/anuncios-meli")) {
      const conta = new URL(url).searchParams.get("clienteContaId") || "42";
      const a = anuncio(conta);
      await corpo({ ok: true, anuncios: [a], paginacao: { page: 1, limit: 24, total: 1, totalPaginas: 1 } });
      return;
    }

    await respond("Fetch.failRequest", { requestId: params.requestId, errorReason: "ConnectionRefused" });
  };
  return excecoes;
}

async function run() {
  const server = await startServer();
  const porta = server.address().port;
  portaLocal = porta;
  const debugPort = 22000 + Math.floor(Math.random() * 900);
  const chrome = childProcess.spawn("google-chrome", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--window-size=1440,900",
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=/tmp/vf-det-modal-${process.pid}`, "about:blank",
  ], { stdio: "ignore" });

  let cdp;
  try {
    await waitChrome(debugPort);
    const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT" })).json();
    cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: SEMENTE });
    const excecoes = wireInterception(cdp);
    // Runtime.exceptionThrown não vê promise rejeitada dentro de um .then() —
    // e é exatamente ali que o render do modal vive. Sem esta rede, um erro
    // de JS aparece só como "o modal não carregou".
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `
        window.__erros = [];
        addEventListener("error", function (e) {
          window.__erros.push(String(e.message) + " @ " + e.filename + ":" + e.lineno);
        });
        addEventListener("unhandledrejection", function (e) {
          window.__erros.push("rejeição: " + String((e.reason && e.reason.stack) || e.reason));
        });
      `,
    });

    pedidos.length = 0;
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${porta}/anuncios-meli.html?cliente=n97&conta=42` });
    await waitFor(cdp, "document.querySelector('.vf-shell__sidebar')", "Shell V3 não montou");
    await waitFor(cdp, "document.getElementById('vf-shell-main').hidden === false", "gating de conta não liberou a tela");

    /* ── 1 a 4: a estrutura nova substituiu a antiga ───────────────────── */

    await check("1 — clicar numa linha do catálogo abre o NOVO modal central", async () => {
      await abrirPrimeiroAnuncio(cdp);
      const m = await cdp.evaluate(`(function(){
        var e = document.querySelector('.am-det-modal'); var r = e.getBoundingClientRect();
        return { role: e.getAttribute('role'), modal: e.getAttribute('aria-modal'),
                 largura: Math.round(r.width), esquerda: Math.round(r.left), direita: Math.round(window.innerWidth - r.right) }; })()`);
      assert.strictEqual(m.role, "dialog");
      assert.strictEqual(m.modal, "true");
      // Centralizado: a folga à esquerda e à direita é a mesma (é modal, não drawer ancorado).
      assert.ok(Math.abs(m.esquerda - m.direita) <= 2, `modal não está centralizado: ${m.esquerda} vs ${m.direita}`);
    });

    await check("2 — o drawer antigo não é usado (nem escondido por baixo)", async () => {
      const n = await cdp.evaluate("document.querySelectorAll('.am-drawer, #am-drawer, .vf-drawer, #am-drawer-body, #am-modal-overlay').length");
      assert.strictEqual(n, 0, "sobrou estrutura do drawer no DOM");
    });

    await check("3 — as cinco abas antigas não existem", async () => {
      const n = await cdp.evaluate("document.querySelectorAll('.am-tab, .am-tabs, .am-tab-panel, [role=\"tablist\"], #am-tab-ia, #am-tab-geral, #am-tab-ficha, #am-tab-fotos, #am-tab-desc').length");
      assert.strictEqual(n, 0, "sobrou estrutura de abas no DOM");
      const rolagem = await cdp.evaluate(`(function(){ var s = document.getElementById('am-det-scroll');
        return { overflow: getComputedStyle(s).overflowY, rolavel: s.scrollHeight > s.clientHeight }; })()`);
      assert.strictEqual(rolagem.overflow, "auto", "a superfície única precisa rolar verticalmente");
      assert.ok(rolagem.rolavel, "o conteúdo deveria exceder a altura do modal e rolar");
    });

    await check("4 — o conteúdo essencial das 5 abas antigas está na mesma superfície", async () => {
      const t = await textoModal(cdp);
      const esperado = [
        TITULO_A, "MLB-A1", "FN-X200-PRT", "Ativo",           // identidade
        "R$ 189,90", "R$ 249,90", "42", "187",                 // comercial
        "Prime Audio", "X200", "Celulares e Smartphones", "Clássico · Full", // catálogo
        "Score VenForce", "61", "Principal ponto",             // qualidade
        "Fotos", "Recomendado ter pelo menos 3 fotos",         // fotos
        "Descrição", "Ficha técnica", "Garantia do fabricante", "Vazio",
        "Sugestão da IA", "Sugestões da IA", "Gerar títulos",  // otimização IA
        "Abrir no Mercado Livre", "Marcar como revisado",      // ações
      ];
      // innerText já vem com o text-transform aplicado (os rótulos do canva
      // são caixa alta), então a comparação ignora caixa.
      const alvo = t.toLowerCase();
      esperado.forEach((frag) => assert.ok(alvo.includes(frag.toLowerCase()), `sumiu do detalhe: "${frag}"`));
    });

    await check("4f — Fotos ocupam a largura do modal: a grade não fica presa a 4 colunas estreitas", async () => {
      const g = await cdp.evaluate(`(function(){
        var grade = document.querySelector('.am-det-photos');
        var secao = grade.closest('.am-det-section');
        return {
          colunas: getComputedStyle(grade).gridTemplateColumns.split(' ').length,
          larguraGrade: grade.getBoundingClientRect().width,
          larguraSecao: secao.getBoundingClientRect().width,
          maxWidth: getComputedStyle(grade).maxWidth,
        }; })()`);
      assert.strictEqual(g.maxWidth, "none", "a grade de fotos não pode ter teto de largura");
      assert.ok(g.larguraGrade >= g.larguraSecao - 1, `a grade (${g.larguraGrade}px) precisa ocupar a seção (${g.larguraSecao}px)`);
      assert.ok(g.colunas >= 6, `na janela de 1440px cabem pelo menos 6 colunas de fotos (achei ${g.colunas})`);
    });

    await check("4a — preço original aparece riscado quando há promoção; some quando não há", async () => {
      const comPromo = await cdp.evaluate("document.querySelector('.am-det-price small')");
      assert.ok(comPromo, "com preco_original truthy, o preço original deveria aparecer riscado");
      const textoComPromo = await cdp.evaluate("document.querySelector('.am-det-price').innerText");
      assert.ok(/249,90/.test(textoComPromo), `preço original ausente: ${textoComPromo}`);
      assert.strictEqual(
        await cdp.evaluate("getComputedStyle(document.querySelector('.am-det-price small')).textDecorationLine"),
        "line-through", "o preço original precisa aparecer riscado"
      );

      // Mesmo anúncio, agora sem promoção — a linha não deve aparecer. Recarrega
      // a página (não só fecha/reabre o modal): o preço cheio do cabeçalho
      // agora também é cacheado ao vivo por item_id (mesma fonte da lista,
      // ver Portal/anuncios-meli.js precoDetalheHtml/AM.state.performanceCache)
      // — sem reload, o valor da chamada anterior continuaria em cache.
      await fecharModal(cdp);
      precoOriginalAtivo = false;
      await cdp.send("Page.navigate", { url: `http://127.0.0.1:${porta}/anuncios-meli.html?cliente=n97&conta=42` });
      await abrirPrimeiroAnuncio(cdp);
      const semPromoElemento = await cdp.evaluate("document.querySelector('.am-det-price small')");
      assert.strictEqual(semPromoElemento, null, "sem preco_original, nada de preço riscado deveria aparecer");
      const textoSemPromo = await cdp.evaluate("document.querySelector('.am-det-price').innerText");
      assert.strictEqual(textoSemPromo, "R$ 189,90", `sobrou algo do preço original: ${textoSemPromo}`);
      precoOriginalAtivo = true;
    });

    await check("4c — preço original ao vivo IGUAL ao atual não é promoção: cabeçalho mostra só o preço atual", async () => {
      // Bug reportado após a auditoria de preço cheio: sale_price.regular_amount
      // pode voltar igual a amount (sem ser mais um desconto) — o código antigo
      // só checava `precoOriginal != null`, então riscava "R$ 189,90" sobre o
      // próprio "R$ 189,90" atual. Precisa existir DIFERENÇA real (cheio > atual).
      performanceHandler = (ids) => {
        const margem = {};
        ids.forEach((id) => {
          margem[id] = id === "MLB-A1"
            ? Object.assign({}, MARGEM_MLA1, { precoAtual: 189.9, precoOriginal: 189.9 })
            : { origem: "projected", margin: 0.2, marginPercent: 20, profit: 30, status: "HEALTHY", statusLabel: "Saudável", statusReasons: [] };
        });
        return { ok: true, metricas7d: {}, margem, margemIndisponivel: null, composicao: {} };
      };
      try {
        await fecharModal(cdp);
        await cdp.send("Page.navigate", { url: `http://127.0.0.1:${porta}/anuncios-meli.html?cliente=n97&conta=42` });
        await abrirPrimeiroAnuncio(cdp);
        const semPromoElemento = await cdp.evaluate("document.querySelector('.am-det-price small')");
        assert.strictEqual(semPromoElemento, null, "precoOriginal igual ao precoAtual não é promoção — não pode riscar");
        const texto = await cdp.evaluate("document.querySelector('.am-det-price').innerText");
        assert.strictEqual(texto, "R$ 189,90", `sobrou algo do preço original: ${texto}`);
      } finally {
        performanceHandler = null;
      }
    });

    await check("4b — categoria mostra o nome legível resolvido pelo backend, não o category_id cru", async () => {
      const texto = await cdp.evaluate("document.getElementById('am-det-modelo').closest('.am-det-top2__col').innerText");
      assert.ok(texto.includes("Celulares e Smartphones"), `nome da categoria ausente: ${texto}`);
      assert.ok(!texto.includes("MLB1055"), `o category_id cru vazou para a tela: ${texto}`);

      // Falha na resolução (categoriaNome null): cai para o category_id, sem quebrar o modal.
      await fecharModal(cdp);
      categoriaNomeResposta = null;
      await abrirPrimeiroAnuncio(cdp);
      const fallback = await cdp.evaluate("document.getElementById('am-det-modelo').closest('.am-det-top2__col').innerText");
      assert.ok(fallback.includes("MLB1055"), `sem nome resolvido, deveria cair para o category_id: ${fallback}`);
      categoriaNomeResposta = "Celulares e Smartphones";
    });

    /* ── 5 a 9: edição, pendência e descarte ──────────────────────────── */

    await check("5 — Título é editável no modal", async () => {
      const info = await cdp.evaluate(`(function(){ var e = document.getElementById('am-det-titulo');
        return { tag: e.tagName, readonly: e.readOnly, disabled: e.disabled, max: e.getAttribute('maxlength'), valor: e.value }; })()`);
      assert.strictEqual(info.tag, "INPUT");
      assert.ok(!info.readonly && !info.disabled, "o título deveria ser editável");
      assert.strictEqual(info.max, "60", "o título precisa respeitar o limite do Mercado Livre");
      assert.strictEqual(info.valor, TITULO_A);
    });

    await check("6 — Modelo é editável no modal", async () => {
      const info = await cdp.evaluate(`(function(){ var e = document.getElementById('am-det-modelo');
        return { tag: e.tagName, readonly: e.readOnly, valor: e.value }; })()`);
      assert.strictEqual(info.tag, "INPUT");
      assert.ok(!info.readonly, "o modelo deveria ser editável");
      assert.strictEqual(info.valor, "X200");
    });

    await check("7 — Descrição é editável no modal", async () => {
      const info = await cdp.evaluate(`(function(){ var e = document.getElementById('am-det-descricao');
        return { tag: e.tagName, readonly: e.readOnly, valor: e.value }; })()`);
      assert.strictEqual(info.tag, "TEXTAREA");
      assert.ok(!info.readonly, "a descrição deveria ser editável");
      assert.strictEqual(info.valor, DESC_A);
    });

    // A doc do ML separa os dois conceitos: catalog_listing identifica a
    // publicação de catálogo (é o único sinal que acende a tag visual);
    // family_name é outro conceito (família/User Products) — não deve ligar
    // a tag, mas o Mercado Livre já demonstrou travar o título por causa dele
    // mesmo assim, então o bloqueio de edição continua olhando os dois.
    async function abrirComModo(modo) {
      await fecharModal(cdp);
      catalogoModo = modo;
      await cdp.send("Page.navigate", { url: `http://127.0.0.1:${porta}/anuncios-meli.html?cliente=n97&conta=42` });
      await esperarLista(cdp);
    }

    await check("7a — catalog_listing=true: tag Catálogo aparece (lista e detalhe) e título fica travado", async () => {
      await abrirComModo("catalog_listing");
      const tagLista = await cdp.evaluate("(document.querySelector('.am-row .vf-tag') || {}).textContent || ''");
      assert.ok(/Catálogo/.test(tagLista), `catalog_listing=true deveria mostrar a tag na lista: "${tagLista}"`);

      await abrirPrimeiroAnuncio(cdp);
      const tituloInfo = await cdp.evaluate(`(function(){ var e = document.getElementById('am-det-titulo');
        return { readonly: e.readOnly, disabled: e.disabled }; })()`);
      assert.ok(tituloInfo.readonly, "título deveria ficar readonly com catalog_listing=true");
      assert.ok(!tituloInfo.disabled, "readonly (não disabled) para continuar selecionável/copiável");

      const texto = await textoModal(cdp);
      assert.ok(/Catálogo/.test(texto), `a tag de catálogo não apareceu no detalhe: ${texto}`);
      assert.ok(/Gerenciado pelo Mercado Livre/.test(texto), `o aviso explicando o motivo não apareceu: ${texto}`);

      const modeloInfo = await cdp.evaluate("document.getElementById('am-det-modelo').readOnly");
      assert.ok(!modeloInfo, "modelo deveria continuar editável");
      const colunaAtual = await cdp.evaluate(`({
        titulo: document.getElementById('am-det-espelho-titulo').readOnly,
        modelo: document.getElementById('am-det-espelho-modelo').readOnly })`);
      assert.ok(colunaAtual.titulo, "a coluna 'Atual' da comparação com a IA obedece à MESMA trava do título");
      assert.ok(!colunaAtual.modelo, "o modelo continua editável também na comparação com a IA");
    });

    await check("7b — family_name sem catalog_listing: NÃO mostra tag Catálogo, mas título continua protegido", async () => {
      await abrirComModo("family_name");
      const semTagLista = await cdp.evaluate("document.querySelector('.am-row .vf-tag.is-primary')");
      assert.strictEqual(semTagLista, null, "family_name sozinho não deveria acender a tag na lista (não é catalog_listing)");

      await abrirPrimeiroAnuncio(cdp);
      const tituloInfo = await cdp.evaluate("document.getElementById('am-det-titulo').readOnly");
      assert.ok(tituloInfo, "título deveria continuar travado por family_name, mesmo sem catalog_listing");

      const texto = await textoModal(cdp);
      assert.ok(!/Catálogo/.test(texto), `a tag "Catálogo" não deveria aparecer no detalhe só com family_name: ${texto}`);
      assert.ok(/Gerenciado pelo Mercado Livre/.test(texto), `o aviso de bloqueio do título deveria continuar aparecendo: ${texto}`);

      const modeloInfo = await cdp.evaluate("document.getElementById('am-det-modelo').readOnly");
      assert.ok(!modeloInfo, "modelo deveria continuar editável");
      const colunaAtual = await cdp.evaluate(`({
        titulo: document.getElementById('am-det-espelho-titulo').readOnly,
        modelo: document.getElementById('am-det-espelho-modelo').readOnly })`);
      assert.ok(colunaAtual.titulo, "a coluna 'Atual' da comparação com a IA obedece à MESMA trava do título");
      assert.ok(!colunaAtual.modelo, "o modelo continua editável também na comparação com a IA");
    });

    await check("7c — sem catalog_listing e sem family_name: anúncio tradicional, nada travado", async () => {
      await abrirComModo("nenhum");
      const semTagLista = await cdp.evaluate("document.querySelector('.am-row .vf-tag.is-primary')");
      assert.strictEqual(semTagLista, null, "sem os dois sinais, a tag não deveria aparecer");

      await abrirPrimeiroAnuncio(cdp);
      const tituloNormal = await cdp.evaluate("document.getElementById('am-det-titulo').readOnly");
      assert.ok(!tituloNormal, "anúncio tradicional não deveria ter o título travado");
      const texto = await textoModal(cdp);
      assert.ok(!/Catálogo/.test(texto), `não deveria sobrar menção a catálogo: ${texto}`);
    });

    await check("7d — anúncio SEM modelo e COM variações: campo Modelo vazio, editável, e entra no salvar", async () => {
      semModeloComVariacoes = true;
      try {
        await abrirComModo("nenhum");
        await abrirPrimeiroAnuncio(cdp);
        const info = await cdp.evaluate(`(function(){ var e = document.getElementById('am-det-modelo');
          return { tag: e.tagName, readonly: e.readOnly, disabled: e.disabled, valor: e.value, ph: e.getAttribute('placeholder') }; })()`);
        assert.strictEqual(info.tag, "INPUT");
        assert.ok(!info.readonly && !info.disabled, "sem modelo (e com variações) o campo continua editável — nenhum bloqueio próprio");
        assert.strictEqual(info.valor, "", "sem MODEL na ficha, o input nasce vazio (nunca 'null')");
        assert.strictEqual(info.ph, "—");
        await digitar(cdp, "#am-det-modelo", "Z10");
        await waitFor(cdp, "document.getElementById('am-det-savebar')", "preencher o modelo não gerou pendência");
        const barra = await cdp.evaluate("document.getElementById('am-det-savebar').innerText");
        assert.ok(/Modelo/.test(barra), `a barra deveria nomear o Modelo: ${barra}`);
        await clicar(cdp, '.am-det-modal [data-acao="descartar"]');
        await waitFor(cdp, "!document.getElementById('am-det-savebar')", "descartar não limpou a pendência");
      } finally {
        semModeloComVariacoes = false;
      }
      // Volta ao estado que o 8 espera (anúncio tradicional aberto, igual ao fim do 7c).
      await abrirComModo("nenhum");
      await abrirPrimeiroAnuncio(cdp);
    });

    /* ── 7e a 7j: editor de fotos por grupo — LEITURA ───────────────────────
       GET /fotos/variacoes. Nesta etapa a tela só lê: nenhuma escrita
       (PUT /fotos) nem upload (POST /imagens) pode acontecer. */

    // Coloca um arquivo no <input type=file> como o seletor do SO faria (usado
    // pelas etapas de edição; mantido aqui para os próximos checks).
    async function escolherArquivo({ png, largura, altura, nome, tipo, texto }) {
      await cdp.evaluate(`(async function(){
        var f;
        if (${JSON.stringify(!!png)}) {
          var c = document.createElement('canvas'); c.width = ${largura || 0}; c.height = ${altura || 0};
          var g = c.getContext('2d'); g.fillStyle = '#c03'; g.fillRect(0, 0, c.width, c.height);
          var blob = await new Promise(function (r) { c.toBlob(r, 'image/png'); });
          f = new File([blob], ${JSON.stringify(nome || "foto.png")}, { type: 'image/png' });
        } else {
          f = new File([${JSON.stringify(texto || "")}], ${JSON.stringify(nome || "x.txt")}, { type: ${JSON.stringify(tipo || "text/plain")} });
        }
        var dt = new DataTransfer(); dt.items.add(f);
        var inp = document.getElementById('am-det-img-input');
        inp.files = dt.files;
        inp.dispatchEvent(new Event('change'));
        return true;
      })()`);
    }
    void escolherArquivo;

    function infoFotos() {
      return cdp.evaluate(`(function(){
        var corpo = document.getElementById('am-det-fotos-corpo');
        var chips = Array.from(document.querySelectorAll('.am-det-fotos__chip'));
        var tiles = Array.from(document.querySelectorAll('#am-det-fotos-corpo .am-det-photo[data-foto]'));
        return {
          existe: !!corpo,
          texto: corpo ? corpo.innerText : '',
          chips: chips.map(function(c){ return c.innerText.replace(/\\s+/g,' ').trim(); }),
          chipAtivo: (chips.find(function(c){ return c.getAttribute('aria-pressed') === 'true'; }) || {}).innerText || '',
          titulo: ((document.querySelector('.am-det-fotos__titulo') || {}).innerText || '').replace(/\\s+/g,' ').trim(),
          ids: tiles.map(function(t){ return t.getAttribute('data-foto'); }),
          srcs: tiles.map(function(t){ return (t.querySelector('img') || {}).src || ''; }),
          selos: Array.from(document.querySelectorAll('#am-det-fotos-corpo .am-det-fotos__selo')).map(function(s){
            return { texto: s.innerText.trim(), foto: s.closest('[data-foto]').getAttribute('data-foto') }; }),
          grade: !!document.querySelector('#am-det-fotos-corpo .am-det-photos'),
          antigoPorCor: !!document.getElementById('am-det-img-var'),
          antigoAdicionar: !!document.getElementById('am-det-img-add'),
        }; })()`);
    }
    const textoFotos = "((document.getElementById('am-det-fotos-corpo') || {}).innerText || '')";
    const escritasAntes = { fotos: fotosEscritas.length, imagens: imagemChamadas.length };

    await check("7e — com variações: 'Carregando', chips por grupo com quantidade, grupo selecionado e só as fotos dele, com a imagem principal marcada", async () => {
      variationsCountAtivo = 3;
      fotosLeituraAtrasoMs = 900;
      try {
        await abrirComModo("nenhum");
        await abrirPrimeiroAnuncio(cdp);
        await waitFor(cdp, `/Carregando as fotos do anúncio no Mercado Livre/.test(${textoFotos})`, "o estado de carregamento não apareceu");
        assert.ok((await infoFotos()).grade, "a grade existe desde o carregamento (a largura da seção não salta)");
        await waitFor(cdp, `/Fotos da variação: Robalo/.test(${textoFotos})`, "os grupos não carregaram");
        const f = await infoFotos();
        assert.deepStrictEqual(f.chips, ["Robalo · 3", "Preto · 1", "Verde · 0"], "um chip por grupo, com a quantidade");
        assert.strictEqual(f.chipAtivo.replace(/\s+/g, " ").trim(), "Robalo · 3", "o primeiro grupo vem selecionado");
        assert.strictEqual(f.titulo, "Fotos da variação: Robalo (P, M)");
        assert.deepStrictEqual(f.ids, ["R1", "R2", "R3"], "só as fotos do grupo selecionado, nunca todas misturadas");
        assert.deepStrictEqual(f.srcs, ["R1", "R2", "R3"].map((id) => `https://img.example/${id}.jpg`));
        assert.deepStrictEqual(f.selos, [{ texto: "Imagem principal da variação", foto: "R1" }], "selo só na primeira foto");
        assert.strictEqual(f.antigoPorCor, false, "a lista antiga 'Fotos por cor' saiu");
        assert.strictEqual(f.antigoAdicionar, false, "nesta etapa não há adicionar");
      } finally {
        fotosLeituraAtrasoMs = 0;
      }
    });

    await check("7f — trocar de grupo mostra só as fotos dele; grupo sem fotos tem estado próprio", async () => {
      await clicar(cdp, '.am-det-fotos__chip[data-idx="1"]');
      await waitFor(cdp, `/Fotos da variação: Preto/.test(${textoFotos})`, "clicar no chip não trocou o grupo");
      let f = await infoFotos();
      assert.strictEqual(f.chipAtivo.replace(/\s+/g, " ").trim(), "Preto · 1");
      assert.deepStrictEqual(f.ids, ["P1"]);
      assert.deepStrictEqual(f.selos, [{ texto: "Imagem principal da variação", foto: "P1" }]);

      await clicar(cdp, '.am-det-fotos__chip[data-idx="2"]');
      await waitFor(cdp, `/Fotos da variação: Verde/.test(${textoFotos})`, "não trocou para Verde");
      f = await infoFotos();
      assert.deepStrictEqual(f.ids, []);
      assert.ok(/Nenhuma foto nesta variação/.test(f.texto), `grupo vazio precisa dizer isso: ${f.texto}`);

      await clicar(cdp, '.am-det-fotos__chip[data-idx="0"]');
      await waitFor(cdp, `/Fotos da variação: Robalo/.test(${textoFotos})`, "não voltou para Robalo");
      assert.deepStrictEqual((await infoFotos()).ids, ["R1", "R2", "R3"]);
      assert.strictEqual(fotosLeituraChamadas > 0, true);
      variationsCountAtivo = 0;
    });

    await check("7g — anúncio sem variação: mesmo componente, 'Fotos do anúncio', sem chips e 'Capa do anúncio' na primeira; sem fotos tem estado próprio", async () => {
      await abrirComModo("nenhum");
      await abrirPrimeiroAnuncio(cdp);
      await waitFor(cdp, `/Fotos do anúncio/.test(${textoFotos})`, "o modo simples não carregou");
      let f = await infoFotos();
      assert.deepStrictEqual(f.chips, [], "sem variação não há chips");
      assert.strictEqual(f.titulo, "Fotos do anúncio");
      assert.deepStrictEqual(f.ids, ["A", "B"]);
      assert.deepStrictEqual(f.selos, [{ texto: "Capa do anúncio", foto: "A" }]);

      fotosLeituraResultado = { status: 200, corpo: { ok: true, modo: "simples", atributo: null, limite: { porGrupo: 12, origem: "operacional" },
        grupos: [{ grupoVariacao: null, rotulo: "", combinacoes: [], quantidade: 0, principal: null, fotos: [] }] } };
      try {
        await abrirComModo("nenhum");
        await abrirPrimeiroAnuncio(cdp);
        await waitFor(cdp, `/Este anúncio não tem fotos no Mercado Livre/.test(${textoFotos})`, "anúncio sem fotos precisa dizer isso");
        f = await infoFotos();
        assert.deepStrictEqual(f.ids, []);
        assert.deepStrictEqual(f.selos, []);
      } finally {
        fotosLeituraResultado = null;
      }
    });

    await check("7h — erro de carregamento: recusa do VenForce mostra o motivo; erro do ML mostra mensagem, código e causa; 'Tentar de novo' relê", async () => {
      fotosLeituraResultado = { status: 409, corpo: { ok: false, codigo: "ATRIBUTO_FOTO_INDEFINIDO", etapa: "bloqueio", incerto: false,
        motivo: "O Mercado Livre não indica, para a categoria deste anúncio, qual atributo das variações define a foto (defines_picture)." } };
      try {
        await abrirComModo("nenhum");
        await abrirPrimeiroAnuncio(cdp);
        await waitFor(cdp, `/defines_picture/.test(${textoFotos})`, "o motivo do bloqueio não apareceu");
        let f = await infoFotos();
        assert.ok(!/Erro do Mercado Livre/.test(f.texto), "recusa do VenForce não se passa por erro do ML");
        assert.deepStrictEqual(f.chips, []);
        assert.deepStrictEqual(f.ids, []);

        fotosLeituraResultado = { status: 422, corpo: { ok: false, codigo: "forbidden", etapa: "leitura", incerto: false, motivo: "Access denied",
          detalhesMl: { status: 403, message: "Access denied", error: "forbidden", causa: null,
            causas: [{ code: "PA_UNAUTHORIZED", message: "Caller is not authorized", type: "error", references: [] }] } } };
        await abrirComModo("nenhum");
        await abrirPrimeiroAnuncio(cdp);
        await waitFor(cdp, `/Erro do Mercado Livre/.test(${textoFotos})`, "o erro do ML não apareceu");
        f = await infoFotos();
        assert.ok(/Mensagem: “Access denied”/.test(f.texto), f.texto);
        assert.ok(/Código: forbidden \(HTTP 403\)/.test(f.texto), f.texto);
        assert.ok(/Causa: PA_UNAUTHORIZED — Caller is not authorized/.test(f.texto), f.texto);

        const antes = fotosLeituraChamadas;
        fotosLeituraResultado = null;
        await clicar(cdp, '#am-det-fotos-corpo [data-acao="foto-recarregar"]');
        await waitFor(cdp, `/Fotos do anúncio/.test(${textoFotos})`, "'Tentar de novo' não recarregou");
        assert.strictEqual(fotosLeituraChamadas, antes + 1, "uma nova leitura");
      } finally {
        fotosLeituraResultado = null;
      }
    });

    await check("7i — anúncio de catálogo: bloqueado com o motivo, sem nem ler as fotos", async () => {
      const antes = fotosLeituraChamadas;
      await abrirComModo("catalog_listing");
      await abrirPrimeiroAnuncio(cdp);
      await waitFor(cdp, `/catálogo/i.test(${textoFotos})`, "catálogo precisa dizer o motivo");
      const f = await infoFotos();
      assert.ok(/Mercado Livre/.test(f.texto), f.texto);
      assert.deepStrictEqual(f.chips, []);
      assert.deepStrictEqual(f.ids, []);
      assert.strictEqual(fotosLeituraChamadas, antes, "catálogo não chama a leitura");
      await abrirComModo("nenhum");
      await abrirPrimeiroAnuncio(cdp);
    });

    await check("7j — só leitura: nenhum PUT /fotos nem upload aconteceu em 7e–7i; sem rascunho não há Salvar", async () => {
      assert.strictEqual(fotosEscritas.length, escritasAntes.fotos, `PUT /fotos não esperado: ${JSON.stringify(fotosEscritas)}`);
      assert.strictEqual(imagemChamadas.length, escritasAntes.imagens, "nenhum POST /imagens");
      assert.strictEqual(await cdp.evaluate("document.querySelectorAll('#am-det-fotos-corpo [data-acao=\"foto-salvar\"]').length"), 0,
        "sem alteração não existe botão de salvar");
    });

    /* ── 7k a 7t: editor de fotos — RASCUNHO EM MEMÓRIA ───────────────────
       Tudo acontece no navegador: nenhuma chamada de escrita, nenhum upload.
       `rede()` fotografa o que já saiu, para comparar depois. */

    function rede() {
      return {
        escrita: pedidos.filter((p) => /\/fotos(\?|$)|\/imagens(\?|$)|\/pictures/.test(p)).length,
        comCorpo: corpos.length,
        putFotos: fotosEscritas.length,
        postImagens: imagemChamadas.length,
      };
    }
    function semRede(antes, oQue) {
      assert.deepStrictEqual(rede(), antes, `${oQue} não pode gerar nenhuma requisição de escrita/upload`);
    }

    // Arrastar nativo com eventos sintéticos (o CDP não arrasta de verdade).
    async function arrastar(de, para) {
      await cdp.evaluate(`(function(){
        var itens = document.querySelectorAll('#am-det-fotos-corpo .am-det-fotos__item');
        var a = itens[${de}], b = itens[${para}], dt = new DataTransfer();
        a.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
        b.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
        b.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
        a.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
        return true; })()`);
    }

    function editor() {
      return cdp.evaluate(`(function(){
        var corpo = document.getElementById('am-det-fotos-corpo');
        var tiles = Array.from(corpo.querySelectorAll('.am-det-fotos__item'));
        var barra = corpo.querySelector('.am-det-fotos__barra');
        var pend = corpo.querySelector('.am-det-fotos__pendente');
        var salvar = corpo.querySelector('[data-acao="foto-salvar"]');
        return {
          ids: tiles.map(function(t){ return t.getAttribute('data-foto'); }),
          removidas: tiles.filter(function(t){ return t.classList.contains('is-removida'); }).map(function(t){ return t.getAttribute('data-foto'); }),
          novas: tiles.filter(function(t){ return t.classList.contains('is-nova'); }).map(function(t){
            return { id: t.getAttribute('data-foto'), src: (t.querySelector('img') || {}).src || '', marca: (t.querySelector('.am-det-fotos__nova') || {}).innerText || '' }; }),
          selo: ((corpo.querySelector('.am-det-fotos__selo') || {}).innerText || '').trim(),
          seloEm: (corpo.querySelector('.am-det-fotos__selo') || { closest: function(){ return null; } }).closest('[data-foto]') ? corpo.querySelector('.am-det-fotos__selo').closest('[data-foto]').getAttribute('data-foto') : null,
          chips: Array.from(corpo.querySelectorAll('.am-det-fotos__chip')).map(function(c){ return c.innerText.replace(/\\s+/g,' ').trim(); }),
          titulo: ((corpo.querySelector('.am-det-fotos__titulo') || {}).innerText || '').replace(/\\s+/g,' ').trim(),
          barra: barra ? barra.innerText.replace(/\\s+/g,' ').trim() : '',
          salvarDesabilitado: salvar ? salvar.disabled : null,
          pendente: pend ? pend.innerText.replace(/\\s+/g,' ').trim() : '',
          lixeiras: corpo.querySelectorAll('.am-det-fotos__item:not(.is-removida) [data-acao="foto-remover"]').length,
          aviso: ((corpo.querySelector('.am-det-fotos__aviso-local') || {}).innerText || '').trim(),
          adicionar: !!corpo.querySelector('[data-acao="foto-escolher"]'),
          adicionarDesabilitado: (corpo.querySelector('[data-acao="foto-escolher"]') || {}).disabled,
        }; })()`);
    }

    async function abrirComVariacoes() {
      variationsCountAtivo = 3;
      await abrirComModo("nenhum");
      await abrirPrimeiroAnuncio(cdp);
      await waitFor(cdp, `/Fotos da variação: Robalo/.test(${textoFotos})`, "o editor não carregou");
    }

    await check("7k — '+ Adicionar imagem' volta: o arquivo vira foto nova só no navegador (preview blob:, marcada 'Nova'), sem nenhuma requisição", async () => {
      await abrirComVariacoes();
      let e = await editor();
      assert.strictEqual(e.adicionar, true, "o '+ Adicionar imagem' voltou");
      assert.strictEqual(e.adicionarDesabilitado, false);
      const antes = rede();
      await escolherArquivo({ png: true, largura: 800, altura: 800, nome: "nova-robalo.png" });
      await waitFor(cdp, "document.querySelector('#am-det-fotos-corpo .am-det-fotos__item.is-nova img')", "a foto nova não apareceu");
      e = await editor();
      assert.deepStrictEqual(e.ids.slice(0, 3), ["R1", "R2", "R3"]);
      assert.strictEqual(e.novas.length, 1, "uma foto nova no fim do grupo");
      assert.ok(/^blob:/.test(e.novas[0].src), `preview local (blob:): ${e.novas[0].src}`);
      assert.strictEqual(e.novas[0].marca, "Nova");
      assert.strictEqual(e.ids[3], e.novas[0].id, "entra no fim");
      semRede(antes, "adicionar imagem");
    });

    await check("7l — arrastar reordena só o rascunho; a primeira ganha o selo; sem setas ← →; nenhuma requisição", async () => {
      const antes = rede();
      assert.strictEqual(await cdp.evaluate(`document.querySelectorAll('#am-det-fotos-corpo [data-acao="foto-mover"]').length`), 0,
        "as setas ← → saíram: a reordenação é por arrastar");
      await arrastar(2, 0);                                         // R3 R1 R2 nova
      let e = await editor();
      assert.deepStrictEqual(e.ids.slice(0, 3), ["R3", "R1", "R2"], "arrastar R3 para o início");
      assert.strictEqual(e.seloEm, "R3", "a primeira foto leva o selo de imagem principal");
      await arrastar(2, 1);
      e = await editor();
      assert.deepStrictEqual(e.ids.slice(0, 3), ["R3", "R2", "R1"], "arrastar para o meio");
      await arrastar(1, 0);
      e = await editor();
      assert.deepStrictEqual(e.ids.slice(0, 3), ["R2", "R3", "R1"], "arrastar para o início de novo");
      assert.strictEqual(e.seloEm, "R2");
      semRede(antes, "reordenar");
    });

    await check("7m — remover marca 'Será removida' (esmaecida) e 'Desfazer' restaura; foto nova removida some; nenhuma requisição", async () => {
      const antes = rede();
      await clicar(cdp, '#am-det-fotos-corpo .am-det-fotos__item[data-foto="R3"] [data-acao="foto-remover"]');
      let e = await editor();
      assert.deepStrictEqual(e.removidas, ["R3"]);
      assert.ok(/Será removida/.test(await cdp.evaluate(textoFotos)));
      const opacidade = await cdp.evaluate(`Number(getComputedStyle(document.querySelector('#am-det-fotos-corpo .am-det-fotos__item[data-foto="R3"] img')).opacity)`);
      assert.ok(opacidade < 0.6, `foto marcada fica esmaecida (opacidade ${opacidade})`);
      await clicar(cdp, '#am-det-fotos-corpo .am-det-fotos__item[data-foto="R3"] [data-acao="foto-desfazer"]');
      e = await editor();
      assert.deepStrictEqual(e.removidas, [], "desfazer restaura");
      await clicar(cdp, '#am-det-fotos-corpo .am-det-fotos__item[data-foto="R3"] [data-acao="foto-remover"]');

      const nova = (await editor()).novas[0].id;
      await clicar(cdp, `#am-det-fotos-corpo .am-det-fotos__item[data-foto="${nova}"] [data-acao="foto-remover"]`);
      e = await editor();
      assert.strictEqual(e.novas.length, 0, "foto nova removida sai do rascunho (nunca existiu no ML)");
      assert.deepStrictEqual(e.ids, ["R2", "R3", "R1"]);
      semRede(antes, "remover/desfazer");
    });

    await check("7n — barra de alterações conta as pendências e oferece Descartar e Salvar", async () => {
      const e = await editor();
      // Pendências: R3 removida + ordem mudou = 2.
      assert.ok(/^2 alterações nas fotos de Robalo/.test(e.barra), `barra: ${e.barra}`);
      assert.ok(/Descartar/.test(e.barra) && /Salvar no Mercado Livre/.test(e.barra), e.barra);
      assert.strictEqual(e.salvarDesabilitado, false, "o salvar está disponível (o envio é testado em 7u–7zd)");
      assert.deepStrictEqual(e.chips, ["Robalo · 2", "Preto · 1", "Verde · 0"], "o chip do grupo acompanha o rascunho");
    });

    await check("7o — trocar de grupo com pendência não troca: 'Existem alterações pendentes neste grupo.' com Salvar / Descartar / Cancelar", async () => {
      const antes = rede();
      await clicar(cdp, '#am-det-fotos-corpo .am-det-fotos__chip[data-idx="1"]');
      await waitFor(cdp, "document.querySelector('#am-det-fotos-corpo .am-det-fotos__pendente')", "o aviso de pendência não apareceu");
      let e = await editor();
      assert.ok(/Existem alterações pendentes neste grupo\./.test(e.pendente), e.pendente);
      assert.ok(/Salvar/.test(e.pendente) && /Descartar/.test(e.pendente) && /Cancelar/.test(e.pendente), e.pendente);
      assert.ok(/Fotos da variação: Robalo/.test(e.titulo), "o grupo não trocou");

      await clicar(cdp, '#am-det-fotos-corpo [data-acao="foto-pendente-cancelar"]');
      e = await editor();
      assert.strictEqual(e.pendente, "");
      assert.deepStrictEqual(e.ids, ["R2", "R3", "R1"], "cancelar mantém o rascunho");
      assert.deepStrictEqual(e.removidas, ["R3"]);

      await clicar(cdp, '#am-det-fotos-corpo .am-det-fotos__chip[data-idx="1"]');
      await waitFor(cdp, "document.querySelector('#am-det-fotos-corpo .am-det-fotos__pendente')", "o aviso não voltou");
      await clicar(cdp, '#am-det-fotos-corpo [data-acao="foto-pendente-descartar"]');
      await waitFor(cdp, `/Fotos da variação: Preto/.test(${textoFotos})`, "descartar não trocou de grupo");
      await clicar(cdp, '#am-det-fotos-corpo .am-det-fotos__chip[data-idx="0"]');
      await waitFor(cdp, `/Fotos da variação: Robalo/.test(${textoFotos})`, "sem pendência a troca é direta");
      e = await editor();
      assert.deepStrictEqual(e.ids, ["R1", "R2", "R3"], "o rascunho descartado não volta");
      assert.deepStrictEqual(e.chips, ["Robalo · 3", "Preto · 1", "Verde · 0"]);
      semRede(antes, "trocar de grupo");
    });

    await check("7p — Descartar volta exatamente ao estado original (ordem, remoções e novas)", async () => {
      await arrastar(1, 0);
      await clicar(cdp, '#am-det-fotos-corpo .am-det-fotos__item[data-foto="R3"] [data-acao="foto-remover"]');
      await escolherArquivo({ png: true, largura: 700, altura: 700, nome: "descartar.png" });
      await waitFor(cdp, "document.querySelector('#am-det-fotos-corpo .am-det-fotos__item.is-nova img')", "a nova não entrou");
      assert.ok((await editor()).barra.length > 0);
      await clicar(cdp, '#am-det-fotos-corpo [data-acao="foto-descartar"]');
      const e = await editor();
      assert.deepStrictEqual(e.ids, ["R1", "R2", "R3"]);
      assert.deepStrictEqual(e.removidas, []);
      assert.deepStrictEqual(e.novas, []);
      assert.strictEqual(e.barra, "", "sem diferença, sem barra");
      assert.strictEqual(e.seloEm, "R1");
    });

    await check("7q — não deixa remover a última foto de uma variação", async () => {
      await clicar(cdp, '#am-det-fotos-corpo .am-det-fotos__chip[data-idx="1"]');
      await waitFor(cdp, `/Fotos da variação: Preto/.test(${textoFotos})`, "não trocou para Preto");
      let e = await editor();
      assert.strictEqual(e.lixeiras, 0, "a única foto do grupo não tem lixeira");
      await escolherArquivo({ png: true, largura: 800, altura: 800, nome: "preto-2.png" });
      await waitFor(cdp, "document.querySelector('#am-det-fotos-corpo .am-det-fotos__item.is-nova')", "a nova não entrou");
      assert.strictEqual((await editor()).lixeiras, 2, "com duas fotos, as duas podem sair");
      await clicar(cdp, '#am-det-fotos-corpo .am-det-fotos__item[data-foto="P1"] [data-acao="foto-remover"]');
      e = await editor();
      assert.strictEqual(e.lixeiras, 0, "a única foto que sobrou perde a lixeira");
      await clicar(cdp, '#am-det-fotos-corpo [data-acao="foto-descartar"]');
    });

    await check("7r — não deixa adicionar a mesma imagem duas vezes no rascunho", async () => {
      await clicar(cdp, '#am-det-fotos-corpo .am-det-fotos__chip[data-idx="0"]');
      await waitFor(cdp, `/Fotos da variação: Robalo/.test(${textoFotos})`, "não voltou para Robalo");
      await escolherArquivo({ png: true, largura: 640, altura: 640, nome: "igual.png" });
      await waitFor(cdp, "document.querySelectorAll('#am-det-fotos-corpo .am-det-fotos__item.is-nova').length === 1", "a primeira não entrou");
      await escolherArquivo({ png: true, largura: 640, altura: 640, nome: "igual-outro-nome.png" });
      await waitFor(cdp, `/Esta imagem já foi adicionada/.test(${textoFotos})`, "duplicata não foi recusada");
      assert.strictEqual((await editor()).novas.length, 1, "a duplicata não entra");
      await clicar(cdp, '#am-det-fotos-corpo [data-acao="foto-descartar"]');
    });

    await check("7s — respeita o limite do GET: no limite, adicionar é recusado localmente", async () => {
      fotosLeituraResultado = { status: 200, corpo: { ...leituraFotos(), limite: { porGrupo: 4, origem: "categoria" } } };
      try {
        await abrirComVariacoes();
        await escolherArquivo({ png: true, largura: 600, altura: 600, nome: "quarta.png" });
        await waitFor(cdp, "document.querySelectorAll('#am-det-fotos-corpo .am-det-fotos__item.is-nova').length === 1", "a quarta não entrou");
        let e = await editor();
        assert.strictEqual(e.adicionarDesabilitado, true, "no limite o adicionar fica desabilitado");
        await escolherArquivo({ png: true, largura: 610, altura: 610, nome: "quinta.png" });
        await waitFor(cdp, `/no máximo 4 imagens/.test(${textoFotos})`, "passar do limite precisa ser recusado com o limite do GET");
        e = await editor();
        assert.strictEqual(e.novas.length, 1);
        await clicar(cdp, '#am-det-fotos-corpo [data-acao="foto-descartar"]');
      } finally {
        fotosLeituraResultado = null;
      }
    });

    await check("7t — nenhum PUT /fotos nem upload em toda a edição (7k–7s)", async () => {
      assert.strictEqual(fotosEscritas.length, escritasAntes.fotos, `PUT /fotos não esperado: ${JSON.stringify(fotosEscritas)}`);
      assert.strictEqual(imagemChamadas.length, escritasAntes.imagens, "nenhum POST /imagens");
      variationsCountAtivo = 0;
      await abrirComModo("nenhum");
      await abrirPrimeiroAnuncio(cdp);
    });

    /* ── 7u a 7zf: editor de fotos — SALVAR (PUT /fotos) ───────────────────
       O PUT vai pela rede de verdade até o servidor local (/__fotos), que lê
       o multipart. Depois do sucesso a tela RELÊ o GET — o teste troca a
       leitura (fotosLeituraResultado) para provar que o estado final vem do
       GET, não do payload enviado. */

    // Imagem de ruído (não comprime): arquivo grande o bastante para o
    // "Enviando imagens…" ser visível com o upload limitado.
    async function escolherRuido(nome, lado) {
      await cdp.evaluate(`(async function(){
        var c = document.createElement('canvas'); c.width = ${lado}; c.height = ${lado};
        var g = c.getContext('2d'); var d = g.createImageData(c.width, c.height);
        for (var i = 0; i < d.data.length; i++) d.data[i] = (Math.random() * 256) | 0;
        g.putImageData(d, 0, 0);
        var blob = await new Promise(function (r) { c.toBlob(r, 'image/png'); });
        var f = new File([blob], ${JSON.stringify(nome)}, { type: 'image/png' });
        var dt = new DataTransfer(); dt.items.add(f);
        var inp = document.getElementById('am-det-img-input');
        inp.files = dt.files; inp.dispatchEvent(new Event('change'));
        return true; })()`);
    }

    function leituraDepois(fotosRobalo) {
      const l = leituraFotos();
      l.grupos[0] = grupoFotos("Robalo", null, ["P", "M"], fotosRobalo);
      return { status: 200, corpo: l };
    }

    const ultimoPut = () => fotosChamadas[fotosChamadas.length - 1];
    const planoRobalo = (ordem) => ({
      grupoVariacao: { attribute_id: "COLOR", value_id: null, value_name: "Robalo" },
      base: ["R1", "R2", "R3"],
      ordem,
    });

    await check("7u — salvar foto nova: 'Enviando imagens…' → 'Salvando no Mercado Livre…' → 'Concluído', tudo travado no meio; multipart certo; o GET é refeito", async () => {
      await abrirComVariacoes();
      await escolherRuido("ruido.png", 900);
      await waitFor(cdp, "document.querySelector('#am-det-fotos-corpo .am-det-fotos__item.is-nova img')", "a nova não entrou");
      const antes = fotosChamadas.length;
      const leiturasAntes = fotosLeituraChamadas;
      fotosLeituraResultado = leituraDepois(["R1", "R2", "R3", "ML9"]);   // o que o ML devolve depois
      fotosAtrasoMs = 1200;
      await cdp.send("Network.enable");
      await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: 700 * 1024 });
      try {
        await clicar(cdp, '#am-det-fotos-corpo [data-acao="foto-salvar"]');
        await waitFor(cdp, `/Enviando imagens/.test(${textoFotos})`, "o estado 'Enviando imagens' não apareceu");
        const travado = await cdp.evaluate(`(function(){
          var c = document.getElementById('am-det-fotos-corpo');
          return {
            chips: Array.from(c.querySelectorAll('.am-det-fotos__chip')).every(function(b){ return b.disabled; }),
            acoes: c.querySelectorAll('[data-acao="foto-remover"]').length,
            arrastaveis: c.querySelectorAll('[draggable="true"]').length,
            adicionar: (c.querySelector('[data-acao="foto-escolher"]') || {}).disabled,
            barra: !!c.querySelector('.am-det-fotos__barra'),
          }; })()`);
        assert.deepStrictEqual(travado, { chips: true, acoes: 0, arrastaveis: 0, adicionar: true, barra: false }, "durante o salvar nada é editável");
        await clicar(cdp, ".am-det-close");
        assert.ok(await cdp.evaluate("!!document.querySelector('.am-det-modal')"), "fechar durante o salvar é bloqueado");
        await waitFor(cdp, `/Salvando no Mercado Livre/.test(${textoFotos})`, "o estado 'Salvando no Mercado Livre' não apareceu");
        await waitFor(cdp, `/Concluído/.test(${textoFotos})`, "não chegou a 'Concluído'");
      } finally {
        await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
        fotosAtrasoMs = 0;
      }
      const put = fotosChamadas[antes];
      assert.ok(put, "nenhum PUT /fotos saiu");
      assert.strictEqual(fotosChamadas.length, antes + 1, "um único PUT");
      assert.ok(/clienteSlug=n97/.test(put.url) && /clienteContaId=42/.test(put.url), put.url);
      assert.deepStrictEqual(put.plano, planoRobalo([{ existente: "R1" }, { existente: "R2" }, { existente: "R3" }, { nova: 0 }]));
      assert.deepStrictEqual(put.arquivos.map((a) => [a.campo, a.nome, a.tipo]), [["novas", "ruido.png", "image/png"]]);
      assert.ok(put.arquivos[0].bytes > 100000, `o arquivo inteiro chega (${put.arquivos[0].bytes} bytes)`);
      assert.strictEqual(fotosLeituraChamadas, leiturasAntes + 1, "depois do sucesso o GET é refeito");
      const e = await editor();
      assert.deepStrictEqual(e.ids, ["R1", "R2", "R3", "ML9"], "a grade mostra o que o GET devolveu (id do ML), não o rascunho");
      assert.deepStrictEqual(e.novas, [], "o rascunho foi recriado");
      assert.strictEqual(e.barra, "", "sem pendências");
      assert.deepStrictEqual(e.chips, ["Robalo · 4", "Preto · 1", "Verde · 0"]);
      fotosLeituraResultado = null;
    });

    await check("7v — salvar só reordenação: ordem só de existentes, nenhum arquivo, direto em 'Salvando'", async () => {
      await abrirComVariacoes();
      await arrastar(2, 0);
      fotosAtrasoMs = 700;
      try {
        await clicar(cdp, '#am-det-fotos-corpo [data-acao="foto-salvar"]');
        await waitFor(cdp, `/Salvando no Mercado Livre/.test(${textoFotos})`, "'Salvando' não apareceu");
        await waitFor(cdp, `/Concluído/.test(${textoFotos})`, "não concluiu");
      } finally {
        fotosAtrasoMs = 0;
      }
      assert.deepStrictEqual(ultimoPut().plano, planoRobalo([{ existente: "R3" }, { existente: "R1" }, { existente: "R2" }]));
      assert.deepStrictEqual(ultimoPut().arquivos, []);
    });

    await check("7w — salvar exclusão: a foto marcada sai da ordem, a base continua a do GET", async () => {
      await abrirComVariacoes();
      await clicar(cdp, '#am-det-fotos-corpo .am-det-fotos__item[data-foto="R2"] [data-acao="foto-remover"]');
      await clicar(cdp, '#am-det-fotos-corpo [data-acao="foto-salvar"]');
      await waitFor(cdp, `/Concluído/.test(${textoFotos})`, "não concluiu");
      assert.deepStrictEqual(ultimoPut().plano, planoRobalo([{ existente: "R1" }, { existente: "R3" }]));
    });

    await check("7x — salvar combinação (nova + excluir + reordenar): índices de 'nova' seguem a ordem dos arquivos; nova removida no rascunho não vai", async () => {
      await abrirComVariacoes();
      await escolherArquivo({ png: true, largura: 800, altura: 800, nome: "primeira.png" });
      await waitFor(cdp, "document.querySelectorAll('#am-det-fotos-corpo .am-det-fotos__item.is-nova').length === 1", "primeira não entrou");
      await escolherArquivo({ png: true, largura: 820, altura: 820, nome: "segunda.png" });
      await waitFor(cdp, "document.querySelectorAll('#am-det-fotos-corpo .am-det-fotos__item.is-nova').length === 2", "segunda não entrou");
      await escolherArquivo({ png: true, largura: 840, altura: 840, nome: "descartada.png" });
      await waitFor(cdp, "document.querySelectorAll('#am-det-fotos-corpo .am-det-fotos__item.is-nova').length === 3", "terceira não entrou");
      // R1 R2 R3 primeira segunda descartada → segunda para o início, R2 fora, descartada sai.
      await arrastar(4, 0);                                                      // segunda R1 R2 R3 primeira descartada
      await clicar(cdp, '#am-det-fotos-corpo .am-det-fotos__item[data-foto="R2"] [data-acao="foto-remover"]');
      const idsNovas = (await editor()).novas.map((n) => n.id);
      await clicar(cdp, `#am-det-fotos-corpo .am-det-fotos__item[data-foto="${idsNovas[idsNovas.length - 1]}"] [data-acao="foto-remover"]`);
      await clicar(cdp, '#am-det-fotos-corpo [data-acao="foto-salvar"]');
      await waitFor(cdp, `/Concluído/.test(${textoFotos})`, "não concluiu");
      const put = ultimoPut();
      assert.deepStrictEqual(put.plano, planoRobalo([{ nova: 0 }, { existente: "R1" }, { existente: "R3" }, { nova: 1 }]));
      assert.deepStrictEqual(put.arquivos.map((a) => a.nome), ["segunda.png", "primeira.png"], "novas[] na ordem dos índices");
    });

    await check("7y — erro de validação do VenForce: motivo aparece, o rascunho continua editável e dá para corrigir e salvar", async () => {
      await abrirComVariacoes();
      await arrastar(1, 0);
      fotosResultado = { status: 400, corpo: { ok: false, codigo: "LIMITE_IMAGENS", etapa: "validacao", incerto: false,
        motivo: "Não é possível salvar. A variação Robalo pode ter no máximo 2 imagens." } };
      try {
        await clicar(cdp, '#am-det-fotos-corpo [data-acao="foto-salvar"]');
        await waitFor(cdp, `/pode ter no máximo 2 imagens/.test(${textoFotos})`, "o motivo não apareceu");
        const t = await cdp.evaluate(textoFotos);
        assert.ok(!/Erro do Mercado Livre/.test(t), "recusa do VenForce não se passa por ML");
        let e = await editor();
        assert.ok(/Salvar no Mercado Livre/.test(e.barra), "o rascunho continua com a barra");
        assert.ok(e.lixeiras > 0, "continua editável");
        fotosResultado = null;
        await clicar(cdp, '#am-det-fotos-corpo .am-det-fotos__item[data-foto="R3"] [data-acao="foto-remover"]');
        e = await editor();
        assert.ok(!/pode ter no máximo 2 imagens/.test(await cdp.evaluate(textoFotos)), "editar limpa o erro anterior");
        await clicar(cdp, '#am-det-fotos-corpo [data-acao="foto-salvar"]');
        await waitFor(cdp, `/Concluído/.test(${textoFotos})`, "depois de corrigir, salvar funciona");
      } finally {
        fotosResultado = null;
      }
    });

    await check("7z — erro do ML: mensagem, código e causa originais; o rascunho fica e nada é reenviado sozinho", async () => {
      await abrirComVariacoes();
      await arrastar(1, 0);
      const antes = fotosChamadas.length;
      fotosResultado = { status: 422, corpo: { ok: false, codigo: "item.pictures.max", etapa: "vinculo", incerto: false, motivo: "Too many pictures",
        detalhesMl: { status: 400, message: "Validation error", error: "validation_error", causa: null,
          causas: [{ code: "item.pictures.max", message: "Too many pictures", type: "error", references: [] }] } } };
      try {
        await clicar(cdp, '#am-det-fotos-corpo [data-acao="foto-salvar"]');
        await waitFor(cdp, `/Erro do Mercado Livre/.test(${textoFotos})`, "o erro do ML não apareceu");
        const t = await cdp.evaluate(textoFotos);
        assert.ok(/Mensagem: “Validation error”/.test(t), t);
        assert.ok(/Código: item\.pictures\.max \(HTTP 400\)/.test(t), t);
        assert.ok(/Causa: item\.pictures\.max — Too many pictures/.test(t), t);
        await sleep(1500);
        assert.strictEqual(fotosChamadas.length, antes + 1, "nenhum reenvio automático");
        assert.deepStrictEqual((await editor()).ids, ["R2", "R1", "R3"], "o rascunho continua como estava");
      } finally {
        fotosResultado = null;
      }
    });

    await check("7za — estado incerto: mensagem de conferência, sem Salvar/reenviar, edição travada; 'Recarregar' só relê", async () => {
      await abrirComVariacoes();
      await arrastar(1, 0);
      const antes = fotosChamadas.length;
      fotosResultado = { status: 422, corpo: { ok: false, codigo: "VINCULO_INCERTO", etapa: "vinculo", incerto: true,
        motivo: "Não foi possível confirmar se as fotos foram salvas (falha de conexão com o Mercado Livre). Confira o anúncio no Mercado Livre antes de salvar de novo." } };
      try {
        await clicar(cdp, '#am-det-fotos-corpo [data-acao="foto-salvar"]');
        await waitFor(cdp, `/Não foi possível confirmar se o Mercado Livre aplicou a alteração\\. Confira o anúncio antes de tentar novamente\\./.test(${textoFotos})`,
          "a mensagem de estado incerto não apareceu");
        const e = await editor();
        assert.strictEqual(e.barra, "", "sem barra de salvar");
        assert.strictEqual(await cdp.evaluate("document.querySelectorAll('#am-det-fotos-corpo [data-acao=\"foto-salvar\"], #am-det-fotos-corpo [data-acao=\"foto-pendente-salvar\"]').length"), 0,
          "nenhum botão de salvar/reenviar");
        assert.strictEqual(e.lixeiras, 0, "edição travada");
        assert.strictEqual(e.adicionarDesabilitado, true);
        await sleep(1200);
        assert.strictEqual(fotosChamadas.length, antes + 1, "nenhum reenvio automático");
        fotosResultado = null;
        const leituras = fotosLeituraChamadas;
        await clicar(cdp, '#am-det-fotos-corpo [data-acao="foto-recarregar"]');
        await waitFor(cdp, `/Fotos da variação: Robalo/.test(${textoFotos}) && !/aplicou a alteração/.test(${textoFotos})`, "recarregar não releu");
        assert.strictEqual(fotosLeituraChamadas, leituras + 1);
        assert.strictEqual(fotosChamadas.length, antes + 1, "recarregar não escreve");
        assert.deepStrictEqual((await editor()).ids, ["R1", "R2", "R3"], "o rascunho foi descartado pela leitura nova");
      } finally {
        fotosResultado = null;
      }
    });

    await check("7zb — conflito (anúncio mudou no ML): motivo e 'Recarregar fotos do Mercado Livre'", async () => {
      await abrirComVariacoes();
      await arrastar(1, 0);
      fotosResultado = { status: 409, corpo: { ok: false, codigo: "FOTOS_DESATUALIZADAS", etapa: "bloqueio", incerto: false,
        motivo: "O anúncio mudou no Mercado Livre desde que você abriu. Recarregue as fotos." } };
      try {
        await clicar(cdp, '#am-det-fotos-corpo [data-acao="foto-salvar"]');
        await waitFor(cdp, `/O anúncio mudou no Mercado Livre desde que você abriu/.test(${textoFotos})`, "o conflito não apareceu");
        assert.ok(await cdp.evaluate("!!document.querySelector('#am-det-fotos-corpo [data-acao=\"foto-recarregar\"]')"), "oferece recarregar");
      } finally {
        fotosResultado = null;
      }
    });

    await check("7zc — fechar o modal com pendência: 'Existem alterações pendentes nas fotos.' com Salvar / Descartar / Cancelar", async () => {
      await abrirComVariacoes();
      await arrastar(1, 0);
      await clicar(cdp, ".am-det-close");
      await waitFor(cdp, "document.querySelector('#am-det-fotos-corpo .am-det-fotos__pendente')", "fechar com pendência não pediu decisão");
      let e = await editor();
      assert.ok(/Existem alterações pendentes nas fotos\./.test(e.pendente), e.pendente);
      assert.ok(/Salvar/.test(e.pendente) && /Descartar/.test(e.pendente) && /Cancelar/.test(e.pendente), e.pendente);
      assert.ok(await cdp.evaluate("!!document.querySelector('.am-det-modal')"), "o modal continua aberto");

      await clicar(cdp, '#am-det-fotos-corpo [data-acao="foto-pendente-cancelar"]');
      e = await editor();
      assert.strictEqual(e.pendente, "");
      assert.deepStrictEqual(e.ids, ["R2", "R1", "R3"], "cancelar mantém o rascunho e o modal");

      await clicar(cdp, ".am-det-close");
      await waitFor(cdp, "document.querySelector('#am-det-fotos-corpo .am-det-fotos__pendente')", "o aviso não voltou");
      await clicar(cdp, '#am-det-fotos-corpo [data-acao="foto-pendente-descartar"]');
      await waitFor(cdp, "!document.querySelector('.am-det-modal')", "descartar não fechou o modal");

      await abrirComVariacoes();
      await arrastar(1, 0);
      const antes = fotosChamadas.length;
      await clicar(cdp, ".am-det-close");
      await waitFor(cdp, "document.querySelector('#am-det-fotos-corpo .am-det-fotos__pendente')", "o aviso não apareceu");
      await clicar(cdp, '#am-det-fotos-corpo [data-acao="foto-pendente-salvar"]');
      await waitFor(cdp, "!document.querySelector('.am-det-modal')", "salvar não fechou o modal depois do sucesso");
      assert.strictEqual(fotosChamadas.length, antes + 1, "salvou antes de fechar");
      assert.deepStrictEqual(ultimoPut().plano.ordem, [{ existente: "R2" }, { existente: "R1" }, { existente: "R3" }]);
    });

    await check("7zd — trocar de grupo com pendência: Salvar grava e segue para o grupo escolhido (relido do GET)", async () => {
      await abrirComVariacoes();
      await arrastar(1, 0);
      const antes = fotosChamadas.length;
      await clicar(cdp, '#am-det-fotos-corpo .am-det-fotos__chip[data-idx="1"]');
      await waitFor(cdp, "document.querySelector('#am-det-fotos-corpo .am-det-fotos__pendente')", "o aviso não apareceu");
      assert.ok(/Existem alterações pendentes neste grupo\./.test((await editor()).pendente));
      await clicar(cdp, '#am-det-fotos-corpo [data-acao="foto-pendente-salvar"]');
      await waitFor(cdp, `/Fotos da variação: Preto/.test(${textoFotos})`, "não seguiu para Preto depois de salvar");
      assert.strictEqual(fotosChamadas.length, antes + 1);
      assert.strictEqual(ultimoPut().plano.grupoVariacao.value_name, "Robalo", "salvou o grupo de onde saiu");
      assert.deepStrictEqual((await editor()).ids, ["P1"]);
    });

    await check("7ze — o fluxo novo nunca usa o POST /imagens antigo", async () => {
      assert.strictEqual(imagemChamadas.length, escritasAntes.imagens, "nenhum POST /imagens em todo o editor");
      variationsCountAtivo = 0;
      await abrirComModo("nenhum");
      await abrirPrimeiroAnuncio(cdp);
    });

    await check("7zf — anúncio de produto (family_name + user_product_id) sem variação: aviso de replicação junto da alteração, antes de salvar; anúncio comum não avisa; nenhum PUT/upload", async () => {
      const AVISO = /pertence a um produto do Mercado Livre\. A alteração de imagem pode ser replicada para outros anúncios relacionados/;
      const textoModal = "((document.querySelector('.am-det-modal') || {}).innerText || '')";
      const escritas = () => ({ put: fotosEscritas.length, multipart: fotosChamadas.length, imagens: imagemChamadas.length });
      const inicio = escritas();
      async function moverPrimeira() {
        await arrastar(1, 0);
        await waitFor(cdp, "!!document.querySelector('#am-det-fotos-corpo .am-det-fotos__barra')", "a barra de alterações não apareceu");
      }
      try {
        // Controle: anúncio comum (sem family_name/user_product_id), mesma alteração, sem aviso.
        await abrirComModo("nenhum");
        await abrirPrimeiroAnuncio(cdp);
        await waitFor(cdp, `/Fotos do anúncio/.test(${textoFotos})`, "o modo simples não carregou");
        await moverPrimeira();
        assert.ok(!AVISO.test(await cdp.evaluate(textoModal)), "anúncio comum não recebe o aviso de replicação");
        await clicar(cdp, '#am-det-fotos-corpo [data-acao="foto-descartar"]');

        // Anúncio de produto sem variação.
        await abrirComModo("produto");
        await abrirPrimeiroAnuncio(cdp);
        await waitFor(cdp, `/Fotos do anúncio/.test(${textoFotos})`, "o modo simples não carregou no anúncio de produto");
        let e = await editor();
        assert.deepStrictEqual(e.ids, ["A", "B"]);
        assert.strictEqual(e.adicionar, true, "anúncio de produto sem variação continua editável (só avisa)");
        assert.ok(!AVISO.test(await cdp.evaluate(textoModal)), "sem alteração pendente ainda não há o que avisar");
        await moverPrimeira();
        assert.ok(AVISO.test(await cdp.evaluate(textoModal)), "com alteração pendente o aviso de replicação aparece antes do salvar");
        e = await editor();
        assert.ok(/Salvar no Mercado Livre/.test(e.barra), "o aviso não tira o Salvar");
        await clicar(cdp, '#am-det-fotos-corpo [data-acao="foto-descartar"]');
        await waitFor(cdp, "!document.querySelector('#am-det-fotos-corpo .am-det-fotos__barra')", "descartar não limpou a barra");
        assert.ok(!AVISO.test(await cdp.evaluate(textoModal)), "descartado o rascunho, o aviso some");
        assert.deepStrictEqual(escritas(), inicio, "nenhum PUT /fotos, multipart ou POST /imagens no cenário");
      } finally {
        await abrirComModo("nenhum");
        await abrirPrimeiroAnuncio(cdp);
      }
    });

    await check("8 — alterações pendentes são detectadas e nomeadas", async () => {
      assert.strictEqual(await cdp.evaluate("document.querySelectorAll('#am-det-savebar').length"), 0,
        "não deveria haver barra de alterações sem alteração nenhuma");
      await digitar(cdp, "#am-det-titulo", "Fone TWS Prime X200 ANC 30h — Edição Manual");
      await digitar(cdp, "#am-det-descricao", DESC_A + " Editado.");
      await waitFor(cdp, "document.getElementById('am-det-savebar')", "a barra de alterações não apareceu");
      const barra = await cdp.evaluate("document.getElementById('am-det-savebar').innerText");
      assert.ok(/2 altera/.test(barra), `a barra deveria contar 2 alterações: ${barra}`);
      assert.ok(/Título/.test(barra) && /Descrição/.test(barra), `a barra deveria nomear os campos: ${barra}`);
      const chips = await cdp.evaluate("document.querySelectorAll('.am-det-dirty:not([hidden])').length");
      assert.ok(chips >= 2, `os campos alterados deveriam marcar "Alteração não salva" (achei ${chips})`);
    });

    await check("9 — descartar restaura os valores originais", async () => {
      await clicar(cdp, '.am-det-modal [data-acao="descartar"]');
      await waitFor(cdp, "!document.getElementById('am-det-savebar')", "a barra de alterações não sumiu ao descartar");
      assert.strictEqual(await cdp.evaluate("document.getElementById('am-det-titulo').value"), TITULO_A);
      assert.strictEqual(await cdp.evaluate("document.getElementById('am-det-descricao').value"), DESC_A);
    });

    await check("9b — comparação com a IA: coluna 'Atual' de Título e Modelo é editável, é o MESMO rascunho do cabeçalho/Catálogo e vai no MESMO salvar", async () => {
      const info = await cdp.evaluate(`(function(){
        var t = document.getElementById('am-det-espelho-titulo'), m = document.getElementById('am-det-espelho-modelo');
        return { tt: t.tagName, tro: t.readOnly, tmax: t.getAttribute('maxlength'), tv: t.value,
                 mt: m.tagName, mro: m.readOnly, mv: m.value }; })()`);
      assert.deepStrictEqual(info, { tt: "INPUT", tro: false, tmax: "60", tv: TITULO_A, mt: "INPUT", mro: false, mv: "X200" });
      const contador = () => cdp.evaluate("document.getElementById('am-det-count-espelho-titulo').textContent");
      assert.strictEqual(await contador(), TITULO_A.length + "/60 caracteres", "o título da comparação mostra quantos caracteres tem");

      // Digitar na comparação espelha no cabeçalho/Catálogo (e vice-versa).
      await digitar(cdp, "#am-det-espelho-titulo", "Título editado na comparação com a IA");
      await digitar(cdp, "#am-det-modelo", "X200 Mini");
      await waitFor(cdp, "document.getElementById('am-det-savebar')", "editar na comparação não gerou pendência");
      const sync = await cdp.evaluate(`({
        cab: document.getElementById('am-det-titulo').value,
        espM: document.getElementById('am-det-espelho-modelo').value,
        sujoT: document.getElementById('am-det-espelho-titulo').classList.contains('is-dirty'),
        barra: document.getElementById('am-det-savebar').innerText })`);
      assert.strictEqual(sync.cab, "Título editado na comparação com a IA", "o título do cabeçalho não acompanhou a comparação");
      assert.strictEqual(await contador(), "Título editado na comparação com a IA".length + "/60 caracteres",
        "o contador acompanha a digitação");
      assert.strictEqual(sync.espM, "X200 Mini", "a coluna 'Atual' do modelo não acompanhou o campo do Catálogo");
      assert.ok(sync.sujoT, "o campo da comparação precisa marcar a alteração pendente");
      assert.ok(/2 altera/.test(sync.barra) && /Título/.test(sync.barra) && /Modelo/.test(sync.barra),
        `um valor, duas vistas: são 2 alterações (Título, Modelo), nunca 4: ${sync.barra}`);

      // "Usar" numa sugestão de título continua caindo no mesmo rascunho — e aparece nas duas vistas.
      await clicar(cdp, '.am-det-modal [data-acao="gerar-titulos"]');
      await waitFor(cdp, "document.querySelector('.am-det-modal [data-acao=\"usar-titulo\"]')", "as sugestões de título não apareceram");
      await clicar(cdp, '.am-det-modal [data-acao="usar-titulo"][data-idx="0"]');
      const sug = await cdp.evaluate(`[document.getElementById('am-det-titulo').value, document.getElementById('am-det-espelho-titulo').value]`);
      assert.deepStrictEqual(sug, [SUG_TITULOS[0].titulo, SUG_TITULOS[0].titulo]);

      // Salvar: o MESMO PATCH /conteudo de sempre, um campo por chave. A
      // resposta forçada não confirma nada, para o estado seguir intacto.
      corpos.length = 0;
      const antesPedidos = pedidos.length;
      conteudoResultado = { status: 200, corpo: { ok: false, motivo: "Resposta de teste (9b)." } };
      await clicar(cdp, '.am-det-modal [data-acao="salvar"]');
      await esperarPedido(/\/anuncios-meli\/MLB-A1\/conteudo/, antesPedidos, "não saiu PATCH de conteúdo");
      const envio = corpos.find((c) => /\/conteudo/.test(c.url));
      assert.strictEqual(envio.metodo, "PATCH");
      assert.strictEqual(envio.body.titulo, SUG_TITULOS[0].titulo);
      assert.strictEqual(envio.body.modelo, "X200 Mini");
      assert.strictEqual(envio.body.descricao, undefined);
      conteudoResultado = null;

      // Descartar volta as DUAS vistas ao original.
      await clicar(cdp, '.am-det-modal [data-acao="descartar"]');
      await waitFor(cdp, "!document.getElementById('am-det-savebar')", "descartar não limpou a pendência");
      const volta = await cdp.evaluate(`[document.getElementById('am-det-titulo').value, document.getElementById('am-det-espelho-titulo').value,
        document.getElementById('am-det-modelo').value, document.getElementById('am-det-espelho-modelo').value]`);
      assert.deepStrictEqual(volta, [TITULO_A, TITULO_A, "X200", "X200"]);
      // O 10 procura o PATCH desde o início do log: não deixa o deste check lá.
      pedidos.splice(antesPedidos);
      corpos.length = 0;
    });

    /* ── 10 a 12: salvar de verdade ───────────────────────────────────── */

    await check("10 — salvar usa o clienteSlug e a ClienteConta do contexto", async () => {
      corpos.length = 0;
      await digitar(cdp, "#am-det-titulo", "Fone TWS Prime X200 ANC 30h Bateria Preto");
      await digitar(cdp, "#am-det-modelo", "X200 Pro");
      await waitFor(cdp, "document.getElementById('am-det-savebar')", "a barra não apareceu");
      await clicar(cdp, '.am-det-modal [data-acao="salvar"]');
      await esperarPedido(/\/anuncios-meli\/MLB-A1\/conteudo/, 0, "não saiu PATCH de conteúdo");
      const envio = corpos.find((c) => /\/conteudo/.test(c.url));
      assert.ok(envio, "o corpo do PATCH não foi capturado");
      assert.strictEqual(envio.metodo, "PATCH");
      assert.strictEqual(envio.body.clienteSlug, "n97");
      assert.strictEqual(String(envio.body.clienteContaId), "42", "a escrita precisa carregar a ClienteConta da operação");
      assert.strictEqual(envio.body.titulo, "Fone TWS Prime X200 ANC 30h Bateria Preto");
      assert.strictEqual(envio.body.modelo, "X200 Pro");
      assert.strictEqual(envio.body.descricao, undefined, "campo não alterado não deveria ser enviado");
    });

    await check("11 — sucesso real atualiza a UI e limpa a pendência", async () => {
      await waitFor(cdp, "!document.getElementById('am-det-savebar')", "a barra continuou após o salvamento confirmado");
      const t = await textoModal(cdp);
      assert.ok(t.includes("X200 Pro"), `o modelo salvo deveria aparecer no detalhe: ${t.slice(0, 400)}`);
      assert.strictEqual(await cdp.evaluate("document.getElementById('am-det-titulo').value"),
        "Fone TWS Prime X200 ANC 30h Bateria Preto");
      const espelho = await cdp.evaluate("document.getElementById('am-det-espelho-titulo').value");
      assert.strictEqual(espelho, "Fone TWS Prime X200 ANC 30h Bateria Preto",
        "a coluna 'Atual' da comparação com a IA precisa refletir o título salvo");
    });

    await check("12 — erro do Mercado Livre NÃO produz falso sucesso", async () => {
      conteudoResultado = {
        status: 200,
        corpo: {
          ok: false,
          resultados: { titulo: { ok: false, codigo: "item_has_sales", motivo: "Não é possível alterar o título de um item com vendas." } },
          anuncio: anuncio("42"), descricao: DESC_A, descricaoEstado: "ok", descricaoErro: null,
        },
      };
      await digitar(cdp, "#am-det-titulo", "Título que o ML vai recusar");
      await clicar(cdp, '.am-det-modal [data-acao="salvar"]');
      await waitFor(cdp, "document.querySelector('#am-det-savebar.is-perigo')", "a barra não entrou em estado de erro");
      const barra = await cdp.evaluate("document.getElementById('am-det-savebar').innerText");
      assert.ok(/Não foi possível salvar a alteração do título/i.test(barra), `a barra deveria dizer que não salvou: ${barra}`);
      assert.ok(/Motivo informado pelo Mercado Livre: Não é possível alterar o título de um item com vendas/i.test(barra),
        `o motivo real do ML deveria aparecer: ${barra}`);
      assert.ok(/Código: item_has_sales/.test(barra), `o código do ML deveria aparecer: ${barra}`);
      assert.strictEqual(await cdp.evaluate("document.getElementById('am-det-titulo').value"), "Título que o ML vai recusar",
        "o texto do usuário não pode ser jogado fora por causa da recusa");
      const t = await textoModal(cdp);
      assert.ok(!/salvas no anúncio/i.test(t), "não pode haver mensagem de sucesso depois de uma recusa");
      conteudoResultado = null;
    });

    await check("12b — recusa por bids: explicação amigável + resposta original + código do ML", async () => {
      const BIDS = "Cannot update title when item has bids";
      conteudoResultado = {
        status: 200,
        corpo: {
          ok: false,
          resultados: { titulo: {
            ok: false, codigo: "item.title.not_modifiable", motivo: BIDS,
            explicacao: "O Mercado Livre recusou a alteração via API neste anúncio. A resposta cita vendas (bids) no anúncio.",
            detalhesMl: { status: 400, message: BIDS, error: "validation_error", causa: null,
              causas: [{ code: "item.title.not_modifiable", message: BIDS, type: "error", references: ["item.title"] }] },
          } },
          anuncio: anuncio("42"), descricao: DESC_A, descricaoEstado: "ok", descricaoErro: null,
        },
      };
      await clicar(cdp, '.am-det-modal [data-acao="salvar"]');
      await waitFor(cdp, "((document.getElementById('am-det-savebar')||{}).innerText||'').indexOf('bids') >= 0",
        "a barra não mostrou a recusa por bids");
      const barra = await cdp.evaluate("document.getElementById('am-det-savebar').innerText");
      assert.ok(/Motivo informado pelo Mercado Livre: O Mercado Livre recusou a alteração via API neste anúncio/.test(barra), barra);
      assert.ok(!/não permite|depois da primeira venda/.test(barra), `sem afirmar regra fixa do ML: ${barra}`);
      assert.ok(barra.includes("Resposta original: “" + BIDS + "”"), `a mensagem crua do ML não pode sumir: ${barra}`);
      assert.ok(/Código: item\.title\.not_modifiable/.test(barra), barra);
      assert.ok(!/salvas no anúncio/i.test(await textoModal(cdp)), "sem falso sucesso");
      conteudoResultado = null;
    });

    await check("12c — ML recusa o MODELO: motivo real + código na barra, valor digitado preservado, sem falso sucesso", async () => {
      corpos.length = 0;
      const RECUSA = "Attribute [MODEL] is not modifiable.";
      conteudoResultado = {
        status: 200,
        corpo: {
          ok: false,
          resultados: { modelo: {
            ok: false, codigo: "item.attribute.not_modifiable", motivo: RECUSA,
            detalhesMl: { status: 400, message: "Validation error", error: "validation_error", causa: null,
              causas: [{ code: "item.attribute.not_modifiable", message: RECUSA, type: "error", references: ["item.attributes"] }] },
          } },
          anuncio: anuncio("42"), descricao: DESC_A, descricaoEstado: "ok", descricaoErro: null,
        },
      };
      await digitar(cdp, "#am-det-modelo", "X999");
      await clicar(cdp, '.am-det-modal [data-acao="salvar"]');
      await waitFor(cdp, "((document.getElementById('am-det-savebar')||{}).innerText||'').indexOf('do modelo') >= 0",
        "a barra não mostrou a recusa do modelo");
      const envio = corpos.find((c) => /\/conteudo/.test(c.url));
      assert.strictEqual(envio.body.modelo, "X999", "o modelo alterado vai no MESMO PATCH /conteudo");
      const barra = await cdp.evaluate("document.getElementById('am-det-savebar').innerText");
      assert.ok(/Não foi possível salvar a alteração do modelo deste anúncio/.test(barra), barra);
      assert.ok(barra.includes("Motivo informado pelo Mercado Livre: " + RECUSA), `o motivo real do ML deveria aparecer: ${barra}`);
      assert.ok(/Código: item\.attribute\.not_modifiable/.test(barra), barra);
      assert.strictEqual(await cdp.evaluate("document.getElementById('am-det-modelo').value"), "X999",
        "o texto do usuário não pode ser jogado fora por causa da recusa");
      assert.ok(!/salvas no anúncio/i.test(await textoModal(cdp)), "sem falso sucesso");
      conteudoResultado = null;
    });

    /* ── 13: fechar com alteração pendente ────────────────────────────── */

    await check("13 — fechar com alteração pendente não perde dado em silêncio", async () => {
      await clicar(cdp, ".am-det-close");
      await sleep(150);
      assert.ok(await cdp.evaluate("Boolean(document.querySelector('.am-det-modal'))"),
        "o modal fechou e levou a alteração pendente junto");
      const barra = await cdp.evaluate("document.getElementById('am-det-savebar').innerText");
      assert.ok(/descartar/i.test(barra), `deveria pedir confirmação explícita: ${barra}`);
      await clicar(cdp, '.am-det-modal [data-acao="cancelar-saida"]');
      await sleep(100);
      assert.strictEqual(await cdp.evaluate("document.getElementById('am-det-titulo').value"), "Título que o ML vai recusar",
        "cancelar a saída precisa devolver o texto intacto");
      await clicar(cdp, '.am-det-modal [data-acao="descartar"]');
      await waitFor(cdp, "!document.getElementById('am-det-savebar')", "descartar não limpou a pendência");
    });

    /* ── 14 a 20: capacidades que precisavam sobreviver ───────────────── */

    await check("14 — revisão continua funcionando", async () => {
      const desde = pedidos.length;
      await clicar(cdp, "#am-det-revisar");
      await esperarPedido(/\/anuncios-meli\/MLB-A1\/revisao/, desde, "a revisão não chamou o backend");
      await waitFor(cdp, "document.getElementById('am-det-revisado-chip').innerText.indexOf('Revisado') >= 0",
        "o estado de revisão não apareceu no modal");
      const rotulo = await cdp.evaluate("document.getElementById('am-det-revisar').innerText");
      assert.ok(/Desmarcar revisão/.test(rotulo), `o botão deveria inverter: ${rotulo}`);
    });

    await check("15 — 'Abrir no Mercado Livre' continua funcionando", async () => {
      const link = await cdp.evaluate(`(function(){ var a = document.getElementById('am-det-abrir-ml');
        return a ? { href: a.getAttribute('href'), target: a.getAttribute('target') } : null; })()`);
      assert.ok(link, "o link para o Mercado Livre sumiu");
      assert.ok(/MLB-A1/.test(link.href), `href errado: ${link.href}`);
      assert.strictEqual(link.target, "_blank");
    });

    await check("16 — o Modelo não tem geração: nem o 'Gerar SEO' legado nem o 'Gerar modelo' da F4", async () => {
      assert.strictEqual(await cdp.evaluate("document.querySelectorAll('.am-det-modal [data-acao=\"gerar\"][data-tipo=\"seo\"]').length"), 0,
        "o 'Gerar SEO' legado saiu da tela");
      assert.strictEqual(await cdp.evaluate("document.querySelectorAll('.am-det-modal [data-acao=\"gerar-modelo\"]').length"), 0,
        "o 'Gerar modelo' saiu com a F4R");
    });

    await check("17 — gerar descrição continua funcionando (agora pelo Description Engine, não pelo /otimizar)", async () => {
      const desde = pedidos.length;
      assert.strictEqual(await cdp.evaluate("document.querySelectorAll('.am-det-modal [data-acao=\"gerar\"][data-tipo=\"descricao\"]').length"), 0,
        "o 'Gerar descrição' legado (/otimizar tipo descricao) saiu da tela na F5");
      await clicar(cdp, '.am-det-modal [data-acao="gerar-descricao"]');
      await esperarPedido(/\/anuncios-meli\/MLB-A1\/seo\/descricao/, desde, "o Gerar descrição não chamou o backend");
      await waitFor(cdp, `document.getElementById('am-det-sug-descricao').innerText.indexOf(${JSON.stringify(SUG_DESC_A)}) >= 0`,
        "a descrição gerada não apareceu");
      assert.deepStrictEqual(pedidos.slice(desde).filter((u) => /\/otimizar/.test(u)), [], "a descrição não passa mais pelo /otimizar");
    });

    await check("18 — sugerir ficha técnica continua funcionando", async () => {
      const desde = pedidos.length;
      await clicar(cdp, '.am-det-modal [data-acao="gerar"][data-tipo="ficha_tecnica"]');
      await esperarPedido(/\/anuncios-meli\/MLB-A1\/otimizar/, desde, "o Sugerir ficha não chamou o backend");
      assert.strictEqual(corpos.filter((c) => /\/otimizar/.test(c.url)).pop().body.tipo, "ficha_tecnica");
    });

    await check("19 — a aprovação interna da ficha continua funcionando (e não publica no ML); descrição não tem mais 'Aprovar'", async () => {
      const antesConteudo = pedidos.filter((u) => /\/conteudo/.test(u)).length;
      assert.strictEqual(await cdp.evaluate("document.querySelectorAll('.am-det-modal [data-acao=\"aprovar-titulo\"]').length"), 0,
        "o título não tem mais 'Aprovar': as sugestões do Title Engine não são registro do otimizador legado");
      assert.strictEqual(await cdp.evaluate("document.querySelectorAll('.am-det-modal [data-acao=\"aprovar-modelo\"]').length"), 0,
        "o Modelo não tem mais 'Aprovar': a sugestão do Model Engine não é registro do otimizador legado");
      assert.strictEqual(await cdp.evaluate("document.querySelectorAll('.am-det-modal [data-acao=\"aprovar-descricao\"]').length"), 0,
        "a descrição não tem mais 'Aprovar': a sugestão do Description Engine não é registro do otimizador legado");
      const desde = pedidos.length;
      await clicar(cdp, '.am-det-modal [data-acao="aprovar-ficha"]', "botão aprovar-ficha não existe");
      await esperarPedido(/\/anuncios-meli\/otimizacoes\/\d+\/aprovar/, desde, "aprovar-ficha não chamou o endpoint de aprovação");
      const corpoFicha = corpos.filter((c) => /\/aprovar/.test(c.url)).pop();
      assert.ok(Array.isArray(corpoFicha.body.fichaAprovadaJson), "aprovar ficha envia a ficha sugerida");
      assert.strictEqual(corpoFicha.body.descricaoAprovada, undefined);
      assert.strictEqual(corpoFicha.body.clienteSlug, "n97", "aprovar leva o cliente (F1)");
      assert.strictEqual(pedidos.filter((u) => /\/conteudo/.test(u)).length, antesConteudo,
        "APROVAR é decisão interna — não pode virar escrita no Mercado Livre");
    });

    await check("20 — copiar continua funcionando nos vários pontos", async () => {
      await cdp.evaluate(`(function(){ window.__copiado = [];
        Object.defineProperty(navigator, 'clipboard', { configurable: true,
          value: { writeText: function (t) { window.__copiado.push(t); return Promise.resolve(); } } }); })()`);
      const alvos = await cdp.evaluate("document.querySelectorAll('.am-det-modal [data-acao=\"copiar\"], .am-det-modal [data-acao=\"copiar-ficha\"]').length");
      // 3 desde a F4: o "Copiar" do modelo_sugerido legado saiu com o Model Engine.
      assert.ok(alvos >= 3, `esperava vários pontos de cópia, achei ${alvos}`);
      await cdp.evaluate(`(function(){ document.querySelectorAll('.am-det-modal [data-acao="copiar"], .am-det-modal [data-acao="copiar-ficha"]')
        .forEach(function (b) { b.click(); }); })()`);
      await sleep(200);
      const copiado = await cdp.evaluate("window.__copiado");
      assert.ok(copiado.length >= 3, `nenhuma cópia registrada: ${JSON.stringify(copiado)}`);
      assert.ok(copiado.some((t) => t && t.includes(SUG_DESC_A)), "copiar a descrição sugerida parou de funcionar");
      assert.ok(copiado.some((t) => t && /Peso: 38 g/.test(t)), "copiar a ficha como lista parou de funcionar");
    });

    /* ── 24: descrição ausente × erro de descrição ────────────────────── */

    await check("24 — 'sem descrição' e 'erro ao carregar a descrição' são estados diferentes", async () => {
      await fecharModal(cdp);
      descricaoEstado = "sem_descricao";
      await abrirPrimeiroAnuncio(cdp);
      let t = await textoModal(cdp);
      assert.ok(/não tem descrição/i.test(t), `estado 'sem descrição' não apareceu: ${t.slice(0, 600)}`);
      assert.ok(!/não foi possível carregar a descrição/i.test(t), "sem descrição não pode se apresentar como erro");
      assert.ok(await cdp.evaluate("Boolean(document.getElementById('am-det-descricao'))"),
        "sem descrição o campo continua editável — é assim que se escreve a primeira");

      await fecharModal(cdp);
      descricaoEstado = "erro";
      await abrirPrimeiroAnuncio(cdp);
      t = await textoModal(cdp);
      assert.ok(/não foi possível carregar a descrição/i.test(t), `estado de erro não apareceu: ${t.slice(0, 600)}`);
      assert.ok(!/não tem descrição/i.test(t), "erro de carregamento não pode afirmar que o anúncio não tem descrição");
      assert.strictEqual(await cdp.evaluate("document.querySelectorAll('#am-det-descricao').length"), 0,
        "com erro de leitura o campo precisa ficar bloqueado — editar sobrescreveria o que não conhecemos");
      assert.strictEqual(await cdp.evaluate("document.querySelectorAll('.am-det-modal [data-acao=\"gerar-descricao\"]').length"), 0,
        "com erro de leitura também não há geração: a sugestão substituiria um texto que não conhecemos");
      descricaoEstado = "ok";
    });

    /* ── 21: usuário sem permissão de IA ──────────────────────────────── */

    await check("21 — usuário sem permissão de IA usa o modal inteiro, e a região de IA se explica", async () => {
      await fecharModal(cdp);
      iaProibida = true;
      await abrirPrimeiroAnuncio(cdp);
      await waitFor(cdp, "document.querySelector('.am-det-modal').innerText.indexOf('administradores') >= 0",
        "a região de IA não explicou o gate");
      const t = await textoModal(cdp);
      // O resto do detalhe continua inteiro.
      [TITULO_A, "MLB-A1", "Score VenForce", "Ficha técnica", "Abrir no Mercado Livre"].forEach((frag) => {
        assert.ok(t.includes(frag), `403 de IA quebrou o resto do detalhe: sumiu "${frag}"`);
      });
      assert.ok(!/erro/i.test(await cdp.evaluate("document.getElementById('am-det-scroll').innerText").then((s) => s.slice(0, 200))),
        "o modal não pode parecer quebrado por causa do 403");
      assert.strictEqual(await cdp.evaluate("document.querySelectorAll('.am-det-modal [data-acao=\"gerar\"]').length"), 0,
        "sem permissão de IA não faz sentido oferecer os botões de gerar");
      assert.strictEqual(await cdp.evaluate("document.querySelectorAll('.am-det-modal [data-acao=\"gerar-titulos\"]').length"), 0,
        "sem permissão de IA não há 'Gerar títulos'");
      assert.strictEqual(await cdp.evaluate("document.querySelectorAll('.am-det-modal [data-acao=\"gerar-descricao\"]').length"), 0,
        "sem permissão de IA não há 'Gerar descrição'");
      assert.ok(!/Score SEO/.test(t), "a nota do otimizador legado não aparece mais");
      // E o que é editável continua editável.
      await digitar(cdp, "#am-det-titulo", TITULO_A + " X");
      await waitFor(cdp, "document.getElementById('am-det-savebar')", "a edição parou de funcionar para quem não tem IA");
      await clicar(cdp, '.am-det-modal [data-acao="descartar"]');
      iaProibida = false;
    });

    /* ── 22 e 23: isolamento de estado ────────────────────────────────── */

    await check("22 — resposta atrasada da Conta A não vaza para a Conta B", async () => {
      await fecharModal(cdp);
      // A abre com resposta LENTA; troca de operação; B abre e responde rápido.
      detalheAtrasoPorItem["MLB-A1"] = 700;
      await clicar(cdp, ".am-row");
      await sleep(80); // a requisição de A já saiu
      await cdp.evaluate("window.VF.context.setConta(43)");
      await waitFor(cdp, "!document.querySelector('.am-det-modal')",
        "trocar de operação deveria tirar da tela o detalhe da conta anterior");
      await waitFor(cdp, "document.querySelector('.am-row')", "o catálogo da conta nova não carregou");
      delete detalheAtrasoPorItem["MLB-A1"];
      await abrirPrimeiroAnuncio(cdp);
      assert.strictEqual(await cdp.evaluate("document.getElementById('am-det-titulo').value"), TITULO_B,
        "o modal deveria estar no anúncio da Conta B");
      await sleep(900); // tempo de a resposta atrasada da Conta A chegar
      const valor = await cdp.evaluate("document.getElementById('am-det-titulo') ? document.getElementById('am-det-titulo').value : ''");
      assert.strictEqual(valor, TITULO_B, `a resposta atrasada da Conta A sobrescreveu a Conta B: ${valor}`);
      const detalhes = pedidos.filter((u) => /^\/anuncios-meli\/MLB-B1\?/.test(u));
      assert.ok(detalhes.some((u) => u.includes("clienteContaId=43")),
        `o detalhe de B precisa sair com a conta 43: ${JSON.stringify(detalhes)}`);
    });

    await check("23 — estado do anúncio A não vaza para o anúncio B", async () => {
      // B (conta 43) não tem otimizações; A tem. Voltar para A, ver sugestão,
      // fechar, abrir B: nada de A pode sobreviver.
      let t = await textoModal(cdp);
      assert.ok(!t.includes(SUG_TITULO_A), `a sugestão do anúncio A apareceu no anúncio B: ${t.slice(0, 500)}`);
      assert.ok(!t.includes(TITULO_A), "o título do anúncio A apareceu no anúncio B");

      await fecharModal(cdp);
      await cdp.evaluate("window.VF.context.setConta(42)");
      await waitFor(cdp, "document.querySelector('.am-row')", "o catálogo da conta 42 não voltou");
      await abrirPrimeiroAnuncio(cdp);
      // Descrição gerada em A (Description Engine) não pode sobreviver.
      await clicar(cdp, '.am-det-modal [data-acao="gerar-descricao"]');
      await waitFor(cdp, `document.querySelector('.am-det-modal').innerText.indexOf(${JSON.stringify(SUG_DESC_A)}) >= 0`,
        "a descrição gerada em A não apareceu");
      // Títulos gerados em A (Title Engine) também não podem sobreviver.
      await clicar(cdp, '.am-det-modal [data-acao="gerar-titulos"]');
      await waitFor(cdp, "document.querySelectorAll('#am-det-sug-titulo [data-acao=\"usar-titulo\"]').length > 0", "os títulos de A não apareceram");
      await digitar(cdp, "#am-det-modelo", "RASCUNHO-A");
      await waitFor(cdp, "document.getElementById('am-det-savebar')", "a alteração pendente em A não foi detectada");
      await fecharModal(cdp); // descarta explicitamente

      await cdp.evaluate("window.VF.context.setConta(43)");
      await waitFor(cdp, "document.querySelector('.am-row')", "o catálogo da conta 43 não voltou");
      await abrirPrimeiroAnuncio(cdp);
      t = await textoModal(cdp);
      assert.ok(!t.includes(SUG_TITULO_A), "a sugestão de IA de A sobreviveu à troca de anúncio");
      assert.ok(!t.includes(SUG_DESC_A), "a descrição sugerida de A sobreviveu à troca de anúncio");
      assert.ok(!SUG_TITULOS.some((sg) => t.includes(sg.titulo)), "os títulos gerados em A sobreviveram à troca de anúncio");
      assert.strictEqual(await cdp.evaluate("document.getElementById('am-det-modelo').value"), "B300",
        "o rascunho de modelo do anúncio A vazou para o anúncio B");
      assert.strictEqual(await cdp.evaluate("document.querySelectorAll('#am-det-savebar').length"), 0,
        "o anúncio B abriu já 'sujo' com a pendência do anúncio A");
    });

    /* ── 25 a 31: "Composição da margem" — sempre aberta, carrega com o modal ── */

    await check("25 — a seção 'Composição da margem' fica entre Fotos e Título, sem recolher, e já busca a composição ao abrir o modal (1 chamada)", async () => {
      // Página nova: os checks anteriores já abriram MLB-A1 e aqueceram o cache.
      await fecharModal(cdp);
      await cdp.send("Page.navigate", { url: `http://127.0.0.1:${porta}/anuncios-meli.html?cliente=n97&conta=42` });
      await esperarLista(cdp);
      pedidos.length = 0;
      chamadasPerformance.length = 0;
      await abrirPrimeiroAnuncio(cdp);
      const estado = await cdp.evaluate(`(function(){
        var d = document.getElementById('am-det-margem');
        var fotos = document.getElementById('am-det-fotos-corpo');
        var titulo = document.getElementById('am-det-titulo-ia') || document.querySelector('.am-det-scroll h4');
        var ordem = function(a, b){ return !!(a && b && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)); };
        var h4 = Array.from(document.querySelectorAll('#am-det-scroll h4')).find(function(h){ return /^Título$/.test(h.textContent.trim()); });
        return { existe: Boolean(d), details: d ? d.tagName === 'DETAILS' : null,
                 summary: d ? !!d.querySelector('summary') : null,
                 depoisDasFotos: ordem(fotos, d), antesDoTitulo: ordem(d, h4),
                 promoAoLado: !!(d && d.parentElement.querySelector('#am-det-promo')) }; })()`);
      assert.ok(estado.existe, "a seção de composição da margem não foi renderizada");
      assert.strictEqual(estado.details, false, "a seção não é mais recolhível (<details>)");
      assert.strictEqual(estado.summary, false, "sem <summary> para clicar");
      assert.strictEqual(estado.depoisDasFotos, true, "a composição vem depois das fotos");
      assert.strictEqual(estado.antesDoTitulo, true, "a composição vem antes do título");
      assert.strictEqual(estado.promoAoLado, true, "Promoções disponíveis continua ao lado da composição");
      await waitFor(cdp, `(function(){
        var b = document.querySelector('#am-det-margem-body');
        return b && /Custo do produto/.test(b.textContent); })()`, "o ladder não carregou sozinho ao abrir o modal");
    });

    await check("26 — a busca automática faz exatamente 1 chamada e mostra o ladder certo (margem projetada); campos editáveis têm lápis visível", async () => {
      assert.strictEqual(chamadasPerformance.length, 1, "abrir o modal devia disparar exatamente 1 chamada");
      assert.deepStrictEqual(chamadasPerformance[0].itemIds, ["MLB-A1"]);
      assert.strictEqual(chamadasPerformance[0].incluirComposicao, true);
      assert.strictEqual(chamadasPerformance[0].incluirMargem, true, "composição sempre pede margem junto");

      const linhas = await lerLinhasComposicao(cdp);
      assert.deepStrictEqual(linhas, [
        "Preço de venda R$ 200,00",
        "Custo do produto R$ 80,00",
        "Comissão Mercado Livre R$ 25,00",
        "Frete R$ 15,00",
        "Custos adicionais —",
        "Imposto (5,0%) R$ 10,00",
        "Margem R$ 70,00 (35,0%)",
      ], JSON.stringify(linhas));

      const badge = await cdp.evaluate("document.querySelector('#am-det-margem-body .am-margem-comp__badge').textContent");
      assert.match(badge, /35,0%/, `o badge tem de mostrar o percentual — sem alternância Realizada/Projetada (Margem = Margem Projetada, somente): ${badge}`);
      assert.ok(!/Realizada/.test(badge), `o badge NUNCA pode dizer "Realizada" — Margem = Margem Projetada, somente, nesta tela: ${badge}`);

      const editaveis = await cdp.evaluate(`(function(){
        var bs = Array.from(document.querySelectorAll('#am-det-margem-body .am-margem-edit__btn'));
        return { n: bs.length,
                 lapis: bs.every(function(b){ return !!b.querySelector('.am-margem-edit__lapis svg'); }),
                 borda: bs.every(function(b){ var c = getComputedStyle(b); return c.borderTopStyle !== 'none' && c.borderTopColor !== 'rgba(0, 0, 0, 0)'; }) }; })()`);
      assert.ok(editaveis.n >= 3, "Preço, Custo do produto e Custos adicionais são editáveis");
      assert.strictEqual(editaveis.lapis, true, "todo campo editável mostra o lápis sem precisar de hover");
      assert.strictEqual(editaveis.borda, true, "todo campo editável tem moldura visível sem hover");

      // Valor + lápis nunca quebram linha — nem na composição, nem na coluna
      // "Preço final" de Promoções disponíveis (coluna estreita).
      // A célula é espremida a 40px (como numa coluna estreita) só durante a medição.
      const quebrados = await cdp.evaluate(`Array.from(document.querySelectorAll('.am-det-margem-grid .am-margem-edit__btn')).filter(function(b){
        var cel = b.parentElement, antes = cel.style.cssText;
        cel.style.width = '40px'; cel.style.maxWidth = '40px'; cel.style.display = 'block';
        var r = document.createRange(); r.selectNodeContents(b.firstChild); // só o texto do valor
        var tops = {}; Array.from(r.getClientRects()).forEach(function(q){ if (q.width > 0) tops[Math.round(q.top)] = 1; });
        cel.style.cssText = antes;
        return Object.keys(tops).length > 1; }).map(function(b){ return b.textContent; })`);
      assert.deepStrictEqual(quebrados, [], "nenhum valor editável pode ocupar 2 linhas");
    });

    await check("27 — um re-render do modal (digitar no título) reaproveita o cache (0 chamada nova, ladder continua na tela)", async () => {
      const antes = chamadasPerformance.length;
      await cdp.evaluate(`(function(){ var t = document.getElementById('am-det-titulo'); t.value = t.value + ' x'; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      const temLadder = await cdp.evaluate("/Custo do produto/.test(document.getElementById('am-det-margem-body').textContent)");
      assert.strictEqual(temLadder, true, "o ladder continua na tela, sem 'carregando'");
      assert.strictEqual(chamadasPerformance.length, antes, "nenhuma chamada nova de /performance");
      await cdp.evaluate(`(function(){ var t = document.getElementById('am-det-titulo'); t.value = t.value.replace(/ x$/, ''); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    });

    await check("28 — fechar o modal e reabrir o do MESMO MLB reaproveita o cache (0 chamada nova)", async () => {
      const antes = chamadasPerformance.length;
      await fecharModal(cdp);
      await abrirPrimeiroAnuncio(cdp); // ainda conta 42 -> MLB-A1
      const corpoAntesDeClicar = await cdp.evaluate(`(function(){
        var b = document.getElementById('am-det-margem-body');
        return b ? b.textContent.replace(/\\s+/g, ' ').trim() : null; })()`);
      assert.match(corpoAntesDeClicar || "", /Custo do produtoR\$ 80,00/,
        "reabrir o modal do MESMO item_id devia mostrar o ladder JÁ PRONTO (cache)");
      assert.strictEqual(chamadasPerformance.length, antes,
        "reabrir o modal do mesmo MLB gastou uma chamada nova de /performance — o cache não é por item_id");
    });

    await check("29 — fechar e abrir o modal de OUTRO MLB NÃO herda a composição anterior (cache é por item_id)", async () => {
      await fecharModal(cdp);
      await cdp.evaluate("window.VF.context.setConta(43)");
      await waitFor(cdp, "document.querySelector('.am-row')", "o catálogo da conta 43 não voltou");
      const antes = chamadasPerformance.length;
      await abrirPrimeiroAnuncio(cdp); // MLB-B1
      assert.strictEqual(await cdp.evaluate("document.getElementById('am-det-titulo').value"), TITULO_B);

      const corpoFechado = await cdp.evaluate(`(function(){
        var b = document.getElementById('am-det-margem-body');
        return b ? b.textContent.trim() : null; })()`);
      assert.ok(!/R\$ 80,00/.test(corpoFechado || ""),
        "o modal de OUTRO MLB não pode abrir mostrando a composição de MLB-A1");

      await waitFor(cdp, `(function(){
        var b = document.querySelector('#am-det-margem-body');
        return b && /Custo do produto/.test(b.textContent); })()`, "o ladder de MLB-B1 não carregou");

      assert.strictEqual(chamadasPerformance.length, antes + 1, "MLB-B1 precisa de 1 chamada própria — não pode reaproveitar a de MLB-A1");
      assert.deepStrictEqual(chamadasPerformance[chamadasPerformance.length - 1].itemIds, ["MLB-B1"]);

      const linhas = await lerLinhasComposicao(cdp);
      assert.deepStrictEqual(linhas, [
        "Preço de venda R$ 150,00",
        "Custo do produto R$ 60,00",
        "Comissão Mercado Livre R$ 18,00",
        "Frete R$ 12,00",
        "Custos adicionais R$ 3,00",
        "Imposto (4,0%) R$ 6,00",
        "Margem R$ 30,00 (20,0%)",
      ], `MLB-B1 mostrou dados de outro item: ${JSON.stringify(linhas)}`);
    });

    await check("29b — voltar para o MLB-A1 continua com a composição DELE (as duas entradas de cache coexistem, por item_id)", async () => {
      const antes = chamadasPerformance.length;
      await fecharModal(cdp);
      await cdp.evaluate("window.VF.context.setConta(42)");
      await waitFor(cdp, "document.querySelector('.am-row')", "o catálogo da conta 42 não voltou");
      await abrirPrimeiroAnuncio(cdp); // MLB-A1 de novo
      const corpo = await cdp.evaluate(`(function(){
        var b = document.getElementById('am-det-margem-body');
        return b ? b.textContent.replace(/\\s+/g, ' ').trim() : null; })()`);
      assert.match(corpo || "", /Custo do produtoR\$ 80,00/,
        "MLB-A1 devia continuar com a própria composição (R$ 80,00 de custo) — não a de MLB-B1 (R$ 60,00)");
      assert.ok(!/R\$ 60,00/.test(corpo || ""), "a composição de MLB-B1 vazou para MLB-A1");
      assert.strictEqual(chamadasPerformance.length, antes,
        "MLB-A1 já tinha sido carregado antes — abrir os dois em sequência não pode custar chamada nova para nenhum dos dois");
    });

    await check("30 — margem indisponível no nível de CONTEXTO: mensagem real do backend, sem ladder", async () => {
      performanceHandler = (ids) => ({
        ok: true, metricas7d: {}, margem: {}, composicao: {},
        margemIndisponivel: { codigo: "BASE_MELI_NAO_VINCULADA", mensagem: "Base de custos MELI não vinculada para esta operação." },
      });
      try {
        pedidos.length = 0;
        chamadasPerformance.length = 0;
        await cdp.send("Page.navigate", { url: `http://127.0.0.1:${porta}/anuncios-meli.html?cliente=n97&conta=42` });
        await esperarLista(cdp);
        await abrirPrimeiroAnuncio(cdp);
        await waitFor(cdp, `(function(){
          var b = document.querySelector('#am-det-margem-body');
          return b && /Base de custos MELI não vinculada/.test(b.textContent); })()`, "a mensagem de contexto não apareceu");
        const semLadder = await cdp.evaluate("document.querySelectorAll('#am-det-margem-body .am-margem-comp__linha').length");
        assert.strictEqual(semLadder, 0, "contexto indisponível não pode mostrar nenhuma linha de composição, nem parcial");
      } finally {
        performanceHandler = null;
      }
    });

    await check("31 — item não-computável (UNVALIDADO): rótulo real do Motor, sem ladder", async () => {
      performanceHandler = (ids) => {
        const margem = {};
        ids.forEach((id) => { margem[id] = { origem: "projected", margin: null, marginPercent: null, profit: null, status: "UNVALIDATED", statusLabel: "Não validado", statusReasons: ["Variáveis obrigatórias ausentes: custo."] }; });
        return { ok: true, metricas7d: {}, margem, composicao: {}, margemIndisponivel: null };
      };
      try {
        pedidos.length = 0;
        chamadasPerformance.length = 0;
        await cdp.send("Page.navigate", { url: `http://127.0.0.1:${porta}/anuncios-meli.html?cliente=n97&conta=42` });
        await esperarLista(cdp);
        await abrirPrimeiroAnuncio(cdp);
        await waitFor(cdp, `(function(){
          var b = document.querySelector('#am-det-margem-body');
          return b && /Não validado/.test(b.textContent); })()`, "o rótulo real do Motor não apareceu");
        const semLadder = await cdp.evaluate("document.querySelectorAll('#am-det-margem-body .am-margem-comp__linha').length");
        assert.strictEqual(semLadder, 0, "item não-computável não pode mostrar nenhuma linha de composição, nem parcial");
      } finally {
        performanceHandler = null;
      }
    });

    await check("32 — prejuízo (LOSS): o ladder aparece COMPLETO, a margem final destaca a cor de risco", async () => {
      performanceHandler = (ids) => {
        const margem = {};
        const composicao = {};
        ids.forEach((id) => {
          margem[id] = { origem: "projected", margin: -0.05, marginPercent: -5, profit: -10, status: "LOSS", statusLabel: "Prejuízo", statusReasons: ["Margem negativa (-5.00%)."] };
          composicao[id] = { venda: 200, custoProduto: 150, comissaoMl: 30, frete: 20, taxaFixa: null, impostoPercentual: 0.05, impostoValor: 10 };
        });
        return { ok: true, metricas7d: {}, margem, composicao, margemIndisponivel: null };
      };
      try {
        pedidos.length = 0;
        chamadasPerformance.length = 0;
        await cdp.send("Page.navigate", { url: `http://127.0.0.1:${porta}/anuncios-meli.html?cliente=n97&conta=42` });
        await esperarLista(cdp);
        await abrirPrimeiroAnuncio(cdp);
        await waitFor(cdp, `(function(){
          var b = document.querySelector('#am-det-margem-body');
          return b && /Custo do produto/.test(b.textContent); })()`, "o ladder do prejuízo não carregou");

        const linhas = await lerLinhasComposicao(cdp);
        assert.deepStrictEqual(linhas, [
          "Preço de venda R$ 200,00",
          "Custo do produto R$ 150,00",
          "Comissão Mercado Livre R$ 30,00",
          "Frete R$ 20,00",
          "Custos adicionais —",
          "Imposto (5,0%) R$ 10,00",
          "Margem R$ -10,00 (-5,0%)",
        ], `o prejuízo escondeu o ladder em vez de mostrá-lo completo: ${JSON.stringify(linhas)}`);

        const badgeClasse = await cdp.evaluate("document.querySelector('#am-det-margem-body .am-margem__valor, #am-det-margem-body .am-margem__estado').className");
        assert.match(badgeClasse, /is-danger/, `prejuízo tem de usar a cor de risco no badge: ${badgeClasse}`);
      } finally {
        performanceHandler = null;
      }
    });

    /* ── 33 a 37: evolução da composição — Preço real, Custo/Custos
       adicionais como simulação ──────────────────────────────────────── */

    await check("33 — Preço: editar simula, 'Aplicar preço' abre diálogo, Confirmar grava no ML e a tela mostra o preço CONFIRMADO (não o digitado)", async () => {
      let precoConfirmado = false;
      performanceHandler = (ids) => {
        const margem = {}; const composicao = {};
        ids.forEach((id) => {
          margem[id] = MARGEM_MLA1;
          composicao[id] = precoConfirmado ? Object.assign({}, COMPOSICAO_MLA1, { venda: 205 }) : COMPOSICAO_MLA1;
        });
        return { ok: true, metricas7d: {}, margem, composicao, margemIndisponivel: null };
      };
      pedidos.length = 0;
      chamadasPerformance.length = 0;
      precoChamadas.length = 0;
      await cdp.send("Page.navigate", { url: `http://127.0.0.1:${porta}/anuncios-meli.html?cliente=n97&conta=42` });
      await esperarLista(cdp);
      await abrirPrimeiroAnuncio(cdp);
      await waitFor(cdp, `(function(){
        var b = document.querySelector('#am-det-margem-body');
        return b && /Custo do produto/.test(b.textContent); })()`, "o ladder inicial não carregou");

      // Editar o preço é SIMULAÇÃO — nenhum PATCH ainda, só "Aplicar preço" aparece.
      await confirmarEdicaoMargem(cdp, "preco", "210");
      await esperarPedido(/\/anuncios-meli\/MLB-A1\/simular-margem$/, 0, "editar o preço não simulou");
      assert.strictEqual(precoChamadas.length, 0, "simular o preço NUNCA pode chamar PATCH /:itemId/preco sozinho");
      await waitFor(cdp, "document.querySelector('#am-det-margem-body [data-acao=\"aplicar-preco\"]')",
        "o botão \"Aplicar preço no Mercado Livre\" não apareceu depois de simular");

      await clicarAplicarPreco(cdp);
      const linhasDialogo = await lerLinhasDialogoEscrita(cdp);
      assert.strictEqual(linhasDialogo.find((l) => l.rotulo === "Preço atual").valor, "R$ 200,00");
      assert.strictEqual(linhasDialogo.find((l) => l.rotulo === "Novo preço").valor, "R$ 210,00");

      precoResultado = { status: 200, corpo: { ok: true, preco: 205, moeda: "BRL" } };
      precoConfirmado = true;
      await confirmarDialogoEscrita(cdp);

      await esperarPedido(/\/anuncios-meli\/MLB-A1\/preco$/, 0, "o PATCH de preço não saiu depois de confirmar no diálogo");
      const envio = precoChamadas[precoChamadas.length - 1];
      assert.strictEqual(envio.body.clienteSlug, "n97");
      assert.strictEqual(String(envio.body.clienteContaId), "42");
      assert.strictEqual(envio.body.preco, 210, "o valor simulado precisa ir no PATCH");

      await waitFor(cdp, "!document.querySelector('.am-confirm-overlay')", "o diálogo deveria fechar depois do sucesso");
      await waitFor(cdp, `(function(){
        var b = document.querySelector('#am-det-margem-body [data-margem-campo="preco"] .am-margem-edit__btn');
        return b && /205/.test(b.textContent); })()`,
        "a tela deveria mostrar o preço CONFIRMADO pelo ML (205), não o digitado (210)");
      const botaoPreco = await cdp.evaluate(`document.querySelector('#am-det-margem-body [data-margem-campo="preco"] .am-margem-edit__btn').textContent`);
      assert.ok(!/210/.test(botaoPreco), `o valor digitado (210) não pode ficar exibido como se fosse o confirmado: ${botaoPreco}`);
      assert.strictEqual(await cdp.evaluate("!!document.querySelector('#am-det-margem-body [data-acao=\"aplicar-preco\"]')"), false,
        "sem simulação pendente (foi aplicada), o botão 'Aplicar preço' não pode continuar aparecendo");

      precoResultado = null;
      performanceHandler = null;
    });

    await check("33b — Enter no campo de preço SIMULA (nunca grava sozinho); Esc cancela sem chamar nada", async () => {
      pedidos.length = 0;
      precoChamadas.length = 0;
      simularMargemChamadas.length = 0;
      await abrirEdicaoMargem(cdp, "preco");
      await cdp.evaluate(`(function(){
        var e = document.querySelector('#am-det-margem-body [data-margem-campo="preco"] .am-margem-edit__input');
        e.value = "777";
        e.dispatchEvent(new Event('input', { bubbles: true }));
        e.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      })()`);
      await waitFor(cdp, "!document.querySelector('#am-det-margem-body [data-margem-campo=\"preco\"] .am-margem-edit__input')",
        "Esc deveria fechar o editor de preço sem salvar");
      assert.strictEqual(precoChamadas.length, 0, "Esc não pode gerar PATCH de preço");
      assert.strictEqual(simularMargemChamadas.length, 0, "Esc não pode nem simular");

      await confirmarEdicaoMargem(cdp, "preco", "210");
      await esperarPedido(/\/anuncios-meli\/MLB-A1\/simular-margem$/, 0, "Enter deveria simular o preço");
      assert.strictEqual(precoChamadas.length, 0, "Enter simula, mas NUNCA chama PATCH de preço sozinho — só \"Aplicar preço\" + confirmar no diálogo fazem isso");

      // Limpa a simulação pendente pra não vazar pro próximo check.
      await clicar(cdp, '#am-det-margem-body [data-acao="restaurar-simulacao-margem"]', "botão de restaurar não encontrado");
      await waitFor(cdp, "!document.querySelector('#am-det-margem-body [data-acao=\"aplicar-preco\"]')", "restaurar não limpou a simulação de preço");
    });

    await check("33c — 'Cancelar' no diálogo de \"Aplicar preço\" fecha sem chamar o Mercado Livre", async () => {
      pedidos.length = 0;
      precoChamadas.length = 0;
      await confirmarEdicaoMargem(cdp, "preco", "230");
      await waitFor(cdp, "document.querySelector('#am-det-margem-body [data-acao=\"aplicar-preco\"]')", "\"Aplicar preço\" não apareceu");
      await clicarAplicarPreco(cdp);
      await lerLinhasDialogoEscrita(cdp);
      await cancelarDialogoEscrita(cdp);
      assert.strictEqual(precoChamadas.length, 0, "cancelar o diálogo não pode chamar PATCH de preço");
      // A simulação pendente continua — cancelar o DIÁLOGO não descarta a simulação.
      assert.ok(await cdp.evaluate("!!document.querySelector('#am-det-margem-body [data-acao=\"aplicar-preco\"]')"),
        "cancelar o diálogo não deveria descartar a simulação pendente, só fechar o diálogo");

      await clicar(cdp, '#am-det-margem-body [data-acao="restaurar-simulacao-margem"]', "botão de restaurar não encontrado");
      await waitFor(cdp, "!document.querySelector('#am-det-margem-body [data-acao=\"aplicar-preco\"]')", "restaurar não limpou a simulação de preço");
    });

    await check("34 — falha do Mercado Livre ao aplicar preço mantém o diálogo aberto com o erro, sem perder o valor anterior na tela", async () => {
      pedidos.length = 0;
      chamadasPerformance.length = 0;
      precoChamadas.length = 0;
      await cdp.send("Page.navigate", { url: `http://127.0.0.1:${porta}/anuncios-meli.html?cliente=n97&conta=42` });
      await esperarLista(cdp);
      await abrirPrimeiroAnuncio(cdp);
      await waitFor(cdp, `(function(){
        var b = document.querySelector('#am-det-margem-body');
        return b && /Custo do produto/.test(b.textContent); })()`, "o ladder inicial não carregou");

      await confirmarEdicaoMargem(cdp, "preco", "999");
      await waitFor(cdp, "document.querySelector('#am-det-margem-body [data-acao=\"aplicar-preco\"]')", "\"Aplicar preço\" não apareceu");
      await clicarAplicarPreco(cdp);
      await lerLinhasDialogoEscrita(cdp);

      precoResultado = {
        status: 200,
        corpo: { ok: false, codigo: "item.price.not_modifiable", motivo: "Este anúncio tem automatização de preço ativa no Mercado Livre." },
      };
      await confirmarDialogoEscrita(cdp);
      await esperarPedido(/\/anuncios-meli\/MLB-A1\/preco$/, 0, "o PATCH de preço não saiu");

      await waitFor(cdp, "/automatização de preço/.test(document.querySelector('.am-confirm-overlay').textContent)",
        "a recusa do Mercado Livre deveria aparecer DENTRO do diálogo, sem fechá-lo");
      assert.ok(await cdp.evaluate("!!document.querySelector('.am-confirm-overlay')"),
        "o diálogo tem de continuar aberto depois de uma recusa do Mercado Livre");

      // A recusa NÃO descarta a simulação pendente (o operador pode tentar de
      // novo, ou trocar o valor) — a linha continua mostrando o simulado (999),
      // nunca um valor "confiado" que o ML na verdade recusou.
      const precoNaTela = await cdp.evaluate(
        `document.querySelector('#am-det-margem-body [data-margem-campo="preco"] .am-margem-edit__btn').textContent`
      );
      assert.ok(/999/.test(precoNaTela), `a simulação pendente deveria continuar visível (999) por trás do diálogo: ${precoNaTela}`);

      await cancelarDialogoEscrita(cdp);
      assert.ok(await cdp.evaluate("!!document.querySelector('#am-det-margem-body [data-acao=\"aplicar-preco\"]')"),
        "depois de cancelar o diálogo de uma recusa, 'Aplicar preço' precisa continuar disponível pra tentar de novo");

      await clicar(cdp, '#am-det-margem-body [data-acao="restaurar-simulacao-margem"]', "botão de restaurar não encontrado");
      precoResultado = null;
    });

    await check("35 — simular Custo do produto e Custos adicionais mostra 'Margem simulada', sem chamar o ML nem a Base", async () => {
      pedidos.length = 0;
      chamadasPerformance.length = 0;
      simularMargemChamadas.length = 0;
      precoChamadas.length = 0;
      await cdp.send("Page.navigate", { url: `http://127.0.0.1:${porta}/anuncios-meli.html?cliente=n97&conta=42` });
      await esperarLista(cdp);
      await abrirPrimeiroAnuncio(cdp);
      await waitFor(cdp, `(function(){
        var b = document.querySelector('#am-det-margem-body');
        return b && /Custo do produto/.test(b.textContent); })()`, "o ladder inicial não carregou");

      simularMargemHandler = () => ({
        ok: true, simulado: true, origem: "projected",
        resultado: { computable: true, profit: 55, margin: 0.275, marginPercent: 27.5, missing: [], assumed: [] },
      });

      await confirmarEdicaoMargem(cdp, "custoProduto", "50");
      await esperarPedido(/\/anuncios-meli\/MLB-A1\/simular-margem$/, 0, "a simulação de custo não chamou o backend");
      let envio = simularMargemChamadas[simularMargemChamadas.length - 1];
      assert.strictEqual(envio.body.custoProduto, 50);
      assert.strictEqual(envio.body.custosAdicionais, undefined, "sem override de custos adicionais, o campo não deveria ir no corpo");

      await waitFor(cdp, `/Margem simulada/.test(document.getElementById('am-det-margem-body').textContent)`,
        "o rótulo 'Margem simulada' não apareceu");
      let texto = await cdp.evaluate("document.getElementById('am-det-margem-body').textContent");
      assert.match(texto, /R\$\s*55,00/, `a margem simulada não apareceu: ${texto}`);
      assert.match(texto, /27,5%/, `o percentual simulado não apareceu: ${texto}`);

      // Combinar os dois overrides: a segunda chamada precisa levar AMBOS.
      const antesChamadas = simularMargemChamadas.length;
      await confirmarEdicaoMargem(cdp, "custosAdicionais", "8");
      for (let i = 0; i < 100 && simularMargemChamadas.length <= antesChamadas; i++) await sleep(50);
      assert.ok(simularMargemChamadas.length > antesChamadas, "a simulação de custos adicionais não disparou uma nova chamada");
      envio = simularMargemChamadas[simularMargemChamadas.length - 1];
      assert.strictEqual(envio.body.custoProduto, 50, "o override de custo já ativo precisa continuar indo junto");
      assert.strictEqual(envio.body.custosAdicionais, 8);

      assert.strictEqual(precoChamadas.length, 0, "simular custo/custos adicionais não pode chamar PATCH de preço");
      assert.ok(!pedidos.some((u) => /\/bases\//.test(u)), "simulação não pode gravar na Base de Custos");

      simularMargemHandler = null;
    });

    await check("36 — 'Restaurar' descarta a simulação e volta para a margem real do Motor", async () => {
      await clicar(cdp, '#am-det-margem-body [data-acao="restaurar-simulacao-margem"]', "botão de restaurar não encontrado");
      await waitFor(cdp, `!/Margem simulada/.test(document.getElementById('am-det-margem-body').textContent)`,
        "a simulação não foi descartada");
      const texto = await cdp.evaluate("document.getElementById('am-det-margem-body').textContent");
      assert.match(texto, /R\$\s*70,00/, `a margem real (do Motor) deveria voltar a aparecer: ${texto}`);
    });

    await check("37 — item legado com variações (sem promoção): preço vira SIMULAÇÃO, nunca tenta PUT", async () => {
      variationsCountAtivo = 3;
      try {
        pedidos.length = 0;
        chamadasPerformance.length = 0;
        precoChamadas.length = 0;
        simularMargemChamadas.length = 0;
        await cdp.send("Page.navigate", { url: `http://127.0.0.1:${porta}/anuncios-meli.html?cliente=n97&conta=42` });
        await esperarLista(cdp);
        await abrirPrimeiroAnuncio(cdp);
        await waitFor(cdp, `(function(){
          var b = document.querySelector('#am-det-margem-body');
          return b && /Custo do produto/.test(b.textContent); })()`, "o ladder não carregou");

        const estado = await cdp.evaluate(`(function(){
          return {
            temBotaoAplicarPreco: !!document.querySelector('#am-det-margem-body [data-acao="aplicar-preco"]'),
            temCampoSimulacao: !!document.querySelector('#am-det-margem-body [data-margem-campo="preco"]'),
            motivo: (document.querySelector('#am-det-margem-body [data-margem-campo="preco"] .am-margem-edit__btn') || {}).title || "",
          };
        })()`);
        assert.strictEqual(estado.temBotaoAplicarPreco, false, "sem simulação nenhuma ainda, 'Aplicar preço' não pode aparecer");
        assert.ok(estado.temCampoSimulacao, "a linha de preço precisa virar um campo de simulação ([data-margem-campo=\"preco\"])");
        assert.match(estado.motivo, /não grava no Mercado Livre/i, `o motivo não explica que é só simulação: ${estado.motivo}`);
        assert.match(estado.motivo, /variações/i, `o motivo não menciona variações: ${estado.motivo}`);

        await confirmarEdicaoMargem(cdp, "preco", "250");
        await esperarPedido(/\/anuncios-meli\/MLB-A1\/simular-margem$/, 0, "a simulação de preço não chamou o backend");
        const envio = simularMargemChamadas[simularMargemChamadas.length - 1];
        assert.strictEqual(envio.body.preco, 250, "o preço digitado precisa ir como override em /simular-margem");
        assert.strictEqual(precoChamadas.length, 0, "simular preço NUNCA pode chamar PATCH /:itemId/preco");

        await waitFor(cdp, `/Margem simulada/.test(document.getElementById('am-det-margem-body').textContent)`,
          "o rótulo 'Margem simulada' não apareceu depois de simular o preço");
        assert.strictEqual(await cdp.evaluate("!!document.querySelector('#am-det-margem-body [data-acao=\"aplicar-preco\"]')"), false,
          "mesmo com uma simulação de preço pendente, 'Aplicar preço' NUNCA pode aparecer pra item com variações (o PUT real seria recusado)");
      } finally {
        variationsCountAtivo = 0;
      }
    });

    await check("37b — item legado: combinar preço + custo + custos adicionais envia os TRÊS overrides", async () => {
      variationsCountAtivo = 3;
      try {
        pedidos.length = 0;
        chamadasPerformance.length = 0;
        simularMargemChamadas.length = 0;
        await cdp.send("Page.navigate", { url: `http://127.0.0.1:${porta}/anuncios-meli.html?cliente=n97&conta=42` });
        await esperarLista(cdp);
        await abrirPrimeiroAnuncio(cdp);
        await waitFor(cdp, `(function(){
          var b = document.querySelector('#am-det-margem-body');
          return b && /Custo do produto/.test(b.textContent); })()`, "o ladder não carregou");

        await confirmarEdicaoMargem(cdp, "preco", "250");
        await esperarPedido(/\/anuncios-meli\/MLB-A1\/simular-margem$/, 0, "a simulação de preço não chamou o backend");

        let antesChamadas = simularMargemChamadas.length;
        await confirmarEdicaoMargem(cdp, "custoProduto", "50");
        for (let i = 0; i < 100 && simularMargemChamadas.length <= antesChamadas; i++) await sleep(50);
        assert.ok(simularMargemChamadas.length > antesChamadas, "a simulação de custo não disparou uma nova chamada");

        antesChamadas = simularMargemChamadas.length;
        await confirmarEdicaoMargem(cdp, "custosAdicionais", "8");
        for (let i = 0; i < 100 && simularMargemChamadas.length <= antesChamadas; i++) await sleep(50);
        assert.ok(simularMargemChamadas.length > antesChamadas, "a simulação de custos adicionais não disparou uma nova chamada");

        const envio = simularMargemChamadas[simularMargemChamadas.length - 1];
        assert.strictEqual(envio.body.preco, 250, "o override de preço já ativo precisa continuar indo junto");
        assert.strictEqual(envio.body.custoProduto, 50, "o override de custo já ativo precisa continuar indo junto");
        assert.strictEqual(envio.body.custosAdicionais, 8);
        assert.strictEqual(precoChamadas.length, 0, "combinar overrides de simulação NUNCA pode chamar PATCH de preço");
      } finally {
        variationsCountAtivo = 0;
      }
    });

    await check("37c — item legado: 'Restaurar' descarta o override de preço junto com os demais", async () => {
      variationsCountAtivo = 3;
      try {
        pedidos.length = 0;
        chamadasPerformance.length = 0;
        await cdp.send("Page.navigate", { url: `http://127.0.0.1:${porta}/anuncios-meli.html?cliente=n97&conta=42` });
        await esperarLista(cdp);
        await abrirPrimeiroAnuncio(cdp);
        await waitFor(cdp, `(function(){
          var b = document.querySelector('#am-det-margem-body');
          return b && /Custo do produto/.test(b.textContent); })()`, "o ladder não carregou");

        await confirmarEdicaoMargem(cdp, "preco", "250");
        await esperarPedido(/\/anuncios-meli\/MLB-A1\/simular-margem$/, 0, "a simulação de preço não chamou o backend");
        await waitFor(cdp, `/Margem simulada/.test(document.getElementById('am-det-margem-body').textContent)`,
          "a simulação não ativou");

        await clicar(cdp, '#am-det-margem-body [data-acao="restaurar-simulacao-margem"]', "botão de restaurar não encontrado");
        await waitFor(cdp, `!/Margem simulada/.test(document.getElementById('am-det-margem-body').textContent)`,
          "restaurar não descartou a simulação");

        const valorCampo = await cdp.evaluate(
          `document.querySelector('#am-det-margem-body [data-margem-campo="preco"]').getAttribute('data-margem-valor')`
        );
        assert.strictEqual(valorCampo, "200", "depois de restaurar, o campo precisa voltar a mostrar o preço REAL (200), sem o override");
      } finally {
        variationsCountAtivo = 0;
      }
    });

    await check("38b — promoção ativa vence variações: mesmo com variations_count > 0, o preço fica só bloqueado (sem simulação)", async () => {
      variationsCountAtivo = 3;
      performanceHandler = (ids) => {
        const margem = {}; const composicao = {};
        ids.forEach((id) => {
          margem[id] = MARGEM_MLA1;
          composicao[id] = Object.assign({}, COMPOSICAO_MLA1, { precoPromocionalAtivo: true });
        });
        return { ok: true, metricas7d: {}, margem, composicao, margemIndisponivel: null };
      };
      try {
        pedidos.length = 0;
        chamadasPerformance.length = 0;
        precoChamadas.length = 0;
        await cdp.send("Page.navigate", { url: `http://127.0.0.1:${porta}/anuncios-meli.html?cliente=n97&conta=42` });
        await esperarLista(cdp);
        await abrirPrimeiroAnuncio(cdp);
        await waitFor(cdp, `(function(){
          var b = document.querySelector('#am-det-margem-body');
          return b && /Custo do produto/.test(b.textContent); })()`, "o ladder não carregou");

        const estado = await cdp.evaluate(`(function(){
          return {
            temCampoSimulacao: !!document.querySelector('#am-det-margem-body [data-margem-campo="preco"]'),
            temBotaoAplicarPreco: !!document.querySelector('#am-det-margem-body [data-acao="aplicar-preco"]'),
            valor: document.querySelector('#am-det-margem-body .am-margem-comp__valor--bloqueado').textContent.trim(),
          };
        })()`);
        assert.strictEqual(estado.temCampoSimulacao, false, "promoção ativa vence — não pode virar campo de simulação de preço");
        assert.strictEqual(estado.temBotaoAplicarPreco, false, "promoção ativa vence — 'Aplicar preço' não pode aparecer");
        assert.strictEqual(estado.valor, "R$ 200,00", "o valor bloqueado continua sendo o efetivo/promocional");
      } finally {
        variationsCountAtivo = 0;
        performanceHandler = null;
      }
    });

    await check("38 — item com promoção ativa: edição de preço vem BLOQUEADA de cara, sem tag \"Altera no Mercado Livre\", com motivo explicado", async () => {
      performanceHandler = (ids) => {
        const margem = {}; const composicao = {};
        ids.forEach((id) => {
          margem[id] = MARGEM_MLA1;
          composicao[id] = Object.assign({}, COMPOSICAO_MLA1, { precoPromocionalAtivo: true });
        });
        return { ok: true, metricas7d: {}, margem, composicao, margemIndisponivel: null };
      };
      try {
        pedidos.length = 0;
        chamadasPerformance.length = 0;
        precoChamadas.length = 0;
        await cdp.send("Page.navigate", { url: `http://127.0.0.1:${porta}/anuncios-meli.html?cliente=n97&conta=42` });
        await esperarLista(cdp);
        await abrirPrimeiroAnuncio(cdp);
        await waitFor(cdp, `(function(){
          var b = document.querySelector('#am-det-margem-body');
          return b && /Custo do produto/.test(b.textContent); })()`, "o ladder não carregou");

        const estado = await cdp.evaluate(`(function(){
          var linha = document.querySelector('#am-det-margem-body .am-margem-comp__linha--editavel');
          return {
            temCampoSimulacao: !!document.querySelector('#am-det-margem-body [data-margem-campo="preco"]'),
            temBotaoAplicarPreco: !!document.querySelector('#am-det-margem-body [data-acao="aplicar-preco"]'),
            temInfoDot: !!linha.querySelector('.vf-info-dot'),
            valor: document.querySelector('#am-det-margem-body .am-margem-comp__valor--bloqueado').textContent.trim(),
          };
        })()`);
        assert.strictEqual(estado.temCampoSimulacao, false, "promoção ativa não pode oferecer nem simulação de preço");
        assert.strictEqual(estado.temBotaoAplicarPreco, false, "promoção ativa não pode oferecer 'Aplicar preço'");
        assert.ok(estado.temInfoDot, "o motivo do bloqueio precisa aparecer (ⓘ), não sumir em silêncio");
        assert.strictEqual(estado.valor, "R$ 200,00", "o valor exibido continua sendo o preço efetivo/promocional, só não editável");

        assert.strictEqual(precoChamadas.length, 0, "nenhuma tentativa de PATCH pode ter acontecido — nem foi oferecida a edição");
      } finally {
        performanceHandler = null;
      }
    });

    await check("39 — 'Promoções disponíveis' carrega em segundo plano (sem bloquear a abertura do modal) e mostra ATIVA + ELEGÍVEL lado a lado", async () => {
      promocoesRespostaPadrao = [PROMO_ATIVA, PROMO_CANDIDATE];
      try {
        pedidos.length = 0;
        promocoesChamadas.length = 0;
        await cdp.send("Page.navigate", { url: `http://127.0.0.1:${porta}/anuncios-meli.html?cliente=n97&conta=42` });
        await esperarLista(cdp);
        await abrirPrimeiroAnuncio(cdp);
        // O modal (título já carregado) existe antes de garantirmos que as
        // promoções chegaram — prova de que a busca não atrasou a abertura.
        assert.ok(await cdp.evaluate("!!document.getElementById('am-det-promo')"),
          "a seção 'Promoções disponíveis' precisa existir assim que o modal abre");

        await waitFor(cdp, "document.querySelectorAll('#am-det-promo-body .am-promo__linha').length === 2",
          "as duas linhas de promoção não apareceram");
        assert.ok(promocoesChamadas.includes("MLB-A1"), "GET /:itemId/promocoes não foi chamado");

        const linhas = await cdp.evaluate(`Array.from(document.querySelectorAll('#am-det-promo-body .am-promo__linha')).map(function (tr) {
          return {
            nome: tr.querySelector('.am-promo__nome').textContent.trim(),
            status: tr.querySelector('.vf-status').textContent.trim(),
            desconto: tr.querySelector('td:nth-child(2)').textContent.replace(/\\s+/g, ' ').trim(),
            precoFinal: tr.querySelector('.am-promo__preco').textContent.trim(),
            subsidioMl: tr.querySelector('.am-promo__subsidio').textContent.trim(),
            acao: tr.querySelector('[data-acao="promo-acao"]').textContent.trim(),
          };
        })`);

        assert.strictEqual(linhas[0].nome, "HOTSALE");
        assert.strictEqual(linhas[0].status, "ATIVA");
        assert.ok(/R\$ 50,00/.test(linhas[0].desconto) && /20,0%/.test(linhas[0].desconto), `desconto da ativa inesperado: ${linhas[0].desconto}`);
        assert.strictEqual(linhas[0].precoFinal, "R$ 199,90");
        assert.strictEqual(linhas[0].subsidioMl, "R$ 2,50", "Subsídio ML precisa vir em R$, nunca em percentual");
        assert.strictEqual(linhas[0].acao, "Alterar", "promoção ativa/agendada precisa oferecer 'Alterar'");

        assert.strictEqual(linhas[1].nome, "Desconto individual", "sem nome próprio, cai para o rótulo do tipo");
        assert.strictEqual(linhas[1].status, "ELEGÍVEL");
        assert.ok(/R\$ 25,00/.test(linhas[1].desconto) && /10,0%/.test(linhas[1].desconto), `desconto da candidate inesperado: ${linhas[1].desconto}`);
        assert.strictEqual(linhas[1].precoFinal, "R$ 224,90");
        assert.strictEqual(linhas[1].subsidioMl, "—", "sem meli_percentage do ML, a coluna mostra — (nunca um valor inventado)");
        // PRICE_DISCOUNT está fora do escopo de escrita desta v1 (só
        // DEAL/SELLER_CAMPAIGN — ver auditoria) — o rótulo nunca pode
        // sugerir uma participação real que a tela não sabe fazer.
        assert.strictEqual(linhas[1].acao, "Simular", "tipo fora do escopo de escrita (PRICE_DISCOUNT) tem de oferecer só 'Simular'");
      } finally {
        promocoesRespostaPadrao = [];
      }
    });

    await check("39b — editar 'Preço final' de uma linha ATIVA dispara SIMULAÇÃO (nunca PATCH de preço), e 'Você recebe' acompanha só a linha selecionada", async () => {
      promocoesRespostaPadrao = [PROMO_ATIVA, PROMO_CANDIDATE];
      try {
        pedidos.length = 0;
        simularMargemChamadas.length = 0;
        precoChamadas.length = 0;
        await cdp.send("Page.navigate", { url: `http://127.0.0.1:${porta}/anuncios-meli.html?cliente=n97&conta=42` });
        await esperarLista(cdp);
        await abrirPrimeiroAnuncio(cdp);
        await waitFor(cdp, "document.querySelectorAll('#am-det-promo-body .am-promo__linha').length === 2",
          "as linhas de promoção não apareceram");

        await confirmarEdicaoPromoPreco(cdp, "P-1::DEAL", "180");

        for (let i = 0; i < 100 && simularMargemChamadas.length === 0; i++) await sleep(50);
        assert.strictEqual(simularMargemChamadas.length, 1, "editar o preço final da promoção precisa chamar POST /simular-margem");
        assert.strictEqual(simularMargemChamadas[0].body.preco, 180, "o override enviado precisa ser o preço final digitado");
        assert.strictEqual(precoChamadas.length, 0, "editar o preço final da promoção NUNCA pode chamar PATCH /:itemId/preco");

        await waitFor(cdp, `(function(){
          var el = document.querySelector('.am-promo__linha[data-promo-key="P-1::DEAL"] .am-promo__recebe');
          return el && /R\\$\\s*99,00/.test(el.textContent);
        })()`, "'Você recebe' da linha simulada não apareceu");

        const recebeCandidate = await cdp.evaluate(
          `document.querySelector('.am-promo__linha[data-promo-key="PD-1::PRICE_DISCOUNT"] .am-promo__recebe').textContent.trim()`
        );
        assert.strictEqual(recebeCandidate, "—", "a linha NÃO selecionada não pode mostrar 'Você recebe' de outra simulação");
      } finally {
        promocoesRespostaPadrao = [];
      }
    });

    await check("39c — 'Simular' numa linha ELEGÍVEL fora do escopo de escrita (PRICE_DISCOUNT) seleciona e aplica o preço sugerido na simulação, e NUNCA vira um botão de escrita", async () => {
      promocoesRespostaPadrao = [PROMO_ATIVA, PROMO_CANDIDATE];
      try {
        pedidos.length = 0;
        simularMargemChamadas.length = 0;
        precoChamadas.length = 0;
        aplicarPromocaoChamadas.length = 0;
        await cdp.send("Page.navigate", { url: `http://127.0.0.1:${porta}/anuncios-meli.html?cliente=n97&conta=42` });
        await esperarLista(cdp);
        await abrirPrimeiroAnuncio(cdp);
        await waitFor(cdp, "document.querySelectorAll('#am-det-promo-body .am-promo__linha').length === 2",
          "as linhas de promoção não apareceram");

        await clicar(cdp, '.am-promo__linha[data-promo-key="PD-1::PRICE_DISCOUNT"] [data-acao="promo-acao"]', "botão 'Simular' não encontrado");

        for (let i = 0; i < 100 && simularMargemChamadas.length === 0; i++) await sleep(50);
        assert.strictEqual(simularMargemChamadas.length, 1);
        assert.strictEqual(simularMargemChamadas[0].body.preco, 224.9, "'Simular' precisa aplicar o precoFinal (sugerido) da própria linha");
        assert.strictEqual(precoChamadas.length, 0, "NUNCA pode escrever no Mercado Livre (sem PATCH de preço)");
        assert.strictEqual(aplicarPromocaoChamadas.length, 0, "NUNCA pode chamar o endpoint de escrita de promoção");

        await waitFor(cdp, `(function(){
          var el = document.querySelector('.am-promo__linha[data-promo-key="PD-1::PRICE_DISCOUNT"] .am-promo__recebe');
          return el && /R\\$\\s*99,00/.test(el.textContent);
        })()`, "'Você recebe' da linha elegível selecionada não apareceu");

        const recebeAtiva = await cdp.evaluate(
          `document.querySelector('.am-promo__linha[data-promo-key="P-1::DEAL"] .am-promo__recebe').textContent.trim()`
        );
        assert.strictEqual(recebeAtiva, "—", "selecionar outra linha move o 'Você recebe' — a anterior some");

        // Mesmo depois de simulado, PRICE_DISCOUNT continua "Simular" — nunca
        // "Confirmar participação" (fora do escopo de escrita desta v1).
        const acaoDepois = await cdp.evaluate(
          `document.querySelector('.am-promo__linha[data-promo-key="PD-1::PRICE_DISCOUNT"] [data-acao="promo-acao"]').textContent.trim()`
        );
        assert.strictEqual(acaoDepois, "Simular", "tipo fora do escopo de escrita não pode virar 'Confirmar participação' mesmo depois de simulado");
      } finally {
        promocoesRespostaPadrao = [];
      }
    });

    await check("39d — restaurar a simulação limpa a seleção da promoção e o preço final volta ao valor do Mercado Livre", async () => {
      promocoesRespostaPadrao = [PROMO_ATIVA, PROMO_CANDIDATE];
      try {
        pedidos.length = 0;
        await cdp.send("Page.navigate", { url: `http://127.0.0.1:${porta}/anuncios-meli.html?cliente=n97&conta=42` });
        await esperarLista(cdp);
        await abrirPrimeiroAnuncio(cdp);
        await waitFor(cdp, "document.querySelectorAll('#am-det-promo-body .am-promo__linha').length === 2",
          "as linhas de promoção não apareceram");

        await confirmarEdicaoPromoPreco(cdp, "P-1::DEAL", "180");
        await waitFor(cdp, `(function(){
          var el = document.querySelector('.am-promo__linha[data-promo-key="P-1::DEAL"] .am-promo__preco');
          return el && el.textContent.trim() === 'R$ 180,00';
        })()`, "o preço final simulado não foi exibido");

        await waitFor(cdp, "document.querySelector('[data-acao=\"restaurar-simulacao-margem\"]')",
          "o botão '↺ real' não apareceu na composição");
        await clicar(cdp, '[data-acao="restaurar-simulacao-margem"]');

        await waitFor(cdp, `(function(){
          var el = document.querySelector('.am-promo__linha[data-promo-key="P-1::DEAL"] .am-promo__preco');
          return el && el.textContent.trim() === 'R$ 199,90';
        })()`, "restaurar não devolveu o preço final ao valor do Mercado Livre");

        const recebe = await cdp.evaluate(
          `document.querySelector('.am-promo__linha[data-promo-key="P-1::DEAL"] .am-promo__recebe').textContent.trim()`
        );
        assert.strictEqual(recebe, "—", "restaurar precisa limpar a seleção — 'Você recebe' some");
      } finally {
        promocoesRespostaPadrao = [];
      }
    });

    await check("39e — sem nenhuma promoção disponível: estado vazio explicado, sem tabela", async () => {
      promocoesRespostaPadrao = [];
      pedidos.length = 0;
      await cdp.send("Page.navigate", { url: `http://127.0.0.1:${porta}/anuncios-meli.html?cliente=n97&conta=42` });
      await esperarLista(cdp);
      await abrirPrimeiroAnuncio(cdp);

      await waitFor(cdp, `(function(){
        var b = document.getElementById('am-det-promo-body');
        return b && /Nenhuma promoç/i.test(b.textContent);
      })()`, "o estado vazio de promoções não apareceu");
      const temTabela = await cdp.evaluate("!!document.querySelector('#am-det-promo-body table')");
      assert.strictEqual(temTabela, false, "sem promoção nenhuma, a tabela não pode aparecer");
    });

    /* ── 40 a 40e: escrita real de promoção (só DEAL/SELLER_CAMPAIGN,
       ver auditoria) — Participar/Alterar → simula → Confirmar participação/
       Confirmar alteração → diálogo → POST/PUT via
       /anuncios-meli/:itemId/promocoes/:promotionId/aplicar ──────────────── */

    await check("40 — DEAL candidate: 'Participar' simula, vira 'Confirmar participação', e confirmar no diálogo chama o endpoint de escrita", async () => {
      promocoesRespostaPadrao = [PROMO_CANDIDATE_DEAL];
      try {
        pedidos.length = 0;
        simularMargemChamadas.length = 0;
        aplicarPromocaoChamadas.length = 0;
        promocoesChamadas.length = 0;
        await cdp.send("Page.navigate", { url: `http://127.0.0.1:${porta}/anuncios-meli.html?cliente=n97&conta=42` });
        await esperarLista(cdp);
        await abrirPrimeiroAnuncio(cdp);
        await waitFor(cdp, "document.querySelectorAll('#am-det-promo-body .am-promo__linha').length === 1",
          "a linha da promoção DEAL candidate não apareceu");

        const acaoInicial = await cdp.evaluate(
          `document.querySelector('.am-promo__linha[data-promo-key="P-2::DEAL"] [data-acao="promo-acao"]').textContent.trim()`
        );
        assert.strictEqual(acaoInicial, "Participar");

        await clicar(cdp, '.am-promo__linha[data-promo-key="P-2::DEAL"] [data-acao="promo-acao"]', "botão 'Participar' não encontrado");
        for (let i = 0; i < 100 && simularMargemChamadas.length === 0; i++) await sleep(50);
        assert.strictEqual(simularMargemChamadas.length, 1, "'Participar' precisa simular antes de qualquer escrita");
        assert.strictEqual(aplicarPromocaoChamadas.length, 0, "o primeiro clique NUNCA pode escrever — só seleciona e simula");

        await waitFor(cdp, `(function(){
          var b = document.querySelector('.am-promo__linha[data-promo-key="P-2::DEAL"] [data-acao="promo-acao"]');
          return b && b.textContent.trim() === "Confirmar participação";
        })()`, "o botão não virou 'Confirmar participação' depois de simular");

        await clicar(cdp, '.am-promo__linha[data-promo-key="P-2::DEAL"] [data-acao="promo-acao"]', "botão 'Confirmar participação' não encontrado");
        const linhasDialogo = await lerLinhasDialogoEscrita(cdp);
        assert.strictEqual(linhasDialogo.find((l) => l.rotulo === "Promoção").valor, "Semana do Cliente");
        assert.strictEqual(linhasDialogo.find((l) => l.rotulo === "Preço atual").valor, "R$ 249,90");
        assert.strictEqual(linhasDialogo.find((l) => l.rotulo === "Novo preço").valor, "R$ 224,90");

        await confirmarDialogoEscrita(cdp);
        for (let i = 0; i < 100 && aplicarPromocaoChamadas.length === 0; i++) await sleep(50);
        assert.strictEqual(aplicarPromocaoChamadas.length, 1, "confirmar no diálogo precisa chamar o endpoint de escrita");
        const envio = aplicarPromocaoChamadas[0];
        assert.strictEqual(envio.itemId, "MLB-A1");
        assert.strictEqual(envio.promotionId, "P-2");
        assert.strictEqual(envio.body.precoNovo, 224.9);
        assert.strictEqual(envio.body.clienteSlug, "n97");

        await waitFor(cdp, "!document.querySelector('.am-confirm-overlay')", "o diálogo deveria fechar depois do sucesso");
        for (let i = 0; i < 100 && promocoesChamadas.length < 2; i++) await sleep(50);
        assert.ok(promocoesChamadas.length >= 2, "depois de aplicar, a lista de promoções precisa ser relida do zero (não confiar no cache)");
      } finally {
        promocoesRespostaPadrao = [];
      }
    });

    await check("40b — DEAL started sem rebate: 'Alterar' simula, vira 'Confirmar alteração', e confirmar chama o mesmo endpoint de escrita", async () => {
      promocoesRespostaPadrao = [PROMO_ATIVA_SEM_REBATE];
      try {
        pedidos.length = 0;
        simularMargemChamadas.length = 0;
        aplicarPromocaoChamadas.length = 0;
        await cdp.send("Page.navigate", { url: `http://127.0.0.1:${porta}/anuncios-meli.html?cliente=n97&conta=42` });
        await esperarLista(cdp);
        await abrirPrimeiroAnuncio(cdp);
        await waitFor(cdp, "document.querySelectorAll('#am-det-promo-body .am-promo__linha').length === 1",
          "a linha da promoção DEAL ativa não apareceu");

        await confirmarEdicaoPromoPreco(cdp, "P-1::DEAL", "180");
        await waitFor(cdp, `(function(){
          var b = document.querySelector('.am-promo__linha[data-promo-key="P-1::DEAL"] [data-acao="promo-acao"]');
          return b && b.textContent.trim() === "Confirmar alteração";
        })()`, "o botão não virou 'Confirmar alteração' depois de editar o preço final");

        await clicar(cdp, '.am-promo__linha[data-promo-key="P-1::DEAL"] [data-acao="promo-acao"]', "botão 'Confirmar alteração' não encontrado");
        const linhasDialogo = await lerLinhasDialogoEscrita(cdp);
        assert.strictEqual(linhasDialogo.find((l) => l.rotulo === "Novo preço").valor, "R$ 180,00");

        await confirmarDialogoEscrita(cdp);
        for (let i = 0; i < 100 && aplicarPromocaoChamadas.length === 0; i++) await sleep(50);
        assert.strictEqual(aplicarPromocaoChamadas.length, 1);
        assert.strictEqual(aplicarPromocaoChamadas[0].promotionId, "P-1");
        assert.strictEqual(aplicarPromocaoChamadas[0].body.precoNovo, 180);
      } finally {
        promocoesRespostaPadrao = [];
      }
    });

    await check("40c — 'Cancelar' no diálogo de promoção fecha sem chamar o endpoint de escrita", async () => {
      promocoesRespostaPadrao = [PROMO_CANDIDATE_DEAL];
      try {
        pedidos.length = 0;
        aplicarPromocaoChamadas.length = 0;
        await cdp.send("Page.navigate", { url: `http://127.0.0.1:${porta}/anuncios-meli.html?cliente=n97&conta=42` });
        await esperarLista(cdp);
        await abrirPrimeiroAnuncio(cdp);
        await waitFor(cdp, "document.querySelectorAll('#am-det-promo-body .am-promo__linha').length === 1",
          "a linha da promoção DEAL candidate não apareceu");

        await clicar(cdp, '.am-promo__linha[data-promo-key="P-2::DEAL"] [data-acao="promo-acao"]', "botão 'Participar' não encontrado");
        await waitFor(cdp, `(function(){
          var b = document.querySelector('.am-promo__linha[data-promo-key="P-2::DEAL"] [data-acao="promo-acao"]');
          return b && b.textContent.trim() === "Confirmar participação";
        })()`, "não virou 'Confirmar participação'");
        await clicar(cdp, '.am-promo__linha[data-promo-key="P-2::DEAL"] [data-acao="promo-acao"]', "botão 'Confirmar participação' não encontrado");
        await lerLinhasDialogoEscrita(cdp);

        await cancelarDialogoEscrita(cdp);
        assert.strictEqual(aplicarPromocaoChamadas.length, 0, "cancelar o diálogo não pode chamar o endpoint de escrita");
      } finally {
        promocoesRespostaPadrao = [];
      }
    });

    await check("40d — recusa do backend ao aplicar promoção mantém o diálogo aberto com o erro, sem fechar", async () => {
      promocoesRespostaPadrao = [PROMO_CANDIDATE_DEAL];
      try {
        pedidos.length = 0;
        aplicarPromocaoChamadas.length = 0;
        await cdp.send("Page.navigate", { url: `http://127.0.0.1:${porta}/anuncios-meli.html?cliente=n97&conta=42` });
        await esperarLista(cdp);
        await abrirPrimeiroAnuncio(cdp);
        await waitFor(cdp, "document.querySelectorAll('#am-det-promo-body .am-promo__linha').length === 1",
          "a linha da promoção DEAL candidate não apareceu");

        await clicar(cdp, '.am-promo__linha[data-promo-key="P-2::DEAL"] [data-acao="promo-acao"]', "botão 'Participar' não encontrado");
        await waitFor(cdp, `(function(){
          var b = document.querySelector('.am-promo__linha[data-promo-key="P-2::DEAL"] [data-acao="promo-acao"]');
          return b && b.textContent.trim() === "Confirmar participação";
        })()`, "não virou 'Confirmar participação'");
        await clicar(cdp, '.am-promo__linha[data-promo-key="P-2::DEAL"] [data-acao="promo-acao"]', "botão 'Confirmar participação' não encontrado");
        await lerLinhasDialogoEscrita(cdp);

        aplicarPromocaoResultado = {
          status: 200,
          corpo: { ok: false, codigo: "ERROR_CREDIBILITY_DISCOUNTED_PRICE", motivo: "O desconto informado não é crível para esta promoção." },
        };
        await confirmarDialogoEscrita(cdp);
        await waitFor(cdp, "/não é crível/.test((document.querySelector('.am-confirm-overlay') || {}).textContent || '')",
          "a recusa do backend deveria aparecer dentro do diálogo");
        assert.ok(await cdp.evaluate("!!document.querySelector('.am-confirm-overlay')"),
          "o diálogo tem de continuar aberto depois de uma recusa");

        await cancelarDialogoEscrita(cdp);
      } finally {
        aplicarPromocaoResultado = null;
        promocoesRespostaPadrao = [];
      }
    });

    await check("40e — DEAL started COM rebate (subsidioMl): 'Alterar' simula normalmente, mas 'Confirmar alteração' mostra o aviso e NUNCA chama o endpoint de escrita", async () => {
      promocoesRespostaPadrao = [PROMO_ATIVA];
      try {
        pedidos.length = 0;
        simularMargemChamadas.length = 0;
        aplicarPromocaoChamadas.length = 0;
        await cdp.send("Page.navigate", { url: `http://127.0.0.1:${porta}/anuncios-meli.html?cliente=n97&conta=42` });
        await esperarLista(cdp);
        await abrirPrimeiroAnuncio(cdp);
        await waitFor(cdp, "document.querySelectorAll('#am-det-promo-body .am-promo__linha').length === 1",
          "a linha da promoção DEAL ativa com rebate não apareceu");

        const acaoInicial = await cdp.evaluate(
          `document.querySelector('.am-promo__linha[data-promo-key="P-1::DEAL"] [data-acao="promo-acao"]').textContent.trim()`
        );
        assert.strictEqual(acaoInicial, "Alterar", "com subsidioMl o botão continua mostrando 'Alterar' normalmente");

        await confirmarEdicaoPromoPreco(cdp, "P-1::DEAL", "180");
        await waitFor(cdp, `(function(){
          var b = document.querySelector('.am-promo__linha[data-promo-key="P-1::DEAL"] [data-acao="promo-acao"]');
          return b && b.textContent.trim() === "Confirmar alteração";
        })()`, "o botão não virou 'Confirmar alteração' depois de editar o preço final");

        await clicar(cdp, '.am-promo__linha[data-promo-key="P-1::DEAL"] [data-acao="promo-acao"]', "botão 'Confirmar alteração' não encontrado");
        await waitFor(cdp, "document.querySelector('.vf-toast.is-warning')", "o aviso de rebate não apareceu");
        const aviso = await cdp.evaluate("document.querySelector('.vf-toast.is-warning').innerText");
        assert.ok(/participação do Mercado Livre \(rebate\)/.test(aviso), `aviso inesperado: ${aviso}`);
        assert.ok(/alteração de valores ainda não está disponível/.test(aviso), `aviso inesperado: ${aviso}`);

        assert.strictEqual(await cdp.evaluate("!!document.querySelector('.am-confirm-overlay')"), false,
          "promoção com rebate jamais pode abrir o diálogo de confirmação de escrita");
        assert.strictEqual(aplicarPromocaoChamadas.length, 0, "promoção com rebate jamais pode chamar o endpoint de escrita de promoção");
      } finally {
        promocoesRespostaPadrao = [];
      }
    });

    await check("41 — PROGRAMADA (pending) sempre mostra 'Simular', nunca 'Alterar', e o clique nunca chega a escrever", async () => {
      promocoesRespostaPadrao = [PROMO_PROGRAMADA];
      try {
        pedidos.length = 0;
        simularMargemChamadas.length = 0;
        aplicarPromocaoChamadas.length = 0;
        await cdp.send("Page.navigate", { url: `http://127.0.0.1:${porta}/anuncios-meli.html?cliente=n97&conta=42` });
        await esperarLista(cdp);
        await abrirPrimeiroAnuncio(cdp);
        await waitFor(cdp, "document.querySelectorAll('#am-det-promo-body .am-promo__linha').length === 1",
          "a linha PROGRAMADA não apareceu");

        const acaoProgramada = await cdp.evaluate(
          `document.querySelector('.am-promo__linha[data-promo-key="P-4::DEAL"] [data-acao="promo-acao"]').textContent.trim()`
        );
        assert.strictEqual(acaoProgramada, "Simular", "pending+PROGRAMADA não pode mostrar 'Alterar' — ainda não começou");

        // Clicar simula localmente (comportamento normal de qualquer linha
        // sem escrita), mas o botão TEM de continuar "Simular" depois —
        // nunca pode virar "Confirmar alteração" para uma PROGRAMADA.
        await clicar(cdp, '.am-promo__linha[data-promo-key="P-4::DEAL"] [data-acao="promo-acao"]', "botão da linha PROGRAMADA não encontrado");
        for (let i = 0; i < 100 && simularMargemChamadas.length === 0; i++) await sleep(50);
        assert.strictEqual(simularMargemChamadas.length, 1, "clicar ainda pode simular localmente (não escreve nada)");

        const acaoDepoisDoClique = await cdp.evaluate(
          `document.querySelector('.am-promo__linha[data-promo-key="P-4::DEAL"] [data-acao="promo-acao"]').textContent.trim()`
        );
        assert.strictEqual(acaoDepoisDoClique, "Simular", "depois de simular, PROGRAMADA continua 'Simular' — nunca 'Confirmar alteração'");

        // Segundo clique: se o gate de clique estivesse ausente, isto abriria
        // o diálogo de confirmação. Tem de continuar sem abrir nada e sem
        // jamais chamar o endpoint de escrita.
        await clicar(cdp, '.am-promo__linha[data-promo-key="P-4::DEAL"] [data-acao="promo-acao"]', "botão da linha PROGRAMADA não encontrado (2º clique)");
        await sleep(200);
        assert.strictEqual(await cdp.evaluate("!!document.querySelector('.am-confirm-overlay')"), false,
          "PROGRAMADA jamais pode abrir o diálogo de confirmação de escrita");
        assert.strictEqual(aplicarPromocaoChamadas.length, 0, "PROGRAMADA jamais pode chamar o endpoint de escrita de promoção");
      } finally {
        promocoesRespostaPadrao = [];
      }
    });

    await check("41b — started + statusExibicao NÃO APLICADA + sem rebate: já participada mostra 'Alterar' e a escrita real funciona, mesmo não sendo a promoção que forma o preço atual", async () => {
      promocoesRespostaPadrao = [PROMO_NAO_APLICADA];
      try {
        pedidos.length = 0;
        simularMargemChamadas.length = 0;
        aplicarPromocaoChamadas.length = 0;
        await cdp.send("Page.navigate", { url: `http://127.0.0.1:${porta}/anuncios-meli.html?cliente=n97&conta=42` });
        await esperarLista(cdp);
        await abrirPrimeiroAnuncio(cdp);
        await waitFor(cdp, "document.querySelectorAll('#am-det-promo-body .am-promo__linha').length === 1",
          "a linha NÃO APLICADA não apareceu");

        const acaoInicial = await cdp.evaluate(
          `document.querySelector('.am-promo__linha[data-promo-key="P-3::DEAL"] [data-acao="promo-acao"]').textContent.trim()`
        );
        assert.strictEqual(acaoInicial, "Alterar",
          "started+NÃO APLICADA já tem participação do vendedor — precisa mostrar 'Alterar' (regra revisada)");

        await confirmarEdicaoPromoPreco(cdp, "P-3::DEAL", "180");
        await waitFor(cdp, `(function(){
          var b = document.querySelector('.am-promo__linha[data-promo-key="P-3::DEAL"] [data-acao="promo-acao"]');
          return b && b.textContent.trim() === "Confirmar alteração";
        })()`, "o botão não virou 'Confirmar alteração' depois de editar o preço final");

        await clicar(cdp, '.am-promo__linha[data-promo-key="P-3::DEAL"] [data-acao="promo-acao"]', "botão 'Confirmar alteração' não encontrado");
        const linhasDialogo = await lerLinhasDialogoEscrita(cdp);
        assert.strictEqual(linhasDialogo.find((l) => l.rotulo === "Novo preço").valor, "R$ 180,00");

        await confirmarDialogoEscrita(cdp);
        for (let i = 0; i < 100 && aplicarPromocaoChamadas.length === 0; i++) await sleep(50);
        assert.strictEqual(aplicarPromocaoChamadas.length, 1, "NÃO APLICADA sem rebate precisa completar a escrita real, como qualquer outra 'Alterar'");
        assert.strictEqual(aplicarPromocaoChamadas[0].promotionId, "P-3");
        assert.strictEqual(aplicarPromocaoChamadas[0].body.precoNovo, 180);
      } finally {
        promocoesRespostaPadrao = [];
      }
    });

    await check("42 — tipos fora do escopo de escrita V1 (SMART, PRICE_DISCOUNT, PRE_NEGOTIATED, PRICE_MATCHING, LIGHTNING), mesmo já participados (started/ATIVA), continuam 'Simular' — nunca 'Alterar'", async () => {
      promocoesRespostaPadrao = PROMO_TIPOS_SEM_ESCRITA_JA_PARTICIPADOS;
      try {
        pedidos.length = 0;
        await cdp.send("Page.navigate", { url: `http://127.0.0.1:${porta}/anuncios-meli.html?cliente=n97&conta=42` });
        await esperarLista(cdp);
        await abrirPrimeiroAnuncio(cdp);
        await waitFor(cdp,
          `document.querySelectorAll('#am-det-promo-body .am-promo__linha').length === ${PROMO_TIPOS_SEM_ESCRITA_JA_PARTICIPADOS.length}`,
          "as linhas dos tipos fora do escopo de escrita não apareceram");

        for (const p of PROMO_TIPOS_SEM_ESCRITA_JA_PARTICIPADOS) {
          const acao = await cdp.evaluate(
            `document.querySelector('.am-promo__linha[data-promo-key="${chave(p)}"] [data-acao="promo-acao"]').textContent.trim()`
          );
          assert.strictEqual(acao, "Simular",
            `${p.tipo} (started/ATIVA, já participada) não pode mostrar 'Alterar' — fora do escopo de escrita V1`);
        }
      } finally {
        promocoesRespostaPadrao = [];
      }
    });

    await check("42b — SMART (fora do escopo de escrita), mesmo já participada (started/ATIVA), nunca abre o diálogo de confirmação nem chama o endpoint de escrita, mesmo depois de simular", async () => {
      const smart = PROMO_TIPOS_SEM_ESCRITA_JA_PARTICIPADOS.find((p) => p.tipo === "SMART");
      promocoesRespostaPadrao = [smart];
      try {
        pedidos.length = 0;
        simularMargemChamadas.length = 0;
        aplicarPromocaoChamadas.length = 0;
        await cdp.send("Page.navigate", { url: `http://127.0.0.1:${porta}/anuncios-meli.html?cliente=n97&conta=42` });
        await esperarLista(cdp);
        await abrirPrimeiroAnuncio(cdp);
        await waitFor(cdp, "document.querySelectorAll('#am-det-promo-body .am-promo__linha').length === 1",
          "a linha SMART não apareceu");

        await clicar(cdp, `.am-promo__linha[data-promo-key="${chave(smart)}"] [data-acao="promo-acao"]`,
          "botão da linha SMART não encontrado");
        for (let i = 0; i < 100 && simularMargemChamadas.length === 0; i++) await sleep(50);
        assert.strictEqual(simularMargemChamadas.length, 1, "clicar ainda pode simular localmente (não escreve nada)");

        const acaoDepoisDoClique = await cdp.evaluate(
          `document.querySelector('.am-promo__linha[data-promo-key="${chave(smart)}"] [data-acao="promo-acao"]').textContent.trim()`
        );
        assert.strictEqual(acaoDepoisDoClique, "Simular", "depois de simular, SMART continua 'Simular' — nunca 'Confirmar alteração'");

        await clicar(cdp, `.am-promo__linha[data-promo-key="${chave(smart)}"] [data-acao="promo-acao"]`,
          "botão da linha SMART não encontrado (2º clique)");
        await sleep(200);
        assert.strictEqual(await cdp.evaluate("!!document.querySelector('.am-confirm-overlay')"), false,
          "SMART jamais pode abrir o diálogo de confirmação de escrita");
        assert.strictEqual(aplicarPromocaoChamadas.length, 0, "SMART jamais pode chamar o endpoint de escrita de promoção");
      } finally {
        promocoesRespostaPadrao = [];
      }
    });

    // Colisão de id entre TIPOS diferentes (auditoria: o id do Mercado Livre só
    // é único dentro do namespace de cada tipo de campanha — duas promoções de
    // tipos diferentes podem coincidir de id por acaso). Antes da correção,
    // data-promo-id/promocaoPorId identificavam a linha só pelo id, e o clique
    // numa linha podia resolver os dados da OUTRA (bug real relatado: "Vendex -
    // Setembro" mostrava Subsídio ML "—" mas o clique em "Alterar" abria o
    // aviso de rebate da outra promoção com o mesmo id). data-promo-key/
    // promocaoPorChave (id+tipo) tornam isso impossível.
    const PROMO_COLISAO_SELLER_CAMPAIGN = {
      id: "X-1", tipo: "SELLER_CAMPAIGN", tipoLabel: "Campanha própria", nome: "Colisão SC",
      status: "started", statusLabel: "ATIVA", statusExibicao: "NÃO APLICADA", inicio: null, fim: null,
      precoOriginal: 249.9, precoFinal: 170, descontoReais: 79.9, descontoPercentual: 32,
      meliPercentage: 5, sellerPercentage: null, subsidioMl: 12.5, editavelPrecoFinal: true,
    };
    const PROMO_COLISAO_DEAL = {
      id: "X-1", tipo: "DEAL", tipoLabel: "Campanha tradicional", nome: "Colisão DEAL",
      status: "started", statusLabel: "ATIVA", statusExibicao: "NÃO APLICADA", inicio: null, fim: null,
      precoOriginal: 249.9, precoFinal: 190, descontoReais: 59.9, descontoPercentual: 24,
      meliPercentage: null, sellerPercentage: null, subsidioMl: null, editavelPrecoFinal: true,
    };

    await check("43 — id colidindo entre tipos diferentes: cada linha resolve os PRÓPRIOS dados (id+tipo), nunca os da outra promoção com o mesmo id", async () => {
      // SELLER_CAMPAIGN (com rebate) vem PRIMEIRO de propósito — sob a
      // identificação antiga (só id), promocaoPorId("X-1") teria resolvido
      // esta linha mesmo clicando na linha DEAL (sem rebate) abaixo.
      promocoesRespostaPadrao = [PROMO_COLISAO_SELLER_CAMPAIGN, PROMO_COLISAO_DEAL];
      try {
        pedidos.length = 0;
        simularMargemChamadas.length = 0;
        aplicarPromocaoChamadas.length = 0;
        await cdp.send("Page.navigate", { url: `http://127.0.0.1:${porta}/anuncios-meli.html?cliente=n97&conta=42` });
        await esperarLista(cdp);
        await abrirPrimeiroAnuncio(cdp);
        await waitFor(cdp, "document.querySelectorAll('#am-det-promo-body .am-promo__linha').length === 2",
          "as duas linhas com id colidindo não apareceram");

        assert.ok(await cdp.evaluate(`!!document.querySelector('.am-promo__linha[data-promo-key="${chave(PROMO_COLISAO_SELLER_CAMPAIGN)}"]')`),
          "a linha SELLER_CAMPAIGN precisa ter sua própria chave (id+tipo)");
        assert.ok(await cdp.evaluate(`!!document.querySelector('.am-promo__linha[data-promo-key="${chave(PROMO_COLISAO_DEAL)}"]')`),
          "a linha DEAL precisa ter sua própria chave (id+tipo), distinta da SELLER_CAMPAIGN mesmo com o id igual");

        // Clicar na linha DEAL (sem rebate) precisa selecionar/simular com os
        // dados DELA — nunca com o precoFinal/subsidioMl da SELLER_CAMPAIGN.
        await clicar(cdp, `.am-promo__linha[data-promo-key="${chave(PROMO_COLISAO_DEAL)}"] [data-acao="promo-acao"]`,
          "botão 'Alterar' da linha DEAL não encontrado");
        for (let i = 0; i < 100 && simularMargemChamadas.length === 0; i++) await sleep(50);
        assert.strictEqual(simularMargemChamadas.length, 1);
        assert.strictEqual(simularMargemChamadas[0].body.preco, 190, "precisa simular com o precoFinal da linha DEAL (190), nunca o da SELLER_CAMPAIGN (170)");
        assert.strictEqual(simularMargemChamadas[0].body.subsidioMl, undefined,
          "a linha DEAL não tem subsidioMl — nunca pode herdar o rebate (12.5) da SELLER_CAMPAIGN só por coincidência de id");

        await waitFor(cdp, `(function(){
          var b = document.querySelector('.am-promo__linha[data-promo-key="${chave(PROMO_COLISAO_DEAL)}"] [data-acao="promo-acao"]');
          return b && b.textContent.trim() === "Confirmar alteração";
        })()`, "o botão da linha DEAL não virou 'Confirmar alteração' depois de simular");

        // Confirmar a linha DEAL (sem rebate) precisa abrir o diálogo normal
        // — NUNCA o aviso de rebate, mesmo com a SELLER_CAMPAIGN (com rebate)
        // compartilhando o mesmo id.
        await clicar(cdp, `.am-promo__linha[data-promo-key="${chave(PROMO_COLISAO_DEAL)}"] [data-acao="promo-acao"]`,
          "botão 'Confirmar alteração' da linha DEAL não encontrado");
        await waitFor(cdp, "document.querySelector('.am-confirm-overlay')", "o diálogo de confirmação da linha DEAL não abriu");
        assert.strictEqual(await cdp.evaluate("!!document.querySelector('.vf-toast.is-warning')"), false,
          "a linha DEAL não tem rebate — jamais pode mostrar o aviso de rebate da outra promoção com o mesmo id");

        await cancelarDialogoEscrita(cdp);

        // A linha SELLER_CAMPAIGN continua intocada — nunca foi selecionada.
        const acaoSellerCampaign = await cdp.evaluate(
          `document.querySelector('.am-promo__linha[data-promo-key="${chave(PROMO_COLISAO_SELLER_CAMPAIGN)}"] [data-acao="promo-acao"]').textContent.trim()`
        );
        assert.strictEqual(acaoSellerCampaign, "Alterar", "a linha SELLER_CAMPAIGN não pode ser afetada por um clique na linha DEAL");
      } finally {
        promocoesRespostaPadrao = [];
      }
    });

    /* ── 44: Title Engine (SEO · F3) ──────────────────────────────────── */

    async function abrirLimpo() {
      iaProibida = false;
      titulosHandler = null;
      titulosAtrasoMs = 0;
      descricaoSeoHandler = null;
      descricaoSeoAtrasoMs = 0;
      await abrirComModo("nenhum");
      await abrirPrimeiroAnuncio(cdp);
      // O histórico legado ainda alimenta a Ficha; esperar por ela garante que
      // o histórico (que traz também descricao_sugerida/modelo_sugerido) chegou.
      await waitFor(cdp, "document.querySelector('#am-det-sug-ficha') && document.querySelector('#am-det-sug-ficha').innerText.indexOf('38 g') >= 0",
        "o histórico legado (Ficha) não carregou");
    }
    const colunaTitulo = () => cdp.evaluate("document.getElementById('am-det-sug-titulo').innerText");

    await check("44a — Título oferece 'Gerar títulos'; Modelo não tem coluna de sugestão", async () => {
      await abrirLimpo();
      const col = await colunaTitulo();
      assert.ok(/Nenhuma sugestão gerada ainda/.test(col), col);
      assert.ok(!col.includes(SUG_TITULO_A), "a sugestão legada de título não pode reaparecer na coluna nova");
      assert.ok(await cdp.evaluate("!!document.querySelector('#am-det-sug-titulo [data-acao=\"gerar-titulos\"]')"));
      assert.ok(await cdp.evaluate("!document.getElementById('am-det-sug-modelo')"),
        "o Modelo é dado factual — sem coluna de sugestão (F4R)");
      assert.ok(/Aguardando geração/.test(await cdp.evaluate("document.getElementById('am-det-status-seo').innerText")));
    });

    await check("44b — Gerar títulos: estado de carregamento, depois 4 sugestões com score, caracteres e 'Usar'", async () => {
      const desde = titulosChamadas.length;
      titulosAtrasoMs = 500;
      await clicar(cdp, '.am-det-modal [data-acao="gerar-titulos"]');
      await waitFor(cdp, "document.querySelector('#am-det-sug-titulo [data-acao=\"gerar-titulos\"]').disabled", "o botão não entrou em carregamento");
      assert.ok(/Gerando/.test(await colunaTitulo()));
      assert.ok(/Gerando títulos/.test(await cdp.evaluate("document.getElementById('am-det-status-seo').innerText")));
      await waitFor(cdp, "document.querySelectorAll('#am-det-sug-titulo [data-acao=\"usar-titulo\"]').length === 4", "as 4 sugestões não apareceram");
      titulosAtrasoMs = 0;

      const envio = titulosChamadas[desde];
      assert.strictEqual(envio.itemId, "MLB-A1");
      assert.strictEqual(envio.body.clienteSlug, "n97");
      assert.strictEqual(String(envio.body.clienteContaId), "42", "a geração leva a ClienteConta da operação");

      const col = await colunaTitulo();
      SUG_TITULOS.forEach((sg) => {
        assert.ok(col.includes(sg.titulo), "faltou: " + sg.titulo);
        assert.ok(col.includes(String(sg.score)), "faltou o score " + sg.score);
        assert.ok(col.includes("(" + sg.chars + "/60)"), "faltou o contador de " + sg.titulo);
      });
      assert.ok(!/recomendad|melhor|vencedor/i.test(col), "sugestões não destacam vencedor");
      assert.ok(/2 sugestões descartadas/.test(col), "o descarte por falta de fato precisa ser dito");
      assert.ok(/4 sugestões/.test(await cdp.evaluate("document.getElementById('am-det-status-seo').innerText")));
    });

    await check("44c — 'Usar' muda só o rascunho (sem PATCH /conteudo); 'Salvar alterações' continua o único caminho de escrita", async () => {
      const antes = pedidos.length;
      await clicar(cdp, '.am-det-modal [data-acao="usar-titulo"][data-idx="2"]');
      const valores = await cdp.evaluate(`[document.getElementById('am-det-titulo').value, document.getElementById('am-det-espelho-titulo').value]`);
      assert.deepStrictEqual(valores, [SUG_TITULOS[2].titulo, SUG_TITULOS[2].titulo]);
      await waitFor(cdp, "document.getElementById('am-det-savebar')", "usar uma sugestão precisa virar alteração pendente");
      await sleep(250);
      assert.deepStrictEqual(pedidos.slice(antes).filter((u) => /\/conteudo|\/preco|\/fotos|\/imagens/.test(u)), [],
        "'Usar' não pode escrever nada");

      conteudoResultado = { status: 200, corpo: { ok: false, motivo: "Resposta de teste (44c)." } };
      await clicar(cdp, '.am-det-modal [data-acao="salvar"]');
      await esperarPedido(/\/anuncios-meli\/MLB-A1\/conteudo/, antes, "Salvar alterações não saiu");
      const envio = corpos.filter((c) => /\/conteudo/.test(c.url)).pop();
      assert.strictEqual(envio.body.titulo, SUG_TITULOS[2].titulo, "o salvar leva o título escolhido");
      conteudoResultado = null;
      await clicar(cdp, '.am-det-modal [data-acao="descartar"]');
      await waitFor(cdp, "!document.getElementById('am-det-savebar')", "descartar não limpou a pendência");
      assert.strictEqual(await cdp.evaluate("document.getElementById('am-det-titulo').value"), TITULO_A);
      assert.strictEqual(await cdp.evaluate("document.querySelectorAll('#am-det-sug-titulo [data-acao=\"usar-titulo\"]').length"), 4,
        "descartar o rascunho não apaga as sugestões");
    });

    await check("44d — backend sem sugestão válida: o motivo aparece e dá para tentar de novo", async () => {
      titulosHandler = () => ({ status: 200, corpo: { ok: false, codigo: "SEM_SUGESTOES_VALIDAS",
        motivo: "Nenhum título gerado passou na validação dos fatos do anúncio. Tente gerar novamente.", descartadas: 8 } });
      await clicar(cdp, '#am-det-sug-titulo [data-acao="gerar-titulos"]');
      await waitFor(cdp, "document.getElementById('am-det-sug-titulo').innerText.indexOf('validação dos fatos') >= 0", "o motivo não apareceu");
      assert.ok(await cdp.evaluate("!!document.querySelector('#am-det-sug-titulo [data-acao=\"gerar-titulos\"]')"), "sem 'Tentar novamente'");
      assert.strictEqual(await cdp.evaluate("document.querySelectorAll('#am-det-sug-titulo [data-acao=\"usar-titulo\"]').length"), 0);
      titulosHandler = null;
    });

    await check("44e — resposta atrasada de um modal fechado é descartada", async () => {
      titulosAtrasoMs = 700;
      const desde = titulosChamadas.length;
      await clicar(cdp, '#am-det-sug-titulo [data-acao="gerar-titulos"]');
      await sleep(150); // a requisição sai; a resposta fica presa por 700ms
      await fecharModal(cdp);
      titulosAtrasoMs = 0;
      await abrirPrimeiroAnuncio(cdp);
      await sleep(1000);
      assert.strictEqual(await cdp.evaluate("document.querySelectorAll('#am-det-sug-titulo [data-acao=\"usar-titulo\"]').length"), 0,
        "a resposta do modal antigo vazou para o novo");
      assert.ok(/Nenhuma sugestão gerada ainda/.test(await colunaTitulo()));
      assert.ok(titulosChamadas.length > desde, "a geração do modal antigo nem saiu");
    });

    await check("44f — título travado (catálogo/família) não oferece geração nem chama o backend", async () => {
      for (const modo of ["catalog_listing", "family_name"]) {
        const desde = titulosChamadas.length;
        await abrirComModo(modo);
        await abrirPrimeiroAnuncio(cdp);
        const col = await colunaTitulo();
        assert.ok(/gerenciado pelo Mercado Livre/i.test(col), modo + ": " + col);
        assert.strictEqual(await cdp.evaluate("document.querySelectorAll('.am-det-modal [data-acao=\"gerar-titulos\"]').length"), 0,
          modo + ": título travado não pode oferecer 'Gerar títulos'");
        assert.strictEqual(titulosChamadas.length, desde);
      }
      await abrirComModo("nenhum");
    });

    /* ── 45: Modelo = dado factual (SEO · F4R) ────────────────────────── */
    // O Modelo saiu da superfície de SEO: sem geração, sem sugestão, sem IA.
    // Continua editável (cabeçalho/Catálogo e espelho) e é salvo pelo MESMO
    // PATCH /conteudo de sempre. Os Termos Complementares não têm UI ainda.

    const valoresModelo = () => cdp.evaluate("[document.getElementById('am-det-modelo').value, document.getElementById('am-det-espelho-modelo').value]");

    await check("45a — Modelo sem botão de geração, sem sugestão, sem 'Usar', sem chip de IA — mesmo com histórico legado de modelo_sugerido", async () => {
      await abrirLimpo();
      const bloco = await cdp.evaluate("document.getElementById('am-det-compare-modelo').innerText");
      assert.ok(!bloco.includes("X200 Pro"), "o modelo_sugerido do histórico legado não pode aparecer: " + bloco);
      assert.ok(!/Sugestão da IA|Gerar|Usar|termos?/i.test(bloco), bloco);
      for (const sel of ["#am-det-sug-modelo", "#am-det-status-modelo", '[data-acao="gerar-modelo"]', '[data-acao="usar-modelo"]',
        '[data-acao="aprovar-modelo"]', '[data-fonte="modelo-sugerido"]', '[data-campo="modelo"][data-acao="usar-sugestao"]']) {
        assert.strictEqual(await cdp.evaluate(`document.querySelectorAll('.am-det-modal ${sel.replace(/'/g, "\\'")}').length`), 0, sel);
      }
      assert.strictEqual(await cdp.evaluate("document.querySelectorAll('#am-det-compare-modelo .am-det-compare__col').length"), 1,
        "uma coluna só: o dado do produto");
      assert.ok(await cdp.evaluate("document.getElementById('am-det-compare-modelo').classList.contains('am-det-compare--unico')"));
    });

    await check("45b — Modelo continua editável pelo espelho e sincroniza com o cabeçalho", async () => {
      assert.strictEqual(await cdp.evaluate("document.getElementById('am-det-espelho-modelo').readOnly"), false);
      assert.deepStrictEqual(await valoresModelo(), ["X200", "X200"]);
      await digitar(cdp, "#am-det-espelho-modelo", "X200 Lite");
      assert.deepStrictEqual(await valoresModelo(), ["X200 Lite", "X200 Lite"]);
      await waitFor(cdp, "document.getElementById('am-det-savebar')", "editar o Modelo precisa virar alteração pendente");
    });

    await check("45c — salvar o Modelo manual usa o PATCH /conteudo existente (só o modelo vai)", async () => {
      const antes = pedidos.length;
      conteudoResultado = { status: 200, corpo: { ok: false, motivo: "Resposta de teste (45c)." } };
      await clicar(cdp, '.am-det-modal [data-acao="salvar"]');
      await esperarPedido(/\/anuncios-meli\/MLB-A1\/conteudo/, antes, "Salvar alterações não saiu");
      const envio = corpos.filter((c) => /\/conteudo/.test(c.url)).pop();
      assert.strictEqual(envio.body.modelo, "X200 Lite", "o salvar leva o modelo digitado");
      assert.strictEqual(envio.body.titulo, undefined, "o título não mudou e não vai junto");
      assert.deepStrictEqual(pedidos.slice(antes).filter((u) => /\/seo\/|\/otimizar|\/aprovar/.test(u)), [],
        "salvar o Modelo não passa por SEO, otimizador ou aprovação");
      conteudoResultado = null;
      await clicar(cdp, '.am-det-modal [data-acao="descartar"]');
      await waitFor(cdp, "!document.getElementById('am-det-savebar')", "descartar não limpou a pendência");
      assert.deepStrictEqual(await valoresModelo(), ["X200", "X200"]);
    });

    await check("45d — mudar o título não mexe no Modelo nem chama nada de Modelo/termos", async () => {
      const desde = pedidos.length;
      await digitar(cdp, "#am-det-titulo", TITULO_A + " Preto");
      await sleep(250);
      assert.deepStrictEqual(await valoresModelo(), ["X200", "X200"]);
      assert.deepStrictEqual(pedidos.slice(desde).filter((u) => /\/seo\/|\/otimizar|\/conteudo/.test(u)), []);
      await clicar(cdp, '.am-det-modal [data-acao="descartar"]');
      await waitFor(cdp, "!document.getElementById('am-det-savebar')", "descartar não limpou a pendência");
    });

    await check("45e — em todo o percurso, nenhum POST /seo/modelo ou /seo/termos-complementares; nenhum PATCH /conteudo levou termos ao Modelo", async () => {
      assert.deepStrictEqual(seoModeloOuTermosChamadas, []);
      const modelosEnviados = corpos.filter((c) => /\/conteudo/.test(c.url) && c.body && c.body.modelo !== undefined)
        .map((c) => c.body.modelo);
      const digitadosNoTeste = ["X200 Mini", "X200 Pro", "X999", "Z10", "X200 Lite", "X200"];
      assert.deepStrictEqual(modelosEnviados.filter((m) => !digitadosNoTeste.includes(m)), [],
        "todo modelo enviado foi digitado à mão por um teste: " + JSON.stringify(modelosEnviados));
    });

    /* ── 46: Description Engine (SEO · F5) ───────────────────────────── */
    // UMA descrição por clique, validada no backend, sem score. "Usar" só muda
    // o rascunho; "Salvar alterações" (PATCH /conteudo) é a única escrita.

    const SUG_DESC_A2 = "Fone Prime X200 sem fio com ANC e até 30h de bateria, para uso no dia a dia.";
    const colunaDescricao = () => cdp.evaluate("document.getElementById('am-det-sug-descricao').innerText");
    const botaoGerarDescricao = () => cdp.evaluate(`(function(){ var b = document.querySelector('#am-det-sug-descricao [data-acao="gerar-descricao"]');
      return b ? { texto: b.textContent.trim(), disabled: b.disabled } : null; })()`);
    const nUsarDescricao = () => cdp.evaluate("document.querySelectorAll('#am-det-sug-descricao [data-acao=\"usar-descricao\"]').length");

    await check("46a — estado inicial: 'Gerar descrição', nenhuma sugestão — nem a do histórico legado, nem 'Aprovar'", async () => {
      await abrirLimpo();
      const col = await colunaDescricao();
      assert.ok(/Nenhuma sugestão gerada ainda/.test(col), col);
      assert.ok(!col.includes(SUG_DESC_A), "a descricao_sugerida do histórico legado não alimenta mais a coluna");
      assert.deepStrictEqual(await botaoGerarDescricao(), { texto: "Gerar descrição", disabled: false });
      for (const sel of ['[data-acao="gerar"][data-tipo="descricao"]', '[data-acao="aprovar-descricao"]', '[data-acao="usar-descricao"]',
        '[data-campo="descricao"][data-acao="usar-sugestao"]']) {
        assert.strictEqual(await cdp.evaluate(`document.querySelectorAll('.am-det-modal ${sel.replace(/'/g, "\\'")}').length`), 0, sel);
      }
      assert.ok(!/score/i.test(col), "descrição não tem score");
    });

    await check("46b — Gerar descrição: POST /seo/descricao com cliente + conta da operação, sem /otimizar", async () => {
      const desde = descricaoSeoChamadas.length;
      const desdePedidos = pedidos.length;
      descricaoSeoAtrasoMs = 600;
      await clicar(cdp, '#am-det-sug-descricao [data-acao="gerar-descricao"]');
      await esperarPedido(/\/anuncios-meli\/MLB-A1\/seo\/descricao$/, desdePedidos, "o POST /seo/descricao não saiu");
      const envio = descricaoSeoChamadas[desde];
      assert.ok(envio, "o interceptor não registrou o pedido");
      assert.strictEqual(envio.itemId, "MLB-A1");
      assert.deepStrictEqual(Object.keys(envio.body).sort(), ["clienteContaId", "clienteSlug"], "contrato mínimo: só cliente e conta");
      assert.strictEqual(envio.body.clienteSlug, "n97");
      assert.strictEqual(String(envio.body.clienteContaId), "42");
      assert.deepStrictEqual(pedidos.slice(desdePedidos).filter((u) => /\/otimizar|\/aprovar/.test(u)), []);
    });

    await check("46c — carregando: botão desabilitado em 'Gerando…' e aviso na coluna", async () => {
      assert.deepStrictEqual(await botaoGerarDescricao(), { texto: "Gerando…", disabled: true });
      assert.ok(/Gerando descrição/.test(await colunaDescricao()));
      const antes = descricaoSeoChamadas.length;
      await cdp.evaluate(`(function(){ var b = document.querySelector('#am-det-sug-descricao [data-acao="gerar-descricao"]'); if (b) b.click(); })()`);
      await sleep(100);
      assert.strictEqual(descricaoSeoChamadas.length, antes, "clique durante o carregamento não gera outra chamada");
    });

    await check("46d — sucesso: mostra o texto, caracteres, fatos usados, 'Usar' e 'Gerar novamente'", async () => {
      await waitFor(cdp, "document.querySelectorAll('#am-det-sug-descricao [data-acao=\"usar-descricao\"]').length === 1", "a sugestão não apareceu");
      descricaoSeoAtrasoMs = 0;
      const col = await colunaDescricao();
      assert.ok(col.includes(SUG_DESC_A), col);
      assert.ok(col.includes(SUG_DESC_A.length + "/2500 caracteres"), col);
      assert.ok(/com base em: Marca, Duração da bateria/.test(col), col);
      assert.deepStrictEqual(await botaoGerarDescricao(), { texto: "Gerar novamente", disabled: false });
      assert.strictEqual(await cdp.evaluate("document.querySelector('#am-det-sug-descricao [data-acao=\"usar-descricao\"]').textContent"), "Usar descrição");
      assert.ok(!/score/i.test(col));
    });

    await check("46e — 'Usar' muda só o rascunho da descrição e não chama PATCH /conteudo", async () => {
      const antes = pedidos.length;
      await clicar(cdp, '#am-det-sug-descricao [data-acao="usar-descricao"]');
      assert.strictEqual(await cdp.evaluate("document.getElementById('am-det-descricao').value"), SUG_DESC_A);
      assert.strictEqual(await cdp.evaluate("document.getElementById('am-det-titulo').value"), TITULO_A, "o título não muda");
      assert.deepStrictEqual(await valoresModelo(), ["X200", "X200"], "o modelo não muda");
      await waitFor(cdp, "document.getElementById('am-det-savebar')", "usar a descrição precisa virar alteração pendente");
      await waitFor(cdp, "document.getElementById('am-det-sug-descricao').innerText.indexOf('Usada nesta edição') >= 0", "o chip 'Usada' não apareceu");
      assert.ok(/preenchida a partir da sugestão da IA/.test(await cdp.evaluate("document.getElementById('am-det-desc-origem').innerText")));
      await sleep(250);
      assert.deepStrictEqual(pedidos.slice(antes).filter((u) => /\/conteudo|\/preco|\/fotos|\/imagens|\/aprovar|\/otimizar/.test(u)), [],
        "'Usar' não pode escrever nada");
    });

    await check("46f — 'Salvar alterações' continua o único caminho de escrita (PATCH /conteudo só com a descrição)", async () => {
      const antes = pedidos.length;
      conteudoResultado = { status: 200, corpo: { ok: false, motivo: "Resposta de teste (46f)." } };
      await clicar(cdp, '.am-det-modal [data-acao="salvar"]');
      await esperarPedido(/\/anuncios-meli\/MLB-A1\/conteudo/, antes, "Salvar alterações não saiu");
      const envio = corpos.filter((c) => /\/conteudo/.test(c.url)).pop();
      assert.strictEqual(envio.metodo, "PATCH");
      assert.strictEqual(envio.body.descricao, SUG_DESC_A, "o salvar leva a descrição usada");
      assert.strictEqual(envio.body.titulo, undefined);
      assert.strictEqual(envio.body.modelo, undefined);
      conteudoResultado = null;
      await clicar(cdp, '.am-det-modal [data-acao="descartar"]');
      await waitFor(cdp, "!document.getElementById('am-det-savebar')", "descartar não limpou a pendência");
      assert.strictEqual(await cdp.evaluate("document.getElementById('am-det-descricao').value"), DESC_A);
      assert.strictEqual(await nUsarDescricao(), 1, "descartar o rascunho não apaga a sugestão");
    });

    await check("46g — 'Gerar novamente' pede outra descrição e troca a sugestão", async () => {
      const desde = descricaoSeoChamadas.length;
      descricaoSeoHandler = () => ({ status: 200, corpo: { ok: true, descricao: SUG_DESC_A2, chars: SUG_DESC_A2.length, limite: 2500, fatosUsados: [] } });
      await clicar(cdp, '#am-det-sug-descricao [data-acao="gerar-descricao"]');
      await waitFor(cdp, `document.getElementById('am-det-sug-descricao').innerText.indexOf(${JSON.stringify(SUG_DESC_A2)}) >= 0`, "a nova sugestão não apareceu");
      assert.strictEqual(descricaoSeoChamadas.length, desde + 1);
      assert.ok(!(await colunaDescricao()).includes(SUG_DESC_A), "uma sugestão por vez");
      descricaoSeoHandler = null;
    });

    await check("46h — erro: mostra o motivo, sem 'Usar', e 'Tentar novamente' volta a gerar", async () => {
      descricaoSeoHandler = () => ({ status: 200, corpo: { ok: false, codigo: "DESCRICAO_INVALIDA",
        motivo: "A descrição gerada não passou na validação: Número ou medida que não está nos dados do anúncio. Tente gerar novamente." } });
      await clicar(cdp, '#am-det-sug-descricao [data-acao="gerar-descricao"]');
      await waitFor(cdp, "document.getElementById('am-det-sug-descricao').innerText.indexOf('não passou na validação') >= 0", "o motivo não apareceu");
      assert.ok(/rejeitada pela checagem de fatos[\s\S]*Nada foi aplicado/.test(await colunaDescricao()), "a rejeição precisa dizer que nada foi aplicado");
      assert.strictEqual(await nUsarDescricao(), 0);
      assert.deepStrictEqual(await botaoGerarDescricao(), { texto: "Tentar novamente", disabled: false });
      // com os problemas do backend: um motivo por linha (repetidos uma vez só), sem o parágrafo corrido
      descricaoSeoHandler = () => ({ status: 200, corpo: { ok: false, codigo: "DESCRICAO_INVALIDA",
        motivo: "A descrição gerada não passou na validação: A. B. Tente gerar novamente.",
        problemas: [{ codigo: "CLAIM_OBJETIVO_SEM_FONTE", detalhe: "Afirmação técnica sem fonte nos dados.", termos: ["antiembacante"] },
          { codigo: "LINGUAGEM_PROIBIDA", detalhe: "Promessa de entrega.", termos: ["receba"] },
          { codigo: "LINGUAGEM_PROIBIDA", detalhe: "Promessa de entrega.", termos: ["receba"] }] } });
      await clicar(cdp, '#am-det-sug-descricao [data-acao="gerar-descricao"]');
      await waitFor(cdp, "document.getElementById('am-det-sug-descricao').innerText.indexOf('Promessa de entrega') >= 0", "os motivos não apareceram");
      assert.strictEqual(await cdp.evaluate("document.querySelectorAll('#am-det-sug-descricao .am-det-compare__list li').length"), 2);
      assert.ok(/Afirmação técnica sem fonte nos dados\. \(antiembacante\)/.test(await colunaDescricao()));
      assert.ok(!/não passou na validação/.test(await colunaDescricao()), "a lista substitui o parágrafo corrido");
      assert.strictEqual(await nUsarDescricao(), 0);
      descricaoSeoHandler = () => ({ status: 200, corpo: { ok: false, codigo: "AI_RESPONSE_TRUNCATED", motivo: "A resposta da IA veio cortada. Tente gerar novamente." } });
      await clicar(cdp, '#am-det-sug-descricao [data-acao="gerar-descricao"]');
      await waitFor(cdp, "document.getElementById('am-det-sug-descricao').innerText.indexOf('veio cortada') >= 0", "o erro da IA não apareceu");
      descricaoSeoHandler = null;
      await clicar(cdp, '#am-det-sug-descricao [data-acao="gerar-descricao"]');
      await waitFor(cdp, "document.querySelectorAll('#am-det-sug-descricao [data-acao=\"usar-descricao\"]').length === 1", "'Tentar novamente' não gerou");
    });

    await check("46i — resposta atrasada de um modal fechado é descartada (DET.token)", async () => {
      await fecharModal(cdp);
      await abrirPrimeiroAnuncio(cdp);
      descricaoSeoAtrasoMs = 700;
      const desde = descricaoSeoChamadas.length;
      await clicar(cdp, '#am-det-sug-descricao [data-acao="gerar-descricao"]');
      await sleep(150); // a requisição sai; a resposta fica presa por 700ms
      await fecharModal(cdp);
      descricaoSeoAtrasoMs = 0;
      await abrirPrimeiroAnuncio(cdp);
      await sleep(1000);
      assert.strictEqual(await nUsarDescricao(), 0, "a resposta do modal antigo vazou para o novo");
      assert.ok(/Nenhuma sugestão gerada ainda/.test(await colunaDescricao()));
      assert.strictEqual(await cdp.evaluate("document.getElementById('am-det-descricao').value"), DESC_A, "o rascunho do novo modal não muda");
      assert.ok(descricaoSeoChamadas.length > desde, "a geração do modal antigo nem saiu");
    });

    await check("46j — Title Engine segue funcionando ao lado da descrição", async () => {
      await clicar(cdp, '.am-det-modal [data-acao="gerar-titulos"]');
      await waitFor(cdp, "document.querySelectorAll('#am-det-sug-titulo [data-acao=\"usar-titulo\"]').length === 4", "os títulos não apareceram");
      assert.ok(/Nenhuma sugestão gerada ainda/.test(await colunaDescricao()), "gerar títulos não mexe na coluna da descrição");
      await clicar(cdp, '.am-det-modal [data-acao="gerar-descricao"]');
      await waitFor(cdp, "document.querySelectorAll('#am-det-sug-descricao [data-acao=\"usar-descricao\"]').length === 1", "a descrição não apareceu");
      assert.strictEqual(await cdp.evaluate("document.querySelectorAll('#am-det-sug-titulo [data-acao=\"usar-titulo\"]').length"), 4,
        "gerar descrição não apaga os títulos");
    });

    await check("46k — Modelo continua sem geração", async () => {
      for (const sel of ["#am-det-sug-modelo", '[data-acao="gerar-modelo"]', '[data-acao="usar-modelo"]', '[data-acao="gerar"][data-tipo="seo"]']) {
        assert.strictEqual(await cdp.evaluate(`document.querySelectorAll('.am-det-modal ${sel.replace(/'/g, "\\'")}').length`), 0, sel);
      }
      assert.strictEqual(await cdp.evaluate("document.querySelectorAll('#am-det-compare-modelo .am-det-compare__col').length"), 1);
    });

    await check("46l — Termos Complementares continuam sem UI (nenhuma chamada, nenhum elemento)", async () => {
      assert.deepStrictEqual(seoModeloOuTermosChamadas, []);
      assert.ok(!/termos complementares/i.test(await textoModal(cdp)));
      assert.strictEqual(await cdp.evaluate("document.querySelectorAll('.am-det-modal [data-acao*=\"termo\"]').length"), 0);
    });

    await check("46n — cenário de teste: aprovação explica avisos, ajustes e autorreparo sem códigos técnicos", async () => {
      descricaoSeoHandler = () => ({ status: 200, corpo: { ok: true, descricao: SUG_DESC_A2,
        avisos: [{ codigo: "LINGUAGEM_PROIBIDA", acao: "trecho removido", trecho: "Promessa de teste", termos: ["receba"] }],
        ajustesEditoriais: ["ITEM_CONTIDO"], autorreparo: { etapa: "remocao", chamadasIa: 1,
          removidas: [{ codigo: "CLAIM_OBJETIVO_SEM_FONTE", trecho: "Afirmação de teste" }] } } });
      await clicar(cdp, '#am-det-sug-descricao [data-acao="gerar-descricao"]');
      await waitFor(cdp, "document.querySelectorAll('#am-det-sug-descricao [data-acao=\"usar-descricao\"]').length === 1", "aprovação não apareceu");
      const col = await colunaDescricao();
      assert.ok(col.includes("trecho removido"), "aviso aprovado precisa aparecer: " + col);
      assert.ok(col.includes("Promessa de teste") && col.includes("receba"), col);
      assert.ok(/itens redundantes removidos/i.test(col), col);
      assert.ok(/trechos sem suporte foram removidos/i.test(col), col);
      assert.ok(!/LINGUAGEM_PROIBIDA|ITEM_CONTIDO|CLAIM_OBJETIVO_SEM_FONTE/.test(col), col);
      // Avisos sem autorreparo também são informação útil no sucesso.
      descricaoSeoHandler = () => ({ status: 200, corpo: { ok: true, descricao: SUG_DESC_A2,
        avisos: [{ codigo: "TESTE_AVISO", acao: "Aviso isolado de teste" }] } });
      await clicar(cdp, '#am-det-sug-descricao [data-acao="gerar-descricao"]');
      await waitFor(cdp, "document.querySelectorAll('#am-det-sug-descricao [data-acao=\"usar-descricao\"]').length === 1", "aprovação com aviso não apareceu");
      assert.ok((await colunaDescricao()).includes("Aviso isolado de teste"));
      descricaoSeoHandler = null;
    });

    await check("46o — cenário de teste: falha do autorreparo preserva motivo, sem texto inválido nem Usar", async () => {
      descricaoSeoHandler = () => ({ status: 200, corpo: { ok: false, codigo: "DESCRICAO_INVALIDA",
        motivo: "Motivo de teste: afirmação sem fonte.", descricao: "TEXTO INVALIDO DE TESTE",
        problemas: [{ detalhe: "Afirmação sem fonte de teste." }],
        autorreparo: { etapa: "falha", chamadasIa: 2, codigo: "REPARO_AINDA_INVALIDO" } } });
      await clicar(cdp, '#am-det-sug-descricao [data-acao="gerar-descricao"]');
      await waitFor(cdp, "document.getElementById('am-det-sug-descricao').innerText.includes('Afirmação sem fonte de teste')", "rejeição não apareceu");
      const col = await colunaDescricao();
      assert.ok(/reparo automático foi tentado, mas não resolveu/i.test(col), col);
      assert.ok(col.includes("Motivo de teste: afirmação sem fonte."), col);
      assert.ok(!/TEXTO INVALIDO DE TESTE|REPARO_AINDA_INVALIDO|antes da aprovação/.test(col), col);
      assert.strictEqual(await nUsarDescricao(), 0);
      descricaoSeoHandler = null;
    });

    await check("46p — cenário de teste: nova geração e novo modal limpam avisos e autorreparo", async () => {
      // Exercita a função real com resposta pendente para observar a limpeza
      // de estado antes da rede, não apenas a ocultação do HTML durante loading.
      const fonte = fs.readFileSync(path.join(PORTAL_DIR, "anuncios-meli.js"), "utf8");
      const gerarReal = fonte.slice(fonte.indexOf("  function gerarDescricao() {"), fonte.indexOf("  function usarDescricao() {"));
      const estadoTeste = { estado: "ok", seq: 0, texto: "Texto anterior de teste", avisos: [{ acao: "Teste" }],
        ajustesEditoriais: ["ITEM_CONTIDO"], autorreparo: { etapa: "remocao" } };
      const detTeste = { anuncio: { item_id: "TESTE-LOCAL" }, descricaoSeo: estadoTeste, descricaoEstado: "ok", token: "teste" };
      new Function("DET", "AM", "api", "repintarDescricao", gerarReal + "; gerarDescricao();")(
        detTeste, { clienteAtual: { slug: "teste-local" } }, () => new Promise(() => {}), () => {});
      assert.deepStrictEqual(estadoTeste.avisos, [], "avisos limpos antes da resposta");
      assert.deepStrictEqual(estadoTeste.ajustesEditoriais, [], "ajustes limpos antes da resposta");
      assert.strictEqual(estadoTeste.autorreparo, null, "autorreparo limpo antes da resposta");
      descricaoSeoHandler = () => ({ status: 200, corpo: { ok: true, descricao: SUG_DESC_A2,
        avisos: [{ acao: "Aviso anterior de teste" }], autorreparo: { etapa: "remocao", removidas: [{ trecho: "Teste" }] } } });
      await clicar(cdp, '#am-det-sug-descricao [data-acao="gerar-descricao"]');
      await waitFor(cdp, "document.getElementById('am-det-sug-descricao').innerText.includes('Aviso anterior de teste')", "aviso inicial não apareceu");
      descricaoSeoAtrasoMs = 600;
      descricaoSeoHandler = null;
      await clicar(cdp, '#am-det-sug-descricao [data-acao="gerar-descricao"]');
      assert.ok(!/Aviso anterior de teste|antes da aprovação/.test(await colunaDescricao()), "loading sem metadados antigos");
      await waitFor(cdp, "document.querySelectorAll('#am-det-sug-descricao [data-acao=\"usar-descricao\"]').length === 1", "nova geração não concluiu");
      descricaoSeoAtrasoMs = 0;
      assert.ok(!/Aviso anterior de teste|antes da aprovação/.test(await colunaDescricao()), "resposta limpa sem metadados antigos");
      await fecharModal(cdp);
      await abrirPrimeiroAnuncio(cdp);
      assert.ok(/Nenhuma sugestão gerada ainda/.test(await colunaDescricao()));
      assert.ok(!/Aviso anterior de teste|antes da aprovação/.test(await colunaDescricao()));
    });

    await check("46q — cenário de teste: reparo por IA explica substituições reais sem mostrar o texto rejeitado", async () => {
      descricaoSeoHandler = () => ({ status: 200, corpo: { ok: true, descricao: SUG_DESC_A2,
        autorreparo: { etapa: "reparo_ia", chamadasIa: 2,
          trocas: [{ id: "S1", antes: "INVALIDO DE TESTE", depois: "Frase corrigida de teste" }] } } });
      await clicar(cdp, '#am-det-sug-descricao [data-acao="gerar-descricao"]');
      await waitFor(cdp, "document.querySelectorAll('#am-det-sug-descricao [data-acao=\"usar-descricao\"]').length === 1", "reparo não apareceu");
      const col = await colunaDescricao();
      assert.ok(/trechos foram corrigidos pela IA e a descrição foi validada novamente/i.test(col), col);
      assert.ok(!col.includes("INVALIDO DE TESTE"), col);
      descricaoSeoHandler = null;
    });

    await check("46r — cenário de teste: avisos e motivo do reparo são escapados, nunca HTML ativo", async () => {
      const ataqueTeste = '<img data-teste-seo="xss" src=x onerror="window.__xssSeoTeste=1">';
      descricaoSeoHandler = () => ({ status: 200, corpo: { ok: true, descricao: SUG_DESC_A2,
        avisos: [{ codigo: ataqueTeste, acao: ataqueTeste, trecho: ataqueTeste, termos: [ataqueTeste] }],
        ajustesEditoriais: [ataqueTeste], autorreparo: { etapa: "remocao", removidas: [{ trecho: ataqueTeste }] } } });
      await clicar(cdp, '#am-det-sug-descricao [data-acao="gerar-descricao"]');
      await waitFor(cdp, "document.querySelectorAll('#am-det-sug-descricao [data-acao=\"usar-descricao\"]').length === 1", "sucesso não apareceu");
      assert.ok((await colunaDescricao()).includes(ataqueTeste), "aviso mantém texto literal");
      assert.strictEqual(await cdp.evaluate("document.querySelectorAll('#am-det-sug-descricao [data-teste-seo]').length"), 0);
      assert.strictEqual(await cdp.evaluate("window.__xssSeoTeste || 0"), 0);
      descricaoSeoHandler = () => ({ status: 200, corpo: { ok: false, codigo: "DESCRICAO_INVALIDA", motivo: ataqueTeste,
        problemas: [{ detalhe: ataqueTeste, termos: [ataqueTeste] }], autorreparo: { etapa: "falha", chamadasIa: 2 } } });
      await clicar(cdp, '#am-det-sug-descricao [data-acao="gerar-descricao"]');
      await waitFor(cdp, "document.getElementById('am-det-sug-descricao').innerText.includes('reparo automático foi tentado')", "falha não apareceu");
      assert.ok((await colunaDescricao()).includes(ataqueTeste));
      assert.strictEqual(await cdp.evaluate("document.querySelectorAll('#am-det-sug-descricao [data-teste-seo]').length"), 0);
      assert.strictEqual(await cdp.evaluate("window.__xssSeoTeste || 0"), 0);
      descricaoSeoHandler = null;
    });

    await check("46s — cenário de teste: autorreparo aprovado não aplica nem escreve automaticamente", async () => {
      const antes = pedidos.length;
      const rascunhoAntes = await cdp.evaluate("document.getElementById('am-det-descricao').value");
      descricaoSeoHandler = () => ({ status: 200, corpo: { ok: true, descricao: SUG_DESC_A2,
        avisos: [{ acao: "Aviso de teste sem aplicação" }], autorreparo: { etapa: "reparo_ia", chamadasIa: 2,
          trocas: [{ antes: "Teste anterior", depois: "Teste corrigido" }] } } });
      await clicar(cdp, '#am-det-sug-descricao [data-acao="gerar-descricao"]');
      await waitFor(cdp, "document.querySelectorAll('#am-det-sug-descricao [data-acao=\"usar-descricao\"]').length === 1", "sugestão não apareceu");
      assert.strictEqual(await cdp.evaluate("document.getElementById('am-det-descricao').value"), rascunhoAntes);
      assert.strictEqual(await cdp.evaluate("document.querySelectorAll('#am-det-savebar').length"), 0);
      assert.ok(!(await colunaDescricao()).includes("Usada nesta edição"));
      assert.deepStrictEqual(pedidos.slice(antes).filter((u) => /\/conteudo|\/preco|\/fotos|\/imagens|\/aprovar|\/otimizar/.test(u)), []);
      descricaoSeoHandler = null;
    });

    await check("46m — em todo o percurso, nenhum PATCH /conteudo levou descrição que não veio de 'Usar'/digitação", async () => {
      const descricoesEnviadas = corpos.filter((c) => /\/conteudo/.test(c.url) && c.body && c.body.descricao !== undefined)
        .map((c) => c.body.descricao);
      assert.ok(descricoesEnviadas.every((d) => d === SUG_DESC_A || d.startsWith(DESC_A)),
        "descrições enviadas: " + JSON.stringify(descricoesEnviadas));
    });

    await check("— nenhuma exceção de JS não tratada durante todo o percurso", async () => {
      const relevantes = excecoes.filter((m) => !/Failed to fetch|NetworkError|ERR_/i.test(m));
      assert.deepStrictEqual(relevantes, [], `exceções: ${JSON.stringify(relevantes)}`);
      const jsErros = (await cdp.evaluate("window.__erros || []"))
        .filter((m) => !/Failed to fetch|NetworkError|ERR_/i.test(m));
      assert.deepStrictEqual(jsErros, [], `erros de JS na página: ${JSON.stringify(jsErros)}`);
    });

    console.log(`\n✓ ${checks} verificações do novo detalhe (modal central) de Anúncios ML`);
  } catch (err) {
    try {
      const jsErros = await cdp.evaluate("window.__erros || []");
      if (jsErros && jsErros.length) console.error("erros de JS na página:", JSON.stringify(jsErros, null, 2));
    } catch (_) { /* a sessão pode já ter caído */ }
    throw err;
  } finally {
    if (cdp) cdp.close();
    chrome.kill("SIGTERM");
    server.close();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
