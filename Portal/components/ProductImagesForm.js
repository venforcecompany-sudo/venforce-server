// Portal/components/ProductImagesForm.js
// Gerencia URLs de imagens do anúncio (preview + ordenação).
// Uso: ProductImagesForm.mount(container, { onChange })
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

  function isValidUrl(url) {
    try {
      const u = new URL(url);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch (e) {
      return false;
    }
  }

  function mount(container, options) {
    if (!container) return null;
    const opts = options || {};
    const state = { images: Array.isArray(opts.initial) ? opts.initial.slice() : [] };

    container.innerHTML =
      '<div class="cam-images">' +
      '<div class="cam-images-add">' +
      '<input type="url" class="vf-input" id="cam-image-url" placeholder="https://.../imagem.jpg" aria-describedby="cam-images-hint" />' +
      '<button type="button" class="vf-btn vf-btn--secondary" id="cam-image-add">Adicionar</button>' +
      "</div>" +
      '<p class="vf-field__hint" id="cam-images-hint">Informe URLs públicas HTTPS. A primeira imagem será a capa do anúncio.</p>' +
      '<div class="cam-images-list" id="cam-pictures-list"></div>' +
      "</div>";

    const listEl = container.querySelector("#cam-pictures-list");
    const inputEl = container.querySelector("#cam-image-url");
    const addBtn = container.querySelector("#cam-image-add");

    function notify() {
      if (typeof opts.onChange === "function") {
        opts.onChange(getPictures());
      }
    }

    function getPictures() {
      return state.images.map(function (src) {
        return { source: src };
      });
    }

    function render() {
      if (!state.images.length) {
        listEl.innerHTML =
          '<div class="vf-empty cam-empty"><p class="vf-empty__description">Nenhuma imagem adicionada.</p></div>';
        notify();
        return;
      }

      listEl.innerHTML = state.images
        .map(function (src, idx) {
          return (
            '<div class="cam-image-card" data-idx="' +
            idx +
            '">' +
            '<div class="cam-image-preview">' +
            '<img src="' +
            escapeHtml(src) +
            '" alt="Imagem ' +
            (idx + 1) +
            '" loading="lazy" />' +
            (idx === 0 ? '<span class="vf-tag is-primary cam-image-badge">Capa</span>' : "") +
            "</div>" +
            '<div class="cam-image-meta">' +
            '<div class="cam-image-url" title="' +
            escapeHtml(src) +
            '">' +
            escapeHtml(src) +
            "</div>" +
            '<div class="cam-image-actions">' +
            '<button type="button" class="vf-btn vf-btn--ghost vf-btn--sm vf-btn--icon cam-img-up" aria-label="Mover imagem ' + (idx + 1) + ' para cima" data-idx="' +
            idx +
            '"' +
            (idx === 0 ? " disabled" : "") +
            ">↑</button>" +
            '<button type="button" class="vf-btn vf-btn--ghost vf-btn--sm vf-btn--icon cam-img-down" aria-label="Mover imagem ' + (idx + 1) + ' para baixo" data-idx="' +
            idx +
            '"' +
            (idx === state.images.length - 1 ? " disabled" : "") +
            ">↓</button>" +
            '<button type="button" class="vf-btn vf-btn--ghost vf-btn--sm cam-img-remove" data-idx="' +
            idx +
            '">Remover</button>' +
            "</div></div></div>"
          );
        })
        .join("");
      notify();
    }

    function addImage() {
      const url = String((inputEl && inputEl.value) || "").trim();
      if (!url) return;
      if (!isValidUrl(url)) {
        if (typeof opts.onError === "function") {
          opts.onError("URL de imagem inválida. Use http:// ou https://.");
        }
        inputEl.classList.add("is-invalid", "is-error");
        inputEl.setAttribute("aria-invalid", "true");
        return;
      }
      inputEl.classList.remove("is-invalid", "is-error");
      inputEl.removeAttribute("aria-invalid");
      if (state.images.indexOf(url) >= 0) return;
      state.images.push(url);
      inputEl.value = "";
      render();
    }

    addBtn.addEventListener("click", addImage);
    inputEl.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") {
        ev.preventDefault();
        addImage();
      }
    });

    listEl.addEventListener("error", function (ev) {
      if (ev.target && ev.target.matches(".cam-image-preview img")) ev.target.classList.add("is-broken");
    }, true);

    listEl.addEventListener("click", function (ev) {
      const btn = ev.target.closest("button");
      if (!btn) return;
      const idx = Number(btn.getAttribute("data-idx"));
      if (!Number.isFinite(idx)) return;

      if (btn.classList.contains("cam-img-remove")) {
        state.images.splice(idx, 1);
        render();
        return;
      }
      if (btn.classList.contains("cam-img-up") && idx > 0) {
        const tmp = state.images[idx - 1];
        state.images[idx - 1] = state.images[idx];
        state.images[idx] = tmp;
        render();
        return;
      }
      if (btn.classList.contains("cam-img-down") && idx < state.images.length - 1) {
        const tmp = state.images[idx + 1];
        state.images[idx + 1] = state.images[idx];
        state.images[idx] = tmp;
        render();
      }
    });

    render();

    return {
      getPictures: getPictures,
      setPictures: function (pics) {
        state.images = (pics || [])
          .map(function (p) {
            return (p && p.source) || p;
          })
          .filter(Boolean);
        render();
      },
      validate: function () {
        if (!state.images.length) {
          return { ok: false, mensagem: "Adicione pelo menos uma imagem." };
        }
        for (let i = 0; i < state.images.length; i++) {
          if (!isValidUrl(state.images[i])) {
            return {
              ok: false,
              mensagem: "A imagem #" + (i + 1) + " possui URL inválida.",
            };
          }
        }
        return { ok: true };
      },
    };
  }

  global.ProductImagesForm = { mount: mount, isValidUrl: isValidUrl };
})(typeof window !== "undefined" ? window : global);
