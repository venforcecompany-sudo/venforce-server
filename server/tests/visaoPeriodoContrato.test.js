// server/tests/visaoPeriodoContrato.test.js
//
// V3 P2.5 — GET /operacao/visao/:cliente e o contrato de competência.
//
// Duas regressões travadas aqui:
//
//   1. `parseCompetencia(periodoRaw) || competenciaAtual()` tratava "não
//      mandou" e "mandou errado" da mesma forma. `?periodo=lixo` respondia o
//      MÊS ATUAL em silêncio: o usuário pedia Julho e recebia Agosto, rotulado
//      como se fosse o que ele pediu. Agora inválido é 400 e ausente é
//      declarado em `contexto.periodoInferido`.
//
//   2. O bloco `fechamento` usava `String(e.periodo).includes(competencia)`,
//      então uma entrega gravada como "2026-07 a 2026-08" respondia por Julho
//      E por Agosto.

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/vf-test";

const assert = require("assert");
const { obterVisao, resolverPeriodo } = require("../services/visaoService");
const { competenciaAtual } = require("../utils/periodoUtils");

let checks = 0;
function ok(label, condition) {
  assert.ok(condition, `FALHOU: ${label}`);
  checks += 1;
  console.log(`  ok  ${label}`);
}
async function rejeitaCom(label, promise, verificar) {
  let erro = null;
  try { await promise; } catch (e) { erro = e; }
  assert.ok(erro, `FALHOU (nao rejeitou): ${label}`);
  if (verificar) assert.ok(verificar(erro), `FALHOU (erro inesperado): ${label} — ${erro.message} / code=${erro.code}`);
  checks += 1;
  console.log(`  ok  ${label}`);
}

const cliente = { id: 1, slug: "n97", nome: "N97", ativo: true };
const contaMeli = { id: 10, cliente_id: 1, marketplace: "meli", nome: "ML 1", ativo: true };

function depsBase(overrides = {}) {
  return {
    resolverClientePorIdOuSlug: async () => cliente,
    obterConta: async () => contaMeli,
    sanitizarConta: (r) => r,
    getCliente360: async () => ({ ok: true }),
    getCentralVendasReadBootstrap: async () => ({ ok: true }),
    obterResumoMargem: async () => ({ ok: true }),
    buscarPerformanceML: async () => ({ ok: true }),
    listarEntregas: async () => ({ ok: true, entregas: [] }),
    listarSyncRuns: async () => ({ ok: true, runs: [] }),
    ...overrides,
  };
}

async function run() {
  // ------------------------------------------------------------ BLOCO C
  await rejeitaCom("periodo invalido → 400 PERIODO_INVALIDO (era o mes atual em silencio)",
    obterVisao({ clienteSlugRaw: "n97", clienteContaIdRaw: "10", periodoRaw: "lixo" }, depsBase()),
    (e) => e.statusCode === 400 && e.code === "PERIODO_INVALIDO");

  await rejeitaCom("periodo 'agosto-2026' tambem e 400 (contrato e YYYY-MM)",
    obterVisao({ clienteSlugRaw: "n97", clienteContaIdRaw: "10", periodoRaw: "agosto-2026" }, depsBase()),
    (e) => e.statusCode === 400 && e.code === "PERIODO_INVALIDO");

  await rejeitaCom("mes 13 e 400, nao vira outro mes",
    obterVisao({ clienteSlugRaw: "n97", clienteContaIdRaw: "10", periodoRaw: "2026-13" }, depsBase()),
    (e) => e.statusCode === 400 && e.code === "PERIODO_INVALIDO");

  // Ausente continua compativel (o contrato sempre permitiu omitir), mas
  // DECLARADO — inferir e avisar e diferente de inferir em silencio.
  {
    const r = await obterVisao({ clienteSlugRaw: "n97", clienteContaIdRaw: "10", periodoRaw: undefined }, depsBase());
    ok("periodo ausente continua caindo no mes corrente (compatibilidade)", r.contexto.competencia === competenciaAtual().competencia);
    ok("...mas isso e DECLARADO em contexto.periodoInferido", r.contexto.periodoInferido === true);
  }
  {
    const r = await obterVisao({ clienteSlugRaw: "n97", clienteContaIdRaw: "10", periodoRaw: "2026-08" }, depsBase());
    ok("periodo informado NAO e marcado como inferido", r.contexto.periodoInferido === false);
    ok("contexto ecoa exatamente a competencia pedida", r.contexto.competencia === "2026-08");
  }

  // resolverPeriodo isolado
  {
    const p = resolverPeriodo("2026-02");
    ok("resolverPeriodo devolve o mes inteiro da competencia", p.dateFrom === "2026-02-01" && p.dateTo === "2026-02-28");
    ok("resolverPeriodo marca inferido=false quando informado", p.inferido === false);
  }
  {
    const p = resolverPeriodo(undefined);
    ok("resolverPeriodo marca inferido=true quando ausente", p.inferido === true);
  }

  // ------------------------------------------------------------ BLOCO E
  {
    const deps = depsBase({
      listarEntregas: async () => ({ ok: true, entregas: [
        { id: 1, periodo: "2026-07 a 2026-08", status: "publicado" },
      ] }),
    });
    const julho = await obterVisao({ clienteSlugRaw: "n97", clienteContaIdRaw: "10", periodoRaw: "2026-07" }, deps);
    ok("intervalo ambiguo NAO responde por Julho na Visao", julho.fechamento.dados === null);
    const agosto = await obterVisao({ clienteSlugRaw: "n97", clienteContaIdRaw: "10", periodoRaw: "2026-08" }, deps);
    ok("intervalo ambiguo NAO responde por Agosto na Visao", agosto.fechamento.dados === null);
  }
  {
    const deps = depsBase({
      listarEntregas: async () => ({ ok: true, entregas: [
        { id: 1, periodo: "Julho 2026", status: "publicado" },
        { id: 2, periodo: "Agosto 2026", status: "rascunho" },
      ] }),
    });
    const julho = await obterVisao({ clienteSlugRaw: "n97", clienteContaIdRaw: "10", periodoRaw: "2026-07" }, deps);
    ok("formato legado do Portal ('Julho 2026') passa a ser encontrado", julho.fechamento.dados?.id === 1);
  }
  {
    // Duplicata na mesma competencia: publicada vence, ordem deterministica.
    const deps = depsBase({
      listarEntregas: async () => ({ ok: true, entregas: [
        { id: 1, periodo: "2026-08", status: "rascunho", publicado: false, created_at: "2026-09-02T10:00:00Z" },
        { id: 2, periodo: "2026-08", status: "publicado", publicado: true, created_at: "2026-09-01T10:00:00Z" },
      ] }),
    });
    const r = await obterVisao({ clienteSlugRaw: "n97", clienteContaIdRaw: "10", periodoRaw: "2026-08" }, deps);
    ok("duplicata na Visao: publicada vence, escolha deterministica", r.fechamento.dados?.id === 2);
  }

  // Escopo declarado dos blocos continua honesto (P2.5 nao "promove" nada).
  {
    const r = await obterVisao({ clienteSlugRaw: "n97", clienteContaIdRaw: "10", periodoRaw: "2026-08" }, depsBase());
    ok("saude continua client-level declarado", r.saude.escopoConta === false);
    ok("resultado (Central de Vendas) e account-aware", r.resultado.escopoConta === true);
    ok("margem recebe a Conta selecionada", r.margem.escopoConta === true);
    ok("ads e account-aware", r.ads.escopoConta === true);
    ok("fechamento continua client-level (entregas_cliente sem cliente_conta_id)", r.fechamento.escopoConta === false);
    ok("atividade e account-aware", r.atividade.escopoConta === true);
  }

  console.log(`\nvisaoPeriodoContrato.test.js: ${checks} verificacoes passaram.`);
}

run().catch((err) => { console.error(err); process.exitCode = 1; });
