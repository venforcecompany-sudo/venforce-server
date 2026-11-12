// server/tests/financeiroFullService.test.js
//
// Campo FULL do Fechamento (billing do ML): lista fechada de subtipos (sem
// frete CFFE/CFFI, sem CFONPN), competência pela data do lançamento lendo as
// faturas M e M+1, paginação instável deduplicada por detail_id, cache por
// conta+competência (definitivo × 6 h), ↻ ignora o cache, falhas do ML viram
// disponivel:false sem cachear, e a identidade da conta é sempre estrita.

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/vf-test";

const assert = require("assert");
const { obterFullDoFechamento, chavesDasFaturas, somarDoMes, cacheValido } = require("../services/financeiroFullService");

let checks = 0;
function ok(label, cond) {
  assert.ok(cond, `FALHOU: ${label}`);
  checks += 1;
  console.log(`  ok  ${label}`);
}

function dbMemoria() {
  const linhas = new Map();
  return {
    linhas,
    async query(sql, params) {
      if (/^\s*SELECT/i.test(sql)) {
        const [conta, mes, slug] = params;
        const row = linhas.get(`${conta}|${mes}`);
        return { rows: row && row.cliente_slug === slug ? [row] : [] };
      }
      if (/INSERT INTO financeiro_full_cache/i.test(sql)) {
        const [conta, mes, slug, custo, lancamentos, componentes, faturas, definitivo] = params;
        const row = {
          cliente_conta_id: conta, mes_ref: mes, cliente_slug: slug, custo_full: String(custo), lancamentos,
          componentes, faturas, definitivo, consultado_em: new Date("2026-11-12T15:00:00Z"),
        };
        linhas.set(`${conta}|${mes}`, row);
        return { rows: [row] };
      }
      throw new Error(`SQL inesperado: ${sql}`);
    },
  };
}

let seq = 1;
function det(sub, valor, data, type = "CHARGE") {
  return { charge_info: { detail_id: seq++, detail_sub_type: sub, detail_type: type, detail_amount: valor, creation_date_time: data } };
}

// ML falso: faturas existentes + lançamentos por fatura; paginação por
// offset/limit. `embaralhar` simula a ordem instável entre páginas na 1ª passada.
function mlFalso({ faturas, lancamentos, embaralharPrimeira = false, status = null }) {
  const chamadas = [];
  const passadas = {};
  const fn = async (clienteId, path, opts) => {
    chamadas.push({ clienteId, path, opts });
    if (status) return { ok: false, status, data: { message: "x" } };
    if (path.startsWith("/billing/integration/monthly/periods")) {
      return { ok: true, status: 200, data: { total: faturas.length, results: faturas.map(([key, st]) => ({ key, period_status: st })) } };
    }
    const m = path.match(/key\/([\d-]+)\/group\/ML\/details\?(.*)$/);
    const q = new URLSearchParams(m[2]);
    const lista = lancamentos[m[1]] || [];
    const tipos = new Set(q.get("detail_sub_types").split(","));
    const filtrada = lista.filter((d) => tipos.has(d.charge_info.detail_sub_type));
    const offset = Number(q.get("offset"));
    const limit = Number(q.get("limit"));
    const chave = m[1];
    if (offset === 0) passadas[chave] = (passadas[chave] || 0) + 1;
    let pagina = filtrada.slice(offset, offset + limit);
    if (embaralharPrimeira && passadas[chave] === 1 && offset > 0) {
      // 2ª página da 1ª passada repete o 1º item no lugar do último: um some.
      pagina = [filtrada[0], ...pagina.slice(1)];
    }
    return { ok: true, status: 200, data: { total: filtrada.length, results: pagina } };
  };
  fn.chamadas = chamadas;
  return fn;
}

const ctxOk = async (args) => { ctxOk.args = args; return { cliente: { id: 7 }, mlUserId: 999, conta: { id: 35 } }; };
const semEspera = { dormir: async () => {}, relogio: () => 0 };
const agora = new Date("2026-11-12T15:00:00Z");
const base = { clienteSlugRaw: "loja-exemplo", clienteContaIdRaw: "35", periodoRaw: "2026-10" };

function lancamentosOutubro() {
  seq = 1;
  return {
    "2026-10-01": [
      det("CFWA", 0.5, "2026-09-20T10:00:00"), // setembro: fora
      det("CFWA", 1.25, "2026-10-03T10:00:00"),
      det("CFBA", 121, "2026-10-05T10:00:00"),
      det("CFFE", 16000, "2026-10-05T10:00:00"), // frete da venda: fora
      det("CFONPN", 50, "2026-10-05T10:00:00"), // parcelamento: fora
    ],
    "2026-11-01": [
      det("CFWA", 2.75, "2026-10-20T10:00:00"),
      det("CFCBI", 90, "2026-10-21T10:00:00"),
      det("CFCBE", 10, "2026-10-22T10:00:00"),
      det("CFRS", 1.78, "2026-10-23T10:00:00"),
      det("CFWA", 3, "2026-11-02T10:00:00"), // novembro: fora
    ],
  };
}

async function run() {
  // ---------- puras ----------
  ok("faturas de out/2026 = out e nov", JSON.stringify(chavesDasFaturas("2026-10")) === JSON.stringify(["2026-10-01", "2026-11-01"]));
  ok("faturas de dez/2026 viram o ano", JSON.stringify(chavesDasFaturas("2026-12")) === JSON.stringify(["2026-12-01", "2027-01-01"]));
  ok("cache definitivo vale sempre", cacheValido({ definitivo: true, consultado_em: new Date("2020-01-01") }, agora));
  ok("cache aberto de 2 h vale", cacheValido({ definitivo: false, consultado_em: new Date("2026-11-12T13:00:00Z") }, agora));
  ok("cache aberto de 7 h expira", !cacheValido({ definitivo: false, consultado_em: new Date("2026-11-12T08:00:00Z") }, agora));
  const soma = somarDoMes(new Map([[1, det("CFWA", 1, "2026-10-01T00:00:00", "BONUS")], [2, det("CFWA", 2, "2026-10-01T00:00:00")]]), "2026-10");
  ok("só CHARGE entra na soma", soma.custoFull === 2 && soma.lancamentos === 1);

  // ---------- validação ----------
  for (const [rotulo, entrada, code] of [
    ["sem conta", { ...base, clienteContaIdRaw: "" }, "CONTA_OBRIGATORIA"],
    ["período inválido", { ...base, periodoRaw: "2026-13" }, "PERIODO_INVALIDO"],
    ["sem cliente", { ...base, clienteSlugRaw: " " }, "CLIENTE_OBRIGATORIO"],
  ]) {
    let erro = null;
    try { await obterFullDoFechamento(entrada, { db: dbMemoria(), ensureSchema: async () => {} }); } catch (e) { erro = e; }
    ok(`400 ${code} (${rotulo})`, erro && erro.statusCode === 400 && erro.code === code);
  }

  // ---------- consulta ao vivo ----------
  const db = dbMemoria();
  const ml = mlFalso({ faturas: [["2026-12-01", "OPEN"], ["2026-11-01", "CLOSED"], ["2026-10-01", "CLOSED"]], lancamentos: lancamentosOutubro() });
  const deps = { db, mlFetch: ml, resolveMarketplaceAccountContext: ctxOk, ensureSchema: async () => {}, agora: () => agora, ...semEspera };
  const r1 = await obterFullDoFechamento(base, deps);
  ok("ao vivo: disponível", r1.disponivel === true && r1.fonte === "ao_vivo");
  ok("soma só armazenagem/prolongado/coleta/retirada de outubro (1,25+121+2,75+90+10+1,78)", r1.custoFull === 226.78);
  const porGrupo = Object.fromEntries(r1.componentes.map((c) => [c.grupo, c.valor]));
  ok("componentes por grupo", porGrupo.armazenagem === 4 && porGrupo.armazenamento_prolongado === 121 && porGrupo.coleta === 100 && porGrupo.retirada === 1.78);
  ok("nunca pede CFFE/CFFI/CFONPN ao ML", ml.chamadas.every((c) => !/CFFE|CFFI|CFONPN/.test(c.path)));
  ok("lê só as faturas M e M+1", !ml.chamadas.some((c) => c.path.includes("2026-12-01")));
  ok("M e M+1 fechadas → definitivo", r1.definitivo === true);
  ok("identidade estrita da conta exata", ctxOk.args.strictIdentity === true && ctxOk.args.clienteContaId === 35 && ctxOk.args.clienteSlug === "loja-exemplo");
  ok("ML chamado com o grant da conta", ml.chamadas.every((c) => c.clienteId === 7 && c.opts.mlUserId === 999));
  ok("gravado no cache", db.linhas.has("35|2026-10"));

  // ---------- cache ----------
  const n = ml.chamadas.length;
  const r2 = await obterFullDoFechamento(base, deps);
  ok("2ª consulta: cache, sem ML", r2.fonte === "cache" && ml.chamadas.length === n);
  ok("cache devolve número e componentes", r2.custoFull === 226.78 && r2.componentes.length === 4);
  const r3 = await obterFullDoFechamento({ ...base, atualizarRaw: "1" }, deps);
  ok("atualizar=1 vai ao ML", r3.fonte === "ao_vivo" && ml.chamadas.length > n);
  const r4 = await obterFullDoFechamento({ ...base, clienteSlugRaw: "outro" }, deps);
  ok("cache de outro cliente não vaza", r4.fonte === "ao_vivo");

  // ---------- duas aberturas ao mesmo tempo: uma leitura no ML ----------
  const mlDuplo = mlFalso({ faturas: [["2026-11-01", "CLOSED"], ["2026-10-01", "CLOSED"]], lancamentos: lancamentosOutubro() });
  const depsDuplo = { ...deps, db: dbMemoria(), mlFetch: mlDuplo, consultasEmCurso: new Map() };
  const [d1, d2] = await Promise.all([obterFullDoFechamento(base, depsDuplo), obterFullDoFechamento(base, depsDuplo)]);
  const leiturasPeriods = mlDuplo.chamadas.filter((c) => c.path.includes("monthly/periods")).length;
  ok("consultas simultâneas compartilham a mesma leitura no ML", leiturasPeriods === 1 && d1.custoFull === 226.78 && d2.custoFull === 226.78);
  ok("terminada a leitura, a chave sai da lista em curso", depsDuplo.consultasEmCurso.size === 0);

  // ---------- mês aberto ----------
  const mlAberto = mlFalso({ faturas: [["2026-11-01", "OPEN"], ["2026-10-01", "CLOSED"]], lancamentos: lancamentosOutubro() });
  const rA = await obterFullDoFechamento(base, { ...deps, db: dbMemoria(), mlFetch: mlAberto });
  ok("M+1 aberta → não definitivo", rA.definitivo === false && rA.custoFull === 226.78);
  const mlSemM1 = mlFalso({ faturas: [["2026-10-01", "CLOSED"]], lancamentos: lancamentosOutubro() });
  const rB = await obterFullDoFechamento(base, { ...deps, db: dbMemoria(), mlFetch: mlSemM1 });
  ok("M+1 ainda não existe → lê só M, não definitivo", rB.definitivo === false && rB.custoFull === 122.25
    && !mlSemM1.chamadas.some((c) => c.path.includes("2026-11-01/group")));

  // ---------- paginação instável ----------
  seq = 1;
  const muitos = { "2026-10-01": Array.from({ length: 1500 }, () => det("CFWA", 0.01, "2026-10-10T00:00:00")), "2026-11-01": [] };
  const mlInstavel = mlFalso({ faturas: [["2026-11-01", "CLOSED"], ["2026-10-01", "CLOSED"]], lancamentos: muitos, embaralharPrimeira: true });
  const rI = await obterFullDoFechamento(base, { ...deps, db: dbMemoria(), mlFetch: mlInstavel });
  ok("página que repete item: relê e fecha os 1500 únicos", rI.disponivel === true && rI.lancamentos === 1500 && rI.custoFull === 15);

  // ---------- falhas do ML ----------
  for (const [status, codigo] of [[403, "ML_BILLING_SEM_PERMISSAO"], [500, "ML_BILLING_API_ERROR"]]) {
    const dbX = dbMemoria();
    const r = await obterFullDoFechamento(base, { ...deps, db: dbX, mlFetch: mlFalso({ faturas: [], lancamentos: {}, status }) });
    ok(`HTTP ${status} → ${codigo}, nada cacheado`, r.disponivel === false && r.codigo === codigo && dbX.linhas.size === 0);
  }
  let tent429 = 0;
  const ml429 = async () => { tent429 += 1; return { ok: false, status: 429, data: {} }; };
  const r429 = await obterFullDoFechamento(base, { ...deps, db: dbMemoria(), mlFetch: ml429 });
  ok("429 persistente: tenta de novo e desiste com disponivel:false", r429.disponivel === false && tent429 === 4);
  let t = 0;
  const rLento = await obterFullDoFechamento(base, {
    ...deps, db: dbMemoria(), relogio: () => (t += 60000),
    mlFetch: mlFalso({ faturas: [["2026-11-01", "CLOSED"], ["2026-10-01", "CLOSED"]], lancamentos: lancamentosOutubro() }),
  });
  ok("estourou o prazo → ML_BILLING_LENTO", rLento.disponivel === false && rLento.codigo === "ML_BILLING_LENTO");
  const rTok = await obterFullDoFechamento(base, { ...deps, db: dbMemoria(), resolveMarketplaceAccountContext: async () => { throw new Error("sem grant"); } });
  ok("sem grant → NO_TOKEN", rTok.disponivel === false && rTok.codigo === "NO_TOKEN");

  // ---------- erro estrutural propaga ----------
  let erro = null;
  try {
    await obterFullDoFechamento(base, {
      ...deps, db: dbMemoria(),
      resolveMarketplaceAccountContext: async () => { const e = new Error("conta não pertence"); e.statusCode = 404; e.code = "CONTA_NAO_ENCONTRADA"; throw e; },
    });
  } catch (e) { erro = e; }
  ok("erro de identidade da conta propaga", erro && erro.code === "CONTA_NAO_ENCONTRADA");

  console.log(`\n✓ financeiroFullService: ${checks} checks`);
}

run().catch((err) => { console.error(err); process.exit(1); });
