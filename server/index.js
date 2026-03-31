require("dotenv").config();

const express = require("express");
const bcrypt = require("bcrypt");
const cors = require("cors");
const multer = require("multer");
const XLSX = require("xlsx");
const jwt = require("jsonwebtoken");
const path = require("path");
const pool = require("./config/database");

const app = express();
const PORT = process.env.PORT || 3333;
const JWT_SECRET = process.env.JWT_SECRET || "venforce_secret_local";

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

// LISTAR BASES
app.get("/bases", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT b.id, b.slug, b.nome, b.ativo FROM bases b
       JOIN user_bases ub ON ub.base_id = b.id
       WHERE ub.user_id = $1 AND b.ativo = true ORDER BY b.nome ASC`,
      [req.user.id]
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
      `SELECT b.id, b.nome, b.slug FROM bases b JOIN user_bases ub ON ub.base_id = b.id
       WHERE b.slug = $1 AND ub.user_id = $2 AND b.ativo = true`,
      [slug, req.user.id]
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
        `INSERT INTO bases (slug, nome) VALUES ($1, $2) ON CONFLICT (slug) DO UPDATE SET nome = EXCLUDED.nome, ativo = true RETURNING id`,
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

// ERRO GLOBAL
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ ok: false, erro: `Erro no upload: ${err.message}` });
  res.status(500).json({ ok: false, erro: "Erro interno do servidor" });
});

app.listen(PORT, () => console.log(`VenForce rodando em http://localhost:${PORT}`));
