// server/scripts/poc-componentes-v2/cenario.js
//
// PoC — persistência dos componentes da Central de Vendas (v2).
// Cenário 100% SINTÉTICO e determinístico (PRNG com semente fixa): as N noites
// do sync noturno de um mês (noite k = snapshot dos dias 1..k, como o worker
// grava hoje), alimentadas no MOTOR REAL (buildMotorFromOrders).
//
// Cobre o que a missão exige do conjunto de dados:
//   - pedidos com 1..4 itens (componentes no nível do item: 5 por item; ~5% multi-item);
//   - componentes no nível do pedido (receita_envio, cancelamento_reembolso);
//   - valores ausentes (custo sem base, sale_fee ausente, frete que ainda não
//     chegou, receiver.cost ausente) — ausente ≠ zero;
//   - zero legítimo (receita de envio 0 do comprador);
//   - envio compartilhado por 2 pedidos (rateio) e pack incompleto (frete NULL);
//   - vendas alteradas entre noites (cancelamento, reembolso parcial/total,
//     frete que chega depois);
//   - Full × normal.
// Nada aqui lê banco nem env.

function prng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

const PARAMS_PADRAO = { noites: 20, pedidosPorDia: 150, taxaMudanca: 0.02, competencia: "2026-09" };

function idPedido(dia, n) { return `7${String(dia).padStart(2, "0")}${String(n).padStart(5, "0")}`; }

function ordersDaNoite(noite, params = PARAMS_PADRAO) {
  const { pedidosPorDia, taxaMudanca, competencia } = { ...PARAMS_PADRAO, ...params };
  const r = prng(20261126);
  const todos = [];
  for (let dia = 1; dia <= noite; dia++) {
    for (let n = 0; n < pedidosPorDia; n++) {
      const id = idPedido(dia, n);
      const sorteioItens = r();
      // Produção (05/11): 711.644 pedidos × 712.708 itens ⇒ multi-item é raro; mantido p/ cobertura.
      const nItens = sorteioItens < 0.95 ? 1 : sorteioItens < 0.98 ? 2 : sorteioItens < 0.995 ? 3 : 4;
      const order_items = [];
      for (let k = 0; k < nItens; k++) {
        const mlb = `MLB${2000 + Math.floor(r() * 400)}`;
        const preco = Math.round((15 + r() * 400) * 100) / 100;
        const semTarifa = r() < 0.04;
        order_items.push({
          item: { id: mlb, seller_sku: r() < 0.1 ? null : `SKU-${mlb}`, title: `Produto sintético ${mlb}`, variation_id: r() < 0.3 ? 9000 + k : null },
          quantity: 1 + Math.floor(r() * 3),
          unit_price: preco,
          sale_fee: semTarifa ? null : Math.round(preco * (0.11 + r() * 0.05) * 100) / 100,
        });
      }
      // 6% dos pedidos compartilham o envio com o pedido anterior do mesmo dia (carrinho/pack).
      const compartilha = n > 0 && r() < 0.06;
      const shippingId = compartilha ? `S${idPedido(dia, n - 1)}` : `S${id}`;
      todos.push({
        id,
        date_created: `${competencia}-${String(dia).padStart(2, "0")}T${String(8 + (n % 12)).padStart(2, "0")}:00:00.000-03:00`,
        status: "paid",
        tags: [],
        pack_id: compartilha ? `PK${idPedido(dia, n - 1)}` : null,
        payments: [{ id: `P${id}`, transaction_amount_refunded: 0 }],
        shipping: { id: shippingId, logistic_type: r() < 0.25 ? "fulfillment" : "cross_docking" },
        order_items,
      });
      if (compartilha) todos[todos.length - 2].pack_id = `PK${idPedido(dia, n - 1)}`;
    }
  }
  // Mudanças legítimas entre noites (o pedido do dia d pode mudar nas noites > d).
  for (let j = 2; j <= noite; j++) {
    const rj = prng(5000 + j);
    for (const o of todos) {
      const dia = Number(o.id.slice(1, 3));
      if (dia >= j) continue;
      if (rj() < taxaMudanca) {
        const t = rj();
        const total = o.order_items.reduce((s, it) => s + it.unit_price * it.quantity, 0);
        if (t < 0.4) o.status = "cancelled";
        else if (t < 0.7) o.payments[0].transaction_amount_refunded = Math.round(total * 100) / 100;
        else o.payments[0].transaction_amount_refunded = Math.round(total * 0.3 * 100) / 100;
      }
    }
  }
  return todos;
}

function freteDaNoite(orders, noite) {
  const m = new Map();
  for (const o of orders) {
    if (m.has(o.shipping.id)) continue;
    const dia = Number(o.id.slice(1, 3));
    // Frete do próprio dia às vezes ainda não chegou: ausente hoje, valor amanhã.
    if (dia === noite && Number(o.id.slice(-1)) % 4 === 0) continue;
    const sufixo = Number(o.id.slice(-2));
    m.set(o.shipping.id, {
      valor: Math.round((8.9 + (sufixo % 11) * 1.37) * 100) / 100,
      status: "real",
      // 0 legítimo (frete grátis ao comprador) na maioria; valor em parte; ausente em parte.
      receitaComprador: sufixo % 10 === 0 ? undefined : sufixo % 3 === 0 ? Math.round((12 + (sufixo % 5)) * 100) / 100 : 0,
    });
  }
  return m;
}

// 1 em cada ~40 packs não teve todos os pedidos identificados com segurança.
function packsIncompletosDaNoite(orders) {
  const s = new Set();
  for (const o of orders) if (o.pack_id && Number(o.pack_id.slice(-3)) % 40 === 0) s.add(o.pack_id);
  return s;
}

function costMapEntradas() {
  return Array.from({ length: 400 }, (_, i) => ({
    produto_id: `MLB${2000 + i}`,
    custo_produto: i % 10 === 0 ? null : Math.round((4 + i * 0.37) * 100) / 100,
    imposto_percentual: i % 17 === 0 ? null : 6,
  }));
}

module.exports = { PARAMS_PADRAO, prng, ordersDaNoite, freteDaNoite, packsIncompletosDaNoite, costMapEntradas };
