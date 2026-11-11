// Composição do faturamento por conta (bruto V1 → exclusões → FAT) e
// sinalização de cobertura de custos de LC/MC. Sem banco: pool mockado por tag.
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/vf-test";

const assert = require("assert");
const pool = require("../config/database");
const {
  classificarPedido, montarComposicaoConta, somarComposicoes, coberturaCustos,
} = require("../services/painelContas/painelContasComposicao");
const { resolverContas, consolidarCliente } = require("../services/painelContas/painelContasOperacional");

let ok = 0;
function check(nome, fn) {
  fn();
  ok += 1;
  console.log(`  ✓ ${nome}`);
}

// ── A. Classificação: um pedido, um grupo ──────────────────────────────────
console.log("A. classificação");
check("pago e parcialmente reembolsado entram (mesmo predicado da Central)", () => {
  assert.strictEqual(classificarPedido("paid", null), "validos");
  assert.strictEqual(classificarPedido("partially_refunded", null), "validos");
  assert.strictEqual(classificarPedido("pending", null), "validos");
  // Devolução parcial mantém o status original: continua no resultado.
  assert.strictEqual(classificarPedido("paid", "devolucao_parcial"), "validos");
});
check("cancelado sem claim × cancelado com devolução", () => {
  assert.strictEqual(classificarPedido("cancelled", null), "cancelamentos");
  assert.strictEqual(classificarPedido("cancelado", "devolucao"), "devolucoes");
});
check("pós-venda aberto: mediação × devolução em andamento × outro", () => {
  assert.strictEqual(classificarPedido("com_problema", "mediacao"), "mediacoes");
  assert.strictEqual(classificarPedido("com_problema", "devolucao"), "devolucoesEmAndamento");
  assert.strictEqual(classificarPedido("com_problema", null), "outrosProblemas");
});
check("status de planilha (sem claim) também é separado", () => {
  assert.strictEqual(classificarPedido("Devolução", null), "devolucoes");
  assert.strictEqual(classificarPedido("Reembolso", null), "devolucoes");
  assert.strictEqual(classificarPedido("Em mediação", null), "mediacoes");
});

// ── B. Composição de UMA conta (números da conta ML 2 da auditoria, #483) ──
console.log("B. composição por conta");
const imp483 = {
  id: 483, cliente_conta_id: 82, publication_status: "published",
  coverage_date_from: "2026-09-01", coverage_date_to: "2026-09-30", faturamento: "527989.27",
};
const linhas483 = [
  { status: "paid", pos_venda_tipo: null, pedidos: 880, sem_valor: 0, faturamento: "527000.00" },
  { status: "partially_refunded", pos_venda_tipo: null, pedidos: 4, sem_valor: 0, faturamento: "989.27" },
  { status: "cancelled", pos_venda_tipo: null, pedidos: 42, sem_valor: 0, faturamento: "18601.48" },
  { status: "cancelado", pos_venda_tipo: "devolucao", pedidos: 14, sem_valor: 0, faturamento: "2320.95" },
  { status: "com_problema", pos_venda_tipo: "mediacao", pedidos: 5, sem_valor: 0, faturamento: "3108.41" },
  { status: "com_problema", pos_venda_tipo: "devolucao", pedidos: 2, sem_valor: 0, faturamento: "122.67" },
];
const c483 = montarComposicaoConta(imp483, linhas483);
check("bruto = todos os pedidos (regra V1)", () => {
  assert.deepStrictEqual(c483.bruto, { pedidos: 947, valor: 552142.78 });
});
check("exclusões disjuntas, com contagem e valor", () => {
  assert.deepStrictEqual(c483.exclusoes.cancelamentos, { pedidos: 42, valor: 18601.48 });
  assert.deepStrictEqual(c483.exclusoes.devolucoes, { pedidos: 14, valor: 2320.95 });
  assert.deepStrictEqual(c483.exclusoes.mediacoes, { pedidos: 5, valor: 3108.41 });
  assert.deepStrictEqual(c483.exclusoes.devolucoesEmAndamento, { pedidos: 2, valor: 122.67 });
  assert.deepStrictEqual(c483.exclusoes.outrosProblemas, { pedidos: 0, valor: 0 });
  assert.deepStrictEqual(c483.totalExcluido, { pedidos: 63, valor: 24153.51 });
});
check("bruto − exclusões = válidos = FAT oficial do import → fecha", () => {
  assert.strictEqual(c483.validos.valor, 527989.27);
  assert.strictEqual(c483.fat, 527989.27);
  assert.deepStrictEqual(c483.reconciliacao, { fecha: true, diferenca: 0 });
  assert.deepStrictEqual(c483.periodo, { de: "2026-09-01", ate: "2026-09-30" });
});
check("FAT do import diferente da soma dos válidos → NÃO fecha, diferença exposta", () => {
  const c = montarComposicaoConta({ ...imp483, faturamento: "528000.00" }, linhas483);
  assert.strictEqual(c.reconciliacao.fecha, false);
  assert.strictEqual(c.reconciliacao.diferenca, 10.73);
  assert.strictEqual(c.fat, 528000, "o FAT exibido continua o do import");
});
check("pedido sem valor é contado e sinalizado", () => {
  const c = montarComposicaoConta(imp483, [{ status: "paid", pos_venda_tipo: null, pedidos: 3, sem_valor: 1, faturamento: "10" }]);
  assert.strictEqual(c.pedidosSemValor, 1);
});

// ── C. Soma das contas ─────────────────────────────────────────────────────
console.log("C. soma das contas");
const c375 = montarComposicaoConta(
  { id: 375, faturamento: "100.00", coverage_date_from: "2026-09-01", coverage_date_to: "2026-09-29" },
  [
    { status: "paid", pos_venda_tipo: null, pedidos: 2, sem_valor: 0, faturamento: "100.00" },
    { status: "cancelled", pos_venda_tipo: null, pedidos: 1, sem_valor: 0, faturamento: "40.00" },
  ]
);
check("soma = Σ contas, grupo a grupo; períodos diferentes sinalizados", () => {
  const s = somarComposicoes([c483, c375]);
  assert.strictEqual(s.contas, 2);
  assert.deepStrictEqual(s.bruto, { pedidos: 950, valor: 552282.78 });
  assert.deepStrictEqual(s.exclusoes.cancelamentos, { pedidos: 43, valor: 18641.48 });
  assert.strictEqual(s.fat, 528089.27);
  assert.strictEqual(s.reconciliacao.fecha, true);
  assert.deepStrictEqual(s.periodo, { de: "2026-09-01", ate: "2026-09-30", diferente: true });
});
check("pedido em duas contas → a soma não fecha", () => {
  const s = somarComposicoes([c483, c375], { pedidos: 1, valor: 40 });
  assert.strictEqual(s.reconciliacao.fecha, false);
  assert.deepStrictEqual(s.sobreposicao, { pedidos: 1, valor: 40 });
});
check("uma conta que não fecha derruba a soma; sem contas → null", () => {
  const ruim = montarComposicaoConta({ ...imp483, faturamento: "1" }, linhas483);
  assert.strictEqual(somarComposicoes([ruim, c375]).reconciliacao.fecha, false);
  assert.strictEqual(somarComposicoes([]), null);
  assert.strictEqual(somarComposicoes([null]), null);
});

// ── D. Cobertura de custos (sinalização, fórmula intacta) ─────────────────
console.log("D. cobertura de custos");
check("parcial: % arredondado para BAIXO (nunca 100% quando falta custo)", () => {
  assert.deepStrictEqual(coberturaCustos({ fat: 1000, lc: 50, baseLc: 620 }), {
    estado: "parcial", cobertura: 0.62, faturamentoComCusto: 620, faturamentoSemCusto: 380,
  });
  assert.strictEqual(coberturaCustos({ fat: 1000, lc: 50, baseLc: 999.6 }).cobertura, 0.999);
});
check("completa, e nada a sinalizar quando LC já é ausente ou FAT ≤ 0", () => {
  assert.strictEqual(coberturaCustos({ fat: 1000, lc: 50, baseLc: 1000 }).estado, "completa");
  assert.strictEqual(coberturaCustos({ fat: 1000, lc: null, baseLc: 0 }), null);
  assert.strictEqual(coberturaCustos({ fat: 0, lc: 0, baseLc: 0 }), null);
  assert.strictEqual(coberturaCustos({ fat: 1000, lc: 10, baseLc: null }), null);
});
check("conta automática: LC/MC do import intocados + cobertura ao lado", () => {
  const [conta] = resolverContas(
    [{ id: 1, marketplace: "meli", external_account_id: "x", ativo: true }],
    { importPorConta: new Map([[1, {
      id: 9, faturamento: "1000", faturamento_com_custo: "620", lucro_contribuicao: "62",
      margem_contribuicao_percentual: "10", published_at: "2026-09-30T00:00:00Z", coverage_date_to: "2026-09-29",
    }]]) }
  );
  assert.strictEqual(conta.resumo.lc, 62);
  assert.strictEqual(conta.resumo.mc, 0.1);
  assert.strictEqual(conta.custos.estado, "parcial");
  assert.strictEqual(conta.custos.cobertura, 0.62);
});
check("conta manual com LC: cobertura completa", () => {
  const [conta] = resolverContas(
    [{ id: 2, marketplace: "shopee", ativo: true }],
    { manualPorConta: new Map([[2, { id: 5, faturamento: "500", lucro_contribuicao: "40", margem_contribuicao: null, competencia: "2026-09" }]]) }
  );
  assert.strictEqual(conta.custos.estado, "completa");
});
check("consolidado: base = Σ faturamento com custo das contas com LC ÷ FAT total", () => {
  const contas = resolverContas(
    [
      { id: 1, marketplace: "meli", external_account_id: "a", ativo: true },
      { id: 2, marketplace: "meli", external_account_id: "b", ativo: true },
    ],
    { importPorConta: new Map([
      [1, { id: 9, faturamento: "1000", faturamento_com_custo: "1000", lucro_contribuicao: "100", margem_contribuicao_percentual: "10" }],
      // Conta sem custo nenhum: LC null — o FAT dela entra, o LC não.
      [2, { id: 10, faturamento: "1000", faturamento_com_custo: "0", lucro_contribuicao: null, margem_contribuicao_percentual: null }],
    ]) }
  );
  assert.strictEqual(contas[1].custos, null, "conta sem LC continua só com '—'");
  const cons = consolidarCliente({ contas });
  assert.strictEqual(cons.resumo.fat, 2000);
  assert.strictEqual(cons.resumo.lc, 100);
  assert.strictEqual(cons.resumo.mc, 0.1, "MC consolidada inalterada (ΣLC ÷ Σbase)");
  assert.deepStrictEqual(cons.custos, { estado: "parcial", cobertura: 0.5, faturamentoComCusto: 1000, faturamentoSemCusto: 1000 });
});
check("consolidado por snapshot com MC do fechamento oficial: aviso só no LC", () => {
  const contas = resolverContas(
    [{ id: 1, marketplace: "meli", external_account_id: "a", ativo: true }],
    { importPorConta: new Map([[1, { id: 9, faturamento: "1000", faturamento_com_custo: "800", lucro_contribuicao: "80", margem_contribuicao_percentual: "10" }]]) }
  );
  const cons = consolidarCliente({
    contas,
    snapshot: {
      faturamento: 1000, lucroContribuicao: 80, lucroContribuicaoPresente: true, mcMedia: 0.12,
      centralImportIds: [9], mcFonte: "fechamento_oficial",
    },
  });
  assert.strictEqual(cons.origem, "snapshot");
  assert.deepStrictEqual(cons.custos.indicadores, ["lc"]);
  assert.strictEqual(cons.custos.cobertura, 0.8);
});
check("snapshot do cliente sem detalhamento: nada é afirmado sobre a base", () => {
  const cons = consolidarCliente({ contas: [], snapshot: { faturamento: 10, lucroContribuicao: 1, lucroContribuicaoPresente: true } });
  assert.strictEqual(cons.custos, null);
});

// ── E. Endpoint: lote, mesmo import da lista, escopo do Painel ─────────────
const originalQuery = pool.query;
const tags = [];
pool.query = async (sql, params = []) => {
  const q = String(sql).replace(/\s+/g, " ");
  const tag = (q.match(/\/\* (\S+) \*\//) || [])[1];
  tags.push(tag);
  if (tag === "authz:RESOLVE_CLIENTE_ID") return { rows: [{ id: 7, slug: "amr", nome: "AMR", ativo: true }] };
  if (tag === "painelAcesso:PODE_VER_CLIENTE") return { rows: [] };
  if (tag === "painelContas:CONTAS_DOS_CLIENTES") return { rows: [
    { id: 11, cliente_id: 7, marketplace: "meli", nome: "Loja 1", ativo: true, external_account_id: "1" },
    { id: 12, cliente_id: 7, marketplace: "meli", nome: "Loja 2", ativo: false, external_account_id: "2" },
    { id: 13, cliente_id: 7, marketplace: "meli", nome: "Loja 3", ativo: true, external_account_id: "3" },
    { id: 14, cliente_id: 7, marketplace: "shopee", nome: "Shopee", ativo: true },
  ] };
  if (tag === "painelContas:IMPORTS_DA_COMPETENCIA") {
    assert.deepStrictEqual(params[0], [11, 13, 14], "só contas ativas");
    return { rows: [
      { id: 201, cliente_conta_id: 11, competencia: "2026-09", publication_status: "published", coverage_date_from: "2026-09-01", coverage_date_to: "2026-09-29", published_at: "2026-09-30T05:00:00Z", faturamento: "100.00" },
      // Mais antigo da mesma conta: a regra M4 escolhe o 201.
      { id: 199, cliente_conta_id: 11, competencia: "2026-09", publication_status: "published", coverage_date_from: "2026-09-01", coverage_date_to: "2026-09-20", published_at: "2026-09-21T05:00:00Z", faturamento: "50.00" },
      { id: 202, cliente_conta_id: 13, competencia: "2026-09", publication_status: "published", coverage_date_from: "2026-09-01", coverage_date_to: "2026-09-30", published_at: "2026-10-01T05:00:00Z", faturamento: "30.00" },
    ] };
  }
  if (tag === "painelContas:COMPOSICAO_DOS_IMPORTS") {
    assert.deepStrictEqual([...params[0]].sort(), [201, 202]);
    return { rows: [
      { import_id: 201, status: "paid", pos_venda_tipo: null, pedidos: 2, sem_valor: 0, faturamento: "100.00" },
      { import_id: 201, status: "com_problema", pos_venda_tipo: "mediacao", pedidos: 1, sem_valor: 0, faturamento: "25.00" },
      { import_id: 202, status: "paid", pos_venda_tipo: null, pedidos: 1, sem_valor: 0, faturamento: "30.00" },
    ] };
  }
  if (tag === "painelContas:COMPOSICAO_SOBREPOSICAO") return { rows: [{ pedidos: 0, valor: 0 }] };
  // A tabela de vínculos não existe nesta fixture (reuso desligado).
  if (/to_regclass\('public\.central_vendas_import_pedidos'\)/.test(String(q))) return { rows: [{ ok: false }] };
  throw new Error(`Query inesperada: ${q}`);
};

const service = require("../services/painelContas/painelContasService");

(async () => {
  console.log("E. endpoint");
  try {
    const r = await service.listarComposicaoDasContas({ id: 1, role: "admin" }, "7", "2026-09");
    check("contas ativas, rótulo igual ao da lista, conta sem import com motivo", () => {
      assert.deepStrictEqual(r.contas.map((c) => c.contaId), [11, 13, 14]);
      assert.strictEqual(r.contas[1].rotulo, "Mercado Livre 3 · Loja 3");
      assert.strictEqual(r.contas[2].composicao, null);
      assert.ok(r.contas[2].motivo);
    });
    check("cada conta usa o import escolhido pela lista e fecha sozinha", () => {
      const c11 = r.contas[0].composicao;
      assert.strictEqual(c11.importId, 201);
      assert.deepStrictEqual(c11.bruto, { pedidos: 3, valor: 125 });
      assert.deepStrictEqual(c11.exclusoes.mediacoes, { pedidos: 1, valor: 25 });
      assert.strictEqual(c11.fat, 100);
      assert.strictEqual(c11.reconciliacao.fecha, true);
      assert.strictEqual(r.contas[1].composicao.reconciliacao.fecha, true);
    });
    check("soma das contas ao lado (não no lugar) das contas", () => {
      assert.strictEqual(r.somaDasContas.contas, 2);
      assert.strictEqual(r.somaDasContas.fat, 130);
      assert.strictEqual(r.somaDasContas.bruto.valor, 155);
      assert.strictEqual(r.somaDasContas.periodo.diferente, true);
    });
    check("composição em duas queries de lote", () => {
      assert.strictEqual(tags.filter((t) => t === "painelContas:COMPOSICAO_DOS_IMPORTS").length, 1);
      assert.strictEqual(tags.filter((t) => t === "painelContas:COMPOSICAO_SOBREPOSICAO").length, 1);
    });

    await assert.rejects(
      () => service.listarComposicaoDasContas({ id: 1, role: "admin" }, "7", "2026-9"),
      (e) => e.statusCode === 400 && e.code === "COMPETENCIA_INVALIDA"
    );
    check("competência inválida → 400", () => {});

    await assert.rejects(
      () => service.listarComposicaoDasContas({ id: 5, role: "membro" }, "7", "2026-09"),
      (e) => e.statusCode === 403 && e.code === "CLIENTE_FORA_DA_CARTEIRA"
    );
    check("fora do escopo do Painel → 403, antes de ler qualquer pedido", () => {
      assert.strictEqual(tags[tags.length - 1], "painelAcesso:PODE_VER_CLIENTE");
    });

    console.log(`\npainelContasComposicao.test.js: ${ok} verificações OK.`);
  } finally {
    pool.query = originalQuery;
  }
})().catch((err) => {
  pool.query = originalQuery;
  console.error(err);
  process.exitCode = 1;
});
