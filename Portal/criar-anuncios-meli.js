// Portal/criar-anuncios-meli.js — Criação de Anúncios Mercado Livre
(function () {
  "use strict";

  var API_BASE = "https://venforce-server.onrender.com";
  var STORAGE_KEY = "vf-token";

  function getToken() {
    var t = localStorage.getItem(STORAGE_KEY);
    if (!t) {
      window.location.replace("index.html");
      return null;
    }
    return t;
  }

  getToken();
  if (typeof initLayout === "function") initLayout();

  // ─── Estado ────────────────────────────────────────────────────────────────
  var CAM = {
    clientes: [],
    conta: null,
    categoryId: null,
    categoryName: null,
    attrsApi: null,
    saleTermsApi: [],
    attrsForm: null,
    imagesForm: null,
    variations: [],
    wholesaleRanges: [],
    wholesaleRetry: null,
    publishing: false,
  };

  function el(id) {
    return document.getElementById(id);
  }

  function escapeHtml(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function emptyState(message, loading) {
    return '<div class="vf-empty cam-empty">' +
      (loading ? '<span class="vf-spinner" aria-hidden="true"></span>' : "") +
      '<p class="vf-empty__description">' + escapeHtml(message) + "</p></div>";
  }

  var HIDDEN_SALE_TERM_NAMES = new Set([
    "disponibilidade de estoque",
    "disponibilidad de stock",
    "faturamento",
    "facturacion",
    "aceita compra recorrente",
    "acepta compra recurrente",
    "preco por compra recorrente",
    "precio por compra recurrente",
    "envio gratis por compra recorrente",
    "desconto por compra recorrente",
    "descuento por compra recurrente",
    "preco por ser nivel 1 do loyalty",
    "preco por ser nivel 2 do loyalty",
    "preco por ser nivel 3 do loyalty",
    "preco por ser nivel 4 do loyalty",
    "preco por ser nivel 5 do loyalty",
    "preco por ser nivel 6 do loyalty",
    "precio por nivel 1 de loyalty",
    "precio por nivel 2 de loyalty",
    "precio por nivel 3 de loyalty",
    "precio por nivel 4 de loyalty",
    "precio por nivel 5 de loyalty",
    "precio por nivel 6 de loyalty",
    "taxa de cambio para checkout",
    "tasa de cambio para checkout",
    "quantidade minima de compra",
    "cantidad minima de compra",
    "quantidade maxima de compra",
    "cantidad maxima de compra",
    "preco do desconto em efetivo",
    "precio del descuento en efectivo",
    "valor de desconto meli em efetivo",
    "valor de desconto meli en efetivo",
    "valor de descuento meli en efectivo",
    "preco do desconto em todos os meios de pagamento",
    "precio del descuento en todos los medios de pago",
    "valor de desconto meli em todos os meios de pagamento",
    "valor de desconto meli en todos os meios de pagamento",
    "valor de descuento meli en todos los medios de pago",
    "preco global",
    "precio global",
    "preco original global",
    "precio original global",
    "tipo de compra",
    "tipo de promocao",
    "tipo de promocion",
    "campanha de parcelas",
    "campana de parcelas",
    "campana de cuotas",
    "e 1p motores",
    "es 1p motores",
    "preco da reserva 1p",
    "precio de reserva 1p",
    "plan intercambio",
  ]);

  var HIDDEN_SALE_TERM_IDS = new Set([
    "LOYALTY_LEVEL_1",
    "LOYALTY_LEVEL_2",
    "LOYALTY_LEVEL_3",
    "LOYALTY_LEVEL_4",
    "LOYALTY_LEVEL_5",
    "LOYALTY_LEVEL_6",
  ]);

  function normalizeSaleTermName(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  function shouldRenderSaleTerm(term) {
    if (!term) return false;
    var id = String(term.id || "").trim().toUpperCase();
    return (
      !HIDDEN_SALE_TERM_IDS.has(id) &&
      !HIDDEN_SALE_TERM_NAMES.has(normalizeSaleTermName(term.name))
    );
  }

  async function api(path, options) {
    var opts = options || {};
    var token = getToken();
    var res = await fetch(API_BASE + path, {
      method: opts.method || "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    var data = null;
    try {
      data = await res.json();
    } catch (e) {
      data = null;
    }
    return { ok: res.ok, status: res.status, data: data };
  }

  function toast(msg) {
    var n = document.createElement("div");
    var content = document.createElement("div");
    var description = document.createElement("p");
    n.className = "vf-toast is-info";
    n.setAttribute("role", "status");
    content.className = "vf-toast__content";
    description.className = "vf-toast__description";
    description.textContent = msg;
    content.appendChild(description);
    n.appendChild(content);
    el("cam-toast-stack").appendChild(n);
    setTimeout(function () {
      n.remove();
    }, 2600);
  }

  // ─── Conta / clientes ──────────────────────────────────────────────────────
  async function carregarClientes() {
    var sel = el("cam-cliente");
    var resp = await api("/anuncios-meli/clientes");
    if (!resp.ok || !resp.data || !resp.data.ok) {
      sel.innerHTML = '<option value="">Erro ao carregar clientes</option>';
      return;
    }
    CAM.clientes = resp.data.clientes || [];
    if (!CAM.clientes.length) {
      sel.innerHTML = '<option value="">Nenhum cliente ativo</option>';
      return;
    }
    sel.innerHTML =
      '<option value="">Selecione um cliente...</option>' +
      CAM.clientes
        .map(function (c) {
          var flag = c.mlConectado ? "●" : "○";
          return (
            '<option value="' +
            escapeHtml(c.slug) +
            '">' +
            flag +
            " " +
            escapeHtml(c.nome) +
            " (" +
            escapeHtml(c.slug) +
            ")</option>"
          );
        })
        .join("");
  }

  async function onClienteChange() {
    var slug = (el("cam-cliente").value || "").trim();
    CAM.conta = null;
    setWholesaleEligibility(false, "Verificando a elegibilidade B2B da conta...");
    resetWholesaleConfig();
    setPublishEnabled(false);

    var userBox = el("cam-ml-user");
    var statusBox = el("cam-ml-status");
    userBox.textContent = "—";
    userBox.className = "vf-alert cam-status-box";
    statusBox.textContent = "Validando conexão...";
    statusBox.className = "vf-alert cam-status-box is-info";

    if (!slug) {
      statusBox.textContent = "Selecione um cliente";
      setWholesaleEligibility(
        false,
        "Selecione uma conta para verificar a elegibilidade B2B."
      );
      el("cam-publish-hint").textContent =
        "Selecione uma conta conectada para publicar.";
      return;
    }

    var resp = await api(
      "/anuncios-meli/criacao/status?clienteSlug=" + encodeURIComponent(slug)
    );
    var data = resp.data || {};
    CAM.conta = data;
    setWholesaleEligibility(
      data.precoAtacadoElegivel === true,
      data.precoAtacadoElegivel === true
        ? "Conta elegível para preços B2B por quantidade."
        : "Esta conta não possui a tag business exigida para preços de atacado."
    );

    if (!data.mlConectado) {
      statusBox.textContent = "Sem token ML";
      statusBox.className = "vf-alert cam-status-box is-danger";
      el("cam-publish-hint").textContent =
        "Conecte a conta em Clientes → Conectar ML.";
      return;
    }

    if (!data.tokenValido) {
      statusBox.textContent = "Token inválido / expirado";
      statusBox.className = "vf-alert cam-status-box is-danger";
      userBox.textContent = data.mlUserId || "—";
      el("cam-publish-hint").textContent = "Reconecte a conta Mercado Livre.";
      return;
    }

    userBox.textContent =
      (data.nickname || "—") +
      (data.mlUserId ? " · ID " + data.mlUserId : "");

    if (!data.podePublicar) {
      statusBox.textContent =
        "Sem permissão de publicação (" + (data.statusConta || "?") + ")";
      statusBox.className = "vf-alert cam-status-box is-warning";
      el("cam-publish-hint").textContent =
        "Esta conta não está apta a listar anúncios.";
      return;
    }

    statusBox.textContent = "Conectado · apto a publicar";
    statusBox.className = "vf-alert cam-status-box is-success";
    el("cam-publish-hint").textContent = "Revise os campos e publique.";
    setPublishEnabled(true);
    await carregarListingTypes(slug);
  }

  async function carregarListingTypes(slug) {
    var resp = await api(
      "/anuncios-meli/criacao/listing-types?clienteSlug=" +
        encodeURIComponent(slug)
    );
    if (!resp.ok || !resp.data || !resp.data.ok) return;
    var types = resp.data.listingTypes || [];
    if (!types.length) return;
    var sel = el("cam-listing-type");
    var current = sel.value;
    sel.innerHTML = types
      .map(function (t) {
        return (
          '<option value="' +
          escapeHtml(t.id) +
          '">' +
          escapeHtml(t.name || t.id) +
          " (" +
          escapeHtml(t.id) +
          ")</option>"
        );
      })
      .join("");
    if (current) sel.value = current;
  }

  function setPublishEnabled(enabled) {
    var button = el("cam-publish");
    button.disabled = !enabled || CAM.publishing;
    button.classList.toggle("is-loading", CAM.publishing);
    button.setAttribute("aria-busy", CAM.publishing ? "true" : "false");
  }

  function setWholesaleEligibility(eligible, message) {
    var toggle = el("cam-wholesale-enabled");
    var status = el("cam-wholesale-eligibility");
    toggle.disabled = !eligible;
    status.textContent = message;
    status.className =
      "vf-alert cam-wholesale-eligibility " + (eligible ? "is-success" : "is-info");
    if (!eligible) {
      toggle.checked = false;
      el("cam-wholesale-config").hidden = true;
    }
  }

  // ─── Categorias ────────────────────────────────────────────────────────────
  async function buscarCategorias() {
    var slug = (el("cam-cliente").value || "").trim();
    var q = (el("cam-category-q").value || "").trim();
    var box = el("cam-category-results");

    if (!slug) {
      toast("Selecione um cliente primeiro.");
      return;
    }
    if (q.length < 2) {
      toast("Digite ao menos 2 caracteres.");
      return;
    }

    box.hidden = false;
    box.innerHTML = emptyState("Buscando categorias...", true);

    var resp = await api(
      "/anuncios-meli/criacao/categorias?clienteSlug=" +
        encodeURIComponent(slug) +
        "&q=" +
        encodeURIComponent(q)
    );

    if (!resp.ok || !resp.data || !resp.data.ok) {
      box.innerHTML = emptyState((resp.data && resp.data.motivo) || "Falha ao buscar.");
      return;
    }

    var cats = resp.data.categorias || [];
    if (!cats.length) {
      box.innerHTML = emptyState("Nenhuma categoria encontrada.");
      return;
    }

    box.innerHTML = cats
      .map(function (c) {
        return (
          '<button type="button" class="cam-cat-item" role="option" data-id="' +
          escapeHtml(c.category_id) +
          '" data-name="' +
          escapeHtml(c.category_name) +
          '">' +
          "<strong>" +
          escapeHtml(c.category_name) +
          "</strong>" +
          "<span>" +
          escapeHtml(c.category_id) +
          (c.domain_name ? " · " + escapeHtml(c.domain_name) : "") +
          "</span></button>"
        );
      })
      .join("");
  }

  async function selecionarCategoria(categoryId, categoryName) {
    CAM.categoryId = categoryId;
    CAM.categoryName = categoryName;
    el("cam-category-id").value = categoryId;
    el("cam-category-results").hidden = true;

    var sel = el("cam-category-selected");
    sel.textContent = categoryName + " (" + categoryId + ")";
    sel.className = "vf-field__hint cam-cat-selected is-set";

    await Promise.all([
      carregarAtributos(categoryId),
      carregarSaleTerms(categoryId),
    ]);
  }

  async function carregarAtributos(categoryId) {
    var slug = (el("cam-cliente").value || "").trim();
    var box = el("cam-attrs");
    box.innerHTML = emptyState("Carregando atributos...", true);

    var resp = await api(
      "/anuncios-meli/criacao/categorias/" +
        encodeURIComponent(categoryId) +
        "/atributos?clienteSlug=" +
        encodeURIComponent(slug)
    );

    if (!resp.ok || !resp.data || !resp.data.ok) {
      box.innerHTML = emptyState((resp.data && resp.data.motivo) || "Erro ao carregar atributos.");
      CAM.attrsForm = null;
      CAM.attrsApi = null;
      return;
    }

    CAM.attrsApi = resp.data;
    CAM.attrsForm = window.DynamicAttributesForm.mount(box, {
      atributos: resp.data.atributos || [],
    });
  }

  async function carregarSaleTerms(categoryId) {
    var slug = (el("cam-cliente").value || "").trim();
    var box = el("cam-sale-terms");
    box.innerHTML = emptyState("Carregando termos...", true);

    var resp = await api(
      "/anuncios-meli/criacao/categorias/" +
        encodeURIComponent(categoryId) +
        "/sale-terms?clienteSlug=" +
        encodeURIComponent(slug)
    );

    var terms =
      resp.ok && resp.data && resp.data.ok ? resp.data.saleTerms || [] : [];
    var visibleTerms = terms.filter(shouldRenderSaleTerm);
    CAM.saleTermsApi = visibleTerms;

    if (!visibleTerms.length) {
      box.innerHTML = emptyState("Nenhum termo comercial específico para esta categoria. Você pode preencher garantia manualmente abaixo.") + renderSaleTermsFallback();
      return;
    }

    box.innerHTML =
      '<div class="cam-sale-grid">' +
      visibleTerms
        .map(function (t) {
          var id = "cam-st-" + escapeHtml(t.id);
          var label =
            escapeHtml(t.name || t.id) +
            (t.required ? ' <span class="vf-field__required">*</span>' : "");
          var control = "";
          if (Array.isArray(t.values) && t.values.length) {
            control =
              '<select class="vf-select cam-st-input" data-st-id="' +
              escapeHtml(t.id) +
              '" id="' +
              id +
              '"><option value="">Selecione...</option>' +
              t.values
                .map(function (v) {
                  return (
                    '<option value="' +
                    escapeHtml(v.id) +
                    '" data-name="' +
                    escapeHtml(v.name) +
                    '">' +
                    escapeHtml(v.name) +
                    "</option>"
                  );
                })
                .join("") +
              "</select>";
          } else {
            control =
              '<input type="text" class="vf-input cam-st-input" data-st-id="' +
              escapeHtml(t.id) +
              '" id="' +
              id +
              '" placeholder="' +
              escapeHtml(t.name || "") +
              '" />';
          }
          return (
            '<div class="vf-field"><label class="vf-field__label" for="' +
            id +
            '">' +
            label +
            "</label>" +
            control +
            "</div>"
          );
        })
        .join("") +
      "</div>";
  }

  function renderSaleTermsFallback() {
    return (
      '<div class="cam-sale-grid cam-sale-grid--fallback">' +
      '<div class="vf-field">' +
      '<label class="vf-field__label" for="cam-st-WARRANTY_TYPE">Tipo de garantia</label>' +
      '<select id="cam-st-WARRANTY_TYPE" class="vf-select cam-st-input" data-st-id="WARRANTY_TYPE">' +
      '<option value="">Não informar</option>' +
      '<option value="name:Garantia do vendedor">Garantia do vendedor</option>' +
      '<option value="name:Garantia de fábrica">Garantia de fábrica</option>' +
      '<option value="name:Sem garantia">Sem garantia</option>' +
      "</select></div>" +
      '<div class="vf-field">' +
      '<label class="vf-field__label" for="cam-st-WARRANTY_TIME">Tempo de garantia</label>' +
      '<input type="text" id="cam-st-WARRANTY_TIME" class="vf-input cam-st-input" data-st-id="WARRANTY_TIME" placeholder="Ex.: 90 dias" />' +
      "</div></div>"
    );
  }

  function coletarSaleTerms() {
    var inputs = document.querySelectorAll(".cam-st-input");
    var out = [];
    inputs.forEach(function (input) {
      var id = input.getAttribute("data-st-id");
      var raw = String(input.value || "").trim();
      if (!id || !raw) return;

      if (input.tagName === "SELECT") {
        if (raw.indexOf("name:") === 0) {
          out.push({ id: id, value_name: raw.slice(5) });
        } else {
          var opt = input.options[input.selectedIndex];
          out.push({
            id: id,
            value_id: raw,
            value_name: opt ? opt.getAttribute("data-name") || opt.textContent : undefined,
          });
        }
        return;
      }
      out.push({ id: id, value_name: raw });
    });
    return out;
  }

  // ─── Variações ─────────────────────────────────────────────────────────────
  function renderVariations() {
    var box = el("cam-variations");
    if (!CAM.variations.length) {
      box.innerHTML = emptyState("Nenhuma variação adicionada. O anúncio será publicado sem variations.");
      return;
    }

    box.innerHTML = CAM.variations
      .map(function (v, idx) {
        return (
          '<div class="cam-var-card" data-idx="' +
          idx +
          '">' +
          '<div class="cam-var-head"><span>Variação #' +
          (idx + 1) +
          '</span><button type="button" class="vf-btn vf-btn--ghost vf-btn--sm cam-var-remove" data-idx="' +
          idx +
          '">Remover</button></div>' +
          '<div class="cam-grid-3">' +
          '<div class="vf-field"><label class="vf-field__label">Combinações (JSON)</label>' +
          '<input type="text" class="vf-input vf-mono cam-var-combos" data-idx="' +
          idx +
          '" value="' +
          escapeHtml(JSON.stringify(v.attribute_combinations || [])) +
          '" placeholder=\'[{"id":"COLOR","value_name":"Preto"}]\' /></div>' +
          '<div class="vf-field"><label class="vf-field__label">Preço</label>' +
          '<input type="number" class="vf-input cam-var-price" data-idx="' +
          idx +
          '" min="0.01" step="0.01" value="' +
          escapeHtml(v.price != null ? v.price : "") +
          '" /></div>' +
          '<div class="vf-field"><label class="vf-field__label">Estoque</label>' +
          '<input type="number" class="vf-input cam-var-qty" data-idx="' +
          idx +
          '" min="1" step="1" value="' +
          escapeHtml(v.available_quantity != null ? v.available_quantity : 1) +
          '" /></div>' +
          "</div></div>"
        );
      })
      .join("");
  }

  function syncVariationsFromDom() {
    CAM.variations = CAM.variations.map(function (v, idx) {
      var combosEl = document.querySelector(
        '.cam-var-combos[data-idx="' + idx + '"]'
      );
      var priceEl = document.querySelector(
        '.cam-var-price[data-idx="' + idx + '"]'
      );
      var qtyEl = document.querySelector('.cam-var-qty[data-idx="' + idx + '"]');
      var combos = [];
      try {
        combos = JSON.parse((combosEl && combosEl.value) || "[]");
      } catch (e) {
        combos = [];
      }
      return {
        attribute_combinations: Array.isArray(combos) ? combos : [],
        price: priceEl && priceEl.value !== "" ? Number(priceEl.value) : null,
        available_quantity:
          qtyEl && qtyEl.value !== "" ? Number(qtyEl.value) : null,
      };
    });
  }

  // ─── Preço de atacado B2B ──────────────────────────────────────────────────
  function resetWholesaleConfig() {
    CAM.wholesaleRanges = [];
    CAM.wholesaleRetry = null;
    var toggle = el("cam-wholesale-enabled");
    if (toggle) toggle.checked = false;
    var config = el("cam-wholesale-config");
    if (config) config.hidden = true;
    var result = el("cam-wholesale-result");
    if (result) result.hidden = true;
    renderWholesaleRanges();
  }

  function syncWholesaleFromDom() {
    CAM.wholesaleRanges = CAM.wholesaleRanges.map(function (range, idx) {
      var qtyInput = document.querySelector(
        '.cam-wholesale-qty[data-idx="' + idx + '"]'
      );
      var priceInput = document.querySelector(
        '.cam-wholesale-price[data-idx="' + idx + '"]'
      );
      return {
        quantidadeMinima:
          qtyInput && qtyInput.value !== "" ? Number(qtyInput.value) : null,
        precoUnitario:
          priceInput && priceInput.value !== "" ? Number(priceInput.value) : null,
      };
    });
  }

  function renderWholesaleRanges() {
    var box = el("cam-wholesale-ranges");
    if (!box) return;

    if (!CAM.wholesaleRanges.length) {
      box.innerHTML = emptyState(
        "Nenhuma faixa adicionada. Adicione ao menos uma faixa para usar preço de atacado."
      );
    } else {
      box.innerHTML = CAM.wholesaleRanges
        .map(function (range, idx) {
          return (
            '<div class="cam-wholesale-row" data-idx="' +
            idx +
            '">' +
            '<div class="cam-wholesale-row-title">Faixa #' +
            (idx + 1) +
            "</div>" +
            '<div class="vf-field"><label class="vf-field__label" for="cam-wholesale-qty-' +
            idx +
            '">Quantidade mínima</label><input type="number" id="cam-wholesale-qty-' +
            idx +
            '" class="vf-input cam-wholesale-qty" data-idx="' +
            idx +
            '" min="2" step="1" value="' +
            escapeHtml(range.quantidadeMinima != null ? range.quantidadeMinima : "") +
            '" placeholder="Ex.: 10"></div>' +
            '<div class="vf-field"><label class="vf-field__label" for="cam-wholesale-price-' +
            idx +
            '">Preço por unidade</label><div class="vf-input-group"><span class="vf-input-prefix">R$</span><input type="number" id="cam-wholesale-price-' +
            idx +
            '" class="vf-input cam-wholesale-price" data-idx="' +
            idx +
            '" min="0.01" step="0.01" value="' +
            escapeHtml(range.precoUnitario != null ? range.precoUnitario : "") +
            '" placeholder="0,00"></div></div>' +
            '<button type="button" class="vf-btn vf-btn--ghost vf-btn--sm cam-wholesale-remove" data-idx="' +
            idx +
            '" aria-label="Remover faixa ' +
            (idx + 1) +
            '">Remover</button></div>'
          );
        })
        .join("");
    }

    var addButton = el("cam-wholesale-add");
    addButton.disabled = CAM.wholesaleRanges.length >= 5;
    addButton.textContent =
      CAM.wholesaleRanges.length >= 5
        ? "Limite de 5 faixas atingido"
        : "Adicionar faixa";
  }

  function collectWholesaleRanges() {
    syncWholesaleFromDom();
    return CAM.wholesaleRanges
      .map(function (range) {
        return {
          quantidadeMinima: range.quantidadeMinima,
          precoUnitario: range.precoUnitario,
        };
      })
      .sort(function (a, b) {
        return a.quantidadeMinima - b.quantidadeMinima;
      });
  }

  function validateWholesale(normalPrice) {
    var errors = [];
    if (!el("cam-wholesale-enabled").checked) return errors;

    if (!CAM.conta || CAM.conta.precoAtacadoElegivel !== true) {
      errors.push({
        campo: "precoAtacado",
        mensagem: "A conta selecionada não é elegível para preço de atacado.",
        sugestao: "Selecione uma conta Mercado Livre com a tag business.",
      });
      return errors;
    }

    var ranges = collectWholesaleRanges();
    if (ranges.length < 1 || ranges.length > 5) {
      errors.push({
        campo: "precoAtacado",
        mensagem: "Informe de uma a cinco faixas de preço de atacado.",
        sugestao: "Adicione ao menos uma faixa e respeite o limite de cinco.",
      });
      return errors;
    }

    var quantities = {};
    ranges.forEach(function (range, idx) {
      if (
        !Number.isFinite(range.quantidadeMinima) ||
        !Number.isInteger(range.quantidadeMinima) ||
        range.quantidadeMinima <= 1
      ) {
        errors.push({
          campo: "precoAtacado",
          mensagem: "A quantidade mínima da faixa " + (idx + 1) + " deve ser um inteiro maior que 1.",
          sugestao: "Informe 2 ou mais unidades.",
        });
      } else if (quantities[range.quantidadeMinima]) {
        errors.push({
          campo: "precoAtacado",
          mensagem: "Existem faixas com a mesma quantidade mínima.",
          sugestao: "Use uma quantidade diferente em cada faixa.",
        });
      } else {
        quantities[range.quantidadeMinima] = true;
      }

      if (!Number.isFinite(range.precoUnitario) || range.precoUnitario <= 0) {
        errors.push({
          campo: "precoAtacado",
          mensagem: "O preço por unidade da faixa " + (idx + 1) + " é inválido.",
          sugestao: "Informe um preço maior que zero.",
        });
      } else if (Number.isFinite(normalPrice) && range.precoUnitario >= normalPrice) {
        errors.push({
          campo: "precoAtacado",
          mensagem: "Todo preço de atacado deve ser menor que o preço normal.",
          sugestao: "Reduza o preço por unidade da faixa " + (idx + 1) + ".",
        });
      }
    });

    for (var i = 1; i < ranges.length; i += 1) {
      if (
        Number.isFinite(ranges[i - 1].precoUnitario) &&
        Number.isFinite(ranges[i].precoUnitario) &&
        ranges[i].precoUnitario >= ranges[i - 1].precoUnitario
      ) {
        errors.push({
          campo: "precoAtacado",
          mensagem: "O preço por unidade deve diminuir conforme a quantidade aumenta.",
          sugestao: "Revise as faixas em ordem crescente de quantidade.",
        });
        break;
      }
    }

    return errors;
  }

  // ─── Validação / publicação ────────────────────────────────────────────────
  function validarLocal() {
    var erros = [];
    var title = (el("cam-title").value || "").trim();
    if (!title) {
      erros.push({
        campo: "title",
        mensagem: "Título é obrigatório.",
        sugestao: "Informe um título descritivo.",
      });
    } else if (title.length > 60) {
      erros.push({
        campo: "title",
        mensagem: "Título excede 60 caracteres.",
        sugestao: "Reduza o título.",
      });
    }

    if (!CAM.categoryId) {
      erros.push({
        campo: "category_id",
        mensagem: "Categoria é obrigatória.",
        sugestao: "Busque e selecione uma categoria.",
      });
    }

    var price = Number(el("cam-price").value);
    if (!Number.isFinite(price) || price <= 0) {
      erros.push({
        campo: "price",
        mensagem: "Preço deve ser maior que zero.",
        sugestao: "Informe um valor válido.",
      });
    }

    erros = erros.concat(validateWholesale(price));

    var qty = Number(el("cam-qty").value);
    if (!Number.isFinite(qty) || qty <= 0 || !Number.isInteger(qty)) {
      erros.push({
        campo: "available_quantity",
        mensagem: "Estoque deve ser inteiro positivo.",
        sugestao: "Informe a quantidade disponível.",
      });
    }

    var imgVal = CAM.imagesForm && CAM.imagesForm.validate();
    if (!imgVal || !imgVal.ok) {
      erros.push({
        campo: "pictures",
        mensagem: (imgVal && imgVal.mensagem) || "Imagem obrigatória.",
        sugestao: "Adicione ao menos uma URL de imagem válida.",
      });
    }

    if (CAM.attrsForm) {
      var required = CAM.attrsForm.getRequiredIds();
      var filled = CAM.attrsForm.collect();
      var filledIds = {};
      filled.forEach(function (a) {
        filledIds[a.id] = true;
      });
      required.forEach(function (id) {
        if (!filledIds[id]) {
          erros.push({
            campo: "attributes",
            mensagem: "Atributo obrigatório ausente: " + id,
            sugestao: "Preencha todos os atributos obrigatórios.",
          });
        }
      });
    }

    return erros;
  }

  function montarPayload() {
    syncVariationsFromDom();
    var attributes = CAM.attrsForm ? CAM.attrsForm.collect() : [];
    var requiredAttributeIds = CAM.attrsForm
      ? CAM.attrsForm.getRequiredIds()
      : [];
    var pictures = CAM.imagesForm ? CAM.imagesForm.getPictures() : [];
    var sale_terms = coletarSaleTerms();
    var variations = CAM.variations.filter(function (v) {
      return (
        (v.attribute_combinations && v.attribute_combinations.length) ||
        v.price != null ||
        v.available_quantity != null
      );
    });

    var payload = {
      clienteSlug: (el("cam-cliente").value || "").trim(),
      title: (el("cam-title").value || "").trim(),
      category_id: CAM.categoryId,
      price: Number(el("cam-price").value),
      currency_id: el("cam-currency").value || "BRL",
      available_quantity: Number(el("cam-qty").value),
      condition: el("cam-condition").value,
      buying_mode: el("cam-buying-mode").value,
      listing_type_id: el("cam-listing-type").value,
      pictures: pictures,
      attributes: attributes,
      requiredAttributeIds: requiredAttributeIds,
      sale_terms: sale_terms,
      description: (el("cam-description").value || "").trim(),
    };

    var sku = (el("cam-sku").value || "").trim();
    if (sku) payload.seller_custom_field = sku;
    if (variations.length) payload.variations = variations;
    if (el("cam-wholesale-enabled").checked) {
      payload.precoAtacado = {
        habilitado: true,
        faixas: collectWholesaleRanges(),
      };
    }

    return payload;
  }

  function setProgress(pct, label) {
    var wrap = el("cam-progress");
    wrap.hidden = false;
    el("cam-progress-fill").setAttribute("data-progress", String(pct));
    wrap.querySelector('[role="progressbar"]').setAttribute("aria-valuenow", String(pct));
    el("cam-progress-label").textContent = label || "Publicando...";
  }

  function hideProgress() {
    el("cam-progress").hidden = true;
  }

  function formatCurrency(value) {
    var amount = Number(value);
    if (!Number.isFinite(amount)) return "—";
    return new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: el("cam-currency").value || "BRL",
    }).format(amount);
  }

  function normalizeConfirmedWholesaleRanges(ranges) {
    return (Array.isArray(ranges) ? ranges : [])
      .map(function (range) {
        var conditions = range && range.conditions ? range.conditions : {};
        return {
          quantidadeMinima: Number(
            range &&
              (range.quantidadeMinima != null
                ? range.quantidadeMinima
                : conditions.min_purchase_unit)
          ),
          precoUnitario: Number(
            range &&
              (range.precoUnitario != null ? range.precoUnitario : range.amount)
          ),
        };
      })
      .filter(function (range) {
        return (
          Number.isFinite(range.quantidadeMinima) &&
          Number.isFinite(range.precoUnitario)
        );
      })
      .sort(function (a, b) {
        return a.quantidadeMinima - b.quantidadeMinima;
      });
  }

  function wholesaleErrorMessage(error) {
    if (!error) return "";
    if (typeof error === "string") return error;
    return error.motivo || error.mensagem || error.message || "";
  }

  function showWholesaleResult(data, fallbackRanges) {
    var result = el("cam-wholesale-result");
    var retryButton = el("cam-wholesale-retry");
    var rangesList = el("cam-wholesale-result-ranges");
    var requested = data && data.precoAtacadoSolicitado === true;
    if (!requested) {
      result.hidden = true;
      CAM.wholesaleRetry = null;
      return;
    }

    var saved = data.precoAtacadoSalvo === true;
    result.hidden = false;
    result.className =
      "vf-alert cam-wholesale-result " + (saved ? "is-success" : "is-warning");
    retryButton.hidden = saved;
    el("cam-wholesale-result-title").textContent = saved
      ? "Preços de atacado cadastrados e confirmados."
      : "Anúncio criado, mas não foi possível cadastrar os preços de atacado.";
    el("cam-wholesale-result-description").textContent = saved
      ? "As faixas abaixo foram confirmadas no Mercado Livre para compradores empresariais."
      : wholesaleErrorMessage(data.precoAtacadoErro) ||
        "Você pode tentar novamente sem recriar o anúncio.";

    var confirmedRanges = normalizeConfirmedWholesaleRanges(
      data.precoAtacadoFaixas
    );
    var displayRanges = confirmedRanges.length
      ? confirmedRanges
      : saved
        ? normalizeConfirmedWholesaleRanges(fallbackRanges)
        : [];
    rangesList.innerHTML = displayRanges
      .map(function (range) {
        return (
          "<li>A partir de " +
          escapeHtml(range.quantidadeMinima) +
          " unidades: " +
          escapeHtml(formatCurrency(range.precoUnitario)) +
          " por unidade</li>"
        );
      })
      .join("");
    rangesList.hidden = !displayRanges.length;

    if (saved) {
      CAM.wholesaleRetry = null;
    }
  }

  async function retryWholesalePrices() {
    if (CAM.publishing || !CAM.wholesaleRetry) return;

    var retryData = CAM.wholesaleRetry;
    CAM.publishing = true;
    setPublishEnabled(false);
    var retryButton = el("cam-wholesale-retry");
    retryButton.disabled = true;
    retryButton.classList.add("is-loading");
    retryButton.setAttribute("aria-busy", "true");
    setProgress(45, "Cadastrando novamente os preços de atacado...");

    try {
      var resp = await api(
        "/anuncios-meli/criacao/" +
          encodeURIComponent(retryData.itemId) +
          "/precos-atacado",
        {
          method: "POST",
          body: {
            clienteSlug: retryData.clienteSlug,
            faixas: retryData.faixas,
          },
        }
      );

      if (
        !resp.ok ||
        !resp.data ||
        !resp.data.ok ||
        resp.data.precoAtacadoSalvo !== true
      ) {
        var failedData = resp.data || {};
        showWholesaleResult(
          {
            precoAtacadoSolicitado: true,
            precoAtacadoSalvo: false,
            precoAtacadoErro:
              failedData.precoAtacadoErro ||
              failedData.motivo ||
              "Não foi possível cadastrar os preços de atacado.",
          },
          retryData.faixas
        );
        toast("O anúncio continua criado. Revise o erro e tente novamente.");
        return;
      }

      setProgress(100, "Preços de atacado confirmados!");
      showWholesaleResult(
        {
          precoAtacadoSolicitado: true,
          precoAtacadoSalvo: true,
          precoAtacadoFaixas: resp.data.precoAtacadoFaixas,
        },
        retryData.faixas
      );
      toast("Preços de atacado cadastrados com sucesso.");
    } catch (err) {
      showWholesaleResult(
        {
          precoAtacadoSolicitado: true,
          precoAtacadoSalvo: false,
          precoAtacadoErro:
            err.message || "Não foi possível cadastrar os preços de atacado.",
        },
        retryData.faixas
      );
    } finally {
      CAM.publishing = false;
      setPublishEnabled(Boolean(CAM.conta && CAM.conta.podePublicar));
      retryButton.disabled = false;
      retryButton.classList.remove("is-loading");
      retryButton.setAttribute("aria-busy", "false");
      setTimeout(hideProgress, 900);
    }
  }

  async function publicar() {
    if (CAM.publishing) return;

    window.MercadoLivreApiError.clear(el("cam-errors"));
    el("cam-success").hidden = true;

    var erros = validarLocal();
    if (erros.length) {
      window.MercadoLivreApiError.render(el("cam-errors"), {
        motivo: "Corrija os campos obrigatórios antes de publicar.",
        erros: erros,
      });
      window.MercadoLivreApiError.highlightFields(el("cam-root"), erros);
      return;
    }

    if (!CAM.conta || !CAM.conta.podePublicar) {
      window.MercadoLivreApiError.render(el("cam-errors"), {
        motivo: "Conta sem permissão para publicar.",
        erros: [
          {
            codigo: "seller.unable_to_list",
            mensagem: "Selecione uma conta apta a listar anúncios.",
            sugestao: "Reconecte o token ML ou escolha outro cliente.",
          },
        ],
      });
      return;
    }

    var payload = montarPayload();
    CAM.publishing = true;
    setPublishEnabled(false);
    setProgress(18, "Validando dados e montando payload...");

    try {
      setProgress(
        45,
        payload.precoAtacado
          ? "Criando anúncio e cadastrando preços de atacado..."
          : "Enviando anúncio ao Mercado Livre (POST /items)..."
      );
      var resp = await api("/anuncios-meli/criacao/publicar", {
        method: "POST",
        body: payload,
      });

      var partialWholesale =
        resp.data &&
        resp.data.item_id &&
        (resp.data.precoAtacadoSolicitado === true || Boolean(payload.precoAtacado)) &&
        resp.data.precoAtacadoSalvo === false;
      if (partialWholesale) {
        setProgress(100, "Anúncio criado com pendência no preço de atacado.");
        showSuccess(resp.data, payload);
        toast("Anúncio criado. O preço de atacado precisa ser reenviado.");
        return;
      }

      if (!resp.ok || !resp.data || !resp.data.ok) {
        hideProgress();
        var data = resp.data || {};
        window.MercadoLivreApiError.render(el("cam-errors"), {
          motivo: data.motivo || "Falha ao publicar o anúncio.",
          erros: data.erros || [],
        });
        window.MercadoLivreApiError.highlightFields(
          el("cam-root"),
          data.erros || []
        );
        return;
      }

      setProgress(
        82,
        payload.precoAtacado
          ? "Confirmando anúncio e preços por quantidade..."
          : "Salvando descrição do anúncio..."
      );
      await new Promise(function (r) {
        setTimeout(r, 350);
      });
      setProgress(100, "Anúncio criado com sucesso!");

      showSuccess(resp.data, payload);
      toast("Anúncio publicado: " + resp.data.item_id);
    } catch (err) {
      hideProgress();
      window.MercadoLivreApiError.render(el("cam-errors"), {
        motivo: err.message || "Erro inesperado ao publicar.",
        erros: [],
      });
    } finally {
      CAM.publishing = false;
      setPublishEnabled(true);
      setTimeout(hideProgress, 900);
    }
  }

  function showSuccess(data, payload) {
    el("cam-success").hidden = false;
    el("cam-success-id").textContent = data.item_id || "—";
    el("cam-success-status").textContent = data.status || "—";
    var link = data.permalink || "#";
    var a = el("cam-success-link");
    a.href = link;
    a.textContent = link;
    var open = el("cam-open-link");
    open.href = link;
    var wholesaleRequested = Boolean(payload && payload.precoAtacado);
    var requestedRanges = wholesaleRequested ? payload.precoAtacado.faixas : [];
    var wholesaleData = Object.assign({}, data, {
      precoAtacadoSolicitado:
        data.precoAtacadoSolicitado === true || wholesaleRequested,
    });
    if (
      wholesaleData.precoAtacadoSolicitado === true &&
      wholesaleData.precoAtacadoSalvo !== true
    ) {
      CAM.wholesaleRetry = {
        itemId: data.item_id,
        clienteSlug: payload.clienteSlug,
        faixas: requestedRanges,
      };
    }
    showWholesaleResult(wholesaleData, requestedRanges);
    el("cam-success").scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function resetFormParcial() {
    el("cam-success").hidden = true;
    window.MercadoLivreApiError.clear(el("cam-errors"));
    el("cam-title").value = "";
    el("cam-title-count").textContent = "0";
    el("cam-price").value = "";
    el("cam-qty").value = "1";
    el("cam-description").value = "";
    el("cam-sku").value = "";
    resetWholesaleConfig();
    CAM.variations = [];
    renderVariations();
    if (CAM.imagesForm) CAM.imagesForm.setPictures([]);
  }

  // ─── Bindings ──────────────────────────────────────────────────────────────
  function bind() {
    el("cam-cliente").addEventListener("change", onClienteChange);
    el("cam-category-search").addEventListener("click", buscarCategorias);
    el("cam-category-q").addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") {
        ev.preventDefault();
        buscarCategorias();
      }
    });
    el("cam-category-results").addEventListener("click", function (ev) {
      var btn = ev.target.closest(".cam-cat-item");
      if (!btn) return;
      selecionarCategoria(btn.getAttribute("data-id"), btn.getAttribute("data-name"));
    });

    el("cam-title").addEventListener("input", function () {
      el("cam-title-count").textContent = String(el("cam-title").value.length);
    });

    el("cam-wholesale-enabled").addEventListener("change", function () {
      var enabled = el("cam-wholesale-enabled").checked;
      el("cam-wholesale-config").hidden = !enabled;
      if (enabled && !CAM.wholesaleRanges.length) {
        CAM.wholesaleRanges.push({
          quantidadeMinima: null,
          precoUnitario: null,
        });
      }
      renderWholesaleRanges();
    });

    el("cam-wholesale-add").addEventListener("click", function () {
      syncWholesaleFromDom();
      if (CAM.wholesaleRanges.length >= 5) return;
      CAM.wholesaleRanges.push({
        quantidadeMinima: null,
        precoUnitario: null,
      });
      renderWholesaleRanges();
    });

    el("cam-wholesale-ranges").addEventListener("click", function (ev) {
      var btn = ev.target.closest(".cam-wholesale-remove");
      if (!btn) return;
      syncWholesaleFromDom();
      CAM.wholesaleRanges.splice(Number(btn.getAttribute("data-idx")), 1);
      renderWholesaleRanges();
    });

    el("cam-var-add").addEventListener("click", function () {
      syncVariationsFromDom();
      CAM.variations.push({
        attribute_combinations: [],
        price: Number(el("cam-price").value) || null,
        available_quantity: Number(el("cam-qty").value) || 1,
      });
      renderVariations();
    });

    el("cam-variations").addEventListener("click", function (ev) {
      var btn = ev.target.closest(".cam-var-remove");
      if (!btn) return;
      syncVariationsFromDom();
      var idx = Number(btn.getAttribute("data-idx"));
      CAM.variations.splice(idx, 1);
      renderVariations();
    });

    el("cam-publish").addEventListener("click", publicar);
    el("cam-wholesale-retry").addEventListener("click", retryWholesalePrices);
    el("cam-copy-link").addEventListener("click", function () {
      var link = el("cam-success-link").href;
      if (!link || link === "#") return;
      navigator.clipboard.writeText(link).then(
        function () {
          toast("Link copiado!");
        },
        function () {
          toast("Não foi possível copiar.");
        }
      );
    });
    el("cam-new-listing").addEventListener("click", resetFormParcial);

    CAM.imagesForm = window.ProductImagesForm.mount(el("cam-images"), {
      onError: function (msg) {
        toast(msg);
      },
    });

    if (window.DynamicAttributesForm) {
      window.DynamicAttributesForm.mount(el("cam-attrs"), { atributos: [] });
    }
    renderVariations();
    renderWholesaleRanges();
  }

  // ─── Boot ──────────────────────────────────────────────────────────────────
  bind();
  carregarClientes();
})();
