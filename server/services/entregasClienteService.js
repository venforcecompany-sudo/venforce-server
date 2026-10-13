const crypto = require("crypto");
const { isDeepStrictEqual } = require("util");
const pool = require("../config/database");
const { normalizarCompetencia } = require("../utils/competenciaCanonica");
const { CODIGOS_CANONICOS } = require("../utils/erroContextoCanonico");

const TIPOS_PERMITIDOS = new Set([
  "fechamento_mensal",
  "diagnostico_completo",
  "preview_precificacao",
  "relatorio_misto",
]);

function normalizarSlug(nome) {
  return String(nome || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function criarErroHttp(statusCode, payload) {
  const err = new Error(payload?.erro || "Erro");
  err.statusCode = statusCode;
  err.payload = payload;
  // V3 P2.6 — o codigo canonico tambem no erro, nao so no payload: quem
  // trata `err.code` (controllers, testes, chamadores internos) nao precisa
  // conhecer o formato do envelope HTTP.
  if (payload?.code) err.code = payload.code;
  return err;
}

function gerarTokenPublico() {
  return crypto.randomBytes(32).toString("hex");
}

function buildPayloadPadrao({ tipo, titulo, periodo, cliente }) {
  return {
    versao: 1,
    tipo,
    titulo,
    periodo: periodo || null,
    cliente: cliente || null,
    cards: [],
    secoes: [],
    tabelas: [],
    graficos: [],
    conclusao: "",
    metadados: { geradoEm: new Date().toISOString() },
  };
}

function validarTipo(tipo) {
  const t = String(tipo || "").trim();
  if (!t) throw criarErroHttp(400, { ok: false, erro: "tipo é obrigatório." });
  if (!TIPOS_PERMITIDOS.has(t)) {
    throw criarErroHttp(400, {
      ok: false,
      erro:
        "tipo inválido. Permitidos: fechamento_mensal, diagnostico_completo, preview_precificacao, relatorio_misto",
    });
  }
  return t;
}

function validarTitulo(titulo) {
  const t = String(titulo || "").trim();
  if (!t) throw criarErroHttp(400, { ok: false, erro: "titulo é obrigatório." });
  return t;
}

function parseTimestampOrNull(v) {
  if (v === null || v === undefined || String(v).trim() === "") return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) {
    throw criarErroHttp(400, { ok: false, erro: "expires_at inválido." });
  }
  return d;
}

// Trava crítica encontrada na auditoria de clientes/contas: processar um
// fechamento para o Cliente A, trocar o seletor para B e salvar não
// invalidava o resultado — o payload ficava com identidade de A mas era
// salvo como entrega de B. `payload_json.cliente.slug` é a identidade
// congelada no momento do cálculo (ver Portal/financeiro.js, _vf_meta);
// se ela existir e divergir da identidade que está sendo persistida agora,
// bloqueia em vez de aceitar silenciosamente.
function validarIdentidadeFechamento({ payloadJson, clienteSlugResolvido }) {
  const payloadClienteSlugRaw = payloadJson && typeof payloadJson === "object" ? payloadJson.cliente?.slug : null;
  if (!payloadClienteSlugRaw) return;
  const payloadSlug = normalizarSlug(payloadClienteSlugRaw);
  const alvoSlug = clienteSlugResolvido ? normalizarSlug(clienteSlugResolvido) : "";
  if (payloadSlug && alvoSlug && payloadSlug !== alvoSlug) {
    throw criarErroHttp(409, {
      ok: false,
      code: "IDENTIDADE_DIVERGENTE",
      erro: `O fechamento foi processado para "${payloadSlug}", mas está sendo salvo como "${alvoSlug}". Reprocesse antes de salvar.`,
    });
  }
}

async function buscarClientePorSlugOuId({ clienteIdRaw, clienteSlugRaw }) {
  const clienteId = clienteIdRaw != null ? parseInt(clienteIdRaw, 10) : null;
  const clienteSlug = clienteSlugRaw != null ? normalizarSlug(clienteSlugRaw) : "";

  if (Number.isFinite(clienteId) && clienteId > 0) {
    const r = await pool.query(
      "SELECT id, slug, nome FROM clientes WHERE id = $1",
      [clienteId]
    );
    return r.rows[0] || null;
  }

  if (clienteSlug) {
    const r = await pool.query(
      "SELECT id, slug, nome FROM clientes WHERE slug = $1",
      [clienteSlug]
    );
    return r.rows[0] || null;
  }

  return null;
}

// V3 P2.6 BLOCO G — escrita e leitura falavam formatos diferentes: a coluna
// `periodo` e VARCHAR(100) livre, sem validacao, e o Portal grava o texto do
// input (placeholder literal "ex: Maio 2026"), enquanto os leitores exigiam
// YYYY-MM. Resultado: praticamente todo relatorio real aparecia sem periodo.
//
// A partir daqui, tudo que der para normalizar com seguranca e GRAVADO ja em
// YYYY-MM. O que nao der continua sendo gravado como veio (texto livre) — nao
// rejeitamos a escrita nem inventamos competencia, so paramos de criar dado
// novo fora do formato. Linhas historicas seguem sendo normalizadas na leitura.
function normalizarPeriodoParaEscrita(periodoRaw) {
  if (periodoRaw === null || periodoRaw === undefined) return null;
  const texto = String(periodoRaw).trim();
  if (!texto) return null;
  return normalizarCompetencia(texto) || texto;
}

// V3 P2.6 D1 — resolve e VALIDA a operacao (ClienteConta) da entrega.
//
// Regra dura do modelo canonico: a conta tem que pertencer ao Cliente
// resolvido. Sem isso, gravar `cliente_conta_id` seria pior que nao gravar —
// criaria um vinculo mentiroso entre a entrega e uma operacao de outro cliente.
//
// Ausencia continua valida e significa "sem operacao registrada" (entrega
// antiga ou fluxo legado). NUNCA escolhemos uma conta sozinhos: nem a primeira,
// nem a is_primary, nem a do marketplace.
async function resolverContaDaEntrega({ clienteContaIdRaw, clienteId }, db = pool) {
  if (clienteContaIdRaw === null || clienteContaIdRaw === undefined || String(clienteContaIdRaw).trim() === "") {
    return null;
  }
  const id = parseInt(clienteContaIdRaw, 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw criarErroHttp(400, { ok: false, erro: "cliente_conta_id invalido." });
  }
  if (clienteId == null) {
    throw criarErroHttp(400, {
      ok: false,
      erro: "Informe o cliente para registrar a operacao (cliente_conta_id) da entrega.",
    });
  }
  const { rows } = await db.query(
    "SELECT id, cliente_id, nome, ativo FROM cliente_contas WHERE id = $1",
    [id]
  );
  const conta = rows[0];
  if (!conta) {
    throw criarErroHttp(404, { ok: false, erro: "Conta nao encontrada." });
  }
  if (Number(conta.cliente_id) !== Number(clienteId)) {
    throw criarErroHttp(409, {
      ok: false,
      code: CODIGOS_CANONICOS.CONTA_NAO_PERTENCE_AO_CLIENTE,
      erro: "Esta conta nao pertence ao cliente informado.",
    });
  }
  return conta.id;
}

// Financeiro V3 — SNAPSHOT. A entrega (apresentação) aponta para a revisão
// financeira que ela mostra (fechamento_snapshots). O vínculo só é aceito
// quando é VERDADEIRO:
//   · só fechamento_mensal;
//   · mesmo cliente, mesma conta e mesma competência do snapshot;
//   · os números do payload (summary) são EXATAMENTE os do snapshot — editar
//     a apresentação (destaques, prioridades) nunca pode mudar LC/MC.
// Sem snapshot_id o comportamento é o de sempre (entrega antiga / legado).
// O repositório do snapshot é carregado sob demanda: quem não manda
// snapshot_id não toca nas tabelas novas.
function snapshotRepo() {
  return require("../repositories/fechamentoSnapshotRepository");
}

function normalizarSnapshotId(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === "") return null;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw criarErroHttp(400, { ok: false, code: "SNAPSHOT_INVALIDO", erro: "snapshot_id inválido." });
  }
  return id;
}

const comoJson = (v) => JSON.parse(JSON.stringify(v ?? null));

function conferirNumerosDoSnapshot(payloadJson, snapshot) {
  const summary = payloadJson && typeof payloadJson === "object" ? payloadJson.summary : undefined;
  if (summary === undefined) return;
  if (!isDeepStrictEqual(comoJson(summary), comoJson(snapshot.summary_json))) {
    throw criarErroHttp(409, {
      ok: false,
      code: "SNAPSHOT_DIVERGENTE",
      erro: `Os números desta entrega não são os da revisão v${snapshot.revisao}. A apresentação não altera o resultado — salve uma nova revisão.`,
    });
  }
}

async function resolverSnapshotDaEntrega({ snapshotId, tipo, clienteId, clienteContaId, periodo, payloadJson }) {
  if (snapshotId == null) return null;
  if (tipo !== "fechamento_mensal") {
    throw criarErroHttp(409, { ok: false, code: "SNAPSHOT_DIVERGENTE", erro: "Só fechamento mensal aponta para uma revisão do fechamento." });
  }
  const snap = await snapshotRepo().buscarIdentidadeDoSnapshot(snapshotId);
  if (!snap) throw criarErroHttp(404, { ok: false, code: "SNAPSHOT_NAO_ENCONTRADO", erro: "Revisão do fechamento não encontrada." });
  const competencia = normalizarCompetencia(periodo) || null;
  const divergencias = [];
  if (Number(snap.cliente_id) !== Number(clienteId)) divergencias.push("cliente");
  if (clienteContaId == null || Number(snap.cliente_conta_id) !== Number(clienteContaId)) divergencias.push("conta");
  if (competencia !== snap.periodo) divergencias.push("competência");
  if (divergencias.length) {
    throw criarErroHttp(409, {
      ok: false,
      code: "SNAPSHOT_DIVERGENTE",
      erro: `A revisão v${snap.revisao} não é desta entrega (${divergencias.join(", ")} diferente).`,
      campos: divergencias,
    });
  }
  conferirNumerosDoSnapshot(payloadJson, snap);
  return snap;
}

// V3 P2.6 D4 — duas entregas publicadas da MESMA competencia significam DOIS
// links publicos com numeros diferentes circulando para o mesmo cliente.
//
// Hoje nada no banco impede isso: nao existe UNIQUE(cliente, tipo, periodo) e
// o INSERT nao tem ON CONFLICT. O unico anti-duplicata era `_entregaIdSalvo`,
// uma variavel de memoria do browser que zera ao reprocessar, ao trocar de
// cliente e a cada F5.
//
// A guarda vive aqui, na aplicacao, DE PROPOSITO: o indice unico parcial
// (sql/migrations/20260828_entregas_cliente_unicidade_p26.sql) exige sanear as
// duplicatas que ja existem em producao ANTES de ser criado, e sanear e
// decisao humana sobre dado real. A guarda de aplicacao funciona sem o indice
// e continua correta depois dele.
//
// So vale para `fechamento_mensal` com competencia conhecida: e a unica
// combinacao com significado de unicidade. Entrega sem periodo, ou de outro
// tipo, continua livre.
const TIPOS_COM_COMPETENCIA_UNICA = new Set(["fechamento_mensal"]);

async function encontrarEntregaDaCompetencia({ tipo, clienteId, clienteContaId, periodo }, db = pool) {
  if (!TIPOS_COM_COMPETENCIA_UNICA.has(tipo)) return null;
  if (clienteId == null || !periodo) return null;

  const params = [tipo, clienteId, periodo];
  const filtroConta = clienteContaId == null
    ? "cliente_conta_id IS NULL"
    : `cliente_conta_id = $${params.push(clienteContaId)}`;

  const { rows } = await db.query(
    `SELECT id, status, publicado, token_publico, created_at
       FROM entregas_cliente
      WHERE tipo = $1 AND cliente_id = $2 AND periodo = $3 AND ${filtroConta}
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    params
  );
  return rows[0] || null;
}

async function criarEntrega({ userId, body }) {
  const tipo = validarTipo(body?.tipo);
  const titulo = validarTitulo(body?.titulo);

  const periodo = normalizarPeriodoParaEscrita(body?.periodo);

  const statusRaw = String(body?.status || "").trim().toLowerCase();
  const status = statusRaw ? statusRaw : "rascunho";

  const origemTipoRaw = body?.origem_tipo;
  const origemTipo =
    origemTipoRaw === null || origemTipoRaw === undefined || String(origemTipoRaw).trim() === ""
      ? null
      : String(origemTipoRaw).trim();

  const origemIdRaw = body?.origem_id;
  const origemIdParsed = origemIdRaw === null || origemIdRaw === undefined || origemIdRaw === ""
    ? null
    : parseInt(origemIdRaw, 10);
  const origemId = Number.isFinite(origemIdParsed) ? origemIdParsed : null;

  const expiresAt = parseTimestampOrNull(body?.expires_at);

  const cliente = await buscarClientePorSlugOuId({
    clienteIdRaw: body?.cliente_id,
    clienteSlugRaw: body?.cliente_slug,
  });

  const cliente_id = cliente ? cliente.id : null;
  const cliente_slug = cliente ? cliente.slug : (body?.cliente_slug ? normalizarSlug(body.cliente_slug) : null);
  const cliente_nome = cliente ? cliente.nome : (body?.cliente_nome ? String(body.cliente_nome).trim() : null);

  validarIdentidadeFechamento({ payloadJson: body?.payload_json, clienteSlugResolvido: cliente_slug });

  // V3 P2.6 D1 — a operacao que gerou o numero passa a ficar registrada.
  const cliente_conta_id = await resolverContaDaEntrega({
    clienteContaIdRaw: body?.cliente_conta_id ?? body?.clienteContaId,
    clienteId: cliente_id,
  });

  // Financeiro V3 — a revisão financeira que esta entrega apresenta.
  const snapshotId = normalizarSnapshotId(body?.snapshot_id ?? body?.snapshotId);
  await resolverSnapshotDaEntrega({
    snapshotId, tipo, clienteId: cliente_id, clienteContaId: cliente_conta_id, periodo, payloadJson: body?.payload_json,
  });

  // V3 P2.6 D4 — reprocessar nao pode duplicar em silencio.
  const existente = await encontrarEntregaDaCompetencia({
    tipo, clienteId: cliente_id, clienteContaId: cliente_conta_id, periodo,
  });
  if (existente) {
    const querSubstituir = body?.substituir === true || String(body?.substituir || "").toLowerCase() === "true";
    if (!querSubstituir) {
      // Devolve o id existente para o frontend poder oferecer "substituir"
      // em vez de criar um segundo link publico do mesmo mes.
      throw criarErroHttp(409, {
        ok: false,
        code: "ENTREGA_JA_EXISTE",
        erro: "Ja existe uma entrega desta competencia para este cliente/operacao. Use substituir=true para atualizar a existente.",
        entregaId: existente.id,
        publicado: !!existente.publicado,
      });
    }
    // Substituicao explicita de uma entrega que NUNCA teve link publico
    // (rascunho): ATUALIZA no lugar — nao ha link historico a proteger e nao
    // se acumulam rascunhos da mesma competencia.
    //
    // Entrega que JA teve link (token_publico existe, publicada ou depois
    // despublicada) e historico: o link divulgado identifica ESTA linha, e
    // reescrever o payload_json dela fazia o link antigo passar a abrir os
    // numeros do fechamento novo. Nesse caso nao se atualiza: segue para o
    // INSERT abaixo e o fechamento novo nasce como registro independente
    // (rascunho, sem token), ganhando o proprio link so quando for publicado.
    // O link antigo continua valido ate ser despublicado explicitamente.
    if (!existente.token_publico) {
      return atualizarEntrega({
        idRaw: existente.id,
        body: { ...body, substituir: undefined },
      });
    }
  }

  const payloadInput = body?.payload_json;
  const payloadVazio =
    payloadInput === null ||
    payloadInput === undefined ||
    (typeof payloadInput === "object" && !Array.isArray(payloadInput) && Object.keys(payloadInput || {}).length === 0);

  const payload_json = payloadVazio
    ? buildPayloadPadrao({
        tipo,
        titulo,
        periodo,
        cliente: cliente
          ? { id: cliente.id, slug: cliente.slug, nome: cliente.nome }
          : cliente_slug || cliente_nome
            ? { id: cliente_id, slug: cliente_slug, nome: cliente_nome }
            : null,
      })
    : payloadInput;

  // snapshot_id só entra no INSERT quando existe: sem ele, a query é a de
  // sempre (e não depende da coluna nova).
  const comSnapshot = snapshotId != null;
  const ins = await pool.query(
    `INSERT INTO entregas_cliente
      (tipo, cliente_id, cliente_conta_id, cliente_slug, cliente_nome, titulo, periodo,
       status, publicado, payload_json, origem_tipo, origem_id, created_by, expires_at${comSnapshot ? ", snapshot_id" : ""})
     VALUES
      ($1,$2,$13,$3,$4,$5,$6,$7,false,$8,$9,$10,$11,$12${comSnapshot ? ",$14" : ""})
     RETURNING
      id, tipo, cliente_id, cliente_conta_id, cliente_slug, cliente_nome, titulo, periodo, status,
      token_publico, publicado, payload_json, origem_tipo, origem_id,
      created_by, created_at, updated_at, published_at, expires_at${comSnapshot ? ", snapshot_id" : ""}`,
    [
      tipo,
      cliente_id,
      cliente_slug,
      cliente_nome,
      titulo,
      periodo,
      status,
      payload_json,
      origemTipo,
      origemId,
      userId || null,
      expiresAt,
      cliente_conta_id, // $13
      ...(comSnapshot ? [snapshotId] : []), // $14
    ]
  );

  return { ok: true, entrega: ins.rows[0] };
}

// `clienteIdsPermitidos`: carteira do usuario aplicada EM SQL. Antes o
// controller filtrava o array JA paginado pelo LIMIT/OFFSET e devolvia o
// `total` sem filtro — vazamento de contagem e paginas curtas/vazias. Passando
// a lista para ca, o COUNT e a paginacao concordam com o que o usuario pode ver.
// `null`/`undefined` = sem restricao (admin ou chamada interna); array VAZIO =
// carteira vazia, que devolve zero linhas (fail-closed), nunca "sem filtro".
async function listarEntregas({ query, clienteIdsPermitidos = null }) {
  const tipo = query?.tipo ? String(query.tipo).trim() : "";
  if (tipo && !TIPOS_PERMITIDOS.has(tipo)) {
    throw criarErroHttp(400, { ok: false, erro: "tipo inválido." });
  }

  const clienteSlug = query?.cliente_slug ? normalizarSlug(query.cliente_slug) : "";
  const clienteIdRaw = query?.cliente_id;
  const clienteIdParsed =
    clienteIdRaw === null || clienteIdRaw === undefined || String(clienteIdRaw).trim() === ""
      ? null
      : parseInt(clienteIdRaw, 10);
  const clienteId = Number.isFinite(clienteIdParsed) ? clienteIdParsed : null;

  const publicadoRaw = query?.publicado;
  const publicado =
    publicadoRaw === undefined || publicadoRaw === null || String(publicadoRaw).trim() === ""
      ? null
      : String(publicadoRaw).trim().toLowerCase() === "true";

  const limitRaw = parseInt(query?.limit, 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.max(limitRaw, 1), 500) : 100;

  const offsetRaw = parseInt(query?.offset, 10);
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;

  const where = [];
  const params = [];

  if (tipo) {
    params.push(tipo);
    where.push(`tipo = $${params.length}`);
  }
  if (clienteId !== null) {
    params.push(clienteId);
    where.push(`cliente_id = $${params.length}`);
  } else if (clienteSlug) {
    params.push(clienteSlug);
    where.push(`cliente_slug = $${params.length}`);
  }
  if (publicado !== null) {
    params.push(publicado);
    where.push(`publicado = $${params.length}`);
  }

  // V3 P2.6 D1 — filtro por operacao. `incluirSemConta` (default true) mantem
  // as entregas antigas (cliente_conta_id NULL) visiveis: elas nao pertencem a
  // outra conta, elas nao tem conta registrada. Esconde-las seria fingir que
  // o historico do cliente comeca na migracao.
  const contaIdRaw = query?.cliente_conta_id ?? query?.clienteContaId;
  const contaIdParsed =
    contaIdRaw === null || contaIdRaw === undefined || String(contaIdRaw).trim() === ""
      ? null
      : parseInt(contaIdRaw, 10);
  const contaId = Number.isFinite(contaIdParsed) && contaIdParsed > 0 ? contaIdParsed : null;
  if (contaId !== null) {
    params.push(contaId);
    const semConta = String(query?.incluir_sem_conta ?? "true").toLowerCase() !== "false";
    where.push(semConta
      ? `(cliente_conta_id = $${params.length} OR cliente_conta_id IS NULL)`
      : `cliente_conta_id = $${params.length}`);
  }

  if (Array.isArray(clienteIdsPermitidos)) {
    if (!clienteIdsPermitidos.length) {
      // Carteira vazia: nao existe entrega visivel. Nao cai em "sem filtro".
      return { ok: true, total: 0, entregas: [] };
    }
    params.push(clienteIdsPermitidos);
    where.push(`cliente_id = ANY($${params.length}::int[])`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const totalResult = await pool.query(
    `SELECT COUNT(*)::int AS total FROM entregas_cliente ${whereSql}`,
    params
  );

  params.push(limit);
  const limitIndex = params.length;
  params.push(offset);
  const offsetIndex = params.length;

  // Financeiro V3 (Relatórios gerados) — resumo de LEITURA do fechamento
  // gravado, para a lista dizer o modo e a cobertura sem trazer o
  // payload_json inteiro (nem um GET por linha). Só projeção: nenhum
  // filtro, ordem ou paginação muda. Entrega sem summary devolve null.
  const result = await pool.query(
    `SELECT
        id, tipo, cliente_id, cliente_conta_id, cliente_slug, cliente_nome, titulo, periodo, status,
        token_publico, publicado, origem_tipo, origem_id,
        created_by, created_at, updated_at, published_at, expires_at,
        payload_json->'summary'->>'calculationMode' AS modo_calculo,
        payload_json->'summary'->>'calculatedCoveragePercent' AS cobertura_custo_percentual,
        COALESCE(payload_json->>'marketplace', payload_json->'metadados'->>'marketplace') AS marketplace_payload
       FROM entregas_cliente
       ${whereSql}
       ORDER BY created_at DESC, id DESC
       LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
    params
  );

  return { ok: true, total: totalResult.rows[0]?.total || 0, entregas: result.rows };
}

async function buscarEntregaPorId({ idRaw }) {
  const id = parseInt(idRaw, 10);
  if (!Number.isFinite(id) || id <= 0) {
    throw criarErroHttp(400, { ok: false, erro: "id inválido." });
  }

  const r = await pool.query("SELECT * FROM entregas_cliente WHERE id = $1", [id]);
  if (!r.rows.length) throw criarErroHttp(404, { ok: false, erro: "Entrega não encontrada." });
  return { ok: true, entrega: r.rows[0] };
}

async function atualizarEntrega({ idRaw, body }) {
  const id = parseInt(idRaw, 10);
  if (!Number.isFinite(id) || id <= 0) {
    throw criarErroHttp(400, { ok: false, erro: "id inválido." });
  }

  const atual = await pool.query("SELECT * FROM entregas_cliente WHERE id = $1", [id]);
  if (!atual.rows.length) throw criarErroHttp(404, { ok: false, erro: "Entrega não encontrada." });

  const patches = [];
  const params = [];

  // Entrega que JA teve link publico (token_publico existe, publicada ou
  // depois despublicada) e historica: o link divulgado identifica ESTA linha.
  // Os campos que definem o que ela representa (tipo, titulo, periodo,
  // payload_json, cliente, operacao) nao podem mudar; PATCH que nao muda nada
  // de fato (ex.: segundo "Gerar link" do legado reenviando os mesmos dados) e
  // aceito. status e expires_at sao operacionais e seguem editaveis.
  const comLink = !!atual.rows[0].token_publico;
  const camposHistoricosAlterados = [];

  if (Object.prototype.hasOwnProperty.call(body || {}, "tipo")) {
    const tipo = validarTipo(body.tipo);
    if (comLink && tipo !== atual.rows[0].tipo) camposHistoricosAlterados.push("tipo");
    params.push(tipo);
    patches.push(`tipo = $${params.length}`);
  }

  if (Object.prototype.hasOwnProperty.call(body || {}, "titulo")) {
    const titulo = validarTitulo(body.titulo);
    if (comLink && titulo !== atual.rows[0].titulo) camposHistoricosAlterados.push("titulo");
    params.push(titulo);
    patches.push(`titulo = $${params.length}`);
  }

  if (Object.prototype.hasOwnProperty.call(body || {}, "periodo")) {
    const periodoNovo = normalizarPeriodoParaEscrita(body?.periodo);
    // Linhas anteriores ao P2.6 guardam texto livre ("Maio 2026"); compara
    // pela mesma normalizacao para nao acusar mudanca onde nao ha.
    if (comLink && periodoNovo !== normalizarPeriodoParaEscrita(atual.rows[0].periodo)) {
      camposHistoricosAlterados.push("periodo");
    }
    params.push(periodoNovo);
    patches.push(`periodo = $${params.length}`);
  }

  if (Object.prototype.hasOwnProperty.call(body || {}, "payload_json")) {
    const payload = body?.payload_json;
    if (payload === null || payload === undefined || typeof payload !== "object" || Array.isArray(payload)) {
      throw criarErroHttp(400, { ok: false, erro: "payload_json inválido." });
    }
    // JSON round-trip: o que o cliente mandou, como o banco (jsonb) devolveria.
    if (comLink && !isDeepStrictEqual(JSON.parse(JSON.stringify(payload)), atual.rows[0].payload_json)) {
      camposHistoricosAlterados.push("payload_json");
    }
    params.push(payload);
    patches.push(`payload_json = $${params.length}`);
  }

  if (Object.prototype.hasOwnProperty.call(body || {}, "expires_at")) {
    const expiresAt = parseTimestampOrNull(body?.expires_at);
    params.push(expiresAt);
    patches.push(`expires_at = $${params.length}`);
  }

  if (Object.prototype.hasOwnProperty.call(body || {}, "status")) {
    const status = String(body?.status || "").trim();
    if (!status) throw criarErroHttp(400, { ok: false, erro: "status inválido." });
    params.push(status);
    patches.push(`status = $${params.length}`);
  }

  let cliente_slug_final = atual.rows[0].cliente_slug;
  let clienteIdFinal = atual.rows[0].cliente_id;
  let contaIdFinal = atual.rows[0].cliente_conta_id ?? null;

  if (Object.prototype.hasOwnProperty.call(body || {}, "cliente_id") ||
      Object.prototype.hasOwnProperty.call(body || {}, "cliente_slug") ||
      Object.prototype.hasOwnProperty.call(body || {}, "cliente_nome")) {
    const cliente = await buscarClientePorSlugOuId({
      clienteIdRaw: body?.cliente_id,
      clienteSlugRaw: body?.cliente_slug,
    });

    const cliente_id = cliente ? cliente.id : null;
    const cliente_slug = cliente ? cliente.slug : (body?.cliente_slug ? normalizarSlug(body.cliente_slug) : null);
    const cliente_nome = cliente ? cliente.nome : (body?.cliente_nome ? String(body.cliente_nome).trim() : null);
    cliente_slug_final = cliente_slug;

    clienteIdFinal = cliente_id;

    // id e slug identificam o cliente; o nome so conta quando veio do body
    // (cliente nao resolvido), para renomear o cliente nao acusar mudanca.
    if (comLink && (
      (cliente_id ?? null) !== (atual.rows[0].cliente_id ?? null)
      || (cliente_slug ?? null) !== (atual.rows[0].cliente_slug ?? null)
      || (!cliente && (cliente_nome ?? null) !== (atual.rows[0].cliente_nome ?? null))
    )) {
      camposHistoricosAlterados.push("cliente");
    }

    params.push(cliente_id);
    patches.push(`cliente_id = $${params.length}`);
    params.push(cliente_slug);
    patches.push(`cliente_slug = $${params.length}`);
    params.push(cliente_nome);
    patches.push(`cliente_nome = $${params.length}`);
  }

  const payloadParaValidar = Object.prototype.hasOwnProperty.call(body || {}, "payload_json")
    ? body.payload_json
    : atual.rows[0].payload_json;
  validarIdentidadeFechamento({ payloadJson: payloadParaValidar, clienteSlugResolvido: cliente_slug_final });

  // V3 P2.6 D1 — registrar (ou limpar) a operacao de uma entrega ja criada.
  // Validado contra o cliente FINAL: se o mesmo PATCH tambem troca o cliente,
  // a conta tem que pertencer ao cliente NOVO, nunca ao antigo.
  if (Object.prototype.hasOwnProperty.call(body || {}, "cliente_conta_id")
      || Object.prototype.hasOwnProperty.call(body || {}, "clienteContaId")) {
    const bruto = Object.prototype.hasOwnProperty.call(body || {}, "cliente_conta_id")
      ? body.cliente_conta_id
      : body.clienteContaId;
    const contaId = await resolverContaDaEntrega({
      clienteContaIdRaw: bruto,
      clienteId: clienteIdFinal,
    });
    if (comLink && (contaId ?? null) !== (atual.rows[0].cliente_conta_id ?? null)) {
      camposHistoricosAlterados.push("cliente_conta_id");
    }
    contaIdFinal = contaId;
    params.push(contaId);
    patches.push(`cliente_conta_id = $${params.length}`);
  } else if (Object.prototype.hasOwnProperty.call(body || {}, "cliente_id")
             || Object.prototype.hasOwnProperty.call(body || {}, "cliente_slug")) {
    // Trocou o cliente sem dizer a nova conta: a operacao antiga passou a ser
    // de outro cliente, entao ela DEIXA de valer. Limpar e a resposta honesta
    // (mesma logica de P2.4 na transferencia de Squad).
    if (atual.rows[0].cliente_conta_id != null && clienteIdFinal !== atual.rows[0].cliente_id) {
      contaIdFinal = null;
      params.push(null);
      patches.push(`cliente_conta_id = $${params.length}`);
    }
  }

  // Financeiro V3 — revisão financeira da entrega. Trocar a revisão de um
  // RASCUNHO é explícito (o "Substituir" do fechamento); de uma entrega que
  // já teve link, nunca (campo histórico). E, enquanto a entrega apontar
  // para uma revisão, o payload não pode trazer números diferentes dos dela.
  const temSnapshotNoBody = Object.prototype.hasOwnProperty.call(body || {}, "snapshot_id")
    || Object.prototype.hasOwnProperty.call(body || {}, "snapshotId");
  const snapshotAtual = atual.rows[0].snapshot_id ?? null;
  const snapshotFinal = temSnapshotNoBody
    ? normalizarSnapshotId(body.snapshot_id ?? body.snapshotId)
    : snapshotAtual;
  if (temSnapshotNoBody) {
    if (comLink && (snapshotFinal ?? null) !== (snapshotAtual == null ? null : Number(snapshotAtual))) {
      camposHistoricosAlterados.push("snapshot_id");
    }
    params.push(snapshotFinal);
    patches.push(`snapshot_id = $${params.length}`);
  }
  if (snapshotFinal != null && !camposHistoricosAlterados.length) {
    const tipoFinal = Object.prototype.hasOwnProperty.call(body || {}, "tipo") ? String(body.tipo).trim() : atual.rows[0].tipo;
    const periodoFinal = Object.prototype.hasOwnProperty.call(body || {}, "periodo")
      ? normalizarPeriodoParaEscrita(body.periodo)
      : atual.rows[0].periodo;
    await resolverSnapshotDaEntrega({
      snapshotId: Number(snapshotFinal),
      tipo: tipoFinal,
      clienteId: clienteIdFinal,
      clienteContaId: contaIdFinal,
      periodo: periodoFinal,
      payloadJson: payloadParaValidar,
    });
  }

  if (camposHistoricosAlterados.length) {
    throw criarErroHttp(409, {
      ok: false,
      code: "ENTREGA_PUBLICADA_IMUTAVEL",
      erro: "Esta entrega ja teve link publico e nao pode ter seu conteudo alterado. Crie uma nova entrega para o novo fechamento.",
      entregaId: id,
      campos: camposHistoricosAlterados,
    });
  }

  if (!patches.length) {
    throw criarErroHttp(400, { ok: false, erro: "Nenhum campo para atualizar." });
  }

  patches.push(`updated_at = NOW()`);

  params.push(id);
  const r = await pool.query(
    `UPDATE entregas_cliente SET ${patches.join(", ")} WHERE id = $${params.length} RETURNING *`,
    params
  );

  return { ok: true, entrega: r.rows[0] };
}

async function publicarEntrega({ idRaw }) {
  const id = parseInt(idRaw, 10);
  if (!Number.isFinite(id) || id <= 0) {
    throw criarErroHttp(400, { ok: false, erro: "id inválido." });
  }

  const atual = await pool.query(
    "SELECT id, token_publico FROM entregas_cliente WHERE id = $1",
    [id]
  );
  if (!atual.rows.length) throw criarErroHttp(404, { ok: false, erro: "Entrega não encontrada." });

  const token = atual.rows[0].token_publico || gerarTokenPublico();

  const upd = await pool.query(
    `UPDATE entregas_cliente
        SET publicado = true,
            status = 'publicado',
            token_publico = $1,
            published_at = COALESCE(published_at, NOW()),
            updated_at = NOW()
      WHERE id = $2
      RETURNING *`,
    [token, id]
  );

  return { ok: true, entrega: upd.rows[0] };
}

async function despublicarEntrega({ idRaw }) {
  const id = parseInt(idRaw, 10);
  if (!Number.isFinite(id) || id <= 0) {
    throw criarErroHttp(400, { ok: false, erro: "id inválido." });
  }

  const atual = await pool.query("SELECT id FROM entregas_cliente WHERE id = $1", [id]);
  if (!atual.rows.length) throw criarErroHttp(404, { ok: false, erro: "Entrega não encontrada." });

  const upd = await pool.query(
    `UPDATE entregas_cliente
        SET publicado = false,
            status = 'rascunho',
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [id]
  );

  return { ok: true, entrega: upd.rows[0] };
}

async function excluirEntrega({ idRaw }) {
  const id = parseInt(idRaw, 10);
  if (!Number.isFinite(id) || id <= 0) {
    throw criarErroHttp(400, { ok: false, erro: "id inválido." });
  }

  const del = await pool.query("DELETE FROM entregas_cliente WHERE id = $1 RETURNING id", [id]);
  if (!del.rows.length) throw criarErroHttp(404, { ok: false, erro: "Entrega não encontrada." });
  return { ok: true };
}

async function buscarEntregaPublicaPorToken({ tokenRaw }) {
  const token = String(tokenRaw || "").trim();
  if (!token) throw criarErroHttp(400, { ok: false, erro: "token é obrigatório." });

  const r = await pool.query(
    `SELECT
        id, tipo, cliente_slug, cliente_nome, titulo, periodo,
        payload_json, publicado, created_at, updated_at, published_at, expires_at
       FROM entregas_cliente
      WHERE token_publico = $1
        AND publicado = true
        AND (expires_at IS NULL OR expires_at > NOW())
      LIMIT 1`,
    [token]
  );

  if (!r.rows.length) {
    throw criarErroHttp(404, { ok: false, erro: "Entrega não encontrada ou não publicada." });
  }

  return { ok: true, entrega: r.rows[0] };
}

module.exports = {
  criarEntrega,
  listarEntregas,
  buscarEntregaPorId,
  atualizarEntrega,
  publicarEntrega,
  despublicarEntrega,
  excluirEntrega,
  buscarEntregaPublicaPorToken,
};

