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
const { getValidMlTokenByCliente, mlFetch } = require("./utils/mlClient");
const { startTokenRefreshWorker } = require("./utils/tokenRefreshWorker");
const { authMiddleware, requireAdmin } = require("./middlewares/authMiddleware");
const {
  apiKeyMiddleware,
  requireAutomacoesAccess,
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

app.get("/automacoes/clientes", authMiddleware, requireAutomacoesAccess, async (req, res) => {
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

// AUTOMAÇÕES (somente leitura) — Preview de precificação por cliente + base
app.get("/automacoes/precificacao/preview", authMiddleware, requireAutomacoesAccess, async (req, res) => {
  try {
    const clienteSlugRaw = String(req.query.clienteSlug || "").trim();
    const baseSlugRaw = String(req.query.baseSlug || "").trim();

    if (!clienteSlugRaw) return res.status(400).json({ ok: false, erro: "clienteSlug é obrigatório" });
    if (!baseSlugRaw) return res.status(400).json({ ok: false, erro: "baseSlug é obrigatório" });

    const clienteSlug = normalizarSlug(clienteSlugRaw);
    const baseSlug = normalizarSlug(baseSlugRaw);

    const c = await pool.query(
      "SELECT id, nome, slug, ativo, created_at FROM clientes WHERE slug = $1",
      [clienteSlug]
    );
    if (!c.rows.length) return res.status(404).json({ ok: false, erro: "Cliente não encontrado." });

    const b = await pool.query(
      "SELECT id, nome, slug, ativo, created_at, updated_at FROM bases WHERE slug = $1",
      [baseSlug]
    );
    if (!b.rows.length) return res.status(404).json({ ok: false, erro: "Base não encontrada." });

    const base = b.rows[0];
    const custos = await pool.query(
      "SELECT produto_id, custo_produto, imposto_percentual, taxa_fixa FROM custos WHERE base_id = $1 ORDER BY produto_id ASC",
      [base.id]
    );

    const totalItens = custos.rows.length;
    const itensPreview = custos.rows.slice(0, 10).map((row) => ({
      produto_id: row.produto_id,
      custo_produto: Number(row.custo_produto),
      imposto_percentual: Number(row.imposto_percentual),
      taxa_fixa: Number(row.taxa_fixa),
    }));

    return res.json({
      ok: true,
      cliente: c.rows[0],
      base: {
        id: base.id,
        nome: base.nome,
        slug: base.slug,
        ativo: base.ativo,
        created_at: base.created_at,
        updated_at: base.updated_at,
      },
      totalItens,
      itensPreview,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, erro: err.message });
  }
});

// AUTOMAÇÕES (somente leitura) — Preview enriquecido (base + dados ML, sem escrita no ML)
app.get("/automacoes/precificacao/preview-ml", authMiddleware, requireAutomacoesAccess, async (req, res) => {
  try {
    const clienteSlugRaw = String(req.query.clienteSlug || "").trim();
    const baseSlugRaw = String(req.query.baseSlug || "").trim();
    const pageRaw = req.query.page;
    const limitRaw = req.query.limit;
    const margemAlvoRaw = req.query.margemAlvo;

    if (!clienteSlugRaw) return res.status(400).json({ ok: false, erro: "clienteSlug é obrigatório" });
    if (!baseSlugRaw) return res.status(400).json({ ok: false, erro: "baseSlug é obrigatório" });

    const clienteSlug = normalizarSlug(clienteSlugRaw);
    const baseSlug = normalizarSlug(baseSlugRaw);

    const page = Math.max(1, parseInt(pageRaw) || 1);
    const limit = Math.min(Math.max(1, parseInt(limitRaw) || 20), 20);
    const offset = (page - 1) * limit;
    const parsedMargemAlvo = Number(margemAlvoRaw);
    const margemAlvo =
      Number.isFinite(parsedMargemAlvo) && parsedMargemAlvo >= 0.01 && parsedMargemAlvo <= 0.99
        ? parsedMargemAlvo
        : null;

    const c = await pool.query(
      "SELECT id, nome, slug, ativo, created_at FROM clientes WHERE slug = $1",
      [clienteSlug]
    );
    if (!c.rows.length) return res.status(404).json({ ok: false, erro: "Cliente não encontrado." });
    const cliente = c.rows[0];

    const b = await pool.query(
      "SELECT id, nome, slug, ativo, created_at, updated_at FROM bases WHERE slug = $1",
      [baseSlug]
    );
    if (!b.rows.length) return res.status(404).json({ ok: false, erro: "Base não encontrada." });
    const base = b.rows[0];

    const custosRes = await pool.query(
      "SELECT produto_id, custo_produto, imposto_percentual, taxa_fixa FROM custos WHERE base_id = $1",
      [base.id]
    );
    const custosMapExact = new Map();
    const custosMapNorm = new Map();
    const custosMapNumeric = new Map();
    custosRes.rows.forEach((row) => {
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

    // ML (somente leitura): usar ml_user_id já vinculado ao cliente
    const tokenRow = await pool.query(
      "SELECT ml_user_id FROM ml_tokens WHERE cliente_id = $1",
      [cliente.id]
    );
    if (!tokenRow.rows.length) {
      return res.status(404).json({ ok: false, erro: "Cliente sem conta ML vinculada." });
    }
    const mlUserId = tokenRow.rows[0].ml_user_id;

    // Somente leitura (anúncios/dados): esta rota faz apenas GET no ML.
    // Refresh OAuth é permitido aqui só para evitar quebra por expiração do access_token; isso não altera anúncios/preços/estoque/campanhas.
    // 1) Buscar ids de itens ativos do cliente (paginado)
    const search = await mlFetch(
      cliente.id,
      `/users/${mlUserId}/items/search?status=active&offset=${offset}&limit=${limit}`
    );
    if (!search.ok) {
      return res.status(search.status).json({ ok: false, erro: search.data?.message || "Erro ao buscar itens no ML.", status: search.status, data: search.data });
    }

    const totalItensMl = search.data?.paging?.total ?? 0;
    const ids = Array.isArray(search.data?.results) ? search.data.results : [];

    // 2) Buscar detalhes de itens em lote (somente leitura)
    let details = [];
    if (ids.length > 0) {
      // Observação: o endpoint do ML espera ids separados por vírgula; não codificar vírgulas evita incompatibilidades.
      const batch = await mlFetch(cliente.id, `/items?ids=${ids.join(",")}`);
      if (!batch.ok) {
        return res.status(batch.status).json({ ok: false, erro: batch.data?.message || "Erro ao buscar detalhes dos itens no ML.", status: batch.status, data: batch.data });
      }
      details = Array.isArray(batch.data) ? batch.data : [];
    }

    const linhas = await Promise.all(details.map(async (entry) => {
      const body = entry?.body || null;
      const itemId = String(body?.id || entry?.id || "").trim();
      const itemNorm = itemId.toUpperCase();

      // Matching conservador:
      // 1) match exato
      // 2) match normalizado (trim + uppercase)
      // 3) se item começar com MLB, tenta o número contra produto_id numérico da base
      // Observação: MLBU NÃO é tratado como equivalente automático a MLB numérico.
      let baseRow =
        custosMapExact.get(itemId) ||
        custosMapNorm.get(itemNorm) ||
        null;

      const observacoes = [];

      if (!baseRow && itemNorm.startsWith("MLBU")) {
        observacoes.push("item MLBU não é casado automaticamente com produto_id numérico da base");
      }

      if (!baseRow && itemNorm.startsWith("MLB") && !itemNorm.startsWith("MLBU")) {
        const num = itemNorm.slice(3).match(/^\d+/)?.[0] || "";
        if (num && custosMapNumeric.has(num)) {
          baseRow = custosMapNumeric.get(num);
          observacoes.push("match realizado pelo número do MLB (base sem prefixo)");
        }
      }

      const custoProduto = baseRow ? baseRow.custoProduto : null;
      const impostoPercentual = baseRow ? baseRow.impostoPercentual : null;
      const taxaFixa = baseRow ? baseRow.taxaFixa : null;

      // Campos ML disponíveis via leitura (GET /items e /users/.../items/search)
      const precoVendaAtual = (typeof body?.price === "number") ? body.price : (body?.price != null ? Number(body.price) : null);
      const listingTypeId = body?.listing_type_id || null;
      const categoryId = body?.category_id || null;
      const sellerId = body?.seller_id || null;
      const condition = body?.condition || "new";
      const logisticType = body?.shipping?.logistic_type || "xd_drop_off";
      const freeShipping = body?.shipping?.free_shipping ?? true;

      const precoOriginal =
        body?.price != null && Number.isFinite(Number(body.price)) && Number(body.price) > 0
          ? Number(body.price)
          : null;

      let precoPromocionado = null;
      try {
        if (itemId) {
          const pricesResp = await mlFetch(cliente.id, `/items/${encodeURIComponent(itemId)}/prices`);
          const pricesList = Array.isArray(pricesResp?.data?.prices) ? pricesResp.data.prices : [];
          const amounts = pricesList
            .map((p) => Number(p?.amount))
            .filter((n) => Number.isFinite(n) && n > 0);
          if (amounts.length > 0) {
            precoPromocionado = Math.min(...amounts);
          }
        }
      } catch (_) {
        precoPromocionado = null;
      }

      const precoEfetivo = precoPromocionado ?? precoOriginal;

      const [listingPricesResp, shippingResp] = await Promise.all([
        (async () => {
          if (precoEfetivo === null || !listingTypeId || !categoryId) return null;
          const query = `/sites/MLB/listing_prices?price=${encodeURIComponent(precoEfetivo)}&listing_type_id=${encodeURIComponent(listingTypeId)}&category_id=${encodeURIComponent(categoryId)}`;
          try {
            return await mlFetch(cliente.id, query);
          } catch (_) {
            return null;
          }
        })(),
        (async () => {
          if (precoEfetivo === null || !sellerId || !listingTypeId || !itemId) return null;
          const query = `/users/${encodeURIComponent(sellerId)}/shipping_options/free?item_id=${encodeURIComponent(itemId)}&verbose=true&item_price=${encodeURIComponent(precoEfetivo)}&listing_type_id=${encodeURIComponent(listingTypeId)}&mode=me2&condition=${encodeURIComponent(condition)}&logistic_type=${encodeURIComponent(logisticType)}&free_shipping=${encodeURIComponent(freeShipping)}`;
          try {
            return await mlFetch(cliente.id, query);
          } catch (_) {
            return null;
          }
        })(),
      ]);

      const listingPricesData =
        listingPricesResp && listingPricesResp.ok ? listingPricesResp.data : null;
      const listingPriceRoot = Array.isArray(listingPricesData)
        ? listingPricesData[0]
        : (Array.isArray(listingPricesData?.results) ? listingPricesData.results[0] : listingPricesData);
      const comissaoMarketplace =
        listingPriceRoot?.sale_fee_amount != null ? Number(listingPriceRoot.sale_fee_amount) : null;
      const comissaoPercentual =
        listingPriceRoot?.sale_fee_details?.percentage_fee != null
          ? Number(listingPriceRoot.sale_fee_details.percentage_fee)
          : null;

      const frete =
        shippingResp && shippingResp.ok && shippingResp.data?.coverage?.all_country?.list_cost != null
          ? Number(shippingResp.data.coverage.all_country.list_cost)
          : null;
      const impostoNumero = Number(impostoPercentual);
      const impostoAliquota =
        Number.isFinite(impostoNumero) && impostoNumero >= 0
          ? (impostoNumero > 1 ? impostoNumero / 100 : impostoNumero)
          : null;

      const hasLcInputs =
        precoEfetivo !== null &&
        custoProduto !== null &&
        impostoAliquota !== null &&
        taxaFixa !== null &&
        comissaoMarketplace !== null &&
        frete !== null;

      const lucroContribuicao = hasLcInputs
        ? precoEfetivo -
          (precoEfetivo * impostoAliquota) -
          comissaoMarketplace -
          frete -
          taxaFixa -
          custoProduto
        : null;
      const margemContribuicao =
        lucroContribuicao !== null && precoEfetivo
          ? lucroContribuicao / precoEfetivo
          : null;

      let precoAlvo = null;
      let lucroAlvo = null;
      if (
        margemAlvo !== null &&
        custoProduto !== null &&
        frete !== null &&
        taxaFixa !== null &&
        impostoAliquota !== null &&
        comissaoPercentual !== null
      ) {
        const denominator =
          1 - impostoAliquota - (comissaoPercentual / 100) - margemAlvo;
        if (denominator > 0) {
          precoAlvo = (custoProduto + frete + taxaFixa) / denominator;
          lucroAlvo = precoAlvo * margemAlvo;
        }
      }

      const lucroContribuicaoPreview = lucroContribuicao;
      const margemContribuicaoPreview = margemContribuicao;

      if (!baseRow) observacoes.push("Sem correspondência na base (produto_id não encontrado).");
      if (comissaoMarketplace === null) observacoes.push("comissaoMarketplace=null (não foi possível obter no ML para este item).");
      if (frete === null) observacoes.push("frete=null (não foi possível obter no ML para este item).");
      if (lucroContribuicaoPreview === null || margemContribuicaoPreview === null) {
        observacoes.push("lucro/margem=null (faltam dados de custo/comissão/frete para este item).");
      }

      return {
        item_id: itemId || null,
        titulo: body?.title || null,
        status: body?.status || null,
        precoVendaAtual,
        tipoAnuncio: listingTypeId,
        listing_type_id: listingTypeId,
        custoProduto,
        impostoPercentual,
        taxaFixa,
        precoOriginal,
        precoPromocionado,
        precoBaseCalculo: precoEfetivo,
        precoEfetivo,
        comissaoMarketplace,
        comissaoPercentual,
        frete,
        lucroContribuicao,
        margemContribuicao,
        precoAlvo,
        lucroAlvo,
        lucroContribuicaoPreview,
        margemContribuicaoPreview,
        temBase: Boolean(baseRow),
        observacoes,
      };
    }));

    return res.json({
      ok: true,
      cliente,
      base: {
        id: base.id,
        nome: base.nome,
        slug: base.slug,
        ativo: base.ativo,
        created_at: base.created_at,
        updated_at: base.updated_at,
      },
      page,
      limit,
      totalItensMl,
      linhas,
      fonteDados: {
        ml: {
          itens: "GET /users/{ml_user_id}/items/search?status=active",
          detalhes: "GET /items?ids=...",
        },
        base: "SELECT custos WHERE base_id = ... (produto_id = item_id/MLB)",
        camposNullPorSeguranca: ["lucroContribuicaoPreview", "margemContribuicaoPreview"],
      },
    });
  } catch (err) {
    return res.status(500).json({ ok: false, erro: err.message });
  }
});

// SALVAR RELATÓRIO
app.post("/automacoes/relatorios", authMiddleware, requireAutomacoesAccess, async (req, res) => {
  try {
    const {
      clienteSlug, baseSlug, margemAlvo, escopo, observacoes, linhas,
    } = req.body || {};

    if (!clienteSlug) return res.status(400).json({ ok: false, erro: "clienteSlug é obrigatório." });
    if (!baseSlug) return res.status(400).json({ ok: false, erro: "baseSlug é obrigatório." });
    if (!Array.isArray(linhas) || linhas.length === 0) {
      return res.status(400).json({ ok: false, erro: "linhas é obrigatório e não pode ser vazio." });
    }

    const clienteSlugNorm = normalizarSlug(clienteSlug);
    const baseSlugNorm = normalizarSlug(baseSlug);
    const escopoNorm = ["pagina_atual", "loja_completa"].includes(escopo) ? escopo : "pagina_atual";

    const c = await pool.query("SELECT id, slug FROM clientes WHERE slug = $1", [clienteSlugNorm]);
    if (!c.rows.length) return res.status(404).json({ ok: false, erro: "Cliente não encontrado." });

    const b = await pool.query("SELECT id, slug FROM bases WHERE slug = $1", [baseSlugNorm]);
    if (!b.rows.length) return res.status(404).json({ ok: false, erro: "Base não encontrada." });

    const margemNumber = Number(margemAlvo);
    const margem = Number.isFinite(margemNumber) && margemNumber > 0 && margemNumber < 1
      ? margemNumber
      : null;

    let comBase = 0, semBase = 0, criticos = 0, atencao = 0, saudaveis = 0;
    let mcSum = 0, mcCount = 0;
    for (const l of linhas) {
      if (l.temBase) comBase++; else semBase++;
      if (l.diagnostico === "critico") criticos++;
      if (l.diagnostico === "atencao") atencao++;
      if (l.diagnostico === "saudavel") saudaveis++;
      const mc = Number(l.mc);
      if (Number.isFinite(mc)) { mcSum += mc; mcCount++; }
    }
    const mcMedia = mcCount > 0 ? mcSum / mcCount : null;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const ins = await client.query(
        `INSERT INTO relatorios
         (user_id, cliente_id, cliente_slug, base_id, base_slug, margem_alvo,
          escopo, status, total_itens, itens_com_base, itens_sem_base,
          itens_criticos, itens_atencao, itens_saudaveis, mc_media, observacoes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'concluido',$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING id, created_at`,
        [
          req.user.id,
          c.rows[0].id, c.rows[0].slug,
          b.rows[0].id, b.rows[0].slug,
          margem, escopoNorm,
          linhas.length, comBase, semBase,
          criticos, atencao, saudaveis,
          mcMedia, (observacoes || null),
        ]
      );
      const relatorioId = ins.rows[0].id;

      for (const l of linhas) {
        await client.query(
          `INSERT INTO relatorio_itens
           (relatorio_id, item_id, titulo, status_anuncio, listing_type_id,
            preco_original, preco_promocional, preco_efetivo,
            custo, imposto_percentual, taxa_fixa,
            frete, comissao, comissao_percentual,
            lc, mc, preco_alvo, preco_sugerido, diferenca_preco,
            acao_recomendada, explicacao_calculo, diagnostico, tem_base)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
          [
            relatorioId,
            String(l.item_id || ""),
            l.titulo ?? null,
            l.statusAnuncio ?? null,
            l.listingTypeId ?? null,
            l.precoOriginal ?? null,
            l.precoPromocional ?? null,
            l.precoEfetivo ?? null,
            l.custo ?? null,
            l.impostoPercentual ?? null,
            l.taxaFixa ?? null,
            l.frete ?? null,
            l.comissao ?? null,
            l.comissaoPercentual ?? null,
            l.lc ?? null,
            l.mc ?? null,
            l.precoAlvo ?? null,
            l.precoSugerido ?? l.preco_sugerido ?? null,
            l.diferencaPreco ?? l.diferenca_preco ?? null,
            l.acaoRecomendada ?? l.acao_recomendada ?? null,
            l.explicacaoCalculo ?? l.explicacao_calculo ?? null,
            l.diagnostico ?? null,
            !!l.temBase,
          ]
        );
      }

      await client.query("COMMIT");

      registrarLog({
        ...dadosUsuarioDeReq(req),
        acao: "automacoes.relatorio.salvar",
        detalhes: {
          relatorio_id: relatorioId,
          cliente_slug: clienteSlugNorm,
          base_slug: baseSlugNorm,
          escopo: escopoNorm,
          total_itens: linhas.length,
        },
        ip: extrairIp(req),
        status: "sucesso",
      });

      return res.status(201).json({
        ok: true,
        relatorio_id: relatorioId,
        created_at: ins.rows[0].created_at,
      });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } catch (err) {
    return res.status(500).json({ ok: false, erro: err.message });
  }
});

// LISTAR RELATÓRIOS (global ou por cliente)
app.get("/automacoes/relatorios", authMiddleware, requireAutomacoesAccess, async (req, res) => {
  try {
    const clienteSlug = String(req.query.clienteSlug || "").trim();
    const pastaIdRaw = req.query.pastaId;
    let pastaId = null;
    if (pastaIdRaw !== undefined && pastaIdRaw !== null && String(pastaIdRaw).trim() !== "") {
      const parsedPastaId = parseInt(pastaIdRaw, 10);
      if (!Number.isFinite(parsedPastaId) || parsedPastaId <= 0) {
        return res.status(400).json({ ok: false, erro: "pastaId inválido." });
      }
      pastaId = parsedPastaId;
    }

    const limitRaw = parseInt(req.query.limit, 10);
    const temLimit = Number.isFinite(limitRaw) && limitRaw > 0;
    const limit = temLimit ? Math.min(Math.max(limitRaw, 1), 500) : null;

    const params = [];
    const where = [];
    if (clienteSlug) {
      params.push(normalizarSlug(clienteSlug));
      where.push(`r.cliente_slug = $${params.length}`);
    }
    if (pastaId !== null) {
      params.push(pastaId);
      where.push(`r.pasta_id = $${params.length}`);
    }

    let sql = `
      SELECT r.id, r.user_id, r.cliente_slug, r.base_slug, r.escopo, r.status,
             r.margem_alvo, r.total_itens, r.itens_com_base, r.itens_sem_base,
             r.itens_criticos, r.itens_atencao, r.itens_saudaveis,
             r.mc_media, r.observacoes, r.created_at, r.pasta_id,
             p.nome AS pasta_nome
        FROM relatorios r
        LEFT JOIN relatorio_pastas p ON p.id = r.pasta_id
    `;

    if (where.length) {
      sql += ` WHERE ${where.join(" AND ")}`;
    }

    sql += ` ORDER BY r.created_at DESC`;
    if (temLimit) {
      params.push(limit);
      sql += ` LIMIT $${params.length}`;
    }

    const result = await pool.query(sql, params);

    return res.json({ ok: true, total: result.rows.length, relatorios: result.rows });
  } catch (err) {
    return res.status(500).json({ ok: false, erro: err.message });
  }
});

// PASTAS DE RELATÓRIOS
app.get("/relatorios/pastas", authMiddleware, requireAutomacoesAccess, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.id, p.nome, p.descricao, p.created_at,
              COUNT(r.id)::int AS total_relatorios
         FROM relatorio_pastas p
         LEFT JOIN relatorios r ON r.pasta_id = p.id
        GROUP BY p.id, p.nome, p.descricao, p.created_at
        ORDER BY p.nome ASC, p.id ASC`
    );
    return res.json({ ok: true, total: result.rows.length, pastas: result.rows });
  } catch (err) {
    return res.status(500).json({ ok: false, erro: err.message });
  }
});

app.post("/relatorios/pastas", authMiddleware, requireAutomacoesAccess, async (req, res) => {
  try {
    const nome = String(req.body?.nome || "").trim();
    const descricaoRaw = req.body?.descricao;
    const descricao = descricaoRaw == null || String(descricaoRaw).trim() === ""
      ? null
      : String(descricaoRaw).trim();

    if (!nome) {
      return res.status(400).json({ ok: false, erro: "nome é obrigatório." });
    }

    const ins = await pool.query(
      `INSERT INTO relatorio_pastas (nome, descricao)
       VALUES ($1, $2)
       RETURNING id, nome, descricao, created_at`,
      [nome, descricao]
    );

    return res.status(201).json({ ok: true, pasta: ins.rows[0] });
  } catch (err) {
    return res.status(500).json({ ok: false, erro: err.message });
  }
});

app.patch("/relatorios/pastas/:id", authMiddleware, requireAutomacoesAccess, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ ok: false, erro: "id inválido." });
    }

    const atual = await pool.query("SELECT id, nome, descricao, created_at FROM relatorio_pastas WHERE id = $1", [id]);
    if (!atual.rows.length) {
      return res.status(404).json({ ok: false, erro: "Pasta não encontrada." });
    }

    const temNome = Object.prototype.hasOwnProperty.call(req.body || {}, "nome");
    const temDescricao = Object.prototype.hasOwnProperty.call(req.body || {}, "descricao");
    if (!temNome && !temDescricao) {
      return res.status(400).json({ ok: false, erro: "Informe nome e/ou descricao para atualizar." });
    }

    const nome = temNome ? String(req.body?.nome || "").trim() : atual.rows[0].nome;
    if (temNome && !nome) {
      return res.status(400).json({ ok: false, erro: "nome é obrigatório." });
    }

    const descricao = temDescricao
      ? (req.body?.descricao == null || String(req.body.descricao).trim() === "" ? null : String(req.body.descricao).trim())
      : atual.rows[0].descricao;

    const upd = await pool.query(
      `UPDATE relatorio_pastas
          SET nome = $1,
              descricao = $2
        WHERE id = $3
      RETURNING id, nome, descricao, created_at`,
      [nome, descricao, id]
    );

    return res.json({ ok: true, pasta: upd.rows[0] });
  } catch (err) {
    return res.status(500).json({ ok: false, erro: err.message });
  }
});

app.delete("/relatorios/pastas/:id", authMiddleware, requireAutomacoesAccess, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ ok: false, erro: "id inválido." });
    }

    const pasta = await pool.query("SELECT id FROM relatorio_pastas WHERE id = $1", [id]);
    if (!pasta.rows.length) {
      return res.status(404).json({ ok: false, erro: "Pasta não encontrada." });
    }

    const refs = await pool.query("SELECT COUNT(*)::int AS total FROM relatorios WHERE pasta_id = $1", [id]);
    if ((refs.rows[0]?.total || 0) > 0) {
      return res.status(400).json({ ok: false, erro: "Não é possível excluir uma pasta com relatórios." });
    }

    await pool.query("DELETE FROM relatorio_pastas WHERE id = $1", [id]);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, erro: err.message });
  }
});

app.patch("/relatorios/:id/pasta", authMiddleware, requireAutomacoesAccess, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ ok: false, erro: "id inválido." });
    }

    const rel = await pool.query("SELECT id FROM relatorios WHERE id = $1", [id]);
    if (!rel.rows.length) {
      return res.status(404).json({ ok: false, erro: "Relatório não encontrado." });
    }

    const pastaIdBody = req.body?.pastaId;
    if (pastaIdBody === null) {
      await pool.query("UPDATE relatorios SET pasta_id = NULL WHERE id = $1", [id]);
      return res.json({ ok: true });
    }

    const pastaId = parseInt(pastaIdBody, 10);
    if (!Number.isFinite(pastaId) || pastaId <= 0) {
      return res.status(400).json({ ok: false, erro: "pastaId inválido." });
    }

    const pasta = await pool.query("SELECT id FROM relatorio_pastas WHERE id = $1", [pastaId]);
    if (!pasta.rows.length) {
      return res.status(404).json({ ok: false, erro: "Pasta não encontrada." });
    }

    await pool.query("UPDATE relatorios SET pasta_id = $1 WHERE id = $2", [pastaId, id]);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, erro: err.message });
  }
});

// BUSCAR DETALHE DE UM RELATÓRIO
app.get("/automacoes/relatorios/:id", authMiddleware, requireAutomacoesAccess, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ ok: false, erro: "id inválido." });
    }

    const rel = await pool.query("SELECT * FROM relatorios WHERE id = $1", [id]);
    if (!rel.rows.length) {
      return res.status(404).json({ ok: false, erro: "Relatório não encontrado." });
    }

    const itens = await pool.query(
      `SELECT id, item_id, sku, titulo, status_anuncio, listing_type_id,
              preco_original, preco_promocional, preco_efetivo,
              custo, imposto_percentual, taxa_fixa,
              frete, comissao, comissao_percentual,
              lc, mc, preco_alvo, preco_sugerido, diferenca_preco,
              acao_recomendada, explicacao_calculo, diagnostico, tem_base
         FROM relatorio_itens
        WHERE relatorio_id = $1
        ORDER BY id ASC`,
      [id]
    );

    return res.json({
      ok: true,
      relatorio: rel.rows[0],
      itens: itens.rows,
      total_itens: itens.rows.length,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, erro: err.message });
  }
});

// EXCLUIR RELATÓRIO
app.delete("/automacoes/relatorios/:id", authMiddleware, requireAutomacoesAccess, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ ok: false, erro: "id inválido." });
    }

    const rel = await pool.query("SELECT id FROM relatorios WHERE id = $1", [id]);
    if (!rel.rows.length) {
      return res.status(404).json({ ok: false, erro: "Relatório não encontrado." });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM relatorio_itens WHERE relatorio_id = $1", [id]);
      await client.query("DELETE FROM relatorios WHERE id = $1", [id]);
      await client.query("COMMIT");
      return res.json({ ok: true });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } catch (err) {
    return res.status(500).json({ ok: false, erro: err.message });
  }
});

function csvEscape(valor) {
  if (valor === null || valor === undefined) return "";
  const texto = String(valor);
  if (texto.includes('"') || texto.includes(",") || texto.includes("\n")) {
    return `"${texto.replace(/"/g, '""')}"`;
  }
  return texto;
}

function montarNomeArquivoRelatorio(relatorio, extensao, prefixo = "relatorio") {
  const cliente = normalizarSlug(relatorio?.cliente_slug || "cliente");
  const base = normalizarSlug(relatorio?.base_slug || "base");
  const escopo = normalizarSlug(relatorio?.escopo || "escopo");
  const id = Number(relatorio?.id) || 0;
  return `${prefixo}-${cliente}-${base}-${escopo}-#${id}.${extensao}`;
}

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

async function carregarRelatorioComItens(id) {
  const rel = await pool.query("SELECT * FROM relatorios WHERE id = $1", [id]);
  if (!rel.rows.length) return null;
  const itens = await pool.query(
    `SELECT id, item_id, sku, titulo, status_anuncio, listing_type_id,
            preco_original, preco_promocional, preco_efetivo,
            custo, imposto_percentual, taxa_fixa,
            frete, comissao, comissao_percentual,
            lc, mc, preco_alvo, preco_sugerido, diferenca_preco,
            acao_recomendada, explicacao_calculo, diagnostico, tem_base
       FROM relatorio_itens
      WHERE relatorio_id = $1
      ORDER BY id ASC`,
    [id]
  );
  return { relatorio: rel.rows[0], itens: itens.rows };
}

// EXPORTAR RELATÓRIO CSV
app.get("/automacoes/relatorios/:id/export/csv", authMiddleware, requireAutomacoesAccess, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ ok: false, erro: "id inválido." });
    }

    const dados = await carregarRelatorioComItens(id);
    if (!dados) {
      return res.status(404).json({ ok: false, erro: "Relatório não encontrado." });
    }
    const { relatorio, itens } = dados;

    const linhas = [];
    linhas.push("Resumo do relatório");
    linhas.push(`ID,${csvEscape(relatorio.id)}`);
    linhas.push(`Cliente,${csvEscape(relatorio.cliente_slug)}`);
    linhas.push(`Base,${csvEscape(relatorio.base_slug)}`);
    linhas.push(`Escopo,${csvEscape(relatorio.escopo)}`);
    linhas.push(`Status,${csvEscape(relatorio.status)}`);
    linhas.push(`Margem alvo,${csvEscape(relatorio.margem_alvo)}`);
    linhas.push(`Total itens,${csvEscape(relatorio.total_itens)}`);
    linhas.push(`Itens com base,${csvEscape(relatorio.itens_com_base)}`);
    linhas.push(`Itens sem base,${csvEscape(relatorio.itens_sem_base)}`);
    linhas.push(`Itens críticos,${csvEscape(relatorio.itens_criticos)}`);
    linhas.push(`Itens atenção,${csvEscape(relatorio.itens_atencao)}`);
    linhas.push(`Itens saudáveis,${csvEscape(relatorio.itens_saudaveis)}`);
    linhas.push(`MC média,${csvEscape(relatorio.mc_media)}`);
    linhas.push(`Observações,${csvEscape(relatorio.observacoes)}`);
    linhas.push(`Criado em,${csvEscape(relatorio.created_at)}`);
    linhas.push("");
    linhas.push("Itens");
    linhas.push([
      "item_id", "titulo", "status_anuncio", "listing_type_id",
      "preco_original", "preco_promocional", "preco_efetivo",
      "custo", "imposto_percentual", "taxa_fixa",
      "frete", "comissao", "comissao_percentual",
      "lc", "mc", "preco_alvo", "preco_sugerido", "diferenca_preco",
      "acao_recomendada", "explicacao_calculo", "diagnostico", "tem_base",
    ].join(","));

    itens.forEach((it) => {
      linhas.push([
        it.item_id, it.titulo, it.status_anuncio, it.listing_type_id,
        it.preco_original, it.preco_promocional, it.preco_efetivo,
        it.custo, it.imposto_percentual, it.taxa_fixa,
        it.frete, it.comissao, it.comissao_percentual,
        it.lc, it.mc, it.preco_alvo, it.preco_sugerido, it.diferenca_preco,
        it.acao_recomendada, it.explicacao_calculo, it.diagnostico, it.tem_base,
      ].map(csvEscape).join(","));
    });

    const csv = linhas.join("\n");
    const filename = montarNomeArquivoRelatorio(relatorio, "csv");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.send(`\uFEFF${csv}`);
  } catch (err) {
    return res.status(500).json({ ok: false, erro: err.message });
  }
});

// EXPORTAR RELATÓRIO XLSX
app.get("/automacoes/relatorios/:id/export/xlsx", authMiddleware, requireAutomacoesAccess, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ ok: false, erro: "id inválido." });
    }

    const dados = await carregarRelatorioComItens(id);
    if (!dados) {
      return res.status(404).json({ ok: false, erro: "Relatório não encontrado." });
    }
    const { relatorio, itens } = dados;

    const paraDecimalPct = (v) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return null;
      return n > 1 ? n / 100 : n;
    };
    const numeroOuNulo = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    const resumoRows = [
      ["Resumo do relatório", ""],
      ["Cliente", relatorio.cliente_slug || "—"],
      ["Base", relatorio.base_slug || "—"],
      ["Escopo", relatorio.escopo || "—"],
      ["Margem alvo", paraDecimalPct(relatorio.margem_alvo)],
      ["Total de itens", numeroOuNulo(relatorio.total_itens)],
      ["Com base", numeroOuNulo(relatorio.itens_com_base)],
      ["Sem base", numeroOuNulo(relatorio.itens_sem_base)],
      ["Críticos", numeroOuNulo(relatorio.itens_criticos)],
      ["Atenção", numeroOuNulo(relatorio.itens_atencao)],
      ["Saudáveis", numeroOuNulo(relatorio.itens_saudaveis)],
      ["MC média", paraDecimalPct(relatorio.mc_media)],
      ["Data do relatório", relatorio.created_at ? new Date(relatorio.created_at).toLocaleString("pt-BR") : "—"],
    ];

    const matrizRows = [
      [
        "Edite custo, frete, comissão, preço ou margem alvo para simular novas decisões.",
        ...Array(28).fill(""),
      ],
      [
        "Dados do anúncio", "", "", "",
        "",
        "Cálculo atual", "", "", "", "", "", "",
        "",
        "Promoção", "", "", "",
        "",
        "Preço sugerido", "", "",
        "",
        "Decisão", "", "", "", "", "", "",
      ],
      [
        "ID", "SKU/Base", "Título", "Marketplace",
        "",
        "Preço Custo", "Imposto %", "Frete R$", "Comissão R$", "Preço Original", "Lucro Original", "MC Original",
        "",
        "Preço Promocional", "Lucro Promocional", "MC Promocional", "Preço Efetivo",
        "",
        "Margem Alvo", "Preço Sugerido", "Lucro no Sugerido",
        "",
        "Ação", "Preço Adotado", "Diferença R$", "Diferença %",
        "Diagnóstico", "Ação Recomendada", "Observação",
      ],
    ];

    itens.forEach((it) => {
      const impostoPct = paraDecimalPct(it.imposto_percentual);
      const freteNum = numeroOuNulo(it.frete);
      matrizRows.push([
        it.item_id || "",
        it.sku || "",
        it.titulo || "",
        "MeLi",
        "",
        numeroOuNulo(it.custo),
        impostoPct,
        freteNum,
        numeroOuNulo(it.comissao),
        numeroOuNulo(it.preco_original),
        "",
        "",
        "",
        numeroOuNulo(it.preco_promocional),
        "",
        "",
        numeroOuNulo(it.preco_efetivo),
        "",
        paraDecimalPct(relatorio.margem_alvo),
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        it.diagnostico || "",
        it.acao_recomendada || "",
        it.explicacao_calculo || "",
      ]);
    });

    const workbook = XLSX.utils.book_new();
    const resumoSheet = XLSX.utils.aoa_to_sheet(resumoRows);
    const matrizSheet = XLSX.utils.aoa_to_sheet(matrizRows);

    const setFormula = (ws, addr, formula, format) => {
      ws[addr] = { ...(ws[addr] || {}), f: formula };
      if (format) ws[addr].z = format;
    };
    const setFormat = (ws, addr, format) => {
      if (!ws[addr]) return;
      ws[addr].z = format;
    };
    const setStyle = (ws, addr, style) => {
      ws[addr] = { ...(ws[addr] || { t: "s", v: "" }), s: style };
    };
    const paintRange = (ws, startCol, endCol, row, style) => {
      for (let c = startCol; c <= endCol; c++) {
        const addr = XLSX.utils.encode_cell({ c, r: row - 1 });
        setStyle(ws, addr, style);
      }
    };

    for (let row = 4; row < 4 + itens.length; row++) {
      setFormula(matrizSheet, `K${row}`, `IFERROR(J${row}-J${row}*G${row}-H${row}-I${row}-F${row},"")`, "R$ #,##0.00");
      setFormula(matrizSheet, `L${row}`, `IFERROR(K${row}/J${row},"")`, "0.00%");
      setFormula(matrizSheet, `O${row}`, `IFERROR(N${row}-N${row}*G${row}-H${row}-I${row}-F${row},"")`, "R$ #,##0.00");
      setFormula(matrizSheet, `P${row}`, `IFERROR(O${row}/N${row},"")`, "0.00%");
      setFormula(matrizSheet, `T${row}`, `IFERROR((F${row}+H${row}+I${row})/(1-G${row}-S${row}),"")`, "R$ #,##0.00");
      setFormula(matrizSheet, `U${row}`, `IFERROR(T${row}*S${row},"")`, "R$ #,##0.00");
      setFormula(matrizSheet, `W${row}`, `IF(AA${row}="sem_base","Revisar custo/base",IF(AA${row}="sem_frete","Revisar frete",IF(AA${row}="sem_comissao","Revisar comissão",IF(Q${row}<T${row},"Subir preço",IF(Q${row}>T${row},"Avaliar redução","Manter")))))`);
      setFormula(matrizSheet, `X${row}`, `IF(W${row}="Subir preço",T${row},Q${row})`, "R$ #,##0.00");
      setFormula(matrizSheet, `Y${row}`, `IFERROR(X${row}-Q${row},"")`, "R$ #,##0.00");
      setFormula(matrizSheet, `Z${row}`, `IFERROR(Y${row}/Q${row},"")`, "0.00%");

      ["F", "H", "I", "J", "K", "N", "O", "Q", "T", "U", "X", "Y"].forEach((col) => setFormat(matrizSheet, `${col}${row}`, "R$ #,##0.00"));
      ["G", "L", "P", "S", "Z"].forEach((col) => setFormat(matrizSheet, `${col}${row}`, "0.00%"));
    }

    setFormat(resumoSheet, "B5", "0.00%");
    setFormat(resumoSheet, "B12", "0.00%");

    matrizSheet["!autofilter"] = { ref: `A3:AC${Math.max(3, 3 + itens.length)}` };
    matrizSheet["!freeze"] = { xSplit: 0, ySplit: 3, topLeftCell: "A4", activePane: "bottomLeft", state: "frozen" };
    matrizSheet["!merges"] = [
      XLSX.utils.decode_range("A1:AC1"),
      XLSX.utils.decode_range("A2:D2"),
      XLSX.utils.decode_range("F2:L2"),
      XLSX.utils.decode_range("N2:Q2"),
      XLSX.utils.decode_range("S2:U2"),
      XLSX.utils.decode_range("W2:AC2"),
    ];
    matrizSheet["!cols"] = [
      { wch: 14 }, { wch: 12 }, { wch: 48 }, { wch: 12 }, { wch: 3 },
      { wch: 12 }, { wch: 10 }, { wch: 11 }, { wch: 12 }, { wch: 13 }, { wch: 13 }, { wch: 11 }, { wch: 3 },
      { wch: 14 }, { wch: 15 }, { wch: 12 }, { wch: 12 }, { wch: 3 },
      { wch: 12 }, { wch: 14 }, { wch: 16 }, { wch: 3 },
      { wch: 18 }, { wch: 13 }, { wch: 12 }, { wch: 11 }, { wch: 12 }, { wch: 24 }, { wch: 30 },
    ];

    const styleInstrucao = {
      font: { bold: true, color: { rgb: "374151" } },
      fill: { patternType: "solid", fgColor: { rgb: "F3F4F6" } },
      alignment: { horizontal: "left", vertical: "center" },
    };
    const styleHeaderBase = {
      font: { bold: true, color: { rgb: "1F2937" } },
      alignment: { horizontal: "center", vertical: "center", wrapText: true },
    };
    const styleDados = { ...styleHeaderBase, fill: { patternType: "solid", fgColor: { rgb: "E5E7EB" } } };
    const styleCalc = { ...styleHeaderBase, fill: { patternType: "solid", fgColor: { rgb: "DBEAFE" } } };
    const stylePromo = { ...styleHeaderBase, fill: { patternType: "solid", fgColor: { rgb: "EDE9FE" } } };
    const styleSug = { ...styleHeaderBase, fill: { patternType: "solid", fgColor: { rgb: "DCFCE7" } } };
    const styleDec = { ...styleHeaderBase, fill: { patternType: "solid", fgColor: { rgb: "FEF3C7" } } };
    const styleSeparador = { fill: { patternType: "solid", fgColor: { rgb: "FFFFFF" } } };

    paintRange(matrizSheet, 0, 28, 1, styleInstrucao);
    paintRange(matrizSheet, 0, 3, 2, styleDados);
    paintRange(matrizSheet, 5, 11, 2, styleCalc);
    paintRange(matrizSheet, 13, 16, 2, stylePromo);
    paintRange(matrizSheet, 18, 20, 2, styleSug);
    paintRange(matrizSheet, 22, 28, 2, styleDec);
    paintRange(matrizSheet, 4, 4, 2, styleSeparador);
    paintRange(matrizSheet, 12, 12, 2, styleSeparador);
    paintRange(matrizSheet, 17, 17, 2, styleSeparador);
    paintRange(matrizSheet, 21, 21, 2, styleSeparador);

    paintRange(matrizSheet, 0, 3, 3, styleDados);
    paintRange(matrizSheet, 5, 11, 3, styleCalc);
    paintRange(matrizSheet, 13, 16, 3, stylePromo);
    paintRange(matrizSheet, 18, 20, 3, styleSug);
    paintRange(matrizSheet, 22, 28, 3, styleDec);
    paintRange(matrizSheet, 4, 4, 3, styleSeparador);
    paintRange(matrizSheet, 12, 12, 3, styleSeparador);
    paintRange(matrizSheet, 17, 17, 3, styleSeparador);
    paintRange(matrizSheet, 21, 21, 3, styleSeparador);
    resumoSheet["!cols"] = [{ wch: 22 }, { wch: 28 }];

    XLSX.utils.book_append_sheet(workbook, resumoSheet, "Resumo");
    XLSX.utils.book_append_sheet(workbook, matrizSheet, "Matriz Mercado Livre");

    const buffer = XLSX.write(workbook, {
      type: "buffer",
      bookType: "xlsx",
      compression: true,
    });

    const filename = montarNomeArquivoRelatorio(relatorio, "xlsx", "matriz-precificacao");
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.send(buffer);
  } catch (err) {
    return res.status(500).json({ ok: false, erro: err.message });
  }
});

// ========== DIAGNÓSTICO COMPLETO DA LOJA ==========

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

// ENDPOINT — iniciar diagnóstico completo
app.post("/automacoes/diagnostico-completo/start", authMiddleware, requireAutomacoesAccess, async (req, res) => {
  try {
    const { clienteSlug, baseSlug, margemAlvo, observacoes } = req.body || {};
    if (!clienteSlug) return res.status(400).json({ ok: false, erro: "clienteSlug é obrigatório." });
    if (!baseSlug) return res.status(400).json({ ok: false, erro: "baseSlug é obrigatório." });

    const clienteSlugNorm = normalizarSlug(clienteSlug);
    const baseSlugNorm = normalizarSlug(baseSlug);

    const c = await pool.query("SELECT id, slug FROM clientes WHERE slug = $1", [clienteSlugNorm]);
    if (!c.rows.length) return res.status(404).json({ ok: false, erro: "Cliente não encontrado." });

    const b = await pool.query("SELECT id, slug FROM bases WHERE slug = $1", [baseSlugNorm]);
    if (!b.rows.length) return res.status(404).json({ ok: false, erro: "Base não encontrada." });

    const t = await pool.query("SELECT 1 FROM ml_tokens WHERE cliente_id = $1", [c.rows[0].id]);
    if (!t.rows.length) return res.status(400).json({ ok: false, erro: "Cliente sem conta ML vinculada." });

    const emAndamento = await pool.query(
      `SELECT id FROM relatorios
        WHERE cliente_id = $1 AND escopo = 'loja_completa' AND status = 'processando'
        ORDER BY id DESC LIMIT 1`,
      [c.rows[0].id]
    );
    if (emAndamento.rows.length) {
      return res.status(409).json({
        ok: false,
        erro: "Já existe um diagnóstico completo em andamento para este cliente.",
        relatorio_id: emAndamento.rows[0].id,
      });
    }

    const margemNum = Number(margemAlvo);
    const margem = Number.isFinite(margemNum) && margemNum > 0 && margemNum < 1 ? margemNum : null;

    const ins = await pool.query(
      `INSERT INTO relatorios
       (user_id, cliente_id, cliente_slug, base_id, base_slug, margem_alvo,
        escopo, status, total_itens, observacoes)
       VALUES ($1,$2,$3,$4,$5,$6,'loja_completa','processando',0,$7)
       RETURNING id, created_at`,
      [
        req.user.id,
        c.rows[0].id,
        c.rows[0].slug,
        b.rows[0].id,
        b.rows[0].slug,
        margem,
        observacoes || null,
      ]
    );
    const relatorioId = ins.rows[0].id;

    registrarLog({
      ...dadosUsuarioDeReq(req),
      acao: "automacoes.diagnostico_completo.start",
      detalhes: { relatorio_id: relatorioId, cliente_slug: clienteSlugNorm, base_slug: baseSlugNorm },
      ip: extrairIp(req),
      status: "sucesso",
    });

    setImmediate(() => {
      executarDiagnosticoCompleto(relatorioId).catch((err) => {
        console.error(`[diag ${relatorioId}] falha não tratada:`, err);
      });
    });

    return res.status(202).json({
      ok: true,
      relatorio_id: relatorioId,
      status: "processando",
      created_at: ins.rows[0].created_at,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, erro: err.message });
  }
});

// ENDPOINT — status leve do diagnóstico (somente resumo, sem itens)
app.get("/automacoes/diagnostico-completo/:id", authMiddleware, requireAutomacoesAccess, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ ok: false, erro: "id inválido." });
    }
    const r = await pool.query(
      `SELECT id, cliente_slug, base_slug, margem_alvo, escopo, status,
              total_itens, itens_com_base, itens_sem_base,
              itens_criticos, itens_atencao, itens_saudaveis,
              mc_media, observacoes, created_at
         FROM relatorios WHERE id = $1`,
      [id]
    );
    if (!r.rows.length) return res.status(404).json({ ok: false, erro: "Relatório não encontrado." });
    return res.json({ ok: true, relatorio: r.rows[0] });
  } catch (err) {
    return res.status(500).json({ ok: false, erro: err.message });
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
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, erro: "Arquivo não enviado" });
    }

    const resultado = processarFechamento(req.file.buffer);

    res.json({
      ok: true,
      data: resultado
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      ok: false,
      erro: err.message
    });
  }
});

app.post("/fechamentos/compilar", authMiddleware, upload.array("files", 20), (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) {
      return res.status(400).json({ ok: false, erro: "Arquivo não enviado" });
    }

    const buffers = files.map((file) => file.buffer);
    const resultado = compilarFechamentos(buffers);

    res.json({
      ok: true,
      data: resultado
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      ok: false,
      erro: err.message
    });
  }
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
