const API_BASE = "https://venforce-server.onrender.com";

function qs(name) {
  return new URLSearchParams(window.location.search).get(name);
}

function escapeHTML(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}

function brl(v) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(v) || 0);
}

function pct(v) {
  const n = Number(v) || 0;
  return (n * 100).toFixed(2) + "%";
}

function formatDateTimePtBR(d) {
  try { return new Date(d).toLocaleString("pt-BR"); } catch { return ""; }
}

function renderErro(msg) {
  const root = document.getElementById("rp-root");
  if (!root) return;
  root.innerHTML = `
    <div class="rp-error">
      <div style="font-weight:950;font-size:16px;margin-bottom:8px;">Não foi possível abrir o relatório</div>
      <div style="color:#7f1d1d;line-height:1.55;">${escapeHTML(msg || "Token inválido ou ausente.")}</div>
    </div>
  `;
}

function cardValueToText(card) {
  if (!card) return "—";
  if (card.tipoValor === "pct") return pct(card.raw);
  return String(card.valor || "—");
}

function renderEntrega(entrega) {
  const payload = entrega?.payload_json || {};
  const titulo = payload?.titulo || entrega?.titulo || "Relatório";
  const periodo = payload?.periodo || entrega?.periodo || "";
  const cliente = payload?.cliente || {};
  const clienteNome = cliente?.nome || entrega?.cliente_nome || "";
  const clienteSlug = cliente?.slug || entrega?.cliente_slug || "";
  const geradoEm = payload?.metadados?.geradoEm || entrega?.created_at || null;

  const resumo = payload?.resumoExecutivo || "";
  const cards = Array.isArray(payload?.cards) ? payload.cards : [];
  const secoes = Array.isArray(payload?.secoes) ? payload.secoes : [];
  const tabelas = Array.isArray(payload?.tabelas) ? payload.tabelas : [];
  const conclusao = payload?.conclusao || "";

  const metaBits = [];
  if (clienteNome || clienteSlug) metaBits.push(`<span><strong>Cliente:</strong> ${escapeHTML(clienteNome || clienteSlug)}</span>`);
  if (periodo) metaBits.push(`<span><strong>Período:</strong> ${escapeHTML(periodo)}</span>`);
  if (geradoEm) metaBits.push(`<span><strong>Gerado em:</strong> ${escapeHTML(formatDateTimePtBR(geradoEm))}</span>`);

  const cardsHtml = cards.length
    ? `<div class="rp-cards">${cards.map((c) => {
        const featured = c.destaque ? "rp-card-featured" : "";
        return `
          <div class="rp-card ${featured}">
            <div class="rp-card-title">${escapeHTML(c.titulo || "Indicador")}</div>
            <div class="rp-card-value">${escapeHTML(cardValueToText(c))}</div>
          </div>
        `;
      }).join("")}</div>`
    : `<p class="rp-lead">Sem cards disponíveis.</p>`;

  const secoesHtml = secoes.length
    ? secoes.map((s) => {
        const isAttn = String(s.tipo || "").toLowerCase() === "atencao";
        const badge = isAttn ? `<span class="rp-badge rp-badge-attn">Atenção</span>` : `<span class="rp-badge">Nota</span>`;
        const bullets = Array.isArray(s.bullets) && s.bullets.length
          ? `<ul style="margin:10px 0 0;padding-left:18px;color:#374151;line-height:1.6;">${s.bullets.map((b) => `<li>${escapeHTML(String(b))}</li>`).join("")}</ul>`
          : "";
        return `
          <section class="rp-section">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
              <h2 class="rp-section-title">${escapeHTML(s.titulo || "Seção")}</h2>
              ${badge}
            </div>
            <p class="rp-lead">${escapeHTML(s.texto || "")}</p>
            ${bullets}
          </section>
        `;
      }).join("")
    : "";

  const tabelasHtml = tabelas.length
    ? tabelas.map((t) => {
        const cols = Array.isArray(t.colunas) ? t.colunas : [];
        const linhas = Array.isArray(t.linhas) ? t.linhas : [];
        const head = cols.map((c) => `<th>${escapeHTML(c)}</th>`).join("");
        const body = linhas.map((row) => {
          const tds = cols.map((c) => `<td>${escapeHTML(row?.[c] ?? "")}</td>`).join("");
          return `<tr>${tds}</tr>`;
        }).join("");
        const desc = t.descricao ? `<p class="rp-lead" style="margin-top:0;">${escapeHTML(t.descricao)}</p>` : "";
        const foot = Number(t.totalOriginal) > linhas.length
          ? `<div style="margin-top:10px;color:#6b7280;font-size:12.5px;">Exibindo ${linhas.length} de ${t.totalOriginal} linha(s).</div>`
          : "";
        return `
          <section class="rp-section">
            <h2 class="rp-section-title">${escapeHTML(t.titulo || "Tabela")}</h2>
            ${desc}
            <div style="overflow:auto;">
              <table class="rp-table">
                <thead><tr>${head}</tr></thead>
                <tbody>${body}</tbody>
              </table>
            </div>
            ${foot}
          </section>
        `;
      }).join("")
    : "";

  const conclusaoHtml = conclusao
    ? `
      <section class="rp-section">
        <h2 class="rp-section-title">Conclusão</h2>
        <p class="rp-lead">${escapeHTML(conclusao)}</p>
      </section>
    `
    : "";

  const root = document.getElementById("rp-root");
  if (!root) return;
  root.innerHTML = `
    <article class="rp-sheet">
      <header class="rp-cover">
        <div class="rp-kicker">VENFORCE · RELATÓRIO</div>
        <div class="rp-title">${escapeHTML(titulo)}</div>
        <div class="rp-meta">${metaBits.join("")}</div>
      </header>

      <section class="rp-section">
        <h2 class="rp-section-title">Resumo executivo</h2>
        <p class="rp-lead">${escapeHTML(resumo || "—")}</p>
      </section>

      <section class="rp-section">
        <h2 class="rp-section-title">Indicadores</h2>
        ${cardsHtml}
      </section>

      ${secoesHtml}
      ${tabelasHtml}
      ${conclusaoHtml}
    </article>
  `;
}

async function main() {
  const token = String(qs("token") || "").trim();
  const btnPdf = document.getElementById("btn-rp-pdf");
  if (btnPdf) btnPdf.addEventListener("click", () => window.print());

  if (!token) {
    renderErro("Token ausente. Peça ao responsável o link completo do relatório.");
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/public/entregas/${encodeURIComponent(token)}`);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      renderErro(json?.erro || json?.error || "Relatório não encontrado ou expirado.");
      return;
    }
    renderEntrega(json?.entrega);

    if (String(qs("print") || "").trim() === "1") {
      setTimeout(() => window.print(), 350);
    }
  } catch (err) {
    renderErro(err?.message || "Erro ao carregar relatório.");
  }
}

main();

