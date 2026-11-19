#!/usr/bin/env node
// server/scripts/sentinel-conciliacao.js
// Operação CONTROLADA da conciliação da comissão (S1) — um comando por etapa, para rodar no shell do serviço
// venforce-sentinel no Render (lá DATABASE_URL e os grants já existem; nada vem do server/.env).
//
//   node scripts/sentinel-conciliacao.js status          [--contas=41,3,86]
//        SOMENTE LEITURA (sessão read-only): schema, pausa 429, elegíveis e conciliações por estado. Zero chamada ao ML.
//
//   node scripts/sentinel-conciliacao.js aplicar-schema  --confirm-host=<host>
//        Aplica a migration 20261119 (idempotente, aditiva, serializada por advisory lock). Zero chamada ao ML.
//
//   node scripts/sentinel-conciliacao.js reverter-schema --confirm-host=<host> --apagar-conciliacoes
//        ROLLBACK da 20261119 numa transação: DROP das 2 tabelas novas + o marcador de versão (sem ele, uma reaplicação
//        futura seria ignorada pelo runner). Não toca em sentinel_pedidos/incidentes/checkpoints. Zero chamada ao ML.
//
//   node scripts/sentinel-conciliacao.js executar        --contas=41 --max-chamadas=3 --confirm-host=<host>
//        UMA execução do coletor só nas contas dadas, com teto de chamadas ao ML (2..20; 3 por padrão nesta CLI).
//        Mesmo código do worker: lock próprio, noRefresh, pausa 429, gravação idempotente. Interromper: Ctrl+C
//        (termina o pedido corrente e sai) — ou matar o processo: o lock cai com a conexão e nada fica pela metade.
//
// Fora de localhost, comandos que ESCREVEM exigem --confirm-host igual ao host do DATABASE_URL (impresso antes).
// Nunca imprime credenciais, tokens nem dados de comprador.

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const MAX_CHAMADAS_CLI = 20;

function lerArgs(argv) {
  const args = { _: [] };
  for (const a of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (m) args[m[1]] = m[2] === undefined ? true : m[2];
    else args._.push(a);
  }
  return args;
}

function lerContas(v) {
  if (v === undefined || v === true) return null;
  const ids = String(v).split(",").map((x) => x.trim()).filter(Boolean);
  if (!ids.length || ids.some((x) => !/^\d{1,9}$/.test(x))) return undefined;
  return [...new Set(ids.map(Number))];
}

const USO = `uso:
  node scripts/sentinel-conciliacao.js status [--contas=41,3,86]
  node scripts/sentinel-conciliacao.js aplicar-schema --confirm-host=<host>
  node scripts/sentinel-conciliacao.js executar --contas=41 [--max-chamadas=3] --confirm-host=<host>
  node scripts/sentinel-conciliacao.js reverter-schema --confirm-host=<host> --apagar-conciliacoes`;

async function status(pool, contas) {
  const { conciliacaoSchemaPronto } = require("../services/sentinel/sentinelSchema");
  const { configConciliacao } = require("../services/sentinel/sentinelConciliacaoColetor");
  const cfg = configConciliacao();
  const c = await pool.connect();
  try {
    await c.query("BEGIN READ ONLY");
    const pronto = await conciliacaoSchemaPronto(c, { lancar: true });
    console.log(`schema 20261119: ${pronto ? "APLICADA" : "ausente (coletor suspenso; leitura responde disponivel:false)"}`);
    const filtro = contas ? "AND p.cliente_conta_id = ANY($4::int[])" : "";
    const params = [new Date().toISOString(), cfg.janelaDias, cfg.maturidadeHoras, ...(contas ? [contas] : [])];
    const eleg = await c.query(`SELECT p.cliente_conta_id AS conta, COUNT(*)::int AS elegiveis
        FROM sentinel_pedidos p
       WHERE p.status_ml = 'paid' AND p.comissao IS NOT NULL AND p.estado_margem IN ('confirmada','sem_custo','custo_ambiguo')
         AND p.data_pedido >= $1::timestamptz - make_interval(days => $2::int)
         AND p.data_pedido <= $1::timestamptz - make_interval(hours => $3::int)
         AND jsonb_typeof(p.itens) = 'array' AND jsonb_array_length(p.itens) = 1 AND (p.itens -> 0 ->> 'quantidade') = '1'
         ${filtro}
       GROUP BY 1 ORDER BY 1`, params);
    console.log(`pedidos elegíveis (janela ${cfg.janelaDias} d, maturidade ${cfg.maturidadeHoras} h):`);
    console.table(eleg.rows);
    if (pronto) {
      const pausa = (await c.query("SELECT pausado_ate, ocorrencias, motivo FROM sentinel_conciliacao_controle WHERE chave = 'billing_429'")).rows[0];
      const ativa = pausa && pausa.pausado_ate && new Date(pausa.pausado_ate) > new Date();
      console.log(`pausa 429: ${ativa ? `ATIVA até ${new Date(pausa.pausado_ate).toISOString()} (${pausa.ocorrencias} seguidas)` : "nenhuma"}`);
      const est = await c.query(`SELECT cliente_conta_id AS conta, estado, status_coleta, COUNT(*)::int AS pedidos,
            MAX(observado_em) AS ultima_observacao
          FROM sentinel_conciliacao_comissao ${contas ? "WHERE cliente_conta_id = ANY($1::int[])" : ""}
         GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`, contas ? [contas] : []);
      console.log("conciliações por conta/estado/coleta:");
      console.table(est.rows);
      const inv = await c.query(`SELECT cliente_conta_id AS conta, pedido_id, estado, motivos
          FROM sentinel_conciliacao_comissao
         WHERE estado IN ('DIVERGENTE', 'TARIFA_BRUTA_COMPROVADA') ${contas ? "AND cliente_conta_id = ANY($1::int[])" : ""}
         ORDER BY 1, 2 LIMIT 50`, contas ? [contas] : []);
      console.log(`para investigação manual (DIVERGENTE / TARIFA_BRUTA_COMPROVADA): ${inv.rows.length}`);
      if (inv.rows.length) console.table(inv.rows.map((r) => ({ ...r, motivos: r.motivos.join(",") })));
    }
    await c.query("ROLLBACK");
  } finally {
    c.release();
  }
}

async function main() {
  const args = lerArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!["status", "aplicar-schema", "executar", "reverter-schema"].includes(cmd)) { console.error(USO); process.exit(2); }
  const contas = lerContas(args.contas);
  if (contas === undefined) { console.error("--contas inválido (ids numéricos separados por vírgula)."); process.exit(2); }
  if (!process.env.DATABASE_URL) { console.error("DATABASE_URL não definido no shell (o .env NÃO é lido por este script)."); process.exit(2); }
  const host = new URL(process.env.DATABASE_URL).hostname;
  console.log(`[sentinel-conciliacao] banco: host=${host}`);
  const escreve = cmd !== "status";
  if (escreve && !LOCAL_HOSTS.has(host) && args["confirm-host"] !== host) {
    console.error(`[sentinel-conciliacao] '${cmd}' escreve no banco. Para confirmar, repita com --confirm-host=${host}`);
    process.exit(3);
  }
  if (cmd === "reverter-schema" && args["apagar-conciliacoes"] !== true) {
    console.error("reverter-schema APAGA as conciliações gravadas: repita com --apagar-conciliacoes."); process.exit(2);
  }
  let maxChamadas = 3;
  if (cmd === "executar") {
    if (!contas || !contas.length) { console.error("executar exige --contas=<ids> (allowlist explícita)."); process.exit(2); }
    if (args["max-chamadas"] !== undefined) {
      maxChamadas = Number.parseInt(args["max-chamadas"], 10);
      if (!Number.isInteger(maxChamadas) || maxChamadas < 2 || maxChamadas > MAX_CHAMADAS_CLI) {
        console.error(`--max-chamadas deve ser inteiro entre 2 e ${MAX_CHAMADAS_CLI}.`); process.exit(2);
      }
    }
  }

  const { criarPoolSentinel } = require("../workers/sentinelWorker");
  const pool = criarPoolSentinel();
  try {
    if (cmd === "status") return await status(pool, contas);
    const { SENTINEL_CONCILIACAO_LOCK_KEY } = require("../services/sentinel/sentinelSchema");
    if (cmd === "aplicar-schema") {
      const { ensureSentinelConciliacaoSchema, conciliacaoSchemaPronto } = require("../services/sentinel/sentinelSchema");
      await ensureSentinelConciliacaoSchema(pool);
      if (await conciliacaoSchemaPronto(pool, { lancar: true })) { console.log("[sentinel-conciliacao] migration 20261119: aplicada"); return; }
      // o runner pulou o DDL porque o marcador de versão existe sem as tabelas (DROP manual sem apagar o marcador)
      console.error(`[sentinel-conciliacao] migration 20261119: tabelas AUSENTES apesar do marcador '${SENTINEL_CONCILIACAO_LOCK_KEY}' em venforce_schema_versoes.
  Rode 'reverter-schema' (apaga o marcador junto) e aplique de novo.`);
      process.exitCode = 1;
      return;
    }
    if (cmd === "reverter-schema") {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        const n = (await c.query("SELECT to_regclass('public.sentinel_conciliacao_comissao') IS NOT NULL AS t")).rows[0].t
          ? (await c.query("SELECT COUNT(*)::int AS n FROM sentinel_conciliacao_comissao")).rows[0].n : 0;
        await c.query("DROP TABLE IF EXISTS sentinel_conciliacao_comissao");
        await c.query("DROP TABLE IF EXISTS sentinel_conciliacao_controle");
        const marc = await c.query("SELECT to_regclass('public.venforce_schema_versoes') IS NOT NULL AS t");
        if (marc.rows[0].t) await c.query("DELETE FROM venforce_schema_versoes WHERE chave = $1", [SENTINEL_CONCILIACAO_LOCK_KEY]);
        await c.query("COMMIT");
        console.log(`[sentinel-conciliacao] 20261119 revertida: ${n} conciliação(ões) apagada(s); marcador removido. sentinel_pedidos intacta.`);
      } catch (err) {
        await c.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        c.release();
      }
      return;
    }
    const { executarColeta } = require("../services/sentinel/sentinelConciliacaoColetor");
    let parar = false;
    process.on("SIGINT", () => { console.log("[sentinel-conciliacao] SIGINT: terminando o pedido corrente e saindo."); parar = true; });
    process.on("SIGTERM", () => { parar = true; });
    const r = await executarColeta({
      db: pool, contaIds: contas, deveParar: () => parar,
      config: { maxChamadasExecucao: maxChamadas, maxChamadasConta: maxChamadas },
    });
    console.log(JSON.stringify({
      executado: r.executado, motivo: r.motivo || null, chamadasMl: r.chamadas ?? 0, parou429: r.parou429 || false,
      abortado: r.abortado || null, ignoradas: r.ignoradas || [], pausa: r.pausa || null,
      contas: (r.contas || []).map((c) => ({ conta: c.contaId, candidatos: c.candidatos, lotes: c.lotes, chamadasBilling: c.chamadasBilling,
        chamadasDescontos: c.chamadasDescontos, gravados: c.gravados, falhas: c.falhas, porEstado: c.porEstado,
        naoProcessados: c.naoProcessados ?? null, parada: c.parada, erro: c.erro })),
    }, null, 2));
    if (r.parou429 || r.abortado || (r.contas || []).some((c) => c.erro)) process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[sentinel-conciliacao] falhou: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { lerArgs, lerContas };
