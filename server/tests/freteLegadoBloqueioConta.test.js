// server/tests/freteLegadoBloqueioConta.test.js
// P0 10/11/2026 — margem ANTIGA (sem freteQualidade) de conta liberada não aparece como confiável;
// contas fora da flag e linhas já avaliadas não mudam. A flag é lida na carga: cada caso roda em processo filho.
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://nobody@127.0.0.1:1/teste-sem-banco";
const assert = require("assert");
const { execFileSync } = require("child_process");
let checks = 0; const ok = (c, m) => { assert.ok(c, m); checks += 1; };

if (process.argv[2] === "filho") {
  const conf = require("../services/motorMargem/margemConfiavel");
  const fonte = require("../services/motorMargem/anunciosMargemProjetadaFonte");
  const rows = [
    // conta 87, linha antiga (sem freteQualidade), frete aparentemente válido
    { item_id: "MLB_ANTIGA", cliente_conta_id: 87, margin_percent: "45.25", profit: "125.85", status: "HEALTHY", calculated_at: "2026-11-10T16:14:00Z", assumed_json: [], frete_qualidade_tipo: null },
    // conta 87, já recalculada com frete válido
    { item_id: "MLB_AVALIADA", cliente_conta_id: 87, margin_percent: "30", profit: "20", status: "HEALTHY", calculated_at: "2026-11-11T10:00:00Z", assumed_json: [], frete_qualidade_tipo: "object", frete_nivel: "cotado_ml" },
    // conta 87, estimada por dimensões: vale, rotulada
    { item_id: "MLB_ESTIMADA", cliente_conta_id: 87, margin_percent: "22", profit: "15", status: "HEALTHY", calculated_at: "2026-11-11T10:00:00Z", assumed_json: [], frete_qualidade_tipo: "object", frete_nivel: "estimado_dimensoes_historicas" },
    // outra conta, linha antiga: intocada
    { item_id: "MLB_OUTRA", cliente_conta_id: 55, margin_percent: "18", profit: "9", status: "HEALTHY", calculated_at: "2026-11-10T16:14:00Z", assumed_json: [], frete_qualidade_tipo: null },
  ];
  // Bancada (/simular) e ranking de Promoções leem o snapshot direto: mesma regra (P0 12/11/2026).
  const sim = require("../services/motorMargem/margemSimularService");
  const { sqlOportunidadesElegiveis } = require("../services/motorMargem/precificacao/precificacaoOportunidadesSql");
  const simular = (contaId, quality) => sim.simular({ user: { id: 1, role: "user" }, body: { cliente_conta_id: contaId, mlb: "MLB100", cenarios: [{ tipo: "preco", preco: 89.9 }] } }, {
    db: {}, now: () => new Date("2026-11-12T12:00:00.000Z"), logger: { error() {}, warn() {}, info() {} },
    assertContaNaCarteira: async () => ({ contaId, clienteId: 133, clienteSlug: "alianza", clienteNome: "Alianza", clienteAtivo: true }),
    obterConta: async () => ({ id: contaId, cliente_id: 133, marketplace: "meli", nome: "Conta", ativo: true, external_account_id: "2433262404" }),
    snapshotRepo: { getProjectionSnapshot: async () => ({ itemId: "MLB100", marketplace: "meli", price: 94.9, cost: 44, taxRate: 0.13, fixedFee: 0, commission: 13.3,
      commissionRate: 0.14, freight: 7.75, status: "HEALTHY", assumed: [], missing: [], refreshStatus: "fresh", calculatedAt: "2026-11-10T16:14:00.000Z", quality, catalogMissingSince: null }) },
    obterAnuncio: async () => ({ item_id: "MLB100", ml_user_id: "2433262404", listing_type_id: "gold_special", category_id: "MLB1", logistic_type: "cross_docking" }),
    promoService: { estadoSincronizacao: async () => ({ hasSnapshot: false }) }, promoRepo: {}, carregarRebates: async () => ({ porItem: new Map(), indisponivel: null }),
    buscarComissaoEFrete: async (a) => ({ comissaoValor: Math.round(a.precoEfetivo * 14) / 100, comissaoPercentual: 0.14, fretePrevisto: 13.85 }),
    mlFetch: async () => ({ ok: false, status: 404, data: null }),
  }).then((r) => ({ veredito: r.cenarios[0].veredito, motivos: r.cenarios[0].motivos, freteHoje: r.cenarios[0].atual ? r.cenarios[0].atual.frete : (r.atual ? r.atual.frete : undefined), lcHoje: r.cenarios[0].atual ? r.cenarios[0].atual.lc : (r.atual ? r.atual.lc : undefined) }));
  fonte.lerMarginSnapshotPorItens({ clienteId: 133, itemIds: rows.map((r) => r.item_id) }, { async query() { return { rows }; } }).then(async (m) => {
    console.log(JSON.stringify({
      sqlFreteLegado: conf.sqlFreteLegadoNaoVerificado("s"),
      sqlOportunidades: sqlOportunidadesElegiveis({ fonteSql: "SELECT 1", clienteContaId: 87, clienteId: 133 }).sql,
      simAntiga: await simular(87, { targetMargin: 0.1 }),
      simAvaliada: await simular(87, { targetMargin: 0.1, freteQualidade: { nivel: "estimado_dimensoes_declaradas" } }),
      simOutra: await simular(55, { targetMargin: 0.1 }),
      sql: conf.SQL_CUSTO_MARKETPLACE_AUSENTE,
      antiga: m.get("MLB_ANTIGA"), avaliada: m.get("MLB_AVALIADA"), estimada: m.get("MLB_ESTIMADA"), outra: m.get("MLB_OUTRA"),
    }));
  });
} else {
  const rodar = (contas) => JSON.parse(execFileSync(process.execPath, [__filename, "filho"], {
    env: { ...process.env, ...(contas === undefined ? {} : { FRETE_LEGADO_BLOQUEAR_CONTAS: contas }) }, encoding: "utf8",
  }).trim().split("\n").pop());

  const comFlag = rodar("87");
  ok(comFlag.antiga.margemIncompleta === true && comFlag.antiga.marginPercent === null && comFlag.antiga.profit === null && comFlag.antiga.computable === false,
    "linha antiga da conta 87 não é confiável");
  ok(comFlag.antiga.status === "SUSPECT_DATA", "frete invalidado na leitura não mantém o status saudável do snapshot");
  ok(comFlag.avaliada.status === "HEALTHY" && comFlag.outra.status === "HEALTHY", "status saudável preservado para fretes válidos e contas fora da regra");
  ok(comFlag.avaliada.margemIncompleta === false && comFlag.avaliada.marginPercent === 30, "linha já avaliada (frete válido) continua visível");
  ok(comFlag.estimada.margemIncompleta === false && comFlag.estimada.freteNivel === "estimado_dimensoes_historicas", "estimada visível e rotulada");
  ok(comFlag.outra.margemIncompleta === false && comFlag.outra.marginPercent === 18, "outra conta intocada");
  ok(comFlag.sql.includes("cliente_conta_id IN (87)") && comFlag.sql.includes("jsonb_typeof(quality_json->'freteQualidade')"), comFlag.sql);

  // Bancada (/simular): o "hoje" de um snapshot antigo da conta bloqueada não usa o 7,75 gravado.
  ok(comFlag.simAntiga.veredito === "bloqueado" && comFlag.simAntiga.motivos.includes("frete_atual_ausente") && comFlag.simAntiga.lcHoje === null,
    `simular com snapshot antigo bloqueia: ${JSON.stringify(comFlag.simAntiga)}`);
  ok(comFlag.simAvaliada.veredito !== "bloqueado" && comFlag.simAvaliada.freteHoje === 7.75, "snapshot já avaliado segue valendo");
  ok(comFlag.simOutra.veredito !== "bloqueado" && comFlag.simOutra.freteHoje === 7.75, "outra conta: simular intocado");
  ok(/CASE WHEN \(s\.cliente_conta_id IN \(87\) AND .*freteQualidade.* THEN NULL ELSE s\.freight END AS freight/.test(comFlag.sqlOportunidades),
    "ranking de Promoções: frete antigo da conta bloqueada sai ausente");

  for (const sem of [undefined, "", "abc", "*"]) {
    const r = rodar(sem);
    ok(r.sqlFreteLegado === "FALSE" && r.sqlOportunidades.includes("CASE WHEN FALSE THEN NULL ELSE s.freight END AS freight"), "sem a flag o ranking lê o frete como antes");
    ok(r.simAntiga.veredito !== "bloqueado" && r.simAntiga.freteHoje === 7.75, "sem a flag o simular não muda");
    ok(r.antiga.margemIncompleta === false && r.antiga.marginPercent === 45.25, `flag ${JSON.stringify(sem)}: comportamento antigo`);
    ok(!r.sql.includes("freteQualidade"), "SQL idêntico ao original sem a flag");
  }
  console.log(`\nfreteLegadoBloqueioConta: ${checks} checks`);
}
