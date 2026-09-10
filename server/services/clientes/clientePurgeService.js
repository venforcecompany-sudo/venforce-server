// server/services/clientes/clientePurgeService.js
//
// Exclusão administrativa REAL de Cliente ("purge"): apaga o Cliente e TODOS
// os dados relacionados, numa única transação, com COMMIT só se tudo der
// certo e ROLLBACK completo se qualquer etapa falhar.
//
// Por que não é só "DELETE FROM clientes" cru: o schema atual mistura 3
// situações (auditadas manualmente contra todo o server/, ver
// clienteDependenciasService.js para a lista completa de tabelas):
//
//   1) ON DELETE CASCADE  -> Postgres apaga sozinho quando o Cliente é
//      apagado (cliente_contas, ml_tokens, base_cliente_vinculos,
//      entregas_cliente, diagnosticos_iniciais, seller_clientes,
//      seller_custos_submissoes, design_client_profiles/templates/artworks
//      [+ versions, que cascateiam dos templates/artworks], cliente_360_*
//      [resumos/diagnosticos(+itens)/frete/sync_jobs], central_vendas_sync_runs
//      [+ sync_sources/mp_payments(+charges)/mp_settlement_reports(+movements)],
//      cliente_squad_history, cliente_responsaveis). Não precisamos (nem
//      devemos) duplicar esses DELETEs aqui — e se algum dia uma dessas FKs
//      deixar de ser CASCADE, o DELETE FROM clientes final falha com
//      foreign_key_violation e a transação inteira faz ROLLBACK sozinha,
//      então o purge nunca "esquece" nada em silêncio.
//
//   2) ON DELETE SET NULL -> Postgres nulifica sozinho (callbacks,
//      fechamento_incidentes). São logs/auditoria de infraestrutura, não
//      dado do cliente — ficam preservados anonimizados de propósito, não
//      são apagados aqui.
//
//   3) SEM FK nenhuma -> o Postgres NÃO faz nada sozinho; se não apagarmos
//      explicitamente, viram lixo órfão (ou, pior, dado "herdado" por um
//      cliente futuro que reuse o mesmo slug). É a lista abaixo.
//
// relatorios tecnicamente TEM FK (ON DELETE SET NULL), mas é decisão de
// produto tratá-lo como dado do cliente a ser apagado no purge (é um
// artefato de diagnóstico gerado PARA aquele cliente, não um log de
// infraestrutura) — por isso está na lista de apagar explicitamente, não na
// lista de "log que sobrevive nulificado".

const pool = require("../../config/database");

const TABELAS_SEM_FK_POR_ID = [
  "relatorios", // relatorio_itens cascateia de relatorio_id
  "meli_anuncios",
  "meli_anuncio_otimizacoes",
  "meli_anuncio_publicacoes",
  "cliente_360_acoes",
  "promocoes_diagnosticos", // promocoes_diagnostico_itens cascateia de diagnostico_id
  "central_vendas_imports", // pedidos/itens/componentes cascateiam de import_id
];

const TABELAS_SEM_FK_POR_SLUG = ["ads_acompanhamentos", "ads_resumos_mensais"];

function erro(status, code, mensagem) {
  const e = new Error(mensagem);
  e.statusCode = status;
  if (code) e.code = code;
  return e;
}

async function purgarClientePermanentemente(slug) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // FOR UPDATE trava a linha do cliente contra escrita concorrente
    // (ex.: dois admins clicando "excluir permanentemente" ao mesmo tempo)
    // enquanto o purge estiver em andamento.
    const clienteRes = await client.query(
      "SELECT id, nome, slug FROM clientes WHERE slug = $1 FOR UPDATE",
      [slug]
    );
    if (!clienteRes.rows.length) {
      await client.query("ROLLBACK");
      throw erro(404, "CLIENTE_NAO_ENCONTRADO", "Cliente não encontrado.");
    }
    const cliente = clienteRes.rows[0];

    const apagados = [];

    for (const tabela of TABELAS_SEM_FK_POR_ID) {
      // eslint-disable-next-line no-await-in-loop
      const r = await client.query(`DELETE FROM ${tabela} WHERE cliente_id = $1`, [cliente.id]);
      if (r.rowCount) apagados.push({ tabela, total: r.rowCount });
    }
    for (const tabela of TABELAS_SEM_FK_POR_SLUG) {
      // eslint-disable-next-line no-await-in-loop
      const r = await client.query(`DELETE FROM ${tabela} WHERE cliente_slug = $1`, [cliente.slug]);
      if (r.rowCount) apagados.push({ tabela, total: r.rowCount });
    }

    // Tudo que sobrou (cliente_contas, ml_tokens, base_cliente_vinculos,
    // entregas_cliente, design_*, cliente_360_* com FK, central_vendas_*
    // com FK, seller_*, diagnosticos_iniciais, squad history/responsaveis)
    // cascateia sozinho aqui. Se alguma dependência real NÃO puder ser
    // apagada com segurança (FK sem CASCADE que ainda não conhecemos, ou
    // migração não aplicada nesse ambiente), o Postgres recusa este DELETE
    // com foreign_key_violation — pegamos isso no catch abaixo, fazemos
    // ROLLBACK completo e informamos exatamente qual tabela impediu.
    const result = await client.query("DELETE FROM clientes WHERE id = $1 RETURNING id", [cliente.id]);
    if (!result.rows.length) {
      await client.query("ROLLBACK");
      throw erro(500, "PURGE_FALHOU", "Falha ao excluir o cliente.");
    }

    await client.query("COMMIT");
    return { cliente, apagados };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      // conexão já pode ter caído; nada a fazer além de deixar o release() rodar
    }
    if (err.statusCode) throw err;
    if (err.code === "23503") {
      // foreign_key_violation — o detail do Postgres já cita a tabela e a
      // constraint que bloquearam ("... is still referenced from table X").
      throw erro(
        409,
        "PURGE_BLOQUEADO_POR_DEPENDENCIA",
        `Não foi possível excluir permanentemente: ${err.detail || err.message}`
      );
    }
    throw erro(500, "PURGE_FALHOU", err.message);
  } finally {
    client.release();
  }
}

module.exports = { purgarClientePermanentemente, TABELAS_SEM_FK_POR_ID, TABELAS_SEM_FK_POR_SLUG };
