// VenForce Resgate — Entrega C (API): sem rota de escrita no ML, carteira em
// toda rota por conta, 503 sem migration, simulação só GET, revisão protegida
// pelo preço visto, exportação global limitada aos anúncios com ação.
const assert = require("assert");
const fs = require("fs");
const path = require("path");

let ok = 0;
async function t(nome, fn) { try { await fn(); ok++; console.log(`  ✓ ${nome}`); } catch (e) { console.error(`  ✗ ${nome}\n    ${e.stack}`); process.exitCode = 1; } }
function res() { const r = { statusCode: 200, headers: {}, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, setHeader(k, v) { this.headers[k] = v; }, send(b) { this.body = b; return this; } }; return r; }

(async () => {
  const rotas = fs.readFileSync(path.join(__dirname, "..", "routes", "resgateRoutes.js"), "utf8");
  await t("rotas: nenhuma PUT/PATCH/DELETE; toda rota /contas/:contaId passa pela carteira", () => {
    assert.ok(!/router\.(put|patch|delete)\(/.test(rotas));
    for (const l of rotas.split("\n").filter((x) => /router\.(get|post)\("\/contas\/:contaId/.test(x))) assert.ok(/\.\.\.daConta/.test(l), l);
    assert.ok(/requireClienteContaNaCarteira\("contaId"\)/.test(rotas));
    const idx = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
    assert.ok(/app\.use\("\/resgate", resgateRoutes\)/.test(idx));
  });
  await t("controller e serviços do Resgate não importam nenhum serviço de escrita do ML", () => {
    const arquivos = [path.join(__dirname, "..", "controllers", "resgateController.js"), ...fs.readdirSync(path.join(__dirname, "..", "services", "resgate")).map((f) => path.join(__dirname, "..", "services", "resgate", f))];
    for (const f of arquivos) {
      const src = fs.readFileSync(f, "utf8");
      assert.ok(!/meliPrecoService|meliPromocoesEscritaService|atualizarPreco\(|method:\s*"(PUT|POST|DELETE|PATCH)"/.test(src), path.basename(f));
    }
  });

  const c = require("../controllers/resgateController");
  await t("sem as tabelas (migration não aplicada) → 503 RESGATE_TABELAS_AUSENTES", async () => {
    c.configurar({ db: { query: async () => ({ rows: [{ ok: false }] }) } });
    for (const fn of ["visaoGlobal", "itens", "planoXlsx", "dryRun"]) {
      const r = res(); await c[fn]({ user: { role: "admin" }, params: { contaId: "86" }, query: {}, body: {} }, r);
      assert.strictEqual(r.statusCode, 503, fn); assert.strictEqual(r.body.codigo, "RESGATE_TABELAS_AUSENTES");
    }
  });

  // Store PG falso mínimo: só o que o controller usa, para testar regras sem banco.
  const item = { itemId: "MLB1", sellerId: "S1", meta: { valor: 0.15 }, fingerprint: { precoVisto: 100 }, contrato: { componentes: {} }, recomendacao: { ok: true, preco: 110 }, restricoes: [] };
  function dbFalso({ revisaoAceita = true } = {}) {
    const chamadas = [];
    return {
      chamadas,
      async query(sql, p) {
        chamadas.push(sql.replace(/\s+/g, " ").slice(0, 60));
        if (/to_regclass/.test(sql)) return { rows: [{ ok: true }] };
        if (/FROM resgate_execucoes/.test(sql)) return { rows: [{ id: 5, status: "concluida", iniciada_em: new Date(), finalizada_em: new Date() }] };
        if (/UPDATE resgate_itens SET revisao_status/.test(sql)) return { rowCount: revisaoAceita && Number(p[6]) === 100 ? 1 : 0, rows: [] };
        if (/FROM resgate_itens WHERE execucao_id = \$1 AND cliente_conta_id = \$2 AND item_id = \$3/.test(sql)) return { rows: [{ resultado: item, revisao_status: "PENDENTE" }] };
        if (/FROM resgate_contas_resultado/.test(sql)) return { rows: [{ cliente_conta_id: 86, cliente_id: 133, resumo: { clienteContaId: 86, clienteId: 133, itens: 1, precisamRevisao: 1, sellerId: "S1" }, matriz: { decisao: "SEM_DADOS", motivos: [], totais: {} } }] };
        if (/FROM margin_projection_snapshots s/.test(sql)) return { rows: [{ item_id: "MLB1", price: 100, cost: 40, tax_rate: 0.13, fixed_fee: 0, calculated_at: new Date().toISOString() }] };
        return { rows: [] };
      },
    };
  }
  await t("visão global: admin vê tudo; usuário só a carteira (filtro por cliente_id)", async () => {
    const db = dbFalso();
    let pedidoCarteira = null;
    c.configurar({ db, clientesAutorizados: async (u) => { pedidoCarteira = u; return new Set([133]); } });
    const r = res(); await c.visaoGlobal({ user: { role: "membro", id: 9 }, query: {} }, r);
    assert.strictEqual(r.statusCode, 200); assert.strictEqual(r.body.contas.length, 1); assert.ok(pedidoCarteira && pedidoCarteira.id === 9);
    assert.ok(r.body.ativacao && Array.isArray(r.body.ativacao.contas));
  });
  await t("revisão: exige preço visto; preço divergente → 409 PROPOSTA_DESATUALIZADA", async () => {
    c.configurar({ db: dbFalso() });
    let r = res(); await c.revisar({ user: { id: 1 }, params: { contaId: "86", itemId: "MLB1" }, body: { status: "APROVADO" } }, r);
    assert.strictEqual(r.statusCode, 400);
    r = res(); await c.revisar({ user: { id: 1 }, params: { contaId: "86", itemId: "MLB1" }, body: { status: "APROVADO", precoVisto: 94.9 } }, r);
    assert.strictEqual(r.statusCode, 409); assert.strictEqual(r.body.codigo, "PROPOSTA_DESATUALIZADA");
    r = res(); await c.revisar({ user: { id: 1 }, params: { contaId: "86", itemId: "MLB1" }, body: { status: "APROVADO", precoVisto: 100 } }, r);
    assert.strictEqual(r.statusCode, 200);
    r = res(); await c.revisar({ user: { id: 1 }, params: { contaId: "86", itemId: "MLB1" }, body: { status: "INVALIDADO", precoVisto: 100 } }, r);
    assert.strictEqual(r.statusCode, 400, "INVALIDADO só o sistema marca");
  });
  await t("simular: leitura ao vivo com o fetch somente-leitura; avisa quando o preço mudou desde a auditoria", async () => {
    const metodos = [];
    const vivo = { ok: true, observadoEm: new Date().toISOString(), precos: { vigente: 94.9, cheio: 94.9, promocional: null, fonte: "sale_price" }, anuncio: { itemId: "MLB1", logisticType: "cross_docking" }, promocao: { ativa: false },
      cotacao: { comissaoValor: 13.29, comissaoPercentual: 0.14, fretePrevisto: 13.85, freteQualidade: { nivel: "cotado_ml" } },
      cotarEmPreco: async (p) => ({ comissaoValor: Math.round(p * 14) / 100, comissaoPercentual: 0.14, fretePrevisto: 13.85, freteQualidade: { nivel: "cotado_ml" } }) };
    const ler = Object.assign(async () => ({}), { metricas: { chamadas: 4 } });
    c.configurar({ db: dbFalso(), criarFetch: () => ler, lerAoVivo: async (a) => { metodos.push(a.ler === ler); return vivo; } });
    const r = res(); await c.simular({ user: { id: 1 }, contaAutorizada: { clienteId: 133 }, params: { contaId: "86", itemId: "MLB1" }, body: { precos: [99.9, 109.9] } }, r);
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body)); assert.deepStrictEqual(metodos, [true]);
    assert.strictEqual(r.body.precoMudouDesdeAuditoria, true);
    assert.strictEqual(r.body.simulacoes.length, 2); assert.strictEqual(r.body.simulacoes[1].comissao.valor, 15.39);
    assert.ok(r.body.recomendacao && r.body.recomendacao.ok);
  });
  await t("exportação global do servidor lê só anúncios com ação (memória do Render); a da conta lê todos", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "controllers", "resgateController.js"), "utf8");
    assert.ok(/somenteAcionaveis = !req\.params\.contaId/.test(src));
    const st = fs.readFileSync(path.join(__dirname, "..", "services", "resgate", "resgateStorePg.js"), "utf8");
    assert.ok(/acao = 'REVISAR_PRECO'/.test(st) && /unidades_30d,0\) > 0/.test(st));
    assert.ok(/LIMITE_GLOBAL_POR_CONTA = 1500/.test(src));
  });
  console.log(`\n${ok} verificações das rotas do Resgate`);
})();
