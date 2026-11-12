// server/tests/margemPrecificacaoAdversarial.test.js
//
// Casos ADVERSARIAIS da escrita da Central de Margem (remediação bloqueante):
// fencing/lease entre duas instâncias, timeout, preview imutável
// (fingerprint), recotação obrigatória, semântica da promoção, autor ×
// aplicador, preço confirmado divergente, propagação durável do snapshot,
// 'aplicando' preso, retry idempotente, schema concorrente e rollout OFF.
//
// "Duas instâncias" = dois conjuntos de deps (tokens próprios) compartilhando
// o MESMO repositório (o banco) e o MESMO estado do ML. O relógio do banco é
// controlado (`agora`) para vencer leases sem esperar. Nenhum Postgres real,
// nenhuma chamada ao ML, nenhuma escrita real — o SQL de verdade destas
// transições é provado em scripts/margemPrecificacaoSqlCheck.js (PGlite).

process.env.DATABASE_URL = "postgres://127.0.0.1:1/margem-adversarial-nunca-conecta";

const assert = require("assert");
const service = require("../services/motorMargem/precificacao/precificacaoService");
const { resolvePricingConfig } = require("../services/motorMargem/precificacao/precificacaoConfig");
const { computeMargin } = require("../services/motorMargem/core/marginEngine");
const schemaEnsure = require("../services/schema/schemaEnsure");
const { motorItem, promo, criarCenario, criarRepoMemoria } = require("./helpers/margemPrecificacaoFakes");

const casos = [];
function caso(nome, fn) { casos.push({ nome, fn }); }

async function esperaErro(fn) {
  try { await fn(); } catch (err) { return err; }
  throw new Error("era esperado um erro");
}
const tick = async (n = 6) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r)); };

// Preço e promoção têm rollouts próprios; as duas escritas ficam LIGADAS para a loja-a (os testes de rollout trocam o env).
const ESCRITA_ON = { MARGIN_PRICING_WRITE_CLIENTES: "loja-a", MARGIN_PROMO_WRITE_ENABLED: "true", MARGIN_PROMO_WRITE_CLIENTES: "loja-a", MARGIN_PRICING_SIMULACAO_CACHE_MS: "0", MARGIN_PRICING_SNAPSHOT_DELAY_MS: "0" };
const CFG = resolvePricingConfig(ESCRITA_ON);
const USER_A = { id: 9, nome: "Pedro", email: "p@x" };
const USER_B = { id: 10, nome: "Ana", email: "a@x" };

/** Mundo compartilhado: 1 banco (repo), 1 ML (estado), relógio controlado. */
function mundo(extra = {}) {
  const relogio = { t: Date.parse("2026-09-30T12:00:00Z") };
  const repo = criarRepoMemoria({ agora: () => relogio.t });
  const c = criarCenario({ env: ESCRITA_ON, ...extra });
  let n = 0;
  const instancia = (nome) => ({ ...c.deps, repo, now: () => new Date(relogio.t), novoToken: () => `${nome}-${++n}` });
  return { c, repo, relogio, A: instancia("A"), B: instancia("B"), avancar: (s) => { relogio.t += s * 1000; } };
}

function previewPreco(deps, user = USER_A, extra = {}) {
  return service.preview({ clienteSlug: "loja-a", clienteContaId: 7, itemId: "MLB100", tipo: "PRICE", novoPreco: "114.90", precoVisto: 110.48, user, ...extra }, deps);
}
function previewPromo(deps, user = USER_A, extra = {}) {
  return service.preview({ clienteSlug: "loja-a", clienteContaId: 7, itemId: "MLB100", tipo: "PROMOTION", promotionId: "P-DEAL-1", precoVisto: 149.9, user, ...extra }, deps);
}
function aplicar(deps, pv, user = USER_A, key = "chave-adv-0001", extra = {}) {
  return service.aplicar({
    clienteSlug: "loja-a", clienteContaId: 7, previewId: pv.preview.id, fingerprint: pv.preview.fingerprint, idempotencyKey: key, user, ...extra,
  }, deps);
}
function obter(deps, id) {
  return service.obterAplicacao({ clienteSlug: "loja-a", clienteContaId: 7, id }, deps);
}
function segurar() {
  let soltar;
  const p = new Promise((r) => { soltar = r; });
  return { p, soltar };
}

// ── 1. duas instâncias, mesmo item ─────────────────────────────────────────
caso("1. duas instâncias aplicam o MESMO item ao mesmo tempo: exatamente 1 envio ao ML", async () => {
  const m = mundo();
  const pa = await previewPreco(m.A, USER_A);
  const pb = await previewPreco(m.B, USER_B, { novoPreco: "116.90" });
  const r = await Promise.allSettled([aplicar(m.A, pa, USER_A, "inst-a-0001"), aplicar(m.B, pb, USER_B, "inst-b-0001")]);
  assert.strictEqual(m.c.chamadas.enviosMl.length, 1);
  const recusa = r.find((x) => x.status === "rejected");
  assert.ok(recusa && ["APLICACAO_EM_ANDAMENTO", "PREVIEW_SUPERADO"].includes(recusa.reason.code), recusa && recusa.reason.code);
  assert.strictEqual(m.repo.linhas.filter((l) => l.status === "aplicado").length, 1);
});

// ── 2. lease vence enquanto A está viva ────────────────────────────────────
caso("2. lease de A vence durante a reavaliação: B assume, A volta e NÃO escreve nem finaliza", async () => {
  const m = mundo();
  const pa = await previewPreco(m.A, USER_A);
  const pb = await previewPreco(m.B, USER_B, { novoPreco: "116.90" });
  const trava = segurar();
  let primeira = true;
  m.c.estado.montarItensHook = async () => { if (primeira) { primeira = false; await trava.p; } };
  const execA = aplicar(m.A, pa, USER_A, "lease-a-0001");
  await tick();
  assert.strictEqual(m.repo.linhas[0].status, "aplicando");
  // Enquanto o lease de A vale, B é barrada.
  assert.strictEqual((await esperaErro(() => aplicar(m.B, pb, USER_B, "lease-b-0001"))).code, "APLICACAO_EM_ANDAMENTO");
  m.avancar(CFG.leaseSegundos + CFG.carenciaLeaseSegundos + 1);
  const rb = await aplicar(m.B, pb, USER_B, "lease-b-0002");
  assert.strictEqual(rb.ok, true, JSON.stringify(rb));
  assert.strictEqual(m.repo.linhas[0].status, "falhou");
  assert.strictEqual(m.repo.linhas[0].erroCodigo, "APLICACAO_INTERROMPIDA_SEM_ESCRITA");
  trava.soltar();
  const ra = await execA;
  assert.strictEqual(ra.ok, false);
  assert.strictEqual(ra.codigo, "FENCING_OBSOLETO");
  assert.strictEqual(m.c.chamadas.enviosMl.length, 1, "só B enviou");
  assert.strictEqual(m.c.chamadas.enviosMl[0].preco, 116.9);
  assert.strictEqual(m.repo.linhas[0].status, "falhou", "A não sobrescreve o desfecho reconciliado");
});

// ── 3. fencing antigo tenta persistir depois ───────────────────────────────
caso("3. A enviou e travou; lease vence e é reconciliado; a resposta tardia de A vira evidência, sem posse", async () => {
  const m = mundo();
  const pa = await previewPreco(m.A, USER_A);
  const pb = await previewPreco(m.B, USER_B, { novoPreco: "116.90" });
  const trava = segurar();
  m.c.estado.aoEnviar = async (p) => { await trava.p; return { ok: true, preco: p.novoPreco }; };
  const execA = aplicar(m.A, pa, USER_A, "tardio-a-0001");
  await tick(10);
  assert.ok(m.repo.linhas[0].escritaEnviadaEm, "A passou do fencing e enviou");
  m.avancar(CFG.leaseEscritaSegundos + CFG.carenciaLeaseSegundos + 1);
  // B: o preview é anterior ao envio de A → superado (mesmo com o ML sem propagar).
  const eb = await esperaErro(() => aplicar(m.B, pb, USER_B, "tardio-b-0001"));
  assert.strictEqual(eb.code, "PREVIEW_SUPERADO");
  assert.strictEqual(m.repo.linhas[0].status, "resultado_desconhecido");
  m.c.estado.aoEnviar = null;
  trava.soltar();
  const ra = await execA;
  assert.strictEqual(ra.codigo, "FENCING_OBSOLETO");
  const linhaA = m.repo.linhas[0];
  assert.strictEqual(linhaA.status, "resultado_desconhecido", "status não volta para 'aplicado' pela mão de quem perdeu a posse");
  assert.strictEqual(linhaA.resultadoTardio.preco, 114.9, "a resposta tardia fica como evidência");
  assert.strictEqual(m.c.chamadas.enviosMl.length, 1);
});

// ── 4. timeout HTTP ────────────────────────────────────────────────────────
caso("4. timeout HTTP: enviado → resultado_desconhecido; não enviado (prazo) → falhou; prazo cabe no lease", async () => {
  const m = mundo();
  const pa = await previewPreco(m.A);
  m.c.estado.aoEnviar = async () => ({ ok: false, codigo: "ML_TIMEOUT", motivo: "sem resposta", enviado: true, incerto: true });
  const r = await aplicar(m.A, pa);
  assert.strictEqual(r.codigo, "ML_TIMEOUT");
  assert.strictEqual(m.repo.linhas[0].status, "resultado_desconhecido");
  const envio = m.c.chamadas.enviosMl[0];
  assert.strictEqual(envio.timeoutMs, CFG.mlTimeoutMs);
  assert.ok(CFG.mlTimeoutMs / 1000 + CFG.margemSegurancaSegundos < CFG.leaseEscritaSegundos, "invariante: timeout + folga < lease de escrita");

  const m2 = mundo();
  const p2 = await previewPreco(m2.A);
  m2.c.estado.aoEnviar = async () => ({ ok: false, codigo: "ML_DEADLINE_EXCEEDED", motivo: "prazo", enviado: false });
  const r2 = await aplicar(m2.A, p2, USER_A, "deadline-0001");
  assert.strictEqual(r2.codigo, "ML_DEADLINE_EXCEEDED");
  assert.strictEqual(m2.repo.linhas[0].status, "falhou");
});

// ── 5. preço muda antes do writer ──────────────────────────────────────────
caso("5. preço muda entre a reavaliação e o PUT: o escritor compara com o preço visto e bloqueia", async () => {
  const m = mundo();
  const pa = await previewPreco(m.A);
  m.c.estado.antesDaReleituraDoEscritor = () => { m.c.estado.precoVivo = 112; };
  const r = await aplicar(m.A, pa);
  assert.strictEqual(r.codigo, "PRECO_ALTERADO");
  assert.strictEqual(r.novoPreviewNecessario, true);
  assert.strictEqual(m.repo.linhas[0].status, "recusado");
  assert.strictEqual(m.c.chamadas.enviosMl.length, 0);

  const mp = mundo({ motor: motorItem({ preco: 149.9 }) });
  const pp = await previewPromo(mp.A);
  mp.c.estado.antesDaReleituraDoEscritor = () => { mp.c.estado.precoVivo = 145; };
  const rp = await aplicar(mp.A, pp, USER_A, "promo-preco-01");
  assert.strictEqual(rp.codigo, "PRECO_ALTERADO", "promoção: preço do anúncio relido no gancho");
  assert.strictEqual(mp.c.chamadas.enviosMl.length, 0);
});

// ── 6–9. componentes financeiros mudam depois do preview ───────────────────
for (const [n, nome, mudar, campo] of [
  [6, "custo", (e) => { e.motor = motorItem({ custo: 55 }); }, "custo"],
  [7, "imposto", (e) => { e.motor = motorItem({ imposto: 0.12 }); }, "imposto"],
  [8, "comissão", (e) => { e.cotacao = (p) => ({ comissaoValor: Math.round(p * 0.13 * 100) / 100, fretePrevisto: 20 }); }, "comissao"],
  [9, "frete", (e) => { e.cotacao = (p) => ({ comissaoValor: Math.round(p * 0.12 * 100) / 100, fretePrevisto: 24.9 }); }, "frete"],
]) {
  caso(`${n}. ${nome} muda depois do preview → PREVIEW_DESATUALIZADO (nunca atualiza a intenção em silêncio)`, async () => {
    const m = mundo();
    const pa = await previewPreco(m.A);
    mudar(m.c.estado);
    const r = await aplicar(m.A, pa);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.codigo, "PREVIEW_DESATUALIZADO");
    assert.strictEqual(r.novoPreviewNecessario, true);
    assert.ok(r.diferencas.some((d) => d.campo === campo), JSON.stringify(r.diferencas));
    assert.strictEqual(m.repo.linhas[0].status, "recusado");
    assert.strictEqual(m.c.chamadas.enviosMl.length, 0);
  });
}

// ── 10. recotação falha ────────────────────────────────────────────────────
caso("10. recotação falha no aplicar → RECOTACAO_INDISPONIVEL, zero escrita (sem frete zero/reuso/taxa)", async () => {
  const m = mundo();
  const pa = await previewPreco(m.A);
  m.c.estado.cotacao = () => { throw new Error("listing_prices 503"); };
  const r = await aplicar(m.A, pa);
  assert.strictEqual(r.codigo, "RECOTACAO_INDISPONIVEL");
  assert.strictEqual(m.c.chamadas.enviosMl.length, 0);
  // Só o frete falhando também bloqueia.
  const m2 = mundo();
  const p2 = await previewPreco(m2.A);
  m2.c.estado.cotacao = (p) => ({ comissaoValor: Math.round(p * 0.12 * 100) / 100, fretePrevisto: null });
  const r2 = await aplicar(m2.A, p2, USER_A, "recot-frete-01");
  assert.strictEqual(r2.codigo, "RECOTACAO_INDISPONIVEL");
  assert.strictEqual(m2.c.chamadas.enviosMl.length, 0);
});

// ── 10b. frete estimado com confiança baixa / histórico antigo (P0 12/11/2026) ──
caso("10b. frete de confiança baixa no aplicar → bloqueado, zero escrita; confiança média passa; mesmo via idempotência nova", async () => {
  for (const [rotulo, q, idem] of [
    ["custo cobrado (baixa)", { nivel: "estimado_custo_cobrado", confianca: "baixa" }, "frete-baixa-01"],
    ["histórico antigo", { nivel: "estimado_dimensoes_historicas", confianca: "baixa", historicoAntigo: true }, "frete-antigo-01"],
  ]) {
    const m = mundo();
    const pa = await previewPreco(m.A); // a simulação/preview segue possível (aviso)
    m.c.estado.cotacao = (p) => ({ comissaoValor: Math.round(p * 0.12 * 100) / 100, fretePrevisto: 14.45, freteQualidade: q });
    const r = await aplicar(m.A, pa, USER_A, idem);
    assert.strictEqual(r.codigo, "RECOTACAO_INDISPONIVEL", rotulo);
    assert.strictEqual(m.c.chamadas.enviosMl.length, 0, `${rotulo}: nenhuma escrita no ML`);
    // Novo preview + nova chave de idempotência (o preview anterior é de uso único): continua bloqueado.
    const pb = await previewPreco(m.A);
    let recusa = null;
    try { recusa = await aplicar(m.A, pb, USER_A, `${idem}-b`); } catch (e) { recusa = e; }
    assert.ok(recusa && (recusa.codigo === "RECOTACAO_INDISPONIVEL" || /bloqueios e não pode ser aplicado/.test(recusa.message || "")), `${rotulo}: reaplicar não contorna: ${recusa && recusa.message}`);
    assert.strictEqual(m.c.chamadas.enviosMl.length, 0);
  }
  const ok = mundo();
  ok.c.estado.cotacao = (p) => ({ comissaoValor: Math.round(p * 0.12 * 100) / 100, fretePrevisto: 14.45, freteQualidade: { nivel: "estimado_dimensoes_declaradas", confianca: "media" } });
  const po = await previewPreco(ok.A); // preview e aplicar veem a mesma cotação (fingerprint)
  const rok = await aplicar(ok.A, po, USER_A, "frete-media-01");
  assert.ok(rok.ok || rok.status === "aplicado" || ok.c.chamadas.enviosMl.length === 1, `confiança média pode gravar: ${JSON.stringify(rok).slice(0, 200)}`);
});

// ── 11–13. semântica da promoção ───────────────────────────────────────────
caso("11. promoção muda de status (ELEGÍVEL → PROGRAMADA) → bloqueado, zero escrita", async () => {
  const m = mundo({ motor: motorItem({ preco: 149.9 }) });
  const pp = await previewPromo(m.A);
  m.c.estado.promocoes = [promo({ status: "pending", statusExibicao: "PROGRAMADA" })];
  const r = await aplicar(m.A, pp, USER_A, "promo-status-1");
  assert.strictEqual(r.ok, false);
  assert.ok(["GATE_PROMOCAO_ESCRITA", "PREVIEW_DESATUALIZADO"].includes(r.codigo), r.codigo);
  assert.strictEqual(m.c.chamadas.enviosMl.length, 0);
});

caso("12. promoção muda subsídio: antes do aplicar → PREVIEW_DESATUALIZADO; logo antes do POST → PROMOCAO_MUDOU", async () => {
  const m = mundo({ motor: motorItem({ preco: 149.9 }) });
  const pp = await previewPromo(m.A);
  m.c.estado.promocoes = [promo({ meliPercentage: 1.0, subsidioMl: 1.5 })];
  const r = await aplicar(m.A, pp, USER_A, "promo-sub-0001");
  assert.strictEqual(r.codigo, "PREVIEW_DESATUALIZADO");
  assert.ok(r.diferencas.some((d) => d.campo === "promocao.subsidioMl"));

  const m2 = mundo({ motor: motorItem({ preco: 149.9 }) });
  const p2 = await previewPromo(m2.A);
  m2.c.estado.antesDaReleituraDoEscritor = () => { m2.c.estado.promocoes = [promo({ sellerPercentage: 12, meliPercentage: 1 })]; };
  const r2 = await aplicar(m2.A, p2, USER_A, "promo-sub-0002");
  assert.strictEqual(r2.codigo, "PROMOCAO_MUDOU");
  assert.strictEqual(m2.c.chamadas.enviosMl.length, 0);
});

caso("13. PARTICIPAR vira ALTERAR: recusado PROMOCAO_INTENCAO_MUDOU (na reavaliação e no gancho do escritor)", async () => {
  const m = mundo({ motor: motorItem({ preco: 149.9 }) });
  const pp = await previewPromo(m.A);
  assert.strictEqual(m.repo.linhas[0].promotionAcao, "PARTICIPAR");
  m.c.estado.promocoes = [promo({ status: "started", statusExibicao: "ATIVA" })];
  const r = await aplicar(m.A, pp, USER_A, "promo-acao-001");
  assert.strictEqual(r.codigo, "PROMOCAO_INTENCAO_MUDOU");
  assert.strictEqual(m.c.chamadas.enviosMl.length, 0);

  const m2 = mundo({ motor: motorItem({ preco: 149.9 }) });
  const p2 = await previewPromo(m2.A);
  m2.c.estado.antesDaReleituraDoEscritor = () => { m2.c.estado.promocoes = [promo({ status: "started", statusExibicao: "ATIVA" })]; };
  const r2 = await aplicar(m2.A, p2, USER_A, "promo-acao-002");
  assert.strictEqual(r2.codigo, "PROMOCAO_INTENCAO_MUDOU");
  assert.strictEqual(m2.c.chamadas.enviosMl.length, 0, "nunca um PUT no lugar do POST confirmado");
});

// ── 14. autor × aplicador ──────────────────────────────────────────────────
caso("14. usuário B tenta aplicar o preview de A → 403; sem usuário → 403; replay por chave também exige o autor", async () => {
  const m = mundo();
  const pa = await previewPreco(m.A, USER_A);
  const e = await esperaErro(() => aplicar(m.B, pa, USER_B, "outro-user-01"));
  assert.strictEqual(e.statusCode, 403);
  assert.strictEqual(e.code, "PREVIEW_DE_OUTRO_USUARIO");
  const e2 = await esperaErro(() => aplicar(m.B, pa, {}, "outro-user-02"));
  assert.strictEqual(e2.code, "PREVIEW_DE_OUTRO_USUARIO");
  assert.strictEqual(m.repo.linhas[0].status, "preview");
  assert.strictEqual(m.c.chamadas.enviosMl.length, 0);
  const ok = await aplicar(m.A, pa, USER_A, "autor-ok-0001");
  assert.strictEqual(ok.ok, true);
  const e3 = await esperaErro(() => aplicar(m.B, pa, USER_B, "autor-ok-0001"));
  assert.strictEqual(e3.code, "PREVIEW_DE_OUTRO_USUARIO");
  // Fingerprint adulterado/de outro preview também não vale.
  const pb = await previewPreco(m.A, USER_A, { novoPreco: "118.90", precoVisto: 110.48 });
  const e4 = await esperaErro(() => aplicar(m.A, { preview: { id: pb.preview.id, fingerprint: pa.preview.fingerprint } }, USER_A, "fp-errado-0001"));
  assert.strictEqual(e4.code, "PREVIEW_FINGERPRINT_DIVERGENTE");
});

// ── 15–16. preço confirmado divergente ─────────────────────────────────────
caso("15. ML confirma preço ≠ solicitado: 'divergente', margem/LC recalculados sobre o CONFIRMADO", async () => {
  const m = mundo();
  const pa = await previewPreco(m.A);
  const margemPreview = m.repo.linhas[0].margemDepois;
  m.c.estado.respostaPreco = () => ({ ok: true, preco: 119.9 });
  const r = await aplicar(m.A, pa);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.divergente, true);
  const l = m.repo.linhas[0];
  assert.strictEqual(l.status, "divergente");
  assert.strictEqual(l.precoSolicitado, 114.9);
  assert.strictEqual(l.precoConfirmado, 119.9);
  const esperado = computeMargin({ price: 119.9, cost: 50, taxRate: 0.1, fixedFee: 0, commission: 14.39, freight: 20 });
  assert.strictEqual(l.lucroDepois, esperado.profit);
  assert.strictEqual(l.margemDepois, esperado.margin);
  assert.notStrictEqual(l.margemDepois, margemPreview, "nunca a margem do solicitado");
  assert.strictEqual(l.atencaoCodigo, "PRECO_CONFIRMADO_DIVERGENTE");
});

caso("16. confirmado abaixo do break-even → atenção ABAIXO_BREAK_EVEN; sem recotação no confirmado → margem nula", async () => {
  const m = mundo();
  const pa = await previewPreco(m.A);
  m.c.estado.respostaPreco = () => ({ ok: true, preco: 70 });
  await aplicar(m.A, pa);
  const l = m.repo.linhas[0];
  assert.strictEqual(l.status, "divergente");
  assert.ok(l.lucroDepois < 0);
  assert.strictEqual(l.atencaoCodigo, "PRECO_CONFIRMADO_ABAIXO_BREAK_EVEN");

  const m2 = mundo();
  const p2 = await previewPreco(m2.A);
  m2.c.estado.respostaPreco = () => ({ ok: true, preco: 99.9 });
  const cot = m2.c.estado.cotacao;
  m2.c.estado.cotacao = (p) => (Math.abs(p - 99.9) < 0.001 ? { comissaoValor: null, fretePrevisto: null } : cot(p));
  await aplicar(m2.A, p2, USER_A, "div-semrecot-1");
  const l2 = m2.repo.linhas[0];
  assert.strictEqual(l2.margemDepois, null);
  assert.strictEqual(l2.lucroDepois, null);
  assert.strictEqual(l2.atencaoCodigo, "PRECO_CONFIRMADO_SEM_RECOTACAO");
});

// ── 17. propagação lenta ───────────────────────────────────────────────────
caso("17. ML demora a propagar: aguardando_propagacao (sem gravar snapshot), depois atualizado; janela estourada → propagacao_pendente", async () => {
  const m = mundo();
  const pa = await previewPreco(m.A);
  const r = await aplicar(m.A, pa);
  await tick();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(m.repo.linhas[0].snapshotStatus, "aguardando_propagacao", "o ML ainda devolve 110,48");
  assert.strictEqual(m.repo.linhas[0].snapshotPrecoObservado, 110.48);
  // O polling não reprocessa antes do backoff.
  await obter(m.A, r.aplicacao.id);
  await tick();
  assert.strictEqual(m.c.chamadas.snapshot.length, 1);
  m.c.estado.precoVivo = 114.9;
  m.avancar(CFG.snapshotBackoffBaseSegundos + 1);
  await obter(m.A, r.aplicacao.id);
  await tick();
  assert.strictEqual(m.repo.linhas[0].snapshotStatus, "atualizado");
  assert.strictEqual(m.repo.linhas[0].snapshotPrecoObservado, 114.9);

  const m2 = mundo();
  const p2 = await previewPreco(m2.A);
  const r2 = await aplicar(m2.A, p2, USER_A, "propaga-nunca1");
  await tick();
  m2.avancar(CFG.snapshotJanelaMinutos * 60 + 1);
  await obter(m2.A, r2.aplicacao.id);
  await tick();
  assert.strictEqual(m2.repo.linhas[0].snapshotStatus, "propagacao_pendente", "nunca 'atualizado' sem o preço confirmado");
});

// ── 18. processo morre em 'aplicando' ──────────────────────────────────────
caso("18. processo morre em 'aplicando': polling distingue viva × lease expirado × perdido; antes/depois do envio", async () => {
  const m = mundo();
  const pa = await previewPreco(m.A);
  m.c.estado.montarItensHook = () => new Promise(() => {}); // morre na reavaliação
  aplicar(m.A, pa, USER_A, "morre-0000001").catch(() => {});
  await tick();
  const id = m.repo.linhas[0].id;
  assert.strictEqual((await obter(m.B, id)).aplicacao.execucao, "viva");
  m.avancar(CFG.leaseSegundos + 1);
  assert.strictEqual((await obter(m.B, id)).aplicacao.execucao, "lease_expirado", "dentro da carência: ainda não reconcilia");
  m.avancar(CFG.carenciaLeaseSegundos);
  const perdido = (await obter(m.B, id)).aplicacao;
  assert.strictEqual(perdido.status, "falhou");
  assert.strictEqual(perdido.execucao, "processo_perdido");

  const m2 = mundo();
  const p2 = await previewPreco(m2.A);
  m2.c.estado.aoEnviar = () => new Promise(() => {}); // morre depois do envio
  aplicar(m2.A, p2, USER_A, "morre-0000002").catch(() => {});
  await tick(10);
  m2.avancar(CFG.leaseEscritaSegundos + CFG.carenciaLeaseSegundos + 1);
  const desconhecido = (await obter(m2.B, m2.repo.linhas[0].id)).aplicacao;
  assert.strictEqual(desconhecido.status, "resultado_desconhecido");
  assert.strictEqual(desconhecido.execucao, "resultado_desconhecido");
});

// ── 19. retry com a mesma chave ────────────────────────────────────────────
caso("19. retry com a mesma chave: em curso → APLICACAO_EM_ANDAMENTO; lease vencido → reconciliado; nunca 2ª escrita", async () => {
  const m = mundo();
  const pa = await previewPreco(m.A);
  m.c.estado.aoEnviar = () => new Promise(() => {});
  aplicar(m.A, pa, USER_A, "retry-mesma-01").catch(() => {});
  await tick(10);
  const r1 = await aplicar(m.A, pa, USER_A, "retry-mesma-01");
  assert.strictEqual(r1.replay, true);
  assert.strictEqual(r1.codigo, "APLICACAO_EM_ANDAMENTO");
  assert.strictEqual(r1.aplicacao.execucao, "viva");
  m.avancar(CFG.leaseEscritaSegundos + CFG.carenciaLeaseSegundos + 1);
  const r2 = await aplicar(m.A, pa, USER_A, "retry-mesma-01");
  assert.strictEqual(r2.aplicacao.status, "resultado_desconhecido");
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(m.c.chamadas.enviosMl.length, 1);
});

// ── 21. schema inicializado por duas instâncias ────────────────────────────
caso("21. schema: duas instâncias inicializam juntas → DDL serializado por advisory lock, sem sobreposição", async () => {
  // Duas "sessões" (clients) com um advisory lock compartilhado que só
  // libera no COMMIT/ROLLBACK — mesma semântica de pg_advisory_xact_lock.
  let dono = null;
  const fila = [];
  const log = [];
  let ddlEmCurso = 0;
  let sobreposicao = false;
  function sessao(nome) {
    return {
      async query(sql) {
        if (/^SELECT pg_advisory_xact_lock/.test(sql)) {
          if (dono && dono !== nome) await new Promise((r) => fila.push(r));
          dono = nome;
          log.push(`${nome}:lock`);
          return { rows: [] };
        }
        if (/^(COMMIT|ROLLBACK)$/.test(sql)) {
          log.push(`${nome}:${sql}`);
          if (dono === nome) { dono = null; const prox = fila.shift(); if (prox) prox(); }
          return { rows: [] };
        }
        if (sql === "BEGIN") { log.push(`${nome}:BEGIN`); return { rows: [] }; }
        ddlEmCurso += 1;
        if (ddlEmCurso > 1) sobreposicao = true;
        await new Promise((r) => setTimeout(r, 15));
        ddlEmCurso -= 1;
        log.push(`${nome}:DDL`);
        return { rows: [] };
      },
    };
  }
  await Promise.all([schemaEnsure.ensureMargemPrecificacaoSchema(sessao("i1")), schemaEnsure.ensureMargemPrecificacaoSchema(sessao("i2"))]);
  assert.strictEqual(sobreposicao, false, log.join(" "));
  for (const n of ["i1", "i2"]) {
    const i = (e) => log.indexOf(`${n}:${e}`);
    assert.ok(i("BEGIN") < i("lock") && i("lock") < i("DDL") && i("DDL") < i("COMMIT"), log.join(" "));
  }
  // O DDL executado é o do arquivo VERSIONADO em sql/migrations.
  const ddl = schemaEnsure.margemPrecificacaoDdl();
  assert.ok(/CREATE TABLE IF NOT EXISTS margem_precificacao_aplicacoes/.test(ddl));
  assert.ok(/claim_token/.test(ddl) && /lease_expira_em/.test(ddl) && /preview_fingerprint/.test(ddl));
  const inv = schemaEnsure.MIGRATIONS_INVENTARIO.find((x) => x.arquivo === schemaEnsure.MARGEM_PRECIFICACAO_MIGRATION);
  assert.ok(inv && inv.auto === true && /ensureMargemPrecificacaoSchema/.test(inv.runner));
  // Mesma instância chamando 2x em paralelo: 1 execução (single-flight).
  let execucoes = 0;
  const unica = { async query(sql) { if (/CREATE TABLE/.test(sql)) execucoes += 1; return { rows: [] }; } };
  await Promise.all([schemaEnsure.ensureMargemPrecificacaoSchema(unica), schemaEnsure.ensureMargemPrecificacaoSchema(unica)]);
  assert.strictEqual(execucoes, 1);
});

// ── 22. flags OFF ──────────────────────────────────────────────────────────
caso("22. flags OFF: aplicar impossível (403) sem tocar linha nem ML; simular/preview seguem funcionando", async () => {
  const relogio = { t: Date.now() };
  const repo = criarRepoMemoria({ agora: () => relogio.t });
  const c = criarCenario({ env: { MARGIN_PRICING_SIMULACAO_CACHE_MS: "0" } });
  const deps = { ...c.deps, repo };
  const pv = await previewPreco(deps);
  assert.strictEqual(pv.escrita.habilitada, false);
  for (const env of [{}, { MARGIN_PRICING_WRITE_ENABLED: "false" }, { MARGIN_PRICING_WRITE_CLIENTES: "outra-loja" }]) {
    const e = await esperaErro(() => aplicar({ ...deps, env: { ...env, MARGIN_PRICING_SIMULACAO_CACHE_MS: "0" } }, pv, USER_A, "flag-off-00001"));
    assert.strictEqual(e.code, "ESCRITA_DESABILITADA");
  }
  assert.strictEqual(repo.linhas[0].status, "preview");
  assert.strictEqual(repo.linhas[0].claimToken, null);
  assert.strictEqual(c.chamadas.atualizarPreco.length, 0);
  assert.strictEqual(c.chamadas.enviosMl.length, 0);
});

async function main() {
  let falhas = 0;
  for (const c of casos) {
    try {
      service._cacheContexto.clear();
      await c.fn();
      console.log(`  ✓ ${c.nome}`);
    } catch (err) {
      falhas += 1;
      console.error(`  ✗ ${c.nome}\n    ${err.stack || err.message}`);
    }
  }
  if (falhas) {
    console.error(`margemPrecificacaoAdversarial: ${falhas} de ${casos.length} falharam`);
    process.exitCode = 1;
  } else {
    console.log(`margemPrecificacaoAdversarial: ok (${casos.length} casos)`);
  }
}

main();
