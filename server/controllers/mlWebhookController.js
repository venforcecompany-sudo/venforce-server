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
 * tópicos `items` e `items_prices`, relê o anúncio no ML e atualiza o portal
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
  return enfileirarItem(itemId, String(notificacao.userId), deps);
}

// `items` (/items/MLB…) e `items_prices` (/items/MLB…/prices: preço ou promoção
// trocados direto no ML) mudam o anúncio; qualquer outro formato é ignorado —
// nunca se busca uma URL ou caminho arbitrário vindo do corpo da notificação.
function itemIdDaNotificacao(notificacao) {
  if (!notificacao || notificacao.userId == null) return null;
  const resource = notificacao.resource || "";
  let m = null;
  if (notificacao.topic === "items") m = /^\/items\/(MLB\d+)$/.exec(resource);
  else if (notificacao.topic === "items_prices") m = /^\/items\/(MLB\d+)\/prices$/.exec(resource);
  return m ? m[1] : null;
}

// Uma leitura por item de cada vez, sem perder o último aviso:
//  · aviso enquanto a leitura ainda está AGUARDANDO (atraso de 2 s, para o ML
//    convergir) é juntado a ela — vai ler o estado mais novo de qualquer jeito;
//  · aviso DURANTE a leitura marca uma releitura ao terminar (o que ela leu
//    pode já ser velho);
//  · leitura que falha (403 passageiro do ML, rede) é repetida até 3 vezes.
const ATRASO_LEITURA_MS = 2000;
const TENTATIVAS_LEITURA = 3;
const filaItens = new Map();
const dormir = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function enfileirarItem(itemId, mlUserId, deps = {}) {
  const atual = filaItens.get(itemId);
  if (atual) {
    if (atual.estado === "lendo") atual.repetir = true;
    return atual.fim;
  }
  const atraso = deps.atrasoMs ?? ATRASO_LEITURA_MS;
  const esperar = deps.esperar || dormir;
  const atualizar = deps.atualizarItem || atualizarItemNoPortal;
  const entrada = { estado: "aguardando", repetir: false, fim: null };
  entrada.fim = (async () => {
    try {
      do {
        entrada.repetir = false;
        entrada.estado = "aguardando";
        await esperar(atraso);
        entrada.estado = "lendo";
        await lerComTentativas(itemId, mlUserId, atualizar, esperar, atraso);
      } while (entrada.repetir);
    } finally {
      filaItens.delete(itemId);
    }
  })();
  filaItens.set(itemId, entrada);
  return entrada.fim;
}

async function lerComTentativas(itemId, mlUserId, atualizar, esperar, atraso) {
  for (let tentativa = 1; tentativa <= TENTATIVAS_LEITURA; tentativa += 1) {
    try {
      await atualizar({ itemId, mlUserId });
      return;
    } catch (err) {
      const ultima = tentativa === TENTATIVAS_LEITURA;
      console.error(
        "[ML webhook] falha ao atualizar o anúncio", itemId,
        `(tentativa ${tentativa}/${TENTATIVAS_LEITURA}):`, err?.message || err
      );
      if (ultima) return;
      await esperar(Math.max(atraso, 1) * tentativa);
    }
  }
}

// Relê o item no ML e grava no portal — só para anúncios que o portal já tem
// daquele vendedor. Lança se o ML não devolveu o item, para a leitura ser
// repetida. Carregado sob demanda para o recebimento continuar leve.
async function atualizarItemNoPortal({ itemId, mlUserId }) {
  const anunciosService = require("../services/meliAnuncios/meliAnunciosService");
  const syncService = require("../services/meliAnuncios/meliSyncService");
  const linhas = await anunciosService.localizarItemPorVendedorMl(itemId, mlUserId);
  for (const linha of linhas) {
    const r = await syncService.atualizarItensConhecidos({ clienteId: linha.cliente_id, itemIds: [itemId] });
    if (r && Array.isArray(r.falhas) && r.falhas.length) {
      throw new Error(r.falhas[0].motivo || "o Mercado Livre não devolveu o anúncio");
    }
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
