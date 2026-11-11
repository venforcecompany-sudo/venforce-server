// server/tests/helpers/painelContasModeloMemoria.js
//
// Banco EM MEMÓRIA do Painel de Contas para os testes de contrato do
// painelContasService (sem Postgres): responde às queries marcadas
// /* authz:... */, /* squads:... */, /* painelAcesso:... */ e
// /* painelContas:... */. Extraído de painelContasOperacionalService.test.js
// para ser compartilhado com painelContasModoManual.test.js.

const { ehDialogoDeSchema } = require("./schemaVersionadoNoMock");
const pool = require("../../config/database");

function importRow(id, contaId, competencia, { fat, lc, fatComCusto = fat, status = "published", de = `${competencia}-01`, ate = `${competencia}-28`, publicado = `${competencia}-29T06:00:00.000Z` }) {
  return {
    id, cliente_conta_id: contaId, competencia, publication_status: status,
    coverage_date_from: de, coverage_date_to: ate, published_at: status === "published" ? publicado : null,
    created_at: publicado, sync_run_id: id + 1000,
    faturamento: fat, faturamento_com_custo: fatComCusto, lucro_contribuicao: lc,
    margem_contribuicao_percentual: lc !== null && fatComCusto > 0 ? Math.round((lc / fatComCusto) * 10000) / 100 : null,
    completeness_status: "complete",
  };
}

function novoModelo() {
  return {
    clientes: [
      { id: 1, slug: "amr-ecommerce", nome: "AMR ecommerce", ativo: true },
      { id: 2, slug: "red-fish", nome: "Red Fish", ativo: true },
      { id: 3, slug: "coremix", nome: "Coremix Loja", ativo: true },
      { id: 4, slug: "carpei", nome: "Carpei", ativo: true },
      { id: 5, slug: "velho-legado", nome: "Velho Legado", ativo: true },
      { id: 6, slug: "fora-da-carteira", nome: "Fora da Carteira", ativo: true },
    ],
    squads: [
      { id: 10, nome: "Squad 6", slug: "squad-6", ativo: true },
      { id: 20, nome: "Squad 2", slug: "squad-2", ativo: true },
      { id: 80, nome: "Squad 8 - Legado", slug: "squad-8-legado", ativo: true },
    ],
    // Ana coordena o Squad 6 e o legado; Beto coordena o Squad 2. Carla e
    // Dani são membros comuns do Squad 2 (sem coordenação).
    members: [
      { squad_id: 10, user_id: 100, is_primary: true, funcao: "coordenador", ativo: true },
      { squad_id: 80, user_id: 100, is_primary: false, funcao: "coordenador", ativo: true },
      { squad_id: 20, user_id: 200, is_primary: true, funcao: "coordenador", ativo: true },
      { squad_id: 20, user_id: 400, is_primary: true, funcao: "membro", ativo: true },
      { squad_id: 20, user_id: 500, is_primary: true, funcao: "membro", ativo: true },
    ],
    // Responsabilidades por cliente (cliente_responsaveis). Começa vazio,
    // como em produção; o bloco L cria os vínculos.
    responsaveis: [],
    history: [
      { cliente_id: 1, squad_id: 10, fim_em: null },
      { cliente_id: 2, squad_id: 10, fim_em: null },
      { cliente_id: 3, squad_id: 10, fim_em: null },
      { cliente_id: 4, squad_id: 10, fim_em: null },
      { cliente_id: 5, squad_id: 80, fim_em: null },
      { cliente_id: 6, squad_id: 20, fim_em: null },
    ],
    contas: [
      // AMR: 3 contas ML (caso real que parecia faturamento errado)
      { id: 11, cliente_id: 1, marketplace: "meli", nome: "AMARO SOLUÇÕES", slug: "amr-1", external_account_id: "ML11", is_primary: true, ativo: true },
      { id: 12, cliente_id: 1, marketplace: "meli", nome: "AMR 2", slug: "amr-2", external_account_id: "ML12", is_primary: false, ativo: true },
      { id: 13, cliente_id: 1, marketplace: "meli", nome: "AMR 3", slug: "amr-3", external_account_id: "ML13", is_primary: false, ativo: true },
      // Red Fish: 1 conta ML, snapshots antigos (jun/ago) mas nada em set
      { id: 21, cliente_id: 2, marketplace: "meli", nome: "RED FISH", slug: "red-1", external_account_id: "ML21", is_primary: true, ativo: true },
      // Coremix: Shopee (sem integração automática)
      { id: 31, cliente_id: 3, marketplace: "shopee", nome: "COREMIX SHOP", slug: "core-1", external_account_id: null, is_primary: true, ativo: true },
      // Carpei: ML não conectado
      { id: 41, cliente_id: 4, marketplace: "meli", nome: "CARPEI", slug: "carpei-1", external_account_id: null, is_primary: true, ativo: true },
      { id: 51, cliente_id: 5, marketplace: "meli", nome: "LEGADO", slug: "leg-1", external_account_id: "ML51", is_primary: true, ativo: true },
      { id: 61, cliente_id: 6, marketplace: "meli", nome: "OUTRO", slug: "out-1", external_account_id: "ML61", is_primary: true, ativo: true },
    ],
    resumos: [
      { cliente_id: 2, competencia: "2026-06", faturamento: 90000, mc_media: 0.2, ads_investido: null, payload_json: {}, sincronizado_em: "2026-07-01T00:00:00.000Z" },
      { cliente_id: 2, competencia: "2026-08", faturamento: 95000, mc_media: 0.21, ads_investido: null, payload_json: {}, sincronizado_em: "2026-09-01T00:00:00.000Z" },
    ],
    imports: [
      importRow(1101, 11, "2026-09", { fat: 2833602, lc: 425040 }),
      importRow(1201, 12, "2026-09", { fat: 800000, lc: 120000 }),
      importRow(1301, 13, "2026-09", { fat: 420512, lc: 63000 }),
      importRow(5101, 51, "2026-09", { fat: 1000, lc: 100 }),
      importRow(6101, 61, "2026-09", { fat: 7777, lc: 777 }),
    ],
    runs: [],
    ads: [
      { cliente_slug: "amr-ecommerce", mes_ref: "2026-09", loja_campanha: "todas", investimento_ads: 120000, gmv_ads: 900000, updated_at: "2026-09-29T07:00:00.000Z" },
    ],
    manuais: [],
    historico: [],
    users: [{ id: 100, nome: "Ana" }, { id: 200, nome: "Beto" }, { id: 1, nome: "Admin" }, { id: 400, nome: "Carla" }, { id: 500, nome: "Dani" }],
  };
}

function portfolioInterno(m, userId) {
  const squadsDoUser = new Set(m.members.filter((x) => x.user_id === userId && x.ativo).map((x) => x.squad_id));
  return m.clientes
    .filter((c) => c.ativo && m.history.some((h) => h.cliente_id === c.id && h.fim_em === null && squadsDoUser.has(h.squad_id)))
    .map(({ id, slug, nome }) => ({ id, slug, nome }));
}

// Espelho em memória das queries de painelContasAcesso: qualquer membership
// ativa (coordenador, gestor ou membro) em Squad ativo dá a carteira do Squad.
function squadsDe(m, userId) {
  return m.members.filter((x) => x.user_id === userId && x.ativo
    && m.squads.some((sq) => sq.id === x.squad_id && sq.ativo)).map((x) => x.squad_id);
}
function clientesPainel(m, userId) {
  const sqs = new Set(squadsDe(m, userId));
  const porSquad = m.clientes.filter((c) => c.ativo && m.history.some((h) => h.cliente_id === c.id && h.fim_em === null && sqs.has(h.squad_id)));
  const porGestor = m.clientes.filter((c) => c.ativo && m.responsaveis.some((r) => r.cliente_id === c.id && r.user_id === userId && r.ativo && r.papel === "gestor"));
  return { porSquad, porGestor };
}

function nomeDe(m, userId) {
  return (m.users.find((u) => u.id === userId) || {}).nome || null;
}

function instalarMock(m) {
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  const contagem = { total: 0, porTag: new Map() };
  const contar = (tag) => { contagem.total += 1; contagem.porTag.set(tag, (contagem.porTag.get(tag) || 0) + 1); };

  async function query(sql, params = []) {
    const q = String(sql).replace(/\s+/g, " ").trim();
    if (q.includes("CREATE TABLE IF NOT EXISTS painel_contas_lancamentos_manuais")) { contar("ensure:painel"); return { rows: [] }; }
    // DDL dos ensures (Squads roda arquivos de migration, que começam com comentário).
    if (/^(--|CREATE|ALTER|DROP|BEGIN|COMMIT|ROLLBACK|DO )/i.test(q) || q.includes("pg_advisory")) return { rows: [] };
    // Diálogo do marcador de versão de schema (schemaVersionado, P0 03/11/2026).
    if (ehDialogoDeSchema(q)) return { rows: [] };

    if (q.includes("painelAcesso:ADMIN_TODOS")) { contar("authz"); return { rows: m.clientes.filter((c) => c.ativo).map(({ id, slug, nome }) => ({ id, slug, nome })) }; }
    if (q.includes("painelAcesso:SQUADS_DO_USUARIO")) {
      contar("authz");
      return { rows: squadsDe(m, params[0]).map((id) => m.squads.find((sq) => sq.id === id)).map(({ id, nome, slug }) => ({ id, nome, slug, funcao: m.members.find((x) => x.user_id === params[0] && x.squad_id === id).funcao })) };
    }
    if (q.includes("painelAcesso:CLIENTES_DOS_SQUADS")) { contar("authz"); return { rows: clientesPainel(m, params[0]).porSquad.map(({ id, slug, nome }) => ({ id, slug, nome })) }; }
    if (q.includes("painelAcesso:CLIENTES_GESTOR")) { contar("authz"); return { rows: clientesPainel(m, params[0]).porGestor.map(({ id, slug, nome }) => ({ id, slug, nome })) }; }
    if (q.includes("painelAcesso:PODE_VER_CLIENTE")) {
      contar("authz");
      const { porSquad, porGestor } = clientesPainel(m, params[0]);
      return { rows: [...porSquad, ...porGestor].some((c) => c.id === Number(params[1])) ? [{ x: 1 }] : [] };
    }
    if (q.includes("authz:PORTFOLIO_INTERNAL_ENFORCEMENT_OFF")) { contar("authz"); return { rows: m.clientes.filter((c) => c.ativo).map(({ id, slug, nome }) => ({ id, slug, nome })) }; }
    if (q.includes("authz:CAN_ACCESS_ENFORCEMENT_OFF")) { contar("authz"); return { rows: m.clientes.some((c) => c.id === Number(params[0])) ? [{ x: 1 }] : [] }; }
    if (q.includes("authz:PORTFOLIO_ADMIN_ALL")) { contar("authz"); return { rows: m.clientes.filter((c) => c.ativo).map(({ id, slug, nome }) => ({ id, slug, nome })) }; }
    if (q.includes("authz:PORTFOLIO_SELLER")) { contar("authz"); return { rows: [] }; }
    if (q.includes("authz:PORTFOLIO_INTERNAL_BY_SQUAD")) { contar("authz"); return { rows: portfolioInterno(m, params[0]) }; }
    if (q.includes("authz:CAN_ACCESS_ADMIN")) { contar("authz"); return { rows: m.clientes.some((c) => c.id === Number(params[0])) ? [{ x: 1 }] : [] }; }
    if (q.includes("authz:CAN_ACCESS_INTERNAL")) { contar("authz"); return { rows: portfolioInterno(m, params[0]).some((c) => c.id === Number(params[1])) ? [{ x: 1 }] : [] }; }
    if (q.includes("authz:RESOLVE_CLIENTE_ID")) { contar("authz"); return { rows: m.clientes.filter((c) => c.id === Number(params[0])) }; }
    if (q.includes("authz:RESOLVE_CLIENTE_SLUG")) { contar("authz"); return { rows: m.clientes.filter((c) => c.slug === params[0]) }; }

    if (q.includes("squads:MEMBERSHIPS_DO_USUARIO")) {
      contar("squads");
      return {
        rows: m.members.filter((x) => x.user_id === params[0] && x.ativo).map((x) => {
          const s = m.squads.find((y) => y.id === x.squad_id);
          return { squad_id: s.id, is_primary: x.is_primary, funcao: x.funcao, squad_nome: s.nome, squad_slug: s.slug, squad_ativo: s.ativo };
        }),
      };
    }
    if (q.includes("squads:SQUADS_ATIVOS_DE_CLIENTES")) {
      contar("squads");
      return {
        rows: (params[0] || []).map((cid) => {
          const h = m.history.find((x) => x.cliente_id === cid && x.fim_em === null);
          if (!h) return null;
          const s = m.squads.find((y) => y.id === h.squad_id);
          return { cliente_id: cid, squad_id: s.id, squad_nome: s.nome, squad_slug: s.slug, squad_ativo: s.ativo };
        }).filter(Boolean),
      };
    }

    const ids = Array.isArray(params[0]) ? params[0].map(Number) : [];
    if (q.includes("painelContas:RESUMO_DA_COMPETENCIA")) {
      contar("painel:resumo");
      return {
        rows: m.resumos.filter((r) => ids.includes(r.cliente_id) && r.competencia === params[1]).map((r) => ({
          ...r, cliente_slug: m.clientes.find((c) => c.id === r.cliente_id).slug,
        })),
      };
    }
    if (q.includes("painelContas:ULTIMA_COMPETENCIA")) {
      contar("painel:ultima");
      const out = new Map();
      for (const r of m.resumos) if (ids.includes(r.cliente_id) && (!out.has(r.cliente_id) || r.competencia > out.get(r.cliente_id))) out.set(r.cliente_id, r.competencia);
      return { rows: [...out.entries()].map(([cliente_id, competencia]) => ({ cliente_id, competencia })) };
    }
    if (q.includes("painelContas:RESUMOS_DO_ANO")) {
      contar("painel:resumosAno");
      return { rows: m.resumos.filter((r) => r.cliente_id === params[0] && String(r.competencia).startsWith(String(params[1]).slice(0, 4))) };
    }
    if (q.includes("painelContas:CONTAS_DOS_CLIENTES")) { contar("painel:contas"); return { rows: m.contas.filter((c) => ids.includes(c.cliente_id)) }; }
    if (q.includes("painelContas:IMPORTS_DA_COMPETENCIA")) { contar("painel:imports"); return { rows: m.imports.filter((i) => ids.includes(i.cliente_conta_id) && i.competencia === params[1]) }; }
    if (q.includes("painelContas:ULTIMO_RUN_POR_CONTA")) { contar("painel:runs"); return { rows: m.runs.filter((r) => ids.includes(r.cliente_conta_id)) }; }
    if (q.includes("painelContas:ADS_DA_COMPETENCIA")) { contar("painel:ads"); return { rows: m.ads.filter((a) => params[0].includes(a.cliente_slug) && a.mes_ref === params[1]) }; }
    if (q.includes("painelContas:MANUAIS_DA_COMPETENCIA")) {
      contar("painel:manuais");
      return {
        rows: m.manuais.filter((x) => ids.includes(x.cliente_conta_id) && x.competencia === params[1])
          .map((x) => ({ ...x, updated_by_nome: nomeDe(m, x.updated_by), created_by_nome: nomeDe(m, x.created_by) })),
      };
    }
    if (q.includes("painelContas:MANUAIS_DA_CONTA")) {
      contar("painel:manuaisConta");
      return {
        rows: m.manuais.filter((x) => x.cliente_conta_id === params[0] && x.cliente_id === params[1])
          .sort((a, b) => b.competencia.localeCompare(a.competencia))
          .map((x) => ({ ...x, updated_by_nome: nomeDe(m, x.updated_by), created_by_nome: nomeDe(m, x.created_by) })),
      };
    }
    if (q.includes("painelContas:HISTORICO_DA_CONTA")) {
      contar("painel:historicoConta");
      return {
        rows: m.historico.filter((h) => h.conta === params[0] && h.cliente_id === params[1] && h.competencia === params[2])
          .map((h) => ({ ...h, valores_json: h.valores, user_nome: nomeDe(m, h.user_id) }))
          .reverse(),
      };
    }
    if (q.includes("painelContas:CONTA_DO_CLIENTE")) {
      contar("painel:conta");
      return { rows: m.contas.filter((c) => c.id === Number(params[0]) && c.cliente_id === Number(params[1])) };
    }
    if (q.includes("painelContas:UPSERT_MANUAL")) {
      contar("painel:upsert");
      const [clienteId, contaId, competencia, fat, lc, mc, ads, gmv, obs, uid, dataRef] = params;
      let row = m.manuais.find((x) => x.cliente_conta_id === contaId && x.competencia === competencia);
      const inserido = !row;
      if (!row) {
        row = { id: m.manuais.length + 1, cliente_id: clienteId, cliente_conta_id: contaId, competencia, created_by: uid, created_at: "2026-09-29T12:00:00.000Z" };
        m.manuais.push(row);
      }
      Object.assign(row, { faturamento: fat, lucro_contribuicao: lc, margem_contribuicao: mc, investimento_ads: ads, gmv_ads: gmv, observacao: obs, data_referencia: dataRef, updated_by: uid, updated_at: "2026-09-29T12:00:00.000Z" });
      return { rows: [{ ...row, inserido }] };
    }
    if (q.includes("painelContas:DELETE_MANUAL")) {
      contar("painel:delete");
      const idx = m.manuais.findIndex((x) => x.cliente_conta_id === params[0] && x.competencia === params[1] && x.cliente_id === params[2]);
      if (idx === -1) return { rows: [] };
      const [row] = m.manuais.splice(idx, 1);
      return { rows: [row] };
    }
    if (q.includes("painelContas:HISTORICO_MANUAL")) {
      contar("painel:historico");
      const removido = q.includes("'removido'");
      m.historico.push({
        id: m.historico.length + 1, created_at: `2026-09-29T12:00:${String(m.historico.length).padStart(2, "0")}.000Z`,
        lancamento_id: params[0], cliente_id: params[1], conta: params[2], competencia: params[3],
        acao: removido ? "removido" : params[4],
        valores: JSON.parse(removido ? params[4] : params[5]),
        user_id: removido ? params[5] : params[6],
      });
      return { rows: [] };
    }

    if (/to_regclass\('public\.central_vendas_import_pedidos'\)/.test(String(q))) return { rows: [{ ok: false }] };
    throw new Error(`SQL inesperado no teste: ${q.slice(0, 100)}`);
  }

  pool.query = (sql, params) => query(sql, params);
  pool.connect = async () => ({ query: (sql, params) => query(sql, params), release() {} });
  return { restaurar: () => { pool.query = originalQuery; pool.connect = originalConnect; }, contagem };
}

module.exports = { importRow, novoModelo, instalarMock };
