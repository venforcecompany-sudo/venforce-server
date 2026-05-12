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
const { getValidMlTokenByCliente, mlFetch } = require("./utils/mlClient");
const { startTokenRefreshWorker } = require("./utils/tokenRefreshWorker");
const { authMiddleware, requireAdmin } = require("./middlewares/authMiddleware");
const {
  apiKeyMiddleware,
  requireDesignAccess,
} = require("./middlewares/accessMiddleware");
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
const mlRoutes = require("./routes/mlRoutes");
const automacoesRoutes = require("./routes/automacoesRoutes");
const entregasClienteRoutes = require("./routes/entregasClienteRoutes");
const basesRoutes = require("./routes/basesRoutes");
const assistenteBaseRoutes = require("./routes/assistenteBaseRoutes");
const { registrarLog, extrairIp, dadosUsuarioDeReq } = require("./services/activityLogService");

const app = express();
const PORT = process.env.PORT || 3333;

// MIDDLEWARES
app.use(cors({ origin: true, credentials: false, methods: ["GET","POST","PUT","PATCH","DELETE","OPTIONS"], allowedHeaders: ["Content-Type","Authorization"] }));
app.options(/.*/, cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
app.use("/downloads", express.static(path.join(__dirname, "downloads")));

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

function parsePlanilha(buffer, originalName) {
  const ext = path.extname(originalName).toLowerCase();
  if (![".xlsx", ".xls", ".csv"].includes(ext)) throw new Error("Formato inválido. Envie .xlsx, .xls ou .csv");
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const primeiraAba = workbook.SheetNames[0];
  if (!primeiraAba) throw new Error("A planilha não possui abas válidas");
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[primeiraAba], { defval: "" });
  if (!rows.length) throw new Error("A planilha está vazia");

  // Detectar se é planilha Shopee (tem coluna "model id" ou variantes).
  // Em Shopee os IDs são numéricos do próprio Shopee — NÃO devem receber MLB.
  const headers = Object.keys(rows[0] || {}).map((h) => h.trim().toLowerCase());
  const isShopee = headers.some((h) =>
    h === "model id" || h === "model_id" || h === "modelid" ||
    h === "id da variacao" || h === "id da variação"
  );

  const resultado = [];
  for (const row of rows) {
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
      taxa_fixa: numeroSeguro(obterValorColuna(r, ["Taxa", "taxa_fixa", "TAXA_FIXA", "taxa", "TAXA", "Taxa Fixa"]))
    });
  }
  if (!resultado.length) throw new Error("Nenhum ID válido encontrado na planilha");
  return resultado;
}

function gerarApiKey() {
  return "vf_" + crypto.randomBytes(32).toString("hex");
}

// ROTAS BÁSICAS
app.get("/", (req, res) => res.send("API VenForce rodando 🚀"));
app.get("/health", (req, res) => res.json({ ok: true, mensagem: `VENFORCE OK porta ${PORT}` }));

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

      CREATE TABLE IF NOT EXISTS entregas_cliente (
        id SERIAL PRIMARY KEY,
        tipo VARCHAR(50) NOT NULL,
        cliente_id INTEGER REFERENCES clientes(id) ON DELETE SET NULL,
        cliente_slug VARCHAR(255),
        cliente_nome VARCHAR(255),
        titulo VARCHAR(255) NOT NULL,
        periodo VARCHAR(100),
        status VARCHAR(30) DEFAULT 'rascunho',
        token_publico VARCHAR(120) UNIQUE,
        publicado BOOLEAN DEFAULT FALSE,
        payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        origem_tipo VARCHAR(50),
        origem_id INTEGER,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        published_at TIMESTAMP,
        expires_at TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_entregas_cliente_cliente_id ON entregas_cliente(cliente_id);
      CREATE INDEX IF NOT EXISTS idx_entregas_cliente_token_publico ON entregas_cliente(token_publico);
      CREATE INDEX IF NOT EXISTS idx_entregas_cliente_tipo ON entregas_cliente(tipo);
      CREATE INDEX IF NOT EXISTS idx_entregas_cliente_created_at ON entregas_cliente(created_at);
    `);   

    await pool.query(`
  ALTER TABLE bases 
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
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
app.use("/fechamentos", fechamentosFinanceiroRoutes);
app.use("/", mlRoutes);
app.use("/", automacoesRoutes);
app.use("/", entregasClienteRoutes);
app.use("/", basesRoutes);
app.use("/bases/assistente", assistenteBaseRoutes);

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
      "SELECT id, nome, slug FROM bases WHERE slug = $1 AND ativo = true",
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

    res.json({ ok: true, baseId: base.slug, nome: base.nome, total: custos.rows.length, dados });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// LISTAR BASES
app.get("/bases", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, slug, nome, ativo, created_at, updated_at FROM bases ORDER BY created_at DESC"
    );
    res.json({ ok: true, bases: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// BUSCAR CUSTOS DE UMA BASE
app.get("/bases/:baseId", authMiddleware, async (req, res) => {
  try {
    const slug = normalizarSlug(req.params.baseId);
    const acesso = await pool.query(
      `SELECT id, nome, slug FROM bases WHERE slug = $1 AND ativo = true`,
      [slug]
    );
    if (!acesso.rows.length) return res.status(404).json({ ok: false, erro: "Base não encontrada" });
    const base = acesso.rows[0];
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
    res.json({ ok: true, baseId: base.slug, nome: base.nome, total: custos.rows.length, dados });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// IMPORTAR PLANILHA
app.post("/importar-base", authMiddleware, upload.single("arquivo"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, erro: "Nenhum arquivo enviado" });
    const nomeBaseOriginal = String(req.body.nomeBase || "").trim();
    if (!nomeBaseOriginal) return res.status(400).json({ ok: false, erro: "Nome da base é obrigatório" });
    const slug = normalizarSlug(nomeBaseOriginal);
    const linhas = parsePlanilha(req.file.buffer, req.file.originalname);

    const confirmar = req.body.confirmar === "true";
    if (!confirmar) {
      return res.json({
        ok: true,
        preview: linhas.slice(0, 10).map(l => ({ id: l.produto_id, custo_produto: l.custo_produto, imposto_percentual: l.imposto_percentual, taxa_fixa: l.taxa_fixa })),
        total: linhas.length, idsDetectados: linhas.length, colunaId: "id / sku"
      });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const baseResult = await client.query(
        `INSERT INTO bases (slug, nome) VALUES ($1, $2) ON CONFLICT (slug) DO UPDATE SET nome = EXCLUDED.nome, ativo = true, updated_at = CURRENT_TIMESTAMP RETURNING id`,
        [slug, nomeBaseOriginal]
      );
      const baseId = baseResult.rows[0].id;
      // vincular base a TODOS usuários
const users = await client.query(`SELECT id FROM users`);

for (const u of users.rows) {
  await client.query(
    `INSERT INTO user_bases (user_id, base_id)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [u.id, baseId]
  );
}
      await client.query("DELETE FROM custos WHERE base_id = $1", [baseId]);
      for (const linha of linhas) {
        await client.query(
          `INSERT INTO custos (base_id, produto_id, custo_produto, imposto_percentual, taxa_fixa)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT (base_id, produto_id) DO UPDATE SET
           custo_produto = EXCLUDED.custo_produto, imposto_percentual = EXCLUDED.imposto_percentual, taxa_fixa = EXCLUDED.taxa_fixa`,
          [baseId, linha.produto_id, linha.custo_produto, linha.imposto_percentual, linha.taxa_fixa]
        );
      }
      await client.query("COMMIT");
      registrarLog({
        ...dadosUsuarioDeReq(req),
        acao: "base.importar",
        detalhes: { base_slug: slug, nome_base: nomeBaseOriginal, total_itens: linhas.length },
        ip: extrairIp(req),
        status: "sucesso"
      });
      res.json({ ok: true, mensagem: "Base criada e planilha importada com sucesso", base: slug, total: linhas.length });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// DESABILITAR BASE
app.post("/bases/:baseId/desabilitar", authMiddleware, async (req, res) => {
  try {
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

// EXCLUIR BASE
app.delete("/bases/:baseId", authMiddleware, async (req, res) => {
  try {
    const param = req.params.baseId;

    let baseId;

    if (req.user.role === "admin") {
      const result = await pool.query(
        `SELECT id FROM bases WHERE id = $1 OR slug = $2`,
        [parseInt(param) || 0, normalizarSlug(param)]
      );

      if (!result.rows.length) {
        return res.status(404).json({ ok: false, erro: "Base não encontrada" });
      }

      baseId = result.rows[0].id;

    } else {
      const acesso = await pool.query(
        `SELECT b.id FROM bases b
         JOIN user_bases ub ON ub.base_id = b.id
         WHERE (b.id = $1 OR b.slug = $2) AND ub.user_id = $3`,
        [parseInt(param) || 0, normalizarSlug(param), req.user.id]
      );

      if (!acesso.rows.length) {
        return res.status(404).json({ ok: false, erro: "Base não encontrada" });
      }

      baseId = acesso.rows[0].id;
    }

    await pool.query("DELETE FROM bases WHERE id = $1", [baseId]);
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

app.get("/admin/ml-tokens", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        c.id AS cliente_id,
        c.nome AS cliente_nome,
        c.slug AS cliente_slug,
        t.ml_user_id,
        t.access_token,
        t.refresh_token,
        t.expires_at,
        t.updated_at
      FROM clientes c
      INNER JOIN ml_tokens t ON t.cliente_id = c.id
      ORDER BY c.nome ASC
    `);
    res.json({ ok: true, tokens: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.get("/clientes", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, nome, slug, api_key, ativo, created_at FROM clientes ORDER BY created_at DESC"
    );
    res.json({ ok: true, clientes: result.rows });
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

app.get("/clientes/:slug/ml-status", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const slug = normalizarSlug(req.params.slug);
    const c = await pool.query("SELECT id FROM clientes WHERE slug = $1", [slug]);
    if (!c.rows.length) {
      return res.status(404).json({ ok: false, erro: "Cliente não encontrado." });
    }
    const clienteId = c.rows[0].id;
    const t = await pool.query(
      "SELECT ml_user_id, expires_at, updated_at FROM ml_tokens WHERE cliente_id = $1",
      [clienteId]
    );
    if (!t.rows.length) {
      return res.json({ ok: true, conectado: false });
    }
    const row = t.rows[0];
    const expiresAt = new Date(row.expires_at);
    const now = new Date();
    const expira_em_segundos = Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));
    const precisa_refresh = expira_em_segundos < 300;
    res.json({
      ok: true,
      conectado: true,
      ml_user_id: row.ml_user_id,
      expires_at: row.expires_at,
      updated_at: row.updated_at,
      expira_em_segundos,
      precisa_refresh
    });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.delete("/clientes/:slug/ml-token", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const slug = normalizarSlug(req.params.slug);
    const c = await pool.query("SELECT id FROM clientes WHERE slug = $1", [slug]);
    if (!c.rows.length) {
      return res.status(404).json({ ok: false, erro: "Cliente não encontrado." });
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
    const { nome, slug } = req.body;
    if (!nome || !slug) {
      return res.status(400).json({ ok: false, erro: "Nome e slug são obrigatórios." });
    }
    const slugNorm = normalizarSlug(slug);
    const apiKey = gerarApiKey();
    const result = await pool.query(
      `INSERT INTO clientes (nome, slug, api_key)
       VALUES ($1, $2, $3)
       RETURNING id, nome, slug, api_key, ativo, created_at`,
      [nome.trim(), slugNorm, apiKey]
    );
    registrarLog({
      ...dadosUsuarioDeReq(req),
      acao: "admin.cliente.criar",
      detalhes: { cliente_slug: slugNorm, cliente_nome: nome.trim() },
      ip: extrairIp(req),
      status: "sucesso"
    });
    res.status(201).json({ ok: true, cliente: result.rows[0] });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ ok: false, erro: "Slug já cadastrado. Use outro nome." });
    }
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.delete("/clientes/:slug", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const slug = normalizarSlug(req.params.slug);
    const result = await pool.query(
      "DELETE FROM clientes WHERE slug = $1 RETURNING id",
      [slug]
    );
    if (!result.rows.length) {
      return res.status(404).json({ ok: false, erro: "Cliente não encontrado." });
    }
    registrarLog({
      ...dadosUsuarioDeReq(req),
      acao: "admin.cliente.excluir",
      detalhes: { cliente_slug: slug },
      ip: extrairIp(req),
      status: "sucesso"
    });
    res.json({ ok: true, mensagem: "Cliente removido com sucesso." });
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
    if (role !== undefined) { campos.push(`role = $${i++}`); valores.push(role); }
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

  return res.json({ data: resultado });
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

  return res.json({ data: resultado });
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
  if (err instanceof multer.MulterError) return res.status(400).json({ ok: false, erro: `Erro no upload: ${err.message}` });
  res.status(500).json({ ok: false, erro: "Erro interno do servidor" });
});

app.listen(PORT, () => {
  console.log(`VenForce rodando em http://localhost:${PORT}`);
  startTokenRefreshWorker();
});
