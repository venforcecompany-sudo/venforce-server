# Unificação de Clientes — inventário e planejamento sem executor

`Cliente = empresa/carteira`; `ClienteConta = operação`. A ferramenta não decide
empresa, não conecta ao banco em `--plan`/`--validate`, não produz COMMIT nem
executa DML. Há dois componentes independentes: coleta SELECT direta e
planejamento offline sobre uma projeção sanitizada.

## Coleta opcional autorizada de leitura

Use um diretório privado NOVO, ignorado pelo Git. O coletor cria `.gitignore`
com `*`, abre conexão dedicada com `default_transaction_read_only=on`, confirma
o estado no servidor, limita statement/lock/connection timeout e executa apenas
SELECTs pré-definidos. Não importa serviços de aplicação, workers ou endpoints.
Nunca extrai valores de access/refresh token, password, JWT ou DATABASE_URL.
O arquivo de ambiente é entrada explícita; seus valores não aparecem na saída.

```bash
node server/scripts/unificacaoClientes/coletarSnapshot.js \
  --env-file /caminho/seguro/ambiente.env \
  --output-dir tmp/unificacao-clientes/coleta-nova
python3 server/scripts/unificacaoClientes/inventory.py \
  --snapshot tmp/unificacao-clientes/coleta-nova/snapshot.json
```

O inventário gera CSV/JSON e mapa completo por Cliente. É privado. Pode receber
`--historical-candidates caminho-privado.json` para preservar candidatos de
triagem anteriores abaixo do limiar atual, claramente pendentes. Nome/seller/
Squad e pontuação não aprovam fusão. Score é explicável e serve só à revisão.
As classes CERTO/NAO_UNIFICAR nunca são inferidas sem decisão objetiva externa.

As leituras são próximas no tempo, não transação longa com snapshot congelado.
Tabela com estimativa superior a 500 mil linhas não recebe contagem pesada:
`VOLUME_ESTIMATED_ONLY` registra a lacuna e bloqueia validação da dependência.
O snapshot contém catálogo completo de constraints/FKs/índices e projeções
agregadas de identidade; payloads/arquivos/consumidores externos não são
certificados por isso.

## Manifesto explícito, plan e validate

O exemplo abaixo é sintético, nunca um mapping real aprovado:

```json
{
  "clienteCanonicoId": 10,
  "clientesLegados": [20],
  "contas": [
    {"clienteContaId": 30, "clienteOrigemId": 20, "clienteDestinoId": 10}
  ],
  "decisaoEmpresarial": {"aprovada": false, "evidencia": null, "aprovador": null},
  "estrategiaUrls": "MANTER_SLUG_LEGADO_COM_LOOKUP"
}
```

```bash
node server/scripts/unificacaoClientes/cli.js --plan \
  --manifest tmp/unificacao-clientes/piloto-01/manifest.json \
  --snapshot tmp/unificacao-clientes/snapshot.json \
  --output tmp/unificacao-clientes/piloto-01/plan.txt
node server/scripts/unificacaoClientes/cli.js --validate \
  --manifest tmp/unificacao-clientes/piloto-01/manifest.json \
  --snapshot tmp/unificacao-clientes/snapshot.json \
  --output tmp/unificacao-clientes/piloto-01/validate.txt
```

Plan calcula mudanças virtuais e preimages por PK, FKs transitivas, volumes por
Conta/Cliente, referências lógicas, UNIQUEs, Grants, Bases, Squad, responsáveis,
ACL Seller e histórico. Mantém os Clientes/IDs/slugs antigos; não prevê DELETE
ou atribuição automática de Grant/Base NULL. Grant NULL exato Cliente/seller
pode conservar o vínculo NULL. Base NULL requer decisão de mapping antes de
mover a operação; Base de operação manual pode estar ausente, sem inventar custo.

Validate verifica origem/destino/Conta, estados de idempotência, seller/Grant/
Base, atividade/marketplace, ACL, colisões de identidade, catálogo/PK/cobertura,
prova de leitura e idade do snapshot (até 24h). UNIQUEs não modeladas exigem
`uniqueRevisadas: {aprovada:true, evidencia:"ensaio identificável em cópia"}`;
referências lógicas exigem `referenciasLogicasRevisadas` com evidência. Histórico
redundante exige política por tabela em `politicasHistorico` com valor
`PRESERVAR_ORIGEM_COM_LOOKUP`. São declarações verificáveis/aprovadas externamente,
não certificação automática de aliases/JSON/financeiro. O lookup ainda precisa
existir/testar no código futuro antes de movimento real.

Estados: `NAO_MIGRADO`, `JA_MIGRADO`, `PARCIALMENTE_MIGRADO`, `CONFLITO`. Estados
parciais/conflitantes recusam; já migrado não reaplica mudanças. Nenhuma
preferência `is_primary` é mudada implicitamente para resolver UNIQUE.

Códigos de saída: plan válido sintaticamente `0` (mesmo se o cenário estiver
bloqueado); validate seguro para **ensaio em cópia** `0`; validate bloqueado `2`;
argumento/input inválido `64`. `--apply`, `--execute`, `--commit` e modo misto
são rejeitados. A ferramenta ignora DATABASE_URL em plan/validate porque não
importa driver de banco. Erros não imprimem conteúdo bruto do input.

## Rollback e limite de prontidão

Plan inclui `rollback` gerado pela inversão de before/after por PK, hash do
snapshot/manifesto e versão observada da linha. Preimages nunca incluem
credenciais. O plano reverso não é executor nem backup. Requer backup/PITR,
precondições de versão, coordenação aprovada de writers, ensaio de ida/volta,
comparação financeira/ACL e política para writes posteriores ao lote.

`writeCapability:false` e `productionReady:false` são permanentes nesta versão,
mesmo quando validate retorna `VALIDO_PARA_ENSAIO_EM_COPIA`. Aprovações humanas
não habilitam escrita. A ausência de erro estrutural não valida token online,
empresa real, payloads nem efeitos de integração externa. Antes de produção,
recoletar estado vivo, implementar/testar lookup e executor em PR próprio e
obter autorização específica. Nenhuma migration é exigida/aplicada pela ferramenta.
