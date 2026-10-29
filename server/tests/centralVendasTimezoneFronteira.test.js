// server/tests/centralVendasTimezoneFronteira.test.js
//
// VenForce V3 — Pós-Convergência #2 (BLOCO 13 / 19).
//
// AUDITORIA DE TIMEZONE do import/sync da Central de Vendas.
//
// Dívida reportada: `dataPedido` / `order.date_created` / `-03:00 fixo` /
// `DATE` / `toISOString()` poderiam deslocar um pedido de competência ou de
// dia na fronteira do mês (23:30 / 00:30).
//
// CONCLUSÃO DA AUDITORIA (provada aqui):
//   - A DATA do pedido (`data_pedido`) é gravada com `asDate()` =
//     `String(order.date_created).slice(0,10)` — LITERAL da string do ML,
//     nunca `new Date(...).toISOString()`. O dia local do vendedor é
//     preservado exatamente.
//   - A COMPETÊNCIA do pedido no agrupamento do sync é
//     `String(order.date_created).slice(0,7)` — mesma leitura literal;
//     `competenciaCanonica.normalizarCompetencia` (a fonte canônica) também
//     lê a string sem `new Date()`. 23:30 de 31/07 continua em 2026-07;
//     00:30 de 01/08 continua em 2026-08, em qualquer offset.
//
// EDGE FECHADA em 29/10/2026 (ver centralVendasJanelaDataLiteral.test.js): a busca
// ganhou folga de ±3h e o run só mantém pedidos com dia literal no intervalo.
// Texto original da edge, mantido como histórico:
//   A JANELA de busca da Orders API é `${data}T00:00:00.000-03:00` /
//   `...T23:59:59.999-03:00` (offset de Brasília fixo). Para um vendedor em
//   fuso brasileiro diferente (Acre −05:00, Amazonas −04:00), ou se o ML
//   devolver `date_created` num offset != −03:00, um pedido nas ~1–3h da
//   virada do mês pode ficar FORA da janela pedida (não puxado), embora sua
//   competência literal seja o mês certo. Correção sep. (alargar a janela
//   ±1 dia e confiar no agrupamento literal) exige validar a interação com
//   M4/publicação — fora do escopo seguro desta maratona.

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/vf-test";

const assert = require("assert");
const { asDate } = require("../services/centralVendas/centralVendasRepository");
const { normalizarCompetencia } = require("../utils/competenciaCanonica");

let checks = 0;
function eq(label, actual, expected) {
  assert.strictEqual(actual, expected, `FALHOU: ${label} — recebido ${JSON.stringify(actual)}, esperado ${JSON.stringify(expected)}`);
  checks += 1;
  console.log(`  ok  ${label}`);
}

// Réplica EXATA do que centralVendasSyncService faz ao agrupar por competência
// (linha ~1109: `String(order.date_created || "").slice(0, 7)`).
function competenciaDoSync(dateCreated) {
  const comp = String(dateCreated || "").slice(0, 7);
  return /^\d{4}-\d{2}$/.test(comp) ? comp : null;
}

async function run() {
  // ---------- 23:30 do último dia do mês, offset Brasília ----------
  const fimDeJulhoBR = "2026-07-31T23:30:00.000-03:00";
  eq("23:30 31/07 −03:00 → data literal 2026-07-31", asDate(fimDeJulhoBR), "2026-07-31");
  eq("23:30 31/07 −03:00 → competência sync 2026-07", competenciaDoSync(fimDeJulhoBR), "2026-07");
  eq("23:30 31/07 −03:00 → competência canônica 2026-07", normalizarCompetencia(fimDeJulhoBR), "2026-07");

  // ---------- 00:30 do primeiro dia do mês seguinte ----------
  const inicioDeAgostoBR = "2026-08-01T00:30:00.000-03:00";
  eq("00:30 01/08 −03:00 → data literal 2026-08-01", asDate(inicioDeAgostoBR), "2026-08-01");
  eq("00:30 01/08 −03:00 → competência sync 2026-08", competenciaDoSync(inicioDeAgostoBR), "2026-08");
  eq("00:30 01/08 −03:00 → competência canônica 2026-08", normalizarCompetencia(inicioDeAgostoBR), "2026-08");

  // ---------- vendedor em Amazonas (−04:00): o dia LOCAL dele é o que vale ----------
  const fimDeJulhoAM = "2026-07-31T23:30:00.000-04:00";
  eq("23:30 31/07 −04:00 (Amazonas) → data literal 2026-07-31 (não desloca p/ agosto)", asDate(fimDeJulhoAM), "2026-07-31");
  eq("23:30 31/07 −04:00 (Amazonas) → competência 2026-07", normalizarCompetencia(fimDeJulhoAM), "2026-07");

  // ---------- offset +00:00 / Z (se o ML devolvesse assim) ----------
  const zulu = "2026-07-31T23:30:00.000Z";
  eq("23:30 31/07 Z → data literal 2026-07-31", asDate(zulu), "2026-07-31");
  eq("23:30 31/07 Z → competência 2026-07", normalizarCompetencia(zulu), "2026-07");

  // ---------- a leitura NUNCA passa por new Date(): a prova negativa ----------
  // Se asDate fizesse `new Date(x).toISOString().slice(0,10)`, num servidor
  // UTC "2026-07-31T23:30:00-03:00" viraria "2026-08-01". Garantimos que não.
  const viaNewDate = new Date(fimDeJulhoBR).toISOString().slice(0, 10);
  assert.strictEqual(viaNewDate, "2026-08-01", "sanidade: new Date() DESLOCARIA para 2026-08-01");
  assert.notStrictEqual(asDate(fimDeJulhoBR), viaNewDate, "asDate NÃO pode coincidir com o caminho new Date()");
  checks += 1;
  console.log("  ok  asDate diverge de new Date().toISOString() na fronteira (leitura literal confirmada)");

  // ---------- Date real vindo do pg (coluna DATE) continua tratado ----------
  eq("Date do pg (meia-noite) → slice ISO", asDate(new Date("2026-08-10T00:00:00.000Z")), "2026-08-10");

  console.log(`\ncentralVendasTimezoneFronteira.test.js: ${checks} verificações passaram.`);
}

run().catch((err) => { console.error(err); process.exitCode = 1; });
