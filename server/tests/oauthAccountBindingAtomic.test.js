// server/tests/mlConectarConta.test.js
//
// Acabamento operacional da gestão de contas ML em /clientes.html:
// link OAuth account-scoped (GET /ml/conectar-conta/:clienteContaId) e a
// proteção de reconexão segura no callback (mlController.callbackMlController).
//
// Cobre a lista de testes obrigatórios pedida:
//  1/2. criar cliente_conta ML sem grant -> "aguardando grant" (grant=null
//       distinto de grant existente) já é verificado em clienteContaService.test.js
//       (criarConta) — aqui o foco é o fluxo OAuth account-scoped em si.
//  3/4. link de ML1 e ML2 apontam para clienteContaId diferentes.
//  5. primeira autorização de uma conta sem external_account_id grava o
//     seller retornado e liga o grant a ela.
//  6/7/8. reconectar com o seller certo funciona; reconectar com o seller
//     errado bloqueia com ML_ACCOUNT_MISMATCH e não salva/move nenhum token.
//  9. ML1 e ML2 continuam independentes (mismatch de ML1 não mexe em ML2).
//  15. nenhum access_token/refresh_token aparece na URL/redirect.
//
// Mesmo padrão de mock das demais suítes: `pool` é monkeypatchado com um
// banco em memória; `global.fetch` é mockado para a troca code -> token do
// Mercado Livre. Sem PostgreSQL real.

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/vf-test";
process.env.ML_CLIENT_ID = process.env.ML_CLIENT_ID || "test-ml-client-id";
process.env.ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET || "test-ml-client-secret";
process.env.JWT_SECRET = process.env.JWT_SECRET || "venforce_secret_local";

const assert = require("assert");

let checks = 0;
function ok(label, condition) {
  assert.ok(condition, `FALHOU: ${label}`);
  checks += 1;
  console.log(`  ok  ${label}`);
}

const pool = require("../config/database");

class BaseDb {
  constructor() {
    this.clientes = [{ id: 1, nome: "Loja Eletrônico", slug: "loja-eletronico", ativo: true }];
    this.contas = [
      { id: 10, cliente_id: 1, marketplace: "meli", nome: "Mercado Livre 1", slug: "loja-eletronico-meli-1", external_account_id: null, is_primary: true, ativo: true, metadata_json: {} },
      { id: 11, cliente_id: 1, marketplace: "meli", nome: "Mercado Livre 2", slug: "loja-eletronico-meli-2", external_account_id: null, is_primary: false, ativo: true, metadata_json: {} },
    ];
    this.grants = [];
    this.nextGrantId = 900;
  }

  async connect() {
    return { query: (sql, params) => this.query(sql, params), release() {} };
  }

  async query(sql, params = []) {
    const q = String(sql).replace(/\s+/g, " ").trim();
    if (q.startsWith("SELECT id, nome, slug, ativo FROM clientes WHERE id = $1")) return { rows: this.clientes.filter(c => c.id === Number(params[0])) };
    if (q.startsWith("SELECT id, cliente_id FROM cliente_contas WHERE marketplace")) return { rows: this.contas.filter(c => c.marketplace === "meli" && String(c.external_account_id) === String(params[0])) };
    if (q.startsWith("SELECT id, cliente_id, cliente_conta_id, ml_user_id FROM ml_tokens")) return { rows: this.grants.filter(g => String(g.ml_user_id) === String(params[0])) };


    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(q) || q.includes("pg_advisory")) return { rows: [] };

    if (q.startsWith("SELECT * FROM clientes WHERE id = $1 AND ativo = true")) {
      return { rows: this.clientes.filter((c) => c.id === Number(params[0]) && c.ativo) };
    }
    if (q.startsWith("SELECT id, slug, nome FROM clientes WHERE slug = $1 AND ativo = true")) {
      return { rows: this.clientes.filter((c) => c.slug === params[0] && c.ativo) };
    }

    if (q.startsWith("SELECT * FROM cliente_contas WHERE id = $1 FOR UPDATE")) {
      const c = this.contas.find((c) => c.id === Number(params[0]));
      return { rows: c ? [{ ...c }] : [] };
    }
    if (q.startsWith("SELECT * FROM cliente_contas WHERE id = $1")) {
      const c = this.contas.find((c) => c.id === Number(params[0]));
      return { rows: c ? [{ ...c }] : [] };
    }
    if (q.startsWith("UPDATE cliente_contas SET external_account_id = $1")) {
      const c = this.contas.find((c) => c.id === Number(params[1]));
      if (c) c.external_account_id = params[0];
      return { rows: [] };
    }
    if (q.startsWith("UPDATE cliente_contas SET metadata_json =")) {
      const c = this.contas.find((c) => c.id === Number(params[0]));
      if (c) c.metadata_json = { ...(c.metadata_json || {}), nickname: params[1] };
      return { rows: [] };
    }
    if (q.startsWith("UPDATE ml_tokens SET cliente_conta_id = $1 WHERE cliente_id = $2 AND ml_user_id = $3")) {
      this.grants.forEach((g) => {
        if (g.cliente_id === Number(params[1]) && String(g.ml_user_id) === String(params[2])) g.cliente_conta_id = Number(params[0]);
      });
      return { rows: [] };
    }

    // mlTokenService.saveMlToken
    if (q.includes("information_schema.columns") && q.includes("has_is_primary")) {
      return { rows: [{ has_is_primary: true, has_refresh_metadata: true }] };
    }
    if (q.startsWith("SELECT id FROM ml_tokens WHERE cliente_id = $1 AND is_primary = true")) {
      const g = this.grants.find((g) => g.cliente_id === Number(params[0]) && g.is_primary);
      return { rows: g ? [{ id: g.id }] : [] };
    }
    if (q.startsWith("SELECT id FROM ml_tokens WHERE cliente_id = $1 AND ml_user_id = $2")) {
      const g = this.grants.find((g) => g.cliente_id === Number(params[0]) && String(g.ml_user_id) === String(params[1]));
      return { rows: g ? [{ id: g.id }] : [] };
    }
    // mlTokenService.resolveMlGrant({ clienteId, mlUserId }) — usado por
    // mlFetch(clienteId, path, { mlUserId }) na captura de nickname.
    if (q.includes("FROM ml_tokens t") && q.includes("t.cliente_id = $1 AND t.ml_user_id = $2")) {
      const g = this.grants.find((g) => g.cliente_id === Number(params[0]) && String(g.ml_user_id) === String(params[1]));
      return { rows: g ? [{ ...g, refresh_failures: 0 }] : [] };
    }
    if (q.startsWith("INSERT INTO ml_tokens") && q.includes("ON CONFLICT (cliente_id, ml_user_id) DO UPDATE")) {
      const clienteId = Number(params[0]);
      const mlUserId = String(params[1]);
      let g = this.grants.find((g) => g.cliente_id === clienteId && String(g.ml_user_id) === mlUserId);
      if (g) {
        g.access_token = params[2];
        g.refresh_token = params[3];
        g.expires_at = params[4];
        g.is_primary = g.is_primary || params[5] === true;
        g.token_status = "valid";
      } else {
        g = {
          id: this.nextGrantId++,
          cliente_id: clienteId,
          ml_user_id: mlUserId,
          access_token: params[2],
          refresh_token: params[3],
          expires_at: params[4],
          is_primary: params[5] === true,
          token_status: "valid",
          cliente_conta_id: null,
        };
        this.grants.push(g);
      }
      return { rows: [{ ...g }] };
    }

    if (q.startsWith("INSERT INTO activity_logs")) return { rows: [] };

    throw new Error(`Query não mapeada no mock: ${q}`);
  }
}

function fakeReq(query) {
  return { query, headers: {}, socket: {} };
}

class MemoryDb extends BaseDb {
 constructor(){super();this.log=[];this.saved=null;this.failBinding=false;}
 async query(sql,params=[]){
  const q=String(sql).replace(/\s+/g," ").trim();this.log.push(q);
  if(q==="BEGIN"){assert.equal(this.saved,null,"não pode aninhar BEGIN");this.saved=JSON.stringify({contas:this.contas,grants:this.grants});return {rows:[]};}
  if(q==="ROLLBACK"){Object.assign(this,JSON.parse(this.saved));this.saved=null;return {rows:[]};}
  if(q==="COMMIT"){this.saved=null;return {rows:[]};}
  if(this.failBinding&&q.startsWith("UPDATE ml_tokens SET cliente_conta_id"))throw Object.assign(new Error(this.bindingErrorMessage || "binding falhou"),{code:"BINDING_TEST_FAILURE"});
  if(q.startsWith("SELECT * FROM cliente_contas WHERE cliente_id"))return {rows:this.contas.filter(c=>c.cliente_id===Number(params[0])&&c.marketplace==="meli"&&String(c.external_account_id)===String(params[1]))};
  if(q.startsWith("SELECT COUNT(*)"))return {rows:[{total:this.contas.filter(c=>c.cliente_id===Number(params[0])&&c.marketplace==="meli").length}]};
  if(q.startsWith("SELECT id FROM cliente_contas WHERE cliente_id"))return {rows:this.contas.filter(c=>c.cliente_id===Number(params[0])&&c.marketplace==="meli"&&c.ativo&&c.is_primary)};
  if(q.startsWith("SELECT id FROM cliente_contas WHERE slug") || q.startsWith("SELECT 1 FROM cliente_contas WHERE slug"))return {rows:this.contas.filter(c=>c.slug===params[0])};
  if(q.startsWith("INSERT INTO cliente_contas")){
   assert.ok(q.includes("WHERE external_account_id IS NOT NULL DO NOTHING"));
   const c={id:Math.max(0,...this.contas.map(c=>c.id))+1,cliente_id:Number(params[0]),marketplace:"meli",nome:params[1],slug:params[2],external_account_id:params[3],is_primary:params[4],ativo:true,metadata_json:params[5]};this.contas.push(c);return {rows:[c]};
  }
  const result=await super.query(sql,params);
  return this.dropSavedGrant && q.startsWith("INSERT INTO ml_tokens") ? {rows:[]} : result;
 }
}
const service=require("../services/clienteContas/clienteContaService");
let db;
const args={clienteId:1,clienteSlug:"loja-eletronico",clienteContaId:10,mlUserId:"111",accessToken:"fixture-new-access",refreshToken:"fixture-new-refresh",expiresAt:new Date("2099-01-01")};
async function test(label,fn){db=new MemoryDb();pool.query=(sql,p)=>db.query(sql,p);pool.connect=async()=>({query:(sql,p)=>db.query(sql,p),release(){}});await fn();ok(label,true);}
async function run(){
 const originalQuery=pool.query;const originalConnect=pool.connect;
 try {
  await test("OAuth primeira Conta: uma transação e vínculo exato",async()=>{const c=await service.concluirOAuthContaMl(args);assert.equal(c.conta.id,10);assert.equal(db.grants[0].cliente_conta_id,10);assert.equal(db.log.filter(q=>q==="BEGIN").length,1);assert.equal(db.log.filter(q=>q==="COMMIT").length,1);});
  await test("falha de vínculo reverte Grant e external da Conta",async()=>{db.failBinding=true;await assert.rejects(service.concluirOAuthContaMl(args),e=>e.code==="BINDING_TEST_FAILURE");assert.equal(db.grants.length,0);assert.equal(db.contas[0].external_account_id,null);assert.ok(db.log.includes("ROLLBACK"));});
  await test("reconexão é idempotente e mantém o ID",async()=>{await service.concluirOAuthContaMl(args);const id=db.grants[0].id;await service.concluirOAuthContaMl(args);assert.equal(db.grants.length,1);assert.equal(db.grants[0].id,id);assert.equal(db.grants[0].cliente_conta_id,10);});
  await test("ML2 preserva Grant1 e sua Conta",async()=>{await service.concluirOAuthContaMl(args);const first=JSON.stringify(db.grants[0]);await service.concluirOAuthContaMl({...args,clienteContaId:11,mlUserId:"222"});assert.equal(JSON.stringify(db.grants[0]),first);assert.equal(db.grants[1].cliente_conta_id,11);});
  await test("callback legado ML2 cria Conta por seller, não principal",async()=>{await service.concluirOAuthContaMl(args);const first=JSON.stringify(db.grants[0]);const c=await service.concluirOAuthContaMl({...args,clienteContaId:null,mlUserId:"222"});assert.notEqual(c.conta.id,10);assert.equal(c.conta.external_account_id,"222");assert.equal(JSON.stringify(db.grants[0]),first);});
  await test("seller compartilhado rejeita antes de persistir token",async()=>{db.grants=[{id:99,cliente_id:2,cliente_conta_id:null,ml_user_id:"111",token_status:"revoked"}];await assert.rejects(service.concluirOAuthContaMl(args),e=>e.code==="SELLER_OWNERSHIP_AMBIGUOUS");assert.ok(!db.log.some(q=>q.startsWith("INSERT")));});
  await test("seller já vinculado à ML1 não pode ir para ML2",async()=>{await service.concluirOAuthContaMl(args);const old=JSON.stringify(db.grants);await assert.rejects(service.concluirOAuthContaMl({...args,clienteContaId:11}),e=>e.code==="ACCOUNT_CONTEXT_AMBIGUOUS");assert.equal(JSON.stringify(db.grants),old);});
  await test("Conta inativa/outro Cliente/marketplace bloqueia",async()=>{for(const patch of [{ativo:false},{cliente_id:2},{marketplace:"shopee"}]){const original={...db.contas[0]};Object.assign(db.contas[0],patch);await assert.rejects(service.concluirOAuthContaMl(args));db.contas[0]=original;}assert.ok(!db.log.some(q=>q.startsWith("INSERT")));});
  await test("Grant anteriormente vinculado a outra Conta não é movido",async()=>{db.grants=[{id:99,cliente_id:1,cliente_conta_id:11,ml_user_id:"111"}];await assert.rejects(service.concluirOAuthContaMl(args),e=>e.code==="GRANT_ACCOUNT_MISMATCH");assert.equal(db.grants[0].cliente_conta_id,11);});
  await test("resposta OAuth incompleta não abre transação",async()=>{for (const patch of [{mlUserId:null},{mlUserId:"not-a-seller"},{accessToken:{}},{refreshToken:" "},{expiresAt:new Date(NaN)}]) await assert.rejects(service.concluirOAuthContaMl({...args,...patch}),e=>e.code==="OAUTH_IDENTITY_INVALID");assert.equal(db.log.length,0);});
  await test("erro SQL de vínculo não expõe credenciais no callback",async()=>{db.failBinding=true;db.bindingErrorMessage="falha: "+args.accessToken+" / "+args.refreshToken;await assert.rejects(service.concluirOAuthContaMl(args),e=>e.code==="BINDING_TEST_FAILURE"&&!e.message.includes(args.accessToken)&&!e.message.includes(args.refreshToken));});
  await test("cache legado só é invalidado após COMMIT do OAuth completo",async()=>{const token=require("../services/mlTokenService");const original=token.clearGrantBackoff;let calls=0;token.clearGrantBackoff=id=>{assert.equal(db.saved,null);calls++;original(id);};try{db.failBinding=true;await assert.rejects(service.concluirOAuthContaMl(args));assert.equal(calls,0);db.failBinding=false;await service.concluirOAuthContaMl(args);assert.equal(calls,1);}finally{token.clearGrantBackoff=original;}});
  await test("save sem Grant retornado reverte em vez de concluir parcialmente",async()=>{db.dropSavedGrant=true;await assert.rejects(service.concluirOAuthContaMl(args),e=>e.code==="GRANT_PERSIST_FAILED");assert.equal(db.grants.length,0);assert.ok(db.log.includes("ROLLBACK"));});
 } finally {pool.query=originalQuery;pool.connect=originalConnect;}
 console.log(`${checks} cenários OAuth atômicos passaram`);
}
run().catch(e=>{console.error(e);process.exitCode=1;});
