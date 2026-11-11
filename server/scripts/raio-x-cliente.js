#!/usr/bin/env node
// server/scripts/raio-x-cliente.js
//
// Gera o Raio-X (read-only) de UM cliente e grava em JSON.
//
//   RAIO_X_DATABASE_URL=postgres://... node server/scripts/raio-x-cliente.js \
//     --cliente <slug|id> [--detalhado] [--timeout-ms 3000] [--orcamento-ms 20000] [--saida arquivo.json]
//
// - NÃO lê server/.env nem DATABASE_URL (que apontam para produção nesta
//   máquina): a URL tem de vir explícita em RAIO_X_DATABASE_URL. O host é
//   impresso antes de conectar.
// - Tudo roda numa transação BEGIN READ ONLY com statement_timeout por consulta.
// - Rodar contra PRODUÇÃO exige autorização explícita do responsável (é leitura,
//   mas é carga no banco); o modo padrão (rápido) não toca as tabelas filhas.

const fs = require("fs");

function arg(nome, padrao = null) {
  const i = process.argv.indexOf(`--${nome}`);
  if (i < 0) return padrao;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

async function main() {
  const url = process.env.RAIO_X_DATABASE_URL;
  const cliente = arg("cliente");
  if (!url || !cliente || cliente === true) {
    console.error("uso: RAIO_X_DATABASE_URL=... node server/scripts/raio-x-cliente.js --cliente <slug|id> [--detalhado]");
    process.exit(2);
  }
  const host = new URL(url).hostname;
  console.error(`[raio-x] host=${host} cliente=${cliente} modo=${arg("detalhado") ? "detalhado" : "rapido"}`);
  // O pool do app lê DATABASE_URL no require: aponta-o para a URL explícita.
  process.env.DATABASE_URL = url;
  const pool = require("../config/database");
  const { gerarRaioXCliente } = require("../services/raioX/raioXClienteService");
  const porId = /^\d+$/.test(String(cliente));
  try {
    const r = await gerarRaioXCliente(
      porId ? { clienteId: Number(cliente) } : { clienteSlug: String(cliente).toLowerCase() },
      {
        db: pool,
        detalhado: !!arg("detalhado"),
        timeoutMs: Number(arg("timeout-ms", 3000)),
        orcamentoMs: Number(arg("orcamento-ms", 20000)),
      }
    );
    const json = JSON.stringify(r, null, 2);
    const saida = arg("saida");
    if (saida && saida !== true) { fs.writeFileSync(saida, json); console.error(`[raio-x] gravado em ${saida}`); }
    else process.stdout.write(`${json}\n`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => { console.error(`[raio-x] falhou: ${err.code || ""} ${err.message}`); process.exit(1); });
