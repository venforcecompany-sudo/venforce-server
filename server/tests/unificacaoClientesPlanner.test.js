const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { buildPlan, validateManifest } = require('../scripts/unificacaoClientes/planner');
const current = new Date();
const fk = (table, parent) => ({ type:'f',table_name:table,referenced_table:parent,name:`fk_${table}_${parent}`,definition:'FOREIGN KEY (id) REFERENCES parent(id)' });
function fixture() {
 return { version:1,collectedAt:current.toISOString(),session:{read_only:'on'},errors:[],columns:[],indexes:[],counts:[],constraints:[fk('cliente_contas','clientes'),fk('ml_tokens','clientes'),fk('ml_tokens','cliente_contas'),fk('base_cliente_vinculos','clientes'),fk('base_cliente_vinculos','cliente_contas')],tables:{
 clientes:[{id:1,ativo:true,slug:'canonico'},{id:2,ativo:true,slug:'legado'}],
 cliente_contas:[{id:11,cliente_id:1,marketplace:'shopee',external_account_id:null,ativo:true,is_primary:false},{id:21,cliente_id:2,marketplace:'meli',external_account_id:'222',ativo:true,is_primary:false,updated_at:'v1'}],
 ml_tokens:[{id:31,cliente_id:2,cliente_conta_id:21,ml_user_id:'222',token_status:'valid',is_primary:false}],
 bases:[{id:41,marketplace:'meli',ativo:true}],base_cliente_vinculos:[{id:51,cliente_id:2,cliente_conta_id:21,base_id:41,marketplace:'meli',ativo:true}],
 squads:[{id:61,ativo:true}],squad_members:[],cliente_squad_history:[{id:71,cliente_id:1,squad_id:61,fim_em:null},{id:72,cliente_id:2,squad_id:61,fim_em:null}],cliente_responsaveis:[],seller_clientes:[],user_bases:[] } };
}
const manifest = () => ({clienteCanonicoId:1,clientesLegados:[2],contas:[{clienteContaId:21,clienteOrigemId:2,clienteDestinoId:1}],decisaoEmpresarial:{aprovada:true,evidencia:'fixture sintética, sem dados reais',aprovador:'teste'},referenciasLogicasRevisadas:{aprovada:true,evidencia:'fixture vazia'},uniqueRevisadas:{aprovada:true,evidencia:'fixture sem UNIQUE adicional'},estrategiaUrls:'MANTER_SLUG_LEGADO_COM_LOOKUP'});
let count=0;
function test(label,fn){const s=fixture(),m=manifest();fn(s,m);count++;console.log('ok — '+label);}
const has=(p,code)=>p.validation.errors.some(e=>e.code===code);
const plan=(s,m)=>buildPlan(s,m,{now:current});
test('plano puro sem mutação e com rollback por PK',(s,m)=>{const before=JSON.stringify(s);const p=plan(s,m);assert.equal(p.validation.ok,true);assert.equal(p.writeCapability,false);assert.equal(p.productionReady,false);assert.equal(JSON.stringify(s),before);assert.equal(p.changes.length,3);for(const c of p.changes){const inverse=p.rollback.changes.find(i=>i.id===c.id&&i.table===c.table);assert.deepEqual(inverse.before,c.after);assert.deepEqual(inverse.after,c.before);}assert.deepEqual(p.clientesExcluidos,[]);});
test('manifesto exige decisão empresarial',(s,m)=>{m.decisaoEmpresarial.aprovada=false;assert.ok(has(plan(s,m),'BUSINESS_DECISION_REQUIRED'));});
test('destino/origem inexistentes',(s,m)=>{s.tables.clientes=[];const p=plan(s,m);assert.ok(has(p,'DESTINATION_NOT_FOUND'));assert.ok(has(p,'SOURCE_NOT_FOUND'));});
test('Conta inexistente',(s,m)=>{s.tables.cliente_contas=[];assert.ok(has(plan(s,m),'ACCOUNT_NOT_FOUND'));});
test('Conta com outro pai é conflito',(s,m)=>{s.tables.cliente_contas[1].cliente_id=9;assert.equal(plan(s,m).accountPlans[0].estado,'CONFLITO');});
test('estado parcialmente migrado detectado',(s,m)=>{s.tables.cliente_contas[1].cliente_id=1;assert.equal(plan(s,m).accountPlans[0].estado,'PARCIALMENTE_MIGRADO');});
test('já migrado sem aplicar novamente',(s,m)=>{s.tables.cliente_contas[1].cliente_id=1;s.tables.ml_tokens[0].cliente_id=1;s.tables.base_cliente_vinculos[0].cliente_id=1;const p=plan(s,m);assert.equal(p.accountPlans[0].estado,'JA_MIGRADO');assert.equal(p.changes.length,0);});
test('já migrado com Grant NULL exato continua inequívoco',(s,m)=>{s.tables.cliente_contas[1].cliente_id=1;s.tables.ml_tokens[0].cliente_id=1;s.tables.ml_tokens[0].cliente_conta_id=null;s.tables.base_cliente_vinculos[0].cliente_id=1;const p=plan(s,m);assert.equal(p.accountPlans[0].estado,'JA_MIGRADO');assert.equal(p.validation.ok,true);assert.equal(p.changes.length,0);});
test('histórico de origem preservado com política explícita não vira migração parcial',(s,m)=>{s.tables.cliente_contas[1].cliente_id=1;s.tables.ml_tokens[0].cliente_id=1;s.tables.base_cliente_vinculos[0].cliente_id=1;s.constraints.push(fk('historico','cliente_contas'));s.counts.push({table:'historico',scope:['cliente_id','cliente_conta_id'],complete:true,rows:[{cliente_id:2,cliente_conta_id:21,total:10}]});m.politicasHistorico={historico:'PRESERVAR_ORIGEM_COM_LOOKUP'};const p=plan(s,m);assert.equal(p.accountPlans[0].estado,'JA_MIGRADO');assert.equal(p.validation.ok,true);});
test('histórico com dono estranho continua bloqueado mesmo com política',(s,m)=>{s.constraints.push(fk('historico','cliente_contas'));s.counts.push({table:'historico',scope:['cliente_id','cliente_conta_id'],complete:true,rows:[{cliente_id:9,cliente_conta_id:21,total:10}]});m.politicasHistorico={historico:'PRESERVAR_ORIGEM_COM_LOOKUP'};assert.equal(plan(s,m).accountPlans[0].estado,'PARCIALMENTE_MIGRADO');});
test('seller ausente',(s,m)=>{s.tables.cliente_contas[1].external_account_id=null;assert.ok(has(plan(s,m),'SELLER_MISSING'));});
test('seller compartilhado entre Clientes',(s,m)=>{s.tables.ml_tokens.push({...s.tables.ml_tokens[0],id:99,cliente_id:1,cliente_conta_id:null});assert.ok(has(plan(s,m),'SELLER_OWNERSHIP_AMBIGUOUS'));});
test('Grant NULL exato não faz backfill de Conta',(s,m)=>{s.tables.ml_tokens[0].cliente_conta_id=null;const p=plan(s,m);assert.equal(p.validation.ok,true);assert.ok(!p.changes.some(c=>c.table==='ml_tokens'&&'cliente_conta_id' in c.after));});
test('Grant errado',(s,m)=>{s.tables.ml_tokens[0].ml_user_id='111';assert.ok(has(plan(s,m),'GRANT_ACCOUNT_MISMATCH'));});
test('Grant ausente',(s,m)=>{s.tables.ml_tokens=[];assert.ok(has(plan(s,m),'GRANT_MISSING_OR_AMBIGUOUS'));});
test('Base marketplace/inativa/parent errado',(s,m)=>{s.tables.bases[0].marketplace='shopee';assert.ok(has(plan(s,m),'BASE_ACCOUNT_MISMATCH'));});
test('Base NULL não ganha Conta automaticamente',(s,m)=>{s.tables.base_cliente_vinculos[0].cliente_conta_id=null;const p=plan(s,m);assert.ok(has(p,'LEGACY_BASE_MAPPING_REQUIRED'));assert.ok(!p.changes.some(c=>c.table==='base_cliente_vinculos'));});
test('duas Bases da Conta não escolhem primeira',(s,m)=>{s.tables.base_cliente_vinculos.push({...s.tables.base_cliente_vinculos[0],id:99});assert.ok(has(plan(s,m),'BASE_MISSING_OR_AMBIGUOUS'));});
test('UNIQUE external inclui Conta inativa',(s,m)=>{s.tables.cliente_contas.push({...s.tables.cliente_contas[1],id:99,cliente_id:1,ativo:false});assert.ok(has(plan(s,m),'UNIQUE_EXTERNAL_COLLISION'));});
test('UNIQUE principal não é resolvida automaticamente',(s,m)=>{s.tables.cliente_contas[0].marketplace='meli';s.tables.cliente_contas.forEach(a=>a.is_primary=true);assert.ok(has(plan(s,m),'UNIQUE_PRIMARY_COLLISION'));});
test('UNIQUE Grant principal colide',(s,m)=>{s.tables.ml_tokens[0].is_primary=true;s.tables.ml_tokens.push({id:99,cliente_id:1,cliente_conta_id:11,ml_user_id:'999',is_primary:true});assert.ok(has(plan(s,m),'UNIQUE_GRANT_PRIMARY_COLLISION'));});
test('Squad diferente impede ampliar acesso',(s,m)=>{s.tables.cliente_squad_history[1].squad_id=99;assert.ok(has(plan(s,m),'ACL_SCOPE_CHANGE_REQUIRES_DECISION'));});
test('responsáveis/acesso Seller diferentes exigem decisão',(s,m)=>{s.tables.cliente_responsaveis.push({id:99,cliente_id:2,user_id:7,funcao:'gestor',ativo:true});assert.ok(has(plan(s,m),'ACL_SCOPE_CHANGE_REQUIRES_DECISION'));});
test('histórico exige política de origem e lookup',(s,m)=>{s.constraints.push(fk('historico','cliente_contas'));s.counts.push({table:'historico',scope:['cliente_id','cliente_conta_id'],complete:true,rows:[{cliente_id:2,cliente_conta_id:21,total:10}]});assert.ok(has(plan(s,m),'HISTORY_POLICY_REQUIRED'));m.politicasHistorico={historico:'PRESERVAR_ORIGEM_COM_LOOKUP'};assert.equal(plan(s,m).validation.ok,true);});
test('milhões estimados não viram zero nem aprovação',(s,m)=>{s.constraints.push(fk('componentes','cliente_contas'));s.errors.push({table:'componentes',code:'VOLUME_ESTIMATED_ONLY',estimated_rows:1000000});assert.ok(has(plan(s,m),'DEPENDENCY_COVERAGE_INCOMPLETE'));});
test('referências lógicas/URLs precisam de evidência',(s,m)=>{delete m.referenciasLogicasRevisadas;delete m.estrategiaUrls;const p=plan(s,m);assert.ok(has(p,'LOGICAL_REFERENCES_REVIEW_REQUIRED'));assert.ok(has(p,'URL_ALIAS_STRATEGY_REQUIRED'));});
test('índice único não modelado exige ensaio',(s,m)=>{s.constraints.push(fk('historico','cliente_contas'));s.indexes.push({table_name:'historico',name:'uq_competencia',definition:'CREATE UNIQUE INDEX uq_competencia ON historico (cliente_id, competencia)'});delete m.uniqueRevisadas;assert.ok(has(plan(s,m),'UNIQUE_REVIEW_REQUIRED'));});
test('catálogo/FK/tabela ausentes bloqueiam',(s,m)=>{s.constraints=[];delete s.tables.seller_clientes;const p=plan(s,m);assert.ok(has(p,'CORE_FK_CATALOG_MISSING'));assert.ok(has(p,'SNAPSHOT_TABLE_MISSING'));});
test('PK duplicada não é escolhida pelo primeiro resultado',(s,m)=>{s.tables.clientes.push({...s.tables.clientes[0]});assert.ok(has(plan(s,m),'SNAPSHOT_ROW_ID_AMBIGUOUS'));});
test('snapshot antigo bloqueia',(s,m)=>{s.collectedAt='2020-01-01';assert.ok(has(plan(s,m),'SNAPSHOT_STALE'));});
test('read-only não comprovado bloqueia',(s,m)=>{s.session.read_only='off';assert.ok(has(plan(s,m),'READ_ONLY_EVIDENCE_MISSING'));});
test('Conta duplicada/IDs inválidos no manifesto recusam',(s,m)=>{m.contas.push({...m.contas[0]});assert.throws(()=>validateManifest(m),/MANIFEST_ACCOUNT_INVALID/);});
test('segredos recusados sem exportar valores',(s,m)=>{s.tables.ml_tokens[0].access_token='NEVER_EXPORT';assert.throws(()=>plan(s,m),/SECRET_FIELD_REJECTED/);});
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'unificacao-test-'));
try{
 const snap=path.join(directory,'snapshot.json'),man=path.join(directory,'manifest.json');fs.writeFileSync(snap,JSON.stringify(fixture()));fs.writeFileSync(man,JSON.stringify(manifest()));
 const cli=path.resolve(__dirname,'../scripts/unificacaoClientes/cli.js');
 const call=args=>spawnSync(process.execPath,[cli,...args],{env:{...process.env,DATABASE_URL:'invalid-do-not-connect'},encoding:'utf8'});
 const args=['--manifest',man,'--snapshot',snap];
 assert.equal(call(['--plan',...args]).status,0);assert.equal(call(['--validate',...args]).status,0);count+=2;
 for(const flag of ['--apply','--execute','--commit']){assert.equal(call([flag,...args]).status,64);count++;}
 assert.equal(call(['--plan','--validate',...args]).status,64);count++;
 const pending=manifest();pending.decisaoEmpresarial.aprovada=false;fs.writeFileSync(man,JSON.stringify(pending));assert.equal(call(['--validate',...args]).status,2);count++;
 assert.equal(call(['--plan',...args,'--output',snap]).status,64);count++;
 assert.equal(JSON.parse(fs.readFileSync(snap)).tables.cliente_contas[1].cliente_id,2);
 fs.writeFileSync(man,'{"password":"PRIVATE_TEST_VALUE"');
 const malformed=call(['--plan',...args]);assert.equal(malformed.status,64);assert.ok(!malformed.stderr.includes('PRIVATE_TEST_VALUE'));count++;
 fs.writeFileSync(man,JSON.stringify({...manifest(),accessToken:'PRIVATE_TEST_VALUE'}));
 const secret=call(['--plan',...args]);assert.equal(secret.status,64);assert.ok(!secret.stderr.includes('PRIVATE_TEST_VALUE'));count++;
}finally{fs.rmSync(directory,{recursive:true,force:true});}
console.log(`${count} verificações de planejamento/CLI passaram; zero conexão ou escrita em banco.`);
