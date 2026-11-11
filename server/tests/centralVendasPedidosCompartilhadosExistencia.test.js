// server/tests/centralVendasPedidosCompartilhadosExistencia.test.js
//
// Regressão do achado P1 da revisão independente: a checagem de existência da
// tabela de vínculos (central_vendas_import_pedidos) NÃO pode transformar um
// erro transitório em "tabela ausente" nem congelar um negativo.
//
//   1. erro (timeout, conexão caída) PROPAGA — nunca vira `false`;
//   2. recuperação: depois do erro, a próxima chamada pergunta de novo;
//   3. transição da migration: negativo confirmado NUNCA é cacheado — assim que
//      a tabela passa a existir, a leitura seguinte já enxerga os vínculos;
//   4. positivo fica em cache (sem nova consulta);
//   5. resposta sem booleano é indeterminada ⇒ erro;
//   6. um erro durante a reconstrução do snapshot do Cliente 360 NÃO persiste
//      snapshot (upsert não chamado) e fecha o job como erro;
//   7. depois da recuperação, o snapshot sai completo (inclui pedido vinculado).
//
// Sem banco real: db injetado; DATABASE_URL aponta para porta morta.

process.env.DATABASE_URL = "postgres://nobody@127.0.0.1:1/teste-sem-banco";

const assert = require("assert");
const pc = require("../services/centralVendas/centralVendasPedidosCompartilhados");
const adapter = require("../services/centralVendas/centralVendasCliente360Adapter");
const { buildResumoCentralVendas } = require("../services/centralVendas/centralVendasImportService");
const { calcularTacos } = require("../services/cliente360/cliente360SyncService");

let checks = 0;
const ok = (label, c) => { assert.ok(c, `FALHOU: ${label}`); checks += 1; };
const eq = (label, a, b) => { assert.deepStrictEqual(a, b, `FALHOU: ${label} — recebido ${JSON.stringify(a)}`); checks += 1; };
async function rejeita(label, fn, trecho) {
  let erro = null;
  try { await fn(); } catch (e) { erro = e; }
  ok(`${label} (rejeitou)`, erro && String(erro.message).includes(trecho));
}

// db programável: `respostas` é consumida na ordem; função = lança/retorna.
function dbSequencial(respostas) {
  const chamadas = [];
  return {
    chamadas,
    async query(sql, params) {
      chamadas.push(sql);
      if (!sql.includes("to_regclass")) throw new Error(`SQL inesperado: ${sql.slice(0, 60)}`);
      const r = respostas.length > 1 ? respostas.shift() : respostas[0];
      if (r instanceof Error) throw r;
      return r;
    },
  };
}
const NAO = { rows: [{ ok: false }] };
const SIM = { rows: [{ ok: true }] };

async function run() {
  // 1 + 2 — erro propaga e a recuperação consulta de novo.
  {
    const db = dbSequencial([new Error("timeout de statement"), SIM]);
    await rejeita("erro transitório propaga", () => pc.tabelaVinculosDisponivel(db), "timeout de statement");
    eq("erro não é cacheado: nova chamada consulta de novo e enxerga a tabela", await pc.tabelaVinculosDisponivel(db), true);
    eq("duas consultas ao PostgreSQL", db.chamadas.length, 2);
  }
  {
    const db = dbSequencial([new Error("Connection terminated unexpectedly"), NAO]);
    await rejeita("conexão interrompida propaga", () => pc.tabelaVinculosDisponivel(db), "Connection terminated");
    eq("após a queda, ausência confirmada devolve false", await pc.tabelaVinculosDisponivel(db), false);
  }
  // 3 — transição da migration: negativo nunca congela.
  {
    const db = dbSequencial([NAO, NAO, SIM]);
    eq("antes da migration: ausente", await pc.tabelaVinculosDisponivel(db), false);
    eq("ainda ausente (confirmado de novo, sem cache)", await pc.tabelaVinculosDisponivel(db), false);
    eq("migration aplicada: a PRÓXIMA leitura já vê a tabela (sem janela de 60 s)", await pc.tabelaVinculosDisponivel(db), true);
    eq("cada negativo consultou o PostgreSQL", db.chamadas.length, 3);
  }
  // 4 — positivo em cache.
  {
    const db = dbSequencial([SIM]);
    await pc.tabelaVinculosDisponivel(db);
    await pc.tabelaVinculosDisponivel(db);
    await pc.tabelaVinculosDisponivel(db);
    eq("positivo consulta uma única vez", db.chamadas.length, 1);
  }
  // 5 — resposta indeterminada.
  for (const [nome, resp] of [["sem linhas", { rows: [] }], ["ok não booleano", { rows: [{ ok: "t" }] }], ["sem rows", {}]]) {
    await rejeita(`resposta indeterminada (${nome}) é erro`, () => pc.tabelaVinculosDisponivel(dbSequencial([resp])), "EXISTENCIA_INDETERMINADA");
  }

  // 6 + 7 — Cliente 360: nenhum snapshot parcial.
  const pedidosProprios = [{ id: 1, import_id: 501, data_pedido: "2026-09-02", status: "paid", confianca: "confiavel", faturamento: "100.00", lc: 20 }];
  const pedidoVinculado = { id: 2, import_id: 501, data_pedido: "2026-09-03", status: "paid", confianca: "confiavel", faturamento: "50.00", lc: 10 };
  const todos = [...pedidosProprios, pedidoVinculado]; // o 2º só aparece pela tabela de vínculos
  const imp = {
    id: 501, competencia: "2026-09", cliente_conta_id: 1, publication_status: "published",
    published_at: "2026-09-24T06:05:00Z", coverage_date_from: "2026-09-01", coverage_date_to: "2026-09-23", sync_run_id: 1501,
    resumo_json: buildResumoCentralVendas({ pedidos: todos, resumo: { lucroContribuicao: 30 } }),
  };
  function depsDoCliente360(respostasRegclass) {
    const chamadas = { upsert: [], finalize: [] };
    const reg = respostasRegclass.slice();
    const deps = {
      db: {
        async query(sql) {
          if (sql.includes("to_regclass")) {
            const r = reg.length > 1 ? reg.shift() : reg[0];
            if (r instanceof Error) throw r;
            return r;
          }
          if (sql.includes("FROM central_vendas_pedido_itens")) return { rows: [] };
          if (sql.includes("FROM central_vendas_pedidos")) {
            // com vínculos: próprios ∪ vinculados; sem: só próprios (SQL antigo)
            const comVinculos = sql.includes("central_vendas_import_pedidos");
            return { rows: (comVinculos ? todos : pedidosProprios).map(({ lc, ...r }) => r) };
          }
          if (sql.includes("FROM entregas_cliente")) return { rows: [] };
          throw new Error(`SQL inesperado: ${sql.slice(0, 80)}`);
        },
      },
      async resolveImportsForRange() { return { imports: [imp] }; },
      async ensureCliente360Tables() {},
      async findResumoMensal() { return null; },
      async upsertResumoMensal(p) { chamadas.upsert.push(p); return { ...p, sincronizado_em: "2026-09-24T06:10:00.000Z" }; },
      async lockSyncJob() { return { job: { id: 55 } }; },
      async finalizeSyncJob(...a) { chamadas.finalize.push(a); },
      async findRelatoriosByCliente() { return []; },
      async countDiagnosticos() { return 0; },
      async consolidarAdsMes() { return { disponivel: false, adsInvestido: null, updatedAt: null }; },
      async consolidarFechamentosMes() { return 0; },
      calcularTacos,
    };
    return { deps, chamadas };
  }
  const args = { cliente: { id: 10, slug: "alfa" }, competencia: "2026-09", contas: [{ clienteContaId: 1 }], segmento: { dateFrom: "2026-09-01", dateTo: "2026-09-23" } };

  {
    // Falha transitória: a checagem de existência lança (db do adaptador é
    // um objeto novo ⇒ sem cache de positivo).
    const { deps, chamadas } = depsDoCliente360([new Error("canceling statement due to statement timeout")]);
    await rejeita("Cliente 360: falha na checagem de vínculos aborta a reconstrução", () => adapter.reconstruirSnapshotMensal(args, deps), "statement timeout");
    eq("Cliente 360: NENHUM snapshot persistido após a falha", chamadas.upsert.length, 0);
    eq("Cliente 360: job fechado como erro", chamadas.finalize.map((f) => f[1]), ["erro"]);
  }
  {
    // Recuperação: a mesma chamada depois que o PostgreSQL volta, com a tabela
    // existindo e um pedido que só aparece por vínculo ⇒ snapshot COMPLETO.
    const { deps, chamadas } = depsDoCliente360([SIM]);
    const r = await adapter.reconstruirSnapshotMensal(args, deps);
    eq("Cliente 360: recuperado, atualiza", r.atualizado, true);
    eq("Cliente 360: snapshot inclui o pedido vinculado (2 pedidos, FAT 150)", [chamadas.upsert[0].pedidos, chamadas.upsert[0].faturamento], [2, 150]);
    eq("Cliente 360: job ok", chamadas.finalize.map((f) => f[1]), ["ok"]);
  }
  {
    // Tabela realmente ausente (confirmada): comportamento de antes, só próprios.
    const { deps, chamadas } = depsDoCliente360([NAO]);
    const r = await adapter.reconstruirSnapshotMensal(args, deps);
    eq("Cliente 360: tabela ausente confirmada ⇒ SQL antigo (1 pedido)", [r.atualizado, chamadas.upsert[0].pedidos], [true, 1]);
  }

  console.log(`centralVendasPedidosCompartilhadosExistencia.test.js: ${checks} verificacoes OK`);
}
run().catch((err) => { console.error(err); process.exit(1); });
