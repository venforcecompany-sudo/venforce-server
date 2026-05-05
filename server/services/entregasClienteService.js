const crypto = require("crypto");
const pool = require("../config/database");

const TIPOS_PERMITIDOS = new Set([
  "fechamento_mensal",
  "diagnostico_completo",
  "preview_precificacao",
  "relatorio_misto",
]);

function normalizarSlug(nome) {
  return String(nome || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function criarErroHttp(statusCode, payload) {
  const err = new Error(payload?.erro || "Erro");
  err.statusCode = statusCode;
  err.payload = payload;
  return err;
}

function gerarTokenPublico() {
  return crypto.randomBytes(32).toString("hex");
}

function buildPayloadPadrao({ tipo, titulo, periodo, cliente }) {
  return {
    versao: 1,
    tipo,
    titulo,
    periodo: periodo || null,
    cliente: cliente || null,
    cards: [],
    secoes: [],
    tabelas: [],
    graficos: [],
    conclusao: "",
    metadados: { geradoEm: new Date().toISOString() },
  };
}

function validarTipo(tipo) {
  const t = String(tipo || "").trim();
  if (!t) throw criarErroHttp(400, { ok: false, erro: "tipo é obrigatório." });
  if (!TIPOS_PERMITIDOS.has(t)) {
    throw criarErroHttp(400, {
      ok: false,
      erro:
        "tipo inválido. Permitidos: fechamento_mensal, diagnostico_completo, preview_precificacao, relatorio_misto",
    });
  }
  return t;
}

function validarTitulo(titulo) {
  const t = String(titulo || "").trim();
  if (!t) throw criarErroHttp(400, { ok: false, erro: "titulo é obrigatório." });
  return t;
}

function parseTimestampOrNull(v) {
  if (v === null || v === undefined || String(v).trim() === "") return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) {
    throw criarErroHttp(400, { ok: false, erro: "expires_at inválido." });
  }
  return d;
}

async function buscarClientePorSlugOuId({ clienteIdRaw, clienteSlugRaw }) {
  const clienteId = clienteIdRaw != null ? parseInt(clienteIdRaw, 10) : null;
  const clienteSlug = clienteSlugRaw != null ? normalizarSlug(clienteSlugRaw) : "";

  if (Number.isFinite(clienteId) && clienteId > 0) {
    const r = await pool.query(
      "SELECT id, slug, nome FROM clientes WHERE id = $1",
      [clienteId]
    );
    return r.rows[0] || null;
  }

  if (clienteSlug) {
    const r = await pool.query(
      "SELECT id, slug, nome FROM clientes WHERE slug = $1",
      [clienteSlug]
    );
    return r.rows[0] || null;
  }

  return null;
}

async function criarEntrega({ userId, body }) {
  const tipo = validarTipo(body?.tipo);
  const titulo = validarTitulo(body?.titulo);

  const periodoRaw = body?.periodo;
  const periodo =
    periodoRaw === null || periodoRaw === undefined || String(periodoRaw).trim() === ""
      ? null
      : String(periodoRaw).trim();

  const statusRaw = String(body?.status || "").trim().toLowerCase();
  const status = statusRaw ? statusRaw : "rascunho";

  const origemTipoRaw = body?.origem_tipo;
  const origemTipo =
    origemTipoRaw === null || origemTipoRaw === undefined || String(origemTipoRaw).trim() === ""
      ? null
      : String(origemTipoRaw).trim();

  const origemIdRaw = body?.origem_id;
  const origemIdParsed = origemIdRaw === null || origemIdRaw === undefined || origemIdRaw === ""
    ? null
    : parseInt(origemIdRaw, 10);
  const origemId = Number.isFinite(origemIdParsed) ? origemIdParsed : null;

  const expiresAt = parseTimestampOrNull(body?.expires_at);

  const cliente = await buscarClientePorSlugOuId({
    clienteIdRaw: body?.cliente_id,
    clienteSlugRaw: body?.cliente_slug,
  });

  const cliente_id = cliente ? cliente.id : null;
  const cliente_slug = cliente ? cliente.slug : (body?.cliente_slug ? normalizarSlug(body.cliente_slug) : null);
  const cliente_nome = cliente ? cliente.nome : (body?.cliente_nome ? String(body.cliente_nome).trim() : null);

  const payloadInput = body?.payload_json;
  const payloadVazio =
    payloadInput === null ||
    payloadInput === undefined ||
    (typeof payloadInput === "object" && !Array.isArray(payloadInput) && Object.keys(payloadInput || {}).length === 0);

  const payload_json = payloadVazio
    ? buildPayloadPadrao({
        tipo,
        titulo,
        periodo,
        cliente: cliente
          ? { id: cliente.id, slug: cliente.slug, nome: cliente.nome }
          : cliente_slug || cliente_nome
            ? { id: cliente_id, slug: cliente_slug, nome: cliente_nome }
            : null,
      })
    : payloadInput;

  const ins = await pool.query(
    `INSERT INTO entregas_cliente
      (tipo, cliente_id, cliente_slug, cliente_nome, titulo, periodo,
       status, publicado, payload_json, origem_tipo, origem_id, created_by, expires_at)
     VALUES
      ($1,$2,$3,$4,$5,$6,$7,false,$8,$9,$10,$11,$12)
     RETURNING
      id, tipo, cliente_id, cliente_slug, cliente_nome, titulo, periodo, status,
      token_publico, publicado, payload_json, origem_tipo, origem_id,
      created_by, created_at, updated_at, published_at, expires_at`,
    [
      tipo,
      cliente_id,
      cliente_slug,
      cliente_nome,
      titulo,
      periodo,
      status,
      payload_json,
      origemTipo,
      origemId,
      userId || null,
      expiresAt,
    ]
  );

  return { ok: true, entrega: ins.rows[0] };
}

async function listarEntregas({ query }) {
  const tipo = query?.tipo ? String(query.tipo).trim() : "";
  if (tipo && !TIPOS_PERMITIDOS.has(tipo)) {
    throw criarErroHttp(400, { ok: false, erro: "tipo inválido." });
  }

  const clienteSlug = query?.cliente_slug ? normalizarSlug(query.cliente_slug) : "";
  const clienteIdRaw = query?.cliente_id;
  const clienteIdParsed =
    clienteIdRaw === null || clienteIdRaw === undefined || String(clienteIdRaw).trim() === ""
      ? null
      : parseInt(clienteIdRaw, 10);
  const clienteId = Number.isFinite(clienteIdParsed) ? clienteIdParsed : null;

  const publicadoRaw = query?.publicado;
  const publicado =
    publicadoRaw === undefined || publicadoRaw === null || String(publicadoRaw).trim() === ""
      ? null
      : String(publicadoRaw).trim().toLowerCase() === "true";

  const limitRaw = parseInt(query?.limit, 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.max(limitRaw, 1), 500) : 100;

  const offsetRaw = parseInt(query?.offset, 10);
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;

  const where = [];
  const params = [];

  if (tipo) {
    params.push(tipo);
    where.push(`tipo = $${params.length}`);
  }
  if (clienteId !== null) {
    params.push(clienteId);
    where.push(`cliente_id = $${params.length}`);
  } else if (clienteSlug) {
    params.push(clienteSlug);
    where.push(`cliente_slug = $${params.length}`);
  }
  if (publicado !== null) {
    params.push(publicado);
    where.push(`publicado = $${params.length}`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const totalResult = await pool.query(
    `SELECT COUNT(*)::int AS total FROM entregas_cliente ${whereSql}`,
    params
  );

  params.push(limit);
  const limitIndex = params.length;
  params.push(offset);
  const offsetIndex = params.length;

  const result = await pool.query(
    `SELECT
        id, tipo, cliente_id, cliente_slug, cliente_nome, titulo, periodo, status,
        token_publico, publicado, origem_tipo, origem_id,
        created_by, created_at, updated_at, published_at, expires_at
       FROM entregas_cliente
       ${whereSql}
       ORDER BY created_at DESC
       LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
    params
  );

  return { ok: true, total: totalResult.rows[0]?.total || 0, entregas: result.rows };
}

async function buscarEntregaPorId({ idRaw }) {
  const id = parseInt(idRaw, 10);
  if (!Number.isFinite(id) || id <= 0) {
    throw criarErroHttp(400, { ok: false, erro: "id inválido." });
  }

  const r = await pool.query("SELECT * FROM entregas_cliente WHERE id = $1", [id]);
  if (!r.rows.length) throw criarErroHttp(404, { ok: false, erro: "Entrega não encontrada." });
  return { ok: true, entrega: r.rows[0] };
}

async function atualizarEntrega({ idRaw, body }) {
  const id = parseInt(idRaw, 10);
  if (!Number.isFinite(id) || id <= 0) {
    throw criarErroHttp(400, { ok: false, erro: "id inválido." });
  }

  const atual = await pool.query("SELECT * FROM entregas_cliente WHERE id = $1", [id]);
  if (!atual.rows.length) throw criarErroHttp(404, { ok: false, erro: "Entrega não encontrada." });

  const patches = [];
  const params = [];

  if (Object.prototype.hasOwnProperty.call(body || {}, "tipo")) {
    const tipo = validarTipo(body.tipo);
    params.push(tipo);
    patches.push(`tipo = $${params.length}`);
  }

  if (Object.prototype.hasOwnProperty.call(body || {}, "titulo")) {
    const titulo = validarTitulo(body.titulo);
    params.push(titulo);
    patches.push(`titulo = $${params.length}`);
  }

  if (Object.prototype.hasOwnProperty.call(body || {}, "periodo")) {
    const periodoRaw = body?.periodo;
    const periodo =
      periodoRaw === null || periodoRaw === undefined || String(periodoRaw).trim() === ""
        ? null
        : String(periodoRaw).trim();
    params.push(periodo);
    patches.push(`periodo = $${params.length}`);
  }

  if (Object.prototype.hasOwnProperty.call(body || {}, "payload_json")) {
    const payload = body?.payload_json;
    if (payload === null || payload === undefined || typeof payload !== "object" || Array.isArray(payload)) {
      throw criarErroHttp(400, { ok: false, erro: "payload_json inválido." });
    }
    params.push(payload);
    patches.push(`payload_json = $${params.length}`);
  }

  if (Object.prototype.hasOwnProperty.call(body || {}, "expires_at")) {
    const expiresAt = parseTimestampOrNull(body?.expires_at);
    params.push(expiresAt);
    patches.push(`expires_at = $${params.length}`);
  }

  if (Object.prototype.hasOwnProperty.call(body || {}, "status")) {
    const status = String(body?.status || "").trim();
    if (!status) throw criarErroHttp(400, { ok: false, erro: "status inválido." });
    params.push(status);
    patches.push(`status = $${params.length}`);
  }

  if (Object.prototype.hasOwnProperty.call(body || {}, "cliente_id") ||
      Object.prototype.hasOwnProperty.call(body || {}, "cliente_slug") ||
      Object.prototype.hasOwnProperty.call(body || {}, "cliente_nome")) {
    const cliente = await buscarClientePorSlugOuId({
      clienteIdRaw: body?.cliente_id,
      clienteSlugRaw: body?.cliente_slug,
    });

    const cliente_id = cliente ? cliente.id : null;
    const cliente_slug = cliente ? cliente.slug : (body?.cliente_slug ? normalizarSlug(body.cliente_slug) : null);
    const cliente_nome = cliente ? cliente.nome : (body?.cliente_nome ? String(body.cliente_nome).trim() : null);

    params.push(cliente_id);
    patches.push(`cliente_id = $${params.length}`);
    params.push(cliente_slug);
    patches.push(`cliente_slug = $${params.length}`);
    params.push(cliente_nome);
    patches.push(`cliente_nome = $${params.length}`);
  }

  if (!patches.length) {
    throw criarErroHttp(400, { ok: false, erro: "Nenhum campo para atualizar." });
  }

  patches.push(`updated_at = NOW()`);

  params.push(id);
  const r = await pool.query(
    `UPDATE entregas_cliente SET ${patches.join(", ")} WHERE id = $${params.length} RETURNING *`,
    params
  );

  return { ok: true, entrega: r.rows[0] };
}

async function publicarEntrega({ idRaw }) {
  const id = parseInt(idRaw, 10);
  if (!Number.isFinite(id) || id <= 0) {
    throw criarErroHttp(400, { ok: false, erro: "id inválido." });
  }

  const atual = await pool.query(
    "SELECT id, token_publico FROM entregas_cliente WHERE id = $1",
    [id]
  );
  if (!atual.rows.length) throw criarErroHttp(404, { ok: false, erro: "Entrega não encontrada." });

  const token = atual.rows[0].token_publico || gerarTokenPublico();

  const upd = await pool.query(
    `UPDATE entregas_cliente
        SET publicado = true,
            status = 'publicado',
            token_publico = $1,
            published_at = COALESCE(published_at, NOW()),
            updated_at = NOW()
      WHERE id = $2
      RETURNING *`,
    [token, id]
  );

  return { ok: true, entrega: upd.rows[0] };
}

async function despublicarEntrega({ idRaw }) {
  const id = parseInt(idRaw, 10);
  if (!Number.isFinite(id) || id <= 0) {
    throw criarErroHttp(400, { ok: false, erro: "id inválido." });
  }

  const atual = await pool.query("SELECT id FROM entregas_cliente WHERE id = $1", [id]);
  if (!atual.rows.length) throw criarErroHttp(404, { ok: false, erro: "Entrega não encontrada." });

  const upd = await pool.query(
    `UPDATE entregas_cliente
        SET publicado = false,
            status = 'rascunho',
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [id]
  );

  return { ok: true, entrega: upd.rows[0] };
}

async function excluirEntrega({ idRaw }) {
  const id = parseInt(idRaw, 10);
  if (!Number.isFinite(id) || id <= 0) {
    throw criarErroHttp(400, { ok: false, erro: "id inválido." });
  }

  const del = await pool.query("DELETE FROM entregas_cliente WHERE id = $1 RETURNING id", [id]);
  if (!del.rows.length) throw criarErroHttp(404, { ok: false, erro: "Entrega não encontrada." });
  return { ok: true };
}

async function buscarEntregaPublicaPorToken({ tokenRaw }) {
  const token = String(tokenRaw || "").trim();
  if (!token) throw criarErroHttp(400, { ok: false, erro: "token é obrigatório." });

  const r = await pool.query(
    `SELECT
        id, tipo, cliente_slug, cliente_nome, titulo, periodo,
        payload_json, publicado, created_at, updated_at, published_at, expires_at
       FROM entregas_cliente
      WHERE token_publico = $1
        AND publicado = true
        AND (expires_at IS NULL OR expires_at > NOW())
      LIMIT 1`,
    [token]
  );

  if (!r.rows.length) {
    throw criarErroHttp(404, { ok: false, erro: "Entrega não encontrada ou não publicada." });
  }

  return { ok: true, entrega: r.rows[0] };
}

module.exports = {
  criarEntrega,
  listarEntregas,
  buscarEntregaPorId,
  atualizarEntrega,
  publicarEntrega,
  despublicarEntrega,
  excluirEntrega,
  buscarEntregaPublicaPorToken,
};

