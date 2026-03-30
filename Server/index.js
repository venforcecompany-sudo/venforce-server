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

const app = express();
app.get('/callback', (req, res) => {
  const code = req.query.code;

  console.log("CODE RECEBIDO:", code);

  res.send(`Code recebido: ${code}`);
});
const PORT = Number(process.env.PORT || 4127);
const JWT_SECRET = process.env.JWT_SECRET || "venforce_secret_local";
const DRIVE_FOLDER_ID = String(process.env.GOOGLE_DRIVE_FOLDER_ID || "").trim();

const publicDir = path.join(__dirname, "public");
const uploadsDir = path.join(__dirname, "uploads");
const dataDir = path.join(__dirname, "data");
const dataClientesDir = path.join(dataDir, "clientes");
const usersFile = path.join(dataDir, "users.json");

// ==========================
// GOOGLE DRIVE
// ==========================
let drive = null;

try {
  const authGoogle = new google.auth.GoogleAuth({
    keyFile: path.resolve(
      process.env.GOOGLE_APPLICATION_CREDENTIALS || "./google-credentials.json"
    ),
    scopes: ["https://www.googleapis.com/auth/drive"]
  });

  drive = google.drive({
    version: "v3",
    auth: authGoogle
  });
} catch (error) {
  console.error("[GOOGLE] falha ao iniciar cliente do Drive:", error.message);
  drive = null;
}

// ==========================
// GARANTIR PASTAS / ARQUIVOS
// ==========================
for (const dir of [publicDir, uploadsDir, dataDir, dataClientesDir]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

if (!fs.existsSync(usersFile)) {
  fs.writeFileSync(usersFile, "[]", "utf8");
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

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

app.use(express.static(publicDir));

// ==========================
// HELPERS
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

  texto = texto
    .replace(/\s+/g, "")
    .replace(/R\$/gi, "")
    .replace(/US\$/gi, "")
    .replace(/€/gi, "")
    .replace(/%/g, "")
    .replace(/[^\d,.\-]/g, "");

  if (!texto) return 0;

  const temVirgula = texto.includes(",");
  const temPonto = texto.includes(".");

  if (temVirgula && temPonto) {
    const ultimaVirgula = texto.lastIndexOf(",");
    const ultimoPonto = texto.lastIndexOf(".");

    if (ultimaVirgula > ultimoPonto) {
      texto = texto.replace(/\./g, "").replace(",", ".");
    } else {
      texto = texto.replace(/,/g, "");
    }
  } else if (temVirgula) {
    const partes = texto.split(",");

    if (partes.length > 2) {
      texto = partes.join("");
    } else {
      const parteDecimal = partes[1] || "";

      if (parteDecimal.length === 3 && partes[0].length >= 1) {
        texto = partes.join("");
      } else {
        texto = texto.replace(",", ".");
      }
    }
  } else if (temPonto) {
    const partes = texto.split(".");

    if (partes.length > 2) {
      texto = partes.join("");
    } else {
      const parteDecimal = partes[1] || "";
      if (parteDecimal.length === 3 && partes[0].length >= 1) {
        texto = partes.join("");
      }
    }
  }

  const numero = Number(texto);
  return Number.isFinite(numero) ? numero : 0;
}

function obterValorColuna(row, nomesPossiveis) {
  const entradas = Object.entries(row || {});

  const normalizar = (texto) =>
    String(texto || "")
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\w]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "");

  for (const nome of nomesPossiveis) {
    if (row[nome] !== undefined && row[nome] !== null && row[nome] !== "") {
      return row[nome];
    }
  }

  const mapa = entradas.map(([chave, valor]) => ({
    chaveNormalizada: normalizar(chave),
    valor
  }));

  for (const nome of nomesPossiveis) {
    const alvo = normalizar(nome);
    const encontrado = mapa.find((item) => item.chaveNormalizada === alvo);

    if (
      encontrado &&
      encontrado.valor !== undefined &&
      encontrado.valor !== null &&
      encontrado.valor !== ""
    ) {
      return encontrado.valor;
    }
  }

  return "";
}

function carregarUsers() {
  if (!fs.existsSync(usersFile)) {
    fs.writeFileSync(usersFile, "[]", "utf8");
  }

  const raw = fs.readFileSync(usersFile, "utf8");

  if (!raw.trim()) {
    return [];
  }

  let users = [];

  try {
    users = JSON.parse(raw);
  } catch {
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

function isAdmin(user) {
  if (!user) return false;

  const role = String(user.role || "").toLowerCase();
  const email = String(user.email || "").trim().toLowerCase();

  return role === "admin" || email === "admin@vendexcompany.com";
}

function userPodeAcessarBase(user, cliente) {
  if (!user) return false;
  if (user.ativo === false) return false;
  if (isAdmin(user)) return true;

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

function garantirPastaCliente(cliente) {
  const clienteDir = path.join(dataClientesDir, cliente);
  if (!fs.existsSync(clienteDir)) {
    fs.mkdirSync(clienteDir, { recursive: true });
  }
  return clienteDir;
}

function getCaminhoCustosCliente(cliente) {
  return path.join(dataClientesDir, cliente, "custos.json");
}

function gerarToken(user) {
  return jwt.sign(
    {
      id: user.id || null,
      nome: user.nome || "",
      email: user.email || "",
      role: user.role || "user",
      bases_permitidas: Array.isArray(user.bases_permitidas)
        ? user.bases_permitidas
        : []
    },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

async function validarSenha(senhaRecebida, senhaSalva) {
  const recebida = String(senhaRecebida || "");
  const salva = String(senhaSalva || "");

  if (!salva) return false;

  if (
    salva.startsWith("$2a$") ||
    salva.startsWith("$2b$") ||
    salva.startsWith("$2y$")
  ) {
    return await bcrypt.compare(recebida, salva);
  }

  return recebida === salva;
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
  } catch {
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
  } catch {}
}

function parsePlanilhaParaResultado(rows) {
  const resultado = {};

  for (const row of rows) {
    const idOriginal = String(
      obterValorColuna(row, [
        "id",
        "ID",
        "Id",
        "sku",
        "SKU",
        "Sku",
        "anuncio",
        "Anuncio",
        "anuncio_id",
        "Anuncio ID",
        "id_anuncio",
        "product_id",
        "Product ID",
        "id ml",
        "id_ml",
        "id anúncio",
        "id_anuncio_ml",
        "model id",
        "Model ID",
        "model_id",
        "MODEL_ID",
        "sku principal",
        "SKU principal",
        "sku_principal",
        "sku da variação",
        "SKU da variação",
        "sku_variacao",
        "item id",
        "Item ID",
        "item_id"
      ])
    ).trim();

    const id = normalizarNomeCliente(idOriginal).replace(/_/g, "");

    if (!idOriginal || !id) continue;

    const custoProduto = numeroSeguro(
      obterValorColuna(row, [
        "custo_produto",
        "CUSTO_PRODUTO",
        "custo",
        "CUSTO",
        "custo produto",
        "Custo Produto",
        "valor",
        "VALOR",
        "preco_custo",
        "PRECO_CUSTO",
        "preço_custo",
        "Preço Custo",
        "custo unitario",
        "custo_unitario",
        "Custo Unitario"
      ])
    );

    const impostoPercentual = numeroSeguro(
      obterValorColuna(row, [
        "imposto_percentual",
        "IMPOSTO_PERCENTUAL",
        "imposto",
        "IMPOSTO",
        "imposto percentual",
        "Imposto Percentual",
        "aliquota",
        "ALIQUOTA",
        "alíquota",
        "Aliquota",
        "percentual_imposto",
        "PERCENTUAL_IMPOSTO"
      ])
    );

    const taxaFixa = numeroSeguro(
      obterValorColuna(row, [
        "taxa_fixa",
        "TAXA_FIXA",
        "taxa fixa",
        "Taxa Fixa",
        "taxa",
        "frete",
        "FRETE",
        "tarifa",
        "TARIFA",
        "custo_fixo",
        "CUSTO_FIXO"
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
  const rows = XLSX.utils.sheet_to_json(worksheet, {
    defval: "",
    raw: false
  });

  if (!rows.length) {
    throw new Error("A planilha está vazia");
  }

  const resultado = parsePlanilhaParaResultado(rows);

  if (!Object.keys(resultado).length) {
    throw new Error("Nenhum ID válido encontrado na planilha");
  }

  return resultado;
}

function driveDisponivel() {
  return !!drive && !!DRIVE_FOLDER_ID;
}

function driveListParamsBase() {
  return {
    supportsAllDrives: true,
    includeItemsFromAllDrives: true
  };
}

async function listarBasesDrivePermitidas(user) {
  if (!driveDisponivel()) return [];

  try {
    const response = await drive.files.list({
      q: `'${DRIVE_FOLDER_ID}' in parents and trashed=false`,
      fields: "files(id,name)",
      ...driveListParamsBase()
    });

    const files = response.data.files || [];

    return files
      .filter((file) => String(file.name || "").toLowerCase().endsWith(".json"))
      .map((file) => {
        const nomeSemExt = String(file.name || "").replace(/\.json$/i, "");
        const slug = normalizarNomeCliente(nomeSemExt);

        return {
          id: slug,
          nome: nomeSemExt,
          nomeExibicao: nomeSemExt,
          slug,
          tipo: "drive",
          fileId: file.id,
          fileName: file.name
        };
      })
      .filter((base) => userPodeAcessarBase(user, base.slug));
  } catch (error) {
    console.error("[DRIVE] erro ao listar bases:", error.message);
    return [];
  }
}

async function listarBasesPermitidasDoUsuario(user) {
  const locais = listarPastasClientes().map((slug) => ({
    id: slug,
    nome: slug,
    nomeExibicao: slug,
    slug,
    tipo: "local"
  }));

  const driveBases = await listarBasesDrivePermitidas(user);
  const mapa = new Map();

  for (const item of locais) {
    mapa.set(item.slug, item);
  }

  for (const item of driveBases) {
    if (!mapa.has(item.slug)) {
      mapa.set(item.slug, item);
    } else {
      const atual = mapa.get(item.slug);
      mapa.set(item.slug, {
        ...atual,
        ...item,
        tipo: "local+drive"
      });
    }
  }

  if (isAdmin(user)) {
    return Array.from(mapa.values()).sort((a, b) =>
      String(a.slug).localeCompare(String(b.slug), "pt-BR")
    );
  }

  const permitidas = Array.isArray(user.bases_permitidas)
    ? user.bases_permitidas.map((b) => normalizarNomeCliente(b)).filter(Boolean)
    : [];

  return Array.from(mapa.values())
    .filter((item) => permitidas.includes(item.slug))
    .sort((a, b) => String(a.slug).localeCompare(String(b.slug), "pt-BR"));
}

async function obterArquivoDrivePorSlug(user, slug) {
  const bases = await listarBasesDrivePermitidas(user);
  const normalizado = normalizarNomeCliente(slug);
  return bases.find((b) => b.slug === normalizado) || null;
}

function lerBaseLocal(cliente) {
  try {
    const jsonPath = getCaminhoCustosCliente(cliente);

    if (!fs.existsSync(jsonPath)) {
      return null;
    }

    const raw = fs.readFileSync(jsonPath, "utf8");

    if (!raw.trim()) {
      return null;
    }

    return JSON.parse(raw);
  } catch (error) {
    console.error("[LOCAL] erro ao ler base local:", cliente, error.message);
    return null;
  }
}

async function lerBaseDrivePorSlug(user, slug) {
  if (!driveDisponivel()) return null;

  const arquivo = await obterArquivoDrivePorSlug(user, slug);

  if (!arquivo?.fileId) {
    return null;
  }

  const response = await drive.files.get(
    {
      fileId: arquivo.fileId,
      alt: "media",
      supportsAllDrives: true
    },
    {
      responseType: "stream"
    }
  );

  const chunks = [];

  await new Promise((resolve, reject) => {
    response.data.on("data", (chunk) => chunks.push(chunk));
    response.data.on("end", resolve);
    response.data.on("error", reject);
  });

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return null;

  return JSON.parse(raw);
}

async function obterBasePorSlug(user, slug) {
  const normalizado = normalizarNomeCliente(slug);

  if (!normalizado) return null;

  if (!userPodeAcessarBase(user, normalizado)) {
    const err = new Error("Você não tem permissão para acessar esta base");
    err.statusCode = 403;
    throw err;
  }

  const dadosLocais = lerBaseLocal(normalizado);

  if (dadosLocais) {
    return {
      origem: "local",
      nome: normalizado,
      nomeExibicao: normalizado,
      dados: dadosLocais
    };
  }

  if (driveDisponivel()) {
    try {
      const dadosDrive = await lerBaseDrivePorSlug(user, normalizado);
      if (dadosDrive) {
        return {
          origem: "drive",
          nome: normalizado,
          nomeExibicao: normalizado,
          dados: dadosDrive
        };
      }
    } catch (error) {
      console.error("[BASE] erro ao ler Drive:", error.message);
    }
  }

  return null;
}

async function salvarBaseNoDrive(cliente, dados) {
  if (!driveDisponivel()) return null;

  const nomeArquivo = `${cliente}.json`;
  const nomeArquivoEscapado = nomeArquivo.replace(/'/g, "\\'");
  const jsonBuffer = Buffer.from(JSON.stringify(dados, null, 2), "utf8");

  const existentes = await drive.files.list({
    q: `'${DRIVE_FOLDER_ID}' in parents and trashed=false and name='${nomeArquivoEscapado}'`,
    fields: "files(id,name)",
    ...driveListParamsBase()
  });

  const existente = (existentes.data.files || [])[0];

  let response;

  if (existente) {
    response = await drive.files.update({
      fileId: existente.id,
      media: {
        mimeType: "application/json",
        body: Readable.from(jsonBuffer)
      },
      fields: "id,name",
      supportsAllDrives: true
    });
  } else {
    response = await drive.files.create({
      requestBody: {
        name: nomeArquivo,
        parents: [DRIVE_FOLDER_ID]
      },
      media: {
        mimeType: "application/json",
        body: Readable.from(jsonBuffer)
      },
      fields: "id,name",
      supportsAllDrives: true
    });
  }

  return response.data;
}

// ==========================
// MULTER
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
  const portalPath = path.join(publicDir, "portal.html");
  const indexPath = path.join(publicDir, "index.html");

  if (fs.existsSync(portalPath)) {
    return res.sendFile(portalPath);
  }

  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }

  return res.json({
    ok: true,
    mensagem: "Servidor VenForce GO ativo"
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    mensagem: `VENFORCE GO STATUS OK ${PORT}`,
    driveConfigurado: !!DRIVE_FOLDER_ID,
    driveClient: !!drive
  });
});

// ==========================
// AUTH
// ==========================
app.post("/auth/login", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim();
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
    const valid = await validarSenha(senha, senhaSalva);

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
      usuario: sanitizarUser(user)
    });
  } catch (error) {
    console.error("Erro no /auth/login:", error);
    return res.status(500).json({
      ok: false,
      erro: error.message || "Erro interno no servidor"
    });
  }
});

app.get("/auth/me", authMiddleware, (req, res) => {
  try {
    return res.json({
      ok: true,
      usuario: sanitizarUser(req.user)
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      erro: error.message || "Erro ao validar sessão"
    });
  }
});

// ==========================
// ALTERAR SENHA
// ==========================
app.post("/change-password", authMiddleware, async (req, res) => {
  try {
    const { senhaAtual, novaSenha } = req.body;
    const email = req.user?.email;

    if (!email || !senhaAtual || !novaSenha) {
      return res.status(400).json({
        ok: false,
        erro: "Senha atual e nova senha são obrigatórios"
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
    const senhaSalva = user.password || user.senha || "";
    const senhaOk = await validarSenha(senhaAtual, senhaSalva);

    if (!senhaOk) {
      return res.status(401).json({
        ok: false,
        erro: "Senha atual incorreta"
      });
    }

    const novoHash = await bcrypt.hash(String(novaSenha), 10);

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
// BASES
// ==========================
app.get("/bases", authMiddleware, async (req, res) => {
  try {
    const bases = await listarBasesPermitidasDoUsuario(req.user);

    return res.json({
      ok: true,
      bases: bases.map((base) => ({
        id: base.slug,
        nome: base.nome,
        nomeExibicao: base.nomeExibicao || base.nome || base.slug,
        slug: base.slug,
        tipo: base.tipo || "local"
      }))
    });
  } catch (error) {
    console.error("Erro ao listar bases:", error);
    return res.status(500).json({
      ok: false,
      erro: error.message || "Erro ao listar bases"
    });
  }
});

app.get("/bases/:cliente", authMiddleware, async (req, res) => {
  try {
    const cliente = normalizarNomeCliente(req.params.cliente);
    const base = await obterBasePorSlug(req.user, cliente);

    if (!base) {
      return res.status(404).json({
        ok: false,
        erro: "Base não encontrada no Drive nem localmente"
      });
    }

    return res.json({
      ok: true,
      baseId: cliente,
      nomeExibicao: base.nomeExibicao || cliente,
      origem: base.origem,
      total: Object.keys(base.dados || {}).length,
      dados: base.dados
    });
  } catch (error) {
    console.error("Erro ao buscar base:", error);
    return res.status(error.statusCode || 500).json({
      ok: false,
      erro: error.message || "Erro ao buscar base"
    });
  }
});

// ==========================
// IMPORTAR EM BASE EXISTENTE
// ==========================
app.post("/importar-base", authMiddleware, upload.single("arquivo"), async (req, res) => {
  let filePath = null;

  try {
    console.log("=== /importar-base ===");
    console.log("req.body.nomeBase:", req.body?.nomeBase);
    console.log(
      "req.file:",
      req.file
        ? {
            originalname: req.file.originalname,
            filename: req.file.filename,
            path: req.file.path,
            size: req.file.size
          }
        : null
    );
    console.log("req.user:", req.user?.email);

    const nomeBaseOriginal = String(req.body.nomeBase || "").trim();
    const nomeBase = normalizarNomeCliente(nomeBaseOriginal);

    if (!nomeBaseOriginal || !nomeBase) {
      return res.status(400).json({
        ok: false,
        erro: "Nome da base é obrigatório"
      });
    }

    if (!req.user || req.user.ativo === false) {
      return res.status(403).json({
        ok: false,
        erro: "Usuário sem permissão para criar base"
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

    console.log("total ids importados:", Object.keys(resultado || {}).length);

    if (!resultado || !Object.keys(resultado).length) {
      return res.status(400).json({
        ok: false,
        erro: "Nenhum dado válido encontrado na planilha"
      });
    }

    const clienteDir = garantirPastaCliente(nomeBase);
    const jsonPath = path.join(clienteDir, "custos.json");
    fs.writeFileSync(jsonPath, JSON.stringify(resultado, null, 2), "utf8");

    // =========================================
    // LIBERAR A BASE PARA O USUÁRIO CRIADOR
    // =========================================
    const users = carregarUsers();

for (const user of users) {
  if (user.ativo === false) continue;

  if (!Array.isArray(user.bases_permitidas)) {
    user.bases_permitidas = [];
  }

  const basesNormalizadas = user.bases_permitidas.map(normalizarNomeCliente);

  if (!basesNormalizadas.includes(nomeBase)) {
    user.bases_permitidas.push(nomeBase);
  }
}

salvarUsers(users);

    let driveInfo = null;
    let aviso = null;

    try {
      if (driveDisponivel()) {
        driveInfo = await salvarBaseNoDrive(nomeBase, resultado);
      } else {
        aviso = "Drive não configurado. Base salva apenas localmente.";
      }
    } catch (erroDrive) {
      console.error("Erro ao enviar base para Drive:", erroDrive.message);
      aviso = "Base salva localmente, mas falhou envio para Drive.";
    }

    return res.json({
      ok: true,
      mensagem: "Planilha carregada com sucesso",
      baseId: nomeBase,
      nomeExibicao: nomeBaseOriginal,
      total: Object.keys(resultado).length,
      origem: driveInfo ? "local_e_drive" : "local",
      arquivoDrive: driveInfo?.name || null,
      fileId: driveInfo?.id || null,
      aviso
    });
  } catch (error) {
    console.error("Erro ao importar base:", error);
    return res.status(500).json({
      ok: false,
      erro: error.message || "Erro ao criar base"
    });
  } finally {
    removerArquivoSeExistir(filePath);
  }
});

// ==========================
// CRIAR NOVA BASE VIA POPUP
// ==========================
app.post("/importar-base", authMiddleware, upload.single("arquivo"), async (req, res) => {
  let filePath = null;

  try {
    const nomeBaseOriginal = String(req.body.nomeBase || "").trim();
    const nomeBase = normalizarNomeCliente(nomeBaseOriginal);

    if (!nomeBaseOriginal || !nomeBase) {
      return res.status(400).json({
        ok: false,
        erro: "Nome da base é obrigatório"
      });
    }

   if (!req.user || req.user.ativo === false) {
  return res.status(403).json({
    ok: false,
    erro: "Usuário sem permissão para criar base"
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

    if (!resultado || !Object.keys(resultado).length) {
      return res.status(400).json({
        ok: false,
        erro: "Nenhum dado válido encontrado na planilha"
      });
    }

    const clienteDir = garantirPastaCliente(nomeBase);
    const jsonPath = path.join(clienteDir, "custos.json");
    fs.writeFileSync(jsonPath, JSON.stringify(resultado, null, 2), "utf8");

    let driveInfo = null;
    let aviso = null;

    try {
      if (driveDisponivel()) {
        driveInfo = await salvarBaseNoDrive(nomeBase, resultado);
      } else {
        aviso = "Drive não configurado. Base salva apenas localmente.";
      }
    } catch (erroDrive) {
      console.error("Erro ao enviar base para Drive:", erroDrive.message);
      aviso = "Base salva localmente, mas falhou envio para Drive.";
    }

    return res.json({
      ok: true,
      mensagem: "Planilha carregada com sucesso",
      baseId: nomeBase,
      nomeExibicao: nomeBaseOriginal,
      total: Object.keys(resultado).length,
      origem: driveInfo ? "local_e_drive" : "local",
      arquivoDrive: driveInfo?.name || null,
      fileId: driveInfo?.id || null,
      aviso
    });
  } catch (error) {
    console.error("Erro ao importar base:", error);
    return res.status(500).json({
      ok: false,
      erro: error.message || "Erro ao criar base"
    });
  } finally {
    removerArquivoSeExistir(filePath);
  }
});

// ==========================
// ROTAS DE DRIVE
// ==========================
app.get("/bases-drive", authMiddleware, async (req, res) => {
  try {
    const bases = await listarBasesDrivePermitidas(req.user);

    return res.json({
      ok: true,
      bases: bases.map((base) => ({
        id: base.slug,
        nome: base.nome,
        nomeExibicao: base.nomeExibicao || base.nome,
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

app.get("/bases-drive/:baseId", authMiddleware, async (req, res) => {
  try {
    const identificador = String(req.params.baseId || "").trim();
    const slug = normalizarNomeCliente(identificador);
    const base = await obterBasePorSlug(req.user, slug);

    if (!base) {
      return res.status(404).json({
        ok: false,
        erro: "Base não encontrada no Drive nem localmente"
      });
    }

    return res.json({
      ok: true,
      baseId: slug,
      nome: base.nome,
      nomeExibicao: base.nomeExibicao || base.nome || slug,
      origem: base.origem,
      total: Object.keys(base.dados || {}).length,
      dados: base.dados
    });
  } catch (error) {
    console.error("Erro ao buscar base no Drive/local:", error);
    return res.status(error.statusCode || 500).json({
      ok: false,
      erro: error.message || "Erro ao buscar base"
    });
  }
});

// ==========================
// ROTA LEGADA
// ==========================
app.get("/api/custos/:cliente", async (req, res) => {
  try {
    const email = String(req.query.email || "").trim();
    const cliente = normalizarNomeCliente(req.params.cliente);

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

    const base = await obterBasePorSlug(user, cliente);

    if (!base) {
      return res.status(404).json({
        ok: false,
        erro: "Cliente ou custos.json não encontrado"
      });
    }

    return res.json({
      ok: true,
      cliente,
      origem: base.origem,
      data: base.dados,
      nomeExibicao: base.nomeExibicao || cliente
    });
  } catch (error) {
    console.error("Erro ao buscar custos:", error);
    return res.status(error.statusCode || 500).json({
      ok: false,
      erro: error.message || "Erro ao buscar custos do cliente"
    });
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
      erro: error.message || "Erro interno do servidor"
    });
  }

  next();
});

// ==========================
// START
// ==========================
app.listen(PORT, () => {
  console.log(`Servidor VenForce GO rodando em http://localhost:${PORT}`);
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
  console.log(`Drive client ativo: ${!!drive}`);
});
add callback route
