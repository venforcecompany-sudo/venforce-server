#!/usr/bin/env node
// server/scripts/central-vendas-retencao.js
// Retenção controlada da Central de Vendas. Padrão: DRY-RUN (só SELECT, numa
// transação READ ONLY). Ver docs/central-vendas/RETENCAO.md.
//
//   DATABASE_URL=... node server/scripts/central-vendas-retencao.js [--json] [--conta=<id>|--conta=legado] [--cliente=<slug>]
//       [--min-idade-horas=72] [--manter-ultimos=1] [--sem-legacy] [--sem-candidates] [--sem-mp]
//       [--ignorar-auditoria-sync-jobs] [--sem-estimativa]
//       [--apply --confirm-host=<host>] [--limite-lotes=N] [--tamanho-lote=20] [--limite-minutos=15] [--export-dir=<dir>]
//
// NÃO carrega server/.env: o banco é só o DATABASE_URL do shell. O host é
// impresso antes de qualquer query. APLICAR exige --apply E
// CENTRAL_VENDAS_RETENCAO_APPLY=true E (host local OU --confirm-host=<host>).
// SIGINT (Ctrl+C) termina depois do lote corrente; um 2º Ctrl+C sai na hora
// (a transação do lote em voo é desfeita pelo servidor).

const { Pool } = require("pg");
const { protegerConexoesDoPool } = require("../config/databaseConexao");
const { executarRetencao, verificarPermissaoApply, hostDaUrl, LOCAL_HOSTS } = require("../services/centralVendas/retencao/centralVendasRetencaoExecutor");

function lerArgs(argv) {
  const args = {};
  for (const a of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (m) args[m[1]] = m[2] === undefined ? true : m[2];
  }
  return args;
}

function fmtBytes(n) {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}

function escopoDosArgs(args) {
  const escopo = {};
  if (args.cliente) escopo.clienteSlug = String(args.cliente).trim().toLowerCase();
  if (args.conta !== undefined) {
    if (args.conta === "legado") escopo.contaId = null;
    else if (/^\d+$/.test(String(args.conta))) escopo.contaId = Number(args.conta);
    else throw new Error(`--conta inválido: ${args.conta} (use um id numérico ou "legado")`);
  }
  return escopo;
}

function cfgDosArgs(args) {
  const cfg = {};
  if (args["min-idade-horas"] !== undefined) cfg.minIdadeHoras = Number(args["min-idade-horas"]);
  if (args["manter-ultimos"] !== undefined) cfg.manterUltimosSubstituidos = Number(args["manter-ultimos"]);
  if (args["sem-legacy"]) cfg.incluirLegacy = false;
  if (args["sem-candidates"]) cfg.incluirCandidates = false;
  if (args["sem-mp"]) cfg.incluirMpPayments = false;
  for (const [k, v] of Object.entries(cfg)) {
    if (typeof v === "number" && !(Number.isFinite(v) && v >= 0)) throw new Error(`valor inválido para ${k}`);
  }
  return cfg;
}

// Ids que só são essenciais por estarem citados na auditoria do job do
// Cliente 360 (payload nunca lido por ninguém) — mostra o custo dessa
// proteção conservadora.
function protegidosSoPorAuditoria(plano) {
  return Object.entries(plano.motivos)
    .filter(([, m]) => m.classe === "essencial")
    .filter(([, m]) => {
      const essenciais = m.motivos.filter((x) => ["selecionavel", "margem_rollback", "recente", "run_ativo"].includes(x) || x.startsWith("referenciado:"));
      return essenciais.length && essenciais.every((x) => x === "referenciado:cliente360_sync_job");
    })
    .map(([id]) => Number(id));
}

function imprimirRelatorio(r) {
  const p = r.plano;
  console.log(`\nPolítica: ${JSON.stringify(p.politica)}`);
  console.log(`Fontes de referência: ${p.fontesRefs.map((f) => `${f.fonte}=${f.lida ? f.idsCitados : f.motivo}`).join(" · ")}`);
  console.log(`\nImports por classe: essencial=${p.essencial.length} substituído=${p.substituido.length} resíduo=${p.residuo.length} retido=${p.retido.length}`);
  const soAud = protegidosSoPorAuditoria(p);
  if (soAud.length) console.log(`  (${soAud.length} essenciais SÓ por citação em cliente_360_sync_jobs — ver --ignorar-auditoria-sync-jobs)`);
  console.log(`mp_payments: runs elegíveis=${p.mp.elegiveis.length} retidos=${p.mp.retidos.length}`);
  const comElegiveis = p.tuplas.filter((t) => t.substituido + t.residuo > 0);
  if (comElegiveis.length) {
    console.log("\nTuplas com elegíveis (slug|marketplace|competência|conta):");
    console.table(comElegiveis.map((t) => ({ tupla: t.chave, total: t.total, essencial: t.essencial, substituido: t.substituido, residuo: t.residuo, retido: t.retido })));
  }
  if (p.espaco) {
    console.log("Espaço estimado por classe:");
    console.table(Object.fromEntries(Object.entries(p.espaco.porClasse).map(([k, v]) => [k, { ...v.linhas, bytes: fmtBytes(v.bytesEstimados) }])));
    console.log("Por conta/competência:");
    console.table(Object.fromEntries(Object.entries(p.espaco.porContaCompetencia).map(([k, v]) => [k, { imports: v.imports, ...v.linhas, bytes: fmtBytes(v.bytesEstimados) }])));
    console.log(`Total estimado: ${fmtBytes(p.espaco.totalBytesEstimados)} — ${p.espaco.observacao}`);
  }
  if (r.modo === "apply") {
    console.log(`\nAPLICADO: imports removidos=${r.totais.importsRemovidos} mp runs limpos=${r.totais.mpRunsLimpos} linhas=${JSON.stringify(r.totais.linhas)}`);
    console.log(`Lotes: ${r.lotes.length} · parada: ${r.motivoParada}${r.interrompido ? " (interrompido)" : ""}`);
    if (r.erro) console.log(`ERRO: ${JSON.stringify(r.erro)}`);
  } else {
    console.log("\nDRY-RUN: nada foi alterado.");
  }
}

async function main() {
  const args = lerArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL não definido no shell (o .env NÃO é lido por este script).");
    process.exit(2);
  }
  const host = hostDaUrl(process.env.DATABASE_URL);
  console.error(`[central-vendas-retencao] banco: host=${host}`);
  let escopo;
  let cfg;
  try {
    escopo = escopoDosArgs(args);
    cfg = cfgDosArgs(args);
  } catch (err) {
    console.error(`[central-vendas-retencao] ${err.message}`);
    process.exit(2);
  }
  const apply = args.apply === true;
  if (apply) {
    const permissao = verificarPermissaoApply({ apply, env: process.env, host, confirmHost: args["confirm-host"] || null });
    if (!permissao.permitido) {
      console.error(`[central-vendas-retencao] APLICAR recusado: ${permissao.motivo}. Exige --apply, CENTRAL_VENDAS_RETENCAO_APPLY=true e, fora de localhost, --confirm-host=${host}`);
      process.exit(3);
    }
  }

  const pool = protegerConexoesDoPool(new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: LOCAL_HOSTS.has(host) ? false : { rejectUnauthorized: false },
    max: 2,
  }), { logger: console });
  const sinal = { interrompido: false };
  process.on("SIGINT", () => {
    if (sinal.interrompido) { console.error("\n[central-vendas-retencao] 2º SIGINT — saindo agora."); process.exit(130); }
    sinal.interrompido = true;
    console.error("\n[central-vendas-retencao] SIGINT — termina depois do lote corrente (Ctrl+C de novo para sair já).");
  });

  const logger = args.json ? { log: (...a) => console.error(...a), error: (...a) => console.error(...a) } : console;
  try {
    const resultado = await executarRetencao({
      pool,
      escopo,
      cfg,
      apply,
      host,
      confirmHost: args["confirm-host"] || null,
      env: process.env,
      incluirAuditoriaSyncJobs: !args["ignorar-auditoria-sync-jobs"],
      tamanhoLote: args["tamanho-lote"] ? Number(args["tamanho-lote"]) : 20,
      limiteLotes: args["limite-lotes"] ? Number(args["limite-lotes"]) : Infinity,
      limiteTempoMs: (args["limite-minutos"] ? Number(args["limite-minutos"]) : 15) * 60 * 1000,
      exportDir: args["export-dir"] || null,
      comEstimativa: !args["sem-estimativa"],
      sinal,
      logger,
    });
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ host, ...resultado, protegidosSoPorAuditoria: protegidosSoPorAuditoria(resultado.plano) }, null, 2)}\n`);
    } else {
      imprimirRelatorio(resultado);
    }
    if (resultado.erro) process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`[central-vendas-retencao] falhou: ${err.code || ""} ${err.message}`);
  process.exit(1);
});
