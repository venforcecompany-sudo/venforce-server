/**
 * ============================================
 * VENFORCE — Dashboard
 * GET /bases com Bearer token; exibe nome, região e status
 * ============================================
 */

/** Mesma chave que login.js usa ao salvar o token após POST /login */
const STORAGE_KEY = "vf-token";

const API_BASE = "https://venforce-server.onrender.com";

// ─── DOM ───
const btnLogout = document.getElementById("btn-logout");
const btnRetry = document.getElementById("btn-retry");
const basesCount = document.getElementById("bases-count");
const basesTbody = document.getElementById("bases-tbody");
const stateLoading = document.getElementById("state-loading");
const stateTable = document.getElementById("state-table");
const stateEmpty = document.getElementById("state-empty");
const stateError = document.getElementById("state-error");
const errorMessage = document.getElementById("error-message");

// ─── Token ───

/**
 * Lê o token salvo no login. Se não existir, manda para a tela de login.
 */
function getTokenOrRedirect() {
  const token = localStorage.getItem(STORAGE_KEY);
  if (!token) {
    window.location.replace("index.html");
    return null;
  }
  return token;
}

const TOKEN = getTokenOrRedirect();

/** 401: sessão inválida → limpa storage e volta ao login */
function clearSessionAndGoLogin() {
  localStorage.removeItem(STORAGE_KEY);
  window.location.replace("index.html");
}

// ─── Estados da UI (apenas um visível por vez) ───

function showLoading() {
  stateLoading.style.display = "flex";
  stateTable.style.display = "none";
  stateEmpty.style.display = "none";
  stateError.style.display = "none";
}

function showTable() {
  stateLoading.style.display = "none";
  stateTable.style.display = "block";
  stateEmpty.style.display = "none";
  stateError.style.display = "none";
}

function showEmpty() {
  stateLoading.style.display = "none";
  stateTable.style.display = "none";
  stateEmpty.style.display = "block";
  stateError.style.display = "none";
  basesCount.style.display = "none";
}

function showError(message) {
  stateLoading.style.display = "none";
  stateTable.style.display = "none";
  stateEmpty.style.display = "none";
  stateError.style.display = "block";
  errorMessage.textContent = message;
}

// ─── API: lista de bases ───

/**
 * GET /bases com Authorization: Bearer <token>
 * Resposta esperada: { "bases": [ { id, nome, regiao, ativa, custo, imposto }, ... ] }
 */
async function loadBases() {
  if (!TOKEN) return;

  showLoading();

  try {
    const response = await fetch(`${API_BASE}/bases`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
    });

    if (response.status === 401) {
      clearSessionAndGoLogin();
      return;
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const result = await response.json();
    const bases = result.bases;

    if (!Array.isArray(bases)) {
      console.error("Resposta inesperada:", result);
      showError(
        'Resposta inválida: a API deve retornar { "bases": [ ... ] }.'
      );
      return;
    }

    renderBases(bases);
  } catch (err) {
    console.error("Erro ao carregar bases:", err);
    const msg =
      err.message && /^HTTP \d+/.test(err.message)
        ? `Erro do servidor (${err.message}). Tente novamente.`
        : "Não foi possível carregar as bases. Verifique sua conexão e se a API está em http://localhost:5000.";
    showError(msg);
  }
}

/**
 * Formata número como moeda BRL para exibição (valores vêm da API em base.custo / base.imposto)
 */
function formatarMoedaBR(valor) {
  if (valor === null || valor === undefined || valor === "") return "—";
  const n = Number(valor);
  if (Number.isNaN(n)) return "—";
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

/**
 * Preenche a tabela: nome, região, custo, imposto, status (base.ativa)
 */
function renderBases(bases) {
  basesTbody.innerHTML = "";

  if (bases.length === 0) {
    showEmpty();
    return;
  }

  basesCount.textContent = String(bases.length);
  basesCount.style.display = "inline-block";

  bases.forEach((base, index) => {
    const tr = document.createElement("tr");
    tr.classList.add("animate-fade-up");
    tr.style.animationDelay = `${index * 0.04}s`;

    const nome =
      base.nome != null && String(base.nome).trim() !== ""
        ? String(base.nome)
        : "—";
    const regiao =
      base.regiao != null && String(base.regiao).trim() !== ""
        ? String(base.regiao)
        : "—";

    const custoFmt = formatarMoedaBR(base.custo);
    const impostoFmt = formatarMoedaBR(base.imposto);

    const ativa = Boolean(base.ativa);
    const statusLabel = ativa ? "Ativa" : "Inativa";
    const statusClass = ativa ? "base-status--active" : "base-status--inactive";
    const statusHtml = `<span class="${statusClass}">${statusLabel}</span>`;

    tr.innerHTML = `
      <td style="color: var(--vf-text-l); font-family: var(--vf-mono); font-size: .8rem;">
        ${String(index + 1).padStart(2, "0")}
      </td>
      <td><strong>${escapeHTML(nome)}</strong></td>
      <td style="color: var(--vf-text-m); font-size: .875rem;">${escapeHTML(
        regiao
      )}</td>
      <td style="font-family: var(--vf-mono); font-size: .875rem;">${escapeHTML(
        custoFmt
      )}</td>
      <td style="font-family: var(--vf-mono); font-size: .875rem;">${escapeHTML(
        impostoFmt
      )}</td>
      <td>${statusHtml}</td>
    `;

    basesTbody.appendChild(tr);
  });

  showTable();
}

function escapeHTML(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ─── Ações ───

btnLogout.addEventListener("click", function () {
  localStorage.removeItem(STORAGE_KEY);
  window.location.replace("index.html");
});

btnRetry.addEventListener("click", function () {
  loadBases();
});

if (TOKEN) {
  loadBases();
}
