// Portal/integracoes-externas.js
//
// Bancada técnica standalone (fora do Shell V3). Só mostra o estado REAL de
// GET /integracoes/matriz/status; as capacidades continuam "Pendente de
// contrato" até a matriz fornecer endpoints. Nenhum valor de segredo trafega.
import { vfApi } from "./vf-api.js";

export const SHOPEE_CAPACIDADES = [
  "Grant / autorização", "Status da autorização", "Lojas", "Pedidos", "Produtos",
  "Estoque", "Financeiro", "Promoções", "Callback", "Webhooks",
];
export const WHATSAPP_CAPACIDADES = [
  "Provider", "Autenticação", "Grupos", "Mensagens", "Histórico", "Eventos / Webhooks", "Relação grupo ↔ cliente",
];

// Puro: transforma a resposta da API no modelo exibido.
export function buildStatusModel(status) {
  const s = status && typeof status === "object" ? status : {};
  const contratoPendente = !s.shopee || s.shopee.externalContract !== "ready";
  return {
    api: { ok: s.baseUrlConfigured === true, label: s.baseUrlConfigured === true ? "Configurada" : "Não configurada" },
    auth: { ok: s.authenticationConfigured === true, label: s.authenticationConfigured === true ? "Configurada" : "Não configurada" },
    contrato: { ok: !contratoPendente, label: contratoPendente ? "Pendente" : "Disponível" },
  };
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function statusHtml({ ok, label }) {
  return `<span class="vf-status ${ok ? "is-success" : "is-warning"}">${esc(label)}</span>`;
}

export function renderSummary(model) {
  const item = (rotulo, m) => `<div><dt>${esc(rotulo)}</dt><dd>${statusHtml(m)}</dd></div>`;
  return item("API da matriz", model.api) + item("Autenticação", model.auth) + item("Contrato Shopee", model.contrato);
}

export function renderCapacidades(nomes) {
  return nomes
    .map((n) => `<tr><td>${esc(n)}</td><td>${statusHtml({ ok: false, label: "Pendente de contrato" })}</td></tr>`)
    .join("");
}

function boot() {
  const token = localStorage.getItem("vf-token");
  if (!token) { window.location.replace("index.html"); return; }
  let user = {};
  try { user = JSON.parse(localStorage.getItem("vf-user") || "{}"); } catch { user = {}; }
  // Mesmo padrão de callbacks.js; o backend (requireAdmin) segue sendo a autoridade.
  if (user.role !== "admin") { window.location.replace("painel-contas.html"); return; }

  const $ = (id) => document.getElementById(id);
  $("shopee-capacidades").innerHTML = renderCapacidades(SHOPEE_CAPACIDADES);
  $("whatsapp-capacidades").innerHTML = renderCapacidades(WHATSAPP_CAPACIDADES);

  async function carregar() {
    $("state-error").hidden = true;
    $("cards").hidden = true;
    $("state-loading").hidden = false;
    try {
      const status = await vfApi.get("/integracoes/matriz/status");
      if (status === null) return; // 401 → vf-api já redirecionou para o login
      $("shopee-summary").innerHTML = renderSummary(buildStatusModel(status));
      $("cards").hidden = false;
    } catch (err) {
      if (err && err.status === 403) { window.location.replace("painel-contas.html"); return; }
      $("state-error-msg").textContent = (err && err.message) || "Erro desconhecido.";
      $("state-error").hidden = false;
    } finally {
      $("state-loading").hidden = true;
    }
  }

  $("btn-retry").addEventListener("click", carregar);
  carregar();
}

if (typeof document !== "undefined" && document.getElementById("cards")) boot();
