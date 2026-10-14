import pathlib,json,csv,re,unicodedata,difflib,itertools,collections,argparse,subprocess
parser=argparse.ArgumentParser();parser.add_argument("--snapshot",required=True);parser.add_argument("--historical-candidates");args=parser.parse_args()
p=pathlib.Path(args.snapshot).resolve().parent;s=json.loads(pathlib.Path(args.snapshot).read_text());t=s['tables'];C=t['clientes'];A=t['cliente_contas'];G=t['ml_tokens'];B=t['bases'];V=t['base_cliente_vinculos'];H=t['cliente_squad_history']
def no_secrets(obj):
 if isinstance(obj,dict):
  for k,v in obj.items():
   if re.fullmatch(r'access_?token|refresh_?token|password|senha|database_?url|jwt|client_?secret|secret',k,re.I):raise ValueError('SECRET_FIELD_REJECTED')
   no_secrets(v)
 elif isinstance(obj,list):
  for v in obj:no_secrets(v)
no_secrets(s)
if not (p/'.gitignore').exists() or '*' not in (p/'.gitignore').read_text().splitlines():raise ValueError('PRIVATE_IGNORED_DIRECTORY_REQUIRED')
if any(not re.fullmatch(r'[a-zA-Z0-9_]+',name) for name in t):raise ValueError('TABLE_NAME_INVALID')
N=lambda x:int(x) if x is not None else None
rowsby=lambda rows,k,v:[r for r in rows if N(r.get(k))==N(v)]
active=lambda r:r.get('ativo') is True
squads=lambda cid:[h['squad_id'] for h in rowsby(H,'cliente_id',cid) if h.get('fim_em') is None]
external=lambda cid:set(str(a['external_account_id']) for a in rowsby(A,'cliente_id',cid) if a.get('external_account_id'))|set(str(g['ml_user_id']) for g in rowsby(G,'cliente_id',cid) if g.get('ml_user_id'))
def stem(x):
 x=''.join(c for c in unicodedata.normalize('NFKD',str(x).lower()) if not unicodedata.combining(c));x=re.sub(r'[^a-z0-9]+',' ',x).strip();x=re.sub(r'(?:\s+(?:ml|meli|mercado livre|shopee|tiktok))?\s*\d+$','',x).strip();return x
# Mesma triagem que a API backend; os candidatos históricos abaixo continuam
# exclusivos do inventário explícito offline, sem inferência empresarial.
candidate_domain=pathlib.Path(__file__).resolve().parents[2]/'services/clientesUnificacao/candidates.js'
result=subprocess.run(['node',str(candidate_domain)],input=json.dumps({k:t[k] for k in ['clientes','cliente_contas','ml_tokens','cliente_squad_history']}),text=True,capture_output=True,check=True)
pairs=json.loads(result.stdout)
# Preserva candidatos da auditoria anterior ausentes no limiar atual, sem
# promover a prova empresarial ou apagar a revisão humana pendente.
old=json.loads(pathlib.Path(args.historical_candidates).read_text()) if args.historical_candidates else []
existing={tuple(sorted([r['cliente_a'],r['cliente_b']])) for r in pairs}
for r in old:
 key=tuple(sorted([r['cliente_atual'],r['outro_cliente']]))
 if key not in existing and all(any(c['id']==x for c in C) for x in key):
  pairs.append({'cliente_a':key[0],'cliente_b':key[1],'classificacao':'DECISAO_HUMANA','score_priorizacao':0,'motivos':[{'motivo':'candidato histórico preservado; não atende ao limiar textual atual; exige revalidação empresarial','pontos':0}],'sellers_compartilhados':sorted(external(key[0])&external(key[1])),'decisao':'PENDENTE','cliente_canonico_aprovado':None})
parent={c['id']:c['id'] for c in C}
def find(x):
 while parent[x]!=x:x=parent[x]
 return x
for a in pairs:parent[find(a['cliente_a'])]=find(a['cliente_b'])
groups=collections.defaultdict(set)
for a in pairs:groups[find(a['cliente_a'])].update([a['cliente_a'],a['cliente_b']])
group_rows=[{'grupo':f'G{i+1:02d}','clientes':sorted(ids),'decisao':'PENDENTE','empresa_comprovada':False} for i,ids in enumerate(sorted(groups.values(),key=lambda v:min(v)))]
sellers=collections.defaultdict(lambda:{'clientes':set(),'contas':set(),'grants':set()})
for a in A:
 if a['marketplace']=='meli' and a.get('external_account_id'):
  k=str(a['external_account_id']);sellers[k]['clientes'].add(a['cliente_id']);sellers[k]['contas'].add(a['id'])
for g in G:
 if g.get('ml_user_id'):
  k=str(g['ml_user_id']);sellers[k]['clientes'].add(g['cliente_id']);sellers[k]['grants'].add(g['id'])
shared_rows=[{'seller':k,**{f:sorted(v) for f,v in value.items()}} for k,value in sellers.items() if len(value['clientes'])>1]
mapa=[];anom=[];missingG=[];missingB=[];ambB=[]
for c in C:
 contas=[]
 for a in rowsby(A,'cliente_id',c['id']):
  exact=[g for g in G if N(g['cliente_id'])==N(c['id']) and str(g['ml_user_id'])==str(a.get('external_account_id'))] if a.get('external_account_id') and a['marketplace']=='meli' else []
  valid=[v for v in V if N(v['cliente_id'])==N(c['id']) and v['marketplace']==a['marketplace'] and active(v) and any(N(b['id'])==N(v['base_id']) and active(b) and b['marketplace']==a['marketplace'] for b in B)]
  direct=[v for v in valid if N(v.get('cliente_conta_id'))==N(a['id'])];legacy=[v for v in valid if v.get('cliente_conta_id') is None];eligible=[x for x in rowsby(A,'cliente_id',c['id']) if active(x) and x['marketplace']==a['marketplace']]
  candidates=direct+(legacy if len(eligible)==1 else [])
  identity_shared=bool(a.get('external_account_id') and len(sellers[str(a['external_account_id'])]['clientes'])>1) if a['marketplace']=='meli' else False
  grant_status='MANUAL' if a['marketplace']!='meli' else 'AMBIGUA' if identity_shared or len(exact)>1 else 'OK' if len(exact)==1 and (exact[0].get('cliente_conta_id') is None or N(exact[0]['cliente_conta_id'])==N(a['id'])) else 'AUSENTE_OU_INCOERENTE'
  base_status='OK' if len(candidates)==1 else 'AMBIGUA' if len(candidates)>1 or (not direct and legacy and len(eligible)!=1) else 'AUSENTE'
  if grant_status=='AUSENTE_OU_INCOERENTE':missingG.append({'cliente_id':c['id'],'cliente_conta_id':a['id'],'ativo':a['ativo']})
  if base_status=='AUSENTE':missingB.append({'cliente_id':c['id'],'cliente_conta_id':a['id'],'ativo':a['ativo']})
  if base_status=='AMBIGUA':ambB.append({'cliente_id':c['id'],'cliente_conta_id':a['id'],'base_ids':[v['base_id'] for v in direct+legacy]})
  modules={}
  for count in s['counts']:
   scoped=[r for r in count['rows'] if N(r.get('cliente_conta_id'))==N(a['id'])] if 'cliente_conta_id' in count['scope'] else []
   if scoped:modules[count['table']]=sum(int(r['total']) for r in scoped)
  contas.append({**a,'grant_status':grant_status,'grants_ids':[g['id'] for g in exact],'base_status':base_status,'bases_ids':[v['base_id'] for v in candidates],'bases_legadas':[v['base_id'] for v in legacy],'seller_compartilhado':identity_shared,'modulos_por_conta':modules,'ads':'PARCIAL: agregado comercial por slug; origem por Conta não persistida','integracao':'manual/indeterminada' if a['marketplace']!='meli' else grant_status})
  for status,kind in [(grant_status,'GRANT'),(base_status,'BASE')]:
   if status not in ('OK','MANUAL'):anom.append({'tipo':kind,'cliente_id':c['id'],'cliente_conta_id':a['id'],'status':status})
 mapa.append({**c,'squads_atual':squads(c['id']),'historico_squad':rowsby(H,'cliente_id',c['id']),'responsaveis':rowsby(t['cliente_responsaveis'],'cliente_id',c['id']),'acessos_seller':rowsby(t['seller_clientes'],'cliente_id',c['id']),'contas':contas,'grants_legados':[g for g in rowsby(G,'cliente_id',c['id']) if g.get('cliente_conta_id') is None],'bases_legadas':[v for v in rowsby(V,'cliente_id',c['id']) if v.get('cliente_conta_id') is None],'identidade_empresarial':'NAO_COMPROVADA'})
def save(name,rows):
 (p/(name+'.json')).write_text(json.dumps(rows,indent=2,ensure_ascii=False)+'\n')
 if isinstance(rows,list):
  keys=sorted(set().union(*(r.keys() for r in rows))) if rows else []
  with (p/(name+'.csv')).open('w') as f:
   w=csv.DictWriter(f,fieldnames=keys);w.writeheader();w.writerows({k:json.dumps(v,ensure_ascii=False) if isinstance(v,(dict,list)) else v for k,v in r.items()} for r in rows)
for table,data in t.items():save('grants' if table=='ml_tokens' else table,data)
for name,rows in [('mapa_por_cliente',mapa),('candidatos_unificacao',pairs),('grupos_candidatos',group_rows),('seller_compartilhado',shared_rows),('grants_sem_conta',[g for g in G if g.get('cliente_conta_id') is None]),('contas_sem_grant',missingG),('contas_sem_base',missingB),('bases_ambiguas',ambB),('anomalias',anom)]:save(name,rows)
summary={'collectedAt':s['collectedAt'],'clientes':len(C),'cliente_contas':len(A),'grants':len(G),'bases':len(B),'squads':len(t['squads']),'pares_candidatos':len(pairs),'grupos_candidatos':len(groups),'grupos_empresa_comprovada':0,'pares_por_classificacao':dict(collections.Counter(a['classificacao'] for a in pairs)),'sellers_compartilhados':len(shared_rows),'decisoes_humanas_pendentes':len(groups),'grants_sem_conta':sum(g.get('cliente_conta_id') is None for g in G),'base_ambigua_operacoes':len(ambB),'contas_sem_grant':len(missingG),'contas_sem_base':len(missingB),'limits':s['errors']}
(p/'resumo.json').write_text(json.dumps(summary,indent=2,ensure_ascii=False)+'\n');print(json.dumps(summary,ensure_ascii=False))
