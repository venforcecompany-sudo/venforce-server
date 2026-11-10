#!/usr/bin/env node
// server/scripts/freteSnapshotsSuspeitos.js
// Lista, SEM ESCREVER NADA, as linhas de margin_projection_snapshots de uma conta cujo frete
// gravado é suspeito (tag `proximity` + cotação por item_id sem desconto obrigatório).
// Sem `--executar` só imprime o plano (nenhum acesso a banco/ML). Com ele: 1 SELECT +
// 2 GETs por linha (items.shipping.tags e shipping_options/free) — usa DATABASE_URL (server/.env = PRODUÇÃO).
//   node server/scripts/freteSnapshotsSuspeitos.js --cliente 133 --conta 87 --seller 2433262404 [--executar] [--saida arq.json]
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };
const cliente = Number(opt("cliente")), conta = Number(opt("conta")), seller = opt("seller"), saida = opt("saida");
if (!Number.isInteger(cliente) || !Number.isInteger(conta) || !seller) { console.error("Uso: --cliente <id> --conta <id> --seller <ml_user_id> [--executar] [--saida arq.json]"); process.exit(2); }
if (!args.includes("--executar")) {
  console.log(`PLANO (nada foi chamado): SELECT item_id, price, freight FROM margin_projection_snapshots WHERE cliente_id=${cliente} AND cliente_conta_id=${conta};`);
  console.log("  por linha: GET /items/{id}?attributes=id,shipping ; GET /users/" + seller + "/shipping_options/free?item_id=…&item_price=<price>&listing_type_id=…&mode=me2 ; classifica com cotacaoNaoConfiavel().");
  console.log("  saída: contagem + lista de item_id suspeitos (para o refresh direcionado). NENHUMA escrita.");
  process.exit(0);
}
(async () => {
  const pool = require("../config/database");
  const { mlFetch } = require("../utils/mlClient");
  const { cotacaoNaoConfiavel, lerResposta } = require("../services/shared/freteCotacaoConfiavel");
  const { rows } = await pool.query(
    `SELECT s.item_id, s.price, s.freight, a.listing_type_id
       FROM margin_projection_snapshots s LEFT JOIN meli_anuncios a ON a.item_id = s.item_id AND a.cliente_conta_id = s.cliente_conta_id
      WHERE s.cliente_id = $1 AND s.cliente_conta_id = $2 AND s.marketplace = 'meli' ORDER BY s.item_id`, [cliente, conta]);
  const op = { mlUserId: String(seller) };
  const suspeitos = [], erros = [];
  for (const r of rows) {
    try {
      const it = await mlFetch(cliente, `/items/${r.item_id}?attributes=id,shipping`, op);
      const tags = it && it.ok && it.data && it.data.shipping ? it.data.shipping.tags : null;
      const q = await mlFetch(cliente, `/users/${seller}/shipping_options/free?item_id=${r.item_id}&verbose=true&item_price=${r.price}&listing_type_id=${r.listing_type_id}&mode=me2`, op);
      if (!Array.isArray(tags) || !q || !q.ok) { erros.push(r.item_id); continue; }
      if (cotacaoNaoConfiavel({ resposta: lerResposta(q), tags })) suspeitos.push({ item_id: r.item_id, price: Number(r.price), freight_gravado: Number(r.freight) });
    } catch (e) { erros.push(r.item_id); }
  }
  const out = { cliente, conta, total: rows.length, suspeitos: suspeitos.length, erros_de_leitura: erros.length, itens: suspeitos, itens_com_erro: erros };
  if (saida) require("fs").writeFileSync(saida, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ ...out, itens: undefined, itens_com_erro: undefined }));
  await pool.end();
})().then(() => process.exit(0)).catch((e) => { console.error("ERRO:", e.message); process.exit(1); });
