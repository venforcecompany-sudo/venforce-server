require("dotenv").config();

const express = require("express");
const bcrypt = require("bcrypt");
const cors = require("cors");
const multer = require("multer");
const XLSX = require("xlsx");
const path = require("path");
const fs = require("fs");
const archiver = require("archiver");
const crypto = require("crypto");
const pool = require("./config/database");
const { processarFechamento, compilarFechamentos } = require("./utils/fechamento/process");
const { processarFechamentoMeli, compilarFechamentosMeli } = require("./utils/fechamento/meliConversaoService");
const { mlFetch } = require("./utils/mlClient");
const { startTokenRefreshWorker } = require("./utils/tokenRefreshWorker");
const { authMiddleware, requireAdmin } = require("./middlewares/authMiddleware");
const {
  apiKeyMiddleware,
  requireDesignAccess,
  requireAutomacoesAccess,
} = require("./middlewares/accessMiddleware");
const { requireBaseNaCarteira } = require("./middlewares/carteiraMiddleware");
const {
  ehAdmin: authzEhAdmin,
  clientesAutorizadosSet: authzClientesAutorizadosSet,
} = require("./services/squads/authorizationService");
const { toNumber, positive, round2 } = require("./utils/numberUtils");
const {
  normalizeText,
  normalizeKey,
  normalizeId,
  normalizeIdNoPrefix,
  normalizeMatchKey,
  normalizeShopeeId,
  findField,
} = require("./utils/textUtils");
const {
  repairWorksheetRef,
  lerWorkbookPlanilha,
  readSheetRows,
  parseSpreadsheet,
  detectMeliHeaderRow,
  createBadRequestError,
} = require("./utils/excelUtils");
const {
  parseMeliRows,
  parseMeliCostRows,
  buildMeliCostMap,
  allocateByUnits,
} = require("./services/fechamentoFinanceiro/meliFinanceiroService");
const {
  parseShopeeSalesRows,
  calculateShopeeItem,
  getShopeeFeesByTicket,
  isShopeePerformanceSheet,
  isShopeeMassUpdateSheet,
  parseShopeeOrderAllForStatus,
  buildShopeePerfSkuBridge,
  buildShopeeStatusSummary,
  parseCostRows,
} = require("./services/fechamentoFinanceiro/shopeePerformanceService");
const authRoutes = require("./routes/authRoutes");
const logsRoutes = require("./routes/logsRoutes");
const fechamentosFinanceiroRoutes = require("./routes/fechamentosFinanceiroRoutes");
const fechamentoDebugRoutes = require("./routes/fechamentoDebugRoutes");
const fechamentoIncidentesRoutes = require("./routes/fechamentoIncidentesRoutes");
const mlRoutes = require("./routes/mlRoutes");
const clienteContasRoutes = require("./routes/clienteContasRoutes");
const meRoutes = require("./routes/meRoutes");
const squadsRoutes = require("./routes/squadsRoutes");
const clienteResponsaveisRoutes = require("./routes/clienteResponsaveisRoutes");
const visaoRoutes = require("./routes/visaoRoutes");
const financeiroVisaoRoutes = require("./routes/financeiroVisaoRoutes");
const { verificarDependenciasCliente } = require("./services/clientes/clienteDependenciasService");
const { purgarClientePermanentemente } = require("./services/clientes/clientePurgeService");
const automacoesRoutes = require("./routes/automacoesRoutes");
const entregasClienteRoutes = require("./routes/entregasClienteRoutes");
const basesRoutes = require("./routes/basesRoutes");
const baseVinculosRoutes = require("./routes/baseVinculosRoutes");
const assistenteBaseRoutes = require("./routes/assistenteBaseRoutes");
const operacaoRoutes = require("./routes/operacaoRoutes");
const fullRoutes = require("./routes/fullRoutes");
const cliente360Routes = require("./routes/cliente360Routes");
const cliente360ResultadoRoutes = require("./routes/cliente360ResultadoRoutes");
const centralVendasRoutes = require("./routes/centralVendasRoutes");
const motorMargemRoutes = require("./routes/motorMargemRoutes");
const diagnosticoInicialRoutes = require("./routes/diagnosticoInicialRoutes");
const adsRoutes = require("./routes/adsRoutes");
const designImageRoutes = require("./routes/designImageRoutes");
const designStudioRoutes = require("./routes/designStudioRoutes");
const designStudioService = require("./services/designStudio/designStudioService");
const { registrarLog, extrairIp, dadosUsuarioDeReq } = require("./services/activityLogService");
const meliAnunciosRoutes = require("./routes/meliAnunciosRoutes");
const metricasRoutes = require("./routes/metricasRoutes");
const clickupRoutes = require("./routes/clickupRoutes");
const externalFirebaseRoutes = require("./routes/externalFirebaseRoutes");
const tiktokShopRoutes = require("./routes/tiktokShopRoutes");
const shopeeRoutes = require("./routes/shopeeRoutes");
const sellerRoutes = require("./routes/sellerRoutes");
const { ensureCentralVendasTables } = require("./services/centralVendas/centralVendasRepository");
const { ensureDiagnosticoInicialTables } = require("./services/diagnosticoInicial/diagnosticoInicialRepository");
const observabilityRoutes = require("./routes/observabilityRoutes");
const dashboardRoutes = require("./routes/dashboardRoutes");
const observabilityService = require("./services/observabilityService");
const {
  observabilityMiddleware,
  captureRequestError,
} = require("./middlewares/observabilityMiddleware");
const { ensureObservabilityTables } = require("./repositories/observabilityRepository");
const { ensureFechamentoIncidenteTables } = require("./repositories/fechamentoIncidenteRepository");
const fechamentoIncidentStorageService = require("./services/fechamentoFinanceiro/incidente/fechamentoIncidentStorageService");
const { ensureSquadsTables, squadsAtivosDeClientes } = require("./services/squads/squadsRepository");
const squadService = require("./services/squads/squadService");
const { ensureEntregasClienteSchema } = require("./services/schema/schemaEnsure");
const { logReadinessNoBoot, verificarSchemaV3 } = require("./services/schema/schemaReadiness");
const {
  MARKETPLACES_SUPORTADOS,
  normalizarProdutoIdTikTok,
  normalizarSkuIdTikTok,
  erroSkuIdDuplicadoTikTok,
  ensureColunasCustos,
} = require("./services/bases/baseCustosService");
const baseImportService = require("./services/bases/baseImportService");
const baseDependenciesService = require("./services/bases/baseDependenciesService");

const app = express();
const PORT = process.env.PORT || 3333;

// MIDDLEWARES
const CORS_ALLOWED_HEADERS = [
  "Content-Type",
  "Authorization",
  "x-api-key",
  // Correlação navegador → servidor (Control Center)
  "X-Request-Id",
  "X-VF-Debug-Session",
  "X-VF-Debug-Tab",
];
app.use(cors({
  origin: true,
  credentials: false,
  methods: ["GET","POST","PUT","PATCH","DELETE","OPTIONS"],
  allowedHeaders: CORS_ALLOWED_HEADERS,
  // Sem exposedHeaders o navegador não consegue LER o id devolvido.
  exposedHeaders: ["X-Request-Id"],
}));
app.options(/.*/, cors());
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
app.use(observabilityMiddleware);
app.use("/downloads", express.static(path.join(__dirname, "downloads")));
app.use("/external/firebase", externalFirebaseRoutes);

// UPLOAD (memória)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// AUXILIARES
function normalizarSlug(nome) {
  return String(nome || "").trim().toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\-]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
}

function normalizarMlItemId(valor) {
  const texto = String(valor || "").trim().toUpperCase();
  if (!texto) return "";
  // Já tem MLB ou MLBU dentro do texto: extrai o padrão completo
  const match = texto.match(/MLB[U]?\d+/);
  if (match) return match[0];
  // Limpa aspas e ".0" do final (Excel serializa números como "12345.0")
  let limpo = texto.replace(/^['"]+|['"]+$/g, "").trim();
  if (/^\d+\.0+$/.test(limpo)) limpo = limpo.replace(/\.0+$/, "");
  // Se for puramente numérico, adiciona MLB
  if (/^\d+$/.test(limpo)) return "MLB" + limpo;
  // Outro formato (SKU customizado, etc): retorna sem alteração
  return texto;
}

function numeroSeguro(valor) {
  if (valor === null || valor === undefined || valor === "") return 0;
  if (typeof valor === "number") return Number.isFinite(valor) ? valor : 0;
  let texto = String(valor)
    .trim()
    .replace(/\s/g, "")
    .replace(/R\$/gi, "")
    .replace(/US\$/gi, "")
    .replace(/€/g, "")
    .replace("%", "");
  if (!texto) return 0;
  if (texto.includes(",") && texto.includes(".")) { texto = texto.replace(/\./g, "").replace(",", "."); }
  else if (texto.includes(",")) { texto = texto.replace(",", "."); }
  const n = Number(texto);
  return Number.isFinite(n) ? n : 0;
}

function normalizarImposto(valor) {
  // String contendo "%": parseia número e divide por 100
  // Ex: "14,50%" → 0.145; "12%" → 0.12
  if (typeof valor === "string" && valor.includes("%")) {
    return numeroSeguro(valor) / 100;
  }
  const n = numeroSeguro(valor);
  // Número >= 1: assume escala 0-100, converte pra decimal
  // Ex: 12 → 0.12; 14.5 → 0.145
  if (n >= 1) return n / 100;
  // Número < 1: já é decimal, mantém
  // Ex: 0.077 → 0.077; 0.12 → 0.12
  return n;
}

function obterValorColuna(row, nomes) {
  for (const nome of nomes) {
    if (row[nome] !== undefined && row[nome] !== null && row[nome] !== "") return row[nome];
  }
  return "";
}

// Candidatos de cabeçalho para o ID de variação Shopee (id_model).
const CANDIDATOS_ID_MODEL_HEADER = [
  "model id", "model_id", "modelid", "id model", "id_model", "id do modelo",
  "id da variacao", "id da variação", "variation id", "variante identificador",
];

function limparIdModel(valor) {
  let limpo = String(valor == null ? "" : valor).replace(/^﻿/, "").trim();
  if (!limpo) return null;
  limpo = limpo.replace(/^['"]+|['"]+$/g, "").trim();
  if (!limpo) return null;
  if (/^\d+\.0+$/.test(limpo)) limpo = limpo.replace(/\.0+$/, "");
  const sci = limpo.replace(",", ".");
  if (/^\d+(\.\d+)?[eE]\+?\d+$/.test(sci)) {
    const n = Number(sci);
    if (Number.isFinite(n)) return Math.trunc(n).toString();
  }
  return limpo || null;
}

function extrairIdModel(row) {
  for (const [k, v] of Object.entries(row)) {
    if (CANDIDATOS_ID_MODEL_HEADER.includes(String(k).trim().toLowerCase())) {
      return limparIdModel(v);
    }
  }
  return null;
}

// ─── TikTok Shop: cabeçalhos da planilha de custos ───────────────────────────
// Contrato canônico da planilha:  ID | ID DO SKU | CUSTO | IMPOSTO
//   ID         = product_id do produto  (repete entre as variações)
//   ID DO SKU  = sku_id da variação      (chave autoritativa de custo)
//
// Aliases já em caixa baixa e sem acento — comparados contra o cabeçalho limpo
// por normalizarChaveHeader(). As duas listas são DISJUNTAS de propósito e o
// ID DO SKU é resolvido primeiro (ver resolverColunasIdTikTok): "ID do SKU" é
// mais específico que "ID" e não pode ser roubado pela coluna do produto.
const TIKTOK_ALIASES_SKU_ID = ["id do sku", "id sku", "sku id", "sku_id", "skuid", "tiktok sku id", "id da variacao", "id variacao"];
const TIKTOK_ALIASES_ID = ["id", "id do produto", "id produto", "produto_id", "product id", "id do product"];
const TIKTOK_ALIASES_CUSTO = ["custo unitario", "custo", "preco de custo", "custo_produto", "cmv unitario"];
const TIKTOK_ALIASES_IMPOSTO = ["imposto", "imposto (%)", "imposto percentual", "aliquota", "imposto_percentual"];
// LEGADO — nomes e SKU textual continuam sendo lidos quando existem na
// planilha (compatibilidade histórica), mas NÃO são obrigatórios e NÃO fazem
// parte de nenhuma chave de custo.
const TIKTOK_ALIASES_PRODUTO = ["nome do produto", "produto", "product name"];
const TIKTOK_ALIASES_VARIACAO = ["variacao", "nome da variacao", "nome do sku"];

function normalizarChaveHeader(valor) {
  return String(valor || "")
    .replace(/^﻿/, "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

// Primeira coluna cujo cabeçalho bate com um dos aliases. Devolve o valor CRU,
// sem conversão numérica (essencial para o ID do SKU do TikTok).
function obterValorPorAlias(row, aliases) {
  for (const alias of aliases) {
    for (const [k, v] of Object.entries(row)) {
      if (normalizarChaveHeader(k) === alias) {
        if (v !== undefined && v !== null && String(v).trim() !== "") return v;
      }
    }
  }
  return "";
}

// Detecção automática (usada só quando o marketplace não vem no body). Fica
// restrita aos aliases inconfundíveis do sku_id: "id da variacao" também é
// cabeçalho da Shopee (id_model) e não pode arrastar planilha Shopee p/ TikTok.
function headerParecerTikTok(headersNormalizados) {
  return headersNormalizados.some((h) =>
    ["id do sku", "id sku", "sku id", "sku_id", "skuid", "tiktok sku id"].includes(h)
  );
}

// Resolve as DUAS colunas de ID do TikTok numa única passada, garantindo que
// uma coluna nunca seja lida como os dois campos. "ID DO SKU" é resolvido
// primeiro: é o mais específico e é a chave de custo.
// Preferência dentro de cada campo: primeiro alias com valor preenchido;
// se nenhum tiver valor, o primeiro alias que exista (a coluna continua
// "consumida", então o outro campo não a rouba).
function resolverColunasIdTikTok(row) {
  const chaves = Object.keys(row);
  const normalizadas = new Map(chaves.map((k) => [k, normalizarChaveHeader(k)]));

  const acharChave = (aliases, usadas) => {
    let primeiraExistente = null;
    for (const alias of aliases) {
      for (const k of chaves) {
        if (usadas.has(k) || normalizadas.get(k) !== alias) continue;
        if (primeiraExistente === null) primeiraExistente = k;
        const v = row[k];
        if (v !== undefined && v !== null && String(v).trim() !== "") return k;
      }
    }
    return primeiraExistente;
  };

  const usadas = new Set();
  const chaveSkuId = acharChave(TIKTOK_ALIASES_SKU_ID, usadas);
  if (chaveSkuId) usadas.add(chaveSkuId);
  const chaveProdutoId = acharChave(TIKTOK_ALIASES_ID, usadas);

  return {
    skuIdBruto: chaveSkuId ? row[chaveSkuId] : "",
    produtoIdBruto: chaveProdutoId ? row[chaveProdutoId] : "",
  };
}

// Lê SÓ a primeira linha da aba (para decidir o marketplace antes de escolher
// o modo de leitura das células).
function lerCabecalhoPlanilha(sheet) {
  const ref = sheet && sheet["!ref"];
  if (!ref) return [];
  const range = XLSX.utils.decode_range(ref);
  const soCabecalho = { s: { ...range.s }, e: { ...range.e, r: range.s.r } };
  const linhas = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false, range: soCabecalho });
  return (linhas[0] || []).map(normalizarChaveHeader);
}

function parsePlanilha(buffer, originalName, marketplace) {
  const ext = path.extname(originalName).toLowerCase();
  if (![".xlsx", ".xls", ".csv"].includes(ext)) throw new Error("Formato inválido. Envie .xlsx, .xls ou .csv");
  const workbook = lerWorkbookPlanilha(buffer, originalName);
  const primeiraAba = workbook.SheetNames[0];
  if (!primeiraAba) throw new Error("A planilha não possui abas válidas");
  const sheet = workbook.Sheets[primeiraAba];

  // Marketplace explícito (vindo do body) tem prioridade. Sem ele, mantém a
  // detecção automática por cabeçalho ("model id" e variantes / "ID do SKU").
  // Em Shopee os IDs são numéricos do próprio Shopee — NÃO devem receber MLB.
  const mktExplicito = MARKETPLACES_SUPORTADOS.includes(marketplace) ? marketplace : null;
  const isTikTok = mktExplicito
    ? mktExplicito === "tiktok"
    : headerParecerTikTok(lerCabecalhoPlanilha(sheet));

  // TikTok lê as células como texto (raw:false): com raw:true o xlsx devolveria
  // o ID do SKU como número e 19 dígitos não cabem num double. MELI e Shopee
  // seguem no modo antigo (raw padrão), sem mudança de comportamento.
  const rows = isTikTok
    ? XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false })
    : XLSX.utils.sheet_to_json(sheet, { defval: "" });
  if (!rows.length) throw new Error("A planilha está vazia");

  const headers = Object.keys(rows[0] || {}).map((h) => h.trim().toLowerCase());
  const headerShopee = headers.some((h) => CANDIDATOS_ID_MODEL_HEADER.includes(h));
  const isShopee = mktExplicito ? mktExplicito === "shopee" : (!isTikTok && headerShopee);

  const resultado = [];
  // TikTok: ID DO SKU (sku_id) é obrigatório — é a identidade da variação.
  // O ID do produto é informativo e PODE repetir. A validação de duplicidade
  // acontece num segundo passe (precisa ver TODAS as linhas do lote).
  const candidatosTikTok = [];
  let linhaPlanilhaAtual = 1; // 1 = cabeçalho; dados começam na linha 2

  for (const row of rows) {
    linhaPlanilhaAtual += 1;
    const r = {};
    for (const [k, v] of Object.entries(row)) {
      const cleanKey = k
        .trim()
        .replace(/^\uFEFF/, "")
        .replace(/^['"]+|['"]+$/g, "");
      const cleanVal =
        typeof v === "string" ? v.replace(/^['"]+|['"]+$/g, "") : v;
      r[cleanKey] = cleanVal;
    }

    if (isTikTok) {
      // TikTok: duas colunas de ID, ambas sempre texto. As normalizações
      // rejeitam notação científica (o Excel já perdeu os dígitos originais).
      //   ID        → produto_id (product_id, informativo, pode repetir)
      //   ID DO SKU → sku_id     (variação, chave de custo, único por base)
      const { skuIdBruto, produtoIdBruto } = resolverColunasIdTikTok(r);
      const skuIdTikTok = normalizarSkuIdTikTok(skuIdBruto);
      const produtoIdTikTok = normalizarProdutoIdTikTok(produtoIdBruto);
      // Sem ID DO SKU não há como identificar a variação: linha ignorada
      // (mesmo tratamento de linha em branco).
      if (!skuIdTikTok) continue;

      const custoRaw = obterValorPorAlias(r, TIKTOK_ALIASES_CUSTO);
      candidatosTikTok.push({
        linha: linhaPlanilhaAtual,
        produto_id: produtoIdTikTok,
        sku_id: skuIdTikTok,
        // SKU textual não é lido nem exigido no modelo novo (fica '').
        sku: "",
        custo_produto: numeroSeguro(custoRaw),
        imposto_percentual: normalizarImposto(obterValorPorAlias(r, TIKTOK_ALIASES_IMPOSTO)),
        // TikTok não usa taxa fixa nem id_model.
        taxa_fixa: 0,
        id_model: null,
        // Nomes: legado, opcionais, só exibição/auditoria.
        produto_nome: String(obterValorPorAlias(r, TIKTOK_ALIASES_PRODUTO) || "").trim() || null,
        variacao_nome: String(obterValorPorAlias(r, TIKTOK_ALIASES_VARIACAO) || "").trim() || null,
        // custo_produto é NOT NULL no banco: linha sem custo não é persistida.
        tem_custo: String(custoRaw == null ? "" : custoRaw).trim() !== "",
      });
      continue;
    }

    const idRaw = String(obterValorColuna(r, ["id", "ID", "Id", "sku", "SKU", "Sku", "mlb", "MLB", "Mlb"])).trim();
    if (!idRaw) continue;

    // Limpa aspas e ".0" sobrante (Excel serializa números como string)
    let idClean = idRaw.replace(/^['"]+|['"]+$/g, "").replace(/^\uFEFF/, "").trim();
    if (/^\d+\.0+$/.test(idClean)) idClean = idClean.replace(/\.0+$/, "");

    // Shopee: mantém ID como veio (numérico). MeLi: normaliza para garantir prefixo MLB.
    const id = isShopee ? idClean : normalizarMlItemId(idClean);
    if (!id) continue;

    resultado.push({
      produto_id: id,
      custo_produto: numeroSeguro(obterValorColuna(r, ["Custo", "custo_produto", "CUSTO_PRODUTO", "custo", "CUSTO", "Custo Produto"])),
      imposto_percentual: normalizarImposto(obterValorColuna(r, ["Imposto", "imposto_percentual", "IMPOSTO_PERCENTUAL", "imposto", "IMPOSTO", "Imposto Percentual"])),
      taxa_fixa: numeroSeguro(obterValorColuna(r, ["Taxa", "taxa_fixa", "TAXA_FIXA", "taxa", "TAXA", "Taxa Fixa"])),
      // id_model só é preenchido para Shopee (ID de variação).
      id_model: isShopee ? extrairIdModel(r) : null,
      produto_nome: null,
      variacao_nome: null,
      tem_custo: true,
    });
  }

  if (isTikTok) {
    // Segundo passe: ID do produto repetido é ESPERADO (uma linha por
    // variação). O que não pode é o mesmo ID DO SKU aparecer duas vezes:
    //   · valores idênticos  → duplicidade inofensiva, mantém uma linha;
    //   · valores divergentes → 422. Nunca escolher um custo arbitrário.
    const porSkuId = new Map();
    for (const c of candidatosTikTok) {
      const anterior = porSkuId.get(c.sku_id);
      if (!anterior) {
        porSkuId.set(c.sku_id, c);
        continue;
      }
      const mesmoCusto = anterior.custo_produto === c.custo_produto;
      const mesmoImposto = anterior.imposto_percentual === c.imposto_percentual;
      const mesmoTemCusto = anterior.tem_custo === c.tem_custo;
      if (!mesmoCusto || !mesmoImposto || !mesmoTemCusto) {
        const erroLinha = new Error(
          erroSkuIdDuplicadoTikTok(c.sku_id, `(linhas ${anterior.linha} e ${c.linha})`)
        );
        erroLinha.statusCode = 422;
        erroLinha.payload = { ok: false, erro: erroLinha.message };
        throw erroLinha;
      }
      // Linha repetida idêntica: completa o que faltar (ex.: product_id/nomes
      // preenchidos só em uma das ocorrências) e segue com uma única linha.
      if (!anterior.produto_id && c.produto_id) anterior.produto_id = c.produto_id;
      if (!anterior.produto_nome && c.produto_nome) anterior.produto_nome = c.produto_nome;
      if (!anterior.variacao_nome && c.variacao_nome) anterior.variacao_nome = c.variacao_nome;
    }

    for (const c of porSkuId.values()) {
      resultado.push({
        produto_id: c.produto_id,
        sku_id: c.sku_id,
        sku: c.sku,
        custo_produto: c.custo_produto,
        imposto_percentual: c.imposto_percentual,
        taxa_fixa: c.taxa_fixa,
        id_model: c.id_model,
        produto_nome: c.produto_nome,
        variacao_nome: c.variacao_nome,
        tem_custo: c.tem_custo,
      });
    }
  }

  if (!resultado.length) {
    throw new Error(
      isTikTok
        ? "Nenhum ID DO SKU válido encontrado na planilha. O formato esperado é: ID | ID DO SKU | CUSTO | IMPOSTO."
        : "Nenhum ID válido encontrado na planilha"
    );
  }
  return resultado;
}

function gerarApiKey() {
  return "vf_" + crypto.randomBytes(32).toString("hex");
}

// ROTAS BÁSICAS
app.get("/", (req, res) => res.send("API VenForce rodando 🚀"));
app.get("/health", (req, res) => res.json({ ok: true, mensagem: `VENFORCE OK porta ${PORT}` }));

// BLOCO 17 — readiness de SCHEMA. Só booleanos estruturais (presença de
// coluna/tabela) + nome da migration correspondente; NENHUM dado, token ou
// PII. `ok=false` só quando falta algo REQUIRED. 503 nesse caso para um
// health-check externo conseguir distinguir "no ar mas sem schema" de "ok".
app.get("/health/schema", async (req, res) => {
  try {
    const r = await verificarSchemaV3();
    res.status(r.ok ? 200 : 503).json(r);
  } catch (err) {
    res.status(500).json({ ok: false, checagemFalhou: true, erro: err.message });
  }
});

// SETUP TABELAS
app.get("/setup", async (req, res) => {
  if (process.env.ENABLE_SETUP_ROUTE !== "true") {
    return res.status(403).json({ ok: false, erro: "Rota desabilitada em produção" });
  }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
        nome TEXT NOT NULL DEFAULT '', ativo BOOLEAN NOT NULL DEFAULT true,
        role TEXT NOT NULL DEFAULT 'user', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE TABLE IF NOT EXISTS bases (
        id SERIAL PRIMARY KEY, slug TEXT UNIQUE NOT NULL, nome TEXT NOT NULL,
        ativo BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS user_bases (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        base_id INTEGER NOT NULL REFERENCES bases(id) ON DELETE CASCADE,
        PRIMARY KEY (user_id, base_id)
      );
      CREATE TABLE IF NOT EXISTS custos (
        id SERIAL PRIMARY KEY, base_id INTEGER NOT NULL REFERENCES bases(id) ON DELETE CASCADE,
        produto_id TEXT NOT NULL, custo_produto NUMERIC NOT NULL DEFAULT 0,
        imposto_percentual NUMERIC NOT NULL DEFAULT 0, taxa_fixa NUMERIC NOT NULL DEFAULT 0,
        UNIQUE (base_id, produto_id)
      );
      CREATE TABLE IF NOT EXISTS clientes (
        id SERIAL PRIMARY KEY,
        nome TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        api_key TEXT UNIQUE NOT NULL,
        ativo BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS base_cliente_vinculos (
        id SERIAL PRIMARY KEY,
        base_id INTEGER REFERENCES bases(id) ON DELETE CASCADE,
        cliente_id INTEGER REFERENCES clientes(id) ON DELETE CASCADE,
        marketplace TEXT,
        origem TEXT DEFAULT 'manual',
        ativo BOOLEAN DEFAULT true,
        confirmado_por INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_base_cliente_vinculos_base_ativo
        ON base_cliente_vinculos (base_id)
        WHERE ativo = true;
CREATE TABLE IF NOT EXISTS callbacks (
        id SERIAL PRIMARY KEY,
        cliente_id INTEGER REFERENCES clientes(id) ON DELETE SET NULL,
        cliente_nome TEXT,
        base_slug TEXT,
        status_code INTEGER,
        duracao_ms INTEGER,
        ip TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS ml_tokens (
        id            SERIAL PRIMARY KEY,
        ml_user_id    TEXT NOT NULL UNIQUE,
        access_token  TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at    TIMESTAMP NOT NULL,
        created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS scans (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        base_slug TEXT NOT NULL,
        conta_ml TEXT NOT NULL,
        total_anuncios INTEGER NOT NULL DEFAULT 0,
        mc_medio NUMERIC(10,4) NOT NULL DEFAULT 0,
        saudaveis INTEGER NOT NULL DEFAULT 0,
        atencao INTEGER NOT NULL DEFAULT 0,
        criticos INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS relatorios (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        cliente_id INTEGER REFERENCES clientes(id) ON DELETE SET NULL,
        cliente_slug TEXT NOT NULL,
        base_id INTEGER REFERENCES bases(id) ON DELETE SET NULL,
        base_slug TEXT NOT NULL,
        margem_alvo NUMERIC(6,4),
        escopo TEXT NOT NULL DEFAULT 'pagina_atual',
        status TEXT NOT NULL DEFAULT 'concluido',
        total_itens INTEGER NOT NULL DEFAULT 0,
        itens_com_base INTEGER NOT NULL DEFAULT 0,
        itens_sem_base INTEGER NOT NULL DEFAULT 0,
        itens_criticos INTEGER NOT NULL DEFAULT 0,
        itens_atencao INTEGER NOT NULL DEFAULT 0,
        itens_saudaveis INTEGER NOT NULL DEFAULT 0,
        mc_media NUMERIC(10,6),
        observacoes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_relatorios_cliente_slug ON relatorios(cliente_slug, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_relatorios_cliente_id ON relatorios(cliente_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS relatorio_itens (
        id SERIAL PRIMARY KEY,
        relatorio_id INTEGER NOT NULL REFERENCES relatorios(id) ON DELETE CASCADE,
        item_id TEXT NOT NULL,
        sku TEXT,
        titulo TEXT,
        status_anuncio TEXT,
        listing_type_id TEXT,
        preco_original NUMERIC(14,4),
        preco_promocional NUMERIC(14,4),
        preco_efetivo NUMERIC(14,4),
        custo NUMERIC(14,4),
        imposto_percentual NUMERIC(8,4),
        taxa_fixa NUMERIC(14,4),
        frete NUMERIC(14,4),
        comissao NUMERIC(14,4),
        comissao_percentual NUMERIC(8,4),
        lc NUMERIC(14,4),
        mc NUMERIC(10,6),
        preco_alvo NUMERIC(14,4),
        preco_sugerido NUMERIC(14,4),
        diferenca_preco NUMERIC(14,4),
        acao_recomendada TEXT,
        explicacao_calculo TEXT,
        diagnostico TEXT,
        tem_base BOOLEAN NOT NULL DEFAULT false
      );
      CREATE INDEX IF NOT EXISTS idx_relatorio_itens_relatorio ON relatorio_itens(relatorio_id);
      CREATE INDEX IF NOT EXISTS idx_relatorio_itens_diagnostico ON relatorio_itens(relatorio_id, diagnostico);
    `);

    // `entregas_cliente` (tabela + coluna cliente_conta_id D1 + índices, SEM o
    // índice UNIQUE de D4) vem de um único lugar agora — o mesmo `ensure` que
    // roda no boot, porque `/setup` é desabilitado em produção. Ver
    // server/services/schema/schemaEnsure.js.
    await ensureEntregasClienteSchema(pool);

    await pool.query(`
  ALTER TABLE bases
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
`);

    await pool.query(`
  ALTER TABLE bases
  ADD COLUMN IF NOT EXISTS marketplace TEXT NOT NULL DEFAULT 'meli';
`);

    await pool.query(`
  ALTER TABLE custos
  ADD COLUMN IF NOT EXISTS id_model TEXT;
`);

    // Nomes vindos da planilha do TikTok Shop + carimbo por linha de custo.
    await pool.query(`
  ALTER TABLE custos
  ADD COLUMN IF NOT EXISTS produto_nome TEXT;
`);

    await pool.query(`
  ALTER TABLE custos
  ADD COLUMN IF NOT EXISTS variacao_nome TEXT;
`);

    await pool.query(`
  ALTER TABLE custos
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
`);

    // LEGADO: SKU textual. MELI/Shopee nunca preenchem (fica '' — o default) e
    // o TikTok deixou de usar quando a identidade passou a ser sku_id.
    await pool.query(`
  ALTER TABLE custos
  ADD COLUMN IF NOT EXISTS sku TEXT NOT NULL DEFAULT '';
`);
    // TikTok Shop: sku_id = coluna "ID DO SKU" da planilha (id da variação,
    // 18–19 dígitos, TEXT). É a identidade de custo do TikTok — o produto_id
    // repete entre as variações do mesmo produto. Ver a migration
    // 20260810_add_sku_id_tiktok.sql (inclui o backfill das bases antigas).
    await pool.query(`
  ALTER TABLE custos
  ADD COLUMN IF NOT EXISTS sku_id TEXT NOT NULL DEFAULT '';
`);
    await pool.query(`
  DO $$
  BEGIN
    ALTER TABLE custos DROP CONSTRAINT IF EXISTS custos_base_id_produto_id_key;
  EXCEPTION WHEN undefined_object THEN NULL;
  END $$;
`);
    await pool.query(`DROP INDEX IF EXISTS uq_custos_base_produto_sku;`);
    await pool.query(`
  CREATE UNIQUE INDEX IF NOT EXISTS uq_custos_base_sku_id
    ON custos (base_id, sku_id) WHERE sku_id <> '';
`);
    await pool.query(`
  CREATE UNIQUE INDEX IF NOT EXISTS uq_custos_base_produto_sku_legado
    ON custos (base_id, produto_id, sku) WHERE sku_id = '';
`);

    await pool.query(`
      ALTER TABLE ml_tokens ADD COLUMN IF NOT EXISTS cliente_id INTEGER REFERENCES clientes(id) ON DELETE CASCADE;
    `);

    await pool.query(`
      ALTER TABLE ml_tokens ADD COLUMN IF NOT EXISTS token_status TEXT DEFAULT 'valid';
    `);

    await pool.query(`
DO $$
BEGIN
  ALTER TABLE ml_tokens DROP CONSTRAINT IF EXISTS ml_tokens_ml_user_id_key;
EXCEPTION
  WHEN undefined_object THEN NULL;
END $$;
    `);

    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ml_tokens_cliente_ml_user_unique ON ml_tokens (cliente_id, ml_user_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_ml_tokens_cliente ON ml_tokens (cliente_id);
    `);

    await pool.query(`
      ALTER TABLE relatorio_itens ADD COLUMN IF NOT EXISTS sku TEXT;
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS relatorio_pastas (
        id SERIAL PRIMARY KEY,
        nome TEXT NOT NULL,
        descricao TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      ALTER TABLE relatorios
      ADD COLUMN IF NOT EXISTS pasta_id INTEGER REFERENCES relatorio_pastas(id) ON DELETE SET NULL;
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_relatorios_pasta_id ON relatorios(pasta_id);
    `);
    
    res.json({ ok: true, mensagem: "Tabelas criadas com sucesso" });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.use("/auth", authRoutes);
app.use("/admin/logs", logsRoutes);
app.use("/admin/observability", observabilityRoutes);
app.use("/dashboard", dashboardRoutes);
app.use("/fechamentos", fechamentosFinanceiroRoutes);
app.use("/fechamentos", fechamentoDebugRoutes);
app.use("/fechamentos", fechamentoIncidentesRoutes);
app.use("/", mlRoutes);
app.use("/", clienteContasRoutes);
app.use("/me", meRoutes);
app.use("/squads", squadsRoutes);
app.use("/clientes", clienteResponsaveisRoutes);
app.use("/", tiktokShopRoutes);
app.use("/shopee", shopeeRoutes);
app.use("/", automacoesRoutes);
app.use("/", entregasClienteRoutes);
app.use("/", basesRoutes);
app.use("/base-vinculos", baseVinculosRoutes);
app.use("/bases/assistente", assistenteBaseRoutes);
// Cockpit de resultado (tela React) antes do router legado da 360: só subcaminhos
// `/:slug/<sub>`, não colide com o `/:slug` puro do router existente.
app.use("/operacao/cliente-360", cliente360ResultadoRoutes);
app.use("/operacao/cliente-360", cliente360Routes);
app.use("/operacao/central-vendas", centralVendasRoutes);
// Central de Margem — API read-only do Motor de Margem (somente GET).
app.use("/operacao/central-margem", motorMargemRoutes);
// V3: Visão (composicao read-only de fontes existentes) e leitura do
// Financeiro por periodo/conta — nao confundir com /fechamentos (upload).
app.use("/operacao/visao", visaoRoutes);
app.use("/financeiro", financeiroVisaoRoutes);
app.use("/operacao/diagnosticos-iniciais", diagnosticoInicialRoutes);
// Central de Gestao Full — ja linkada no menu do Portal (Marketplace >
// Central Full), mas o namespace inteiro so responde com FULL_CENTRAL_ENABLED=true
// (ver server/routes/fullRoutes.js). Sem essa env var setada no ambiente do
// Render, toda rota devolve 404 como se nao existisse — confirmar a env var
// no Render antes de considerar a V1 disponivel em producao.
app.use("/operacao/full", fullRoutes);
app.use("/operacao", operacaoRoutes);
app.use("/seller", sellerRoutes);
app.use("/ads", adsRoutes);
app.use("/anuncios-meli", meliAnunciosRoutes);
app.use("/metricas", metricasRoutes);
// Editor de imagem do Estúdio de Templates. Fica sob /design/imagens para não
// colidir com os endpoints /design/clientes e /design/anuncios declarados abaixo.
app.use("/design/imagens", designImageRoutes);
app.use("/design/studio", designStudioRoutes);
app.use("/api/clickup", clickupRoutes);

app.post("/scans", authMiddleware, async (req, res) => {
  try {
    const {
      base_slug, conta_ml, total_anuncios,
      mc_medio, saudaveis, atencao, criticos
    } = req.body;

    if (!base_slug || !conta_ml || !total_anuncios) {
      return res.status(400).json({ ok: false, erro: "Campos obrigatórios faltando." });
    }

    const result = await pool.query(
      `INSERT INTO scans 
       (user_id, base_slug, conta_ml, total_anuncios, mc_medio, saudaveis, atencao, criticos)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [req.user.id, base_slug, conta_ml, total_anuncios,
       mc_medio || 0, saudaveis || 0, atencao || 0, criticos || 0]
    );

    res.status(201).json({ ok: true, scan: result.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.get("/scans", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM scans ORDER BY created_at DESC LIMIT 500`
    );
    res.json({ ok: true, scans: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.delete("/scans/:id", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "DELETE FROM scans WHERE id = $1 RETURNING id",
      [parseInt(req.params.id)]
    );
    if (!result.rows.length) {
      return res.status(404).json({ ok: false, erro: "Scan não encontrado." });
    }
    res.json({ ok: true, mensagem: "Scan excluído." });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.delete("/scans", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const conta = req.query.conta;
    if (!conta) {
      return res.status(400).json({ ok: false, erro: "Informe a conta." });
    }
    await pool.query(
      "DELETE FROM scans WHERE conta_ml = $1",
      [conta]
    );
    res.json({ ok: true, mensagem: "Scans da conta excluídos." });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.get("/api/bases/:baseSlug", apiKeyMiddleware, async (req, res) => {
  try {
    const inicio = Date.now();
    const slug = normalizarSlug(req.params.baseSlug);
    const baseResult = await pool.query(
      "SELECT id, nome, slug, marketplace FROM bases WHERE slug = $1 AND ativo = true",
      [slug]
    );
    if (!baseResult.rows.length) {
      await pool.query(
        `INSERT INTO callbacks (cliente_id, cliente_nome, base_slug, status_code, duracao_ms, ip)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [req.cliente.id, req.cliente.nome, slug, 404, 0,
         req.headers["x-forwarded-for"] || req.socket.remoteAddress]
      ).catch(() => {});
      return res.status(404).json({ ok: false, erro: "Base não encontrada." });
    }
    const base = baseResult.rows[0];
    const custos = await pool.query(
      "SELECT produto_id, custo_produto, imposto_percentual, taxa_fixa FROM custos WHERE base_id = $1",
      [base.id]
    );
    const dados = {};
    for (const row of custos.rows) {
      dados[row.produto_id] = {
        custo_produto: parseFloat(row.custo_produto),
        imposto_percentual: parseFloat(row.imposto_percentual),
        taxa_fixa: parseFloat(row.taxa_fixa)
      };
    }
    const duracao = Date.now() - inicio;

    await pool.query(
      `INSERT INTO callbacks (cliente_id, cliente_nome, base_slug, status_code, duracao_ms, ip)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [req.cliente.id, req.cliente.nome, slug, 200, duracao,
       req.headers["x-forwarded-for"] || req.socket.remoteAddress]
    ).catch(() => {});

    res.json({ ok: true, baseId: base.slug, nome: base.nome, marketplace: base.marketplace || "meli", total: custos.rows.length, dados });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// LISTAR BASES
app.get("/bases", authMiddleware, requireAutomacoesAccess, async (req, res) => {
  try {
    // total_skus / skus_com_custo alimentam a cobertura por base na tela /bases.
    const result = await pool.query(
      `SELECT b.id, b.slug, b.nome, b.ativo, b.marketplace, b.created_at, b.updated_at,
              COUNT(c.produto_id)::int AS total_skus,
              COUNT(c.custo_produto)::int AS skus_com_custo
         FROM bases b
         LEFT JOIN custos c ON c.base_id = b.id
        GROUP BY b.id
        ORDER BY b.created_at DESC`
    );
    let bases = result.rows;
    // P2.1 — carteira: não-admin vê só bases órfãs (sem vínculo ativo) e as
    // que cobrem ao menos um cliente do seu portfolio.
    if (!authzEhAdmin(req.user)) {
      const permitidos = [...(await authzClientesAutorizadosSet(req.user))];
      const vinc = await pool.query(
        `SELECT base_id,
                COUNT(*) FILTER (WHERE cliente_id = ANY($1::int[]))::int AS mine
           FROM base_cliente_vinculos
          WHERE ativo = true
          GROUP BY base_id`,
        [permitidos]
      );
      const porBase = new Map(vinc.rows.map((r) => [r.base_id, r.mine]));
      bases = bases.filter((b) => !porBase.has(b.id) || porBase.get(b.id) > 0);
    }
    res.json({ ok: true, bases });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// BUSCAR CUSTOS DE UMA BASE
app.get("/bases/:baseId", authMiddleware, requireAutomacoesAccess, requireBaseNaCarteira("baseId", { bySlug: true }), async (req, res) => {
  try {
    const slug = normalizarSlug(req.params.baseId);
    const acesso = await pool.query(
      `SELECT id, nome, slug, marketplace FROM bases WHERE slug = $1 AND ativo = true`,
      [slug]
    );
    if (!acesso.rows.length) return res.status(404).json({ ok: false, erro: "Base não encontrada" });
    const base = acesso.rows[0];
    const custos = await pool.query(
      "SELECT produto_id, sku_id, sku, custo_produto, imposto_percentual, taxa_fixa, id_model, produto_nome, variacao_nome, updated_at FROM custos WHERE base_id = $1",
      [base.id]
    );
    const dados = {};
    for (const row of custos.rows) {
      // TikTok: o mesmo produto_id aparece em várias linhas (uma por
      // variação), então a chave do dicionário é o sku_id — identidade real da
      // linha. MELI/Shopee nunca preenchem sku_id, e a chave continua sendo só
      // o produto_id (comportamento inalterado). O `sku` textual ainda entra na
      // chave das linhas TikTok legadas, que não têm sku_id.
      const chave = row.sku_id
        ? row.sku_id
        : row.sku
          ? `${row.produto_id}::${row.sku}`
          : row.produto_id;
      dados[chave] = {
        produto_id: row.produto_id,
        sku_id: row.sku_id || null,
        sku: row.sku || null,
        custo_produto: row.custo_produto == null ? null : parseFloat(row.custo_produto),
        imposto_percentual: parseFloat(row.imposto_percentual),
        taxa_fixa: parseFloat(row.taxa_fixa),
        id_model: row.id_model || null,
        produto_nome: row.produto_nome || null,
        variacao_nome: row.variacao_nome || null,
        updated_at: row.updated_at || null
      };
    }
    res.json({ ok: true, baseId: base.slug, nome: base.nome, marketplace: base.marketplace || "meli", total: custos.rows.length, dados });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// IMPORTAR PLANILHA
app.post("/importar-base", authMiddleware, requireAutomacoesAccess, upload.single("arquivo"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, erro: "Nenhum arquivo enviado" });
    const nomeBaseOriginal = String(req.body.nomeBase || "").trim();
    if (!nomeBaseOriginal) return res.status(400).json({ ok: false, erro: "Nome da base é obrigatório" });
    const slug = normalizarSlug(nomeBaseOriginal);

    // marketplace: validado quando presente; ausente → 'meli' (não-regressão).
    const marketplaceRaw = String(req.body.marketplace || "").trim().toLowerCase();
    if (marketplaceRaw && !MARKETPLACES_SUPORTADOS.includes(marketplaceRaw)) {
      return res.status(400).json({ ok: false, erro: `marketplace inválido. Use: ${MARKETPLACES_SUPORTADOS.join(", ")}.` });
    }
    const marketplace = marketplaceRaw || "meli";

    const linhas = parsePlanilha(req.file.buffer, req.file.originalname, marketplace);

    const confirmar = req.body.confirmar === "true";
    if (!confirmar) {
      return res.json({
        ok: true,
        marketplace,
        preview: linhas.slice(0, 10).map(l => ({
          id: l.produto_id,
          sku_id: l.sku_id || null,
          sku: l.sku || null,
          custo_produto: l.custo_produto,
          imposto_percentual: l.imposto_percentual,
          taxa_fixa: l.taxa_fixa,
          id_model: l.id_model || null,
          produto_nome: l.produto_nome || null,
          variacao_nome: l.variacao_nome || null,
          tem_custo: l.tem_custo !== false,
        })),
        total: linhas.length,
        idsDetectados: linhas.length,
        colunaId: marketplace === "tiktok" ? "id / id do sku" : "id / sku"
      });
    }

    // custo_produto é NOT NULL: linha sem custo fica de fora da persistência
    // (aparece no preview, mas não vira 0 no banco).
    const linhasPersistiveis = linhas.filter((l) => l.tem_custo !== false);
    if (!linhasPersistiveis.length) {
      return res.status(400).json({ ok: false, erro: "Nenhuma linha com custo preenchido para importar." });
    }

    // "Importar nova base" é sempre CRIAR — nunca substitui uma base
    // existente. Slug colidindo é 409 (BASE_SLUG_ALREADY_EXISTS): nenhum
    // UPDATE, nenhum DELETE, nenhum custo antigo é tocado. Base + custos +
    // vínculo (quando cliente/conta são informados) são atômicos: se o
    // vínculo falhar (ex.: ML com 2+ contas sem escolha explícita), a base e
    // os custos também não ficam gravados — ver server/services/bases/baseImportService.js.
    const clienteContaId = req.body.cliente_conta_id != null && String(req.body.cliente_conta_id).trim() !== ""
      ? req.body.cliente_conta_id
      : null;
    const clienteId = req.body.cliente_id != null && String(req.body.cliente_id).trim() !== ""
      ? req.body.cliente_id
      : null;

    const resultado = await baseImportService.criarBaseComCustos({
      slug,
      nomeBase: nomeBaseOriginal,
      marketplace,
      linhasPersistiveis,
      clienteId,
      clienteContaId,
      userId: req.user?.id,
    });

    registrarLog({
      ...dadosUsuarioDeReq(req),
      acao: "base.importar",
      detalhes: {
        base_slug: slug,
        nome_base: nomeBaseOriginal,
        marketplace,
        total_itens: resultado.total,
        vinculado: !!resultado.vinculo,
      },
      ip: extrairIp(req),
      status: "sucesso"
    });
    res.json({
      ok: true,
      mensagem: "Base criada e planilha importada com sucesso",
      base: slug,
      total: resultado.total,
      vinculo: resultado.vinculo,
    });
  } catch (err) {
    // Erros de validação de planilha (ex.: ID TikTok em notação científica)
    // e os erros estruturados do service de importação (409/422 com code)
    // chegam com statusCode — não são falha interna.
    const status = err.statusCode || 500;
    const payload = err.payload || { ok: false, erro: err.message };
    if (!err.payload && err.code) payload.code = err.code;
    if (!err.payload && err.contas) payload.contas = err.contas;
    res.status(status).json(payload);
  }
});

// DESABILITAR BASE
app.post("/bases/:baseId/desabilitar", authMiddleware, requireAutomacoesAccess, async (req, res) => {
  try {
    // Já isolado por user_bases (mecanismo legado de posse de base por usuário);
    // P2.1 acrescenta só o gate de role. Ver BACKEND_V3_AUTHORIZATION_COVERAGE.md.
    const slug = normalizarSlug(req.params.baseId);
    const acesso = await pool.query(
      `SELECT b.id FROM bases b JOIN user_bases ub ON ub.base_id = b.id WHERE b.slug = $1 AND ub.user_id = $2`,
      [slug, req.user.id]
    );
    if (!acesso.rows.length) return res.status(404).json({ ok: false, erro: "Base não encontrada" });
    await pool.query("UPDATE bases SET ativo = false WHERE id = $1", [acesso.rows[0].id]);
    registrarLog({
      ...dadosUsuarioDeReq(req),
      acao: "base.desabilitar",
      detalhes: { base_slug: slug },
      ip: extrairIp(req),
      status: "sucesso"
    });
    res.json({ ok: true, mensagem: "Base desabilitada com sucesso" });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// EXCLUIR BASE (hard delete) — estrutura/identidade/destruição alinhada à
// política da Fundação Cliente/Contas: admin-only, com preflight de
// dependências. A ação operacional comum passou a ser "Desabilitar base"
// (POST /bases/:baseId/desabilitar, acima), que preserva custos/histórico.
// Este endpoint continua existindo só para compatibilidade/admin (achado P0
// da auditoria: qualquer usuário com user_bases podia apagar e o CASCADE
// removia vínculo ativo em silêncio; seller_custos_submissoes sem ON DELETE
// virava 500 cru).
app.delete("/bases/:baseId", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const param = req.params.baseId;

    const result = await pool.query(
      `SELECT id FROM bases WHERE id = $1 OR slug = $2`,
      [parseInt(param) || 0, normalizarSlug(param)]
    );
    if (!result.rows.length) {
      return res.status(404).json({ ok: false, erro: "Base não encontrada" });
    }
    const baseId = result.rows[0].id;

    const dependencias = await baseDependenciesService.checarDependenciasBase(baseId);
    if (dependencias.bloqueado) {
      return res.status(409).json({
        ok: false,
        code: "BASE_HAS_DEPENDENCIES",
        erro: "Esta base tem dependências ativas e não pode ser excluída. Desative o vínculo (ou as dependências listadas) antes de tentar novamente.",
        dependencies: dependencias.dependencias,
      });
    }

    try {
      await pool.query("DELETE FROM bases WHERE id = $1", [baseId]);
    } catch (err) {
      // Rede de segurança: qualquer FK não coberta pelo preflight vira 409
      // estruturado em vez de 500 cru (ex.: nova dependência futura sem
      // ON DELETE declarado).
      if (err.code === "23503") {
        return res.status(409).json({
          ok: false,
          code: "BASE_HAS_DEPENDENCIES",
          erro: "Esta base ainda possui dependências que impedem a exclusão.",
          dependencies: dependencias.dependencias,
        });
      }
      throw err;
    }

    registrarLog({
      ...dadosUsuarioDeReq(req),
      acao: "base.excluir",
      detalhes: { base_slug: normalizarSlug(param) },
      ip: extrairIp(req),
      status: "sucesso"
    });

    res.json({ ok: true, mensagem: "Base excluída com sucesso" });

  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ADMIN USERS
app.get("/admin/users", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query("SELECT id, nome, email, ativo, role, created_at FROM users ORDER BY id ASC");
    res.json({ ok: true, users: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.get("/clientes", authMiddleware, async (req, res) => {
  try {
    const role = String(req.user?.role || "").toLowerCase();

    if (role === "shopee_reviewer") {
      const result = await pool.query(
        "SELECT id, nome, slug, ativo, created_at FROM clientes WHERE slug = 'demo-shopee' AND ativo = true"
      );
      return res.json({ ok: true, clientes: result.rows });
    }

    if (role !== "admin") {
      return res.status(403).json({ ok: false, erro: "Acesso restrito a administradores." });
    }

    const result = await pool.query(
      "SELECT id, nome, slug, ativo, created_at FROM clientes ORDER BY created_at DESC"
    );
    const clientes = result.rows;

    // Squad ativo de cada cliente, numa única query batched (mission
    // "fechar o contrato Cliente↔Squad", set/2026) — cliente histórico sem
    // squad fica com squad: null (honesto, nunca inventado).
    const squadsPorCliente = await squadsAtivosDeClientes(clientes.map((c) => c.id));
    const squadDoCliente = new Map(squadsPorCliente.map((s) => [s.cliente_id, s]));
    const clientesComSquad = clientes.map((c) => {
      const s = squadDoCliente.get(c.id) || null;
      return {
        ...c,
        squad: s ? { id: s.squad_id, nome: s.squad_nome, slug: s.squad_slug } : null,
      };
    });

    res.json({ ok: true, clientes: clientesComSquad });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.get("/design/clientes", authMiddleware, requireDesignAccess, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, nome, slug, ativo, created_at
       FROM clientes
       WHERE ativo = true
       ORDER BY nome ASC`
    );
    res.json({ ok: true, clientes: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.get("/design/anuncios/:itemId/imagens", authMiddleware, requireDesignAccess, async (req, res) => {
  try {
    const clienteSlugRaw = String(req.query.clienteSlug || "").trim();
    if (!clienteSlugRaw) {
      return res.status(400).json({ ok: false, erro: "clienteSlug é obrigatório." });
    }

    const clienteSlug = normalizarSlug(clienteSlugRaw);
    const clienteRes = await pool.query(
      "SELECT id, nome, slug FROM clientes WHERE slug = $1 AND ativo = true",
      [clienteSlug]
    );
    if (!clienteRes.rows.length) {
      return res.status(404).json({ ok: false, erro: "Cliente não encontrado." });
    }
    const cliente = clienteRes.rows[0];

    const itemId = normalizarMlItemId(req.params.itemId);
    if (!itemId) {
      return res.status(400).json({ ok: false, erro: "itemId inválido." });
    }

    const itemResp = await mlFetch(cliente.id, `/items/${encodeURIComponent(itemId)}`);
    if (!itemResp.ok) {
      return res.status(itemResp.status || 502).json({
        ok: false,
        erro: itemResp.data?.message || "Erro ao buscar anúncio no Mercado Livre.",
        status: itemResp.status,
        data: itemResp.data ?? null
      });
    }

    const item = itemResp.data?.body || itemResp.data || {};
    const pictures = Array.isArray(item.pictures) ? item.pictures : [];
    const imagens = pictures.map((p, index) => ({
      index: index + 1,
      id: p.id || null,
      url: p.secure_url || p.url || p.max_size || null,
      secure_url: p.secure_url || null,
      size: p.size || null,
      max_size: p.max_size || null,
      quality: p.quality || null,
    })).filter((img) => img.url);

    return res.json({
      ok: true,
      item: {
        id: item.id || itemId,
        title: item.title || null,
        seller_id: item.seller_id || null,
        status: item.status || null
      },
      total: imagens.length,
      imagens
    });
  } catch (err) {
    return res.status(500).json({ ok: false, erro: err.message });
  }
});

app.get("/design/anuncios/:itemId/imagens/download", authMiddleware, requireDesignAccess, async (req, res) => {
  try {
    const clienteSlugRaw = String(req.query.clienteSlug || "").trim();
    if (!clienteSlugRaw) {
      return res.status(400).json({ ok: false, erro: "clienteSlug é obrigatório." });
    }

    const clienteSlug = normalizarSlug(clienteSlugRaw);
    const clienteRes = await pool.query(
      "SELECT id, nome, slug FROM clientes WHERE slug = $1 AND ativo = true",
      [clienteSlug]
    );
    if (!clienteRes.rows.length) {
      return res.status(404).json({ ok: false, erro: "Cliente não encontrado." });
    }
    const cliente = clienteRes.rows[0];

    const itemId = normalizarMlItemId(req.params.itemId);
    if (!itemId) {
      return res.status(400).json({ ok: false, erro: "itemId inválido." });
    }

    const itemResp = await mlFetch(cliente.id, `/items/${encodeURIComponent(itemId)}`);
    if (!itemResp.ok) {
      return res.status(itemResp.status || 502).json({
        ok: false,
        erro: itemResp.data?.message || "Erro ao buscar anúncio no Mercado Livre.",
        status: itemResp.status,
        data: itemResp.data ?? null
      });
    }

    const item = itemResp.data?.body || itemResp.data || {};
    const pictures = Array.isArray(item.pictures) ? item.pictures : [];
    const imagens = pictures.map((p) => p?.secure_url || p?.url || p?.max_size || null).filter(Boolean);
    if (!imagens.length) {
      return res.status(404).json({ ok: false, erro: "Nenhuma imagem encontrada para este anúncio." });
    }

    const arquivos = [];
    for (let index = 0; index < imagens.length; index++) {
      const url = imagens[index];
      try {
        const imgResp = await fetch(url);
        if (!imgResp.ok) continue;

        const arr = await imgResp.arrayBuffer();
        const buffer = Buffer.from(arr);
        if (!buffer.length) continue;

        const contentType = String(imgResp.headers.get("content-type") || "").toLowerCase();
        let ext = ".jpg";
        if (contentType.includes("png")) ext = ".png";
        else if (contentType.includes("webp")) ext = ".webp";
        else if (contentType.includes("jpeg") || contentType.includes("jpg")) ext = ".jpg";

        arquivos.push({
          index,
          ext,
          buffer,
        });
      } catch (_) {
        // ignora falhas individuais para não interromper o lote
      }
    }

    if (!arquivos.length) {
      return res.status(500).json({ ok: false, erro: "Não foi possível baixar nenhuma imagem." });
    }

    const designDir = path.join(__dirname, "downloads", "design");
    fs.mkdirSync(designDir, { recursive: true });

    const filename = `${itemId}-imagens-${Date.now()}.zip`;
    const zipPath = path.join(designDir, filename);

    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 6 } });

    const zipDone = new Promise((resolve, reject) => {
      output.on("close", resolve);
      output.on("error", reject);
      archive.on("error", reject);
    });

    archive.pipe(output);
    arquivos.forEach((arquivo) => {
      archive.append(arquivo.buffer, {
        name: `${itemId}_${String(arquivo.index + 1).padStart(2, "0")}${arquivo.ext}`
      });
    });
    await archive.finalize();
    await zipDone;

    return res.json({
      ok: true,
      downloadUrl: `/downloads/design/${filename}`
    });
  } catch (err) {
    return res.status(500).json({ ok: false, erro: err.message });
  }
});

app.delete("/clientes/:slug/ml-token", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const slug = normalizarSlug(req.params.slug);
    const c = await pool.query("SELECT id FROM clientes WHERE slug = $1", [slug]);
    if (!c.rows.length) {
      return res.status(404).json({ ok: false, erro: "Cliente não encontrado." });
    }
    // Esta rota é legada e não é account-scoped: ela apaga TODOS os grants
    // ML do cliente. Com múltiplas contas isso apagaria ML1 ao tentar
    // desconectar só ML2. Bloqueia com erro explícito nesse caso e orienta
    // a usar DELETE /cliente-contas/:id/ml-grant (account-scoped).
    const grants = await pool.query("SELECT COUNT(*)::int AS total FROM ml_tokens WHERE cliente_id = $1", [c.rows[0].id]);
    if ((grants.rows[0]?.total || 0) > 1) {
      return res.status(409).json({
        ok: false,
        code: "MULTIPLE_ML_GRANTS",
        erro: "Este cliente possui mais de uma conta Mercado Livre. Use DELETE /cliente-contas/:id/ml-grant para desconectar uma conta específica, sem apagar as demais.",
      });
    }
    await pool.query("DELETE FROM ml_tokens WHERE cliente_id = $1", [c.rows[0].id]);
    registrarLog({
      ...dadosUsuarioDeReq(req),
      acao: "admin.ml.desconectar",
      detalhes: { cliente_slug: slug },
      ip: extrairIp(req),
      status: "sucesso"
    });
    res.json({ ok: true, mensagem: "Conta ML desvinculada." });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.post("/clientes", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { nome, slug, squadId } = req.body;
    if (!nome || !slug) {
      return res.status(400).json({ ok: false, erro: "Nome e slug são obrigatórios." });
    }

    // squadId é obrigatório (mission "fechar o contrato Cliente↔Squad",
    // set/2026): um incidente real mostrou 2 clientes ativos sem Squad
    // porque o backend ainda tolerava criação sem squadId. O único
    // consumidor de POST /clientes é Portal/clientes.js, que já envia
    // squadId desde a obrigatoriedade no formulário (commit
    // e2e2f20, set/2026) — não há caminho legado a preservar.
    if (squadId === undefined || squadId === null || squadId === "") {
      return res.status(400).json({
        ok: false,
        code: "SQUAD_OBRIGATORIO",
        erro: "Todo cliente deve pertencer a um Squad.",
      });
    }
    const sid = Number(squadId);
    if (!Number.isInteger(sid) || sid <= 0) {
      return res.status(400).json({ ok: false, code: "SQUAD_ID_INVALIDO", erro: "Squad inválido." });
    }

    const slugNorm = normalizarSlug(slug);
    const apiKey = gerarApiKey();
    const nomeTrim = nome.trim();

    // Cria Cliente + vínculo de Squad como UMA transação
    // (squadService.criarClienteComSquad) — nunca duas escritas
    // independentes que possam deixar o Cliente órfão se a segunda falhar.
    try {
      const resultado = await squadService.criarClienteComSquad(
        { nome: nomeTrim, slug: slugNorm, apiKey, squadId: sid },
        req.user.id
      );
      registrarLog({
        ...dadosUsuarioDeReq(req),
        acao: "admin.cliente.criar",
        detalhes: { cliente_slug: slugNorm, cliente_nome: nomeTrim, squad_id: sid },
        ip: extrairIp(req),
        status: "sucesso"
      });
      return res.status(201).json({ ok: true, cliente: resultado.cliente, squad: resultado.squad });
    } catch (err) {
      const status = Number.isFinite(Number(err?.statusCode)) ? Number(err.statusCode) : 500;
      if (status >= 500) console.error("[clientes] criar com squad:", err.message);
      return res.status(status).json({ ok: false, erro: err.message, code: err.code });
    }
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Consulta prévia e não-destrutiva de dependências — usada pelo frontend
// para decidir, ANTES de o admin confirmar, se a remoção será hard delete
// (sem dependências) ou desativação preservando histórico (com
// dependências). Nunca apaga nada; só lê.
app.get("/clientes/:slug/dependencias", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const slug = normalizarSlug(req.params.slug);
    const clienteAtual = await pool.query("SELECT id FROM clientes WHERE slug = $1", [slug]);
    if (!clienteAtual.rows.length) {
      return res.status(404).json({ ok: false, erro: "Cliente não encontrado." });
    }
    const dependencias = await verificarDependenciasCliente(clienteAtual.rows[0].id, slug);
    res.json({ ok: true, dependencias });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Exclusão administrativa (admin tem a palavra final):
//   - sem dependências            -> apaga direto.
//   - com dependências, sem       -> 409 CLIENTE_COM_DEPENDENCIAS, lista o
//     ?confirmarPurge=true           que existe. Não é um beco sem saída: o
//                                     admin escolhe entre PATCH .../desativar
//                                     (preserva tudo) ou repetir este DELETE
//                                     com ?confirmarPurge=true (apaga tudo).
//   - com dependências, COM       -> purge real: apaga o cliente e todo o
//     ?confirmarPurge=true           dado relacionado numa transação só
//                                     (clientePurgeService.purgarClientePermanentemente).
// Em ambos os casos que efetivamente excluem, o purge service é quem roda —
// mesmo sem dependências, para não duplicar a lógica de exclusão em dois
// lugares (as tabelas "sem FK" simplesmente não têm o que apagar).
app.delete("/clientes/:slug", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const slug = normalizarSlug(req.params.slug);
    const clienteAtual = await pool.query("SELECT id, nome, slug FROM clientes WHERE slug = $1", [slug]);
    if (!clienteAtual.rows.length) {
      return res.status(404).json({ ok: false, erro: "Cliente não encontrado." });
    }
    const cliente = clienteAtual.rows[0];

    const dependencias = await verificarDependenciasCliente(cliente.id, slug);
    const confirmarPurge = String(req.query.confirmarPurge || "").toLowerCase() === "true";

    if (dependencias.length && !confirmarPurge) {
      return res.status(409).json({
        ok: false,
        code: "CLIENTE_COM_DEPENDENCIAS",
        erro: "Este cliente possui dados vinculados. Confirme explicitamente a exclusão permanente (?confirmarPurge=true) ou use PATCH /clientes/:slug/desativar para removê-lo da operação preservando o histórico.",
        dependencias,
      });
    }

    // Segunda confirmação (defesa em profundidade além do botão desabilitado
    // na UI): quando há dependências reais sendo apagadas de verdade, exige
    // que o admin tenha digitado o nome ou o slug exato do cliente no corpo
    // da requisição — nunca aceita ?confirmarPurge=true sozinho como prova
    // de intenção para um purge com dados envolvidos.
    if (dependencias.length && confirmarPurge) {
      const digitado = String(req.body?.confirmar || "").trim().toLowerCase();
      const confere = digitado === cliente.slug.toLowerCase() || digitado === cliente.nome.trim().toLowerCase();
      if (!confere) {
        return res.status(400).json({
          ok: false,
          code: "CONFIRMACAO_INVALIDA",
          erro: "Para excluir permanentemente, digite o nome ou o slug exato do cliente no campo de confirmação.",
        });
      }
    }

    let resultado;
    try {
      resultado = await purgarClientePermanentemente(slug);
    } catch (err) {
      const status = Number.isFinite(Number(err?.statusCode)) ? Number(err.statusCode) : 500;
      if (status >= 500) console.error("[clientes] purge:", err.message);
      return res.status(status).json({ ok: false, erro: err.message, code: err.code });
    }

    registrarLog({
      ...dadosUsuarioDeReq(req),
      acao: dependencias.length ? "admin.cliente.purgar" : "admin.cliente.excluir",
      detalhes: { cliente_slug: slug, apagados: resultado.apagados },
      ip: extrairIp(req),
      status: "sucesso"
    });
    res.json({
      ok: true,
      mensagem: dependencias.length
        ? "Cliente e todos os dados relacionados foram excluídos permanentemente."
        : "Cliente removido com sucesso.",
      apagados: resultado.apagados,
    });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Remoção segura de cliente COM dependências: nunca apaga Grants, contas,
// bases ou histórico financeiro — só tira o cliente da operação ativa
// (mesma flag `ativo` que já filtra dashboards/metricas/financeiro/central
// de vendas em todo o backend). Reversível por quem tiver acesso direto ao
// banco; não há endpoint de reativação nesta missão (fora de escopo).
app.patch("/clientes/:slug/desativar", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const slug = normalizarSlug(req.params.slug);
    const clienteAtual = await pool.query("SELECT id FROM clientes WHERE slug = $1", [slug]);
    if (!clienteAtual.rows.length) {
      return res.status(404).json({ ok: false, erro: "Cliente não encontrado." });
    }
    await pool.query("UPDATE clientes SET ativo = false WHERE slug = $1", [slug]);
    registrarLog({
      ...dadosUsuarioDeReq(req),
      acao: "admin.cliente.desativar",
      detalhes: { cliente_slug: slug },
      ip: extrairIp(req),
      status: "sucesso"
    });
    res.json({ ok: true, mensagem: "Cliente removido da operação ativa. Dados preservados." });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.post("/download-ferramenta-or", authMiddleware, async (req, res) => {
  try {
    const { mlbs } = req.body;

    if (!Array.isArray(mlbs) || !mlbs.length) {
      return res.status(400).json({ ok: false, erro: "Informe ao menos um MLB." });
    }

    for (const item of mlbs) {
      if (!item.mlb || !item.quantidade_padrao || !item.preco_final) {
        return res.status(400).json({
          ok: false,
          erro: "Cada item deve ter mlb, quantidade_padrao e preco_final."
        });
      }
    }

    const config = {
      mlbs: mlbs.map((item) => ({
        mlb: String(item.mlb).trim(),
        quantidade_padrao: Number(item.quantidade_padrao),
        preco_final: String(item.preco_final).trim(),
      })),
      headless: false,
      slow_mo: 50,
    };

    const configJson = JSON.stringify(config, null, 2);
    const downloadsDir = path.join(__dirname, "downloads");

    const v1Path     = path.join(downloadsDir, "v1_10_1.py");
    const criarPath  = path.join(downloadsDir, "Criar_ORs.py");

    if (!fs.existsSync(v1Path) || !fs.existsSync(criarPath)) {
      return res.status(500).json({ ok: false, erro: "Arquivos Python não encontrados em server/downloads/." });
    }

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", "attachment; filename=ferramenta-or.zip");

    const archive = archiver("zip", { zlib: { level: 6 } });

    archive.on("error", (err) => {
      console.error("[download-ferramenta-or] archiver erro:", err.message);
      if (!res.headersSent) res.status(500).json({ ok: false, erro: err.message });
    });

    archive.pipe(res);
    archive.file(v1Path,    { name: "v1_10_1.py" });
    archive.file(criarPath, { name: "Criar_ORs.py" });
    archive.append(configJson, { name: "config.json" });

    await archive.finalize();
  } catch (err) {
    console.error("[download-ferramenta-or] erro:", err.message);
    if (!res.headersSent) res.status(500).json({ ok: false, erro: err.message });
  }
});

app.get("/callbacks", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { base, status, de, ate, page = 1 } = req.query;
    const limit = 20;
    const offset = (parseInt(page) - 1) * limit;
    const condicoes = [];
    const valores = [];
    let i = 1;

    if (base) { condicoes.push(`base_slug = $${i++}`); valores.push(base); }
    if (status === "sucesso") { condicoes.push(`status_code BETWEEN 200 AND 299`); }
    if (status === "erro") { condicoes.push(`status_code >= 400`); }
    if (de) { condicoes.push(`created_at >= $${i++}`); valores.push(de); }
    if (ate) { condicoes.push(`created_at <= $${i++}`); valores.push(ate + " 23:59:59"); }

    const where = condicoes.length ? "WHERE " + condicoes.join(" AND ") : "";

    const result = await pool.query(
      `SELECT id, cliente_nome, base_slug, status_code, duracao_ms, ip, created_at
       FROM callbacks ${where}
       ORDER BY created_at DESC
       LIMIT $${i++} OFFSET $${i++}`,
      [...valores, limit, offset]
    );

    const total = await pool.query(
      `SELECT COUNT(*) FROM callbacks ${where}`,
      valores
    );

    res.json({
      ok: true,
      callbacks: result.rows,
      total: parseInt(total.rows[0].count),
      page: parseInt(page),
      totalPages: Math.ceil(parseInt(total.rows[0].count) / limit)
    });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.get("/usuarios", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, nome, email, role, ativo, created_at FROM users ORDER BY created_at DESC"
    );
    res.json({ ok: true, usuarios: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.patch("/usuarios/:id", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const targetId = parseInt(req.params.id);
    if (targetId === req.user.id) {
      return res.status(400).json({ ok: false, erro: "Você não pode alterar sua própria conta por aqui." });
    }
    const { ativo, role } = req.body;
    const campos = [];
    const valores = [];
    let i = 1;
    if (ativo !== undefined) { campos.push(`ativo = $${i++}`); valores.push(ativo); }
    if (role !== undefined) {
      const rolesPermitidas = ['admin', 'membro', 'seller', 'shopee_reviewer'];
      if (!rolesPermitidas.includes(role)) {
        return res.status(400).json({ ok: false, erro: `Role inválida. Permitidas: ${rolesPermitidas.join(', ')}.` });
      }
      campos.push(`role = $${i++}`);
      valores.push(role);
    }
    if (!campos.length) return res.status(400).json({ ok: false, erro: "Nenhum campo para atualizar." });
    valores.push(targetId);
    const result = await pool.query(
      `UPDATE users SET ${campos.join(", ")} WHERE id = $${i} RETURNING id, nome, email, role, ativo`,
      valores
    );
    if (!result.rows.length) return res.status(404).json({ ok: false, erro: "Usuário não encontrado." });
    registrarLog({
      ...dadosUsuarioDeReq(req),
      acao: "admin.usuario.atualizar",
      detalhes: { target_user_id: targetId, ativo: ativo, role: role },
      ip: extrairIp(req),
      status: "sucesso"
    });
    res.json({ ok: true, usuario: result.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.delete("/usuarios/:id", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const targetId = parseInt(req.params.id);
    if (targetId === req.user.id) {
      return res.status(400).json({ ok: false, erro: "Você não pode remover sua própria conta." });
    }
    const result = await pool.query("DELETE FROM users WHERE id = $1 RETURNING id", [targetId]);
    if (!result.rows.length) return res.status(404).json({ ok: false, erro: "Usuário não encontrado." });
    registrarLog({
      ...dadosUsuarioDeReq(req),
      acao: "admin.usuario.excluir",
      detalhes: { target_user_id: targetId },
      ip: extrairIp(req),
      status: "sucesso"
    });
    res.json({ ok: true, mensagem: "Usuário removido com sucesso." });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});
function gerarExcelBase64Conversao(resultado) {
  try {
    const wb = XLSX.utils.book_new();

    const pct2 = (v) => (v != null ? (v * 100).toFixed(2) + "%" : "0.00%");

    if (Array.isArray(resultado.curvaAbcCompleta) && resultado.curvaAbcCompleta.length) {
      const rows = resultado.curvaAbcCompleta.map((r) => ({
        ID: r.id ?? "",
        Produto: r.produto ?? "",
        Faturamento: r.faturamento ?? 0,
        "% Fat.": pct2(r.percentualFaturamento),
        "Acum. Fat.": pct2(r.acumuladoFaturamento),
        Unidades: r.unidades ?? 0,
        "% Unid.": pct2(r.percentualUnidades),
        "Acum. Unid.": pct2(r.acumuladoUnidades),
        "Curva Fat": r.curvaFat ?? "",
        "Curva Uni": r.curvaUni ?? "",
        Final: r.curvaFinal ?? "",
      }));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Curva ABC");
    }

    if (Array.isArray(resultado.sugestaoKits) && resultado.sugestaoKits.length) {
      const rows = resultado.sugestaoKits.map((r) => ({
        ID: r.id ?? "",
        Produto: r.produto ?? "",
        "Pedidos Pagos": r.pedidosPagos ?? 0,
        "Unidades Pagas": r.unidadesPagas ?? 0,
        "Unid./Pedido": r.unidadesPorPedido != null ? Number(r.unidadesPorPedido).toFixed(2) : "0.00",
      }));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Kits");
    }

    for (const [key, label] of [
      ["adsObrigatorios", "ADS Obrigatórios"],
      ["adsPrioridade34", "ADS Prioridade 3-4"],
      ["adsPrioridade24", "ADS Prioridade 2-4"],
    ]) {
      if (Array.isArray(resultado[key]) && resultado[key].length) {
        const rows = resultado[key].map((r) => ({
          ID: r.id ?? "",
          Produto: r.produto ?? "",
          Cliques: r.cliques ?? 0,
          CTR: pct2(r.ctr),
          Conversão: pct2(r.conversao),
          Motivo: r.motivo ?? "",
        }));
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), label);
      }
    }

    for (const [key, label, col] of [
      ["produtosMaisImpressoes", "Impressões", "Impressões"],
      ["produtosMaisCliques", "Cliques", "Cliques"],
      ["produtosMaiorCtr", "CTR", "CTR"],
      ["produtosMaiorConversao", "Conversão", "Conversão"],
    ]) {
      if (Array.isArray(resultado[key]) && resultado[key].length) {
        const rows = resultado[key].map((r) => ({ ID: r.id ?? "", Produto: r.produto ?? "", [col]: r.valor ?? 0 }));
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), label);
      }
    }

    if (!wb.SheetNames.length) return null;

    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    return buf.toString("base64");
  } catch (e) {
    console.error("[gerarExcelBase64Conversao]", e);
    return null;
  }
}

app.post("/fechamentos/upload", authMiddleware, upload.single("file"), (req, res) => {
  const marketplace = String(req.body.marketplace || "shopee").trim().toLowerCase();
  const buffer = req.file && req.file.buffer;

  if (!buffer) {
    return res.status(400).json({ erro: "Arquivo não enviado." });
  }

  const resultado = marketplace === "meli"
    ? processarFechamentoMeli(buffer)
    : processarFechamento(buffer);

  if (resultado.error || resultado.erro) {
    return res.status(400).json({ erro: resultado.error || resultado.erro });
  }

  const excelBase64 = gerarExcelBase64Conversao(resultado);

  return res.json({ data: resultado, excelBase64: excelBase64 || null });
});

app.post("/fechamentos/compilar", authMiddleware, upload.array("files", 20), (req, res) => {
  const marketplace = String(req.body.marketplace || "shopee").trim().toLowerCase();
  const buffers = (req.files || []).map((f) => f.buffer);

  if (!buffers.length) {
    return res.status(400).json({ erro: "Nenhum arquivo enviado." });
  }

  const resultado = marketplace === "meli"
    ? compilarFechamentosMeli(buffers)
    : compilarFechamentos(buffers);

  if (resultado.error || resultado.erro) {
    return res.status(400).json({ erro: resultado.error || resultado.erro });
  }

  const excelBase64 = gerarExcelBase64Conversao(resultado);

  return res.json({ data: resultado, excelBase64: excelBase64 || null });
});
/* ========================= SHOPEE ========================= */
// Lê uma planilha Order.all e retorna apenas pedidos cancelados
// ou não pagos, com chaves SKU e valor (Subtotal do produto).
// Usado para feature de Cancelados/Não Pagos da Shopee.
// NÃO substitui processamento principal (que usa performance).
// Constrói dicionário SKU → {idItem, idVariacao} a partir das linhas
// brutas da planilha de performance. Usado como ponte para cruzar
// pedidos da Order.all com a base de custos.
// Cruza pedidos cancelados/não pagos com base de custos via ponte da
// performance. Retorna estatísticas e lista de não-encontrados.
/* ========================= MELI ========================= */
// ERRO GLOBAL
app.use((err, req, res, next) => {
  // Registra o erro técnico ANTES de responder: o listener de `finish` do
  // middleware de observabilidade lê req.__vfObsError e grava uma única vez.
  captureRequestError(req, err);

  if (err instanceof multer.MulterError) return res.status(400).json({ ok: false, erro: `Erro no upload: ${err.message}` });
  // A stack nunca sai para o cliente — ela fica só no histórico admin.
  res.status(500).json({ ok: false, erro: "Erro interno do servidor" });
});

// BLOCO 14 — o segredo de assinatura é resolvido de forma preguiçosa (a cada
// verify/sign) DE PROPÓSITO (ver config/jwtSecret.js). Mas em produção um
// JWT_SECRET ausente/fraco NÃO PODE deixar o servidor subir e só falhar no
// primeiro login: falha rápido, ANTES de bind na porta, com mensagem
// acionável. Fora de produção continua ergonômico (fallback local + warn).
try {
  const { getJwtSecret } = require("./config/jwtSecret");
  getJwtSecret();
} catch (err) {
  console.error(`[boot] ${err.message}`);
  process.exit(1);
}

const server = app.listen(PORT, () => {
  console.log(`VenForce rodando em http://localhost:${PORT}`);

  ensureCentralVendasTables().catch((err) => {
    console.error("[centralVendas] erro ao garantir tabelas no boot:", err.message);
  });

  // BLOCO 4 — `entregas_cliente.cliente_conta_id` (V3 P2.6 D1) só existia no
  // DDL da rota `/setup`, desabilitada em produção → a tela do Financeiro V3
  // quebrava com `column "cliente_conta_id" does not exist`. Este ensure é o
  // caminho automático que faltava. Idempotente, aditivo, NÃO aplica o índice
  // UNIQUE de D4. A checagem de readiness roda LOGO DEPOIS dele para não
  // acusar falso-positivo enquanto a coluna está sendo criada.
  ensureEntregasClienteSchema()
    .then(() => logReadinessNoBoot())
    .catch((err) => {
      console.error("[schema] erro ao garantir schema de entregas_cliente / readiness no boot:", err.message);
    });

  // /setup é desabilitado em produção — as colunas novas de `custos`
  // (produto_nome, variacao_nome, updated_at) são garantidas aqui.
  ensureColunasCustos().catch((err) => {
    console.error("[bases] erro ao garantir colunas de custos no boot:", err.message);
  });

  ensureDiagnosticoInicialTables().catch((err) => {
    console.error(
      "[diagnosticoInicial] erro ao garantir tabelas no boot:",
      err.message
    );
  });

  designStudioService.initialize().catch((err) => {
    console.error("[design-studio] erro ao garantir tabelas no boot:", err.message);
  });

  // P2.2 (+ HARDENING) — ROLLOUT GATE: cruza a intenção do operador
  // (SQUADS_ENFORCEMENT) com o estado real dos dados (auditoria de migração).
  // O arme é síncrono: enquanto a auditoria não responde, o gate mantém o
  // enforcement OFF, então não existe janela em que o processo já atende
  // requisições sem saber se os dados estão migrados.
  require("./services/squads/rolloutGateBoot")
    .armarRolloutGate({
      ensureSquadsTables,
      auditoria: () => require("./services/squads/squadsMigracaoService").auditoria(),
    })
    .then(({ auditoria: a, erro }) => {
      if (erro) {
        console.error("[squads] erro ao garantir tabelas / auditoria no boot:", erro.message);
      }
      const { describeEnforcement } = require("./config/squadsEnforcement");
      const enf = describeEnforcement();
      const dados = a
        ? `clientes sem squad=${a.clientesAtivos.semSquad}/${a.clientesAtivos.total} | ` +
          `internos sem membership=${a.usuariosInternos.semMembership}/${a.usuariosInternos.total} | ` +
          `internos sem principal=${a.usuariosInternos.semPrincipal} | ` +
          `auditoria.pronto=${a.pronto}`
        : "auditoria indisponível";
      console.log(
        `[squads] enforcement=${enf.enabled ? "ON" : "OFF"} ` +
        `(SQUADS_ENFORCEMENT=${enf.envRaw ?? "<ausente>"}, gate=${enf.gate}` +
        `${enf.overrideAtivo ? ", override=ON" : ""}) | ${dados}`
      );
      // Flag pede ON mas o gate segurou: o enforcement NÃO subiu. Dizer isso
      // alto evita o diagnóstico errado de "liguei e não aconteceu nada".
      if (enf.flagLigada && !enf.enabled) {
        console.warn(
          `[squads] ⚠ SQUADS_ENFORCEMENT pede ON, mas o rollout gate está "${enf.gate}" — ` +
          `enforcement permanece OFF. Motivo: ${enf.motivo}. Complete a migração ` +
          `(GET /squads/migracao/auditoria); para exceções aceitas, use ` +
          `SQUADS_ENFORCEMENT_ALLOW_INCOMPLETE=on.`
        );
      }
    })
    // Rede de segurança: este bloco é DIAGNÓSTICO e não pode derrubar o boot.
    // `armarRolloutGate` já não rejeita (o fail-safe do gate mora lá dentro),
    // mas um erro no log não pode virar unhandled rejection — o Node encerra o
    // processo nesse caso. Mesmo padrão das outras cadeias de boot aqui.
    .catch((err) => {
      console.error("[squads] erro ao reportar o estado do rollout gate no boot:", err.message);
    });

  ensureObservabilityTables()
    .then(() => observabilityService.runCleanup())
    .then(() => observabilityService.startRetentionJob())
    .catch((err) => {
      console.error("[observability] erro ao preparar tabelas no boot:", err.message);
    });

  ensureFechamentoIncidenteTables()
    .then(() => fechamentoIncidentStorageService.runCleanup())
    .then(() => fechamentoIncidentStorageService.startRetentionJob())
    .catch((err) => {
      console.error("[fechamento-incidentes] erro ao preparar tabelas no boot:", err.message);
    });

  startTokenRefreshWorker();
});

// Encerramento: tenta drenar a fila de observabilidade sem travar o processo.
let encerrando = false;
function encerrarComGraca(sinal) {
  if (encerrando) return;
  encerrando = true;
  console.log(`[server] ${sinal} recebido, encerrando…`);
  const prazo = setTimeout(() => process.exit(0), 5000);
  if (typeof prazo.unref === "function") prazo.unref();

  observabilityService.shutdown()
    .catch(() => {})
    .then(() => {
      observabilityService.stopRetentionJob();
      server.close(() => process.exit(0));
    });
}

process.on("SIGTERM", () => encerrarComGraca("SIGTERM"));
process.on("SIGINT", () => encerrarComGraca("SIGINT"));
