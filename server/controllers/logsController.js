const pool = require("../config/database");

async function listar(req, res) {
  try {
    const {
      user_id,
      acao,
      acao_prefix,
      status,
      de,
      ate,
      page = 1,
      limit = 50
    } = req.query;

    const userId = parseInt(user_id);
    const currentPage = Math.max(parseInt(page) || 1, 1);
    const pageLimit = Math.min(Math.max(parseInt(limit) || 50, 1), 200);
    const offset = (currentPage - 1) * pageLimit;

    const condicoes = [];
    const valores = [];
    let i = 1;

    if (!Number.isNaN(userId)) {
      condicoes.push(`user_id = $${i++}`);
      valores.push(userId);
    }

    if (typeof acao === "string" && acao.trim()) {
      condicoes.push(`acao = $${i++}`);
      valores.push(acao.trim());
    }

    if (typeof acao_prefix === "string" && acao_prefix.trim()) {
      condicoes.push(`acao LIKE $${i++}`);
      valores.push(`${acao_prefix.trim()}%`);
    }

    if (status === "sucesso" || status === "falha") {
      condicoes.push(`status = $${i++}`);
      valores.push(status);
    }

    if (typeof de === "string" && de.trim()) {
      condicoes.push(`created_at >= $${i++}`);
      valores.push(de.trim());
    }

    if (typeof ate === "string" && ate.trim()) {
      condicoes.push(`created_at <= $${i++}`);
      const ateNormalizado = /^\d{4}-\d{2}-\d{2}$/.test(ate.trim()) ? `${ate.trim()} 23:59:59` : ate.trim();
      valores.push(ateNormalizado);
    }

    const where = condicoes.length ? "WHERE " + condicoes.join(" AND ") : "";

    const result = await pool.query(
      `SELECT id, user_id, user_email, user_nome, acao, detalhes, ip, status, created_at
       FROM activity_logs ${where}
       ORDER BY created_at DESC
       LIMIT $${i++} OFFSET $${i++}`,
      [...valores, pageLimit, offset]
    );

    const total = await pool.query(
      `SELECT COUNT(*) FROM activity_logs ${where}`,
      valores
    );

    res.json({
      ok: true,
      logs: result.rows,
      total: parseInt(total.rows[0].count),
      page: currentPage,
      totalPages: Math.ceil(parseInt(total.rows[0].count) / pageLimit)
    });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
}

module.exports = { listar };
