// server/services/financeiroFullService.js
//
// Campo FULL do Fechamento (Financeiro V3) preenchido pelo faturamento do ML.
// GET /financeiro/:cliente/full?conta=&periodo=YYYY-MM[&atualizar=1]
//
// Fonte: API de billing do ML, lançamentos de UMA conta ML.
//   GET /billing/integration/monthly/periods            → faturas e status
//   GET /billing/integration/periods/key/{key}/group/ML/details
//       ?document_type=BILL&detail_sub_types=...        → lançamentos
//
// O QUE ENTRA (lista fechada de subtipos — NÃO usar o prefixo "CF": o
// CFONPN, por exemplo, é taxa de parcelamento):
//   CFWA          armazenagem diária do Full. O resumo da fatura rotula como
//                 "Estorno por Fulfillment Warehousing", mas cada lançamento
//                 é CHARGE "Tarifa pelo serviço de armazenamento Full"
//                 (validado em shopping_86, out/2026) — é custo.
//   CFBA          armazenamento prolongado
//   CFCBI / CFCBE coleta Full
//   CFRS          retirada ou descarte de estoque
//
// O QUE NÃO ENTRA: CFFE/CFFI (e os estornos BFFE/BFFI) são o frete de cada
// venda Full — o mesmo valor de senders[].cost de /shipments/:id/costs, que o
// fechamento já desconta por venda (centralVendasFreteService / coluna
// "Tarifas de envio" da planilha). Somar aqui contaria o frete duas vezes.
//
// COMPETÊNCIA ≠ FATURA. A fatura do ML não é o mês do calendário: a chave
// 2026-10-01 cobre lançamentos de ~10/set a 09/out (com sobras atrasadas de
// meses anteriores). Por isso o mês M soma os lançamentos com
// creation_date_time dentro de M, lidos das faturas M e M+1 (juntas cobrem
// ~10/M-1 a 09/M+1). Sobras atrasadas que caem em M+2 ficam de fora de
// propósito: em out/2026 da shopping_86 foram centavos, e cada fatura a mais
// custa ~15 s de leitura (ver INTERVALO_DETAILS_MS). Só fica `definitivo`
// quando as duas existem e estão fechadas; antes disso o cache vale 6 h.
//
// PAGINAÇÃO INSTÁVEL. A ordem entre páginas do /details não é estável: uma
// leitura pode repetir e perder lançamentos. Cada fatura é lida até o número
// de detail_id únicos fechar com o `total` (até 3 passadas, unindo as
// passadas). Se não fechar, a resposta é disponivel:false — nunca um valor
// a menor em silêncio.
//
// Sem dado da API (sem token, sem permissão, erro/lentidão do ML) a resposta
// é `disponivel:false` com o código — o campo vira manual, nunca bloqueia o
// fechamento. Nada é cacheado nesse caso.

const pool = require("../config/database");
const { mlFetch } = require("../utils/mlClient");
const { resolveMarketplaceAccountContext } = require("./clienteContas/clienteContaService");
const { ensureFinanceiroFullCacheSchema } = require("./schema/schemaEnsure");

const PERIODO_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;
const TTL_MES_ABERTO_MS = 6 * 60 * 60 * 1000;
const PAGINA = 1000;
const MAX_PASSADAS = 3;
const MAX_TENTATIVAS_429 = 4;
const INTERVALO_DETAILS_MS = 14500;
const TIMEOUT_CHAMADA_MS = 30 * 1000;
const PRAZO_TOTAL_MS = 120 * 1000;

const GRUPOS = [
  { grupo: "armazenagem", rotulo: "Armazenagem", tipos: ["CFWA"] },
  { grupo: "armazenamento_prolongado", rotulo: "Armazenamento prolongado", tipos: ["CFBA"] },
  { grupo: "coleta", rotulo: "Coleta", tipos: ["CFCBI", "CFCBE"] },
  { grupo: "retirada", rotulo: "Retirada ou descarte", tipos: ["CFRS"] },
];
const SUBTIPOS_FULL = GRUPOS.flatMap((g) => g.tipos);
const CONSULTAS_EM_CURSO = new Map();
const GRUPO_DO_TIPO = new Map(GRUPOS.flatMap((g) => g.tipos.map((t) => [t, g])));

function erroHttp(statusCode, code, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

function erroMl(codigo, motivo) {
  const err = new Error(motivo);
  err.fullCodigo = codigo;
  return err;
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// "2026-10" → ["2026-10-01", "2026-11-01"]
function chavesDasFaturas(periodo) {
  const [ano, mes] = periodo.split("-").map(Number);
  return [0, 1].map((k) => {
    const d = new Date(Date.UTC(ano, mes - 1 + k, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
  });
}

function cacheValido(row, agora) {
  if (row.definitivo === true) return true;
  const quando = new Date(row.consultado_em);
  if (Number.isNaN(quando.getTime())) return false;
  return agora.getTime() - quando.getTime() < TTL_MES_ABERTO_MS;
}

// Soma os lançamentos do mês por grupo. `lancamentos` = Map(detail_id → detalhe).
function somarDoMes(lancamentos, periodo) {
  const porGrupo = new Map(GRUPOS.map((g) => [g.grupo, { grupo: g.grupo, rotulo: g.rotulo, tipos: g.tipos, valor: 0, lancamentos: 0 }]));
  let total = 0;
  let n = 0;
  for (const d of lancamentos.values()) {
    const ci = d?.charge_info || {};
    const grupo = GRUPO_DO_TIPO.get(ci.detail_sub_type);
    if (!grupo) continue;
    if (String(ci.detail_type || "CHARGE").toUpperCase() !== "CHARGE") continue;
    if (String(ci.creation_date_time || "").slice(0, 7) !== periodo) continue;
    const valor = Number(ci.detail_amount);
    if (!Number.isFinite(valor)) continue;
    const g = porGrupo.get(grupo.grupo);
    g.valor += valor;
    g.lancamentos += 1;
    total += valor;
    n += 1;
  }
  const componentes = [...porGrupo.values()].map((g) => ({ ...g, valor: round2(g.valor) }));
  return { custoFull: round2(total), lancamentos: n, componentes };
}

// O /details aceita ~1 chamada a cada ~14 s por conta (medido em produção,
// 12/11/2026: as respostas 200 vinham espaçadas de 14-15 s; o resto, 429).
// Máximo de 1000 lançamentos por página (limit maior → 422). Em vez de bater no 429 e
// esperar, o leitor espaça as chamadas de /details por conta própria.
function criarLeitor({ fetchMl, clienteId, mlUserId, dormir, relogio }) {
  const inicio = relogio();
  let ultimoDetails = null;
  async function get(path) {
    const ehDetails = path.includes("/details");
    for (let tentativa = 1; ; tentativa++) {
      if (ehDetails && ultimoDetails !== null) {
        const falta = INTERVALO_DETAILS_MS - (relogio() - ultimoDetails);
        if (falta > 0) await dormir(falta);
      }
      if (relogio() - inicio > PRAZO_TOTAL_MS) {
        throw erroMl("ML_BILLING_LENTO", "O faturamento do Mercado Livre demorou demais para responder.");
      }
      let r;
      try {
        r = await fetchMl(clienteId, path, { mlUserId, timeoutMs: TIMEOUT_CHAMADA_MS });
      } catch (err) {
        throw erroMl(err?.name === "MlTimeoutError" ? "ML_BILLING_LENTO" : "ML_BILLING_API_ERROR", err?.message || "Falha ao consultar o ML.");
      } finally {
        if (ehDetails) ultimoDetails = relogio();
      }
      if (r.status === 429 && tentativa < MAX_TENTATIVAS_429) {
        const espera = Number(r.retryAfter) > 0 ? Math.min(Number(r.retryAfter) * 1000, 15000) : INTERVALO_DETAILS_MS;
        await dormir(espera);
        continue;
      }
      return r;
    }
  }
  return { get };
}

function falhaHttp(r, onde) {
  if (r.status === 401 || r.status === 403) {
    return erroMl("ML_BILLING_SEM_PERMISSAO", `Token ML sem permissão no faturamento (${onde}, HTTP ${r.status}).`);
  }
  return erroMl("ML_BILLING_API_ERROR", `Faturamento do ML retornou HTTP ${r.status} (${onde}): ${JSON.stringify(r.data).slice(0, 200)}`);
}

// Faturas existentes da conta (chave → status), das mais novas para as mais
// antigas. Para assim que passar da mais antiga que interessa.
async function listarFaturas(leitor, chaveMaisAntiga) {
  const faturas = new Map();
  for (let offset = 0; offset < 120; ) {
    const r = await leitor.get(`/billing/integration/monthly/periods?group=ML&document_type=BILL&offset=${offset}&limit=12`);
    if (r.status !== 200) throw falhaHttp(r, "periods");
    const res = Array.isArray(r.data?.results) ? r.data.results : [];
    for (const p of res) if (p?.key) faturas.set(String(p.key), String(p.period_status || "").toUpperCase());
    offset += res.length;
    const maisAntiga = res.length ? String(res[res.length - 1].key) : null;
    if (!res.length || offset >= Number(r.data?.total || 0) || (maisAntiga && maisAntiga < chaveMaisAntiga)) break;
  }
  return faturas;
}

// Todos os lançamentos Full de uma fatura, deduplicados por detail_id.
async function lerFatura(leitor, chave, acumulado) {
  const tipos = SUBTIPOS_FULL.join(",");
  let total = null;
  for (let passada = 1; passada <= MAX_PASSADAS; passada++) {
    let offset = 0;
    for (;;) {
      const r = await leitor.get(
        `/billing/integration/periods/key/${chave}/group/ML/details?document_type=BILL&detail_sub_types=${tipos}&limit=${PAGINA}&offset=${offset}`
      );
      if (r.status === 404) return { total: 0 };
      if (r.status !== 200) throw falhaHttp(r, `details ${chave}`);
      total = Number(r.data?.total || 0);
      const res = Array.isArray(r.data?.results) ? r.data.results : [];
      for (const d of res) {
        const id = d?.charge_info?.detail_id;
        if (id != null) acumulado.set(`${chave}:${id}`, d);
      }
      offset += res.length;
      if (!res.length || offset >= total) break;
    }
    const unicos = [...acumulado.keys()].filter((k) => k.startsWith(`${chave}:`)).length;
    if (unicos >= total) return { total };
  }
  throw erroMl(
    "ML_BILLING_INCOMPLETO",
    `A fatura ${chave} do ML não fechou: a paginação devolveu menos lançamentos que o total informado.`
  );
}

function linhaParaResposta(row, fonte) {
  const parse = (v) => (typeof v === "string" ? JSON.parse(v) : v) || [];
  return {
    disponivel: true,
    fonte,
    custoFull: Number(row.custo_full),
    lancamentos: Number(row.lancamentos),
    componentes: parse(row.componentes),
    faturas: parse(row.faturas),
    definitivo: row.definitivo === true,
    consultadoEm: new Date(row.consultado_em).toISOString(),
  };
}

function defaultDeps() {
  return {
    db: pool,
    mlFetch,
    resolveMarketplaceAccountContext,
    ensureSchema: ensureFinanceiroFullCacheSchema,
    agora: () => new Date(),
    dormir: (ms) => new Promise((r) => setTimeout(r, ms)),
    relogio: () => Date.now(),
    consultasEmCurso: CONSULTAS_EM_CURSO,
  };
}

async function consultarMl(deps, { clienteSlug, clienteContaId, periodo }) {
  let ctx;
  try {
    ctx = await deps.resolveMarketplaceAccountContext({
      clienteSlug,
      marketplace: "meli",
      clienteContaId,
      requireUsableGrant: true,
      strictIdentity: true,
      resolveBase: false,
    });
  } catch (err) {
    if (err?.statusCode) throw err; // 404/409 estruturais propagam
    throw erroMl("NO_TOKEN", "A conta não está conectada ao Mercado Livre.");
  }
  if (!ctx?.mlUserId) throw erroMl("NO_TOKEN", "A conta não está conectada ao Mercado Livre.");

  const leitor = criarLeitor({ fetchMl: deps.mlFetch, clienteId: ctx.cliente.id, mlUserId: ctx.mlUserId, dormir: deps.dormir, relogio: deps.relogio });
  const chaves = chavesDasFaturas(periodo);
  const existentes = await listarFaturas(leitor, chaves[0]);

  const acumulado = new Map();
  const faturas = [];
  for (const chave of chaves) {
    if (!existentes.has(chave)) continue;
    await lerFatura(leitor, chave, acumulado);
    faturas.push({ key: chave, status: existentes.get(chave) });
  }
  const definitivo = chaves.every((c) => existentes.get(c) === "CLOSED");
  return { ...somarDoMes(acumulado, periodo), faturas, definitivo };
}

async function obterFullDoFechamento({ clienteSlugRaw, clienteContaIdRaw, periodoRaw, atualizarRaw }, depsOverride = {}) {
  const deps = { ...defaultDeps(), ...depsOverride };
  const clienteSlug = String(clienteSlugRaw || "").trim();
  const periodo = String(periodoRaw || "").trim();
  const clienteContaId = /^\d+$/.test(String(clienteContaIdRaw || "")) ? Number(clienteContaIdRaw) : null;
  const atualizar = ["1", "true"].includes(String(atualizarRaw || "").toLowerCase());

  if (!clienteSlug) throw erroHttp(400, "CLIENTE_OBRIGATORIO", "Cliente é obrigatório.");
  if (!clienteContaId) throw erroHttp(400, "CONTA_OBRIGATORIA", "A conta (conta=) é obrigatória.");
  if (!PERIODO_REGEX.test(periodo)) throw erroHttp(400, "PERIODO_INVALIDO", "periodo é obrigatório no formato YYYY-MM.");

  await deps.ensureSchema(deps.db);

  // cliente_slug junto da conta: só volta cache de uma consulta que passou
  // pela resolução estrita deste mesmo par.
  if (!atualizar) {
    const { rows } = await deps.db.query(
      `SELECT * FROM financeiro_full_cache
        WHERE cliente_conta_id = $1 AND mes_ref = $2 AND cliente_slug = $3`,
      [clienteContaId, periodo, clienteSlug]
    );
    if (rows.length && cacheValido(rows[0], deps.agora())) return linhaParaResposta(rows[0], "cache");
  }

  // Uma leitura por vez por cliente+conta+mês neste processo: a 2ª abertura
  // do drawer durante a 1ª consulta (~1 min) espera a mesma, em vez de
  // disputar o limite de taxa do ML com ela.
  const chaveEmCurso = `${clienteSlug}|${clienteContaId}|${periodo}`;
  let emCurso = deps.consultasEmCurso.get(chaveEmCurso);
  if (!emCurso) {
    emCurso = consultarMl(deps, { clienteSlug, clienteContaId, periodo });
    deps.consultasEmCurso.set(chaveEmCurso, emCurso);
    emCurso.then(
      () => deps.consultasEmCurso.delete(chaveEmCurso),
      () => deps.consultasEmCurso.delete(chaveEmCurso)
    );
  }

  let resultado;
  try {
    resultado = await emCurso;
  } catch (err) {
    if (!err?.fullCodigo) throw err;
    console.warn(`[financeiro-full] cliente=${clienteSlug} conta=${clienteContaId} periodo=${periodo} ${err.fullCodigo}: ${err.message}`);
    return { disponivel: false, codigo: err.fullCodigo, motivo: err.message };
  }

  const { rows } = await deps.db.query(
    `INSERT INTO financeiro_full_cache
       (cliente_conta_id, mes_ref, cliente_slug, custo_full, lancamentos, componentes, faturas, definitivo, consultado_em)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, NOW())
     ON CONFLICT (cliente_conta_id, mes_ref) DO UPDATE SET
       cliente_slug  = EXCLUDED.cliente_slug,
       custo_full    = EXCLUDED.custo_full,
       lancamentos   = EXCLUDED.lancamentos,
       componentes   = EXCLUDED.componentes,
       faturas       = EXCLUDED.faturas,
       definitivo    = EXCLUDED.definitivo,
       consultado_em = NOW()
     RETURNING *`,
    [
      clienteContaId,
      periodo,
      clienteSlug,
      resultado.custoFull,
      resultado.lancamentos,
      JSON.stringify(resultado.componentes),
      JSON.stringify(resultado.faturas),
      resultado.definitivo,
    ]
  );
  return linhaParaResposta(rows[0], "ao_vivo");
}

module.exports = { obterFullDoFechamento, chavesDasFaturas, somarDoMes, cacheValido, SUBTIPOS_FULL };
