// Portal/components/DynamicAttributesForm.js
// Formulário dinâmico de atributos de categoria do Mercado Livre.
// Uso: DynamicAttributesForm.mount(container, { atributos, valoresIniciais, onChange })
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

  function isRequired(attr) {
    return !!(attr && (attr.required || (attr.tags && (attr.tags.required || attr.tags.catalog_required))));
  }

  function renderField(attr, valor) {
    const required = isRequired(attr);
    const values = Array.isArray(attr.values) ? attr.values : [];
    const id = "cam-attr-" + escapeHtml(attr.id);
    const label =
      escapeHtml(attr.name || attr.id) +
      (required ? ' <span class="cam-req">*</span>' : "");

    let control = "";
    const current = valor || {};

    if (values.length > 0 && (attr.value_type === "list" || attr.value_type === "boolean" || values.length <= 40)) {
      const opts = ['<option value="">Selecione...</option>']
        .concat(
          values.map(function (v) {
            const selected =
              String(current.value_id || "") === String(v.id) ? " selected" : "";
            return (
              '<option value="' +
              escapeHtml(v.id) +
              '"' +
              selected +
              ">" +
              escapeHtml(v.name) +
              "</option>"
            );
          })
        )
        .join("");
      control =
        '<select class="vf-input cam-attr-input" data-attr-id="' +
        escapeHtml(attr.id) +
        '" data-mode="list" id="' +
        id +
        '"' +
        (required ? " required" : "") +
        ">" +
        opts +
        "</select>";
    } else if (attr.value_type === "number_unit" && Array.isArray(attr.allowed_units) && attr.allowed_units.length) {
      const unit = current.unit || attr.default_unit || (attr.allowed_units[0] && attr.allowed_units[0].id) || "";
      const unitOpts = attr.allowed_units
        .map(function (u) {
          const uid = u.id || u;
          const uname = u.name || u.id || u;
          const selected = String(unit) === String(uid) ? " selected" : "";
          return (
            '<option value="' +
            escapeHtml(uid) +
            '"' +
            selected +
            ">" +
            escapeHtml(uname) +
            "</option>"
          );
        })
        .join("");
      control =
        '<div class="cam-attr-unit-row">' +
        '<input type="number" class="vf-input cam-attr-input" data-attr-id="' +
        escapeHtml(attr.id) +
        '" data-mode="number_unit" id="' +
        id +
        '" value="' +
        escapeHtml(current.number != null ? current.number : "") +
        '"' +
        (required ? " required" : "") +
        " />" +
        '<select class="vf-input cam-attr-unit" data-attr-id="' +
        escapeHtml(attr.id) +
        '">' +
        unitOpts +
        "</select>" +
        "</div>";
    } else {
      control =
        '<input type="text" class="vf-input cam-attr-input" data-attr-id="' +
        escapeHtml(attr.id) +
        '" data-mode="string" id="' +
        id +
        '" value="' +
        escapeHtml(current.value_name || "") +
        '" placeholder="' +
        escapeHtml(attr.name || "") +
        '"' +
        (required ? " required" : "") +
        (attr.value_max_length ? ' maxlength="' + attr.value_max_length + '"' : "") +
        " />";
    }

    return (
      '<div class="vf-form-group cam-attr-field" data-attr-id="' +
      escapeHtml(attr.id) +
      '">' +
      "<label for=\"" +
      id +
      '">' +
      label +
      "</label>" +
      control +
      (attr.id
        ? '<div class="cam-attr-hint">ID: ' + escapeHtml(attr.id) + "</div>"
        : "") +
      "</div>"
    );
  }

  function collect(container) {
    if (!container) return [];
    const attrsMeta = container._camAtributos || [];
    const byId = {};
    attrsMeta.forEach(function (a) {
      byId[a.id] = a;
    });

    const result = [];
    const inputs = container.querySelectorAll(".cam-attr-input");
    inputs.forEach(function (input) {
      const attrId = input.getAttribute("data-attr-id");
      const mode = input.getAttribute("data-mode");
      const meta = byId[attrId] || { id: attrId, name: attrId };
      if (!attrId) return;

      if (mode === "list") {
        const valueId = String(input.value || "").trim();
        if (!valueId) return;
        const opt = input.options[input.selectedIndex];
        result.push({
          id: attrId,
          value_id: valueId,
          value_name: opt ? opt.textContent : undefined,
        });
        return;
      }

      if (mode === "number_unit") {
        const num = String(input.value || "").trim();
        if (!num) return;
        const unitSel = container.querySelector(
          '.cam-attr-unit[data-attr-id="' + attrId + '"]'
        );
        const unit = unitSel ? unitSel.value : meta.default_unit || "";
        result.push({
          id: attrId,
          value_name: unit ? num + " " + unit : num,
        });
        return;
      }

      const name = String(input.value || "").trim();
      if (!name) return;
      result.push({ id: attrId, value_name: name });
    });

    return result;
  }

  function getRequiredIds(container) {
    const attrs = (container && container._camAtributos) || [];
    return attrs.filter(isRequired).map(function (a) {
      return a.id;
    });
  }

  function mount(container, options) {
    if (!container) return null;
    const opts = options || {};
    const atributos = Array.isArray(opts.atributos) ? opts.atributos : [];
    const iniciais = opts.valoresIniciais || {};
    container._camAtributos = atributos;

    if (!atributos.length) {
      container.innerHTML =
        '<div class="cam-empty">Selecione uma categoria para carregar os atributos.</div>';
      return { collect: function () { return []; }, getRequiredIds: function () { return []; } };
    }

    const required = atributos.filter(isRequired);
    const optional = atributos.filter(function (a) {
      return !isRequired(a) && !(a.tags && a.tags.hidden);
    });

    let html = "";
    if (required.length) {
      html += '<div class="cam-attr-section"><h6>Atributos obrigatórios</h6><div class="cam-attr-grid">';
      required.forEach(function (a) {
        html += renderField(a, iniciais[a.id]);
      });
      html += "</div></div>";
    }
    if (optional.length) {
      html +=
        '<details class="cam-attr-optional"><summary>Atributos opcionais (' +
        optional.length +
        ')</summary><div class="cam-attr-grid">';
      optional.slice(0, 40).forEach(function (a) {
        html += renderField(a, iniciais[a.id]);
      });
      html += "</div></details>";
    }

    container.innerHTML = html;

    function notify() {
      if (typeof opts.onChange === "function") {
        opts.onChange(collect(container));
      }
    }

    container.addEventListener("change", notify);
    container.addEventListener("input", notify);

    return {
      collect: function () {
        return collect(container);
      },
      getRequiredIds: function () {
        return getRequiredIds(container);
      },
      destroy: function () {
        container.innerHTML = "";
        container._camAtributos = [];
      },
    };
  }

  global.DynamicAttributesForm = {
    mount: mount,
    collect: collect,
    getRequiredIds: getRequiredIds,
  };
})(typeof window !== "undefined" ? window : global);
