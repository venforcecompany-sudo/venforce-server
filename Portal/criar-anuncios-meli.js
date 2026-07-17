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
    n.className = "cam-toast";
    n.textContent = msg;
    n.style.cssText =
      "position:fixed;right:16px;bottom:16px;z-index:9999;background:#2d2a33;color:#fff;padding:.7rem 1rem;border-radius:10px;font-size:.85rem;box-shadow:0 8px 24px rgba(0,0,0,.18);";
    document.body.appendChild(n);
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
    setPublishEnabled(false);

    var userBox = el("cam-ml-user");
    var statusBox = el("cam-ml-status");
    userBox.textContent = "—";
    userBox.className = "cam-status-box";
    statusBox.textContent = "Validando conexão...";
    statusBox.className = "cam-status-box";

    if (!slug) {
      statusBox.textContent = "Selecione um cliente";
      el("cam-publish-hint").textContent =
        "Selecione uma conta conectada para publicar.";
      return;
    }

    var resp = await api(
      "/anuncios-meli/criacao/status?clienteSlug=" + encodeURIComponent(slug)
    );
    var data = resp.data || {};
    CAM.conta = data;

    if (!data.mlConectado) {
      statusBox.textContent = "Sem token ML";
      statusBox.className = "cam-status-box cam-status-bad";
      el("cam-publish-hint").textContent =
        "Conecte a conta em Clientes → Conectar ML.";
      return;
    }

    if (!data.tokenValido) {
      statusBox.textContent = "Token inválido / expirado";
      statusBox.className = "cam-status-box cam-status-bad";
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
      statusBox.className = "cam-status-box cam-status-warn";
      el("cam-publish-hint").textContent =
        "Esta conta não está apta a listar anúncios.";
      return;
    }

    statusBox.textContent = "Conectado · apto a publicar";
    statusBox.className = "cam-status-box cam-status-ok";
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
    el("cam-publish").disabled = !enabled || CAM.publishing;
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

    box.style.display = "";
    box.innerHTML = '<div class="cam-empty">Buscando categorias...</div>';

    var resp = await api(
      "/anuncios-meli/criacao/categorias?clienteSlug=" +
        encodeURIComponent(slug) +
        "&q=" +
        encodeURIComponent(q)
    );

    if (!resp.ok || !resp.data || !resp.data.ok) {
      box.innerHTML =
        '<div class="cam-empty">' +
        escapeHtml((resp.data && resp.data.motivo) || "Falha ao buscar.") +
        "</div>";
      return;
    }

    var cats = resp.data.categorias || [];
    if (!cats.length) {
      box.innerHTML = '<div class="cam-empty">Nenhuma categoria encontrada.</div>';
      return;
    }

    box.innerHTML = cats
      .map(function (c) {
        return (
          '<button type="button" class="cam-cat-item" data-id="' +
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
    el("cam-category-results").style.display = "none";

    var sel = el("cam-category-selected");
    sel.textContent = categoryName + " (" + categoryId + ")";
    sel.className = "cam-cat-selected is-set";

    await Promise.all([
      carregarAtributos(categoryId),
      carregarSaleTerms(categoryId),
    ]);
  }

  async function carregarAtributos(categoryId) {
    var slug = (el("cam-cliente").value || "").trim();
    var box = el("cam-attrs");
    box.innerHTML = '<div class="cam-empty">Carregando atributos...</div>';

    var resp = await api(
      "/anuncios-meli/criacao/categorias/" +
        encodeURIComponent(categoryId) +
        "/atributos?clienteSlug=" +
        encodeURIComponent(slug)
    );

    if (!resp.ok || !resp.data || !resp.data.ok) {
      box.innerHTML =
        '<div class="cam-empty">' +
        escapeHtml((resp.data && resp.data.motivo) || "Erro ao carregar atributos.") +
        "</div>";
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
    box.innerHTML = '<div class="cam-empty">Carregando termos...</div>';

    var resp = await api(
      "/anuncios-meli/criacao/categorias/" +
        encodeURIComponent(categoryId) +
        "/sale-terms?clienteSlug=" +
        encodeURIComponent(slug)
    );

    var terms =
      resp.ok && resp.data && resp.data.ok ? resp.data.saleTerms || [] : [];
    CAM.saleTermsApi = terms;

    if (!terms.length) {
      box.innerHTML =
        '<div class="cam-empty">Nenhum termo comercial específico para esta categoria. Você pode preencher garantia manualmente abaixo.</div>' +
        renderSaleTermsFallback();
      return;
    }

    box.innerHTML =
      '<div class="cam-sale-grid">' +
      terms
        .map(function (t) {
          var id = "cam-st-" + escapeHtml(t.id);
          var label =
            escapeHtml(t.name || t.id) +
            (t.required ? ' <span class="cam-req">*</span>' : "");
          var control = "";
          if (Array.isArray(t.values) && t.values.length) {
            control =
              '<select class="vf-input cam-st-input" data-st-id="' +
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
            '<div class="vf-form-group" style="margin:0;"><label for="' +
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
      '<div class="cam-sale-grid" style="margin-top:.75rem;">' +
      '<div class="vf-form-group" style="margin:0;">' +
      '<label for="cam-st-WARRANTY_TYPE">Tipo de garantia</label>' +
      '<select id="cam-st-WARRANTY_TYPE" class="vf-input cam-st-input" data-st-id="WARRANTY_TYPE">' +
      '<option value="">Não informar</option>' +
      '<option value="name:Garantia do vendedor">Garantia do vendedor</option>' +
      '<option value="name:Garantia de fábrica">Garantia de fábrica</option>' +
      '<option value="name:Sem garantia">Sem garantia</option>' +
      "</select></div>" +
      '<div class="vf-form-group" style="margin:0;">' +
      '<label for="cam-st-WARRANTY_TIME">Tempo de garantia</label>' +
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
      box.innerHTML =
        '<div class="cam-empty">Nenhuma variação adicionada. O anúncio será publicado sem variations.</div>';
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
          '</span><button type="button" class="vf-btn-xs cam-var-remove" data-idx="' +
          idx +
          '">Remover</button></div>' +
          '<div class="cam-grid-3">' +
          '<div class="vf-form-group" style="margin:0;"><label>Combinações (JSON)</label>' +
          '<input type="text" class="vf-input cam-var-combos" data-idx="' +
          idx +
          '" value="' +
          escapeHtml(JSON.stringify(v.attribute_combinations || [])) +
          '" placeholder=\'[{"id":"COLOR","value_name":"Preto"}]\' /></div>' +
          '<div class="vf-form-group" style="margin:0;"><label>Preço</label>' +
          '<input type="number" class="vf-input cam-var-price" data-idx="' +
          idx +
          '" min="0.01" step="0.01" value="' +
          escapeHtml(v.price != null ? v.price : "") +
          '" /></div>' +
          '<div class="vf-form-group" style="margin:0;"><label>Estoque</label>' +
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

    return payload;
  }

  function setProgress(pct, label) {
    var wrap = el("cam-progress");
    wrap.style.display = "";
    el("cam-progress-fill").style.width = pct + "%";
    el("cam-progress-label").textContent = label || "Publicando...";
  }

  function hideProgress() {
    el("cam-progress").style.display = "none";
  }

  async function publicar() {
    if (CAM.publishing) return;

    window.MercadoLivreApiError.clear(el("cam-errors"));
    el("cam-success").style.display = "none";

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
      setProgress(45, "Enviando anúncio ao Mercado Livre (POST /items)...");
      var resp = await api("/anuncios-meli/criacao/publicar", {
        method: "POST",
        body: payload,
      });

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

      setProgress(82, "Salvando descrição do anúncio...");
      await new Promise(function (r) {
        setTimeout(r, 350);
      });
      setProgress(100, "Anúncio criado com sucesso!");

      showSuccess(resp.data);
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

  function showSuccess(data) {
    el("cam-success").style.display = "";
    el("cam-success-id").textContent = data.item_id || "—";
    el("cam-success-status").textContent = data.status || "—";
    var link = data.permalink || "#";
    var a = el("cam-success-link");
    a.href = link;
    a.textContent = link;
    var open = el("cam-open-link");
    open.href = link;
    el("cam-success").scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function resetFormParcial() {
    el("cam-success").style.display = "none";
    window.MercadoLivreApiError.clear(el("cam-errors"));
    el("cam-title").value = "";
    el("cam-title-count").textContent = "0";
    el("cam-price").value = "";
    el("cam-qty").value = "1";
    el("cam-description").value = "";
    el("cam-sku").value = "";
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
  }

  // ─── Boot ──────────────────────────────────────────────────────────────────
  bind();
  carregarClientes();
})();
