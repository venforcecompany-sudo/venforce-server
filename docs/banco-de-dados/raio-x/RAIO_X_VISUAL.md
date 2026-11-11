# Raio-X visual (interface local, somente leitura)

## Como abrir
```bash
cd server
npm run raio-x                      # modo SINTÉTICO (sem banco, sem credenciais) → http://127.0.0.1:4777
```
Modo **real** (somente leitura) — só com URL explícita e autorização do host:
```bash
# banco local (descartável):
RAIO_X_DATABASE_URL='postgres://usuario_ro:***@127.0.0.1:5432/banco?sslmode=disable' npm run raio-x -- --real

# banco REMOTO (carga de leitura: exige autorização do responsável) — host exato da URL:
RAIO_X_DATABASE_URL='postgres://raiox_ro:***@HOST:5432/banco?sslmode=verify-full' npm run raio-x -- --real --autorizo-host=HOST
```
- **Credencial**: use um usuário **somente leitura** (nunca o do app). Sugestão para o DBA — *não executada; criar/alterar
  usuário e grants exige autorização*: `CREATE ROLE raiox_ro LOGIN …; ALTER ROLE raiox_ro SET default_transaction_read_only = on;
  GRANT CONNECT …; GRANT USAGE ON SCHEMA public …; GRANT SELECT` nas tabelas do inventário e, em `ml_tokens`, só as colunas
  `(id, cliente_id, ml_user_id, is_primary, token_status, refresh_failures, superseded_at, expires_at, updated_at)` — o Raio-X nunca lê token.
- A URL só aceita `sslmode`, `ssl`, `application_name`, `connect_timeout`; `?host=`, `hostaddr`, `port`, `service`, `options` são recusados.
  O host exibido na interface é o destino efetivo. Sem `--autorizo-host` exato, host não-local é recusado antes de conectar.
- Fora do pico; o serviço serializa as consultas e guarda 60 s em cache. Encerrar com Ctrl+C.
- **CLI antigo `server/scripts/raio-x-cliente.js`: NÃO usar contra banco remoto** até alinhar a validação de destino
  (ele ainda confia em `new URL().hostname`, que `?host=` contorna). Para banco remoto use somente `npm run raio-x -- --real`.

Garantias: escuta só em `127.0.0.1` e recusa `Host` não-local; só `GET`; cada leitura em
`BEGIN READ ONLY` + `statement_timeout`; não lê `server/.env` nem `DATABASE_URL`; modo real
serializa as consultas e guarda 60 s em cache; nunca seleciona token/segredo. Deep-links:
`#clientes/<id>[/<conta>]`, `#dependencias/<motor|tabela>`, `#armazenamento`, `#oportunidades`.

## Telas
1. **Visão geral** — tamanho do banco, domínios, tipos de dado, tabelas fora do inventário.
2. **Clientes e contas** — IDs/relacionamentos, última sincronização e períodos, imports vigentes /
   substituídos / vinculados (reuso), pagamentos MP duplicados, tabelas por domínio (≈), motores do
   cliente (última atualização + qualidade). Seleção por conta filtra as tabelas que têm `cliente_conta_id`.
3. **Armazenamento** — por domínio, tipo de dado ou tabela (tamanho real do catálogo do PG).
4. **Dependências e motores** — Central, Painel, Cliente 360, Margem, Promoções, Sentinel, Conciliação MP,
   Financeiro, Anúncios, Ads: consome / produz / persistência / snapshots-caches-históricos /
   compartilhado / o que impede excluir ou reconstruir / **não mapeado**; por tabela: quem escreve e lê.
5. **Otimização e limpeza** — sugestões com evidência, risco e bloqueio. **Nunca executa nada.**

## Honestidade dos dados
- Etiquetas de evidência em todas as ligações: **Confirmado** (lido no código) · **Inferido** · **Não mapeado**.
  Fonte: `server/services/raioX/raioXMotores.js` (a partir do inventário). Nenhum motor foi alterado.
- Tamanho de tabela = **real**; linhas = estimativa do planner; tamanho por cliente/conta = **≈ estimativa**.
- "Qualidade" do motor = regra heurística simples (último sync, falhas, cópias/payment, tempo sem escrita), não SLA.
- "Potencialmente descartável" = reconstruível e não manual — **candidato, sem garantia**; veja as dependências.
- Modo sintético tem selo permanente e nomes marcados "(sintético)".

## Código
`services/raioX/`: `raioXMotores.js` (catálogo), `raioXVisualService.js` (composição; reaproveita
`gerarRaioXCliente`, agora com `contaId` opcional), `raioXSintetico.js`; `scripts/raio-x-visual.js`;
`raioX-ui/index.html`. Testes: `raioXVisual.test.js` (132), `raioXVisual.postgres.test.js` (57, PG local).

## Autorização do host e escopo por conta
- A URL do banco passa por `raioXConexao.js`: o host usado é o do MESMO parser do driver e só são aceitos
  `sslmode`, `ssl`, `application_name`, `connect_timeout` (`?host=`, `hostaddr`, `port`, `service`, `options`… são recusados);
  `PGHOST` & cia são removidos do ambiente; o host exibido é o destino efetivo.
- Com conta selecionada, Central, syncs, Mercado Pago e as checagens filtram pela conta; o que não se separa por conta
  (imports sem conta, grants sem conta…) aparece como **escopo do cliente** e não rebaixa a qualidade da conta.
- Vínculos de reuso: `sql/observabilidade/reuso_vinculos_cliente.sql` (restringe cliente/conta antes de agregar); a global
  `reuso_vinculos.sql` segue para observabilidade geral.
- "Como funciona" (aba 4) vem de `raioXMotores.js` (fluxos do inventário); sem fluxo documentado a tela mostra **Não mapeado**.

## Fora do alcance (próximas etapas)
Tamanho exato por cliente/conta (hoje estimativa); filhas (pedidos/itens/componentes) por cliente só no
modo detalhado do serviço; tabelas fora do inventário aparecem na visão geral, sem dono; Shopee/TikTok/Design
Studio/Relatórios aparecem como "não mapeados".
