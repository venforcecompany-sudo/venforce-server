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
const { buscarPerformanceML } = require("../services/ads/mlAdsService");
const { obterVisao } = require("../services/visaoService");
const motor = require("../services/motorMargem/motorMargemService");
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
let checks=0;
async function test(label,fn){db=new MemoryDb();await fn();checks++;console.log(`ok — ${label}`);}
async function run(){
 await test("Ads ML2 usa Grant2 sem exigir Base e sem principal",async()=>{
  db.bases[1].cliente_conta_id=null;const old=global.fetch;const calls=[];
  global.fetch=async(url,opts)=>{calls.push(opts.headers.Authorization);return {ok:true,status:200,headers:{get:()=>null},json:async()=>({advertisers:[]})};};
  try{await buscarPerformanceML(cliente.slug,"2026-10",null,12,{strictIdentity:true});assert.deepEqual(calls,["Bearer fixture-access-22"]);assert.ok(!db.log.some(q=>q.sql.includes("base_cliente_vinculos")));}finally{global.fetch=old;}
 });
 await test("Ads seller compartilhado recusa antes de API",async()=>{db.grants.push({...db.grants[1],id:99,cliente_id:2});await assert.rejects(buscarPerformanceML(cliente.slug,"2026-10",null,12,{strictIdentity:true}),e=>e.code==="SELLER_OWNERSHIP_AMBIGUOUS");});
 await test("resumo de Margem transporta Conta até o workspace",async()=>{
  const seen=[];await motor.obterResumo({clienteSlug:cliente.slug,clienteContaId:12,dateFrom:"2026-10-01",dateTo:"2026-10-31"},{prepareWorkspaceContext:async args=>{seen.push(args);return {cliente,conta:db.contas[1],base:db.bases[1],periodo:{dateFrom:"2026-10-01",dateTo:"2026-10-31"},vendasRaw:{sincronizado:true,pedidos:[]},porMlb:new Map(),naoAtribuido:{reembolso:0}};},enrichBatch:async()=>({totalItensMl:0,itens:[]})});assert.equal(seen[0].clienteContaId,12);
 });
 await test("Visão transporta Conta ao resumo, mantendo agregado comercial explícito",async()=>{
  const seen=[];const c=await obterVisao({clienteSlugRaw:cliente.slug,clienteContaIdRaw:12,periodoRaw:"2026-10"},{resolverClientePorIdOuSlug:async()=>cliente,obterConta:async()=>db.contas[1],sanitizarConta:r=>r,getCliente360:async()=>({}),getCentralVendasReadBootstrap:async()=>({}),obterResumoMargem:async args=>{seen.push(args);return {};},buscarPerformanceML:async()=>({}),listarEntregas:async()=>({entregas:[]}),listarSyncRuns:async()=>[]});assert.equal(seen[0].clienteContaId,12);assert.equal(c.margem.escopoConta,true);assert.equal(c.saude.escopoConta,false);assert.equal(c.fechamento.escopoConta,false);
 });
 await test("Ads padrão usado pela Central conserva o contrato anterior",async()=>{
  const old=global.fetch;global.fetch=async()=>({ok:true,status:200,headers:{get:()=>null},json:async()=>({advertisers:[]})});
  try{await buscarPerformanceML(cliente.slug,"2026-10",null,12);assert.ok(!db.log.some(q=>q.sql.startsWith("SELECT id, cliente_id FROM cliente_contas")));assert.ok(db.log.some(q=>q.sql.includes("base_cliente_vinculos")));}finally{global.fetch=old;}
 });
 console.log(`${checks} cenários de convergência passaram`);
}
run().catch(e=>{console.error(e);process.exitCode=1;});
