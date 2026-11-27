# 12 — Revisão de segurança e arquitetura: componentes compactos (v2)

Revisão integral do diff da branch `feat/central-vendas-persistencia-componentes-v2`
contra `main` f5162f95, item a item do pedido de 26/11. Para cada item:
veredito, evidência e onde está no código.

## 1. Guia do diff para revisão independente

| commit | o quê | arquivos de produção |
|---|---|---|
| `feat(central-vendas): componentes compactos…` | formato v2: escrita por flag, leitura nos dois formatos | `centralVendasComponentesCompactos.js` (novo), `centralVendasRepository.js`, migration `20261126` |
| `perf(central-vendas): leitura compacta decodificada em JS…` | arrays crus em texto + ordem de grupos pelo banco + mescla em JS; guardas de escrita; PK `id` (Unificação); backup com literal de array | idem + retenção |
| `fix(resgate): …` | Resgate pela camada compartilhada (reuso + compactos) | `resgateLeituraRepository.js` |
| testes / ferramentas / docs | equivalência, bordas, restauração, benchmarks, validação real, rollout | `tests/`, `scripts/`, `sql/observabilidade/`, `docs/` |

Ordem sugerida de leitura:
1. `centralVendasComponentesCompactos.js`: `avaliarImport` → `montarLinhas` →
   `gravarCompactos` → `sqlCompactosCrus` / `sqlGrupos` / `gruposEmOrdem` /
   `mesclarComponentes` → `sqlUniao` (fallback);
2. `centralVendasRepository.consultarComponentes`;
3. `resgateLeituraRepository`;
4. retenção.

## 2. Itens revisados

| item | veredito | evidência |
|---|---|---|
| **Leitores SQL diretos incompatíveis** | resolvido para produção | varredura `grep -a` em `server/` e `Portal/`: todos os leitores de componentes passam por `consultarComponentes` / `carregarComponentesDosPedidos`. Restam só scripts pontuais: `sentinel-e0-paridade.js` (Sentinel, fora do escopo; lê só linhas antigas) e `sql/auditoria/…frete_pack.sql` (filtra imports anteriores a 28/10, portanto só linhas antigas). Os dois estão documentados |
| **Perda silenciosa de componentes** | protegido | escrita: `avaliarImport` (sem pedido, item sem linha, item de outro pedido, valor não numérico/NaN/∞, tipo/confiança inválidos → import inteiro em linhas); `montarLinhas` aborta se o pedido ou o item não tiver linha; `gravarCompactos` aborta se o INSERT gravar ≠ 1 linha por pedido. Leitura: `validarLinhaCompacta` (formato, dimensões), código NULL, texto ausente no dicionário e contagem da mescla → **erro** `COMPONENTES_COMPACTOS_CORROMPIDOS`, nunca omissão. Testes unitários + validador real (teste negativo: 1 centavo e 1 vínculo apagado detectados) |
| **Duplicação financeira** | protegido | mescla confere `saída = antigas + compactas`; Resgate usa `DISTINCT pedido_row_id`; C1 do validador (repetidos = 0); 392 verificações do teste de 5 modos |
| **Versionamento** | protegido | `formato = 1` com CHECK; regra de classificação M6 congelada (`REGRA_FORMATO_1`) e comparada ao ledger em teste; leitor recusa formato desconhecido |
| **Reuso** | compatível | o digest do reuso vem do objeto do motor, não do formato físico; pedido vinculado mantém o formato em que foi gravado; leitores mesclam. Teste `reuso_compacto` + validador em banco misto |
| **Integridade referencial** | ok, com 1 limite documentado | compactos: FK `pedido_row_id` → pedidos `ON DELETE CASCADE`, `UNIQUE` (1 por pedido). `item_row_ids` sem FK (array): consistência garantida na escrita (item do MESMO pedido) e conferida na leitura (grupo inexistente → caminho SQL). Itens só morrem com o pedido (CASCADE), então não há órfão |
| **Concorrência e atomicidade** | ok | compactos na MESMA transação de pedidos/itens (retry de 40P01 refaz do zero); dicionário em transação própria e curta, antes do import, ordem fixa, idempotente (texto sobrando é inofensivo) |
| **Retenção, backup, restauração** | ok | contagem e backup CSV levam compactos + dicionário (arrays como literal do PG, exatos); teste de restauração completa (CSV → banco → leitores idênticos); DELETE por CASCADE; trava S3 inalterada (fornecedor × referenciador do reuso: FK NO ACTION impede apagar o dono em uso; purge apaga tudo do cliente junto) |
| **Imports manuais** | ok | planilha sempre em linhas (`isEscritaCompactaHabilitada` exige `orders_api` + run); teste |
| **Rollback após a 1ª gravação compacta** | ok, com regra | flag off → próximos imports em linhas; compactos continuam lidos. **Proibido**: `DROP` das tabelas e publicar código anterior a esta branch (não leria os compactos). Doc 11 |
| **Unificação Clientes×Contas** | corrigido nesta revisão | a 1ª versão (PK `pedido_row_id`) viraria `CENTRAL_POLICY_DRIFT`; agora é PK `id` + `UNIQUE (pedido_row_id)`; validado rodando o teste de Unificação com a migration (sem drift; a tabela entra como filha preservada) |
| **Fórmulas financeiras** | inalteradas | nenhum arquivo de motor/serviço de cálculo no diff; mesmos resultados em todos os leitores |

## 3. Achados pré-existentes (não corrigidos; fora do escopo)

1. **Unificação já bloqueada em produção pelo reuso**: com a migration
   `20261111` (aplicada em 14/11), o planejador acusa `CENTRAL_POLICY_DRIFT`
   em `central_vendas_import_pedidos` (PK composta). Reproduzido com o código
   da `main`.
2. **Trava S3 global**: um vínculo em qualquer conta impede a retenção em
   todas (afeta a onda 3).
3. **Cliente 360 sem `ORDER BY` nos itens**: o SKU/título exibido por produto
   depende da ordem física. Unidades e faturamento são iguais; o rótulo pode
   variar com o reuso.
4. **Resgate, `vendasResumoConta.cobertura`**: ordena objetos `Date` como
   texto; pode devolver uma data de cobertura menor que a real.
5. **`buildPedidos` custa P×C**: filtra todos os componentes para cada pedido,
   cerca de 10 s para 3.000 pedidos no benchmark. Independe do armazenamento;
   indexar por `pedido_row_id` resolveria sem mudar fórmula.
6. **Toda leitura de período lê `imports.payload_json`** (`resolveImportsForRange`):
   no formato completo é o motorPayload inteiro, em TOAST. É candidato a
   ganho de leitura independente desta branch, e é a razão de o validador
   medir a Margem sem a seleção M4 (a `raiox_ro` não lê esse campo, de propósito).
7. **Escrita atual linha a linha** (1 INSERT por componente): já corrigido no
   caminho compacto (1 INSERT por import).

## 4. Bloqueadores restantes

| # | bloqueador | de quem | para |
|---|---|---|---|
| B1 | publicar esta branch (flags desligadas) **antes** de ligar o reuso: com a `main` atual, o Resgate perde os pedidos vinculados | revisão + merge + deploy [A] | R2 |
| B2 | decidir a ordem retenção (onda 3) × reuso (trava S3 global) | responsável | R2 |
| B3 | concessão de leitura de valores à `raiox_ro` (ou rodar a validação com outra role autorizada) | responsável / admin [A] | R1 (valores), C0 |
| B4 | reconfirmar o estado real (`rollout_estado`): nesta sessão não houve conexão ao banco | responsável [A: credencial] | R0 |
| B5 | migration 20261126 em produção | [A] | C1 |
| — | leituras filtradas por tipo +30–64% (Margem realizado, Resgate) | otimização futura; critério de latência no piloto | não bloqueia o piloto |

## 5. Veredito técnico

**GO para revisão independente e para a fase R (reuso), assim que B1 a B4
estiverem resolvidos.** **GO para a fase C (compactos) na mesma conta**
depois de R4 (7 noites verdes) e B5.
- **Contrato:** equivalência exata em todos os leitores, Resgate incluído,
  nos 5 modos e com formatos misturados.
- **Integridade:** falhas são explícitas; restauração do backup testada.
- **Armazenamento:** −77% nos componentes e −33% nas tabelas da Central sobre
  o reuso.
- **Escrita:** −59%.
- **Leitura:** a carga principal fica 18–28% mais rápida.

**Ainda NO-GO**: migrar o histórico, expandir para todas as contas sem passar
por C3/C4, e qualquer `DROP` depois da 1ª gravação compacta.

## 6. Revisão final (27/11) — estado para publicação

Revisão independente do trabalho de 26/11, com as correções locais.

Legenda:
- **I** implementado;
- **T** testado (unitário e PG local);
- **R** validado com dados reais;
- **P** pronto para produção.

| item | I | T | R | P | evidência | ação |
|---|---|---|---|---|---|---|
| B1 publicar a branch com flags desligadas | ✓ | ✓ | — | ✓ | 0 conflitos com `origin/main` (c129922e); nenhuma migration nova é aplicada no boot; flags desligadas ⇒ motor `deepEqual` e leitores iguais (5 modos, 392 verificações) | revisão, merge e deploy (seu) |
| B2 retenção (onda 3) × reuso | — | — | — | — | trava S3 global, deliberada, da frente de retenção; não alterada aqui | decidir a ordem: onda 3 antes de ligar o reuso, ou adiar a retenção |
| B3 leitura de valores pela `raiox_ro` | ✓ | ✓ | — | — | `componentes-v2/raiox_ro_paridade_central.sql` (revogável) | admin aplica, ou valida com outra role autorizada |
| B4 estado real de produção | ✓ | ✓ | — | — | `central_vendas_rollout_estado.raiox_ro.sql` | rodar com a `raiox_ro` |
| B5 migration 20261126 | ✓ | ✓ | — | ✓ | idempotente (aplicada 2× em PG local), transação com `lock_timeout` 5 s, manual (fora do boot), `CHECK formato IN (1,2)` | aplicar na fase C1 (doc 11) |
| Composição promocional no motor (flag) | ✓ | ✓ | — | ✓ desligada | formato 2; resultado, totais e pendências idênticos com a flag ligada | ligar só depois da validação real |
| Rebate comprovado (Discounts + Billing) | parcial | ✓ | — | — | o motor aceita evidências; a coleta no sync não existe (desenho no doc 13 §5.1); validador real pronto (`scripts/central-vendas-rebate-validar.js`) | autorizar `executar` em 1 conta com ~10 pedidos e teto de ~25 chamadas |
| Custo por variação (L1) | ✓ comparador | ✓ | — | — | `scripts/central-vendas-custo-variacao-comparar.js` (read only) | rodar na conta piloto e só então decidir a regra |
| Ads e Full na Central | ✓ | ✓ | — | ✓ | mesmas linhas de cache que o Financeiro grava (conta + slug), mesma consolidação; **corrigido**: cache consultado antes do fim do mês não cobre o mês inteiro | conferir com os caches reais depois do deploy |
| Detalhamento do pedido (drawer) | ✓ | ✓ | — | ✓ | seções novas com as classes existentes; sem composição, o HTML é igual ao anterior | conferir 3 pedidos na tela depois do deploy |
| Desempenho | ✓ | ✓ medido | — | ✓ | `buildPedidos` 16,3 s → 53 ms (3 mil pedidos); seleção de imports 966 ms → 0,8 ms (45 imports de 3,9 MB); detalhe +2 leituras por chave + 14 ms de assinatura (20 mil linhas) | — |

Achados de precisão pré-existentes, sem mudança de fórmula, para decisão:

- **Devolução parcial**: o pedido continua no resultado com a receita cheia, e o reembolso parcial não é abatido. As quantidades ficam gravadas.
- **Imposto**: a regra `> 1` × `≤ 1` (M5) continua como estava.
- **Cupom do vendedor**: não modelado; é exposto como sinal.
- **Ajuste de plataforma (planilha)**: sem componente próprio; o resíduo aparece no detalhe.
