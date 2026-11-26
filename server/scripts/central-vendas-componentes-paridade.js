#!/usr/bin/env node
// server/scripts/central-vendas-componentes-paridade.js
//
// Paridade do formato COMPACTO dos componentes contra os dados REAIS de uma
// conta — SOMENTE LEITURA. Nada é gravado: os componentes atuais (linhas de
// central_vendas_componentes) do período são codificados no formato compacto
// EM MEMÓRIA (mesmas regras de centralVendasComponentesCompactos), decodificados
// de volta e comparados:
//   1. campo a campo com a linha atual (COMPONENTE_READ_COLUMNS, menos `id`);
//   2. reconstrução do objeto do motor (colunas + extras do payload_json);
//   3. contrato da Central (buildPedidoContrato) pedido a pedido.
// É a prova exigida antes de ligar a escrita compacta para a conta (piloto).
//
//   DATABASE_URL=<role de LEITURA> node server/scripts/central-vendas-componentes-paridade.js \
//     --conta=<cliente_conta_id> --de=2026-11-01 --ate=2026-11-25 [--include-legacy] [--saida=relatorio.json]
//
// Segurança: NÃO lê server/.env (usa só o DATABASE_URL do shell) e imprime o
// host antes de qualquer consulta; toda sessão é READ ONLY com
// statement_timeout; nenhum INSERT/UPDATE/DELETE existe neste arquivo.

const fs = require("fs");
const path = require("path");

function lerArgs(argv) {
  const args = {};
  for (const a of argv) { const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a); if (m) args[m[1]] = m[2] === undefined ? true : m[2]; }
  return args;
}

async function main() {
  const args = lerArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url || !args.conta || !args.de || !args.ate) {
    console.error("uso: DATABASE_URL=<leitura> node central-vendas-componentes-paridade.js --conta=<id> --de=AAAA-MM-DD --ate=AAAA-MM-DD");
    process.exit(2);
  }
  console.log(`  banco: host=${new URL(url).hostname} (sessão READ ONLY)`);
  const { Pool } = require(path.join(__dirname, "..", "node_modules", "pg"));
  const ssl = /sslmode=disable/.test(url) ? false : { rejectUnauthorized: false };
  const db = new Pool({ connectionString: url, ssl, max: 2,
    options: "-c default_transaction_read_only=on -c statement_timeout=60000 -c lock_timeout=2000" });
  const { rows: [ro] } = await db.query("SHOW default_transaction_read_only");
  if (ro.default_transaction_read_only !== "on") throw new Error("SESSAO_NAO_READ_ONLY");

  const repo = require("../services/centralVendas/centralVendasRepository");
  const { buildPedidoContrato } = require("../services/centralVendas/centralVendasService");
  const cc = require("../services/centralVendas/centralVendasComponentesCompactos");
  const pe = require("../services/centralVendas/centralVendasPersistenciaEnxuta");
  const { classificarComponenteFinanceiro } = require("../services/centralVendas/centralVendasComponenteLedger");

  const { rows: [conta] } = await db.query(
    `SELECT cc.id, c.slug FROM cliente_contas cc JOIN clientes c ON c.id = cc.cliente_id WHERE cc.id = $1`, [Number(args.conta)]);
  if (!conta) throw new Error("CONTA_INEXISTENTE");
  const range = { clienteSlug: conta.slug, dateFrom: args.de, dateTo: args.ate, clienteContaId: Number(conta.id), includeLegacy: !!args["include-legacy"] };
  const { importIds } = await repo.resolveImportsForRange(range, db);
  const carga = await repo.loadPedidosByImportIds({ importIds, dateFrom: args.de, dateTo: args.ate }, db);
  const comps = carga.componentes;

  // payload_json das linhas atuais (só para os extras; nenhum leitor o usa).
  const ids = comps.filter((c) => c.id != null).map((c) => c.id);
  const payloads = new Map();
  for (let i = 0; i < ids.length; i += 20000) {
    // eslint-disable-next-line no-await-in-loop
    const { rows } = await db.query(`SELECT id, payload_json FROM central_vendas_componentes WHERE id = ANY($1::bigint[])`, [ids.slice(i, i + 20000)]);
    for (const r of rows) payloads.set(String(r.id), r.payload_json);
  }

  // --- Codificação em memória (mesma regra da escrita compacta) ------------
  const textos = new Map();
  const cod = (t) => { if (t === null || t === undefined) return 0; if (!textos.has(t)) textos.set(t, textos.size + 1); return textos.get(t); };
  const porPedido = new Map();
  const pedidosPorId = new Map(carga.pedidos.map((p) => [String(p.id), p]));
  const itensPorId = new Map(carga.itens.map((i) => [String(i.id), i]));
  const naoElegiveis = {};
  const ordenadas = [...comps].sort((a, b) => Number(a.pedido_row_id) - Number(b.pedido_row_id) || Number(a.id) - Number(b.id));
  for (const c of ordenadas) {
    const motivo = c.pedido_row_id == null ? "SEM_PEDIDO" : c.item_id && c.item_row_id == null ? "ITEM_SEM_LINHA" : null;
    if (motivo) { naoElegiveis[motivo] = (naoElegiveis[motivo] || 0) + 1; continue; }
    const k = String(c.pedido_row_id);
    if (!porPedido.has(k)) porPedido.set(k, { codigos: [], valores: [], itens: [], extras: {}, origem: [] });
    const l = porPedido.get(k);
    const objeto = pe.reconstruirComponente({ ...c, payload_json: payloads.get(String(c.id)) || {} });
    const extras = pe.extrasDoComponente(objeto);
    l.codigos.push(cod(c.tipo), cod(c.fonte), cod(c.confianca), cod(c.obs));
    l.valores.push(c.valor);
    l.itens.push(c.item_row_id);
    if (Object.keys(extras).length) l.extras[String(l.valores.length)] = extras;
    l.origem.push({ row: c, objeto });
  }

  // --- Decodificação + comparação -------------------------------------------
  const porTexto = new Map([...textos.entries()].map(([t, n]) => [n, t]));
  const divergencias = [];
  let comparados = 0;
  const decodificados = [];
  for (const [k, l] of porPedido) {
    const p = pedidosPorId.get(k);
    l.valores.forEach((valor, n) => {
      const itemRow = l.itens[n] == null ? null : itensPorId.get(String(l.itens[n]));
      const tipo = porTexto.get(l.codigos[4 * n]);
      const cls = classificarComponenteFinanceiro({ tipo, itemId: l.itens[n] == null ? null : "item" });
      const efeito = Object.prototype.hasOwnProperty.call(cc.REGRA_FORMATO_1.efeito, tipo) ? cc.REGRA_FORMATO_1.efeito[tipo] : null;
      const dec = { import_id: p.import_id, pedido_row_id: k, item_row_id: l.itens[n], cliente_id: p.cliente_id, cliente_slug: p.cliente_slug,
        marketplace: p.marketplace, competencia: p.competencia, pedido_id: p.pedido_id, item_id: itemRow ? itemRow.item_id : null, tipo, valor,
        fonte: porTexto.get(l.codigos[4 * n + 1]) ?? null, confianca: porTexto.get(l.codigos[4 * n + 2]), obs: porTexto.get(l.codigos[4 * n + 3]) ?? null,
        escopo: cls.escopo, efeito, incluido_no_resultado: cls.incluidoNoResultado, created_at: p.created_at, updated_at: p.updated_at };
      const { row, objeto } = l.origem[n];
      comparados += 1;
      for (const campo of Object.keys(dec)) {
        const a = row[campo] instanceof Date ? row[campo].toISOString() : row[campo] == null ? null : String(row[campo]);
        const b = dec[campo] instanceof Date ? dec[campo].toISOString() : dec[campo] == null ? null : String(dec[campo]);
        if (a !== b && divergencias.length < 50) divergencias.push({ componenteId: row.id, campo, atual: a, compacto: b });
      }
      const reconstruido = pe.reconstruirComponente({ ...dec, payload_json: l.extras[String(n + 1)] || {} });
      if (JSON.stringify(pe.canonico(reconstruido)) !== JSON.stringify(pe.canonico(objeto)) && divergencias.length < 50) {
        divergencias.push({ componenteId: row.id, campo: "<objeto do motor>", atual: objeto, compacto: reconstruido });
      }
      decodificados.push({ ...dec, id: null });
    });
  }
  // Contrato da Central, pedido a pedido. A ordem dos componentes no contrato
  // vem do ORDER BY da leitura (pedido_id, item_id, gravação), aplicado pelo
  // banco nos dois formatos: aqui a ordem de item_id é a que o próprio banco
  // devolveu (mesma collation), e dentro do item vale a ordem de gravação.
  const rankItem = new Map();
  for (const c of comps) {
    const k = `${c.pedido_row_id}|${c.item_id ?? "\u0000null"}`;
    if (!rankItem.has(k)) rankItem.set(k, rankItem.size);
  }
  const ordemDb = (x) => rankItem.get(`${x.pedido_row_id}|${x.item_id ?? "\u0000null"}`);
  decodificados.forEach((d, n) => { d._n = n; });
  decodificados.sort((a, b) => ordemDb(a) - ordemDb(b) || a._n - b._n);
  for (const d of decodificados) delete d._n;
  let contratosDiferentes = 0;
  for (const p of carga.pedidos) {
    const itens = carga.itens.filter((i) => String(i.pedido_row_id) === String(p.id));
    const a = buildPedidoContrato(p, itens, comps.filter((c) => String(c.pedido_row_id) === String(p.id)));
    const b = buildPedidoContrato(p, itens, decodificados.filter((c) => String(c.pedido_row_id) === String(p.id)));
    if (JSON.stringify(a) !== JSON.stringify(b)) contratosDiferentes += 1;
  }
  const relatorio = {
    conta: Number(conta.id), periodo: { de: args.de, ate: args.ate }, imports: importIds.length,
    pedidos: carga.pedidos.length, componentes: comps.length, componentesComparados: comparados,
    pedidosCompactos: porPedido.size, textosNoDicionario: textos.size, naoElegiveis,
    divergencias: divergencias.length, contratosDiferentes, amostraDivergencias: divergencias.slice(0, 20),
    veredito: divergencias.length === 0 && contratosDiferentes === 0 && !Object.keys(naoElegiveis).length ? "PARIDADE_OK" : "DIVERGE",
  };
  if (args.saida) fs.writeFileSync(args.saida, JSON.stringify(relatorio, null, 2));
  console.log(JSON.stringify({ ...relatorio, amostraDivergencias: undefined }, null, 2));
  await db.end();
  if (relatorio.veredito !== "PARIDADE_OK") process.exit(3);
}

main().catch((err) => { console.error(err.message || err); process.exit(1); });
