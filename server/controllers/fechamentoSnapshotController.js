// server/controllers/fechamentoSnapshotController.js
//
// Snapshot do fechamento (Financeiro V3). Autorização por CARTEIRA em toda
// rota: na escrita e na lista, o cliente do corpo/query; por `:id`, o cliente
// do próprio snapshot (nunca o que o request diz).

"use strict";

const service = require("../services/fechamentoSnapshot/fechamentoSnapshotService");
const repo = require("../repositories/fechamentoSnapshotRepository");
const { assertClienteNaCarteira, canAccessCliente } = require("../services/squads/authorizationService");
const { extrairIp } = require("../services/activityLogService");

function responderErro(res, err) {
  if (err?.payload && err?.statusCode) return res.status(err.statusCode).json(err.payload);
  const status = Number(err?.statusCode);
  if (Number.isFinite(status) && status >= 400 && status < 500) {
    const corpo = { ok: false, erro: err.message };
    if (err.code) corpo.code = err.code;
    return res.status(status).json(corpo);
  }
  console.error("[fechamento-snapshot]", err?.message);
  return res.status(500).json({ ok: false, erro: "Erro interno do servidor" });
}

function erroHttp(status, code, mensagem) {
  const e = new Error(mensagem);
  e.statusCode = status;
  e.code = code;
  return e;
}

function exigirRef(ref) {
  if (ref === undefined || ref === null || String(ref).trim() === "") {
    throw erroHttp(400, "CLIENTE_OBRIGATORIO", "Informe o cliente (cliente_slug).");
  }
  return ref;
}

// Snapshot por `:id` → cliente DELE → carteira do usuário.
async function autorizarPorSnapshot(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw erroHttp(400, "ID_INVALIDO", "id inválido.");
  const ident = await repo.buscarIdentidadeDoSnapshot(id);
  if (!ident) throw erroHttp(404, "SNAPSHOT_NAO_ENCONTRADO", "Snapshot não encontrado.");
  const ok = await canAccessCliente(req.user || {}, ident.cliente_id);
  if (!ok) throw erroHttp(403, "CLIENTE_FORA_DA_CARTEIRA", "Cliente fora da sua carteira.");
  return ident;
}

async function criar(req, res) {
  try {
    await assertClienteNaCarteira(req.user || {}, exigirRef(req.body?.clienteSlug));
    const r = await service.criarSnapshot({ user: req.user || {}, body: req.body || {}, ip: extrairIp(req) });
    return res.status(r.reaproveitado ? 200 : 201).json({ ok: true, snapshot: r.snapshot, reaproveitado: r.reaproveitado });
  } catch (err) {
    return responderErro(res, err);
  }
}

async function listar(req, res) {
  try {
    await assertClienteNaCarteira(req.user || {}, exigirRef(req.query?.cliente_slug ?? req.query?.clienteSlug));
    const snapshots = await service.listarSnapshots({ query: req.query || {} });
    return res.json({ ok: true, snapshots });
  } catch (err) {
    return responderErro(res, err);
  }
}

async function buscar(req, res) {
  try {
    await autorizarPorSnapshot(req);
    const snapshot = await service.buscarSnapshot({ id: req.params.id });
    return res.json({ ok: true, snapshot });
  } catch (err) {
    return responderErro(res, err);
  }
}

async function itens(req, res) {
  try {
    await autorizarPorSnapshot(req);
    const r = await service.listarItensDoSnapshot({ id: req.params.id, query: req.query || {} });
    return res.json({ ok: true, ...r });
  } catch (err) {
    return responderErro(res, err);
  }
}

async function baseAtual(req, res) {
  try {
    await autorizarPorSnapshot(req);
    const r = await service.conferirBaseAtual({ id: req.params.id });
    return res.json({ ok: true, ...r });
  } catch (err) {
    return responderErro(res, err);
  }
}

module.exports = { criar, listar, buscar, itens, baseAtual, autorizarPorSnapshot };
