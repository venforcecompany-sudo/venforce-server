# Raio-X visual (interface local, somente leitura)

```bash
cd server
npm run raio-x                      # dados SINTÉTICOS (sem banco)  → http://127.0.0.1:4777
RAIO_X_DATABASE_URL=postgres://... npm run raio-x -- --real                       # banco local
RAIO_X_DATABASE_URL=postgres://... npm run raio-x -- --real --autorizo-host=<host> # banco remoto (carga de leitura: exige autorização)
```
(equivalente: `node server/scripts/raio-x-visual.js [--real] [--porta 4777]`)

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
`raioX-ui/index.html`. Testes: `raioXVisual.test.js` (46), `raioXVisual.postgres.test.js` (29, PG local).

## Fora do alcance (próximas etapas)
Tamanho exato por cliente/conta (hoje estimativa); filhas (pedidos/itens/componentes) por cliente só no
modo detalhado do serviço; tabelas fora do inventário aparecem na visão geral, sem dono; Shopee/TikTok/Design
Studio/Relatórios aparecem como "não mapeados".
