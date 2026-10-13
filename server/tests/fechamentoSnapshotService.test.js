// server/tests/fechamentoSnapshotService.test.js
//
// Regras do service do snapshot (sem banco: repo/cliente/conta injetados):
// selo obrigatório e ligado ao contexto, conta do cliente e do marketplace,
// competência canônica, TODAS as linhas gravadas, contas nunca misturadas,
// auditoria em activity_logs só quando cria.

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://127.0.0.1:1/x";
delete process.env.NODE_ENV;
process.env.JWT_SECRET = "segredo-de-teste-com-tamanho-suficiente-123";

const assert = require("assert");
const svc = require("../services/fechamentoSnapshot/fechamentoSnapshotService");
const { selarProcessamento } = require("../services/fechamentoSnapshot/seloProcessamento");

let checks = 0;
async function caso(label, fn) {
  await fn();
  checks += 1;
  console.log(`  ok  ${label}`);
}

const CLIENTES = { zorza: { id: 1, slug: "zorza", nome: "Zorza" }, outro: { id: 2, slug: "outro", nome: "Outro" } };
const CONTAS = {
  121: { id: 121, cliente_id: 1, marketplace: "shopee", nome: "Zorza Shopee", ativo: true },
  122: { id: 122, cliente_id: 1, marketplace: "meli", nome: "Zorza ML", ativo: true },
  130: { id: 130, cliente_id: 2, marketplace: "shopee", nome: "Outro Shopee", ativo: true },
  131: { id: 131, cliente_id: 1, marketplace: "shopee", nome: "Desativada", ativo: false },
};

function deps() {
  const gravados = [];
  const logs = [];
  return {
    gravados,
    logs,
    resolverClientePorIdOuSlug: async ({ clienteSlug }) => {
      const c = CLIENTES[clienteSlug];
      if (!c) throw Object.assign(new Error("Cliente não encontrado."), { statusCode: 404 });
      return c;
    },
    obterConta: async (id) => {
      const c = CONTAS[id];
      if (!c) throw Object.assign(new Error("Conta não encontrada."), { statusCode: 404 });
      return c;
    },
    registrarLog: (l) => logs.push(l),
    repo: {
      async criarSnapshot(meta, itens) {
        const mesmaChave = gravados.filter((g) => g.meta.clienteContaId === meta.clienteContaId && g.meta.periodo === meta.periodo);
        const ultima = mesmaChave[mesmaChave.length - 1];
        if (ultima && ultima.meta.selo === meta.selo) return { snapshot: ultima.row, reaproveitado: true };
        const row = {
          id: gravados.length + 1, cliente_id: meta.clienteId, cliente_slug: meta.clienteSlug, cliente_conta_id: meta.clienteContaId,
          marketplace: meta.marketplace, periodo: meta.periodo, revisao: mesmaChave.length + 1, total_itens: itens.length,
          contagens_json: meta.contagens, origem_custos_json: meta.origemCustos, ajustes_json: meta.ajustes, arquivos_json: meta.arquivos,
          origem: meta.origem, processado_em: meta.processadoEm, created_at: "2026-10-13T17:31:00Z", entregas: [],
        };
        gravados.push({ meta, itens, row });
        return { snapshot: row, reaproveitado: false };
      },
      async listarSnapshotsDaConta({ clienteContaId }) {
        return gravados.filter((g) => g.meta.clienteContaId === clienteContaId).map((g) => ({ ...g.row, summary_json: g.meta.summary }));
      },
    },
  };
}

const linhas = (n) => Array.from({ length: n }, (_, i) => ({
  "ID do pedido": `25090100000${i}`, Produto: `P${i}`, SKU: `S${i}`, "Receita bruta": 10, CMV: i % 4 === 0 ? null : 3,
  LC: i % 4 === 0 ? null : 2, MC: i % 4 === 0 ? null : 20, "Match de custo": i % 4 === 0 ? "miss" : "direct_sku",
  "Cobertura de custo": i % 4 === 0 ? "sem custo" : "com custo",
}));

// O que o frontend recebe do processamento e devolve ao salvar.
function processado({ contexto, n = 130, summary = { finalResult: 25000, calculatedCoveragePercent: 91 } } = {}) {
  const ctx = { clienteSlug: "zorza", clienteContaId: 121, periodo: "2026-09", marketplace: "shopee", ...contexto };
  const resposta = { ok: true, summary, detailedRows: linhas(n), unmatchedIds: ["X"], competencia: { periodoDetectado: "2026-09" }, costsSource: "base", costsBase: { id: 9, slug: "b", nome: "zorza shopee 3" } };
  resposta.processamento = selarProcessamento({
    contexto: ctx, resultado: resposta, usuarioId: 3, ajustes: { ads: 20 }, arquivos: [{ tipo: "vendas", sha256: "a".repeat(64) }], costRowsRaw: [{ a: 1 }],
  });
  const volta = JSON.parse(JSON.stringify(resposta));
  const { processamento, ...resultado } = volta;
  return { body: { ...ctx, resultado, processamento } };
}

const USER = { id: 3, email: "op@venforce", nome: "Operador" };

async function main() {
  console.log("\n▸ criar");
  await caso("v1 com TODAS as 130 linhas (não 50), contagens e auditoria", async () => {
    const d = deps();
    const r = await svc.criarSnapshot({ user: USER, ...processado() }, d);
    assert.strictEqual(r.snapshot.revisao, 1);
    assert.strictEqual(d.gravados[0].itens.length, 130);
    assert.strictEqual(r.snapshot.totalItens, 130);
    assert.strictEqual(d.gravados[0].itens[129].ordem, 130);
    assert.strictEqual(d.gravados[0].meta.contagens.sem_custo, 33);
    assert.strictEqual(d.gravados[0].meta.origemCustos.costsBase.nome, "zorza shopee 3");
    assert.strictEqual(d.gravados[0].meta.ajustes.ads, 20);
    assert.deepStrictEqual(d.gravados[0].meta.diagnostico.unmatchedIds, ["X"]);
    assert.ok(!("summary" in d.gravados[0].meta.diagnostico) && !("detailedRows" in d.gravados[0].meta.diagnostico));
    assert.strictEqual(d.logs.length, 1);
    assert.strictEqual(d.logs[0].acao, "financeiro_snapshot_criado");
    assert.strictEqual(d.logs[0].detalhes.revisao, 1);
  });

  await caso("v2 depois de reprocessar; reenviar o MESMO processamento não cria v3 nem novo log", async () => {
    const d = deps();
    await svc.criarSnapshot({ user: USER, ...processado() }, d);
    const p2 = processado({ summary: { finalResult: 29500, calculatedCoveragePercent: 98 } });
    const v2 = await svc.criarSnapshot({ user: USER, ...p2 }, d);
    assert.strictEqual(v2.snapshot.revisao, 2);
    const de = await svc.criarSnapshot({ user: USER, ...p2 }, d);
    assert.strictEqual(de.reaproveitado, true);
    assert.strictEqual(de.snapshot.revisao, 2);
    assert.strictEqual(d.logs.length, 2);
  });

  await caso("IDs longos ficam texto e null fica null na linha gravada", async () => {
    const d = deps();
    await svc.criarSnapshot({ user: USER, ...processado({ n: 5 }) }, d);
    const l0 = d.gravados[0].itens[0].linha;
    assert.strictEqual(l0["ID do pedido"], "250901000000");
    assert.strictEqual(l0.LC, null);
    assert.strictEqual(d.gravados[0].itens[0].lc, null);
  });

  console.log("\n▸ recusas");
  const recusa = async (label, body, code, { status } = {}) => caso(label, async () => {
    await assert.rejects(() => svc.criarSnapshot({ user: USER, body }, deps()), (e) => {
      assert.strictEqual(e.code, code, `${e.code} ≠ ${code}`);
      if (status) assert.strictEqual(e.statusCode, status);
      return true;
    });
  });
  const base = processado().body;
  await recusa("número alterado no navegador → SELO_INVALIDO", { ...base, resultado: { ...base.resultado, summary: { ...base.resultado.summary, finalResult: 99999 } } }, "SELO_INVALIDO", { status: 409 });
  await recusa("linha removida → SELO_INVALIDO", { ...base, resultado: { ...base.resultado, detailedRows: base.resultado.detailedRows.slice(0, 50) } }, "SELO_INVALIDO");
  await recusa("sem selo → SELO_INVALIDO", { ...base, processamento: { ...base.processamento, selo: undefined } }, "SELO_INVALIDO");
  await recusa("processado na conta 121, salvo na 131 (mesmo cliente) → recusado", { ...base, clienteContaId: 131 }, "CONTA_INATIVA");
  await recusa("conta de OUTRO cliente → CONTA_NAO_PERTENCE_AO_CLIENTE", { ...base, clienteContaId: 130 }, "CONTA_NAO_PERTENCE_AO_CLIENTE");
  await recusa("conta MELI com fechamento Shopee → MARKETPLACE_DIVERGENTE", { ...base, clienteContaId: 122 }, "MARKETPLACE_DIVERGENTE");
  await recusa("competência fora do formato AAAA-MM → COMPETENCIA_INVALIDA", { ...base, periodo: "qualquer" }, "COMPETENCIA_INVALIDA");
  await recusa("sem conta → CONTA_OBRIGATORIA", { ...base, clienteContaId: null }, "CONTA_OBRIGATORIA");
  await recusa("sem resultado → PROCESSAMENTO_AUSENTE", { ...base, resultado: null }, "PROCESSAMENTO_AUSENTE");
  await caso("processado como Agosto, salvo como Setembro → SELO_INVALIDO", async () => {
    const p = processado({ contexto: { periodo: "2026-08" } });
    await assert.rejects(() => svc.criarSnapshot({ user: USER, body: { ...p.body, periodo: "2026-09" } }, deps()), (e) => e.code === "SELO_INVALIDO");
  });

  console.log("\n▸ listar");
  await caso("lista é da CONTA: snapshots de outra conta do mesmo cliente nunca aparecem", async () => {
    const d = deps();
    await svc.criarSnapshot({ user: USER, ...processado() }, d);
    const meli = processado({ contexto: { clienteContaId: 122, marketplace: "meli" } });
    await svc.criarSnapshot({ user: USER, ...meli }, d);
    const lista = await svc.listarSnapshots({ query: { cliente_slug: "zorza", cliente_conta_id: "121" } }, d);
    assert.strictEqual(lista.length, 1);
    assert.strictEqual(lista[0].clienteContaId, 121);
    assert.strictEqual(lista[0].summary.finalResult, 25000);
    await assert.rejects(() => svc.listarSnapshots({ query: { cliente_slug: "outro", cliente_conta_id: "121" } }, d), (e) => e.code === "CONTA_NAO_PERTENCE_AO_CLIENTE");
  });

  console.log("\n▸ itens");
  await caso("paginação limitada a 200 por página e filtro desconhecido recusado", async () => {
    let pedido = null;
    const d = { repo: { listarItens: async (p) => { pedido = p; return { total: 0, itens: [] }; } } };
    await svc.listarItensDoSnapshot({ id: 5, query: { limit: "9999", offset: "-3", busca: "  Algodão " } }, d);
    assert.deepStrictEqual(pedido, { snapshotId: 5, offset: 0, limit: 200, status: null, busca: "algodao" });
    await assert.rejects(() => svc.listarItensDoSnapshot({ id: 5, query: { status: "drop table" } }, d), (e) => e.code === "FILTRO_INVALIDO");
  });

  console.log(`\n${checks} verificações OK`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
