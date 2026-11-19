// server/controllers/sentinelController.js
// HTTP do Sentinel V0-b. Autenticação (authMiddleware) e papel ficam na rota;
// aqui: autorização por carteira → motor (sentinelIncidentes) → resposta sem
// segredos. O motor é injetado (tests) ou carregado sob demanda.

const SEVERIDADES = ["critica", "alta", "media", "baixa"];
const STATUS = ["aberto", "reconhecido", "resolvido", "reaberto"];
const TIPOS = ["margem_negativa", "custo_pendente", "leitura_atrasada"];
// Chaves de SEGREDO (não qualquer uma que contenha "token": erroToken/token_status são métricas).
const CHAVE_SENSIVEL = /^(access|refresh|id)?[_-]?token$|secret|senha|password|authorization|cookie|api[_-]?key/i;

// Remove qualquer chave com cara de segredo, em profundidade. Defesa extra:
// o motor não deveria devolver isso, mas a resposta nunca depende dessa promessa.
function limpar(valor, nivel = 0) {
  if (nivel > 8) return null;
  if (Array.isArray(valor)) return valor.map((v) => limpar(v, nivel + 1));
  if (valor && typeof valor === "object" && !(valor instanceof Date)) {
    const out = {};
    for (const [k, v] of Object.entries(valor)) {
      if (CHAVE_SENSIVEL.test(k)) continue;
      out[k] = limpar(v, nivel + 1);
    }
    return out;
  }
  return valor;
}

function badRequest(res, code, mensagem) {
  return res.status(400).json({ ok: false, code, erro: mensagem });
}

function inteiro(v, def, min, max) {
  if (v === undefined || v === "") return def;
  const n = Number(v);
  if (!Number.isInteger(n)) return NaN;
  return Math.min(max, Math.max(min, n));
}

function data(v) {
  if (v === undefined || v === "") return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? NaN : d;
}

// Valida a query de listagem; devolve { erro } ou { filtros }.
function lerFiltros(q) {
  for (const [chave, lista] of [["tipo", TIPOS], ["status", STATUS], ["severidade", SEVERIDADES]]) {
    if (q[chave] !== undefined && q[chave] !== "" && !lista.includes(q[chave])) {
      return { erro: `Parâmetro "${chave}" inválido.` };
    }
  }
  const limit = inteiro(q.limit, 50, 1, 200);
  const offset = inteiro(q.offset, 0, 0, 1e9);
  const desde = data(q.desde);
  const ate = data(q.ate);
  if ([limit, offset].some(Number.isNaN)) return { erro: "limit/offset devem ser inteiros." };
  if ([desde, ate].some((d) => typeof d === "number")) return { erro: "desde/ate devem ser datas válidas." };
  const busca = q.busca === undefined ? null : String(q.busca).trim().slice(0, 100) || null;
  return {
    filtros: {
      tipo: q.tipo || null,
      status: q.status || null,
      severidade: q.severidade || null,
      desde,
      ate,
      busca,
      limit,
      offset,
    },
  };
}

function atorDe(user) {
  const nome = user.nome || user.email || "usuário";
  return `${nome} (#${user.id})`;
}

// conciliacao: leitura da conciliação da comissão (S1); injetável em teste, carregada sob demanda.
function criarController({ db, acesso, motor, conciliacao = () => require("../services/sentinel/sentinelConciliacaoLeitura") }) {
  const incidentes = () => (typeof motor === "function" ? motor() : motor);
  const conc = () => (typeof conciliacao === "function" ? conciliacao() : conciliacao);

  // Envolve handlers: erros do motor/BD viram resposta sem vazar stack/SQL.
  const seguro = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err && err.code === "MODULE_NOT_FOUND" && /sentinelIncidentes/.test(err.message || "")) {
        return res.status(501).json({ ok: false, code: "SENTINEL_MOTOR_INDISPONIVEL", erro: "Motor de incidentes ainda não instalado." });
      }
      const mapa = { INCIDENTE_NAO_ENCONTRADO: 404, TRANSICAO_INVALIDA: 409, MOTIVO_OBRIGATORIO: 400, PARAMETRO_INVALIDO: 400 };
      if (err && mapa[err.code]) {
        return res.status(mapa[err.code]).json({ ok: false, code: err.code, erro: err.message });
      }
      console.error("[sentinel] erro de rota:", err && err.code ? err.code : "", err && err.message);
      return res.status(500).json({ ok: false, code: "SENTINEL_ERRO", erro: "Falha ao consultar o Sentinel." });
    }
  };

  // Escopo por query (conta/cliente/squad) sempre como INTERSEÇÃO da carteira.
  // Marca cada item com contaAtiva (conta desativada = só leitura; a UI mostra o selo).
  const marcar = (itens, contas) => {
    const ativa = new Map(contas.map((c) => [c.id, c.ativo]));
    return (itens || []).map((i) => ({ ...i, contaAtiva: ativa.get(i.contaId) !== false }));
  };
  const escopo = (req) => acesso.contasAutorizadas(req.user, { squad: req.query.squad, cliente: req.query.cliente, conta: req.query.conta }, db);

  // Por ID: contaDoIncidente → carteira → 404 (igual p/ inexistente e fora).
  async function incidenteAutorizado(req, res) {
    const id = Number(req.params.id);
    const naoEncontrado = () => res.status(404).json({ ok: false, code: "INCIDENTE_NAO_ENCONTRADO", erro: "Incidente não encontrado." }) && null;
    if (!Number.isInteger(id) || id <= 0) return naoEncontrado();
    const contaId = await incidentes().contaDoIncidente(db, id);
    const conta = contaId ? await acesso.contaAutorizadaInfo(req.user, contaId, db) : null;
    if (!conta) return naoEncontrado();
    req.contaInfo = conta;
    return id;
  }

  return {
    resumo: seguro(async (req, res) => {
      const { contaIds } = await escopo(req);
      const resumo = await incidentes().resumoMonitoramento(db, { contaIds });
      res.json({ ok: true, resumo: limpar(resumo) });
    }),

    listar: seguro(async (req, res) => {
      const { erro, filtros } = lerFiltros(req.query);
      if (erro) return badRequest(res, "PARAMETRO_INVALIDO", erro);
      const { contaIds, contas } = await escopo(req);
      if (!contaIds.length) return res.json({ ok: true, itens: [], total: 0, limit: filtros.limit, offset: filtros.offset });
      const r = await incidentes().listarIncidentes(db, { ...filtros, contaIds });
      res.json({ ok: true, itens: limpar(marcar(r.itens, contas)), total: r.total, limit: filtros.limit, offset: filtros.offset });
    }),

    obter: seguro(async (req, res) => {
      const id = await incidenteAutorizado(req, res);
      if (!id) return;
      const inc = await incidentes().obterIncidente(db, id);
      if (!inc) return res.status(404).json({ ok: false, code: "INCIDENTE_NAO_ENCONTRADO", erro: "Incidente não encontrado." });
      res.json({ ok: true, incidente: limpar({ ...inc, contaAtiva: req.contaInfo.ativo !== false }) });
    }),

    reconhecer: seguro(async (req, res) => {
      const id = await incidenteAutorizado(req, res);
      if (!id) return;
      const observacao = req.body && req.body.observacao ? String(req.body.observacao).slice(0, 1000) : undefined;
      const inc = await incidentes().reconhecerIncidente(db, id, { ator: atorDe(req.user), observacao });
      res.json({ ok: true, incidente: limpar(inc) });
    }),

    resolver: seguro(async (req, res) => {
      const id = await incidenteAutorizado(req, res);
      if (!id) return;
      const motivo = req.body && typeof req.body.motivo === "string" ? req.body.motivo.trim().slice(0, 500) : "";
      if (!motivo) return badRequest(res, "MOTIVO_OBRIGATORIO", "Informe o motivo da resolução.");
      const observacao = req.body.observacao ? String(req.body.observacao).slice(0, 1000) : undefined;
      const inc = await incidentes().resolverIncidente(db, id, { ator: atorDe(req.user), motivo, observacao });
      res.json({ ok: true, incidente: limpar(inc) });
    }),

    // Saúde do monitoramento (F4): mesmo escopo de carteira; sem contas autorizadas não
    // consulta o motor e devolve o esqueleto "sem dados" (nunca finge saúde).
    saude: seguro(async (req, res) => {
      const { contaIds } = await escopo(req);
      if (!contaIds.length) {
        return res.json({ ok: true, saude: {
          worker: { estado: "sem_dados", ultimaExecucaoEm: null, idadeSegundos: null },
          contas: { monitoradas: 0, ok: 0, atrasadas: 0, erroToken: 0, erroApi: 0, nuncaLidas: 0, semPedidosRecentes: 0 },
          checkpointIdadeMaxSegundos: null, ultimaColetaOkEm: null,
          incidentesAbertosPorSeveridade: { critica: 0, alta: 0, media: 0, baixa: 0 }, cobertura: null, alertas: [],
        } });
      }
      const saude = await incidentes().resumoOperacional(db, { contaIds });
      res.json({ ok: true, saude: limpar(saude) });
    }),

    contas: seguro(async (req, res) => {
      const { contaIds, contas: autorizadas } = await escopo(req);
      if (!contaIds.length) return res.json({ ok: true, contas: [] });
      const contas = await incidentes().saudeContas(db, { contaIds });
      const ativa = new Map(autorizadas.map((c) => [c.id, c.ativo]));
      res.json({ ok: true, contas: limpar((contas || []).map((c) => ({ ...c, ativo: ativa.get(c.contaId) !== false }))) });
    }),

    // ── Conciliação da comissão (S1) — SOMENTE LEITURA. Não altera margem/incidentes; DIVERGENTE ≠ prejuízo confirmado.
    conciliacaoResumo: seguro(async (req, res) => {
      const { contaIds } = await escopo(req);
      const resumo = await conc().resumoConciliacao(db, { contaIds });
      res.json({ ok: true, conciliacao: limpar(resumo) });
    }),

    conciliacaoListar: seguro(async (req, res) => {
      const estado = req.query.estado === undefined || req.query.estado === "" ? null : String(req.query.estado);
      if (estado !== null && !conc().ESTADOS.includes(estado)) return badRequest(res, "PARAMETRO_INVALIDO", 'Parâmetro "estado" inválido.');
      const limit = inteiro(req.query.limit, 50, 1, 200);
      const offset = inteiro(req.query.offset, 0, 0, 1e9);
      if ([limit, offset].some(Number.isNaN)) return badRequest(res, "PARAMETRO_INVALIDO", "limit/offset devem ser inteiros.");
      const { contaIds } = await escopo(req);
      const r = await conc().listarConciliacoes(db, { contaIds, estado, limit, offset });
      res.json({ ok: true, ...limpar(r), limit, offset });
    }),

    // Por pedido: exige ?conta= (o pedido_id do ML só é único DENTRO da conta); fora da carteira ⇒ 404, igual a inexistente.
    conciliacaoPedido: seguro(async (req, res) => {
      const naoEncontrado = () => res.status(404).json({ ok: false, code: "PEDIDO_NAO_ENCONTRADO", erro: "Pedido não encontrado." });
      const contaId = Number(req.query.conta);
      const pedidoId = String(req.params.pedidoId || "").trim();
      if (!Number.isInteger(contaId) || contaId <= 0) return badRequest(res, "PARAMETRO_INVALIDO", 'Informe "conta".');
      if (!/^\d{1,30}$/.test(pedidoId)) return naoEncontrado();
      const conta = await acesso.contaAutorizadaInfo(req.user, contaId, db);
      if (!conta) return naoEncontrado();
      const item = await conc().obterConciliacaoPedido(db, contaId, pedidoId);
      if (!item) return naoEncontrado();
      res.json({ ok: true, conciliacao: limpar(item) });
    }),
  };
}

module.exports = { criarController, limpar, lerFiltros };
