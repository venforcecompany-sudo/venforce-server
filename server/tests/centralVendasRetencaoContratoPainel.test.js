// server/tests/centralVendasRetencaoContratoPainel.test.js
//
// CONTRATO que sustenta a retenção sem lock com escritores de referência JSON:
// "uma referência JSON (snapshot do Painel / Cliente 360) a um import NUNCA é
// desreferenciada". O Painel de Contas:
//   1. só usa o snapshot (cliente_360_resumos_mensais) quando
//      snapshot.centralImportIds == ids dos imports vigentes selecionados AO
//      VIVO (painelContasOperacional.consolidarCliente → mesmoConjunto);
//   2. lê pedidos / composição SEMPRE pelos ids de importPorConta da seleção
//      ao vivo (painelContasService.escolherImportPorConta), nunca pelos ids
//      gravados no snapshot.
// Logo, um snapshot citando um import dominado que a retenção já apagou é
// ignorado e nada é lido dele. Usa o modelo em memória dos testes do Painel
// (helpers/painelContasModeloMemoria.js), sem Postgres.

process.env.DATABASE_URL = "postgres://nobody@127.0.0.1:1/teste-sem-banco";
process.env.PAINEL_CONTAS_AUTO_UPDATE_ENABLED = "true";
process.env.SQUADS_ENFORCEMENT = "on";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const pool = require("../config/database");
const { importRow, novoModelo, instalarMock } = require("./helpers/painelContasModeloMemoria");
const service = require("../services/painelContas/painelContasService");

let checks = 0;
function ok(label) {
  checks += 1;
  console.log(`  ok  ${label}`);
}

const ANA = { id: 100, role: "membro" }; // coordena o Squad 6 (AMR)
const SET = "2026-09";
const VIGENTES_AMR = [1101, 1201, 1301];
const DOMINADO = 1100; // published antigo da conta 11, coberto pelo 1101

function snapshotAmr(importIds, fat) {
  return {
    cliente_id: 1, competencia: SET, faturamento: fat, mc_media: 0.15, ads_investido: null,
    sincronizado_em: "2026-09-30T00:00:00.000Z",
    payload_json: {
      fonte: "central_vendas",
      centralVendas: {
        lucroContribuicao: 1, mcFonte: "central",
        contas: importIds.map((importId, i) => ({ clienteContaId: [11, 12, 13][i], importId })),
      },
    },
  };
}

async function run() {
  const m = novoModelo();
  const { restaurar } = instalarMock(m);
  // Intercepta as leituras de PEDIDOS: registra QUAIS import ids foram lidos.
  const lidos = [];
  const queryModelo = pool.query;
  pool.query = async (sql, params) => {
    const q = String(sql);
    for (const tag of ["PEDIDOS_DOS_IMPORTS", "COMPOSICAO_DOS_IMPORTS", "COMPOSICAO_SOBREPOSICAO"]) {
      if (q.includes(`painelContas:${tag}`)) {
        lidos.push(...params[0].map(Number));
        return { rows: tag === "COMPOSICAO_SOBREPOSICAO" ? [{ pedidos: 0, valor: 0 }] : [] };
      }
    }
    return queryModelo(sql, params);
  };
  try {
    const fatAoVivo = 2833602 + 800000 + 420512;
    const amr = async () => (await service.listar(ANA, { competencia: SET })).clientes.find((c) => c.slug === "amr-ecommerce");

    // 1. snapshot cita EXATAMENTE os vigentes ⇒ é usado (controle positivo)
    m.resumos.push(snapshotAmr(VIGENTES_AMR, 111));
    let c = await amr();
    assert.strictEqual(c.origem, "snapshot");
    assert.strictEqual(c.resumo.fat, 111);
    ok("snapshot citando exatamente os vigentes ao vivo é usado (controle positivo)");

    // 2. snapshot cita um import DOMINADO já apagado pela retenção ⇒ ignorado
    m.resumos = m.resumos.filter((r) => !(r.cliente_id === 1 && r.competencia === SET));
    m.resumos.push(snapshotAmr([DOMINADO, 1201, 1301], 999));
    c = await amr();
    assert.notStrictEqual(c.origem, "snapshot");
    assert.strictEqual(c.resumo.fat, fatAoVivo, "FAT vem dos imports vigentes ao vivo");
    ok("snapshot citando import dominado já apagado é ignorado; o FAT vem da seleção ao vivo");

    // 3. o dominado ainda NÃO apagado (antes da retenção): a seleção ao vivo
    //    continua escolhendo o vigente — o snapshot velho também é ignorado
    m.imports.push(importRow(DOMINADO, 11, SET, { fat: 5, lc: 1, ate: `${SET}-20`, publicado: `${SET}-21T06:00:00.000Z` }));
    c = await amr();
    assert.notStrictEqual(c.origem, "snapshot");
    assert.strictEqual(c.contas.find((x) => x.id === 11).resumo.fat, 2833602);
    ok("com o dominado ainda presente, a seleção ao vivo escolhe o vigente e o snapshot velho segue ignorado");

    // 4. pedidos e composição: SEMPRE os ids da seleção ao vivo, nunca os do snapshot
    lidos.length = 0;
    await service.listarSemanasDasContas(ANA, "1", SET);
    assert.deepStrictEqual([...new Set(lidos)].sort((a, b) => a - b), VIGENTES_AMR);
    lidos.length = 0;
    await service.listarComposicaoDasContas(ANA, "1", SET);
    assert.deepStrictEqual([...new Set(lidos)].sort((a, b) => a - b), VIGENTES_AMR);
    m.imports = m.imports.filter((i) => i.id !== DOMINADO); // retenção apagou
    lidos.length = 0;
    await service.listarSemanasDasContas(ANA, "1", SET);
    await service.listarComposicaoDasContas(ANA, "1", SET);
    assert.ok(!lidos.includes(DOMINADO));
    assert.deepStrictEqual([...new Set(lidos)].sort((a, b) => a - b), VIGENTES_AMR);
    ok("semanas e composição leem pedidos só dos imports da seleção ao vivo; o id do snapshot nunca é lido");

    // 5. guarda estática: centralImportIds só é LIDO do JSON (repository) e
    //    COMPARADO (mesmoConjunto). Um uso novo (ex.: carregar pedidos por ele)
    //    quebra este contrato e precisa revisar a retenção.
    const raiz = path.join(__dirname, "..", "services", "painelContas");
    const usos = [];
    for (const arq of fs.readdirSync(raiz).filter((f) => f.endsWith(".js"))) {
      fs.readFileSync(path.join(raiz, arq), "utf8").split("\n").forEach((linha, i) => {
        if (linha.includes("centralImportIds")) usos.push(`${arq}:${i + 1}: ${linha.trim()}`);
      });
    }
    assert.strictEqual(usos.length, 2, `usos de centralImportIds mudaram:\n${usos.join("\n")}`);
    assert.ok(usos.some((u) => u.startsWith("painelContasRepository.js") && u.includes("centralImportIds: Array.isArray(central.contas)")));
    assert.ok(usos.some((u) => u.startsWith("painelContasOperacional.js") && u.includes("mesmoConjunto(snapshot.centralImportIds")));
    ok("centralImportIds só é extraído do JSON e comparado com mesmoConjunto (nenhum outro uso)");
  } finally {
    pool.query = queryModelo;
    restaurar();
  }
  console.log(`\n✓ centralVendasRetencaoContratoPainel: ${checks} checks`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
