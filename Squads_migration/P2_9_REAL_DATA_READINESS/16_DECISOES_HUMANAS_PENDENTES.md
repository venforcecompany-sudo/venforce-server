# 16 — DECISÕES HUMANAS PENDENTES (handoff pós-relação)

> **Estado:** `SQUADS_ENFORCEMENT` = **OFF** · migração **NÃO EXECUTADA** ·
> banco **NÃO ALTERADO** · nenhum plano emitido.
>
> Este documento existe para **encolher** a lista de perguntas humanas. Depois da
> relação recebida, a pergunta **"quem está em qual Squad?" está respondida** —
> ver `15_MEMBERSHIPS_RECEBIDAS.md`. Sobraram 5 decisões, e só elas.

---

## O que NÃO precisa mais ser perguntado

| Pergunta antiga | Estado |
|---|---|
| Quais são os 6 Squads? | **Respondida** — Squad 1 a Squad 5 + 1 bloco de rótulo pendente |
| Quem é o Coordenador de cada Squad? | **Respondida** |
| Quem é o Gestor de cada Squad? | **Respondida** |
| Quem são os Auxiliares? | **Respondida** |
| Quem é o Design? | **Respondida** para Squads 1–5 |
| Coordenador e Gestor são a mesma pessoa? | **Respondida: NÃO.** São funções e pessoas distintas — o tooling foi corrigido |
| A mesma pessoa pode coordenar vários Squads? | **Respondida: SIM**, e não é erro |
| Squad 5 tem Auxiliar 2? | **Respondida: não tem** (`AUSENTE_NA_ESTRUTURA`) |
| Nomes "sofisticados" para os Squads? | **Não** — nomes operacionais simples: Squad 1…Squad 5 |

---

## As 5 decisões que ainda faltam

### 1. O sexto bloco é o Squad 6?

Na planilha, o sexto bloco está rotulado **"squad 5"** — igual ao bloco anterior.
Pelo requisito de produto existem exatamente 6 Squads, então a hipótese é que
seja o **Squad 6**.

- **Registrado como:** `SQUAD_6_PENDENTE_CONFIRMACAO_DO_ROTULO`
- **Hipótese guardada em:** `NOME_HIPOTESE: Squad 6`
- **Impacto:** enquanto pendente, o bloco inteiro (Squad + 3 memberships:
  Klayvert, Matheus, Victor) **fica fora do plano**. Nada de "Squad 6" é criado
  a partir de suposição.
- **Como resolver:** em `entrada/relacao-squads-operacao-v1.txt`, no último
  bloco, troque

  ```
  SQUAD: PENDENTE_CONFIRMACAO_DO_ROTULO
  ROTULO_STATUS: SQUAD_6_PENDENTE_CONFIRMACAO_DO_ROTULO
  ```

  por

  ```
  SQUAD: Squad 6
  SLUG: squad-6
  ROTULO_STATUS: CONFIRMADO
  ```

  e remova a linha `NOME_HIPOTESE`. (O `ROTULO_STATUS` é **fail-closed**: só o
  valor exato `CONFIRMADO` libera o Squad.)

> **Pergunta a fazer:** *"O bloco com Coordenador Klayvert / Gestor Matheus /
> Auxiliar Victor é o Squad 6, ou o rótulo 'squad 5' está correto e há outra
> explicação?"*

---

### 2. O sexto Squad tem Design?

O Design **não apareceu no recorte fornecido**. Não sabemos se o Squad não tem
Design ou se a informação ficou fora da captura — e essas duas coisas exigem
respostas diferentes.

- **Registrado como:** `DESIGN: PENDENTE_CONFIRMACAO` → `DESIGN_PENDENTE_CONFIRMACAO`
- **Contraste deliberado:** o Auxiliar 2 do Squad 5 é `AUSENTE_NA_ESTRUTURA`
  (sabemos que não existe → `INFO`, não bloqueia). O Design do 6º bloco é
  `PENDENTE_CONFIRMACAO` (não sabemos → bloqueia).
- **Como resolver:** se o Squad não tem Design, escreva
  `DESIGN: AUSENTE_NA_ESTRUTURA`. Se tem, escreva o nome.

> **Pergunta a fazer:** *"O sexto Squad tem alguém em Design? Se não tem, é
> intencional?"*

---

### 3. Squad principal das 3 pessoas multi-Squad

O produto permite **usuário ∈ N Squads**, mas exige **exatamente 1 principal**.
**A ordem da relação não define o principal** e o pré-validador se recusa a
escolher o primeiro — se ninguém decidir, o importador auto-promoveria a 1ª
membership, e essa escolha silenciosa é justamente o que esta fase proíbe.

| Pessoa | Squads | Função em cada um | Principal |
|---|---|---|---|
| **Klayvert** | Squad 2 · Squad 3 · 6º bloco | Coordenador · Coordenador · Coordenador | **PENDENTE** |
| **Micael** | Squad 1 · Squad 5 | Coordenador · Coordenador | **PENDENTE** |
| **Fernando** | Squad 1 · Squad 4 | **Auxiliar 2** · **Coordenador** | **PENDENTE** |

Auditoria completa: essas são as **únicas** 3 pessoas multi-Squad das 23. As
outras 20 estão em 1 Squad só, e o principal delas já está resolvido de forma
determinística.

- **Como resolver:** no Squad que for o principal da pessoa, liste o nome dela em
  `PRINCIPAL:`. Exemplo — se o principal do Klayvert é o Squad 2:

  ```
  SQUAD: Squad 2
  PRINCIPAL:
    - Klayvert
  ```

  Cada pessoa pode aparecer em `PRINCIPAL:` de **no máximo 1** Squad; declarar em
  dois é `ERRO_ESTRUTURAL`, e declarar num Squad de que a pessoa não é membro
  também.

> **Perguntas a fazer:** *"Qual é o Squad principal do Klayvert (2, 3 ou o
> sexto)? E do Micael (1 ou 5)? E do Fernando (1, onde é Auxiliar 2, ou 4, onde é
> Coordenador)?"*

---

### 4. Identidade técnica das 23 pessoas (email ou id)

A relação veio por **primeiro nome**; o plano canônico exige **email ou id**.
Nome puro não pode ir ao plano final porque o tooling não garante unicidade de
nome.

Pessoas a resolver (23):

Micael · Eliabe · Gustavo · Fernando · Gabrielly · Klayvert · Adrian · Juliana ·
Vinícius · Caique · Diogo · Mayara · Thiago · Cavazzoto · Anderson · Giovanna ·
Yuri · Carol · Witor · Felipe · Sophia · Matheus · Victor

**Isto pode ser resolvido sem perguntar a ninguém**, desde que haja acesso
READ-ONLY ao banco. A resolução é determinística (§6 de
`15_MEMBERSHIPS_RECEBIDAS.md`) e **nunca faz fuzzy-match**:

```bash
DATABASE_URL="postgres://READONLY:...@host/db" \
  node server/sql/squads-inventario-readonly.js --saida inventario.json

node server/sql/squads-preflight-relacao.js \
  --relacao Squads_migration/P2_9_REAL_DATA_READINESS/entrada/relacao-squads-operacao-v1.txt \
  --inventario inventario.json --memberships
```

Depois disso, **só chega a humano** o que a máquina não puder resolver
objetivamente:

- `MATCH_AMBIGUO` — dois usuários casam com o mesmo nome (ex.: dois "Victor").
  Nenhum é escolhido; o humano diz qual.
- `NAO_ENCONTRADO` — o nome não casa com nome completo, primeiro nome nem parte
  local de email. Pode ser apelido, nome de casada, ou usuário inexistente.

> **Bloqueador atual (T-1):** `server/.env` não existe neste checkout,
> `DATABASE_URL` não está no ambiente, não há Postgres local. Enquanto isso, as
> 23 identidades ficam `PENDENTE_EMAIL_OU_ID`.

---

### 5. Cliente → Squad (a carteira)

**Este é o bloqueio principal do P2.9.** A relação recebida resolve
**Usuário → Squad**; ela **não contém** Cliente → Squad.

Nada foi inferido. Não há inferência autorizada por gestor histórico,
responsável legado, marketplace, Grant, Base, nome, atividade ou ClickUp — essas
fontes produzem **evidência auxiliar**, nunca dado de rollout (ver
`09_RESPONSABILIDADES_EVIDENCIAS.md`). `cliente.squad` continua
`PENDENTE_RELACAO_CLIENTE_SQUAD`.

Consequência: **`cliente_responsaveis` também não foi criado.** Responsabilidade
é por Cliente, não por Squad; assumir que todo membro do Squad responde por todo
Cliente do Squad seria inventar a carteira.

- **Como resolver:** em cada bloco de Squad, substitua

  ```
  CLIENTES: PENDENTE_RELACAO_CLIENTE_SQUAD
  ```

  pela lista de slugs (ou ids) dos Clientes daquele Squad, um por linha com `- `.
  Com `--inventario`, o validador cobra que **todo Cliente ativo** acabe em
  exatamente 1 Squad, e recusa Cliente em 2 Squads.

> **Pergunta a fazer:** *"Qual é a carteira de cada Squad — quais Clientes
> pertencem ao Squad 1, ao Squad 2, e assim por diante?"*

---

## Ordem sugerida

```
1. confirmar o rótulo do 6º bloco          (1 pergunta)
2. confirmar o Design do 6º bloco          (1 pergunta)
3. decidir o principal de 3 pessoas        (3 perguntas)
4. resolver identidades                    (0 perguntas se houver banco READ-ONLY;
                                            só ambiguidades vão a humano)
5. receber Cliente → Squad                 (a carteira — o bloqueio maior)
```

Itens 1–3 são perguntas curtas e independentes; podem ser feitas de uma vez.
O item 4 não é pergunta, é acesso. O item 5 é o entregável que falta.

---

## Só depois de tudo isso

```
node server/sql/squads-preflight-relacao.js --relacao <rel> --inventario inv.json --estrito
   → precisa dar PRONTO_PARA_DRY_RUN (exit 0)

node server/sql/squads-preflight-relacao.js --relacao <rel> --inventario inv.json \
     --emitir-plano plano-p2-9.json

node server/sql/squads-migrate.js --plan plano-p2-9.json          # dry-run COM banco
node server/sql/squads-migrate.js --plan plano-p2-9.json --apply  # só após revisão humana
```

**Nada disso é hoje.** Hoje: `ROLLOUT GATE = NO-GO`, `APPLY = NÃO`.

---

## Anexo — riscos de hardening que continuam abertos

Achados da fase anterior, **não** corrigidos aqui de propósito (esta missão era
a relação real, não uma refatoração ampla):

| Risco | O que é | Onde |
|---|---|---|
| **T-1** | Sem `DATABASE_URL` / `server/.env` → nenhum número real de banco | `00_RESUMO.md` §2 |
| **T-2** | `ROLES_INTERNAS` existe em **3 cópias divergentes** (`squadsMigracaoService.js:14`, `authorizationService.js:17`, `squadsMigracaoImportService.js:31` — esta com `admin` a mais) | `12_ROLLOUT_GATE_ATUAL.md` |
| **T-3** | O dry-run atual **toca DDL** (`ensureSquadsTables`) | `12_ROLLOUT_GATE_ATUAL.md` |
| **T-4** | `auditoria().pronto` pode ser `true` **por vacuidade** (nenhum dado a auditar) | `12_ROLLOUT_GATE_ATUAL.md` |

O pré-validador desta fase evita T-3 por construção (adaptador de banco falso,
DDL inerte) e usa deliberadamente a cópia de `ROLES_INTERNAS` da **auditoria** —
a que decide o gate. T-2 e T-4 seguem para hardening posterior.
