# Contrato S1.5: operação automática e observabilidade

Este contrato é compartilhado entre o runtime (worker) e a leitura (API). **Não altere sem ajustar os dois lados.**

## 1. Sem migration nova

Tudo usa a tabela `sentinel_conciliacao_controle (chave TEXT PK, pausado_ate TIMESTAMPTZ, ocorrencias INT, motivo TEXT, atualizado_em TIMESTAMPTZ)`. Ela foi criada pela migration 20261119, que já está aplicada em produção.

- Cada chave tem uma linha só, com tamanho constante e sem crescimento. Nenhum evento é gravado por pedido nem por ciclo.
- `motivo` guarda JSON serializado, limitado a 4000 caracteres e sem tokens, URLs ou dados pessoais.
- Se as tabelas da 20261119 não existirem (`conciliacaoSchemaPronto` = false), o worker **não grava** heartbeat nem agenda, e a leitura devolve `disponivel:false`. Nunca lança.

| chave | quem grava | `pausado_ate` | `ocorrencias` | `motivo` (JSON) | `atualizado_em` |
|---|---|---|---|---|---|
| `billing_429` | coletor (já existe) | pausa global por 429 | 429 seguidos | texto livre (já existe) | — |
| `worker_processo` | `workers/sentinelWorker.js` | NULL | número de boots (incrementa a cada boot) | ver §2 | último heartbeat |
| `billing_agenda` | agendador do Billing no worker, **dentro do lock da conciliação** | próxima execução devida (não executar antes) | execuções seguidas com falha ou aborto (0 depois de uma concluída) | ver §3 | fim da última execução |

## 2. `worker_processo.motivo`

```json
{
  "v": 1,
  "instancia": "<RENDER_INSTANCE_ID || hostname-pid>",
  "commit": "<RENDER_GIT_COMMIT[0:12] || null>",
  "pid": 123,
  "iniciadoEm": "ISO",
  "heartbeatEm": "ISO",
  "encerradoEm": null,
  "encerramento": null,
  "memoria": { "rssMb": 80, "heapUsedMb": 30 },
  "polling": {
    "habilitado": true, "contas": [3, 41, 86], "intervaloMs": 180000,
    "ultimoCicloEm": "ISO|null", "ultimoCicloMs": 9000, "ultimoCicloPedidos": 150,
    "ultimoCicloEstado": "concluido|pulado|abortado|erro|sem_contas|null",
    "ultimoCicloErro": "texto sanitizado|null",
    "falhasSeguidas": 0,
    "falhaBoot": null
  },
  "billing": {
    "habilitado": false, "contas": [], "intervaloMs": 21600000,
    "emExecucao": false, "ultimaVerificacaoEm": "ISO|null"
  },
  "anterior": { "instancia": "...", "commit": "...", "heartbeatEm": "ISO", "encerramento": "limpo|null" }
}
```

- `encerramento` pode ser `null` (rodando) ou `"limpo"` (SIGTERM/SIGINT tratado).
- `anterior` é uma cópia do dono anterior, feita no boot.

**Posse da linha.** O boot faz upsert e assume a linha: grava `instancia` e copia o dono anterior para `anterior`. O `anterior` fica **preservado do banco** em cada heartbeat. Ao encerrar, o dono antigo, que já não é dono, grava `anterior.encerramento = "limpo"` na linha do novo. Assim, uma sobreposição de deploy ou um restart por troca de variável não parece reinício inesperado. Heartbeats e o encerramento só atualizam `WHERE motivo::jsonb->>'instancia' = <minha instância>`. Na sobreposição de deploy, a instância antiga para de escrever assim que a nova assume.

**Heartbeat.** É gravado no boot, no fim de cada ciclo de polling, no fim de cada execução do Billing e no encerramento limpo. Na falta de outros eventos, também a cada `SENTINEL_HEARTBEAT_MS` (padrão 180000 e mínimo 60000), para que um worker só com Billing também pareça vivo.

**Encerramento inesperado (heurística da leitura).** Acontece quando o boot atual tem o **mesmo commit** do anterior e o anterior não tem `encerramento:"limpo"`, ou seja, o processo reiniciou sem deploy, o que indica crash ou OOM. Com commit diferente, é deploy.

## 3. `billing_agenda.motivo`

```json
{
  "v": 1,
  "execucaoId": "b-<epochms>-<rand4>",
  "instancia": "...",
  "inicioEm": "ISO", "fimEm": "ISO", "duracaoMs": 1234,
  "resultado": "concluida|concluida_com_falhas|abortada|pausa_429|parada_solicitada|erro",
  "chamadas": 9, "gravados": 6, "parou429": false,
  "contas": [ { "contaId": 41, "candidatos": 2, "chamadasBilling": 1, "chamadasDescontos": 2, "gravados": 2, "falhas": 0, "parada": null } ],
  "erro": null,
  "intervaloMs": 21600000
}
```

- **Execução dentro do lock.** Ela adquire o lock da conciliação (`vf:sentinel:conciliacao`) e **relê** `billing_agenda.pausado_ate` dentro dele. Se ainda não estiver devida, retorna `nao_devida` sem chamar o ML e sem gravar. Isso evita execução dupla entre duas instâncias.
- **Fim da execução.** Ao terminar, grava a agenda ainda dentro do lock: `pausado_ate = fim + intervaloMs`. Em caso de `pausa_429`, usa o maior valor entre o fim da pausa e `fim + intervalo`.
- **Lock ocupado.** Uma execução pulada por lock ocupado **não** grava nada.
- **Nunca gravados na agenda:** `schema_ausente`, `sem_contas` e `sem_contas_ativas`, que acontecem antes do lock, e `abortada`, quando o lock foi perdido.
- **Regras de `ocorrencias`, ajustadas na integração e na revisão:**

  | Resultado | Efeito em `ocorrencias` | Próxima execução |
  |---|---|---|
  | `concluida` | zera | normal |
  | `concluida_com_falhas` (alguma conta parou por motivo que não é rotina, como 403, token, 5xx, `errors[]` ou erro interno) | **incrementa** | normal |
  | `pausa_429` | incrementa | regra de §3 |
  | `erro` | incrementa | normal |
  | `parada_solicitada` (SIGTERM ou deploy) | **mantém** | `fim + min(intervalo, 10 min)`, para não empurrar a fila 6 h |

## 4. Flags do worker (todas desligadas por padrão)

| Variável | Efeito |
|---|---|
| `SENTINEL_WORKER_ENABLED` + `SENTINEL_CONTAS_ALLOWLIST` | polling (sem mudança) |
| `SENTINEL_CONCILIACAO_AGENDADA_ENABLED=true` + `SENTINEL_CONCILIACAO_CONTAS` | **nova**: o worker existente agenda o Billing. É uma flag dedicada, então nenhuma variável antiga liga o Billing no deploy. |
| `SENTINEL_CONCILIACAO_INTERVAL_MS` | intervalo (padrão 6 h, mínimo 10 min) |
| `SENTINEL_CONCILIACAO_DB_POOL_MAX` | pool PRÓPRIO do Billing (padrão 1), mais a conexão do lock |
| `SENTINEL_CONCILIACAO_ADIAR_MAX_MS` | quanto o Billing espera um ciclo de polling em curso terminar (padrão 120000) |
| `SENTINEL_HEARTBEAT_MS` | heartbeat (padrão 180000) |

Os demais limites seguem `configConciliacao` (orçamento por execução e por conta, prazo, lote).

## 5. Leitura (API)

`GET /sentinel/operacao` é somente leitura e autenticado com o mesmo gate do Sentinel. Os dados por conta seguem a carteira do usuário. Ver `services/sentinel/sentinelOperacao.js`.
