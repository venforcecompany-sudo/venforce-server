const STORAGE_KEY = "vf-token";
const API_BASE = "https://venforce-server.onrender.com";

// ─── Destino pós-login por role ───
// F1.3 — a home dos papéis internos era a Carteira (MASTER_SPEC D2/§20.3).
// A Carteira saiu do Portal; o Painel de Contas é a carteira agrupada por
// Squad, global, e acessível a admin e aos papéis internos (user/membro/interno,
// ver server/services/painelContas/painelContasAcesso.js).
// seller e shopee_reviewer têm telas próprias e NÃO mudam.
function destinoPorRole(user) {
  const role = String(user?.role || "").toLowerCase();
  if (role === "seller") return "seller.html";
  if (role === "shopee_reviewer") return "cliente-operacao.html";
  return "painel-contas.html";
}

// ─── Redirect se já logado ───
if (localStorage.getItem(STORAGE_KEY)) {
  let usuarioSalvo = {};
  try { usuarioSalvo = JSON.parse(localStorage.getItem("vf-user") || "{}") || {}; } catch {}
  window.location.replace(destinoPorRole(usuarioSalvo));
}

document.getElementById("year").textContent = new Date().getFullYear();

// ─── Tabs ───
function switchTab(tab) {
  const isLogin = tab === "login";
  document.getElementById("login-form").style.display         = isLogin ? "" : "none";
  document.getElementById("alterar-senha-info").style.display = isLogin ? "none" : "";
  document.getElementById("tab-login").classList.toggle("active", isLogin);
  document.getElementById("tab-alterar-senha").classList.toggle("active", !isLogin);
  document.getElementById("brand-subtitle").textContent = isLogin
    ? "Acesse o painel administrativo"
    : "Altere sua senha com o administrador";
  hideAlert("error");
  hideAlert("success");
}

// ─── Alertas ───
function showAlert(type, msg) {
  const box = document.getElementById(`form-${type}`);
  document.getElementById(`form-${type}-msg`).textContent = msg;
  box.classList.add("show");
}
function hideAlert(type) {
  document.getElementById(`form-${type}`)?.classList.remove("show");
}
function hideAllAlerts() { hideAlert("error"); hideAlert("success"); }

// ─── Loading de botão ───
function setLoading(btnId, spinnerId, textId, loading, defaultText) {
  document.getElementById(btnId).disabled = loading;
  document.getElementById(textId).textContent = loading ? "Aguarde…" : defaultText;
  document.getElementById(spinnerId).style.display = loading ? "inline-block" : "none";
}

// ─── LOGIN ───
document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  hideAllAlerts();

  const email = document.getElementById("login-email").value.trim();
  const senha = document.getElementById("login-senha").value;

  if (!email || !senha) { showAlert("error", "Preencha todos os campos."); return; }

  setLoading("btn-login", "btn-login-spinner", "btn-login-text", true, "Entrar");

  try {
    const res  = await fetch(`${API_BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: senha }),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      showAlert("error", data?.erro || data?.message || "E-mail ou senha incorretos.");
      return;
    }

    if (!data?.token) { showAlert("error", "Resposta inválida do servidor."); return; }

    localStorage.setItem(STORAGE_KEY, data.token);
    localStorage.setItem("vf-user", JSON.stringify(data.user));
    // D12/D3 — login bem-sucedido limpa o contexto operacional ANTES do
    // redirect, para uma aba reaproveitada não herdar Cliente/Conta do
    // usuário anterior. Fonte única: vf-context.js (import dinâmico —
    // login.js continua script clássico, switchTab() precisa ficar global
    // para o onclick inline do HTML). Falha do módulo nunca bloqueia login.
    try {
      const { vfContext } = await import("./vf-context.js");
      vfContext.clearOperationalContext();
    } catch {}
    try {
      if (chrome?.runtime?.sendMessage) {
        chrome.runtime.sendMessage(
          undefined,
          { action: "VENFORCE_SET_TOKEN", token: data.token, user: data.user },
          () => void chrome.runtime.lastError
        );
      }
    } catch {}
    window.location.replace(destinoPorRole(data.user));
  } catch {
    showAlert("error", "Não foi possível conectar ao servidor.");
  } finally {
    setLoading("btn-login", "btn-login-spinner", "btn-login-text", false, "Entrar");
  }
});

