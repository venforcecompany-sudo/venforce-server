const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const directory = fs.mkdtempSync(path.join(os.tmpdir(),'unificacao-readonly-'));
const envFile = path.join(directory,'fixture.env');
fs.writeFileSync(envFile,'DATABASE_URL=postgres://fixture:never-export-this@localhost/test\n');
const statements=[];let readOnly='on';let config;let ended=0;let connected=0;
const fields = { clientes:['id','nome','slug','ativo'],cliente_contas:['id','cliente_id','marketplace','ativo'],ml_tokens:['id','cliente_id','cliente_conta_id','ml_user_id','access_token','refresh_token'],bases:['id','marketplace','ativo'],base_cliente_vinculos:['id','cliente_id','cliente_conta_id','base_id','marketplace','ativo'],squads:['id','ativo'],squad_members:['id','user_id','squad_id'],cliente_squad_history:['id','cliente_id','squad_id'],cliente_responsaveis:['id','cliente_id','user_id'],seller_clientes:['id','cliente_id','user_id'],user_bases:['user_id','base_id'] };
class FakeClient {
 constructor(opts){config=opts;}
 async connect(){connected++;}
 async end(){ended++;}
 async query(sql){
  statements.push(sql);assert.ok(/^SELECT\b/.test(sql));assert.ok(!/INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK|set_config|pg_advisory/.test(sql));
  if(sql.includes('current_setting'))return {rows:[{read_only:readOnly}]};
  if(sql.includes('information_schema.columns'))return {rows:Object.entries(fields).flatMap(([table_name,cols])=>cols.map(column_name=>({table_name,column_name,data_type:'text',is_nullable:'YES'})))};
  if(sql.includes('FROM pg_constraint')||sql.includes('FROM pg_indexes')||sql.includes('FROM pg_class'))return {rows:[]};
  if(sql.includes('FROM "ml_tokens"'))assert.ok(!/access_token|refresh_token/.test(sql),'projeção nunca lê credenciais');
  return {rows:[]};
 }
}
const originalLoad=Module._load;
Module._load=function(request,parent,isMain){if(request==='pg')return {Client:FakeClient};return originalLoad.call(this,request,parent,isMain);};
const {collect}=require('../scripts/unificacaoClientes/coletarSnapshot');
Module._load=originalLoad;
async function run(){
 try{
  const output=path.join(directory,'new-private');const result=await collect({envFile,outputDirectory:output});
  assert.equal(result.readOnly,true);assert.ok(config.options.includes('default_transaction_read_only=on'));
  assert.ok(config.options.includes('statement_timeout=10000'));assert.ok(config.options.includes('lock_timeout=1500'));
  assert.equal(fs.readFileSync(path.join(output,'.gitignore'),'utf8'),'*\n');
  assert.ok(!fs.readFileSync(path.join(output,'snapshot.json'),'utf8').includes('never-export-this'));
  assert.equal(ended,1);assert.equal(connected,1);
  await assert.rejects(collect({envFile,outputDirectory:output}),/OUTPUT_DIRECTORY_EXISTS_USE_NEW/);assert.equal(connected,1);
  readOnly='off';const before=statements.length;
  await assert.rejects(collect({envFile,outputDirectory:path.join(directory,'readonly-off')}),/READ_ONLY_NOT_ENFORCED/);
  assert.equal(statements.length,before+1);assert.equal(ended,2);
  assert.ok(!fs.existsSync(path.join(directory,'readonly-off','snapshot.json')));
  await assert.rejects(collect({}),/EXPLICIT_ENV_AND_OUTPUT_REQUIRED/);
  console.log('coletor read-only: SELECTs, timeouts, sigilo, rejeição de read-only OFF e diretório novo passaram');
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
}
run().catch(e=>{console.error(e);process.exitCode=1;});
