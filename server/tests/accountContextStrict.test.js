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
const accountService = require("../services/clienteContas/clienteContaService");
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
      if (q.includes('b.id AS base_id')) return { rows: this.bases.filter(b => b.cliente_id === Number(params[0]) && b.vinculo_marketplace === params[1] && b.vinculo_ativo).map(b => ({...b, base_id: b.id})) };
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
async function test(label, fn) { db = new MemoryDb(); await fn(); checks++; console.log(`ok — ${label}`); }
const resolve = (options = {}) => accountService.resolveMarketplaceAccountContext({clienteId: 1, marketplace: "meli", clienteContaId: 12, requireUsableGrant: true, strictIdentity: true, ...options});
const rejects = (promise, code) => assert.rejects(promise, e => e.code === code);
async function run() {
 await test("Conta ML2 preserva Grant2/Base2", async () => { const c=await resolve(); assert.deepEqual([c.conta.id,c.mlUserId,c.grant.id,c.base.base_id],[12,"222",22,32]); });
 await test("Grant legado NULL exato continua sem backfill", async()=>{db.grants[1].cliente_conta_id=null;assert.equal((await resolve()).grant.id,22);assert.equal(db.grants[1].cliente_conta_id,null);});
 await test("Grant vinculado a outra Conta recusa",async()=>{db.grants[1].cliente_conta_id=11;await rejects(resolve(),"GRANT_ACCOUNT_MISMATCH");});
 await test("dois Grants exatos recusam",async()=>{db.grants.push({...db.grants[1],id:99});await rejects(resolve(),"GRANT_CONTEXT_AMBIGUOUS");});
 await test("seller em outro Cliente recusa inclusive Grant histórico",async()=>{db.grants.push({...db.grants[1],id:99,cliente_id:2,token_status:"revoked"});await rejects(resolve(),"SELLER_OWNERSHIP_AMBIGUOUS");});
 await test("Base inativa não entra",async()=>{db.bases[1].ativo=false;await rejects(resolve(),"BASE_INATIVA");});
 await test("marketplace da Base divergente recusa",async()=>{db.bases[1].marketplace="shopee";await rejects(resolve(),"MARKETPLACE_INCOMPATIVEL");});
 await test("Base NULL em multi-conta recusa",async()=>{db.bases[1].cliente_conta_id=null;await rejects(resolve(),"ACCOUNT_CONTEXT_AMBIGUOUS");});
 await test("single-account Base NULL automático preservado",async()=>{db.contas=[db.contas[1]];db.grants=[db.grants[1]];db.bases=[{...db.bases[1],cliente_conta_id:null}];assert.equal((await resolve({clienteContaId:null})).base.base_id,32);});
 await test("multi-account sem escolha exige seleção",async()=>{await rejects(resolve({clienteContaId:null}),"MULTIPLE_MARKETPLACE_ACCOUNTS");});
 await test("zero Conta recusa em modo estrito",async()=>{db.contas=[];await rejects(resolve({clienteContaId:null}),"ACCOUNT_CONTEXT_NOT_FOUND");});
 await test("Base de outra Conta nunca faz fallback em single-account",async()=>{db.contas=[db.contas[1]];db.bases=[db.bases[0]];assert.equal((await resolve()).base.base_id,null);});
 await test("Ads pode resolver identidade sem exigir Base",async()=>{db.bases[1].cliente_conta_id=null;assert.equal((await resolve({resolveBase:false})).base,null);assert.ok(!db.log.some(q=>q.sql.includes("base_cliente_vinculos")));});
 await test("spoof e Conta inativa recusam",async()=>{db.contas[1].cliente_id=2;await rejects(resolve(),"CONTA_NAO_PERTENCE_AO_CLIENTE");db.contas[1].cliente_id=1;db.contas[1].ativo=false;await rejects(resolve(),"CONTA_INATIVA");});
 await test("duas Bases ativas da Conta recusam",async()=>{db.bases.push({...db.bases[1],id:99});await rejects(resolve(),"ACCOUNT_CONTEXT_AMBIGUOUS");});
 await test("Shopee manual com Base exata não exige Grant ML",async()=>{db.contas[1].marketplace="shopee";db.bases[1].marketplace="shopee";db.bases[1].vinculo_marketplace="shopee";const c=await resolve({marketplace:"shopee"});assert.equal(c.grant,null);assert.equal(c.base.base_id,32);});
 await test("contrato padrão permanece sem guardrails opt-in",async()=>{const c=await resolve({strictIdentity:false});assert.equal(c.mlUserId,"222");assert.ok(!db.log.some(q=>q.sql.startsWith("SELECT id, cliente_id FROM cliente_contas")));});
 console.log(`${checks} cenários estritos passaram`);
}
run().catch(e=>{console.error(e);process.exitCode=1;});
