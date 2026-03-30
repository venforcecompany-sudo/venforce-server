/**
 * ============================================
 * VENFORCE — Login Controller
 * Autenticação via POST /login e persistência do token
 * ============================================
 */

/** Chave EXATA no localStorage (deve ser a mesma em dashboard.js) */
const STORAGE_KEY = "vf-token";

// ─── Configuração da API ───
const API_BASE = "https://venforce-server.onrender.com";

// ─── Referências DOM ───
const form = document.getElementById("login-form");
const emailInput = document.getElementById("email");
const senhaInput = document.getElementById("senha");
const btnLogin = document.getElementById("btn-login");
const btnText = document.getElementById("btn-login-text");
const btnSpinner = document.getElementById("btn-login-spinner");
const alertBox = document.getElementById("login-error");
const alertMsg = document.getElementById("login-error-msg");
const yearSpan = document.getElementById("year");

yearSpan.textContent = new Date().getFullYear();

// Já autenticado → dashboard (mesma chave que o dashboard verifica)
if (localStorage.getItem(STORAGE_KEY)) {
  window.location.replace("dashboard.html");
}

// ─── UI: erro no formulário ───

function showFormError(message) {
  alertMsg.textContent = message;
  alertBox.classList.add("show");
}

function hideFormError() {
  alertBox.classList.remove("show");
}

/**
 * Loading no botão de entrar (desabilita e mostra spinner)
 */
function setButtonLoading(isLoading) {
  btnLogin.disabled = isLoading;
  btnText.textContent = isLoading ? "Entrando…" : "Entrar";
  btnSpinner.style.display = isLoading ? "inline-block" : "none";
}

// ─── Validação local ───

function validateFields() {
  let valid = true;

  emailInput.classList.remove("is-invalid");
  senhaInput.classList.remove("is-invalid");
  hideFormError();

  const email = emailInput.value.trim();
  if (!email) {
    emailInput.classList.add("is-invalid");
    showFormError("Preencha o campo de e-mail.");
    valid = false;
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    emailInput.classList.add("is-invalid");
    showFormError("Formato de e-mail inválido.");
    valid = false;
  }

  const senha = senhaInput.value;
  if (!senha) {
    senhaInput.classList.add("is-invalid");
    if (valid) showFormError("Preencha o campo de senha.");
    valid = false;
  }

  return valid;
}

/**
 * Extrai mensagem amigável do JSON de erro da API (ex.: { "erro": "..." })
 */
function messageFromErrorBody(data) {
  if (!data || typeof data !== "object") return null;
  return (
    data.erro ||
    data.message ||
    data.error ||
    (typeof data.msg === "string" ? data.msg : null)
  );
}

// ─── Submit: POST /login ───

form.addEventListener("submit", async function (e) {
  e.preventDefault();

  if (!validateFields()) return;

  setButtonLoading(true);
  hideFormError();

  const payload = {
    email: emailInput.value.trim(),
    senha: senhaInput.value,
  };

  try {
    const response = await fetch(`${API_BASE}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    let data = null;
    try {
      data = await response.json();
    } catch {
      // corpo não é JSON (ex.: servidor fora do ar com HTML)
    }

    if (!response.ok) {
      const msg =
        messageFromErrorBody(data) ||
        "E-mail ou senha incorretos.";
      showFormError(msg);
      setButtonLoading(false);
      return;
    }

    const token = data && data.token;
    if (!token || typeof token !== "string") {
      showFormError("Resposta inválida: servidor não enviou o token.");
      setButtonLoading(false);
      return;
    }

    // Sucesso: persiste token e só então redireciona
    localStorage.setItem(STORAGE_KEY, token);
    window.location.replace("dashboard.html");
  } catch (err) {
    console.error("Erro no login:", err);
    showFormError(
      "Não foi possível conectar ao servidor. Verifique se a API está em http://localhost:5000."
    );
    setButtonLoading(false);
  }
});

emailInput.addEventListener("input", () => {
  emailInput.classList.remove("is-invalid");
  hideFormError();
});

senhaInput.addEventListener("input", () => {
  senhaInput.classList.remove("is-invalid");
  hideFormError();
});
