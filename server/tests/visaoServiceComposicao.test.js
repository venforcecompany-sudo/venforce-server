// server/tests/visaoServiceComposicao.test.js
//
// GET /operacao/visao/:cliente (VenForce V3 Master Spec §11.4, §18.3) —
// composição server-side de fontes já existentes. Usa injeção de
// dependência (mesmo padrão de motorMargemService.obterResumo(params,deps)
// e centralVendasSyncService) para testar a composição sem precisar mockar
// SQL de 6 serviços diferentes até o fundo.

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/vf-test";

const assert = require("assert");
const { obterVisao } = require("../services/visaoService");

let checks = 0;
function ok(label, condition) {
  assert.ok(condition, `FALHOU: ${label}`);
  checks += 1;
  console.log(`  ok  ${label}`);
}
async function rejeitaCom(label, promise, verificar) {
  let erro = null;
  try {
    await promise;
  } catch (e) {
    erro = e;
  }
  assert.ok(erro, `FALHOU (não rejeitou): ${label}`);
  if (verificar) assert.ok(verificar(erro), `FALHOU (erro inesperado): ${label} — ${erro.message}`);
  checks += 1;
  console.log(`  ok  ${label}`);
}

const cliente = { id: 1, nome: "N97 Comercial", slug: "n97", ativo: true };
const contaMeli = { id: 10, cliente_id: 1, marketplace: "meli", nome: "ML 1", ativo: true, external_account_id: "111", externalAccountLabel: null };
const contaShopee = { id: 11, cliente_id: 1, marketplace: "shopee", nome: "Shopee", ativo: true, external_account_id: null, externalAccountLabel: null };
const contaInativa = { id: 12, cliente_id: 1, marketplace: "meli", nome: "ML velha", ativo: false };
const contaDeOutroCliente = { id: 13, cliente_id: 999, marketplace: "meli", nome: "Outro", ativo: true };

function depsBase(overrides = {}) {
  return {
    resolverClientePorIdOuSlug: async () => cliente,
    obterConta: async (id) => {
      const todas = [contaMeli, contaShopee, contaInativa, contaDeOutroCliente];
      const c = todas.find((x) => x.id === Number(id));
      if (!c) { const e = new Error("Conta não encontrada."); e.statusCode = 404; throw e; }
      return c;
    },
    sanitizarConta: (row) => row,
    getCliente360: async () => ({ ok: true, saude: "pronto" }),
    getCentralVendasReadBootstrap: async () => ({ ok: true, summary: { faturamento: 1000 } }),
    obterResumoMargem: async () => ({ ok: true, placar: { margemMedia: 0.2 } }),
    buscarPerformanceML: async () => ({ codigo: "OK", investimentoAds: 50 }),
    listarEntregas: async () => ({ ok: true, entregas: [] }),
    listarSyncRuns: async () => ([{ id: 1, status: "completed" }]),
    ...overrides,
  };
}

async function run() {
  // 1. Caminho feliz, conta MELI: todos os blocos aplicáveis e disponíveis,
  //    com escopoConta correto por bloco.
  {
    const resultado = await obterVisao({ clienteSlugRaw: "n97", clienteContaIdRaw: "10", periodoRaw: "2026-08" }, depsBase());
    ok("contexto reflete a conta e o marketplace derivado dela", resultado.contexto.clienteContaId === 10 && resultado.contexto.marketplace === "meli");
    ok("saude disponível, escopoConta=false (Cliente 360 não é account-aware)", resultado.saude.disponivel === true && resultado.saude.escopoConta === false);
    ok("resultado (Central de Vendas) disponível, escopoConta=true", resultado.resultado.disponivel === true && resultado.resultado.escopoConta === true);
    ok("margem disponível para MELI, escopoConta=true", resultado.margem.disponivel === true && resultado.margem.escopoConta === true);
    ok("ads disponível para MELI, escopoConta=true", resultado.ads.disponivel === true && resultado.ads.escopoConta === true);
    ok("atividade (sync runs) disponível, escopoConta=true", resultado.atividade.disponivel === true && resultado.atividade.escopoConta === true);
  }

  // 2. Conta Shopee: margem e ads são ML-only — nunca tentados, marcados
  //    indisponível com motivo explícito, nunca como se tivessem falhado.
  {
    const deps = depsBase({
      obterResumoMargem: async () => { throw new Error("não deveria ser chamado para Shopee"); },
      buscarPerformanceML: async () => { throw new Error("não deveria ser chamado para Shopee"); },
    });
    const resultado = await obterVisao({ clienteSlugRaw: "n97", clienteContaIdRaw: "11", periodoRaw: "2026-08" }, deps);
    ok("margem indisponível para Shopee, com motivo (não erro)", resultado.margem.disponivel === false && /Mercado Livre/.test(resultado.margem.motivo));
    ok("ads indisponível para Shopee, com motivo (não erro)", resultado.ads.disponivel === false && /Mercado Livre/.test(resultado.ads.motivo));
    ok("Central de Vendas continua disponível (multi-marketplace)", resultado.resultado.disponivel === true);
  }

  // 3. Conta desativada → 409 CONTA_INATIVA, nenhum bloco é sequer tentado.
  {
    let chamouAlgumBloco = false;
    const deps = depsBase({
      getCliente360: async () => { chamouAlgumBloco = true; return {}; },
      getCentralVendasReadBootstrap: async () => { chamouAlgumBloco = true; return {}; },
    });
    await rejeitaCom(
      "clienteContaId de conta inativa → 409 CONTA_INATIVA, sem compor nenhum bloco",
      obterVisao({ clienteSlugRaw: "n97", clienteContaIdRaw: "12", periodoRaw: "2026-08" }, deps),
      (err) => err.statusCode === 409 && err.code === "CONTA_INATIVA"
    );
    ok("nenhum bloco foi chamado antes da checagem de conta inativa", chamouAlgumBloco === false);
  }

  // 4. Conta de outro cliente → 403.
  await rejeitaCom(
    "conta de outro cliente → 403 CONTA_NAO_PERTENCE_AO_CLIENTE",
    obterVisao({ clienteSlugRaw: "n97", clienteContaIdRaw: "13", periodoRaw: "2026-08" }, depsBase()),
    (err) => err.statusCode === 403 && err.code === "CONTA_NAO_PERTENCE_AO_CLIENTE"
  );

  // 5. Sem clienteContaId → 400 (Visão nunca escolhe a conta sozinha).
  await rejeitaCom(
    "sem clienteContaId → 400, nunca escolhe conta em silêncio",
    obterVisao({ clienteSlugRaw: "n97", clienteContaIdRaw: null, periodoRaw: "2026-08" }, depsBase()),
    (err) => err.statusCode === 400
  );

  // 6. Um bloco falha (Central de Vendas fora do ar) — os outros continuam,
  //    nenhuma exceção sobe para o chamador.
  {
    const deps = depsBase({
      getCentralVendasReadBootstrap: async () => { throw new Error("banco fora do ar"); },
    });
    const resultado = await obterVisao({ clienteSlugRaw: "n97", clienteContaIdRaw: "10", periodoRaw: "2026-08" }, deps);
    ok("bloco que falhou vem com disponivel=false + motivo, não derruba a Visão", resultado.resultado.disponivel === false && resultado.resultado.motivo === "banco fora do ar");
    ok("os outros blocos continuam disponíveis mesmo com Central de Vendas fora do ar", resultado.saude.disponivel === true && resultado.ads.disponivel === true);
  }

  // 7. Fechamento do período: encontra a entrega certa entre várias.
  {
    const deps = depsBase({
      listarEntregas: async () => ({
        ok: true,
        entregas: [
          { id: 1, periodo: "2026-07", status: "publicado" },
          { id: 2, periodo: "2026-08", status: "rascunho" },
        ],
      }),
    });
    const resultado = await obterVisao({ clienteSlugRaw: "n97", clienteContaIdRaw: "10", periodoRaw: "2026-08" }, deps);
    ok("fechamento encontra a entrega do período pedido, não a mais recente cega", resultado.fechamento.dados.id === 2);
  }

  console.log(`\nvisaoServiceComposicao.test.js: ${checks} verificações passaram.`);
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
