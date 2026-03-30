console.log("[VenForce] extensão iniciada");

(function () {
  const API_CANDIDATES = [
    "https://venforce-server.onrender.com"
  ];

  const OVERLAY_ID = "venforce-overlay-root";
  const BOX_CLASS = "venforce-card-box";

  const BOX_WIDTH = 280;
  const CARD_GAP_FROM_ROW = 18;
  const VIEWPORT_RIGHT_GAP = 12;
  const MIN_VERTICAL_GAP = 10;

  let COST_DB = {};
  let scheduled = false;
  let currentBaseId = null;
  let currentApiBase = null;
  let expandAllOnNextRender = false;
  let collapseAllOnNextRender = false;

  function detectarPlataforma() {
    const hostname = (location?.hostname || "").toLowerCase();
    if (hostname.includes("mercadolivre")) return "ml";
    if (hostname.includes("shopee")) return "shopee";
    return null;
  }

  const PLATAFORMA = detectarPlataforma();

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

      .vf-dbg-green {
        background: #e8f8ee;
        border-radius: 6px;
        padding: 4px 2px;
        font-size: 10px;
        color: #1a7a42;
        font-weight: 700;
      }

      .vf-dbg-yellow {
        background: #fffbea;
        border-radius: 6px;
        padding: 4px 2px;
        font-size: 10px;
        color: #8a5c00;
        font-weight: 700;
      }

      .vf-dbg-red {
        background: #fef0f0;
        border-radius: 6px;
        padding: 4px 2px;
        font-size: 10px;
        color: #c62828;
        font-weight: 700;
      }

      .vf-dbg-label {
        font-size: 8px;
        font-weight: 400;
        display: block;
        margin-top: 1px;
      }

      .vf-dbg-media {
        margin-top: 5px;
        font-size: 10px;
        color: #666;
        text-align: center;
      }
    `;

    root.appendChild(style);
  }

  function moeda(valor) {
    return Number(valor || 0).toLocaleString("pt-BR", {
      style: "currency",
      currency: "BRL"
    });
  }

  function porcentagem(valor) {
    return `${Number(valor || 0).toFixed(2)}%`;
  }

  function numeroSeguro(valor) {
    if (valor === null || valor === undefined || valor === "") return 0;

    if (typeof valor === "number") {
      return Number.isFinite(valor) ? valor : 0;
    }

    let texto = String(valor).trim();
    if (!texto) return 0;

    texto = texto.replace(/\s/g, "").replace("%", "");

    if (texto.includes(",") && texto.includes(".")) {
      texto = texto.replace(/\./g, "").replace(",", ".");
    } else if (texto.includes(",")) {
      texto = texto.replace(",", ".");
    } else if (texto.includes(".")) {
      if (/^\d{1,3}(\.\d{3})+$/.test(texto)) {
        texto = texto.replace(/\./g, "");
      }
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
    } else if (valor.includes(".")) {
      if (/^\d{1,3}(\.\d{3})+$/.test(valor)) {
        valor = valor.replace(/\./g, "");
      }
    }

    const n = Number(valor);
    return Number.isFinite(n) ? n : 0;
  }

  function extrairTodosOsPrecosDoTexto(texto) {
    if (!texto) return [];

    const matches = [...String(texto).matchAll(/R\$\s*([\d\.]+,\d{2}|[\d\.]+)/gi)];
    const valores = [];

    for (const match of matches) {
      const valor = extrairNumeroDeTexto(match[0]);
      if (valor > 0) valores.push(valor);
    }

    return valores;
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
    if (mc <= 6) {
      return { texto: "Crítico", classe: "venforce-red-text" };
    }

    if (mc < 10) {
      return { texto: "Atenção", classe: "venforce-yellow-text" };
    }

    return { texto: "Saudável", classe: "venforce-green-text" };
  }

  function getTextoLimpo(el) {
    return (el?.innerText || "").replace(/\u00a0/g, " ").trim();
  }

  function getLinhas(texto) {
    return String(texto || "")
      .replace(/\u00a0/g, " ")
      .split("\n")
      .map((s) => s.trim())
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

  async function getStorage() {
    return chrome.storage.local.get([
      "baseAtiva",
      "baseSelecionada",
      "venforce_email",
      "venforce_user",
      "email",
      "user",
      "token"
    ]);
  }

  async function getSessao() {
    try {
      const storage = await getStorage();

      return {
        baseAtiva: storage.baseSelecionada || storage.baseAtiva || null,
        email:
          storage.venforce_email ||
          storage.email ||
          storage.user?.email ||
          storage.venforce_user?.email ||
          null,
        user: storage.user || storage.venforce_user || null,
        token: storage.token || null
      };
    } catch (error) {
      console.error("[VenForce] erro ao ler sessão:", error);
      return {
        baseAtiva: null,
        email: null,
        user: null,
        token: null
      };
    }
  }

  async function fetchJson(url, options = {}) {
    const response = await fetch(url, options);
    const text = await response.text();

    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    return { response, json, text };
  }

  async function tryHealth(baseUrl) {
    try {
      const { response } = await fetchJson(`${baseUrl}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }

  async function resolveApiBase() {
    if (currentApiBase) return currentApiBase;

    for (const base of API_CANDIDATES) {
      const ok = await tryHealth(base);
      if (ok) {
        currentApiBase = base;
        console.log("[VenForce] API detectada em:", base);
        return base;
      }
    }

    currentApiBase = API_CANDIDATES[0];
    return currentApiBase;
  }

  function clearLoadedBase() {
    COST_DB = {};
    currentBaseId = null;
  }

  function clearAllBoxes() {
    const overlay = document.getElementById(OVERLAY_ID);
    if (!overlay?.shadowRoot) return;
    overlay.shadowRoot.querySelectorAll(`.${BOX_CLASS}`).forEach((el) => el.remove());
  }

  async function loadCostsByToken(baseUrl, sessao) {
    if (!sessao.token || !sessao.baseAtiva) return false;

    try {
      const { response, json } = await fetchJson(
        `${baseUrl}/bases-drive/${encodeURIComponent(sessao.baseAtiva)}`,
        {
          headers: {
            Authorization: `Bearer ${sessao.token}`
          }
        }
      );

      if (!response.ok || !json?.ok) {
        throw new Error(json?.erro || `HTTP ${response.status}`);
      }

      COST_DB = json.dados || {};
      currentBaseId = json.baseId || sessao.baseAtiva;

      console.log(
        "[VenForce] base carregada via token/drive:",
        currentBaseId,
        Object.keys(COST_DB).length
      );
      return true;
    } catch (error) {
      console.warn("[VenForce] falha no carregamento via token/drive:", error.message);
      return false;
    }
  }

  async function loadCostsByLegacyEmail(baseUrl, sessao) {
    if (!sessao.email || !sessao.baseAtiva) return false;

    try {
      const { response, json } = await fetchJson(
        `${baseUrl}/api/custos/${encodeURIComponent(sessao.baseAtiva)}?email=${encodeURIComponent(sessao.email)}`
      );

      if (!response.ok || !json?.ok) {
        throw new Error(json?.erro || `HTTP ${response.status}`);
      }

      COST_DB = json.data || {};
      currentBaseId = json.cliente || sessao.baseAtiva;

      console.log(
        "[VenForce] base carregada via email:",
        currentBaseId,
        Object.keys(COST_DB).length
      );
      return true;
    } catch (error) {
      console.warn("[VenForce] falha no carregamento legado:", error.message);
      return false;
    }
  }

  async function loadCostsFromApi() {
    const sessao = await getSessao();
    const baseUrl = await resolveApiBase();

    if (!sessao.baseAtiva) {
      console.warn("[VenForce] nenhuma base ativa selecionada");
      clearLoadedBase();
      return false;
    }

    if (!sessao.token && !sessao.email) {
      console.warn("[VenForce] usuário não logado");
      clearLoadedBase();
      return false;
    }

    const okToken = await loadCostsByToken(baseUrl, sessao);
    if (okToken) return true;

    const okLegacy = await loadCostsByLegacyEmail(baseUrl, sessao);
    if (okLegacy) return true;

    clearLoadedBase();
    return false;
  }

  async function loadCostsLocalFallback() {
    try {
      const url = chrome.runtime.getURL("custos.json");
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Fallback não encontrado (${response.status})`);
      }

      COST_DB = await response.json();
      currentBaseId = "fallback-local";
      console.log("[VenForce] fallback local carregado");
      return true;
    } catch (error) {
      console.error("[VenForce] erro no fallback local:", error);
      clearLoadedBase();
      return false;
    }
  }

  async function loadCosts() {
    const ok = await loadCostsFromApi();
    if (!ok) {
      await loadCostsLocalFallback();
    }
  }

  function ensureOverlay() {
    let overlay = document.getElementById(OVERLAY_ID);
    if (overlay) return overlay;

    overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.style.position = "absolute";
    overlay.style.top = "0";
    overlay.style.left = "0";
    overlay.style.width = "100%";
    overlay.style.pointerEvents = "none";
    overlay.style.zIndex = "999999";
    document.body.appendChild(overlay);

    const root = overlay.attachShadow({ mode: "open" });
    injectStyles(root);

    const expandWrap = document.createElement("div");
    expandWrap.className = "venforce-expand-all-wrap";
    const expandBtn = document.createElement("button");
    expandBtn.type = "button";
    expandBtn.className = "venforce-expand-all-btn";
    expandBtn.textContent = "Expandir todos";
    expandBtn.addEventListener("click", () => {
      collapseAllOnNextRender = false;
      expandAllOnNextRender = true;
      scheduleProcess();
    });
    expandWrap.appendChild(expandBtn);

    const collapseBtn = document.createElement("button");
    collapseBtn.type = "button";
    collapseBtn.className = "venforce-collapse-all-btn";
    collapseBtn.textContent = "Recolher todos";
    collapseBtn.addEventListener("click", () => {
      expandAllOnNextRender = false;
      collapseAllOnNextRender = true;
      scheduleProcess();
    });
    expandWrap.appendChild(collapseBtn);

    const sep = document.createElement("div");
    sep.style.cssText = "border-top:1px solid rgba(0,0,0,0.1); margin:2px 0;";
    expandWrap.appendChild(sep);

    const scanBtn = document.createElement("button");
    scanBtn.type = "button";
    scanBtn.id = "vf-scan-btn";
    scanBtn.className = "venforce-scan-btn";
    scanBtn.textContent = "▶ Escanear página";
    scanBtn.addEventListener("click", async () => {
      scanBtn.disabled = true;
      scanBtn.textContent = "Escaneando...";

      collapseAllOnNextRender = false;
      expandAllOnNextRender = true;
      scheduleProcess();

      await new Promise((r) => setTimeout(r, 1200));

      processarPagina();
      await new Promise((r) => setTimeout(r, 400));

      atualizarDebugNaPagina();

      scanBtn.disabled = false;
      scanBtn.textContent = "▶ Escanear página";
    });
    expandWrap.appendChild(scanBtn);

    const debugBox = document.createElement("div");
    debugBox.id = "vf-debug-box";
    debugBox.className = "venforce-debug-box";
    debugBox.style.display = "none";
    debugBox.innerHTML = `
    <div class="venforce-debug-total">
      <span>Escaneados</span>
      <span id="vf-dbg-total">0</span>
    </div>
    <div class="venforce-debug-grid">
      <div class="vf-dbg-green">
        <span id="vf-dbg-sau">0</span>
        <span class="vf-dbg-label">Saudável</span>
      </div>
      <div class="vf-dbg-yellow">
        <span id="vf-dbg-ate">0</span>
        <span class="vf-dbg-label">Atenção</span>
      </div>
      <div class="vf-dbg-red">
        <span id="vf-dbg-cri">0</span>
        <span class="vf-dbg-label">Crítico</span>
      </div>
    </div>
    <div class="vf-dbg-media" id="vf-dbg-media"></div>
  `;
    expandWrap.appendChild(debugBox);

    root.appendChild(expandWrap);

    return overlay;
  }

  function atualizarDebugNaPagina() {
    const root = getOverlayRoot();
    if (!root) return;

    const debugBox = root.getElementById("vf-debug-box");
    if (!debugBox) return;

    const boxes = root.querySelectorAll("[data-venforce-key]");
    const dados = [];

    boxes.forEach((box) => {
      const cache = box.__venforceCache;
      if (!cache?.id || !cache?.dados) return;
      dados.push(cache.dados);
    });

    const total = dados.length;
    if (!total) return;

    const saudaveis = dados.filter((d) => d.mc >= 10).length;
    const atencao = dados.filter((d) => d.mc >= 6 && d.mc < 10).length;
    const criticos = dados.filter((d) => d.mc < 6).length;
    const mcMedia = dados.reduce((s, d) => s + (d.mc || 0), 0) / total;

    const elTotal = root.getElementById("vf-dbg-total");
    const elSau = root.getElementById("vf-dbg-sau");
    const elAte = root.getElementById("vf-dbg-ate");
    const elCri = root.getElementById("vf-dbg-cri");
    const elMedia = root.getElementById("vf-dbg-media");

    if (elTotal) elTotal.textContent = total;
    if (elSau) elSau.textContent = saudaveis;
    if (elAte) elAte.textContent = atencao;
    if (elCri) elCri.textContent = criticos;
    if (elMedia) elMedia.textContent = `MC médio: ${mcMedia.toFixed(2)}%`;

    debugBox.style.display = "block";
  }

  function getOverlayRoot() {
    const overlay = ensureOverlay();
    if (!overlay.shadowRoot) {
      const root = overlay.attachShadow({ mode: "open" });
      injectStyles(root);
    }
    return overlay.shadowRoot;
  }

  function syncOverlaySize() {
    const overlay = ensureOverlay();
    const body = document.body;
    const html = document.documentElement;

    const width = Math.max(
      body.scrollWidth,
      body.offsetWidth,
      html.clientWidth,
      html.scrollWidth,
      html.offsetWidth
    );

    const height = Math.max(
      body.scrollHeight,
      body.offsetHeight,
      html.clientHeight,
      html.scrollHeight,
      html.offsetHeight
    );

    overlay.style.width = `${width}px`;
    overlay.style.height = `${height}px`;
  }

  function isRowCandidate(el) {
    const t = getTextoLimpo(el);
    if (!t) return false;

    const hasId = /#\d{8,}/.test(t) || /\b\d{8,}\b/.test(t);
    const hasPrice = /R\$\s*[\d\.]+,\d{2}/.test(t);
    const hasCommission = /Clássico|Classico|Premium|Tarifa de venda/i.test(t);
    const hasShipping =
      /Envio por conta do comprador|Você oferece frete grátis|Frete grátis|por usar o Flex|A pagar R\$/i.test(t);

    if (!hasId || !hasPrice || !hasCommission || !hasShipping) return false;

    const rect = el.getBoundingClientRect();
    if (rect.width < 700) return false;
    if (rect.height < 90) return false;
    if (rect.height > 700) return false;

    const hasCheckbox = !!el.querySelector('input[type="checkbox"]');
    if (!hasCheckbox && rect.width < 900) return false;

    return true;
  }

  function getPainelRows() {
    const selectors =
      PLATAFORMA === "ml"
        ? ["div", "section", "article", "[role='row']"]
        : [
            '[data-sqe="item"]',
            "div[role='row']",
            "[role='row']"
          ];
    const candidates = Array.from(
      document.querySelectorAll(selectors.join(","))
    ).filter(isRowCandidate);

    const rows = candidates.filter((el) => {
      return !candidates.some((other) => other !== el && el.contains(other));
    });

    rows.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return ra.top - rb.top;
    });

    return rows;
  }

  function extrairIdPainel(row) {
    const t = getTextoLimpo(row);

    let match = t.match(/#(\d{8,})/);
    if (match?.[1]) return match[1];

    match = t.match(/\b(\d{8,})\b/);
    if (match?.[1]) return match[1];

    return null;
  }

  function extrairPrecoVendaDoDOM(row) {
    const selectorsPrioritarios = [
      ".sc-list-actionable-cell__price--no-wrap",
      "[class*='price--no-wrap']",
      "[data-testid*='price']",
      "[class*='price']"
    ];

    for (const selector of selectorsPrioritarios) {
      const elementos = row.querySelectorAll(selector);
      for (const el of elementos) {
        const texto = getTextoLimpo(el);
        if (!/R\$\s*/i.test(texto)) continue;
        if (/a pagar|frete|envio|comiss[aã]o|tarifa/i.test(texto)) continue;

        const valor = extrairNumeroDeTexto(texto);
        if (valor > 0) return valor;
      }
    }

    return 0;
  }

  function extrairPrecoVenda(row) {
    const textoRow = getTextoLimpo(row);
    // Remove trechos de "preço de atacado" do texto usado na extração: listam valores menores que o preço de venda
    // e fazem extrairTodosOsPrecosDoTexto / heurísticas pegarem o valor errado.
    const textoSemAtacado = textoRow.replace(
      /(?:com\s+\d+\s+preços?\s+de\s+atacado|preços?\s+de\s+atacado)[\s\S]{0,300}?(?=\n\n|\nClássico|\nPremium|\nTarifa|$)/gi,
      ""
    );
    const linhasSemAtacado = getLinhas(textoSemAtacado);

    let precoCheio = 0;
    let precoPromocional = 0;
    let precoVenda = 0;

    // Padrão do layout novo: "Você vende por R$ 133,90 na promoção"
    // O preço cheio (R$ 175,54) aparece logo antes no texto como linha isolada
    const matchVendePor = textoRow.match(
      /você vende por\s+R\$\s*([\d\.]+(?:,\d{1,2})?)\s+na\s+promo[çc][aã]o/i
    );

    if (matchVendePor?.[1]) {
      precoPromocional = extrairNumeroDeTexto(`R$ ${matchVendePor[1]}`);

      // Tenta pegar o preço cheio: última ocorrência de R$X,XX antes de "você vende por"
      const idxVendePor = textoRow.toLowerCase().indexOf("você vende por");
      const textAntesVendePor = idxVendePor >= 0 ? textoRow.slice(0, idxVendePor) : "";
      const matchCheioAntes = [...textAntesVendePor.matchAll(/R\$\s*([\d\.]+(?:,\d{1,2})?)/gi)];
      if (matchCheioAntes.length) {
        const candidato = extrairNumeroDeTexto(
          `R$ ${matchCheioAntes[matchCheioAntes.length - 1][1]}`
        );
        if (candidato > precoPromocional) {
          precoCheio = candidato;
        }
      }
      if (!precoCheio) precoCheio = precoPromocional;

      precoVenda = precoPromocional;
      return { precoVenda, precoCheio, precoPromocional };
    }

    const matchPromoForte = textoSemAtacado.match(
      /R\$\s*([\d\.]+,\d{2}|[\d\.]+)[\s\S]{0,80}?(?:em promoção|na promoção)[\s\S]{0,40}?(?:a\s*)?R\$\s*([\d\.]+,\d{2}|[\d\.]+)/i
    );

    if (matchPromoForte?.[1] && matchPromoForte?.[2]) {
      precoCheio = extrairNumeroDeTexto(`R$ ${matchPromoForte[1]}`);
      precoPromocional = extrairNumeroDeTexto(`R$ ${matchPromoForte[2]}`);
      precoVenda = precoPromocional || precoCheio;
      return { precoVenda, precoCheio, precoPromocional };
    }

    for (let i = 0; i < linhasSemAtacado.length; i++) {
      const linha = linhasSemAtacado[i];

      if (!precoCheio && /^R\$\s*[\d\.]+,\d{2}$/i.test(linha)) {
        const prox1 = (linhasSemAtacado[i + 1] || "").toLowerCase();
        const prox2 = linhasSemAtacado[i + 2] || "";
        const prox3 = linhasSemAtacado[i + 3] || "";

        if (
          prox1.includes("promoção") ||
          prox1.includes("promocao") ||
          /em promoção|na promoção/i.test(`${prox1} ${prox2} ${prox3}`)
        ) {
          precoCheio = extrairNumeroDeTexto(linha);

          const blocoPromo = `${linhasSemAtacado[i + 1] || ""} ${linhasSemAtacado[i + 2] || ""} ${linhasSemAtacado[i + 3] || ""}`;
          const promoMatch = blocoPromo.match(/R\$\s*([\d\.]+,\d{2}|[\d\.]+)/i);
          if (promoMatch?.[1]) {
            precoPromocional = extrairNumeroDeTexto(`R$ ${promoMatch[1]}`);
          }
          break;
        }
      }
    }

    if (!precoCheio) {
      const todosPrecos = extrairTodosOsPrecosDoTexto(textoSemAtacado);
      if (todosPrecos.length) {
        precoCheio = todosPrecos[0];
      }
    }

    if (!precoPromocional) {
      const matchPromoSolto = textoSemAtacado.match(
        /(?:em promoção|na promoção)[\s\S]{0,40}?(?:a\s*)?R\$\s*([\d\.]+,\d{2}|[\d\.]+)/i
      );
      if (matchPromoSolto?.[1]) {
        precoPromocional = extrairNumeroDeTexto(`R$ ${matchPromoSolto[1]}`);
      }
    }

    precoVenda = precoPromocional || precoCheio || 0;

    return {
      precoVenda,
      precoCheio: precoCheio || precoVenda || 0,
      precoPromocional: precoPromocional || 0
    };
  }

  function extrairComissaoInfo(row, precoVenda) {
    const t = getTextoLimpo(row);

    let valor = 0;

    valor = buscarValorAposBloco(t, /(Clássico|Classico|Premium|Tarifa de venda)/i, 220);

    if (!valor) {
      const match = t.match(
        /(Clássico|Classico|Premium|Tarifa de venda)[\s\S]{0,220}?A pagar\s*R\$\s*([\d\.]+,\d{2}|[\d\.]+)/i
      );
      if (match?.[2]) {
        valor = extrairNumeroDeTexto(`R$ ${match[2]}`);
      }
    }

    const percentual = precoVenda > 0 && valor > 0 ? (valor / precoVenda) * 100 : 0;

    return { percentual, valor };
  }

  function extrairFrete(row) {
    const t = getTextoLimpo(row);
    const tSemFlex = t.replace(
      /você receberá[\s\S]{0,80}?por usar o flex[\s\S]{0,40}?(?:\n|$)/gi,
      ""
    );
    const linhas = getLinhas(tSemFlex);

    // Heurística: no layout novo costuma aparecer "Qualidade do anúncio" / "Experiência..."
    // Aí tentamos a extração "ancorada" primeiro, mas preservando fallback.
    const isLayoutNovoAuto =
      /qualidade do an[uú]ncio|qualidade do anuncio|experi[eê]ncia de compra/i.test(t);

    const preferirNovo = isLayoutNovoAuto;

    function extrairFreteNovo() {
      const triggerRe =
        /(envio por conta do comprador|você oferece frete grátis|voce oferece frete grátis|frete grátis|frete|envio)/i;

      for (let i = 0; i < linhas.length; i++) {
        const linha = linhas[i];
        if (!triggerRe.test(linha)) continue;

        // Janela curta: evita capturar "A pagar" de outras colunas/linhas.
        const janelaRaw = linhas.slice(i, i + 8);
        const janela = janelaRaw.filter(
          (l) =>
            !/por usar o flex/i.test(l) && !/você receberá/i.test(l)
        );
        const janelaTexto = janela.join(" ");

        // Se é frete grátis e não tem valor na janela, assume 0.
        if (/frete\s*gr[aá]tis/i.test(linha) && !/R\$\s*/i.test(janelaTexto)) {
          return { found: true, value: 0 };
        }

        const matchAPagar = janelaTexto.match(
          /A pagar\s*R\$\s*([\d\.]+,\d{2}|[\d\.]+)/i
        );
        if (matchAPagar?.[1]) {
          return { found: true, value: extrairNumeroDeTexto(`R$ ${matchAPagar[1]}`) };
        }

        // Fallback dentro da janela: pega a primeira moeda apenas se a janela menciona frete/envio.
        const mencionaFreteEnvio = janela.some((l) =>
          /(frete|envio)/i.test(l)
        );
        if (mencionaFreteEnvio) {
          const matchMoeda = janelaTexto.match(/R\$\s*([\d\.]+,\d{2}|[\d\.]+)/i);
          if (matchMoeda?.[1]) {
            return { found: true, value: extrairNumeroDeTexto(`R$ ${matchMoeda[1]}`) };
          }
        }
      }

      return { found: false, value: 0 };
    }

    // Método antigo (layout atual)
    const valorAntigo = buscarValorAposBloco(
      tSemFlex,
      /(Envio por conta do comprador|Você oferece frete grátis|Frete grátis|Frete|Envio)/i,
      240
    );
    if (!preferirNovo && valorAntigo) return valorAntigo;

    const matchAntigo = tSemFlex.match(
      /(Envio por conta do comprador|Você oferece frete grátis|Frete grátis|Frete|Envio)[\s\S]{0,240}?A pagar\s*R\$\s*([\d\.]+,\d{2}|[\d\.]+)/i
    );
    if (!preferirNovo && matchAntigo?.[2]) return extrairNumeroDeTexto(`R$ ${matchAntigo[2]}`);

    if (preferirNovo) {
      const vNovo = extrairFreteNovo();
      if (vNovo.found) return vNovo.value;
    }

    // Fallback final antigo
    if (valorAntigo) return valorAntigo;
    if (matchAntigo?.[2]) return extrairNumeroDeTexto(`R$ ${matchAntigo[2]}`);

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

    return {
      precoVenda,
      custo,
      impostoPct,
      impostoValor,
      comissaoPct,
      comissaoValor,
      frete,
      lc,
      mc
    };
  }

  function getBoxKey(row, index) {
    const id = extrairIdPainel(row);
    if (id) return `venforce-box-${id}-${index}`;
    return `venforce-box-index-${index}`;
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

    if (box.getAttribute("data-expanded") === null) {
      box.setAttribute("data-expanded", "false");
    }

    box.onclick = () => {
      const exp = box.getAttribute("data-expanded") === "true";
      box.setAttribute("data-expanded", String(!exp));
      renderBox(box, id, dados, extras);
      requestAnimationFrame(() => scheduleProcess());
    };

    const expanded = box.getAttribute("data-expanded") === "true";
    const temPromo = (extras.precoPromocional || 0) > 0;

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
          : `<div class="vf-cell"></div>`
        }
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
    const root = getOverlayRoot();
    const boxes = root.querySelectorAll(`.${BOX_CLASS}`);

    boxes.forEach((box) => {
      const key = box.getAttribute("data-venforce-key");
      if (!validKeys.has(key)) {
        box.remove();
      }
    });
  }

  function getDynamicBoxWidth() {
    return Math.min(BOX_WIDTH, Math.max(200, window.innerWidth - 24));
  }

  function getBoxLeftForRow(row) {
    const rect = row.getBoundingClientRect();
    const dynamicWidth = getDynamicBoxWidth();
    const desiredLeft = window.scrollX + rect.right + CARD_GAP_FROM_ROW;
    const finalLeft = Math.min(
      desiredLeft,
      window.scrollX + window.innerWidth - dynamicWidth - VIEWPORT_RIGHT_GAP
    );

    return Math.max(10, finalLeft);
  }

  function positionBoxes(items) {
    items.forEach((item) => {
      const { box, row } = item;
      const rect = row.getBoundingClientRect();

      const isNarrow = window.innerWidth < 768;
      const top = window.scrollY + rect.top;
      const left = isNarrow
        ? window.scrollX + 10
        : getBoxLeftForRow(row);

      box.style.top = `${top}px`;
      box.style.left = `${left}px`;
    });
  }

  function processarRow(row, index) {
    const key = getBoxKey(row, index);
    const box = ensureBox(key);

    const jaProcessado = row.dataset?.vfProcessed === "1";
    const cache = box.__venforceCache;

    let id = null;
    let precoInfo = null;
    let precoVenda = 0;
    let dados = null;

    const podeUsarCache =
      jaProcessado && cache && cache.id && cache.precoInfo && cache.dados;

    if (podeUsarCache) {
      id = cache.id;
      precoInfo = cache.precoInfo;
      precoVenda = precoInfo.precoVenda;
      dados = cache.dados;
    } else {
      id = extrairIdPainel(row);
      if (!id) {
        renderErroExtracao(box, null);
        return { key, box, row };
      }

      const custoInfo = COST_DB[id];
      if (!custoInfo) {
        renderSemCusto(box, id);
        return { key, box, row };
      }

      precoInfo = extrairPrecoVenda(row);
      precoVenda = precoInfo.precoVenda;

      if (!precoVenda) {
        console.warn("[VenForce] falha ao extrair preço", {
          id,
          texto: getTextoLimpo(row)
        });

        renderErroExtracao(box, id);
        return { key, box, row };
      }

      const comissaoInfo = extrairComissaoInfo(row, precoVenda);
      const frete = extrairFrete(row);
      dados = calcular(precoVenda, custoInfo, comissaoInfo, frete);
    }

    if (collapseAllOnNextRender) {
      box.setAttribute("data-expanded", "false");
    } else if (expandAllOnNextRender) {
      box.setAttribute("data-expanded", "true");
    }

    renderBox(box, id, dados, {
      precoCheio: precoInfo.precoCheio,
      precoPromocional: precoInfo.precoPromocional
    });

    if (!podeUsarCache) {
      box.__venforceCache = {
        id,
        dados,
        precoInfo
      };
    }

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
    const lastRun = scheduleProcess.lastRun || 0;

    // Throttle: não agendar mais de 1 execução a cada 800ms
    if (now - lastRun < 800) return;
    if (scheduled) return;

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
        clearAllBoxes();
      }

      scheduleProcess();
    })();
  }

  function startObserver() {
    const observer = new MutationObserver((mutations) => {
      // Evita execução quando só muda atributos/texto sem nós adicionados
      const temAddedNodes = mutations?.some(
        (m) => m.addedNodes && m.addedNodes.length > 0
      );
      if (temAddedNodes) scheduleProcess();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    window.addEventListener("scroll", scheduleProcess, { passive: true });
    window.addEventListener("resize", scheduleProcess);
    window.addEventListener("load", scheduleProcess);
  }

  function startStorageWatcher() {
    if (!chrome?.storage?.onChanged) return;

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;

      const keysImportantes = [
        "baseAtiva",
        "baseSelecionada",
        "venforce_user",
        "venforce_email",
        "user",
        "email",
        "token"
      ];

      const mudouAlgoImportante = keysImportantes.some((key) => key in changes);
      if (!mudouAlgoImportante) return;

      console.log("[VenForce] storage alterado, recarregando base...");
      scheduleFullReload();
    });
  }

  async function init() {
    if (!PLATAFORMA) return;
    await loadCosts();
    ensureOverlay();
    syncOverlaySize();

    if (!Object.keys(COST_DB).length) {
      clearAllBoxes();
    }

    processarPagina();
    startObserver();
    startStorageWatcher();

    console.log("[VenForce] inicialização concluída");
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === "VENFORCE_EXPAND_ALL") {
      expandAllOnNextRender = true;
      scheduleProcess();
    }
  });

  chrome.storage?.local?.get(["venforce_ativo"], (result) => {
    const ativo = result?.venforce_ativo !== false; // padrão: ativo

    if (!ativo) {
      console.log("[VenForce] extensão desativada pelo usuário");
      return;
    }

    init();
  });
})();
