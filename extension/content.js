console.log("[VenForce] extensão iniciada");

(function () {
  const API_BASE_URL = "https://venforce-server.onrender.com";

  const OVERLAY_ID = "venforce-overlay-root";
  const BOX_CLASS = "venforce-card-box";
  const SCAN_SESSION_KEY = "vf_scan_session";
  const LS_TOKEN_KEY = "vf-token";
  const LS_BASE_KEY = "vf-base";

  const BOX_WIDTH = 280;
  const CARD_GAP_FROM_ROW = 18;
  const VIEWPORT_RIGHT_GAP = 12;

  let COST_DB = {};
  let scheduled = false;
  let currentBaseId = null;
  let expandAllOnNextRender = false;
  let collapseAllOnNextRender = false;

  // ==========================
  // PLATAFORMA
  // ==========================
  function detectarPlataforma() {
    const hostname = (location?.hostname || "").toLowerCase();
    if (hostname.includes("mercadolivre")) return "ml";
    return null;
  }

  const PLATAFORMA = detectarPlataforma();

  // ==========================
  // ESTILOS
  // ==========================
  function injectStyles(root) {
    if (root.getElementById("venforce-style")) return;

    const style = document.createElement("style");
    style.id = "venforce-style";
    style.textContent = `
      .${BOX_CLASS} {
        position: absolute;
        width: 230px;
        max-width: calc(100vw - 24px);
        border-radius: 9px;
        padding: 5px 7px;
        font-family: Arial, sans-serif;
        font-size: 10px;
        line-height: 1.25;
        box-sizing: border-box;
        pointer-events: auto;
        box-shadow: 0 2px 7px rgba(0,0,0,0.10);
        border: 1.5px solid transparent;
        transition: box-shadow 0.15s, transform 0.15s;
        word-wrap: break-word;
        overflow-wrap: break-word;
      }

      .venforce-compact {
        width: 86px !important;
        padding: 4px 6px;
        cursor: pointer;
      }

      .venforce-card-box:hover {
        transform: translateY(-1px);
        box-shadow: 0 4px 12px rgba(0,0,0,0.14);
      }

      .venforce-arrow {
        font-size: 7px;
        opacity: 0.4;
        transition: transform 0.18s;
        display: inline-block;
      }
      .venforce-arrow.open { transform: rotate(90deg); }

      .venforce-card-green  { background: #e8f8ee; border-color: #2ea55e; color: #163d26; }
      .venforce-card-yellow { background: #fffbea; border-color: #d4a000; color: #584200; }
      .venforce-card-red    { background: #fef0f0; border-color: #d44c4c; color: #5b1f1f; }

      .vf-sep {
        border: none;
        border-top: 1px solid rgba(0,0,0,0.1);
        margin: 4px 0;
      }

      .vf-grid3 {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        gap: 2px 3px;
        margin-top: 3px;
      }

      .vf-grid2 {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 2px 3px;
        margin-top: 3px;
      }

      .vf-cell  { display: flex; flex-direction: column; }
      .vf-lbl   { font-size: 8px; opacity: 0.55; line-height: 1.1; }
      .vf-val   { font-size: 10px; font-weight: 700; line-height: 1.15; }

      .venforce-red-text    { color: #c62828; font-weight: 700; }
      .venforce-green-text  { color: #1a7a42; font-weight: 700; }
      .venforce-yellow-text { color: #8a5c00; font-weight: 700; }

      .venforce-expand-all-wrap {
        position: fixed;
        top: 80px;
        right: 14px;
        z-index: 1000000;
        pointer-events: auto;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .venforce-expand-all-btn {
        padding: 6px 12px;
        font-size: 12px;
        font-weight: 600;
        font-family: Arial, sans-serif;
        color: #fff;
        background: #2ea55e;
        border: 1px solid #237a47;
        border-radius: 8px;
        cursor: pointer;
        white-space: nowrap;
      }
      .venforce-expand-all-btn:hover { background: #237a47; }
      .venforce-collapse-all-btn {
        padding: 6px 12px;
        font-size: 12px;
        font-weight: 600;
        font-family: Arial, sans-serif;
        color: #fff;
        background: #6c757d;
        border: 1px solid #545b62;
        border-radius: 8px;
        cursor: pointer;
        white-space: nowrap;
      }
      .venforce-collapse-all-btn:hover { background: #545b62; }

      .venforce-scan-btn {
        padding: 6px 12px;
        font-size: 12px;
        font-weight: 600;
        font-family: Arial, sans-serif;
        color: #fff;
        background: #5b2be0;
        border: 1px solid #4520ad;
        border-radius: 10px;
        cursor: pointer;
        box-shadow: 0 2px 8px rgba(0,0,0,0.12);
        white-space: nowrap;
      }
      .venforce-scan-btn:hover { background: #4520ad; }
      .venforce-scan-btn:disabled { opacity: 0.6; cursor: not-allowed; }

      .venforce-debug-box {
        background: rgba(255,255,255,0.96);
        border: 1.5px solid #d8d0ff;
        border-radius: 10px;
        padding: 8px 10px;
        font-family: Arial, sans-serif;
        font-size: 11px;
        color: #333;
        min-width: 140px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.10);
      }

      .venforce-debug-total {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 6px;
        font-weight: 700;
        font-size: 12px;
        color: #5b2be0;
      }

      .venforce-debug-grid {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        gap: 4px;
        text-align: center;
      }

      .vf-dbg-green  { background: #e8f8ee; border-radius: 6px; padding: 4px 2px; font-size: 10px; color: #1a7a42; font-weight: 700; }
      .vf-dbg-yellow { background: #fffbea; border-radius: 6px; padding: 4px 2px; font-size: 10px; color: #8a5c00; font-weight: 700; }
      .vf-dbg-red    { background: #fef0f0; border-radius: 6px; padding: 4px 2px; font-size: 10px; color: #c62828; font-weight: 700; }
      .vf-dbg-label  { font-size: 8px; font-weight: 400; display: block; margin-top: 1px; }
      .vf-dbg-media  { margin-top: 5px; font-size: 10px; color: #666; text-align: center; }

      .vf-scan-session {
        background: rgba(255,255,255,0.96);
        border: 1.5px solid #d8d0ff;
        border-radius: 10px;
        padding: 8px 10px;
        font-family: Arial, sans-serif;
        font-size: 11px;
        color: #333;
        min-width: 140px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.10);
      }

      .vf-scan-session-title {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
        margin-bottom: 6px;
        font-weight: 700;
        font-size: 12px;
        color: #5b2be0;
      }

      .vf-scan-active {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 10px;
        font-weight: 700;
        color: #1a7a42;
      }

      .vf-scan-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: #2ea55e;
        box-shadow: 0 0 0 0 rgba(46,165,94,0.45);
        animation: vfPulseDot 1.1s ease-in-out infinite;
      }

      @keyframes vfPulseDot {
        0%   { box-shadow: 0 0 0 0 rgba(46,165,94,0.40); }
        70%  { box-shadow: 0 0 0 7px rgba(46,165,94,0.00); }
        100% { box-shadow: 0 0 0 0 rgba(46,165,94,0.00); }
      }

      .vf-scan-row { display: flex; gap: 6px; align-items: center; margin-top: 6px; }
      .vf-scan-row label { font-size: 9px; opacity: 0.6; min-width: 56px; }
      .vf-scan-input, .vf-scan-select {
        flex: 1;
        border: 1px solid rgba(0,0,0,0.18);
        border-radius: 8px;
        padding: 6px 8px;
        font-size: 11px;
        outline: none;
      }
      .vf-scan-input:focus, .vf-scan-select:focus { border-color: rgba(91,43,224,0.45); box-shadow: 0 0 0 2px rgba(91,43,224,0.08); }

      .vf-scan-actions { display: flex; gap: 6px; margin-top: 8px; }
      .vf-scan-mini-btn {
        flex: 1;
        padding: 7px 8px;
        font-size: 11px;
        font-weight: 700;
        font-family: Arial, sans-serif;
        border-radius: 10px;
        cursor: pointer;
        border: 1px solid transparent;
      }
      .vf-scan-finish { background: #2ea55e; border-color: #237a47; color: #fff; }
      .vf-scan-finish:hover { background: #237a47; }
      .vf-scan-reset { background: #fef0f0; border-color: #d44c4c; color: #c62828; }
      .vf-scan-reset:hover { background: #fbd7d7; }
      .vf-scan-mini-btn:disabled { opacity: 0.6; cursor: not-allowed; }
      .vf-scan-help { margin-top: 6px; font-size: 10px; color: #666; }
    `;

    root.appendChild(style);
  }

  // ==========================
  // FORMATAÇÃO
  // ==========================
  function moeda(valor) {
    return Number(valor || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }

  function porcentagem(valor) {
    return `${Number(valor || 0).toFixed(2)}%`;
  }

  function numeroSeguro(valor) {
    if (valor === null || valor === undefined || valor === "") return 0;
    if (typeof valor === "number") return Number.isFinite(valor) ? valor : 0;

    let texto = String(valor).trim().replace(/\s/g, "").replace("%", "");
    if (!texto) return 0;

    if (texto.includes(",") && texto.includes(".")) {
      texto = texto.replace(/\./g, "").replace(",", ".");
    } else if (texto.includes(",")) {
      texto = texto.replace(",", ".");
    } else if (texto.includes(".") && /^\d{1,3}(\.\d{3})+$/.test(texto)) {
      texto = texto.replace(/\./g, "");
    }

    const n = Number(texto);
    return Number.isFinite(n) ? n : 0;
  }

  function extrairNumeroDeTexto(texto) {
    if (!texto) return 0;
    const match = String(texto).match(/R\$\s*([\d\.]+,\d{2}|[\d\.]+)/i);
    if (!match) return 0;

    let valor = match[1];
    if (valor.includes(",") && valor.includes(".")) {
      valor = valor.replace(/\./g, "").replace(",", ".");
    } else if (valor.includes(",")) {
      valor = valor.replace(",", ".");
    } else if (valor.includes(".") && /^\d{1,3}(\.\d{3})+$/.test(valor)) {
      valor = valor.replace(/\./g, "");
    }

    const n = Number(valor);
    return Number.isFinite(n) ? n : 0;
  }

  function extrairTodosOsPrecosDoTexto(texto) {
    if (!texto) return [];
    return [...String(texto).matchAll(/R\$\s*([\d\.]+,\d{2}|[\d\.]+)/gi)]
      .map(m => extrairNumeroDeTexto(m[0]))
      .filter(v => v > 0);
  }

  function normalizarPercentual(valor) {
    const n = numeroSeguro(valor);
    if (n > 0 && n <= 1) return n * 100;
    return n;
  }

  function classeNumero(valor) {
    if (valor > 0) return "venforce-green-text";
    if (valor < 0) return "venforce-red-text";
    return "venforce-yellow-text";
  }

  function getCardColorClassByMc(mc) {
    if (mc <= 6) return "venforce-card-red";
    if (mc < 10) return "venforce-card-yellow";
    return "venforce-card-green";
  }

  function getStatusByMc(mc) {
    if (mc <= 6) return { texto: "Crítico", classe: "venforce-red-text" };
    if (mc < 10) return { texto: "Atenção", classe: "venforce-yellow-text" };
    return { texto: "Saudável", classe: "venforce-green-text" };
  }

  function getTextoLimpo(el) {
    return (el?.innerText || "").replace(/\u00a0/g, " ").trim();
  }

  function getLinhas(texto) {
    return String(texto || "")
      .replace(/\u00a0/g, " ")
      .split("\n")
      .map(s => s.trim())
      .filter(Boolean);
  }

  function buscarValorAposBloco(texto, marcadorRegex, limite = 220) {
    const regex = new RegExp(
      `${marcadorRegex.source}[\\s\\S]{0,${limite}}?A pagar\\s*R\\$\\s*([\\d\\.]+,\\d{2}|[\\d\\.]+)`,
      "i"
    );
    const match = texto.match(regex);
    if (!match?.[1]) return 0;
    return extrairNumeroDeTexto(`R$ ${match[1]}`);
  }

  // ==========================
  // STORAGE
  // ==========================
  async function getSessao() {
    try {
      const storage = await chrome.storage.local.get([
        "baseAtiva", "baseSelecionada", "token", "user", "venforce_user"
      ]);

      return {
        baseAtiva: storage.baseSelecionada || storage.baseAtiva || null,
        token: storage.token || null,
        user: storage.user || storage.venforce_user || null
      };
    } catch {
      return { baseAtiva: null, token: null, user: null };
    }
  }

  // ==========================
  // SCAN ACUMULATIVO (chrome.storage.local)
  // ==========================
  function getTokenLocalStorage() {
    try { return localStorage.getItem(LS_TOKEN_KEY) || ""; } catch { return ""; }
  }

  function getBaseSlugLocalStorage() {
    try { return (localStorage.getItem(LS_BASE_KEY) || "").trim(); } catch { return ""; }
  }

  function setBaseSlugLocalStorage(slug) {
    try { localStorage.setItem(LS_BASE_KEY, String(slug || "").trim()); } catch {}
  }

  async function getScanSession() {
    try {
      const storage = await chrome.storage.local.get([SCAN_SESSION_KEY]);
      return storage?.[SCAN_SESSION_KEY] || null;
    } catch {
      return null;
    }
  }

  async function setScanSession(sessao) {
    try {
      await chrome.storage.local.set({ [SCAN_SESSION_KEY]: sessao });
      return true;
    } catch {
      return false;
    }
  }

  async function clearScanSession() {
    try {
      await chrome.storage.local.remove([SCAN_SESSION_KEY]);
    } catch {}
  }

  function calcularMetricas(anuncios) {
    const items = Object.values(anuncios || {});
    const total = items.length;
    if (!total) return { total: 0, mc_medio: 0, saudaveis: 0, atencao: 0, criticos: 0 };

    let somaPreco = 0;
    let somaMcPonderado = 0;
    let somaMc = 0;
    let saudaveis = 0;
    let atencao = 0;
    let criticos = 0;

    for (const it of items) {
      const mc = Number(it?.mc) || 0;
      const preco = Number(it?.preco) || 0;
      somaMc += mc;

      if (preco > 0) {
        somaPreco += preco;
        somaMcPonderado += mc * preco;
      }

      if (mc >= 20) saudaveis += 1;
      else if (mc >= 10) atencao += 1;
      else criticos += 1;
    }

    const mc_medio = somaPreco > 0 ? (somaMcPonderado / somaPreco) : (somaMc / total);
    return { total, mc_medio, saudaveis, atencao, criticos };
  }

  async function iniciarScan(base_slug, conta_ml) {
    const base = String(base_slug || "").trim();
    const conta = String(conta_ml || "").trim();
    if (!base || !conta) return null;

    const atual = await getScanSession();
    if (atual?.ativo && atual.base_slug && atual.conta_ml) {
      const mesma = atual.base_slug === base && atual.conta_ml === conta;
      if (mesma) return atual;

      const ok = confirm(
        `Já existe um scan acumulando para:\n\nBase: ${atual.base_slug}\nConta: ${atual.conta_ml}\n\nDeseja resetar e iniciar um novo scan para:\nBase: ${base}\nConta: ${conta}?`
      );
      if (!ok) return atual;
    }

    const nova = {
      ativo: true,
      base_slug: base,
      conta_ml: conta,
      anuncios: {},
      iniciado_em: Date.now()
    };
    await setScanSession(nova);
    atualizarScanUI();
    return nova;
  }

  function adicionarAnuncio(id, dados) {
    const anuncioId = String(id || "").trim();
    if (!anuncioId) return;

    const payload = {
      mc: Number(dados?.mc) || 0,
      preco: Number(dados?.preco) || 0,
      status: String(dados?.status || "")
    };

    chrome.storage.local.get([SCAN_SESSION_KEY], (storage) => {
      const sessao = storage?.[SCAN_SESSION_KEY];
      if (!sessao?.ativo) return;
      if (!sessao.anuncios) sessao.anuncios = {};
      sessao.anuncios[anuncioId] = payload;
      chrome.storage.local.set({ [SCAN_SESSION_KEY]: sessao }, () => {
        atualizarScanUI();
      });
    });
  }

  async function finalizarScan(token) {
    try {
      const t = String(token || "").trim();
      if (!t) return;

      const sessao = await getScanSession();
      if (!sessao?.ativo) {
        alert("Nenhuma sessão de scan ativa.");
        return;
      }

      const base_slug = String(sessao.base_slug || "").trim();
      const conta_ml = String(sessao.conta_ml || "").trim();
      const anuncios = sessao.anuncios || {};
      const m = calcularMetricas(anuncios);

      if (!base_slug || !conta_ml || !m.total) {
        alert("Não foi possível finalizar: base/conta inválidas ou nenhum anúncio acumulado.");
        return;
      }

      const res = await fetch(`${API_BASE_URL}/scans`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${t}`
        },
        body: JSON.stringify({
          base_slug,
          conta_ml,
          total_anuncios: m.total,
          mc_medio: m.mc_medio,
          saudaveis: m.saudaveis,
          atencao: m.atencao,
          criticos: m.criticos
        })
      });

      const json = await res.json().catch(() => ({}));
      if (res.status === 401) {
        alert("Sessão expirada. Faça login novamente no portal.");
        return;
      }
      if (!res.ok || json?.ok === false) {
        throw new Error(json?.erro || `HTTP ${res.status}`);
      }

      await clearScanSession();
      resetarContadoresScanUI();
      alert("✓ Scan finalizado e salvo com sucesso.");
    } catch (err) {
      alert("Erro ao finalizar scan: " + err.message);
    } finally {
      atualizarScanUI();
    }
  }

  function resetarScan() {
    clearScanSession().finally(() => {
      resetarContadoresScanUI();
      atualizarScanUI();
    });
  }

  async function obterContaMl() {
    const fromUrl = (() => {
      try {
        const u = new URL(location.href);
        const path = (u.pathname || "").split("/").filter(Boolean);
        const known = path.find(p => /^@/.test(p));
        if (known) return known.replace(/^@/, "");
        const maybe = path.find(p => /perfil|user|usuario|seller/i.test(p));
        if (maybe) {
          const idx = path.indexOf(maybe);
          if (idx >= 0 && path[idx + 1]) return path[idx + 1];
        }
      } catch {}
      return "";
    })();

    if (fromUrl) return fromUrl;

    const candidates = [
      "[data-testid='user-menu']",
      "[data-testid='nav-header-user-menu']",
      "header a[href*='perfil']",
      "header a[href*='/profile']",
      "header [class*='user']",
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      const t = getTextoLimpo(el);
      if (t && t.length >= 3 && t.length <= 40) return t.split("\n")[0].trim();
    }

    return "";
  }

  async function carregarBasesParaSelect(token) {
    const root = getOverlayRoot();
    const select = root?.getElementById("vf-scan-base");
    if (!select) return;

    select.innerHTML = `<option value="">Carregando bases…</option>`;
    try {
      const res = await fetch(`${API_BASE_URL}/bases`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json().catch(() => ({}));
      const bases = Array.isArray(json?.bases) ? json.bases : [];

      select.innerHTML = `<option value="">Selecione uma base…</option>`;
      bases.forEach((b) => {
        const opt = document.createElement("option");
        opt.value = b.slug || b.nome || "";
        opt.textContent = b.nome || b.slug || "—";
        select.appendChild(opt);
      });

      const current = getBaseSlugLocalStorage();
      if (current) select.value = current;
    } catch {
      select.innerHTML = `<option value="">Não foi possível carregar bases</option>`;
    }
  }

  function resetarContadoresScanUI() {
    const root = getOverlayRoot();
    const el = root?.getElementById("vf-scan-count");
    if (el) el.textContent = "0 anúncios acumulados";
    const active = root?.getElementById("vf-scan-active");
    if (active) active.style.display = "none";
  }

  async function atualizarScanUI() {
    const root = getOverlayRoot();
    if (!root) return;

    const token = getTokenLocalStorage();
    const box = root.getElementById("vf-scan-session-box");
    if (!box) return;

    const btnFinish = root.getElementById("vf-btn-finish-scan");
    const btnReset = root.getElementById("vf-btn-reset-scan");

    if (!token) {
      box.style.display = "none";
      return;
    }
    box.style.display = "block";

    const sessao = await getScanSession();
    const countEl = root.getElementById("vf-scan-count");
    const activeEl = root.getElementById("vf-scan-active");
    const contaInput = root.getElementById("vf-scan-conta");
    const baseSelect = root.getElementById("vf-scan-base");

    const baseSlug = getBaseSlugLocalStorage();
    if (baseSelect && baseSlug && baseSelect.value !== baseSlug) baseSelect.value = baseSlug;

    const contaAtual = (contaInput?.value || "").trim();
    if (!contaAtual) {
      const contaDetectada = await obterContaMl();
      if (contaDetectada && contaInput) contaInput.value = contaDetectada;
    }

    const total = sessao?.anuncios ? Object.keys(sessao.anuncios).length : 0;
    if (countEl) countEl.textContent = `${total} anúncios acumulados`;
    if (activeEl) activeEl.style.display = sessao?.ativo ? "inline-flex" : "none";

    if (btnFinish) btnFinish.disabled = !sessao?.ativo || total <= 0;
    if (btnReset) btnReset.disabled = !sessao?.ativo && total <= 0;
  }

  // ==========================
  // CARREGAMENTO DE CUSTOS
  // ROTA NOVA: GET /bases/:baseId (sem Drive)
  // ==========================
  function clearLoadedBase() {
    COST_DB = {};
    currentBaseId = null;
  }

  async function loadCostsFromApi() {
    const sessao = await getSessao();

    if (!sessao.baseAtiva || !sessao.token) {
      clearLoadedBase();
      return false;
    }

    // Se a mesma base já está carregada, não recarrega
    if (currentBaseId === sessao.baseAtiva && Object.keys(COST_DB).length > 0) {
      return true;
    }

    try {
      const response = await fetch(
        `${API_BASE_URL}/bases/${encodeURIComponent(sessao.baseAtiva)}`,
        { headers: { Authorization: `Bearer ${sessao.token}` } }
      );

      if (!response.ok) {
        const json = await response.json().catch(() => ({}));
        throw new Error(json?.erro || `HTTP ${response.status}`);
      }

      const json = await response.json();
      if (!json?.ok) throw new Error(json?.erro || "Resposta inválida");

      COST_DB = json.dados || {};
      currentBaseId = json.baseId || sessao.baseAtiva;

      console.log("[VenForce] base carregada:", currentBaseId, Object.keys(COST_DB).length, "IDs");
      return true;
    } catch (err) {
      console.warn("[VenForce] falha ao carregar base:", err.message);
      clearLoadedBase();
      return false;
    }
  }

  async function loadCostsLocalFallback() {
    try {
      const url = chrome.runtime.getURL("custos.json");
      const response = await fetch(url);
      if (!response.ok) return false;

      const json = await response.json();
      if (!json || !Object.keys(json).length) return false;

      COST_DB = json;
      currentBaseId = "fallback-local";
      console.log("[VenForce] fallback local carregado");
      return true;
    } catch {
      clearLoadedBase();
      return false;
    }
  }

  async function loadCosts() {
    const ok = await loadCostsFromApi();
    if (!ok) await loadCostsLocalFallback();
  }

  // ==========================
  // OVERLAY / DOM
  // ==========================
  function ensureOverlay() {
    let overlay = document.getElementById(OVERLAY_ID);
    if (overlay) return overlay;

    overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.style.cssText = "position:absolute;top:0;left:0;width:100%;pointer-events:none;z-index:999999;";
    document.body.appendChild(overlay);

    const root = overlay.attachShadow({ mode: "open" });
    injectStyles(root);

    const wrap = document.createElement("div");
    wrap.className = "venforce-expand-all-wrap";

    const expandBtn = document.createElement("button");
    expandBtn.type = "button";
    expandBtn.className = "venforce-expand-all-btn";
    expandBtn.textContent = "Expandir todos";
    expandBtn.addEventListener("click", () => {
      collapseAllOnNextRender = false;
      expandAllOnNextRender = true;
      scheduleProcess();
    });
    wrap.appendChild(expandBtn);

    const collapseBtn = document.createElement("button");
    collapseBtn.type = "button";
    collapseBtn.className = "venforce-collapse-all-btn";
    collapseBtn.textContent = "Recolher todos";
    collapseBtn.addEventListener("click", () => {
      expandAllOnNextRender = false;
      collapseAllOnNextRender = true;
      scheduleProcess();
    });
    wrap.appendChild(collapseBtn);

    const scanBtn = document.createElement("button");
    scanBtn.type = "button";
    scanBtn.className = "venforce-scan-btn";
    scanBtn.textContent = "▶ Escanear página";
    scanBtn.addEventListener("click", async () => {
      const token = getTokenLocalStorage();
      if (token) {
        const root = getOverlayRoot();
        const baseSel = root?.getElementById("vf-scan-base");
        const contaIn = root?.getElementById("vf-scan-conta");
        const baseSlug = String(baseSel?.value || getBaseSlugLocalStorage() || "").trim();
        const contaMl = String(contaIn?.value || (await obterContaMl()) || "").trim();
        if (baseSlug) setBaseSlugLocalStorage(baseSlug);
        if (baseSlug && contaMl) await iniciarScan(baseSlug, contaMl);
        atualizarScanUI();
      }

      scanBtn.disabled = true;
      scanBtn.textContent = "Escaneando...";
      expandAllOnNextRender = true;
      scheduleProcess();
      await new Promise(r => setTimeout(r, 1200));
      processarPagina();
      await new Promise(r => setTimeout(r, 400));
      atualizarDebugNaPagina();
      scanBtn.disabled = false;
      scanBtn.textContent = "▶ Escanear página";
    });
    wrap.appendChild(scanBtn);

    const scanSessionBox = document.createElement("div");
    scanSessionBox.id = "vf-scan-session-box";
    scanSessionBox.className = "vf-scan-session";
    scanSessionBox.style.display = "none";
    scanSessionBox.innerHTML = `
      <div class="vf-scan-session-title">
        <span>Scan acumulativo</span>
        <span class="vf-scan-active" id="vf-scan-active" style="display:none;">
          <span class="vf-scan-dot"></span>
          Ativo
        </span>
      </div>
      <div id="vf-scan-count" style="font-weight:700;color:#5b2be0;">0 anúncios acumulados</div>

      <div class="vf-scan-row">
        <label>Base</label>
        <select id="vf-scan-base" class="vf-scan-select">
          <option value="">Selecione uma base…</option>
        </select>
      </div>
      <div class="vf-scan-row">
        <label>Conta</label>
        <input id="vf-scan-conta" class="vf-scan-input" placeholder="ex: minha_conta_ml">
      </div>

      <div class="vf-scan-actions">
        <button type="button" class="vf-scan-mini-btn vf-scan-finish" id="vf-btn-finish-scan">Finalizar scan</button>
        <button type="button" class="vf-scan-mini-btn vf-scan-reset" id="vf-btn-reset-scan">Resetar</button>
      </div>
      <div class="vf-scan-help">Dica: o scan acumula entre páginas enquanto estiver ativo.</div>
    `;
    wrap.appendChild(scanSessionBox);

    const debugBox = document.createElement("div");
    debugBox.id = "vf-debug-box";
    debugBox.className = "venforce-debug-box";
    debugBox.style.display = "none";
    debugBox.innerHTML = `
      <div class="venforce-debug-total">
        <span>Escaneados</span><span id="vf-dbg-total">0</span>
      </div>
      <div class="venforce-debug-grid">
        <div class="vf-dbg-green"><span id="vf-dbg-sau">0</span><span class="vf-dbg-label">Saudável</span></div>
        <div class="vf-dbg-yellow"><span id="vf-dbg-ate">0</span><span class="vf-dbg-label">Atenção</span></div>
        <div class="vf-dbg-red"><span id="vf-dbg-cri">0</span><span class="vf-dbg-label">Crítico</span></div>
      </div>
      <div class="vf-dbg-media" id="vf-dbg-media"></div>
    `;
    wrap.appendChild(debugBox);

    root.appendChild(wrap);

    const token = getTokenLocalStorage();
    if (token) {
      carregarBasesParaSelect(token);
      atualizarScanUI();
      const baseSel = root.getElementById("vf-scan-base");
      if (baseSel) {
        baseSel.addEventListener("change", () => {
          const v = String(baseSel.value || "").trim();
          if (v) setBaseSlugLocalStorage(v);
          atualizarScanUI();
        });
      }
      const contaIn = root.getElementById("vf-scan-conta");
      if (contaIn) contaIn.addEventListener("input", () => atualizarScanUI());

      const btnFinish = root.getElementById("vf-btn-finish-scan");
      if (btnFinish) btnFinish.addEventListener("click", async () => {
        btnFinish.disabled = true;
        await finalizarScan(getTokenLocalStorage());
        btnFinish.disabled = false;
      });
      const btnReset = root.getElementById("vf-btn-reset-scan");
      if (btnReset) btnReset.addEventListener("click", () => {
        if (confirm("Resetar o scan acumulativo? Isso apaga os anúncios já acumulados.")) resetarScan();
      });
    }

    return overlay;
  }

  function getOverlayRoot() {
    const overlay = ensureOverlay();
    if (!overlay.shadowRoot) {
      const root = overlay.attachShadow({ mode: "open" });
      injectStyles(root);
    }
    return overlay.shadowRoot;
  }

  function atualizarDebugNaPagina() {
    const root = getOverlayRoot();
    if (!root) return;

    const debugBox = root.getElementById("vf-debug-box");
    if (!debugBox) return;

    const boxes = root.querySelectorAll("[data-venforce-key]");
    const mcs = [];
    boxes.forEach(box => {
      const mc = box.__venforceCache?.dados?.mc;
      if (typeof mc === "number" && Number.isFinite(mc)) mcs.push(mc);
    });

    if (!mcs.length) return;

    const total = mcs.length;
    root.getElementById("vf-dbg-total").textContent = total;
    root.getElementById("vf-dbg-sau").textContent = mcs.filter(mc => mc >= 10).length;
    root.getElementById("vf-dbg-ate").textContent = mcs.filter(mc => mc >= 6 && mc < 10).length;
    root.getElementById("vf-dbg-cri").textContent = mcs.filter(mc => mc < 6).length;
    root.getElementById("vf-dbg-media").textContent = `MC médio: ${(mcs.reduce((s, v) => s + v, 0) / total).toFixed(2)}%`;
    debugBox.style.display = "block";
  }

  function syncOverlaySize() {
    const overlay = ensureOverlay();
    const body = document.body;
    const html = document.documentElement;
    overlay.style.width = `${Math.max(body.scrollWidth, body.offsetWidth, html.clientWidth, html.scrollWidth, html.offsetWidth)}px`;
    overlay.style.height = `${Math.max(body.scrollHeight, body.offsetHeight, html.clientHeight, html.scrollHeight, html.offsetHeight)}px`;
  }

  // ==========================
  // DETECÇÃO DE LINHAS DO ML
  // ==========================
  function isRowCandidate(el) {
    const t = getTextoLimpo(el);
    if (!t) return false;

    const hasId = /#\d{8,}/.test(t) || /\b\d{8,}\b/.test(t);
    const hasPrice = /R\$\s*[\d\.]+,\d{2}/.test(t);
    const hasCommission = /Clássico|Classico|Premium|Tarifa de venda/i.test(t);
    const hasShipping = /Envio por conta do comprador|Você oferece frete grátis|Frete grátis|por usar o Flex|A pagar R\$/i.test(t);

    if (!hasId || !hasPrice || !hasCommission || !hasShipping) return false;

    const rect = el.getBoundingClientRect();
    if (rect.width < 700 || rect.height < 90 || rect.height > 700) return false;

    const hasCheckbox = !!el.querySelector('input[type="checkbox"]');
    if (!hasCheckbox && rect.width < 900) return false;

    return true;
  }

  function getPainelRows() {
    const candidates = Array.from(
      document.querySelectorAll("div, section, article, [role='row']")
    ).filter(isRowCandidate);

    return candidates
      .filter(el => !candidates.some(other => other !== el && el.contains(other)))
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  }

  function extrairIdPainel(row) {
    const t = getTextoLimpo(row);
    return (t.match(/#(\d{8,})/)?.[1]) || (t.match(/\b(\d{8,})\b/)?.[1]) || null;
  }

  // ==========================
  // EXTRAÇÃO DE DADOS DO ANÚNCIO
  // ==========================
  function extrairPrecoVenda(row) {
    const textoRow = getTextoLimpo(row);
    const textoSemAtacado = textoRow.replace(
      /(?:com\s+\d+\s+preços?\s+de\s+atacado|preços?\s+de\s+atacado)[\s\S]{0,300}?(?=\n\n|\nClássico|\nPremium|\nTarifa|$)/gi,
      ""
    );
    const linhas = getLinhas(textoSemAtacado);

    let precoCheio = 0;
    let precoPromocional = 0;

    const matchVendePor = textoRow.match(
      /você vende por\s+R\$\s*([\d\.]+(?:,\d{1,2})?)\s+na\s+promo[çc][aã]o/i
    );

    if (matchVendePor?.[1]) {
      precoPromocional = extrairNumeroDeTexto(`R$ ${matchVendePor[1]}`);
      const idxVendePor = textoRow.toLowerCase().indexOf("você vende por");
      const textAntes = idxVendePor >= 0 ? textoRow.slice(0, idxVendePor) : "";
      const matchCheio = [...textAntes.matchAll(/R\$\s*([\d\.]+(?:,\d{1,2})?)/gi)];
      if (matchCheio.length) {
        const candidato = extrairNumeroDeTexto(`R$ ${matchCheio[matchCheio.length - 1][1]}`);
        if (candidato > precoPromocional) precoCheio = candidato;
      }
      if (!precoCheio) precoCheio = precoPromocional;
      return { precoVenda: precoPromocional, precoCheio, precoPromocional };
    }

    for (let i = 0; i < linhas.length; i++) {
      const linha = linhas[i];
      if (!precoCheio && /^R\$\s*[\d\.]+,\d{2}$/i.test(linha)) {
        const prox = `${linhas[i + 1] || ""} ${linhas[i + 2] || ""} ${linhas[i + 3] || ""}`;
        if (/em promoção|na promoção|promoção|promocao/i.test(prox)) {
          precoCheio = extrairNumeroDeTexto(linha);
          const promoMatch = prox.match(/R\$\s*([\d\.]+,\d{2}|[\d\.]+)/i);
          if (promoMatch?.[1]) precoPromocional = extrairNumeroDeTexto(`R$ ${promoMatch[1]}`);
          break;
        }
      }
    }

    if (!precoCheio) {
      const todos = extrairTodosOsPrecosDoTexto(textoSemAtacado);
      if (todos.length) precoCheio = todos[0];
    }

    if (!precoPromocional) {
      const m = textoSemAtacado.match(
        /(?:em promoção|na promoção)[\s\S]{0,40}?(?:a\s*)?R\$\s*([\d\.]+,\d{2}|[\d\.]+)/i
      );
      if (m?.[1]) precoPromocional = extrairNumeroDeTexto(`R$ ${m[1]}`);
    }

    const precoVenda = precoPromocional || precoCheio || 0;
    return { precoVenda, precoCheio: precoCheio || precoVenda, precoPromocional };
  }

  function extrairComissaoInfo(row, precoVenda) {
    const t = getTextoLimpo(row);
    let valor = buscarValorAposBloco(t, /(Clássico|Classico|Premium|Tarifa de venda)/i, 220);

    if (!valor) {
      const m = t.match(/(Clássico|Classico|Premium|Tarifa de venda)[\s\S]{0,220}?A pagar\s*R\$\s*([\d\.]+,\d{2}|[\d\.]+)/i);
      if (m?.[2]) valor = extrairNumeroDeTexto(`R$ ${m[2]}`);
    }

    const percentual = precoVenda > 0 && valor > 0 ? (valor / precoVenda) * 100 : 0;
    return { percentual, valor };
  }

 function extrairFrete(row) {
  const t = getTextoLimpo(row);

  // 🔹 remove bloco do FLEX (continua igual)
  const tSemFlex = t.replace(
    /você receberá[\s\S]{0,80}?por usar o flex[\s\S]{0,40}?(?:\n|$)/gi,
    ""
  );

  // ==========================
  // 1. LAYOUT NOVO 
  // ==========================
  let valor = buscarValorAposBloco(
    tSemFlex,
    /(Envio por conta do comprador|Você oferece frete grátis|Frete grátis|Frete|Envio)/i,
    240
  );
  if (valor) return valor;

  // ==========================
  // 2. LAYOUT ANTIGO (NOVO SUPORTE)
  // ==========================
  const linhas = getLinhas(tSemFlex);

  for (let i = 0; i < linhas.length; i++) {
    const linha = linhas[i];

    // identifica bloco de frete
    if (/frete grátis|frete|envio/i.test(linha)) {
      const bloco = `${linhas[i]} ${linhas[i + 1] || ""} ${linhas[i + 2] || ""}`;

      const match = bloco.match(/R\$\s*([\d\.]+,\d{2}|[\d\.]+)/i);
      if (match?.[1]) {
        return extrairNumeroDeTexto(`R$ ${match[1]}`);
      }
    }
  }

  // ==========================
  // 3. FALLBACK INTELIGENTE
  // ==========================
  const todosValores = extrairTodosOsPrecosDoTexto(tSemFlex);

  if (todosValores.length >= 3) {
    // geralmente: preço venda / comissão / frete
    return todosValores[2];
  }

  // ==========================
  // 4. FALLBACK FINAL
  // ==========================
  const match = tSemFlex.match(
    /(Envio|Frete)[\s\S]{0,200}?R\$\s*([\d\.]+,\d{2}|[\d\.]+)/i
  );
  if (match?.[2]) {
    return extrairNumeroDeTexto(`R$ ${match[2]}`);
  }

  return 0;
}


  function calcular(precoVenda, custoInfo, comissaoInfo, frete) {
    const custo = numeroSeguro(custoInfo?.custo_produto);
    const impostoPct = normalizarPercentual(custoInfo?.imposto_percentual);
    const comissaoValor = numeroSeguro(comissaoInfo?.valor);
    const comissaoPct = precoVenda > 0 ? (comissaoValor / precoVenda) * 100 : 0;
    const impostoValor = (precoVenda * impostoPct) / 100;
    const lc = precoVenda - comissaoValor - frete - impostoValor - custo;
    const mc = precoVenda > 0 ? (lc / precoVenda) * 100 : 0;

    return { precoVenda, custo, impostoPct, impostoValor, comissaoPct, comissaoValor, frete, lc, mc };
  }

  // ==========================
  // RENDER DOS CARDS
  // ==========================
  function getBoxKey(row, index) {
    const id = extrairIdPainel(row);
    return id ? `venforce-box-${id}-${index}` : `venforce-box-index-${index}`;
  }

  function ensureBox(key) {
    const root = getOverlayRoot();
    let box = root.querySelector(`[data-venforce-key="${key}"]`);
    if (box) return box;

    box = document.createElement("div");
    box.className = `${BOX_CLASS} venforce-card-green`;
    box.setAttribute("data-venforce-key", key);
    box.setAttribute("data-expanded", "false");
    root.appendChild(box);
    return box;
  }

  function renderSemCusto(box, id) {
    box.className = `${BOX_CLASS} venforce-card-yellow venforce-compact`;
    box.innerHTML = `
      <div style="font-size:8px;opacity:0.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${id || "—"}</div>
      <div style="font-size:9px;font-weight:700;margin-top:2px;" class="venforce-yellow-text">Sem custo</div>
      <div style="font-size:8px;opacity:0.38;margin-top:1px;">Base: ${currentBaseId || "nenhuma"}</div>
    `;
  }

  function renderErroExtracao(box, id) {
    box.className = `${BOX_CLASS} venforce-card-red venforce-compact`;
    box.innerHTML = `
      <div style="font-size:8px;opacity:0.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${id || "—"}</div>
      <div style="font-size:9px;font-weight:700;margin-top:2px;" class="venforce-red-text">Erro</div>
    `;
  }

  function renderBox(box, id, dados, extras = {}) {
    const lcClass = classeNumero(dados.lc);
    const mcClass = classeNumero(dados.mc);
    const cardCls = getCardColorClassByMc(dados.mc);
    const status = getStatusByMc(dados.mc);
    const expanded = box.getAttribute("data-expanded") === "true";
    const temPromo = (extras.precoPromocional || 0) > 0;

    box.onclick = () => {
      box.setAttribute("data-expanded", String(!(box.getAttribute("data-expanded") === "true")));
      renderBox(box, id, dados, extras);
      requestAnimationFrame(() => scheduleProcess());
    };

    box.className = `${BOX_CLASS} ${cardCls}${expanded ? "" : " venforce-compact"}`;

    if (!expanded) {
      box.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:2px;">
          <div style="min-width:0;flex:1;">
            <div style="font-size:8px;opacity:0.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${id}</div>
            <div style="font-size:13px;font-weight:700;line-height:1.1;margin-top:1px;">${porcentagem(dados.mc)}</div>
            <div style="font-size:8px;font-weight:700;margin-top:1px;" class="${status.classe}">${status.texto}</div>
          </div>
          <div class="venforce-arrow" style="flex-shrink:0;">▶</div>
        </div>
      `;
      return;
    }

    box.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px;">
        <span style="font-size:9px;font-weight:700;opacity:0.5;letter-spacing:.04em;">VENFORCE</span>
        <div class="venforce-arrow open">▶</div>
      </div>
      <div style="font-size:8px;opacity:0.38;margin-bottom:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">ID: ${id}</div>
      <div class="vf-grid3">
        <div class="vf-cell"><span class="vf-lbl">Venda</span><span class="vf-val">${moeda(dados.precoVenda)}</span></div>
        <div class="vf-cell"><span class="vf-lbl">Frete</span><span class="vf-val">${moeda(dados.frete)}</span></div>
        <div class="vf-cell"><span class="vf-lbl">Custo</span><span class="vf-val">${moeda(dados.custo)}</span></div>
        <div class="vf-cell"><span class="vf-lbl">Com R$</span><span class="vf-val">${moeda(dados.comissaoValor)}</span></div>
        <div class="vf-cell"><span class="vf-lbl">Com %</span><span class="vf-val">${porcentagem(dados.comissaoPct)}</span></div>
        <div class="vf-cell"><span class="vf-lbl">Imp %</span><span class="vf-val">${porcentagem(dados.impostoPct)}</span></div>
        <div class="vf-cell"><span class="vf-lbl">Imp R$</span><span class="vf-val">${moeda(dados.impostoValor)}</span></div>
        <div class="vf-cell"><span class="vf-lbl">Cheio</span><span class="vf-val">${moeda(extras.precoCheio || dados.precoVenda)}</span></div>
        ${temPromo
          ? `<div class="vf-cell"><span class="vf-lbl">Promo</span><span class="vf-val">${moeda(extras.precoPromocional)}</span></div>`
          : `<div class="vf-cell"></div>`}
      </div>
      <hr class="vf-sep">
      <div class="vf-grid2">
        <div class="vf-cell"><span class="vf-lbl">LC</span><span class="vf-val ${lcClass}">${moeda(dados.lc)}</span></div>
        <div class="vf-cell"><span class="vf-lbl">MC %</span><span class="vf-val ${mcClass}">${porcentagem(dados.mc)}</span></div>
      </div>
      <div style="margin-top:4px;font-size:9px;font-weight:700;" class="${status.classe}">${status.texto}</div>
      <div style="margin-top:1px;font-size:8px;opacity:0.38;">Base: ${currentBaseId || "nenhuma"}</div>
    `;
  }

  function cleanupBoxes(validKeys) {
    getOverlayRoot().querySelectorAll(`.${BOX_CLASS}`).forEach(box => {
      if (!validKeys.has(box.getAttribute("data-venforce-key"))) box.remove();
    });
  }

  function positionBoxes(items) {
    items.forEach(({ box, row }) => {
      const rect = row.getBoundingClientRect();
      const isNarrow = window.innerWidth < 768;
      const dynamicWidth = Math.min(BOX_WIDTH, Math.max(200, window.innerWidth - 24));
      const desiredLeft = window.scrollX + rect.right + CARD_GAP_FROM_ROW;
      const left = isNarrow
        ? window.scrollX + 10
        : Math.max(10, Math.min(desiredLeft, window.scrollX + window.innerWidth - dynamicWidth - VIEWPORT_RIGHT_GAP));

      box.style.top = `${window.scrollY + rect.top}px`;
      box.style.left = `${left}px`;
    });
  }

  // ==========================
  // PROCESSAR PÁGINA
  // ==========================
  function processarRow(row, index) {
    const key = getBoxKey(row, index);
    const box = ensureBox(key);
    const cache = box.__venforceCache;
    const podeUsarCache = row.dataset?.vfProcessed === "1" && cache?.id && cache?.dados;

    let id, precoInfo, dados;

    if (podeUsarCache) {
      ({ id, precoInfo, dados } = cache);
    } else {
      id = extrairIdPainel(row);
      if (!id) { renderErroExtracao(box, null); return { key, box, row }; }

      const custoInfo = COST_DB[id];
      if (!custoInfo) { renderSemCusto(box, id); return { key, box, row }; }

      precoInfo = extrairPrecoVenda(row);
      if (!precoInfo.precoVenda) { renderErroExtracao(box, id); return { key, box, row }; }

      const comissaoInfo = extrairComissaoInfo(row, precoInfo.precoVenda);
      const frete = extrairFrete(row);
      dados = calcular(precoInfo.precoVenda, custoInfo, comissaoInfo, frete);
    }

    if (collapseAllOnNextRender) box.setAttribute("data-expanded", "false");
    else if (expandAllOnNextRender) box.setAttribute("data-expanded", "true");

    renderBox(box, id, dados, { precoCheio: precoInfo.precoCheio, precoPromocional: precoInfo.precoPromocional });

    const token = getTokenLocalStorage();
    if (token) {
      const status = getStatusByMc(dados.mc)?.texto || "";
      adicionarAnuncio(id, { mc: dados.mc, preco: dados.precoVenda, status });
    }

    if (!podeUsarCache) box.__venforceCache = { id, dados, precoInfo };
    row.dataset.vfProcessed = "1";

    return { key, box, row };
  }

  function processarPagina() {
    scheduled = false;
    syncOverlaySize();

    const rows = getPainelRows();
    const validKeys = new Set();
    const items = [];

    rows.forEach((row, index) => {
      const item = processarRow(row, index);
      validKeys.add(item.key);
      items.push(item);
    });

    cleanupBoxes(validKeys);
    positionBoxes(items);
    syncOverlaySize();

    if (expandAllOnNextRender) expandAllOnNextRender = false;
    if (collapseAllOnNextRender) collapseAllOnNextRender = false;
  }

  function scheduleProcess() {
    const now = Date.now();
    if (now - (scheduleProcess.lastRun || 0) < 800 || scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduleProcess.lastRun = Date.now();
      processarPagina();
    });
  }

  function scheduleFullReload() {
    (async () => {
      await loadCosts();
      if (!Object.keys(COST_DB).length) {
        getOverlayRoot().querySelectorAll(`.${BOX_CLASS}`).forEach(el => el.remove());
      }
      scheduleProcess();
    })();
  }

  // ==========================
  // OBSERVERS
  // ==========================
  function startObserver() {
    new MutationObserver(mutations => {
      if (mutations.some(m => m.addedNodes?.length > 0)) scheduleProcess();
    }).observe(document.body, { childList: true, subtree: true });

    window.addEventListener("scroll", scheduleProcess, { passive: true });
    window.addEventListener("resize", scheduleProcess);
    window.addEventListener("load", scheduleProcess);
  }

  function startStorageWatcher() {
    if (!chrome?.storage?.onChanged) return;

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      const keys = ["baseAtiva", "baseSelecionada", "token", "user", "venforce_user"];
      if (keys.some(k => k in changes)) {
        console.log("[VenForce] storage alterado, recarregando...");
        scheduleFullReload();
      }
    });
  }

  // ==========================
  // MENSAGENS DO POPUP
  // ==========================
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === "VENFORCE_EXPAND_ALL") {
      expandAllOnNextRender = true;
      scheduleProcess();
    }
  });

  // ==========================
  // INIT
  // ==========================
  async function init() {
    if (!PLATAFORMA) return;
    await loadCosts();
    ensureOverlay();
    syncOverlaySize();
    processarPagina();
    startObserver();
    startStorageWatcher();
    atualizarScanUI();
    console.log("[VenForce] inicialização concluída");
  }

  chrome.storage?.local?.get(["venforce_ativo"], result => {
    if (result?.venforce_ativo === false) {
      console.log("[VenForce] extensão desativada pelo usuário");
      return;
    }
    init();
  });
})();
