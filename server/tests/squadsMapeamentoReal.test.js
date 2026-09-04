// server/tests/squadsMapeamentoReal.test.js
//
// V3 P2.9 REAL MAPPING — as regras que decidem QUEM acessa O QUÊ em produção.
//
// Este módulo resolve a relação operacional contra o banco real e produz o mapa
// Cliente→Squad. Um erro aqui não quebra nada visivelmente: ele dá a carteira
// errada para uma pessoa real, em silêncio, no dia em que o enforcement ligar.
// Por isso cada regra é testada com o caso que ela existe para recusar.
//
// Os cenários usam a FORMA dos dados reais (sufixo legado, colisão de
// ml_user_id, grant cruzado, nome curto ambíguo), com dados fabricados.

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/vf-test";

const assert = require("assert");
const M = require("../sql/squads-mapeamento-real");

let checks = 0;
function ok(label, condition) {
  assert.ok(condition, `FALHOU: ${label}`);
  checks += 1;
  console.log(`  ok  ${label}`);
}

/* ─────────────────── construtores de cenário ─────────────────── */

function cliente(id, nome, slug, extra = {}) {
  return { id, nome, slug, ativo: true, contas_total: 0, contas_ativas: 0, contas_inativas: 0, marketplaces_ativos: [], ...extra };
}
function conta(id, cliente_id, external_account_id, extra = {}) {
  return { id, cliente_id, marketplace: "meli", nome: "Mercado Livre 1", slug: `c${id}`, external_account_id, is_primary: true, ativo: true, ...extra };
}
function grant(id, cliente_id, ml_user_id, cliente_conta_id = null, is_primary = true) {
  return { id, cliente_id, cliente_conta_id, ml_user_id, is_primary, token_status: "valid", refresh_failures: 0, expirado: false };
}
function cenario({ clientes = [], contas = [], grants = [], bases = [], usuarios = [], colisoesGrant = [], colisoesConta = [], squads = [] } = {}) {
  const porCliente = new Map();
  for (const c of contas) porCliente.set(c.cliente_id, (porCliente.get(c.cliente_id) || 0) + 1);
  return {
    inventario: {
      geradoEm: new Date().toISOString(),
      clientes: clientes.map((c) => ({ ...c, contas_total: porCliente.get(c.id) || 0, contas_ativas: porCliente.get(c.id) || 0 })),
      cliente_contas: contas, grants, base_vinculos: bases, usuarios,
      squads: [], squad_members: [], cliente_squad_history: [], cliente_responsaveis: [],
    },
    auditoria: {
      matrizReferencias: [
        { tabela: "ml_tokens", coluna: "cliente_id", temFk: true, onDelete: "CASCADE" },
        { tabela: "meli_anuncios", coluna: "cliente_id", temFk: false, onDelete: null },
      ],
      contagens: [{ tabela: "ml_tokens", coluna: "cliente_id", total: grants.length, nulos: 0, porChave: {} }],
      colisoes: { grants_ml_user_id: colisoesGrant, contas_external_account_id: colisoesConta },
      apiKeys: clientes.map((c) => ({ id: c.id, tem_api_key: true, tamanho_api_key: 67 })),
    },
    relacao: { versao: 2, squads },
  };
}
const seisSquads = (cl = {}) => [1, 2, 3, 4, 5, 6].map((n) => ({
  numero: n, rotuloPlanilha: `squad ${n}`, slug: `squad-${n}`, nome: `Squad ${n}`,
  papeis: { coordenador: "AUSENTE_NA_ESTRUTURA", gestor: "AUSENTE_NA_ESTRUTURA", auxiliar: "AUSENTE_NA_ESTRUTURA", auxiliar2: "AUSENTE_NA_ESTRUTURA", design: "AUSENTE_NA_ESTRUTURA" },
  clientes: cl[n] || [],
}));

/* ═══════════════ 1. normalização e sufixo legado ═══════════════ */

function testarNormalizacao() {
  console.log("\n1 · normalização");
  ok("acento e pontuação somem", M.normalizar("Empório Luz!") === "emporio luz");
  ok("underscore vira separador", M.normalizar("dua_cosmeticos_2") === "dua cosmeticos 2");
  ok("forma compacta ignora separador", M.compacta("J&W Presentes") === "jwpresentes");
  ok("`AVENDA` ≡ `a_venda` na forma compacta", M.compacta("AVENDA") === M.compacta("a_venda"));
  ok("`Giromax` ≡ `Giro Max` na forma compacta", M.compacta("Giromax") === M.compacta("Giro Max"));
  ok("conectivos somem na forma sem conectivos",
    M.compactaSemConectivos("Toque de Ouro") === M.compactaSemConectivos("Toque ouro"));

  console.log("\n1b · sufixo legado NÃO é ganancioso");
  ok("`Alma 2` tem radical `alma`", M.radicalLegado("Alma 2") === "alma");
  ok("`maya 5` tem radical `maya`", M.radicalLegado("maya 5") === "maya");
  ok("`Luli_1` tem radical `luli`", M.radicalLegado("Luli_1") === "luli");
  ok("`Shopping 86` NÃO tem sufixo legado (86 não é 1–9)", M.radicalLegado("Shopping 86") === null);
  ok("`er2` NÃO tem sufixo legado (é uma palavra só)", M.radicalLegado("er2") === null);
  ok("`ER 2` teria radical `er`, curto demais → recusado", M.radicalLegado("ER 2") === null);
  ok("`Fenix Equipamentos1` NÃO tem sufixo (não há token separado)",
    M.radicalLegado("Fenix Equipamentos1") === null);

  console.log("\n1c · distância de edição");
  ok("`kirus` ≈ `kirius` (1 letra, ≥5)", M.proximo("kirius", "kirus"));
  ok("`cavazotto` ≈ `cavazzoto` (2 letras, ≥8)", M.proximo("cavazotto", "cavazzoto"));
  ok("`witor` ≢ `victor` (2 letras, comprimento <8)", !M.proximo("witor", "victor"));
  ok("nomes curtos só por igualdade", !M.proximo("mm", "mw") && !M.proximo("gs", "ads"));
  ok("distancia() calcula certo", M.distancia("abc", "abd", 2) === 1 && M.distancia("abc", "xyz", 2) === 3);
}

/* ═══════════════ 2. clusters ═══════════════ */

function testarClusterSufixoAutovalidado() {
  console.log("\n2 · cluster por sufixo — só quando o radical EXISTE");
  const c = cenario({
    clientes: [cliente(1, "Alma", "alma"), cliente(2, "Alma 2", "alma_2"),
      cliente(3, "er2", "er_2"), cliente(4, "Shopping 86", "shopping_86")],
    squads: seisSquads(),
  });
  const r = M.mapear(c);
  ok("forma exatamente 1 cluster", r.clusters.length === 1);
  ok("o cluster é alma + alma 2", r.clusters[0].canonicalClienteId === 1 && r.clusters[0].aliasClienteIds.join() === "2");
  ok("`er2` NÃO virou cluster (não existe cliente `er`)", !r.clusters.some((x) => x.membros.some((m) => m.id === 3)));
  ok("`Shopping 86` NÃO virou cluster", !r.clusters.some((x) => x.membros.some((m) => m.id === 4)));
}

function testarClusterChaveNatural() {
  console.log("\n2b · cluster por chave natural (a prova forte)");
  const c = cenario({
    clientes: [cliente(10, "William Modas", "william_modas"), cliente(11, "wm.modas", "wmmodas")],
    grants: [grant(1, 10, "999"), grant(2, 11, "999")],
    colisoesGrant: [{ ml_user_id: "999", clientes: [10, 11], grants: [1, 2], clientes_distintos: 2 }],
    squads: seisSquads(),
  });
  const r = M.mapear(c);
  ok("nomes sem parentesco textual ainda formam cluster", r.clusters.length === 1);
  ok("confiança é CONFIRMADO (ambos primários no mesmo ml_user_id)", r.clusters[0].confianca === M.CONF.CONFIRMADO);
  ok("a evidência registrada é ML_USER_ID",
    r.clusters[0].evidencias.some((e) => e.tipo === "ML_USER_ID"));
}

function testarGrantCruzadoNaoMergeia() {
  console.log("\n2c · grant cruzado NÃO é identidade");
  const c = cenario({
    clientes: [cliente(20, "Fenix Equipamentos1", "fenix_equipamentos1"), cliente(21, "Eliza.Market", "elizamarket")],
    contas: [conta(1, 20, "111")],
    grants: [grant(1, 20, "111", 1, true), grant(2, 20, "222", null, false), grant(3, 21, "222", null, true)],
    colisoesGrant: [{ ml_user_id: "222", clientes: [20, 21], grants: [2, 3], clientes_distintos: 2 }],
    squads: seisSquads(),
  });
  const r = M.mapear(c);
  ok("NÃO forma cluster", r.clusters.length === 0);
  ok("registra o par como NAO_MERGEAR", r.naoMergear.length === 1);
  ok("classifica como GRANT_CRUZADO_DEFEITO", r.naoMergear[0].classe === "GRANT_CRUZADO_DEFEITO");
  ok("os dois continuam clientes independentes no mapa",
    r.mapaClientes.filter((m) => [20, 21].includes(m.clienteId)).every((m) => m.papel === "CANONICO"));
}

function testarCanonicoNaoEhMenorId() {
  console.log("\n2d · canônico é evidência, não `menor id`");
  const c = cenario({
    // #30 tem sufixo legado mas id menor; #31 é o nome limpo
    clientes: [cliente(30, "Maya 2", "maya_2"), cliente(31, "Maya", "maya")],
    contas: [conta(1, 30, "aaa"), conta(2, 30, "bbb")],
    grants: [grant(1, 30, "aaa", 1), grant(2, 30, "bbb", 2)],
    squads: seisSquads(),
  });
  const r = M.mapear(c);
  ok("o canônico é o SEM sufixo, mesmo com id maior e menos dados",
    r.clusters[0].canonicalClienteId === 31);
  ok("o componente `semSufixoLegado` domina o score",
    r.clusters[0].membros.find((m) => m.id === 31).componentes.semSufixoLegado === 1000);
}

/* ═══════════════ 3. casamento e ambiguidade ═══════════════ */

function testarNomeCurtoAmbiguo() {
  console.log("\n3 · nome curto ambíguo NUNCA é resolvido por palpite");
  const c = cenario({
    clientes: [cliente(50, "MM Importes", "mm_importes"), cliente(51, "MM Comercio", "mm_comercio")],
    squads: seisSquads({ 3: ["MM"] }),
  });
  const r = M.mapear(c);
  const mm = r.matches.find((m) => m.nomeRelacao === "MM");
  ok("`MM` vira MATCH_AMBIGUO", mm.classe === M.CLASSE.AMBIGUO);
  ok("lista os dois candidatos", mm.candidatos.length === 2);
  ok("NÃO escolhe nenhum", mm.clienteId === null);
  ok("os DOIS candidatos vão para o Squad 8 (default seguro)",
    r.mapaClientes.filter((m) => [50, 51].includes(m.clienteId)).every((m) => m.squad === M.SQUAD_LEGADO.slug));
}

function testarClienteInexistenteNaoEhCriado() {
  console.log("\n3b · cliente da relação que não existe NÃO é criado");
  const c = cenario({
    clientes: [cliente(60, "Carpei", "carpei")],
    squads: seisSquads({ 1: ["Carpei", "Nikolly Fashion", "GS"] }),
  });
  const r = M.mapear(c);
  const faltantes = r.matches.filter((m) => m.classe === M.CLASSE.INEXISTENTE);
  ok("2 nomes classificados como NAO_EXISTE_NO_BANCO", faltantes.length === 2);
  ok("o plano tem só o cliente que existe", r.planoP29.clientes.length === 1);
  ok("nenhuma entrada do plano cita cliente inexistente",
    r.invariantes.find((i) => i.id === "I14").passou);
  ok("o mapa tem exatamente 1 cliente", r.mapaClientes.length === 1);
}

function testarCamadasNaoSePassamPorExatas() {
  console.log("\n3c · a primeira camada que decide é a mais estrita disponível");
  const c = cenario({
    clientes: [cliente(70, "Tenda Medieval", "tenda_medieval"), cliente(71, "Tenda", "tenda")],
    squads: seisSquads({ 1: ["Tenda"] }),
  });
  const r = M.mapear(c);
  const t = r.matches.find((m) => m.nomeRelacao === "Tenda");
  ok("com igualdade exata disponível, o prefixo não é usado", t.camada === "L1_IGUALDADE_EXATA");
  ok("resolve para o cliente de nome exato, não para o mais longo", t.clienteId === 71);
}

/* ═══════════════ 4. Squad 8 e alias ═══════════════ */

function testarSquad8() {
  console.log("\n4 · Squad 8 · Legado");
  const c = cenario({
    clientes: [cliente(80, "Carpei", "carpei"), cliente(81, "Cliente Antigo", "cliente_antigo"),
      cliente(82, "teste1", "teste1")],
    squads: seisSquads({ 1: ["Carpei"] }),
  });
  const r = M.mapear(c);
  ok("slug do Squad legado é `squad-8-legado`", M.SQUAD_LEGADO.slug === "squad-8-legado");
  ok("nome canônico é `Squad 8 · Legado`", M.SQUAD_LEGADO.nome === "Squad 8 · Legado");
  ok("clientes fora da relação vão para o Squad 8",
    r.mapaClientes.filter((m) => [81, 82].includes(m.clienteId)).every((m) => m.squad === M.SQUAD_LEGADO.slug));
  ok("cliente da relação NÃO vai para o Squad 8",
    r.mapaClientes.find((m) => m.clienteId === 80).squad === "squad-1");
  ok("Squad 8 entra no plano de squads", r.planoP29.squads.some((s) => s.slug === M.SQUAD_LEGADO.slug));
  ok("Squad 8 NÃO recebe membership nenhuma",
    r.planoP29.membros.filter((m) => m.squad === M.SQUAD_LEGADO.slug).length === 0);
  ok("exatamente 6 operacionais + 1 legado", r.invariantes.find((i) => i.id === "I15").passou);
  ok("nenhum squad-7 ou squad-9", r.invariantes.find((i) => i.id === "I16").passou);
}

function testarAliasHerdaSquadDoCanonico() {
  console.log("\n4b · alias herda o Squad do canônico (nunca ganha o seu)");
  const c = cenario({
    clientes: [cliente(90, "Alma", "alma"), cliente(91, "Alma 2", "alma_2")],
    squads: seisSquads({ 5: ["Alma"] }),
  });
  const r = M.mapear(c);
  const canon = r.mapaClientes.find((m) => m.clienteId === 90);
  const alias = r.mapaClientes.find((m) => m.clienteId === 91);
  ok("o canônico vai para o Squad da relação", canon.squad === "squad-5");
  ok("o alias vai para o MESMO Squad", alias.squad === "squad-5");
  ok("e é marcado como herança, não como decisão própria", alias.origem === "ALIAS_HERDA_CANONICO");
  ok("o alias NÃO fica sem Squad (seria invisível no enforcement)", Boolean(alias.squad));
  ok("invariante `alias não ganha Squad próprio` passa", r.invariantes.find((i) => i.id === "I9").passou);
}

/* ═══════════════ 5. preservação ═══════════════ */

function testarGrantsPreservados() {
  console.log("\n5 · Grants: nenhum some, nenhum troca de conta");
  const c = cenario({
    clientes: [cliente(100, "Empresa", "empresa"), cliente(101, "Empresa 2", "empresa_2")],
    contas: [conta(1, 100, "AAA"), conta(2, 101, "BBB")],
    grants: [grant(1, 100, "AAA", 1), grant(2, 101, "BBB", 2)],
    squads: seisSquads({ 1: ["Empresa"] }),
  });
  const r = M.mapear(c);
  const op = r.planoConsolidacao.operacoes[0];
  ok("o grant do alias é endereçado pelo plano", op.grants.length === 1);
  ok("ele segue a própria conta, não a do canônico", op.grants[0].acao === "SEGUE_A_CONTA_MOVIDA");
  ok("o ml_user_id é preservado", op.grants[0].mlUserId === "BBB");
  ok("a conta muda de dono mas não de identidade",
    op.clienteContas[0].externalAccountId === "BBB" && op.clienteContas[0].acao === "MOVER_CONTA");
  ok("o plano avisa para RECALCULAR is_primary", /RECALCULADO/.test(op.grants[0].nota));
  ok("I1 nenhum Grant some", r.invariantes.find((i) => i.id === "I1").passou);
  ok("I2 nenhum Grant troca de seller/conta", r.invariantes.find((i) => i.id === "I2").passou);
  ok("I3 nenhuma conta muda de marketplace", r.invariantes.find((i) => i.id === "I3").passou);
}

function testarContaDuplicadaNaoDuplica() {
  console.log("\n5b · multi-conta: mesma chave natural nunca vira segunda ClienteConta");
  const c = cenario({
    clientes: [cliente(110, "Empresa", "empresa"), cliente(111, "Empresa 2", "empresa_2")],
    contas: [conta(1, 110, "MESMA"), conta(2, 111, "MESMA", { ativo: false })],
    grants: [grant(1, 110, "MESMA", 1)],
    colisoesConta: [{ external_account_id: "MESMA", marketplace: "meli", clientes: [110, 111], contas: [1, 2], clientes_distintos: 2 }],
    squads: seisSquads({ 1: ["Empresa"] }),
  });
  const r = M.mapear(c);
  const op = r.planoConsolidacao.operacoes[0];
  ok("a conta do alias é marcada DEDUPLICAR_CONTA", op.clienteContas[0].acao === "DEDUPLICAR_CONTA");
  ok("aponta a conta do canônico como destino", op.clienteContas[0].contaDestinoExistente === 1);
  ok("I4 nenhuma ClienteConta duplicada", r.invariantes.find((i) => i.id === "I4").passou);
}

function testarGrantSemContaEhBloqueante() {
  console.log("\n5c · grant client-level legado é BLOQUEANTE, não silencioso");
  const c = cenario({
    clientes: [cliente(120, "Empresa", "empresa"), cliente(121, "Empresa 2", "empresa_2")],
    grants: [grant(1, 121, "ORFAO", null)],
    squads: seisSquads({ 1: ["Empresa"] }),
  });
  const r = M.mapear(c);
  const op = r.planoConsolidacao.operacoes[0];
  ok("o grant sem conta é marcado SEM_CONTA_CORRESPONDENTE", op.grants[0].acao === "SEM_CONTA_CORRESPONDENTE");
  ok("e sinalizado como bloqueante", op.grants[0].bloqueante === true);
  ok("o cluster deixa de ser aplicável automaticamente", op.aplicavelAutomaticamente === false);
  ok("o bloqueador aparece na lista do cluster", op.bloqueadores.length === 1);
}

function testarPlanoNuncaCriaNemDeleta() {
  console.log("\n5d · o plano nunca cria nem deleta cliente");
  const c = cenario({
    clientes: [cliente(130, "Empresa", "empresa"), cliente(131, "Empresa 2", "empresa_2")],
    contas: [conta(1, 131, "X")],
    grants: [grant(1, 131, "X", 1)],
    squads: seisSquads({ 1: ["Empresa", "Cliente Que Nao Existe"] }),
  });
  const r = M.mapear(c);
  const txt = JSON.stringify(r.planoConsolidacao);
  ok("nenhuma ação de criação de cliente", !/CRIAR_CLIENTE/.test(txt));
  ok("nenhuma ação de deleção", !/DELETE|DELETAR|REMOVER_CLIENTE/i.test(txt));
  ok("toda operação é PLAN_ONLY", r.planoConsolidacao.operacoes.every((o) => o.acao === "PLAN_ONLY"));
  ok("o aviso de PLAN_ONLY está no artefato", /PLAN_ONLY/.test(r.planoConsolidacao.aviso));
  ok("I5 nenhum Cliente novo é criado", r.invariantes.find((i) => i.id === "I5").passou);
}

/* ═══════════════ 6. identidade ═══════════════ */

function testarIdentidadeExataAntesDeAproximada() {
  console.log("\n6 · identidade: exato antes de aproximado");
  const usuarios = [
    { id: 6, nome: "Vitor Capeli", email: "vitor.capeli@x.com", role: "admin", ativo: true },
    { id: 31, nome: "Witor Silva", email: "witor.silva@x.com", role: "user", ativo: true },
  ];
  const squads = seisSquads();
  squads[4].papeis.gestor = "Witor";
  const r = M.mapear(cenario({ clientes: [], usuarios, squads }));
  const w = r.identidades.find((i) => i.nomeRelacao === "Witor");
  ok("`Witor` casa por token EXATO", w.camada === "TOKEN_EXATO" && w.classe === "MATCH_EXATO");
  ok("resolve para Witor Silva, não para Vitor Capeli", w.userId === 31);
}

function testarIdentidadePorExclusao() {
  console.log("\n6b · identidade: propagação por exclusão");
  const usuarios = [
    { id: 16, nome: "Gabrielly Ribeiro", email: "gabrielly.ribeiro@x.com", role: "user", ativo: true },
    { id: 47, nome: "Gabrielly Cavazotto", email: "gabrielly.cavazotto@x.com", role: "membro", ativo: true },
  ];
  const squads = seisSquads();
  squads[0].papeis.design = "Gabrielly";
  squads[2].papeis.design = "Cavazzoto";
  const r = M.mapear(cenario({ clientes: [], usuarios, squads }));
  const cav = r.identidades.find((i) => i.nomeRelacao === "Cavazzoto");
  const gab = r.identidades.find((i) => i.nomeRelacao === "Gabrielly");
  ok("`Cavazzoto` resolve para #47 por aproximação de sobrenome", cav.userId === 47);
  ok("`Gabrielly` deixa de ser ambíguo e resolve para #16", gab.userId === 16);
  ok("e é marcado como resolvido por exclusão", gab.classe === "MATCH_POR_EXCLUSAO");
}

function testarAproximadoEmAdminNaoEhAceito() {
  console.log("\n6c · aproximado sobre conta admin não é aceito sozinho");
  const usuarios = [{ id: 6, nome: "Vitor Capeli", email: "vitor.capeli@x.com", role: "admin", ativo: true }];
  const squads = seisSquads();
  squads[5].papeis.auxiliar = "Victor";
  const r = M.mapear(cenario({ clientes: [], usuarios, squads }));
  const v = r.identidades.find((i) => i.nomeRelacao === "Victor");
  ok("`Victor` NÃO é auto-resolvido para a conta admin", v.userId === null);
  ok("é marcado ambíguo com o motivo explícito", v.classe === "MATCH_AMBIGUO" && /admin/.test(v.motivo || ""));

  // o mesmo nome, apontando para conta NÃO-admin, resolve normalmente
  const usuarios2 = [{ id: 99, nome: "Vitor Souza", email: "vitor.souza@x.com", role: "membro", ativo: true }];
  const r2 = M.mapear(cenario({ clientes: [], usuarios: usuarios2, squads }));
  const v2 = r2.identidades.find((i) => i.nomeRelacao === "Victor");
  ok("mas a mesma aproximação sobre conta não-admin é aceita", v2.userId === 99 && v2.classe === "MATCH_APROXIMADO");
}

function testarMultiSquadNaoDecideSozinho() {
  console.log("\n6d · Squad principal nunca é escolhido pela máquina");
  const usuarios = [{ id: 24, nome: "Micael Almeida", email: "micael@x.com", role: "user", ativo: true }];
  const squads = seisSquads();
  squads[0].papeis.coordenador = "Micael";
  squads[4].papeis.coordenador = "Micael";
  const r = M.mapear(cenario({ clientes: [], usuarios, squads }));
  const mic = r.identidades.find((i) => i.nomeRelacao === "Micael");
  ok("é detectado como multi-Squad", mic.multiSquad === true);
  ok("as duas memberships entram no plano", r.planoP29.membros.filter((m) => m.usuario === "micael@x.com").length === 2);
  ok("NENHUMA delas é marcada principal",
    r.planoP29.membros.filter((m) => m.usuario === "micael@x.com").every((m) => m.principal !== true));
  ok("as duas são marcadas como principal PENDENTE",
    r.planoP29.membros.filter((m) => m.usuario === "micael@x.com").every((m) => m._principalPendente === true));
  ok("há bloqueio SQUAD_PRINCIPAL_PENDENTE", r.bloqueios.some((b) => b.tipo === "SQUAD_PRINCIPAL_PENDENTE"));
  ok("o modo ESTRITO recusa emitir", r.emitivel === false);
}

function testarCoordenadorNaoEhGestor() {
  console.log("\n6e · Coordenador ≠ Gestor (correção preservada)");
  const usuarios = [
    { id: 1, nome: "Coord Pessoa", email: "coord@x.com", role: "user", ativo: true },
    { id: 2, nome: "Gestor Pessoa", email: "gestor@x.com", role: "user", ativo: true },
  ];
  const squads = seisSquads();
  squads[0].papeis.coordenador = "Coord";
  squads[0].papeis.gestor = "Gestor";
  const r = M.mapear(cenario({ clientes: [], usuarios, squads }));
  const co = r.planoP29.membros.find((m) => m.usuario === "coord@x.com");
  const ge = r.planoP29.membros.find((m) => m.usuario === "gestor@x.com");
  ok("Coordenador vira funcao=coordenador", co && co.funcao === "coordenador");
  ok("Gestor vira funcao=membro, NÃO coordenador", ge && ge.funcao === "membro");
  ok("o papel operacional fica registrado", ge._papelOperacional === "gestor");
  ok("mapeamento de papéis é explícito",
    M.FUNCAO_SQUAD.gestor === "membro" && M.FUNCAO_SQUAD.design === "membro" &&
    M.FUNCAO_SQUAD.coordenador === "coordenador");
}

/* ═══════════════ 7. responsabilidades e integridade final ═══════════════ */

function testarResponsabilidadesNaoSaoInventadas() {
  console.log("\n7 · responsabilidades NÃO são inventadas a partir do Squad");
  const usuarios = [{ id: 1, nome: "Gestor Pessoa", email: "g@x.com", role: "user", ativo: true }];
  const squads = seisSquads({ 1: ["Carpei"] });
  squads[0].papeis.gestor = "Gestor";
  const r = M.mapear(cenario({ clientes: [cliente(1, "Carpei", "carpei")], usuarios, squads }));
  ok("responsaveis fica VAZIO", r.planoP29.responsaveis.length === 0);
  ok("e o porquê está escrito no plano", /não está documentada/i.test(r.planoP29._avisoResponsaveis));
}

function testarTodoClienteEmExatamenteUmSquad() {
  console.log("\n7b · integridade final do mapa");
  const c = cenario({
    clientes: [cliente(1, "Carpei", "carpei"), cliente(2, "Alma", "alma"), cliente(3, "Alma 2", "alma_2"),
      cliente(4, "Orfao", "orfao")],
    squads: seisSquads({ 1: ["Carpei"], 5: ["Alma"] }),
  });
  const r = M.mapear(c);
  ok("todo cliente real aparece no mapa", r.mapaClientes.length === 4);
  ok("nenhum aparece duas vezes", new Set(r.mapaClientes.map((m) => m.clienteId)).size === 4);
  ok("I6 exatamente 1 Squad por cliente ativo", r.invariantes.find((i) => i.id === "I6").passou);
  ok("I7 cliente da relação → Squad 1–6", r.invariantes.find((i) => i.id === "I7").passou);
  ok("I8 cliente fora da relação → Squad 8", r.invariantes.find((i) => i.id === "I8").passou);
  ok("I17 todo id do mapa existe no banco", r.invariantes.find((i) => i.id === "I17").passou);
  ok("nenhuma invariante falha", r.invariantes.every((i) => i.passou));
}

function testarConflitoDeRelacaoNaoEhSilencioso() {
  console.log("\n7c · o mesmo cliente em dois Squads da relação é detectado");
  const c = cenario({
    clientes: [cliente(1, "Carpei", "carpei")],
    squads: seisSquads({ 1: ["Carpei"], 2: ["Carpei"] }),
  });
  const r = M.mapear(c);
  ok("o conflito é registrado", r.conflitos.length === 1);
  ok("o cliente não fica em dois Squads", r.mapaClientes.filter((m) => m.clienteId === 1).length === 1);
  ok("I6 reprova por causa do conflito", r.invariantes.find((i) => i.id === "I6").passou === false);
}

function testarModuloEhOffline() {
  console.log("\n7d · o módulo é 100% offline");
  const fonte = require("fs").readFileSync(require("path").join(__dirname, "..", "sql", "squads-mapeamento-real.js"), "utf8");
  ok("não importa `pg`", !/require\(["']pg["']\)/.test(fonte));
  ok("não importa o pool de banco", !/config\/database/.test(fonte));
  ok("não carrega dotenv", !/dotenv/.test(fonte));
  ok("não lê DATABASE_URL", !/DATABASE_URL/.test(fonte));
  ok("não emite SQL de escrita",
    !/\b(INSERT|UPDATE|DELETE|CREATE TABLE|ALTER TABLE|DROP TABLE)\b/i.test(fonte));
}


/* ═══════════════ 8. decisões humanas aprovadas ═══════════════
 *
 * A relação operacional é uma planilha de PRIMEIROS NOMES, e um nome não é uma
 * identidade: "Fernando" são duas pessoas; "Victor" não é o "Vitor" que existe
 * no banco. Esta camada aceita a decisão humana como FONTE (o QUE se quer) e
 * continua exigindo do banco a CORRESPONDÊNCIA (a QUEM isso corresponde). Ela
 * só pode RESTRINGIR: decisão nenhuma cria usuário, inventa id ou afrouxa uma
 * ambiguidade — quando o email confirmado não resolve exatamente um usuário
 * ativo, a membership é BLOQUEADA. */

const DEC_USUARIOS = [
  { id: 5, nome: "Fernando Salgado", email: "fernando.salgado@x.com", role: "admin", ativo: true },
  { id: 45, nome: "Fernando Montoro", email: "fernando.montoro@x.com", role: "membro", ativo: true },
  { id: 6, nome: "Vitor Capeli", email: "vitor.capeli@x.com", role: "admin", ativo: true },
  { id: 24, nome: "Micael Almeida", email: "micael.almeida@x.com", role: "user", ativo: true },
];

function testarIdentidadePorEmailConfirmado() {
  console.log("\n8 · identidade resolve pelo email confirmado, nunca pelo primeiro nome");
  const squads = seisSquads();
  squads[3].papeis.coordenador = "Fernando";
  const decisoes = {
    versao: 1,
    identidades: [{ nome: "Fernando", email: "fernando.salgado@x.com", pessoa: "Fernando Salgado" }],
  };
  const r = M.mapear({ ...cenario({ usuarios: DEC_USUARIOS, squads }), decisoes });
  const f = r.identidades.find((i) => i.nomeRelacao === "Fernando");
  ok("resolve para o usuário do email confirmado", f.userId === 5);
  ok("a classe registra que quem decidiu foi o humano", f.classe === "DECISAO_HUMANA_EMAIL");
  ok("o email da decisão fica como evidência", f.emailDecisao === "fernando.salgado@x.com");
  ok("sem ambiguidade herdada do matcher por nome", r.bloqueios.every((b) => b.tipo !== "USUARIO_AMBIGUO"));
}

function testarEmailQueNaoResolveBloqueiaAMembership() {
  console.log("\n8b · email confirmado que não resolve exatamente 1 usuário BLOQUEIA");
  const squads = seisSquads();
  squads[3].papeis.coordenador = "Fernando";
  const decisoes = {
    versao: 1,
    identidades: [{ nome: "Fernando", email: "fernando.fantasma@x.com", pessoa: "Fernando Fantasma" }],
  };
  const r = M.mapear({ ...cenario({ usuarios: DEC_USUARIOS, squads }), decisoes });
  const f = r.identidades.find((i) => i.nomeRelacao === "Fernando");
  ok("nenhum usuário é resolvido", f.userId === null);
  ok("a classe diz por quê", f.classe === "DECISAO_EMAIL_NAO_RESOLVE");
  ok("há bloqueio explícito com o email", r.bloqueios.some((b) => b.tipo === "EMAIL_DECISAO_NAO_RESOLVE" && b.email === "fernando.fantasma@x.com"));
  ok("nenhuma membership é emitida para o assento", r.planoP29.membros.length === 0);
  ok("e o modo estrito recusa emitir", r.emitivel === false);
}

function testarEmailNaoRessuscitaUsuarioInativo() {
  console.log("\n8c · decisão humana não alcança usuário inativo");
  const squads = seisSquads();
  squads[3].papeis.coordenador = "Fernando";
  const usuarios = [{ id: 5, nome: "Fernando Salgado", email: "fernando.salgado@x.com", role: "admin", ativo: false }];
  const decisoes = { versao: 1, identidades: [{ nome: "Fernando", email: "fernando.salgado@x.com" }] };
  const r = M.mapear({ ...cenario({ usuarios, squads }), decisoes });
  const f = r.identidades.find((i) => i.nomeRelacao === "Fernando");
  ok("o usuário inativo não é resolvido", f.userId === null);
  ok("fica bloqueado, não silencioso", r.bloqueios.some((b) => b.tipo === "EMAIL_DECISAO_NAO_RESOLVE"));
}

function testarSplitDeAssentoSeparaHomonimos() {
  console.log("\n8d · o mesmo nome em dois assentos são duas pessoas");
  const squads = seisSquads();
  squads[0].papeis.auxiliar2 = "Fernando";
  squads[3].papeis.coordenador = "Fernando";
  const decisoes = {
    versao: 1,
    identidades: [
      { nome: "Fernando", assentos: [{ squad: "squad-1", papel: "auxiliar2" }], email: "fernando.montoro@x.com", pessoa: "Fernando Montoro" },
      { nome: "Fernando", assentos: [{ squad: "squad-4", papel: "coordenador" }], email: "fernando.salgado@x.com", pessoa: "Fernando Salgado" },
    ],
  };
  const r = M.mapear({ ...cenario({ usuarios: DEC_USUARIOS, squads }), decisoes });
  const montoro = r.planoP29.membros.find((m) => m.squad === "squad-1");
  const salgado = r.planoP29.membros.find((m) => m.squad === "squad-4");
  ok("o assento do Squad 1 é do Montoro", montoro.usuario === "fernando.montoro@x.com");
  ok("o assento do Squad 4 é do Salgado", salgado.usuario === "fernando.salgado@x.com");
  ok("nenhum dos dois vira multi-Squad", r.identidades.filter((i) => i.nomeRelacao === "Fernando").every((i) => i.multiSquad === false));
  ok("cada um é principal do seu único Squad", montoro.principal === true && salgado.principal === true);
  ok("nenhum bloqueio de principal pendente", r.bloqueios.every((b) => b.tipo !== "SQUAD_PRINCIPAL_PENDENTE"));
}

function testarUsuarioNaoCriadoEhExcluidoSemBloquear() {
  console.log("\n8e · usuário ainda não criado sai do APPLY sem bloquear os demais");
  const squads = seisSquads();
  squads[5].papeis.auxiliar = "Victor";
  squads[3].papeis.coordenador = "Fernando";
  const decisoes = {
    versao: 1,
    identidades: [{ nome: "Fernando", email: "fernando.salgado@x.com" }],
    usuariosNaoCriados: [{ nome: "Victor", assentos: [{ squad: "squad-6", papel: "auxiliar" }] }],
  };
  const r = M.mapear({ ...cenario({ usuarios: DEC_USUARIOS, squads }), decisoes });
  const v = r.identidades.find((i) => i.nomeRelacao === "Victor");
  ok("Victor NÃO casa com o Vitor admin que existe no banco", v.userId === null);
  ok("é marcado como excluído por decisão humana", v.classe === "EXCLUIDO_USUARIO_NAO_CRIADO");
  ok("nenhuma membership é emitida para ele", r.planoP29.membros.every((m) => m.squad !== "squad-6"));
  ok("a exclusão não vira bloqueio", r.bloqueios.length === 0);
  ok("e as demais memberships seguem emitíveis", r.emitivel === true && r.planoP29.membros.length === 1);
  ok("a composição humana continua registrada", v.assentosPrevistos.length === 1 && v.assentosPrevistos[0].squad === "squad-6");
}

function testarSquadPrincipalDecididoPeloHumano() {
  console.log("\n8f · Squad principal decidido pelo humano fecha o bloqueio");
  const squads = seisSquads();
  squads[0].papeis.coordenador = "Micael";
  squads[4].papeis.coordenador = "Micael";
  const decisoes = { versao: 1, squadPrincipal: [{ nome: "Micael", squad: "squad-1" }] };
  const r = M.mapear({ ...cenario({ usuarios: DEC_USUARIOS, squads }), decisoes });
  const doMicael = r.planoP29.membros.filter((m) => m.usuario === "micael.almeida@x.com");
  ok("as duas memberships continuam no plano", doMicael.length === 2);
  ok("exatamente uma é principal", doMicael.filter((m) => m.principal === true).length === 1);
  ok("e é a decidida pelo humano", doMicael.find((m) => m.principal === true).squad === "squad-1");
  ok("nenhuma fica marcada como pendente", doMicael.every((m) => m._principalPendente !== true));
  ok("o bloqueio de principal desaparece", r.bloqueios.every((b) => b.tipo !== "SQUAD_PRINCIPAL_PENDENTE"));
  ok("o modo estrito volta a emitir", r.emitivel === true);
}

function testarPrincipalForaDosSquadsDaPessoaEhRecusado() {
  console.log("\n8g · principal em Squad que a pessoa não ocupa é recusado");
  const squads = seisSquads();
  squads[0].papeis.coordenador = "Micael";
  squads[4].papeis.coordenador = "Micael";
  const decisoes = { versao: 1, squadPrincipal: [{ nome: "Micael", squad: "squad-3" }] };
  const r = M.mapear({ ...cenario({ usuarios: DEC_USUARIOS, squads }), decisoes });
  ok("o principal inválido é bloqueado", r.bloqueios.some((b) => b.tipo === "SQUAD_PRINCIPAL_INVALIDO" && b.squad === "squad-3"));
  ok("nenhuma membership é promovida a principal", r.planoP29.membros.every((m) => m.principal !== true));
  ok("o modo estrito recusa emitir", r.emitivel === false);
}

function testarDecisaoNuncaCriaUsuario() {
  console.log("\n8h · nenhuma decisão cria usuário ou inventa identidade");
  const squads = seisSquads();
  squads[5].papeis.auxiliar = "Victor";
  const decisoes = {
    versao: 1,
    usuariosNaoCriados: [{ nome: "Victor", assentos: [{ squad: "squad-6", papel: "auxiliar" }] }],
  };
  const r = M.mapear({ ...cenario({ usuarios: DEC_USUARIOS, squads }), decisoes });
  const emailsDoBanco = new Set(DEC_USUARIOS.map((u) => u.email));
  ok("toda membership aponta para email que existe no banco",
    r.planoP29.membros.every((m) => emailsDoBanco.has(m.usuario)));
  ok("o plano não contém nenhuma operação sobre usuários",
    !/criar_usuario/i.test(JSON.stringify(r.planoP29)));
}

function testarSemDecisoesOComportamentoAntigoEhIntacto() {
  console.log("\n8i · sem decisões, o comportamento anterior é bit a bit o mesmo");
  const squads = seisSquads();
  squads[0].papeis.coordenador = "Micael";
  squads[4].papeis.coordenador = "Micael";
  const c = cenario({ usuarios: DEC_USUARIOS, squads });
  const antes = M.mapear(c);
  const depois = M.mapear({ ...c, decisoes: null });
  ok("o resultado é idêntico com e sem o parâmetro",
    JSON.stringify(antes.identidades) === JSON.stringify(depois.identidades) &&
    JSON.stringify(antes.bloqueios) === JSON.stringify(depois.bloqueios));
  ok("e o principal continua PENDENTE quando ninguém decidiu",
    antes.bloqueios.some((b) => b.tipo === "SQUAD_PRINCIPAL_PENDENTE"));
}

function testarCliAceitaArquivoDeDecisoes() {
  console.log("\n8j · a CLI recebe as decisões como ARQUIVO, não como código");
  const a = M.parseArgs(["node", "x.js", "--inventario", "i.json", "--auditoria", "a.json",
    "--relacao", "r.json", "--decisoes", "d.json", "--saida-dir", "out"]);
  ok("o caminho das decisões é lido do argumento", a.decisoes === "d.json");
  ok("sem o argumento, decisões ficam nulas",
    M.parseArgs(["node", "x.js", "--relacao", "r.json"]).decisoes === null);
}

function testarDecisaoQueNaoPousaNaoDesapareceEmSilencio() {
  console.log("\n8k · decisão que não encontra assento é denunciada, não ignorada");
  const squads = seisSquads();
  squads[3].papeis.coordenador = "Fernando";
  const decisoes = {
    versao: 1,
    identidades: [
      { nome: "Fernando", assentos: [{ squad: "squad-4", papel: "coordenador" }], email: "fernando.salgado@x.com" },
      { nome: "Fernando", assentos: [{ squad: "squad-2", papel: "gestor" }], email: "fernando.montoro@x.com" },
    ],
    usuariosNaoCriados: [{ nome: "Ninguem", assentos: [{ squad: "squad-5", papel: "design" }] }],
    squadPrincipal: [{ nome: "Fantasma", squad: "squad-1" }],
  };
  const r = M.mapear({ ...cenario({ usuarios: DEC_USUARIOS, squads }), decisoes });
  ok("a decisão de identidade sem assento correspondente é reportada",
    r.bloqueios.some((b) => b.tipo === "DECISAO_SEM_ASSENTO" && b.email === "fernando.montoro@x.com"));
  ok("a exclusão sem assento correspondente também é reportada",
    r.bloqueios.some((b) => b.tipo === "DECISAO_SEM_ASSENTO" && b.nome === "Ninguem"));
  ok("o principal de quem não está na relação também é reportado",
    r.bloqueios.some((b) => b.tipo === "DECISAO_SEM_ASSENTO" && b.nome === "Fantasma"));
  ok("e o modo estrito recusa emitir", r.emitivel === false);
  ok("a decisão que POUSA continua valendo",
    r.planoP29.membros.length === 1 && r.planoP29.membros[0].usuario === "fernando.salgado@x.com");
}

function testarPlanoCarregaORecusoQuandoHaBloqueio() {
  console.log("\n8l · o plano emitido diz, nele mesmo, que não está liberado");
  const squads = seisSquads();
  squads[1].papeis.coordenador = "Klayvert";
  const usuarios = [
    { id: 22, nome: "Klayvert Rodrigues", email: "klayvert@a.com", role: "user", ativo: true },
    { id: 35, nome: "Klayvert Rodrigues", email: "klayvert@b.com", role: "user", ativo: true },
  ];
  const r = M.mapear(cenario({ usuarios, squads }));
  ok("o plano registra que NÃO é emitível", r.planoP29._emitivel === false);
  ok("e carrega os bloqueios que o impedem",
    Array.isArray(r.planoP29._bloqueios) && r.planoP29._bloqueios.length === r.bloqueios.length);

  const limpo = M.mapear(cenario({ usuarios: [usuarios[0]], squads }));
  ok("sem bloqueio, o plano se declara emitível", limpo.planoP29._emitivel === true);
  ok("e a lista de bloqueios fica vazia", limpo.planoP29._bloqueios.length === 0);
}

(async () => {
  testarNormalizacao();
  testarClusterSufixoAutovalidado();
  testarClusterChaveNatural();
  testarGrantCruzadoNaoMergeia();
  testarCanonicoNaoEhMenorId();
  testarNomeCurtoAmbiguo();
  testarClienteInexistenteNaoEhCriado();
  testarCamadasNaoSePassamPorExatas();
  testarSquad8();
  testarAliasHerdaSquadDoCanonico();
  testarGrantsPreservados();
  testarContaDuplicadaNaoDuplica();
  testarGrantSemContaEhBloqueante();
  testarPlanoNuncaCriaNemDeleta();
  testarIdentidadeExataAntesDeAproximada();
  testarIdentidadePorExclusao();
  testarAproximadoEmAdminNaoEhAceito();
  testarMultiSquadNaoDecideSozinho();
  testarCoordenadorNaoEhGestor();
  testarResponsabilidadesNaoSaoInventadas();
  testarTodoClienteEmExatamenteUmSquad();
  testarConflitoDeRelacaoNaoEhSilencioso();
  testarModuloEhOffline();
  testarIdentidadePorEmailConfirmado();
  testarEmailQueNaoResolveBloqueiaAMembership();
  testarEmailNaoRessuscitaUsuarioInativo();
  testarSplitDeAssentoSeparaHomonimos();
  testarUsuarioNaoCriadoEhExcluidoSemBloquear();
  testarSquadPrincipalDecididoPeloHumano();
  testarPrincipalForaDosSquadsDaPessoaEhRecusado();
  testarDecisaoNuncaCriaUsuario();
  testarSemDecisoesOComportamentoAntigoEhIntacto();
  testarCliAceitaArquivoDeDecisoes();
  testarDecisaoQueNaoPousaNaoDesapareceEmSilencio();
  testarPlanoCarregaORecusoQuandoHaBloqueio();
  console.log(`\n✔ squadsMapeamentoReal: ${checks} verificações OK\n`);
})().catch((e) => { console.error(e); process.exit(1); });
