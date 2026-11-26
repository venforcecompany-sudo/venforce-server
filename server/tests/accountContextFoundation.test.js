// A–L: resolução real Conta → seller → Grant → Base, banco/rede em memória.
const assert = require('node:assert/strict');
const Module = require('node:module');
let db;
const pool = { query: (...args) => db.query(...args) };
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request.endsWith('/config/database')) return pool;
  return originalLoad.call(this, request, parent, isMain);
};
const context = require('../services/automacoes/contextoPrecificacaoService');
const { gerarPreviewPrecificacaoMl } = require('../services/automacoes/precificacaoService');
const { executarDiagnosticoCompleto } = require('../services/automacoes/diagnosticoService');
const { assertAccountContext } = require('../services/clienteContas/accountContextInvariant');
Module._load = originalLoad;

const cliente = { id: 1, nome: 'Empresa A', slug: 'empresa-a', ativo: true };
const conta = (id, seller, extra = {}) => ({ id, cliente_id: 1, marketplace: 'meli',
  nome: `ML${id}`, slug: `ml-${id}`, ativo: true, is_primary: id === 11,
  external_account_id: seller, ...extra });
const grant = (id, account, extra = {}) => ({ id, cliente_id: account.cliente_id,
  cliente_conta_id: account.id, ml_user_id: account.external_account_id,
  access_token: `fixture-access-${id}`, refresh_token: `fixture-refresh-${id}`,
  expires_at: '2099-01-01', token_status: 'valid', is_primary: account.is_primary, ...extra });
const base = (id, account, extra = {}) => ({ id, slug: `base-${id}`, nome: `Base ${id}`,
  ativo: true, marketplace: 'meli', cliente_id: 1, cliente_conta_id: account.id,
  vinculo_marketplace: 'meli', vinculo_ativo: true, ...extra });

class MemoryDb {
  constructor() {
    this.contas = [conta(11, '111'), conta(12, '222')];
    this.grants = this.contas.map((c, i) => grant(21 + i, c));
    this.bases = this.contas.map((c, i) => base(31 + i, c));
    this.log = [];
    this.grantOverride = null;
    this.failOwnership = false;
    this.reportBaseId = 32;
  }
  async query(sql, params = []) {
    const q = String(sql).replace(/\s+/g, ' ').trim();
    this.log.push({ sql: q, params });
    if (q.startsWith('UPDATE relatorios')) return { rows: [] }; // worker recusado
    assert.ok(q.startsWith('SELECT '), `Escrita proibida no resolver: ${q}`);
    if (q.includes('FROM clientes')) return { rows: params[0] === cliente.slug || Number(params[0]) === cliente.id ? [cliente] : [] };
    if (q.startsWith('SELECT * FROM cliente_contas WHERE id')) return { rows: this.contas.filter((c) => c.id === Number(params[0])) };
    if (q.startsWith('SELECT * FROM cliente_contas WHERE cliente_id')) return { rows: this.contas.filter((c) => c.cliente_id === Number(params[0]) && c.marketplace === params[1] && c.ativo) };
    if (q.startsWith('SELECT COUNT(*)')) return { rows: [{ total: this.contas.filter((c) => c.cliente_id === Number(params[0]) && c.marketplace === (params[1] || 'meli') && c.ativo).length }] };
    if (q.startsWith('SELECT id, cliente_id FROM cliente_contas')) {
      if (this.failOwnership) throw Object.assign(new Error('DB indisponível'), { code: 'ECONNRESET' });
      return { rows: this.contas.filter((c) => c.marketplace === 'meli' && String(c.external_account_id) === String(params[0])) };
    }
    if (q.startsWith('SELECT id, cliente_id, cliente_conta_id, ml_user_id FROM ml_tokens')) {
      assert.ok(!q.includes('LIMIT'), 'Ambiguidade de Grant não pode ser escondida');
      return { rows: this.grants.filter((g) => String(g.ml_user_id) === String(params[0])).map(({ id, cliente_id, cliente_conta_id, ml_user_id }) => ({ id, cliente_id, cliente_conta_id, ml_user_id })) };
    }
    if (q.includes('FROM ml_tokens t')) {
      assert.ok(q.includes('t.ml_user_id = $2'), 'Grant principal nunca deve ser consultado');
      return { rows: this.grantOverride ? [this.grantOverride] : this.grants.filter((g) => g.cliente_id === Number(params[0]) && String(g.ml_user_id) === String(params[1])) };
    }
    if (q.includes('FROM bases b')) {
      assert.ok(!q.includes('LIMIT') && !q.includes('ORDER BY'), 'Base explícita nunca escolhe primeiro/recente');
      return { rows: this.bases.filter((b) => b.slug === params[0]) };
    }
    if (q.includes('FROM base_cliente_vinculos v')) {
      if (q.includes('v.cliente_conta_id = $1')) return { rows: [] }; // descarte da Base do resolver compartilhado
      if (q.includes('b.ativo = true')) {
        assert.ok(q.includes("b.marketplace = 'meli'") && q.includes("v.marketplace = 'meli'") && q.includes('v.ativo = true'));
        return { rows: this.bases.filter((b) => b.cliente_id === Number(params[0]) && b.ativo && b.vinculo_ativo && b.marketplace === 'meli' && b.vinculo_marketplace === 'meli') };
      }
      return { rows: [] };
    }
    if (q.includes('FROM custos')) return { rows: [{ produto_id: 'MLB222', custo_produto: 10, imposto_percentual: 0.1, taxa_fixa: 1 }] };
    if (q.includes('FROM relatorios r')) return { rows: [{ cliente_id: 1, cliente_slug: cliente.slug, base_id: this.reportBaseId, base_slug: 'base-32' }] };
    if (q.includes('FROM relatorio_itens')) return { rows: [{ media: null }] };
    throw new Error(`Query sem fixture: ${q}`);
  }
}
let checks = 0;
async function test(label, fn) {
  db = new MemoryDb();
  await fn(); checks++;
  console.log(`ok — ${label}`);
}
const args = { clienteSlugRaw: cliente.slug, clienteContaId: 12 };
const reject = (promise, code, status = 409) => assert.rejects(promise, (e) => e.code === code && e.statusCode === status && e.payload.code === code);

async function run() {
  await test('A/L — única operação sem seleção explícita preservada', async () => {
    db.contas = [db.contas[0]]; db.grants = [db.grants[0]]; db.bases = [db.bases[0]];
    const c = await context.exigirContextoPronto({ clienteSlugRaw: cliente.slug });
    assert.deepEqual([c.conta.id, c.mlUserId, c.grant.id, c.base.id], [11, '111', 21, 31]);
  });
  await test('B — ML2 retorna seller2/Grant2/Base2, independente de principal', async () => {
    const c = await context.exigirContextoPronto(args);
    assert.deepEqual([c.conta.id, c.mlUserId, c.grant.id, c.base.id], [12, '222', 22, 32]);
    const explicita = await context.exigirContextoPronto({ ...args, baseSlugRaw: 'base-32' });
    assert.equal(explicita.base.id, 32);
  });
  await test('C — ML2 + Base1 rejeita sem custo/API', async () => {
    await reject(context.exigirContextoPronto({ ...args, baseSlugRaw: 'base-31' }), 'BASE_ACCOUNT_MISMATCH');
    assert.ok(!db.log.some((q) => q.sql.includes('FROM custos')));
  });
  await test('D — Grant com seller2 mas vinculado à ML1 rejeita', async () => {
    db.grants[1].cliente_conta_id = 11;
    await reject(context.exigirContextoPronto(args), 'GRANT_ACCOUNT_MISMATCH');
  });
  await test('D — defesa após resolver retornar Grant1 para ML2', async () => {
    db.grantOverride = db.grants[0];
    await reject(context.exigirContextoPronto(args), 'GRANT_ACCOUNT_MISMATCH');
  });
  await test('E — Base NULL + uma Conta, explícita e automática', async () => {
    db.contas = [db.contas[1]]; db.grants = [db.grants[1]]; db.bases = [db.bases[1]];
    db.bases[0].cliente_conta_id = null;
    for (const extra of [{}, { baseSlugRaw: 'base-32' }]) {
      assert.equal((await context.exigirContextoPronto({ clienteSlugRaw: cliente.slug, ...extra })).base.id, 32);
    }
  });
  await test('F — Base NULL + duas Contas, explícita e automática recusadas', async () => {
    db.bases = [base(33, db.contas[1], { cliente_conta_id: null })];
    for (const extra of [{}, { baseSlugRaw: 'base-33' }]) await reject(context.exigirContextoPronto({ ...args, ...extra }), 'ACCOUNT_CONTEXT_AMBIGUOUS');
  });
  await test('F — Base direta válida prevalece; Base NULL explícita ainda recusada', async () => {
    db.bases.push(base(33, db.contas[1], { cliente_conta_id: null }));
    assert.equal((await context.exigirContextoPronto(args)).base.id, 32);
    await reject(context.exigirContextoPronto({ ...args, baseSlugRaw: 'base-33' }), 'ACCOUNT_CONTEXT_AMBIGUOUS');
  });
  await test('G — seller em outro Cliente via Grant histórico NULL/inválido', async () => {
    db.grants.push(grant(23, db.contas[1], { cliente_id: 2, cliente_conta_id: null, token_status: 'revoked' }));
    await reject(context.exigirContextoPronto(args), 'SELLER_OWNERSHIP_AMBIGUOUS');
    assert.ok(!db.log.some((q) => q.sql.includes('FROM ml_tokens t')));
  });
  await test('G — seller em Conta de outro Cliente, sem Grant', async () => {
    db.contas.push(conta(13, '222', { cliente_id: 2, ativo: false }));
    await reject(context.exigirContextoPronto(args), 'SELLER_OWNERSHIP_AMBIGUOUS');
  });
  await test('H — Conta inativa explícita e única inativa sem seleção recusadas', async () => {
    db.contas[1].ativo = false;
    await reject(context.exigirContextoPronto(args), 'CONTA_INATIVA');
    db.contas = [db.contas[1]];
    await reject(context.exigirContextoPronto({ clienteSlugRaw: cliente.slug }), 'ACCOUNT_CONTEXT_NOT_FOUND', 404);
  });
  await test('I — Base inativa explícita rejeita e automática não seleciona', async () => {
    db.bases[1].ativo = false;
    await reject(context.exigirContextoPronto({ ...args, baseSlugRaw: 'base-32' }), 'BASE_INATIVA');
    assert.equal((await context.resolverContextoPrecificacao(args)).motivo, 'BASE_MELI_NAO_VINCULADA');
  });
  await test('I — vínculo inativo recusado', async () => {
    db.bases[1].vinculo_ativo = false;
    await reject(context.exigirContextoPronto({ ...args, baseSlugRaw: 'base-32' }), 'BASE_INATIVA');
  });
  await test('J — Conta/Base/vínculo marketplace incompatível', async () => {
    for (const field of ['marketplace', 'vinculo_marketplace']) {
      db.bases[1][field] = 'shopee';
      await reject(context.exigirContextoPronto({ ...args, baseSlugRaw: 'base-32' }), 'MARKETPLACE_INCOMPATIVEL', 422);
      db.bases[1][field] = 'meli';
    }
    db.contas[1].marketplace = 'shopee';
    await reject(context.exigirContextoPronto(args), 'MARKETPLACE_INCOMPATIVEL', 422);
  });
  await test('J — invariante também recusa Base MELI em operação Shopee', async () => {
    const shopee = conta(13, null, { marketplace: 'shopee' });
    assert.throws(() => assertAccountContext({ clienteId: 1, clienteContaId: 13,
      conta: shopee, marketplace: 'shopee', base: base(33, shopee), strict: true }),
    (e) => e.code === 'MARKETPLACE_INCOMPATIVEL' && e.statusCode === 422);
  });
  await test('K — spoof Conta e Base de outro Cliente', async () => {
    db.contas[1].cliente_id = 2;
    await reject(context.exigirContextoPronto(args), 'CONTA_NAO_PERTENCE_AO_CLIENTE', 403);
    db.contas[1].cliente_id = 1; db.bases[1].cliente_id = 2;
    await reject(context.exigirContextoPronto({ ...args, baseSlugRaw: 'base-32' }), 'BASE_ACCOUNT_MISMATCH');
  });
  await test('multi-account sem seleção explícita falha fechado', async () => {
    await assert.rejects(context.exigirContextoPronto({ clienteSlugRaw: cliente.slug }), (e) => e.statusCode === 409 && e.code === 'MULTIPLE_MARKETPLACE_ACCOUNTS');
  });
  await test('zero Conta não cai no principal; Conta não encontrada distingue 404', async () => {
    await assert.rejects(context.exigirContextoPronto({ ...args, clienteContaId: 999 }), (e) => e.statusCode === 404);
    db.contas = [];
    await reject(context.exigirContextoPronto({ clienteSlugRaw: cliente.slug }), 'ACCOUNT_CONTEXT_NOT_FOUND', 404);
  });
  await test('Grant ausente/revogado não herda outro Grant', async () => {
    db.grants[1].token_status = 'revoked';
    assert.equal((await context.resolverContextoPrecificacao(args)).grant.conectado, false);
    db.grants.pop();
    assert.equal((await context.resolverContextoPrecificacao(args)).grant.conectado, false);
  });
  await test('Grant NULL exato funciona sem associação/backfill', async () => {
    db.grants[1].cliente_conta_id = null;
    assert.equal((await context.exigirContextoPronto(args)).grant.id, 22);
    assert.equal(db.grants[1].cliente_conta_id, null);
  });
  await test('dois Grants exatos recusados, mesmo um principal/recente', async () => {
    db.grants.push(grant(23, db.contas[1], { is_primary: true, updated_at: '2099-01-01' }));
    await reject(context.exigirContextoPronto(args), 'GRANT_CONTEXT_AMBIGUOUS');
  });
  await test('duas Contas para mesmo seller recusadas dentro do Cliente', async () => {
    db.contas.push(conta(13, '222'));
    await reject(context.exigirContextoPronto(args), 'ACCOUNT_CONTEXT_AMBIGUOUS');
  });
  await test('Base inexistente e dois vínculos ativos distinguem 404/409', async () => {
    await reject(context.exigirContextoPronto({ ...args, baseSlugRaw: 'inexistente' }), 'BASE_NOT_FOUND', 404);
    db.bases.push({ ...db.bases[1] });
    await reject(context.exigirContextoPronto({ ...args, baseSlugRaw: 'base-32' }), 'ACCOUNT_CONTEXT_AMBIGUOUS');
  });
  await test('falha de DB não vira prontidão desconectada nem fallback', async () => {
    db.failOwnership = true;
    await assert.rejects(context.resolverContextoPrecificacao(args), (e) => e.code === 'ECONNRESET');
  });
  await test('erros públicos nunca contêm credenciais', async () => {
    db.grants[1].cliente_conta_id = 11;
    try { await context.exigirContextoPronto(args); assert.fail('deveria falhar'); }
    catch (e) { assert.ok(!JSON.stringify(e).includes('fixture-access')); assert.ok(!JSON.stringify(e).includes('fixture-refresh')); }
  });
  await test('preview propaga seller em multiget, preços e frete', async () => {
    const originalFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, opts) => {
      calls.push({ url: String(url), auth: opts.headers.Authorization });
      const u = new URL(url);
      let data = {};
      if (u.pathname.endsWith('/items/search')) data = { results: ['MLB222'], paging: { total: 1 } };
      // O multiget /items?ids= é feito pelo mlFetch como um GET /items/{id} por item.
      else if (u.pathname === '/items/MLB222') data = { id: 'MLB222', seller_id: 222, price: 100, listing_type_id: 'gold_special', category_id: 'MLB1', shipping: { logistic_type: 'fulfillment' } };
      else if (u.pathname.endsWith('/prices')) data = { prices: [] };
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => data };
    };
    try {
      await gerarPreviewPrecificacaoMl(args);
      assert.ok(calls.some((c) => new URL(c.url).pathname === '/items/MLB222'));
      assert.ok(calls.some((c) => c.url.includes('/listing_prices?')));
      assert.ok(calls.some((c) => c.url.includes('/shipping_options/free?')));
      assert.ok(calls.every((c) => c.auth === 'Bearer fixture-access-22'));
    } finally { global.fetch = originalFetch; }
  });
  await test('worker sem seleção em multi-conta recusa antes de HTTP', async () => {
    await executarDiagnosticoCompleto(99);
    const update = db.log.find((q) => q.sql.startsWith('UPDATE relatorios'));
    assert.ok(update && String(update.params[1]).includes('mais de uma conta'));
  });
  await test('worker recusa seller divergente e Base ID alterada antes de HTTP', async () => {
    await executarDiagnosticoCompleto(99, { clienteContaId: 12, mlUserId: '111' });
    assert.ok(db.log.some((q) => q.sql.startsWith('UPDATE relatorios') && String(q.params[1]).includes('Seller do diagnóstico')));
    db.log = []; db.reportBaseId = 31;
    await executarDiagnosticoCompleto(99, { clienteContaId: 12, mlUserId: '222' });
    assert.ok(db.log.some((q) => q.sql.startsWith('UPDATE relatorios') && String(q.params[1]).includes('Identidade do relatório')));
    assert.ok(!db.log.some((q) => q.sql.includes('FROM custos')));
  });
  await test('worker com Conta ML2 revalida e mantém seller2/Base2', async () => {
    const originalFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, opts) => {
      calls.push({ url: String(url), auth: opts.headers.Authorization });
      return { ok: true, status: 200, headers: { get: () => null },
        json: async () => String(url).endsWith('/users/me') ? { id: 222 } : { results: [] } };
    };
    try {
      await executarDiagnosticoCompleto(99, { clienteContaId: 12, mlUserId: '222' });
      assert.ok(calls.some((c) => c.url.includes('/users/222/items/search')));
      assert.ok(calls.every((c) => c.auth === 'Bearer fixture-access-22'));
      const custos = db.log.find((q) => q.sql.includes('FROM custos'));
      assert.equal(custos.params[0], 32);
      assert.ok(!db.log.some((q) => q.sql.startsWith('UPDATE relatorios') && q.sql.includes("status = 'erro'")));
    } finally { global.fetch = originalFetch; }
  });
  console.log(`\n${checks} cenários passaram; sem banco ou marketplace reais.`);
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
