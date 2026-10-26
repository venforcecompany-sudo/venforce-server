// Gravador dos vídeos tutoriais do Portal: abre uma página REAL do Portal
// servida localmente, com o backend trocado por dados de demonstração, injeta
// cursor/destaque/legenda e captura quadro a quadro (screencast do Chromium,
// JPEG de alta qualidade) até gerar um MP4 1080p.
//
// Uso: gravar({ nome, caminho, rotear, prontoQuando, role, roteiro })
//   roteiro(api) recebe page e os helpers (go, click, hl, cap, card, …).
"use strict";
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const W = 1600, H = 900;
const OUT = path.join(__dirname, "out");

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

async function gravar({ nome, caminho, rotear, prontoQuando, role, roteiro }) {
  const dir = path.join(OUT, nome);
  fs.mkdirSync(dir, { recursive: true });
  const srv = await require("./server")();
  const port = srv.address().port;
  const browser = await chromium.launch(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY, bypass: "127.0.0.1,localhost" } } : {});
  // deviceScaleFactor 1.2: a página é desenhada em 1920x1080 de verdade
  // (texto nítido), mantendo o layout de 1600x900.
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1.2, ignoreHTTPSErrors: true, locale: "pt-BR" });
  await ctx.addInitScript((role) => {
    localStorage.setItem("vf-token", "demo");
    localStorage.setItem("vf-user", JSON.stringify({ id: 12, nome: "Ana Souza", role }));
  }, role || "user");
  await ctx.addInitScript(OVERLAY);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("ERR", e.message));
  await rotear(page);

  const wait = (ms) => page.waitForTimeout(Math.round(ms * 0.8));
  async function moveTo(x, y, steps) { await page.mouse.move(x, y, { steps: steps || 28 }); }
  async function boxOf(target) {
    const loc = typeof target === "string" ? page.locator(target).first() : target;
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    return loc.boundingBox().catch(() => null);
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
    if (!(await go(target, dx, dy))) return false;
    await page.mouse.down(); await wait(90); await page.mouse.up();
    await wait(400);
    return true;
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
  const quadros = [];
  const capitulos = [];
  async function cap(n, txt) {
    // Instante da legenda no vídeo final (o vídeo começa no 1º quadro capturado).
    if (n && quadros.length && !capitulos.some((c) => c.n === n)) capitulos.push({ n, t: +(Date.now() / 1000 - quadros[0].t).toFixed(1), txt: txt.replace(/<[^>]+>/g, "") });
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
      if (!e) return;
      if (scroller) {
        const s = document.querySelector(scroller);
        s.scrollTo({ top: e.getBoundingClientRect().top - s.getBoundingClientRect().top + s.scrollTop - offset, behavior: "smooth" });
      } else window.scrollTo({ top: e.getBoundingClientRect().top + window.scrollY - offset, behavior: "smooth" });
    }, [sel, offset, scroller || null]);
    await wait(1000);
  }
  async function digitar(target, texto) {
    const loc = typeof target === "string" ? page.locator(target).first() : target;
    await click(loc);
    await loc.fill("");
    await loc.pressSequentially(texto, { delay: 110 });
  }

  await page.goto(`http://127.0.0.1:${port}/${caminho}`);
  await prontoQuando(page);
  await page.evaluate(() => document.fonts.ready);
  await wait(1500);
  await page.mouse.move(800, 450);

  const FRAMES = path.join(dir, "frames");
  fs.rmSync(FRAMES, { recursive: true, force: true });
  fs.mkdirSync(FRAMES, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  cdp.on("Page.screencastFrame", async (f) => {
    const arq = String(quadros.length).padStart(6, "0") + ".jpg";
    fs.writeFileSync(path.join(FRAMES, arq), Buffer.from(f.data, "base64"));
    quadros.push({ nome: arq, t: f.metadata.timestamp });
    await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 95, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });

  await roteiro({ page, wait, go, click, hl, hlOff, cap, capOff, card, scrollTo, scrollToEl, digitar, dir });

  await cdp.send("Page.stopScreencast");
  fs.writeFileSync(path.join(dir, "capitulos.json"), JSON.stringify(capitulos, null, 1));
  const fimTs = Date.now() / 1000;
  await ctx.close();
  await browser.close(); srv.close();

  // Concat do ffmpeg: cada quadro dura até o próximo (o screencast só manda
  // quadro quando a tela muda).
  const linhas = [];
  quadros.forEach((q, i) => {
    const prox = i + 1 < quadros.length ? quadros[i + 1].t : fimTs;
    linhas.push("file '" + path.join(FRAMES, q.nome) + "'", "duration " + Math.max(0.001, prox - q.t).toFixed(4));
  });
  linhas.push("file '" + path.join(FRAMES, quadros[quadros.length - 1].nome) + "'");
  fs.writeFileSync(path.join(dir, "quadros.txt"), linhas.join("\n"));
  const mp4 = path.join(dir, "tutorial-" + nome + ".mp4");
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", path.join(dir, "quadros.txt"),
    "-vf", "scale=1920:1080:flags=lanczos,fps=30,fade=t=in:st=0:d=0.6", "-c:v", "libx264", "-preset", "veryslow", "-crf", "22", "-tune", "stillimage",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4], { stdio: "inherit" });
  console.log("quadros", quadros.length, "duração", (fimTs - quadros[0].t).toFixed(1) + "s");
  console.log("MP4:", mp4);
  return { mp4, capitulos };
}

module.exports = { gravar };
