// server/controllers/mlWebhookController.js
// Recebimento de notificações/webhooks do Mercado Livre (orders_v2, items, etc.).
//
// Propositalmente separado de mlController.js: aqui não existe OAuth, state,
// code ou token — é só uma notificação HTTP que o Mercado Livre reenvia com
// retry se não receber 200 rapidamente. Por isso a rota sempre confirma o
// recebimento primeiro e só depois processa, sem nunca deixar uma falha de
// processamento virar erro HTTP numa resposta que já foi enviada.

const MAX_RESOURCE_LENGTH = 200;
const MAX_TOPIC_LENGTH = 80;
const MAX_DATE_LENGTH = 60;

function sanitizeText(value, maxLength) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

// user_id/application_id vêm como número na doc do ML, mas notificações reais
// já foram vistas com string — aceitamos os dois sem executar coerção solta.
function sanitizeIdentifier(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return value.trim();
  return null;
}

function sanitizeAttempts(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Extrai somente os campos conhecidos e seguros do corpo da notificação.
 * Nunca repassa o body inteiro adiante (nem para log, nem para persistência).
 * Retorna null se o corpo não for um objeto plano — nesse caso não há o que extrair.
 */
function extrairNotificacao(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;

  return {
    resource: sanitizeText(body.resource, MAX_RESOURCE_LENGTH),
    topic: sanitizeText(body.topic, MAX_TOPIC_LENGTH),
    userId: sanitizeIdentifier(body.user_id),
    applicationId: sanitizeIdentifier(body.application_id),
    attempts: sanitizeAttempts(body.attempts),
    sent: sanitizeText(body.sent, MAX_DATE_LENGTH),
    received: sanitizeText(body.received, MAX_DATE_LENGTH),
  };
}

/**
 * Processamento pós-confirmação. Registra metadados sanitizados e, para o
 * tópico `items` (/items/MLB…), relê o anúncio no ML e atualiza o portal
 * (status, estoque, preço) — só se o portal já tem o item daquele vendedor.
 * Os demais tópicos (orders_v2 etc.) seguem só registrados. Nunca busca uma
 * URL arbitrária vinda do corpo da notificação.
 */
async function processarNotificacao(notificacao, deps = {}) {
  console.log(
    "[ML webhook] notificação recebida:",
    JSON.stringify({
      topic: notificacao.topic,
      resource: notificacao.resource,
      userId: notificacao.userId,
      applicationId: notificacao.applicationId,
      attempts: notificacao.attempts,
    })
  );

  const itemId = itemIdDaNotificacao(notificacao);
  if (!itemId) return;
  if (!deveProcessarItem(itemId, deps.agora ? deps.agora() : Date.now())) return;

  const atualizar = deps.atualizarItem || atualizarItemNoPortal;
  try {
    await atualizar({ itemId, mlUserId: String(notificacao.userId) });
  } catch (err) {
    console.error("[ML webhook] falha ao atualizar o anúncio", itemId, ":", err?.message || err);
  }
}

// Só o tópico `items` com resource no formato exato /items/MLB123 — nunca uma
// URL ou caminho arbitrário vindo do corpo da notificação.
function itemIdDaNotificacao(notificacao) {
  if (!notificacao || notificacao.topic !== "items" || notificacao.userId == null) return null;
  const m = /^\/items\/(MLB\d+)$/.exec(notificacao.resource || "");
  return m ? m[1] : null;
}

// O ML costuma disparar várias notificações seguidas do mesmo item (e reenvia
// com retry): uma releitura a cada janela basta, o resto é redundante.
const JANELA_ITEM_MS = 5000;
const ultimoProcessamento = new Map();
function deveProcessarItem(itemId, agora) {
  const ult = ultimoProcessamento.get(itemId);
  if (ult !== undefined && agora - ult < JANELA_ITEM_MS) return false;
  ultimoProcessamento.set(itemId, agora);
  if (ultimoProcessamento.size > 5000) {
    for (const [k, t] of ultimoProcessamento) {
      if (agora - t >= JANELA_ITEM_MS) ultimoProcessamento.delete(k);
    }
  }
  return true;
}

// Relê o item no ML e grava no portal — só para anúncios que o portal já tem
// daquele vendedor. Carregado sob demanda para o recebimento continuar leve.
async function atualizarItemNoPortal({ itemId, mlUserId }) {
  const anunciosService = require("../services/meliAnuncios/meliAnunciosService");
  const syncService = require("../services/meliAnuncios/meliSyncService");
  const linhas = await anunciosService.localizarItemPorVendedorMl(itemId, mlUserId);
  for (const linha of linhas) {
    await syncService.atualizarItensConhecidos({ clienteId: linha.cliente_id, itemIds: [itemId] });
  }
}

function receberNotificacaoMlController(req, res) {
  // Confirma o recebimento antes de qualquer processamento — o Mercado Livre
  // reenvia a notificação (retry) se não receber 200 rapidamente.
  res.status(200).json({ ok: true, recebido: true });

  setImmediate(() => {
    try {
      const notificacao = extrairNotificacao(req.body);
      if (!notificacao) {
        console.error("[ML webhook] payload inválido: corpo da notificação não é um objeto.");
        return;
      }

      Promise.resolve(processarNotificacao(notificacao)).catch((err) => {
        console.error("[ML webhook] erro no processamento assíncrono:", err?.message || err);
      });
    } catch (err) {
      // Nunca deixa o processamento posterior derrubar o processo Node.
      console.error("[ML webhook] erro ao processar notificação:", err?.message || err);
    }
  });
}

module.exports = {
  receberNotificacaoMlController,
  extrairNotificacao,
  processarNotificacao,
  itemIdDaNotificacao,
};
