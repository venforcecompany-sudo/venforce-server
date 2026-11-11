// server/tests/raioXVisual.test.js
//
// Raio-X VISUAL (sem banco): catálogo de motores, provedor sintético, servidor
// HTTP local (somente leitura, só 127.0.0.1) e recusas do modo real.

process.env.DATABASE_URL = "postgres://nobody@127.0.0.1:1/teste-sem-banco";

const assert = require("assert");
const http = require("http");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

let checks = 0;
const ok = (l, c) => { assert.ok(c, `FALHOU: ${l}`); checks += 1; };
const eq = (l, a, b) => { assert.deepStrictEqual(a, b, `FALHOU: ${l} — recebido ${JSON.stringify(a)}`); checks += 1; };

const { catalogo, MOTORES, TABELAS } = require("../services/raioX/raioXMotores");
const sint = require("../services/raioX/raioXSintetico").criar();
const { REGISTRO } = require("../services/raioX/raioXRegistro");

function get(porta, caminho, headers = {}, metodo = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: porta, path: caminho, method: metodo, headers }, (res) => {
      let b = ""; res.on("data", (d) => { b += d; }); res.on("end", () => resolve({ status: res.statusCode, corpo: b, headers: res.headers }));
    });
    req.on("error", reject); req.end();
  });
}

async function run() {
  // ---- catálogo de motores
  const cat = catalogo();
  const nomes = new Set(MOTORES.map((m) => m.id));
  for (const id of ["central_vendas", "sentinel", "margem", "promocoes", "painel_contas", "cliente_360", "conciliacao_mp"]) ok(`motor ${id} no catálogo`, nomes.has(id));
  const ev = new Set(["confirmado", "inferido", "nao_mapeado"]);
  ok("toda ligação tem evidência válida", MOTORES.every((m) => [...m.consome, ...m.produz, ...m.gatilhos].every((x) => ev.has(x.evidencia))));
  const externos = (x) => x.tipo === "fonte_externa" || /^(POST |GET )|[ (]/.test(x.ref);
  const faltando = MOTORES.flatMap((m) => [...m.consome, ...m.produz].filter((x) => !externos(x) && !TABELAS.has(x.ref)).map((x) => `${m.id}:${x.ref}`));
  eq("toda tabela citada por um motor existe no inventário (registro ou extras)", faltando, []);
  ok("todas as tabelas do registro estão no catálogo", REGISTRO.every((r) => TABELAS.has(r.tabela)));
  const t = (n) => cat.tabelas.find((x) => x.tabela === n);
  ok("custos é compartilhada (Central, Margem, Sentinel, Anúncios)", t("custos").compartilhada && ["central_vendas", "margem", "sentinel", "anuncios_ml"].every((m) => t("custos").leitores.some((l) => l.motor === m)));
  ok("tabela manual traz restrição 'manual'", t("painel_contas_lancamentos_manuais").restricoes.some((r) => r.tipo === "manual"));
  ok("tabela lida por outro motor traz restrição 'consumidores'", t("central_vendas_imports").restricoes.some((r) => r.tipo === "consumidores" && r.motores.includes("painel_contas")));
  ok("legado duplicado é apontado (margem)", cat.duplicacoes.some((d) => d.id === "margem_legado" && d.evidencia === "confirmado"));
  ok("duplicação não verificada é marcada como não mapeada", cat.duplicacoes.some((d) => d.id === "pedido_dois_motores" && d.evidencia === "nao_mapeado"));
  ok("resumo conta confirmadas/inferidas/não mapeadas", cat.resumo.confirmadas > 50 && cat.resumo.inferidas >= 1 && cat.resumo.naoMapeados >= 5);
  ok("o motor Sentinel declara o que NÃO está mapeado", MOTORES.find((m) => m.id === "sentinel").naoMapeado.length >= 1);

  // ---- provedor sintético
  const v = await sint.visaoGeral();
  ok("visão geral sintética tem domínios e tabelas não mapeadas", v.porDominio.length > 5 && v.resumo.naoMapeadas === 4);
  const cs = await sint.listarClientes();
  ok("3 clientes sintéticos, todos rotulados", cs.length === 3 && cs.every((c) => /sint[ée]tico/i.test(c.nome)));
  const todos = await sint.raioXDoCliente({ clienteId: 2 });
  eq("cliente 2 tem vínculos de reuso", todos.vinculos.imports.map((i) => i.papel).sort(), ["ambos", "fornece", "referencia"]);
  const porConta = await sint.raioXDoCliente({ clienteId: 3, contaId: 9 });
  eq("filtro por conta restringe a Central à conta", [...new Set(porConta.centralVendas.porContaCompetencia.map((p) => p.clienteContaId))], [9]);
  const cvm = porConta.motores.find((m) => m.id === "central_vendas");
  ok("qualidade aponta falha de sync (atenção)", cvm.qualidade.nivel === "atencao" && cvm.qualidade.motivos.some((x) => /failed/.test(x)));
  ok("motores trazem última atualização e tamanho estimado", todos.motores.every((m) => "ultimaAtualizacao" in m && "bytesEstimados" in m));
  eq("conta de outro cliente é recusada", (await sint.raioXDoCliente({ clienteId: 1, contaId: 9 })).codigo, "CONTA_NAO_PERTENCE_AO_CLIENTE");
  ok("oportunidades do cliente com reuso incluem o bloqueio de retenção", todos.oportunidades.some((o) => o.id === "imports_vinculados" && /PROIBIDA/.test(o.bloqueio)));
  ok("toda oportunidade informa evidência, risco e bloqueio", todos.oportunidades.every((o) => o.evidencia && o.risco && o.bloqueio));
  ok("tamanho: estimativa identificada nas oportunidades", todos.oportunidades.some((o) => o.tipoGanho === "estimativa"));

  // ---- servidor HTTP (modo sintético)
  const porta = 47000 + Math.floor(Math.random() * 1000);
  const srv = spawn(process.execPath, [path.join(__dirname, "..", "scripts", "raio-x-visual.js"), "--porta", String(porta)], { env: { PATH: process.env.PATH }, stdio: "ignore" });
  try {
    let pronto = false;
    for (let i = 0; i < 50 && !pronto; i++) { try { pronto = (await get(porta, "/api/meta")).status === 200; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    ok("servidor sintético sobe", pronto);
    const meta = JSON.parse((await get(porta, "/api/meta")).corpo);
    eq("modo sintético sem host", [meta.modo, meta.host], ["sintetico", null]);
    const pagina = await get(porta, "/");
    ok("página servida com selo SINTÉTICO e CSP", pagina.status === 200 && /DADOS SINTÉTICOS/.test(pagina.corpo) && /default-src 'self'/.test(pagina.headers["content-security-policy"]));
    for (const p of ["/api/visao-geral", "/api/clientes", "/api/motores", "/api/otimizacao", "/api/cliente?id=1", "/api/cliente?id=3&conta=9"]) eq(`GET ${p} = 200`, (await get(porta, p)).status, 200);
    eq("POST recusado (somente leitura)", (await get(porta, "/api/clientes", {}, "POST")).status, 405);
    eq("DELETE recusado", (await get(porta, "/api/clientes", {}, "DELETE")).status, 405);
    eq("Host não-local recusado (DNS rebinding)", (await get(porta, "/api/meta", { Host: "evil.example" })).status, 403);
    eq("id inválido ⇒ 400", (await get(porta, "/api/cliente?id=1;DROP")).status, 400);
    eq("conta inválida ⇒ 400", (await get(porta, "/api/cliente?id=1&conta=x")).status, 400);
    eq("conta de outro cliente ⇒ erro estruturado, não 500", JSON.parse((await get(porta, "/api/cliente?id=1&conta=9")).corpo).codigo, "CONTA_NAO_PERTENCE_AO_CLIENTE");
    eq("rota desconhecida ⇒ 404", (await get(porta, "/api/xyz")).status, 404);
  } finally { srv.kill(); }

  // ---- recusas do modo real (não conectam)
  const script = path.join(__dirname, "..", "scripts", "raio-x-visual.js");
  const semUrl = spawnSync(process.execPath, [script, "--real"], { env: { PATH: process.env.PATH, DATABASE_URL: "postgres://prod.example/db" }, encoding: "utf8" });
  ok("--real sem RAIO_X_DATABASE_URL recusa (e ignora DATABASE_URL)", semUrl.status === 2 && /RAIO_X_DATABASE_URL/.test(semUrl.stderr));
  const remoto = spawnSync(process.execPath, [script, "--real"], { env: { PATH: process.env.PATH, RAIO_X_DATABASE_URL: "postgres://u:p@banco-remoto.invalid:5432/db" }, encoding: "utf8" });
  ok("--real com host remoto exige --autorizo-host", remoto.status === 2 && /--autorizo-host=banco-remoto\.invalid/.test(remoto.stderr));
  ok("a mensagem de recusa não vaza a senha", !/:p@/.test(remoto.stderr));

  console.log(`raioXVisual.test.js: ${checks} verificacoes OK`);
}
run().catch((e) => { console.error(e); process.exit(1); });
