process.env.DATABASE_URL = "postgres://nobody@127.0.0.1:1/teste-sem-banco";

const assert = require("assert");
const { sincronizarAdsCliente, agregarPerformances } = require("../services/centralVendas/centralVendasAdsSyncService");
const { calcularAcos } = require("../services/painelContas/painelContasMetricas");
const adsService = require("../services/adsService");
const pool = require("../config/database");

let checks = 0;
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, `FALHOU: ${label} — recebido ${JSON.stringify(actual)}`);
  checks += 1;
}
function ok(label, condition) {
  assert.ok(condition, `FALHOU: ${label}`);
  checks += 1;
}

function depsCom(perConta) {
  const chamadas = { buscar: [], salvar: [], ensure: 0 };
  return {
    chamadas,
    deps: {
      async buscarPerformanceML(slug, competencia, janela, contaId) {
        chamadas.buscar.push({ slug, competencia, janela, contaId });
        const valor = perConta[contaId];
        if (valor instanceof Error) throw valor;
        return valor;
      },
      async ensureAdsResumoTables() { chamadas.ensure += 1; },
      async salvarResumoMensalAds(p) {
        chamadas.salvar.push(p);
        return { ...p.dados, updatedAt: "2026-09-25T06:00:00.000Z" };
      },
    },
  };
}

async function run() {
  const base = {
    cliente: { id: 1, slug: "cliente-a" },
    competencia: "2026-09",
    segmento: { dateFrom: "2026-09-01", dateTo: "2026-09-24" },
  };

  {
    const h = depsCom({ 10: { investimentoAds: 100, gmvAds: 500 } });
    const r = await sincronizarAdsCliente({ ...base, contas: [{ clienteContaId: 10 }] }, h.deps);
    eq("1 conta: agregado persistido", [r.investimentoAds, r.gmvAds], [100, 500]);
    eq("1 conta: um unico upsert do cliente", h.chamadas.salvar.length, 1);
    eq("1 conta: chave mensal", {
      slug: h.chamadas.salvar[0].clienteSlug,
      mes: h.chamadas.salvar[0].mes,
      loja: h.chamadas.salvar[0].lojaCampanha,
      somentePerformance: h.chamadas.salvar[0].somentePerformance,
    }, { slug: "cliente-a", mes: "2026-09", loja: "todas", somentePerformance: true });
  }

  {
    const h = depsCom({
      10: { investimentoAds: 100, gmvAds: 500, acos: 20 },
      11: { investimentoAds: 200, gmvAds: 1000, acos: 20 },
    });
    const r = await sincronizarAdsCliente({ ...base, contas: [{ clienteContaId: 10 }, { clienteContaId: 11 }] }, h.deps);
    eq("multiconta: consulta individual por conta", h.chamadas.buscar.map((c) => c.contaId), [10, 11]);
    eq("multiconta: soma investimento e GMV", [r.investimentoAds, r.gmvAds], [300, 1500]);
    eq("multiconta: ROAS agregado pela razao dos totais", r.roas, 5);
    eq("multiconta: ACOS agregado = 20%", calcularAcos(r.investimentoAds, r.gmvAds), 0.2);
    eq("multiconta: persiste uma vez, nunca sobrescreve conta a conta", h.chamadas.salvar.length, 1);
  }

  {
    const h = depsCom({
      10: { investimentoAds: 100, gmvAds: 500 },
      11: { semDados: true, codigo: "ML_ADS_API_ERROR", motivo: "indisponivel" },
    });
    let erro;
    try {
      await sincronizarAdsCliente({ ...base, contas: [{ clienteContaId: 10 }, { clienteContaId: 11 }] }, h.deps);
    } catch (err) { erro = err; }
    eq("erro Ads: codigo preservado", erro?.code, "ML_ADS_API_ERROR");
    eq("erro Ads: nenhuma linha e sobrescrita por zero falso", h.chamadas.salvar.length, 0);
    eq("erro Ads: nem ensure/upsert ocorre", h.chamadas.ensure, 0);
  }

  {
    const agregado = agregarPerformances([{ investimentoAds: 0, gmvAds: 0 }]);
    eq("zero real: permanece um agregado valido", agregado, { investimentoAds: 0, gmvAds: 0, roas: 0 });
    ok("ausencia e invalida, nao convertida em zero", (() => {
      try { agregarPerformances([{ investimentoAds: null, gmvAds: undefined }]); return false; } catch (_) { return true; }
    })());
  }

  {
    const queryOriginal = pool.query;
    let sqlExecutado = "";
    pool.query = async (sql) => {
      sqlExecutado = sql;
      return { rows: [{
        cliente_slug: "cliente-a", mes_ref: "2026-09", loja_campanha: "todas",
        investimento_ads: 100, gmv_ads: 500, roas: 5,
        faturamento_total: 9000, cancelados_valor: 10, cancelados_pct: 1,
        devolvidos_valor: 20, tacos: 2, updated_at: new Date("2026-09-25T06:00:00Z"),
      }] };
    };
    try {
      await adsService.salvarResumoMensalAds({
        clienteSlug: "cliente-a", mes: "2026-09", lojaCampanha: "todas",
        dados: { investimentoAds: 100, gmvAds: 500, roas: 5 },
        userId: null, somentePerformance: true,
      });
    } finally {
      pool.query = queryOriginal;
    }
    const updateSql = sqlExecutado.split("DO UPDATE SET")[1] || "";
    ok("upsert automatico preserva campos gerenciais existentes", !updateSql.includes("faturamento_total = EXCLUDED") && !updateSql.includes("tacos = EXCLUDED"));
  }

  console.log(`centralVendasAdsSync.test.js: ${checks} verificacoes OK`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
