// server/services/resgate/resgateStorePg.js
//
// Persistência da auditoria no PostgreSQL do VenForce (tabelas resgate_*, ver
// sql/migrations/20261112_venforce_resgate.sql). Só para o SERVIDOR, depois da
// migration aplicada com autorização. Gravações em lotes de até 200 linhas por
// comando, sem transações longas.

const LOTE = 200;

function erroTabelasAusentes(err) { return err && err.code === "42P01"; }

function criarStorePg(db) {
  return {
    tipo: "pg",
    async tabelasDisponiveis() {
      const { rows } = await db.query(`SELECT to_regclass('public.resgate_execucoes') IS NOT NULL AS ok`);
      return Boolean(rows[0] && rows[0].ok);
    },
    async iniciarExecucao(meta) {
      const { rows } = await db.query(
        `INSERT INTO resgate_execucoes (parametros, iniciada_por, heartbeat_em) VALUES ($1::jsonb, $2, now()) RETURNING id`,
        [JSON.stringify(meta || {}), meta && meta.iniciadaPor ? meta.iniciadaPor : null]);
      return Number(rows[0].id);
    },
    async finalizarExecucao(id, status, resumo) {
      await db.query(`UPDATE resgate_execucoes SET status = $2, resumo = $3::jsonb, finalizada_em = now() WHERE id = $1`, [id, status, JSON.stringify(resumo || null)]);
    },
    async pedidoDeCancelamento(id) {
      const { rows } = await db.query(`UPDATE resgate_execucoes SET heartbeat_em = now() WHERE id = $1 RETURNING cancelar`, [id]);
      return Boolean(rows[0] && rows[0].cancelar);
    },
    async solicitarCancelamento(id) {
      const r = await db.query(`UPDATE resgate_execucoes SET cancelar = TRUE WHERE id = $1 AND status = 'em_andamento'`, [id]);
      return r.rowCount > 0;
    },
    async lerCheckpoint(id, contaId) {
      const { rows } = await db.query(`SELECT checkpoint FROM resgate_contas_resultado WHERE execucao_id = $1 AND cliente_conta_id = $2`, [id, contaId]);
      return rows[0] ? rows[0].checkpoint : null;
    },
    async salvarCheckpoint(id, contaId, cp) {
      await db.query(
        `INSERT INTO resgate_contas_resultado (execucao_id, cliente_conta_id, checkpoint) VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (execucao_id, cliente_conta_id) DO UPDATE SET checkpoint = EXCLUDED.checkpoint, atualizado_em = now()`,
        [id, contaId, JSON.stringify(cp)]);
    },
    async salvarItens(id, contaId, itens) {
      for (let i = 0; i < itens.length; i += LOTE) {
        const lote = itens.slice(i, i + LOTE).map((x) => ({
          item_id: x.itemId, cliente_id: x.clienteId, situacao: x.situacao, acao: x.acao, origem: x.historico.origem,
          prioridade: x.prioridade, mudanca_recente: Boolean(x.historico.mudancaRecente), unidades_30d: x.vendas30d ? x.vendas30d.unidades : null,
          exposicao: x.exposicao && Number.isFinite(x.exposicao.valor) ? x.exposicao.valor : null, resultado: x,
        }));
        await db.query(
          `INSERT INTO resgate_itens (execucao_id, cliente_conta_id, item_id, cliente_id, situacao, acao, origem, prioridade, mudanca_recente, unidades_30d, exposicao, resultado)
           SELECT $1, $2, r.item_id, r.cliente_id, r.situacao, r.acao, r.origem, r.prioridade, r.mudanca_recente, r.unidades_30d, r.exposicao, r.resultado
             FROM jsonb_to_recordset($3::jsonb) AS r(item_id text, cliente_id bigint, situacao text, acao text, origem text, prioridade int,
                  mudanca_recente boolean, unidades_30d numeric, exposicao numeric, resultado jsonb)
           ON CONFLICT (execucao_id, cliente_conta_id, item_id) DO UPDATE SET
             situacao = EXCLUDED.situacao, acao = EXCLUDED.acao, origem = EXCLUDED.origem, prioridade = EXCLUDED.prioridade,
             mudanca_recente = EXCLUDED.mudanca_recente, unidades_30d = EXCLUDED.unidades_30d, exposicao = EXCLUDED.exposicao,
             resultado = EXCLUDED.resultado, atualizado_em = now(),
             -- Proposta recalculada com OUTRO preço visto invalida a revisão anterior.
             revisao_status = CASE WHEN resgate_itens.resultado->'fingerprint'->>'precoVisto' IS DISTINCT FROM EXCLUDED.resultado->'fingerprint'->>'precoVisto'
                                    AND resgate_itens.revisao_status <> 'PENDENTE' THEN 'INVALIDADO' ELSE resgate_itens.revisao_status END`,
          [id, contaId, JSON.stringify(lote)]);
      }
    },
    async lerItens(id, contaId, { somenteAcionaveis = false } = {}) {
      const { rows } = await db.query(
        `SELECT resultado, revisao_status, revisao_nota FROM resgate_itens WHERE execucao_id = $1 AND cliente_conta_id = $2 AND (NOT $3 OR acao <> 'NENHUMA') ORDER BY item_id`,
        [id, contaId, somenteAcionaveis]);
      return rows.map((r) => ({ ...r.resultado, revisao: { status: r.revisao_status, nota: r.revisao_nota } }));
    },
    async salvarConta(id, contaId, { resumo, matriz }) {
      await db.query(
        `INSERT INTO resgate_contas_resultado (execucao_id, cliente_conta_id, cliente_id, resumo, matriz) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
         ON CONFLICT (execucao_id, cliente_conta_id) DO UPDATE SET cliente_id = EXCLUDED.cliente_id, resumo = EXCLUDED.resumo, matriz = EXCLUDED.matriz, atualizado_em = now()`,
        [id, contaId, resumo && resumo.clienteId ? resumo.clienteId : null, JSON.stringify(resumo || null), JSON.stringify(matriz || null)]);
    },
    async lerConta(id, contaId) {
      const { rows } = await db.query(`SELECT resumo, matriz FROM resgate_contas_resultado WHERE execucao_id = $1 AND cliente_conta_id = $2`, [id, contaId]);
      return rows[0] || null;
    },
    /** Última execução concluída (ou a em andamento, se pedida). */
    async ultimaExecucao({ incluirEmAndamento = false } = {}) {
      const { rows } = await db.query(
        `SELECT id, status, parametros, resumo, iniciada_em, finalizada_em, heartbeat_em FROM resgate_execucoes
          WHERE status = 'concluida' OR ($1 AND status = 'em_andamento') ORDER BY id DESC LIMIT 1`, [incluirEmAndamento]);
      return rows[0] || null;
    },
    async listarContas(id, clienteIds = null) {
      const { rows } = await db.query(
        `SELECT cliente_conta_id, cliente_id, resumo, matriz, atualizado_em FROM resgate_contas_resultado
          WHERE execucao_id = $1 AND resumo IS NOT NULL AND ($2::bigint[] IS NULL OR cliente_id = ANY($2::bigint[])) ORDER BY cliente_conta_id`,
        [id, clienteIds]);
      return rows;
    },
    async paginaItens(id, contaId, { situacao = null, acao = null, origem = null, somenteRecentes = false, busca = null, limite = 50, offset = 0 } = {}) {
      const params = [id, contaId, situacao, acao, origem, somenteRecentes, busca ? `%${String(busca).toUpperCase()}%` : null, Math.min(200, Math.max(1, limite)), Math.max(0, offset)];
      const filtro = `execucao_id = $1 AND cliente_conta_id = $2 AND ($3::text IS NULL OR situacao = $3) AND ($4::text IS NULL OR acao = $4)
        AND ($5::text IS NULL OR origem = $5) AND (NOT $6 OR mudanca_recente) AND ($7::text IS NULL OR upper(item_id) LIKE $7 OR upper(COALESCE(resultado->>'sku','')) LIKE $7 OR upper(COALESCE(resultado->>'titulo','')) LIKE $7)`;
      const [itens, total] = await Promise.all([
        db.query(`SELECT resultado, revisao_status, revisao_em, revisao_nota FROM resgate_itens WHERE ${filtro} ORDER BY prioridade DESC, item_id LIMIT $8 OFFSET $9`, params),
        db.query(`SELECT count(*)::int AS n FROM resgate_itens WHERE ${filtro}`, params.slice(0, 7)),
      ]);
      return { total: total.rows[0].n, itens: itens.rows.map((r) => ({ ...r.resultado, revisao: { status: r.revisao_status, em: r.revisao_em, nota: r.revisao_nota } })) };
    },
    async item(id, contaId, itemId) {
      const { rows } = await db.query(`SELECT resultado, revisao_status, revisao_em, revisao_nota FROM resgate_itens WHERE execucao_id = $1 AND cliente_conta_id = $2 AND item_id = $3`, [id, contaId, itemId]);
      return rows[0] ? { ...rows[0].resultado, revisao: { status: rows[0].revisao_status, em: rows[0].revisao_em, nota: rows[0].revisao_nota } } : null;
    },
    /** Revisão humana: só aceita se o preço visto da proposta for o informado (proteção contra proposta desatualizada). */
    async registrarRevisao(id, contaId, itemId, { status, nota = null, userId = null, precoVisto }) {
      const r = await db.query(
        `UPDATE resgate_itens SET revisao_status = $4, revisao_nota = $5, revisao_por = $6, revisao_em = now()
          WHERE execucao_id = $1 AND cliente_conta_id = $2 AND item_id = $3 AND (resultado->'fingerprint'->>'precoVisto')::numeric = $7::numeric
          RETURNING revisao_status`, [id, contaId, itemId, status, nota, userId, precoVisto]);
      return r.rowCount > 0;
    },
    async configContas(contaIds) {
      const { rows } = await db.query(`SELECT cliente_conta_id, meta_margem, limite_variacao FROM resgate_config_contas WHERE cliente_conta_id = ANY($1::bigint[])`, [contaIds]);
      return rows;
    },
    /** Retenção: mantém só as `manter` últimas execuções (CASCADE limpa itens/contas). */
    async aplicarRetencao(manter = 3) {
      await db.query(`DELETE FROM resgate_execucoes WHERE id NOT IN (SELECT id FROM resgate_execucoes ORDER BY id DESC LIMIT $1) AND status <> 'em_andamento'`, [manter]);
    },
  };
}

module.exports = { criarStorePg, erroTabelasAusentes };
