# VenForce V3 — P2.9 Decisões Finais Aprovadas

## 1. Fonte

Arquivo canônico referido no briefing:

`16_DECISOES_FINAIS_HUMANAS.md`

Arquivo efetivamente anexado e analisado nesta conversa:

`16_DECISOES_HUMANAS_PENDENTES.md`

Relação operacional complementar confirmada pelo humano durante a facilitação:

`Squads (1).xlsx`

Este documento registra somente as decisões humanas finais tomadas nesta conversa. Ele não substitui auditorias, tooling, dry-run, plano técnico ou validações do banco.

## 2. Estado

**DECISÕES HUMANAS: RESOLVIDAS**

As 5 classes de decisão abertas no arquivo recebido foram resolvidas:

1. rótulo do sexto bloco;
2. composição/Design do sexto bloco;
3. principal dos usuários realmente multi-Squad;
4. identidade técnica dos usuários existentes e regra para usuários ainda não criados;
5. Cliente → Squad, isto é, a carteira oficial.

Também foram corrigidas duas ambiguidades da relação original por decisão humana:

- os dois registros chamados **Fernando** são pessoas diferentes;
- **Gabrielly** e **Cavazzoto** são pessoas diferentes.

## 3. Decisões que bloqueavam APPLY

### 3.1 Sexto bloco operacional

- **Decisão original:** confirmar se o último bloco duplicado como “Squad 5” era, na verdade, o Squad 6.
- **Escolha final:** **SIM. O último bloco é o Squad 6.**
- **Valor escolhido:** `Squad 6` / `squad-6`.
- **Justificativa curta:** o segundo “Squad 5” foi erro de digitação na relação.
- **Impacto esperado:** libera a existência do sexto Squad operacional e suas memberships reais.

Estrutura final conhecida do Squad 6:

- Coordenador: **Klayvert**
- Gestor: **Matheus**
- Auxiliar: **Victor** — usuário ainda não criado
- Auxiliar 2: **ausente por enquanto**
- Design: **Sophia**

Não existe regra de quantidade fixa de integrantes. Uma função pode ficar sem ocupante temporariamente; a estrutura precisa apenas suportar que ela seja preenchida depois.

---

### 3.2 Squad principal x Squad ativo

- **Decisão original:** definir exatamente 1 principal para cada pessoa multi-Squad.
- **Escolha final:** manter **1 Squad principal persistido**, separado do **Squad ativo da sessão**.
- **Justificativa curta:** evita transformar uma preferência/default em autorização e evita alterar dado persistente toda vez que um Coordenador muda de carteira durante o dia.
- **Impacto esperado:** atende a estrutura do P2.9 sem limitar o trabalho multi-Squad.

Regra canônica aprovada:

```text
ROLE
  ↓
SQUADS QUE O USUÁRIO PODE ACESSAR
  ↓
SQUAD PRINCIPAL
  ↓
SQUAD ATIVO DA SESSÃO
  ↓
CARTEIRA DESSE SQUAD
  ↓
CLIENTE
  ↓
CLIENTE_CONTA
  ↓
MÓDULOS
```

Regras:

- `Squad principal` = preferência/default persistido.
- `Squad ativo` = escopo temporário de trabalho da sessão.
- Squad ativo **não é autorização**.
- Trocar Squad ativo **não altera** Squad principal.
- O Squad ativo deve ser descartado no próximo login.
- Memberships reais definem quais Squads o usuário pode acessar.
- Backend continua sendo a autoridade de autorização.
- Coordenadores multi-Squad podem escolher/alterar sua preferência de principal posteriormente.
- Para permitir o P2.9 sem deixar principal nulo, a migração recebe um principal inicial válido pertencente ao usuário.
- Usuários com apenas 1 Squad têm esse Squad como principal de forma determinística.

Principais finais aprovados:

| USUÁRIO | SQUADS | SQUAD PRINCIPAL INICIAL |
|---|---|---|
| Klayvert | 2, 3, 6 | **Squad 2** |
| Micael | 1, 5 | **Squad 1** |
| Sophia | 5, 6 | **Squad 5** |

---

### 3.3 Fernando não é um usuário multi-Squad

- **Decisão original:** a relação antiga agrupava “Fernando” como se fosse uma única pessoa nos Squads 1 e 4.
- **Escolha final:** são **duas pessoas diferentes**.
- **Valor/identidade escolhida:** ver tabela de identidades em §7.
- **Justificativa curta:** a relação final possui identidades de login distintas.
- **Impacto esperado:** remove um falso multi-Squad e impede associação de membership à pessoa errada.

O Fernando Coordenador do Squad 4 possui **role global `admin`** e deve manter acesso administrativo total. Sua função operacional no Squad não reduz os poderes da role `admin`.

O Fernando Auxiliar 2 do Squad 1 é outra pessoa.

---

### 3.4 Identidade técnica das pessoas existentes

- **Decisão original:** nomes puros não poderiam seguir para o plano final; era necessário email ou id.
- **Escolha final:** os emails confirmados na relação são as identidades humanas confiáveis de login e serão usados para resolver o usuário técnico correto.
- **Valor escolhido:** para o APPLY, **preferir o `user.id` real do banco quando disponível**, resolvido pelo email confirmado; manter o email no plano/handoff como referência humana e verificação.
- **Justificativa curta:** `user.id` é a melhor referência interna para vínculos; o email confirmado é a chave humana já cadastrada e usada no login.
- **Impacto esperado:** evita fuzzy-match por nome e evita vincular membership à pessoa errada.

Regra de identidade:

1. nunca fazer fuzzy-match por nome;
2. resolver o usuário existente pelo email confirmado;
3. usar o `user.id` real como referência técnica quando o banco o disponibilizar;
4. manter o email como evidência/auditoria;
5. não inventar ID nem email para usuário inexistente.

---

### 3.5 Usuários ainda não criados

- **Decisão original:** alguns nomes da estrutura não possuem usuário técnico ainda.
- **Escolha final:** eles **continuam fazendo parte da estrutura oficial do Squad**, porém **nenhuma membership técnica é criada até existir uma identidade real**.
- **Justificativa curta:** preservar a composição planejada sem fabricar usuário.
- **Impacto esperado:** o rollout pode preparar/aplicar o restante de forma segura, deixando apenas essas memberships para uma etapa posterior à criação das contas.

Usuários ainda não criados:

- **Caique** — Design — Squad 2
- **Yuri** — Auxiliar 2 — Squad 4
- **Carol** — Design — Squad 4
- **Victor** — Auxiliar — Squad 6

Para os quatro:

- **deve ser criado depois?** SIM.
- **deve ficar fora desta aplicação enquanto não existir?** SIM, apenas quanto à membership técnica correspondente.
- **impacto:** não inventar identidade e não bloquear as demais memberships válidas, desde que o tooling do APPLY trate ausência explicitamente e de forma fail-closed.

---

### 3.6 Cliente → Squad — carteira oficial

- **Decisão original:** o arquivo de memberships não continha a carteira Cliente → Squad.
- **Escolha final:** a relação `CLIENTES` da planilha confirmada pelo humano é a **carteira oficial do P2.9**.
- **Justificativa curta:** nenhuma relação deve ser inferida por gestor histórico, Grant, Base, marketplace, atividade ou nome.
- **Impacto esperado:** todo Cliente existente da relação passa a ter um único Squad operacional definido.

Carteira aprovada:

#### Squad 1

- Carpei
- Power Game
- DM Comércio
- Extra
- JF
- WBS
- Loja da Isa
- Mercadao
- Tenda

#### Squad 2

- ADB Supply
- BrasilTek
- J&W Presentes
- GS
- Calhas
- Cegil
- Eletro in Matec
- Empório Luz
- MWM
- Tevix
- Up Vendas

#### Squad 3

- ADS
- Beleza Chic
- Brilha Kids
- Infinite
- MW
- MM
- Plispack
- Rios Shop
- Zorza

#### Squad 4

- AVENDA
- Comprou Enviou
- Dua cosmeticos
- Exclusiva Jeans
- Influencia Jeans
- Kirus
- Maya
- Nikolly Fashion
- Paula e Anselmo
- Shopping 86
- WM
- Zenite

#### Squad 5

- Alma
- Castro Company
- ER2
- Giromax
- Rikam
- Thiago Moreno

#### Squad 6

- Fênix
- Fitassul Comércio
- LPS Fitness
- Red Fish
- Toque de Ouro

Regras de preservação para transformar essa decisão em plano técnico:

- não criar Cliente novo;
- resolver cada nome da relação para o Cliente real existente por slug/id antes do write;
- um Cliente não pode terminar em dois Squads ativos;
- não mover `ClienteConta` para marketplace/seller errado;
- não perder Grant;
- não perder Base;
- não perder histórico.

## 4. Decisões que bloqueavam ENFORCEMENT

**Nenhuma das 5 decisões humanas do arquivo recebido era classificada como “somente enforcement”.**

Entretanto, durante a facilitação foi aprovada uma regra de produto que deve ser preservada na fase de enforcement:

> **Squad principal e Squad ativo não são autorização.**

A autorização deve continuar sendo determinada pelo backend a partir da role e dos vínculos reais permitidos. O Squad ativo é apenas o recorte de carteira em que o usuário decidiu trabalhar naquela sessão.

Admin mantém acesso total conforme a política administrativa existente/aprovada.

## 5. Confirmações não bloqueantes

### 5.1 Quantidade de integrantes por Squad

- **Decisão:** não existe número obrigatório de integrantes por função.
- **Escolha final:** funções podem ficar temporariamente sem ocupante.
- **Impacto:** ausência de Auxiliar 2 no Squad 5 ou Squad 6, por exemplo, não é erro estrutural por si só.

### 5.2 Design do Squad 6

A decisão inicial de “sem Design por enquanto” foi **substituída** pela relação final confirmada:

- **Sophia é Design do Squad 6 e também do Squad 5.**
- Principal de Sophia: **Squad 5**.

Esta é a decisão canônica atual; a resposta anterior fica revogada.

## 6. Usuários multi-Squad

| USUÁRIO | SQUADS | SQUAD PRINCIPAL DEFINIDO |
|---|---|---|
| Klayvert | Squad 2 · Squad 3 · Squad 6 | **Squad 2** |
| Micael | Squad 1 · Squad 5 | **Squad 1** |
| Sophia | Squad 5 · Squad 6 | **Squad 5** |

Observações:

- Os dois registros de Fernando são pessoas diferentes e, portanto, não formam um usuário multi-Squad.
- Coordenador multi-Squad pode alterar sua preferência de principal depois; isso não altera os Squads a que tem acesso.
- Sophia é multi-Squad, mas não entra na regra de escolha livre reservada aos Coordenadores; seu principal foi definido humanamente como Squad 5.

## 7. Identidades ambíguas

| NOME OPERACIONAL | IDENTIDADE DEFINITIVA | ID/EMAIL SE DISPONÍVEL | DECISÃO |
|---|---|---|---|
| Fernando — Squad 1 — Auxiliar 2 | Fernando Montoro | `fernando.montoro@vendexcompany.com` | Pessoa distinta do Fernando do Squad 4 |
| Fernando — Squad 4 — Coordenador | Fernando Salgado | `fernando.salgado@vendexcompany.com` | Pessoa distinta; role global `admin` |
| Gabrielly — Squad 1 — Design | Gabrielly Ribeiro | `gabrielly.ribeiro@vendexcompany.com` | Pessoa distinta de Cavazzoto |
| Cavazzoto — Squad 3 — Design | Cavazzoto / Gabrielly Cavazzoto | `gabrielly.cavazotto@vendexcompany.com` | Pessoa distinta de Gabrielly do Squad 1 |

Regra: o APPLY deve resolver o `user.id` real a partir do email confirmado e nunca pelo primeiro nome.

## 8. Usuários inexistentes

### Caique

- **nome:** Caique
- **decisão tomada:** permanece previsto como Design do Squad 2.
- **deve ser criado depois?** SIM.
- **deve ficar fora desta aplicação?** SIM, somente a membership técnica, até a conta existir.
- **impacto:** nenhum email/id deve ser inventado.

### Yuri

- **nome:** Yuri
- **decisão tomada:** permanece previsto como Auxiliar 2 do Squad 4.
- **deve ser criado depois?** SIM.
- **deve ficar fora desta aplicação?** SIM, somente a membership técnica, até a conta existir.
- **impacto:** nenhum email/id deve ser inventado.

### Carol

- **nome:** Carol
- **decisão tomada:** permanece prevista como Design do Squad 4.
- **deve ser criado depois?** SIM.
- **deve ficar fora desta aplicação?** SIM, somente a membership técnica, até a conta existir.
- **impacto:** nenhum email/id deve ser inventado.

### Victor

- **nome:** Victor
- **decisão tomada:** permanece previsto como Auxiliar do Squad 6.
- **deve ser criado depois?** SIM.
- **deve ficar fora desta aplicação?** SIM, somente a membership técnica, até a conta existir.
- **impacto:** nenhum email/id deve ser inventado.

## 9. Grants ambíguos/cruzados

O arquivo de decisões humanas recebido nesta conversa **não lista um caso concreto de Grant ambíguo/cruzado entre as 5 decisões abertas**.

Portanto:

- **estado atual:** nenhum caso específico pode ser decidido a partir deste arquivo;
- **decisão:** não inventar movimentação nem reconciliação de Grant neste handoff;
- **regra de preservação:** nenhum Grant pode ser perdido, sobrescrito ou movido para Cliente/ClienteConta por inferência;
- **bloqueio:** não existe decisão humana de Grant pendente neste documento. Qualquer caso concreto vindo de outra auditoria precisa carregar sua própria evidência antes de write.

Nunca incluir token/segredo em plano ou handoff.

## 10. Squad 8 · Legado

Decisão de produto já estabelecida e mantida:

### Finalidade

`Squad 8 · Legado` recebe **Clientes reais já existentes** que não pertencem aos Squads operacionais 1–6.

### Natureza

- não é um sétimo Squad operacional;
- não renumerar para Squad 7;
- topologia de produto: **6 Squads operacionais + Squad 8 Legado**.

### Acesso

- não criar autorização especial por inferência;
- backend continua autoridade;
- role `admin` mantém acesso administrativo total;
- qualquer acesso não-admin deve respeitar memberships/permissões reais definidas pela camada de autorização.

### Responsabilidades

- `responsibility` continua sendo por Cliente e **não é autorização**;
- não assumir que todo membro do Squad 8 é automaticamente responsável por todo Cliente nele;
- não fabricar `cliente_responsaveis` sem relação explícita.

### Comportamento esperado

- funcionar como destino legado/fallback para Cliente real que não pertence às carteiras operacionais 1–6;
- preservar Cliente, ClienteConta, Grant, Base e histórico;
- não criar Cliente novo para “completar” a estrutura;
- não mover conta para marketplace/seller errado.

## 11. Pendências restantes

**NENHUMA DECISÃO HUMANA BLOQUEANTE.**

Restam apenas verificações/execuções técnicas para a missão seguinte, entre elas:

1. resolver `user.id` real dos usuários existentes a partir dos emails confirmados;
2. resolver os Clientes da carteira para os slugs/ids reais existentes;
3. excluir do write de memberships os quatro usuários ainda não criados, de forma explícita e fail-closed;
4. revalidar no tooling que nenhum Cliente ficou duplicado ou sem destino fora da regra do Squad 8;
5. revalidar hardening/gates técnicos apontados pelas auditorias antes do APPLY real.

Esses itens **não reabrem as decisões humanas acima**.

## 12. Autorização para próxima fase

# PRONTO PARA PREPARAR APPLY REAL

Motivo:

- o rótulo do Squad 6 foi confirmado;
- a composição real do Squad 6 foi esclarecida;
- os multi-Squad reais foram identificados e possuem principal definido;
- os falsos matches de Fernando foram corrigidos;
- Gabrielly e Cavazzoto foram desambiguadas;
- os emails existentes foram confirmados como identidades de login válidas;
- os usuários ainda não criados possuem uma regra explícita, sem fabricação de identidade;
- a carteira Cliente → Squad foi aprovada como oficial;
- nenhuma decisão humana bloqueante permanece.

Esta autorização significa **preparar a missão técnica de APPLY**. Não significa executar APPLY automaticamente, não autoriza SQL destrutivo e não substitui dry-run, preflight, revisão humana final do plano ou mecanismos de rollback.
