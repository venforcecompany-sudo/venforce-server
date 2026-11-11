# Retenção × reuso de pedidos — proibição e especificação para o agente da retenção

Esta missão **não** alterou `~/venforce-dev/wt-retencao-manuais`, não executou
limpeza e não repetiu dry-run em produção. Este documento (a) registra a
proibição operacional, (b) lista os caminhos que podem apagar imports e (c)
entrega a especificação exata da correção, para o agente da retenção.

## 1. PROIBIDO (vale até a Etapa 1 da seção 5 estar na `main`)

Para **qualquer escopo que contenha import em modo reuso**
(`reuso_vinculos.sql` devolve linhas para ele):

- **Retenção automática** (`CENTRAL_VENDAS_RETENCAO_AUTO=true`): proibida.
- **Retenção manual** (`scripts/central-vendas-retencao.js --apply`): proibida.
  Dry-run continua permitido (só SELECT).
- Na prática, enquanto o reuso estiver ligado para **qualquer** conta, `--apply`
  só pode ser usado com `--conta=<id>` explícito de uma conta **fora** de
  `CENTRAL_VENDAS_SYNC_REUSO_CONTAS` e que **nunca** teve reuso (conferir com
  `server/sql/observabilidade/reuso_vinculos.sql` — read-only; vazio para a conta).
- DELETE/TRUNCATE manual em `central_vendas_imports|pedidos`: proibido.

## 2. Caminhos que apagam imports/pedidos (verificado no código)

| Caminho | Conhece vínculos? | O que impede o estrago |
|---|---|---|
| Executor da retenção — `aplicarLoteImports` (`DELETE FROM central_vendas_imports`), chamado por **CLI `--apply`** e pelo **modo auto** (`centralVendasRetencaoAuto`) | **Não** | só a FK (23503) e `RETENCAO_AUTO` desligada |
| Purge de cliente / exclusão em cascata (`DELETE clientes`) | irrelevante (dono e referenciadores saem juntos no mesmo comando) | teste local: passa sem órfãos |
| Unificação de contas | tabela registrada como `PRESERVE_BY_PARENT` | 54 cenários PG |
| SQL manual de operador | não | FK |

Não há rota HTTP de retenção. **Nenhum caminho consulta os vínculos antes de
apagar**: o único bloqueio existente é a FK `pedido_row_id` (NO ACTION).

### O que a FK garante — e o que não garante

- Garante: **nenhuma linha em uso é perdida**, por nenhum caminho (inclusive SQL manual).
- **Não** garante retenção segura. Evidência (executor real, PG18 local,
  [`sync-noturno/retencao_x_reuso_experimento_pg18.json`](sync-noturno/retencao_x_reuso_experimento_pg18.json)):
  - o planner propõe os imports 1–3 (fornecedores de linhas do vigente 4);
  - o lote 1 aborta com `23503`; **o run inteiro para** (`motivoParada: ERRO`);
    lotes seguintes — de **outras contas** — não rodam;
  - a cada execução o planner repropõe os mesmos imports ⇒ retenção travada.
- **Export/restauração incompleta**: `exportarImportsCsv` exporta só linhas com
  `import_id = <import>`. Para um import que **referencia** linhas de outro, os
  vínculos (`central_vendas_import_pedidos`) não vão ao CSV e somem por CASCADE
  ao apagá-lo ⇒ o import apagado **não pode ser reconstruído** da exportação.

## 3. Especificação da correção (código da retenção)

Arquivos: `services/centralVendas/retencao/centralVendasRetencaoRepository.js`,
`…Planner.js`, `…Executor.js`, `scripts/central-vendas-retencao.js`.

**S3 — trava global (Etapa 1).** Em `executarRetencao`, quando `apply === true`
(CLI e auto passam por aqui), **antes** do plano:
```js
const GUARDA_VINCULOS = false; // vira true só quando S1+S2+S4 estiverem na main
if (!GUARDA_VINCULOS) {
  const { rows } = await pool.query(`SELECT to_regclass('public.central_vendas_import_pedidos') IS NOT NULL AS t`);
  if (rows[0].t === true &&
      (await pool.query(`SELECT EXISTS (SELECT 1 FROM central_vendas_import_pedidos) AS e`)).rows[0].e) {
    throw erroComCodigo("REUSO_ATIVO_SEM_GUARDA", "Retenção recusada: há imports em modo reuso (vínculos) e o planner ainda não os protege");
  }
}
```
Erro na consulta **propaga** (nunca assume "sem vínculos"). Cobre manual e auto.

**S1 — planner protege fornecedores (Etapa 2).** `carregarImports` (inclusive no
caminho `forUpdate`) passa a trazer, por import:
```sql
EXISTS (SELECT 1 FROM central_vendas_import_pedidos v
          JOIN central_vendas_pedidos p ON p.id = v.pedido_row_id
         WHERE p.import_id = i.id AND v.import_id <> i.id) AS fornece_a_outros
```
`planejarRetencao` trata `fornece_a_outros = true` como **protegido** (motivo
`FORNECE_PEDIDOS_A_OUTRO_IMPORT`), igual a "vigente". O replano dentro de
`aplicarLoteImports` (após `FOR UPDATE`) usa a mesma coluna. Um import só fica
elegível quando nenhum **outro** import ainda usa suas linhas (dono e
referenciadores no mesmo lote são apagados juntos — a FK é checada ao fim do comando).

**S2 — 23503 deixa de parar o run (Etapa 2).** Em `executarRetencao`, `23503` no
lote ⇒ tentar de novo import a import (ou bisseção) com SAVEPOINT; o que falhar
vira `desistido: fornece_pedidos` e a execução **segue** para os demais lotes.

**S4 — export/restauração (Etapa 2).** `exportarImportsCsv` passa a gravar também
`<prefixo>-vinculos.csv` = `SELECT * FROM central_vendas_import_pedidos WHERE import_id = ANY(alvo)`.
Linhas de pedido/itens/componentes continuam exportadas por `import_id` (inclui o `id`).
Restauração: ordem **imports → pedidos → itens → componentes → vínculos**,
preservando os `id` do CSV (os vínculos apontam para `pedido_row_id`); restaurar
primeiro o import dono e depois o que o referencia. Atualizar `RETENCAO.md` e a
contagem do lote (`contarFilhosPorImport` passa a informar `vinculos`).

## 4. Testes exigidos (no PG local, mesmo padrão de `centralVendasRetencaoPostgres.test.js`)

1. **S3**: com ao menos 1 vínculo, `apply` (CLI e `autorizacao: "auto"`) recusa com `REUSO_ATIVO_SEM_GUARDA`; sem vínculo, comportamento atual; erro na consulta propaga; dry-run não é afetado.
2. **S1**: tupla com vigente que referencia linhas de 1..3 ⇒ plano **não** propõe 1..3 (motivo `FORNECE_PEDIDOS_A_OUTRO_IMPORT`); propõe quando o referenciador também é elegível (par apagado junto); import sem vínculos segue como hoje.
3. **S2**: lote com um fornecedor + outras contas elegíveis ⇒ as outras contas são limpas, o fornecedor é `desistido`, `motivoParada = CONCLUIDO`.
4. **S4**: export→DELETE→restore reproduz imports, pedidos, itens, componentes e vínculos idênticos (contagens e checksums); leitor da Central devolve o mesmo para o import restaurado.
5. Corrida: sync gravando vínculos para linhas de um import enquanto o lote o apaga ⇒ nenhuma linha em uso é removida (FK) e nenhum vínculo órfão.

## 5. Ordem de liberação

| Etapa | Conteúdo | Libera |
|---|---|---|
| **1** | S3 na `main` (+ esta proibição vigente) | **piloto do reuso em 1 conta** |
| **2** | S1 + S2 + S4 na `main`; `GUARDA_VINCULOS = true` | retenção (manual e auto) em contas com reuso |
| 3 | GC de imports superados em modo reuso (apagar vínculos do superado + versões sem referência) | longo prazo |

Veredito desta missão: **a Etapa 1 não existe na `main` nem nesta branch ⇒ piloto:
NO-GO** (ver `PENDENCIAS_E_ROLLOUT.md`).
