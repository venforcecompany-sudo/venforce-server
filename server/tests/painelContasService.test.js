// server/tests/painelContasService.test.js
//
// Testes de contrato do painelContasService (Auditoria §26: Autorização,
// Dados, Variação, Performance). Sem Postgres real — mesmo padrão de
// squadsIsolamento.test.js: um modelo em memória responde às queries
// marcadas /* authz:... */, /* squads:... */ e /* painelContas:... */. A
// lógica de junção é reimplementada no mock a partir dos arrays — se o SQL
// de produção divergir do modelo, o teste continua exercitando o CONTRATO do
// service (autorização primeiro, filtros depois, derivação correta,
// contagem de queries fixa).

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/vf-test";
process.env.SQUADS_ENFORCEMENT = "on"; // isolamento por Squad só é observável com enforcement ligado

const assert = require("assert");
const pool = require("../config/database");

let checks = 0;
function ok(label, cond) {
  assert.ok(cond, `FALHOU: ${label}`);
  checks += 1;
  console.log(`  ok  ${label}`);
}

// ─────────────────────────── modelo em memória ───────────────────────────

function novoModelo() {
  return {
    clientes: [
      { id: 1, slug: "cliente-a", nome: "Cliente A", ativo: true },
      { id: 2, slug: "cliente-b", nome: "Cliente B", ativo: true },
      { id: 3, slug: "cliente-c", nome: "Cliente C", ativo: true },
      { id: 4, slug: "cliente-nunca-sync", nome: "Cliente Nunca Sincronizado", ativo: true },
    ],
    squads: [
      { id: 10, nome: "Squad Alpha", slug: "alpha", ativo: true },
      { id: 20, nome: "Squad Beta", slug: "beta", ativo: true },
    ],
    members: [
      { squad_id: 10, user_id: 100, is_primary: true, funcao: "membro", ativo: true },
      { squad_id: 20, user_id: 200, is_primary: true, funcao: "membro", ativo: true },
    ],
    history: [
      { cliente_id: 1, squad_id: 10, fim_em: null },
      { cliente_id: 2, squad_id: 10, fim_em: null },
      { cliente_id: 3, squad_id: 20, fim_em: null },
      { cliente_id: 4, squad_id: 10, fim_em: null },
    ],
    sellerClientes: [],
    // cliente_360_resumos_mensais
    resumos: [
      { cliente_id: 1, competencia: "2026-01", faturamento: 100000, mc_media: 0.18, ads_investido: 3500, sincronizado_em: "2026-02-01T09:00:00.000Z", payload_json: { porDia: [{ data: "2026-01-05", vendasBrutas: 5000 }] } },
      {
        cliente_id: 1, competencia: "2026-02", faturamento: 113000, mc_media: 0.181,
        ads_investido: 3900, sincronizado_em: "2026-03-01T09:10:00.000Z",
        payload_json: {
          porDia: [{ data: "2026-02-03", vendasBrutas: 6000 }],
          centralVendas: { lucroContribuicao: 15000 },
          ads: { investimentoAds: 3900, gmvAds: 100000, roas: 25.64, resumoAtualizadoEm: "2026-03-01T09:09:00.000Z" },
        },
      },
      // Cliente B: mc_media gravado em ESCALA PERCENTUAL (22 = 22%), não fração.
      { cliente_id: 2, competencia: "2026-02", faturamento: 50000, mc_media: 22, ads_investido: null, sincronizado_em: "2026-03-01T09:15:00.000Z", payload_json: {} },
      { cliente_id: 3, competencia: "2026-02", faturamento: 80000, mc_media: 0.2, ads_investido: 1000, sincronizado_em: "2026-03-01T09:20:00.000Z", payload_json: {} },
      // Cliente 4 (cliente-nunca-sync): NENHUMA linha.
    ],
    // ads_resumos_mensais — só cliente-a tem gmv_ads persistido em fev/2026.
    adsResumos: [
      { cliente_slug: "cliente-a", mes_ref: "2026-02", loja_campanha: "todas", gmv_ads: 100000 },
    ],
  };
}

function squadAtivoDoCliente(m, clienteId) {
  const h = m.history.find((r) => r.cliente_id === clienteId && r.fim_em === null);
  if (!h) return null;
  const s = m.squads.find((x) => x.id === h.squad_id);
  return { ...h, squad: s };
}

function portfolioInterno(m, userId) {
  const squadsDoUser = new Set(
    m.members.filter((mm) => mm.user_id === userId && mm.ativo).map((mm) => mm.squad_id)
      .filter((sid) => (m.squads.find((s) => s.id === sid) || {}).ativo)
  );
  return m.clientes
    .filter((c) => c.ativo)
    .filter((c) => {
      const h = m.history.find((r) => r.cliente_id === c.id && r.fim_em === null);
      return h && squadsDoUser.has(h.squad_id);
    })
    .map((c) => ({ id: c.id, slug: c.slug, nome: c.nome }));
}

function resumoMaisRecente(m, ids, anoLike) {
  const padrao = anoLike ? new RegExp(`^${String(anoLike).replace("%", ".*")}$`) : null;
  return ids
    .map((id) => {
      const doCliente = m.resumos.filter((r) => r.cliente_id === id && (!padrao || padrao.test(r.competencia)));
      if (!doCliente.length) return null;
      const recente = [...doCliente].sort((a, b) => b.competencia.localeCompare(a.competencia))[0];
      const cliente = m.clientes.find((c) => c.id === id);
      return {
        cliente_id: id, cliente_slug: cliente.slug, competencia: recente.competencia,
        faturamento: recente.faturamento, mc_media: recente.mc_media, ads_investido: recente.ads_investido,
        payload_json: recente.payload_json, sincronizado_em: recente.sincronizado_em,
      };
    })
    .filter(Boolean);
}

function resumosDoAno(m, clienteId, ano) {
  const cliente = m.clientes.find((c) => c.id === clienteId);
  return m.resumos
    .filter((r) => r.cliente_id === clienteId && r.competencia.startsWith(`${ano}-`))
    .sort((a, b) => a.competencia.localeCompare(b.competencia))
    .map((r) => {
      return {
        cliente_id: clienteId, cliente_slug: cliente.slug, competencia: r.competencia,
        faturamento: r.faturamento, mc_media: r.mc_media, ads_investido: r.ads_investido,
        payload_json: r.payload_json, sincronizado_em: r.sincronizado_em,
      };
    });
}

function instalarMock(m) {
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  const contagem = { total: 0, porTag: new Map() };

  function contar(tag) {
    contagem.total += 1;
    contagem.porTag.set(tag, (contagem.porTag.get(tag) || 0) + 1);
  }

  async function query(sql, params = []) {
    const q = String(sql).replace(/\s+/g, " ").trim();

    if (/^(CREATE|ALTER|DROP|BEGIN|COMMIT|ROLLBACK|DO )/i.test(q) || q.includes("pg_advisory")) {
      return { rows: [] };
    }

    if (q.includes("authz:PORTFOLIO_ADMIN_ALL")) {
      contar("authz:PORTFOLIO_ADMIN_ALL");
      return { rows: m.clientes.filter((c) => c.ativo).map(({ id, slug, nome }) => ({ id, slug, nome })) };
    }
    if (q.includes("authz:PORTFOLIO_SELLER")) {
      contar("authz:PORTFOLIO_SELLER");
      return { rows: [] };
    }
    if (q.includes("authz:PORTFOLIO_INTERNAL_BY_SQUAD")) {
      contar("authz:PORTFOLIO_INTERNAL_BY_SQUAD");
      return { rows: portfolioInterno(m, params[0]) };
    }
    if (q.includes("authz:CAN_ACCESS_ADMIN")) {
      contar("authz:CAN_ACCESS_ADMIN");
      const c = m.clientes.find((x) => x.id === Number(params[0]));
      return { rows: c ? [{ "?column?": 1 }] : [] };
    }
    if (q.includes("authz:CAN_ACCESS_INTERNAL")) {
      contar("authz:CAN_ACCESS_INTERNAL");
      const [uid, cid] = params;
      const hit = portfolioInterno(m, uid).some((c) => c.id === Number(cid));
      return { rows: hit ? [{ "?column?": 1 }] : [] };
    }
    if (q.includes("authz:RESOLVE_CLIENTE_ID")) {
      contar("authz:RESOLVE_CLIENTE_ID");
      return { rows: m.clientes.filter((c) => c.id === Number(params[0])) };
    }
    if (q.includes("authz:RESOLVE_CLIENTE_SLUG")) {
      contar("authz:RESOLVE_CLIENTE_SLUG");
      return { rows: m.clientes.filter((c) => c.slug === params[0]) };
    }

    if (q.includes("squads:MEMBERSHIPS_DO_USUARIO")) {
      contar("squads:MEMBERSHIPS_DO_USUARIO");
      const uid = params[0];
      return {
        rows: m.members
          .filter((mm) => mm.user_id === uid && mm.ativo)
          .map((mm) => {
            const s = m.squads.find((x) => x.id === mm.squad_id);
            return {
              squad_id: mm.squad_id, is_primary: mm.is_primary, funcao: mm.funcao,
              squad_nome: s.nome, squad_slug: s.slug, squad_ativo: s.ativo,
            };
          }),
      };
    }
    if (q.includes("squads:SQUADS_ATIVOS_DE_CLIENTES")) {
      contar("squads:SQUADS_ATIVOS_DE_CLIENTES");
      const ids = params[0] || [];
      return {
        rows: ids.map((cid) => squadAtivoDoCliente(m, cid)).filter(Boolean).map((h) => ({
          cliente_id: h.cliente_id, squad_id: h.squad_id, squad_nome: h.squad.nome, squad_slug: h.squad.slug, squad_ativo: h.squad.ativo,
        })),
      };
    }

    if (q.includes("painelContas:ULTIMO_RESUMO_POR_CLIENTE")) {
      contar("painelContas:ULTIMO_RESUMO_POR_CLIENTE");
      const ids = params[0] || [];
      const anoLike = params[1] || null;
      return { rows: resumoMaisRecente(m, ids, anoLike) };
    }
    if (q.includes("painelContas:RESUMOS_DO_ANO")) {
      contar("painelContas:RESUMOS_DO_ANO");
      const clienteId = params[0];
      const ano = String(params[1]).replace("-%", "");
      return { rows: resumosDoAno(m, clienteId, ano) };
    }
    if (q.startsWith("SELECT * FROM cliente_360_resumos_mensais")) {
      contar("cliente360Repo:findResumoMensal");
      const [clienteId, competencia] = params;
      const row = m.resumos.find((r) => r.cliente_id === clienteId && r.competencia === competencia);
      return { rows: row ? [row] : [] };
    }

    return { rows: [] };
  }

  pool.query = (sql, params) => query(sql, params);
  pool.connect = async () => ({ query: (sql, params) => query(sql, params), release() {} });

  return { restaurar: () => { pool.query = originalQuery; pool.connect = originalConnect; }, contagem };
}

// ─────────────────────────────── testes ───────────────────────────────

const service = require("../services/painelContas/painelContasService");
const { maskSensitiveData } = require("../controllers/painelContasController");

const U = {
  alpha: { id: 100, role: "membro", nome: "Alpha" },
  beta: { id: 200, role: "membro", nome: "Beta" },
  admin: { id: 1, role: "admin", nome: "Admin" },
};

async function run() {
  const m = novoModelo();
  const { restaurar, contagem } = instalarMock(m);
  try {
    // ── Autorização ──
    const listaAdmin = await service.listar(U.admin, {});
    ok("admin vê clientes de múltiplos Squads na lista inicial", new Set(listaAdmin.clientes.map((c) => c.id)).size >= 3);

    const listaAlpha = await service.listar(U.alpha, {});
    ok("Alpha (Squad Alpha) NÃO vê Cliente C (Squad Beta)", !listaAlpha.clientes.some((c) => c.id === 3));
    ok("Alpha vê A, B e o cliente-nunca-sync (todos do seu Squad)", listaAlpha.clientes.map((c) => c.id).sort().join(",") === "1,2,4");

    const listaBeta = await service.listar(U.beta, {});
    ok("Beta vê só Cliente C", listaBeta.clientes.map((c) => c.id).join(",") === "3");

    let err403;
    try { await service.listarMeses(U.alpha, "3", { ano: 2026 }); } catch (e) { err403 = e; }
    ok("GET meses de cliente FORA da carteira via id direto -> 403 CLIENTE_FORA_DA_CARTEIRA", err403 && err403.statusCode === 403 && err403.code === "CLIENTE_FORA_DA_CARTEIRA");

    let err404;
    try { await service.listarMeses(U.alpha, "999", { ano: 2026 }); } catch (e) { err404 = e; }
    ok("GET meses de cliente inexistente -> 404 CLIENTE_NAO_ENCONTRADO", err404 && err404.statusCode === 404 && err404.code === "CLIENTE_NAO_ENCONTRADO");

    // filtro de squad enviado pelo cliente NUNCA amplia acesso além da carteira
    const listaAlphaFiltroBeta = await service.listar(U.alpha, { squadId: 20 });
    ok("squadId=Beta enviado por Alpha não retorna Cliente C (filtro nunca é autorização)", listaAlphaFiltroBeta.clientes.length === 0);

    // ── Dados ──
    const clienteNuncaSync = listaAlpha.clientes.find((c) => c.id === 4);
    ok("cliente sem NENHUM snapshot -> resumo null, nunca erro/500", clienteNuncaSync.resumo === null && clienteNuncaSync.ultimoMesDisponivel === null);

    const clienteB = listaAlpha.clientes.find((c) => c.id === 2);
    ok("cliente B: mc_media em escala percentual (22) normalizado para fração (0.22)", clienteB.resumo.mc === 0.22);
    ok("cliente B: mês sem Ads (ads_investido null) -> tacos/acos null, nunca 0", clienteB.resumo.tacos === null && clienteB.resumo.acos === null);

    const clienteC = listaBeta.clientes.find((c) => c.id === 3);
    ok("cliente C: gmv_ads ausente -> acos null", clienteC.resumo.acos === null);

    const clienteA = listaAlpha.clientes.find((c) => c.id === 1);
    ok("cliente A: ultimoMesDisponivel é o mais recente (2026-02, não 2026-01)", clienteA.ultimoMesDisponivel === "2026-02");
    ok("cliente A: investimento/GMV do mesmo payload -> acos derivado", clienteA.resumo.acos !== null && Math.abs(clienteA.resumo.acos - 3900 / 100000) < 1e-9);
    ok("cliente A: LC real do payload vence FAT × MC", clienteA.resumo.lc === 15000);

    const mesesA = await service.listarMeses(U.alpha, "1", { ano: 2026 });
    ok("meses do cliente A: 2 competências (jan, fev)", mesesA.meses.length === 2);
    ok("primeiro mês do cliente (jan/2026): variacaoVsMesAnterior toda null", Object.values(mesesA.meses[0].variacaoVsMesAnterior).every((v) => Object.values(v).every((x) => x === null)));
    ok("fev/2026 vs jan/2026: variação calculada (fat sobe)", mesesA.meses[1].variacaoVsMesAnterior.fat.abs === 13000);

    // mês anterior com valor 0 -> deltaPct null, nunca Infinity (injeta um cenário isolado)
    m.resumos.push({ cliente_id: 1, competencia: "2026-03", faturamento: 0, mc_media: 0, ads_investido: 0, sincronizado_em: "2026-04-01T00:00:00.000Z", payload_json: {} });
    m.resumos.push({ cliente_id: 1, competencia: "2026-04", faturamento: 50000, mc_media: 0.1, ads_investido: 1000, sincronizado_em: "2026-05-01T00:00:00.000Z", payload_json: {} });
    const mesesA2 = await service.listarMeses(U.alpha, "1", { ano: 2026 });
    const abr = mesesA2.meses.find((mm) => mm.competencia === "2026-04");
    ok("mês anterior (mar/2026) com fat=0: pct null, nunca Infinity", abr.variacaoVsMesAnterior.fat.pct === null && Number.isFinite(abr.variacaoVsMesAnterior.fat.abs));

    // semanas: dado real de porDia
    const semanasA = await service.listarSemanas(U.alpha, "1", "2026-01");
    ok("semanas jan/2026 do cliente A: FAT presente, resto null", semanasA.semanas.some((s) => s.resumo.fat !== null) && semanasA.semanas.every((s) => s.resumo.lc === null));

    // semanas de cliente sem snapshot da competência -> tudo null, nunca erro
    const semanasSem = await service.listarSemanas(U.alpha, "4", "2026-05");
    ok("semanas de competência sem snapshot: todas as semanas com fat null, nunca 500", semanasSem.semanas.every((s) => s.resumo.fat === null));

    // ── Performance / N+1 ──
    contagem.total = 0;
    contagem.porTag.clear();
    await service.listar(U.admin, {});
    const totalListaAdmin = contagem.total;
    ok("lista inicial (N clientes): contagem de queries fixa, não escala por cliente (<=5 queries)", totalListaAdmin <= 5);
    ok("painelContas:ULTIMO_RESUMO_POR_CLIENTE chamado exatamente 1x (lote, nunca 1 por cliente)", contagem.porTag.get("painelContas:ULTIMO_RESUMO_POR_CLIENTE") === 1);

    contagem.total = 0;
    contagem.porTag.clear();
    await service.listarMeses(U.alpha, "1", { ano: 2026 });
    ok("expandir 1 cliente não dispara nenhuma query sobre outros clientes (poucas queries fixas)", contagem.total <= 4);
    ok("RESUMOS_DO_ANO chamado exatamente 1x", contagem.porTag.get("painelContas:RESUMOS_DO_ANO") === 1);

    // ── Contrato: nenhum segredo vaza ──
    const payloadComSegredo = { ok: true, cliente: { access_token: "abc", refresh_token: "def" }, dado: 1 };
    const mascarado = maskSensitiveData(payloadComSegredo);
    ok("maskSensitiveData redige access_token/refresh_token", mascarado.cliente.access_token === "[REDACTED]" && mascarado.cliente.refresh_token === "[REDACTED]");
    const dumpReal = JSON.stringify(listaAdmin) + JSON.stringify(mesesA) + JSON.stringify(semanasA);
    ok("nenhuma resposta real de painelContas expõe access_token/refresh_token/api_key/client_secret", !/access_token|refresh_token|client_secret|api_key/i.test(dumpReal));

    console.log(`\npainelContasService.test.js: ${checks} verificações passaram.`);
  } finally {
    restaurar();
  }
}

run().catch((err) => { console.error(err); process.exitCode = 1; });
