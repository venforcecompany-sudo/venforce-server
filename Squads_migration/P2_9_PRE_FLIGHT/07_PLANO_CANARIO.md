# 07 — Plano de ativação controlada (canário)

> **Plano conceitual. NADA é executado nesta fase.** `SQUADS_ENFORCEMENT` = OFF.
>
> Base: `VENFORCE_V3_SQUADS_ROLLOUT_SAFETY.md` §3/§4 e
> `VENFORCE_V3_BACKEND_RELEASE_CANDIDATE.md` §7/§13.
>
> Princípio: **o enforcement é um único flag de env** (`SQUADS_ENFORCEMENT`),
> lido em tempo de chamada, fail-safe OFF. Ligar/desligar = setar a env no
> Render + restart. **Sem tocar dados, sem tocar schema.** Isso é o que torna o
> canário reversível em segundos.

---

## O que o "canário" significa aqui

O enforcement **não é por-Squad no código** — quando `SQUADS_ENFORCEMENT=on`,
ele vale para **todo mundo** de uma vez. O "canário" é feito **pelos dados**:
migra-se a carteira de **um** Squad primeiro (e nada mais), liga-se o flag, e
como só esse Squad tem `cliente_squad_history`/`squad_members` populados, só as
pessoas desse Squad têm carteira restrita — as demais caem em carteira vazia
(403).

➡️ **Consequência importante:** ligar o flag com **apenas 1 Squad migrado**
deixa **todos os outros internos sem carteira**. Duas opções:

| Estratégia | Como | Trade-off |
|---|---|---|
| **A — Big-bang de dados, canário de observação** (recomendado) | migrar **todos** os Squads de uma vez (dry-run limpo, `pronto:true`), ligar o flag, e "canário" = observar de perto o 1º Squad / as primeiras horas, pronto para `off` | ninguém fica sem carteira; a reversão é o flag |
| **B — Canário de dados real** | migrar só o Squad canário; ligar o flag; aceitar que os demais internos operam via **admin** ou com o flag `off` para eles não existe (não dá) | os demais internos ficam sem carteira enquanto durar o canário — só serve se a operação puder parar |

**Recomendação: Estratégia A.** O "canário" vira uma janela de observação, não
uma migração parcial. A migração é idempotente e transacional; não há ganho real
em fatiá-la, e fatiá-la cria um período em que metade da empresa não trabalha.

---

## Fases

### FASE 0 — enforcement OFF (estado atual, indefinido)
- `SQUADS_ENFORCEMENT` ausente. Interno vê todos os clientes ativos.
- Nada de Squad em produção.
- **Saída:** Convergência #2 mergeada + `JWT_SECRET` pronto + código deployado
  (ver `06`, `11`).

### FASE 1 — dados migrados + enforcement ainda OFF
- Deploy do código com `SQUADS_ENFORCEMENT` ausente/`off`.
- Smoke (§ do RELEASE CANDIDATE §7.5): `/me/portfolio` idêntico a antes,
  `/fechamentos/financeiro/clientes` idêntico, `/financeiro?periodo=lixo` → 400.
- Rodar `--audit` → guardar `p2-9-auditoria-ANTES.json`.
- Operação preenche `plano-p2-9.json` (de `02`/`03`).
- `--plan` (dry-run): **0 erros**, avisos revisados um a um.
- `--apply --actor <admin>`: transacional, idempotente.
- **Nada muda para o usuário** — o flag ainda está OFF. A carteira legada vale.

### FASE 2 — auditoria `pronto: true`
- `--audit` de novo. Gate objetivo:
  ```
  auditoria.pronto === true
  auditoria.integridade.clientesComVinculoDuplicado === 0
  auditoria.atencao revisado (não precisa ser 0 — precisa ser CONHECIDO e aceito)
  ```
- `atencao.responsaveisForaDoSquad` revisado: cada pessoa nessa lista **perde
  acesso** ao cliente pelo qual responde quando o flag ligar. Corrigir (mover
  cliente/pessoa) ou aceitar explicitamente.
- **Sem `pronto:true` → NÃO ligar o flag** (o log de boot avisa com `⚠`).

### FASE 3 — canário: ligar o flag, observar o 1º Squad
- Escolher janela de baixo risco (não durante fechamento mensal de cliente
  grande).
- Alguém de plantão com acesso ao Render **e** autoridade para `off`.
- `SQUADS_ENFORCEMENT=on` + restart.
- Log de boot esperado:
  `[squads] enforcement=ON (SQUADS_ENFORCEMENT=on) | clientes sem squad=0/N | ... | auditoria.pronto=true`
- Smoke com enforcement:
  - membro do Squad canário → abre cliente do seu Squad (200)
  - membro do Squad canário → cliente de outro Squad → **403 CLIENTE_FORA_DA_CARTEIRA**
  - **admin** → todos (bypass, inalterado)
  - **seller** → só `seller_clientes` (inalterado)
  - `/me/portfolio` de um interno → só os clientes do(s) seu(s) Squad(s)

### FASE 4 — observar (24–72h, ou 1 ciclo operacional curto)
- Acompanhar os sinais da tabela abaixo.
- Critério de sucesso: nenhum sinal de aborto; o Squad canário trabalha normal;
  0 chamado "não consigo abrir cliente X".

### FASE 5 — expandir
- Com a Estratégia A, a expansão é **só continuar observando** os demais Squads
  (os dados já estão lá). Fazer um sweep dos sinais por Squad.
- Com a Estratégia B, aqui se migra o 2º, 3º… Squad (dry-run + apply por lote) e
  observa cada um.

### FASE 6 — todos os Squads
- Sweep final: `--audit` → `pronto:true` estável; 0 reclamações de carteira;
  métricas de 403 de carteira estáveis e explicáveis.
- Documentar o estado final. P2.9 concluída.

---

## Sinais de ABORTO → `SQUADS_ENFORCEMENT=off` + restart imediato

| Sinal | Origem | Ação |
|---|---|---|
| **(obrigatório)** usuário interno com carteira **vazia** que **deveria** ter clientes | chamado / suporte / `/me/portfolio` vazio | **`off` imediato**, auditar, **não insistir** (RELEASE CANDIDATE §13) |
| pico de `403 CLIENTE_FORA_DA_CARTEIRA` no log (`[carteira] acesso negado`) acima do esperado para 1 Squad | log do servidor | `off`, comparar com o mapa Cliente→Squad aprovado |
| `5xx` nas rotas de carteira (`/me/*`, `/operacao/*`, `/financeiro`) surgindo após o restart | log / monitor | `off` — pode ser tabela de Squad ausente com flag ON (não deveria acontecer pós-migração) |
| admin ou seller com comportamento diferente de antes | smoke / chamado | `off` — o flag **não** deveria tocar admin/seller; é bug |
| `auditoria.pronto` virou `false` depois de ligar (ex.: alguém criou cliente novo sem Squad) | `--audit` / log de boot | não precisa abortar na hora; atribuir Squad ao novo cliente rápido; se demorar, `off` |
| responsável não consegue abrir o cliente pelo qual responde (previsto em `atencao.responsaveisForaDoSquad` mas não corrigido) | chamado | avaliar: corrigir o vínculo (mover cliente/pessoa) sem `off`, ou `off` se for muitos |
| queda de throughput / latência anômala nas rotas de carteira | monitor | investigar; `resolvePortfolioClientes` é O(1) por índice parcial — não deveria pesar |
| dúvida | — | na dúvida, `off`. É reversível em segundos e não perde dado. |

**Reversão nunca apaga dados:** `off` + restart volta ao comportamento legado.
`squads`, `squad_members`, `cliente_squad_history`, `cliente_responsaveis`
permanecem. Religar = `on` de novo (idempotente).

---

## Métricas úteis (dívida honesta: parte não existe ainda)

| Métrica | Existe? | Onde |
|---|---|---|
| estado do flag no boot | ✅ | log `[squads] enforcement=…` |
| `clientes sem squad`, `internos sem membership`, `auditoria.pronto` no boot | ✅ | mesma linha de log |
| 403 de carteira em runtime | ✅ (log, sem contador) | `[carteira] acesso negado (…): user=… role=…` |
| **contador de "403 de carteira por dia"** | ❌ | RELEASE CANDIDATE §9 — "sinal mais útil durante o canário", registrado como **pré-requisito desejável, não bloqueante** |
| `/me/portfolio` retornando vazio para interno | parcial (via chamado) | considerar um alerta simples antes do canário |

**Recomendação de pré-flight:** antes da FASE 3, adicionar um contador simples
de 403 de carteira (log estruturado agregável ou métrica) — é o sinal nº 2 da
tabela de aborto e hoje depende de leitura manual de log. É trabalho de backend
pequeno, **fora deste pacote de docs**, mas deve entrar no escopo de quem
executar P2.9.
