// server/tests/sentinelOperacao.postgres.cjs
//
// Leitura operacional (S1.5) contra um PostgreSQL LOCAL descartável (fora do run-all):
//   SENTINEL_TEST_DATABASE_URL=postgres://vf@127.0.0.1:57652/postgres node tests/sentinelOperacao.postgres.cjs
// Cria vf_sentinel_oper_<ts>, aplica as migrations do Sentinel (20261023/27/28/19), grava as linhas do contrato
// (worker_processo, billing_agenda, billing_429) DIRETAMENTE, roda o SQL REAL de lerOperacao e a rota HTTP, e apaga o
// banco. Nunca lê server/.env, nunca chama o Mercado Livre, recusa host não-local.

const assert = require("assert");
const crypto = require("crypto");
const { Pool } = require("pg");

const baseUrl = process.env.SENTINEL_TEST_DATABASE_URL;
if (!baseUrl) throw new Error("Defina SENTINEL_TEST_DATABASE_URL (PostgreSQL local).");
const parsed = new URL(baseUrl);
if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) throw new Error("LOCAL_DATABASE_REQUIRED");
console.log(`[sentinel.operacao.postgres] host=${parsed.hostname} port=${parsed.port}`);
const dbName = `vf_sentinel_oper_${Date.now()}`;
const testUrl = new URL(baseUrl);
testUrl.pathname = `/${dbName}`;
process.env.DATABASE_URL = testUrl.toString();

let checks = 0;
const ok = (label, cond) => { assert.ok(cond, `FALHOU: ${label}`); checks += 1; console.log(`  ok  ${label}`); };
const eq = (label, a, b) => { assert.deepStrictEqual(a, b, `FALHOU: ${label}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); checks += 1; console.log(`  ok  ${label}`); };

const MIN = 60000;
const HORA = 60 * MIN;
const DIA = 24 * HORA;
const AGORA = Math.floor(Date.now() / 1000) * 1000;
const iso = (ms) => new Date(ms).toISOString();

const FIXTURE_SQL = `
CREATE TABLE clientes (id integer PRIMARY KEY, nome text, slug text UNIQUE, ativo boolean DEFAULT true);
CREATE TABLE cliente_contas (id integer PRIMARY KEY, cliente_id integer REFERENCES clientes(id) ON DELETE CASCADE, marketplace text,
  nome text, slug text, external_account_id text, is_primary boolean, ativo boolean);
CREATE TABLE squads (id integer PRIMARY KEY, nome text, slug text, ativo boolean DEFAULT true);
CREATE TABLE cliente_squad_history (id serial PRIMARY KEY, cliente_id integer, squad_id integer, fim_em timestamp);
CREATE TABLE ml_tokens (id serial PRIMARY KEY, cliente_id integer, ml_user_id text, access_token text, refresh_token text,
  expires_at timestamp, created_at timestamp DEFAULT now(), updated_at timestamp DEFAULT now(), cliente_conta_id integer,
  is_primary boolean DEFAULT false, token_status text DEFAULT 'valid', refresh_failures integer DEFAULT 0, last_refresh_error text,
  last_refresh_error_at timestamp, next_refresh_attempt_at timestamp, superseded_by_grant_id integer, superseded_at timestamp, superseded_reason text);
INSERT INTO clientes VALUES (1, 'Loja Tres', 'loja-3', true), (2, 'Loja Quarenta', 'loja-41', true), (3, 'Loja Oitenta', 'loja-86', true);
INSERT INTO cliente_contas VALUES (3, 1, 'meli', 'Conta 3', 'c3', '1003', true, true), (41, 2, 'meli', 'Conta 41', 'c41', '1041', true, true),
  (86, 3, 'meli', 'Conta 86', 'c86', '1086', true, true);
INSERT INTO squads VALUES (100, 'Squad Azul', 'azul', true);
INSERT INTO cliente_squad_history (cliente_id, squad_id, fim_em) VALUES (2, 100, NULL);
`;

async function main() {
  const admin = new Pool({ connectionString: baseUrl, ssl: false, max: 1 });
  const avisos = [];
  admin.on("error", (e) => avisos.push(`admin: ${e.message}`));
  await admin.query(`CREATE DATABASE "${dbName}"`);
  const pool = new Pool({ connectionString: testUrl.toString(), ssl: false, max: 4 });
  pool.on("error", (e) => avisos.push(`pool: ${e.message}`));
  // config/database.js força a configuração de produção: injeta o pool local ANTES de carregar rota/serviços.
  const dbPath = require.resolve("../config/database");
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: pool };
  const { ensureSentinelSchema, ensureSentinelIncidentesSchema, ensureSentinelConciliacaoSchema } = require("../services/sentinel/sentinelSchema");
  const O = require("../services/sentinel/sentinelOperacao");
  const q = async (sql, p) => (await pool.query(sql, p)).rows;

  // pool que registra TODO SQL enviado pela leitura (prova de que nada além de SELECT/controle de transação sai)
  const enviados = [];
  const poolEspiao = {
    connect: async () => {
      const c = await pool.connect();
      return { query: (sql, p) => { enviados.push(typeof sql === "string" ? sql : sql.text); return c.query(sql, p); }, release: () => c.release() };
    },
    query: (sql, p) => { enviados.push(sql); return pool.query(sql, p); },
  };
  const TABELAS = ["sentinel_pedidos", "sentinel_checkpoints", "sentinel_pedido_excecoes", "sentinel_conciliacao_comissao", "sentinel_conciliacao_controle", "sentinel_incidentes", "ml_tokens", "cliente_contas"];
  const fotografia = async () => {
    const out = {};
    for (const t of TABELAS) out[t] = crypto.createHash("md5").update(JSON.stringify(await q(`SELECT * FROM ${t} ORDER BY 1, 2`))).digest("hex");
    return out;
  };

  try {
    await q(FIXTURE_SQL);
    await ensureSentinelSchema(pool);
    await ensureSentinelIncidentesSchema(pool);
    await ensureSentinelConciliacaoSchema(pool);

    // ── grants (com segredos plantados: nunca podem aparecer na resposta) ──
    await q(`INSERT INTO ml_tokens (cliente_id, ml_user_id, access_token, refresh_token, expires_at, is_primary, token_status, refresh_failures, last_refresh_error, last_refresh_error_at, superseded_by_grant_id, superseded_at, superseded_reason)
             VALUES (1, '1003', 'APP_USR-SEGREDO-3', 'TG-SEGREDO-3', $1, true, 'valid', 0, NULL, NULL, NULL, NULL, NULL),
                    (2, '1041', 'APP_USR-SEGREDO-41', 'TG-SEGREDO-41', $1, true, 'error', 2, 'invalid_grant refresh_token=TG-VAZOU', $2, NULL, NULL, NULL),
                    (3, '1086', 'APP_USR-SEGREDO-86', 'TG-SEGREDO-86', $3, true, 'valid', 0, NULL, NULL, NULL, NULL, NULL)`,
    [new Date(AGORA + 5 * HORA), new Date(AGORA - HORA), new Date(AGORA - 30 * MIN)]);
    // grant antigo SUBSTITUÍDO da conta 3 (revogado): ignorado
    await q(`INSERT INTO ml_tokens (cliente_id, ml_user_id, access_token, refresh_token, expires_at, is_primary, token_status, superseded_by_grant_id, superseded_at, superseded_reason)
             VALUES (1, '1003', 'APP_USR-VELHO', 'TG-VELHO', $1, false, 'revoked', 1, now(), 'reconexao')`, [new Date(AGORA - DIA)]);

    // ── checkpoints / exceções ──
    await q(`INSERT INTO sentinel_checkpoints (cliente_conta_id, ultimo_date_last_updated, ultima_execucao_em, ultimo_erro, pedidos_processados_ultima, ciclos_sem_progresso)
             VALUES (3, $1, $1, NULL, 7, 0), (41, $2, $1, NULL, 3, 4), (86, $3, $4, 'SENTINEL_CICLO_ORCAMENTO: SENTINEL_CICLO_MAX_MS esgotado; retoma no próximo ciclo.', 0, 1)`,
    [new Date(AGORA - MIN), new Date(AGORA - 10 * MIN), new Date(AGORA - 5 * HORA), new Date(AGORA - 2 * MIN)]);
    await q(`INSERT INTO sentinel_pedido_excecoes (cliente_conta_id, pedido_id, motivo, status, primeiro_erro_em)
             VALUES (86, '9901', 'erro', 'quarentena', $1), (86, '9902', 'erro', 'quarentena', $2), (86, '9903', 'erro', 'retentando', $2), (41, '9904', 'erro', 'resolvido', $2)`,
    [new Date(AGORA - 3 * DIA), new Date(AGORA - DIA)]);

    // ── pedidos ──
    const CLI = { 3: 1, 41: 2, 86: 3 };
    const pedido = async (conta, id, { atrasMs = 2 * DIA, status = "paid", estado = "confirmada", itens = null, comissao = 6.21 } = {}) => {
      await q(`INSERT INTO sentinel_pedidos (cliente_id, cliente_conta_id, pedido_id, competencia, data_pedido, status_ml, itens, faturamento, comissao, estado_margem, payload_hash)
               VALUES ($1, $2, $3, '2026-11', $4, $5, $6::jsonb, 57.54, $7, $8, $9)`,
      [CLI[conta], conta, String(id), new Date(AGORA - atrasMs), status, JSON.stringify(itens || [{ item_id: `MLB${id}`, quantidade: 1, preco: 57.54 }]), comissao, estado, `h-${id}`]);
    };
    const conc = async (conta, id, { estado, motivos = [], status = "concluida", doc = null, definitivo = false, proxima = null, falhas = 0, descontos = null, observado = AGORA - HORA }) => {
      const comprovada = estado.startsWith("TARIFA_");
      await q(`INSERT INTO sentinel_conciliacao_comissao (cliente_conta_id, pedido_id, estado, motivos, contrato_versao, evidencia_versao, comissao_centavos,
                 gross_centavos, net_centavos, rebate_centavos, discount_centavos, cobrancas_tarifa_centavos, documento, documento_definitivo, descontos_min,
                 pedido_payload_hash, status_coleta, observacoes, falhas_consecutivas, proxima_tentativa_em, observado_em, atualizado_em)
               VALUES ($1, $2, $3, $4::text[], 1, 1, 621, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, 1, $15, $16, $17, COALESCE($17, now()))`,
      [conta, String(id), estado, motivos, comprovada ? 700 : null, comprovada ? 621 : null, comprovada ? 79 : null, comprovada ? 0 : null, comprovada ? 621 : null,
        doc, definitivo, descontos ? JSON.stringify(descontos) : null, `h-${id}`, status, falhas, proxima === null ? null : new Date(proxima), observado === null ? null : new Date(observado)]);
    };

    // conta 3: TARIFA_LIQUIDA_COMPROVADA com documento provisório (padrão real) + definitivo + lacunas
    await pedido(3, 301, { atrasMs: 2 * DIA });
    await conc(3, 301, { estado: "TARIFA_LIQUIDA_COMPROVADA", motivos: ["documento_em_processamento"], status: "reconsultar", doc: "PROCESSING", proxima: AGORA + 12 * HORA });
    await pedido(3, 302, { atrasMs: 3 * DIA });
    await conc(3, 302, { estado: "TARIFA_LIQUIDA_COMPROVADA", doc: "PROCESSED", definitivo: true });
    await pedido(3, 303, { atrasMs: HORA });                                         // imaturo (< 6 h)
    await pedido(3, 304, { atrasMs: 5 * DIA });                                      // elegível sem consulta
    await pedido(3, 305, { atrasMs: 2 * DIA, itens: [{ quantidade: 1 }, { quantidade: 1 }] }); // fora do escopo (2 itens)
    await pedido(3, 306, { atrasMs: 4 * DIA, estado: "sem_custo" });                 // elegível sem consulta + custo ausente
    await pedido(3, 307, { atrasMs: 33 * DIA });                                     // saiu da janela sem consulta (cobertura perdida)
    await pedido(3, 308, { atrasMs: 50 * DIA });                                     // documento provisório antigo (> 45 d)
    await conc(3, 308, { estado: "TARIFA_LIQUIDA_COMPROVADA", motivos: ["documento_em_processamento"], status: "esgotada", doc: "PROCESSING", proxima: AGORA + 3 * DIA });
    // conta 41: cupom/cashback concluídas (escopo), transitórias vencidas, fora da janela de reconsulta
    await pedido(41, 4101, { atrasMs: 2 * DIA });
    await conc(41, 4101, { estado: "NAO_CONCILIADO", motivos: ["cupom_nao_validado"] });
    await pedido(41, 4102, { atrasMs: 3 * DIA });
    await conc(41, 4102, { estado: "NAO_CONCILIADO", motivos: ["cashback_nao_validado"] });
    await pedido(41, 4103, { atrasMs: 4 * DIA });
    await conc(41, 4103, { estado: "NAO_CONCILIADO", motivos: ["sem_registro_billing"], status: "reconsultar", proxima: AGORA - 2 * DIA });
    await pedido(41, 4104, { atrasMs: 10 * DIA });
    await conc(41, 4104, { estado: "NAO_CONCILIADO", motivos: ["coleta_billing_falhou"], status: "falha", proxima: AGORA - HORA, falhas: 2, observado: null });
    await pedido(41, 4105, { atrasMs: 70 * DIA });
    await conc(41, 4105, { estado: "NAO_CONCILIADO", motivos: ["sem_registro_billing"], status: "reconsultar", proxima: AGORA - 40 * DIA });
    await pedido(41, 4106, { atrasMs: 2 * DIA, estado: "custo_ambiguo" });
    // conta 86: padrões reais — /discounts 404 (marcador), cobranças que não somam o net, subtipo desconhecido
    await pedido(86, 8601, { atrasMs: 2 * DIA });
    await conc(86, 8601, { estado: "NAO_CONCILIADO", motivos: ["descontos_indisponiveis_nao_validado"], descontos: { indisponivel_http: 404 } });
    await pedido(86, 8602, { atrasMs: 3 * DIA });
    await conc(86, 8602, { estado: "DIVERGENTE", motivos: ["cobrancas_nao_somam_net", "documento_em_processamento"], status: "reconsultar", doc: "PROCESSING", proxima: AGORA + 6 * HORA });
    await pedido(86, 8603, { atrasMs: 4 * DIA });
    await conc(86, 8603, { estado: "NAO_CONCILIADO", motivos: ["subtipo_cobranca_desconhecido"], status: "reconsultar", proxima: AGORA + 6 * HORA });

    // ── linhas do contrato S1.5 (gravadas direto, no formato de docs/sentinel/CONTRATO_S1_5_OPERACAO.md) ──
    const worker = {
      v: 1, instancia: "srv-sentinel-abcd", commit: "b32f4d89aa11", pid: 41, iniciadoEm: iso(AGORA - 20 * MIN), heartbeatEm: iso(AGORA - MIN),
      encerradoEm: null, encerramento: null, memoria: { rssMb: 81, heapUsedMb: 33 },
      polling: { habilitado: true, contas: [3, 41, 86], intervaloMs: 180000, ultimoCicloEm: iso(AGORA - MIN), ultimoCicloMs: 9100, ultimoCicloPedidos: 10,
        ultimoCicloEstado: "concluido", ultimoCicloErro: null, falhasSeguidas: 0, falhaBoot: null },
      billing: { habilitado: true, contas: [3, 41, 86], intervaloMs: 6 * HORA, emExecucao: false, ultimaVerificacaoEm: iso(AGORA - MIN) },
      anterior: { instancia: "srv-sentinel-wxyz", commit: "b32f4d89aa11", heartbeatEm: iso(AGORA - 25 * MIN), encerramento: null },
    };
    const agenda = {
      v: 1, execucaoId: "b-1763550000000-a1b2", instancia: "srv-sentinel-abcd", inicioEm: iso(AGORA - 8 * HORA - 2 * MIN), fimEm: iso(AGORA - 8 * HORA), duracaoMs: 120000,
      resultado: "abortada", chamadas: 9, gravados: 6, parou429: false,
      contas: [{ contaId: 41, candidatos: 2, chamadasBilling: 1, chamadasDescontos: 2, gravados: 2, falhas: 0, parada: null },
        { contaId: 86, candidatos: 3, chamadasBilling: 1, chamadasDescontos: 3, gravados: 3, falhas: 0, parada: "prazo" },
        { contaId: 999, candidatos: 1, chamadasBilling: 1, chamadasDescontos: 0, gravados: 1, falhas: 0, parada: null }],
      erro: "prazo da execução esgotado", intervaloMs: 6 * HORA,
    };
    await q(`INSERT INTO sentinel_conciliacao_controle (chave, pausado_ate, ocorrencias, motivo, atualizado_em) VALUES
               ('worker_processo', NULL, 7, $1, $2), ('billing_agenda', $3, 2, $4, $5), ('billing_429', $6, 0, 'HTTP 429 do Billing (Retry-After 60s)', $7)`,
    [JSON.stringify(worker), new Date(AGORA - MIN), new Date(AGORA - 2 * HORA), JSON.stringify(agenda), new Date(AGORA - 8 * HORA), new Date(AGORA - 9 * HORA), new Date(AGORA - 9 * HORA)]);

    // ════ leitura completa (carteira = 3, 41, 86) ════
    const antes = await fotografia();
    enviados.length = 0;
    const op = await O.lerOperacao(poolEspiao, { contaIds: [3, 41, 86], agora: AGORA, env: {} });
    const depois = await fotografia();
    eq("nenhuma tabela mudou (hash do conteúdo antes/depois)", depois, antes);
    eq("transação READ ONLY aberta primeiro", enviados[0], "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    ok("nenhum INSERT/UPDATE/DELETE/DDL enviado", !enviados.some((s) => /^\s*(\/\*[^*]*\*\/\s*)?(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/i.test(s)));
    ok("ml_tokens: nunca seleciona access_token/refresh_token/last_refresh_error", !enviados.filter((s) => s.includes("ml_tokens")).some((s) => /access_token|refresh_token|last_refresh_error\b|to_jsonb/.test(s)));
    eq("disponível", op.disponivel, true);

    // worker
    eq("worker vivo pelo heartbeat", [op.worker.estado, op.worker.fonte, op.worker.boots, op.worker.commit], ["vivo", "heartbeat", 7, "b32f4d89aa11"]);
    eq("reinício inesperado (mesmo commit, anterior sem encerramento limpo)", op.worker.reinicioInesperado, true);
    eq("billing publicado pelo worker", [op.billing.habilitado, op.billing.intervaloMs], [true, 6 * HORA]);
    eq("última execução do Billing", [op.billing.ultimaExecucao.resultado, op.billing.ultimaExecucao.chamadas, op.billing.ultimaExecucao.duracaoMs], ["abortada", 9, 120000]);
    eq("contas da execução: só as da carteira (999 fora)", op.billing.ultimaExecucao.contas.map((c) => c.contaId), [41, 86]);
    eq("próxima execução e falhas seguidas", [op.billing.proximaExecucaoEm, op.billing.falhasSeguidas], [iso(AGORA - 2 * HORA), 2]);
    eq("pausa 429 expirada", [op.billing.pausa429.ativa, op.billing.pausa429.ocorrencias], [false, 0]);

    // polling (motor existente)
    eq("polling por checkpoints ativo", op.polling.porCheckpoint.estado, "ativo");
    const c = Object.fromEntries(op.contas.map((x) => [x.contaId, x]));
    eq("contas na ordem do motor", op.contas.map((x) => x.contaId).sort((a, b) => a - b), [3, 41, 86]);
    eq("conta 41: ciclos sem progresso", c[41].polling.ciclosSemProgresso, 4);
    eq("conta 86: leitura atrasada com erro (regra existente) + quarentena", [c[86].polling.situacao, c[86].polling.leituraSeveridade, c[86].polling.quarentena, c[86].polling.retentando], ["erro", "alta", 2, 1]);
    eq("squad vem do vínculo existente", c[41].squad, { id: 100, nome: "Squad Azul" });

    // cobertura
    const k3 = c[3].cobertura;
    eq("conta 3: monitorados/elegíveis/consultados/semConsulta", [k3.monitorados30d, k3.elegiveis, k3.consultados, k3.semConsulta], [6, 4, 2, 2]);
    eq("conta 3: porEstado", k3.porEstado, { TARIFA_LIQUIDA_COMPROVADA: 2, TARIFA_BRUTA_COMPROVADA: 0, DIVERGENTE: 0, NAO_CONCILIADO: 0 });
    eq("conta 3: documento provisório (janela) e antigo", [k3.documentosProvisorios, k3.documentosProvisoriosAntigos], [1, 1]);
    eq("conta 3: saiu da janela sem consulta e custo ausente", [k3.sairamDaJanelaSemConsulta7d, k3.custoAusente], [1, 1]);
    eq("conta 3: motivosTop", k3.motivosTop, [{ motivo: "documento_em_processamento", categoria: "aviso", transitorio: false, n: 1 }]);
    const k41 = c[41].cobertura;
    eq("conta 41: elegíveis/consultados", [k41.monitorados30d, k41.elegiveis, k41.consultados, k41.semConsulta], [5, 5, 4, 1]);
    eq("conta 41: NAO_CONCILIADO escopo × transitório × bloqueio", [k41.naoConciliadoEscopo, k41.naoConciliadoTransitorio, k41.naoConciliadoBloqueio], [2, 2, 0]);
    eq("conta 41: status de coleta", k41.porStatusColeta, { concluida: 2, reconsultar: 1, falha: 1, esgotada: 0 });
    eq("conta 41: reconsultas vencidas / antigas / fora da janela / falhas", [k41.reconsultasVencidas, k41.reconsultasVencidasAntigas, k41.reconsultasForaDaJanela, k41.falhasColeta], [2, 1, 1, 1]);
    const k86 = c[86].cobertura;
    eq("conta 86: porEstado", k86.porEstado, { TARIFA_LIQUIDA_COMPROVADA: 0, TARIFA_BRUTA_COMPROVADA: 0, DIVERGENTE: 1, NAO_CONCILIADO: 2 });
    eq("conta 86: 404 de descontos = escopo; subtipo desconhecido = bloqueio", [k86.naoConciliadoEscopo, k86.naoConciliadoTransitorio, k86.naoConciliadoBloqueio], [1, 0, 1]);
    eq("conta 86: motivos reais", k86.motivosTop.map((m) => `${m.motivo}:${m.categoria}`).sort(),
      ["cobrancas_nao_somam_net:divergencia", "descontos_indisponiveis_nao_validado:escopo", "documento_em_processamento:aviso", "subtipo_cobranca_desconhecido:bloqueio"]);
    eq("totais = soma das contas", [op.cobertura.elegiveis, op.cobertura.consultados, op.cobertura.porEstado.NAO_CONCILIADO], [12, 9, 6]);

    // grants
    eq("grants: 3 ok (substituído revogado ignorado), 41 atenção, 86 expirado", [c[3].grant.situacao, c[41].grant.situacao, c[41].grant.refreshFalhas, c[86].grant.situacao, c[86].grant.motivo],
      ["ok", "atencao", 2, "indisponivel", "expirado"]);

    // sinais
    const chaves = op.sinais.map((s) => `${s.dedupKey}/${s.severidade}`).sort();
    eq("sinais esperados (tipo:conta/severidade)", chaves, [
      "billing_atrasado:global/alta",
      "billing_falhas_seguidas:global/alta",
      "cobertura_perdida:3/media",
      "conta_sem_progresso:41/alta",
      "conta_sem_progresso:86/alta",
      "custo_ausente:3/info",
      "custo_ausente:41/info",
      "documento_provisorio_antigo:3/info",
      "grant_indisponivel:86/alta",
      "pedidos_em_quarentena:86/media",
      "reconsultas_fora_da_janela:41/media",
      "reconsultas_vencidas_acumuladas:41/media",
      "worker_reinicio_inesperado:global/media",
    ]);
    ok("sinais ordenados por severidade", op.sinais.map((s) => O.SEVERIDADES.indexOf(s.severidade)).every((v, i, a) => i === 0 || a[i - 1] <= v));
    const json = JSON.stringify(op);
    for (const p of ["SEGREDO", "TG-VAZOU", "invalid_grant", "APP_USR", "access_token", "refresh_token"]) ok(`resposta sem "${p}"`, !json.includes(p));
    ok("nenhum sinal fala em prejuízo", !JSON.stringify(op.sinais).toLowerCase().includes("prejuízo"));
    console.log("\n── exemplo (encurtado) ──");
    console.log(JSON.stringify({ ...op, contas: op.contas.filter((x) => x.contaId === 86), sinais: op.sinais.slice(0, 3) }, null, 1).slice(0, 6000));

    // ════ carteira restrita (só 41) ════
    const so41 = await O.lerOperacao(pool, { contaIds: [41], agora: AGORA, env: {} });
    eq("carteira [41]: só a conta 41", so41.contas.map((x) => x.contaId), [41]);
    eq("carteira [41]: listas do worker filtradas", [so41.worker.polling.contas, so41.worker.billing.contas, so41.billing.ultimaExecucao.contas.map((x) => x.contaId)], [[41], [41], [41]]);
    ok("carteira [41]: nenhum sinal de 3/86", so41.sinais.every((s) => s.contaId === null || s.contaId === 41));
    ok("carteira [41]: nada de 'Loja Oitenta'/'Loja Tres'", !/Loja Oitenta|Loja Tres/.test(JSON.stringify(so41)));

    // ════ rota HTTP real (gate do router; auth/acesso falsos; motor e banco reais) ════
    const express = require("express");
    const { criarSentinelRouter } = require("../routes/sentinelRoutes");
    const app = express();
    app.use("/sentinel", criarSentinelRouter({
      auth: (req, res, next) => { if (!req.headers["x-user"]) return res.status(401).json({ ok: false }); req.user = JSON.parse(req.headers["x-user"]); next(); },
      db: pool,
      acesso: { papelPermitido: (u) => u.role === "admin", contasAutorizadas: async () => ({ contaIds: [3, 86], contas: [] }), contaAutorizadaInfo: async () => null },
    }));
    const srv = await new Promise((res) => { const s = app.listen(0, "127.0.0.1", () => res(s)); });
    try {
      const url = `http://127.0.0.1:${srv.address().port}/sentinel/operacao`;
      eq("rota: sem usuário 401", (await fetch(url)).status, 401);
      eq("rota: papel sem acesso 403", (await fetch(url, { headers: { "x-user": JSON.stringify({ id: 9, role: "seller" }) } })).status, 403);
      const antesRota = await fotografia();
      const r = await fetch(url, { headers: { "x-user": JSON.stringify({ id: 1, role: "admin" }) } });
      const body = await r.json();
      eq("rota: 200 com carteira [3, 86]", [r.status, body.operacao.contas.map((x) => x.contaId).sort((a, b) => a - b)], [200, [3, 86]]);
      eq("rota: nada gravado", await fotografia(), antesRota);
      ok("rota: sem segredos", !/SEGREDO|APP_USR|access_token|refresh_token/.test(JSON.stringify(body)));
    } finally {
      await new Promise((res) => srv.close(res));
    }

    // ════ sem as tabelas da 20261119 ⇒ disponivel:false, só polling/grants, nunca lança ════
    await q("DROP TABLE sentinel_conciliacao_comissao; DROP TABLE sentinel_conciliacao_controle;");
    const sem = await O.lerOperacao(pool, { contaIds: [3, 41, 86], agora: AGORA, env: {} });
    eq("sem 20261119: disponivel false + motivo", [sem.disponivel, sem.motivo], [false, "migration_20261119_nao_aplicada"]);
    eq("sem 20261119: worker sem_dados, billing/cobertura nulos", [sem.worker.estado, sem.billing, sem.cobertura, sem.contas[0].cobertura], ["sem_dados", null, null, null]);
    eq("sem 20261119: polling e grants continuam", [sem.polling.porCheckpoint.estado, sem.contas.find((x) => x.contaId === 86).grant.situacao], ["ativo", "indisponivel"]);
    ok("sem 20261119: nenhum sinal de cobertura/Billing", !sem.sinais.some((s) => /^(billing|cobertura|reconsultas|documento|custo|worker)/.test(s.tipo)));

    // ════ ml_tokens sem as colunas novas ⇒ grant 'desconhecido' (SAVEPOINT; resto da leitura intacto) ════
    await q("ALTER TABLE ml_tokens DROP COLUMN refresh_failures");
    const semCol = await O.lerOperacao(pool, { contaIds: [3], agora: AGORA, env: {} });
    eq("ml_tokens incompleto: grant desconhecido, leitura segue", [semCol.contas[0].grant.situacao, semCol.polling.porCheckpoint.estado], ["desconhecido", "ativo"]);
  } finally {
    await pool.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  }
  if (avisos.length) console.log(`(avisos de conexão no encerramento: ${avisos.length})`);
  console.log(`\n✓ sentinelOperacao.postgres: ${checks} verificações`);
}

main().catch((err) => { console.error(err); process.exit(1); });
