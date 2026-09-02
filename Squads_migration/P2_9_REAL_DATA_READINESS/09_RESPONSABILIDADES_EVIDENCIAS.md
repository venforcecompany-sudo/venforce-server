# 09 — Responsabilidades existentes: evidências, não decisões

> **BLOCO I.** Auditoria do que já existe em `cliente_responsaveis` e de
> vínculos legados. **Nada aqui é usado automaticamente para formar Squads.**
> Tudo continua `PENDENTE_RELACAO_CLIENTE_SQUAD`.

---

## 1. A regra que governa este documento

> **Responsabilidade ≠ autorização.**
> `authorizationService.js` — a **única** fonte de autorização — **não
> referencia `cliente_responsaveis` em lugar nenhum**
> (`VENFORCE_V3_FINAL_CONVERGENCE_CLOSURE.md` §4). Ser "gestor" de um cliente
> **não dá acesso** a ele; acesso vem do Squad.

Portanto, saber que *"o Cliente X é historicamente do Gestor Y"* é uma pista
**organizacional**, nunca uma conclusão sobre o Squad de X.

---

## 2. Modelo

`cliente_responsaveis` — `20260827_squads_foundation.sql:127-149` +
`20260828_cliente_responsaveis_p24.sql:26-37`:

```sql
CREATE TABLE IF NOT EXISTS cliente_responsaveis (
  id SERIAL PRIMARY KEY,
  cliente_id INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  papel TEXT NOT NULL,          -- CHECK: 'gestor' | 'auxiliar' | 'designer'
  ativo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
-- P2.4, aditivas:
--   criado_por INTEGER REFERENCES users(id)
--   encerrado_em TIMESTAMP
--   encerrado_por INTEGER REFERENCES users(id)
--   motivo TEXT
```

Dois pontos:

- **Não existe papel `coordenador` aqui.** O CHECK aceita só
  `gestor|auxiliar|designer`. "Coordenador" é atributo da **membership**
  (`squad_members.funcao`), não da responsabilidade. **É por isso que o Gestor
  de um Squad, na conversão para o plano canônico, vira
  `membros[].funcao = "coordenador"`** — ver `11_VALIDACAO_FUTURA_RELACAO.md`.
- As colunas P2.4 (`encerrado_em`, `motivo`) guardam **histórico**. O pacote
  anterior nunca as consultava (só `ativo = true`) — gap fechado aqui.

---

## 3. Query (inclui o histórico encerrado)

```sql
SELECT id, cliente_id, user_id, papel, ativo, encerrado_em, motivo
  FROM cliente_responsaveis
 ORDER BY cliente_id ASC, id ASC;
```

---

## 4. Força da evidência — e o que cada nível autoriza

| Sinal disponível | Classe | O que autoriza |
|---|---|---|
| `cliente_responsaveis` **ativo**, `papel='gestor'`, usuário ativo e interno | **EVIDÊNCIA_FORTE** | sugerir ao humano *"o Cliente X talvez pertença ao Squad do Gestor Y"* — **para ele confirmar** |
| Responsabilidade **encerrada** (`ativo=false` / `encerrado_em` preenchido) | **EVIDÊNCIA_FRACA** | nada; registra história, não estado |
| `papel='auxiliar'` / `'designer'` | **EVIDÊNCIA_FRACA** | nada — não implica carteira |
| Cliente com **múltiplos** responsáveis `gestor` ativos | **AMBÍGUO** | nada — apontar como pergunta à gestão |
| Cliente **sem nenhum** responsável | **AMBÍGUO** | nada |
| `data/users.json` (23 nomes, `@vendexcompany.com`) | **EVIDÊNCIA_FRACA** | nada — store pré-Postgres, sem `role`, sem squad (ver `03_USUARIOS_REAIS.md` §4) |
| Nome do Cliente · marketplace · Base · Grant · quem acessou | **NÃO É EVIDÊNCIA** | **nada.** Proibido pelo BLOCO A |

**Mesmo EVIDÊNCIA_FORTE não decide.** Ela vira, no máximo, uma coluna
*sugestão* numa planilha de conferência — a operação confirma ou corrige. O
campo que vai para o plano continua vindo **só** da relação humana.

---

## 5. O alerta que precisa ser resolvido ANTES do canário

`auditoria().atencao.responsaveisForaDoSquad` conta pessoas que são
**responsáveis** por um cliente mas **não são membros** do Squad desse cliente.

Com o enforcement ligado, essas pessoas **deixam de conseguir abrir o cliente
pelo qual respondem** — 403. Não é bug: é a consequência correta de
"acesso vem do Squad".

| | |
|---|---|
| **Detecção** | `auditoria().atencao.responsaveisForaDoSquad` · `P2_9_PRE_FLIGHT/queries/03_inconsistencias.sql` ATENÇÃO 1 |
| **Bloqueia `pronto`?** | **NÃO** — `atencao.*` está deliberadamente **fora** da fórmula de `pronto` (7 condições, nenhuma delas é `atencao`) |
| **Deve bloquear o canário?** | **SIM, na prática** — é a causa mais provável de "liguei e a equipe perdeu acesso" |
| **Correção** | mover o cliente de Squad **ou** a pessoa para o Squad. **Decisão humana.** |

> Este é um caso em que o gate automático **não** protege: `pronto` pode ser
> `true` com dezenas de responsáveis fora do Squad. Conferir `atencao`
> manualmente antes do canário é obrigatório.

---

## 6. Efeito colateral de transferência (registrar antes de acontecer)

Quando um cliente é **transferido** de Squad pelo importador, as
responsabilidades de quem **não** é membro do Squad de destino são
**encerradas automaticamente** (`cliente_responsaveis.ativo = false`,
`motivo = 'transferencia_squad'`) — `P2_9_PRE_FLIGHT/02_TEMPLATE_MAPEAMENTO.md`
§`clientes[]`.

O passo 4 do plano (`responsaveis[]`) pode reatribuir logo em seguida. Mas se o
plano **não** reatribuir, a responsabilidade **some silenciosamente**.

**Recomendação:** ao preencher a relação, se houver transferências, preencher
também `responsaveis[]` na mesma rodada.

---

## 7. Estado

| | |
|---|---|
| **Responsabilidades auditadas** | **0** — `REQUER BANCO` (**T-1**) |
| **Query** | **PRONTA** (inclui histórico encerrado — gap do pacote anterior) |
| **Alguma responsabilidade criada/alterada?** | **NÃO** |
| **Alguma usada para formar Squad?** | **NÃO. Nenhuma.** |
| **Squad de qualquer cliente** | `PENDENTE_RELACAO_CLIENTE_SQUAD` |
