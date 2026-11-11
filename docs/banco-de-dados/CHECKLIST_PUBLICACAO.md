# Checklist curto — implantação e rollback

`[A]` = autorização própria. Nada abaixo foi executado em produção.

## Antes do PR
- [x] Branch `feat/pg-reorg…`, worktree limpa, código validado em `eabaeef2` (depois só docs); merge de teste com `origin/main` sem conflitos; suíte = só as 4 falhas preexistentes.
- [ ] No dia: `git fetch` + rebase/merge na `main` e rerodar a suíte (esperado: as mesmas 4).

## Deploy (flags ausentes — ver `PR_E_IMPLANTACAO.md`)
- [ ] [A] merge + deploy. Conferir: app sobe; Painel, Central, Cliente 360, Margem e Sentinel abrem para 1 cliente; o próximo sync noturno conclui com `persistencia.formato = "completo"`.
- [ ] Confirmar que a retenção NÃO roda: `RETENCAO_AUTO` e `RETENCAO_APPLY` ausentes.

## Ativação
- [ ] [A] `…PERSISTENCIA_ENXUTA=true` → validar 1–2 contas.
- [ ] [A] migration `20261111_central_vendas_import_pedidos.sql` (manual) → restart → `SELECT to_regclass('central_vendas_import_pedidos')` não nulo.
- [ ] [A] `…REUSO_PEDIDOS=true` + `…REUSO_CONTAS=<1–2 contas>`; manhã seguinte: `gravados.vinculos > 0`, telas da conta idênticas ao dia anterior.
- [ ] Saber em que período está (read-only): `SELECT COUNT(*) FROM central_vendas_import_pedidos;` (0 = período A).

## Rollback — PERÍODO A (nenhum vínculo gravado: flags de reuso desligadas ou antes da 1ª gravação)
- Flag: remover a variável (ou a conta da lista).
- Deploy: redeploy da versão anterior (sem dependência de schema).
- Migration: se `COUNT(*) = 0`, `DROP TABLE IF EXISTS central_vendas_import_pedidos` [A].

## Rollback — PERÍODO B (após a 1ª gravação com reuso: existem vínculos)
- Flag: tirar a conta de `REUSO_CONTAS` / remover `REUSO_PEDIDOS`. **Manter o código novo**: os leitores novos continuam completos e os imports vinculados seguem legíveis.
- **NÃO** fazer redeploy da versão anterior: o código antigo lê só linhas próprias e mostraria pedidos/valores **incompletos** nos imports vinculados.
- **NÃO** dropar a tabela de vínculos (apagaria a ligação dos pedidos reaproveitados).
- **NÃO** rodar retenção (manual ou auto): proibida e recusada pela trava S3. Não há rotina de "desvinculação" testada; voltar ao código antigo exigiria antes materializar os vínculos ou refazer os imports (sync) — decisão separada [A].
- Diagnóstico (read-only): `server/sql/observabilidade/reuso_vinculos.sql` ou o Raio-X do cliente.

## Sempre
- Retenção (manual/auto) PROIBIDA com vínculos até S1+S2+S4 (`09_RETENCAO_X_REUSO_ESPECIFICACAO.md`); a trava de planilhas legacy da main também depende da frente de retenção.
- Leituras em produção (Raio-X `--real`, `mp_redundancia.sql`, relatório de armazenamento) exigem autorização e janela fora do pico.
