# PR e ordem de implantação — `feat/pg-reorganizacao`

Compatível com a `main` atual (verificado em `3504b1ac`: a main só mexeu em `Portal/vf-shell*`; zero
arquivos em comum, zero conflitos na simulação de merge). Nada foi enviado ao remoto.

## Título
`feat(banco): reorganização do PostgreSQL — reuso de pedidos, trava de retenção e Raio-X visual (flags desligadas)`

## Descrição (resumo)
- **Sync da Central**: persistência enxuta + reuso de pedidos inalterados por conta (−83% em PG local sintético). Tudo opt-in; migration manual `20261111_central_vendas_import_pedidos.sql` (não entra no boot).
- **Leitores** (Central, Margem, Painel, Cliente 360) entendem vínculos; sem a tabela rodam o SQL de antes. Checagem de existência propaga erro e nunca cacheia negativo (P1 da revisão).
- **Retenção**: trava S3 no executor (CLI e auto) recusa exclusões enquanto houver vínculo de reuso; correção S1/S2/S4 fica com a frente de retenção (`09_RETENCAO_X_REUSO_ESPECIFICACAO.md`).
- **MP**: flag de coleta (`CENTRAL_VENDAS_MP_PAYMENTS_COLETA_ENABLED`, ausente = ligada) + SQL de redundância.
- **Raio-X**: serviço read-only, CLI, métricas de armazenamento e **interface visual local** (`npm run raio-x`).
- Flags novas ausentes por padrão ⇒ **nenhuma mudança de comportamento em produção**.
- Testes: suíte com as mesmas 4 falhas preexistentes da main; PG local: 3 versões (175), isolamento por conta (29), trava S3 (25), Raio-X (23 + 29), unificação (68), retenção (11).

## Ordem de implantação (cada passo com autorização própria)
1. Rebase/merge na `main` e suíte completa → PR → merge → deploy **com flags ausentes**. Verificar telas e o próximo sync noturno (`persistencia.formato = "completo"`).
2. (Opcional, leitura) Raio-X `--real` e `mp_redundancia.sql` fora do pico, para medir a base real.
3. `CENTRAL_VENDAS_SYNC_PERSISTENCIA_ENXUTA=true`; validar 1–2 contas.
4. Aplicar a migration manualmente → restart → `CENTRAL_VENDAS_SYNC_REUSO_PEDIDOS=true` + `_CONTAS=<1–2 contas>` (piloto **sem limpeza**; retenção segue desligada e a trava S3 a recusa).
5. Ampliar contas → `*`.
6. Só depois de S1+S2+S4 na `main` (e `GUARDA_VINCULOS=true`): retenção em contas com reuso.
7. Decisão separada: `CENTRAL_VENDAS_MP_PAYMENTS_COLETA_ENABLED=false` e retenção do MP (`08_`).

Reversão: remover a variável / tirar a conta da lista; imports com vínculo seguem legíveis. Deploy: redeploy da versão anterior (sem dependência de schema).
