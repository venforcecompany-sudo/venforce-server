const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const pool = require("../config/database");

const JWT_SECRET = process.env.JWT_SECRET || "venforce_secret_local";

async function register(req, res) {
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
}

async function login(req, res) {
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
}

function me(req, res) {
  const u = req.user;
  res.json({ ok: true, user: { id: u.id, nome: u.nome, email: u.email, ativo: u.ativo, role: u.role } });
}

module.exports = { register, login, me };
