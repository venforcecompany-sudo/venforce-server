#!/usr/bin/env node
// server/scripts/raio-x-visual.js
//
// Interface administrativa LOCAL do Raio-X do PostgreSQL (somente leitura).
//
//   node server/scripts/raio-x-visual.js                       # dados SINTÉTICOS (sem banco)
//   RAIO_X_DATABASE_URL=postgres://... node server/scripts/raio-x-visual.js --real [--autorizo-host=<host>]
//   opções: --porta 4777
//
// - Escuta SÓ em 127.0.0.1 e recusa Host que não seja local (anti DNS-rebinding).
// - Só GET. Nenhuma rota escreve; o serviço roda em BEGIN READ ONLY.
// - NUNCA lê server/.env nem DATABASE_URL (que apontam para produção nesta máquina):
//   o modo real exige --real E RAIO_X_DATABASE_URL explícita. Host não-local exige
//   também --autorizo-host=<host> (autorização do responsável: é leitura, mas é carga).
// - No modo real as consultas são serializadas e o resultado fica 60 s em cache.

const http = require("http");
const fs = require("fs");
const path = require("path");

function arg(nome, padrao = null) {
  const i = process.argv.indexOf(`--${nome}`);
  if (i >= 0) { const v = process.argv[i + 1]; return v && !v.startsWith("--") ? v : true; }
  const kv = process.argv.find((a) => a.startsWith(`--${nome}=`));
  return kv ? kv.split("=").slice(1).join("=") : padrao;
}

const LOCAIS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const CACHE_MS = 60 * 1000;

function criarProvedor() {
  if (!arg("real")) return { provedor: require("../services/raioX/raioXSintetico").criar(), meta: { modo: "sintetico", host: null } };
  const url = process.env.RAIO_X_DATABASE_URL;
  if (!url) { console.error("[raio-x] --real exige RAIO_X_DATABASE_URL (não usa server/.env nem DATABASE_URL)."); process.exit(2); }
  const { validarUrlRaioX, autorizar, limparEnvPg } = require("../services/raioX/raioXConexao");
  let destino;
  try { destino = validarUrlRaioX(url); } catch (e) { console.error(`[raio-x] URL recusada (${e.codigo || "ERRO"}): ${e.message}`); process.exit(2); }
  const aut = autorizar(destino, arg("autorizo-host"));
  if (!aut.permitido) { console.error(`[raio-x] ${aut.motivo}.`); process.exit(2); }
  const host = destino.host; // destino EFETIVO (o mesmo que o driver usa)
  limparEnvPg(); // PGHOST & cia não podem redirecionar a conexão
  process.env.DATABASE_URL = url; // o pool do app lê no require
  const pool = require("../config/database");
  const svc = require("../services/raioX/raioXVisualService");
  let fila = Promise.resolve();
  const serial = (fn) => { const p = fila.then(fn, fn); fila = p.catch(() => {}); return p; };
  return {
    meta: { modo: "real", host, portaBanco: destino.port, banco: destino.banco },
    fechar: () => pool.end().catch(() => {}),
    provedor: {
      visaoGeral: () => serial(() => svc.visaoGeral(pool)),
      listarClientes: () => serial(() => svc.listarClientes(pool)),
      raioXDoCliente: (p) => serial(() => svc.raioXDoCliente(pool, p)),
    },
  };
}

function main() {
  const porta = Number(arg("porta", 4777));
  const { provedor, meta, fechar } = criarProvedor();
  const { catalogo } = require("../services/raioX/raioXMotores");
  const { oportunidades } = require("../services/raioX/raioXVisualService");
  const html = () => fs.readFileSync(path.join(__dirname, "..", "raioX-ui", "index.html"));
  const cache = new Map();
  const comCache = async (chave, fresco, fn) => {
    const c = cache.get(chave);
    if (!fresco && c && Date.now() - c.em < CACHE_MS) return c.v;
    const v = await fn();
    cache.set(chave, { em: Date.now(), v });
    return v;
  };

  const servidor = http.createServer(async (req, res) => {
    const enviar = (status, corpo, tipo = "application/json; charset=utf-8") => {
      res.writeHead(status, { "Content-Type": tipo, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:" });
      res.end(typeof corpo === "string" || Buffer.isBuffer(corpo) ? corpo : JSON.stringify(corpo));
    };
    try {
      const hostHeader = String(req.headers.host || "").replace(/:\d+$/, "");
      if (!LOCAIS.has(hostHeader)) return enviar(403, { erro: "HOST_NAO_LOCAL" });
      if (req.method !== "GET") return enviar(405, { erro: "SOMENTE_LEITURA" });
      const u = new URL(req.url, `http://${req.headers.host}`);
      const fresco = u.searchParams.get("fresh") === "1";
      if (u.pathname === "/") return enviar(200, html(), "text/html; charset=utf-8");
      if (u.pathname === "/api/meta") return enviar(200, { ...meta, porta, geradoEm: new Date().toISOString() });
      if (u.pathname === "/api/motores") return enviar(200, catalogo());
      if (u.pathname === "/api/visao-geral") return enviar(200, await comCache("visao", fresco, () => provedor.visaoGeral()));
      if (u.pathname === "/api/clientes") return enviar(200, await comCache("clientes", fresco, () => provedor.listarClientes()));
      if (u.pathname === "/api/otimizacao") {
        const visao = await comCache("visao", fresco, () => provedor.visaoGeral());
        return enviar(200, oportunidades({ visao }));
      }
      if (u.pathname === "/api/cliente") {
        const id = u.searchParams.get("id"); const slug = u.searchParams.get("slug"); const conta = u.searchParams.get("conta");
        if (!id && !slug) return enviar(400, { erro: "INFORME_id_OU_slug" });
        if (id && !/^\d+$/.test(id)) return enviar(400, { erro: "ID_INVALIDO" });
        if (conta && !/^\d+$/.test(conta)) return enviar(400, { erro: "CONTA_INVALIDA" });
        const p = { clienteId: id ? Number(id) : null, clienteSlug: slug ? String(slug).toLowerCase() : null, contaId: conta ? Number(conta) : null };
        return enviar(200, await comCache(`c:${id || slug}:${conta || ""}`, fresco, () => provedor.raioXDoCliente(p)));
      }
      return enviar(404, { erro: "NAO_ENCONTRADO" });
    } catch (err) {
      console.error(`[raio-x] erro: ${err.code || ""} ${err.message}`);
      return enviar(500, { erro: "FALHA_NA_LEITURA", codigo: err.code || null });
    }
  });
  servidor.listen(porta, "127.0.0.1", () => {
    console.log(`[raio-x] modo=${meta.modo}${meta.host ? ` host=${meta.host}` : " (dados sintéticos, sem banco)"}`);
    console.log(`[raio-x] abra: http://127.0.0.1:${porta}   (Ctrl+C encerra)`);
  });
  const sair = async () => { servidor.close(); if (fechar) await fechar(); process.exit(0); };
  process.on("SIGINT", sair); process.on("SIGTERM", sair);
  return servidor;
}

if (require.main === module) main();
module.exports = { main };
