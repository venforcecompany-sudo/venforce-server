// Portal/components/MercadoLivreApiError.js
// Renderiza erros amigáveis da API / validação do Mercado Livre.
// Uso: MercadoLivreApiError.render(container, { motivo, erros })
(function (global) {
  "use strict";

  function escapeHtml(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function render(container, payload) {
    if (!container) return;
    const data = payload || {};
    const erros = Array.isArray(data.erros) ? data.erros : [];
    const motivo = data.motivo || "Não foi possível publicar o anúncio.";

    let items = "";
    if (erros.length) {
      items =
        '<ul class="cam-error-list">' +
        erros
          .map(function (e) {
            return (
              "<li>" +
              (e.campo
                ? '<span class="cam-error-field">' +
                  escapeHtml(e.campo) +
                  "</span> — "
                : "") +
              "<strong>" +
              escapeHtml(e.mensagem || "Erro") +
              "</strong>" +
              (e.sugestao
                ? '<div class="cam-error-hint">' +
                  escapeHtml(e.sugestao) +
                  "</div>"
                : "") +
              (e.codigo
                ? '<div class="cam-error-code">' +
                  escapeHtml(e.codigo) +
                  "</div>"
                : "") +
              "</li>"
            );
          })
          .join("") +
        "</ul>";
    }

    container.innerHTML =
      '<div class="vf-banner is-danger cam-api-error" role="alert"><div class="vf-banner__content">' +
      '<p class="vf-banner__title">Falha na publicação</p><p class="vf-banner__description">' +
      escapeHtml(motivo) +
      "</p>" +
      items +
      "</div></div>";
    container.hidden = false;
  }

  function clear(container) {
    if (!container) return;
    container.innerHTML = "";
    container.hidden = true;
  }

  function highlightFields(root, erros) {
    if (!root) return;
    root.querySelectorAll(".is-invalid").forEach(function (el) {
      el.classList.remove("is-invalid", "is-error");
      el.removeAttribute("aria-invalid");
    });
    (erros || []).forEach(function (e) {
      if (!e || !e.campo) return;
      const map = {
        title: "#cam-title",
        category_id: "#cam-category-q",
        price: "#cam-price",
        available_quantity: "#cam-qty",
        condition: "#cam-condition",
        currency_id: "#cam-currency",
        buying_mode: "#cam-buying-mode",
        listing_type_id: "#cam-listing-type",
        pictures: "#cam-pictures-list",
        attributes: "#cam-attrs",
      };
      const sel = map[e.campo];
      if (!sel) return;
      const el = root.querySelector(sel);
      if (el) { el.classList.add("is-invalid", "is-error"); el.setAttribute("aria-invalid", "true"); }
    });
  }

  global.MercadoLivreApiError = {
    render: render,
    clear: clear,
    highlightFields: highlightFields,
  };
})(typeof window !== "undefined" ? window : global);
