// server/services/squads/squadService.js
// Mutações de Squads: CRUD de squad, memberships (com a regra do principal
// único), vínculo Cliente↔Squad e transferência transacional com histórico.
//
// Invariantes garantidas aqui + no banco (índices parciais de
// 20260827_squads_foundation.sql):
//   - slug de squad único (uq_squads_slug)
//   - 1 membership por (squad,user) (uq_squad_members_squad_user)
//   - no máx. 1 principal ativo por usuário (uq_squad_members_primary_por_user)
//   - no máx. 1 Squad ativo por cliente (uq_cliente_squad_ativo)
//   - transferência atômica (BEGIN/COMMIT)

const pool = require("../../config/database");
const {
  ensureSquadsTables,
  encerrarResponsaveisSemAcessoAoSquad,
  contarResponsaveisAtivos,
} = require("./squadsRepository");

// Quando um Cliente muda de Squad, as responsabilidades (gestor/auxiliar/
// designer) cujo titular NÃO é membro do Squad de destino são encerradas —
// não podem seguir apontando silenciosamente para quem perdeu o acesso
// (mission P2.4 §4). Isto NÃO é autorização: é limpeza disparada PELA
// transferência. O "último gestor obrigatório" da remoção MANUAL não se
// aplica aqui — a transferência é um estado de migração tratado.
// Retorna { responsaveisEncerrados, pendencias } — `pendencias` é uma lista
// aberta (hoje só "gestor_ausente"; preparada para novos tipos sem quebrar
// o contrato de quem consome).
async function limparResponsaveisAposMudancaDeSquad(clienteId, squadDestinoId, actorId, client) {
  const encerrados = await encerrarResponsaveisSemAcessoAoSquad(
    clienteId, squadDestinoId, { encerradoPor: actorId, motivo: "transferencia_squad" }, client
  );
  const gestoresVigentes = await contarResponsaveisAtivos(clienteId, "gestor", client);
  const pendencias = [];
  if (gestoresVigentes === 0) pendencias.push({ tipo: "gestor_ausente" });
  return {
    responsaveisEncerrados: encerrados.map((r) => ({ userId: r.user_id, papel: r.papel })),
    pendencias,
  };
}

function erro(status, code, mensagem) {
  const e = new Error(mensagem);
  e.statusCode = status;
  if (code) e.code = code;
  return e;
}

function normalizarSlug(valor) {
  return String(valor || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

async function gerarSlugUnico(base, client) {
  const raiz = normalizarSlug(base) || "squad";
  let candidato = raiz;
  let n = 2;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { rows } = await client.query("SELECT 1 FROM squads WHERE slug = $1", [candidato]);
    if (!rows.length) return candidato;
    candidato = `${raiz}-${n++}`;
  }
}

/* ───────────────────────────── squads ───────────────────────────── */

async function criarSquad({ nome, slug } = {}, actorId = null) {
  await ensureSquadsTables();
  const nomeFinal = String(nome || "").trim();
  if (!nomeFinal) throw erro(400, "SQUAD_NOME_OBRIGATORIO", "nome do squad é obrigatório.");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const slugFinal = slug ? normalizarSlug(slug) : await gerarSlugUnico(nomeFinal, client);
    if (!slugFinal) throw erro(400, "SQUAD_SLUG_INVALIDO", "slug inválido.");
    const { rows } = await client.query(
      `INSERT INTO squads (nome, slug) VALUES ($1, $2)
       RETURNING id, nome, slug, ativo, created_at, updated_at`,
      [nomeFinal, slugFinal]
    );
    await client.query("COMMIT");
    console.log(`[squads] squad criado id=${rows[0].id} slug=${slugFinal} por user=${actorId}`);
    return rows[0];
  } catch (e) {
    await client.query("ROLLBACK");
    if (e.code === "23505") throw erro(409, "SQUAD_SLUG_DUPLICADO", "Já existe um squad com esse slug.");
    throw e;
  } finally {
    client.release();
  }
}

async function editarSquad(id, { nome, slug, ativo } = {}, actorId = null) {
  await ensureSquadsTables();
  const patches = [];
  const params = [];
  if (nome !== undefined) {
    const n = String(nome).trim();
    if (!n) throw erro(400, "SQUAD_NOME_OBRIGATORIO", "nome não pode ser vazio.");
    params.push(n); patches.push(`nome = $${params.length}`);
  }
  if (slug !== undefined) {
    const s = normalizarSlug(slug);
    if (!s) throw erro(400, "SQUAD_SLUG_INVALIDO", "slug inválido.");
    params.push(s); patches.push(`slug = $${params.length}`);
  }
  if (ativo !== undefined) { params.push(Boolean(ativo)); patches.push(`ativo = $${params.length}`); }
  if (!patches.length) throw erro(400, "SEM_ALTERACAO", "Nenhum campo para atualizar.");
  patches.push("updated_at = NOW()");
  params.push(Number(id));

  try {
    const { rows } = await pool.query(
      `UPDATE squads SET ${patches.join(", ")} WHERE id = $${params.length}
       RETURNING id, nome, slug, ativo, created_at, updated_at`,
      params
    );
    if (!rows.length) throw erro(404, "SQUAD_NAO_ENCONTRADO", "Squad não encontrado.");
    console.log(`[squads] squad ${id} editado por user=${actorId} campos=${patches.join(",")}`);
    return rows[0];
  } catch (e) {
    if (e.code === "23505") throw erro(409, "SQUAD_SLUG_DUPLICADO", "Já existe um squad com esse slug.");
    throw e;
  }
}

/* ─────────────────────────── memberships ─────────────────────────── */

// Adiciona (ou reativa) membership. Se o usuário não tem NENHUMA membership
// ativa, esta vira principal automaticamente (regra: 1 principal quando há
// memberships). `isPrimary:true` força a troca do principal.
async function adicionarMembro(squadId, userId, { funcao = "membro", isPrimary = false } = {}, actorId = null) {
  await ensureSquadsTables();
  const sid = Number(squadId);
  const uid = Number(userId);
  if (!["membro", "coordenador"].includes(funcao)) {
    throw erro(400, "FUNCAO_INVALIDA", "funcao deve ser 'membro' ou 'coordenador'.");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(529871001, $1)", [uid]);

    const squad = await client.query("SELECT id, ativo FROM squads WHERE id = $1 FOR UPDATE", [sid]);
    if (!squad.rows.length) throw erro(404, "SQUAD_NAO_ENCONTRADO", "Squad não encontrado.");
    const usuario = await client.query("SELECT id, role FROM users WHERE id = $1", [uid]);
    if (!usuario.rows.length) throw erro(404, "USUARIO_NAO_ENCONTRADO", "Usuário não encontrado.");

    const ativasCount = await client.query(
      "SELECT COUNT(*)::int AS total FROM squad_members WHERE user_id = $1 AND ativo = true AND squad_id <> $2",
      [uid, sid]
    );
    const primeiraMembership = ativasCount.rows[0].total === 0;
    const seraPrincipal = isPrimary === true || primeiraMembership;

    if (seraPrincipal) {
      await client.query(
        "UPDATE squad_members SET is_primary = false, updated_at = NOW() WHERE user_id = $1 AND is_primary = true",
        [uid]
      );
    }

    const { rows } = await client.query(
      `INSERT INTO squad_members (squad_id, user_id, is_primary, funcao, ativo)
       VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (squad_id, user_id) DO UPDATE
         SET ativo = true,
             funcao = EXCLUDED.funcao,
             is_primary = CASE WHEN $3 THEN true ELSE squad_members.is_primary END,
             updated_at = NOW()
       RETURNING id, squad_id, user_id, is_primary, funcao, ativo`,
      [sid, uid, seraPrincipal, funcao]
    );

    await client.query("COMMIT");
    console.log(`[squads] membro user=${uid} -> squad=${sid} funcao=${funcao} principal=${seraPrincipal} por user=${actorId}`);
    return rows[0];
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// Remove (desativa) a membership. Se era a principal e o usuário ainda tem
// outras memberships ativas, promove a mais antiga a principal.
async function removerMembro(squadId, userId, actorId = null) {
  await ensureSquadsTables();
  const sid = Number(squadId);
  const uid = Number(userId);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(529871001, $1)", [uid]);

    const atual = await client.query(
      "SELECT id, is_primary FROM squad_members WHERE squad_id = $1 AND user_id = $2 AND ativo = true FOR UPDATE",
      [sid, uid]
    );
    if (!atual.rows.length) {
      await client.query("ROLLBACK");
      throw erro(404, "MEMBERSHIP_NAO_ENCONTRADA", "Membership ativa não encontrada.");
    }

    await client.query(
      "UPDATE squad_members SET ativo = false, is_primary = false, updated_at = NOW() WHERE id = $1",
      [atual.rows[0].id]
    );

    let promovida = null;
    if (atual.rows[0].is_primary) {
      const restante = await client.query(
        `SELECT id FROM squad_members
          WHERE user_id = $1 AND ativo = true
          ORDER BY created_at ASC, id ASC LIMIT 1`,
        [uid]
      );
      if (restante.rows.length) {
        await client.query(
          "UPDATE squad_members SET is_primary = true, updated_at = NOW() WHERE id = $1",
          [restante.rows[0].id]
        );
        promovida = restante.rows[0].id;
      }
    }

    await client.query("COMMIT");
    console.log(`[squads] membro user=${uid} removido de squad=${sid} por user=${actorId} promovida=${promovida}`);
    return { removido: true, novaPrincipalMembershipId: promovida };
  } catch (e) {
    if (e.statusCode) throw e;
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function definirPrincipal(squadId, userId, actorId = null) {
  await ensureSquadsTables();
  const sid = Number(squadId);
  const uid = Number(userId);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(529871001, $1)", [uid]);

    const alvo = await client.query(
      "SELECT id FROM squad_members WHERE squad_id = $1 AND user_id = $2 AND ativo = true FOR UPDATE",
      [sid, uid]
    );
    if (!alvo.rows.length) {
      await client.query("ROLLBACK");
      throw erro(404, "MEMBERSHIP_NAO_ENCONTRADA", "Membership ativa não encontrada.");
    }

    await client.query(
      "UPDATE squad_members SET is_primary = false, updated_at = NOW() WHERE user_id = $1 AND is_primary = true",
      [uid]
    );
    await client.query(
      "UPDATE squad_members SET is_primary = true, updated_at = NOW() WHERE id = $1",
      [alvo.rows[0].id]
    );

    await client.query("COMMIT");
    console.log(`[squads] principal de user=${uid} -> squad=${sid} por user=${actorId}`);
    return { ok: true };
  } catch (e) {
    if (e.statusCode) throw e;
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function definirFuncao(squadId, userId, funcao, actorId = null) {
  await ensureSquadsTables();
  if (!["membro", "coordenador"].includes(funcao)) {
    throw erro(400, "FUNCAO_INVALIDA", "funcao deve ser 'membro' ou 'coordenador'.");
  }
  const { rows } = await pool.query(
    `UPDATE squad_members SET funcao = $1, updated_at = NOW()
      WHERE squad_id = $2 AND user_id = $3 AND ativo = true
      RETURNING id, squad_id, user_id, is_primary, funcao, ativo`,
    [funcao, Number(squadId), Number(userId)]
  );
  if (!rows.length) throw erro(404, "MEMBERSHIP_NAO_ENCONTRADA", "Membership ativa não encontrada.");
  console.log(`[squads] funcao de user=${userId} em squad=${squadId} -> ${funcao} por user=${actorId}`);
  return rows[0];
}

/* ─────────────────────── cliente ↔ squad ─────────────────────── */

// Atribui um cliente SEM squad ativo a um squad. Se já tem squad ativo,
// use `transferirCliente`.
async function atribuirCliente(squadId, clienteId, { motivo = null } = {}, actorId = null) {
  await ensureSquadsTables();
  const sid = Number(squadId);
  const cid = Number(clienteId);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(529871002, $1)", [cid]);

    const squad = await client.query("SELECT id, ativo FROM squads WHERE id = $1", [sid]);
    if (!squad.rows.length) throw erro(404, "SQUAD_NAO_ENCONTRADO", "Squad não encontrado.");
    const cli = await client.query("SELECT id FROM clientes WHERE id = $1", [cid]);
    if (!cli.rows.length) throw erro(404, "CLIENTE_NAO_ENCONTRADO", "Cliente não encontrado.");

    const atual = await client.query(
      "SELECT id, squad_id FROM cliente_squad_history WHERE cliente_id = $1 AND fim_em IS NULL",
      [cid]
    );
    if (atual.rows.length) {
      if (atual.rows[0].squad_id === sid) {
        await client.query("ROLLBACK");
        return { jaVinculado: true, squadId: sid };
      }
      throw erro(409, "CLIENTE_JA_TEM_SQUAD", "Cliente já pertence a um squad. Use transferência.");
    }

    const { rows } = await client.query(
      `INSERT INTO cliente_squad_history (cliente_id, squad_id, alterado_por, motivo)
       VALUES ($1, $2, $3, $4)
       RETURNING id, cliente_id, squad_id, inicio_em`,
      [cid, sid, actorId, motivo]
    );

    await client.query("COMMIT");
    console.log(`[squads] cliente=${cid} atribuído ao squad=${sid} por user=${actorId}`);
    return rows[0];
  } catch (e) {
    if (e.statusCode) { await client.query("ROLLBACK").catch(() => {}); throw e; }
    await client.query("ROLLBACK");
    if (e.code === "23505") throw erro(409, "CLIENTE_JA_TEM_SQUAD", "Cliente já pertence a um squad.");
    throw e;
  } finally {
    client.release();
  }
}

// Cria um Cliente NOVO já vinculado a um Squad, como uma única transação
// (mission "criação de cliente com squad"): não pode existir uma janela em
// que o Cliente exista sem Squad. squadId é sempre revalidado aqui (existe +
// ativo) — nunca confiado do jeito que chega do frontend. Não toca
// ClienteConta, Grant, Base nem nenhum dado operacional — só clientes +
// cliente_squad_history, igual atribuirCliente().
async function criarClienteComSquad({ nome, slug, apiKey, squadId, motivo = null } = {}, actorId = null) {
  await ensureSquadsTables();
  const sid = Number(squadId);
  if (!Number.isInteger(sid) || sid <= 0) {
    throw erro(400, "SQUAD_ID_INVALIDO", "squadId inválido.");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const squad = await client.query("SELECT id, nome, ativo FROM squads WHERE id = $1", [sid]);
    if (!squad.rows.length) throw erro(404, "SQUAD_NAO_ENCONTRADO", "Squad não encontrado.");
    if (squad.rows[0].ativo !== true) throw erro(409, "SQUAD_INATIVO", "Squad inativo. Escolha um squad ativo.");

    let clienteRow;
    try {
      const ins = await client.query(
        `INSERT INTO clientes (nome, slug, api_key)
         VALUES ($1, $2, $3)
         RETURNING id, nome, slug, api_key, ativo, created_at`,
        [nome, slug, apiKey]
      );
      clienteRow = ins.rows[0];
    } catch (e) {
      if (e.code === "23505") throw erro(409, "CLIENTE_SLUG_DUPLICADO", "Slug já cadastrado. Use outro nome.");
      throw e;
    }

    await client.query(
      `INSERT INTO cliente_squad_history (cliente_id, squad_id, alterado_por, motivo)
       VALUES ($1, $2, $3, $4)`,
      [clienteRow.id, sid, actorId, motivo]
    );

    await client.query("COMMIT");
    console.log(`[squads] cliente=${clienteRow.id} criado e atribuído ao squad=${sid} por user=${actorId}`);
    return { cliente: clienteRow, squad: { id: squad.rows[0].id, nome: squad.rows[0].nome } };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Transferência transacional Squad A -> Squad B. NÃO toca ClienteConta,
// Grant, Base nem dados operacionais — só o pertencimento do Cliente.
// Fecha o histórico antigo e abre o novo.
async function transferirCliente(clienteId, squadDestinoId, { motivo = null } = {}, actorId = null) {
  await ensureSquadsTables();
  const cid = Number(clienteId);
  const destino = Number(squadDestinoId);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(529871002, $1)", [cid]);

    const squad = await client.query("SELECT id, ativo FROM squads WHERE id = $1", [destino]);
    if (!squad.rows.length) throw erro(404, "SQUAD_NAO_ENCONTRADO", "Squad de destino não encontrado.");
    if (squad.rows[0].ativo !== true) {
      throw erro(409, "SQUAD_INATIVO", "Não é possível transferir para um squad inativo.");
    }
    const cli = await client.query("SELECT id FROM clientes WHERE id = $1", [cid]);
    if (!cli.rows.length) throw erro(404, "CLIENTE_NAO_ENCONTRADO", "Cliente não encontrado.");

    const atual = await client.query(
      "SELECT id, squad_id FROM cliente_squad_history WHERE cliente_id = $1 AND fim_em IS NULL FOR UPDATE",
      [cid]
    );
    if (!atual.rows.length) {
      throw erro(409, "CLIENTE_SEM_SQUAD", "Cliente não tem squad ativo. Use atribuição.");
    }
    const origem = atual.rows[0].squad_id;
    if (origem === destino) {
      await client.query("ROLLBACK");
      return { semMudanca: true, squadId: destino };
    }

    await client.query(
      "UPDATE cliente_squad_history SET fim_em = NOW() WHERE id = $1",
      [atual.rows[0].id]
    );
    const { rows } = await client.query(
      `INSERT INTO cliente_squad_history (cliente_id, squad_id, alterado_por, motivo)
       VALUES ($1, $2, $3, $4)
       RETURNING id, cliente_id, squad_id, inicio_em`,
      [cid, destino, actorId, motivo]
    );

    const responsabilidade = await limparResponsaveisAposMudancaDeSquad(cid, destino, actorId, client);

    await client.query("COMMIT");
    console.log(`[squads] cliente=${cid} transferido squad ${origem} -> ${destino} por user=${actorId} motivo=${motivo || "-"} responsaveisEncerrados=${responsabilidade.responsaveisEncerrados.length} pendencias=${responsabilidade.pendencias.map((p) => p.tipo).join(",") || "-"}`);
    return { ...rows[0], squadOrigemId: origem, responsabilidade };
  } catch (e) {
    if (e.statusCode) { await client.query("ROLLBACK").catch(() => {}); throw e; }
    await client.query("ROLLBACK");
    if (e.code === "23505") throw erro(409, "CLIENTE_JA_TEM_SQUAD", "Cliente já pertence a um squad ativo.");
    throw e;
  } finally {
    client.release();
  }
}

// Remove o cliente de qualquer squad (fecha o histórico aberto). O cliente
// vira pendência de migração até nova atribuição. Não apaga nada.
async function removerClienteDoSquad(clienteId, { motivo = null } = {}, actorId = null) {
  await ensureSquadsTables();
  const cid = Number(clienteId);
  const { rows } = await pool.query(
    `UPDATE cliente_squad_history SET fim_em = NOW(), motivo = COALESCE($2, motivo)
      WHERE cliente_id = $1 AND fim_em IS NULL
      RETURNING id, squad_id`,
    [cid, motivo]
  );
  if (!rows.length) throw erro(409, "CLIENTE_SEM_SQUAD", "Cliente não tem squad ativo.");
  console.log(`[squads] cliente=${cid} removido do squad=${rows[0].squad_id} por user=${actorId}`);
  return { removido: true, squadId: rows[0].squad_id };
}

module.exports = {
  normalizarSlug,
  criarSquad,
  editarSquad,
  adicionarMembro,
  removerMembro,
  definirPrincipal,
  definirFuncao,
  atribuirCliente,
  criarClienteComSquad,
  transferirCliente,
  removerClienteDoSquad,
};
