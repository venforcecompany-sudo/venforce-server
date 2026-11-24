// server/tests/margemPrecificacaoPromoAceite.test.js
// Central de Margem — participar de promoções de ACEITE (SMART, PRICE_MATCHING,
// MARKETPLACE_CAMPAIGN…) pelo pipeline SEGURO (precificacaoService), não pela
// rota de /anuncios:
//   - preview no preço SUGERIDO pelo ML (não editável), LC antes/depois e veredito;
//   - fingerprint com promoção + tipo + modo + offer id + preço sugerido + status do anúncio;
//   - aplicar relê ao vivo: promoção ainda candidata, mesmo preço sugerido (senão
//     novo preview), veredito recalculado; escreve por participarPromocaoAceite;
//   - mesmos gates de DEAL: MARGIN_PROMO_WRITE_* + papel + veredito, timeout →
//     resultado_desconhecido, auditoria com LC antes/depois e modo `aceite`.
// Tudo com fakes (helpers/margemPrecificacaoFakes): nenhum Postgres, nenhum ML real.

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://127.0.0.1:1/vf-test";

const assert = require("assert");
const service = require("../services/motorMargem/precificacao/precificacaoService");
const { motorItem, promo, criarCenario, criarRepoMemoria } = require("./helpers/margemPrecificacaoFakes");

const casos = [];
function cenario(nome, fn) {
  casos.push({ nome, fn });
}

async function esperaErro(fn) {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error("era esperado um erro");
}

const PROMO_ON = { MARGIN_PROMO_WRITE_ENABLED: "true", MARGIN_PROMO_WRITE_CLIENTES: "loja-a", MARGIN_PRICING_SIMULACAO_CACHE_MS: "0", MARGIN_PRICING_SNAPSHOT_DELAY_MS: "0" };
const USER = { id: 9, nome: "Pedro", email: "p@x" };

function smart(o = {}) {
  return promo({
    id: "S1", tipo: "SMART", tipoLabel: "Campanha cofinanciada automatizada", nome: "Impulsione suas vendas",
    precoOriginal: 149.9, precoFinal: 139.9, subsidioMl: 7.5, meliPercentage: 5, sellerPercentage: 1.67,
    refId: "CANDIDATE-MLB100-1", ...o,
  });
}

function cenarioAceite(extra = {}) {
  return criarCenario({ motor: motorItem({ preco: 149.9 }), promocoes: [smart()], env: PROMO_ON, ...extra });
}

function comRepo(c, repo) {
  return { ...c.deps, repo };
}

function gate(r, id) {
  return (r.gates || []).find((g) => g.id === id) || null;
}

async function preview(c, repo, extra = {}) {
  return service.preview(
    { clienteSlug: "loja-a", clienteContaId: 7, itemId: "MLB100", tipo: "PROMOTION", promotionId: "S1", precoVisto: 149.9, user: USER, ...extra },
    comRepo(c, repo)
  );
}

async function aplicar(c, repo, previewId, key = "aceite-chave-0001", extra = {}) {
  const linha = repo.linhas.find((r) => r.id === previewId);
  return service.aplicar(
    { clienteSlug: "loja-a", clienteContaId: 7, previewId, idempotencyKey: key, fingerprint: linha ? linha.previewFingerprint : undefined, promotionId: "S1", user: USER, ...extra },
    comRepo(c, repo)
  );
}

// ── Preview ────────────────────────────────────────────────────────────────

cenario("preview SMART elegível: modo aceite, preço = sugerido pelo ML, LC antes/depois e veredito do núcleo", async () => {
  const c = cenarioAceite();
  const r = await preview(c, criarRepoMemoria());
  assert.strictEqual(r.bloqueado, false, JSON.stringify(r.gates.filter((g) => g.tom === "block")));
  assert.deepStrictEqual(r.promocao.escrita, { suportada: true, acao: "PARTICIPAR", modo: "aceite", motivo: null });
  assert.strictEqual(r.proposta.preco, 139.9, "o preço é o sugerido pelo ML");
  assert.strictEqual(r.promocao.precoSugerido, 139.9);
  assert.strictEqual(r.promocao.refId, "CANDIDATE-MLB100-1");
  assert.strictEqual(r.proposta.rebate, 7.5, "retorno do ML entra no LC");
  assert.strictEqual(gate(r, "promocao_escrita").tom, "ok");
  assert.ok(/preço definido pelo Mercado Livre/.test(gate(r, "promocao_escrita").titulo));
  assert.strictEqual(gate(r, "promocao_preco").titulo, "Preço sugerido pelo Mercado Livre");
  // Veredito exposto com LC antes/depois — as mesmas contas de atual/proposta.
  const v = r.promocao.veredito;
  assert.ok(v && ["entrar", "entrar_se_girar"].includes(v.veredito), JSON.stringify(v));
  assert.strictEqual(v.lcAntes, r.atual.lucro);
  assert.strictEqual(v.lcDepois, r.proposta.lucro);
  assert.strictEqual(gate(r, "veredito").tom === "block", false);
  // A cotação foi feita no preço sugerido (comissão/frete do novo preço).
  assert.ok(c.chamadas.cotacao.some((q) => q.precoEfetivo === 139.9));
  assert.strictEqual(r.escrita.habilitada, true);
  assert.ok(r.preview && r.preview.fingerprint);
});

cenario("preview persiste a intenção PARTICIPAR e o fingerprint leva tipo, modo, offer id, preço sugerido e status do anúncio", async () => {
  const c = cenarioAceite();
  const repo = criarRepoMemoria();
  await preview(c, repo);
  const linha = repo.linhas[0];
  assert.strictEqual(linha.promotionType, "SMART");
  assert.strictEqual(linha.promotionAcao, "PARTICIPAR");
  assert.strictEqual(linha.precoSolicitado, 139.9);
  assert.strictEqual(linha.fingerprint.statusAnuncio, "active");
  assert.deepStrictEqual(
    { id: linha.fingerprint.promocao.id, tipo: linha.fingerprint.promocao.tipo, modo: linha.fingerprint.promocao.modo, refId: linha.fingerprint.promocao.refId, precoFinal: linha.fingerprint.promocao.precoFinal, status: linha.fingerprint.promocao.status, acao: linha.fingerprint.promocao.acao },
    { id: "S1", tipo: "SMART", modo: "ACEITE", refId: "CANDIDATE-MLB100-1", precoFinal: "139.90", status: "candidate", acao: "PARTICIPAR" }
  );
  assert.strictEqual(linha.calculo.promocao.veredito.lcDepois, linha.lucroDepois);
});

cenario("preço NÃO editável: um preço digitado diferente do sugerido bloqueia; o mesmo preço passa", async () => {
  const c = cenarioAceite();
  const r = await preview(c, criarRepoMemoria(), { novoPreco: "135.00" });
  const g = gate(r, "promocao_preco");
  assert.strictEqual(g.tom, "block");
  assert.ok(/não editável/.test(g.titulo));
  assert.ok(/R\$ 139,90/.test(g.detalhe));
  const ok = await preview(c, criarRepoMemoria(), { novoPreco: "139.90" });
  assert.strictEqual(gate(ok, "promocao_preco").tom, "ok");
  assert.strictEqual(ok.bloqueado, false);
});

cenario("sem preço sugerido pelo ML: bloqueia (nunca inventa preço)", async () => {
  const c = cenarioAceite({ promocoes: [smart({ precoFinal: null })] });
  const r = await preview(c, criarRepoMemoria());
  assert.strictEqual(gate(r, "promocao_preco").tom, "block");
  assert.ok(/Sem preço sugerido/.test(gate(r, "promocao_preco").titulo));
  assert.strictEqual(r.preview, null);
});

cenario("tipo que exige offer_id sem a oferta: bloqueia; MARKETPLACE_CAMPAIGN (POST sem offer_id) passa", async () => {
  const sem = await preview(cenarioAceite({ promocoes: [smart({ refId: null })] }), criarRepoMemoria());
  assert.strictEqual(gate(sem, "promocao_oferta").tom, "block");
  const mc = await preview(cenarioAceite({ promocoes: [smart({ tipo: "MARKETPLACE_CAMPAIGN", refId: null })] }), criarRepoMemoria());
  assert.strictEqual(gate(mc, "promocao_oferta"), null);
  assert.strictEqual(mc.bloqueado, false);
});

cenario("veredito não entrar (LC ≤ 0 no preço sugerido): preview bloqueado e aplicar recusa sem escrever", async () => {
  const c = cenarioAceite({ promocoes: [smart({ precoFinal: 60, subsidioMl: 1 })] });
  const repo = criarRepoMemoria();
  const p = await preview(c, repo);
  assert.strictEqual(gate(p, "veredito").tom, "block");
  assert.strictEqual(p.promocao.veredito.veredito, "nao_entrar");
  const err = await esperaErro(() => aplicar(c, repo, p.preview.id));
  assert.strictEqual(err.code, "PREVIEW_BLOQUEADO");
  assert.strictEqual(c.chamadas.participarPromocaoAceite.length, 0);
  assert.strictEqual(c.chamadas.enviosMl.length, 0);
});

cenario("ACEITE já ativa: nunca vira Alterar (o ML define o preço) — só simulação", async () => {
  const c = cenarioAceite({ promocoes: [smart({ status: "started", statusExibicao: "ATIVA" })] });
  const r = await preview(c, criarRepoMemoria());
  assert.strictEqual(gate(r, "promocao_escrita").tom, "block");
  assert.strictEqual(r.promocao.escrita.acao, null);
  assert.ok(/Mercado Livre define o preço/.test(r.promocao.escrita.motivo));
});

cenario("tipo fora do escopo (LIGHTNING) segue 'Somente simulação' com motivo claro", async () => {
  const c = cenarioAceite({ promocoes: [smart({ tipo: "LIGHTNING" })] });
  const r = await preview(c, criarRepoMemoria());
  assert.strictEqual(gate(r, "promocao_escrita").titulo, "Somente simulação");
  assert.ok(/oferta relâmpago/.test(gate(r, "promocao_escrita").detalhe));
});

// ── Aplicar ────────────────────────────────────────────────────────────────

cenario("aplicar: participa por participarPromocaoAceite (1x, sem preço, conta certa, com prazo e gancho) — nunca aplicarPromocao", async () => {
  const c = cenarioAceite();
  const repo = criarRepoMemoria();
  const p = await preview(c, repo);
  const r = await aplicar(c, repo, p.preview.id);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(c.chamadas.aplicarPromocao.length, 0);
  assert.strictEqual(c.chamadas.participarPromocaoAceite.length, 1);
  const chamada = c.chamadas.participarPromocaoAceite[0];
  assert.strictEqual(chamada.promotionId, "S1");
  assert.strictEqual(chamada.tipo, "SMART");
  assert.strictEqual(chamada.mlUserId, "555");
  assert.strictEqual(chamada.clienteId, 3);
  assert.ok(chamada.timeoutMs > 0, "prazo real no escritor");
  assert.strictEqual(typeof chamada.antesDeEscrever, "function");
  assert.strictEqual("precoNovo" in chamada, false, "aceite nunca envia preço");
  assert.strictEqual(c.chamadas.enviosMl.length, 1);
  assert.ok(c.chamadas.enviosMl[0].deadlineAt !== null, "envio dentro do lease (fencing)");
  assert.strictEqual(r.aplicacao.status, "aplicado");
  assert.strictEqual(r.aplicacao.precoConfirmado, 139.9);
  assert.strictEqual(r.aplicacao.promotionModo, "aceite");
  assert.strictEqual(r.aplicacao.promotionAcao, "PARTICIPAR");
  assert.strictEqual(repo.linhas[0].respostaMl.metodo, "POST");
  assert.strictEqual(repo.linhas[0].respostaMl.modo, "aceite");
});

cenario("auditoria: central_margem_promocao_aplicar com modo aceite, LC antes/depois e veredito", async () => {
  const c = cenarioAceite();
  const repo = criarRepoMemoria();
  const p = await preview(c, repo);
  await aplicar(c, repo, p.preview.id);
  assert.strictEqual(c.chamadas.logs.length, 1);
  const log = c.chamadas.logs[0];
  assert.strictEqual(log.acao, "central_margem_promocao_aplicar");
  assert.strictEqual(log.status, "sucesso");
  const d = log.detalhes;
  assert.strictEqual(d.tipo, "PROMOTION");
  assert.strictEqual(d.promotionModo, "aceite");
  assert.strictEqual(d.promotionType, "SMART");
  assert.strictEqual(d.promotionAcao, "PARTICIPAR");
  assert.strictEqual(d.lucroAntes, p.atual.lucro);
  assert.strictEqual(d.lucroDepois, p.proposta.lucro);
  assert.ok(d.lucroAntes !== null && d.lucroDepois !== null);
  assert.strictEqual(d.veredito.lcAntes, d.lucroAntes);
  assert.strictEqual(d.veredito.lcDepois, d.lucroDepois);
  assert.ok(["entrar", "entrar_se_girar"].includes(d.veredito.veredito));
});

cenario("preço sugerido mudou entre preview e aplicar → PRECO_SUGERIDO_MUDOU, novo preview, zero escrita", async () => {
  const c = cenarioAceite();
  const repo = criarRepoMemoria();
  const p = await preview(c, repo);
  c.estado.promocoes = [smart({ precoFinal: 137.5 })];
  const r = await aplicar(c, repo, p.preview.id);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.codigo, "PRECO_SUGERIDO_MUDOU");
  assert.strictEqual(r.novoPreviewNecessario, true);
  assert.strictEqual(r.precoSugeridoAgora, 137.5);
  assert.strictEqual(c.chamadas.participarPromocaoAceite.length, 0);
  assert.strictEqual(c.chamadas.enviosMl.length, 0);
  assert.strictEqual(r.aplicacao.status, "recusado");
});

cenario("preço sugerido mudou na releitura do PRÓPRIO escritor (depois da reavaliação) → PROMOCAO_MUDOU, zero escrita", async () => {
  const c = cenarioAceite();
  const repo = criarRepoMemoria();
  const p = await preview(c, repo);
  c.estado.antesDaReleituraDoEscritor = async () => { c.estado.promocoes = [smart({ precoFinal: 137.5 })]; };
  const r = await aplicar(c, repo, p.preview.id);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.codigo, "PROMOCAO_MUDOU");
  assert.ok(/precoFinal/.test(r.motivo));
  assert.strictEqual(r.novoPreviewNecessario, true);
  assert.strictEqual(c.chamadas.enviosMl.length, 0);
  assert.strictEqual(r.aplicacao.status, "recusado");
});

cenario("offer id mudou desde o preview → recusado (fingerprint), zero escrita", async () => {
  const c = cenarioAceite();
  const repo = criarRepoMemoria();
  const p = await preview(c, repo);
  c.estado.promocoes = [smart({ refId: "CANDIDATE-MLB100-2" })];
  const r = await aplicar(c, repo, p.preview.id);
  assert.strictEqual(r.codigo, "PREVIEW_DESATUALIZADO");
  assert.ok(r.diferencas.some((x) => x.campo === "promocao.refId"));
  assert.strictEqual(c.chamadas.enviosMl.length, 0);
});

cenario("promoção deixou de ser candidata (já participa) → recusado, zero escrita", async () => {
  const c = cenarioAceite();
  const repo = criarRepoMemoria();
  const p = await preview(c, repo);
  c.estado.promocoes = [smart({ status: "started", statusExibicao: "NÃO APLICADA" })];
  const r = await aplicar(c, repo, p.preview.id);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.aplicacao.status, "recusado");
  assert.strictEqual(c.chamadas.enviosMl.length, 0);
});

cenario("escritor recusa (PROMOCAO_JA_PARTICIPA na releitura dele) → 'recusado', não 'falhou'", async () => {
  const c = cenarioAceite();
  const repo = criarRepoMemoria();
  const p = await preview(c, repo);
  c.estado.antesDaReleituraDoEscritor = async () => { c.estado.promocoes = [smart({ status: "pending", statusExibicao: "PROGRAMADA" })]; };
  const r = await aplicar(c, repo, p.preview.id);
  assert.strictEqual(r.codigo, "PROMOCAO_JA_PARTICIPA");
  assert.strictEqual(r.aplicacao.status, "recusado");
  assert.strictEqual(c.chamadas.enviosMl.length, 0);
});

cenario("escritor recusa ABAIXO_FRETE_GRATIS (rebate < R$ 19,00) → 'recusado', não 'falhou'", async () => {
  const c = cenarioAceite();
  const repo = criarRepoMemoria();
  const p = await preview(c, repo);
  c.estado.respostaAceite = () => ({
    ok: false,
    codigo: "ABAIXO_FRETE_GRATIS",
    motivo: "O preço desta promoção (R$ 18,90) fica abaixo de R$ 19,00 — o comprador perderia o frete grátis. Nada foi enviado.",
  });
  const r = await aplicar(c, repo, p.preview.id);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.codigo, "ABAIXO_FRETE_GRATIS");
  assert.strictEqual(r.aplicacao.status, "recusado", "piso de frete grátis é recusa do serviço, não falha");
  assert.ok(/R\$ 18,90/.test(r.motivo));
  assert.ok(/frete grátis/.test(r.motivo));
});

cenario("sugestão sumiu (ML não sugere mais preço) → PRECO_SUGERIDO_MUDOU, zero escrita", async () => {
  const c = cenarioAceite();
  const repo = criarRepoMemoria();
  const p = await preview(c, repo);
  c.estado.promocoes = [smart({ precoFinal: null })];
  const r = await aplicar(c, repo, p.preview.id);
  assert.strictEqual(r.codigo, "PRECO_SUGERIDO_MUDOU");
  assert.strictEqual(r.precoSugeridoAgora, null);
  assert.strictEqual(c.chamadas.enviosMl.length, 0);
});

cenario("timeout no POST (incerto) → resultado_desconhecido", async () => {
  const c = cenarioAceite();
  const repo = criarRepoMemoria();
  const p = await preview(c, repo);
  c.estado.aoEnviar = () => ({ ok: false, codigo: "ML_TIMEOUT", motivo: "sem resposta", enviado: true, incerto: true });
  const r = await aplicar(c, repo, p.preview.id);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.aplicacao.status, "resultado_desconhecido");
  assert.strictEqual(c.chamadas.logs[0].detalhes.promotionModo, "aceite");
});

cenario("exceção depois de liberar o envio → resultado_desconhecido (o ML pode ter recebido)", async () => {
  const c = cenarioAceite();
  const repo = criarRepoMemoria();
  const p = await preview(c, repo);
  c.estado.aoEnviar = () => { throw new Error("socket hang up"); };
  const r = await aplicar(c, repo, p.preview.id);
  assert.strictEqual(r.aplicacao.status, "resultado_desconhecido");
  assert.strictEqual(r.codigo, "ESCRITA_EXCECAO");
});

cenario("ML confirma preço diferente do sugerido → 'divergente' com LC recalculado no confirmado", async () => {
  const c = cenarioAceite();
  const repo = criarRepoMemoria();
  const p = await preview(c, repo);
  c.estado.respostaAceite = (_p, viva) => ({ ok: true, acao: "PARTICIPAR", promotionId: viva.id, tipo: viva.tipo, precoConfirmado: 138.9 });
  const r = await aplicar(c, repo, p.preview.id);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.divergente, true);
  assert.strictEqual(r.aplicacao.precoConfirmado, 138.9);
  assert.ok(r.aplicacao.lucroDepois !== null && r.aplicacao.lucroDepois !== p.proposta.lucro);
});

// ── Gates de rollout e papel (iguais aos de DEAL) ──────────────────────────

cenario("rollout: só MARGIN_PROMO_WRITE_ENABLED + MARGIN_PROMO_WRITE_CLIENTES liberam; MARGIN_PRICING_WRITE_* não", async () => {
  for (const env of [
    {},
    { MARGIN_PROMO_WRITE_ENABLED: "true" },
    { MARGIN_PROMO_WRITE_CLIENTES: "loja-a" },
    { MARGIN_PRICING_WRITE_ENABLED: "true", MARGIN_PRICING_WRITE_CLIENTES: "loja-a" },
  ]) {
    const c = cenarioAceite({ env: { MARGIN_PRICING_SIMULACAO_CACHE_MS: "0", ...env } });
    const repo = criarRepoMemoria();
    const p = await preview(c, repo);
    assert.strictEqual(p.escrita.habilitada, false, JSON.stringify(env));
    const err = await esperaErro(() => aplicar(c, repo, p.preview.id));
    assert.strictEqual(err.statusCode, 403, JSON.stringify(env));
    assert.strictEqual(c.chamadas.participarPromocaoAceite.length, 0);
    assert.strictEqual(repo.linhas[0].status, "preview");
  }
});

cenario("papel: sem admin/coordenador do squad → 403 PAPEL_NAO_AUTORIZADO, zero escrita", async () => {
  const c = cenarioAceite({ papelPromocao: { ok: false, papel: null } });
  const repo = criarRepoMemoria();
  const p = await preview(c, repo);
  assert.strictEqual(p.escrita.codigo, "PAPEL_NAO_AUTORIZADO");
  const err = await esperaErro(() => aplicar(c, repo, p.preview.id));
  assert.strictEqual(err.code, "PAPEL_NAO_AUTORIZADO");
  assert.strictEqual(c.chamadas.participarPromocaoAceite.length, 0);
});

cenario("DEAL continua pelo escritor de PREÇO (aplicarPromocao), nunca pelo de aceite", async () => {
  const c = cenarioAceite({ promocoes: [promo({ id: "S1" })] });
  const repo = criarRepoMemoria();
  const p = await preview(c, repo);
  assert.strictEqual(p.promocao.escrita.modo, "preco");
  const r = await aplicar(c, repo, p.preview.id);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(c.chamadas.aplicarPromocao.length, 1);
  assert.strictEqual(c.chamadas.participarPromocaoAceite.length, 0);
  assert.strictEqual(r.aplicacao.promotionModo, "preco");
});

async function main() {
  let falhas = 0;
  for (const caso of casos) {
    try {
      service._cacheContexto.clear();
      await caso.fn();
      console.log(`  ✓ ${caso.nome}`);
    } catch (err) {
      falhas += 1;
      console.error(`  ✗ ${caso.nome}\n    ${err.stack || err.message}`);
    }
  }
  if (falhas > 0) {
    console.error(`margemPrecificacaoPromoAceite: ${falhas} de ${casos.length} cenários falharam`);
    process.exitCode = 1;
  } else {
    console.log(`margemPrecificacaoPromoAceite: ok (${casos.length} cenários)`);
  }
}

main();
