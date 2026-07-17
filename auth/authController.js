const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

const clientsFile = path.join(__dirname, "..", "data", "clients.json");

function readClients() {
  try {
    if (!fs.existsSync(clientsFile)) {
      return [];
    }

    const raw = fs.readFileSync(clientsFile, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    console.error("Erro ao ler clients.json:", error);
    return [];
  }
}

function generateToken(user) {
  const secret = process.env.JWT_SECRET || "venforce_secret_local";

  return jwt.sign(
    {
      id: user.id,
      nome: user.nome,
      email: user.email,
      role: user.role || "user"
    },
    secret,
    { expiresIn: "7d" }
  );
}

async function login(req, res) {
  try {
    const { email, senha, password } = req.body || {};
    const senhaRecebida = senha || password || "";

    if (!email || !senhaRecebida) {
      return res.status(400).json({
        ok: false,
        erro: "Email e senha são obrigatórios"
      });
    }

    const clients = readClients();

    const user = clients.find(
      (item) =>
        String(item.email || "").toLowerCase() === String(email).toLowerCase()
    );

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

    let senhaValida = false;

    if (user.senha) {
      if (
        String(user.senha).startsWith("$2a$") ||
        String(user.senha).startsWith("$2b$") ||
        String(user.senha).startsWith("$2y$")
      ) {
        senhaValida = await bcrypt.compare(senhaRecebida, user.senha);
      } else {
        senhaValida = String(user.senha) === String(senhaRecebida);
      }
    }

    if (!senhaValida) {
      return res.status(401).json({
        ok: false,
        erro: "Senha inválida"
      });
    }

    const token = generateToken(user);

    return res.json({
      ok: true,
      token,
      user: {
        id: user.id,
        nome: user.nome,
        email: user.email,
        role: user.role || "user"
      }
    });
  } catch (error) {
    console.error("Erro no login:", error);
    return res.status(500).json({
      ok: false,
      erro: "Erro interno no login"
    });
  }
}

function me(req, res) {
  try {
    return res.json({
      ok: true,
      user: req.user
    });
  } catch (error) {
    console.error("Erro no /auth/me:", error);
    return res.status(500).json({
      ok: false,
      erro: "Erro ao validar sessão"
    });
  }
}

module.exports = {
  login,
  me
};