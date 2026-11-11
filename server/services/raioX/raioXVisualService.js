// server/services/raioX/raioXVisualService.js
//
// Camada de composição do Raio-X VISUAL. Reaproveita o serviço read-only
// (gerarRaioXCliente) e o catálogo de motores; acrescenta: visão geral do banco,
// lista de clientes/contas, vínculos de reuso, visão por motor e oportunidades.
//
// Tudo roda em BEGIN READ ONLY com statement_timeout; nunca escreve. Nada aqui
// conecta sozinho: quem chama entrega o `db` (pool) — o script só o cria com
// --real e RAIO_X_DATABASE_URL explícita.

const fs = require("fs");
const path = require("path");
const { gerarRaioXCliente } = require("./raioXClienteService");
const { catalogo, TABELAS, DUPLICACOES } = require("./raioXMotores");

// Consulta específica do Raio-X: restringe cliente/conta ANTES de agregar (a global,
// reuso_vinculos.sql, segue sendo a de observabilidade geral).
const SQL_VINCULOS_CLIENTE = fs.readFileSync(path.join(__dirname, "..", "..", "sql", "observabilidade", "reuso_vinculos_cliente.sql"), "utf8");
const TIMEOUT_MS = 4000;

async function somenteLeitura(db, fn, { timeoutMs = TIMEOUT_MS } = {}) {
  const client = typeof db.connect === "function" ? await db.connect() : db;
  const liberar = typeof client.release === "function" ? () => client.release() : () => {};
  try {
    await client.query("BEGIN READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${Math.floor(timeoutMs)}`);
    const out = await fn(client);
    await client.query("ROLLBACK");
    return out;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* conexão perdida */ }
    throw err;
  } finally {
    liberar();
  }
}

// ---------------------------------------------------------------------------
// Visão geral: tamanho REAL das tabelas (catálogo do PostgreSQL), por domínio.
// ---------------------------------------------------------------------------
function agruparPorDominio(tabelas) {
  const dominios = new Map();
  for (const t of tabelas) {
    const k = t.dominio;
    if (!dominios.has(k)) dominios.set(k, { dominio: k, tabelas: 0, bytes: 0, linhasEstimadas: 0, mapeada: t.mapeada });
    const d = dominios.get(k);
    d.tabelas += 1; d.bytes += t.bytesTotal; d.linhasEstimadas += Math.max(t.linhasEstimadas, 0);
  }
  return [...dominios.values()].sort((a, b) => b.bytes - a.bytes);
}

function compor(tabelasPg, extra = {}) {
  const tabelas = tabelasPg.map((r) => {
    const meta = TABELAS.get(r.tabela);
    return {
      tabela: r.tabela, bytesTotal: Number(r.bytes_total), bytesHeap: Number(r.bytes_heap), bytesIndices: Number(r.bytes_indices),
      linhasEstimadas: Number(r.linhas_estimadas), mapeada: !!meta,
      dominio: meta ? meta.dominio : "Fora do inventário do Raio-X", classe: meta ? meta.classe : "desconhecida",
      manual: meta ? meta.manual : null, reconstruivel: meta ? meta.reconstruivel : null,
    };
  }).sort((a, b) => b.bytesTotal - a.bytesTotal);
  const total = tabelas.reduce((s, t) => s + t.bytesTotal, 0);
  const naoMapeadas = tabelas.filter((t) => !t.mapeada);
  return {
    ...extra,
    tabelas,
    porDominio: agruparPorDominio(tabelas),
    porClasse: Object.entries(tabelas.reduce((m, t) => { m[t.classe] = (m[t.classe] || 0) + t.bytesTotal; return m; }, {})).map(([classe, bytes]) => ({ classe, bytes })).sort((a, b) => b.bytes - a.bytes),
    resumo: {
      tabelas: tabelas.length, bytesTabelas: total,
      mapeadas: tabelas.length - naoMapeadas.length, naoMapeadas: naoMapeadas.length, bytesNaoMapeadas: naoMapeadas.reduce((s, t) => s + t.bytesTotal, 0),
      tabelasDoCatalogoSemTabelaNoBanco: [...TABELAS.keys()].filter((n) => !tabelas.some((t) => t.tabela === n)),
    },
    tipoDeMedida: { tamanhoTabela: "real (pg_total_relation_size)", linhas: "estimativa do planner (reltuples)" },
  };
}

async function visaoGeral(db) {
  return somenteLeitura(db, async (c) => {
    const base = (await c.query(`SELECT current_database() AS banco, pg_database_size(current_database())::bigint AS bytes, split_part(version(), ' ', 2) AS versao`)).rows[0];
    const { rows } = await c.query(
      `SELECT c.relname AS tabela, pg_total_relation_size(c.oid) AS bytes_total, pg_relation_size(c.oid) AS bytes_heap,
              pg_indexes_size(c.oid) AS bytes_indices, c.reltuples::bigint AS linhas_estimadas
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'r' AND n.nspname = 'public'`);
    const cont = (await c.query(`SELECT (SELECT COUNT(*) FROM clientes)::int AS clientes, (SELECT COUNT(*) FROM cliente_contas)::int AS contas`)).rows[0];
    return compor(rows, { banco: base.banco, versaoPostgres: base.versao, bytesBanco: Number(base.bytes), clientes: cont.clientes, contas: cont.contas });
  });
}

async function listarClientes(db) {
  return somenteLeitura(db, async (c) => {
    const { rows } = await c.query(
      `SELECT cl.id, cl.nome, cl.slug, cl.ativo,
              COALESCE(json_agg(json_build_object('id', ct.id, 'marketplace', ct.marketplace, 'nome', ct.nome, 'ativa', ct.ativo) ORDER BY ct.marketplace, ct.id)
                       FILTER (WHERE ct.id IS NOT NULL), '[]') AS contas
         FROM clientes cl LEFT JOIN cliente_contas ct ON ct.cliente_id = cl.id
        GROUP BY cl.id ORDER BY cl.nome`);
    return rows.map((r) => ({ id: r.id, nome: r.nome, slug: r.slug, ativo: r.ativo, contas: r.contas }));
  });
}

// ---------------------------------------------------------------------------
// Vínculos de reuso do cliente (imports vigentes/superados/vinculados).
// ---------------------------------------------------------------------------
async function vinculosDoCliente(db, { clienteId = null, slug, contaId = null } = {}) {
  return somenteLeitura(db, async (c) => {
    const t = await c.query(`SELECT to_regclass('public.central_vendas_import_pedidos') IS NOT NULL AS ok`);
    if (t.rows[0].ok !== true) return { status: "tabela_ausente", imports: [] };
    const { rows } = await c.query(SQL_VINCULOS_CLIENTE, [clienteId, slug, contaId == null ? null : Number(contaId)]);
    return { status: "ok", imports: rows.map((r) => ({ importId: Number(r.import_id), clienteContaId: r.cliente_conta_id == null ? null : Number(r.cliente_conta_id), marketplace: r.marketplace, competencia: String(r.competencia).trim(), publicacao: r.publication_status, papel: r.papel, linhasFornecidas: Number(r.linhas_fornecidas), usadoPorImports: (r.usado_por_imports || []).map(Number), vinculos: Number(r.vinculos) })) };
  });
}

// ---------------------------------------------------------------------------
// Visão por motor para UM cliente (pura: recebe o raio-x já gerado).
// ---------------------------------------------------------------------------
const DIA = 24 * 3600 * 1000;
const parseTs = (v) => (v ? new Date(v).getTime() : null);

function qualidadeDoMotor(motor, tabelasProduzidas, raiox, agora) {
  const motivos = [];
  let nivel = "ok";
  const med = tabelasProduzidas.filter((t) => t.status === "ok");
  const comDados = med.filter((t) => t.linhas > 0);
  if (!tabelasProduzidas.length) return { nivel: "sem_producao", motivos: ["Motor não grava tabelas próprias (só consome)."], regra: "catálogo" };
  if (!med.length) return { nivel: "nao_medido", motivos: ["As tabelas deste motor ainda não estão no registro do Raio-X (sem contagem por cliente)."], regra: "catálogo" };
  if (!comDados.length) { nivel = "sem_dados"; motivos.push("Nenhuma tabela do motor tem linhas para este escopo."); }
  const rebaixa = (n, m) => { motivos.push(m); if (nivel === "ok") nivel = n; };
  if (motor.id === "central_vendas") {
    const s = raiox.syncs && raiox.syncs.status === "ok" ? raiox.syncs.ultimoPorConta : [];
    for (const u of s) if (u.status !== "completed") rebaixa("atencao", `Último sync da conta ${u.clienteContaId} terminou como "${u.status}"${u.erro ? ` (${String(u.erro).slice(0, 80)})` : ""}.`);
    const ult = Math.max(0, ...s.map((u) => parseTs(u.terminadoEm || u.criadoEm) || 0));
    if (s.length && agora - ult > 3 * DIA) rebaixa("atencao", "Último sync há mais de 3 dias (limite heurístico).");
    const cv = raiox.centralVendas;
    if (cv && cv.status === "ok") {
      const semVigente = cv.porContaCompetencia.filter((p) => !p.vigente && p.candidatesNaoPublicados.length);
      if (semVigente.length) rebaixa("atencao", `${semVigente.length} competência(s) só com candidate não publicado.`);
    }
    // Com conta selecionada só entram as checagens que sabem filtrar por conta; as de
    // escopo do cliente aparecem na tela, mas NÃO rebaixam a qualidade da conta.
    for (const i of raiox.inconsistencias || []) {
      if (i.ocorrencias > 0 && i.codigo !== "import_com_conta_de_outro_cliente" && (raiox.escopoConta == null || i.escopo === "conta")) rebaixa("atencao", `${i.descricao} (${i.ocorrencias}).`);
    }
  }
  if (motor.id === "conciliacao_mp" || motor.id === "central_vendas") {
    const mp = raiox.mercadoPago && raiox.mercadoPago.status === "ok" ? raiox.mercadoPago.porConta : [];
    for (const m of mp) if (Number(m.copiasPorPayment) > 1.5) rebaixa("atencao", `Conta ${m.clienteContaId}: ${m.copiasPorPayment} cópias por payment do Mercado Pago.`);
  }
  const ult = Math.max(0, ...comDados.map((t) => parseTs(t.ultimaEscrita) || 0));
  if (comDados.length && ult && agora - ult > 30 * DIA && nivel === "ok") rebaixa("atencao", "Nenhuma escrita há mais de 30 dias (limite heurístico).");
  return { nivel, motivos, regra: "heurística simples do Raio-X (não é SLA)" };
}

function montarVisaoMotores(raiox, cat = catalogo(), agora = Date.now()) {
  const porTabela = new Map((raiox.tabelas || []).map((t) => [t.tabela, t]));
  return cat.motores.map((m) => {
    const producaoRefs = m.produz.filter((p) => p.tipo !== "fonte_externa" && TABELAS.has(p.ref)).map((p) => p.ref);
    const tabelasProduzidas = [...new Set(producaoRefs)].map((ref) => {
      const t = porTabela.get(ref);
      const meta = TABELAS.get(ref);
      if (!t) return { tabela: ref, dominio: meta.dominio, classe: meta.classe, status: "fora_do_registro", linhas: null, bytesEstimados: null, ultimaEscrita: null, escopo: null };
      return { tabela: ref, dominio: t.dominio, classe: t.classe, status: t.status, linhas: t.linhas ?? null, bytesEstimados: t.bytesEstimados ?? null, ultimaEscrita: t.ultimaEscrita || null, periodo: t.periodo || null, escopo: t.escopo || "cliente" };
    });
    const medidas = tabelasProduzidas.filter((t) => t.status === "ok" && t.linhas > 0);
    const ultimaAtualizacao = medidas.map((t) => t.ultimaEscrita).filter(Boolean).sort().pop() || null;
    const consumo = m.consome.map((c) => {
      const t = porTabela.get(c.ref);
      return { ...c, linhas: t && t.status === "ok" ? t.linhas : null, ultimaEscrita: t && t.ultimaEscrita || null };
    });
    return {
      id: m.id, nome: m.nome, grupo: m.grupo, descricao: m.descricao,
      ultimaAtualizacao, qualidade: qualidadeDoMotor(m, tabelasProduzidas, raiox, agora),
      bytesEstimados: medidas.reduce((s, t) => s + (t.bytesEstimados || 0), 0),
      tabelasProduzidas, consumo,
    };
  });
}

// ---------------------------------------------------------------------------
// Oportunidades de otimização/limpeza. SÓ sugestões com evidência — nenhuma
// ação é executada pelo Raio-X; cada uma exige aprovação própria.
// ---------------------------------------------------------------------------
function oportunidades({ visao = null, raiox = null, vinculos = null } = {}) {
  const tam = (n) => (visao ? (visao.tabelas.find((t) => t.tabela === n) || {}).bytesTotal ?? null : null);
  const lista = [
    { id: "mp_copias", titulo: "Payments do Mercado Pago repetidos por run", dominio: "Mercado Pago", tabelas: ["central_vendas_mp_payments", "central_vendas_mp_payment_charges"],
      bytesAlvo: (tam("central_vendas_mp_payments") ?? 0) + (tam("central_vendas_mp_payment_charges") ?? 0) || null, ganhoEstimado: "≈ 90% do espaço dessas tabelas (diagnóstico de 05/11: ~14 cópias/payment)", tipoGanho: "estimativa",
      evidencia: "confirmado", acao: "Parar a coleta (flag) e planejar retenção própria por run (doc 08). Medir antes com mp_redundancia.sql.", risco: "baixo", bloqueio: "Retenção em lote só com autorização; export prévio." },
    { id: "central_reuso", titulo: "Reuso de pedidos inalterados no sync", dominio: "Central de Vendas", tabelas: ["central_vendas_pedidos", "central_vendas_pedido_itens", "central_vendas_componentes"],
      bytesAlvo: (tam("central_vendas_pedidos") ?? 0) + (tam("central_vendas_pedido_itens") ?? 0) + (tam("central_vendas_componentes") ?? 0) || null, ganhoEstimado: "−73% a −89% do crescimento diário de escrita (medido em PG local sintético: −83%)", tipoGanho: "estimativa",
      evidencia: "confirmado", acao: "Ligar persistência enxuta e reuso em 1–2 contas (checklist de publicação).", risco: "médio", bloqueio: "Migration manual; retenção PROIBIDA com vínculos (doc 09)." },
    { id: "margem_legado", titulo: "Aposentar margem projetada legada", dominio: "Central de Margem", tabelas: ["anuncios_margem_projetada_snapshot"],
      bytesAlvo: tam("anuncios_margem_projetada_snapshot"), ganhoEstimado: "tamanho da tabela legada (duplica margin_projection_snapshots)", tipoGanho: "real quando o tamanho vem do banco",
      evidencia: "confirmado", acao: "Confirmar que /anuncios-meli não depende mais do fallback antes de congelar.", risco: "médio", bloqueio: "anunciosMargemProjetadaFonte ainda lê como fallback." },
    { id: "promo_legado", titulo: "Congelar diagnósticos de promoções legados", dominio: "Promoções", tabelas: ["promocoes_diagnosticos", "promocoes_diagnostico_itens"],
      bytesAlvo: (tam("promocoes_diagnosticos") ?? 0) + (tam("promocoes_diagnostico_itens") ?? 0) || null, ganhoEstimado: "tamanho das tabelas legadas", tipoGanho: "real quando o tamanho vem do banco",
      evidencia: "confirmado", acao: "Migrar o fallback do promoSnapshotLegado e arquivar.", risco: "médio", bloqueio: "promoSnapshotLegado e precificacaoOportunidades ainda leem." },
    { id: "sentinel_pedidos", titulo: "Sentinel sem retenção", dominio: "Sentinel", tabelas: ["sentinel_pedidos", "sentinel_incidente_eventos"],
      bytesAlvo: tam("sentinel_pedidos"), ganhoEstimado: "contenção de crescimento (política sugerida: 90 dias)", tipoGanho: "estimativa",
      evidencia: "inferido", acao: "Definir política de retenção com o dono do Sentinel; hoje não há DELETE automático.", risco: "baixo", bloqueio: "Sentinel não é alterado nesta etapa." },
    { id: "logs_sem_retencao", titulo: "Logs/auditorias sem retenção", dominio: "Observabilidade", tabelas: ["activity_logs", "central_vendas_sync_runs", "margin_snapshot_runs", "cliente_360_sync_jobs"],
      bytesAlvo: null, ganhoEstimado: "contenção de crescimento", tipoGanho: "estimativa",
      evidencia: "confirmado", acao: "Políticas de 90 dias a 13 meses (inventário CLASSIFICACAO_E_RETENCAO).", risco: "baixo", bloqueio: "activity_logs sem DDL no código." },
    { id: "payload_sem_leitor", titulo: "payload_json de itens/componentes sem leitor", dominio: "Central de Vendas", tabelas: ["central_vendas_pedido_itens", "central_vendas_componentes"],
      bytesAlvo: null, ganhoEstimado: "−34% de disco na persistência enxuta (PG local sintético)", tipoGanho: "estimativa",
      evidencia: "confirmado", acao: "Persistência enxuta (flag CENTRAL_VENDAS_SYNC_PERSISTENCIA_ENXUTA).", risco: "baixo", bloqueio: "—" },
  ];
  if (vinculos && vinculos.status === "ok" && vinculos.imports.length) {
    lista.push({ id: "imports_vinculados", titulo: "Este cliente tem imports em modo reuso", dominio: "Central de Vendas", tabelas: ["central_vendas_imports", "central_vendas_import_pedidos"],
      bytesAlvo: null, ganhoEstimado: "—", tipoGanho: "—", evidencia: "confirmado", acao: "Não rodar retenção neste cliente: a trava S3 recusa e a correção S1–S4 ainda é da outra frente.", risco: "alto", bloqueio: "Retenção PROIBIDA enquanto houver vínculos." });
  }
  if (raiox && raiox.ok && raiox.centralVendas && raiox.centralVendas.status === "ok") {
    const t = raiox.centralVendas.totais;
    if (t.superados > 0) lista.push({ id: "cliente_superados", titulo: `${t.superados} cópia(s) superada(s) da Central neste cliente (${t.pedidosEmCopiasSuperadas} pedidos declarados)`, dominio: "Central de Vendas", tabelas: ["central_vendas_imports"],
      bytesAlvo: null, ganhoEstimado: "≈ proporção das cópias superadas", tipoGanho: "estimativa", evidencia: "confirmado", acao: "Retenção por dominância (frente de retenção).", risco: "baixo", bloqueio: "Retenção automática desligada; manuais/legacy protegidos só na worktree de retenção." });
  }
  return lista;
}

// ---------------------------------------------------------------------------
async function raioXDoCliente(db, { clienteId = null, clienteSlug = null, contaId = null } = {}) {
  const raiox = await gerarRaioXCliente({ clienteId, clienteSlug, contaId }, { db });
  if (!raiox.ok) return raiox;
  const vinculos = await vinculosDoCliente(db, { clienteId: raiox.cliente.id, slug: raiox.cliente.slug, contaId: raiox.escopoConta }).catch((e) => ({ status: "erro", erro: e.code || e.message, imports: [] }));
  const cat = catalogo();
  return finalizarCliente({ raiox, vinculos, cat });
}

function finalizarCliente({ raiox, vinculos, cat, visao = null }) {
  const vinc = contaFiltro(vinculos, raiox.escopoConta);
  return {
    ...raiox,
    vinculos: vinc,
    motores: montarVisaoMotores(raiox, cat),
    oportunidades: oportunidades({ visao, raiox, vinculos: vinc }),
  };
}

function contaFiltro(vinculos, contaId) {
  if (contaId == null || !vinculos || !vinculos.imports) return vinculos;
  return { ...vinculos, imports: vinculos.imports.filter((i) => i.clienteContaId === Number(contaId)) };
}

module.exports = { visaoGeral, listarClientes, raioXDoCliente, vinculosDoCliente, SQL_VINCULOS_CLIENTE, montarVisaoMotores, oportunidades, finalizarCliente, compor, somenteLeitura, DUPLICACOES };
