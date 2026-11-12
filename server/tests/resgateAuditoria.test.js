// VenForce Resgate — Entrega B: leitura somente GET, isolamento entre contas,
// auditoria em lotes (retomável/cancelável), correção pelo realizado, XLSX
// recalculado no LibreOffice (backend × planilha) e dry-run sem escrita.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync, execFileSync } = require("child_process");
const XLSX = require("xlsx");

const { criarFetchSomenteLeitura, lerAnuncioAoVivo, promocaoDoItem } = require("../services/resgate/resgateAoVivo");
const { auditarConta } = require("../services/resgate/resgateAuditoriaService");
const { auditarItem } = require("../services/resgate/resgateAuditoriaItem");
const { criarStoreArquivo } = require("../services/resgate/resgateStoreArquivo");
const { construirPlanoXlsx } = require("../services/resgate/resgatePlanoXlsx");
const { simularLote, executarLote, ESCRITA_REAL_DISPONIVEL, MOTIVO } = require("../services/resgate/resgateDryRun");
const { SITUACAO } = require("../services/resgate/resgateClassificacao");

let ok = 0;
async function t(nome, fn) {
  try { await fn(); ok++; console.log(`  ✓ ${nome}`); } catch (e) { console.error(`  ✗ ${nome}\n    ${e.stack}`); process.exitCode = 1; }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "vf-resgate-"));
const semEspera = async () => {};

// ── Fixture: snapshots de DUAS contas (86 e 87); a auditoria da 86 não pode ver a 87.
function linha(conta, id, extra = {}) {
  return {
    item_id: id, cliente_id: 133, cliente_conta_id: conta, sku: `SKU-${id}`, titulo: `Produto ${id}`, price: "100.00", list_price: "100.00", promo_price: null,
    cost: "40.00", fixed_fee: "0.00", commission: "14.00", freight: "7.75", profit: null, tax_rate: "0.1300", commission_rate: "0.1400",
    margin: null, margin_percent: "25.25", status_motor: "HEALTHY", confidence_level: "HIGH", refresh_status: "fresh", last_error: null,
    calculated_at: new Date(Date.now() - 3600000).toISOString(), observed_at: null, frete_qualidade: null, frete_aplicavel: "true",
    logistic_type_snapshot: "cross_docking", status_anuncio_snapshot: "active", target_margin: "0.10", assumed_json: [], missing_json: [],
    status_anuncio: "active", logistic_type: "cross_docking", listing_type_id: "gold_special", preco_sync: "100.00", preco_original_sync: "100.00",
    last_synced_at: new Date(Date.now() - 7200000).toISOString(), variations_count: 0, estoque: 3, ...extra,
  };
}
function fakeDb({ linhas, vendas = [], eventos = [] }) {
  const consultas = [];
  return {
    consultas,
    async query(sql, params = []) {
      consultas.push(sql.replace(/\s+/g, " ").slice(0, 80));
      if (/INSERT|UPDATE|DELETE/i.test(sql.replace(/'[^']*'/g, ""))) throw new Error("escrita proibida no teste");
      if (/FROM margin_projection_snapshots s/.test(sql)) {
        const [conta, apos, lim, ids] = params;
        return { rows: linhas.filter((l) => l.cliente_conta_id === conta && l.item_id > apos && (!ids || ids.includes(l.item_id))).sort((a, b) => (a.item_id < b.item_id ? -1 : 1)).slice(0, lim) };
      }
      if (/FROM central_vendas_imports/.test(sql)) return { rows: params[0] === 86 ? [{ id: 1, competencia: "2026-11", coverage_date_to: "2026-11-12" }] : [] };
      if (/FROM central_vendas_pedido_itens/.test(sql)) return { rows: vendas };
      if (/FROM activity_logs/.test(sql)) return { rows: eventos.filter((e) => e.conta === params[0]) };
      if (/FROM margem_precificacao_aplicacoes|FROM relatorio_itens|FROM relatorios/.test(sql)) return { rows: [] };
      throw new Error(`consulta inesperada: ${sql.slice(0, 120)}`);
    },
  };
}
const conta86 = { clienteId: 133, clienteContaId: 86, sellerId: "1587129755", clienteNome: "Cliente A", contaNome: "Conta 1" };

(async () => {
  console.log("Leitura somente GET");
  await t("PUT/POST/corpo recusados antes de sair do processo; GET passa com noRefresh", async () => {
    const vistos = [];
    const ler = criarFetchSomenteLeitura({ fetchFn: async (_c, p, o) => { vistos.push(o); return { ok: true, status: 200, data: {} }; }, noRefresh: true, minIntervalMs: 0, sleep: semEspera });
    await assert.rejects(() => ler(1, "/items/MLB1", { method: "PUT", body: "{}" }), /somente leitura/);
    await assert.rejects(() => ler(1, "/items/MLB1", { method: "POST" }), /somente leitura/);
    await assert.rejects(() => ler(1, "/items/MLB1", { body: "{}" }), /somente leitura/);
    await ler(1, "/items/MLB1", { mlUserId: "S" });
    assert.strictEqual(vistos.length, 1); assert.strictEqual(vistos[0].method, "GET"); assert.strictEqual(vistos[0].noRefresh, true);
  });
  await t("429: pausa global e nova tentativa; desiste após o limite e devolve o 429 (falha parcial, sem exceção)", async () => {
    let n = 0;
    const ler = criarFetchSomenteLeitura({ fetchFn: async () => (++n < 3 ? { ok: false, status: 429, retryAfter: 1 } : { ok: true, status: 200, data: { x: 1 } }), minIntervalMs: 0, max429: 3, sleep: semEspera });
    const r = await ler(1, "/items/MLB1", {});
    assert.strictEqual(r.ok, true); assert.strictEqual(ler.metricas.status429, 2);
    const sempre = criarFetchSomenteLeitura({ fetchFn: async () => ({ ok: false, status: 429 }), minIntervalMs: 0, max429: 2, sleep: semEspera });
    assert.strictEqual((await sempre(1, "/x", {})).status, 429);
  });
  await t("anúncio de OUTRO seller é recusado (isolamento entre contas)", async () => {
    const ler = criarFetchSomenteLeitura({ fetchFn: async (_c, p) => (p.startsWith("/items/MLB7?") ? { ok: true, status: 200, data: { id: "MLB7", seller_id: 2433262404 } } : { ok: false, status: 404 }), minIntervalMs: 0, sleep: semEspera });
    const r = await lerAnuncioAoVivo({ clienteId: 133, sellerId: "1587129755", itemId: "MLB7", ler });
    assert.strictEqual(r.ok, false); assert.strictEqual(r.motivo, "anuncio_de_outro_seller");
  });
  await t("subsídio: 1 promoção com retorno → valor; todas com meli_percentage 0 → zero comprovado; sem o campo → desconhecido; 2 → ambíguo", () => {
    assert.strictEqual(promocaoDoItem([{ status: "started", subsidioMl: 4.5, promotionId: "P1" }], []).subsidioMl, 4.5);
    assert.strictEqual(promocaoDoItem([{ status: "started", subsidioMl: 0 }], []).subsidioMl, 0);
    assert.strictEqual(promocaoDoItem([{ status: "started", subsidioMl: null }], []).subsidioMl, null);
    assert.strictEqual(promocaoDoItem([{ status: "started", subsidioMl: 2 }, { status: "active", subsidioMl: 3 }], []).ambigua, true);
  });
  await t("leitura ao vivo usa o cotador compartilhado em modo auditoria (proximity sem medidas → frete desconhecido)", async () => {
    const metodos = [];
    const fetchFn = async (_c, p, o) => {
      metodos.push(o.method);
      if (p.startsWith("/items/MLB1?attributes")) return { ok: true, status: 200, data: { id: "MLB1", seller_id: 1587129755, price: 100, status: "active", listing_type_id: "gold_special", category_id: "C1", shipping: { logistic_type: "cross_docking", tags: ["proximity", "mandatory_free_shipping"] } } };
      if (p.includes("/sale_price")) return { ok: true, status: 200, data: { amount: 100 } };
      if (p.endsWith("/prices")) return { ok: true, status: 200, data: { prices: [{ type: "standard", amount: 100, last_updated: "2026-11-10T10:00:00Z" }] } };
      if (p.startsWith("/seller-promotions")) return { ok: true, status: 200, data: [] };
      if (p.startsWith("/sites/MLB/listing_prices")) return { ok: true, status: 200, data: { sale_fee_amount: 14, sale_fee_details: { percentage_fee: 14 } } };
      if (p.includes("shipping_options/free?item_id")) return { ok: true, status: 200, data: { coverage: { all_country: { list_cost: 7.75, discount: { type: "none", rate: 0 } } } } };
      if (p.includes("include_attributes=all")) return { ok: true, status: 200, data: { attributes: [] } };
      if (p.startsWith("/orders/search")) return { ok: true, status: 200, data: { results: [] } };
      return { ok: false, status: 404 };
    };
    const ler = criarFetchSomenteLeitura({ fetchFn, minIntervalMs: 0, sleep: semEspera });
    const v = await lerAnuncioAoVivo({ clienteId: 133, sellerId: "1587129755", itemId: "MLB1", ler });
    assert.strictEqual(v.ok, true); assert.strictEqual(v.cotacao.fretePrevisto, null); assert.strictEqual(v.cotacao.freteQualidade.cotacaoRejeitada, 7.75);
    assert.strictEqual(v.precoBaseAtualizadoEm, "2026-11-10T10:00:00.000Z");
    assert.ok(metodos.every((m) => m === "GET"));
    const it = await auditarItem({ row: linha(86, "MLB1"), conta: conta86, vivo: v, meta: { valor: 0.1 } });
    assert.strictEqual(it.situacao, SITUACAO.DADOS_INSUFICIENTES); assert.strictEqual(it.fonteAvaliacao, "ao_vivo");
    assert.ok(it.contrato.bloqueios.some((b) => b.codigo === "FRETE_DESCONHECIDO"));
  });

  console.log("Auditoria da conta (lotes, isolamento, retomada, cancelamento)");
  const linhas = [linha(86, "MLB1"), linha(86, "MLB2", { cost: null, tax_rate: null, fixed_fee: null, margin_percent: null }), linha(86, "MLB3"), linha(87, "MLB9")];
  const vendas = [1, 2, 3, 4].map((d) => ({ item_id: "MLB3", data_pedido: `2026-11-0${d + 4}`, quantidade: "1", valor_unitario: "100.00", quantidade_itens: "1", frete_seller: "-13.85" }));
  await t("camada 1: classifica todas as linhas DA CONTA, nunca as de outra", async () => {
    const dir = tmp();
    const db = fakeDb({ linhas, vendas });
    const store = criarStoreArquivo(dir);
    const r = await auditarConta({ db, conta: conta86, store, execucaoId: "e1", opcoes: { pagina: 2, agora: new Date("2026-11-12T12:00:00Z") } });
    assert.strictEqual(r.status, "concluida");
    assert.deepStrictEqual(r.itens.map((x) => x.itemId).sort(), ["MLB1", "MLB2", "MLB3"]);
    const it2 = r.itens.find((x) => x.itemId === "MLB2");
    assert.strictEqual(it2.situacao, SITUACAO.DADOS_INSUFICIENTES);
    // MLB3: snapshot 7,75 × 4 vendas reais cobrando 13,85 → contrato corrigido pelo realizado e margem antiga inflada.
    const it3 = r.itens.find((x) => x.itemId === "MLB3");
    assert.strictEqual(it3.fonteAvaliacao, "snapshot_corrigido_pelo_realizado");
    assert.strictEqual(it3.contrato.componentes.frete.valor, 13.85);
    assert.strictEqual(it3.situacao, SITUACAO.MARGEM_ANTIGA_INFLADA);
    assert.ok(it3.exposicao.valor > 0);
    // MLB1 (sem vendas, frete não verificado): margem desconhecida, não "ok".
    assert.strictEqual(r.itens.find((x) => x.itemId === "MLB1").situacao, SITUACAO.MARGEM_DESCONHECIDA);
    assert.ok(fs.existsSync(path.join(dir, "contas", "86", "conta.json")));
    assert.ok(!fs.existsSync(path.join(dir, "contas", "87")));
    assert.ok(r.matriz && r.matriz.totais.itensAuditados === 3);
  });
  await t("retomada: conta concluída não é relida; cancelamento devolve 'cancelado' com checkpoint", async () => {
    const dir = tmp();
    const store = criarStoreArquivo(dir);
    const db1 = fakeDb({ linhas, vendas });
    await auditarConta({ db: db1, conta: conta86, store, execucaoId: "e2", opcoes: { pagina: 2 } });
    const db2 = fakeDb({ linhas, vendas });
    const r2 = await auditarConta({ db: db2, conta: conta86, store, execucaoId: "e2", opcoes: { pagina: 2 } });
    assert.strictEqual(r2.retomada, true);
    assert.ok(!db2.consultas.some((q) => /margin_projection_snapshots/.test(q)), "não releu snapshots");
    const ctrl = new AbortController(); ctrl.abort();
    const r3 = await auditarConta({ db: fakeDb({ linhas }), conta: conta86, store: criarStoreArquivo(tmp()), execucaoId: "e3", opcoes: { signal: ctrl.signal } });
    assert.strictEqual(r3.status, "cancelado");
  });
  await t("camada 2: só anúncios da conta e só GET; preço mudou depois do snapshot → origem indeterminada e recente", async () => {
    const pedidos = [];
    const fetchFn = async (_c, p, o) => {
      pedidos.push([o.method, p]);
      const id = (p.match(/MLB\d+/) || [])[0];
      if (/^\/items\/MLB\d+\?attributes/.test(p)) return { ok: true, status: 200, data: { id, seller_id: 1587129755, price: 89.9, status: "active", listing_type_id: "gold_special", category_id: "C1", shipping: { logistic_type: "cross_docking", tags: [] } } };
      if (p.includes("/sale_price")) return { ok: true, status: 200, data: { amount: 89.9 } };
      if (p.endsWith("/prices")) return { ok: true, status: 200, data: { prices: [] } };
      if (p.startsWith("/seller-promotions")) return { ok: false, status: 404 };
      if (p.startsWith("/sites/MLB/listing_prices")) return { ok: true, status: 200, data: { sale_fee_amount: Math.round(Number(p.match(/price=([\d.]+)/)[1]) * 14) / 100, sale_fee_details: { percentage_fee: 14 } } };
      if (p.includes("shipping_options/free?item_id")) return { ok: true, status: 200, data: { coverage: { all_country: { list_cost: 13.85, discount: { type: "mandatory", rate: 0.5 } } } } };
      return { ok: false, status: 404 };
    };
    const ler = criarFetchSomenteLeitura({ fetchFn, minIntervalMs: 0, sleep: semEspera });
    const r = await auditarConta({ db: fakeDb({ linhas, vendas }), conta: conta86, store: criarStoreArquivo(tmp()), execucaoId: "e4", opcoes: { aoVivo: { ativo: true, maxItens: 5, ler }, metas: { 86: 0.15 } } });
    assert.ok(pedidos.every(([m]) => m === "GET"));
    assert.ok(!pedidos.some(([, p]) => /MLB9/.test(p)), "não leu anúncio da conta 87");
    const v1 = r.itens.find((x) => x.itemId === "MLB1");
    assert.strictEqual(v1.fonteAvaliacao, "ao_vivo");
    assert.strictEqual(v1.historico.origem, "ALTERADO_ORIGEM_INDETERMINADA");
    assert.strictEqual(v1.historico.mudancaRecente, true);
    assert.strictEqual(v1.meta.valor, 0.15); assert.strictEqual(v1.meta.origem, "configurada para a conta");
    assert.ok(r.matriz.totais.amostraAoVivo >= 1);
  });

  console.log("XLSX de recuperação (backend × planilha, zero × ausente)");
  const TEM_SOFFICE = spawnSync("soffice", ["--version"], { encoding: "utf8", timeout: 60000 }).status === 0;
  await t("estrutura: cabeçalho de AUDITORIA, colunas obrigatórias e fórmulas com ISNUMBER", async () => {
    const r = await auditarConta({ db: fakeDb({ linhas, vendas }), conta: conta86, store: null, execucaoId: "x", opcoes: { metas: { 86: 0.15 } } });
    const wb = construirPlanoXlsx({ contas: [{ resumo: r.resumo, matriz: r.matriz }], itensPorConta: new Map([[86, r.itens]]), execucao: { id: "x", iniciadaEm: new Date().toISOString() } });
    assert.deepStrictEqual(wb.SheetNames, ["Resumo", "Plano de preços", "Pendências", "Todos os anúncios", "Contas"]);
    const ws = wb.Sheets["Todos os anúncios"];
    assert.ok(/AUDITORIA VenForce Resgate/.test(ws.A1.v) && /não de relatório salvo/.test(ws.A1.v));
    const cab = XLSX.utils.sheet_to_json(ws, { header: 1 })[1];
    for (const col of ["Cliente", "Conta", "Seller", "MLB", "SKU", "Produto", "Preço atual", "Preço proposto", "Margem atual (backend)", "Margem projetada", "Meta", "Frete atual", "Fonte do frete", "Comissão atual", "Custo", "Imposto %", "Promoção", "Histórico de alteração", "Classificação", "Confiança", "Pendências", "Status da revisão"]) assert.ok(cab.includes(col), `coluna ${col}`);
    for (const k of Object.keys(ws)) if (ws[k] && ws[k].f && /\/I\d+|\/J\d+/.test(ws[k].f)) assert.ok(/ISNUMBER\(K\d+\)/.test(ws[k].f), `fórmula sem ISNUMBER: ${ws[k].f}`);
    const pend = XLSX.utils.sheet_to_json(wb.Sheets["Pendências"], { header: 1 });
    assert.ok(pend.some((l) => l[2] === "MLB2" && /custo/i.test(l[8])));
  });
  await t(TEM_SOFFICE ? "LibreOffice real: margem da fórmula = margem do backend; custo ausente → fórmula em branco" : "LibreOffice ausente: recálculo PULADO", async () => {
    if (!TEM_SOFFICE) return;
    const r = await auditarConta({ db: fakeDb({ linhas, vendas }), conta: conta86, store: null, execucaoId: "x", opcoes: { metas: { 86: 0.15 } } });
    const wb = construirPlanoXlsx({ contas: [{ resumo: r.resumo, matriz: r.matriz }], itensPorConta: new Map([[86, r.itens]]), execucao: { id: "x" } });
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "in.xlsx"), XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
    execFileSync("soffice", ["--headless", `-env:UserInstallation=file://${dir}/perfil`, "--convert-to", "xlsx:Calc MS Excel 2007 XML", "--outdir", path.join(dir, "out"), path.join(dir, "in.xlsx")], { stdio: "ignore", timeout: 180000 });
    const re = XLSX.read(fs.readFileSync(path.join(dir, "out", "in.xlsx")));
    const rows = XLSX.utils.sheet_to_json(re.Sheets["Todos os anúncios"], { header: 1, defval: "" });
    const cab = rows[1];
    const col = (n) => cab.indexOf(n);
    for (const l of rows.slice(2)) {
      assert.ok(String(l[col("Confere com backend")]).startsWith("OK"), `${l[col("MLB")]}: ${l[col("Confere com backend")]}`);
      if (l[col("MLB")] === "MLB2") assert.strictEqual(l[col("Margem atual (fórmula)")], "");
      if (l[col("MLB")] === "MLB3") assert.ok(Math.abs(Number(l[col("Margem atual (fórmula)")]) - (100 - 13 - 14 - 13.85 - 0 - 40) / 100) < 1e-6);
    }
  });

  console.log("Dry-run (sem escrita)");
  const fetchDry = (precoAtual) => { const m = []; const f = async (_c, p, o) => { m.push(o.method); if (p.includes("/sale_price")) return { ok: true, status: 200, data: { amount: precoAtual } }; return { ok: false, status: 404 }; }; f.metodos = m; return f; };
  await t("nunca há escrita: só GET; executarLote lança; trava dura independe de env", async () => {
    const f = fetchDry(100);
    const ler = criarFetchSomenteLeitura({ fetchFn: f, minIntervalMs: 0, sleep: semEspera });
    const r = await simularLote({ propostas: [{ clienteId: 133, clienteContaId: 86, sellerId: "1", itemId: "MLB1", aprovado: true, precoVisto: 100, precoProposto: 110, meta: 0.15 }], ler });
    assert.strictEqual(r.lote.modo, "DRY_RUN"); assert.strictEqual(ESCRITA_REAL_DISPONIVEL, false);
    assert.strictEqual(r.itens[0].acao, "ESCREVERIA"); assert.strictEqual(r.itens[0].escrita.metodo, "PUT");
    assert.ok(f.metodos.every((m) => m === "GET"));
    process.env.RESGATE_ESCRITA_ENABLED = "true";
    await assert.rejects(() => executarLote(), /não existe/);
    delete process.env.RESGATE_ESCRITA_ENABLED;
  });
  await t("preço alterado depois da análise (manual/externo): proposta INVALIDADA, nada sobrescrito", async () => {
    const ler = criarFetchSomenteLeitura({ fetchFn: fetchDry(94.9), minIntervalMs: 0, sleep: semEspera });
    const r = await simularLote({ propostas: [{ clienteId: 133, clienteContaId: 86, sellerId: "1", itemId: "MLB1", aprovado: true, precoVisto: 100, precoProposto: 110 }], ler });
    assert.strictEqual(r.itens[0].motivo, MOTIVO.PRECO_MUDOU); assert.strictEqual(r.itens[0].precoAtual, 94.9);
  });
  await t("sem aprovação, variação acima do limite, limite por lote e por conta, restrição de promoção", async () => {
    const ler = criarFetchSomenteLeitura({ fetchFn: fetchDry(100), minIntervalMs: 0, sleep: semEspera });
    const p = (id, extra = {}) => ({ clienteId: 133, clienteContaId: 86, sellerId: "1", itemId: id, aprovado: true, precoVisto: 100, precoProposto: 110, ...extra });
    const r = await simularLote({ propostas: [p("A", { aprovado: false }), p("B", { precoProposto: 180 }), p("C"), p("D"), p("E", { restricoes: [{ codigo: "PROMOCAO_ATIVA" }] }), p("F", { clienteContaId: 87 })], ler, limites: { maxPorLote: 2, maxPorConta: 1 } });
    const m = Object.fromEntries(r.itens.map((x) => [x.itemId, x.motivo || x.acao]));
    assert.strictEqual(m.A, MOTIVO.SEM_APROVACAO); assert.strictEqual(m.B, MOTIVO.VARIACAO); assert.strictEqual(m.C, "ESCREVERIA");
    assert.strictEqual(m.D, MOTIVO.LIMITE_CONTA); assert.strictEqual(m.E, MOTIVO.RESTRICAO); assert.strictEqual(m.F, "ESCREVERIA");
  });

  console.log("Persistência e migração");
  await t("migration do Resgate NÃO é aplicada no boot; store PG invalida revisão quando o preço visto muda", () => {
    const schema = fs.readFileSync(path.join(__dirname, "..", "services", "schema", "schemaEnsure.js"), "utf8");
    assert.ok(!/venforce_resgate/.test(schema));
    const pg = fs.readFileSync(path.join(__dirname, "..", "services", "resgate", "resgateStorePg.js"), "utf8");
    assert.ok(/THEN 'INVALIDADO'/.test(pg) && /precoVisto/.test(pg));
    const sql = fs.readFileSync(path.join(__dirname, "..", "sql", "migrations", "20261112_venforce_resgate.sql"), "utf8");
    assert.ok(/uq_resgate_execucoes_em_andamento/.test(sql), "no máximo uma execução em andamento");
  });

  console.log(`\n${ok} verificações da auditoria do Resgate${TEM_SOFFICE ? "" : " (recálculo LibreOffice pulado)"}`);
})();
