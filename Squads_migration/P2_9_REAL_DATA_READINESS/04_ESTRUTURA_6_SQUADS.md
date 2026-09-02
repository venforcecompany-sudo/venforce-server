# 04 — Estrutura dos 6 Squads

> **STATUS: AGUARDANDO_MAPEAMENTO.**
> Nada aqui foi criado no banco. Este documento é **preparação documental**.
> Nenhum Squad existe em `squads` hoje (ver `05_ESTADO_SCHEMA_SQUADS.md`).

---

## 1. O que é verdade de produto (fronteira atual da informação)

| Fato | Origem | Confiança |
|---|---|---|
| Existem **exatamente 6** Squads operacionais | declaração humana da missão P2.9 Real Data Readiness (2026-09-02) | **CONFIRMADO** |
| Cada Squad possui **1 Gestor principal conhecido** (conhecido *pela operação*) | mesma declaração | **CONFIRMADO que existe**, mas a identidade **não** foi fornecida |
| Nomes oficiais dos 6 Squads | — | **NÃO FORNECIDO** |
| Identidade (nome/id/email) dos 6 Gestores | — | **NÃO FORNECIDO** |
| Quais Clientes pertencem a cada Squad | — | **NÃO FORNECIDO** |
| Quais demais usuários pertencem a cada Squad | — | **NÃO FORNECIDO** |

### Busca documental executada (resultado negativo, registrado)

Antes de declarar "não disponível", o repositório inteiro foi varrido em busca
de uma fonte confiável que nomeasse os Squads ou seus Gestores:

```
grep -ri "squad 1..6 | nome oficial | gestor do squad"  Squads_migration/
grep -ri "(6|seis) squads"                              <repo>/    → ZERO ocorrências
```

**Todos** os nomes de Squad presentes no repositório são **fictícios de exemplo
ou de teste**, e estão explicitamente marcados como tal na origem:

| Nome encontrado | Arquivo | Natureza |
|---|---|---|
| `squad-exemplo-a`, `squad-exemplo-b` | `Squads_migration/SQUADS_MIGRATION_TEMPLATE.example.json:7-8` | exemplo fictício do template |
| `Squad Alpha` | `Squads_migration/VENFORCE_V3_SQUADS_AUTH_READINESS.md:354` | payload de exemplo de documentação |
| `alpha`, `arquivado` | `server/tests/squadsMigracaoImport.test.js` | fixture de teste em memória |

Nenhum deles é fonte de nome oficial. **Nada foi derivado deles.**

> A expressão "6 squads" **não aparece em lugar nenhum do código ou dos
> documentos**. O número 6 é conhecido *exclusivamente* pela declaração humana
> desta missão. Isso está registrado aqui para que ninguém, depois, procure no
> repositório a origem do número e conclua que ela se perdeu.

---

## 2. Os 6 slots estruturais

> ⚠️ **`SQUAD_1` … `SQUAD_6` são IDENTIFICADORES TEMPORÁRIOS DE DOCUMENTAÇÃO.**
>
> **NÃO são slugs.** **NÃO devem ser inseridos no banco.** **NÃO devem aparecer
> em nenhum plano entregue ao `squads-migrate.js`.**
>
> Eles existem apenas para que este documento, o mapa de entrada
> (`entrada/relacao-squads.PENDENTE_HUMANO.yaml`) e o validador possam se
> referir ao "terceiro Squad" antes de o terceiro Squad ter nome.
>
> O validador **recusa** um plano que ainda contenha um identificador temporário
> (erro `SQUAD_IDENTIFICADOR_TEMPORARIO`) — ver `11_VALIDACAO_FUTURA_RELACAO.md`.

| Slot temporário | Nome oficial | Slug definitivo | Gestor | Clientes | Membros adicionais | Status |
|---|---|---|---|---|---|---|
| `SQUAD_1` | `PENDENTE_NOME_OFICIAL` | `PENDENTE_NOME_OFICIAL` | `PENDENTE_DADO_HUMANO` | `PENDENTE_RELACAO_CLIENTE_SQUAD` | `PENDENTE_RELACAO_USUARIO_SQUAD` | AGUARDANDO_MAPEAMENTO |
| `SQUAD_2` | `PENDENTE_NOME_OFICIAL` | `PENDENTE_NOME_OFICIAL` | `PENDENTE_DADO_HUMANO` | `PENDENTE_RELACAO_CLIENTE_SQUAD` | `PENDENTE_RELACAO_USUARIO_SQUAD` | AGUARDANDO_MAPEAMENTO |
| `SQUAD_3` | `PENDENTE_NOME_OFICIAL` | `PENDENTE_NOME_OFICIAL` | `PENDENTE_DADO_HUMANO` | `PENDENTE_RELACAO_CLIENTE_SQUAD` | `PENDENTE_RELACAO_USUARIO_SQUAD` | AGUARDANDO_MAPEAMENTO |
| `SQUAD_4` | `PENDENTE_NOME_OFICIAL` | `PENDENTE_NOME_OFICIAL` | `PENDENTE_DADO_HUMANO` | `PENDENTE_RELACAO_CLIENTE_SQUAD` | `PENDENTE_RELACAO_USUARIO_SQUAD` | AGUARDANDO_MAPEAMENTO |
| `SQUAD_5` | `PENDENTE_NOME_OFICIAL` | `PENDENTE_NOME_OFICIAL` | `PENDENTE_DADO_HUMANO` | `PENDENTE_RELACAO_CLIENTE_SQUAD` | `PENDENTE_RELACAO_USUARIO_SQUAD` | AGUARDANDO_MAPEAMENTO |
| `SQUAD_6` | `PENDENTE_NOME_OFICIAL` | `PENDENTE_NOME_OFICIAL` | `PENDENTE_DADO_HUMANO` | `PENDENTE_RELACAO_CLIENTE_SQUAD` | `PENDENTE_RELACAO_USUARIO_SQUAD` | AGUARDANDO_MAPEAMENTO |

**GESTORES CONFIRMADOS DOCUMENTALMENTE: 0 / 6.**

Não é uma falha da auditoria — é o estado real da informação disponível. A
operação conhece os 6 Gestores; o repositório não.

---

## 3. Regras estruturais que valem para os 6 (verificáveis hoje)

Estas regras já estão implementadas no validador
(`server/sql/squads-preflight-relacao.js`) e rodam **sem banco**:

| Regra | Severidade se violada |
|---|---|
| Exatamente 6 Squads no plano | `ERRO_ESTRUTURAL` |
| `nome` único entre os 6 | `ERRO_ESTRUTURAL` |
| `slug` único entre os 6 (após normalização) | `ERRO_ESTRUTURAL` |
| Cada Squad tem **1** Gestor principal declarado | `ERRO_ESTRUTURAL` |
| Nenhum Squad com 2+ Gestores | `ERRO_ESTRUTURAL` |
| Nenhum identificador temporário (`SQUAD_N`) sobrando | `ERRO_ESTRUTURAL` |
| Nenhum marcador `PENDENTE_*` sobrando | `ERRO_ESTRUTURAL` |
| Squad sem clientes atribuídos | `PENDENTE_ESPERADO` (hoje) → `AVISO` (quando a relação chegar) |

A distinção `PENDENTE_ESPERADO` × `ERRO_ESTRUTURAL` é o que permite rodar o
validador **hoje**, com o mapa vazio, e obter um resultado útil em vez de um
muro de erros — ver `11_VALIDACAO_FUTURA_RELACAO.md` §3.

---

## 4. O que NÃO foi feito aqui (por decisão explícita)

- ❌ Não foi criado nenhum registro em `squads`.
- ❌ Não foi inventado nenhum nome de Squad.
- ❌ Não foi inferido nenhum Gestor a partir de `data/users.json`, de
  `cliente_responsaveis`, de histórico de commits ou de qualquer outro sinal.
- ❌ Não foi criado 7º Squad, nem fundidos Squads.
- ❌ Não foi assumido que os 6 Squads correspondem a alguma divisão existente
  (marketplace, base, grant, carteira legada).

> **Por que essa disciplina importa:** o rollout gate (§9.8 de
> `VENFORCE_V3_SQUADS_ROLLOUT_SAFETY.md`) valida **completude**, não
> **correção**. Um mapa completo porém errado **passa** no gate e liga o
> enforcement com a carteira trocada. Um Gestor inventado aqui viraria acesso
> real errado em produção — silenciosamente. Por isso: `PENDENTE_DADO_HUMANO`.

---

## 5. Como este documento é preenchido quando a relação chegar

Este arquivo **não** é o ponto de entrada. Ele é documentação.

O ponto de entrada é:
`Squads_migration/P2_9_REAL_DATA_READINESS/entrada/relacao-squads.PENDENTE_HUMANO.yaml`

O fluxo completo está em `14_O_QUE_FALTA_QUANDO_RELACAO_CHEGAR.md`.
