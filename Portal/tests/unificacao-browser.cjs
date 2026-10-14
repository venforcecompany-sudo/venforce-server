// Mesmo padrão CDP/Chrome puro dos testes do Shell; sem dependências novas.
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.pending = new Map();
    this.next = 0;
  }
  async open() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", ({ data }) => {
      const msg = JSON.parse(data);
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    });
  }
  send(method, params = {}) {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
  async wait(expression) {
    for (let i = 0; i < 160; i++) {
      if (await this.eval(`Boolean(${expression})`)) return;
      await sleep(40);
    }
    throw new Error(`Timeout: ${expression}`);
  }
  async click(id) {
    await this.eval(`document.getElementById(${JSON.stringify(id)}).click()`);
  }
  async input(id, value, type = "input") {
    await this.eval(
      `{const el=document.getElementById(${JSON.stringify(id)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event(${JSON.stringify(type)},{bubbles:true}));}`,
    );
  }
  async check(id, value = true) {
    await this.eval(
      `{const el=document.getElementById(${JSON.stringify(id)});el.checked=${value};el.dispatchEvent(new Event('change',{bubbles:true}));}`,
    );
  }
  async action(action, index = 0) {
    await this.eval(
      `document.querySelectorAll('[data-action="${action}"]')[${index}].click()`,
    );
  }
  text(id) {
    return this.eval(
      `document.getElementById(${JSON.stringify(id)}).textContent`,
    );
  }
  close() {
    this.socket.close();
  }
}
async function browser() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vf-unificacao-ui-"));
  const process = spawn(
    globalThis.process.env.CHROME_BIN || "google-chrome",
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-background-networking",
      "--no-first-run",
      "--remote-debugging-port=0",
      `--user-data-dir=${dir}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let cdp;
  try {
    let port;
    for (let i = 0; i < 120; i++) {
      try {
        port = Number(
          (
            await fs.readFile(path.join(dir, "DevToolsActivePort"), "utf8")
          ).split("\n")[0],
        );
        break;
      } catch {
        await sleep(50);
      }
    }
    if (!port) throw new Error("Chrome não iniciou");
    const target = await (
      await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
        method: "PUT",
      })
    ).json();
    cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send("Page.enable");
    await cdp.send("Network.enable");
    await cdp.send("Network.setBlockedURLs", {
      urls: ["https://*", "http://venforce-server.onrender.com/*"],
    });
    return {
      cdp,
      close: async () => {
        cdp.close();
        process.kill("SIGTERM");
        await new Promise((r) => {
          if (process.exitCode !== null) r();
          else process.once("exit", r);
        });
        await fs.rm(dir, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        });
      },
    };
  } catch (e) {
    cdp?.close();
    process.kill("SIGTERM");
    await fs.rm(dir, { recursive: true, force: true });
    throw e;
  }
}
module.exports = { browser, sleep };
