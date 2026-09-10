/* Integração frontend isolada. Os únicos dados sintéticos vivem neste teste.
 * Chrome intercepta TODA requisição antes da rede. Nenhum backend/banco inicia.
 * Reaproveita as fixtures e o CDP da regressão existente sem alterar o arquivo.
 * node Portal/squads-config-redesign-ui.test.js [--screenshots=/tmp/sq-review]
 */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { spawn } = require("node:child_process");
const existing = path.join(__dirname, "squads-config-hotfix-ui.test.js");
const harness = new Module(existing, module);
harness.filename = existing; harness.paths = module.paths;
const source = fs.readFileSync(existing, "utf8");
const boundary = source.indexOf("async function run() {");
assert.ok(boundary > 0, "Harness existente precisa expor seu setup antes de run().");
harness._compile(source.slice(0, boundary) + `\nmodule.exports = { Cdp, startServer, waitChrome, waitFor, sleep, rotaApi, estadoInicial, getState: () => STATE_BACKEND, setState: value => STATE_BACKEND = value };`, existing);
const { Cdp, startServer, waitChrome, waitFor, sleep } = harness.exports;
let role = "admin", fail = null, slow = 0, checks = 0, heldRead = null;
const requested = [], writes = [], errors = [];
const out = process.argv.find(a => a.startsWith("--screenshots="))?.split("=")[1];
if (out) fs.mkdirSync(out, { recursive: true });
const fontDir = process.argv.find(a => a.startsWith("--font-dir="))?.split("=")[1];
const fontCss = fontDir ? [400,500,600,700].map(weight => `@font-face{font-family:'Hanken Grotesk';font-style:normal;font-weight:${weight};src:url(data:font/ttf;base64,${fs.readFileSync(path.join(fontDir, `sq-hanken-${weight}.ttf`)).toString("base64")})}`).join("\n") : "";
function reset() {
  const s = harness.exports.estadoInicial();
  s.squads.push({ id: 8, nome: "Squad 8", slug: "squad-8-legado", ativo: true }, { id: 9, nome: "Squad Inativo", slug: "inativo", ativo: false });
  s.membros[1].push({ user_id: 11, user_nome: "Pessoa de Teste", user_email: "pessoa@example.test", funcao: "membro", is_primary: false });
  s.membros[8] = []; s.membros[9] = [];
  s.squadClientLinks[8] = []; s.squadClientLinks[9] = [];
  s.users = [{ id: 12, nome: "Pessoa Disponível", email: "disponivel@example.test", ativo: true }, { id: 13, nome: "Pessoa Inativa", email: "inativa@example.test", ativo: false }];
  harness.exports.setState(s); fail = null; slow = 0;
}
function route(url, method, body) {
  const s = harness.exports.getState();
  if (fail && url === fail.path && method === (fail.method || "GET")) return { status: fail.status || 500, body: { ok: false, erro: "Falha controlada no teste" } };
  if (url === "/me/context") return { status: 200, body: { ok: true, user: { id: role === "admin" ? 1 : 10, nome: "Sessão de teste", role: role === "admin" ? "admin" : "membro" }, squads: [], clientes: [], squadPrincipalId: null } };
  if (url === "/usuarios") return { status: role === "admin" ? 200 : 403, body: { ok: role === "admin", usuarios: s.users } };
  if (role !== "admin" && /^\/squads\/(\d+)\/(membros|clientes)/.test(url)) {
    const sid = Number(url.split("/")[2]);
    if (role === "member" || sid !== 1) return { status: 403, body: { ok: false, erro: "Gestão restrita ao coordenador do Squad" } };
    if (url.endsWith("/funcao") || url.endsWith("/transferir")) return { status: 403, body: { ok: false, erro: "Admin only" } };
  }
  let match = url.match(/^\/squads\/(\d+)\/membros\/(\d+)(?:\/(funcao|principal))?$/);
  if (match && method !== "GET") {
    const sid = Number(match[1]), uid = Number(match[2]), action = match[3];
    const person = (s.membros[sid] || []).find(m => m.user_id === uid);
    if (action === "funcao") person.funcao = body.funcao;
    if (action === "principal") { Object.values(s.membros).flat().filter(m => m.user_id === uid).forEach(m => m.is_primary = false); person.is_primary = true; }
    if (method === "DELETE") s.membros[sid] = s.membros[sid].filter(m => m.user_id !== uid);
    return { status: 200, body: { ok: true } };
  }
  match = url.match(/^\/squads\/(\d+)\/membros$/);
  if (match && method === "POST") {
    const sid = Number(match[1]), user = s.users.find(u => u.id === body.userId);
    s.membros[sid].push({ user_id: body.userId, user_nome: user?.nome || "Pessoa por ID", user_email: user?.email, funcao: body.funcao, is_primary: body.isPrimary });
    return { status: 201, body: { ok: true } };
  }
  match = url.match(/^\/squads\/(\d+)$/);
  if (match && method === "PATCH") { Object.assign(s.squads.find(squad => squad.id === Number(match[1])), body); return { status: 200, body: { ok: true } }; }
  const result = harness.exports.rotaApi(url, method, body);
  if (url === "/squads" && role !== "admin") result.body.squads = result.body.squads.filter(squad => [1,2].includes(squad.id));
  return result;
}
async function run() {
  reset();
  const server = await startServer();
  const port = server.address().port, debugPort = 17500 + Math.floor(Math.random() * 500);
  const profile = fs.mkdtempSync("/tmp/vf-sq-redesign-");
  const chrome = spawn("google-chrome", ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-background-networking", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  let cdp;
  try {
    await waitChrome(debugPort);
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
    cdp = new Cdp(targets.find(t => t.type === "page").webSocketDebuggerUrl); await cdp.open();
    cdp.socket.addEventListener("message", e => { const m = JSON.parse(e.data); if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails); });
    await cdp.send("Runtime.enable"); await cdp.send("Page.enable");
    cdp.onRequestPaused = async ({ requestId, request }) => {
      try {
        const u = new URL(request.url); requested.push(request.url);
        const local = u.origin === `http://127.0.0.1:${port}`;
        if (local) { await cdp.send("Fetch.continueRequest", { requestId }); return; }
        let result = { status: 200, body: "" }, type = "text/plain";
        if (fontCss && u.hostname === "fonts.googleapis.com") { result.body = fontCss; type = "text/css"; }
        if (u.origin === "https://venforce-server.onrender.com") {
          const body = request.postData ? JSON.parse(request.postData) : null;
          if (!["GET", "OPTIONS"].includes(request.method)) writes.push({ path: u.pathname, method: request.method, body });
          if (slow) await sleep(slow);
          result = request.method === "OPTIONS" ? { status: 204, body: "" } : route(u.pathname, request.method, body);
          type = "application/json";
          if (heldRead && u.pathname === "/squads/1/membros" && request.method === "GET") {
            const hold = heldRead; heldRead = null;
            result = JSON.parse(JSON.stringify(result)); hold.started(); await hold.promise;
          }
        }
        // Toute autre origine (y compris fonts) reçoit une réponse locale vide.
        await cdp.send("Fetch.fulfillRequest", { requestId, responseCode: result.status, responseHeaders: [
          { name: "Content-Type", value: type }, { name: "Access-Control-Allow-Origin", value: "*" },
          { name: "Access-Control-Allow-Methods", value: "GET,POST,PATCH,DELETE,OPTIONS" }, { name: "Access-Control-Allow-Headers", value: "Content-Type,Authorization" },
        ], body: Buffer.from(typeof result.body === "string" ? result.body : JSON.stringify(result.body)).toString("base64") });
      } catch (e) { errors.push(String(e)); }
    };
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    const ev = expression => cdp.evaluate(expression);
    const click = selector => ev(`document.querySelector(${JSON.stringify(selector)}).focus(); document.querySelector(${JSON.stringify(selector)}).click()`);
    const val = (id, value, type = "input") => ev(`document.getElementById(${JSON.stringify(id)}).value=${JSON.stringify(value)}; document.getElementById(${JSON.stringify(id)}).dispatchEvent(new Event(${JSON.stringify(type)},{bubbles:true}))`);
    const settled = () => waitFor(cdp, "!STATE.refreshing && !STATE.busy", "estado não estabilizou");
    async function goto() {
      await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/harness-squads.html` });
      await waitFor(cdp, "typeof STATE !== 'undefined' && STATE.squads.length > 0 && !STATE.refreshing", "boot falhou");
      if (role !== "admin") {
        await ev(`localStorage.setItem('vf-user',JSON.stringify({id:10,nome:'Coordenação de teste',role:'membro'}))`);
        await cdp.send("Page.reload"); await waitFor(cdp, "typeof STATE !== 'undefined' && !ADMIN && !STATE.refreshing && STATE.squads.length > 0", "boot coordenador falhou");
      }
    }
    const select = async sid => { await click(`.sq-row[data-id="${sid}"]`); await settled(); };
    const check = async (label, fn) => { await fn(); console.log(`ok ${++checks} - ${label}`); };
    async function shot(name, width = 1440, height = 1000) {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      await ev("window.scrollTo(0,0)"); await ev("document.fonts.ready"); await sleep(180);
      if (fontCss) assert.equal(await ev("Array.from(document.fonts).some(f=>f.family===\"Hanken Grotesk\" && f.status===\"loaded\")"), true, "Hanken não carregou");
      assert.ok(await ev("document.documentElement.scrollWidth <= window.innerWidth"), `overflow em ${width}`);
      if (out) { const img = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }); fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(img.data, "base64")); }
    }
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await goto();
    await check("admin lista todos os Squads e clientes aguardando atribuição", async () => { assert.equal(await ev("document.querySelectorAll('.sq-row').length"),4); assert.match(await ev("$('sq-unassigned').textContent"),/1 cliente aguarda/); });
    await select(1);
    await check("seleção identifica Squad, coordenação, pessoas, clientes e principal", async () => { assert.equal(await ev("$('sq-detail-title').textContent"),"Squad Alfa"); assert.match(await ev("$('sq-detail-coord').textContent"),/Ana/); assert.equal(await ev("document.querySelectorAll('.sq-person').length"),2); assert.equal(await ev("document.querySelectorAll('.sq-primary').length"),1); });
    await shot("desktop-inicial");
    await check("busca global encontra pessoa e cliente sem perder seleção", async () => { await val("sq-search","ana coordenadora"); assert.equal(await ev("document.querySelectorAll('.sq-row').length"),1); await val("sq-search","vinculado"); assert.equal(await ev("document.querySelectorAll('.sq-row').length"),1); await val("sq-search",""); });
    await check("busca local e filtros de função/principal", async () => { await val("sq-people-search","pessoa"); assert.equal(await ev("document.querySelectorAll('.sq-person').length"),1); await val("sq-people-search",""); await val("sq-people-filter","coordenador","change"); assert.equal(await ev("document.querySelectorAll('.sq-person').length"),1); await val("sq-people-filter","primary","change"); assert.equal(await ev("document.querySelectorAll('.sq-person').length"),1); await val("sq-people-filter","all","change"); });
    await check("função muda diretamente e sucesso nomeia pessoa/Squad", async () => { await val("sq-role-11","coordenador","change"); await settled(); assert.equal(harness.exports.getState().membros[1][1].funcao,"coordenador"); assert.match(await ev("$('sq-feedback').textContent"),/Pessoa de Teste.*coordenador.*Squad Alfa/); });
    await check("erro de função restaura valor e mostra motivo", async () => { fail={path:"/squads/1/membros/11/funcao",method:"PATCH"}; await val("sq-role-11","membro","change"); await settled(); assert.equal(await ev("$('sq-role-11').value"),"coordenador"); assert.match(await ev("$('sq-feedback').textContent"),/Falha controlada/); fail=null; });
    await check("principal exige confirmação contextual e usa PATCH existente", async () => { await click('[data-action="principal"][data-uid="11"]'); assert.match(await ev("$('sq-confirm-body').textContent"),/Squad Alfa.*Pessoa de Teste.*outros vínculos/); await click("#sq-confirm-ok"); await settled(); assert.equal(harness.exports.getState().membros[1][1].is_primary,true); });
    await check("adicionar pessoa: busca, ID correto, função e principal", async () => { await click("#sq-btn-add-member"); await waitFor(cdp,"STATE.usuarios !== null"); await val("sq-add-search","disponivel"); assert.equal(await ev("$('sq-add-user').options.length"),2); await val("sq-add-user","12"); await val("sq-add-funcao","membro","change"); await ev("$('sq-add-principal').checked=true"); await click("#sq-add-confirm"); await settled(); assert.ok(harness.exports.getState().membros[1].some(m=>m.user_id===12 && m.is_primary)); });
    await check("remover pessoa: cancelar não escreve; confirmar remove", async () => { const n=writes.length; await click('[data-action="remover"][data-uid="12"]'); assert.match(await ev("$('sq-confirm-body').textContent"),/Pessoa Disponível.*Squad Alfa/); await click("#sq-confirm-cancel"); assert.equal(writes.length,n); await click('[data-action="remover"][data-uid="12"]'); await click("#sq-confirm-ok"); await settled(); assert.ok(!harness.exports.getState().membros[1].some(m=>m.user_id===12)); });
    await check("busca de cliente tem vazio específico", async () => { await val("sq-clients-search","inexistente"); assert.match(await ev("$('sq-clientes-wrap').textContent"),/Nenhum cliente encontrado/); await val("sq-clients-search",""); });
    await check("atribuição exclui vinculados/inativos e confirma identidade", async () => { await select(2); await click("#sq-btn-add-cliente"); assert.deepEqual(await ev("Array.from($('sq-addcliente-select').options).map(o=>o.value)"),["200"]); assert.equal(await ev("$('sq-addcliente-confirm').disabled"),true); await val("sq-addcliente-select","200","change"); assert.match(await ev("$('sq-addcliente-preview').textContent"),/Cliente Novo Sem Squad.*Squad Beta/); await click("#sq-addcliente-confirm"); await settled(); assert.ok(harness.exports.getState().squadClientLinks[2].includes(200)); assert.equal(await ev("$('sq-unassigned').hidden"),true); });
    await select(1);
    await check("transferência sem destino pré-selecionado, exclui origem/inativo", async () => { await click('[data-action="mover"][data-cid="100"]'); assert.equal(await ev("$('sq-move-confirm').disabled"),true); assert.deepEqual(await ev("Array.from($('sq-move-destino').options).map(o=>o.value)"),["","2","8"]); await val("sq-move-destino","2","change"); assert.match(await ev("$('sq-move-preview').textContent"),/Cliente Vinculado.*Origem.*Squad Alfa.*Destino.*Squad Beta/); });
    await shot("transferencia-desktop");
    await check("modal: foco contido, Esc fecha e devolve foco", async () => { await ev("$('sq-move-confirm').focus()"); await cdp.send("Input.dispatchKeyEvent",{type:"keyDown",key:"Tab",code:"Tab",windowsVirtualKeyCode:9}); assert.equal(await ev("document.activeElement.id"),"sq-move-close"); await cdp.send("Input.dispatchKeyEvent",{type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27}); assert.equal(await ev("STATE.modal"),null); assert.equal(await ev("document.activeElement.dataset.cid"),"100"); });
    await check("transferência falha sem fechar; retry confirma uma única escrita", async () => { await click('[data-action="mover"][data-cid="100"]'); await val("sq-move-destino","2","change"); fail={path:"/squads/2/clientes/100/transferir",method:"POST"}; await click("#sq-move-confirm"); await settled(); assert.match(await ev("$('sq-move-danger').textContent"),/Falha controlada/); assert.equal(await ev("STATE.modal"),"move"); fail=null; await click("#sq-move-confirm"); await settled(); assert.ok(harness.exports.getState().squadClientLinks[2].includes(100)); assert.match(await ev("$('sq-feedback').textContent"),/Cliente Vinculado.*Squad Alfa.*Squad Beta/); });
    await select(8);
    await check("Legado é explícito e neutro; estados de equipe/carteira vazias", async () => { assert.equal(await ev("$('sq-legacy-note').hidden"),false); assert.match(await ev("$('sq-membros-wrap').textContent"),/A equipe começa aqui/); assert.match(await ev("$('sq-clientes-wrap').textContent"),/Uma carteira para formar/); });
    await shot("legado-vazio");
    await select(1);
    await check("atualização parcial preserva conteúdo e não finge vazio", async () => { fail={path:"/squads/1/membros"}; await click("#sq-refresh"); await settled(); assert.match(await ev("$('sq-detail-status').textContent"),/Parte dos dados/); assert.equal(await ev("document.querySelectorAll('.sq-person').length"),2); assert.match(await ev("$('sq-detail-coord').textContent"),/indisponível/); fail=null; await click("#sq-refresh"); await settled(); });
    await check("falha de catálogo não classifica clientes como sem Squad", async () => { fail={path:"/squads/2/clientes"}; await click("#sq-refresh"); await settled(); assert.equal(await ev("STATE.catalogsReady"),false); assert.match(await ev("$('sq-unassigned').textContent"),/não foi possível verificar/); fail=null; await click("#sq-refresh"); await settled(); });
    await check("nome e estado: edição inline e desativação confirmada", async () => { await click("#sq-edit"); await val("sq-edit-name","Squad Alfa Editado"); await val("sq-edit-state","false","change"); await click('#sq-edit-form button[type="submit"]'); assert.match(await ev("$('sq-confirm-body').textContent"),/inativo.*acesso operacional/); await click("#sq-confirm-ok"); await settled(); assert.equal(harness.exports.getState().squads[0].ativo,false); });
    reset(); await goto(); await select(1);
    for(const width of [1440,1280,1024,900,768,390]) {
      await check(`layout ${width}px sem overflow e detalhe utilizável`, async()=>{ await shot(`layout-${width}`,width,900); if(width===390){assert.equal(await ev("getComputedStyle(document.querySelector('.sq-master')).display"),"none"); await click("#sq-detail-close"); assert.notEqual(await ev("getComputedStyle(document.querySelector('.sq-master')).display"),"none"); await shot("mobile-lista",390,900); await select(1); assert.ok(await ev("$('sq-detail-title').getBoundingClientRect().top > document.querySelector('.vf-shell__contextbar').getBoundingClientRect().bottom"), "barra não pode encobrir título"); if(out){ const img=await cdp.send("Page.captureScreenshot",{format:"png"});fs.writeFileSync(path.join(out,"mobile-detalhe.png"),Buffer.from(img.data,"base64")); } } });
    }
    await click('[data-action="mover"][data-cid="100"]'); await val("sq-move-destino","2","change"); await shot("transferencia-mobile",390,844); await click("#sq-move-cancel");
    await check("atualização lenta mantém contexto e seleção rápida é estável",async()=>{ slow=70; await click("#sq-refresh"); await select(2); assert.equal(await ev("$('sq-detail-title').textContent"),"Squad Beta"); await settled(); assert.equal(await ev("$('sq-detail-title').textContent"),"Squad Beta"); slow=0; });
    await check("escrita durante refresh espera leitura anterior e relê depois de salvar",async()=>{
      await select(1);
      let releaseRead, startedRead;
      const started = new Promise(resolve=>startedRead=resolve);
      heldRead={promise:new Promise(resolve=>releaseRead=resolve),started:startedRead};
      await click("#sq-refresh"); await started;
      const before=writes.length; await val("sq-role-11","coordenador","change");
      await sleep(80); assert.equal(writes.length,before,"escrita deve esperar leitura anterior");
      releaseRead(); await settled();
      assert.equal(await ev("$('sq-role-11').value"),"coordenador");
      assert.equal(harness.exports.getState().membros[1][1].funcao,"coordenador");
    });
    await check("carteira com 26 clientes: busca encontra o último e identidade longa não transborda",async()=>{
      const s=harness.exports.getState();
      for(let n=0;n<25;n++){ const c={id:500+n,nome:`Cliente de Teste ${n+1} com nome extenso para validação de quebra de linha`,slug:`cliente-teste-${n+1}`,ativo:true};s.allClients.push(c);s.squadClientLinks[1].push(c.id); }
      await click("#sq-refresh");await settled();await select(1);
      assert.equal(await ev("document.querySelectorAll('.sq-table tbody tr').length"),26);
      await val("sq-clients-search","cliente-teste-25");assert.equal(await ev("document.querySelectorAll('.sq-table tbody tr').length"),1);
      await val("sq-clients-search",""); await shot("carteira-26-desktop",1440,1000);
      await ev("$('sq-clients-section').scrollIntoView()");
      if(out){ const img=await cdp.send("Page.captureScreenshot",{format:"png"});fs.writeFileSync(path.join(out,"carteira-26-lista.png"),Buffer.from(img.data,"base64")); }
    });
    await check("função ausente é exposta e filtrável",async()=>{harness.exports.getState().membros[1][1].funcao=null;await click("#sq-refresh");await settled();await val("sq-people-filter","invalid","change");assert.equal(await ev("document.querySelectorAll('.sq-person').length"),1);assert.match(await ev("$('sq-membros-wrap').textContent"),/Função não definida/);await val("sq-people-filter","all","change");});
    await check("falha inicial e retry são distintos de ausência de Squads",async()=>{fail={path:"/squads"};await cdp.send("Page.reload");await waitFor(cdp,"typeof STATE !== 'undefined' && !STATE.refreshing && $('sq-state-error').style.display === 'block'");assert.match(await ev("$('sq-error-message').textContent"),/Falha controlada/);fail=null;await click("#sq-btn-retry");await settled();assert.ok(await ev("STATE.squads.length>0"));});
    await check("lista sem Squads é um estado vazio legítimo",async()=>{harness.exports.getState().squads=[];await click("#sq-refresh");await settled();assert.match(await ev("$('sq-list').textContent"),/Nenhum Squad disponível/);assert.equal(await ev("$('sq-state-error').style.display"),"none");});
    role="coordinator"; reset(); await goto(); await select(1);
    await check("coordenador gerencia próprio Squad e não recebe controles admin",async()=>{ assert.equal(await ev("$('sq-btn-add-member').hidden"),false); assert.equal(await ev("document.querySelectorAll('.sq-funcao-select,[data-action=mover]').length"),0); await click("#sq-edit"); assert.equal(await ev("$('sq-edit-state-wrap').hidden"),true); await click("#sq-edit-cancel"); });
    await check("coordenador inclui pessoa pelo contrato existente sem catálogo global",async()=>{ const n=requested.filter(u=>u.endsWith("/usuarios")).length; await click("#sq-btn-add-member"); assert.equal(await ev("$('sq-add-id-wrap').hidden"),false); await val("sq-add-id","12"); await click("#sq-add-confirm"); await settled(); assert.ok(harness.exports.getState().membros[1].some(m=>m.user_id===12)); assert.equal(requested.filter(u=>u.endsWith("/usuarios")).length,n); });
    await check("outro Squad: resumo somente leitura e 403 explícito",async()=>{ await select(2); assert.equal(await ev("$('sq-btn-add-member').hidden"),true); assert.equal(await ev("$('sq-edit').hidden"),true); assert.match(await ev("$('sq-detail-status').textContent"),/restritas ao coordenador/); });
    role="member"; await goto(); await select(1);
    await check("membro sem permissão não recebe ações de gestão",async()=>{ assert.equal(await ev("$('sq-btn-add-cliente').hidden"),true); assert.equal(await ev("document.querySelectorAll('[data-action=remover]').length"),0); });
    await check("todas as escritas usam somente /squads/* e nenhum erro JS",async()=>{ assert.ok(writes.every(w=>w.path.startsWith("/squads/"))); assert.deepEqual(errors,[]); });
    console.log(`\n✓ ${checks} verificações do redesign; ${writes.length} escritas interceptadas; zero conexão com API real.`);
  } finally { cdp?.close(); chrome.kill("SIGTERM"); server.close(); }
}
run().catch(err=>{console.error(err);process.exitCode=1;});
