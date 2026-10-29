// server/tests/centralVendasRetencaoPlanner.test.js
//
// Retenção da Central de Vendas — planner PURO (sem banco).
//
// PARTE 1 — regras: dominância por cobertura (parcial/total/NULL), legacy,
//           candidate (resíduo), conta NULL × conta, manterUltimos, minIdade,
//           refs protegidas, run ativo, políticas desligadas, mp_payments.
// PARTE 2 — propriedade: N cenários aleatórios; para TODO segmento do mês e
//           TODA variante de conta (exata / includeLegacy), a seleção
//           canônica (selecionarMelhorImportPorCompetencia) é a mesma antes e
//           depois de remover os elegíveis.

const assert = require("assert");
const { planejarRetencao, lerPolitica } = require("../services/centralVendas/retencao/centralVendasRetencaoPlanner");
const { selecionarMelhorImportPorCompetencia } = require("../services/centralVendas/centralVendasRepository");

let checks = 0;
function check(label, fn) {
  fn();
  checks += 1;
  console.log(`  ok  ${label}`);
}

const VELHO = "2026-01-01T00:00:00Z";
const AGORA = "2026-10-29T12:00:00Z";
const cfgBase = { agora: AGORA, minIdadeHoras: 72, manterUltimosSubstituidos: 0 };

let seq = 0;
function imp(over = {}) {
  seq += 1;
  const t = new Date(Date.parse(VELHO) + seq * 3600 * 1000).toISOString();
  return {
    id: seq,
    cliente_slug: "loja",
    marketplace: "meli",
    competencia: "2026-09",
    cliente_conta_id: 5,
    publication_status: "published",
    coverage_date_from: "2026-09-01",
    coverage_date_to: "2026-09-30",
    created_at: t,
    published_at: t,
    sync_run_id: null,
    ...over,
  };
}

function classe(plano, id) {
  return plano.motivos[id].classe;
}

console.log("PARTE 1 — regras do planner");

check("published com cobertura contida em outro mais novo é substituído; o mais novo é essencial", () => {
  seq = 0;
  const a = imp({ coverage_date_to: "2026-09-15" });
  const b = imp({ coverage_date_to: "2026-09-30" });
  const plano = planejarRetencao({ imports: [a, b], cfg: cfgBase });
  assert.strictEqual(classe(plano, a.id), "substituido");
  assert.ok(plano.motivos[a.id].motivos.includes(`dominado_por:${b.id}`));
  assert.strictEqual(classe(plano, b.id), "essencial");
  assert.deepStrictEqual(plano.elegiveis, [a.id]);
});

check("cobertura parcial NÃO contida (mais novo cobre 01→15, antigo 10→30) — ambos ficam", () => {
  seq = 0;
  const a = imp({ coverage_date_from: "2026-09-10", coverage_date_to: "2026-09-30" });
  const b = imp({ coverage_date_from: "2026-09-01", coverage_date_to: "2026-09-15" });
  const plano = planejarRetencao({ imports: [a, b], cfg: cfgBase });
  assert.strictEqual(classe(plano, a.id), "essencial");
  assert.strictEqual(classe(plano, b.id), "essencial");
  assert.deepStrictEqual(plano.elegiveis, []);
});

check("published mais NOVO com cobertura menor não domina o antigo maior", () => {
  seq = 0;
  const a = imp({ coverage_date_to: "2026-09-30" });
  const b = imp({ coverage_date_to: "2026-09-20" });
  const plano = planejarRetencao({ imports: [a, b], cfg: cfgBase });
  // b ⊂ a, mas a é mais ANTIGO: b vence 01→20 e a ainda serve 21→30.
  assert.strictEqual(classe(plano, a.id), "essencial");
  assert.strictEqual(classe(plano, b.id), "essencial");
});

check("published com cobertura NULL não domina ninguém e não é eliminado", () => {
  seq = 0;
  const a = imp({ coverage_date_to: "2026-09-15" });
  const b = imp({ coverage_date_from: null, coverage_date_to: null });
  const plano = planejarRetencao({ imports: [a, b], cfg: cfgBase });
  assert.strictEqual(classe(plano, a.id), "essencial");
  assert.strictEqual(classe(plano, b.id), "retido");
  assert.ok(plano.motivos[b.id].motivos.includes("published_sem_cobertura"));
});

check("legacy: o mais recente fica, os anteriores são substituídos", () => {
  seq = 0;
  const l1 = imp({ publication_status: "legacy", coverage_date_from: null, coverage_date_to: null, published_at: null });
  const l2 = imp({ publication_status: "legacy", coverage_date_from: null, coverage_date_to: null, published_at: null });
  const plano = planejarRetencao({ imports: [l1, l2], cfg: cfgBase });
  assert.strictEqual(classe(plano, l1.id), "substituido");
  assert.strictEqual(classe(plano, l2.id), "essencial");
});

check("legacy dominado por published do mês inteiro; published parcial não domina legacy", () => {
  seq = 0;
  const l = imp({ publication_status: "legacy", coverage_date_from: null, coverage_date_to: null, published_at: null });
  const pParcial = imp({ coverage_date_to: "2026-09-20" });
  let plano = planejarRetencao({ imports: [l, pParcial], cfg: cfgBase });
  assert.strictEqual(classe(plano, l.id), "essencial", "legacy ainda serve 21→30");
  const pMes = imp();
  plano = planejarRetencao({ imports: [l, pParcial, pMes], cfg: cfgBase });
  assert.strictEqual(classe(plano, l.id), "substituido");
  assert.ok(plano.motivos[l.id].motivos.includes(`published_mes_inteiro:${pMes.id}`));
});

check("incluirLegacy=false mantém legacy dominado como retido", () => {
  seq = 0;
  const l1 = imp({ publication_status: "legacy", coverage_date_from: null, coverage_date_to: null });
  const l2 = imp({ publication_status: "legacy", coverage_date_from: null, coverage_date_to: null });
  const plano = planejarRetencao({ imports: [l1, l2], cfg: { ...cfgBase, incluirLegacy: false } });
  assert.strictEqual(classe(plano, l1.id), "retido");
  assert.deepStrictEqual(plano.elegiveis, []);
});

check("tupla exata: conta NULL e conta 5 são tuplas separadas (nada domina através da conta)", () => {
  seq = 0;
  const legado = imp({ cliente_conta_id: null, coverage_date_to: "2026-09-10" });
  const conta = imp({ cliente_conta_id: 5 });
  const plano = planejarRetencao({ imports: [legado, conta], cfg: cfgBase });
  assert.strictEqual(classe(plano, legado.id), "essencial", "NULL não é dominado por conta 5");
  assert.strictEqual(plano.tuplas.length, 2);
});

check("candidate: run failed ⇒ resíduo; run completed + published mais novo ⇒ resíduo; run running ⇒ nunca", () => {
  seq = 0;
  const runs = [
    { id: 1, status: "failed", created_at: VELHO, finished_at: VELHO },
    { id: 2, status: "completed", created_at: VELHO, finished_at: VELHO },
    { id: 3, status: "running", created_at: VELHO },
    { id: 4, status: "completed", created_at: VELHO, finished_at: VELHO },
  ];
  const cFalho = imp({ publication_status: "candidate", published_at: null, sync_run_id: 1 });
  const cSemPub = imp({ publication_status: "candidate", published_at: null, sync_run_id: 4 });
  const cOk = imp({ publication_status: "candidate", published_at: null, sync_run_id: 2 });
  const p = imp();
  const cRunning = imp({ publication_status: "candidate", published_at: null, sync_run_id: 3 });
  const plano = planejarRetencao({ imports: [cFalho, cSemPub, cOk, p, cRunning], runs, cfg: cfgBase });
  assert.strictEqual(classe(plano, cFalho.id), "residuo");
  assert.strictEqual(classe(plano, cOk.id), "residuo");
  assert.strictEqual(classe(plano, cSemPub.id), "residuo", "há published mais novo (p) na tupla");
  assert.strictEqual(classe(plano, cRunning.id), "retido");
  // sem o published, o candidate de run completed fica
  const plano2 = planejarRetencao({ imports: [cSemPub], runs, cfg: cfgBase });
  assert.strictEqual(classe(plano2, cSemPub.id), "retido");
  const plano3 = planejarRetencao({ imports: [cFalho], runs, cfg: { ...cfgBase, incluirCandidates: false } });
  assert.strictEqual(classe(plano3, cFalho.id), "retido");
});

check("manterUltimosSubstituidos=1 protege o published dominado mais recente; 2 protege dois", () => {
  seq = 0;
  const a = imp();
  const b = imp();
  const c = imp();
  const d = imp();
  let plano = planejarRetencao({ imports: [a, b, c, d], cfg: { ...cfgBase, manterUltimosSubstituidos: 1 } });
  assert.deepStrictEqual(plano.essencial, [c.id, d.id]);
  assert.ok(plano.motivos[c.id].motivos.includes("margem_rollback"));
  assert.deepStrictEqual(plano.substituido, [a.id, b.id]);
  plano = planejarRetencao({ imports: [a, b, c, d], cfg: { ...cfgBase, manterUltimosSubstituidos: 2 } });
  assert.deepStrictEqual(plano.substituido, [a.id]);
});

check("minIdadeHoras: dominado criado há menos de 72h é essencial (recente)", () => {
  seq = 0;
  const a = imp({ created_at: "2026-10-28T00:00:00Z", published_at: "2026-10-28T00:00:00Z" });
  const b = imp({ created_at: "2026-10-29T00:00:00Z", published_at: "2026-10-29T00:00:00Z" });
  const plano = planejarRetencao({ imports: [a, b], cfg: cfgBase });
  assert.strictEqual(classe(plano, a.id), "essencial");
  assert.ok(plano.motivos[a.id].motivos.includes("recente"));
  const plano0 = planejarRetencao({ imports: [a, b], cfg: { ...cfgBase, minIdadeHoras: 0 } });
  assert.strictEqual(classe(plano0, a.id), "substituido");
});

check("published antigo republicado há pouco (published_at recente) conta como recente", () => {
  seq = 0;
  const a = imp({ created_at: VELHO, published_at: "2026-10-29T00:00:00Z", coverage_date_to: "2026-09-10" });
  const b = imp({ created_at: VELHO, published_at: "2026-10-29T01:00:00Z" });
  const plano = planejarRetencao({ imports: [a, b], cfg: cfgBase });
  assert.strictEqual(classe(plano, a.id), "essencial");
});

check("refs protegidas (Painel/outros) e run ativo tornam o dominado essencial", () => {
  seq = 0;
  const runs = [{ id: 9, status: "running", created_at: VELHO }];
  const a = imp();
  const b = imp({ sync_run_id: 9 });
  const c = imp();
  const plano = planejarRetencao({
    imports: [a, b, c], runs,
    refsProtegidas: { imports: new Map([[a.id, ["painel_contas_snapshot"]]]) },
    cfg: cfgBase,
  });
  assert.strictEqual(classe(plano, a.id), "essencial");
  assert.ok(plano.motivos[a.id].motivos.includes("referenciado:painel_contas_snapshot"));
  assert.strictEqual(classe(plano, b.id), "essencial");
  assert.ok(plano.motivos[b.id].motivos.includes("run_ativo"));
});

check("mp_payments: só runs sem import retido, terminais e antigos; runs sem import entram", () => {
  seq = 0;
  const runs = [
    { id: 1, status: "completed", created_at: VELHO, finished_at: VELHO, tem_mp_payments: true }, // do import substituído
    { id: 2, status: "completed", created_at: VELHO, finished_at: VELHO, tem_mp_payments: true }, // do vigente
    { id: 3, status: "completed", created_at: VELHO, finished_at: VELHO, tem_mp_payments: true }, // sem import
    { id: 4, status: "running", created_at: VELHO, tem_mp_payments: true },
    { id: 5, status: "failed", created_at: "2026-10-29T00:00:00Z", finished_at: "2026-10-29T01:00:00Z", tem_mp_payments: true },
    { id: 6, status: "completed", created_at: VELHO, finished_at: VELHO, tem_mp_payments: true }, // ref externa
    { id: 7, status: "completed", created_at: VELHO, finished_at: VELHO, tem_mp_payments: false },
  ];
  const a = imp({ sync_run_id: 1 });
  const b = imp({ sync_run_id: 2 });
  const plano = planejarRetencao({ imports: [a, b], runs, refsProtegidas: { runs: [6] }, cfg: cfgBase });
  assert.deepStrictEqual(plano.mp.elegiveis, [1, 3]);
  assert.deepStrictEqual(plano.mp.retidos, [2, 4, 5, 6]);
  assert.ok(plano.mp.motivos[2].includes("run_de_import_retido"));
  const desligado = planejarRetencao({ imports: [a, b], runs, cfg: { ...cfgBase, incluirMpPayments: false } });
  assert.deepStrictEqual(desligado.mp.elegiveis, []);
});

check("lerPolitica: padrão, env e args (args vencem; inválido cai no padrão)", () => {
  assert.deepStrictEqual(lerPolitica({}), {
    minIdadeHoras: 72, manterUltimosSubstituidos: 1, incluirLegacy: true, incluirCandidates: true, incluirMpPayments: true,
  });
  const p = lerPolitica(
    { CENTRAL_VENDAS_RETENCAO_MIN_IDADE_HORAS: "24", CENTRAL_VENDAS_RETENCAO_INCLUIR_LEGACY: "false", CENTRAL_VENDAS_RETENCAO_MANTER_ULTIMOS: "-3" },
    { minIdadeHoras: 100 }
  );
  assert.strictEqual(p.minIdadeHoras, 100);
  assert.strictEqual(p.incluirLegacy, false);
  assert.strictEqual(p.manterUltimosSubstituidos, 1);
});

console.log("PARTE 2 — propriedade: seleção idêntica antes/depois da remoção");

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function dia(n) {
  return `2026-09-${String(n).padStart(2, "0")}`;
}

function variantesDeConta(contas) {
  const out = [];
  for (const c of contas) {
    out.push({ nome: `exata:${c}`, filtro: (r) => (r.cliente_conta_id ?? null) === c });
    if (c !== null) out.push({ nome: `includeLegacy:${c}`, filtro: (r) => r.cliente_conta_id === c || r.cliente_conta_id == null });
  }
  return out;
}

check("200 cenários × todos os segmentos × todas as variantes de conta", () => {
  const rand = rng(20261029);
  const contas = [null, 5, 6];
  const variantes = variantesDeConta(contas);
  let comparacoes = 0;
  let removidosTotal = 0;
  for (let cenario = 0; cenario < 200; cenario += 1) {
    const n = 1 + Math.floor(rand() * 14);
    const imports = [];
    const runs = [];
    for (let i = 1; i <= n; i += 1) {
      const r = rand();
      const status = r < 0.55 ? "published" : r < 0.8 ? "legacy" : "candidate";
      let from = 1 + Math.floor(rand() * 30);
      let to = 1 + Math.floor(rand() * 30);
      if (from > to) [from, to] = [to, from];
      if (rand() < 0.3) { from = 1; to = 30; }
      const semCobertura = rand() < 0.1;
      // published_at com empates para exercitar o desempate por id
      const pub = new Date(Date.parse(VELHO) + Math.floor(rand() * 6) * 86400000).toISOString();
      const criado = new Date(Date.parse(VELHO) + Math.floor(rand() * 6) * 86400000).toISOString();
      const runStatus = ["completed", "failed", "running", "queued"][Math.floor(rand() * 4)];
      runs.push({ id: 100 + i, status: runStatus, created_at: VELHO, finished_at: VELHO, tem_mp_payments: rand() < 0.5 });
      imports.push({
        id: i,
        cliente_slug: "loja",
        marketplace: "meli",
        competencia: "2026-09",
        cliente_conta_id: contas[Math.floor(rand() * contas.length)],
        publication_status: status,
        coverage_date_from: semCobertura ? null : dia(from),
        coverage_date_to: semCobertura ? null : dia(to),
        created_at: criado,
        published_at: status === "published" ? pub : null,
        sync_run_id: 100 + i,
      });
    }
    const refs = new Map();
    if (rand() < 0.3) refs.set(1 + Math.floor(rand() * n), ["painel_contas_snapshot"]);
    const plano = planejarRetencao({
      imports, runs, refsProtegidas: { imports: refs },
      cfg: { agora: AGORA, minIdadeHoras: 72, manterUltimosSubstituidos: Math.floor(rand() * 3) },
    });
    const removidos = new Set(plano.elegiveis);
    removidosTotal += removidos.size;
    for (const id of refs.keys()) assert.ok(!removidos.has(id), "ref protegida removida");
    const depois = imports.filter((r) => !removidos.has(r.id));
    for (const v of variantes) {
      const antesV = imports.filter(v.filtro);
      const depoisV = depois.filter(v.filtro);
      for (let s = 1; s <= 30; s += 1) {
        for (let e = s; e <= 30; e += 1) {
          const seg = { segmentStart: dia(s), segmentEnd: dia(e) };
          const a = selecionarMelhorImportPorCompetencia(antesV, seg);
          const d = selecionarMelhorImportPorCompetencia(depoisV, seg);
          assert.strictEqual(d ? d.id : null, a ? a.id : null,
            `cenário ${cenario} variante ${v.nome} segmento ${s}→${e}: antes=${a && a.id} depois=${d && d.id}`);
          comparacoes += 1;
        }
      }
    }
  }
  assert.ok(removidosTotal > 50, `cenários removeram pouco (${removidosTotal}) — propriedade fraca`);
  console.log(`      ${comparacoes} comparações, ${removidosTotal} imports removidos no total`);
});

console.log(`\n✓ centralVendasRetencaoPlanner: ${checks} checks`);
