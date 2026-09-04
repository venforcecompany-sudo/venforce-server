# 15 — MEMBERSHIPS RECEBIDAS (relação real dos 6 Squads)

> **Fonte:** relação humana entregue pela operação, transcrita em
> `entrada/relacao-squads-operacao-v1.txt`.
> **Gerado por:** `node server/sql/squads-preflight-relacao.js --relacao <arq> --memberships`
> **Estado:** `SQUADS_ENFORCEMENT` = **OFF** · migração **NÃO EXECUTADA** ·
> banco **NÃO ALTERADO** · nenhuma conexão de banco aberta.

---

## 1. O que mudou: a estrutura real não era a que o tooling assumia

O tooling V1 modelava **Squad → Gestor → membros** e convertia o Gestor em
`squad_members.funcao = "coordenador"`.

A estrutura **real** da empresa é mais rica:

```
Squad → Coordenador
      → Gestor
      → Auxiliar
      → Auxiliar 2 (quando houver)
      → Design
```

**Coordenador e Gestor são pessoas e funções distintas.** O pressuposto V1 era
uma incompatibilidade semântica e foi corrigido nesta fase: o Gestor **nunca**
vira `coordenador`. Um cinto anti-regressão (`GESTOR_MAPEADO_COMO_COORDENADOR`)
transforma qualquer volta atrás em `ERRO_ESTRUTURAL` na validação, não no banco.

---

## 2. As duas dimensões, e por que continuam separadas

| Dimensão | Onde vive | Enum | Significa |
|---|---|---|---|
| **Squad membership** | `squad_members.funcao` | `membro` \| `coordenador` | acesso / participação no Squad |
| **Client responsibility** | `cliente_responsaveis.papel` | `gestor` \| `auxiliar` \| `designer` | responsabilidade **POR CLIENTE** |

Mapeamento aplicado — tabela `FUNCOES_OPERACIONAIS` em
`server/sql/squads-preflight-relacao.js`:

| Cargo recebido | `squad_members.funcao` | papel preservado p/ `cliente_responsaveis` |
|---|---|---|
| Coordenador | `coordenador` | — (o cargo *é* a membership) |
| Gestor | `membro` | `gestor` |
| Auxiliar | `membro` | `auxiliar` |
| Auxiliar 2 | `membro` | `auxiliar` |
| Design | `membro` | `designer` |

**Nenhum enum novo foi criado em `squad_members`.** Não existe `funcao = gestor`,
nem `auxiliar`, nem `designer` — isso exigiria decisão arquitetural explícita e
apagaria a separação acima. O CHECK do banco continua `('membro','coordenador')`
(ver `05_ESTADO_SCHEMA_SQUADS.md`).

**Nenhum `cliente_responsaveis` foi criado.** Responsabilidade é *por Cliente*, e
Cliente→Squad ainda não chegou. Assumir que todo membro de um Squad responde por
todo Cliente do Squad seria inventar carteira. A função organizacional de cada
pessoa fica preservada na relação (coluna FUNÇÃO OPERACIONAL, §4), pronta para
virar `responsaveis[]` quando a carteira chegar.

---

## 3. Composição recebida, por Squad

| Squad | Coordenador | Gestor | Auxiliar | Auxiliar 2 | Design |
|---|---|---|---|---|---|
| Squad 1 | Micael | Eliabe | Gustavo | Fernando | Gabrielly |
| Squad 2 | Klayvert | Adrian | Juliana | Vinícius | Caique |
| Squad 3 | Klayvert | Diogo | Mayara | Thiago | Cavazzoto |
| Squad 4 | Fernando | Anderson | Giovanna | Yuri | Carol |
| Squad 5 | Micael | Witor | Felipe | *AUSENTE_NA_ESTRUTURA* | Sophia |
| **6º bloco** — rótulo não confirmado | Klayvert | Matheus | Victor | *AUSENTE_NA_ESTRUTURA* | *PENDENTE_CONFIRMACAO* |

### O 6º bloco

Na planilha ele também está escrito **"squad 5"** — o mesmo rótulo do bloco
anterior. Pelo requisito de produto existem exatamente 6 Squads, então é muito
provável que este seja o **Squad 6**.

Essa probabilidade **não é dado**. O bloco está classificado como
`SQUAD_6_PENDENTE_CONFIRMACAO_DO_ROTULO`, a hipótese "Squad 6" fica em
`NOME_HIPOTESE`, e o pré-validador **se recusa** a convertê-la em linha de plano:
`slugDoSquad()` devolve vazio enquanto `ROTULO_STATUS` não for exatamente
`CONFIRMADO` (fail-closed), então o Squad e as memberships dele ficam fora do
plano. Nada é persistido a partir de suposição.

O rótulo repetido é detectado sozinho, como pendência e não como duplicata:
`SQUAD_ROTULO_DUPLICADO_NA_PLANILHA` — os membros dos dois blocos são diferentes,
logo é um Squad a mais com rótulo errado, não a mesma linha duas vezes.

### Ausências: `AUSENTE_NA_ESTRUTURA` ≠ dado faltando

`AUSENTE_NA_ESTRUTURA` significa *este cargo não existe neste Squad*. O validador
classifica como `INFO` — não afeta veredito, **nem com `--estrito`**. É o caso do
Auxiliar 2 do Squad 5.

O Design do 6º bloco é um caso diferente: ele **não apareceu no recorte
fornecido**, e não sabemos se o Squad não tem Design ou se a informação ficou
fora da captura. Por isso é `PENDENTE_CONFIRMACAO` — e essa pendência **bloqueia**.

---

## 4. Matriz PESSOA × SQUAD

| PESSOA | SQUAD | FUNÇÃO OPERACIONAL | MEMBERSHIP funcao | EMAIL/ID | PRINCIPAL | STATUS |
|---|---|---|---|---|---|---|
| Eliabe | squad-1 | Gestor | `membro` | PENDENTE_EMAIL_OU_ID | squad-1 | PENDENTE_EMAIL_OU_ID |
| Fernando | squad-1<br>squad-4 | Auxiliar 2<br>Coordenador | `membro`<br>`coordenador` | PENDENTE_EMAIL_OU_ID | **PENDENTE_SQUAD_PRINCIPAL** | PENDENTE_EMAIL_OU_ID |
| Gabrielly | squad-1 | Design | `membro` | PENDENTE_EMAIL_OU_ID | squad-1 | PENDENTE_EMAIL_OU_ID |
| Gustavo | squad-1 | Auxiliar | `membro` | PENDENTE_EMAIL_OU_ID | squad-1 | PENDENTE_EMAIL_OU_ID |
| Micael | squad-1<br>squad-5 | Coordenador<br>Coordenador | `coordenador`<br>`coordenador` | PENDENTE_EMAIL_OU_ID | **PENDENTE_SQUAD_PRINCIPAL** | PENDENTE_EMAIL_OU_ID |
| Adrian | squad-2 | Gestor | `membro` | PENDENTE_EMAIL_OU_ID | squad-2 | PENDENTE_EMAIL_OU_ID |
| Caique | squad-2 | Design | `membro` | PENDENTE_EMAIL_OU_ID | squad-2 | PENDENTE_EMAIL_OU_ID |
| Juliana | squad-2 | Auxiliar | `membro` | PENDENTE_EMAIL_OU_ID | squad-2 | PENDENTE_EMAIL_OU_ID |
| Klayvert | squad-2<br>squad-3<br>[hipótese: Squad 6] | Coordenador<br>Coordenador<br>Coordenador | `coordenador`<br>`coordenador`<br>`coordenador` | PENDENTE_EMAIL_OU_ID | **PENDENTE_SQUAD_PRINCIPAL** | PENDENTE_EMAIL_OU_ID |
| Vinícius | squad-2 | Auxiliar 2 | `membro` | PENDENTE_EMAIL_OU_ID | squad-2 | PENDENTE_EMAIL_OU_ID |
| Cavazzoto | squad-3 | Design | `membro` | PENDENTE_EMAIL_OU_ID | squad-3 | PENDENTE_EMAIL_OU_ID |
| Diogo | squad-3 | Gestor | `membro` | PENDENTE_EMAIL_OU_ID | squad-3 | PENDENTE_EMAIL_OU_ID |
| Mayara | squad-3 | Auxiliar | `membro` | PENDENTE_EMAIL_OU_ID | squad-3 | PENDENTE_EMAIL_OU_ID |
| Thiago | squad-3 | Auxiliar 2 | `membro` | PENDENTE_EMAIL_OU_ID | squad-3 | PENDENTE_EMAIL_OU_ID |
| Anderson | squad-4 | Gestor | `membro` | PENDENTE_EMAIL_OU_ID | squad-4 | PENDENTE_EMAIL_OU_ID |
| Carol | squad-4 | Design | `membro` | PENDENTE_EMAIL_OU_ID | squad-4 | PENDENTE_EMAIL_OU_ID |
| Giovanna | squad-4 | Auxiliar | `membro` | PENDENTE_EMAIL_OU_ID | squad-4 | PENDENTE_EMAIL_OU_ID |
| Yuri | squad-4 | Auxiliar 2 | `membro` | PENDENTE_EMAIL_OU_ID | squad-4 | PENDENTE_EMAIL_OU_ID |
| Felipe | squad-5 | Auxiliar | `membro` | PENDENTE_EMAIL_OU_ID | squad-5 | PENDENTE_EMAIL_OU_ID |
| Sophia | squad-5 | Design | `membro` | PENDENTE_EMAIL_OU_ID | squad-5 | PENDENTE_EMAIL_OU_ID |
| Witor | squad-5 | Gestor | `membro` | PENDENTE_EMAIL_OU_ID | squad-5 | PENDENTE_EMAIL_OU_ID |
| Matheus | [hipótese: Squad 6] | Gestor | `membro` | PENDENTE_EMAIL_OU_ID | [hipótese: Squad 6] | PENDENTE_EMAIL_OU_ID |
| Victor | [hipótese: Squad 6] | Auxiliar | `membro` | PENDENTE_EMAIL_OU_ID | [hipótese: Squad 6] | PENDENTE_EMAIL_OU_ID |

Legenda de `PRINCIPAL` / `STATUS`:

- `PENDENTE_EMAIL_OU_ID` — a relação chegou por **nome humano**; sem inventário
  de banco não há como resolver para email/id (bloqueador T-1, §6).
- `PENDENTE_SQUAD_PRINCIPAL` — pessoa em 2+ Squads sem principal declarado. **A
  ordem da planilha não decide isso**, e a máquina se recusa a escolher.
- Squad único → o principal é determinístico e já está resolvido.
- `[hipótese: …]` — rótulo não confirmado; essas linhas **não entram no plano**.

---

## 5. Totais

| Métrica | Valor |
|---|---|
| Blocos de Squad na relação | **6** (5 com rótulo confirmado + 1 pendente) |
| Memberships derivadas | **24** (só dos 5 Squads confirmados) |
| Pessoas únicas | **23** |
| Coordenadores distintos | **3** — Micael, Klayvert, Fernando |
| Gestores | **6** — Eliabe, Adrian, Diogo, Anderson, Witor, Matheus |
| Auxiliares (incl. Auxiliar 2) | **10** |
| Designers | **5** + 1 pendente de confirmação |
| Pessoas multi-Squad | **3** — Klayvert, Micael, Fernando |
| Squad principal pendente | **3** |
| Identidades sem email/id | **23** |
| Vínculos Cliente→Squad | **0** — `PENDENTE_RELACAO_CLIENTE_SQUAD` |
| `cliente_responsaveis` criados | **0**, por decisão |

**Mesmo Coordenador em vários Squads é válido** e não é erro — sai como `INFO`:
Klayvert coordena Squad 2, Squad 3 e o 6º bloco; Micael coordena Squad 1 e
Squad 5.

---

## 6. Por que os emails/ids continuam pendentes

A relação veio por **primeiro nome**. O plano canônico exige **email ou id
numérico** — nome puro não pode ir ao plano final porque o tooling **não garante
unicidade de nome**.

O bloqueador **T-1** da fase anterior continua valendo: `server/.env` não existe
neste checkout, `DATABASE_URL` não está no ambiente e não há Postgres local. Sem
inventário a resolução não é tentada — e "não tentada" é registrado como
`PENDENTE_EMAIL_OU_ID`, nunca como "encontrado".

**Quando o inventário existir**, a resolução é determinística e por estágios:

| Estratégia | Regra | Classificação |
|---|---|---|
| `REF_DIRETA` | o token já é email ou id | resolvido, nada a fazer |
| `NOME_COMPLETO` | igualdade exata de `users.nome` normalizado | `MATCH_EXATO` se único |
| `PRIMEIRO_NOME` | igualdade exata do 1º token de `users.nome` | `MATCH_EXATO` se único, + `AVISO` auditável |
| `EMAIL_LOCAL` | igualdade exata da parte local do email | `MATCH_EXATO` se único |

Empate → `MATCH_AMBIGUO` (**ERRO**; a máquina não desempata). Nada casa →
`NAO_ENCONTRADO` (**ERRO**). **Não existe distância de edição, substring nem
"melhor palpite" em nenhum estágio** — dado de rollout não se resolve por
adivinhação. Exemplo coberto por teste: havendo dois usuários "Victor",
`"Victor"` é ambíguo e **nenhum** dos dois é escolhido.

A normalização remove acento e caixa (`Vinícius` = `Vinicius`), o que é
igualdade, não similaridade: `Micae` e `Micaela` **não** casam com
`Micael Souza`.

Para resolver, quando houver acesso READ-ONLY:

```bash
DATABASE_URL="postgres://READONLY:...@host/db" \
  node server/sql/squads-inventario-readonly.js --saida inventario.json

node server/sql/squads-preflight-relacao.js \
  --relacao Squads_migration/P2_9_REAL_DATA_READINESS/entrada/relacao-squads-operacao-v1.txt \
  --inventario inventario.json --memberships
```

---

## 7. Veredito

| Item | Estado |
|---|---|
| Relação recebida | **PROCESSADA** |
| Membership map | **PARCIALMENTE RESOLVIDO** — composição conhecida; identidade e principal pendentes |
| Client map | **PENDENTE** — `PENDENTE_RELACAO_CLIENTE_SQUAD` |
| Plano P2.9 | **NÃO PRONTO PARA APPLY** — nenhum plano emitido |
| Rollout gate | **NO-GO** |
| `SQUADS_ENFORCEMENT` | **OFF** |
| Banco alterado | **NÃO** |

Veredito do pré-validador: **`AGUARDANDO_RELACAO`** — **0 erro estrutural**,
90 pendências esperadas. Nenhuma delas é defeito: são a fronteira da informação.

Com `--estrito` o veredito vira `ERRO_ESTRUTURAL` (exit 2) e **nenhum plano é
escrito em disco** — verificado. Sem `--estrito` o plano também não sai, porque
a emissão exige `PRONTO_PARA_DRY_RUN`.
