require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcrypt");
const cors = require("cors");
const multer = require("multer");
const XLSX = require("xlsx");
const jwt = require("jsonwebtoken");
const { google } = require("googleapis");
const { Readable } = require("stream");
const pool = require("./config/database");

const app = express();
const PORT = process.env.PORT || 3333;
const JWT_SECRET = process.env.JWT_SECRET || "venforce_secret_local";
const DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID || "";

// ==========================
// GOOGLE
// ==========================
const authGoogle = new google.auth.GoogleAuth({
  keyFile: path.resolve(
    process.env.GOOGLE_APPLICATION_CREDENTIALS || "./google-credentials.json"
  ),
  scopes: ["https://www.googleapis.com/auth/drive"]
});

const drive = google.drive({
  version: "v3",
  auth: authGoogle
});

// ==========================
// CAMINHOS
// ==========================
const publicDir = path.join(__dirname, "public");
const uploadsDir = path.join(__dirname, "uploads");
const dataClientesDir = path.resolve(
  process.env.DATA_CLIENTES_DIR || path.join(__dirname, "data", "clientes")
);
const usersFile = path.join(__dirname, "data", "users.json");

// ==========================
// GARANTIR PASTAS
// ==========================
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

if (!fs.existsSync(dataClientesDir)) {
  fs.mkdirSync(dataClientesDir, { recursive: true });
}

if (!fs.existsSync(path.dirname(usersFile))) {
  fs.mkdirSync(path.dirname(usersFile), { recursive: true });
}

// ==========================
// MIDDLEWARES
// ==========================
app.use(cors({
  origin: true,
  credentials: false,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.options(/.*/, cors({
  origin: true,
  credentials: false,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});


// ==========================
// AUXILIARES
// ==========================
function normalizarNomeCliente(nome) {
  return String(nome || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function numeroSeguro(valor) {
  if (valor === null || valor === undefined || valor === "") return 0;

  if (typeof valor === "number") {
    return Number.isFinite(valor) ? valor : 0;
  }

  let texto = String(valor).trim();
  if (!texto) return 0;

  texto = texto.replace(/\s/g, "").replace("%", "");

  if (texto.includes(",") && texto.includes(".")) {
    texto = texto.replace(/\./g, "").replace(",", ".");
  } else if (texto.includes(",")) {
    texto = texto.replace(",", ".");
  }

  const numero = Number(texto);
  return Number.isFinite(numero) ? numero : 0;
}

function obterValorColuna(row, nomesPossiveis) {
  for (const nome of nomesPossiveis) {
    if (row[nome] !== undefined && row[nome] !== null && row[nome] !== "") {
      return row[nome];
    }
  }
  return "";
}

function carregarUsers() {
  if (!fs.existsSync(usersFile)) {
    throw new Error("Arquivo users.json não encontrado");
  }

  const raw = fs.readFileSync(usersFile, "utf8");

  if (!raw.trim()) {
    throw new Error("Arquivo users.json está vazio");
  }

  let users = [];

  try {
    users = JSON.parse(raw);
  } catch (error) {
    throw new Error("users.json inválido");
  }

  if (!Array.isArray(users)) {
    throw new Error("users.json precisa ser um array");
  }

  return users;
}

function salvarUsers(users) {
  fs.writeFileSync(usersFile, JSON.stringify(users, null, 2), "utf8");
}

function buscarUserPorEmail(email) {
  const users = carregarUsers();

  return users.find(
    (u) =>
      String(u.email || "").trim().toLowerCase() ===
      String(email || "").trim().toLowerCase()
  );
}

function sanitizarUser(user) {
  return {
    id: user.id || null,
    nome: user.nome || "",
    email: user.email || "",
    ativo: user.ativo !== false,
    role: user.role || "user",
    bases_permitidas: Array.isArray(user.bases_permitidas)
      ? user.bases_permitidas
      : []
  };
}

function userPodeAcessarBase(user, cliente) {
  if (!user) return false;
  if (user.ativo === false) return false;

  const bases = Array.isArray(user.bases_permitidas) ? user.bases_permitidas : [];
  const clienteNormalizado = normalizarNomeCliente(cliente);

  return bases.map(normalizarNomeCliente).includes(clienteNormalizado);
}

function listarPastasClientes() {
  if (!fs.existsSync(dataClientesDir)) return [];

  return fs
    .readdirSync(dataClientesDir, { withFileTypes: true })
    .filter((item) => item.isDirectory())
    .map((item) => item.name);
}

function gerarToken(user) {
  return jwt.sign(
    {
      id: user.id || null,
      nome: user.nome || "",
      email: user.email || "",
      role: user.role || "user"
    },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        ok: false,
        erro: "Token não informado"
      });
    }

    const token = authHeader.slice(7);
    const decoded = jwt.verify(token, JWT_SECRET);

    const user = buscarUserPorEmail(decoded.email);

    if (!user) {
      return res.status(401).json({
        ok: false,
        erro: "Usuário não encontrado"
      });
    }

    if (user.ativo === false) {
      return res.status(403).json({
        ok: false,
        erro: "Usuário inativo"
      });
    }

    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({
      ok: false,
      erro: "Token inválido ou expirado"
    });
  }
}

function removerArquivoSeExistir(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    console.warn("Não foi possível remover arquivo temporário:", filePath);
  }
}

function parsePlanilhaParaResultado(rows) {
  const resultado = {};

  for (const row of rows) {
    const id = String(
      obterValorColuna(row, ["id", "ID", "Id", "sku", "SKU", "Sku"])
    ).trim();

    if (!id) continue;

    const custoProduto = numeroSeguro(
      obterValorColuna(row, [
        "custo_produto",
        "CUSTO_PRODUTO",
        "custo",
        "CUSTO",
        "custo produto",
        "Custo Produto"
      ])
    );

    const impostoPercentual = numeroSeguro(
      obterValorColuna(row, [
        "imposto_percentual",
        "IMPOSTO_PERCENTUAL",
        "imposto",
        "IMPOSTO",
        "imposto percentual",
        "Imposto Percentual"
      ])
    );

    const taxaFixa = numeroSeguro(
      obterValorColuna(row, [
        "taxa_fixa",
        "TAXA_FIXA",
        "taxa fixa",
        "Taxa Fixa",
        "taxa"
      ])
    );

    resultado[id] = {
      custo_produto: custoProduto,
      imposto_percentual: impostoPercentual,
      taxa_fixa: taxaFixa
    };
  }

  return resultado;
}

function lerPlanilhaParaJson(filePath, originalName) {
  const ext = path.extname(originalName).toLowerCase();

  if (![".xlsx", ".xls", ".csv"].includes(ext)) {
    throw new Error("Formato inválido. Envie .xlsx, .xls ou .csv");
  }

  const workbook = XLSX.readFile(filePath);
  const primeiraAba = workbook.SheetNames[0];

  if (!primeiraAba) {
    throw new Error("A planilha não possui abas válidas");
  }

  const worksheet = workbook.Sheets[primeiraAba];
  const rows = XLSX.utils.sheet_to_json(worksheet, { defval: "" });

  if (!rows.length) {
    throw new Error("A planilha está vazia");
  }

  const resultado = parsePlanilhaParaResultado(rows);

  if (!Object.keys(resultado).length) {
    throw new Error("Nenhum ID válido encontrado na planilha");
  }

  return resultado;
}

async function listarBasesDrivePermitidas(user) {
  if (!DRIVE_FOLDER_ID) return [];

  const response = await drive.files.list({
    q: `'${DRIVE_FOLDER_ID}' in parents and trashed=false`,
    fields: "files(id,name)"
  });

  const files = response.data.files || [];
  const basesPermitidas = Array.isArray(user.bases_permitidas)
    ? user.bases_permitidas.map(normalizarNomeCliente)
    : [];

  return files
    .filter((file) => String(file.name || "").toLowerCase().endsWith(".json"))
    .map((file) => {
      const nomeSemExt = String(file.name || "").replace(/\.json$/i, "");
      const slug = normalizarNomeCliente(nomeSemExt);

      return {
        id: file.id,
        nome: nomeSemExt,
        slug,
        tipo: "drive",
        fileId: file.id,
        fileName: file.name
      };
    })
    .filter((base) => basesPermitidas.includes(base.slug));
}

function listarBasesLocaisPermitidas(user) {
  const clientesExistentes = listarPastasClientes();
  const basesPermitidas = Array.isArray(user.bases_permitidas)
    ? user.bases_permitidas.map(normalizarNomeCliente)
    : [];

  return clientesExistentes
    .filter((cliente) => basesPermitidas.includes(normalizarNomeCliente(cliente)))
    .map((cliente) => ({
      id: cliente,
      nome: cliente,
      slug: normalizarNomeCliente(cliente),
      tipo: "local"
    }));
}

async function obterArquivoDrivePorIdentificador(user, identificador) {
  const bases = await listarBasesDrivePermitidas(user);
  const normalizado = normalizarNomeCliente(identificador);

  return (
    bases.find((b) => b.id === identificador) ||
    bases.find((b) => b.slug === normalizado) ||
    bases.find((b) => normalizarNomeCliente(b.nome) === normalizado) ||
    null
  );
}

// ==========================
// CONFIG UPLOAD
// ==========================
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    const safeOriginalName = String(file.originalname).replace(/\s+/g, "_");
    const uniqueName = `${Date.now()}-${safeOriginalName}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 20 * 1024 * 1024
  }
});

// ==========================
// ROTAS BÁSICAS
// ==========================
app.get("/", (req, res) => {
  res.send("API VenForce rodando 🚀");
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    mensagem: `VENFORCE STATUS OK ${PORT}`
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    mensagem: `VENFORCE STATUS OK ${PORT}`
  });
});


app.get('/create-users-table', async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    res.send('Tabela users criada com sucesso');
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro ao criar tabela');
  }
});


app.get('/test-db', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro no banco');
  }
});

// ==========================
// LOGIN LEGADO
// ==========================
app.post("/login", async (req, res) => {
  try {
    const email = req.body.email;
    const password = req.body.password || req.body.senha;

    if (!email || !password) {
      return res.status(400).json({
        ok: false,
        erro: "Email e senha são obrigatórios"
      });
    }

    if (!String(email).toLowerCase().endsWith("@vendexcompany.com")) {
      return res.status(403).json({
        ok: false,
        erro: "Acesso permitido apenas para emails Vendex"
      });
    }

    const user = buscarUserPorEmail(email);

    if (!user) {
      return res.status(401).json({
        ok: false,
        erro: "Usuário não encontrado"
      });
    }

    if (user.ativo === false) {
      return res.status(403).json({
        ok: false,
        erro: "Usuário inativo"
      });
    }

    const senhaSalva = user.password || user.senha || "";
    const valid = await bcrypt.compare(password, senhaSalva);

    if (!valid) {
      return res.status(401).json({
        ok: false,
        erro: "Senha inválida"
      });
    }

    return res.json({
      ok: true,
      mensagem: "Login realizado com sucesso",
      user: sanitizarUser(user)
    });
  } catch (error) {
    console.error("Erro no login:", error);
    return res.status(500).json({
      ok: false,
      erro: error.message || "Erro interno no servidor"
    });
  }
});

// ==========================
// LOGIN NOVO
// ==========================
app.post("/auth/login", async (req, res) => {
  try {
    const email = req.body.email;
    const senha = req.body.senha || req.body.password;

    if (!email || !senha) {
      return res.status(400).json({
        ok: false,
        erro: "Email e senha são obrigatórios"
      });
    }

    if (!String(email).toLowerCase().endsWith("@vendexcompany.com")) {
      return res.status(403).json({
        ok: false,
        erro: "Acesso permitido apenas para emails Vendex"
      });
    }

    const user = buscarUserPorEmail(email);

    if (!user) {
      return res.status(401).json({
        ok: false,
        erro: "Usuário não encontrado"
      });
    }

    if (user.ativo === false) {
      return res.status(403).json({
        ok: false,
        erro: "Usuário inativo"
      });
    }

    const senhaSalva = user.password || user.senha || "";
    const valid = await bcrypt.compare(senha, senhaSalva);

    if (!valid) {
      return res.status(401).json({
        ok: false,
        erro: "Senha inválida"
      });
    }

    const token = gerarToken(user);

    return res.json({
      ok: true,
      mensagem: "Login realizado com sucesso",
      token,
      user: sanitizarUser(user)
    });
  } catch (error) {
    console.error("Erro no /auth/login:", error);
    return res.status(500).json({
      ok: false,
      erro: error.message || "Erro interno no servidor"
    });
  }
});

// ==========================
// USUÁRIO
// ==========================
app.get("/me", (req, res) => {
  try {
    const email = String(req.query.email || "").trim();

    if (!email) {
      return res.status(400).json({
        ok: false,
        erro: "Email é obrigatório"
      });
    }

    if (!email.toLowerCase().endsWith("@vendexcompany.com")) {
      return res.status(403).json({
        ok: false,
        erro: "Acesso permitido apenas para emails Vendex"
      });
    }

    const user = buscarUserPorEmail(email);

    if (!user) {
      return res.status(404).json({
        ok: false,
        erro: "Usuário não encontrado"
      });
    }

    if (user.ativo === false) {
      return res.status(403).json({
        ok: false,
        erro: "Usuário inativo"
      });
    }

    return res.json({
      ok: true,
      user: sanitizarUser(user)
    });
  } catch (error) {
    console.error("Erro no /me:", error);
    return res.status(500).json({
      ok: false,
      erro: error.message || "Erro ao buscar usuário"
    });
  }
});

app.get("/auth/me", authMiddleware, (req, res) => {
  try {
    return res.json({
      ok: true,
      user: sanitizarUser(req.user)
    });
  } catch (error) {
    console.error("Erro no /auth/me:", error);
    return res.status(500).json({
      ok: false,
      erro: "Erro ao validar sessão"
    });
  }
});

// ==========================
// ALTERAR SENHA
// ==========================
app.post("/change-password", async (req, res) => {
  try {
    const { email, senhaAtual, novaSenha } = req.body;

    if (!email || !senhaAtual || !novaSenha) {
      return res.status(400).json({
        ok: false,
        erro: "Email, senha atual e nova senha são obrigatórios"
      });
    }

    if (String(novaSenha).trim().length < 4) {
      return res.status(400).json({
        ok: false,
        erro: "A nova senha está muito curta"
      });
    }

    const users = carregarUsers();
    const userIndex = users.findIndex(
      (u) =>
        String(u.email || "").trim().toLowerCase() ===
        String(email || "").trim().toLowerCase()
    );

    if (userIndex === -1) {
      return res.status(404).json({
        ok: false,
        erro: "Usuário não encontrado"
      });
    }

    const user = users[userIndex];

    if (user.ativo === false) {
      return res.status(403).json({
        ok: false,
        erro: "Usuário inativo"
      });
    }

    const senhaSalva = user.password || user.senha || "";
    const senhaOk = await bcrypt.compare(senhaAtual, senhaSalva);

    if (!senhaOk) {
      return res.status(401).json({
        ok: false,
        erro: "Senha atual incorreta"
      });
    }

    const novoHash = await bcrypt.hash(novaSenha, 10);

    if (user.password !== undefined) {
      users[userIndex].password = novoHash;
    } else {
      users[userIndex].senha = novoHash;
    }

    salvarUsers(users);

    return res.json({
      ok: true,
      mensagem: "Senha alterada com sucesso"
    });
  } catch (error) {
    console.error("Erro ao trocar senha:", error);
    return res.status(500).json({
      ok: false,
      erro: error.message || "Erro ao alterar senha"
    });
  }
});

// ==========================
// UPLOAD LEGADO
// ==========================
app.post("/upload", upload.single("planilha"), (req, res) => {
  let arquivoPath = null;

  try {
    const email = String(req.body.email || "").trim();
    const clienteOriginal = String(req.body.cliente || "").trim();
    const cliente = normalizarNomeCliente(clienteOriginal);

    if (!email) {
      return res.status(400).json({
        ok: false,
        erro: "Email é obrigatório"
      });
    }

    if (!email.toLowerCase().endsWith("@vendexcompany.com")) {
      return res.status(403).json({
        ok: false,
        erro: "Acesso permitido apenas para emails Vendex"
      });
    }

    const user = buscarUserPorEmail(email);

    if (!user) {
      return res.status(401).json({
        ok: false,
        erro: "Usuário não encontrado"
      });
    }

    if (user.ativo === false) {
      return res.status(403).json({
        ok: false,
        erro: "Usuário inativo"
      });
    }

    if (!clienteOriginal) {
      return res.status(400).json({
        ok: false,
        erro: "Nome do cliente é obrigatório"
      });
    }

    if (!cliente) {
      return res.status(400).json({
        ok: false,
        erro: "Nome do cliente inválido"
      });
    }

    if (!req.file) {
      return res.status(400).json({
        ok: false,
        erro: "Nenhum arquivo foi enviado"
      });
    }

    arquivoPath = req.file.path;

    const resultado = lerPlanilhaParaJson(arquivoPath, req.file.originalname);

    const clienteDir = path.join(dataClientesDir, cliente);
    if (!fs.existsSync(clienteDir)) {
      fs.mkdirSync(clienteDir, { recursive: true });
    }

    const jsonPath = path.join(clienteDir, "custos.json");
    fs.writeFileSync(jsonPath, JSON.stringify(resultado, null, 2), "utf8");

    return res.json({
      ok: true,
      mensagem: "Planilha convertida com sucesso",
      cliente,
      cliente_original: clienteOriginal,
      arquivo_enviado: req.file.filename,
      registros: Object.keys(resultado).length,
      json_salvo_em: jsonPath
    });
  } catch (error) {
    console.error("Erro no upload/processamento:", error);
    return res.status(500).json({
      ok: false,
      erro: error.message || "Erro ao processar planilha"
    });
  } finally {
    removerArquivoSeExistir(arquivoPath);
  }
});

// ==========================
// CLIENTES LEGADO
// ==========================
app.get("/clientes", (req, res) => {
  try {
    const email = String(req.query.email || "").trim();

    if (!email) {
      return res.status(400).json({
        ok: false,
        erro: "Email é obrigatório"
      });
    }

    if (!email.toLowerCase().endsWith("@vendexcompany.com")) {
      return res.status(403).json({
        ok: false,
        erro: "Acesso permitido apenas para emails Vendex"
      });
    }

    const user = buscarUserPorEmail(email);

    if (!user) {
      return res.status(401).json({
        ok: false,
        erro: "Usuário não encontrado"
      });
    }

    if (user.ativo === false) {
      return res.status(403).json({
        ok: false,
        erro: "Usuário inativo"
      });
    }

    const clientesExistentes = listarPastasClientes();
    const basesPermitidas = Array.isArray(user.bases_permitidas)
      ? user.bases_permitidas
      : [];

    const clientesLiberados = clientesExistentes.filter((cliente) =>
      basesPermitidas.map(normalizarNomeCliente).includes(normalizarNomeCliente(cliente))
    );

    return res.json({
      ok: true,
      email: user.email,
      clientes: clientesLiberados
    });
  } catch (error) {
    console.error("Erro ao listar clientes:", error);
    return res.status(500).json({
      ok: false,
      erro: error.message || "Erro ao listar clientes"
    });
  }
});

// ==========================
// LISTAR BASES
// ==========================
app.get("/bases", authMiddleware, async (req, res) => {
  try {
    const user = req.user;

    const basesLocais = listarBasesLocaisPermitidas(user);
    const basesDrive = await listarBasesDrivePermitidas(user);

    const mapa = new Map();

    for (const base of basesLocais) {
      mapa.set(base.slug, {
        id: base.id,
        nome: base.nome,
        tipo: "local",
        slug: base.slug
      });
    }

    for (const base of basesDrive) {
      mapa.set(base.slug, {
        id: base.slug,
        nome: base.nome,
        tipo: "drive",
        slug: base.slug,
        fileId: base.fileId
      });
    }

    const bases = Array.from(mapa.values()).sort((a, b) =>
      String(a.nome).localeCompare(String(b.nome), "pt-BR")
    );

    return res.json({
      ok: true,
      bases
    });
  } catch (error) {
    console.error("Erro ao listar bases:", error);
    return res.status(500).json({
      ok: false,
      erro: error.message || "Erro ao listar bases"
    });
  }
});

// ==========================
// CUSTOS LEGADO
// ==========================
app.get("/api/custos/:cliente", (req, res) => {
  try {
    const email = String(req.query.email || "").trim();
    const cliente = normalizarNomeCliente(req.params.cliente);

    if (!email) {
      return res.status(400).json({
        ok: false,
        erro: "Email é obrigatório"
      });
    }

    if (!email.toLowerCase().endsWith("@vendexcompany.com")) {
      return res.status(403).json({
        ok: false,
        erro: "Acesso permitido apenas para emails Vendex"
      });
    }

    const user = buscarUserPorEmail(email);

    if (!user) {
      return res.status(401).json({
        ok: false,
        erro: "Usuário não encontrado"
      });
    }

    if (user.ativo === false) {
      return res.status(403).json({
        ok: false,
        erro: "Usuário inativo"
      });
    }

    if (!userPodeAcessarBase(user, cliente)) {
      return res.status(403).json({
        ok: false,
        erro: "Você não tem permissão para acessar esta base"
      });
    }

    const jsonPath = path.join(dataClientesDir, cliente, "custos.json");

    if (!fs.existsSync(jsonPath)) {
      return res.status(404).json({
        ok: false,
        erro: "Cliente ou custos.json não encontrado"
      });
    }

    const raw = fs.readFileSync(jsonPath, "utf8");
    const data = JSON.parse(raw);

    return res.json({
      ok: true,
      cliente,
      data
    });
  } catch (error) {
    console.error("Erro ao buscar custos:", error);
    return res.status(500).json({
      ok: false,
      erro: "Erro ao buscar custos do cliente"
    });
  }
});

// ==========================
// BASE LOCAL ESPECÍFICA
// ==========================
app.get("/bases/:cliente", authMiddleware, (req, res) => {
  try {
    const cliente = normalizarNomeCliente(req.params.cliente);
    const user = req.user;

    if (!userPodeAcessarBase(user, cliente)) {
      return res.status(403).json({
        ok: false,
        erro: "Você não tem permissão para acessar esta base"
      });
    }

    const jsonPath = path.join(dataClientesDir, cliente, "custos.json");

    if (!fs.existsSync(jsonPath)) {
      return res.status(404).json({
        ok: false,
        erro: "Base ainda não possui custos.json"
      });
    }

    const raw = fs.readFileSync(jsonPath, "utf8");
    const dados = JSON.parse(raw);

    return res.json({
      ok: true,
      baseId: cliente,
      total: Object.keys(dados).length,
      dados
    });
  } catch (error) {
    console.error("Erro ao buscar base:", error);
    return res.status(500).json({
      ok: false,
      erro: "Erro ao buscar base"
    });
  }
});

// ==========================
// IMPORTAR PLANILHA LOCAL
// ==========================
app.post("/bases/:cliente/importar", authMiddleware, upload.single("arquivo"), (req, res) => {
  let arquivoPath = null;

  try {
    const clienteOriginal = String(req.params.cliente || "").trim();
    const cliente = normalizarNomeCliente(clienteOriginal);
    const user = req.user;

    if (!cliente) {
      return res.status(400).json({
        ok: false,
        erro: "Base inválida"
      });
    }

    if (!userPodeAcessarBase(user, cliente)) {
      return res.status(403).json({
        ok: false,
        erro: "Você não tem permissão para importar nesta base"
      });
    }

    if (!req.file) {
      return res.status(400).json({
        ok: false,
        erro: "Nenhum arquivo foi enviado"
      });
    }

    arquivoPath = req.file.path;

    const resultado = lerPlanilhaParaJson(arquivoPath, req.file.originalname);

    const clienteDir = path.join(dataClientesDir, cliente);
    if (!fs.existsSync(clienteDir)) {
      fs.mkdirSync(clienteDir, { recursive: true });
    }

    const jsonPath = path.join(clienteDir, "custos.json");
    fs.writeFileSync(jsonPath, JSON.stringify(resultado, null, 2), "utf8");

    return res.json({
      ok: true,
      mensagem: "Planilha importada com sucesso",
      cliente,
      total: Object.keys(resultado).length
    });
  } catch (error) {
    console.error("Erro ao importar planilha da base:", error);
    return res.status(500).json({
      ok: false,
      erro: error.message || "Erro ao importar planilha"
    });
  } finally {
    removerArquivoSeExistir(arquivoPath);
  }
});

// ==========================
// LISTAR UPLOADS
// ==========================
app.get("/uploads-list", (req, res) => {
  try {
    const email = String(req.query.email || "").trim();

    if (!email) {
      return res.status(400).json({
        ok: false,
        erro: "Email é obrigatório"
      });
    }

    const user = buscarUserPorEmail(email);

    if (!user) {
      return res.status(401).json({
        ok: false,
        erro: "Usuário não encontrado"
      });
    }

    if (user.ativo === false) {
      return res.status(403).json({
        ok: false,
        erro: "Usuário inativo"
      });
    }

    const arquivos = fs.readdirSync(uploadsDir);

    return res.json({
      ok: true,
      arquivos
    });
  } catch (error) {
    console.error("Erro ao listar uploads:", error);
    return res.status(500).json({
      ok: false,
      erro: "Erro ao listar uploads"
    });
  }
});

// ==========================
// DRIVE - LISTAR BASES
// ==========================
app.get("/bases-drive", authMiddleware, async (req, res) => {
  try {
    if (!DRIVE_FOLDER_ID) {
      return res.status(500).json({
        ok: false,
        erro: "GOOGLE_DRIVE_FOLDER_ID não configurado"
      });
    }

    const bases = await listarBasesDrivePermitidas(req.user);

    return res.json({
      ok: true,
      bases: bases.map((base) => ({
        id: base.id,
        nome: base.nome,
        slug: base.slug
      }))
    });
  } catch (error) {
    console.error("Erro Drive:", error);

    return res.status(500).json({
      ok: false,
      erro: error.message || "Erro ao acessar Google Drive"
    });
  }
});

// ==========================
// DRIVE - BUSCAR BASE POR TOKEN
// ==========================
app.get("/bases-drive/:baseId", authMiddleware, async (req, res) => {
  try {
    if (!DRIVE_FOLDER_ID) {
      return res.status(500).json({
        ok: false,
        erro: "GOOGLE_DRIVE_FOLDER_ID não configurado"
      });
    }

    const identificador = String(req.params.baseId || "").trim();

    if (!identificador) {
      return res.status(400).json({
        ok: false,
        erro: "Base inválida"
      });
    }

    const base = await obterArquivoDrivePorIdentificador(req.user, identificador);

    if (!base) {
      return res.status(404).json({
        ok: false,
        erro: "Base não encontrada no Drive ou sem permissão"
      });
    }

    const response = await drive.files.get(
      { fileId: base.fileId, alt: "media" },
      { responseType: "stream" }
    );

    const chunks = [];

    await new Promise((resolve, reject) => {
      response.data.on("data", (chunk) => chunks.push(chunk));
      response.data.on("end", resolve);
      response.data.on("error", reject);
    });

    const raw = Buffer.concat(chunks).toString("utf8");
    const dados = JSON.parse(raw);

    return res.json({
      ok: true,
      baseId: base.slug,
      nome: base.nome,
      origem: "drive",
      total: Object.keys(dados || {}).length,
      dados
    });
  } catch (error) {
    console.error("Erro ao buscar base no Drive:", error);

    return res.status(500).json({
      ok: false,
      erro: error.message || "Erro ao buscar base no Drive"
    });
  }
});

// ==========================
// IMPORTAR PLANILHA → DRIVE
// ==========================
app.post("/importar-base", authMiddleware, upload.single("arquivo"), async (req, res) => {
  let filePath = null;

  try {
    if (!DRIVE_FOLDER_ID) {
      return res.status(500).json({
        ok: false,
        erro: "GOOGLE_DRIVE_FOLDER_ID não configurado"
      });
    }

    if (!req.file) {
      return res.status(400).json({
        ok: false,
        erro: "Nenhum arquivo enviado"
      });
    }

    filePath = req.file.path;

    const resultado = lerPlanilhaParaJson(filePath, req.file.originalname);

    const nomeBaseOriginal = String(req.body.nomeBase || req.body.baseName || "").trim();
    const nomeBase = normalizarNomeCliente(nomeBaseOriginal || `base_${Date.now()}`);

    if (!userPodeAcessarBase(req.user, nomeBase)) {
      return res.status(403).json({
        ok: false,
        erro: "Você não tem permissão para criar ou atualizar esta base"
      });
    }

    const existentes = await listarBasesDrivePermitidas(req.user);
    const existente = existentes.find((b) => b.slug === nomeBase);

    const jsonBuffer = Buffer.from(JSON.stringify(resultado, null, 2), "utf8");
    const jsonStream = Readable.from(jsonBuffer);

    let driveResponse;

    if (existente) {
      driveResponse = await drive.files.update({
        fileId: existente.fileId,
        media: {
          mimeType: "application/json",
          body: jsonStream
        },
        fields: "id,name"
      });
    } else {
      driveResponse = await drive.files.create({
        requestBody: {
          name: `${nomeBase}.json`,
          parents: [DRIVE_FOLDER_ID]
        },
        media: {
          mimeType: "application/json",
          body: jsonStream
        },
        fields: "id,name"
      });
    }

    return res.json({
      ok: true,
      mensagem: existente ? "Base atualizada no Drive" : "Base criada no Drive",
      fileId: driveResponse.data.id,
      arquivo: driveResponse.data.name,
      total: Object.keys(resultado).length
    });
  } catch (error) {
    console.error("Erro importando base:", error);

    return res.status(500).json({
      ok: false,
      erro: error.message || "Erro ao importar planilha"
    });
  } finally {
    removerArquivoSeExistir(filePath);
  }
});

// ==========================
// ERROS
// ==========================
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    return res.status(400).json({
      ok: false,
      erro: `Erro no upload: ${error.message}`
    });
  }

  if (error) {
    console.error("Erro geral:", error);
    return res.status(500).json({
      ok: false,
      erro: "Erro interno do servidor"
    });
  }

  next();
});

// ==========================
// START
// ==========================

app.listen(PORT, () => {
  console.log(`Servidor VenForce rodando em http://localhost:${PORT}`);
  console.log(`Pasta public: ${publicDir}`);
  console.log(`Pasta uploads: ${uploadsDir}`);
  console.log(`Pasta data/clientes: ${dataClientesDir}`);
  console.log(`Arquivo users: ${usersFile}`);
  console.log(
    `Arquivo credenciais Google: ${path.resolve(
      process.env.GOOGLE_APPLICATION_CREDENTIALS || "./google-credentials.json"
    )}`
  );
  console.log(`GOOGLE_DRIVE_FOLDER_ID: ${DRIVE_FOLDER_ID || "(não configurado)"}`);
});
