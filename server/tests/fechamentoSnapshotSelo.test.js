// server/tests/fechamentoSnapshotSelo.test.js
//
// O selo do processamento (services/fechamentoSnapshot/seloProcessamento.js):
// o resultado do motor atravessa res.json → navegador → express.json e volta
// com o MESMO selo; qualquer alteração (número, linha, contexto, arquivo) o
// invalida.

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://127.0.0.1:1/x";
delete process.env.NODE_ENV;
process.env.JWT_SECRET = "segredo-de-teste-com-tamanho-suficiente-123";

const assert = require("assert");
const selo = require("../services/fechamentoSnapshot/seloProcessamento");

let checks = 0;
function ok(label, cond) {
  assert.ok(cond, `FALHOU: ${label}`);
  checks += 1;
  console.log(`  ok  ${label}`);
}

const ida = (v) => JSON.parse(JSON.stringify(v)); // res.json → navegador → express.json

const contexto = { clienteSlug: "zorza", clienteContaId: 121, periodo: "2026-09", marketplace: "shopee" };
const resultado = {
  ok: true,
  summary: { finalResult: 25000.1, calculatedCoveragePercent: 91.2, contributionMarginCalculated: NaN, tacos: null, nested: { b: 1, a: [1, { z: 2, y: undefined }] } },
  detailedRows: Array.from({ length: 120 }, (_, i) => ({ "ID do pedido": `2509${i}`, LC: i % 5 === 0 ? null : i * 1.1, MC: -0, Produto: `P${i}` })),
  unmatchedIds: ["229977001"],
  unmatchedCosts: [{ type: "item_id", value: "229977001", reason: "not_found_direct" }],
  // mapa com chaves numéricas (IDs Shopee): a ordem de enumeração muda no JS
  costConflicts: undefined,
  competencia: { periodoDetectado: "2026-09", divergente: false },
  costsSource: "base",
  costsBase: { id: 9, slug: "b", nome: "zorza shopee 3" },
  excelBase64: "UEsDBBQ...", // fora do selo
  incidente: { codigo: "X" }, // fora do selo
};
resultado.summary.porId = { 30: "c", 10: "a", 20: "b" };

const processamento = selo.selarProcessamento({
  contexto,
  resultado,
  usuarioId: 3,
  ajustes: { ads: 20, venforce: 5, affiliates: 2, fullCost: 0, additionalCosts: 0 },
  arquivos: [selo.manifestoDoArquivo("vendas", { originalname: "Order.all.xlsx", mimetype: "application/x", buffer: Buffer.from("abc") }), null],
  costRowsRaw: [{ sku: "A", custo: 10 }],
  agora: new Date("2026-10-13T17:30:00Z"),
});

console.log("\n▸ forma do bloco");
ok("selo é hex de 64", /^[0-9a-f]{64}$/.test(processamento.selo));
ok("manifesto com sha256 do arquivo (sem binário) e nulos descartados", processamento.arquivos.length === 1 && processamento.arquivos[0].sha256 === selo.sha256(Buffer.from("abc")) && !("buffer" in processamento.arquivos[0]));
ok("impressão dos custos: contagem + hash", processamento.custos.linhas === 1 && /^[0-9a-f]{64}$/.test(processamento.custos.sha256));
ok("impressão dos custos não depende da ordem das linhas (a base é lida sem ORDER BY)",
  selo.impressaoDosCustos([{ a: 1 }, { b: 2 }]).sha256 === selo.impressaoDosCustos([{ b: 2 }, { a: 1 }]).sha256
  && selo.impressaoDosCustos([{ a: 1 }]).sha256 !== selo.impressaoDosCustos([{ a: 2 }]).sha256);
ok("ajustes não numéricos viram null, nunca 0", selo.selarProcessamento({ contexto, resultado, ajustes: { ads: NaN }, arquivos: [], costRowsRaw: [] }).ajustes.ads === null);

console.log("\n▸ ida e volta pelo navegador");
const volta = ida({ ...resultado, processamento });
ok("selo confere depois do JSON round-trip", selo.verificar({ contexto, resultado: volta, processamento: volta.processamento }, volta.processamento.selo));
ok("campos fora do selo (excelBase64, incidente) podem faltar", selo.verificar({ contexto, resultado: { ...volta, excelBase64: undefined, incidente: undefined }, processamento: volta.processamento }, volta.processamento.selo));

console.log("\n▸ qualquer alteração invalida");
const alterar = (fn) => {
  const r = ida(volta);
  fn(r);
  return selo.verificar({ contexto: r.__ctx || contexto, resultado: r, processamento: r.processamento }, r.processamento.selo);
};
ok("número do summary", !alterar((r) => { r.summary.finalResult = 25000.2; }));
ok("uma linha no meio", !alterar((r) => { r.detailedRows[77].LC = 1; }));
ok("linha removida (o snapshot não pode perder linha)", !alterar((r) => { r.detailedRows.pop(); }));
ok("origem dos custos", !alterar((r) => { r.costsSource = "upload"; }));
ok("manifesto do arquivo", !alterar((r) => { r.processamento.arquivos[0].sha256 = "0".repeat(64); }));
ok("data do processamento", !alterar((r) => { r.processamento.processadoEm = "2026-10-14T00:00:00.000Z"; }));
ok("ajuste (ADS)", !alterar((r) => { r.processamento.ajustes.ads = 21; }));
ok("contexto: outro cliente", !selo.verificar({ contexto: { ...contexto, clienteSlug: "outro" }, resultado: volta, processamento: volta.processamento }, volta.processamento.selo));
ok("contexto: outra conta", !selo.verificar({ contexto: { ...contexto, clienteContaId: 122 }, resultado: volta, processamento: volta.processamento }, volta.processamento.selo));
ok("contexto: outra competência", !selo.verificar({ contexto: { ...contexto, periodo: "2026-10" }, resultado: volta, processamento: volta.processamento }, volta.processamento.selo));
ok("selo malformado nunca lança", selo.verificar({ contexto, resultado: volta, processamento: volta.processamento }, "zz") === false && selo.verificar({}, undefined) === false);

console.log("\n▸ chave derivada do JWT_SECRET");
process.env.JWT_SECRET = "outro-segredo-de-teste-com-tamanho-suficiente";
ok("trocar o segredo invalida selos antigos", !selo.verificar({ contexto, resultado: volta, processamento: volta.processamento }, volta.processamento.selo));

console.log("\n▸ JSON canônico");
ok("chaves ordenadas e undefined omitido", selo.json({ b: 1, a: undefined, c: [undefined, NaN] }) === '{"b":1,"c":[null,null]}');
ok("toJSON respeitado (Date)", selo.json({ d: new Date("2026-01-01T00:00:00Z") }) === '{"d":"2026-01-01T00:00:00.000Z"}');

console.log(`\n${checks} verificações OK`);
