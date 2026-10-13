#!/usr/bin/env node
// Somente SELECT direto; não carrega serviços, endpoints, workers ou pool da aplicação.
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const dotenv = require('dotenv');
const allowed = {
 clientes: ['id','nome','slug','ativo','created_at','updated_at'],
 cliente_contas: ['id','cliente_id','marketplace','nome','slug','external_account_id','is_primary','ativo','created_at','updated_at'],
 ml_tokens: ['id','cliente_id','cliente_conta_id','ml_user_id','is_primary','token_status','expires_at','refresh_failures','next_refresh_attempt_at','created_at','updated_at'],
 bases: ['id','slug','nome','marketplace','ativo','created_at','updated_at'],
 base_cliente_vinculos: ['id','base_id','cliente_id','cliente_conta_id','marketplace','origem','ativo','created_at','updated_at'],
 squads: ['id','nome','slug','ativo'], squad_members: ['id','squad_id','user_id','is_primary','funcao','ativo'],
 cliente_squad_history: ['id','cliente_id','squad_id','inicio_em','fim_em','alterado_por'],
 cliente_responsaveis: ['id','cliente_id','user_id','funcao','ativo','inicio_em','fim_em'],
 seller_clientes: ['id','user_id','cliente_id','marketplace','ativo'], user_bases: ['user_id','base_id']
};
const quote = s => '"'+s.replace(/"/g,'""')+'"';
async function collect({ envFile, outputDirectory }) {
 if (!envFile || !outputDirectory) throw new Error('EXPLICIT_ENV_AND_OUTPUT_REQUIRED');
 const directory = path.resolve(outputDirectory);
 if (fs.existsSync(directory)) throw new Error('OUTPUT_DIRECTORY_EXISTS_USE_NEW');
 fs.mkdirSync(directory, { recursive:true, mode:0o700 });
 if (fs.existsSync(path.join(directory,'snapshot.json'))) throw new Error('SNAPSHOT_EXISTS_USE_NEW_DIRECTORY');
 fs.writeFileSync(path.join(directory,'.gitignore'), '*\n', { mode:0o600 });
 const cfg=dotenv.parse(fs.readFileSync(envFile));
 if(!cfg.DATABASE_URL)throw new Error('CONNECTION_CONFIG_MISSING');
 const db=new Client({connectionString:cfg.DATABASE_URL,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:8000,
   options:'-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=1500'});
 const snapshot={version:1,collectedAt:new Date().toISOString(),source:'live-read-only',errors:[],tables:{},counts:[]};
 const query=async(sql,values=[])=>{
   if(!/^SELECT\b/i.test(sql.trim()) || /;|FOR\s+UPDATE|pg_advisory|dblink|set_config/i.test(sql))throw new Error('READ_ONLY_QUERY_REJECTED');
   return (await db.query(sql,values)).rows;
 };
 try{
  await db.connect();
  snapshot.session=(await query("SELECT current_setting('transaction_read_only') AS read_only, current_timestamp AS observed_at"))[0];
  if(snapshot.session.read_only!=='on')throw new Error('READ_ONLY_NOT_ENFORCED');
  snapshot.columns=await query("SELECT table_name,column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position");
  snapshot.constraints=await query("SELECT c.conname AS name,c.contype AS type,c.conrelid::regclass::text AS table_name,c.confrelid::regclass::text AS referenced_table,pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' ORDER BY c.conrelid::regclass::text,c.conname");
  snapshot.indexes=await query("SELECT tablename AS table_name,indexname AS name,indexdef AS definition FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname");
  snapshot.estimates=await query("SELECT c.relname AS table_name,c.reltuples::bigint AS estimated_rows FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'");
  for(const [table,fields] of Object.entries(allowed)){
   const cols=snapshot.columns.filter(c=>c.table_name===table).map(c=>c.column_name);
   const projected=fields.filter(f=>cols.includes(f));
   if(!projected.length){snapshot.errors.push({table,code:'TABLE_ABSENT'});continue;}
   snapshot.tables[table]=await query(`SELECT ${projected.map(quote).join(',')} FROM ${quote(table)} ORDER BY ${quote(projected[0])}`);
  }
  for(const {table_name:table,estimated_rows} of snapshot.estimates){
   if(allowed[table])continue;
   const scope=snapshot.columns.filter(c=>c.table_name===table&&['cliente_id','cliente_conta_id','cliente_slug','base_id','grant_id','ml_user_id','seller_id','external_account_id'].includes(c.column_name)).map(c=>c.column_name);
   if(!scope.length)continue;
   if(Number(estimated_rows)>500000){snapshot.errors.push({table,code:'VOLUME_ESTIMATED_ONLY',estimated_rows});continue;}
   try{
    const group=scope.map(quote).join(',');
    const rows=await query(`SELECT ${group},COUNT(*)::bigint AS total FROM ${quote(table)} GROUP BY ${group}`);
    snapshot.counts.push({table,scope,rows,complete:true});
   }catch(e){snapshot.errors.push({table,code:e.code||'QUERY_FAILED'});}
  }
  fs.writeFileSync(path.join(directory,'snapshot.json'),JSON.stringify(snapshot,null,2)+'\n',{mode:0o600});
  return {outputDirectory:directory,readOnly:true,counts:Object.fromEntries(Object.entries(snapshot.tables).map(([k,v])=>[k,v.length])),incompleteTables:snapshot.errors};
 }finally{await db.end();}
}
if(require.main===module){
 const argv=process.argv.slice(2);
 if(argv.length!==4||argv[0]!=='--env-file'||argv[2]!=='--output-dir'){
  process.stderr.write('Use --env-file CAMINHO --output-dir DIRETORIO_PRIVADO_NOVO\n');process.exitCode=64;
 }else collect({envFile:argv[1],outputDirectory:argv[3]}).then(r=>process.stdout.write(JSON.stringify(r)+'\n')).catch(e=>{process.stderr.write(JSON.stringify({code:e.code||'COLLECTION_FAILED'})+'\n');process.exitCode=1;});
}
module.exports={collect,allowed};
