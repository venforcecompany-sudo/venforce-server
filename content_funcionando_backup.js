console.log("[VenForce] extensão iniciada");

(function () {
  const CARD_MARK = "data-venforce-card";
  const BOX_CLASS = "venforce-floating-box";
  const WRAPPER_CLASS = "venforce-inline-wrapper";
  const DEBUG_ID = "venforce-debug-fixed";

  let COST_DB = {};
  let scheduled = false;
  let lastCardCount = 0;

  // ==========================
  // CARREGAR BASE DE CUSTOS
  // ==========================
  async function loadCosts() {
    try {
      const url = chrome.runtime.getURL("custos.json");
      const response = await fetch(url);
      COST_DB = await response.json();
      console.log("[VenForce] custos carregados", Object.keys(COST_DB).length);
    } catch (error) {
      console.error("[VenForce] erro ao carregar custos.json", error);
      COST_DB = {};
    }
  }

  // ==========================
  // FUNÇÕES AUXILIARES
  // ==========================
  function normalizeText(text) {
    return (text || "").replace(/\s+/g, " ").trim();
  }

  function getText(el) {
    return normalizeText(el?.innerText || "");
  }

  function toNumberBR(value) {
    if (value == null || value === "") return null;

    const cleaned = String(value)
      .replace(/R\$\s*/gi, "")
      .replace(/\s+/g, "")
      .replace(/\./g, "")
      .replace(",", ".");

    const num = Number(cleaned);
    return Number.isFinite(num) ? num : null;
  }

  function formatMoney(value) {
    if (value == null) return "N/D";

    return new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: "BRL",
    }).format(value);
  }

  function formatPercent(value) {
    if (value == null) return "N/D";
    return `${value.toFixed(2).replace(".", ",")}%`;
  }

  function extractByRegex(text, regex) {
    const match = text.match(regex);
    if (!match || !match[1]) return null;
    return toNumberBR(match[1]);
  }

  function normalizeTaxPercent(rawValue) {
    if (rawValue == null || rawValue === "") return null;

    const num = Number(rawValue);
    if (!Number.isFinite(num)) return null;

    return num <= 1 ? num * 100 : num;
  }

  // ==========================
  // CORES DE STATUS
  // ==========================
  function getStatusColor(mc) {
    if (mc == null) {
      return { bg: "#f3f4f6", border: "#d1d5db", label: "Sem base" };
    }

    if (mc <= 5) {
      return { bg: "#fee2e2", border: "#ef4444", label: "Crítico" };
    }

    if (mc <= 8) {
      return { bg: "#fef3c7", border: "#f59e0b", label: "Atenção" };
    }

    return { bg: "#dcfce7", border: "#22c55e", label: "Saudável" };
  }

  // ==========================
  // EXTRAIR DADOS DO CARD
  // ==========================
  function extractCardData(card) {
    const text = getText(card);

    const idMatch = text.match(/#(\d{8,})/);
    const id = idMatch ? idMatch[1] : null;

    const precoVenda =
      extractByRegex(text, /Você vende por\s*R\$\s*([\d.]+,\d{2})/i) ||
      extractByRegex(text, /R\$\s*([\d.]+,\d{2})/);

    const comissaoPercentual = extractByRegex(
      text,
      /Tarifa de venda\s*([\d.,]+)%/i
    );

    const comissaoValor =
      extractByRegex(
        text,
        /Tarifa de venda[\s\S]{0,120}?A pagar\s*R\$\s*([\d.]+,\d{2})/i
      ) ||
      extractByRegex(text, /A pagar\s*R\$\s*([\d.]+,\d{2})/i);

    const frete =
      extractByRegex(
        text,
        /Envio[\s\S]{0,220}?A pagar\s*R\$\s*([\d.]+,\d{2})/i
      ) ||
      extractByRegex(
        text,
        /Envio[\s\S]{0,220}?Você paga\s*R\$\s*([\d.]+,\d{2})/i
      );

    return {
      id,
      precoVenda,
      comissaoPercentual,
      comissaoValor,
      frete,
    };
  }

  // ==========================
  // CÁLCULO LC E MC
  // ==========================
  function enrichWithCosts(data) {
    const base = data.id ? COST_DB[data.id] : null;

    const custoProduto = base?.custo_produto ?? null;
    const impostoPercentual = normalizeTaxPercent(base?.imposto_percentual);

    const percentualTotal =
      (data.comissaoPercentual ?? 0) + (impostoPercentual ?? 0);

    const valorPercentual =
      data.precoVenda != null
        ? data.precoVenda * (percentualTotal / 100)
        : null;

    const LC =
      data.precoVenda != null
        ? data.precoVenda -
          (valorPercentual ?? 0) -
          (data.frete ?? 0) -
          (custoProduto ?? 0)
        : null;

    const MC =
      data.precoVenda != null && LC != null && data.precoVenda !== 0
        ? (LC / data.precoVenda) * 100
        : null;

    return {
      ...data,
      custoProduto,
      impostoPercentual,
      LC,
      MC,
    };
  }

  // ==========================
  // BOX
  // ==========================
  function createBox(data, mode = "inline") {
    const status = getStatusColor(data.MC);

    const box = document.createElement("div");
    box.className = BOX_CLASS;

    if (mode === "inline") {
      box.style.position = "relative";
      box.style.marginTop = "12px";
      box.style.width = "260px";
    } else {
      box.style.position = "absolute";
      box.style.top = "10px";
      box.style.right = "10px";
      box.style.width = "260px";
    }

    box.style.zIndex = "20";
    box.style.padding = "12px";
    box.style.border = `2px solid ${status.border}`;
    box.style.borderRadius = "14px";
    box.style.background = status.bg;
    box.style.boxShadow = "0 6px 18px rgba(0,0,0,0.10)";
    box.style.fontSize = "12px";
    box.style.lineHeight = "1.45";
    box.style.color = "#111827";
    box.style.boxSizing = "border-box";

    box.innerHTML = `
      <div style="font-weight:700; font-size:14px; margin-bottom:8px;">VenForce Company</div>

      <div><strong>ID:</strong> ${data.id ?? "N/D"}</div>
      <div><strong>Venda:</strong> ${formatMoney(data.precoVenda)}</div>
      <div><strong>Comissão %:</strong> ${formatPercent(data.comissaoPercentual)}</div>
      <div><strong>Comissão R$:</strong> ${formatMoney(data.comissaoValor)}</div>
      <div><strong>Frete:</strong> ${formatMoney(data.frete)}</div>

      <hr style="border:none; border-top:1px solid rgba(0,0,0,.12); margin:8px 0;">

      <div><strong>Custo:</strong> ${formatMoney(data.custoProduto)}</div>
      <div><strong>Imposto %:</strong> ${formatPercent(data.impostoPercentual)}</div>

      <hr style="border:none; border-top:1px solid rgba(0,0,0,.12); margin:8px 0;">

      <div><strong>LC:</strong> ${formatMoney(data.LC)}</div>
      <div><strong>MC %:</strong> ${formatPercent(data.MC)}</div>

      <div style="margin-top:8px; font-weight:700;">${status.label}</div>
    `;

    return box;
  }

  // ==========================
  // ENCONTRAR ÂNCORA INTERNA
  // ==========================
  function findInlineAnchor(card) {
    const selectors = Array.from(card.querySelectorAll("a, span, div"));

    const patterns = [
      "Oferecer parcelamento sem acréscimo",
      "Modificar tipo de anúncio",
      "Oferecer frete grátis",
      "Adicionar preços de atacado",
      "Oferecer frete",
      "Melhorar fotos",
      "Incluir clip",
    ];

    for (const el of selectors) {
      const text = getText(el);
      if (!text) continue;

      if (patterns.some((p) => text.includes(p))) {
        let current = el;

        while (current && current !== card) {
          if (
            current.tagName === "DIV" &&
            current.children.length > 0 &&
            current.getBoundingClientRect().height > 30
          ) {
            return current;
          }
          current = current.parentElement;
        }
      }
    }

    return null;
  }

  // ==========================
  // IDENTIFICAR CARDS
  // ==========================
  function looksLikeRealCard(el) {
    const text = getText(el);

    return (
      /#\d{8,}/.test(text) &&
      text.includes("Tarifa de venda") &&
      (text.includes("Experiência de compra") ||
        text.includes("Qualidade do anúncio")) &&
      (text.includes("Você vende por") ||
        text.includes("A pagar") ||
        text.includes("Você recebe"))
    );
  }

  function findCards() {
    const candidates = Array.from(document.querySelectorAll("div")).filter(
      looksLikeRealCard
    );

    const uniqueById = new Map();

    for (const el of candidates) {
      const text = getText(el);
      const idMatch = text.match(/#(\d{8,})/);
      const id = idMatch ? idMatch[1] : null;
      if (!id) continue;

      const rect = el.getBoundingClientRect();
      const area = rect.width * rect.height;
      const existing = uniqueById.get(id);

      if (!existing || area < existing.area) {
        uniqueById.set(id, { el, area });
      }
    }

    return Array.from(uniqueById.values()).map((x) => x.el);
  }

  // ==========================
  // DEBUG
  // ==========================
  function updateDebug(count) {
    let debug = document.getElementById(DEBUG_ID);

    if (!debug) {
      debug = document.createElement("div");
      debug.id = DEBUG_ID;
      debug.style.position = "fixed";
      debug.style.top = "20px";
      debug.style.right = "20px";
      debug.style.zIndex = "2147483647";
      debug.style.background = "#111";
      debug.style.color = "#fff";
      debug.style.padding = "8px 12px";
      debug.style.borderRadius = "8px";
      debug.style.fontSize = "12px";
      debug.style.fontWeight = "700";
      document.body.appendChild(debug);
    }

    debug.textContent = `[VenForce] cards: ${count}`;
  }

  // ==========================
  // LIMPEZA
  // ==========================
  function removeOldArtifacts(card) {
    card.querySelectorAll(`.${BOX_CLASS}`).forEach((el) => el.remove());
    card.querySelectorAll(`.${WRAPPER_CLASS}`).forEach((el) => el.remove());
  }

  // ==========================
  // INSERIR BOX
  // ==========================
  function injectIntoCard(card) {
    if (!card) return;

    removeOldArtifacts(card);

    const raw = extractCardData(card);
    const data = enrichWithCosts(raw);

    const anchor = findInlineAnchor(card);

    if (anchor) {
      const wrapper = document.createElement("div");
      wrapper.className = WRAPPER_CLASS;
      wrapper.style.display = "block";
      wrapper.style.marginTop = "10px";
      wrapper.style.marginBottom = "4px";
      wrapper.style.minHeight = "0";

      wrapper.appendChild(createBox(data, "inline"));

      if (!anchor.nextElementSibling || !anchor.nextElementSibling.classList?.contains(WRAPPER_CLASS)) {
        anchor.insertAdjacentElement("afterend", wrapper);
      }
    } else {
      if (!card.hasAttribute(CARD_MARK)) {
        card.setAttribute(CARD_MARK, "1");

        const style = window.getComputedStyle(card);

        if (style.position === "static") {
          card.style.position = "relative";
        }

        card.style.overflow = "visible";
        card.style.paddingRight = "290px";
        card.style.minHeight = "260px";
      }

      card.appendChild(createBox(data, "floating"));
    }
  }

  // ==========================
  // EXECUÇÃO
  // ==========================
  function run() {
    if (!location.href.includes("/anuncios/lista")) return;

    const cards = findCards();
    lastCardCount = cards.length;

    updateDebug(cards.length);
    cards.forEach(injectIntoCard);
  }

  function scheduleRun() {
    if (scheduled) return;

    scheduled = true;

    requestAnimationFrame(() => {
      scheduled = false;
      run();
    });
  }

  async function boot() {
    await loadCosts();
    run();

    const observer = new MutationObserver(() => {
      scheduleRun();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    window.addEventListener("scroll", scheduleRun, { passive: true });
    document.addEventListener("scroll", scheduleRun, { passive: true });

    setInterval(() => {
      const cards = findCards();

      if (
        cards.length !== lastCardCount ||
        cards.some(
          (card) =>
            !card.querySelector(`.${BOX_CLASS}`) &&
            !card.querySelector(`.${WRAPPER_CLASS}`)
        )
      ) {
        run();
      }
    }, 1500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();