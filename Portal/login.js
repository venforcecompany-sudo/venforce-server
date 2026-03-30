const STORAGE_KEY = "vf-token";
const API_BASE = "https://venforce-server.onrender.com";

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

if (localStorage.getItem(STORAGE_KEY)) {
  window.location.replace("dashboard.html");
}

function showFormError(message) {
  alertMsg.textContent = message;
  alertBox.classList.add("show");
}

function hideFormError() {
  alertBox.classList.remove("show");
}

function setButtonLoading(isLoading) {
  btnLogin.disabled = isLoading;
  btnText.textContent = isLoading ? "Entrando…" : "Entrar";
  btnSpinner.style.display = isLoading ? "inline-block" : "none";
}

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

  if (!senhaInput.value) {
    senhaInput.classList.add("is-invalid");
    if (valid) showFormError("Preencha o campo de senha.");
    valid = false;
  }

  return valid;
}

form.addEventListener("submit", async function (e) {
  e.preventDefault();
  if (!validateFields()) return;

  setButtonLoading(true);
  hideFormError();

  try {
    const response = await fetch(`${API_BASE}/auth/login`, {   // ← rota correta
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: emailInput.value.trim(),
        password: senhaInput.value,                             // ← campo correto
      }),
    });

    let data = null;
    try { data = await response.json(); } catch {}

    if (!response.ok) {
      showFormError(data?.erro || data?.message || "E-mail ou senha incorretos.");
      setButtonLoading(false);
      return;
    }

    if (!data?.token) {
      showFormError("Resposta inválida: token não recebido.");
      setButtonLoading(false);
      return;
    }

    // Salva token E dados do usuário
    localStorage.setItem(STORAGE_KEY, data.token);
    localStorage.setItem("vf-user", JSON.stringify(data.user));
    window.location.replace("dashboard.html");

  } catch (err) {
    console.error("Erro no login:", err);
    showFormError("Não foi possível conectar ao servidor.");
    setButtonLoading(false);
  }
});

emailInput.addEventListener("input", () => { emailInput.classList.remove("is-invalid"); hideFormError(); });
senhaInput.addEventListener("input", () => { senhaInput.classList.remove("is-invalid"); hideFormError(); });
