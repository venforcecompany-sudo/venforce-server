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
