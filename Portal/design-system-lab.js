(function () {
  "use strict";

  const STORAGE_KEY = "vf-design-system-lab-v2";
  const DEFAULTS = Object.freeze({
    primary: "#5a2a8f",
    fontSize: 15,
    spacingScale: 100,
    radius: 10,
    cardPadding: 20,
    tablePadding: 9,
    contentWidth: 1560,
    cardColumns: "auto",
    density: "comfortable",
    viewport: "wide",
  });

  const tokenRoot = document.getElementById("lab-density-root");
  const viewport = document.getElementById("lab-viewport");
  const changeState = document.getElementById("lab-change-state");
  const customizer = document.getElementById("lab-customizer");
  const customizerBackdrop = document.getElementById("lab-customizer-backdrop");

  if (!tokenRoot || !viewport || !customizer) return;

  let settings = loadSettings();

  function getUser() {
    try {
      return JSON.parse(localStorage.getItem("vf-user") || "{}") || {};
    } catch {
      return {};
    }
  }

  function enforceAccess() {
    const role = String(getUser().role || "").toLowerCase();
    const hasToken = Boolean(localStorage.getItem("vf-token"));
    if (hasToken && role !== "admin") {
      window.location.replace("dashboard.html");
      return false;
    }
    return true;
  }

  function loadSettings() {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      return { ...DEFAULTS, ...stored };
    } catch {
      return { ...DEFAULTS };
    }
  }

  function saveSettings() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function hexToRgb(hex) {
    const clean = String(hex).replace("#", "");
    const value = Number.parseInt(clean, 16);
    return {
      r: (value >> 16) & 255,
      g: (value >> 8) & 255,
      b: value & 255,
    };
  }

  function rgbToHex(rgb) {
    const part = (value) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0");
    return `#${part(rgb.r)}${part(rgb.g)}${part(rgb.b)}`;
  }

  function mix(hex, target, amount) {
    const source = hexToRgb(hex);
    const destination = hexToRgb(target);
    return rgbToHex({
      r: source.r + (destination.r - source.r) * amount,
      g: source.g + (destination.g - source.g) * amount,
      b: source.b + (destination.b - source.b) * amount,
    });
  }

  function setToken(name, value) {
    document.body.style.setProperty(name, value);
  }

  function applySettings(options = {}) {
    const { persist = true, syncControls = true } = options;
    const primaryRgb = hexToRgb(settings.primary);
    const typeScale = settings.fontSize / DEFAULTS.fontSize;
    const spacingScale = settings.spacingScale / 100;

    setToken("--vf-primary", settings.primary);
    setToken("--vf-primary-hover", mix(settings.primary, "#000000", 0.15));
    setToken("--vf-primary-active", mix(settings.primary, "#000000", 0.29));
    setToken("--vf-primary-strong", mix(settings.primary, "#000000", 0.22));
    setToken("--vf-primary-soft", mix(settings.primary, "#ffffff", 0.92));
    setToken("--vf-primary-soft-hover", mix(settings.primary, "#ffffff", 0.86));
    setToken("--vf-primary-border", mix(settings.primary, "#ffffff", 0.76));
    setToken("--vf-primary-rgb", `${primaryRgb.r}, ${primaryRgb.g}, ${primaryRgb.b}`);

    const typeTokens = {
      "--vf-fs-2xs": 11,
      "--vf-fs-xs": 12,
      "--vf-fs-sm": 14,
      "--vf-fs-md": 15,
      "--vf-fs-lg": 18,
      "--vf-fs-xl": 22,
      "--vf-fs-2xl": 26,
      "--vf-fs-3xl": 32,
    };
    Object.entries(typeTokens).forEach(([name, px]) => setToken(name, `${(px * typeScale).toFixed(2)}px`));

    const spacingTokens = {
      "--vf-sp-1": 4,
      "--vf-sp-2": 8,
      "--vf-sp-3": 12,
      "--vf-sp-4": 16,
      "--vf-sp-5": 20,
      "--vf-sp-6": 24,
      "--vf-sp-8": 32,
      "--vf-sp-10": 40,
      "--vf-sp-12": 48,
      "--vf-sp-16": 64,
    };
    Object.entries(spacingTokens).forEach(([name, px]) => setToken(name, `${Math.round(px * spacingScale)}px`));

    setToken("--vf-radius-sm", `${Math.max(0, settings.radius - 4)}px`);
    setToken("--vf-radius", `${settings.radius}px`);
    setToken("--vf-radius-lg", `${settings.radius + 2}px`);
    setToken("--vf-card-pad-x", `${settings.cardPadding}px`);
    setToken("--vf-card-pad-y", `${settings.cardPadding}px`);
    setToken("--vf-table-cell-py", `${settings.tablePadding}px`);
    setToken("--vf-content-wide", `${settings.contentWidth}px`);
    const cardGrid = document.getElementById("lab-card-grid");
    if (cardGrid) {
      cardGrid.style.gridTemplateColumns = settings.cardColumns === "auto"
        ? ""
        : `repeat(${settings.cardColumns}, minmax(0, 1fr))`;
    }

    tokenRoot.toggleAttribute("data-vf-density", settings.density === "compact");
    if (settings.density === "compact") tokenRoot.setAttribute("data-vf-density", "compact");
    viewport.dataset.width = settings.viewport;

    if (syncControls) syncControlValues();
    syncSegmentedControls();
    updateChangeState();
    if (persist) saveSettings();
  }

  function syncControlValues() {
    const controls = {
      "lab-primary-color": settings.primary,
      "lab-font-size": settings.fontSize,
      "lab-spacing-scale": settings.spacingScale,
      "lab-radius": settings.radius,
      "lab-card-padding": settings.cardPadding,
      "lab-table-padding": settings.tablePadding,
      "lab-content-width": String(settings.contentWidth),
      "lab-card-columns": settings.cardColumns,
    };
    Object.entries(controls).forEach(([id, value]) => {
      const control = document.getElementById(id);
      if (control) control.value = value;
    });

    const outputs = {
      "lab-primary-color-value": settings.primary,
      "lab-font-size-value": `${settings.fontSize}px`,
      "lab-spacing-scale-value": `${settings.spacingScale}%`,
      "lab-radius-value": `${settings.radius}px`,
      "lab-card-padding-value": `${settings.cardPadding}px`,
      "lab-table-padding-value": `${settings.tablePadding}px`,
    };
    Object.entries(outputs).forEach(([id, value]) => {
      const output = document.getElementById(id);
      if (output) output.textContent = value;
    });
  }

  function syncSegmentedControls() {
    document.querySelectorAll("button[data-density]").forEach((button) => {
      const active = button.dataset.density === settings.density;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    document.querySelectorAll("button[data-width]").forEach((button) => {
      const active = button.dataset.width === settings.viewport;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
  }

  function updateChangeState() {
    const keys = ["primary", "fontSize", "spacingScale", "radius", "cardPadding", "tablePadding", "contentWidth", "cardColumns"];
    const changes = keys.filter((key) => String(settings[key]) !== String(DEFAULTS[key])).length;
    if (!changeState) return;
    changeState.classList.toggle("is-edited", changes > 0);
    changeState.textContent = changes ? `${changes} ajuste${changes > 1 ? "s" : ""} local${changes > 1 ? "is" : ""}` : "Fundação V2 · padrão";
  }

  function openCustomizer() {
    customizer.classList.add("is-open");
    customizerBackdrop.classList.add("is-open");
    customizer.setAttribute("aria-hidden", "false");
    customizer.removeAttribute("inert");
    document.getElementById("lab-open-customizer")?.setAttribute("aria-expanded", "true");
    document.body.classList.add("vf-no-scroll");
    document.getElementById("lab-primary-color")?.focus();
  }

  function closeCustomizer() {
    customizer.classList.remove("is-open");
    customizerBackdrop.classList.remove("is-open");
    customizer.setAttribute("aria-hidden", "true");
    customizer.setAttribute("inert", "");
    document.getElementById("lab-open-customizer")?.setAttribute("aria-expanded", "false");
    document.body.classList.remove("vf-no-scroll");
  }

  function resetSettings() {
    settings = { ...DEFAULTS };
    localStorage.removeItem(STORAGE_KEY);
    applySettings({ persist: false });
    showToast("success", "Padrão restaurado", "O laboratório voltou aos tokens oficiais da Fundação V2.");
  }

  function cssExport() {
    const scale = settings.spacingScale / 100;
    const typeScale = settings.fontSize / DEFAULTS.fontSize;
    const primaryRgb = hexToRgb(settings.primary);
    const px = (value) => `${Math.round(value * scale)}px`;
    const type = (value) => `${(value * typeScale).toFixed(2)}px`;
    return `/* Experimento gerado no Design System Lab */\n:root {\n  --vf-primary: ${settings.primary};\n  --vf-primary-hover: ${mix(settings.primary, "#000000", 0.15)};\n  --vf-primary-active: ${mix(settings.primary, "#000000", 0.29)};\n  --vf-primary-strong: ${mix(settings.primary, "#000000", 0.22)};\n  --vf-primary-soft: ${mix(settings.primary, "#ffffff", 0.92)};\n  --vf-primary-soft-hover: ${mix(settings.primary, "#ffffff", 0.86)};\n  --vf-primary-border: ${mix(settings.primary, "#ffffff", 0.76)};\n  --vf-primary-rgb: ${primaryRgb.r}, ${primaryRgb.g}, ${primaryRgb.b};\n\n  --vf-fs-2xs: ${type(11)};\n  --vf-fs-xs: ${type(12)};\n  --vf-fs-sm: ${type(14)};\n  --vf-fs-md: ${type(15)};\n  --vf-fs-lg: ${type(18)};\n  --vf-fs-xl: ${type(22)};\n  --vf-fs-2xl: ${type(26)};\n  --vf-fs-3xl: ${type(32)};\n\n  --vf-sp-1: ${px(4)};\n  --vf-sp-2: ${px(8)};\n  --vf-sp-3: ${px(12)};\n  --vf-sp-4: ${px(16)};\n  --vf-sp-5: ${px(20)};\n  --vf-sp-6: ${px(24)};\n  --vf-sp-8: ${px(32)};\n  --vf-sp-10: ${px(40)};\n  --vf-sp-12: ${px(48)};\n  --vf-sp-16: ${px(64)};\n\n  --vf-radius-sm: ${Math.max(0, settings.radius - 4)}px;\n  --vf-radius: ${settings.radius}px;\n  --vf-radius-lg: ${settings.radius + 2}px;\n  --vf-card-pad-x: ${settings.cardPadding}px;\n  --vf-card-pad-y: ${settings.cardPadding}px;\n  --vf-table-cell-py: ${settings.tablePadding}px;\n  --vf-content-wide: ${settings.contentWidth}px;\n}\n\n/* Layout de cards testado: ${settings.cardColumns === "auto" ? "responsivo automático" : `${settings.cardColumns} coluna(s)`} */`;
  }

  async function copyCss() {
    const css = cssExport();
    try {
      await navigator.clipboard.writeText(css);
      showToast("success", "CSS copiado", "As variáveis do experimento estão prontas para revisão.");
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = css;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
      showToast("success", "CSS copiado", "As variáveis do experimento estão prontas para revisão.");
    }
  }

  function showToast(kind, title, description) {
    const stack = document.getElementById("lab-toast-stack");
    if (!stack) return;
    const toast = document.createElement("div");
    toast.className = `vf-toast is-${kind}`;
    toast.setAttribute("role", "status");
    toast.innerHTML = `<div class="vf-toast__content"><p class="vf-toast__title"></p><p class="vf-toast__description"></p></div><button type="button" class="vf-toast__close" aria-label="Fechar notificação">✕</button>`;
    toast.querySelector(".vf-toast__title").textContent = title;
    toast.querySelector(".vf-toast__description").textContent = description;
    toast.querySelector(".vf-toast__close").addEventListener("click", () => toast.remove());
    stack.appendChild(toast);
    window.setTimeout(() => toast.remove(), 4500);
  }

  function bindTokenControls() {
    const definitions = [
      ["lab-primary-color", "primary", String],
      ["lab-font-size", "fontSize", Number],
      ["lab-spacing-scale", "spacingScale", Number],
      ["lab-radius", "radius", Number],
      ["lab-card-padding", "cardPadding", Number],
      ["lab-table-padding", "tablePadding", Number],
      ["lab-content-width", "contentWidth", Number],
      ["lab-card-columns", "cardColumns", String],
    ];
    definitions.forEach(([id, key, parse]) => {
      document.getElementById(id)?.addEventListener("input", (event) => {
        settings[key] = parse(event.target.value);
        applySettings({ syncControls: false });
        syncControlValues();
      });
    });
  }

  function bindToolbar() {
    document.querySelectorAll("button[data-density]").forEach((button) => {
      button.addEventListener("click", () => {
        settings.density = button.dataset.density;
        saveSettings();
        updateChangeState();
      });
    });
    document.querySelectorAll("button[data-width]").forEach((button) => {
      button.addEventListener("click", () => {
        settings.viewport = button.dataset.width;
        saveSettings();
      });
    });

    document.getElementById("lab-open-customizer")?.addEventListener("click", openCustomizer);
    document.getElementById("lab-close-customizer")?.addEventListener("click", closeCustomizer);
    customizerBackdrop.addEventListener("click", closeCustomizer);
    document.getElementById("lab-reset")?.addEventListener("click", resetSettings);
    document.getElementById("lab-panel-reset")?.addEventListener("click", resetSettings);
    document.getElementById("lab-copy-css")?.addEventListener("click", copyCss);
    document.getElementById("lab-panel-copy")?.addEventListener("click", copyCss);

    document.getElementById("lab-jump-context")?.addEventListener("click", () => scrollToSection("sec-context"));
    document.getElementById("lab-compare-density")?.addEventListener("click", () => scrollToSection("sec-density"));

    document.getElementById("lab-section-jump")?.addEventListener("change", (event) => {
      if (event.target.value) scrollToSection(event.target.value);
      event.target.value = "";
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && customizer.classList.contains("is-open")) closeCustomizer();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        document.getElementById("lab-component-search")?.focus();
      }
    });
  }

  function scrollToSection(id) {
    const section = document.getElementById(id)?.closest(".vf-section") || document.getElementById(id);
    if (!section) return;
    section.classList.remove("is-filtered-out");
    section.scrollIntoView({ behavior: "smooth", block: "start" });
    section.classList.remove("lab-flash");
    window.setTimeout(() => section.classList.add("lab-flash"), 380);
  }

  function bindSearch() {
    const input = document.getElementById("lab-component-search");
    if (!input) return;
    const container = tokenRoot;
    const sections = Array.from(container.querySelectorAll(":scope > .vf-section"));
    const empty = document.createElement("div");
    empty.className = "vf-empty lab-search-empty";
    empty.hidden = true;
    empty.innerHTML = `<div class="vf-empty__icon is-primary">⌕</div><h2 class="vf-empty__title">Nenhum componente encontrado</h2><p class="vf-empty__description">Tente buscar por card, tabela, botão, formulário, modal ou token.</p>`;
    container.appendChild(empty);

    input.addEventListener("input", () => {
      const query = input.value.trim().toLocaleLowerCase("pt-BR");
      let visible = 0;
      sections.forEach((section) => {
        const matches = !query || section.textContent.toLocaleLowerCase("pt-BR").includes(query);
        section.classList.toggle("is-filtered-out", !matches);
        if (matches) visible += 1;
      });
      empty.hidden = visible > 0;
    });
  }

  function bindDemoInteractions() {
    document.querySelectorAll(".vf-filter-chip").forEach((button) => {
      button.addEventListener("click", () => {
        const next = !button.classList.contains("is-active");
        button.classList.toggle("is-active", next);
        button.setAttribute("aria-pressed", String(next));
      });
    });

    document.querySelectorAll("button.vf-kpi--interactive").forEach((button) => {
      button.addEventListener("click", () => {
        const next = !button.classList.contains("is-active");
        button.classList.toggle("is-active", next);
        button.setAttribute("aria-pressed", String(next));
      });
    });

    document.querySelectorAll(".vf-table__sort").forEach((button) => {
      button.addEventListener("click", () => {
        const descending = !button.classList.contains("is-desc");
        button.closest("table").querySelectorAll(".vf-table__sort").forEach((sort) => sort.classList.remove("is-desc", "is-asc"));
        button.classList.add(descending ? "is-desc" : "is-asc");
      });
    });
  }

  if (!enforceAccess()) return;
  if (typeof window.initLayout === "function") window.initLayout();
  applySettings({ persist: false });
  bindTokenControls();
  bindToolbar();
  bindSearch();
  bindDemoInteractions();
})();
