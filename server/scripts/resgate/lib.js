// server/scripts/resgate/lib.js — infraestrutura comum das CLIs do Resgate.
// Conexão PostgreSQL SOMENTE LEITURA: toda sessão abre com
// default_transaction_read_only=on e statement_timeout; a CLI confere isso
// antes de qualquer consulta e aborta se o banco aceitar escrita.
const { Pool } = require("pg");

function args(argv = process.argv.slice(2)) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) { const k = a.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true; o[k] = v; } else o._.push(a);
  }
  return o;
}

// Força leitura também no pool do servidor (mlTokenService usa config/database):
// node-postgres lê PGOPTIONS do ambiente.
function forcarSomenteLeituraNoAmbiente(timeoutMs = 15000) {
  const extra = `-c default_transaction_read_only=on -c statement_timeout=${timeoutMs}`;
  if (!String(process.env.PGOPTIONS || "").includes("default_transaction_read_only=on")) process.env.PGOPTIONS = `${process.env.PGOPTIONS || ""} ${extra}`.trim();
}

async function abrirBancoSomenteLeitura({ url = process.env.DATABASE_URL, max = 2, ssl = process.env.RESGATE_PG_SSL !== "off" } = {}) {
  if (!url) throw new Error("DATABASE_URL ausente.");
  forcarSomenteLeituraNoAmbiente();
  const pool = new Pool({ connectionString: url, ssl: ssl ? { rejectUnauthorized: false } : false, max, application_name: "venforce-resgate-auditoria" });
  const { rows } = await pool.query("SHOW default_transaction_read_only");
  if (!rows[0] || rows[0].default_transaction_read_only !== "on") { await pool.end(); throw new Error("Sessão não está em modo somente leitura: abortado."); }
  return pool;
}

forcarSomenteLeituraNoAmbiente();

module.exports = { args, abrirBancoSomenteLeitura, forcarSomenteLeituraNoAmbiente };
