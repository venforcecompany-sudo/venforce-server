// Grava o vídeo tutorial da página Anúncios ML: abre o Portal REAL
// (Portal/anuncios-meli.html) servido localmente, com o backend substituído
// por dados de demonstração (mock.js — nenhuma chamada ao servidor real),
// e conduz um tour com cursor, destaques e legendas.
//
// Uso: node tools/video-tutorial-anuncios/tour.js
// Requer Playwright (Chromium) e ffmpeg. Saída em out/tutorial-anuncios-ml.mp4.
"use strict";
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const { rotear } = require("./mock");
const OUT = path.join(__dirname, "out");

const W = 1600, H = 900;

// Overlay do vídeo: cursor, clique, destaque e legenda. pointer-events: none em tudo.
const OVERLAY = () => {
  const css = `
  #tv-cursor{position:fixed;left:0;top:0;width:26px;height:26px;z-index:2147483647;pointer-events:none;transform:translate(-3px,-2px);transition:transform .08s}
  #tv-cursor.down{transform:translate(-3px,-2px) scale(.85)}
  .tv-ripple{position:fixed;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;border:3px solid #7c3aed;z-index:2147483646;pointer-events:none;animation:tvr .6s ease-out forwards}
  @keyframes tvr{to{transform:scale(4);opacity:0}}
  #tv-hl{position:fixed;z-index:2147483645;pointer-events:none;border:3px solid #f59e0b;border-radius:12px;box-shadow:0 0 0 4000px rgba(15,10,30,.28),0 0 18px rgba(245,158,11,.8);opacity:0;transition:all .45s ease}
  #tv-cap{position:fixed;left:50%;bottom:28px;transform:translateX(-50%) translateY(20px);z-index:2147483647;pointer-events:none;max-width:1100px;
    background:rgba(24,16,48,.94);color:#fff;font:500 21px/1.4 'Hanken Grotesk',system-ui,sans-serif;padding:16px 26px;border-radius:14px;
    box-shadow:0 12px 40px rgba(0,0,0,.35);opacity:0;transition:all .4s ease;display:flex;gap:16px;align-items:center}
  #tv-cap.on{opacity:1;transform:translateX(-50%) translateY(0)}
  #tv-cap b{background:#7c3aed;border-radius:8px;padding:4px 11px;font-size:16px;white-space:nowrap;letter-spacing:.02em}
  #tv-card{position:fixed;inset:0;z-index:2147483647;pointer-events:none;display:flex;flex-direction:column;align-items:center;justify-content:center;
    background:linear-gradient(135deg,#2a1260 0%,#4c1d95 55%,#6d28d9 100%);color:#fff;font-family:'Manrope',system-ui,sans-serif;opacity:0;transition:opacity .7s}
  #tv-card.on{opacity:1}
  #tv-card .k{font-size:22px;letter-spacing:.28em;text-transform:uppercase;opacity:.75;margin-bottom:18px}
  #tv-card .t{font-size:68px;font-weight:800;margin-bottom:18px}
  #tv-card .s{font-size:26px;opacity:.9;max-width:1000px;text-align:center;line-height:1.45}
  #tv-card ul{margin-top:28px;font-size:22px;line-height:1.75;opacity:.92;columns:2;column-gap:60px}`;
  const boot = () => {
    if (document.getElementById("tv-cursor")) return;
    const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
    const c = document.createElement("div"); c.id = "tv-cursor";
    c.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M4 2l15 11.2-6.6 1.1 4.1 7.3-2.9 1.6-4.1-7.4L4 20.3z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    c.style.left = "800px"; c.style.top = "450px";
    document.body.appendChild(c);
    const hl = document.createElement("div"); hl.id = "tv-hl"; document.body.appendChild(hl);
    const cap = document.createElement("div"); cap.id = "tv-cap"; document.body.appendChild(cap);
    const card = document.createElement("div"); card.id = "tv-card"; document.body.appendChild(card);
    document.addEventListener("mousemove", (e) => { c.style.left = e.clientX + "px"; c.style.top = e.clientY + "px"; }, true);
    document.addEventListener("mousedown", (e) => {
      c.classList.add("down");
      const r = document.createElement("div"); r.className = "tv-ripple"; r.style.left = e.clientX + "px"; r.style.top = e.clientY + "px";
      document.body.appendChild(r); setTimeout(() => r.remove(), 700);
    }, true);
    document.addEventListener("mouseup", () => c.classList.remove("down"), true);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
};

(async () => {
  const srv = await require("./server")();
  const port = srv.address().port;
  const browser = await chromium.launch(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY, bypass: "127.0.0.1,localhost" } } : {});
  const ctx = await browser.newContext({
    viewport: { width: W, height: H }, ignoreHTTPSErrors: true, locale: "pt-BR",
    recordVideo: { dir: path.join(OUT, "rec"), size: { width: W, height: H } },
  });
  await ctx.addInitScript(() => {
    localStorage.setItem("vf-token", "demo");
    localStorage.setItem("vf-user", JSON.stringify({ id: 12, nome: "Ana Souza", role: "user" }));
  });
  await ctx.addInitScript(OVERLAY);
  const t0 = Date.now();
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("ERR", e.message));
  await rotear(page);

  const wait = (ms) => page.waitForTimeout(Math.round(ms * 0.8));
  let mx = 800, my = 450;
  async function moveTo(x, y, steps) {
    await page.mouse.move(x, y, { steps: steps || 28 });
    mx = x; my = y;
  }
  async function boxOf(target) {
    const loc = typeof target === "string" ? page.locator(target).first() : target;
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    return loc.boundingBox();
  }
  async function go(target, dx, dy) {
    const b = await boxOf(target);
    if (!b) { console.log("WARN sem caixa", String(target)); return null; }
    const x = b.x + (dx == null ? b.width / 2 : dx), y = b.y + (dy == null ? b.height / 2 : dy);
    await moveTo(x, y);
    await wait(250);
    return { x, y };
  }
  async function click(target, dx, dy) {
    if (!(await go(target, dx, dy))) return;
    await page.mouse.down(); await wait(90); await page.mouse.up();
    await wait(400);
  }
  async function hl(target, pad) {
    pad = pad == null ? 8 : pad;
    const b = await boxOf(target);
    if (!b) return;
    await page.evaluate(([b, pad]) => {
      const h = document.getElementById("tv-hl");
      Object.assign(h.style, { left: (b.x - pad) + "px", top: (b.y - pad) + "px", width: (b.width + 2 * pad) + "px", height: (b.height + 2 * pad) + "px", opacity: 1 });
    }, [b, pad]);
  }
  async function hlOff() { await page.evaluate(() => { document.getElementById("tv-hl").style.opacity = 0; }); }
  async function cap(n, txt) {
    await page.evaluate(([n, txt]) => {
      const c = document.getElementById("tv-cap");
      c.classList.remove("on");
      setTimeout(() => { c.innerHTML = (n ? "<b>" + n + "</b>" : "") + "<span>" + txt + "</span>"; c.classList.add("on"); }, 250);
    }, [n, txt]);
    await wait(450);
  }
  async function capOff() { await page.evaluate(() => document.getElementById("tv-cap").classList.remove("on")); }
  async function card(html, ms) {
    await page.evaluate((html) => { const c = document.getElementById("tv-card"); c.innerHTML = html; c.classList.add("on"); }, html);
    await wait(ms);
    await page.evaluate(() => document.getElementById("tv-card").classList.remove("on"));
    await wait(700);
  }
  async function scrollTo(y, el) {
    await page.evaluate(([y, el]) => { (el ? document.querySelector(el) : window).scrollTo({ top: y, behavior: "smooth" }); }, [y, el || null]);
    await wait(900);
  }
  async function scrollToEl(sel, offset, scroller) {
    await page.evaluate(([sel, offset, scroller]) => {
      const e = document.querySelector(sel);
      if (scroller) {
        const s = document.querySelector(scroller);
        s.scrollTo({ top: e.getBoundingClientRect().top - s.getBoundingClientRect().top + s.scrollTop - offset, behavior: "smooth" });
      } else window.scrollTo({ top: e.getBoundingClientRect().top + window.scrollY - offset, behavior: "smooth" });
    }, [sel, offset, scroller || null]);
    await wait(1000);
  }

  await page.goto(`http://127.0.0.1:${port}/anuncios-meli.html?cliente=casabella&conta=42`);
  await page.waitForSelector('.am-row[data-item="MLB3456789012"] .am-margem__valor', { timeout: 20000 });
  await page.evaluate(() => document.fonts.ready);
  await wait(1500);
  const inicio = (Date.now() - t0) / 1000;
  await page.mouse.move(mx, my);

  // ── Abertura ───────────────────────────────────────────────────────────
  await card('<div class="k">VenForce · Guia rápido</div><div class="t">Anúncios ML</div><div class="s">Como consultar, filtrar, precificar e otimizar os anúncios Mercado Livre de cada cliente</div>', 4200);

  // ── 1. Contexto ────────────────────────────────────────────────────────
  await cap("1", "Primeiro escolha o <u>cliente</u> e a <u>operação</u> (conta Mercado Livre) na barra lateral.");
  await hl(".vf-shell__sidebar .vf-shell__context, .vf-shell__sidebar [class*=context]", 6).catch(async () => {});
  await go("text=Casa Bella Utilidades >> nth=0");
  await wait(1500);
  await go("text=casabella_oficial >> nth=0");
  await wait(2200);
  await hlOff();

  // ── 2. Sincronização ───────────────────────────────────────────────────
  await cap("2", "No topo: status da conexão e última sincronização. <b style='background:none;padding:0'>Atualizar</b> traz só anúncios novos; <b style='background:none;padding:0'>Sincronizar</b> revisa todo o catálogo e recalcula a margem.");
  await hl("#am-hud-top", 4);
  await wait(2000);
  await go("#am-hud-top >> text=Atualizar >> nth=-1");
  await wait(1500);
  await go("#am-hud-top >> text=Sincronizar >> nth=-1");
  await wait(2600);
  await hlOff();

  // ── 3. Indicadores ─────────────────────────────────────────────────────
  await cap("3", "Os indicadores resumem o catálogo e também são <u>filtros</u>: clique para filtrar, clique de novo para limpar. Eles podem ser combinados.");
  await hl("#am-resumo", 4);
  await wait(2200);
  await hlOff();
  await click('.am-kpi[data-kpi="pausados"]');
  await wait(600);
  await scrollToEl("#am-catalogo-titulo", 320);
  await wait(2300);
  await click('.am-kpi[data-kpi="pausados"]');
  await wait(800);
  await click('.am-kpi[data-kpi="score_baixo"]');
  await wait(2600);
  await click('.am-kpi[data-kpi="score_baixo"]');
  await wait(800);

  // ── 4. Busca ───────────────────────────────────────────────────────────
  await cap("4", "Busque por título, código MLB ou SKU.");
  await click("#am-busca");
  await page.locator("#am-busca").pressSequentially("térmica", { delay: 110 });
  await wait(2800);
  await page.locator("#am-busca").fill("");
  await page.locator("#am-busca").dispatchEvent("input");
  await wait(1200);

  // ── 5. Ordenação ───────────────────────────────────────────────────────
  await cap("5", "Ordene por margem, % de faturamento, unidades vendidas ou Curva ABC. A seta ao lado inverte a direção.");
  await click("#am-ordenacao-trigger");
  await wait(1600);
  await click("#am-ordenacao-menu >> text=Margem");
  await wait(2200);
  await click("#am-ordenacao-dir");
  await wait(2200);
  await click("#am-ordenacao-trigger");
  await wait(700);
  await click("#am-ordenacao-menu >> text=Padrão");
  await wait(1000);

  // ── 6. Colunas ─────────────────────────────────────────────────────────
  await scrollToEl(".am-listagem__head", 110);
  await cap("6", "Cada linha mostra status, preço, estoque, vendas, % do faturamento com Curva ABC, métricas dos últimos 7 dias, margem e o Score VenForce.");
  await hl(".am-listagem__head", 2);
  await wait(2500);
  const garrafa = '.am-row[data-item="MLB3456789012"]';
  await hl(garrafa + " .am-faturamento", 6); await go(garrafa + " .am-faturamento"); await wait(1700);
  await hl(garrafa + " .am-metricas7d", 6); await go(garrafa + " .am-metricas7d"); await wait(1700);
  await hl(garrafa + " .am-margem", 6); await go(garrafa + " .am-margem"); await wait(1700);
  await hl(garrafa + " .am-gauge", 6); await go(garrafa + " .am-gauge"); await wait(1700);
  await hlOff();

  // ── 7. Famílias ────────────────────────────────────────────────────────
  await cap("7", "Anúncios agrupados pelo Mercado Livre (família) aparecem numa linha só. Clique para ver cada variação.");
  await click(".am-row--grupo .am-row__titulo");
  await wait(3200);
  await click(".am-row--grupo .am-row__titulo");
  await wait(1000);

  // ── 8. Custo pontual ───────────────────────────────────────────────────
  const faq = '.am-row[data-item="MLB3456789014"]';
  await scrollToEl(faq, 380);
  await cap("8", "Anúncio sem custo? Clique em <u>+ Custo</u> na coluna Margem, digite o valor e tecle Enter: ele é gravado na Base de custos.");
  await hl(faq, 2);
  await wait(1500);
  await hlOff();
  await click(faq + " >> text=+ Custo");
  await page.locator(`[data-custo-inline="MLB3456789014"]`).pressSequentially("62,50", { delay: 140 });
  await wait(900);
  await page.keyboard.press("Enter");
  await wait(2600);

  // ── 9. Custos em massa ─────────────────────────────────────────────────
  await scrollToEl("#am-catalogo-titulo", 120);
  await cap("9", "<u>Editar custos</u> abre a edição em massa na própria lista. A seta ao lado permite importar uma planilha de custos.");
  await click('[data-custos-acao="menu"]');
  await wait(2600);
  await page.keyboard.press("Escape");
  await click(".am-custos-split__main");
  await wait(1200);
  await hl("#am-custos-barra", 4);
  await wait(2200);
  await hlOff();
  const inp = page.locator('[data-custo-massa="MLB3456789012"]');
  if (await inp.count()) { await click(inp); await inp.fill(""); await inp.pressSequentially("34,90", { delay: 130 }); await wait(1600); }
  await cap("9", "Altere quantos custos quiser e clique em <u>Salvar</u> na barra inferior — nada é gravado antes disso.");
  await wait(2600);
  console.log("custos btns", await page.evaluate(() => [...document.querySelectorAll("[data-custos-acao]")].filter(b => b.offsetParent).map(b => b.getAttribute("data-custos-acao") + "|" + b.textContent.trim()).join(" ; ")));
  for (const a of ["descartar", "sair", "descartar-continuar"]) {
    const l = page.locator(`[data-custos-acao="${a}"]:visible`);
    if (await l.count()) { await click(l.first()); await wait(900); }
  }
  await wait(800);

  // ── 10. Radar de subsídios ─────────────────────────────────────────────
  await cap("10", "O <u>Radar de subsídios</u> procura promoções do Mercado Livre com rebate que aumentam sua margem ou lucro.");
  await click("#am-reb-abrir");
  await wait(1800);
  await cap("10", "Antes de iniciar, selecione a <u>promoção de referência</u>: somente os anúncios que participam dela serão analisados.");
  await hl("#am-reb-ref", 8);
  await go("#am-reb-ref");
  await wait(2200);
  await page.selectOption("#am-reb-ref", "C-SET");
  await wait(1600);
  await page.selectOption("#am-reb-ref", "C-OUT");
  await wait(2200);
  await hlOff();
  await cap("10", "Com a referência escolhida, clique em <u>Analisar</u>. O Radar compara cada anúncio dela com as promoções com rebate disponíveis.");
  await go('[data-reb-acao="analisar"]');
  await wait(1800);
  await click('[data-reb-acao="analisar"]');
  await wait(4600);
  await cap("10", "Recomendados já vêm marcados. Confira preço, rebate, ganho de margem e lucro por unidade e clique em <u>Participar</u>.");
  await hl(".am-reb-aba.is-active", 4).catch(() => {});
  await wait(1400);
  await hlOff();
  await go("#am-reb-chk-0");
  await wait(1600);
  await click("#am-reb-aba-escolha");
  await wait(2500);
  await click("#am-reb-aba-recomendado");
  await wait(1200);
  await go("#am-reb-participar");
  await wait(1800);
  await click("#am-reb-x");
  await wait(1200);
  if (await page.locator('[data-reb-acao="fechar-mesmo"]:visible').count()) await click('[data-reb-acao="fechar-mesmo"]:visible');
  await wait(600);

  // ── 11. Detalhe do anúncio ─────────────────────────────────────────────
  await scrollToEl(garrafa, 300);
  await cap("11", "Clique no anúncio para abrir o detalhe completo.");
  await click(garrafa + " .am-row__titulo");
  await wait(2200);
  await cap("11", "No topo: dados comerciais e o Score VenForce, com o checklist do que falta para melhorar o anúncio.");
  await hl(".am-det-modal .am-det-score, .am-det-modal [class*=qualidade], .am-det-modal [class*=score]", 6).catch(() => {});
  await wait(3500);
  await hlOff();
  await cap("11", "Fotos do anúncio — dá para reordenar, trocar e adicionar imagens direto por aqui.");
  await scrollToEl(".am-det-modal .am-det-section", 90, ".am-det-scroll");
  await wait(2800);
  await cap("12", "Composição da margem: veja preço, custo, comissão, frete e imposto. Clique numa promoção para simular o resultado antes de participar.");
  await scrollToEl("#am-det-margem", 90, ".am-det-scroll");
  await wait(2500);
  await click('[data-acao="promo-selecionar"] >> nth=1');
  await wait(1400);
  await hl("#am-det-margem", 4);
  await wait(3200);
  await hlOff();
  await go("text=Participar por >> nth=0").catch(() => {});
  await wait(1400);
  await go("text=Descartar simulação >> nth=0").catch(() => {});
  await click("text=Descartar simulação >> nth=0").catch(() => {});
  await wait(800);
  await cap("13", "Otimização com IA: gere sugestões de título, descrição e ficha técnica a partir dos dados reais do produto.");
  await scrollToEl('[data-acao="gerar-titulos"]', 260, ".am-det-scroll");
  await click('[data-acao="gerar-titulos"]');
  await wait(3800);
  await hl('[data-acao="gerar-titulos"]', 4).catch(() => {});
  await hlOff();
  await go(".am-det-modal >> text=Usar >> nth=0").catch(() => {});
  await wait(2200);
  await scrollToEl('[data-acao="gerar-descricao"]', 200, ".am-det-scroll");
  await go('[data-acao="gerar-descricao"]');
  await wait(2000);
  await scrollToEl('[data-acao="gerar"]', 300, ".am-det-scroll");
  await go('[data-acao="gerar"]');
  await wait(2200);
  await cap("14", "Depois de revisar, marque o anúncio como <u>revisado</u> e feche o detalhe.");
  await scrollTo(0, ".am-det-scroll");
  await click('[data-acao="revisar"]');
  await wait(1800);
  await click('.am-det-modal [data-acao="fechar"]');
  await wait(1200);
  await capOff();
  await scrollTo(0);

  // ── Fechamento ─────────────────────────────────────────────────────────
  await card('<div class="k">Resumo</div><div class="t">Anúncios ML</div><ul>' +
    '<li>Escolha cliente e operação</li><li>Sincronize o catálogo</li><li>Filtre pelos indicadores</li><li>Busque e ordene</li>' +
    '<li>Acompanhe margem e Score</li><li>Edite custos (um ou em massa)</li><li>Radar de subsídios</li><li>Detalhe, promoções e IA</li></ul>', 5500);

  const fim = (Date.now() - t0) / 1000;
  const video = page.video();
  await ctx.close();
  const p = await video.path();
  fs.writeFileSync(path.join(OUT, "timing.json"), JSON.stringify({ inicio, fim, video: p }));
  console.log("video", p, "inicio", inicio, "fim", fim, "duração", fim - inicio);
  await browser.close(); srv.close();
  // MP4 1080p, cortando o carregamento inicial da página.
  require("child_process").execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-ss", String(inicio), "-i", p,
    "-vf", "scale=1920:1080:flags=lanczos,fps=30,fade=t=in:st=0:d=0.6", "-c:v", "libx264", "-preset", "slow", "-crf", "22",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart", path.join(OUT, "tutorial-anuncios-ml.mp4")], { stdio: "inherit" });
  console.log("MP4:", path.join(OUT, "tutorial-anuncios-ml.mp4"));
})();
