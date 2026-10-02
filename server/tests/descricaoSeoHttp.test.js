// server/tests/descricaoSeoHttp.test.js
//
// Description Engine (SEO · F5) na camada HTTP:
//   POST /anuncios-meli/:itemId/seo/descricao
//
// Router REAL num Express local, HTTP de verdade. Real: authMiddleware (JWT),
// requireAutomacoesAccess, guard de carteira, requireAdmin, controller,
// meliAnunciosService.resolverContaDoAnuncio (F1), descricaoEngine,
// fatosProduto, seoText. Simulado: decisão de carteira, banco, mlFetch e a IA
// (nunca a Anthropic real).
//
// O que este teste protege:
//   - conta A + item A permitido; conta B + item A recusado; ambiguidade
//     falha fechado; fora da carteira = 403 — tudo ANTES de ler o ML ou a IA;
//   - a descrição atual é lida ao vivo do ML com o usuário ML da conta do
//     anúncio e chega ao prompt; "sem descrição" ≠ "erro de leitura";
//   - o limite vem de settings.max_description_length (cache de categoria);
//   - erros da IA chegam no contrato { ok:false, codigo, motivo };
//   - o ML só recebe GET (descrição e categoria); o banco não recebe escrita.

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/vf-test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "venforce_secret_local";

const assert = require("assert");
const Module = require("module");
const express = require("express");
const jwt = require("jsonwebtoken");

const CLIENTE_A = { id: 1, nome: "Cliente A", slug: "cliente-a", ativo: true };
const CLIENTE_B = { id: 2, nome: "Cliente B", slug: "cliente-b", ativo: true };
const CLIENTES = [CLIENTE_A, CLIENTE_B];

const USERS = {
  1: { id: 1, nome: "Admin", role: "admin", ativo: true },
  2: { id: 2, nome: "Operador", role: "user", ativo: true },
  99: { id: 99, nome: "Fora da carteira", role: "user", ativo: true },
};
const CARTEIRA = { 1: [1, 2], 2: [1, 2], 99: [] };

const DESC_ATUAL = "Tênis confortável para o dia a dia escolar. Solado de borracha antiderrapante com 2 cm de altura.";
const BOA = "Tênis infantil Molekinho para meninos, pensado para o dia a dia escolar.\n\n" +
  "O fechamento é por cadarço e o material principal é sintético. O solado de borracha tem 2 cm de altura.";

// ── stubs ───────────────────────────────────────────────────────────────────
let mlChamadas = [];
let descricaoResposta = null; // () => resposta do mlFetch para /items/{id}/description
let categoriaResposta = null; // () => resposta do mlFetch para /categories/{id}
let iaChamadas = [];
let iaResposta = null;        // (opts) => resposta de aiProvider.gerarJSON

const originalLoad = Module._load;
Module._load = function loadComStubs(request, parent, isMain) {
  if (request === "../../utils/mlClient" || request === "../utils/mlClient") {
    return {
      async mlFetch(clienteId, path, options = {}) {
        mlChamadas.push({ clienteId, path, mlUserId: options.mlUserId, metodo: options.method || "GET" });
        if (/^\/items\/[^/]+\/description$/.test(path) && descricaoResposta) return descricaoResposta(path);
        if (/^\/categories\//.test(path) && categoriaResposta) return categoriaResposta(path);
        return { ok: false, status: 500, data: null };
      },
    };
  }
  if (request === "../services/ai/aiProvider" || request === "../ai/aiProvider") {
    return {
      async gerarJSON(opts) { iaChamadas.push(opts); return iaResposta(opts); },
    };
  }
  if (request === "../services/squads/authorizationService") {
    const real = originalLoad.call(this, request, parent, isMain);
    return {
      ...real,
      async assertClienteNaCarteira(user, ref) {
        const cliente = CLIENTES.find((c) => c.slug === String(ref) || String(c.id) === String(ref));
        if (!cliente || !(CARTEIRA[user.id] || []).includes(cliente.id)) {
          const err = new Error("Cliente fora da sua carteira.");
          err.statusCode = 403;
          err.code = "CLIENTE_FORA_DA_CARTEIRA";
          throw err;
        }
        return cliente;
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const pool = require("../config/database");
const router = require("../routes/meliAnunciosRoutes");
Module._load = originalLoad;

// ── banco simulado ──────────────────────────────────────────────────────────
function grant(id, cliente_id, ml_user_id) {
  return {
    id, cliente_id, ml_user_id, access_token: "tok", refresh_token: "ref",
    expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    token_status: "valid", is_primary: false, refresh_failures: 0, updated_at: new Date().toISOString(),
  };
}
const CONTA_10 = { id: 10, cliente_id: 1, marketplace: "meli", nome: "ML 1", external_account_id: "111", is_primary: true, ativo: true };
const CONTA_11 = { id: 11, cliente_id: 1, marketplace: "meli", nome: "ML 2", external_account_id: "222", is_primary: false, ativo: true };
const CONTA_20 = { id: 20, cliente_id: 2, marketplace: "meli", nome: "ML B", external_account_id: "333", is_primary: true, ativo: true };

let estado = null;
const escritasBanco = [];

pool.query = async (sql, params = []) => {
  const q = String(sql).replace(/\s+/g, " ").trim();
  if (q.startsWith("SELECT * FROM users WHERE id = $1")) return { rows: USERS[params[0]] ? [USERS[params[0]]] : [] };
  if (q.includes("FROM clientes WHERE LOWER(slug) = $1")) {
    const c = CLIENTES.find((x) => x.slug === params[0]);
    return { rows: c ? [c] : [] };
  }
  if (q.includes("FROM clientes WHERE id = $1")) {
    const c = CLIENTES.find((x) => x.id === Number(params[0]));
    return { rows: c ? [c] : [] };
  }
  if (q.startsWith("SELECT * FROM cliente_contas WHERE id = $1")) {
    const c = estado.contas.find((x) => x.id === Number(params[0]));
    return { rows: c ? [c] : [] };
  }
  if (q.includes("FROM cliente_contas WHERE cliente_id = $1 AND marketplace = $2 AND ativo = true ORDER BY is_primary")) {
    return { rows: estado.contas.filter((c) => c.cliente_id === params[0] && c.marketplace === params[1] && c.ativo !== false) };
  }
  if (q.includes("COUNT(*)::int AS total FROM cliente_contas")) {
    return { rows: [{ total: estado.contas.filter((c) => c.cliente_id === params[0] && c.marketplace === "meli" && c.ativo !== false).length }] };
  }
  if (q.includes("t.cliente_id = $1 AND t.ml_user_id = $2")) {
    const g = estado.grants.find((x) => x.cliente_id === params[0] && String(x.ml_user_id) === String(params[1]));
    return { rows: g ? [g] : [] };
  }
  if (q.includes("FROM ml_tokens t") && q.includes("WHERE t.cliente_id = $1")) {
    return { rows: estado.grants.filter((g) => g.cliente_id === params[0]) };
  }
  if (q.includes("base_cliente_vinculos")) return { rows: [] };
  if (q.startsWith("CREATE TABLE") || q.startsWith("ALTER TABLE") || q.startsWith("CREATE INDEX")) return { rows: [] };
  if (q.startsWith("SELECT * FROM meli_anuncios WHERE cliente_id = $1 AND item_id = $2")) {
    const a = estado.anuncios.find((x) => x.cliente_id === params[0] && x.item_id === String(params[1]));
    return { rows: a ? [a] : [] };
  }
  if (/^(INSERT|UPDATE|DELETE)/.test(q)) escritasBanco.push(q.slice(0, 60));
  return { rows: [] };
};
pool.connect = async () => ({ query: pool.query, release() {} });

function anuncio(over = {}) {
  return {
    id: 7, cliente_id: 1, cliente_slug: "cliente-a", item_id: "MLB-A",
    titulo: "Tênis Infantil Molekinho Cadarço",
    marca: "Molekinho", modelo: "tenis casual", category_id: "MLB-CAT",
    catalog_listing: false, catalog_product_id: null, family_name: null, user_product_id: "MLBU1",
    attributes_json: [
      { id: "BRAND", name: "Marca", value: "Molekinho" },
      { id: "GENDER", name: "Gênero", value: "Meninos" },
      { id: "CLOSURE_TYPE", name: "Tipo de fechamento", value: "Cadarço" },
      { id: "MAIN_MATERIAL", name: "Material principal", value: "Sintético" },
      { id: "IS_WATERPROOF", name: "É impermeável", value: "Não" },
      { id: "SELLER_SKU", name: "SKU", value: "MK-1" },
    ],
    cliente_conta_id: 10, ml_user_id: "111",
    ...over,
  };
}

let categoriaSeq = 0;
// descricao: "ok" | "sem" | "erro"; categoria: "ok" | "erro" | número (max_description_length)
function reset({ contas = [CONTA_10, CONTA_11, CONTA_20], anuncios = [anuncio()], descricao = "ok", categoria = "ok" } = {}) {
  estado = {
    contas,
    grants: [grant(100, 1, "111"), grant(101, 1, "222"), grant(102, 2, "333")],
    anuncios,
  };
  mlChamadas = [];
  iaChamadas = [];
  escritasBanco.length = 0;
  // category_id único por cenário: o cache de categoria do controller é por processo.
  categoriaSeq += 1;
  estado.anuncios.forEach((a) => { if (a.category_id === "MLB-CAT") a.category_id = "MLB-CAT-" + categoriaSeq; });
  descricaoResposta = () => {
    if (descricao === "sem") return { ok: false, status: 404, data: { message: "not found" } };
    if (descricao === "erro") return { ok: false, status: 503, data: null };
    return { ok: true, status: 200, data: { plain_text: DESC_ATUAL } };
  };
  categoriaResposta = () => {
    if (categoria === "erro") return { ok: false, status: 500, data: { message: "boom" } };
    const maxDesc = typeof categoria === "number" ? categoria : 50000;
    return { ok: true, status: 200, data: { id: "X", name: "Tênis", settings: { max_title_length: 60, max_description_length: maxDesc } } };
  };
  iaResposta = () => ({ ok: true, provider: "anthropic", model: "stub", data: { descricao: BOA, fatosUsados: ["brand", "attr:CLOSURE_TYPE"] } });
}

// ── servidor ────────────────────────────────────────────────────────────────
let base = "";
const token = (id) => `Bearer ${jwt.sign({ id }, process.env.JWT_SECRET)}`;
async function chamar(itemId, body, { auth = token(1) } = {}) {
  const resp = await fetch(`${base}/anuncios-meli/${itemId}/seo/descricao`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth },
    body: JSON.stringify(body),
  });
  let corpo = null;
  try { corpo = await resp.json(); } catch (_) { corpo = null; }
  return { status: resp.status, corpo };
}
const CORPO = { clienteSlug: "cliente-a", clienteContaId: 10 };
const caminhos = () => mlChamadas.map((c) => [c.metodo, c.path.replace(/MLB-CAT-\d+/, "C"), c.mlUserId]).sort();
const todasChamadasMl = [];
const todasEscritas = [];

let checks = 0;
function ok(msg) { checks += 1; console.log(`  ✓ ${msg}`); }

async function run() {
  const app = express();
  app.use(express.json());
  app.use("/anuncios-meli", router);
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  const guardar = () => { todasChamadasMl.push(...mlChamadas); todasEscritas.push(...escritasBanco); };

  try {
    console.log("POST /anuncios-meli/:itemId/seo/descricao");

    {
      reset();
      const r = await chamar("MLB-A", CORPO);
      assert.strictEqual(r.status, 200, JSON.stringify(r.corpo));
      assert.deepStrictEqual(Object.keys(r.corpo).sort(), ["chars", "descricao", "fatosUsados", "limite", "ok"], "sem score");
      assert.strictEqual(r.corpo.ok, true);
      assert.strictEqual(r.corpo.descricao, BOA);
      assert.strictEqual(r.corpo.limite, 2500, "50.000 da categoria → teto operacional");
      assert.deepStrictEqual(r.corpo.fatosUsados, [
        { id: "brand", label: "Marca", value: "Molekinho" },
        { id: "attr:CLOSURE_TYPE", label: "Tipo de fechamento", value: "Cadarço" },
      ]);
      assert.deepStrictEqual(caminhos(), [["GET", "/categories/C", "111"], ["GET", "/items/MLB-A/description", "111"]],
        "só lê descrição e categoria, com o usuário ML da conta do anúncio");
      assert.strictEqual(iaChamadas.length, 1);
      const prompt = iaChamadas[0].prompt;
      assert.ok(prompt.includes(DESC_ATUAL), "descrição atual lida do ML chega ao prompt");
      assert.ok(prompt.includes("[brand] Marca: Molekinho") && prompt.includes("[categoria] Categoria do Mercado Livre (só para entender o produto; não vira item nem frase): Tênis"));
      assert.ok(prompt.includes("nunca escreva: impermeável") && !prompt.includes("MK-1"));
      assert.deepStrictEqual(escritasBanco, [], "a rota não persiste nada");
      guardar();
      ok("conta A + item A → 200 { ok, descricao, chars, limite, fatosUsados }; descrição atual do ML no prompt; só GETs; nada escrito");
    }
    {
      reset();
      const r = await chamar("MLB-A", { ...CORPO, clienteContaId: 11 });
      assert.strictEqual(r.status, 409);
      assert.strictEqual(r.corpo.codigo, "ANUNCIO_DE_OUTRA_CONTA");
      assert.deepStrictEqual([mlChamadas.length, iaChamadas.length], [0, 0]);
      ok("conta B + item A → 409 ANUNCIO_DE_OUTRA_CONTA, sem ML e sem IA");
    }
    {
      reset({ anuncios: [anuncio({ cliente_conta_id: null, ml_user_id: null })] });
      const r = await chamar("MLB-A", { clienteSlug: "cliente-a" });
      assert.strictEqual(r.status, 409);
      assert.strictEqual(r.corpo.codigo, "MULTIPLE_MARKETPLACE_ACCOUNTS");
      assert.strictEqual(r.corpo.contas.length, 2);
      assert.deepStrictEqual([mlChamadas.length, iaChamadas.length], [0, 0]);
      ok("conta ambígua → 409 MULTIPLE_MARKETPLACE_ACCOUNTS (fail closed, sem primeira conta)");
    }
    {
      reset();
      const r = await chamar("MLB-A", CORPO, { auth: token(99) });
      assert.strictEqual(r.status, 403);
      assert.strictEqual(r.corpo.code, "CLIENTE_FORA_DA_CARTEIRA");
      const r2 = await chamar("MLB-A", CORPO, { auth: token(2) });
      assert.strictEqual(r2.status, 403, "admin-only, como /seo/titulos");
      const r3 = await chamar("MLB-A", { ...CORPO, clienteContaId: 20 });
      assert.strictEqual(r3.status, 403);
      assert.strictEqual(r3.corpo.codigo, "CONTA_NAO_PERTENCE_AO_CLIENTE");
      assert.deepStrictEqual([mlChamadas.length, iaChamadas.length], [0, 0]);
      ok("cliente fora da carteira → 403; não-admin → 403; conta de outro cliente → 403");
    }
    {
      reset({ descricao: "sem" });
      iaResposta = () => ({ ok: true, data: { descricao: "Tênis infantil Molekinho para meninos, com fechamento por cadarço.", fatosUsados: ["brand"] } });
      const r = await chamar("MLB-A", CORPO);
      assert.strictEqual(r.corpo.ok, true, JSON.stringify(r.corpo));
      assert.ok(iaChamadas[0].prompt.includes("Descrição atual: (o anúncio não tem descrição hoje)"));
      guardar();
      reset({ descricao: "erro" });
      const r2 = await chamar("MLB-A", CORPO);
      assert.strictEqual(r2.status, 200);
      assert.deepStrictEqual([r2.corpo.ok, r2.corpo.codigo], [false, "DESCRICAO_ATUAL_INDISPONIVEL"]);
      assert.strictEqual(iaChamadas.length, 0, "não gasta IA sem saber o que o anúncio tem hoje");
      guardar();
      ok("ML 404 = sem descrição (gera); ML 503 = DESCRICAO_ATUAL_INDISPONIVEL sem chamar a IA");
    }
    {
      reset({ categoria: 300 });
      const r = await chamar("MLB-A", CORPO);
      assert.strictEqual(r.corpo.limite, 300, "max_description_length da categoria abaixo do teto vale");
      assert.ok(iaChamadas[0].prompt.includes("Máximo absoluto: 300 caracteres"));
      await chamar("MLB-A", CORPO);
      await chamar("MLB-A", CORPO);
      assert.strictEqual(mlChamadas.filter((c) => /^\/categories\//.test(c.path)).length, 1, "categoria em cache: 1 leitura em 3 cliques");
      assert.strictEqual(mlChamadas.filter((c) => /description$/.test(c.path)).length, 3, "descrição é lida ao vivo a cada clique");
      guardar();
      reset({ categoria: "erro" });
      const r2 = await chamar("MLB-A", CORPO);
      assert.strictEqual(r2.corpo.ok, true);
      assert.strictEqual(r2.corpo.limite, 2500, "categoria ilegível → padrão 50.000 sob o teto 2500");
      assert.ok(!iaChamadas[0].prompt.includes("[categoria]"));
      guardar();
      ok("limite = settings.max_description_length (cache, 1 leitura); categoria ilegível → fallback seguro");
    }
    {
      for (const [resp, codigo] of [
        [{ ok: false, codigo: "AI_RESPONSE_TRUNCATED", erro: "cortada" }, "AI_RESPONSE_TRUNCATED"],
        [{ ok: false, codigo: "JSON_INVALIDO", erro: "A IA não devolveu JSON válido." }, "JSON_INVALIDO"],
        [{ ok: false, codigo: "HTTP_529", erro: "Overloaded" }, "HTTP_529"],
        [{ ok: false, codigo: "NO_API_KEY", erro: "Sem chave" }, "NO_API_KEY"],
      ]) {
        reset();
        iaResposta = () => resp;
        const r = await chamar("MLB-A", CORPO);
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual([r.corpo.ok, r.corpo.codigo], [false, codigo]);
        assert.ok(typeof r.corpo.motivo === "string" && r.corpo.motivo.length > 0);
        guardar();
      }
      ok("erros do provider → 200 { ok:false, codigo (TRUNCATED/JSON/HTTP/NO_API_KEY), motivo } — contrato do /seo/titulos");
    }
    {
      reset();
      iaResposta = () => ({ ok: true, data: { descricao: "Tênis Nike impermeável para homem com 40 cm. Frete grátis!", fatosUsados: ["brand", "attr:NAO_EXISTE"] } });
      const r = await chamar("MLB-A", CORPO);
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual([r.corpo.ok, r.corpo.codigo], [false, "DESCRICAO_INVALIDA"]);
      const cods = r.corpo.problemas.map((p) => p.codigo);
      // F7B: problemas = só os HARD que bloquearam (FATO_DESCONHECIDO é SOFT)
      for (const c of ["NOME_NAO_COMPROVADO", "ATRIBUTO_PROIBIDO", "NUMERO_NAO_COMPROVADO", "LINGUAGEM_PROIBIDA"]) {
        assert.ok(cods.includes(c), c + " ∉ " + cods);
      }
      assert.ok(!cods.includes("FATO_DESCONHECIDO"));
      assert.ok(!("descricao" in r.corpo), "texto inválido não chega ao front");
      guardar();
      ok("geração inválida → 200 { ok:false, DESCRICAO_INVALIDA, problemas } sem devolver o texto");
    }
    {
      reset({ anuncios: [anuncio({ marca: null, modelo: null, attributes_json: [{ id: "BRAND", name: "Marca", value: "Genérica" }] })], descricao: "sem" });
      const r = await chamar("MLB-A", CORPO);
      assert.deepStrictEqual([r.corpo.ok, r.corpo.codigo], [false, "FATOS_INSUFICIENTES"]);
      assert.strictEqual(iaChamadas.length, 0);
      guardar();
      ok("poucos fatos → FATOS_INSUFICIENTES sem chamar a IA");
    }
    {
      reset({ anuncios: [anuncio({ catalog_listing: true, family_name: "Tênis Molekinho" })] });
      const r = await chamar("MLB-A", CORPO);
      assert.strictEqual(r.corpo.ok, true, "catálogo/família não travam a descrição (só o título)");
      guardar();
      reset();
      const r2 = await chamar("MLB-A", { clienteContaId: 10 });
      assert.strictEqual(r2.status, 400);
      const r3 = await chamar("MLB-NAO-EXISTE", CORPO);
      assert.strictEqual(r3.status, 404);
      guardar();
      ok("catálogo/família não bloqueiam; sem clienteSlug → 400; anúncio inexistente → 404");
    }
    {
      // Autorreparo pela rota real: mesma requisição, flag OFF × ON.
      const PROMESSA = " Compre com confiança e receba tudo de forma simples e segura.";
      const COM_CLAIM = BOA.replace("o material principal é sintético.", "o material principal é sintético e resistente ao uso diário.");
      const REPARADA = "O fechamento é por cadarço e o material principal é sintético.";
      const USADOS = ["brand", "attr:CLOSURE_TYPE", "attr:MAIN_MATERIAL"];
      const sequencia = (...rs) => () => rs[Math.min(iaChamadas.length - 1, rs.length - 1)];
      const anterior = process.env.SEO_DESCRICAO_AUTORREPARO;
      try {
        for (const [flag, ligado] of [[undefined, false], ["off", false], ["1", true]]) {
          if (flag === undefined) delete process.env.SEO_DESCRICAO_AUTORREPARO;
          else process.env.SEO_DESCRICAO_AUTORREPARO = flag;

          // (a) rejeitável só por frase sem fato → remoção localizada (sem 2ª chamada)
          reset();
          iaResposta = sequencia({ ok: true, data: { descricao: BOA + PROMESSA, fatosUsados: USADOS } });
          const ra = await chamar("MLB-A", CORPO);
          assert.strictEqual(ra.status, 200);
          assert.strictEqual(iaChamadas.length, 1);
          if (!ligado) {
            assert.deepStrictEqual([ra.corpo.ok, ra.corpo.codigo], [false, "DESCRICAO_INVALIDA"], "OFF: rejeição de hoje");
            assert.ok(!("autorreparo" in ra.corpo));
          } else {
            assert.strictEqual(ra.corpo.ok, true, JSON.stringify(ra.corpo));
            assert.strictEqual(ra.corpo.descricao, BOA);
            assert.strictEqual(ra.corpo.autorreparo.etapa, "remocao");
            assert.deepStrictEqual(ra.corpo.autorreparo.removidas.map((x) => x.trecho), [PROMESSA.trim()]);
            assert.deepStrictEqual(ra.corpo.fatosUsados.map((f) => f.label), ["Marca", "Tipo de fechamento", "Material principal"]);
            assert.strictEqual(ra.corpo.limite, 2500);
          }
          guardar();

          // (b) claim em frase com fato → UMA chamada de reparo só com o trecho
          reset();
          iaResposta = sequencia({ ok: true, data: { descricao: COM_CLAIM, fatosUsados: USADOS } },
            { ok: true, data: { trocas: [{ id: "S1", texto: REPARADA }] } },
            { ok: true, data: { descricao: BOA, fatosUsados: USADOS } });
          const rb = await chamar("MLB-A", CORPO);
          assert.strictEqual(rb.status, 200);
          if (!ligado) {
            assert.deepStrictEqual([rb.corpo.ok, rb.corpo.codigo, iaChamadas.length], [false, "DESCRICAO_INVALIDA", 1]);
          } else {
            assert.strictEqual(iaChamadas.length, 2, "geração + 1 reparo, nunca mais");
            assert.strictEqual(iaChamadas[1].task, "seo_description");
            assert.ok(iaChamadas[1].prompt.includes("[S1]") && !iaChamadas[1].prompt.includes("[S2]"), "só o trecho rejeitado vai ao reparo");
            assert.strictEqual(rb.corpo.ok, true, JSON.stringify(rb.corpo));
            assert.strictEqual(rb.corpo.descricao, BOA, "fora do trecho tudo idêntico; nenhum atributo some");
            assert.deepStrictEqual(rb.corpo.autorreparo.trocas.map((t) => t.depois), [REPARADA]);
          }
          guardar();

          // (c) reparo que não resolve → mesma rejeição; aprovada na 1ª → igual a hoje
          reset();
          iaResposta = sequencia({ ok: true, data: { descricao: COM_CLAIM, fatosUsados: USADOS } },
            { ok: true, data: { trocas: [{ id: "S1", texto: REPARADA + " Ideal para a marca Nike." }] } });
          const rc = await chamar("MLB-A", CORPO);
          assert.deepStrictEqual([rc.corpo.ok, rc.corpo.codigo], [false, "DESCRICAO_INVALIDA"]);
          assert.ok(!("descricao" in rc.corpo));
          assert.strictEqual(iaChamadas.length, ligado ? 2 : 1);
          assert.strictEqual(!!rc.corpo.autorreparo, ligado);
          guardar();
          reset();
          const rd = await chamar("MLB-A", CORPO);
          assert.deepStrictEqual(Object.keys(rd.corpo).sort(), ["chars", "descricao", "fatosUsados", "limite", "ok"], "aprovada na 1ª: contrato de hoje");
          assert.strictEqual(iaChamadas.length, 1);
          assert.deepStrictEqual(escritasBanco, []);
          guardar();
        }
      } finally {
        if (anterior === undefined) delete process.env.SEO_DESCRICAO_AUTORREPARO;
        else process.env.SEO_DESCRICAO_AUTORREPARO = anterior;
      }
      ok("autorreparo: flag ausente/off = rejeição de hoje (1 chamada); ON = remoção localizada ou 1 reparo restrito ao trecho, rejeição idêntica quando não resolve");
    }
    {
      const anterior = process.env.SEO_DESCRICAO_AUTORREPARO;
      const a = () => anuncio({ attributes_json: [...anuncio().attributes_json, { id: "COLOR", name: "Cor", value: "Azul marinho" }] });
      const base = "DESCRIÇÃO PRINCIPAL\nTênis infantil Molekinho para meninos.";
      try {
        for (const flag of ["off", "on"]) {
          process.env.SEO_DESCRICAO_AUTORREPARO = flag;
          reset({ anuncios: [a()], descricao: "sem" });
          iaResposta = () => ({ ok: true, data: { descricao: base + "\n\nESPECIFICAÇÕES\n* Cor: Azul marinho acetinado.", fatosUsados: [] } });
          const corrigida = await chamar("MLB-A", CORPO);
          assert.strictEqual(corrigida.status, 200);
          assert.ok(corrigida.corpo.ok && corrigida.corpo.descricao.includes("Cor: Azul marinho"), JSON.stringify(corrigida.corpo));
          assert.ok(!corrigida.corpo.descricao.includes("acetinado"));
          assert.ok(corrigida.corpo.avisos.some((p) => p.codigo === "TERMO_NAO_COMPROVADO"));
          assert.strictEqual(iaChamadas.length, 1);
          guardar();

          reset({ anuncios: [a()], descricao: "sem" });
          iaResposta = () => iaChamadas.length === 1
            ? { ok: true, data: { descricao: base + "\n\nDESTAQUES DO PRODUTO\nA cor azul marinho tem acabamento acetinado.", fatosUsados: [] } }
            : { ok: true, data: { trocas: [{ id: "S1", texto: "" }] } };
          const perdida = await chamar("MLB-A", CORPO);
          assert.strictEqual(perdida.status, 200);
          assert.ok(!perdida.corpo.ok && perdida.corpo.problemas.some((p) => p.codigo === "FATO_PERDIDO"));
          assert.ok(!("descricao" in perdida.corpo));
          assert.strictEqual(iaChamadas.length, flag === "on" ? 2 : 1);
          guardar();
          if (flag === "off") {
            for (const [secao, claim] of [["BENEFÍCIOS", "Baixo\nconsumo."], ["BENEFÍCIOS", "Revestimento\neletrostático."],
              ["COMO USAR", "* Posicione o produto de forma firme\nsob carga."]]) {
              reset({ anuncios: [a()], descricao: "sem" });
              iaResposta = () => ({ ok: true, data: { descricao: base + "\n\n" + secao + "\n" + claim, fatosUsados: [] } });
              const insegura = await chamar("MLB-A", CORPO);
              assert.ok(!insegura.corpo.ok && insegura.corpo.problemas.some((p) => p.codigo === "CLAIM_OBJETIVO_SEM_FONTE"), JSON.stringify(insegura.corpo));
              assert.ok(!("descricao" in insegura.corpo));
              assert.strictEqual(iaChamadas.length, 1);
              guardar();
            }
            reset({ anuncios: [a()], descricao: "sem" });
            const isolada = base + "\n\nCOMO USAR\n* Posicione o produto de forma firme";
            iaResposta = () => ({ ok: true, data: { descricao: isolada, fatosUsados: [] } });
            const segura = await chamar("MLB-A", CORPO);
            assert.ok(segura.corpo.ok && segura.corpo.descricao === isolada, JSON.stringify(segura.corpo));
            assert.strictEqual(iaChamadas.length, 1);
            guardar();
          }
        }
      } finally {
        if (anterior === undefined) delete process.env.SEO_DESCRICAO_AUTORREPARO;
        else process.env.SEO_DESCRICAO_AUTORREPARO = anterior;
      }
      ok("preservação SOFT na rota: cor conservada na primeira geração, perda rejeitada com flag OFF/ON, sem escrita");
    }
    {
      assert.ok(todasChamadasMl.length > 0);
      assert.ok(todasChamadasMl.every((c) => c.metodo === "GET" &&
        (/^\/categories\/[^/]+$/.test(c.path) || /^\/items\/[^/]+\/description$/.test(c.path))),
        "o ML só é LIDO: GET /categories/{id} e GET /items/{id}/description");
      assert.deepStrictEqual(todasEscritas, []);
      ok("em todo o teste o ML só recebeu GET de descrição/categoria e o banco nenhuma escrita");
    }
  } finally {
    server.close();
  }
  console.log(`\n✓ ${checks} verificações de POST /seo/descricao`);
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
