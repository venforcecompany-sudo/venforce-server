#!/usr/bin/env node
// server/scripts/resgate/importarParaPg.js
// Carrega o resultado de uma auditoria da CLI (store de arquivo) nas tabelas
// resgate_* para a API/tela /resgate lerem. ESCREVE no banco indicado — só
// nas tabelas do Resgate (nunca em outra tabela, nunca no Mercado Livre).
// Exige a migration 20261112_venforce_resgate.sql aplicada e --confirmar.
//   DATABASE_URL=… node server/scripts/resgate/importarParaPg.js --dados <dir> --confirmar --contas 86,87 [--sem-ssl]   (ou --todas)
// --contas limita a importação às contas indicadas (V1: só as que serão usadas; menos volume no banco).
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const { args } = require("./lib");

const a = args();
const dir = path.resolve(a.dados || ".");
const soContas = a.contas ? new Set(String(a.contas).split(",").map((x) => Number(x.trim())).filter((n) => n > 0)) : null;
if (!a.confirmar) {
  console.log(`PLANO (nada foi gravado): importar ${dir}${soContas ? ` (só contas ${[...soContas].join(", ")})` : " (todas as contas)"} → resgate_execucoes / resgate_contas_resultado / resgate_itens em lotes de 200.`);
  console.log("Repita com --confirmar. Requer a migration aplicada; falha se já houver execução em andamento.");
  process.exit(0);
}
if (!soContas && !a.todas) {
  // Importar as 88 contas grava ~152 MB (a instância de produção já teve crash-recovery com volume menor).
  console.error("Recusado: com --confirmar, informe --contas (ex.: --contas 86,87) ou --todas explicitamente.");
  process.exit(2);
}
(async () => {
  // O lib força leitura no ambiente; este script é o ÚNICO que grava, e só nas tabelas resgate_*.
  process.env.PGOPTIONS = String(process.env.PGOPTIONS || "").replace(/-c default_transaction_read_only=on/g, "").trim();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: a["sem-ssl"] ? false : { rejectUnauthorized: false }, max: 1, application_name: "venforce-resgate-import" });
  const { criarStorePg } = require("../../services/resgate/resgateStorePg");
  const { criarStoreArquivo } = require("../../services/resgate/resgateStoreArquivo");
  const pg = criarStorePg(pool);
  if (!(await pg.tabelasDisponiveis())) throw new Error("Tabelas do Resgate ausentes: aplique a migration antes.");
  const arq = criarStoreArquivo(dir);
  const exec = JSON.parse(fs.readFileSync(path.join(dir, "execucao.json"), "utf8"));
  const id = await pg.iniciarExecucao({ origem: "importacao_cli", execucaoArquivo: exec.id, iniciadaEmArquivo: exec.iniciadaEm });
  let itens = 0;
  try {
    for (const c of (await arq.listarContas()).filter((x) => !soContas || soContas.has(Number(x.resumo.clienteContaId)))) {
      const contaId = Number(c.resumo.clienteContaId);
      const lista = await arq.lerItens(null, contaId);
      await pg.salvarItens(id, contaId, lista);
      await pg.salvarConta(id, contaId, { resumo: c.resumo, matriz: c.matriz });
      itens += lista.length;
    }
    await pg.finalizarExecucao(id, "concluida", { ...(exec.resumo || {}), importadoDe: exec.id, itens });
    await pg.aplicarRetencao(3);
  } catch (err) {
    await pg.finalizarExecucao(id, "erro", { erro: String(err.message).slice(0, 300) });
    throw err;
  }
  console.log(JSON.stringify({ execucaoId: id, itens }));
  await pool.end();
})().then(() => process.exit(0)).catch((e) => { console.error("ERRO:", e.message); process.exit(1); });
