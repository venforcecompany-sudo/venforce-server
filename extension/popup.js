const API_URL = "https://venforce-server.onrender.com";
const API_BASE = "https://venforce-server.onrender.com";

document.addEventListener("click", (e) => {
  e.stopPropagation();
});

document.addEventListener("DOMContentLoaded", async () => {
  // ==========================
  // ELEMENTOS
  // ==========================
  const loginView = document.getElementById("loginView");
  const appView = document.getElementById("appView");

  const scannerToggle = document.getElementById("scannerToggle");

  const emailInput = document.getElementById("email");
  const senhaInput = document.getElementById("senha");
  const btnLogin = document.getElementById("btnLogin");

  const statusLoginBox = document.getElementById("status");
  const statusAppBox = document.getElementById("statusApp");

  const usuarioNomeBox = document.getElementById("usuarioNome");
  const btnLogout = document.getElementById("btnLogout");

  const filtroBaseInput = document.getElementById("filtroBase");
  const basesSelect = document.getElementById("basesSelect");
  const btnAtualizarBases = document.getElementById("btnAtualizarBases");

  const btnUsarBase = document.getElementById("btnUsarBase");
  const btnDesabilitarBase = document.getElementById("btnDesabilitarBase");

  const novaBaseNomeInput = document.getElementById("novaBaseNome");
  const novaBaseArquivoInput = document.getElementById("novaBaseArquivo");
  const btnCriarBaseImportar = document.getElementById("btnCriarBaseImportar");
  const expandAllBtn = document.getElementById("expandAllBtn");
  const fileUploadText = document.getElementById("fileUploadText");
  const btnScan = document.getElementById("btnScan");
  const scanDebug = document.getElementById("scanDebug");
  const scanTotal = document.getElementById("scanTotal");
  const scanSaudavel = document.getElementById("scanSaudavel");
  const scanAtencao = document.getElementById("scanAtencao");
  const scanCritico = document.getElementById("scanCritico");
  const scanMcMedia = document.getElementById("scanMcMedia");

  if (novaBaseArquivoInput) {
    novaBaseArquivoInput.addEventListener("change", () => {
      const arquivo = novaBaseArquivoInput.files?.[0];
      if (fileUploadText) {
        fileUploadText.textContent = arquivo
          ? arquivo.name
          : "Escolher planilha (.xlsx, .csv)";
      }
    });
  }

  const fileInput = document.querySelector('input[type="file"]');

  if (fileInput) {
    fileInput.addEventListener("click", (e) => {
      e.stopPropagation();
    });
  }

  document.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
    });
  });

  let todasAsBases = [];

  // ==========================
  // STATUS
  // ==========================
  function setLoginStatus(message, color = "red") {
    if (!statusLoginBox) return;
    statusLoginBox.textContent = message || "";
    statusLoginBox.style.color = color;
  }

  function setAppStatus(message, color = "#2e7d32") {
    if (!statusAppBox) return;
    statusAppBox.textContent = message || "";
    statusAppBox.style.color = color;
  }

  function clearLoginStatus() {
    setLoginStatus("");
  }

  function clearAppStatus() {
    setAppStatus("");
  }

  // ==========================
  // STORAGE
  // ==========================
  function getStorage(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.get(keys, (result) => resolve(result));
    });
  }

  function setStorage(data) {
    return new Promise((resolve) => {
      chrome.storage.local.set(data, () => resolve());
    });
  }

  function removeStorage(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.remove(keys, () => resolve());
    });
  }

  // ==========================
  // ATIVAR/DESATIVAR SCANNER
  // ==========================
  function setScannerToggle(ativo) {
    if (scannerToggle) scannerToggle.checked = ativo;
  }

  async function carregarEstadoAtivo() {
    const { venforce_ativo } = await getStorage(["venforce_ativo"]);
    const ativo = venforce_ativo !== false;
    setScannerToggle(ativo);
    return ativo;
  }

  if (scannerToggle) {
    scannerToggle.addEventListener("change", async () => {
      const novo = scannerToggle.checked;
      await setStorage({ venforce_ativo: novo });
      setAppStatus(
        novo ? "Scanner ativado." : "Scanner desativado.",
        novo ? "#2e7d32" : "#666"
      );
    });
  }

  // ==========================
  // TELA
  // ==========================
  function showLoginView() {
    if (loginView) loginView.style.display = "block";
    if (appView) appView.style.display = "none";
    clearAppStatus();
  }

  function showAppView() {
    if (loginView) loginView.style.display = "none";
    if (appView) appView.style.display = "block";
    clearLoginStatus();
  }

  // ==========================
  // REQUEST
  // ==========================
  async function apiFetch(path, options = {}) {
    const { token } = await getStorage(["token"]);

    const headers = {
      ...(options.headers || {})
    };

    if (!(options.body instanceof FormData)) {
      headers["Content-Type"] = "application/json";
    }

    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    const response = await fetch(`${API_URL}${path}`, {
      ...options,
      headers
    });

    let data = {};
    try {
      data = await response.json();
    } catch (error) {
      data = {};
    }

    if (response.status === 401) {
      await removeStorage([
        "token",
        "usuario",
        "user",
        "venforce_user",
        "venforce_email",
        "email",
        "baseSelecionada"
      ]);
      showLoginView();
      throw new Error(data.erro || "Sessão expirada. Faça login novamente.");
    }

    if (!response.ok) {
      throw new Error(data.erro || data.message || `Erro HTTP ${response.status}`);
    }

    return data;
  }

  // ==========================
  // LOGIN
  // ==========================
  async function login(email, password) {
    clearLoginStatus();
    
console.log("LOGIN ENVIADO:", email, password);

    const response = await fetch(`${API_URL}/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        email,
        password
      })
    });

    let data = {};
    try {
      data = await response.json();
      console.log("RESPOSTA DO BACKEND:", data);
    } catch (error) {
      data = {};
    }

    if (!response.ok) {
      throw new Error(data.erro || data.message || "Falha no login");
    }

    if (!data.token) {
      throw new Error("Token não recebido no login");
    }

    const usuario = data.usuario || data.user || { email };

    await setStorage({
      token: data.token,
      usuario,
      user: usuario,
      venforce_user: usuario,
      venforce_email: usuario?.email || email,
      email: usuario?.email || email
    });

    return data;
  }

  async function logout() {
    await removeStorage([
      "token",
      "usuario",
      "user",
      "venforce_user",
      "venforce_email",
      "email",
      "baseSelecionada"
    ]);

    if (emailInput) emailInput.value = "";
    if (senhaInput) senhaInput.value = "";
    if (basesSelect) {
      basesSelect.innerHTML = `<option value="">Selecionar base</option>`;
    }
    if (filtroBaseInput) {
      filtroBaseInput.value = "";
    }
    if (novaBaseNomeInput) {
      novaBaseNomeInput.value = "";
    }
    if (novaBaseArquivoInput) {
      novaBaseArquivoInput.value = "";
    }

    todasAsBases = [];

    showLoginView();
    setLoginStatus("Você saiu da conta.", "#666");
  }

  // ==========================
  // USUÁRIO
  // ==========================
  async function preencherUsuario() {
    const storage = await getStorage(["usuario", "user", "venforce_user"]);
    const usuario = storage.usuario || storage.user || storage.venforce_user || null;

    if (!usuarioNomeBox) return;

    if (usuario?.nome) {
      usuarioNomeBox.textContent = usuario.nome;
    } else if (usuario?.email) {
      usuarioNomeBox.textContent = usuario.email;
    } else {
      usuarioNomeBox.textContent = "Usuário logado";
    }

    const avatar = document.getElementById("userAvatar");
    if (avatar) {
      const nome = usuario?.nome || usuario?.email || "V";
      avatar.textContent = nome.charAt(0).toUpperCase();
    }
  }

  // ==========================
  // BASES
  // ==========================
  function normalizarListaBases(payload) {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.bases)) return payload.bases;
    if (Array.isArray(payload?.dados)) return payload.dados;
    if (Array.isArray(payload?.resultado)) return payload.resultado;
    return [];
  }

function getBaseValue(base) {
  return (
    base?.slug ||
    base?.id ||
    base?.nome ||
    base?.baseId ||
    base?.value ||
    ""
  );
}

  function getBaseLabel(base) {
    return (
      base?.nomeExibicao ||
      base?.nome ||
      base?.titulo ||
      base?.label ||
      getBaseValue(base) ||
      "Base sem nome"
    );
  }

  function renderBases(lista) {
    if (!basesSelect) return;

    basesSelect.innerHTML = `<option value="">Selecionar base</option>`;

    if (!lista.length) {
      basesSelect.innerHTML = `<option value="">Nenhuma base encontrada</option>`;
      return;
    }

    lista.forEach((base) => {
      const option = document.createElement("option");
      option.value = getBaseValue(base);
      option.textContent = getBaseLabel(base);
      basesSelect.appendChild(option);
    });
  }

  async function aplicarBaseSalva() {
    const { baseSelecionada } = await getStorage(["baseSelecionada"]);

    if (!basesSelect) return;

    if (!baseSelecionada) {
      setAppStatus("Selecione uma base para continuar.", "#666");
      return;
    }

    const existe = [...basesSelect.options].some(
      (option) => option.value === baseSelecionada
    );

    if (existe) {
      basesSelect.value = baseSelecionada;
      const texto =
        basesSelect.options[basesSelect.selectedIndex]?.textContent || baseSelecionada;
      setAppStatus(`Base atual: ${texto}`, "#2e7d32");
    } else {
      setAppStatus("Selecione uma base para continuar.", "#666");
    }
  }

  async function carregarBases() {
    if (!basesSelect) return;

    setAppStatus("Carregando bases...", "#666");
    basesSelect.disabled = true;
    basesSelect.innerHTML = `<option value="">Carregando...</option>`;

    try {
      const response = await apiFetch("/bases");
      todasAsBases = normalizarListaBases(response);

      renderBases(todasAsBases);

      if (!todasAsBases.length) {
        basesSelect.disabled = false;
        setAppStatus("Nenhuma base encontrada para este usuário.", "#c62828");
        return;
      }

      await aplicarBaseSalva();
      basesSelect.disabled = false;
    } catch (error) {
      console.error("[VenForce] erro ao carregar bases:", error);
      basesSelect.innerHTML = `<option value="">Erro ao carregar bases</option>`;
      basesSelect.disabled = false;
      setAppStatus(error.message || "Erro ao carregar bases.", "#c62828");
    }
  }

  async function salvarBaseSelecionada() {
    const base = basesSelect?.value || "";

    if (!base) {
      setAppStatus("Selecione uma base antes de continuar.", "#c62828");
      return false;
    }

    await setStorage({ baseSelecionada: base });

    const textoBase =
      basesSelect.options[basesSelect.selectedIndex]?.textContent || base;

    setAppStatus(`Base selecionada: ${textoBase}`, "#2e7d32");
    return true;
  }

  function filtrarBases() {
    const termo = String(filtroBaseInput?.value || "").trim().toLowerCase();

    if (!termo) {
      renderBases(todasAsBases);
      aplicarBaseSalva();
      return;
    }

    const filtradas = todasAsBases.filter((base) =>
      getBaseLabel(base).toLowerCase().includes(termo)
    );

    renderBases(filtradas);
  }

  // ==========================
  // IMPORTAR PLANILHA
  // ==========================
  async function importarPlanilha() {
    // Mantida por compatibilidade (não usada no fluxo atual)
  }

  async function criarBaseEImportar() {
    const nomeBase = String(novaBaseNomeInput?.value || "").trim();
    const arquivo = novaBaseArquivoInput?.files?.[0];

    if (btnCriarBaseImportar) {
      btnCriarBaseImportar.disabled = true;
      btnCriarBaseImportar.textContent = "Importando...";
    }

    if (!nomeBase) {
      setAppStatus("Informe o nome da base.", "#c62828");
      return;
    }

    if (!arquivo) {
      setAppStatus("Selecione uma planilha para criar a base.", "#c62828");
      return;
    }

    const formData = new FormData();
    formData.append("arquivo", arquivo);
    formData.append("nomeBase", nomeBase);

    setAppStatus("Criando base e importando planilha...", "#666");

    try {
      const { token } = await chrome.storage.local.get("token");

      async function enviarImportacao(confirmar) {
        const fd = new FormData();
        fd.append("arquivo", arquivo);
        fd.append("nomeBase", nomeBase);
        if (confirmar) fd.append("confirmar", "true");

        const res = await fetch(`${API_BASE}/importar-base`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`
          },
          body: fd
        });

        const text = await res.text();
        let response = {};
        try {
          response = text ? JSON.parse(text) : {};
        } catch (e) {
          console.error("Resposta não JSON:", text);
          throw new Error("Resposta do servidor não é JSON (verifique a rota /importar-base).");
        }

        if (!res.ok) {
          throw new Error(
            response?.erro || response?.message || response?.detalhe || `Erro HTTP ${res.status}`
          );
        }

        return response;
      }

      function mostrarPreviewModal(payload) {
        return new Promise((resolve) => {
          const overlay = document.createElement("div");
          overlay.style.position = "fixed";
          overlay.style.inset = "0";
          overlay.style.background = "rgba(0,0,0,0.35)";
          overlay.style.zIndex = "9999";
          overlay.style.display = "flex";
          overlay.style.alignItems = "center";
          overlay.style.justifyContent = "center";
          overlay.addEventListener("click", (e) => e.stopPropagation());

          const card = document.createElement("div");
          card.style.width = "92%";
          card.style.maxWidth = "360px";
          card.style.background = "#fff";
          card.style.borderRadius = "14px";
          card.style.padding = "14px";
          card.style.boxShadow = "0 12px 30px rgba(0,0,0,0.18)";
          card.style.fontFamily = "Arial, Helvetica, sans-serif";

          const titulo = document.createElement("div");
          titulo.textContent = "Pré-visualização da importação";
          titulo.style.fontWeight = "700";
          titulo.style.marginBottom = "10px";

          const meta = document.createElement("div");
          meta.style.fontSize = "12px";
          meta.style.color = "#555";
          meta.style.marginBottom = "10px";
          meta.textContent = `Total linhas: ${payload.total || 0} • IDs detectados: ${payload.idsDetectados || 0} • Coluna: ${payload.colunaId || "—"}`;

          const tableWrap = document.createElement("div");
          tableWrap.style.maxHeight = "220px";
          tableWrap.style.overflow = "auto";
          tableWrap.style.border = "1px solid #eee";
          tableWrap.style.borderRadius = "10px";

          const table = document.createElement("table");
          table.style.width = "100%";
          table.style.borderCollapse = "collapse";
          table.style.fontSize = "12px";

          const thead = document.createElement("thead");
          const headRow = document.createElement("tr");
          ["ID", "Custo", "Imposto", "Taxa"].forEach((h) => {
            const th = document.createElement("th");
            th.textContent = h;
            th.style.textAlign = "left";
            th.style.padding = "8px";
            th.style.borderBottom = "1px solid #eee";
            th.style.background = "#fafafa";
            headRow.appendChild(th);
          });
          thead.appendChild(headRow);

          const tbody = document.createElement("tbody");
          (payload.preview || []).forEach((r) => {
            const tr = document.createElement("tr");
            const cols = [
              r?.id ?? "",
              r?.custo_produto ?? "",
              r?.imposto_percentual ?? "",
              r?.taxa_fixa ?? ""
            ];
            cols.forEach((v) => {
              const td = document.createElement("td");
              td.textContent = String(v);
              td.style.padding = "8px";
              td.style.borderBottom = "1px solid #f2f2f2";
              tr.appendChild(td);
            });
            tbody.appendChild(tr);
          });

          table.appendChild(thead);
          table.appendChild(tbody);
          tableWrap.appendChild(table);

          const actions = document.createElement("div");
          actions.style.display = "flex";
          actions.style.gap = "8px";
          actions.style.marginTop = "12px";

          const cancelar = document.createElement("button");
          cancelar.type = "button";
          cancelar.textContent = "Cancelar";
          cancelar.className = "secondary";
          cancelar.style.flex = "1";
          cancelar.addEventListener("click", (e) => {
            e.stopPropagation();
            overlay.remove();
            resolve(false);
          });

          const confirmar = document.createElement("button");
          confirmar.type = "button";
          confirmar.textContent = "Confirmar importação";
          confirmar.style.flex = "1";
          confirmar.addEventListener("click", (e) => {
            e.stopPropagation();
            overlay.remove();
            resolve(true);
          });

          actions.appendChild(cancelar);
          actions.appendChild(confirmar);

          card.appendChild(titulo);
          card.appendChild(meta);
          card.appendChild(tableWrap);
          card.appendChild(actions);

          overlay.appendChild(card);
          document.body.appendChild(overlay);
        });
      }

      const previewResponse = await enviarImportacao(false);
      if (previewResponse?.preview) {
        const ok = await mostrarPreviewModal(previewResponse);
        if (!ok) {
          setAppStatus("Importação cancelada.", "#666");
          return;
        }
      }

      const response = await enviarImportacao(true);

      await setStorage({ baseSelecionada: nomeBase });
      await carregarBases();
      await aplicarBaseSalva();

      setAppStatus(
        response?.mensagem
          ? `${response.mensagem} (${response.total || 0} IDs)`
          : "Base criada e planilha importada com sucesso.",
        "#2e7d32"
      );

      if (novaBaseNomeInput) novaBaseNomeInput.value = "";
      if (novaBaseArquivoInput) novaBaseArquivoInput.value = "";
      if (fileUploadText) fileUploadText.textContent = "Escolher planilha (.xlsx, .csv)";
    } catch (error) {
      console.error("[VenForce] erro ao criar base/importar planilha:", error);
      setAppStatus(error.message || "Erro ao criar base/importar planilha.", "#c62828");
    } finally {
      if (btnCriarBaseImportar) {
        btnCriarBaseImportar.disabled = false;
        btnCriarBaseImportar.textContent = "Criar base e importar";
      }
    }
  }

  async function escanearPagina() {
    if (!btnScan) return;

    try {
      btnScan.disabled = true;
      btnScan.textContent = "Escaneando...";
      if (scanDebug) scanDebug.style.display = "none";
      setAppStatus("", "");

      // 1. Verifica se está na página certa
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];

      if (!tab?.id || !/mercadolivre\.com\.br/i.test(tab.url || "")) {
        setAppStatus("Abra a página de anúncios do Mercado Livre primeiro.", "#c62828");
        return;
      }

      // 2. Expande todos os cards primeiro
      try {
        await chrome.tabs.sendMessage(tab.id, { action: "VENFORCE_EXPAND_ALL" });
        await new Promise((r) => setTimeout(r, 1200));
      } catch (e) {
        setAppStatus("Recarregue a página do ML (F5) e tente novamente.", "#c62828");
        return;
      }

      try {
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: "MAIN",
          func: () => {
            const overlay = document.getElementById("venforce-overlay-root");
            const root = overlay && overlay.shadowRoot ? overlay.shadowRoot : null;
            if (!root) return { ok: false, erro: "Overlay não encontrado." };

            const boxes = root.querySelectorAll("[data-venforce-key]");
            const mcs = [];
            boxes.forEach((box) => {
              const cache = box.__venforceCache;
              const mc = cache?.dados?.mc;
              if (typeof mc === "number" && Number.isFinite(mc)) mcs.push(mc);
            });

            if (!mcs.length) return { ok: false, erro: "Nenhum anúncio detectado." };

            const total = mcs.length;
            const saudaveis = mcs.filter((mc) => mc >= 10).length;
            const atencao = mcs.filter((mc) => mc >= 6 && mc < 10).length;
            const criticos = mcs.filter((mc) => mc < 6).length;
            const mcMedia = mcs.reduce((s, v) => s + v, 0) / total;

            return { ok: true, total, saudaveis, atencao, criticos, mcMedia };
          }
        });

        if (!result?.ok) {
          setAppStatus(
            result?.erro ||
              "Nenhum anúncio detectado. Role a página para carregar os anúncios.",
            "#c62828"
          );
          return;
        }

        // 4. Atualiza o painel de debug
        if (scanTotal) scanTotal.textContent = result.total;
        if (scanSaudavel) scanSaudavel.textContent = result.saudaveis;
        if (scanAtencao) scanAtencao.textContent = result.atencao;
        if (scanCritico) scanCritico.textContent = result.criticos;
        if (scanMcMedia) scanMcMedia.textContent = `MC médio: ${result.mcMedia.toFixed(2)}%`;
        if (scanDebug) scanDebug.style.display = "block";

        setAppStatus(`${result.total} anúncios escaneados com sucesso.`, "#2e7d32");
        return;
      } catch (e) {
        console.error("[VenForce] erro ao escanear:", e);
        setAppStatus(
          "Não foi possível ler os dados da página. Recarregue (F5) e tente novamente.",
          "#c62828"
        );
        return;
      }
    } catch (error) {
      console.error("[VenForce] erro ao escanear:", error);
      setAppStatus(error.message || "Erro ao escanear.", "#c62828");
    } finally {
      if (btnScan) {
        btnScan.disabled = false;
        btnScan.textContent = "▶ Escanear página";
      }
    }
  }

  if (btnScan) {
    btnScan.addEventListener("click", async () => {
      await escanearPagina();
    });
  }

  // ==========================
  // RESTAURAR SESSÃO
  // ==========================
  async function restaurarSessao() {
    const { token } = await getStorage(["token"]);

    if (!token) {
      showLoginView();
      return;
    }

    try {
      await apiFetch("/auth/me");
      showAppView();
      await preencherUsuario();
      await carregarBases();
    } catch (error) {
      console.error("[VenForce] erro ao restaurar sessão:", error);
      await removeStorage([
        "token",
        "usuario",
        "user",
        "venforce_user",
        "venforce_email",
        "email",
        "baseSelecionada"
      ]);
      showLoginView();
      setLoginStatus("Faça login para continuar.", "#666");
    }
  }

  // ==========================
  // EVENTOS
  // ==========================
  if (btnLogin) {
    btnLogin.addEventListener("click", async () => {
      const email = emailInput?.value?.trim() || "";
      const password = senhaInput?.value || "";

      if (!email || !password) {
        setLoginStatus("Preencha email e senha.", "red");
        return;
      }

      setLoginStatus("Entrando...", "#666");

      try {
        await login(email, password);
        showAppView();
        await preencherUsuario();
        await carregarBases();
      } catch (error) {
        console.error("[VenForce] erro no login:", error);
        setLoginStatus(error.message || "Erro ao fazer login.", "red");
      }
    });
  }

  if (senhaInput) {
    senhaInput.addEventListener("keydown", async (event) => {
      if (event.key !== "Enter") return;

      event.preventDefault();

      const email = emailInput?.value?.trim() || "";
      const password = senhaInput?.value || "";

      if (!email || !password) {
        setLoginStatus("Preencha email e senha.", "red");
        return;
      }

      setLoginStatus("Entrando...", "#666");

      try {
        await login(email, password);
        showAppView();
        await preencherUsuario();
        await carregarBases();
      } catch (error) {
        console.error("[VenForce] erro no login:", error);
        setLoginStatus(error.message || "Erro ao fazer login.", "red");
      }
    });
  }

  if (btnLogout) {
    btnLogout.addEventListener("click", async () => {
      try {
        await logout();
      } catch (error) {
        console.error("[VenForce] erro no logout:", error);
        setAppStatus("Erro ao sair da conta.", "#c62828");
      }
    });
  }

  if (btnAtualizarBases) {
    btnAtualizarBases.addEventListener("click", async () => {
      await carregarBases();
    });
  }

  if (btnUsarBase) {
    btnUsarBase.addEventListener("click", async () => {
      btnUsarBase.disabled = true;
      try {
        await salvarBaseSelecionada();
      } finally {
        btnUsarBase.disabled = false;
      }
    });
  }

  if (btnDesabilitarBase) {
    btnDesabilitarBase.addEventListener("click", async () => {
      const baseSelecionadaUI = basesSelect?.value || "";
      const baseSelecionadaStorage = (await getStorage(["baseSelecionada"]))
        ?.baseSelecionada;

      if (!baseSelecionadaUI) {
        setAppStatus("Selecione uma base antes de desabilitar.", "#c62828");
        return;
      }

      try {
        setAppStatus("Desabilitando base...", "#666");

        await apiFetch(`/bases/${encodeURIComponent(baseSelecionadaUI)}/desabilitar`, {
          method: "POST"
        });

        await carregarBases();

        const baseAtual =
          String(baseSelecionadaStorage || "") === String(baseSelecionadaUI || "")
            ? baseSelecionadaStorage
            : null;

        if (baseAtual !== null) {
          const novoBase =
            [...(basesSelect?.options || [])].find((opt) => opt.value)?.value || "";

          await setStorage({ baseSelecionada: novoBase });
          if (basesSelect) basesSelect.value = novoBase;

          if (novoBase) {
            const texto =
              basesSelect.options[basesSelect.selectedIndex]?.textContent || novoBase;
            setAppStatus(`Base desabilitada. Nova base: ${texto}`, "#2e7d32");
          } else {
            setAppStatus("Base desabilitada. Nenhuma base restante.", "#666");
          }
        } else {
          // Se você desabilitou outra base que não a atual, só avisamos.
          setAppStatus("Base desabilitada com sucesso.", "#2e7d32");
        }
      } catch (error) {
        console.error("[VenForce] erro ao desabilitar base:", error);
        setAppStatus(error.message || "Erro ao desabilitar base.", "#c62828");
      }
    });
  }

  const btnExcluirBase = document.getElementById("btnExcluirBase");

  if (btnExcluirBase) {
    btnExcluirBase.addEventListener("click", async () => {
      const baseSelecionadaUI = basesSelect?.value || "";

      if (!baseSelecionadaUI) {
        setAppStatus("Selecione uma base antes de excluir.", "#c62828");
        return;
      }

      const nomeBase =
        basesSelect.options[basesSelect.selectedIndex]?.textContent ||
        baseSelecionadaUI;

      if (
        !confirm(
          `Tem certeza que deseja EXCLUIR permanentemente a base "${nomeBase}"?\nEsta ação não pode ser desfeita.`
        )
      ) {
        return;
      }

      try {
        setAppStatus("Excluindo base...", "#666");
        btnExcluirBase.disabled = true;

        await apiFetch(`/bases/${encodeURIComponent(baseSelecionadaUI)}`, {
          method: "DELETE",
        });

        const { baseSelecionada } = await getStorage(["baseSelecionada"]);
        if (String(baseSelecionada || "") === String(baseSelecionadaUI || "")) {
          await setStorage({ baseSelecionada: "" });
        }

        await carregarBases();
        setAppStatus(`Base "${nomeBase}" excluída com sucesso.`, "#2e7d32");
      } catch (error) {
        console.error("[VenForce] erro ao excluir base:", error);
        setAppStatus(error.message || "Erro ao excluir base.", "#c62828");
      } finally {
        btnExcluirBase.disabled = false;
      }
    });
  }

  if (basesSelect) {
    basesSelect.addEventListener("change", async () => {
      await salvarBaseSelecionada();
    });
  }

  if (filtroBaseInput) {
    filtroBaseInput.addEventListener("input", () => {
      filtrarBases();
    });
  }

  if (btnCriarBaseImportar) {
    btnCriarBaseImportar.addEventListener("click", async () => {
      await criarBaseEImportar();
    });
  }

  if (expandAllBtn) {
    expandAllBtn.addEventListener("click", async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) {
          setAppStatus("Abra a página de anúncios do Mercado Livre e clique novamente.", "#c62828");
          return;
        }
        const isMercadoLivre = tab.url && /mercadolivre\.com\.br/i.test(tab.url);
        if (!isMercadoLivre) {
          setAppStatus("Abra a página de anúncios do Mercado Livre em uma aba e clique em \"Expandir todos\" novamente.", "#c62828");
          return;
        }
        await chrome.tabs.sendMessage(tab.id, { action: "VENFORCE_EXPAND_ALL" });
        setAppStatus("Comando enviado. Os cards devem expandir na página.", "#2e7d32");
      } catch (err) {
        console.warn("[VenForce] Expandir todos:", err);
        setAppStatus("Abra a página de anúncios do Mercado Livre, recarregue-a (F5) e clique em \"Expandir todos\" novamente.", "#c62828");
      }
    });
  }

  // ==========================
  // INÍCIO
  // ==========================
  await carregarEstadoAtivo();
  await restaurarSessao();
});
