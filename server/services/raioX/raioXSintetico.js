// server/services/raioX/raioXSintetico.js
//
// Dados 100% SINTÉTICOS para abrir o Raio-X visual sem banco. Mesmo formato do
// modo real (mesmos serviços de composição). Nada aqui vem de produção; a UI
// mostra o selo "SINTÉTICO" em todas as telas. Determinístico (PRNG fixo).

const { REGISTRO } = require("./raioXRegistro");
const { catalogo, TABELAS } = require("./raioXMotores");
const { compor, finalizarCliente } = require("./raioXVisualService");

const AGORA = Date.parse("2026-11-11T12:00:00Z");
function prng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
const iso = (diasAtras, h = 6) => new Date(AGORA - diasAtras * 86400000 - h * 3600000).toISOString();

// Tamanho "real" sintético por tabela (bytes) — proporcional ao inventário.
const GRANDES = {
  central_vendas_componentes: 2466e6, central_vendas_mp_payment_charges: 1240e6, central_vendas_pedidos: 916e6, central_vendas_pedido_itens: 867e6,
  central_vendas_mp_payments: 476e6, central_vendas_imports: 180e6, sentinel_pedidos: 150e6, margin_projection_snapshots: 95e6,
  anuncios_margem_projetada_snapshot: 70e6, promo_snapshot_itens: 55e6, meli_anuncios: 48e6, promocoes_diagnosticos: 22e6,
};
const LINHAS_GRANDES = {
  central_vendas_componentes: 3.9e6, central_vendas_mp_payment_charges: 4.6e6, central_vendas_pedidos: 711644, central_vendas_pedido_itens: 790000,
  central_vendas_mp_payments: 1122694, central_vendas_imports: 1900, sentinel_pedidos: 420000, margin_projection_snapshots: 310000,
};

function tabelasDoBanco() {
  const r = prng(7);
  const rows = [];
  for (const meta of TABELAS.values()) {
    const base = GRANDES[meta.tabela] ?? Math.round(2e5 + r() * 4e6);
    rows.push({ tabela: meta.tabela, bytes_total: base, bytes_heap: Math.round(base * 0.7), bytes_indices: Math.round(base * 0.3), linhas_estimadas: LINHAS_GRANDES[meta.tabela] ?? Math.round(500 + r() * 40000) });
  }
  for (let i = 1; i <= 4; i++) rows.push({ tabela: `tabela_sintetica_nao_mapeada_${i}`, bytes_total: Math.round(1e6 + r() * 30e6), bytes_heap: 1e6, bytes_indices: 1e5, linhas_estimadas: Math.round(r() * 9000) });
  return rows;
}

const CLIENTES = [
  { id: 1, nome: "Loja Exemplo Alfa (sintético)", slug: "alfa-sintetico", ativo: true, contas: [{ id: 5, marketplace: "meli", nome: "ML Alfa 1", ativa: true }, { id: 6, marketplace: "meli", nome: "ML Alfa 2", ativa: true }] },
  { id: 2, nome: "Loja Exemplo Beta (sintético) — com reuso", slug: "beta-sintetico", ativo: true, contas: [{ id: 7, marketplace: "meli", nome: "ML Beta", ativa: true }] },
  { id: 3, nome: "Loja Exemplo Gama (sintético) — com alertas", slug: "gama-sintetico", ativo: true, contas: [{ id: 8, marketplace: "meli", nome: "ML Gama 1", ativa: true }, { id: 9, marketplace: "meli", nome: "ML Gama 2", ativa: true }, { id: 10, marketplace: "shopee", nome: "Shopee Gama", ativa: false }] },
];

function raioXSinteticoCru(cliente, contaId) {
  const r = prng(cliente.id * 97);
  const contas = contaId != null ? cliente.contas.filter((c) => c.id === contaId) : cliente.contas;
  const fator = contaId != null ? 1 / cliente.contas.length : 1;
  const tabelas = REGISTRO.map((e) => {
    const base = { tabela: e.tabela, dominio: e.dominio, modulos: e.modulos, classe: e.classe, origem: e.origem, manual: e.manual, reconstruivel: e.reconstruivel };
    if (e.via) return { ...base, status: "so_no_modo_detalhado", identidade: `via ${e.via.pai}.${e.via.fk}` };
    const linhas = Math.round((LINHAS_GRANDES[e.tabela] ?? 6000) / 1900 * (0.3 + r()) * fator * (cliente.id === 3 && e.tabela.startsWith("sentinel") ? 3 : 1));
    const comConta = ["central_vendas_imports", "central_vendas_sync_runs", "margin_projection_snapshots", "promo_snapshot_itens", "sentinel_pedidos", "central_vendas_mp_payments", "meli_anuncios"].includes(e.tabela);
    const semDado = /shopee|design|seller|cliente_squad|diagnosticos_iniciais|tiktok/.test(e.tabela) && cliente.id !== 3;
    if (semDado) return { ...base, identidade: "cliente_id", status: "ok", linhas: 0, bytesEstimados: 0, periodo: null, ultimaEscrita: null, escopo: "cliente" };
    const velho = cliente.id === 3 && /sentinel|margin_/.test(e.tabela);
    return {
      ...base, identidade: comConta ? "cliente_conta_id" : "cliente_id", status: "ok", linhas, bytesEstimados: Math.round(linhas * ((GRANDES[e.tabela] && LINHAS_GRANDES[e.tabela]) ? GRANDES[e.tabela] / LINHAS_GRANDES[e.tabela] : 700)),
      periodo: { coluna: "created_at", de: "2026-05-02", ate: "2026-11-10" }, ultimaEscrita: iso(velho ? 41 : r() * 2), escopo: contaId != null && comConta ? "conta" : "cliente",
    };
  });
  const competencias = ["2026-09", "2026-10", "2026-11"];
  const porContaCompetencia = [];
  for (const c of contas) for (const comp of competencias) {
    const superadas = cliente.id === 2 ? 11 : 4 + Math.floor(r() * 8);
    const semVigente = cliente.id === 3 && c.id === 9 && comp === "2026-11";
    porContaCompetencia.push({
      clienteContaId: c.id, marketplace: c.marketplace, competencia: comp,
      vigente: semVigente ? null : { importId: 1000 + c.id * 10 + competencias.indexOf(comp), fonte: "orders_api", status: "published", cobertura: [`${comp}-01`, comp === "2026-11" ? "2026-11-10" : `${comp}-30`], pedidos: 300 + Math.floor(r() * 900) },
      importsTotal: superadas + 1, copiasSuperadas: superadas, pedidosEmCopiasSuperadas: superadas * (250 + Math.floor(r() * 400)),
      manuaisProtegidos: comp === "2026-09" && c.id === contas[0].id ? [900 + c.id] : [], candidatesNaoPublicados: semVigente ? [1999] : [],
    });
  }
  const totalCopias = porContaCompetencia.reduce((s, p) => s + p.copiasSuperadas, 0);
  const ultimoPorConta = contas.map((c) => ({
    clienteContaId: c.id, runId: 5000 + c.id, status: cliente.id === 3 && c.id === 9 ? "failed" : "completed", completude: "completa",
    periodo: ["2026-11-01", "2026-11-10"], criadoEm: iso(cliente.id === 3 ? 6 : 0.3), terminadoEm: iso(cliente.id === 3 ? 6 : 0.3, 5.9),
    erro: cliente.id === 3 && c.id === 9 ? "timeout na API de shipments (sintético)" : null,
  }));
  const raiox = {
    ok: true, versao: "raio-x-cliente/v1", geradoEm: new Date(AGORA).toISOString(), duracaoMs: 0, modo: "rapido", escopoConta: contaId,
    limites: { timeoutPorConsultaMs: 3000, orcamentoTotalMs: 20000 },
    estimativaTamanho: { metodo: "SINTÉTICO — proporcional, não medido", exato: false },
    cliente: { id: cliente.id, nome: cliente.nome, slug: cliente.slug, ativo: true },
    contas: contas.map((c, i) => ({ id: c.id, marketplace: c.marketplace, nome: c.nome, slug: `${cliente.slug}-${c.id}`, externalAccountId: String(100000 + c.id), principal: i === 0, ativa: c.ativa, criadaEm: iso(200) })),
    grants: { mercadoLivre: contas.filter((c) => c.marketplace === "meli").map((c) => ({ id: c.id, mlUserId: String(100000 + c.id), principal: true, status: "valid", falhasRefresh: 0, substituidoEm: null, expiraEm: iso(-1), atualizadoEm: iso(1) })) },
    tabelas,
    centralVendas: { status: "ok", totais: { imports: porContaCompetencia.reduce((s, p) => s + p.importsTotal, 0), vigentes: porContaCompetencia.filter((p) => p.vigente).length, superados: totalCopias, manuais: porContaCompetencia.filter((p) => p.manuaisProtegidos.length).length, candidatesNaoPublicados: porContaCompetencia.filter((p) => p.candidatesNaoPublicados.length).length, pedidosEmCopiasSuperadas: porContaCompetencia.reduce((s, p) => s + p.pedidosEmCopiasSuperadas, 0) }, porContaCompetencia },
    syncs: { status: "ok", ultimoPorConta, agregadosPorConta: contas.map((c) => ({ clienteContaId: c.id, runs: 380, falhas: cliente.id === 3 ? 21 : 2, runs7d: 70, duracaoMedianaS: 140 })) },
    mercadoPago: { status: "ok", porConta: contas.filter((c) => c.marketplace === "meli").map((c) => ({ clienteContaId: c.id, linhas: 52000 * (c.id % 3 + 1), paymentsDistintos: 3700 * (c.id % 3 + 1), runs: 380, copiasPorPayment: cliente.id === 2 ? 1.1 : 14.1, ultimaColeta: iso(0.4) })) },
    inconsistencias: [
      { codigo: "import_com_conta_de_outro_cliente", descricao: "Import da Central apontando para conta de OUTRO cliente", status: "ok", ocorrencias: 0 },
      { codigo: "conta_meli_sem_grant", descricao: "Conta ML ativa sem grant (ml_tokens) para o external_account_id", status: "ok", ocorrencias: cliente.id === 3 ? 1 : 0 },
      { codigo: "run_preso", descricao: "Sync run em queued/running há mais de 6 h", status: "ok", ocorrencias: 0 },
    ],
    fluxo: [],
  };
  const comLinhas = tabelas.filter((t) => t.status === "ok" && t.linhas > 0);
  raiox.resumo = { tabelasComDados: comLinhas.length, linhas: comLinhas.reduce((s, t) => s + t.linhas, 0), bytesEstimados: comLinhas.reduce((s, t) => s + (t.bytesEstimados || 0), 0), tabelasManuaisComDados: comLinhas.filter((t) => t.manual).map((t) => t.tabela), blocosComTimeout: [] };
  return raiox;
}

function vinculosSinteticos(cliente, contaId) {
  if (cliente.id !== 2) return { status: "ok", imports: [] };
  const imports = [
    { importId: 2011, clienteContaId: 7, marketplace: "meli", competencia: "2026-11", publicacao: "published", papel: "referencia", linhasFornecidas: 0, usadoPorImports: [], vinculos: 912 },
    { importId: 2008, clienteContaId: 7, marketplace: "meli", competencia: "2026-11", publicacao: "published", papel: "fornece", linhasFornecidas: 640, usadoPorImports: [2011], vinculos: 0 },
    { importId: 2009, clienteContaId: 7, marketplace: "meli", competencia: "2026-11", publicacao: "published", papel: "ambos", linhasFornecidas: 272, usadoPorImports: [2011], vinculos: 400 },
  ];
  return { status: "ok", imports: contaId == null ? imports : imports.filter((i) => i.clienteContaId === contaId) };
}

function criar() {
  const cat = catalogo();
  const visao = { ...compor(tabelasDoBanco(), { banco: "sintetico", versaoPostgres: "18 (sintético)", bytesBanco: 6718e6, clientes: CLIENTES.length, contas: CLIENTES.reduce((s, c) => s + c.contas.length, 0) }) };
  return {
    modo: "sintetico",
    visaoGeral: async () => visao,
    listarClientes: async () => CLIENTES,
    raioXDoCliente: async ({ clienteId = null, clienteSlug = null, contaId = null }) => {
      const cliente = CLIENTES.find((c) => c.id === Number(clienteId) || c.slug === clienteSlug);
      if (!cliente) return { ok: false, codigo: "CLIENTE_NAO_ENCONTRADO" };
      if (contaId != null && !cliente.contas.some((c) => c.id === Number(contaId))) return { ok: false, codigo: "CONTA_NAO_PERTENCE_AO_CLIENTE" };
      const cid = contaId == null ? null : Number(contaId);
      return finalizarCliente({ raiox: raioXSinteticoCru(cliente, cid), vinculos: vinculosSinteticos(cliente, cid), cat, visao });
    },
  };
}

module.exports = { criar, CLIENTES };
