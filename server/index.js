require("dotenv").config();

const express = require("express");
const bcrypt = require("bcrypt");
const cors = require("cors");
const multer = require("multer");
const XLSX = require("xlsx");
const jwt = require("jsonwebtoken");
const path = require("path");
const crypto = require("crypto");
const pool = require("./config/database");
const { processarFechamento } = require("./utils/fechamento/process");

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

// AUTH MIDDLEWARE
async function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) return res.status(401).json({ ok: false, erro: "Token não informado" });
    const token = authHeader.slice(7);
    const decoded = jwt.verify(token, JWT_SECRET);
    const result = await pool.query("SELECT * FROM users WHERE id = $1", [decoded.id]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ ok: false, erro: "Usuário não encontrado" });
    if (!user.ativo) return res.status(403).json({ ok: false, erro: "Usuário inativo" });
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ ok: false, erro: "Token inválido ou expirado" });
  }
}

function requireAdmin(req, res, next) {
  if (req.user.role !== "admin") {
    return res.status(403).json({ ok: false, erro: "Acesso restrito a administradores." });
  }
  next();
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
    
    res.json({ ok: true, mensagem: "Tabelas criadas com sucesso" });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// REGISTER
app.post("/auth/register", async (req, res) => {
  try {
    const { email, password, nome = "" } = req.body;
    if (!email || !password) return res.status(400).json({ ok: false, erro: "Email e senha são obrigatórios" });
    const hashed = await bcrypt.hash(password, 10);
    const result = await pool.query(
      "INSERT INTO users (email, password, nome) VALUES ($1, $2, $3) RETURNING id, email, nome, ativo, role",
      [email.trim().toLowerCase(), hashed, nome.trim()]
    );
    res.status(201).json({ ok: true, user: result.rows[0] });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ ok: false, erro: "Email já cadastrado" });
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// LOGIN
app.post("/auth/login", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const senha = req.body.password || req.body.senha || "";
    if (!email || !senha) return res.status(400).json({ ok: false, erro: "Email e senha são obrigatórios" });
    const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ ok: false, erro: "Usuário não encontrado" });
    if (!user.ativo) return res.status(403).json({ ok: false, erro: "Usuário inativo" });
    const valido = await bcrypt.compare(senha, user.password);
    if (!valido) return res.status(401).json({ ok: false, erro: "Senha inválida" });
    const token = jwt.sign({ id: user.id, email: user.email, nome: user.nome, role: user.role }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ ok: true, token, user: { id: user.id, nome: user.nome, email: user.email, ativo: user.ativo, role: user.role } });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// AUTH/ME
app.get("/auth/me", authMiddleware, (req, res) => {
  const u = req.user;
  res.json({ ok: true, user: { id: u.id, nome: u.nome, email: u.email, ativo: u.ativo, role: u.role } });
});

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
    if (!acesso.rows.length) return res.status(404).json({ ok: false, erro: "Base não encontrada ou sem permissão" });
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
      await client.query(`INSERT INTO user_bases (user_id, base_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [req.user.id, baseId]);
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
    res.json({ ok: true, mensagem: "Base desabilitada com sucesso" });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// EXCLUIR BASE
app.delete("/bases/:baseId", authMiddleware, async (req, res) => {
  try {
    const param = req.params.baseId;
    // Aceita tanto ID numérico quanto slug
    const acesso = await pool.query(
      `SELECT b.id FROM bases b JOIN user_bases ub ON ub.base_id = b.id
       WHERE (b.id = $1 OR b.slug = $2) AND ub.user_id = $3`,
      [parseInt(param) || 0, normalizarSlug(param), req.user.id]
    );
    if (!acesso.rows.length) return res.status(404).json({ ok: false, erro: "Base não encontrada" });
    await pool.query("DELETE FROM bases WHERE id = $1", [acesso.rows[0].id]);
    res.json({ ok: true, mensagem: "Base excluída com sucesso" });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ADMIN USERS
app.get("/admin/users", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query("SELECT id, nome, email, ativo, role, created_at FROM users ORDER BY id ASC");
    res.json({ ok: true, users: result.rows });
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
    res.json({ ok: true, mensagem: "Cliente removido com sucesso." });
  } catch (err) {
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
    res.json({ ok: true, mensagem: "Usuário removido com sucesso." });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});
// ==========================
// ML — INICIAR AUTORIZAÇÃO
// ==========================
app.get("/ml/conectar", (req, res) => {
  if (!ML_CLIENT_ID) return res.status(500).send("ML_CLIENT_ID não configurado.");
  const url = new URL("https://auth.mercadolivre.com.br/authorization");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id",    ML_CLIENT_ID);
  url.searchParams.set("redirect_uri", ML_REDIRECT_URI);
  res.redirect(url.toString());
});

// ==========================
// ML — CALLBACK
// ==========================
app.get("/callback", async (req, res) => {
  const { code, error, error_description } = req.query;

  if (error) {
    return res.status(400).send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:3rem;background:#f8f9fc;">
        <h2>❌ Autorização negada</h2>
        <p style="color:#6b7280;">${error_description || error}</p>
      </body></html>`);
  }

  if (!code) return res.status(400).send("Parâmetro 'code' não recebido.");

  try {
    const tokenRes = await fetch("https://api.mercadolibre.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type:    "authorization_code",
        client_id:     ML_CLIENT_ID,
        client_secret: ML_CLIENT_SECRET,
        code,
        redirect_uri:  ML_REDIRECT_URI
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
    const expiresAt = new Date(Date.now() + expires_in * 1000);

    await pool.query(
      `INSERT INTO ml_tokens (ml_user_id, access_token, refresh_token, expires_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (ml_user_id) DO UPDATE SET
         access_token  = EXCLUDED.access_token,
         refresh_token = EXCLUDED.refresh_token,
         expires_at    = EXCLUDED.expires_at,
         updated_at    = NOW()`,
      [String(mlUserId), access_token, refresh_token, expiresAt]
    );

    console.log(`[ML callback] ✓ token salvo — ml_user_id: ${mlUserId}`);

    return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:3rem;background:#f8f9fc;">
        <div style="max-width:420px;margin:0 auto;background:#fff;border-radius:16px;padding:2.5rem;box-shadow:0 4px 24px rgba(0,0,0,.08);">
          <div style="font-size:2.5rem;margin-bottom:1rem;">✅</div>
          <h2 style="margin:0 0 .5rem;color:#2d2d2d;">Conta conectada!</h2>
          <p style="color:#6b7280;margin:0 0 1rem;">Token salvo com sucesso.</p>
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

app.post("/fechamentos/upload", upload.single("file"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "Arquivo não enviado" });
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
      error: err.message
    });
  }
});

// ========================= FECHAMENTO FINANCEIRO =========================

function normalizeTextFin(value) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}
function normalizeKeyFin(value) {
  return normalizeTextFin(value).replace(/\s+/g, " ");
}
function normalizeIdFin(value) {
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
    if (Number.isFinite(num)) return Math.trunc(num).toString();
  }
  const cleaned = text.replace(/^MLB/i, "").replace(/\D/g, "");
  return cleaned ? `MLB${cleaned}` : "";
}
function normalizeIdNoPrefixFin(value) {
  return normalizeIdFin(value).replace(/^MLB/i, "");
}
function toNumberFin(value) {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  let text = String(value).trim();
  if (!text) return 0;
  text = text.replace(/\s+/g, "").replace(/R\$/gi, "").replace(/US\$/gi, "").replace(/€/g, "").replace(/%/g, "").replace(/[^\d,.-]/g, "");
  if (!text) return 0;
  const hasComma = text.includes(",");
  const hasDot = text.includes(".");
  if (hasComma && hasDot) {
    const lastComma = text.lastIndexOf(",");
    const lastDot = text.lastIndexOf(".");
    if (lastComma > lastDot) { text = text.replace(/\./g, "").replace(",", "."); }
    else { text = text.replace(/,/g, ""); }
  } else if (hasComma) {
    text = text.replace(/\./g, "").replace(",", ".");
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : 0;
}
function round2Fin(value) {
  return Number((Number.isFinite(value) ? value : 0).toFixed(2));
}
function findFieldFin(row, candidates) {
  const entries = Object.entries(row);
  for (const [key, value] of entries) {
    const normalized = normalizeKeyFin(key);
    for (const candidate of candidates) {
      if (normalized === candidate) return value;
    }
  }
  for (const [key, value] of entries) {
    const normalized = normalizeKeyFin(key);
    for (const candidate of candidates) {
      if (normalized.includes(candidate)) return value;
    }
  }
  return "";
}
function readSheetRowsFin(fileBuffer) {
  const workbook = XLSX.read(fileBuffer, { type: "buffer", cellStyles: true });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) throw new Error("A planilha enviada está vazia.");
  const sheet = workbook.Sheets[firstSheetName];
  const rowsAsArrays = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false });
  return { workbook, sheet, rowsAsArrays };
}
function parseSpreadsheetFin(fileBuffer, skipRows = 0) {
  const { sheet } = readSheetRowsFin(fileBuffer);
  return XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false, range: skipRows });
}
function detectMeliHeaderRowFin(fileBuffer) {
  const { rowsAsArrays } = readSheetRowsFin(fileBuffer);
  for (let i = 0; i < rowsAsArrays.length; i++) {
    const joined = (rowsAsArrays[i] || []).map(cell => normalizeTextFin(cell)).join(" | ");
    if (joined.includes("n.º de venda") || joined.includes("n.o de venda") || joined.includes("nº de venda") || joined.includes("# de anuncio") || joined.includes("# de anúncio") || joined.includes("receita por produtos") || joined.includes("tarifa de venda e impostos")) return i;
  }
  return 5;
}
function detectShopeeHeaderRowFin(fileBuffer) {
  const { rowsAsArrays } = readSheetRowsFin(fileBuffer);
  for (let i = 0; i < rowsAsArrays.length; i++) {
    const joined = (rowsAsArrays[i] || []).map(cell => normalizeTextFin(cell)).join(" | ");
    if (joined.includes("id do item") || joined.includes("item id") || joined.includes("id da variacao") || joined.includes("id da variação") || joined.includes("vendas (pedido pago)") || joined.includes("unidades (pedido pago)")) return i;
  }
  return 0;
}
function parseCostRowsFin(rows) {
  const parsed = [];
  for (const row of rows) {
    const idRaw = findFieldFin(row, ["id", "id do item", "id do produto", "id da variacao", "id da variação", "product id", "item id", "variation id", "sku", "seller sku", "sku do vendedor", "codigo", "código", "model_id", "modelid", "model id", "id modelo", "modelo"]);
    const id = normalizeIdNoPrefixFin(idRaw);
    if (!id) continue;
    const modelIdRaw = findFieldFin(row, ["model_id", "modelid", "model id", "id modelo", "modelo"]);
    const modelId = normalizeIdNoPrefixFin(modelIdRaw);
    const cost = toNumberFin(findFieldFin(row, ["preco custo", "preço custo", "custo", "custo produto", "custo do produto", "custo unitario", "custo unitário", "product cost"]));
    let taxPercent = toNumberFin(findFieldFin(row, ["imposto", "imposto percentual", "percentual imposto", "aliquota", "alíquota", "taxa imposto", "tax percent", "taxa"]));
    if (taxPercent > 0 && taxPercent <= 1) taxPercent = taxPercent * 100;
    parsed.push({ id, modelId, cost, taxPercent });
  }
  return parsed;
}
function getShopeeFeesByTicketFin(avgTicket) {
  if (avgTicket <= 79.99) return { commissionPercent: 20, fixedFeePerUnit: 4 };
  if (avgTicket <= 99.99) return { commissionPercent: 14, fixedFeePerUnit: 16 };
  if (avgTicket <= 199.99) return { commissionPercent: 14, fixedFeePerUnit: 20 };
  return { commissionPercent: 14, fixedFeePerUnit: 26 };
}
function parseShopeeSalesRowsFin(rows) {
  const groups = new Map();
  for (const row of rows) {
    const itemId = normalizeIdNoPrefixFin(findFieldFin(row, ["id do item", "item id", "id do produto", "product id"]));
    if (!itemId) continue;
    if (!groups.has(itemId)) groups.set(itemId, []);
    groups.get(itemId).push(row);
  }
  const parsed = [];
  for (const [itemId, groupRows] of groups.entries()) {
    const variationRows = groupRows.filter(row => {
      const variationId = normalizeIdNoPrefixFin(findFieldFin(row, ["id da variacao", "id da variação", "variation id"]));
      const revenue = toNumberFin(findFieldFin(row, ["vendas (pedido pago) (brl)", "vendas (pedido pago)", "pedido pago (brl)"]));
      const paidUnits = toNumberFin(findFieldFin(row, ["unidades (pedido pago)", "unidades pagas", "paid units"]));
      const impressionsRaw = findFieldFin(row, ["impressao do produto", "impressão do produto", "impressoes do produto", "impressões do produto"]);
      const impressions = toNumberFin(impressionsRaw);
      return !!variationId && revenue > 0 && paidUnits > 0 && impressions === 0;
    });
    const rowsToUse = variationRows.length > 0 ? variationRows : groupRows;
    for (const row of rowsToUse) {
      const variationId = normalizeIdNoPrefixFin(findFieldFin(row, ["id da variacao", "id da variação", "variation id"]));
      const modelIdRaw = findFieldFin(row, ["model id", "model_id", "modelid"]);
      const modelId = normalizeIdNoPrefixFin(modelIdRaw);
      const paidRevenue = toNumberFin(findFieldFin(row, ["vendas (pedido pago) (brl)", "vendas (pedido pago)", "pedido pago (brl)"]));
      const paidUnits = toNumberFin(findFieldFin(row, ["unidades (pedido pago)", "unidades pagas", "paid units"]));
      const variationStatus = normalizeTextFin(findFieldFin(row, ["status atual da variacao", "status atual da variação"]));
      const product = String(findFieldFin(row, ["produto", "nome do produto", "product name"]) || "").trim();
      if (paidRevenue <= 0 || paidUnits <= 0) continue;
      const isVariation = variationRows.length > 0;
      parsed.push({ id: isVariation ? variationId : itemId, modelId, product, itemId, variationId, paidRevenue, paidUnits, isVariation, variationStatus });
    }
  }
  return parsed;
}
function processShopeeFinanceiro(salesRowsRaw, costRowsRaw, ads, venforce, affiliates) {
  const salesRows = parseShopeeSalesRowsFin(salesRowsRaw);
  const costRows = parseCostRowsFin(costRowsRaw);
  if (!salesRows.length) throw new Error("Não consegui identificar linhas válidas na planilha Shopee.");
  if (!costRows.length) throw new Error("Não consegui identificar linhas válidas na planilha de custos.");
  const costMap = new Map();
  for (const row of costRows) {
    if (row.modelId && !costMap.has(row.modelId)) costMap.set(row.modelId, row);
    if (row.id && !costMap.has(row.id)) costMap.set(row.id, row);
  }
  const unmatchedIdsSet = new Set();
  const validItems = [];
  const detailedRows = [];
  let ignoredRevenue = 0;
  for (const sale of salesRows) {
    const costRow = costMap.get(sale.modelId) || costMap.get(sale.id);
    if (!costRow || costRow.cost <= 0) { unmatchedIdsSet.add(sale.id); ignoredRevenue += sale.paidRevenue; continue; }
    const averageTicket = sale.paidUnits > 0 ? sale.paidRevenue / sale.paidUnits : 0;
    if (averageTicket <= 0) continue;
    const shopeeFees = getShopeeFeesByTicketFin(averageTicket);
    const commissionValueUnit = averageTicket * (shopeeFees.commissionPercent / 100);
    const taxUnit = averageTicket * (costRow.taxPercent / 100);
    const contributionProfitUnit = averageTicket - commissionValueUnit - shopeeFees.fixedFeePerUnit - costRow.cost - taxUnit;
    const contributionMargin = averageTicket > 0 ? contributionProfitUnit / averageTicket : 0;
    const contributionProfit = contributionProfitUnit * sale.paidUnits;
    validItems.push({ paidRevenue: sale.paidRevenue, contributionProfit });
    detailedRows.push({ Marketplace: "Shopee", Produto: sale.product, ID: sale.id, "Vendas (Pedido pago) (BRL)": round2Fin(sale.paidRevenue), "Unidades (Pedido pago)": sale.paidUnits, Ticket: round2Fin(averageTicket), Custo: round2Fin(costRow.cost), Imposto: round2Fin(costRow.taxPercent), "Comissão %": round2Fin(shopeeFees.commissionPercent), "Taxa Fixa": round2Fin(shopeeFees.fixedFeePerUnit), LC: round2Fin(contributionProfitUnit), MC: round2Fin(contributionMargin * 100), "LC POR ANÚNCIO": round2Fin(contributionProfit) });
  }
  const paidRevenueTotal = validItems.reduce((acc, item) => acc + item.paidRevenue, 0);
  const contributionProfitTotal = validItems.reduce((acc, item) => acc + item.contributionProfit, 0);
  const averageContributionMargin = paidRevenueTotal > 0 ? contributionProfitTotal / paidRevenueTotal : 0;
  const tacos = paidRevenueTotal > 0 ? ads / paidRevenueTotal : 0;
  const finalResult = contributionProfitTotal - ads - venforce - affiliates;
  return { summary: { grossRevenueTotal: paidRevenueTotal, paidRevenueTotal, contributionProfitTotal, averageContributionMargin, finalResult, tacos, tacox: paidRevenueTotal > 0 ? (ads + venforce) / paidRevenueTotal : 0 }, detailedRows, excelFileName: "fechamento-shopee.xlsx", unmatchedIds: Array.from(unmatchedIdsSet), ignoredRowsWithoutCost: unmatchedIdsSet.size, ignoredRevenue, message: unmatchedIdsSet.size > 0 ? "Alguns IDs não possuem custo cadastrado." : "Processamento concluído com sucesso." };
}
function parseMeliRowsFin(rows) {
  return rows.map((row, index) => {
    const adIdRaw = String(findFieldFin(row, ["# de anúncio", "# de anuncio", "# do anúncio", "# do anuncio"]) ?? "").trim();
    return { rowIndex: index, saleDate: String(findFieldFin(row, ["data da venda"]) ?? "").trim(), units: toNumberFin(findFieldFin(row, ["unidades"])), total: toNumberFin(findFieldFin(row, ["total (brl)", "total"])), productRevenue: toNumberFin(findFieldFin(row, ["receita por produtos (brl)", "receita por produtos"])), cancelRefund: toNumberFin(findFieldFin(row, ["cancelamentos e reembolsos (brl)", "cancelamentos e reembolsos"])), adIdRaw, adId: normalizeIdFin(adIdRaw), title: String(findFieldFin(row, ["título do anúncio", "titulo do anuncio", "título", "titulo"]) ?? "").trim(), unitSalePrice: toNumberFin(findFieldFin(row, ["preço unitário de venda do anúncio (brl)", "preco unitario de venda do anuncio (brl)", "preço unitário de venda do anúncio"])) };
  });
}
function parseMeliCostRowsFin(rows) {
  const parsed = [];
  for (const row of rows) {
    const idRaw = findFieldFin(row, ["# de anúncio", "# de anuncio", "# do anúncio", "# do anuncio", "id do anúncio", "id do anuncio", "anúncio", "anuncio", "mlb", "id"]);
    const normalizedId = normalizeIdFin(idRaw);
    if (!normalizedId) continue;
    const cost = toNumberFin(findFieldFin(row, ["preço de custo", "preco de custo", "preço custo", "preco custo", "custo", "custo do produto", "custo produto", "custo unitário", "custo unitario"]));
    let taxPercent = toNumberFin(findFieldFin(row, ["imposto", "imposto %", "imposto percentual", "percentual imposto", "aliquota", "alíquota"]));
    if (taxPercent > 0 && taxPercent <= 1) taxPercent = taxPercent * 100;
    parsed.push({ id: normalizedId, cost: round2Fin(cost), taxPercent: round2Fin(taxPercent) });
  }
  return parsed;
}
function buildMeliCostMapFin(rows) {
  const parsed = parseMeliCostRowsFin(rows);
  const map = new Map();
  for (const row of parsed) {
    if (!row.id) continue;
    if (!map.has(row.id)) map.set(row.id, row);
    const noPrefix = row.id.replace(/^MLB/i, "");
    if (noPrefix && !map.has(noPrefix)) map.set(noPrefix, row);
  }
  return map;
}
function allocateByUnitsFin(totalValue, componentRows) {
  const totalUnits = componentRows.reduce((acc, row) => acc + row.units, 0);
  if (totalUnits <= 0 || componentRows.length === 0) return componentRows.map(() => 0);
  const allocations = [];
  let accumulated = 0;
  for (let i = 0; i < componentRows.length; i++) {
    if (i === componentRows.length - 1) { allocations.push(round2Fin(totalValue - accumulated)); continue; }
    const value = round2Fin((totalValue / totalUnits) * componentRows[i].units);
    allocations.push(value);
    accumulated += value;
  }
  return allocations;
}
function processMeliFinanceiro(salesRowsRaw, costRowsRaw, ads, venforce, affiliates) {
  const salesRows = parseMeliRowsFin(salesRowsRaw);
  const costMap = buildMeliCostMapFin(costRowsRaw);
  const finalRows = [];
  const unmatchedIds = new Set();
  const consumedIndexes = new Set();
  let ignoredRevenue = 0;
  const refundsTotal = round2Fin(salesRows.reduce((sum, row) => sum + row.cancelRefund, 0));
  function isMainRow(row) { return !row.adId && Math.abs(row.productRevenue) > 0; }
  function isItemRow(row) { return !!row.adId && row.units > 0; }
  function getCostForAd(adId) {
    const normalized = normalizeIdFin(adId);
    const noPrefix = normalized.replace(/^MLB/i, "");
    return costMap.get(normalized) || costMap.get(noPrefix) || costMap.get(`MLB${noPrefix}`) || null;
  }
  function pushCalculatedRow(item, totalRateado) {
    const id = normalizeIdFin(item.adId || item.adIdRaw);
    const cost = getCostForAd(id);
    if (!cost || cost.cost <= 0) { unmatchedIds.add(id || item.adIdRaw || "SEM_ID"); ignoredRevenue += round2Fin(totalRateado); return; }
    const units = round2Fin(item.units);
    const price = round2Fin(item.unitSalePrice);
    const vendaTotal = round2Fin(units * price);
    const impostoPercent = round2Fin(cost.taxPercent || 0);
    const impostoDec = impostoPercent > 1 ? impostoPercent / 100 : impostoPercent;
    const precoCusto = round2Fin(cost.cost || 0);
    const precoCustoTotal = round2Fin(units * precoCusto);
    const totalFormatado = round2Fin(totalRateado);
    let lc = 0, mc = 0;
    if (totalFormatado < 0) { lc = round2Fin(totalFormatado); mc = vendaTotal > 0 ? round2Fin((lc / vendaTotal) * 100) : 0; }
    else if (totalFormatado > 0) { lc = round2Fin(vendaTotal - (vendaTotal * impostoDec) - (vendaTotal - totalFormatado) - precoCustoTotal); mc = vendaTotal > 0 ? round2Fin((lc / vendaTotal) * 100) : 0; }
    finalRows.push({ "# de anúncio": id, "Título do anúncio": item.title, Unidades: units, "Preço unitário de venda do anúncio (BRL)": price, "Venda Total": vendaTotal, "Total (BRL)": totalFormatado, Imposto: impostoPercent, "Preço de custo": precoCusto, "Preço de custo total": precoCustoTotal, LC: lc, MC: mc });
  }
  for (let i = 0; i < salesRows.length; i++) {
    if (consumedIndexes.has(i)) continue;
    const current = salesRows[i];
    if (isMainRow(current)) {
      const children = [], childrenIndexes = [];
      let j = i + 1;
      while (j < salesRows.length) {
        const next = salesRows[j];
        if (isMainRow(next)) break;
        if (next.saleDate !== current.saleDate) break;
        if (!isItemRow(next)) break;
        children.push(next); childrenIndexes.push(j); j++;
      }
      if (children.length > 0) {
        const totalRateado = allocateByUnitsFin(current.total, children);
        for (let k = 0; k < children.length; k++) { pushCalculatedRow(children[k], totalRateado[k]); consumedIndexes.add(childrenIndexes[k]); }
        consumedIndexes.add(i); continue;
      }
      consumedIndexes.add(i); continue;
    }
    if (isItemRow(current)) { pushCalculatedRow(current, current.total); consumedIndexes.add(i); }
  }
  const grossRevenueTotal = round2Fin(finalRows.reduce((sum, row) => sum + Number(row["Venda Total"] || 0), 0));
  const paidRevenueTotal = round2Fin(finalRows.reduce((sum, row) => sum + Number(row["Total (BRL)"] || 0), 0));
  const contributionProfitTotal = round2Fin(finalRows.reduce((sum, row) => sum + Number(row["LC"] || 0), 0));
  const averageContributionMargin = grossRevenueTotal > 0 ? contributionProfitTotal / grossRevenueTotal : 0;
  const finalResult = contributionProfitTotal - ads - venforce - affiliates;
  const tacos = grossRevenueTotal > 0 ? ads / grossRevenueTotal : 0;
  const tacox = grossRevenueTotal > 0 ? (ads + venforce + affiliates) / grossRevenueTotal : 0;
  return { summary: { grossRevenueTotal, refundsTotal, cancelledRevenue: refundsTotal, paidRevenueTotal, contributionProfitTotal, averageContributionMargin, finalResult, tacos, tacox }, detailedRows: finalRows, excelFileName: "fechamento-meli.xlsx", unmatchedIds: Array.from(unmatchedIds), ignoredRowsWithoutCost: unmatchedIds.size, ignoredRevenue: round2Fin(ignoredRevenue), message: unmatchedIds.size > 0 ? "Alguns anúncios do MELI não possuem custo cadastrado e foram ignorados." : "OK" };
}

app.post("/fechamentos/financeiro", authMiddleware, upload.fields([{ name: "sales", maxCount: 1 }, { name: "costs", maxCount: 1 }]), async (req, res) => {
  try {
    const salesFile = req.files?.["sales"]?.[0];
    const costsFile = req.files?.["costs"]?.[0];
    const marketplace = String(req.body.marketplace || "").trim().toLowerCase();
    const ads = toNumberFin(req.body.ads);
    const venforce = toNumberFin(req.body.venforce);
    const affiliates = toNumberFin(req.body.affiliates);
    if (!salesFile) return res.status(400).json({ ok: false, erro: "Arquivo de vendas não enviado." });
    if (!costsFile) return res.status(400).json({ ok: false, erro: "Arquivo de custos não enviado." });
    if (marketplace !== "meli" && marketplace !== "shopee") return res.status(400).json({ ok: false, erro: "Marketplace inválido. Envie 'meli' ou 'shopee'." });
    const salesBuffer = salesFile.buffer;
    const costsBuffer = costsFile.buffer;
    const salesRowsRaw = marketplace === "meli" ? parseSpreadsheetFin(salesBuffer, detectMeliHeaderRowFin(salesBuffer)) : parseSpreadsheetFin(salesBuffer, detectShopeeHeaderRowFin(salesBuffer));
    const costRowsRaw = parseSpreadsheetFin(costsBuffer);
    const result = marketplace === "meli" ? processMeliFinanceiro(salesRowsRaw, costRowsRaw, ads, venforce, affiliates) : processShopeeFinanceiro(salesRowsRaw, costRowsRaw, ads, venforce, affiliates);
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.json_to_sheet(result.detailedRows);
    XLSX.utils.book_append_sheet(workbook, sheet, "Detalhamento");
    const excelBuffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
    return res.json({ ok: true, ...result, excelBase64: Buffer.from(excelBuffer).toString("base64") });
  } catch (error) {
    console.error("Erro em /fechamentos/financeiro:", error);
    return res.status(500).json({ ok: false, erro: error instanceof Error ? error.message : "Erro ao processar os arquivos." });
  }
});



// ============================================================
// ROTAS MULTI-CONTA — Sistema de Assessoria
// Cada conta = 1 cliente com config.json + sessao_ml.json próprios
// Cole no index.js antes de "// ERRO GLOBAL"
// ============================================================

// ─── CONTAS ML (os "saves") ─────────────────────────────────

// Listar todas as contas do usuário
app.get("/contas", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.nome, c.slug, c.conta_ml_id, c.ativo, c.headless, c.slow_mo,
              c.created_at, c.updated_at,
              (SELECT COUNT(*) FROM conta_mlbs m WHERE m.conta_id = c.id AND m.ativo = true) AS total_mlbs,
              (SELECT valida FROM conta_sessoes s WHERE s.conta_id = c.id) AS sessao_valida,
              (SELECT json_build_object('id', j.id, 'status', j.status, 'created_at', j.created_at)
               FROM conta_jobs j WHERE j.conta_id = c.id ORDER BY j.created_at DESC LIMIT 1) AS ultimo_job
       FROM contas_ml c
       WHERE c.user_id = $1
       ORDER BY c.nome ASC`,
      [req.user.id]
    );
    res.json({ ok: true, contas: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Criar nova conta
app.post("/contas", authMiddleware, async (req, res) => {
  try {
    const { nome, conta_ml_id, headless = true, slow_mo = 50 } = req.body;
    if (!nome) return res.status(400).json({ ok: false, erro: "Nome é obrigatório." });

    const slug = normalizarSlug(nome);
    const result = await pool.query(
      `INSERT INTO contas_ml (user_id, nome, slug, conta_ml_id, headless, slow_mo)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [req.user.id, nome.trim(), slug, conta_ml_id || null, headless, slow_mo]
    );
    res.status(201).json({ ok: true, conta: result.rows[0] });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ ok: false, erro: "Já existe uma conta com esse nome." });
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Atualizar conta
app.patch("/contas/:id", authMiddleware, async (req, res) => {
  try {
    const contaId = parseInt(req.params.id);
    const { nome, conta_ml_id, ativo, headless, slow_mo } = req.body;
    const campos = [];
    const valores = [];
    let i = 1;

    if (nome !== undefined)       { campos.push(`nome = $${i++}`);        valores.push(nome.trim()); }
    if (conta_ml_id !== undefined) { campos.push(`conta_ml_id = $${i++}`); valores.push(conta_ml_id); }
    if (ativo !== undefined)      { campos.push(`ativo = $${i++}`);       valores.push(ativo); }
    if (headless !== undefined)   { campos.push(`headless = $${i++}`);    valores.push(headless); }
    if (slow_mo !== undefined)    { campos.push(`slow_mo = $${i++}`);     valores.push(slow_mo); }

    if (!campos.length) return res.status(400).json({ ok: false, erro: "Nenhum campo para atualizar." });

    campos.push(`updated_at = CURRENT_TIMESTAMP`);
    valores.push(contaId, req.user.id);

    const result = await pool.query(
      `UPDATE contas_ml SET ${campos.join(", ")} WHERE id = $${i++} AND user_id = $${i}
       RETURNING *`,
      valores
    );
    if (!result.rows.length) return res.status(404).json({ ok: false, erro: "Conta não encontrada." });
    res.json({ ok: true, conta: result.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Excluir conta (cascade deleta MLBs, sessão e jobs)
app.delete("/contas/:id", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      "DELETE FROM contas_ml WHERE id = $1 AND user_id = $2 RETURNING id, nome",
      [parseInt(req.params.id), req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ ok: false, erro: "Conta não encontrada." });
    res.json({ ok: true, mensagem: `Conta "${result.rows[0].nome}" excluída.` });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Duplicar conta (copiar MLBs para nova conta)
app.post("/contas/:id/duplicar", authMiddleware, async (req, res) => {
  try {
    const contaId = parseInt(req.params.id);
    const { novo_nome } = req.body;
    if (!novo_nome) return res.status(400).json({ ok: false, erro: "novo_nome é obrigatório." });

    // Buscar conta original
    const original = await pool.query(
      "SELECT * FROM contas_ml WHERE id = $1 AND user_id = $2",
      [contaId, req.user.id]
    );
    if (!original.rows.length) return res.status(404).json({ ok: false, erro: "Conta não encontrada." });

    const slug = normalizarSlug(novo_nome);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const novaConta = await client.query(
        `INSERT INTO contas_ml (user_id, nome, slug, headless, slow_mo)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [req.user.id, novo_nome.trim(), slug,
         original.rows[0].headless, original.rows[0].slow_mo]
      );

      // Copiar MLBs
      await client.query(
        `INSERT INTO conta_mlbs (conta_id, mlb, quantidade, preco_final)
         SELECT $1, mlb, quantidade, preco_final
         FROM conta_mlbs WHERE conta_id = $2 AND ativo = true`,
        [novaConta.rows[0].id, contaId]
      );

      await client.query("COMMIT");
      res.status(201).json({ ok: true, conta: novaConta.rows[0] });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ ok: false, erro: "Já existe uma conta com esse nome." });
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ─── MLBs DE UMA CONTA ──────────────────────────────────────

// Listar MLBs da conta
app.get("/contas/:contaId/mlbs", authMiddleware, async (req, res) => {
  try {
    const contaId = parseInt(req.params.contaId);

    // Verificar acesso
    const acesso = await pool.query(
      "SELECT id FROM contas_ml WHERE id = $1 AND user_id = $2",
      [contaId, req.user.id]
    );
    if (!acesso.rows.length) return res.status(404).json({ ok: false, erro: "Conta não encontrada." });

    const result = await pool.query(
      "SELECT id, mlb, quantidade, preco_final, ativo, created_at FROM conta_mlbs WHERE conta_id = $1 ORDER BY mlb",
      [contaId]
    );
    res.json({ ok: true, mlbs: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Adicionar/atualizar MLB
app.post("/contas/:contaId/mlbs", authMiddleware, async (req, res) => {
  try {
    const contaId = parseInt(req.params.contaId);
    const acesso = await pool.query(
      "SELECT id FROM contas_ml WHERE id = $1 AND user_id = $2",
      [contaId, req.user.id]
    );
    if (!acesso.rows.length) return res.status(404).json({ ok: false, erro: "Conta não encontrada." });

    const { mlb, quantidade = 10, preco_final = null } = req.body;
    if (!mlb) return res.status(400).json({ ok: false, erro: "MLB é obrigatório." });

    const result = await pool.query(
      `INSERT INTO conta_mlbs (conta_id, mlb, quantidade, preco_final)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (conta_id, mlb) DO UPDATE SET
         quantidade = EXCLUDED.quantidade,
         preco_final = EXCLUDED.preco_final,
         ativo = true
       RETURNING *`,
      [contaId, String(mlb).trim().toUpperCase(), quantidade, preco_final || null]
    );
    res.status(201).json({ ok: true, mlb: result.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Importar MLBs em lote (config.json inteiro)
app.post("/contas/:contaId/mlbs/lote", authMiddleware, async (req, res) => {
  try {
    const contaId = parseInt(req.params.contaId);
    const acesso = await pool.query(
      "SELECT id FROM contas_ml WHERE id = $1 AND user_id = $2",
      [contaId, req.user.id]
    );
    if (!acesso.rows.length) return res.status(404).json({ ok: false, erro: "Conta não encontrada." });

    const { mlbs, substituir = false } = req.body;
    if (!Array.isArray(mlbs) || !mlbs.length) {
      return res.status(400).json({ ok: false, erro: "Envie um array 'mlbs'." });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      if (substituir) {
        await client.query("DELETE FROM conta_mlbs WHERE conta_id = $1", [contaId]);
      }

      let count = 0;
      for (const item of mlbs) {
        const mlb = String(item.mlb || "").trim().toUpperCase();
        if (!mlb) continue;

        await client.query(
          `INSERT INTO conta_mlbs (conta_id, mlb, quantidade, preco_final)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (conta_id, mlb) DO UPDATE SET
             quantidade = EXCLUDED.quantidade,
             preco_final = EXCLUDED.preco_final,
             ativo = true`,
          [contaId, mlb, item.quantidade_padrao || item.quantidade || 10, item.preco_final || null]
        );
        count++;
      }

      await client.query(
        "UPDATE contas_ml SET updated_at = CURRENT_TIMESTAMP WHERE id = $1",
        [contaId]
      );

      await client.query("COMMIT");
      res.json({ ok: true, total: count, mensagem: `${count} MLBs importados.` });
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

// Exportar MLBs como config.json
app.get("/contas/:contaId/exportar", authMiddleware, async (req, res) => {
  try {
    const contaId = parseInt(req.params.contaId);
    const acesso = await pool.query(
      "SELECT * FROM contas_ml WHERE id = $1 AND user_id = $2",
      [contaId, req.user.id]
    );
    if (!acesso.rows.length) return res.status(404).json({ ok: false, erro: "Conta não encontrada." });

    const mlbs = await pool.query(
      "SELECT mlb, quantidade AS quantidade_padrao, preco_final FROM conta_mlbs WHERE conta_id = $1 AND ativo = true ORDER BY mlb",
      [contaId]
    );

    res.json({
      mlbs: mlbs.rows,
      headless: acesso.rows[0].headless,
      slow_mo: acesso.rows[0].slow_mo
    });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Remover MLB
app.delete("/contas/:contaId/mlbs/:mlbId", authMiddleware, async (req, res) => {
  try {
    const contaId = parseInt(req.params.contaId);
    const acesso = await pool.query(
      "SELECT id FROM contas_ml WHERE id = $1 AND user_id = $2",
      [contaId, req.user.id]
    );
    if (!acesso.rows.length) return res.status(404).json({ ok: false, erro: "Conta não encontrada." });

    const result = await pool.query(
      "DELETE FROM conta_mlbs WHERE id = $1 AND conta_id = $2 RETURNING id",
      [parseInt(req.params.mlbId), contaId]
    );
    if (!result.rows.length) return res.status(404).json({ ok: false, erro: "MLB não encontrado." });
    res.json({ ok: true, mensagem: "MLB removido." });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ─── SESSÃO ML POR CONTA ────────────────────────────────────

// Upload de sessão (sessao_ml.json)
app.post("/contas/:contaId/sessao", authMiddleware, async (req, res) => {
  try {
    const contaId = parseInt(req.params.contaId);
    const acesso = await pool.query(
      "SELECT id FROM contas_ml WHERE id = $1 AND user_id = $2",
      [contaId, req.user.id]
    );
    if (!acesso.rows.length) return res.status(404).json({ ok: false, erro: "Conta não encontrada." });

    const { sessao } = req.body;
    if (!sessao || !sessao.cookies) {
      return res.status(400).json({ ok: false, erro: "Sessão inválida. Envie o conteúdo do sessao_ml.json." });
    }

    await pool.query(
      `INSERT INTO conta_sessoes (conta_id, sessao_json)
       VALUES ($1, $2)
       ON CONFLICT (conta_id) DO UPDATE SET
         sessao_json = EXCLUDED.sessao_json,
         valida = true,
         updated_at = CURRENT_TIMESTAMP`,
      [contaId, JSON.stringify(sessao)]
    );

    res.json({ ok: true, mensagem: "Sessão salva." });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Verificar sessão
app.get("/contas/:contaId/sessao", authMiddleware, async (req, res) => {
  try {
    const contaId = parseInt(req.params.contaId);
    const result = await pool.query(
      `SELECT valida, updated_at FROM conta_sessoes
       WHERE conta_id = $1 AND conta_id IN (SELECT id FROM contas_ml WHERE user_id = $2)`,
      [contaId, req.user.id]
    );
    if (!result.rows.length) return res.json({ ok: true, tem_sessao: false });
    res.json({ ok: true, tem_sessao: true, valida: result.rows[0].valida, atualizada_em: result.rows[0].updated_at });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ─── JOBS POR CONTA ─────────────────────────────────────────

// Criar job para uma conta
app.post("/contas/:contaId/jobs", authMiddleware, async (req, res) => {
  try {
    const contaId = parseInt(req.params.contaId);
    const conta = await pool.query(
      "SELECT * FROM contas_ml WHERE id = $1 AND user_id = $2 AND ativo = true",
      [contaId, req.user.id]
    );
    if (!conta.rows.length) return res.status(404).json({ ok: false, erro: "Conta não encontrada ou inativa." });

    // Verificar sessão
    const sessao = await pool.query(
      "SELECT valida FROM conta_sessoes WHERE conta_id = $1",
      [contaId]
    );
    if (!sessao.rows.length || !sessao.rows[0].valida) {
      return res.status(400).json({ ok: false, erro: "Sessão ML inválida. Faça upload primeiro." });
    }

    // Verificar se não tem job em andamento para esta conta
    const emAndamento = await pool.query(
      "SELECT id FROM conta_jobs WHERE conta_id = $1 AND status IN ('pendente', 'executando')",
      [contaId]
    );
    if (emAndamento.rows.length) {
      return res.status(409).json({ ok: false, erro: "Já existe um job em andamento para esta conta." });
    }

    // Buscar MLBs
    const mlbs = await pool.query(
      "SELECT mlb, quantidade AS quantidade_padrao, preco_final FROM conta_mlbs WHERE conta_id = $1 AND ativo = true ORDER BY mlb",
      [contaId]
    );
    if (!mlbs.rows.length) {
      return res.status(400).json({ ok: false, erro: "Nenhum MLB configurado nesta conta." });
    }

    const result = await pool.query(
      `INSERT INTO conta_jobs (user_id, conta_id, mlbs_json)
       VALUES ($1, $2, $3)
       RETURNING id, status, created_at`,
      [req.user.id, contaId, JSON.stringify(mlbs.rows)]
    );

    res.status(201).json({ ok: true, job: result.rows[0], total_mlbs: mlbs.rows.length });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Rodar TODAS as contas ativas de uma vez (fila sequencial)
app.post("/contas/executar-todas", authMiddleware, async (req, res) => {
  try {
    const contas = await pool.query(
      `SELECT c.id, c.nome FROM contas_ml c
       WHERE c.user_id = $1 AND c.ativo = true
       AND EXISTS (SELECT 1 FROM conta_sessoes s WHERE s.conta_id = c.id AND s.valida = true)
       AND EXISTS (SELECT 1 FROM conta_mlbs m WHERE m.conta_id = c.id AND m.ativo = true)
       AND NOT EXISTS (SELECT 1 FROM conta_jobs j WHERE j.conta_id = c.id AND j.status IN ('pendente', 'executando'))
       ORDER BY c.nome`,
      [req.user.id]
    );

    if (!contas.rows.length) {
      return res.status(400).json({ ok: false, erro: "Nenhuma conta elegível. Verifique sessões e MLBs." });
    }

    const jobs = [];
    for (const conta of contas.rows) {
      const mlbs = await pool.query(
        "SELECT mlb, quantidade AS quantidade_padrao, preco_final FROM conta_mlbs WHERE conta_id = $1 AND ativo = true",
        [conta.id]
      );

      const result = await pool.query(
        `INSERT INTO conta_jobs (user_id, conta_id, mlbs_json)
         VALUES ($1, $2, $3) RETURNING id, status`,
        [req.user.id, conta.id, JSON.stringify(mlbs.rows)]
      );
      jobs.push({ conta_id: conta.id, nome: conta.nome, job_id: result.rows[0].id });
    }

    res.status(201).json({ ok: true, total: jobs.length, jobs });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Listar jobs (todos ou de uma conta)
app.get("/contas/jobs", authMiddleware, async (req, res) => {
  try {
    const { conta_id, limit = 50, page = 1 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const condicoes = ["j.user_id = $1"];
    const valores = [req.user.id];
    let i = 2;

    if (conta_id) {
      condicoes.push(`j.conta_id = $${i++}`);
      valores.push(parseInt(conta_id));
    }

    valores.push(parseInt(limit), offset);
    const result = await pool.query(
      `SELECT j.id, j.conta_id, c.nome AS conta_nome, j.status,
              j.mlbs_json, j.resultado, j.log_text,
              j.created_at, j.started_at, j.finished_at
       FROM conta_jobs j
       JOIN contas_ml c ON c.id = j.conta_id
       WHERE ${condicoes.join(" AND ")}
       ORDER BY j.created_at DESC
       LIMIT $${i++} OFFSET $${i}`,
      valores
    );

    res.json({ ok: true, jobs: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Detalhes de um job (para o debug panel)
app.get("/contas/jobs/:jobId", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT j.*, c.nome AS conta_nome
       FROM conta_jobs j JOIN contas_ml c ON c.id = j.conta_id
       WHERE j.id = $1 AND j.user_id = $2`,
      [parseInt(req.params.jobId), req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ ok: false, erro: "Job não encontrado." });
    res.json({ ok: true, job: result.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Cancelar job
app.post("/contas/jobs/:jobId/cancelar", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE conta_jobs SET status = 'cancelado', finished_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND user_id = $2 AND status = 'pendente' RETURNING id`,
      [parseInt(req.params.jobId), req.user.id]
    );
    if (!result.rows.length) return res.status(400).json({ ok: false, erro: "Job não pode ser cancelado." });
    res.json({ ok: true, mensagem: "Job cancelado." });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ─── DASHBOARD / STATUS GERAL ───────────────────────────────

// Panorama de todas as contas (para o debug panel)
app.get("/contas/dashboard", authMiddleware, async (req, res) => {
  try {
    const contas = await pool.query(
      `SELECT c.id, c.nome, c.slug, c.ativo,
              (SELECT COUNT(*) FROM conta_mlbs m WHERE m.conta_id = c.id AND m.ativo = true) AS total_mlbs,
              (SELECT valida FROM conta_sessoes s WHERE s.conta_id = c.id) AS sessao_valida,
              (SELECT json_build_object(
                'id', j.id, 'status', j.status,
                'resultado', j.resultado,
                'log_text', j.log_text,
                'created_at', j.created_at,
                'finished_at', j.finished_at
              ) FROM conta_jobs j WHERE j.conta_id = c.id ORDER BY j.created_at DESC LIMIT 1) AS ultimo_job
       FROM contas_ml c
       WHERE c.user_id = $1
       ORDER BY c.nome`,
      [req.user.id]
    );

    // Jobs em andamento
    const pendentes = await pool.query(
      "SELECT COUNT(*) FROM conta_jobs WHERE user_id = $1 AND status IN ('pendente', 'executando')",
      [req.user.id]
    );

    res.json({
      ok: true,
      contas: contas.rows,
      jobs_pendentes: parseInt(pendentes.rows[0].count)
    });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});



// ERRO GLOBAL
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ ok: false, erro: `Erro no upload: ${err.message}` });
  res.status(500).json({ ok: false, erro: "Erro interno do servidor" });
});

app.listen(PORT, () => console.log(`VenForce rodando em http://localhost:${PORT}`));
