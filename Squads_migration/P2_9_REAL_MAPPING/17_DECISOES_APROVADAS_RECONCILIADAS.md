# 17 — Decisões humanas aprovadas, reconciliadas contra o banco

> **Estado:** `SQUADS_ENFORCEMENT` = **OFF** · migração **NÃO APLICADA** ·
> banco **NÃO ALTERADO** · `--apply` **NÃO EXECUTADO** · 0 usuário criado ·
> 0 cliente criado · 0 Grant movido.

| | |
|---|---|
| Documento humano | `Squads_migration/VENFORCE_V3_P2_9_DECISOES_FINAIS_APROVADAS.md` |
| + rodada 2 | as três respostas objetivas: Klayvert, Vinícius e o Grant cruzado |
| Documento humano anterior | `16_DECISOES_FINAIS_HUMANAS.md` (permanece, é histórico) |
| Branch | `backend/v3-p2-9-real-mapping` |
| Base | `7acb3f0` + merge de `origin/main` `bb33973` |
| Banco lido | produção (Render) · **somente leitura** |
| Snapshot do inventário | `2026-09-04T18:23:46.199Z` |

---

## 0. `origin/main` — integrada por merge normal

`origin/main` avançou de `fd2671a` para **`bb33973`**. Três commits, todos do
mesmo hotfix do Fechamento V3 (PR #97):

```
bb33973 Merge pull request #97 from .../hotfix/fechamento-v3-auth-public-route
2de98c1 test(cliente-contas): cobre a regressão do auth global-bloqueio (fd487d4)
216f8d7 fix: impedir auth global-bloqueio
```

Integrada nesta branch por **merge normal** (`--no-ff`, sem rebase, sem force):
tocam `server/routes/clienteContasRoutes.js` e dois testes de `cliente_contas`;
esta branch toca `server/sql/squads-mapeamento-real.js`, o teste dele e
`Squads_migration/`. **Zero interseção de arquivos, zero conflito.**

Os dois lados foram conferidos depois do merge: o hotfix está presente
(`216f8d7` é o último commit de `clienteContasRoutes.js`, e
`clienteContasAuthPerRoute.test.js` existe e passa com 11 verificações), e o
trabalho P2.9 está intacto.

---

## 1. A regra que governou esta reconciliação

> **A decisão humana define O QUE se quer. O banco define A QUEM isso
> corresponde.**

Nenhuma afirmação do documento novo virou dado técnico sem ser reconferida
contra o inventário real. Onde o documento decidiu e o banco confirma, a
decisão entrou. Onde o documento **não** decidiu, nada foi inferido — a
membership correspondente ficou **bloqueada**, não adivinhada.

Isso está implementado, não prometido: a camada de decisões só sabe
**restringir**. Ela resolve identidade por igualdade exata de email confirmado
contra usuário **ativo**; se o email não resolver exatamente um, a membership
é bloqueada (`DECISAO_EMAIL_NAO_RESOLVE`). Uma decisão que não encontra o
assento que diz endereçar vira `DECISAO_SEM_ASSENTO` em vez de sumir em
silêncio.

---

## 2. Matriz de reconciliação

Nada do documento anterior desaparece. Cada linha de `16` aparece abaixo com o
que aconteceu com ela.

### 2.1 Bloqueavam o APPLY

| # | DECISÃO ANTIGA | STATUS ANTIGO | DECISÃO NOVA | EVIDÊNCIA | STATUS FINAL |
|---|---|---|---|---|---|
| 1 | Squad principal de Micael (#24), squad-1 × squad-5 | 🔴 pendente | **Squad 1** | §3.2/§6 do doc aprovado · `user.id 24` confirmado por `micael.almeida@vendexcompany.com` | ✅ **RESOLVIDO** — plano marca `principal: true` só em squad-1 |
| 1 | Squad principal de Sophia (#28), squad-5 × squad-6 | 🔴 pendente | **Squad 5** | §3.2/§5.2/§6 · `user.id 28` por `sophia.costa@vendexcompany.com` | ✅ **RESOLVIDO** — `principal: true` só em squad-5 |
| 1 | Squad principal de Klayvert, squads 2/3/6 | 🔴 pendente | **Squad 2** | §3.2/§6 | ⚠️ **decisão registrada, inaplicável** — a identidade de Klayvert continua indefinida (ver 3.1). O principal está no arquivo de decisões e passa a valer no instante em que a conta for escolhida |
| 1 | Squad principal de Fernando, squad-1 × squad-4 | 🔴 pendente | **não existe** — são duas pessoas | §3.3/§7 | ✅ **DISSOLVIDO** — cada Fernando ocupa 1 Squad e é principal dele |
| 2 | Quem é "Fernando": #5 Salgado (admin) **ou** #45 Montoro (membro)? | 🔴 ambíguo | **os dois; pessoas diferentes** — squad-1:auxiliar2 = Montoro, squad-4:coordenador = Salgado | emails confirmados batem exatamente 1 usuário ativo cada: `fernando.montoro@vendexcompany.com` → **#45**, `fernando.salgado@vendexcompany.com` → **#5** (`role=admin`) | ✅ **RESOLVIDO** |
| 2 | Quem é "Klayvert": #22 (`.com`) **ou** #35 (`.com.br`)? | 🔴 ambíguo | **#35** — rodada 2, decisão 1 | `klayvert.rodrigues@vendexcompany.com.br` resolve exatamente 1 usuário ativo: **#35**. Motivo humano: é a conta com atividade recente registrada | ✅ **RESOLVIDO** — 3 memberships de Coordenador emitidas (squads 2, 3, 6), principal squad-2. **#22 não é tocada**: fica como dívida de saneamento |
| 2 | Quem é "Victor": #6 Vitor Capeli (admin)? | 🔴 ambíguo | **nenhum dos dois** — Victor é usuário **ainda não criado** | §3.1/§8 | ✅ **RESOLVIDO por exclusão** — o casamento aproximado com a conta admin #6 fica formalmente **revogado** |
| 2 | Quem é "Vinícius": #29 Bergo (admin) **ou** #44 Dias (membro)? | 🔴 ambíguo | **#44 Vinicius Dias** — rodada 2, decisão 2 | `vinicius.dias@vendexcompany.com` resolve exatamente 1 usuário ativo: **#44** | ✅ **RESOLVIDO** — `squad-2:auxiliar2` emitido. A conta admin **#29 não é usada nem alterada** |
| 3 | Três pessoas sem conta: Caique, Carol, Yuri | 🔴 pendente | **quatro**: + **Victor**. Nenhuma conta é criada; só as memberships técnicas ficam fora | §3.5/§8 | ✅ **RESOLVIDO** — ver seção 4 |

### 2.2 Bloqueavam o ENFORCEMENT

| # | DECISÃO ANTIGA | STATUS ANTIGO | DECISÃO NOVA | EVIDÊNCIA | STATUS FINAL |
|---|---|---|---|---|---|
| 4 | Grant cruzado **Fenix (#102) × Eliza.Market (#105)** | 🟠 pendente | **NÃO MEXER** — rodada 2, decisão 3. Grants #69 e #70 ficam exatamente como estão | reauditoria read-only completa na seção 5; classificação preservada | ⛔ **ABERTO POR DECISÃO** — não bloqueia APPLY, **bloqueia ENFORCEMENT** |
| 5 | Squad 8 · Legado com 26 clientes e nenhum membro | 🟠 pendente | **confirmado como está**: 6 operacionais + Squad 8 Legado, sem renumerar; acesso só por admin e por memberships reais; `responsibility` não é autorização | §10 | ✅ **RESOLVIDO** — comportamento mantido, 26 clientes |

### 2.3 Confirmações rápidas

| # | DECISÃO ANTIGA | STATUS ANTIGO | DECISÃO NOVA | EVIDÊNCIA | STATUS FINAL |
|---|---|---|---|---|---|
| 6 | `MM` é #54 MM Importes ou #107 MM Comercio? | 🟡 aberto | **não decidido** — a carteira aprovada repete só "MM" | §3.6 lista `MM` no Squad 3 sem desambiguar; ambos existem, ativos, com conta e grant próprios | 🟡 **CONTINUA ABERTO, não bloqueante** — os dois seguem no Squad 8 |
| 7 | `JFX` (#75) é segunda entidade da `JF`? | 🟡 aberto | **não mencionado** | `JF` → #37 JF Shopp (Squad 1); #75 fora da relação | 🟡 **CONTINUA ABERTO, não bloqueante** — #75 segue no Squad 8 |
| 8 | Canônico do cluster `wm`: #123 `wm.modas` × #116 `William Modas` | 🟡 aberto | **não mencionado** | ambos vão para o **Squad 4** de qualquer forma; a consolidação é `PLAN_ONLY` | 🟡 **CONTINUA ABERTO, não bloqueante e sem efeito no APPLY** |

### 2.4 O que já estava resolvido e continua

| questão | estado |
|---|---|
| rótulo do 6º bloco | ✅ **confirmado como Squad 6** pelo humano (§3.1) e pela própria planilha (`Squads.xlsx`, linha 41: `squad 6`) |
| Design do Squad 6 | ✅ **Sophia**, e o doc revoga expressamente o "sem Design por enquanto" (§5.2) |
| 6 Squads + legado | ✅ invariante **I15/I16** verdes: `squad-1..6` + `squad-8-legado`, nenhum squad-7/9 |
| `Gabrielly` × `Cavazzoto` | ✅ agora por **email confirmado**, não mais por propagação: #16 e #47 |
| `Witor` × `Vitor` | ✅ intacto — camada exata antes da aproximada |
| clusters, sufixo, chave natural | ✅ intactos — 11 clusters, 16 aliases, mesmos de antes |
| T-2, T-3, T-4 | ✅ intactos |
| Carteira Cliente → Squad | ✅ **oficializada** (§3.6) e **idêntica**, nome a nome, à já usada em `entrada/relacao-squads-v2.json` |

---

## 3. O que ainda não está decidido

Depois da rodada 2, **nenhum item bloqueia o APPLY**. Sobra um item aberto,
não bloqueante, e o Grant cruzado (seção 5), que bloqueia só o enforcement.

### 3.1 ✅ Klayvert — resolvido: **#35**

Duas contas ativas, mesmo nome, a mesma pessoa. A decisão humana escolheu
**#35** (`klayvert.rodrigues@vendexcompany.com.br`) como identidade técnica do
P2.9, pelo motivo que a evidência já apontava:

| | #22 | **#35 ← escolhida** |
|---|---|---|
| email | `klayvert.rodrigues@vendexcompany.com` | `klayvert.rodrigues@vendexcompany.com.br` |
| role | `user` | `user` |
| ativo | sim | sim |
| criado em | 2026-04-08 (lote inicial do time) | 2026-05-05 (avulso, um mês depois) |
| `activity_logs` | **0** | **8** (2026-05-05 → 2026-07-06) |
| `relatorios` | 0 | 1 |
| `user_bases` | 55 | 41 |

O email confirmado resolve **exatamente 1** usuário ativo (#35), e as três
memberships de Coordenador (squads 2, 3 e 6) foram emitidas para ele, com
`principal: true` só em squad-2.

**A conta #22 não foi tocada** — não desativada, não deletada, sem migração de
dados. Ela não aparece em nenhum lugar do plano (verificado). Fica registrada
como **dívida de saneamento posterior**, fora do escopo deste APPLY.

> ⚠️ Consequência operacional a acompanhar depois do APPLY: se a pessoa logar
> pela conta #22, ela não terá Squad nenhum. Enquanto o enforcement estiver
> OFF isso é inócuo; quando ligar, vira carteira vazia. É o que torna o
> saneamento de #22 uma dívida real, e não cosmética.

### 3.2 ✅ Vinícius — resolvido: **#44 Vinicius Dias**

Aqui não eram duas contas de uma pessoa; eram **duas pessoas**:

| | #29 Vinicius **Bergo** | **#44 Vinicius Dias ← escolhido** |
|---|---|---|
| email | `vinicius.bergo@vendexcompany.com` | `vinicius.dias@vendexcompany.com` |
| role | `admin` | `membro` |
| criado em | 2026-04-08 | 2026-07-06 |
| `activity_logs` | 8 (até 2026-08-31) | 5 (até 2026-08-27) |

O assento `squad-2:auxiliar2` foi emitido para **#44**. A conta admin **#29 não
é usada nem alterada** e não aparece no plano (verificado).

### 3.3 🟡 MM — continua aberto, e continua não bloqueante

A carteira aprovada (§3.6) lista `MM` no Squad 3. O banco tem **`MM Importes`
(#54)** e **`MM Comercio` (#107)**, ambos ativos, cada um com conta e grant
próprios. Sem desempate, os dois permanecem no **Squad 8 · Legado** — o default
seguro.

Não bloqueia o APPLY: a invariante "todo Cliente ativo em exatamente 1 Squad"
continua satisfeita. O custo é que **o Squad 3 não recebe o cliente "MM" que o
humano aprovou** — fidelidade de carteira, reversível movendo o cliente depois,
não risco de dado.

---

## 4. Usuários não criados: de 3 para 4 — reconciliado

| nome | papel na estrutura | relatório antigo | decisão nova | resultado técnico |
|---|---|---|---|---|
| **Caique** | squad-2 · design | "sem conta" (bloqueante) | permanece previsto; criar depois | `EXCLUIDO_USUARIO_NAO_CRIADO` |
| **Yuri** | squad-4 · auxiliar2 | "sem conta" (bloqueante) | permanece previsto; criar depois | `EXCLUIDO_USUARIO_NAO_CRIADO` |
| **Carol** | squad-4 · design | "sem conta" (bloqueante) | permanece prevista; criar depois | `EXCLUIDO_USUARIO_NAO_CRIADO` |
| **Victor** | squad-6 · auxiliar | ⚠️ classificado como **ambíguo** (casava por aproximação com a conta admin #6 Vitor Capeli) | **não existe** — usuário ainda não criado | `EXCLUIDO_USUARIO_NAO_CRIADO` |

**A diferença 3 → 4 é exatamente Victor**, e ela é uma **melhora de segurança**:
o antigo relatório deixava aberta a hipótese de o Victor do Squad 6 ser a conta
`admin` #6. A decisão humana fecha essa porta. Nenhuma membership de Squad 6
aponta para conta administrativa.

Resultado, como pedido:

- **0 usuário criado**
- **0 identidade inventada**
- **4 memberships previstas e NÃO aplicáveis** até a conta existir
- **0 bloqueio** gerado por essas quatro — as demais 20 memberships seguem
  emitíveis, com exclusão explícita e fail-closed (provado por teste: `8e`).

A composição humana continua registrada no artefato: cada uma delas aparece em
`MAPA_P2_9_REAL.json → identidades[]` com `assentosPrevistos` preenchido.

---

## 5. ⛔ Grant cruzado **Fênix (#102) × Eliza.Market (#105)** — reauditoria

O documento novo (§9) declara que **não** havia caso concreto de Grant no
arquivo que ele recebeu — portanto **não** o resolveu. O caso foi reauditado
do zero, read-only, contra o snapshot atual.

### 5.1 A evidência crua

```
clientes
  #102  Fenix Equipamentos1  slug=fenix_equipamentos1  ativo  contas=1 (meli)
  #105  Eliza.Market         slug=elizamarket          ativo  contas=0

cliente_contas
  #40   cliente_id=102  meli  "Mercado Livre 1"  external_account_id=369291463  is_primary  ativa

ml_tokens (grants)
  #67   cliente_id=102  cliente_conta_id=40    ml_user_id=369291463   is_primary=true   valid
  #69   cliente_id=102  cliente_conta_id=NULL  ml_user_id=2661771367  is_primary=false  valid
  #70   cliente_id=105  cliente_conta_id=NULL  ml_user_id=2661771367  is_primary=true   valid
```

### 5.2 As respostas, uma a uma

| pergunta | resposta |
|---|---|
| **qual Grant?** | **#69** (o secundário, em Fenix) e **#70** (o primário, em Eliza.Market). Mesmo `ml_user_id` **2661771367** |
| **qual ClienteConta?** | **nenhuma.** Os dois grants têm `cliente_conta_id = NULL`. Não existe `cliente_contas` para 2661771367 em lugar nenhum do banco. A única conta de #102 é a #40, de outro seller (369291463) |
| **qual seller / ml_user_id?** | `2661771367`, sem `cliente_contas` correspondente; o seller legítimo de #102 é `369291463` |
| **por que aparece nos dois?** | assinatura de **grant cruzado**: o OAuth do Mercado Livre foi concluído de dentro do cliente errado. O sistema registrou a pendência sozinho — `cliente_contas_pendencias` tem 4 linhas abertas do tipo `ml_user_id_duplicado_entre_clientes`, e são exatamente os 4 pares de `ml_user_id` repetido do banco (8682183 Mercadao, 3310587126 Luli, 3589758095 wm, **2661771367 Fenix×Eliza**). Os outros três são a mesma empresa duplicada; este é o único em que os nomes não têm parentesco |
| **qual é primário / secundário?** | **primário em #105** (Eliza.Market) · **secundário em #102** (Fenix). O lado primário é o coerente: Eliza.Market não tem nenhuma outra conta, então 2661771367 é plausivelmente o seller dela. O secundário em Fenix é o excedente |
| **impacto do APPLY** | **nenhum.** O plano P2.9 não emite operação alguma sobre `ml_tokens`. #102 e #105 são ambos **canônicos** — o par está marcado `NAO_MERGEAR` / `GRANT_CRUZADO_DEFEITO` justamente para não virar cluster. A invariante **I1** confirma: 13 grants de alias no banco, 13 endereçados no plano, sobre um total de 63 — nenhum some, nenhum se move. Fundir seria pior que não fundir |
| **impacto do ENFORCEMENT** | **real.** Grants são lidos por `cliente_id` (`listGrantsByCliente(clienteId)`, `resolveMlGrant({clienteId, mlUserId})` em `server/services/mlTokenService.js`). Com o mapa aprovado, **#102 fica no Squad 6** e **#105 no Squad 8 · Legado**. Ligar o enforcement dá ao Squad 6 um caminho vivo (`token_status=valid`) até a conta ML da Eliza.Market, que pertence ao Squad 8. A exposição *absoluta* diminui (hoje, com enforcement OFF, todo interno alcança #102) — mas a **promessa do enforcement**, "um Squad só alcança as contas dos seus Clientes", passa a ser **falsa** no dia em que ele ligar. É esse o problema |

### 5.3 Classificação

| | |
|---|---|
| **BLOQUEIA APPLY?** | **NÃO** — o APPLY não toca em Grant nenhum, e o defeito já existe hoje |
| **BLOQUEIA ENFORCEMENT?** | **SIM** — enquanto o grant #69 existir, o Squad 6 alcança conta de cliente do Squad 8 |

### 5.4 A decisão humana: **não mexer**

Perguntado se o grant secundário #69 deveria ser desconectado, o humano
respondeu: **na dúvida operacional, não mexer.**

- grant **#69** (secundário, em Fenix #102) → **fica como está**
- grant **#70** (primário, em Eliza.Market #105) → **fica como está**
- não desconectar · não mover · não alterar

A classificação acima é **preservada integralmente**. Isso é uma decisão
consciente de aceitar o item como **bloqueador de enforcement**, não de
descartá-lo: o APPLY segue liberado, e ligar o enforcement continua
condicionado a resolver o cruzamento.

Verificado depois do dry-run final: os dois grants estão exatamente onde
estavam.

```
grant cruzado ANTES : #69 cliente102 primary=false | #70 cliente105 primary=true
grant cruzado DEPOIS: #69 cliente102 primary=false | #70 cliente105 primary=true
```

Nada foi movido, removido ou reapontado.

---

## 6. MM · JFX · cluster `wm` — reconciliados

Reconferidos na rodada 2: o comportamento seguro **continua válido** para os três. Nenhum passou
a violar "todo Cliente canônico termina em exatamente 1 Squad" e nenhum cria
risco de Grant ou de Conta. Nenhum sobe para bloqueador.

| item | estado | por quê continua seguro |
|---|---|---|
| **MM** | 🟡 aberto, **não bloqueante** · #54 e #107 **os dois no Squad 8** | cada um em exatamente 1 Squad (I6 verde). Squad 8 é quarentena reversível; pôr o errado no Squad 3 seria acesso indevido. Custo: o Squad 3 fica sem o "MM" da carteira aprovada — **fidelidade**, não integridade |
| **JFX** | 🟡 aberto, **não bloqueante** · #75 no Squad 8 | não aparece na relação; a regra "fora da relação → Squad 8" é a I8, verde. Conta e grant próprios preservados, intactos |
| **cluster `wm`** | 🟡 aberto, **sem efeito prático** · canônico #123 `wm.modas`, alias #116 `William Modas` | **ambos terminam no Squad 4**, então a escolha do canônico não muda carteira nenhuma. A consolidação é `PLAN_ONLY` e reversível. O cluster tem prova forte: mesmo `ml_user_id` 3589758095 nos dois — é uma das 4 pendências que o próprio sistema já registrou |

---

## 7. Identidades finais — 24 identidades, 24 memberships

`Fernando` conta como **duas** identidades: a relação tem 23 nomes distintos,
mas 24 pessoas. **Nenhuma identidade ficou ambígua.**

| nome na planilha | classe | user.id | email confirmado | Squads | principal |
|---|---|---|---|---|---|
| Adrian | MATCH_EXATO | **#9** | adrian.neves@ | squad-2 | squad-2 |
| Anderson | MATCH_EXATO | **#11** | anderson.santos@ | squad-4 | squad-4 |
| **Caique** | EXCLUIDO_USUARIO_NAO_CRIADO | — | — | squad-2 (previsto) | — |
| **Carol** | EXCLUIDO_USUARIO_NAO_CRIADO | — | — | squad-4 (previsto) | — |
| **Cavazzoto** | **DECISAO_HUMANA_EMAIL** | **#47** | gabrielly.cavazotto@ | squad-3 | squad-3 |
| Diogo | MATCH_EXATO | **#32** | diogo-pinheiro2001@hotmail.com | squad-3 | squad-3 |
| Eliabe | MATCH_EXATO | **#13** | eliabe.almeida@ | squad-1 | squad-1 |
| Felipe | MATCH_EXATO | **#37** | felipe.pitta@ | squad-5 | squad-5 |
| **Fernando (Montoro)** | **DECISAO_HUMANA_EMAIL** | **#45** | fernando.montoro@ | squad-1 · auxiliar2 | squad-1 |
| **Fernando (Salgado)** | **DECISAO_HUMANA_EMAIL** | **#5** `admin` | fernando.salgado@ | squad-4 · coordenador | squad-4 |
| **Gabrielly** | **DECISAO_HUMANA_EMAIL** | **#16** | gabrielly.ribeiro@ | squad-1 | squad-1 |
| Giovanna | MATCH_EXATO | **#17** | giovanna.santos@ | squad-4 | squad-4 |
| Gustavo | MATCH_EXATO | **#46** | gustavo.nakamura@ | squad-1 | squad-1 |
| Juliana | MATCH_EXATO | **#21** | juliana.discher@ | squad-2 | squad-2 |
| **Klayvert** | **DECISAO_HUMANA_EMAIL** | **#35** | klayvert.rodrigues@vendexcompany.**com.br** | squads 2·3·6 | **squad-2** ✔ |
| Matheus | MATCH_EXATO | **#23** | matheus.leopoldo@ | squad-6 | squad-6 |
| Mayara | MATCH_EXATO | **#38** | mayara.cerbi@ | squad-3 | squad-3 |
| **Micael** | MATCH_EXATO | **#24** | micael.almeida@ | squads 1·5 | **squad-1** ✔ |
| **Sophia** | MATCH_EXATO | **#28** | sophia.costa@ | squads 5·6 | **squad-5** ✔ |
| Thiago | MATCH_EXATO | **#48** | thiago.zanini@ | squad-3 | squad-3 |
| **Victor** | EXCLUIDO_USUARIO_NAO_CRIADO | — | — | squad-6 (previsto) | — |
| **Vinícius** | **DECISAO_HUMANA_EMAIL** | **#44** Dias | vinicius.dias@ | squad-2 | squad-2 |
| Witor | MATCH_EXATO | **#31** | witor.silva@ | squad-5 | squad-5 |
| **Yuri** | EXCLUIDO_USUARIO_NAO_CRIADO | — | — | squad-4 (previsto) | — |

Domínio omitido por brevidade: todos `@vendexcompany.com`, exceto Diogo
(hotmail) e Klayvert (`.com.br`).

**Contas deliberadamente fora do plano**, verificado no artefato: **#22**
(Klayvert `.com`), **#29** (Vinicius Bergo, admin) e **#6** (Vitor Capeli,
admin). Nenhuma delas aparece em nenhuma membership.

**Fernando Salgado mantém `role = admin`.** O plano só emite `squad_members`;
nenhuma operação toca `users`. A função operacional (Coordenador do Squad 4)
não reduz o admin, conforme §3.3.

**Exatamente 1 principal por usuário**, verificado: 0 usuários com número de
principais diferente de 1, e 0 memberships com `_principalPendente`.

### Composição por Squad, ao fim

| Squad | assentos na planilha | memberships emitidas | faltando | por quê |
|---|---|---|---|---|
| squad-1 | 5 | **5** | — | completo |
| squad-2 | 5 | **4** | 1 | Caique (sem conta) |
| squad-3 | 5 | **5** | — | completo |
| squad-4 | 5 | **3** | 2 | Yuri e Carol (sem conta) |
| squad-5 | 4 | **4** | — | completo (auxiliar2 ausente na estrutura, por decisão §5.1) |
| squad-6 | 4 | **3** | 1 | Victor (sem conta) |
| **total** | **28** | **24** | **4** | **todas** as ausências são as 4 pessoas sem conta — **0 bloqueio de identidade** |

Os seis Squads têm Coordenador. Nenhum assento ficou vago por ambiguidade.

---

## 8. Carteira Cliente → Squad — conferida linha a linha

A carteira de §3.6 foi comparada nome a nome com a que já estava em
`entrada/relacao-squads-v2.json`: **52 nomes, idênticos, na mesma ordem, nos
mesmos Squads.** A decisão humana **confirma** o que já estava em uso; nada
mudou no mapa de clientes.

| Squad | clientes reais | |
|---|---|---|
| squad-1 | 11 | Loja da Isa, DM, WBS Medical (+`wbs 2`), Carpei, Extra, Mercadao enxovais (+`… 2`), JF Shopp, Tenda Medieval, Power Game |
| squad-2 | 10 | MWM, Calhas Kairos, Cegil, Up Vendas, ADB Supply, Empório Luz, BrasilTek, tevix.comercio, in.matec, jw presentes |
| squad-3 | 7 | Brilha Kids, Infinite Solucoes, Rios Shop, zorza.loja (+`zorza_shopee`), Beleza Chic, PlisPack Embalagens |
| squad-4 | 18 | Influencia Jeans (+1), Dua Cosmeticos (+1), Comprou Enviou Chegou, Kirius, Maya (+4), Exclusiva Jeans, a_venda, shopping_86, Paula e Anselmo, Zenite, wm.modas (+`William Modas`) |
| squad-5 | 6 | Alma (+`Alma 2`), Castro Company, er2, Giro Max, Rikam Loja |
| squad-6 | 5 | LPS Fitness, Fenix Equipamentos1, Red Fish, Toque ouro, Fitassul Comercio |
| **squad-8-legado** | **26** | Maximus, Deluche, Vent soluções, Maria Eduarda, Pro Fit, J Meira (+2), Pedro Baby, ENVM, Macedo, **MM Importes**, Mais Estilo, Luli (+1), Trevo, **JFX**, Shalom, Cliente Demo Shopee, **Eliza.Market**, Teste_x01, **MM Comercio**, Teste 01, cafe, teste1, teste2 |
| **soma** | **83** | = todos os clientes reais ativos |

Seis nomes da carteira aprovada **não** encontram cliente no banco e, por
decisão (`não criar Cliente novo`), continuam sem existir: **GS**, **ADS**,
**MW**, **Nikolly Fashion**, **Thiago Moreno** (nenhum cliente correspondente)
e **MM** (ambíguo entre dois). Nada foi criado para "completar" a estrutura.

---

## 9. O que mudou no tooling

Fonte → tooling → artefato. Nenhum JSON foi editado à mão.

**Nova fonte:** `entrada/decisoes-humanas-aprovadas.json` — transcrição literal
das decisões humanas (identidades por email, usuários não criados, Squad
principal). Ela carrega os dois lados: `_decididoNaRodada2` registra as três
respostas objetivas que fecharam o pré-apply, e `_naoDecididoPeloDocumento`
mantém o que segue indecidido (hoje, só o `MM`).

**A rodada 2 não mexeu em uma linha de tooling.** As três decisões entraram
como *dados* na fonte canônica; o código que as consome já existia e já estava
testado. Fonte → tooling → artefato, sem exceção.

**Novo flag:** `squads-mapeamento-real.js --decisoes <arquivo>`.

**Novas regras, todas escritas em teste antes do código** (`8` a `8l`):

| regra | o que impede |
|---|---|
| identidade por **igualdade exata** de email confirmado contra usuário **ativo** | fuzzy-match por primeiro nome |
| email que não resolve **exatamente 1** ativo → `DECISAO_EMAIL_NAO_RESOLVE` + bloqueio | adivinhar pessoa; ressuscitar conta inativa |
| **assento** (Squad × papel) como unidade, não nome | dois homônimos virarem um multi-Squad falso |
| `usuariosNaoCriados` → exclusão explícita, **sem** bloquear as demais | fabricar usuário; travar o rollout inteiro por 4 contas ausentes |
| `squadPrincipal` só vale se o Squad for um dos que a pessoa ocupa | principal inventado |
| decisão que não encontra assento → `DECISAO_SEM_ASSENTO` | decisão sumir em silêncio por um typo |
| usuário reivindicado por decisão sai do pool do matcher | dois nomes reivindicarem o mesmo usuário |
| o plano carrega `_emitivel` e `_bloqueios` **dentro** do arquivo | um plano bloqueado circular sem dizer que está bloqueado |

**Sem decisões, o comportamento é bit a bit o anterior** — testado (`8i`).
O módulo continua 100% offline: não importa `pg`, não lê `DATABASE_URL`, não
emite SQL de escrita (teste `7d`, intacto).

---

## 10. Invariantes — 13/13 verdes

| id | invariante | resultado |
|---|---|---|
| I1 | nenhum Grant some | ✅ alias no banco 13 · endereçados 13 · total 63 |
| I2 | nenhum Grant troca de seller/conta | ✅ 0 |
| I3 | nenhuma ClienteConta muda de marketplace | ✅ 0 |
| I4 | nenhuma ClienteConta duplicada é criada | ✅ 3 marcadas `DEDUPLICAR_CONTA` |
| I5 | nenhum Cliente novo é criado | ✅ |
| I6 | todo Cliente ativo em **exatamente 1** Squad | ✅ sem squad 0 · com 2+ 0 · conflitos 0 |
| I7 | Cliente da relação → Squad 1–6 | ✅ 0 caiu no Squad 8 |
| I8 | Cliente fora da relação → Squad 8 | ✅ 0 escapou |
| I9 | alias não ganha Squad próprio | ✅ 0 |
| I14 | nenhum cliente inexistente entra no plano | ✅ 0 |
| I15 | exatamente 6 operacionais + 1 legado | ✅ squad-1..6 + squad-8-legado |
| I16 | nenhum Squad 7 ou 9 acidental | ✅ |
| I17 | todo id do mapa existe no banco | ✅ 83 conferidas |

Invariantes adicionais desta fase, verificadas nos artefatos:

- **Fernando Montoro ≠ Fernando Salgado** — #45 e #5, memberships em Squads
  distintos, nenhum marcado multi-Squad ✔
- **Sophia** multi-Squad, principal **squad-5** ✔
- **Klayvert** = **#35**, multi-Squad (2·3·6), principal **squad-2** ✔ · a conta
  **#22 fora do plano**, não desativada, não deletada, sem migração ✔
- **Micael** multi-Squad, principal **squad-1** ✔
- **Vinícius** = **#44 Dias** · a conta admin **#29 fora do plano e intocada** ✔
- **Grants #69 e #70 preservados**, byte a byte, antes e depois do dry-run ✔
- **4 usuários inexistentes sem membership técnica** ✔
- **admin Fernando Salgado mantém `role=admin`** — nada no plano toca `users` ✔
- **`SQUADS_ENFORCEMENT` continua OFF** — default fail-safe, e o rollout gate
  bloquearia de qualquer forma enquanto a auditoria de migração reprovar ✔

---

## 11. Índice desta fase

| # | arquivo |
|---|---|
| 16 | `16_DECISOES_FINAIS_HUMANAS.md` — histórico, preservado |
| **17** | **este documento** — reconciliação |
| 18 | `18_DRY_RUN_FINAL_PRE_APPLY.md` — o dry-run final, zero-write |
| 19 | `19_GO_NO_GO_FINAL_PRE_APPLY.md` — os dois vereditos |

Artefatos de máquina regerados em `artefatos/`:
`plano-p2-9.json`, `MAPA_P2_9_REAL.json`, `CLIENT_CONSOLIDATION_PLAN.json`.
Fontes em `entrada/`: `relacao-squads-v2.json` e
`decisoes-humanas-aprovadas.json`.
