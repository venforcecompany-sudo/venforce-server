#!/usr/bin/env node
// server/scripts/pg-relatorio-armazenamento.js
//
// Relatório operacional de armazenamento do PostgreSQL (somente leitura).
//
//   PG_METRICAS_DATABASE_URL=postgres://... node server/scripts/pg-relatorio-armazenamento.js \
//     [--capacidade-gb 10] [--dir ~/venforce-backups/pg-metricas] [--timeout-ms 10000]
//
// - NÃO lê server/.env nem DATABASE_URL: a URL vem explícita; o host é impresso.
// - Executa cada bloco de server/sql/observabilidade/pg_armazenamento.sql numa
//   transação BEGIN READ ONLY com statement_timeout (bloco que falha vira
//   { erro } no relatório; os outros continuam).
// - Grava <dir>/AAAA-MM-DDTHHMMZ.json e .md e compara com o relatório
//   anterior do mesmo diretório: crescimento do banco e por tabela, taxa
//   diária e projeção de quando atinge 80/90/95% da capacidade.
// - Feito para rodar 1× por dia (ou sob demanda). Sem polling.

const fs = require("fs");
const os = require("os");
const path = require("path");

const SQL_PATH = path.join(__dirname, "..", "sql", "observabilidade", "pg_armazenamento.sql");
const LIMIARES = [0.8, 0.9, 0.95];

function arg(nome, padrao = null) {
  const i = process.argv.indexOf(`--${nome}`);
  if (i < 0) return padrao;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

function blocosSql(texto) {
  const blocos = [];
  let atual = null;
  for (const linha of texto.split("\n")) {
    const m = linha.match(/^-- @([a-z0-9_]+)\s*$/);
    if (m) { atual = { nome: m[1], sql: [] }; blocos.push(atual); continue; }
    if (atual) atual.sql.push(linha);
  }
  return blocos.map((b) => ({ nome: b.nome, sql: b.sql.join("\n").trim() })).filter((b) => b.sql);
}

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const fmt = (b) => (b == null ? "—" : b >= GB ? `${(b / GB).toFixed(2)} GB` : `${(b / MB).toFixed(1)} MB`);

function comparar(atual, anterior, capacidadeBytes) {
  const total = Number(atual.secoes.banco?.[0]?.bytes_total || 0);
  const out = {
    bytesTotal: total,
    capacidadeBytes,
    ocupacao: capacidadeBytes ? total / capacidadeBytes : null,
    limiares: LIMIARES.map((l) => ({ limiar: l, atingido: capacidadeBytes ? total >= l * capacidadeBytes : null })),
  };
  if (!anterior) return { ...out, comparacao: null };
  const totalAnt = Number(anterior.secoes.banco?.[0]?.bytes_total || 0);
  const dias = (new Date(atual.medidoEm) - new Date(anterior.medidoEm)) / 86400000;
  const crescimento = total - totalAnt;
  const porDia = dias > 0 ? crescimento / dias : null;
  const antPorTabela = new Map((anterior.secoes.tabelas || []).map((t) => [t.tabela, t]));
  const tabelas = (atual.secoes.tabelas || []).map((t) => {
    const a = antPorTabela.get(t.tabela);
    const ins = a ? Number(t.ins_acumulado) - Number(a.ins_acumulado) : null;
    return {
      tabela: t.tabela,
      bytes: Number(t.bytes_total),
      deltaBytes: a ? Number(t.bytes_total) - Number(a.bytes_total) : null,
      // contadores acumulados zeram em stats reset/crash: delta negativo = reset
      insercoesNoIntervalo: ins != null && ins >= 0 ? ins : null,
    };
  }).sort((x, y) => (y.deltaBytes ?? 0) - (x.deltaBytes ?? 0));
  const projecoes = LIMIARES.map((l) => {
    const alvo = l * capacidadeBytes;
    if (!capacidadeBytes || porDia == null) return { limiar: l, dias: null };
    if (total >= alvo) return { limiar: l, dias: 0 };
    return { limiar: l, dias: porDia > 0 ? Math.round((alvo - total) / porDia) : null };
  });
  return {
    ...out,
    comparacao: {
      anteriorEm: anterior.medidoEm, intervaloDias: Math.round(dias * 100) / 100,
      crescimentoBytes: crescimento, crescimentoPorDiaBytes: porDia == null ? null : Math.round(porDia),
      projecoes, tabelas: tabelas.slice(0, 15),
    },
  };
}

function markdown(r) {
  const c = r.analise;
  const L = [];
  L.push(`# Armazenamento PostgreSQL — ${r.medidoEm}`, "");
  L.push(`- Banco: **${fmt(c.bytesTotal)}** de ${fmt(c.capacidadeBytes)} (${c.ocupacao == null ? "—" : (c.ocupacao * 100).toFixed(1) + "%"})`);
  for (const l of c.limiares) L.push(`- ${l.limiar * 100}%: ${l.atingido ? "**ATINGIDO**" : "não atingido"}`);
  if (c.comparacao) {
    const k = c.comparacao;
    L.push(`- Desde ${k.anteriorEm} (${k.intervaloDias} d): ${fmt(k.crescimentoBytes)} — ${fmt(k.crescimentoPorDiaBytes)}/dia`);
    for (const p of k.projecoes) L.push(`  - ${p.limiar * 100}% em ${p.dias == null ? "— (sem crescimento)" : `${p.dias} dia(s)`}`);
    L.push("", "| tabela | tamanho | Δ | inserções no intervalo |", "|---|---:|---:|---:|");
    for (const t of k.tabelas) L.push(`| ${t.tabela} | ${fmt(t.bytes)} | ${fmt(t.deltaBytes)} | ${t.insercoesNoIntervalo ?? "—"} |`);
  } else {
    L.push("- Primeiro relatório do diretório: sem comparação (rode de novo amanhã).");
  }
  L.push("", "## Maiores tabelas", "", "| tabela | total | heap | toast | índices | vivas | mortas |", "|---|---:|---:|---:|---:|---:|---:|");
  for (const t of (r.secoes.tabelas || []).slice(0, 20)) {
    L.push(`| ${t.tabela} | ${fmt(+t.bytes_total)} | ${fmt(+t.bytes_heap)} | ${fmt(+t.bytes_toast)} | ${fmt(+t.bytes_indices)} | ${t.linhas_vivas ?? "—"} | ${t.linhas_mortas ?? "—"} |`);
  }
  const sup = r.secoes.central_copias_superadas?.[0];
  if (sup) L.push("", `## Central de Vendas`, "", `- Imports superados (aprox.): ${sup.imports_superados} em ${sup.tuplas} tuplas, ${sup.pedidos_em_copias} pedidos em cópias; manuais protegidos entre eles: ${sup.superados_manuais_protegidos}`);
  const esc = r.secoes.syncs_escrita_24h?.[0];
  if (esc && esc.imports_medidos) L.push(`- Últimas 24 h: ${esc.imports_medidos} imports, ${esc.pedidos_gravados} pedidos gravados (${esc.pedidos_inalterados} inalterados, ${esc.pedidos_alterados} alterados, ${esc.pedidos_novos} novos), ${fmt(+esc.bytes_json_gravados)} de JSON; enxutos: ${esc.imports_enxutos}`);
  const mp = r.secoes.mp_payments_duplicacao?.[0];
  if (mp) L.push(`- MP Payments: ~${mp.linhas_estimadas} linhas para ~${mp.payments_distintos_estimados} payments distintos (estimativa pg_stats)`);
  const erros = Object.entries(r.erros || {});
  if (erros.length) { L.push("", "## Blocos com erro", ""); for (const [n, e] of erros) L.push(`- ${n}: ${e}`); }
  return `${L.join("\n")}\n`;
}

async function coletar(client, { timeoutMs }) {
  const secoes = {};
  const erros = {};
  await client.query("BEGIN READ ONLY");
  try {
    for (const bloco of blocosSql(fs.readFileSync(SQL_PATH, "utf8"))) {
      await client.query("SAVEPOINT b");
      try {
        await client.query(`SET LOCAL statement_timeout = ${Math.max(500, Number(timeoutMs) | 0)}`);
        // eslint-disable-next-line no-await-in-loop
        secoes[bloco.nome] = (await client.query(bloco.sql)).rows;
        await client.query("RELEASE SAVEPOINT b");
      } catch (err) {
        await client.query("ROLLBACK TO SAVEPOINT b");
        erros[bloco.nome] = `${err.code || ""} ${String(err.message || "").slice(0, 160)}`.trim();
      }
    }
  } finally {
    await client.query("ROLLBACK");
  }
  return { secoes, erros };
}

async function main() {
  const url = process.env.PG_METRICAS_DATABASE_URL;
  if (!url) { console.error("uso: PG_METRICAS_DATABASE_URL=... node server/scripts/pg-relatorio-armazenamento.js [--capacidade-gb 10] [--dir DIR]"); process.exit(2); }
  const dir = String(arg("dir", path.join(os.homedir(), "venforce-backups", "pg-metricas")));
  const capacidadeBytes = Number(arg("capacidade-gb", 10)) * GB;
  console.error(`[pg-metricas] host=${new URL(url).hostname} dir=${dir}`);
  const { Client } = require("pg");
  const local = ["127.0.0.1", "localhost"].includes(new URL(url).hostname);
  const client = new Client({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false } });
  await client.connect();
  try {
    const { secoes, erros } = await coletar(client, { timeoutMs: Number(arg("timeout-ms", 10000)) });
    fs.mkdirSync(dir, { recursive: true });
    const anteriores = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}T\d{4}Z\.json$/.test(f)).sort();
    const anterior = anteriores.length ? JSON.parse(fs.readFileSync(path.join(dir, anteriores[anteriores.length - 1]), "utf8")) : null;
    const medidoEm = new Date().toISOString();
    const rel = { versao: "pg-armazenamento/v1", medidoEm, secoes, erros };
    rel.analise = comparar(rel, anterior, capacidadeBytes);
    const base = medidoEm.slice(0, 16).replace(/:/g, "").replace(/-(\d\d)T/, "-$1T") + "Z";
    const nome = `${base.slice(0, 10)}T${base.slice(11, 15)}Z`;
    fs.writeFileSync(path.join(dir, `${nome}.json`), JSON.stringify(rel, null, 2));
    fs.writeFileSync(path.join(dir, `${nome}.md`), markdown(rel));
    console.error(`[pg-metricas] gravado ${path.join(dir, nome)}.{json,md}`);
    process.stdout.write(markdown(rel));
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((err) => { console.error(`[pg-metricas] falhou: ${err.code || ""} ${err.message}`); process.exit(1); });
}

module.exports = { blocosSql, comparar, markdown, coletar };
