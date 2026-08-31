# 03 — Checklist para a reunião com a gestão

> Pauta objetiva. Cada resposta vira uma linha do plano de migração (`02`) ou
> uma pendência conhecida. **O agente não responde nada disto.** Trazer a
> auditoria de `04` impressa para a reunião — ela dá a lista real de clientes e
> usuários.

**Antes da reunião:** rodar `queries/*.sql` de `04` numa cópia segura (ou pedir
para alguém com acesso rodar) e imprimir:
`clientes_ativos`, `usuarios_internos`, `clientes_sem_conta`,
`clientes_multi_conta`, `responsaveis_existentes`.

---

## As 12 perguntas

| # | Pergunta | Onde a resposta entra | Registrar como |
|---|---|---|---|
| 1 | **Quais Squads realmente existem hoje?** (unidades operacionais reais, não o organograma inteiro) | `squads[]` do plano | lista de nomes |
| 2 | **Qual o nome oficial de cada Squad?** E o `slug` (curto, minúsculo, sem espaço)? | `squads[].nome` / `.slug` | tabela nome→slug |
| 3 | **Qual Cliente pertence a qual Squad?** (percorrer a lista de clientes ativos da auditoria) | `clientes[]` do plano | coluna `squad_slug` na planilha de clientes |
| 4 | **Qual usuário participa de qual Squad?** (percorrer a lista de internos) | `membros[]` do plano | planilha de memberships |
| 5 | **Qual o Squad principal de cada usuário?** (só 1 por pessoa; é o default de navegação, não limita acesso) | `membros[].principal` | marcar 1 linha por pessoa |
| 6 | **Quem é coordenador de qual Squad?** (administra o próprio Squad; não herda permissão global; não transfere clientes) | `membros[].funcao = "coordenador"` | lista pessoa→squad |
| 7 | **Quais Clientes cada pessoa atende diretamente?** (gestor / auxiliar / designer — organização, **não** acesso) | `responsaveis[]` (opcional) | planilha de responsáveis |
| 8 | **Existem Clientes ativos que ficam temporariamente SEM Squad?** Quais e por quê? | **fora do plano** | lista + motivo → pendência conhecida |
| 9 | **Existem usuários internos que NÃO devem entrar em nenhum Squad?** (se sim: com enforcement ON eles ficam sem carteira — é o desejado? ou a role deveria mudar?) | **fora do plano** | lista + decisão |
| 10 | **Como tratar Clientes inativos?** (padrão: não entram no plano; a auditoria só conta ativos) | decisão | confirmar padrão ou exceções |
| 11 | **Como tratar usuários inativos com role interna?** (padrão: não entram; membership de inativo só suja contagem) | decisão | confirmar padrão ou exceções |
| 12 | **Qual Squad será o primeiro canário?** (pequeno, com pessoas próximas, sem cliente de alto risco/fechamento crítico em curso) | `07_PLANO_CANARIO.md` | nome do Squad + janela |

---

## Perguntas de consistência (verificar contra a auditoria `04`/`05`)

| Pergunta | Baseada em |
|---|---|
| Algum cliente tem 2+ contas do mesmo marketplace? Confirmar que **não** há intenção de separar as contas em Squads diferentes (não é suportado — o Squad é do cliente). | `queries/clientes_multi_conta.sql` |
| Algum responsável (`cliente_responsaveis`) ficará **fora do Squad** do cliente pelo qual responde? (com enforcement ON, essa pessoa perde acesso ao cliente) | `queries/responsaveis_fora_do_squad.sql` (roda após o plano existir, mas a lista de responsáveis atuais já ajuda) |
| Há entregas de `fechamento_mensal` duplicadas por (cliente, conta, competência)? Se sim, classe **D** (2+ publicadas) precisa de decisão antes do rollout. | `05_AUDITORIA_DUPLICATAS_FINANCEIRO.md` |
| `JWT_SECRET` está configurado no Render em produção? `NODE_ENV=production`? (definir `JWT_SECRET` **derruba todas as sessões** — precisa ser combinado, não descoberto) | `06_JWT_DEPLOY_READINESS.md` |
| Quem fica de plantão, com acesso ao Render e autoridade para setar `SQUADS_ENFORCEMENT=off`, durante o canário? | `08_GO_NO_GO.md` |

---

## Saída da reunião (o que deve existir depois)

1. `squads[]` preenchido.
2. Planilha `cliente → squad_slug` completa (todo cliente ativo tem um destino
   **ou** está na lista "fica sem Squad por ora").
3. Planilha `membership` completa (todo interno tem Squad + principal + função,
   **ou** está na lista "não entra em Squad").
4. Planilha `responsáveis` (opcional).
5. Squad canário definido + janela.
6. Nome do responsável pelo rollback / plantão.
7. Confirmação do estado do `JWT_SECRET` (ou tarefa atribuída a quem tem acesso).

Com isso, `02` vira um `plano-p2-9.json` real e o fluxo de `09` pode rodar.
