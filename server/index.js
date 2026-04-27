require("dotenv").config();

const express = require("express");
const bcrypt = require("bcrypt");
const cors = require("cors");
const multer = require("multer");
const XLSX = require("xlsx");
const jwt = require("jsonwebtoken");
const path = require("path");
const fs = require("fs");
const archiver = require("archiver");
const crypto = require("crypto");
const pool = require("./config/database");
const { processarFechamento, compilarFechamentos } = require("./utils/fechamento/process");
const { getValidMlTokenByCliente, mlFetch } = require("./utils/mlClient");
const { startTokenRefreshWorker } = require("./utils/tokenRefreshWorker");
const { authMiddleware, requireAdmin } = require("./middlewares/authMiddleware");
const authRoutes = require("./routes/authRoutes");
const logsRoutes = require("./routes/logsRoutes");
const { registrarLog, extrairIp, dadosUsuarioDeReq } = require("./services/activityLogService");

const app = express();
const PORT = process.env.PORT || 3333;
const JWT_SECRET = process.env.JWT_SECRET || "venforce_secret_local";
const ML_CLIENT_ID     = process.env.ML_CLIENT_ID     || "";
const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET || "";
const ML_REDIRECT_URI  = process.env.ML_REDIRECT_URI  || "https://venforce-server.onrender.com/callback";

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

function numeroSeguro(valor) {
  if (valor === null || valor === undefined || valor === "") return 0;
  if (typeof valor === "number") return Number.isFinite(valor) ? valor : 0;
  let texto = String(valor).trim().replace(/\s/g, "").replace("%", "");
  if (!texto) return 0;
  if (texto.includes(",") && texto.includes(".")) { texto = texto.replace(/\./g, "").replace(",", "."); }
  else if (texto.includes(",")) { texto = texto.replace(",", "."); }
  const n = Number(texto);
  return Number.isFinite(n) ? n : 0;
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

  const resultado = [];
  for (const row of rows) {
    // Normaliza chaves: remove espaços e BOM invisíveis
    const r = {};
    for (const [k, v] of Object.entries(row)) {
      r[k.trim().replace(/^\uFEFF/, "")] = v;
    }

    const id = String(obterValorColuna(r, ["id", "ID", "Id", "sku", "SKU", "Sku"])).trim();
    if (!id) continue;

    resultado.push({
      produto_id: id,
      custo_produto: numeroSeguro(obterValorColuna(r, ["Custo", "custo_produto", "CUSTO_PRODUTO", "custo", "CUSTO", "Custo Produto"])),
      imposto_percentual: numeroSeguro(obterValorColuna(r, ["Imposto", "imposto_percentual", "IMPOSTO_PERCENTUAL", "imposto", "IMPOSTO", "Imposto Percentual"])),
      taxa_fixa: numeroSeguro(obterValorColuna(r, ["Taxa", "taxa_fixa", "TAXA_FIXA", "taxa", "TAXA", "Taxa Fixa"]))
    });
  }
  if (!resultado.length) throw new Error("Nenhum ID válido encontrado na planilha");
  return resultado;
}

function gerarApiKey() {
  return "vf_" + crypto.randomBytes(32).toString("hex");
}

async function apiKeyMiddleware(req, res, next) {
  try {
    const key = req.headers["x-api-key"] || req.query.api_key;
    if (!key) return res.status(401).json({ ok: false, erro: "API Key não informada." });
    const result = await pool.query(
      "SELECT * FROM clientes WHERE api_key = $1 AND ativo = true",
      [key]
    );
    if (!result.rows.length) {
      return res.status(401).json({ ok: false, erro: "API Key inválida ou inativa." });
    }
    req.cliente = result.rows[0];
    next();
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
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
    
    res.json({ ok: true, mensagem: "Tabelas criadas com sucesso" });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.use("/auth", authRoutes);
app.use("/admin/logs", logsRoutes);

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

// AUTOMAÇÕES (somente leitura) — Preview de precificação por cliente + base
app.get("/automacoes/precificacao/preview", authMiddleware, requireAdmin, async (req, res) => {
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
app.get("/automacoes/precificacao/preview-ml", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const clienteSlugRaw = String(req.query.clienteSlug || "").trim();
    const baseSlugRaw = String(req.query.baseSlug || "").trim();
    const pageRaw = req.query.page;
    const limitRaw = req.query.limit;

    if (!clienteSlugRaw) return res.status(400).json({ ok: false, erro: "clienteSlug é obrigatório" });
    if (!baseSlugRaw) return res.status(400).json({ ok: false, erro: "baseSlug é obrigatório" });

    const clienteSlug = normalizarSlug(clienteSlugRaw);
    const baseSlug = normalizarSlug(baseSlugRaw);

    const page = Math.max(1, parseInt(pageRaw) || 1);
    const limit = Math.min(Math.max(1, parseInt(limitRaw) || 20), 50);
    const offset = (page - 1) * limit;

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

    const linhas = details.map((entry) => {
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

      // Por segurança nesta etapa:
      // - comissão e frete podem depender de regras dinâmicas (categoria, listing_type, shipping/logistic_type, etc.)
      // - existem endpoints read-only no ML, mas sem garantia de completude/estabilidade aqui, preferimos retornar null.
      const comissaoMarketplace = null;
      const frete = null;

      // Lucro/margem: só calculamos se TODOS os componentes necessários estiverem disponíveis com segurança
      // (nesta etapa, comissão e frete ficam null; portanto lucro/margem também ficam null).
      const lucroContribuicaoPreview = null;
      const margemContribuicaoPreview = null;

      if (!baseRow) observacoes.push("Sem correspondência na base (produto_id não encontrado).");
      if (comissaoMarketplace === null) observacoes.push("comissaoMarketplace=null (não obtida nesta etapa por segurança/read-only).");
      if (frete === null) observacoes.push("frete=null (não obtido nesta etapa por segurança/read-only).");
      if (lucroContribuicaoPreview === null || margemContribuicaoPreview === null) {
        observacoes.push("lucro/margem=null (depende de comissão/frete; mantido nulo por segurança).");
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
        comissaoMarketplace,
        frete,
        lucroContribuicaoPreview,
        margemContribuicaoPreview,
        temBase: Boolean(baseRow),
        observacoes,
      };
    });

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
        camposNullPorSeguranca: ["comissaoMarketplace", "frete", "lucroContribuicaoPreview", "margemContribuicaoPreview"],
      },
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

// ==========================
// ML — ROTAS DE INTEGRAÇÃO
// ==========================

// Testa conexão e retorna dados do usuário ML
app.get("/ml/teste/:clienteId", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const clienteId = parseInt(req.params.clienteId);
    if (!clienteId) return res.status(400).json({ ok: false, erro: "clienteId inválido." });

    const { ok, status, data } = await mlFetch(clienteId, "/users/me");

    if (!ok) {
      return res.status(status).json({ ok: false, erro: data?.message || "Erro ao chamar ML.", status, data });
    }

    res.json({ ok: true, status, usuario: data });
  } catch (err) {
    console.error("[GET /ml/teste] erro:", err.message);
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Busca anúncios ativos do cliente no ML (até 20 por vez, com suporte a offset)
app.get("/ml/items/:clienteId", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const clienteId = parseInt(req.params.clienteId);
    if (!clienteId) return res.status(400).json({ ok: false, erro: "clienteId inválido." });

    // Passo 1: buscar o ml_user_id do cliente no banco
    const tokenRow = await pool.query(
      "SELECT ml_user_id FROM ml_tokens WHERE cliente_id = $1",
      [clienteId]
    );
    if (!tokenRow.rows.length) {
      return res.status(404).json({ ok: false, erro: "Cliente sem conta ML vinculada." });
    }
    const mlUserId = tokenRow.rows[0].ml_user_id;

    // Passo 2: buscar itens ativos
    const offset = parseInt(req.query.offset) || 0;
    const limit  = Math.min(parseInt(req.query.limit) || 20, 50);

    const { ok, status, data } = await mlFetch(
      clienteId,
      `/users/${mlUserId}/items/search?status=active&offset=${offset}&limit=${limit}`
    );

    if (!ok) {
      return res.status(status).json({ ok: false, erro: data?.message || "Erro ao buscar itens.", status, data });
    }

    res.json({
      ok: true,
      total: data?.paging?.total ?? 0,
      offset: data?.paging?.offset ?? offset,
      limit:  data?.paging?.limit  ?? limit,
      items:  data?.results ?? [],
    });
  } catch (err) {
    console.error("[GET /ml/items] erro:", err.message);
    res.status(500).json({ ok: false, erro: err.message });
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
// ==========================
// ML — INICIAR AUTORIZAÇÃO
// ==========================
app.get("/ml/conectar", (req, res) => {
  res.status(410).send(
    `<html><body style="font-family:sans-serif;padding:2rem;max-width:520px;margin:0 auto;">
      <h2>410 Gone</h2>
      <p>Use <code>GET /ml/conectar/:clienteSlug</code> com o slug do cliente para iniciar a autorização Mercado Livre.</p>
    </body></html>`
  );
});

app.get("/ml/conectar/:clienteSlug", async (req, res) => {
  try {
    if (!ML_CLIENT_ID) return res.status(500).send("ML_CLIENT_ID não configurado.");
    const slug = normalizarSlug(req.params.clienteSlug);
    const result = await pool.query(
      "SELECT id, slug, nome FROM clientes WHERE slug = $1 AND ativo = true",
      [slug]
    );
    const cliente = result.rows[0];
    if (!cliente) {
      return res.status(404).send("Cliente não encontrado.");
    }

    const state = jwt.sign(
      {
        clienteId: cliente.id,
        clienteSlug: cliente.slug,
        nonce: crypto.randomBytes(16).toString("hex")
      },
      JWT_SECRET,
      { expiresIn: "10m" }
    );

    const url = new URL("https://auth.mercadolivre.com.br/authorization");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", ML_CLIENT_ID);
    url.searchParams.set("redirect_uri", ML_REDIRECT_URI);
    url.searchParams.set("state", state);

    res.redirect(url.toString());
  } catch (err) {
    console.error("[ML conectar] erro:", err);
    res.status(500).send("Erro interno: " + err.message);
  }
});

// ==========================
// ML — CALLBACK
// ==========================
app.get("/callback", async (req, res) => {
  const { code, error, error_description, state } = req.query;

  if (!state || String(state).trim() === "") {
    return res.status(400).send(
      `<html><body style="font-family:sans-serif;padding:2rem;"><h2>Erro</h2><p>state ausente</p></body></html>`
    );
  }

  let decoded;
  try {
    decoded = jwt.verify(String(state), JWT_SECRET);
  } catch (e) {
    return res.status(400).send(
      `<html><body style="font-family:sans-serif;padding:2rem;"><h2>Erro</h2><p>state inválido ou expirado</p></body></html>`
    );
  }

  try {
    const clienteRes = await pool.query(
      "SELECT * FROM clientes WHERE id = $1 AND ativo = true",
      [decoded.clienteId]
    );
    const cliente = clienteRes.rows[0];
    if (!cliente) {
      return res.status(400).send(
        `<html><body style="font-family:sans-serif;padding:2rem;"><h2>Erro</h2><p>Cliente inválido ou inativo.</p></body></html>`
      );
    }

    if (error) {
      return res.status(400).send(`
        <html><body style="font-family:sans-serif;text-align:center;padding:3rem;background:#f8f9fc;">
          <h2>❌ Autorização negada</h2>
          <p style="color:#6b7280;">${error_description || error}</p>
        </body></html>`);
    }

    if (!code) {
      return res.status(400).send(
        `<html><body style="font-family:sans-serif;padding:2rem;"><h2>Erro</h2><p>Parâmetro 'code' não recebido.</p></body></html>`
      );
    }

    const tokenRes = await fetch("https://api.mercadolibre.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: ML_CLIENT_ID,
        client_secret: ML_CLIENT_SECRET,
        code,
        redirect_uri: ML_REDIRECT_URI
      })
    });

    const data = await tokenRes.json();
    console.log("[ML callback] resposta:", JSON.stringify(data));

    if (!tokenRes.ok) {
      return res.status(502).send(`
        <html><body style="font-family:sans-serif;text-align:center;padding:3rem;background:#f8f9fc;">
          <h2>❌ Erro ao obter token</h2>
          <p style="color:#6b7280;">${data?.message || JSON.stringify(data)}</p>
        </body></html>`);
    }

    const { access_token, refresh_token, user_id: mlUserId, expires_in } = data;
    const expiresAt = new Date(Date.now() + (expires_in || 0) * 1000);

    await pool.query(
      `INSERT INTO ml_tokens (cliente_id, ml_user_id, access_token, refresh_token, expires_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (cliente_id, ml_user_id) DO UPDATE SET
         access_token = EXCLUDED.access_token,
         refresh_token = EXCLUDED.refresh_token,
         expires_at = EXCLUDED.expires_at,
         updated_at = NOW()`,
      [cliente.id, String(mlUserId), access_token, refresh_token, expiresAt]
    );
    registrarLog({
      userId: null,
      userEmail: null,
      userNome: null,
      acao: "admin.ml.conectar",
      detalhes: { cliente_slug: cliente.slug, cliente_nome: cliente.nome, ml_user_id: String(mlUserId) },
      ip: extrairIp(req),
      status: "sucesso"
    });

    console.log(`[ML callback] ✓ token salvo — cliente: ${cliente.nome} ml_user_id: ${mlUserId}`);

    return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:3rem;background:#f8f9fc;">
        <div style="max-width:420px;margin:0 auto;background:#fff;border-radius:16px;padding:2.5rem;box-shadow:0 4px 24px rgba(0,0,0,.08);">
          <div style="font-size:2.5rem;margin-bottom:1rem;">✅</div>
          <h2 style="margin:0 0 .5rem;color:#2d2d2d;">Conta conectada!</h2>
          <p style="color:#6b7280;margin:0 0 1rem;"><strong>${cliente.nome}</strong></p>
          <p style="font-family:monospace;font-size:.8rem;color:#9ca3af;background:#f8f9fc;padding:.75rem;border-radius:8px;">
            ML User ID: ${mlUserId}<br>
            Expira em: ${expiresAt.toLocaleString("pt-BR")}
          </p>
        </div>
      </body></html>`);
  } catch (err) {
    console.error("[ML callback] erro:", err);
    return res.status(500).send("Erro interno: " + err.message);
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

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function normalizeKey(value) {
  return normalizeText(value).replace(/\s+/g, " ");
}

function normalizeId(value) {
  if (value === null || value === undefined) return "";

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "";
    return Math.trunc(value).toString();
  }

  let text = String(value).trim();
  if (!text) return "";

  const scientificLike = text.replace(",", ".");
  if (/^\d+(\.\d+)?e\+\d+$/i.test(scientificLike)) {
    const num = Number(scientificLike);
    if (Number.isFinite(num)) {
      return Math.trunc(num).toString();
    }
  }

  const cleaned = text.replace(/^MLB/i, "").replace(/\D/g, "");
  return cleaned ? `MLB${cleaned}` : "";
}

function normalizeIdNoPrefix(value) {
  const full = normalizeId(value);
  return full.replace(/^MLB/i, "");
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return 0;

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  let text = String(value).trim();
  if (!text) return 0;

  text = text
    .replace(/\s+/g, "")
    .replace(/R\$/gi, "")
    .replace(/US\$/gi, "")
    .replace(/€/g, "")
    .replace(/%/g, "")
    .replace(/[^\d,.-]/g, "");

  if (!text) return 0;

  const hasComma = text.includes(",");
  const hasDot = text.includes(".");

  if (hasComma && hasDot) {
    const lastComma = text.lastIndexOf(",");
    const lastDot = text.lastIndexOf(".");

    if (lastComma > lastDot) {
      text = text.replace(/\./g, "").replace(",", ".");
    } else {
      text = text.replace(/,/g, "");
    }
  } else if (hasComma) {
    text = text.replace(/\./g, "").replace(",", ".");
  }

  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function positive(value) {
  return Math.abs(toNumber(value));
}

function round2(value) {
  return Number((Number.isFinite(value) ? value : 0).toFixed(2));
}

function readSheetRows(fileBuffer) {
  const workbook = XLSX.read(fileBuffer, { type: "buffer", cellStyles: true });
  const firstSheetName = workbook.SheetNames[0];

  if (!firstSheetName) {
    throw new Error("A planilha enviada está vazia.");
  }

  const sheet = workbook.Sheets[firstSheetName];

  const rowsAsArrays = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: "",
    raw: false,
  });

  return { workbook, sheet, rowsAsArrays };
}

function parseSpreadsheet(fileBuffer, skipRows = 0) {
  const { sheet } = readSheetRows(fileBuffer);

  return XLSX.utils.sheet_to_json(sheet, {
    defval: "",
    raw: false,
    range: skipRows,
  });
}

function detectMeliHeaderRow(fileBuffer) {
  const { rowsAsArrays } = readSheetRows(fileBuffer);

  for (let i = 0; i < rowsAsArrays.length; i++) {
    const joined = (rowsAsArrays[i] || [])
      .map((cell) => normalizeText(cell))
      .join(" | ");

    if (
      joined.includes("n.º de venda") ||
      joined.includes("n.o de venda") ||
      joined.includes("nº de venda") ||
      joined.includes("# de anuncio") ||
      joined.includes("# de anúncio") ||
      joined.includes("receita por produtos") ||
      joined.includes("tarifa de venda e impostos")
    ) {
      return i;
    }
  }

  return 5;
}

function detectShopeeHeaderRow(fileBuffer) {
  const { rowsAsArrays } = readSheetRows(fileBuffer);

  for (let i = 0; i < rowsAsArrays.length; i++) {
    const joined = (rowsAsArrays[i] || [])
      .map((cell) => normalizeText(cell))
      .join(" | ");

    if (
      joined.includes("id do item") ||
      joined.includes("item id") ||
      joined.includes("id da variacao") ||
      joined.includes("id da variação") ||
      joined.includes("vendas (pedido pago)") ||
      joined.includes("unidades (pedido pago)")
    ) {
      return i;
    }
  }

  return 0;
}

function findField(row, candidates) {
  const entries = Object.entries(row);

  for (const [key, value] of entries) {
    const normalized = normalizeKey(key);

    for (const candidate of candidates) {
      if (normalized === candidate) return value;
    }
  }

  for (const [key, value] of entries) {
    const normalized = normalizeKey(key);

    for (const candidate of candidates) {
      if (normalized.includes(candidate)) return value;
    }
  }

  return "";
}

function parseCostRows(rows) {
  const parsed = [];

  for (const row of rows) {
    const idRaw = findField(row, [
      "id",
      "id do item",
      "id do produto",
      "id da variacao",
      "id da variação",
      "product id",
      "item id",
      "variation id",
      "sku",
      "seller sku",
      "sku do vendedor",
      "codigo",
      "código",
      "codigo do produto",
      "codigo do item",
      "# do anuncio",
      "# do anúncio",
      "# de anuncio",
      "# de anúncio",
    ]);

    const id = normalizeIdNoPrefix(idRaw);

    if (!id) continue;

    const cost = toNumber(
      findField(row, [
        "preco custo",
        "preço custo",
        "custo",
        "custo produto",
        "custo do produto",
        "custo unitario",
        "custo unitário",
        "product cost",
      ])
    );

    let taxPercent = toNumber(
      findField(row, [
        "imposto",
        "imposto percentual",
        "percentual imposto",
        "aliquota",
        "alíquota",
        "taxa imposto",
        "tax percent",
        "taxa",
      ])
    );

    if (taxPercent > 0 && taxPercent <= 1) {
      taxPercent = taxPercent * 100;
    }

    const modelIdRaw = findField(row, [
      "model_id",
      "modelid",
      "model id",
      "id modelo",
      "modelo",
    ]);
    const modelId = normalizeIdNoPrefix(modelIdRaw);

    parsed.push({
      id,
      modelId,
      cost,
      taxPercent,
    });
  }

  return parsed;
}

/* ========================= SHOPEE ========================= */

function getShopeeFeesByTicket(avgTicket) {
  if (avgTicket <= 79.99) return { commissionPercent: 20, fixedFeePerUnit: 4 };
  if (avgTicket <= 99.99) return { commissionPercent: 14, fixedFeePerUnit: 16 };
  if (avgTicket <= 199.99) return { commissionPercent: 14, fixedFeePerUnit: 20 };
  return { commissionPercent: 14, fixedFeePerUnit: 26 };
}

function parseShopeeSalesRows(rows) {
  const groups = new Map();

  for (const row of rows) {
    const itemId = normalizeIdNoPrefix(
      findField(row, ["id do item", "item id", "id do produto", "product id"])
    );

    if (!itemId) continue;

    if (!groups.has(itemId)) groups.set(itemId, []);
    groups.get(itemId).push(row);
  }

  const parsed = [];

  for (const [itemId, groupRows] of groups.entries()) {
    const variationRows = groupRows.filter((row) => {
      const variationId = normalizeIdNoPrefix(
        findField(row, ["id da variacao", "id da variação", "variation id"])
      );

      const revenue = toNumber(
        findField(row, [
          "vendas (pedido pago) (brl)",
          "Vendas (Pedido pago) (BRL)",
          "vendas (pedido pago)",
          "pedido pago (brl)",
        ])
      );

      const paidUnits = toNumber(
        findField(row, [
          "unidades (pedido pago)",
          "Unidades (Pedido pago)",
          "unidades pagas",
          "paid units",
        ])
      );

const impressionsRaw = findField(row, [
  "impressao do produto",
  "impressão do produto",
  "impressoes do produto",
  "impressões do produto",
]);

const impressions = toNumber(impressionsRaw);

const raw = String(impressionsRaw || "").trim();

const isZeroImpressions =
  impressions === 0 ||
  raw === "-" ||
  raw === "–" ||
  raw === "";

      return !!variationId && !isNaN(Number(variationId)) && isZeroImpressions;
    });

    const rowsToUse = variationRows.length > 0 ? variationRows : groupRows;

    for (const row of rowsToUse) {
      const paidRevenue = toNumber(
        findField(row, [
          "vendas (pedido pago) (brl)",
          "Vendas (Pedido pago) (BRL)",
          "vendas (pedido pago)",
          "pedido pago (brl)",
        ])
      );

      const paidUnits = toNumber(
        findField(row, [
          "unidades (pedido pago)",
          "Unidades (Pedido pago)",
          "unidades pagas",
          "paid units",
        ])
      );

      const product = String(
        findField(row, ["produto", "nome do produto", "product name"]) || ""
      ).trim();

      const variationId = normalizeIdNoPrefix(
        findField(row, ["id da variacao", "id da variação", "variation id"])
      );

      const variationStatus = normalizeText(
        findField(row, ["status atual da variacao", "status atual da variação"])
      );

      const saleModelId = normalizeIdNoPrefix(
        findField(row, ["model id", "model_id", "modelid"])
      );

      const isVariation = variationRows.length > 0;
      const id = isVariation ? variationId : itemId;

      console.log("[DEBUG parseShopeeSalesRows] id:", id, "paidRevenue:", paidRevenue, "paidUnits:", paidUnits);

      if (!id || paidRevenue <= 0 || paidUnits <= 0) continue;

      parsed.push({
        id,
        product,
        itemId,
        variationId,
        saleModelId,
        paidRevenue,
        paidUnits,
        isVariation,
        variationStatus,
      });
    }
  }

  return parsed;
}

function calculateShopeeItem(sale, costRow) {
  const averageTicket =
    sale.paidUnits > 0 ? sale.paidRevenue / sale.paidUnits : 0;

  if (averageTicket <= 0) {
    return {
      id: sale.id,
      product: sale.product,
      paidRevenue: sale.paidRevenue,
      paidUnits: sale.paidUnits,
      contributionProfit: 0,
      contributionMargin: 0,
      averageTicket: 0,
      contributionProfitUnit: 0,
      cost: costRow.cost,
      taxPercent: costRow.taxPercent,
      commissionPercent: 0,
      fixedFeePerUnit: 0,
    };
  }

  const shopeeFees = getShopeeFeesByTicket(averageTicket);

  const commissionValueUnit =
    averageTicket * (shopeeFees.commissionPercent / 100);

  const fixedFeeUnit = shopeeFees.fixedFeePerUnit;
  const taxUnit = averageTicket * (costRow.taxPercent / 100);
  const costUnit = costRow.cost;

  const contributionProfitUnit =
    averageTicket - commissionValueUnit - fixedFeeUnit - costUnit - taxUnit;

  const contributionMargin =
    averageTicket > 0 ? contributionProfitUnit / averageTicket : 0;

  const contributionProfit = contributionProfitUnit * sale.paidUnits;

  return {
    id: sale.id,
    product: sale.product,
    paidRevenue: sale.paidRevenue,
    paidUnits: sale.paidUnits,
    contributionProfit,
    contributionMargin,
    averageTicket,
    contributionProfitUnit,
    cost: costRow.cost,
    taxPercent: costRow.taxPercent,
    commissionPercent: shopeeFees.commissionPercent,
    fixedFeePerUnit: shopeeFees.fixedFeePerUnit,
  };
}

function processShopee(salesRowsRaw, costRowsRaw, ads, venforce, affiliates) {
  const salesRows = parseShopeeSalesRows(salesRowsRaw);
  const costRows = parseCostRows(costRowsRaw);

  if (!salesRows.length) {
    const detectedColumns =
      salesRowsRaw.length > 0 ? Object.keys(salesRowsRaw[0]) : [];

    throw new Error(
      `Não consegui identificar linhas válidas na planilha Shopee. Colunas detectadas: ${detectedColumns.join(", ")}`
    );
  }

  if (!costRows.length) {
    throw new Error("Não consegui identificar linhas válidas na planilha de custos.");
  }

  const costMap = new Map();
  for (const row of costRows) {
    if (!row.id) continue;
    costMap.set(row.id, row);
    if (row.modelId) costMap.set(row.modelId, row);
  }

  const unmatchedIdsSet = new Set();
  const excludedVariationIdsSet = new Set();
  const validItems = [];
  const detailedRows = [];

  let ignoredRevenue = 0;

  for (const sale of salesRows) {
    if (sale.isVariation && sale.variationStatus === "excluido") {
      excludedVariationIdsSet.add(sale.id);
    }

    const costRow =
      (sale.saleModelId && costMap.get(sale.saleModelId)) ||
      costMap.get(sale.id) ||
      costMap.get(sale.itemId);

    if (!costRow || costRow.cost <= 0) {
      unmatchedIdsSet.add(sale.id);
      ignoredRevenue += sale.paidRevenue;
      continue;
    }

    const calculated = calculateShopeeItem(sale, costRow);
    validItems.push(calculated);

    detailedRows.push({
      Marketplace: "Shopee",
      Produto: calculated.product,
      ID: calculated.id,
      "Vendas (Pedido pago) (BRL)": Number(calculated.paidRevenue.toFixed(2)),
      "Unidades (Pedido pago)": Number(calculated.paidUnits.toFixed(0)),
      Ticket: Number(calculated.averageTicket.toFixed(2)),
      Custo: Number(calculated.cost.toFixed(2)),
      Imposto: Number(calculated.taxPercent.toFixed(2)),
      "Comissão %": Number(calculated.commissionPercent.toFixed(2)),
      "Taxa Fixa": Number(calculated.fixedFeePerUnit.toFixed(2)),
      LC: Number(calculated.contributionProfitUnit.toFixed(2)),
      MC: Number((calculated.contributionMargin * 100).toFixed(2)),
      "LC POR ANÚNCIO": Number(calculated.contributionProfit.toFixed(2)),
    });
  }

  const paidRevenueTotal = validItems.reduce((acc, item) => acc + item.paidRevenue, 0);
  const contributionProfitTotal = validItems.reduce(
    (acc, item) => acc + item.contributionProfit,
    0
  );

  const averageContributionMargin =
    paidRevenueTotal > 0 ? contributionProfitTotal / paidRevenueTotal : 0;

  const tacos = paidRevenueTotal > 0 ? ads / paidRevenueTotal : 0;
  const tacox = paidRevenueTotal > 0 ? (ads + venforce) / paidRevenueTotal : 0;
  const finalResult = contributionProfitTotal - ads - venforce - affiliates;

  return {
    summary: {
      grossRevenueTotal: paidRevenueTotal,
      refundsTotal: 0,
      cancelledRevenue: 0,
      paidRevenueTotal,
      contributionProfitTotal,
      averageContributionMargin,
      finalResult,
      tacos,
      tacox,
    },
    detailedRows,
    excelFileName: "fechamento-shopee.xlsx",
    unmatchedIds: Array.from(unmatchedIdsSet),
    excludedVariationIds: Array.from(excludedVariationIdsSet),
    ignoredRowsWithoutCost: unmatchedIdsSet.size,
    ignoredRevenue,
    message:
      unmatchedIdsSet.size > 0
        ? "Alguns IDs não possuem custo cadastrado e foram removidos do cálculo."
        : "Processamento concluído com sucesso.",
  };
}

/* ========================= MELI ========================= */

function parseMeliRows(rows) {
  return rows.map((row, index) => {
    const saleNumber = String(
      findField(row, [
        "n.º de venda",
        "n.o de venda",
        "nª de venda",
        "nº de venda",
        "n° de venda",
        "numero de venda",
        "no de venda",
      ]) ?? ""
    ).trim();

    const saleDate = String(
      findField(row, ["data da venda"]) ?? ""
    ).trim();

    const adIdRaw = String(
      findField(row, [
        "# de anúncio",
        "# de anuncio",
        "# do anúncio",
        "# do anuncio",
      ]) ?? ""
    ).trim();

    return {
      rowIndex: index,
      saleNumber,
      saleDate,
      units: toNumber(findField(row, ["unidades"])),
      total: toNumber(findField(row, ["total (brl)", "total"])),
      productRevenue: toNumber(
        findField(row, [
          "receita por produtos (brl)",
          "receita por produtos",
        ])
      ),
      cancelRefund: toNumber(
        findField(row, [
          "cancelamentos e reembolsos (brl)",
          "cancelamentos e reembolsos",
        ])
      ),
      adIdRaw,
      adId: normalizeId(adIdRaw),
      title: String(
        findField(row, [
          "título do anúncio",
          "titulo do anuncio",
          "título",
          "titulo",
        ]) ?? ""
      ).trim(),
      unitSalePrice: toNumber(
        findField(row, [
          "preço unitário de venda do anúncio (brl)",
          "preco unitario de venda do anuncio (brl)",
          "preço unitário de venda do anúncio",
          "preco unitario de venda do anuncio",
        ])
      ),
      modelIdRaw: String(
        findField(row, ["model id", "model_id", "modelid"]) ?? ""
      ).trim(),
    };
  });
}

function parseMeliCostRows(rows) {
  const parsed = [];

  for (const row of rows) {
    const idRaw = findField(row, [
      "# de anúncio",
      "# de anuncio",
      "# do anúncio",
      "# do anuncio",
      "id do anúncio",
      "id do anuncio",
      "anúncio",
      "anuncio",
      "mlb",
      "id",
    ]);

    const normalizedId = normalizeId(idRaw);
    if (!normalizedId) continue;

    const cost = toNumber(
      findField(row, [
        "preço de custo",
        "preco de custo",
        "preço custo",
        "preco custo",
        "custo",
        "custo do produto",
        "custo produto",
        "custo unitário",
        "custo unitario",
      ])
    );

    let taxPercent = toNumber(
      findField(row, [
        "imposto",
        "imposto %",
        "imposto percentual",
        "percentual imposto",
        "aliquota",
        "alíquota",
      ])
    );

    if (taxPercent > 0 && taxPercent <= 1) {
      taxPercent = taxPercent * 100;
    }

    const modelIdRaw = findField(row, [
      "model_id",
      "modelid",
      "model id",
      "id modelo",
      "modelo",
    ]);
    const modelId = String(modelIdRaw ?? "").trim();

    parsed.push({
      id: normalizedId,
      modelId,
      cost: round2(cost),
      taxPercent: round2(taxPercent),
    });
  }

  return parsed;
}

function buildMeliCostMap(rows) {
  const parsed = parseMeliCostRows(rows);
  const map = new Map();

  for (const row of parsed) {
    if (!row.id) continue;

    if (!map.has(row.id)) {
      map.set(row.id, row);
    }

    const noPrefix = row.id.replace(/^MLB/i, "");
    if (noPrefix && !map.has(noPrefix)) {
      map.set(noPrefix, row);
    }

    if (row.modelId) {
      const mNorm = normalizeId(row.modelId);
      if (mNorm) {
        if (!map.has(mNorm)) map.set(mNorm, row);
        const mNoPrefix = mNorm.replace(/^MLB/i, "");
        if (mNoPrefix && !map.has(mNoPrefix)) map.set(mNoPrefix, row);
        if (mNoPrefix && !map.has(`MLB${mNoPrefix}`)) map.set(`MLB${mNoPrefix}`, row);
      }
    }
  }

  return map;
}

function allocateByUnits(totalValue, componentRows) {
  const totalUnits = componentRows.reduce((acc, row) => acc + row.units, 0);

  if (totalUnits <= 0 || componentRows.length === 0) {
    return componentRows.map(() => 0);
  }

  const allocations = [];
  let accumulated = 0;

  for (let i = 0; i < componentRows.length; i++) {
    const row = componentRows[i];

    if (i === componentRows.length - 1) {
      allocations.push(round2(totalValue - accumulated));
      continue;
    }

    const value = round2((totalValue / totalUnits) * row.units);
    allocations.push(value);
    accumulated += value;
  }

  return allocations;
}

function buildMeliBaseSheetRows(finalRows) {
  const aoa = [];

  aoa.push([
    "# de anúncio",
    "Título do anúncio",
    "Unidades",
    "Preço unitário de venda do anúncio (BRL)",
    "Venda Total",
    "Total (BRL)",
    "Imposto",
    "Preço de custo",
    "Preço de custo total",
    "LC",
    "MC",
  ]);

  for (const row of finalRows) {
    aoa.push([
      row["# de anúncio"],
      row["Título do anúncio"],
      row.Unidades,
      row["Preço unitário de venda do anúncio (BRL)"],
      row["Venda Total"],
      row["Total (BRL)"],
      row["Imposto"] / 100,
      row["Preço de custo"],
      row["Preço de custo total"],
      row.LC,
      row.MC / 100,
    ]);
  }

  const sheet = XLSX.utils.aoa_to_sheet(aoa);

  for (let rowIndex = 2; rowIndex <= finalRows.length + 1; rowIndex++) {
    const d = `D${rowIndex}`;
    const e = `E${rowIndex}`;
    const f = `F${rowIndex}`;
    const g = `G${rowIndex}`;
    const h = `H${rowIndex}`;
    const i = `I${rowIndex}`;
    const j = `J${rowIndex}`;
    const k = `K${rowIndex}`;

    if (sheet[d]) sheet[d].z = "R$ #,##0.00";
    if (sheet[e]) sheet[e].z = "R$ #,##0.00";
    if (sheet[f]) sheet[f].z = "R$ #,##0.00";
    if (sheet[g]) sheet[g].z = "0.00%";
    if (sheet[h]) sheet[h].z = "R$ #,##0.00";
    if (sheet[i]) sheet[i].z = "R$ #,##0.00";
    if (sheet[j]) sheet[j].z = "R$ #,##0.00";
    if (sheet[k]) sheet[k].z = "0.00%";
  }

  sheet["!cols"] = [
    { wch: 16 },
    { wch: 55 },
    { wch: 10 },
    { wch: 24 },
    { wch: 16 },
    { wch: 16 },
    { wch: 10 },
    { wch: 14 },
    { wch: 18 },
    { wch: 14 },
    { wch: 10 },
  ];

  sheet["!autofilter"] = { ref: "A1:K1" };

  return sheet;
}

function processMeli(salesRowsRaw, costRowsRaw, ads, venforce, affiliates) {
  const salesRows = parseMeliRows(salesRowsRaw);
  const costMap = buildMeliCostMap(costRowsRaw);

  const finalRows = [];
  const unmatchedIds = new Set();
  const consumedIndexes = new Set();
  let ignoredRevenue = 0;

  const refundsTotal = round2(
    salesRows.reduce((sum, row) => sum + row.cancelRefund, 0)
  );

  function isMainRow(row) {
    return !row.adId && Math.abs(row.productRevenue) > 0;
  }

  function isItemRow(row) {
    return !!row.adId && row.units > 0;
  }

  function getCostForAd(adId) {
    const normalized = normalizeId(adId);
    const noPrefix = normalized.replace(/^MLB/i, "");

    return (
      costMap.get(normalized) ||
      costMap.get(noPrefix) ||
      costMap.get(`MLB${noPrefix}`) ||
      null
    );
  }

  function pushCalculatedRow(item, totalRateado) {
    const id = normalizeId(item.adId || item.adIdRaw);
    let cost = item.modelIdRaw ? getCostForAd(item.modelIdRaw) : null;
    if (!cost) cost = getCostForAd(id);

    if (!cost || cost.cost <= 0) {
      unmatchedIds.add(id || item.adIdRaw || "SEM_ID");
      ignoredRevenue += round2(totalRateado);
      return;
    }

    const units = round2(item.units);
    const price = round2(item.unitSalePrice);
    const vendaTotal = round2(units * price);

    const impostoPercent = round2(cost.taxPercent || 0);
    const impostoDec = impostoPercent > 1 ? impostoPercent / 100 : impostoPercent;

    const precoCusto = round2(cost.cost || 0);
    const precoCustoTotal = round2(units * precoCusto);

    const totalFormatado = round2(totalRateado);

    let lc = 0;
    let mc = 0;
    
    if (totalFormatado < 0) {
      lc = round2(totalFormatado);
      mc = vendaTotal > 0 ? round2((lc / vendaTotal) * 100) : 0;
    } else if (totalFormatado > 0) {
      lc = round2(
        vendaTotal -
          (vendaTotal * impostoDec) -
          (vendaTotal - totalFormatado) -
          precoCustoTotal
      );
    
      mc = vendaTotal > 0 ? round2((lc / vendaTotal) * 100) : 0;
    } else {
      lc = 0;
      mc = 0;
    }

    finalRows.push({
      "# de anúncio": id,
      "Título do anúncio": item.title,
      Unidades: units,
      "Preço unitário de venda do anúncio (BRL)": price,
      "Venda Total": vendaTotal,
      "Total (BRL)": totalFormatado,
      Imposto: impostoPercent,
      "Preço de custo": precoCusto,
      "Preço de custo total": precoCustoTotal,
      LC: lc,
      MC: mc,
    });
  }

  for (let i = 0; i < salesRows.length; i++) {
    if (consumedIndexes.has(i)) continue;

    const current = salesRows[i];

    if (isMainRow(current)) {
      const children = [];
      const childrenIndexes = [];
      let j = i + 1;

      while (j < salesRows.length) {
        const next = salesRows[j];

        if (isMainRow(next)) break;
        if (next.saleDate !== current.saleDate) break;
        if (!isItemRow(next)) break;

        children.push(next);
        childrenIndexes.push(j);
        j++;
      }

      if (children.length > 0) {
        const totalRateado = allocateByUnits(current.total, children);

        for (let k = 0; k < children.length; k++) {
          pushCalculatedRow(children[k], totalRateado[k]);
          consumedIndexes.add(childrenIndexes[k]);
        }

        consumedIndexes.add(i);
        continue;
      }

      consumedIndexes.add(i);
      continue;
    }

    if (isItemRow(current)) {
      pushCalculatedRow(current, current.total);
      consumedIndexes.add(i);
    }
  }

  const grossRevenueTotal = round2(
    finalRows.reduce((sum, row) => sum + Number(row["Venda Total"] || 0), 0)
  );

  const paidRevenueTotal = round2(
    finalRows.reduce((sum, row) => sum + Number(row["Total (BRL)"] || 0), 0)
  );

  const contributionProfitTotal = round2(
    finalRows.reduce((sum, row) => sum + Number(row["LC"] || 0), 0)
  );

  const averageContributionMargin =
    grossRevenueTotal > 0 ? contributionProfitTotal / grossRevenueTotal : 0;

  const finalResult = contributionProfitTotal - ads - venforce - affiliates;
  const tacos = grossRevenueTotal > 0 ? ads / grossRevenueTotal : 0;
  const tacox =
    grossRevenueTotal > 0 ? (ads + venforce + affiliates) / grossRevenueTotal : 0;

  return {
    summary: {
      grossRevenueTotal,
      refundsTotal,
      cancelledRevenue: refundsTotal,
      paidRevenueTotal,
      contributionProfitTotal,
      averageContributionMargin,
      finalResult,
      tacos,
      tacox,
    },
    preparedRows: finalRows,
    detailedRows: finalRows,
    auditRows: [],
    excelFileName: "fechamento-meli.xlsx",
    unmatchedIds: Array.from(unmatchedIds),
    ignoredRowsWithoutCost: unmatchedIds.size,
    ignoredRevenue: round2(ignoredRevenue),
    message:
      unmatchedIds.size > 0
        ? "Alguns anúncios do MELI não possuem custo cadastrado e foram ignorados."
        : "OK",
  };
}

app.post("/fechamentos/financeiro", authMiddleware, upload.fields([{ name: "sales", maxCount: 1 }, { name: "costs", maxCount: 1 }]), (req, res) => {
  try {
    const salesFile = req.files && req.files["sales"] && req.files["sales"][0];
    const costsFile = req.files && req.files["costs"] && req.files["costs"][0];

    const marketplace = String(req.body.marketplace || "")
      .trim()
      .toLowerCase();

    const ads = toNumber(req.body.ads);
    const venforce = toNumber(req.body.venforce);
    const affiliates = toNumber(req.body.affiliates);

    if (!salesFile || !salesFile.buffer) {
      return res.status(400).json({ ok: false, error: "Arquivo de vendas não enviado." });
    }

    if (!costsFile || !costsFile.buffer) {
      return res.status(400).json({ ok: false, error: "Arquivo de custos não enviado." });
    }

    if (marketplace !== "meli" && marketplace !== "shopee") {
      return res.status(400).json({ ok: false, error: "Marketplace inválido. Envie exatamente 'meli' ou 'shopee'." });
    }

    const salesBuffer = salesFile.buffer;
    const costsBuffer = costsFile.buffer;

    const salesRowsRaw =
      marketplace === "meli"
        ? parseSpreadsheet(salesBuffer, detectMeliHeaderRow(salesBuffer))
        : parseSpreadsheet(salesBuffer, detectShopeeHeaderRow(salesBuffer));

    const costRowsRaw = parseSpreadsheet(costsBuffer);

    const result =
      marketplace === "meli"
        ? processMeli(salesRowsRaw, costRowsRaw, ads, venforce, affiliates)
        : processShopee(salesRowsRaw, costRowsRaw, ads, venforce, affiliates);

    const workbook = XLSX.utils.book_new();

    if (marketplace === "meli" && result.preparedRows && result.preparedRows.length > 0) {
      const baseSheet = buildMeliBaseSheetRows(result.preparedRows);
      XLSX.utils.book_append_sheet(workbook, baseSheet, "Base_MeLi");
    } else {
      const summaryRows = Object.entries(result.summary).map(([key, value]) => ({
        Métrica: key,
        Valor:
          typeof value === "number" ? Number(value.toFixed(6)) : String(value),
      }));

      const summarySheet = XLSX.utils.json_to_sheet(summaryRows);
      const detailSheet = XLSX.utils.json_to_sheet(result.detailedRows);

      XLSX.utils.book_append_sheet(workbook, summarySheet, "Painel");
      XLSX.utils.book_append_sheet(workbook, detailSheet, "Detalhamento");
    }

    if (result.auditRows && result.auditRows.length > 0) {
      const auditSheet = XLSX.utils.json_to_sheet(result.auditRows);
      XLSX.utils.book_append_sheet(workbook, auditSheet, "Auditoria");
    }

    const excelBuffer = XLSX.write(workbook, {
      type: "buffer",
      bookType: "xlsx",
    });

    const excelBase64 = Buffer.from(excelBuffer).toString("base64");

    res.json({
      ok: true,
      summary: result.summary,
      detailedRows: result.detailedRows,
      excelBase64,
      unmatchedIds: result.unmatchedIds,
      ignoredRowsWithoutCost: result.ignoredRowsWithoutCost,
      ignoredRevenue: result.ignoredRevenue,
      message: result.message
    });
  } catch (error) {
    console.error("Erro em /fechamentos/financeiro:", error);
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : "Erro ao processar os arquivos enviados."
    });
  }
});

// DEBUG TEMPORÁRIO — Spike de endpoints ML em anúncio real
app.get("/debug/ml-spike/:clienteSlug/:itemId", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const clienteSlug = normalizarSlug(req.params.clienteSlug);
    const itemId = String(req.params.itemId || "").trim();

    if (!clienteSlug) {
      return res.status(400).json({ ok: false, erro: "clienteSlug inválido." });
    }
    if (!itemId) {
      return res.status(400).json({ ok: false, erro: "itemId é obrigatório." });
    }

    const clienteRes = await pool.query(
      "SELECT id, nome, slug FROM clientes WHERE slug = $1",
      [clienteSlug]
    );
    if (!clienteRes.rows.length) {
      return res.status(404).json({ ok: false, erro: "Cliente não encontrado." });
    }
    const cliente = clienteRes.rows[0];

    try {
      await getValidMlTokenByCliente(cliente.id);
    } catch (tokenErr) {
      return res.status(404).json({
        ok: false,
        erro: "Cliente sem ml_token válido vinculado.",
        detalhe: tokenErr.message,
      });
    }

    function toErrorPayload(result, fallbackMessage) {
      return {
        ok: false,
        status: result?.status ?? null,
        erro:
          result?.data?.message ||
          result?.data?.error ||
          result?.data?.error_description ||
          fallbackMessage,
        data: result?.data ?? null,
      };
    }

    function findSaleFeeAmount(listingPricesData) {
      if (!listingPricesData) return null;

      const first = Array.isArray(listingPricesData)
        ? listingPricesData[0]
        : (Array.isArray(listingPricesData?.results) ? listingPricesData.results[0] : listingPricesData);

      if (!first || typeof first !== "object") return null;

      if (first.sale_fee_amount !== undefined && first.sale_fee_amount !== null) {
        return first.sale_fee_amount;
      }
      if (first?.sale_fee_details?.amount !== undefined && first?.sale_fee_details?.amount !== null) {
        return first.sale_fee_details.amount;
      }
      if (first?.sale_fee !== undefined && first?.sale_fee !== null) {
        return first.sale_fee;
      }
      return null;
    }

    function extractCostFeeFields(value, path = "root", out = []) {
      if (value === null || value === undefined) return out;

      if (Array.isArray(value)) {
        value.forEach((entry, index) => extractCostFeeFields(entry, `${path}[${index}]`, out));
        return out;
      }

      if (typeof value === "object") {
        for (const [key, nested] of Object.entries(value)) {
          const nextPath = `${path}.${key}`;
          if (/(cost|fee)/i.test(key) && (typeof nested !== "object" || nested === null)) {
            out.push({ campo: nextPath, valor: nested });
          }
          extractCostFeeFields(nested, nextPath, out);
        }
      }

      return out;
    }

    const itemPromise = mlFetch(cliente.id, `/items/${encodeURIComponent(itemId)}`);

    const listingPricesPromise = itemPromise.then(async (itemResult) => {
      if (!itemResult.ok) {
        return {
          ok: false,
          status: itemResult.status,
          data: {
            message: "Não foi possível calcular listing_prices: falha ao buscar item.",
            dependencia: "item",
            item_status: itemResult.status,
            item_data: itemResult.data ?? null,
          },
        };
      }

      const price = itemResult?.data?.price;
      const listingTypeId = itemResult?.data?.listing_type_id;
      if (price === null || price === undefined || !listingTypeId) {
        return {
          ok: false,
          status: 422,
          data: {
            message: "Item sem price e/ou listing_type_id para calcular listing_prices.",
            price: price ?? null,
            listing_type_id: listingTypeId ?? null,
          },
        };
      }

      const query = `/sites/MLB/listing_prices?price=${encodeURIComponent(price)}&listing_type_id=${encodeURIComponent(listingTypeId)}`;
      return mlFetch(cliente.id, query);
    });

    const shippingOptionsPromise = mlFetch(
      cliente.id,
      `/items/${encodeURIComponent(itemId)}/shipping_options?zip_code=01310100`
    );

    const [itemSettled, listingSettled, shippingSettled] = await Promise.allSettled([
      itemPromise,
      listingPricesPromise,
      shippingOptionsPromise,
    ]);

    const itemResult =
      itemSettled.status === "fulfilled"
        ? (itemSettled.value.ok ? itemSettled.value.data : toErrorPayload(itemSettled.value, "Erro ao buscar item"))
        : toErrorPayload(null, itemSettled.reason?.message || "Erro inesperado ao buscar item");

    const listingPricesResult =
      listingSettled.status === "fulfilled"
        ? (listingSettled.value.ok ? listingSettled.value.data : toErrorPayload(listingSettled.value, "Erro ao buscar listing_prices"))
        : toErrorPayload(null, listingSettled.reason?.message || "Erro inesperado ao buscar listing_prices");

    const shippingOptionsResult =
      shippingSettled.status === "fulfilled"
        ? (shippingSettled.value.ok ? shippingSettled.value.data : toErrorPayload(shippingSettled.value, "Erro ao buscar shipping_options"))
        : toErrorPayload(null, shippingSettled.reason?.message || "Erro inesperado ao buscar shipping_options");

    const resumo = {
      price: itemSettled.status === "fulfilled" && itemSettled.value.ok ? (itemSettled.value.data?.price ?? null) : null,
      listing_type_id:
        itemSettled.status === "fulfilled" && itemSettled.value.ok
          ? (itemSettled.value.data?.listing_type_id ?? null)
          : null,
      sale_fee_amount:
        listingSettled.status === "fulfilled" && listingSettled.value.ok
          ? findSaleFeeAmount(listingSettled.value.data)
          : null,
      shipping_costs_fees:
        shippingSettled.status === "fulfilled" && shippingSettled.value.ok
          ? extractCostFeeFields(shippingSettled.value.data)
          : [],
    };

    return res.json({
      ok: true,
      cliente: {
        id: cliente.id,
        nome: cliente.nome,
        slug: cliente.slug,
      },
      item: itemResult,
      listing_prices: listingPricesResult,
      shipping_options: shippingOptionsResult,
      resumo,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, erro: err.message });
  }
});

// ERRO GLOBAL
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ ok: false, erro: `Erro no upload: ${err.message}` });
  res.status(500).json({ ok: false, erro: "Erro interno do servidor" });
});

app.listen(PORT, () => {
  console.log(`VenForce rodando em http://localhost:${PORT}`);
  startTokenRefreshWorker();
});
