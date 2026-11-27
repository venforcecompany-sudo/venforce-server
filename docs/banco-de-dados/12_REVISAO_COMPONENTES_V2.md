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
| B2 retenção (onda 3) × reuso | — | — | — | — | **decidido 27/11: retenção histórica adiada**; prioridade é parar o crescimento (reuso + compacto). Trava S3 intocada | nenhuma; não rodar retenção enquanto o reuso estiver ligado |
| B3 leitura de valores pela `raiox_ro` | ✓ | ✓ ciclo | — | — | concessão temporária autorizada 27/11; SQL conferido contra os privilégios reais de produção (a revogação devolve exatamente `pedidos(id, import_id)`); ciclo concede→revoga provado em PG local | aplicar como admin na janela de R1/C0 e revogar no mesmo dia |
| B4 estado real de produção | ✓ | ✓ | ✓ 27/11 | — | leitura de 27/11 (§7.1): tabela compacta ausente, vínculos do reuso presentes, banco 5,3 GB, componentes 2,5 GB; **sync noturno sem rodada da carteira desde 10/11** | religar o noturno é pré-requisito da fase R (achado, fora desta frente) |
| B5 migration 20261126 | ✓ | ✓ | — | ✓ | idempotente (aplicada 2× em PG local), transação com `lock_timeout` 5 s, manual (fora do boot), `CHECK formato IN (1,2)` | aplicar na fase C1 (doc 11) |
| Composição promocional no motor (flag) | ✓ | ✓ | — | ✓ desligada | formato 2; resultado, totais e pendências idênticos com a flag ligada | ligar só depois da validação real |
| Rebate comprovado (Discounts + Billing) | parcial | ✓ | ✓ 10 pedidos | — | §7.2: comissão da Central = `sale_fee` = Billing `net` em 10/10; rebate já incorporado; crédito comprovado 0; nenhuma diferença financeira. Coleta no sync ainda não existe (doc 13 §5.1) | conta complementar com multi-item, quantidade > 1 e Full antes de ligar a composição |
| Custo por variação (L1) | ✓ comparador | ✓ | ✓ | — | §7.3: conta piloto 587/587 itens iguais, ΔCMV 0; **nenhuma base ML de produção tem MLB com custos diferentes** (0 conflitos) | manter a regra; reavaliar só se uma base passar a ter custo por variação |
| Ads e Full na Central | ✓ | ✓ | ✓ caches | ✓ | caches reais conferidos (§7.4); estados consolidado/provisório/parcial/indisponível (doc 14 §5.1); Ads da janela das vendas por conta atrás de `CENTRAL_VENDAS_ADS_JANELA` (desligada) | ligar a flag na conta piloto junto com o noturno |
| Detalhamento do pedido (drawer) | ✓ | ✓ | — | ✓ | seções novas com as classes existentes; sem composição, o HTML é igual ao anterior | conferir 3 pedidos na tela depois do deploy |
| Desempenho | ✓ | ✓ medido | — | ✓ | `buildPedidos` 16,3 s → 53 ms (3 mil pedidos); seleção de imports 966 ms → 0,8 ms (45 imports de 3,9 MB); detalhe +2 leituras por chave + 14 ms de assinatura (20 mil linhas) | — |

Achados de precisão pré-existentes, medidos em produção em 27/11 (§7.5).
Nenhuma fórmula mudou:

- **Reembolso parcial**: lacuna REAL. Pedidos `partially_refunded` ficam no resultado com a receita cheia e o reembolso (gravado como `cancelamento_reembolso`) não é abatido. Out–nov: 32 pedidos com resultado em 13 contas, R$ 1.731,44 não abatidos. Decisão pendente: provar quem bancou o reembolso.
- **Imposto**: sem efeito hoje. Todas as linhas ML estão em fração entre 0,03 e 0,30 (ou 0); nenhum valor = 1 ou > 1.
- **Cupom do vendedor**: sem efeito na receita. O cupom está dentro de cheio → pago, e a receita já é o preço pago (2 casos reais).
- **Ajuste de plataforma (planilha)**: sem efeito hoje. Desde setembro só há imports da API; resíduo 0 em 59.186 pedidos.


## 7. Validação com dados reais (27/11)

Autorizada pelo responsável:
- conta piloto ML, identidade e elegibilidade conferidas: conta principal do cliente, seller presente, grant válido;
- até 25 chamadas ao ML, sem refresh, sem gravação no banco, parada em limite;
- sessão de banco forçada em READ ONLY (`default_transaction_read_only=on`).

Evidências brutas fora do repositório, que é público (backups locais do responsável).

### 7.1 Estado de produção (B4, só leitura)

| item | valor |
|---|---|
| banco | 5,3 GB de 10 GB |
| `central_vendas_componentes` / `_pedidos` / `_pedido_itens` | 2,5 GB / 0,9 GB / 0,9 GB |
| `central_vendas_pedido_componentes` (migration 20261126) | ausente, como esperado |
| `central_vendas_import_pedidos` (reuso, 20261111) | presente |
| imports publicados por dia | 62–71 contas/dia de 07 a 10/11; **1–5/dia desde 11/11** |
| `raiox_ro` | existe, READ ONLY, 8 s, 2 conexões, sem leitura de valores |

O sync noturno da carteira não roda desde 10/11. É pré-requisito para a fase R e para o Ads da janela, porque ambos dependem do noturno. O motivo fica fora desta frente.

### 7.2 Rebate, descontos e comissão

22 chamadas: 1 busca de 50 pedidos, para escolher a amostra sem gastar orçamento; 10 `/orders/{id}`; 1 Billing em lote; 10 Discounts. Nenhum 429.

| grupo (pedidos) | o que o ML mostrou | estado | Central × ML |
|---|---|---|---|
| cofinanciado ML (2) | comissão bruta 17,50, líquida 10,00, rebate 7,50; desconto 45,00 (vendedor 37,50, ML 7,50) | 1 CONCILIADO (crédito 0, rebate já incorporado); 1 PARCIAL por cashback, mesmos números | tarifa = `sale_fee` = `net` |
| desconto só do vendedor (3) | rebate 0, comissão bruta = líquida | CONCILIADO | igual |
| cupom (2) | cupom dentro de cheio → pago, todo do vendedor | PARCIAL (`cupom_nao_validado`) | igual |
| comissão com tarifa fixa (1) | 24% (preço abaixo do mínimo) | CONCILIADO | igual |
| cancelado com cupom (1) | sem cobranças de tarifa no Billing | PARCIAL | Central grava a tarifa do pedido; fora do resultado |
| controle (1) | cashback | PARCIAL | igual |

Conclusão:
- o rebate **já está incorporado** à comissão que a Central usa;
- somá-lo seria dupla contagem;
- não houve nenhum caso de diferença financeira (crédito comprovado = 0);
- a amostra não tem multi-item, quantidade > 1 nem Full. É preciso uma conta complementar.

### 7.3 Custo por variação (L1)

| medida | valor |
|---|---|
| base da conta piloto | 322 linhas, nenhuma com `id_model` ou SKU |
| itens comparados (60 dias) | 604: 587 iguais, 17 sem custo nas duas regras |
| ΔCMV | 0 |
| produção inteira: MLB com 2+ custos ou impostos diferentes na mesma base | **0** (39.290 linhas MLB) |

A regra "primeiro custo do MLB" não muda nenhum número hoje.

### 7.4 Ads e Full (caches reais)

Conta piloto, novembro:
- cache do Financeiro: R$ 766,32, consultado em 10/11 de manhã, ou seja, com parte do dia 10;
- sync noturno: R$ 747,56 até 09/11, mas só a soma do cliente em `ads_resumos_mensais`;
- nenhum cache de Full.

Pela regra corrigida, o cache de 10/11 é `incompativel` com vendas de 01 a 09/11. Por isso entrou o Ads da janela (doc 14 §4): com a flag, o mês aberto fica **parcial**, com Ads abatido como provisório e Full declarado como faltando.

### 7.5 Precisão: exemplos reais (sem mudança de fórmula)

Reembolso parcial: 3 pedidos reais de quantidade 1, valores em R$.

| receita | custo | frete | tarifa | imposto | resultado atual | reembolso | proposto | diferença |
|---|---|---|---|---|---|---|---|---|
| 1.056,23 | 549,00 | 79,35 | 72,73 | 0,00 | 355,15 | 31,69 | 323,46 | −31,69 |
| 176,48 | 108,00 | 26,35 | 21,18 | 13,24 | 7,71 | 12,35 | −4,64 | −12,35 |
| 39,00 | 17,07 | 8,95 | 4,37 | 3,90 | 4,71 | 1,95 | 2,76 | −1,95 |

Total de out–nov:
- resultado atual dos 32 pedidos: R$ 1.352,53;
- proposto: −R$ 378,91;
- 26 pedidos viram negativos.

Nenhum desses pedidos tem claim. Em produção não há `mp_payments` para provar quem bancou o reembolso. Proposta, a decidir:
1. abater o `cancelamento_reembolso` dos pedidos que ficam no resultado (`partially_refunded`), atrás de flag;
2. antes, validar 2–3 pedidos da conta com mais casos: payment/refund e Billing.

Isso exige autorização de chamadas nessa conta.

## 8. Revisão de publicação (27/11)

| verificação | resultado |
|---|---|
| compatibilidade com a `main` atual (`c129922e`) | merge sem conflito; nenhum arquivo em comum com o que a `main` mudou desde a base |
| suíte sobre o merge (branch + `main`) | unit: as mesmas 4 falhas da `main` pura (basesTiktok, designStudioWorkspace, meliAnunciosOrdenacaoGlobal, mlTokenService). Portal: as mesmas 7 da `main` pura (anuncios-meli ×4, financeiro-v3-shell, vf-admin-nav-restore, vf-ui) + 1 instável nas duas árvores (squads-config-redesign, `Invalid InterceptionId` do Chrome em 1/3 na `main` e 2/3 no merge) |
| PG local na branch | compactos 14, Ads/Full 13, 5 modos 392, validador de rebate 6, trava do reuso 25, isolamento do reuso 29, Raio-X 23 + 57, retenção 3 + 11 |
| flags novas, todas desligadas sem variável | `CENTRAL_VENDAS_COMPONENTES_COMPACTOS(_CONTAS)`, `CENTRAL_VENDAS_COMPOSICAO_PROMOCIONAL(_CONTAS)`, `CENTRAL_VENDAS_ADS_JANELA(_CONTAS)`; as do reuso já existiam e continuam desligadas |
| migration no boot | nenhuma: `index.js`, `schemaEnsure` e `central_vendas_schema.sql` sem diff; a 20261126 é manual (fase C1) |
| efeito financeiro com flags desligadas | nenhum nos números: motor `deepEqual` e leitores iguais (5 modos). Sempre ligado, só aditivo: índice do `buildPedidos`, seleção de imports sem `payload_json`, `resumo.baseCustos` (1 consulta por run), `composicaoFinanceira` no detalhe e o bloco de Ads/Full (informativo, fora do resultado oficial) |

**Rollback**
- **Do deploy (flags desligadas):** publicar de novo o commit anterior. Não há mudança de schema, e os dados novos são chaves JSON aditivas (`resumo.baseCustos`) que o código antigo ignora.
- **Depois de ligar o reuso:** só a flag (rollback R, doc 11).
- **Depois da 1ª gravação compacta:** só a flag (rollback C). **Nunca** voltar o código para antes desta branch e **nunca** dropar as tabelas.
- **Ads da janela:** só a flag. Os registros no run ficam inertes.

**GO:** merge e deploy com todas as flags desligadas.

**NO-GO, até nova evidência ou decisão:**
- ligar reuso ou compacto antes do noturno da carteira voltar e das noites R3/R4;
- ligar a composição antes da conta complementar (multi-item, quantidade > 1, Full);
- mudar a fórmula do reembolso parcial antes de provar quem bancou;
- rodar retenção com o reuso ligado.
