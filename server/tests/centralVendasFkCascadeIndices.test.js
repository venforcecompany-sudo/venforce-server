// Toda FK com ON DELETE CASCADE do schema da Central precisa de um índice que
// comece pela coluna da FK. Sem ele, cada linha apagada no pai faz um seq scan
// no filho. Foi o que derrubou por statement_timeout o 1º lote da retenção em
// produção (30/10/2026): componentes.item_row_id, 3,4 mi linhas, sem índice.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const sql = fs.readFileSync(path.join(__dirname, "..", "sql", "central_vendas_schema.sql"), "utf8")
  .replace(/--[^\n]*/g, "");

// FKs declaradas na coluna: CREATE TABLE ... ( col TIPO REFERENCES pai(id) ON DELETE CASCADE ... )
// e em ALTER TABLE t ADD COLUMN IF NOT EXISTS col TIPO REFERENCES ... ON DELETE CASCADE.
const fks = [];
for (const m of sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\n\);/g)) {
  for (const c of m[2].matchAll(/^\s*(\w+)\s+[A-Z]+[^,\n]*REFERENCES\s+\w+\s*\(\w+\)\s+ON DELETE CASCADE/gm)) {
    fks.push({ tabela: m[1], coluna: c[1] });
  }
}
for (const m of sql.matchAll(/ALTER TABLE (\w+)\s+ADD COLUMN IF NOT EXISTS (\w+)\s+[^;]*?REFERENCES\s+\w+\s*\(\w+\)\s+ON DELETE CASCADE/g)) {
  fks.push({ tabela: m[1], coluna: m[2] });
}

// Índices: CREATE [UNIQUE] INDEX ... ON tabela (col1, ...) e UNIQUE (col1, ...) dentro da tabela.
const primeiraColuna = new Set();
for (const m of sql.matchAll(/CREATE (?:UNIQUE )?INDEX(?: CONCURRENTLY)? IF NOT EXISTS \w+\s+ON (\w+)\s*(?:USING \w+\s*)?\(\s*(\w+)/g)) {
  primeiraColuna.add(`${m[1]}.${m[2]}`);
}
for (const m of sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\n\);/g)) {
  for (const u of m[2].matchAll(/UNIQUE\s*\(\s*(\w+)/g)) primeiraColuna.add(`${m[1]}.${u[1]}`);
}

assert.ok(fks.length >= 6, `esperava ao menos as 6 FKs CASCADE de imports/pedidos/itens, achei ${fks.length}`);
assert.ok(fks.some((f) => f.tabela === "central_vendas_componentes" && f.coluna === "item_row_id"), "o parser precisa enxergar componentes.item_row_id");
const semIndice = fks.filter((f) => !primeiraColuna.has(`${f.tabela}.${f.coluna}`));
assert.deepStrictEqual(semIndice, [], `FK ON DELETE CASCADE sem índice: ${JSON.stringify(semIndice)}`);

const migration = fs.readFileSync(path.join(__dirname, "..", "sql", "migrations", "20261030_central_vendas_componentes_item_row_idx.sql"), "utf8");
assert.ok(/CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_central_vendas_componentes_item_row\s+ON central_vendas_componentes \(item_row_id\)/.test(migration));

console.log(`centralVendasFkCascadeIndices.test.js: ${fks.length} FKs CASCADE, todas com índice`);
