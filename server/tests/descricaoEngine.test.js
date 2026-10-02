// server/tests/descricaoEngine.test.js
//
// Description Engine (SEO ML · F5) isolado: ficha factual, prompt, validação
// determinística e gerarDescricao com aiProvider SIMULADO (nunca a Anthropic
// real). Uma sugestão por chamada, sem score.

const assert = require("assert");
const engine = require("../services/meliAnuncios/seo/descricaoEngine");

function anuncio(over = {}) {
  return {
    item_id: "MLB-A",
    titulo: "Tênis Infantil Molekinho Cadarço Azul",
    marca: "Molekinho",
    attributes_json: [
      { id: "BRAND", name: "Marca", value: "Molekinho" },
      { id: "MODEL", name: "Modelo", value: "2024" },
      { id: "GENDER", name: "Gênero", value: "Meninos" },
      { id: "CLOSURE_TYPE", name: "Tipo de fechamento", value: "Cadarço" },
      { id: "MAIN_MATERIAL", name: "Material principal", value: "Sintético" },
      { id: "COLOR", name: "Cor", value: "Azul Marinho" },
      { id: "IS_WATERPROOF", name: "É impermeável", value: "Não" },
      { id: "WITH_LIGHTS", name: "Com luzes", value: "Sim" },
      { id: "SELLER_SKU", name: "SKU", value: "MK-998877" },
    ],
    ...over,
  };
}
const DESC_ATUAL = "Tênis confortável para o dia a dia escolar. Solado de borracha antiderrapante com 2 cm de altura.";
function ficha(over = {}, opts = {}) {
  return engine.montarFicha(anuncio(over), {
    categoriaNome: "Tênis",
    limiteCategoria: 50000,
    descricaoAtual: DESC_ATUAL,
    descricaoEstado: "ok",
    ...opts,
  });
}
const BOA = [
  "Tênis infantil Molekinho para meninos, pensado para o dia a dia escolar.",
  "",
  "O fechamento é por cadarço e o material principal é sintético. " +
    "O solado de borracha tem 2 cm de altura.",
  "",
  "Na cor azul marinho, com luzes. Não é impermeável.",
].join("\n");
const USADOS = ["brand", "attr:GENDER", "attr:CLOSURE_TYPE", "attr:MAIN_MATERIAL", "contexto:descricao_atual"];
const codigos = (v) => (v.problemas || []).map((p) => p.codigo);
const valida = (texto, f = ficha(), usados = USADOS) => engine.validarDescricao(texto, usados, f);

function provider(resposta) {
  const chamadas = [];
  return {
    chamadas,
    async gerarJSON(opts) {
      chamadas.push(opts);
      if (typeof resposta === "function") return resposta(opts);
      return resposta;
    },
  };
}

let checks = 0;
function ok(msg) { checks += 1; console.log(`  ✓ ${msg}`); }

async function run() {
  console.log("descricaoEngine");

  // 1 ─ fatos estruturados chegam ao prompt, com ID estável
  {
    const f = ficha();
    const p = engine.montarPrompt(f);
    for (const linha of [
      "[brand] Marca: Molekinho", "[model] Modelo: 2024", "[attr:GENDER] Gênero: Meninos",
      "[attr:CLOSURE_TYPE] Tipo de fechamento: Cadarço", "[attr:COLOR] Cor: Azul Marinho",
      "[categoria] Categoria do Mercado Livre (só para entender o produto; não vira item nem frase): Tênis", "[attr:WITH_LIGHTS] Com luzes: Sim",
    ]) assert.ok(p.includes(linha), "faltou no prompt: " + linha);
    assert.ok(!p.includes("MK-998877"), "SKU não é fato do produto");
    assert.ok(p.includes("SE UMA INFORMAÇÃO NÃO ESTIVER NOS FATOS OU NO CONTEXTO AUTORIZADO, NÃO INVENTE") ||
      engine.SYSTEM.includes("SE UMA INFORMAÇÃO NÃO ESTIVER NOS FATOS OU NO CONTEXTO AUTORIZADO, NÃO INVENTE"));
    assert.ok(!/score|ranking|palavras?-chave|keywords?|volume de busca/i.test(p + engine.SYSTEM), "nada de score/keywords");
    assert.deepStrictEqual(f.fatos.filter((x) => x.grupo === "forte").map((x) => x.id),
      ["brand", "model", "attr:GENDER", "attr:CLOSURE_TYPE", "attr:MAIN_MATERIAL", "attr:COLOR"]);
    assert.deepStrictEqual(f.fatos.filter((x) => x.grupo === "secundario").map((x) => x.id), ["attr:WITH_LIGHTS"]);
    ok("1. fatos fortes/secundários chegam ao prompt com ID; SKU fora; regra NÃO INVENTE; sem score/keywords");
  }

  // 1b ─ MODEL legado (lista de palavras-chave) não vira fato
  {
    const f = ficha({ attributes_json: [
      { id: "BRAND", name: "Marca", value: "Molekinho" },
      { id: "MODEL", name: "Modelo", value: "tenis, infantil, menino, escolar, barato, promoção" },
    ] });
    assert.ok(!f.fatos.some((x) => x.id === "model"));
    assert.ok(!engine.montarPrompt(f).includes("barato"), "lista de stuffing não vai ao prompt");
    ok("1b. MODEL com cara de keyword stuffing legado não é fato e não vai ao prompt");
  }

  // 2 ─ descrição atual chega ao prompt como contexto fraco
  {
    const p = engine.montarPrompt(ficha());
    assert.ok(p.includes("[contexto:descricao_atual]"));
    assert.ok(p.includes(DESC_ATUAL));
    assert.ok(p.indexOf("CONTEXTO (mais fraco que os fatos") > p.indexOf("FATOS PRINCIPAIS"));
    ok("2. descrição atual chega ao prompt, rotulada como contexto mais fraco que os fatos");
  }

  // 3 ─ ausência de descrição atual
  {
    const f = ficha({}, { descricaoAtual: null, descricaoEstado: "sem_descricao" });
    assert.deepStrictEqual(f.descricaoAtual, { estado: "sem_descricao", texto: null });
    const p = engine.montarPrompt(f);
    assert.ok(p.includes("Descrição atual: (o anúncio não tem descrição hoje)"));
    assert.ok(!f.idsConhecidos.has("contexto:descricao_atual"));
    const fErro = ficha({}, { descricaoAtual: null, descricaoEstado: "erro" });
    assert.strictEqual(fErro.descricaoAtual.estado, "erro", "erro de leitura ≠ sem descrição");
    const prov = provider({ ok: true, data: { descricao: BOA, fatosUsados: [] } });
    const r = await engine.gerarDescricao({ ficha: fErro, aiProvider: prov });
    assert.deepStrictEqual([r.ok, r.codigo, prov.chamadas.length], [false, "DESCRICAO_ATUAL_INDISPONIVEL", 0]);
    ok("3. sem descrição = 'não tem descrição hoje'; leitura com erro = recusa sem chamar a IA");
  }

  // 4 ─ booleano "Não" vira proibido
  {
    const f = ficha();
    const p = f.proibidos.find((x) => x.id === "attr:IS_WATERPROOF");
    assert.ok(p && p.motivo === "ATRIBUTO_NEGADO" && p.exibir[0] === "impermeável", JSON.stringify(f.proibidos));
    assert.ok(engine.montarPrompt(f).includes("nunca escreva: impermeável"));
    assert.ok(codigos(valida("Tênis infantil Molekinho impermeável, para meninos.")).includes("ATRIBUTO_PROIBIDO"));
    assert.ok(!codigos(valida("Tênis infantil Molekinho para meninos. Não é impermeável.")).includes("ATRIBUTO_PROIBIDO"),
      "negar o atributo é a informação correta");
    ok("4. 'É impermeável: Não' → proibido no prompt; afirmar 'impermeável' invalida; 'não é impermeável' passa");
  }

  // 5 ─ GENDER conflitante
  {
    const f = ficha();
    const g = f.proibidos.find((x) => x.id === "attr:GENDER");
    assert.deepStrictEqual(g.exibir.slice().sort(), ["feminino", "homem", "menina", "mulher"]);
    const v = valida("Tênis Molekinho masculino, ideal para homens.");
    assert.ok(codigos(v).includes("ATRIBUTO_PROIBIDO"));
    assert.ok(v.problemas.find((x) => x.codigo === "ATRIBUTO_PROIBIDO").termos.includes("homem"));
    assert.ok(!codigos(valida("Tênis Molekinho para meninos.")).includes("ATRIBUTO_PROIBIDO"));
    ok("5. GENDER=Meninos proíbe homem/mulher/menina/feminino (tabela do fatosProduto)");
  }

  // 6 ─ marca errada
  {
    const f = ficha();
    assert.deepStrictEqual(codigos(valida("Tênis da marca Adidas para meninos.", f, ["brand"])), ["MARCA_CONFLITANTE"]);
    assert.ok(codigos(valida("Tênis para meninos, no estilo Nike Air.", f, ["brand"])).includes("NOME_NAO_COMPROVADO"));
    assert.strictEqual(valida("Tênis da marca Molekinho para meninos.", f, ["brand"]).valida, true);
    ok("6. outra marca ('marca Adidas', 'Nike Air' no meio da frase) invalida; a marca da ficha passa");
  }

  // 6b ─ marca / nome próprio em QUALQUER posição (início, meio, fim, depois
  // de quebra de linha ou pontuação, qualquer caixa)
  {
    const f = ficha();
    const cod = (t, fx = f) => codigos(engine.validarDescricao(t, ["brand"], fx));
    // A) marca inventada abrindo a descrição
    for (const t of [
      "Nike oferece um tênis para meninos.",
      "Samsung ideal para o dia a dia escolar.",
      "Nike desenvolvido para meninos.",
      "Nike modelo infantil para meninos.",
      "NIKE para meninos.",
      "Tênis para meninos.\nNike apresenta o cadarço.",
      "Tênis para meninos. Olympikus oferece cadarço.",
      "Tênis para meninos; Adidas oferece cadarço.",
    ]) assert.ok(cod(t).includes("MARCA_CONFLITANTE"), t + " → " + cod(t));
    // D) / E) padrões explícitos, inclusive em minúsculas depois de "marca"
    for (const t of [
      "Marca Nike, para meninos.",
      "Tênis da marca nike para meninos.",
      "Produto da Nike para meninos.",
      "Tênis fabricado pela Adidas.",
      "Tênis infantil, produto Olympikus.",
      "Tênis para meninos da Adidas",
    ]) assert.ok(cod(t).includes("MARCA_CONFLITANTE"), t + " → " + cod(t));
    // B) a marca da ficha em qualquer posição e caixa
    for (const t of [
      "O tênis Molekinho é pensado para meninos.",
      "Molekinho oferece um tênis para meninos.",
      "MOLEKINHO para meninos.",
      "Tênis da marca molekinho para meninos.",
      "Produto da Molekinho para meninos.",
    ]) assert.strictEqual(engine.validarDescricao(t, ["brand"], f).valida, true, t + " → " + cod(t));
    // C) palavras comuns abrindo frase não são marca
    for (const t of [
      "Este tênis foi desenvolvido para meninos.",
      "O tênis tem fechamento por cadarço.",
      "Desenvolvido para o dia a dia escolar.",
      "Ideal para o dia a dia escolar.",
      "Com fechamento por cadarço.",
      "Possui fechamento por cadarço.",
      "Tênis ideal para o dia a dia escolar.",
    ]) assert.strictEqual(engine.validarDescricao(t, ["brand"], f).valida, true, t + " → " + cod(t));
    // "Kit" abrindo a frase não é nome — mas, sem kit nos dados, é termo sem origem (F7A.2)
    assert.deepStrictEqual(cod("Kit com tênis Molekinho para meninos."), ["TERMO_NAO_COMPROVADO"]);
    ok("6b. A/B/C/D/E — marca inventada vale em qualquer posição/caixa; marca da ficha e palavras comuns no início passam");

    // F) descrição atual com Nike NÃO autoriza Nike (fato estruturado vence)
    const fNike = ficha({}, { descricaoAtual: "Tênis confortável, no estilo da Nike, para o dia a dia escolar dos meninos.", descricaoEstado: "ok" });
    assert.ok(fNike.vocabularioFraco.has("nike") && !fNike.nomesAutorizados.has("nike"));
    for (const t of ["Nike oferece um tênis para meninos.", "Tênis para meninos no estilo da Nike.", "Tênis inspirado em Nike para meninos."]) {
      assert.strictEqual(engine.validarDescricao(t, ["brand"], fNike).valida, false, t);
    }
    ok("6c. F — 'Nike' na descrição atual não autoriza 'Nike' na nova com BRAND = Molekinho");

    // G) sem BRAND: palavra capitalizada comum no início passa; nome
    // inventado (posição de marca / grafia estrangeira) sem contexto não passa;
    // nome presente no título/descrição atual passa (sem marca estruturada,
    // o contexto do vendedor é a única referência).
    const semMarca = engine.montarFicha(
      { titulo: "Tênis Infantil Zentrix Cadarço", attributes_json: [
        { id: "GENDER", name: "Gênero", value: "Meninos" }, { id: "CLOSURE_TYPE", name: "Tipo de fechamento", value: "Cadarço" }] },
      { categoriaNome: "Tênis", descricaoEstado: "sem_descricao" });
    assert.strictEqual(semMarca.marca, null);
    const v = (t) => engine.validarDescricao(t, [], semMarca);
    assert.strictEqual(v("Desenvolvido para meninos, com fechamento por cadarço.").valida, true);
    assert.strictEqual(v("Este tênis tem fechamento por cadarço.").valida, true);
    assert.deepStrictEqual(codigos(v("Kombat oferece um tênis para meninos.")), ["NOME_NAO_COMPROVADO"]);
    assert.deepStrictEqual(codigos(v("Nike para meninos, com cadarço.")), ["NOME_NAO_COMPROVADO"]);
    assert.deepStrictEqual(codigos(v("Tênis da marca Kombat.")), ["NOME_NAO_COMPROVADO"]);
    assert.strictEqual(v("Zentrix oferece um tênis para meninos.").valida, true, "nome do título do vendedor, sem BRAND conflitante");
    ok("6d. G — sem BRAND: começo comum passa; nome inventado vira NOME_NAO_COMPROVADO (nunca MARCA_CONFLITANTE); nome do título passa");

    // H) LINE / MODEL factual abrindo a frase
    const fLinha = ficha({ attributes_json: [
      { id: "BRAND", name: "Marca", value: "Molekinho" },
      { id: "MODEL", name: "Modelo", value: "Kids Runner" },
      { id: "LINE", name: "Linha", value: "Street Hype" },
      { id: "CLOSURE_TYPE", name: "Tipo de fechamento", value: "Cadarço" },
    ] });
    for (const t of [
      "Street Hype é a linha infantil da Molekinho.",
      "Kids Runner traz fechamento por cadarço.",
      "Tênis da linha Street Hype, modelo Kids Runner.",
      "STREET HYPE para o dia a dia escolar.", // sem GENDER aqui: "meninos" não teria origem (F7A.2)
    ]) assert.strictEqual(engine.validarDescricao(t, ["attr:LINE", "model"], fLinha).valida, true, t + " → " + codigos(engine.validarDescricao(t, [], fLinha)));
    assert.ok(codigos(engine.validarDescricao("Tênis da linha Air Max.", [], fLinha)).includes("MARCA_CONFLITANTE"),
      "linha inventada em posição de marca também não passa");
    ok("6e. H — LINE e MODEL factuais passam no início da frase e em caixa alta; linha inventada não");
  }

  // 7 / 8 ─ números
  {
    const v = valida("Tênis Molekinho para meninos com 3 cm de solado, 12V e 500 ml.");
    assert.ok(codigos(v).includes("NUMERO_NAO_COMPROVADO"));
    assert.deepStrictEqual(v.problemas.find((x) => x.codigo === "NUMERO_NAO_COMPROVADO").termos, ["3", "12", "500"]);
    assert.ok(codigos(valida("Kit Molekinho com três unidades.")).includes("NUMERO_NAO_COMPROVADO"));
    ok("7. número/medida inventado (3 cm, 12V, 500 ml, 'três unidades') invalida");

    assert.strictEqual(valida("Tênis Molekinho 2024 para meninos, solado com 2 cm de altura.").valida, true);
    const f = ficha({ attributes_json: [
      { id: "BRAND", name: "Marca", value: "Molekinho" },
      { id: "VOLTAGE", name: "Voltagem", value: "220V" },
      { id: "CAPACITY", name: "Capacidade", value: "1,5 L" },
      { id: "UNITS_PER_PACK", name: "Unidades por kit", value: "2" },
    ] });
    assert.strictEqual(engine.validarDescricao("Produto Molekinho 220V com 1.5 L, kit com duas unidades.", ["brand"], f).valida, true);
    ok("8. número presente nos fatos/descrição atual (2 cm, 2024, 220V, 1,5 L, 'duas unidades') passa");
  }

  // 9 / 10 / 11 ─ URL, e-mail, telefone
  {
    assert.ok(codigos(valida("Veja mais em www.molekinho.com.br.")).includes("URL"));
    assert.ok(codigos(valida("Veja https://exemplo.com")).includes("URL"));
    ok("9. URL invalida");
    assert.ok(codigos(valida("Dúvidas: contato@molekinho.com")).includes("EMAIL"));
    ok("10. e-mail invalida");
    assert.ok(codigos(valida("Ligue (11) 98765-4321.")).includes("TELEFONE"));
    assert.ok(codigos(valida("Chame no WhatsApp para saber mais.")).includes("CONTATO_EXTERNO"));
    ok("11. telefone invalida (e WhatsApp/contato externo também)");
  }

  // 12 ─ linguagem promocional, logística, garantia, voz da loja, chatbot
  {
    for (const [frase, codigo] of [
      ["Descubra a combinação perfeita para meninos.", "LINGUAGEM_PROIBIDA"],
      ["Produto incrível da Molekinho.", "LINGUAGEM_PROIBIDA"],
      ["Qualidade incomparável.", "LINGUAGEM_PROIBIDA"],
      ["Imperdível.", "LINGUAGEM_PROIBIDA"],
      ["A melhor escolha para meninos.", "LINGUAGEM_PROIBIDA"],
      ["Frete grátis para todo o Brasil.", "LINGUAGEM_PROIBIDA"],
      ["Garantia de 90 dias.", "LINGUAGEM_PROIBIDA"],
      ["Aqui está a descrição do tênis.", "LINGUAGEM_PROIBIDA"],
      ["Tênis Molekinho. Ótimo! Lindo! Confira!", "LINGUAGEM_PROIBIDA"],
      ["Na nossa loja você encontra o tênis Molekinho.", "VOZ_DA_LOJA"],
      ["<b>Tênis</b> Molekinho", "FORMATACAO_INVALIDA"],
      ["**Tênis** Molekinho", "FORMATACAO_INVALIDA"],
    ]) assert.ok(codigos(valida(frase)).includes(codigo), frase + " → " + codigos(valida(frase)));
    assert.strictEqual(valida("Tênis Molekinho com luzes nos solados.").valida, true, "'nos' (em+os) não é voz da loja");
    const fPremium = ficha({ attributes_json: [
      { id: "BRAND", name: "Marca", value: "Molekinho" },
      { id: "LINE", name: "Linha", value: "Premium" },
    ] });
    assert.strictEqual(engine.validarDescricao("Tênis Molekinho da linha Premium.", ["attr:LINE"], fPremium).valida, true,
      "termo que é VALOR de um fato não é promocional");
    ok("12. promocional/frete/garantia/chatbot/'nossa loja'/HTML/markdown invalidam; 'Premium' de fato passa");
  }

  // 13 ─ fatoUsado desconhecido
  {
    const v = valida(BOA, ficha(), ["brand", "attr:INVENTADO"]);
    assert.deepStrictEqual(codigos(v), ["FATO_DESCONHECIDO"]);
    assert.deepStrictEqual(v.problemas[0].termos, ["attr:INVENTADO"]);
    assert.deepStrictEqual(codigos(valida(BOA, ficha(), "brand")), ["FATOS_USADOS_INVALIDOS"]);
    assert.strictEqual(valida(BOA, ficha(), ["attr:IS_WATERPROOF", "categoria", "contexto:titulo"]).valida, true,
      "ID de proibido, categoria e contexto também são conhecidos");
    ok("13. fatoUsado desconhecido → FATO_DESCONHECIDO; lista ausente → FATOS_USADOS_INVALIDOS");
  }

  // 14 ─ resposta vazia
  {
    assert.deepStrictEqual(codigos(valida("   \n  ")), ["VAZIA"]);
    const r = await engine.gerarDescricao({ ficha: ficha(), aiProvider: provider({ ok: true, data: { descricao: "", fatosUsados: [] } }) });
    assert.deepStrictEqual([r.ok, r.codigo], [false, "DESCRICAO_INVALIDA"]);
    assert.deepStrictEqual(r.problemas.map((p) => p.codigo), ["VAZIA"]);
    ok("14. resposta vazia → VAZIA / DESCRICAO_INVALIDA");
  }

  // 15 ─ acima do limite
  {
    const longa = (BOA + "\n").repeat(12);
    const f = ficha();
    assert.strictEqual(f.limite, engine.TETO_OPERACIONAL, "categoria com 50.000 → teto operacional");
    assert.ok(codigos(valida(longa, f)).includes("EXCEDE_LIMITE"));
    const fCurta = ficha({}, { limiteCategoria: 200 });
    assert.strictEqual(fCurta.limite, 200, "limite da categoria menor que o teto vale");
    assert.ok(codigos(valida(BOA, fCurta)).includes("EXCEDE_LIMITE"));
    assert.strictEqual(ficha({}, { limiteCategoria: null }).limite, engine.TETO_OPERACIONAL, "sem categoria: fallback 50.000 → teto");
    ok("15. acima do limite (min(categoria, teto 2500); fallback 50.000) → EXCEDE_LIMITE");
  }

  // 16 ─ poucos fatos
  {
    const pobre = engine.montarFicha({ titulo: "Produto", attributes_json: [{ id: "BRAND", name: "Marca", value: "Genérica" }] },
      { categoriaNome: "Tênis", descricaoEstado: "sem_descricao" });
    assert.strictEqual(pobre.suficiente, false);
    const prov = provider({ ok: true, data: { descricao: "x", fatosUsados: [] } });
    const r = await engine.gerarDescricao({ ficha: pobre, aiProvider: prov });
    assert.deepStrictEqual([r.ok, r.codigo, prov.chamadas.length], [false, "FATOS_INSUFICIENTES", 0]);
    const umFatoMaisDescricao = engine.montarFicha(
      { titulo: "Tênis", attributes_json: [{ id: "BRAND", name: "Marca", value: "Molekinho" }] },
      { descricaoAtual: DESC_ATUAL, descricaoEstado: "ok" });
    assert.strictEqual(umFatoMaisDescricao.suficiente, true, "descrição atual real conta como 1 fonte");
    assert.deepStrictEqual(umFatoMaisDescricao.alvo, { min: 300, max: 700 }, "poucos fatos → faixa curta");
    assert.deepStrictEqual(ficha().alvo, { min: 800, max: 2000 }, "muitos fatos → faixa maior");
    ok("16. poucos fatos → FATOS_INSUFICIENTES sem chamar IA; faixa de tamanho proporcional aos fatos");
  }

  // 17 / 18 / 19 ─ erros do provider
  {
    const r1 = await engine.gerarDescricao({ ficha: ficha(), aiProvider: provider({ ok: false, codigo: "HTTP_529", erro: "Overloaded" }) });
    assert.deepStrictEqual([r1.ok, r1.codigo, r1.motivo], [false, "HTTP_529", "Overloaded"]);
    const r1b = await engine.gerarDescricao({ ficha: ficha(), aiProvider: { async gerarJSON() { throw new Error("boom"); } } });
    assert.deepStrictEqual([r1b.ok, r1b.codigo], [false, "IA_ERRO"]);
    ok("17. provider com erro → { ok:false, codigo do provider, motivo }; exceção → IA_ERRO");

    const r2 = await engine.gerarDescricao({ ficha: ficha(), aiProvider: provider({ ok: false, codigo: "JSON_INVALIDO", erro: "A IA não devolveu JSON válido." }) });
    assert.deepStrictEqual([r2.ok, r2.codigo], [false, "JSON_INVALIDO"]);
    const r2b = await engine.gerarDescricao({ ficha: ficha(), aiProvider: provider({ ok: true, data: { texto: "sem campo descricao" } }) });
    assert.deepStrictEqual([r2b.ok, r2b.codigo], [false, "RESPOSTA_INVALIDA"]);
    ok("18. JSON inválido → JSON_INVALIDO; JSON sem 'descricao' → RESPOSTA_INVALIDA");

    const r3 = await engine.gerarDescricao({ ficha: ficha(), aiProvider: provider({ ok: false, codigo: "AI_RESPONSE_TRUNCATED", erro: "cortada" }) });
    assert.deepStrictEqual([r3.ok, r3.codigo], [false, "AI_RESPONSE_TRUNCATED"]);
    assert.ok(/cortada/.test(r3.motivo));
    ok("19. AI_RESPONSE_TRUNCATED propagado com motivo claro");
  }

  // 20 ─ determinismo + caminho feliz
  {
    const f = ficha();
    const antes = JSON.stringify({ ...f, idsConhecidos: [...f.idsConhecidos], nomesAutorizados: [...f.nomesAutorizados], vocabularioFraco: [...f.vocabularioFraco], vocabularioComum: [...f.vocabularioComum], numerosPermitidos: [...f.numerosPermitidos] });
    const ruim = "Descubra o tênis Nike incrível! Para homem. 35 cm. www.x.com";
    const a = JSON.stringify(valida(ruim, f, ["x"]));
    for (let i = 0; i < 5; i += 1) assert.strictEqual(JSON.stringify(valida(ruim, f, ["x"])), a);
    assert.strictEqual(JSON.stringify(valida(BOA, f)), JSON.stringify(valida(BOA, f)));
    const depois = JSON.stringify({ ...f, idsConhecidos: [...f.idsConhecidos], nomesAutorizados: [...f.nomesAutorizados], vocabularioFraco: [...f.vocabularioFraco], vocabularioComum: [...f.vocabularioComum], numerosPermitidos: [...f.numerosPermitidos] });
    assert.strictEqual(depois, antes, "validar não altera a ficha");

    const prov = provider({ ok: true, data: { descricao: "  " + BOA.replace(/\n/g, "\r\n") + "  ", fatosUsados: USADOS.concat(["brand"]) } });
    const r = await engine.gerarDescricao({ ficha: f, aiProvider: prov });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual(Object.keys(r).sort(), ["chars", "descricao", "fatosUsados", "limite", "ok"], "sem score de nenhum tipo");
    assert.strictEqual(r.descricao, BOA, "normaliza CRLF e espaços das pontas");
    assert.deepStrictEqual(r.fatosUsados.map((x) => x.id), USADOS, "IDs deduplicados, na ordem");
    assert.deepStrictEqual(r.fatosUsados[0], { id: "brand", label: "Marca", value: "Molekinho" });
    assert.strictEqual(prov.chamadas.length, 1, "uma chamada por geração");
    assert.strictEqual(prov.chamadas[0].task, "seo_description", "F6 — task informada ao aiProvider");
    assert.ok(prov.chamadas[0].system.includes("NÃO INVENTE") && prov.chamadas[0].prompt.includes("[brand]"));
    ok("20. validação determinística e sem efeito colateral; caminho feliz = 1 chamada, sem score, fatos rastreáveis");
  }

  // 21 ─ F7A.1: contrato de fatosUsados (colchetes de exibição ≠ id)
  {
    const f = ficha();
    const usados = (lista) => engine.validarDescricao(BOA, lista, f);
    const desconhecidos = (v) => ((v.problemas || []).find((p) => p.codigo === "FATO_DESCONHECIDO") || {}).termos || [];
    // A) id puro
    assert.deepStrictEqual(usados(["brand"]).fatosUsados, ["brand"]);
    // B) uma camada de colchetes → canônico
    assert.deepStrictEqual(usados(["[brand]"]).fatosUsados, ["brand"]);
    // C) id com prefixo attr:
    assert.deepStrictEqual(usados(["[attr:COLOR]"]).fatosUsados, ["attr:COLOR"]);
    // D) misturado, e duplicado depois de normalizar conta uma vez
    assert.deepStrictEqual(usados(["brand", "[attr:COLOR]", "[brand]"]).fatosUsados, ["brand", "attr:COLOR"]);
    // E) colchetes não criam fato: id inexistente segue desconhecido
    let v = usados(["[naoExiste]"]);
    assert.deepStrictEqual([v.valida, desconhecidos(v)], [false, ["[naoExiste]".slice(1, -1)]]);
    // F) duas camadas não é sintaxe aceita
    v = usados(["[[brand]]"]);
    assert.deepStrictEqual([v.valida, desconhecidos(v)], [false, ["[[brand]]"]]);
    // G) texto extra, dentro ou fora dos colchetes
    for (const ruim of ["[brand] texto", "brand extra", "[brand texto]", "[brand", "brand]", "[]"]) {
      v = usados([ruim]);
      assert.strictEqual(v.valida, false, ruim);
      assert.ok(desconhecidos(v).length === 1, ruim + " → " + JSON.stringify(v.problemas));
    }
    // H) trim simples é aceito (mesmo comportamento de antes)
    assert.deepStrictEqual(usados([" brand ", " [attr:COLOR] "]).fatosUsados, ["brand", "attr:COLOR"]);
    // sem fuzzy: caixa, prefixo parcial e typo continuam desconhecidos
    for (const quase of ["[Brand]", "BRAND", "[attr:color]", "[attr:COLO]", "[attr:]", "[brnad]", "[ brand ]"]) {
      assert.strictEqual(usados([quase]).valida, false, quase);
    }
    assert.strictEqual(engine.normalizarIdFato("[contexto:descricao_atual]"), "contexto:descricao_atual");
    // I) o prompt pede o id SEM colchetes, com exemplo inequívoco
    const p = engine.montarPrompt(f);
    assert.ok(/SEM COLCHETES/.test(p), "instrução explícita");
    assert.ok(p.includes("escreva attr:COLOR, nunca [attr:COLOR]"), "exemplo do formato");
    assert.ok(!/ids entre colchetes/.test(p), "instrução ambígua antiga removida");
    ok("21. fatosUsados: tira UMA camada de colchetes e exige o id exato da ficha (A–I)");
  }

  // 21b ─ gerarDescricao: resposta com "[id]" sai canônica e rastreável
  {
    const prov = provider({ ok: true, data: { descricao: BOA, fatosUsados: USADOS.map((id) => "[" + id + "]") } });
    const r = await engine.gerarDescricao({ ficha: ficha(), aiProvider: prov });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual(r.fatosUsados.map((x) => x.id), USADOS, "ids canônicos, sem colchetes");
    assert.deepStrictEqual(r.fatosUsados[0], { id: "brand", label: "Marca", value: "Molekinho" });
    const ruim = await engine.gerarDescricao({ ficha: ficha(), aiProvider: provider({ ok: true, data: { descricao: BOA, fatosUsados: ["[brand]", "[attr:INEXISTENTE]"] } }) });
    // F7B: id inexistente é rastreabilidade, não fato no texto → SOFT: sai de fatosUsados com aviso
    assert.deepStrictEqual([ruim.ok, ruim.fatosUsados.map((x) => x.id)], [true, ["brand"]]);
    assert.deepStrictEqual(ruim.avisos.map((a) => [a.codigo, a.termos]), [["FATO_DESCONHECIDO", ["attr:INEXISTENTE"]]]);
    assert.strictEqual(engine.validarDescricao(BOA, ["[brand]", "[attr:INEXISTENTE]"], ficha()).problemas[0].codigo, "FATO_DESCONHECIDO",
      "validarDescricao continua apontando");
    ok("21b. ids entre colchetes viram canônicos; id inexistente → aviso FATO_DESCONHECIDO e sai de fatosUsados (F7B: SOFT)");
  }

  // 22 ─ F7A.2: grounding lexical (A–G)
  {
    const fx = (attrs, opts = {}) => engine.montarFicha(
      { titulo: opts.titulo || "Produto Lumi", attributes_json: [{ id: "BRAND", name: "Marca", value: "Lumi" }].concat(attrs) },
      { categoriaNome: opts.categoria || "Cuidados", descricaoAtual: opts.desc || null, descricaoEstado: opts.desc ? "ok" : "sem_descricao" });
    const termos = (v) => ((v.problemas || []).find((p) => p.codigo === "TERMO_NAO_COMPROVADO") || {}).termos || [];
    const v = (t, f) => engine.validarDescricao(t, [], f);

    const fOleo = fx([{ id: "MAIN_INGREDIENTS", name: "Ingredientes", value: "Óleo de coco" }]);
    // A) termo dos fatos
    assert.strictEqual(v("Contém óleo de coco.", fOleo).valida, true, JSON.stringify(v("Contém óleo de coco.", fOleo)));
    // B) karité inventado — o caso real do F7A.1
    let r = v("Contém óleo de coco e manteiga de karité.", fOleo);
    assert.deepStrictEqual(codigos(r), ["TERMO_NAO_COMPROVADO"]);
    assert.deepStrictEqual(termos(r), ["manteiga", "karite"]);

    const fAlg = fx([{ id: "MATERIAL", name: "Material", value: "Algodão" }]);
    // C) material dos fatos
    assert.strictEqual(v("Produto fabricado em algodão.", fAlg).valida, true);
    // D) material inventado
    r = v("Produto fabricado em couro legítimo.", fAlg);
    assert.deepStrictEqual([codigos(r), termos(r)], [["TERMO_NAO_COMPROVADO"], ["couro", "legitimo"]]);
    // E) booleano Sim autoriza o nome do atributo (flexão reconhecida pelo seoText)
    const fBolso = fx([{ id: "MATERIAL", name: "Material", value: "Algodão" }, { id: "WITH_POCKETS", name: "Com bolsos", value: "Sim" }]);
    assert.strictEqual(v("Possui bolsos.", fBolso).valida, true);
    assert.strictEqual(v("Possui bolso.", fBolso).valida, true, "singular/plural é a mesma chave");
    // F) característica sem fato
    assert.deepStrictEqual(termos(v("Produto impermeável.", fAlg)), ["impermeavel"]);
    // G) termo técnico da descrição atual = autorizado lexicalmente
    const fRede = fx([{ id: "MATERIAL", name: "Material", value: "Plástico" }],
      { titulo: "Placa de rede Lumi", categoria: "Placas de rede", desc: "Placa de rede com conector RJ45 para cabo de rede." });
    // G vale para o grounding; a regra de nomes existente continua: com BRAND
    // estruturada, sigla em caixa alta só do contexto fraco segue NOME_NAO_COMPROVADO.
    r = v("Placa de rede com conector RJ45.", fRede);
    assert.ok(!codigos(r).includes("TERMO_NAO_COMPROVADO"), JSON.stringify(r));
    assert.deepStrictEqual(engine.termosNaoComprovados("Placa de rede com conector RJ45.", fRede), []);
    const fRedeSemMarca = engine.montarFicha({ titulo: "Placa de rede", attributes_json: [{ id: "MATERIAL", name: "Material", value: "Plástico" }] },
      { categoriaNome: "Placas de rede", descricaoAtual: "Placa de rede com conector RJ45 para cabo de rede.", descricaoEstado: "ok" });
    r = v("Placa de rede com conector RJ45.", fRedeSemMarca);
    assert.strictEqual(r.valida, true, JSON.stringify(r));
    // Bluetooth (maiúscula no meio) é pego como nome; memória interna como termo
    r = v("Placa de rede com Bluetooth e memória interna.", fRede);
    assert.deepStrictEqual([codigos(r), termos(r)], [["NOME_NAO_COMPROVADO", "TERMO_NAO_COMPROVADO"], ["memoria", "interna"]]);
    assert.deepStrictEqual(termos(v("Placa de rede com bluetooth.", fRede)), ["bluetooth"], "em minúscula vira termo");
    for (const [t, esperados] of [
      ["Produto com forro térmico.", ["forro", "termico"]],
      ["Produto com proteção UV.", ["protecao"]],
    ]) assert.deepStrictEqual(termos(v(t, fAlg)).filter((x) => esperados.includes(x)), esperados, t);
    // contexto fraco não vence fato estruturado: Nike na descrição atual com BRAND = Lumi
    const fNike = fx([{ id: "MATERIAL", name: "Material", value: "Algodão" }], { desc: "Produto de algodão no estilo da Nike, para o dia a dia." });
    assert.ok(codigos(v("Produto Lumi da marca Nike.", fNike)).includes("MARCA_CONFLITANTE"));
    // nome já apontado não vira também TERMO (um problema, um código)
    assert.deepStrictEqual(codigos(v("Produto da marca Adidas.", fAlg)), ["MARCA_CONFLITANTE"]);
    // determinístico
    assert.strictEqual(JSON.stringify(v("Contém óleo de coco e manteiga de karité.", fOleo)),
      JSON.stringify(v("Contém óleo de coco e manteiga de karité.", fOleo)));
    ok("22. grounding A–G: termo dos fatos/contexto passa; karité, couro legítimo, impermeável, forro térmico → TERMO_NAO_COMPROVADO");
  }

  // 23 ─ F7A.2: vocabulário genérico seguro
  {
    const f = engine.montarFicha({ titulo: "Bermuda Infantil Lumi", attributes_json: [
      { id: "BRAND", name: "Marca", value: "Lumi" }, { id: "MATERIAL", name: "Material", value: "Algodão" },
      { id: "WITH_POCKETS", name: "Com bolsos", value: "Sim" }, { id: "GENDER", name: "Gênero", value: "Meninos" },
    ] }, { categoriaNome: "Bermudas", descricaoEstado: "sem_descricao" });
    for (const t of [
      "Este produto possui bolsos.",
      "É indicado para meninos.",
      "A embalagem acompanha uma unidade.",
      "Pode ser utilizado por meninos.",
      "Bermuda infantil Lumi, feita em algodão, com bolsos. Ideal para meninos.",
    ]) {
      const r = engine.validarDescricao(t, [], f);
      assert.strictEqual(r.valida, true, t + " → " + JSON.stringify(r.problemas));
    }
    // F7A.10: subjetivo leve da lista fechada passa; claim objetivo continua barrado
    assert.strictEqual(engine.validarDescricao("Bermuda com design elegante e visual moderno.", [], f).valida, true);
    for (const w of ["premium", "confortavel", "resistente", "duravel", "impermeavel", "antiderrapante", "macio", "leve",
      "pratico", "seguro", "qualidade", "profissional", "original", "compativel", "karite"]) {
      assert.ok(!engine.VOCABULARIO_SUBJETIVO.includes(w), "subjetivo não pode virar claim objetivo: " + w);
    }
    for (const [t, termo] of [
      ["Bermuda de alta durabilidade.", "durabilidade"],
      ["Bermuda com máximo conforto.", "conforto"],
      ["Bermuda de material premium.", "premium"],
    ]) {
      const r = engine.validarDescricao(t, [], f);
      const p = (r.problemas || []).find((x) => x.codigo === "TERMO_NAO_COMPROVADO");
      assert.ok(p && p.termos.includes(termo), t + " → " + JSON.stringify(r.problemas));
    }
    const genericas = new Set(engine.PALAVRAS_FUNCIONAIS.concat(engine.VOCABULARIO_NEUTRO));
    for (const w of ["premium", "confortavel", "resistente", "duravel", "elegante", "moderno", "profissional",
      "karite", "impermeavel", "antiderrapante", "macio", "leve", "pratico", "seguro", "qualidade", "design"]) {
      assert.ok(!genericas.has(w), "lista genérica não pode criar característica: " + w);
    }
    assert.ok(engine.VOCABULARIO_NEUTRO.length <= 64, "lista neutra pequena e explícita (F7A.10: + títulos destaque/benefício)");
    ok("23. frases neutras passam; elegante/durabilidade/conforto/premium sem fato não; listas genéricas sem adjetivo de característica");
  }

  // 24 ─ F7A.2: IDs exatos no prompt, sem alias no backend
  {
    const f = ficha();
    const p = engine.montarPrompt(f);
    assert.ok(p.includes("IDS VÁLIDOS PARA fatosUsados"));
    assert.ok(/COPIE EXATAMENTE/.test(p) && p.includes('nunca "category"') && p.includes('nunca "attr:BRAND"'));
    const bloco = p.slice(p.indexOf("IDS VÁLIDOS"), p.indexOf("Responda SOMENTE"));
    for (const id of f.idsConhecidos) assert.ok(bloco.includes("\n- " + id + "\n"), "faltou id na lista: " + id);
    for (const ruim of ["category", "attr:BRAND", "brnad", "attr:color"]) {
      const v = valida(BOA, f, ["brand", ruim]);
      assert.deepStrictEqual(codigos(v), ["FATO_DESCONHECIDO"], ruim);
      assert.deepStrictEqual(v.problemas[0].termos, [ruim]);
    }
    ok("24. prompt lista os IDs válidos (copiar exatamente); category/attr:BRAND/brnad/attr:color seguem FATO_DESCONHECIDO");
  }

  // 25 ─ F7A.2: logística
  {
    const f = ficha();
    for (const t of [
      "Tênis Molekinho. No máximo 1 unidade por pedido.",
      "É possível enviar no máximo 01 unidade por pedido.",
      "Envio em até 24 horas.",
      "Frete grátis.",
      "Consulte o prazo de entrega.",
      "Tênis despachado pela transportadora.",
      "O tênis será enviado em caixa.",
    ]) assert.ok(codigos(valida(t, f)).includes("LINGUAGEM_PROIBIDA"), t + " → " + codigos(valida(t, f)));
    const fRelogio = engine.montarFicha({ titulo: "Relógio Lumi", attributes_json: [
      { id: "BRAND", name: "Marca", value: "Lumi" }, { id: "FEATURES", name: "Funções", value: "Enviar mensagens, pedido de ajuda" },
    ] }, { categoriaNome: "Relógios", descricaoEstado: "sem_descricao" });
    for (const t of ["O relógio permite enviar mensagens.", "Tem função de pedido de ajuda."]) {
      assert.ok(!codigos(engine.validarDescricao(t, [], fRelogio)).includes("LINGUAGEM_PROIBIDA"), t);
    }
    ok("25. logística (por pedido, enviar no máximo, envio, frete, prazo, transportadora) → LINGUAGEM_PROIBIDA; 'enviar mensagens' não");
  }

  // 26 ─ F7C (substitui F7A.3/F7A.10/F7A.11): padrão operacional, FATOS × COPY
  {
    const f = ficha();
    const p = engine.montarPrompt(f);
    const ordem = ["DESCRIÇÃO PRINCIPAL", "DESTAQUES DO PRODUTO", "COMO USAR", "ESPECIFICAÇÕES", "BENEFÍCIOS", "EXPERIÊNCIA DE COMPRA"]
      .map((s) => p.indexOf("  " + s + "\n"));
    assert.ok(ordem.every((x, i) => x > 0 && (i === 0 || x > ordem[i - 1])), "6 blocos na ordem do padrão operacional");
    assert.ok(p.includes("4 a 7 linhas curtas") && p.includes("Pirâmide invertida") && p.includes("começam com \"* \""));
    assert.ok(p.includes("desta lista: " + engine.VOCABULARIO_SUBJETIVO.join(", ")), "subjetivo é lista fechada no prompt");
    assert.ok(p.includes("\"Possui bolsos\" → \"Mais praticidade no dia a dia\""), "exemplo de benefício do usuário");
    assert.ok(/PROIBIDO em qualquer bloco, se não houver fato que comprove: impermeável, resistente, durável, hipoalergênico, proteção UV/.test(p));
    assert.ok(/NUNCA afirme envio rápido, frete, prazo, garantia, devolução, troca, originalidade, qualidade garantida/.test(p));
    assert.ok(p.includes("Tamanho: entre 640 e 2000 caracteres"), "faixa F7C");
    assert.deepStrictEqual(f.alvo, { min: 800, max: 2000 }, "ficha.alvo não muda");
    ok("26. prompt F7C: 6 blocos do padrão operacional, bullets \"* \", subjetivo só da lista, claims e logística proibidos, copy com benefício real");
  }

  // 27 ─ F7A.4: morfologia conservadora no grounding
  {
    const f = engine.montarFicha({ titulo: "Peça Lumi", attributes_json: [
      { id: "BRAND", name: "Marca", value: "Lumi" },
      { id: "WEDGE_SHAPE", name: "Forma de caimento", value: "Reta" },
      { id: "HAND_STRAPS_COLOR", name: "Cor das alças", value: "Dourado" },
      { id: "MAIN_COLOR", name: "Cor principal", value: "Multicolorido" },
      { id: "AGE_GROUP", name: "Idade", value: "Adultos" },
      { id: "IS_REINFORCED", name: "É reforçada", value: "Sim" },
      { id: "IS_HANGABLE", name: "É pendurável", value: "Sim" },
      { id: "SALE_FORMAT", name: "Formato de venda", value: "Unidade" },
      { id: "INCLUDES_KIT", name: "Inclui kit de instalação", value: "Sim" },
      { id: "WEIGHT", name: "Peso", value: "15 kg" },
      { id: "COMPOSITION", name: "Composição", value: "100% algodão" },
      { id: "WITH_POCKETS", name: "Com bolsos", value: "Sim" },
      { id: "TOP_MATERIAL", name: "Material do tampo", value: "MDF" },
    ] }, { categoriaNome: "Roupas", descricaoEstado: "sem_descricao" });
    const termos = (t) => engine.termosNaoComprovados(t, f);
    // gênero e particípios derivados de termos autorizados passam
    for (const t of [
      "Caimento reto.", "Alças douradas.", "Cor multicolorida.", "Para pessoa adulta.", "Peça reforçado.",
      "Vendida por unidade.", "Pode ser pendurada.", "Kit de instalação incluído.", "Pesando 15 kg.",
      "Composto por 100% algodão.",
    ]) assert.deepStrictEqual(termos(t).filter((k) => k !== "pessoa"), [], t + " → " + termos(t));
    // não afrouxa: pares de sentido distinto, base nova liberada por derivada, contexto fraco, invenção
    assert.deepStrictEqual(termos("Possui bolsa."), ["bolsa"], "bolso ≠ bolsa");
    assert.deepStrictEqual(termos("Com tampa."), ["tampa"], "tampo ≠ tampa");
    assert.deepStrictEqual(termos("Pode ser vendedor."), ["vendedor"], "venda não libera vendedor");
    assert.deepStrictEqual(termos("Manteiga de karité."), ["manteiga", "karite"]);
    assert.deepStrictEqual(termos("Peça confortável e resistente."), ["confortavel", "resistente"]);
    const fFraca = engine.montarFicha({ titulo: "Bermuda reta Lumi", attributes_json: [{ id: "BRAND", name: "Marca", value: "Lumi" }, { id: "COLOR", name: "Cor", value: "Azul" }] },
      { descricaoEstado: "sem_descricao" });
    assert.deepStrictEqual(engine.termosNaoComprovados("Bermuda de caimento reto.", fFraca), ["caimento", "reto"],
      "gênero só contra valor estruturado, nunca contra o título");
    ok("27. morfologia: reto/dourada/multicolorida/adulta/reforçado/vendida/pendurada/incluído/pesando/composto passam; bolsa, tampa, vendedor, karité não");
  }

  // 28 ─ F7A.4: conflito explícito entre atributo e título/descrição atual
  {
    const regata = engine.montarFicha({ titulo: "Kit 2 Regata Infantil Lumi Sem Manga", attributes_json: [
      { id: "BRAND", name: "Marca", value: "Lumi" },
      { id: "SLEEVE_TYPE", name: "Tipo de manga", value: "Curta" },
      { id: "FABRIC_TYPE", name: "Tipo de tecido", value: "Algodão" },
    ] }, { categoriaNome: "Camisetas e Regatas", descricaoAtual: "Regata infantil. Manga: Sem mangas.", descricaoEstado: "ok" });
    assert.deepStrictEqual(regata.conflitos.map((c) => [c.id, c.tipo, c.fonte]), [["attr:SLEEVE_TYPE", "NEGACAO", "titulo"]]);
    assert.ok(!regata.fatos.some((x) => x.id === "attr:SLEEVE_TYPE"), "fato conflitante sai da ficha");
    assert.ok(!regata.idsConhecidos.has("attr:SLEEVE_TYPE"));
    const p = engine.montarPrompt(regata);
    assert.ok(p.includes("DADOS CONFLITANTES") && p.includes("- Tipo de manga") && !p.includes("Tipo de manga: Curta"));
    const cod = (t) => codigos(engine.validarDescricao(t, ["brand"], regata));
    assert.ok(cod("Regata infantil Lumi com manga curta.").includes("CONFLITO_DE_FONTES"));
    assert.ok(cod("Regata infantil Lumi sem manga.").includes("CONFLITO_DE_FONTES"), "negar também é escolher vencedor");
    assert.deepStrictEqual(cod("Kit com 2 regatas infantis Lumi de algodão."), []);

    const lixeira = engine.montarFicha({ titulo: "Kit 2 Lixeira Lumi 120 Litros", attributes_json: [
      { id: "BRAND", name: "Marca", value: "Lumi" },
      { id: "VOLUME_CAPACITY", name: "Capacidade em volume", value: "240 L" },
      { id: "HEIGHT", name: "Altura", value: "98 cm" },
      { id: "SELLER_PACKAGE_WEIGHT", name: "Peso da embalagem", value: "2500 g" },
    ] }, { categoriaNome: "Lixeiras", descricaoEstado: "sem_descricao" });
    assert.deepStrictEqual(lixeira.conflitos.map((c) => [c.id, c.tipo, c.numeros]), [["attr:VOLUME_CAPACITY", "MEDIDA", ["240", "120"]]]);
    for (const t of ["Lixeira Lumi de 240 litros.", "Lixeira Lumi de 120 litros."]) {
      assert.ok(codigos(engine.validarDescricao(t, [], lixeira)).includes("CONFLITO_DE_FONTES"), t);
    }
    assert.deepStrictEqual(codigos(engine.validarDescricao("Kit com 2 lixeiras Lumi com 98 cm de altura.", [], lixeira)), []);
    // caso real: atributo de TEXTO citando "240 Litros" não tira a unicidade;
    // "58 Kg (lixo)" na descrição não é o Peso; "Capacidade: 120 L" é a capacidade
    const lixeiraReal = engine.montarFicha({ titulo: "Kit 2 Lixeira Lumi Com Rodas 120 Litros", attributes_json: [
      { id: "BRAND", name: "Marca", value: "Lumi" },
      { id: "MANUAL_TITLE", name: "Título manual", value: "Lixeira Grande Com Rodas 240 Litros" },
      { id: "VOLUME_CAPACITY", name: "Capacidade em volume", value: "240 L" },
      { id: "WEIGHT", name: "Peso", value: "10 kg" },
    ] }, { descricaoAtual: "Contêiner com rodas. Capacidade: 120 L / 58 Kg (lixo).", descricaoEstado: "ok" });
    assert.deepStrictEqual(lixeiraReal.conflitos.map((c) => [c.id, c.fonte]),
      [["attr:VOLUME_CAPACITY", "titulo"], ["attr:VOLUME_CAPACITY", "descricao_atual"]]);
    assert.ok(lixeiraReal.fatos.some((x) => x.id === "attr:WEIGHT"), "peso não conflita com carga de lixo");
    assert.deepStrictEqual(codigos(engine.validarDescricao("Lixeira Lumi, modelo C240p, com rodas.", [], lixeiraReal)).filter((c) => c === "CONFLITO_DE_FONTES"), [],
      "'240' dentro do código do modelo não é a capacidade");
    assert.ok(codigos(engine.validarDescricao("Lixeira Lumi de 240L.", [], lixeiraReal)).includes("CONFLITO_DE_FONTES"));

    // sem contradição explícita, nada muda
    const semConflito = [
      engine.montarFicha({ titulo: "Lixeira 240 Litros Lumi", attributes_json: [{ id: "VOLUME_CAPACITY", name: "Capacidade em volume", value: "240 L" }] }, {}),
      engine.montarFicha({ titulo: "Mesa 120 cm Lumi", attributes_json: [{ id: "WIDTH", name: "Largura", value: "60 cm" }, { id: "LENGTH", name: "Comprimento", value: "120 cm" }] }, {}),
      engine.montarFicha({ titulo: "Mesa Lumi 100 cm", attributes_json: [{ id: "WIDTH", name: "Largura", value: "60 cm" }, { id: "LENGTH", name: "Comprimento", value: "120 cm" }] }, {}),
      engine.montarFicha({ titulo: "Regata Sem Manga", attributes_json: [{ id: "SLEEVE_TYPE", name: "Tipo de manga", value: "Sem manga" }] }, {}),
      engine.montarFicha({ titulo: "Placa sem embalagem", attributes_json: [{ id: "SELLER_PACKAGE_TYPE", name: "Tipo da embalagem", value: "Com embalagem adicional" }] }, {}),
      engine.montarFicha({ titulo: "Regata Lumi", attributes_json: [{ id: "GARMENT_TYPE", name: "Tipo de roupa", value: "Camiseta" }] }, {}),
    ];
    for (const fx of semConflito) assert.deepStrictEqual(fx.conflitos, [], fx.tituloAtual);

    // gerarDescricao sinaliza o conflito (sem alterar o dado original)
    const an = { titulo: "Kit 2 Regata Infantil Lumi Sem Manga", attributes_json: [
      { id: "BRAND", name: "Marca", value: "Lumi" }, { id: "SLEEVE_TYPE", name: "Tipo de manga", value: "Curta" },
      { id: "FABRIC_TYPE", name: "Tipo de tecido", value: "Algodão" }] };
    const antes = JSON.stringify(an);
    const fr = engine.montarFicha(an, { descricaoEstado: "sem_descricao" });
    assert.strictEqual(JSON.stringify(an), antes, "dado original intacto");
    const r = await engine.gerarDescricao({ ficha: fr, aiProvider: provider({ ok: true, data: { descricao: "Kit com 2 regatas infantis Lumi, de algodão.", fatosUsados: ["brand", "attr:FABRIC_TYPE"] } }) });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual(r.conflitos, [{ id: "attr:SLEEVE_TYPE", label: "Tipo de manga", value: "Curta", fonte: "titulo", trecho: "Sem Manga" }]);
    ok("28. conflito explícito (sem <assunto> × atributo; medida única × contexto) → fato omitido, prompt avisa, CONFLITO_DE_FONTES, resposta sinaliza");
  }

  // 30 ─ F7A.5: medidas da mesma grandeza comparadas na unidade-base
  {
    const fx = (titulo, attrs, desc) => engine.montarFicha({ titulo, attributes_json: [{ id: "BRAND", name: "Marca", value: "Lumi" }].concat(attrs) },
      desc ? { descricaoAtual: desc, descricaoEstado: "ok" } : { descricaoEstado: "sem_descricao" });
    const taxa = { id: "DATA_TRANSFER_RATE", name: "Taxa de transferência de dados", value: "2.4 Gbps" };
    // placa: "Gigabit" (= 1000 Mbps) no título × 2.4 Gbps no atributo
    let f = fx("Placa Rede Gigabit 10/100/1000 Pci Express Lumi", [taxa]);
    assert.deepStrictEqual(f.conflitos.map((c) => [c.id, c.tipo, c.fonte, c.trecho]), [["attr:DATA_TRANSFER_RATE", "MEDIDA", "titulo", "gigabit"]]);
    assert.ok(!f.fatos.some((x) => x.id === "attr:DATA_TRANSFER_RATE"));
    for (const t of ["Placa de rede Lumi com taxa de 2.4 Gbps.", "Placa de rede Lumi Gigabit."]) {
      assert.ok(codigos(engine.validarDescricao(t, [], f)).includes("CONFLITO_DE_FONTES"), t);
    }
    // lista "10/100/1000Mbps" com rótulo antes, na descrição
    f = fx("Placa de rede Lumi", [taxa], "Taxa de transferência: 10/100/1000Mbps.");
    assert.deepStrictEqual(f.conflitos.map((c) => [c.fonte, c.numeros]), [["descricao_atual", ["2.4", "10", "100", "1000"]]]);
    // conversões que CONCORDAM não são conflito
    for (const [titulo, attr] of [
      ["Placa Rede Gigabit Lumi", { ...taxa, value: "1000 Mbps" }],
      ["Placa Rede Lumi 1 Gbps", { ...taxa, value: "1000 Mbps" }],
      ["Mesa Lumi 22 kg", { id: "WEIGHT", name: "Peso", value: "22000 g" }],
      ["Garrafa Lumi 1,5 Litros", { id: "VOLUME_CAPACITY", name: "Capacidade", value: "1500 ml" }],
      ["Bandeira Lumi 150 cm", { id: "LENGTH", name: "Comprimento", value: "1.5 m" }],
    ]) assert.deepStrictEqual(fx(titulo, [attr]).conflitos, [], titulo);
    // mesma grandeza, valor diferente: conflito também entre unidades
    assert.strictEqual(fx("Mesa Lumi 25 kg", [{ id: "WEIGHT", name: "Peso", value: "22000 g" }]).conflitos.length, 1);
    // duas medidas da mesma grandeza no produto (peso e carga): não decide
    assert.deepStrictEqual(fx("Mesa Lumi 60 kg", [{ id: "WEIGHT", name: "Peso", value: "15 kg" }, { id: "WEIGHT_CAPACITY", name: "Capacidade em peso", value: "50 kg" }]).conflitos, []);
    ok("30. grandezas: Gigabit×2.4 Gbps e 10/100/1000Mbps×2.4 Gbps → conflito; 22 kg=22000 g, 1,5 L=1500 ml, 150 cm=1,5 m concordam");
  }

  // 31 ─ F7A.5: atributos sem autoridade de fato
  {
    const f = engine.montarFicha({ titulo: "Bandeira Flâmula Lumi Casa Bolton", attributes_json: [
      { id: "BRAND", name: "Marca", value: "Lumi" },
      { id: "MATERIAL", name: "Material", value: "Poliéster" },
      { id: "RECOMMENDED_USES", name: "Usos recomendados", value: "Fãs,Admiradores do universo de Tolkien" },
      { id: "MANUAL_TITLE", name: "Título manual", value: "Bandeira Grande 240 Litros" },
      { id: "GIFTABLE", name: "Regalavel", value: "vppfull" },
      { id: "SIZE_GRID_ID", name: "ID da guia de tamanhos", value: "1431751" },
    ] }, { descricaoEstado: "sem_descricao" });
    for (const id of ["RECOMMENDED_USES", "MANUAL_TITLE", "GIFTABLE", "SIZE_GRID_ID"]) {
      assert.ok(!f.fatos.some((x) => x.id === "attr:" + id) && !f.idsConhecidos.has("attr:" + id), id);
    }
    const p = engine.montarPrompt(f);
    assert.ok(!/Tolkien|vppfull|240 Litros|1431751/.test(p), "não vão ao prompt");
    assert.ok(!f.vocabularioAutorizado.has("tolkien") && !f.numerosPermitidos.has("240"));
    assert.ok(codigos(engine.validarDescricao("Bandeira Lumi para fãs do universo de Tolkien.", [], f)).includes("NOME_NAO_COMPROVADO"));
    ok("31. MANUAL_TITLE/RECOMMENDED_USES/GIFTABLE/ids internos não são fato: fora do prompt, do vocabulário e dos números");
  }

  // 32 ─ F7A.5: alternativas nomeadas pela categoria
  {
    const fx = (titulo, categoria, attrs) => engine.montarFicha({ titulo, attributes_json: [{ id: "BRAND", name: "Marca", value: "Lumi" }].concat(attrs) },
      { categoriaNome: categoria, descricaoEstado: "sem_descricao" });
    const tipo = (v) => ({ id: "GARMENT_TYPE", name: "Tipo de roupa", value: v });
    const f = fx("Kit 2 Regata Infantil Lumi Sem Manga", "Camisetas e Regatas", [tipo("Camiseta"), { id: "MAIN_MATERIAL", name: "Material principal", value: "Algodão" }]);
    assert.deepStrictEqual(f.conflitos.map((c) => [c.id, c.tipo, c.chaves]), [["attr:GARMENT_TYPE", "ALTERNATIVA", ["camiseta", "regata"]]]);
    assert.ok(!f.fatos.some((x) => x.id === "attr:GARMENT_TYPE"));
    for (const t of ["Camiseta infantil Lumi de algodão.", "Regata infantil Lumi de algodão."]) {
      assert.ok(codigos(engine.validarDescricao(t, [], f)).includes("CONFLITO_DE_FONTES"), t);
    }
    assert.ok(!codigos(engine.validarDescricao("Kit infantil Lumi de algodão.", [], f)).includes("CONFLITO_DE_FONTES"));
    // sem contradição
    for (const [titulo, cat, v] of [
      ["Shorts Jeans Lumi", "Bermudas e Shorts", "Short"],
      ["Jaqueta Lumi", "Casacos e Jaquetas", "Jaqueta"],
      ["Camiseta Regata Lumi", "Camisetas e Regatas", "Camiseta"],
      ["Blusa Lumi", "Camisetas e Regatas", "Camiseta"],
      ["Regata Lumi", "Cestos de Papéis", "Camiseta"],
    ]) assert.deepStrictEqual(fx(titulo, cat, [tipo(v)]).conflitos, [], titulo + " / " + cat);
    ok("32. categoria 'Camisetas e Regatas': atributo Camiseta × título Regata → conflito, as duas palavras bloqueadas; sem alternativa no título, nada");
  }

  // 33 ─ F7A.6: falsos positivos restantes
  {
    // neutras: medida / dimensões / disponível
    const fBolsa = engine.montarFicha({ titulo: "Clutch Lumi", attributes_json: [
      { id: "BRAND", name: "Marca", value: "Lumi" }, { id: "WIDTH", name: "Largura", value: "18 cm" },
      { id: "VOLTAGE", name: "Voltagem", value: "127 V / 220 V" }] }, { descricaoEstado: "sem_descricao" });
    for (const t of ["Medidas: 18 cm de largura.", "Dimensões: 18 cm de largura.", "Disponível em 127 ou 220 V."]) {
      assert.strictEqual(engine.validarDescricao(t, [], fBolsa).valida, true, t + " → " + JSON.stringify(engine.validarDescricao(t, [], fBolsa).problemas));
    }

    // negação em lista
    const fMesa = engine.montarFicha({ titulo: "Escrivaninha Lumi", attributes_json: [
      { id: "BRAND", name: "Marca", value: "Lumi" }, { id: "MATERIAL", name: "Material", value: "MDF" },
      { id: "WITH_DOORS", name: "Com portas", value: "Não" }, { id: "WITH_DRAWERS", name: "Com gavetas", value: "Não" },
      { id: "WITH_SHELVES", name: "Com prateleiras", value: "Não" }, { id: "WITH_WHEELS", name: "Com rodas", value: "Não" },
      { id: "IS_WATERPROOF", name: "É impermeável", value: "Não" }, { id: "WITH_ZIPPER", name: "Com zíper", value: "Não" },
    ] }, { descricaoEstado: "sem_descricao" });
    const proib = (t) => ((engine.validarDescricao(t, [], fMesa).problemas || []).find((p) => p.codigo === "ATRIBUTO_PROIBIDO") || {}).termos || [];
    for (const t of [
      "Escrivaninha em MDF. Não possui portas, gavetas, prateleiras e rodas.",
      "Escrivaninha em MDF. Não possui portas, gavetas, prateleiras ou rodas.",
      "Escrivaninha em MDF, sem portas, gavetas nem rodas.",
      "Escrivaninha em MDF. Não tem portas e gavetas.",
    ]) assert.deepStrictEqual(proib(t), [], t);
    // a lista para quando abre outra oração: o que vem depois é afirmação
    assert.deepStrictEqual(proib("Escrivaninha sem portas e com rodas."), ["rodas"]);
    assert.deepStrictEqual(proib("Escrivaninha sem gavetas, mas tem prateleiras."), ["prateleiras"]);
    assert.deepStrictEqual(proib("Não desbota e é impermeável."), ["impermeável"]);
    assert.deepStrictEqual(proib("Não possui portas. Tem rodas."), ["rodas"], "negação não atravessa a frase");
    assert.deepStrictEqual(proib("Escrivaninha com portas e gavetas."), ["portas", "gavetas"]);

    // "lançamento": rótulo exato de fato estruturado passa; claim solto não
    const fShort = engine.montarFicha({ titulo: "Short Jeans Lumi", attributes_json: [
      { id: "BRAND", name: "Marca", value: "Lumi" },
      { id: "RELEASE_SEASON", name: "Temporada de lançamento", value: "Primavera/Verão" },
      { id: "RELEASE_YEAR", name: "Ano de lançamento", value: "2026" },
    ] }, { descricaoEstado: "sem_descricao" });
    const ling = (t) => codigos(engine.validarDescricao(t, [], fShort)).includes("LINGUAGEM_PROIBIDA");
    assert.strictEqual(ling("Short jeans Lumi. Temporada de lançamento Primavera/Verão, ano de lançamento 2026."), false);
    for (const t of ["Short jeans Lumi, lançamento 2026.", "Lançamento: short jeans Lumi.", "Short jeans Lumi, o lançamento da temporada."]) {
      assert.strictEqual(ling(t), true, t);
    }
    const semRotulo = engine.montarFicha({ titulo: "Short Lumi", attributes_json: [{ id: "BRAND", name: "Marca", value: "Lumi" }, { id: "COLOR", name: "Cor", value: "Azul" }] }, {});
    assert.ok(codigos(engine.validarDescricao("Short Lumi azul. Temporada de lançamento.", [], semRotulo)).includes("LINGUAGEM_PROIBIDA"));

    // nome/linha exato do título
    const fCond = engine.montarFicha({ titulo: "Condicionador Hawaiian Coconut Pinapow 280ml", attributes_json: [
      { id: "BRAND", name: "Marca", value: "Akla Cosméticos" }, { id: "HAIR_TYPES", name: "Tipos de cabelo", value: "Lisos" }] },
    { descricaoEstado: "sem_descricao" });
    const nomes = (t, f = fCond) => codigos(engine.validarDescricao(t, [], f)).filter((c) => c === "MARCA_CONFLITANTE" || c === "NOME_NAO_COMPROVADO");
    assert.deepStrictEqual(nomes("Condicionador Hawaiian Coconut PinaPow, da Akla Cosméticos, para cabelos lisos."), []);
    assert.deepStrictEqual(nomes("Hawaiian Coconut PinaPow é um condicionador para cabelos lisos."), []);
    assert.deepStrictEqual(nomes("Condicionador Hawaiian, da Akla Cosméticos."), ["NOME_NAO_COMPROVADO"], "palavra isolada do título não");
    assert.ok(nomes("Condicionador da marca Hawaiian Coconut.").includes("MARCA_CONFLITANTE"), "posição de marca segue conflito");
    assert.deepStrictEqual(nomes("Condicionador Hawaiian Coconut Tropical."), ["NOME_NAO_COMPROVADO"], "palavra fora do título");
    const fNike = engine.montarFicha({ titulo: "Tênis Molekinho Infantil Estilo Nike Air", attributes_json: [
      { id: "BRAND", name: "Marca", value: "Molekinho" }, { id: "GENDER", name: "Gênero", value: "Meninos" }] }, { descricaoEstado: "sem_descricao" });
    for (const t of ["Tênis Molekinho infantil Nike Air.", "Tênis Molekinho no estilo Nike Air.", "Tênis da Nike Air."]) {
      assert.ok(nomes(t, fNike).length, t + " → referência a outro produto no título não autoriza");
    }
    ok("33. medida/dimensão/disponível neutras; negação em lista nega todos (e para em outra oração); rótulo 'Temporada de lançamento' passa, claim não; nome 2+ palavras exato do título passa");
  }

  // 29 ─ F7A.4: metatexto evitado no prompt, mas NÃO liberado no grounding
  {
    const p = engine.montarPrompt(ficha());
    assert.ok(p.includes("nunca do anúncio ou da página") && p.includes("\"confira\""));
    const t = engine.termosNaoComprovados("Confira o anúncio antes de escolher.", ficha());
    for (const k of ["confira", "anuncio", "escolher"]) assert.ok(t.includes(k), k);
    ok("29. prompt pede para não falar do anúncio/página; 'confira'/'anúncio' seguem TERMO_NAO_COMPROVADO");
  }

  // extra ─ cópia da ficha técnica (F7A.7: só o despejo sem introdução)
  {
    const despejo = "Tênis Molekinho\n- Marca: Molekinho\n- Cor: Azul Marinho\n- Gênero: Meninos\n- Tipo de fechamento: Cadarço";
    assert.ok(codigos(valida(despejo)).includes("COPIA_FICHA_TECNICA"));
    const comIntro = "Tênis Molekinho\n\nTênis infantil Molekinho para meninos.\n\nEspecificações:\n- Marca: Molekinho\n- Cor: Azul Marinho\n- Gênero: Meninos\n- Tipo de fechamento: Cadarço";
    assert.ok(!codigos(valida(comIntro)).includes("COPIA_FICHA_TECNICA"));
    ok("extra. 4+ linhas 'Rótulo: valor' SEM introdução → COPIA_FICHA_TECNICA; com introdução é o formato F7A.7");
  }

  // 34 ─ F7A.7: formato em seções + itens
  {
    const f = ficha();
    const p = engine.montarPrompt(f);
    // F7C: prompt no padrão operacional; o validador segue aceitando o formato F7A.7–F7A.12
    for (const s of ["DESCRIÇÃO PRINCIPAL", "ESPECIFICAÇÕES", "EXPERIÊNCIA DE COMPRA"]) assert.ok(p.includes(s), s);
    assert.ok(p.includes("NUNCA escreva um título sem conteúdo embaixo") && p.includes("asterisco e espaço"));
    assert.ok(!p.includes("frases corridas") && !p.includes("nem bloco \"ESPECIFICAÇÕES\""), "regra antiga contra lista removida");
    const estruturada = [
      "Tênis Infantil Molekinho",
      "",
      "Tênis infantil Molekinho para meninos, com fechamento por cadarço.",
      "",
      "Especificações:",
      "- Material principal: sintético",
      "- Cor: azul marinho",
      "- Com luzes",
      "- Não é impermeável",
      "",
      "Dimensões:",
      "- Solado com 2 cm de altura",
    ].join("\n");
    const v = engine.validarDescricao(estruturada, ["brand", "attr:MAIN_MATERIAL", "attr:COLOR"], f);
    assert.strictEqual(v.valida, true, JSON.stringify(v.problemas));
    // seção sem itens
    const vazia = engine.validarDescricao(estruturada + "\n\nConteúdo da embalagem:\n\nObservações:\n- Não é impermeável", [], f);
    assert.deepStrictEqual([codigos(vazia), vazia.problemas[0].termos], [["SECAO_VAZIA"], ["Conteúdo da embalagem"]]);
    // o grounding vale dentro dos itens
    assert.ok(codigos(engine.validarDescricao(estruturada + "\n- Palmilha de couro legítimo", [], f)).includes("TERMO_NAO_COMPROVADO"));
    assert.ok(codigos(engine.validarDescricao(estruturada + "\n- Garantia de 90 dias", [], f)).includes("LINGUAGEM_PROIBIDA"));
    ok("34. formato nome + introdução + seções com itens '-' passa; seção vazia → SECAO_VAZIA; grounding e linguagem valem nos itens");
  }

  // 35 ─ F7A.8: itens seletivos
  {
    const extras = anuncio().attributes_json.concat([
      { id: "MAIN_COLOR", name: "Cor principal", value: "Azul Marinho" },
      { id: "MANUFACTURER", name: "Fabricante", value: "Molekinho" },
      { id: "SELLER_PACKAGE_WEIGHT", name: "Peso da embalagem do vendor", value: "300 g" },
      { id: "WITH_VIRTUAL_TRY_ON", name: "Com provador virtual", value: "Sim" },
      { id: "PATTERN_NAME", name: "Nome do desenho", value: "Não listado" },
      { id: "UNITS_PER_PACK", name: "Unidades por kit", value: "1" },
      { id: "STRUCTURE_MATERIALS", name: "Materiais da estrutura", value: "Plástico" },
      { id: "LID_MATERIAL", name: "Material da tampa", value: "Plástico" },
      { id: "DOORS_NUMBER", name: "Quantidade de portas", value: "0" },
    ]);
    const f = ficha({ attributes_json: extras }, { descricaoAtual: DESC_ATUAL + " Solado: borracha. Produto original, com qualidade e durabilidade." });
    const oculto = (id) => (f.fatos.find((x) => x.id === id) || {}).oculto;
    assert.deepStrictEqual(
      ["attr:MAIN_COLOR", "attr:MANUFACTURER", "attr:SELLER_PACKAGE_WEIGHT", "attr:WITH_VIRTUAL_TRY_ON", "attr:PATTERN_NAME", "attr:UNITS_PER_PACK"].map(oculto),
      ["REDUNDANTE", "REDUNDANTE", "EMBALAGEM", "PLATAFORMA", "SEM_INFORMACAO", "PLATAFORMA"]);
    assert.deepStrictEqual([oculto("attr:STRUCTURE_MATERIALS"), oculto("attr:LID_MATERIAL"), oculto("attr:COLOR")], [undefined, undefined, undefined],
      "partes diferentes com o mesmo valor ficam as duas; 'Cor' fica e 'Cor principal' sai");
    // valor 0 = não tem: vira proibido, sai dos fatos e o 0 segue permitido
    assert.ok(!f.fatos.some((x) => x.id === "attr:DOORS_NUMBER"));
    assert.ok(f.proibidos.some((p) => p.id === "attr:DOORS_NUMBER" && p.exibir.includes("portas")));
    assert.ok(f.numerosPermitidos.has("0"));
    // prompt: só listáveis; categoria vai para o contexto
    const p = engine.montarPrompt(f);
    for (const s of ["Cor principal", "Fabricante", "Peso da embalagem", "provador", "Nome do desenho", "Unidades por kit"]) assert.ok(!p.includes(s), "não listável no prompt: " + s);
    assert.ok(p.indexOf("[categoria]") > p.indexOf("CONTEXTO ("), "categoria fora dos FATOS");
    assert.ok(p.includes("Nunca invente rótulo") && p.includes("recomendamos"));

    const base = (intro, itens) => ["Tênis Infantil Molekinho", "", intro, "", "Especificações:", ...itens].join("\n");
    const intro = "Tênis infantil da marca Molekinho.";
    const v = (itens, i = intro, ff = f) => engine.validarDescricao(base(i, itens), [], ff);
    const termos = (r, c) => ((r.problemas || []).find((x) => x.codigo === c) || {}).termos;
    // rótulos reais (inclusive encurtados e da descrição atual) passam
    const boa = v(["- Fechamento: cadarço", "- Cor: azul marinho", "- Material da tampa: plástico", "- Solado: borracha", "- Possui luzes", "- Quantidade de portas: 0"]);
    assert.strictEqual(boa.valida, true, JSON.stringify(boa.problemas));
    // rótulo inventado / irrelevante
    const r1 = v(["- Tipo: Tênis", "- Voltagem: 220 V", "- Categoria: Tênis", "- Peso da embalagem: 300 g", "- Cor principal: azul marinho"]);
    assert.deepStrictEqual(termos(r1, "ROTULO_INVENTADO"), ["Tipo", "Voltagem"]);
    assert.deepStrictEqual(termos(r1, "ITEM_IRRELEVANTE"), ["Categoria", "Peso da embalagem", "Cor principal"]);
    // repetição da introdução
    const r2 = v(["- Cor: azul marinho", "- Com luzes: Sim", "- Marca: Molekinho", "- Fechamento: cadarço"], "Tênis infantil Molekinho azul marinho, com luzes.");
    assert.deepStrictEqual(termos(r2, "REPETE_INTRODUCAO"), ["Cor: azul marinho", "Com luzes: Sim", "Marca: Molekinho"]);
    // voz da loja e propaganda herdada da descrição atual
    const r3 = v(["- Fechamento: cadarço", "- Produto original, com qualidade e durabilidade", "- Recomendamos lavar à mão"]);
    assert.ok(codigos(r3).includes("VOZ_DA_LOJA") && termos(r3, "VOZ_DA_LOJA")[0] === "Recomendamos");
    assert.deepStrictEqual(termos(r3, "PROPAGANDA_HERDADA"), ["original", "qualidade", "durabilidade"]);
    // a mesma palavra vinda do título não é herdada da descrição
    const fTitulo = ficha({ attributes_json: extras, titulo: "Tênis Infantil Molekinho Original" }, { descricaoAtual: "Produto original." });
    assert.ok(!codigos(v(["- Fechamento: cadarço", "- Produto original"], intro, fTitulo)).includes("PROPAGANDA_HERDADA"));
    ok("35a. F7A.8: só fatos úteis vão ao prompt; rótulo inventado/irrelevante, repetição da introdução, 'recomendamos' e propaganda herdada são barrados; valor 0 = não tem");

    // 1ª linha = nome comercial do título não dispara conflito; o corpo dispara
    const fr = engine.montarFicha({
      item_id: "MLB-R", titulo: "Kit 2 Regata Infantil Dinossauro Zenite",
      attributes_json: [
        { id: "BRAND", name: "Marca", value: "Zenite" },
        { id: "GARMENT_TYPE", name: "Tipo de roupa", value: "Camiseta" },
        { id: "MAIN_MATERIAL", name: "Material principal", value: "Algodão" },
      ],
    }, { categoriaNome: "Camisetas e Regatas", limiteCategoria: 50000, descricaoAtual: null, descricaoEstado: "sem_descricao" });
    assert.ok(fr.conflitos.some((c) => c.tipo === "ALTERNATIVA"));
    const corpo = "\n\nPeça infantil da marca Zenite.\n\nEspecificações:\n- Material principal: algodão";
    // F7A.11: a exceção da 1ª linha (F7A.8) saiu — o nome é LIMPO do trecho em conflito
    assert.ok(codigos(engine.validarDescricao("Kit 2 Regata Infantil Zenite" + corpo, [], fr)).includes("CONFLITO_DE_FONTES"),
      "validação vale para o texto inteiro");
    const limpo = engine.limparNomeConflitante("Kit 2 Regata Infantil Zenite" + corpo, fr);
    // F7A.12: sem "Regata" o nome fica sem tipo → nome neutro só de fatos não conflitantes
    assert.deepStrictEqual([limpo.descricao.split("\n")[0], limpo.removidos, limpo.nomeNeutro],
      ["Kit 2 Produto Zenite", ["Regata"], "Kit 2 Produto Zenite"]);
    assert.strictEqual(engine.validarDescricao(limpo.descricao, [], fr).valida, true);
    assert.ok(codigos(engine.validarDescricao(engine.limparNomeConflitante("Kit 2 Infantil Zenite\n\nRegata infantil da marca Zenite.\n\nEspecificações:\n- Material principal: algodão", fr).descricao, [], fr))
      .includes("CONFLITO_DE_FONTES"), "a limpeza é só da 1ª linha: no corpo continua barrado");
    ok("35b. F7A.11: trecho em conflito sai da 1ª linha (só ele); no corpo o conflito continua barrado");
    assert.ok(engine.montarPrompt(fr).includes("- Tipo de roupa (não escreva: camiseta, regata)"),
      "prompt lista as palavras bloqueadas pelo conflito");

    // poda: só remove itens repetidos/irrelevantes (e a seção que esvaziar)
    const gerada = ["Tênis Infantil Molekinho", "", "Tênis infantil da marca Molekinho, azul marinho.", "",
      "Especificações:", "- Cor: azul marinho", "- Fechamento: cadarço", "- Categoria: Tênis", "",
      "Informações adicionais:", "- Peso da embalagem: 300 g", "", "Observações:", "- Voltagem: 220 V"].join("\n");
    const pd = engine.podarItens(gerada, f);
    assert.deepStrictEqual(pd.removidos, ["Cor: azul marinho", "Categoria: Tênis", "Peso da embalagem: 300 g"]);
    assert.strictEqual(pd.descricao, ["Tênis Infantil Molekinho", "", "Tênis infantil da marca Molekinho, azul marinho.", "",
      "Especificações:", "- Fechamento: cadarço", "", "Observações:", "- Voltagem: 220 V"].join("\n"));
    assert.ok(pd.descricao.split("\n").every((l) => gerada.split("\n").includes(l)), "poda nunca reescreve linha");
    assert.ok(codigos(engine.validarDescricao(pd.descricao, [], f)).includes("ROTULO_INVENTADO"), "rótulo inventado não é podado");
    const viaIa = await engine.gerarDescricao({ ficha: f, aiProvider: provider({ ok: true, data: { descricao: gerada.replace("\n\nObservações:\n- Voltagem: 220 V", ""), fatosUsados: ["brand"] } }) });
    assert.deepStrictEqual([viaIa.ok, viaIa.itensRemovidos], [true, ["Cor: azul marinho", "Categoria: Tênis", "Peso da embalagem: 300 g"]]);
    assert.ok(!viaIa.descricao.includes("Informações adicionais"), "seção esvaziada pela poda sai junto");
    ok("35c. F7A.8: poda tira só itens repetidos/irrelevantes e seção vazia (nunca reescreve); gerarDescricao valida o texto podado e expõe itensRemovidos");
  }

  // 36 ─ F7A.9: introdução em texto corrido
  {
    const f = ficha();
    const p = engine.montarPrompt(f);
    // F7A.10 substituiu a introdução curta por abertura de 4–6 frases (bloco 26)
    assert.ok(!p.includes("2 ou 3 frases curtas") && !/Tem \d+ × \d+/.test(p), "sem números de exemplo que a IA copiaria");
    const intro = "Tênis infantil da marca Molekinho, para meninos. É feito em material sintético, na cor azul marinho. " +
      "Tem fechamento por cadarço e possui luzes.";
    assert.ok(intro.length >= 120 && intro.length <= 220, "fixture no alvo: " + intro.length);
    const texto = ["Tênis Infantil Molekinho", "", intro, "", "Especificações:", "- Cor: azul marinho", "- Não é impermeável",
      "", "Dimensões:", "- Solado com 2 cm de altura"].join("\n");
    const pd = engine.podarItens(texto, f);
    assert.deepStrictEqual(pd.removidos, ["Cor: azul marinho"], "item que só repete a introdução sai");
    const v = engine.validarDescricao(pd.descricao, ["brand", "attr:COLOR"], f);
    assert.strictEqual(v.valida, true, JSON.stringify(v.problemas));
    // a introdução segue sob o grounding e a linguagem proibida
    const com = (frase) => codigos(engine.validarDescricao(texto.replace(intro, intro + " " + frase), [], f));
    assert.ok(com("É resistente e durável.").includes("TERMO_NAO_COMPROVADO"));
    assert.ok(com("Tem qualidade premium.").includes("LINGUAGEM_PROIBIDA"));
    // valor compartilhado com outro fato: só é repetição se a introdução citar o rótulo
    const fb = engine.montarFicha({ item_id: "MLB-B", titulo: "Bolsa Clutch Festa", attributes_json: [
      { id: "BRAND", name: "Marca", value: "Lumi" },
      { id: "EXTERNAL_MATERIAL", name: "Material externo", value: "Tecido Brilhante" },
      { id: "INTERNAL_MATERIAL", name: "Material interno", value: "Tecido" },
    ] }, { categoriaNome: "Bolsas", limiteCategoria: 50000, descricaoAtual: null, descricaoEstado: "sem_descricao" });
    const bolsa = (i) => engine.podarItens(["Bolsa Clutch Festa", "", i, "", "Especificações:", "- Material interno: Tecido"].join("\n"), fb).removidos;
    assert.deepStrictEqual(bolsa("Clutch da marca Lumi, com material externo em tecido brilhante."), [], "tecido do externo não cobre o interno");
    assert.deepStrictEqual(bolsa("Clutch da marca Lumi, em tecido brilhante, com material interno em tecido."), ["Material interno: Tecido"]);
    ok("36. F7A.9: item repetido sai na poda (valor de outro fato não conta); grounding vale na introdução");
  }

  // 37 ─ F7A.10: formato comercial (títulos em maiúsculas, subjetivo leve, claims barrados)
  {
    const f = ficha({}, { descricaoAtual: DESC_ATUAL + " Compatível com palmilhas ortopédicas. Modo de uso: calçar com meia." });
    const abertura = "Tênis infantil da marca Molekinho, pensado para meninos e com visual moderno. O material principal é sintético " +
      "e a cor é azul marinho, de estilo clássico e versátil. O fechamento é por cadarço. Possui luzes. Não é impermeável.";
    const texto = (extra = "") => ["Tênis Infantil Molekinho", "", abertura, "", "DESTAQUES DO PRODUTO",
      "- Luzes no tênis", "- Fechamento por cadarço", "", "ESPECIFICAÇÕES", "- Material principal: sintético",
      "- Solado com 2 cm de altura", "", "COMO USAR", "- Calçar com meia", extra].join("\n");
    const pd = engine.podarItens(texto(), f);
    assert.deepStrictEqual(pd.removidos, ["Material principal: sintético"], "destaque em frase não é podado; 'Rótulo: valor' repetido é");
    const v = engine.validarDescricao(pd.descricao, ["brand"], f);
    assert.strictEqual(v.valida, true, JSON.stringify(v.problemas));
    // título em maiúsculas sem itens = seção vazia; nunca vira nome próprio
    const vazia = engine.validarDescricao(pd.descricao + "\n\nBENEFÍCIOS", [], f);
    assert.deepStrictEqual(codigos(vazia), ["SECAO_VAZIA"]);
    assert.deepStrictEqual(vazia.problemas[0].termos, ["BENEFÍCIOS"]);
    // claims objetivos continuam barrados, mesmo com o formato comercial
    const claim = (frase) => codigos(engine.validarDescricao(pd.descricao.replace(abertura, abertura + " " + frase), [], f));
    assert.ok(claim("É resistente e durável.").includes("TERMO_NAO_COMPROVADO"));
    assert.ok(claim("Oferece máximo conforto.").includes("PROPAGANDA_HERDADA"), "conforto vem só da descrição atual");
    assert.ok(claim("É compatível com palmilhas ortopédicas.").includes("PROPAGANDA_HERDADA"), "compatibilidade só do vendedor");
    assert.ok(claim("Tem garantia de 90 dias.").includes("LINGUAGEM_PROIBIDA"));
    assert.ok(claim("É um tênis perfeito.").includes("LINGUAGEM_PROIBIDA"));
    // item sem hífen sob título em maiúsculas ganha o marcador e é checado como item
    const semHifen = pd.descricao.replace("- Solado com 2 cm de altura", "Cor: azul marinho\nVoltagem: 220 V");
    const pn = engine.podarItens(semHifen, f);
    assert.ok(pn.descricao.includes("\n- Voltagem: 220 V") && pn.removidos.includes("Cor: azul marinho"));
    assert.ok(codigos(engine.validarDescricao(pn.descricao, [], f)).includes("ROTULO_INVENTADO"));
    assert.ok(!codigos(engine.validarDescricao(pn.descricao, [], f)).includes("SECAO_VAZIA"));
    ok("37. F7A.10: abertura com subjetivo leve + DESTAQUES/ESPECIFICAÇÕES/COMO USAR passa; título vazio → SECAO_VAZIA; resistência, conforto, compatibilidade, garantia e hipérbole seguem barrados");
  }

  // 38 ─ F7A.11: benefício deduzido barrado; nome limpo de medida em conflito
  {
    const f = ficha({}, { descricaoAtual: DESC_ATUAL + " Combina com tudo e facilita o dia a dia." });
    const base = "Tênis Infantil Molekinho\n\nTênis infantil da marca Molekinho, com visual moderno e elegante. O material principal " +
      "é sintético, na cor azul marinho. Tem fechamento por cadarço e possui luzes.\n\nObservações:\n- Não é impermeável";
    assert.strictEqual(engine.validarDescricao(base, [], f).valida, true, "subjetivo leve sem benefício passa");
    const ben = (frase) => engine.validarDescricao(base.replace("possui luzes.", "possui luzes. " + frase), [], f);
    const termosBen = (r) => ((r.problemas || []).find((p) => p.codigo === "BENEFICIO_DEDUZIDO") || {}).termos;
    assert.deepStrictEqual(termosBen(ben("Combina com tudo e facilita o dia a dia.")), ["combina", "facilita"],
      "barrado mesmo com origem na descrição atual");
    assert.ok(termosBen(ben("O cadarço ajuda no ajuste.")), "ajuda");
    assert.ok(!termosBen(ben("É a melhor escolha.")), "adjetivo 'melhor' é da LINGUAGEM_PROIBIDA, não daqui");
    // palavra de fato estruturado não é benefício deduzido
    const fp = ficha({ attributes_json: anuncio().attributes_json.concat([{ id: "WITH_UV_PROTECTION", name: "Com proteção UV", value: "Sim" }]) });
    assert.ok(!termosBen(engine.validarDescricao(base.replace("possui luzes.", "possui luzes e proteção UV."), [], fp)));

    // nome limpo: medida em conflito ("120 Litros") e números em conflito ("10/100/1000")
    const fl = engine.montarFicha({ item_id: "MLB-L", titulo: "Kit 2 Lixeira Com Rodas 120 Litros Jsn Preto", attributes_json: [
      { id: "BRAND", name: "Marca", value: "JSN" },
      { id: "VOLUME_CAPACITY", name: "Capacidade em volume", value: "240 L" },
      { id: "COLOR", name: "Cor", value: "Preto" },
      { id: "WITH_WHEELS", name: "Com rodas", value: "Sim" },
    ] }, { categoriaNome: "Cestos de Papéis", limiteCategoria: 50000, descricaoAtual: null, descricaoEstado: "sem_descricao" });
    assert.ok(fl.conflitos.some((c) => c.tipo === "MEDIDA"));
    const texto = "Kit 2 Lixeira Com Rodas 120 Litros Jsn Preto\n\nLixeira da marca JSN, na cor preta. Possui rodas.";
    const l = engine.limparNomeConflitante(texto, fl);
    assert.deepStrictEqual([l.descricao.split("\n")[0], l.removidos], ["Kit 2 Lixeira Com Rodas Jsn Preto", ["120 Litros"]]);
    assert.strictEqual(engine.validarDescricao(l.descricao, [], fl).valida, true);
    assert.ok(codigos(engine.validarDescricao(texto, [], fl)).includes("CONFLITO_DE_FONTES"), "sem limpeza, o 120 L do título é contradição");
    const fn = engine.montarFicha({ item_id: "MLB-N", titulo: "Placa Rede Gigabit 10/100/1000 Pci Tp-link Tg-3468", attributes_json: [
      { id: "BRAND", name: "Marca", value: "TP-Link" },
      { id: "DATA_TRANSFER_RATE", name: "Taxa de transferência de dados", value: "2.4 Gbps" },
    ] }, { categoriaNome: "Placas de Rede", limiteCategoria: 50000, descricaoAtual: "Taxa de transferência de dados: 10/100/1000Mbps.", descricaoEstado: "ok" });
    const n = engine.limparNomeConflitante("Placa Rede Gigabit 10/100/1000 Pci Tp-link Tg-3468\n\nPlaca de rede TP-Link.", fn);
    assert.strictEqual(n.descricao.split("\n")[0], "Placa Rede Pci Tp-link Tg-3468", "Tg-3468 é código, não número em conflito");
    ok("38. F7A.11: facilita/combina/ajuda → BENEFICIO_DEDUZIDO (salvo fato estruturado); 1ª linha perde só o trecho em conflito");
  }

  // 39 ─ F7A.12: claim técnico herdado, nome neutro, duplicados e ordem das seções
  {
    const mesa = (over = {}, desc = "Estrutura em aço carbono reforçado com tratamento antioxidante. Pés niveladores.") =>
      engine.montarFicha({ item_id: "MLB-M", titulo: "Mesa Ouro 120cm Aço", attributes_json: [
        { id: "BRAND", name: "Marca", value: "Genus" }, { id: "DESK_MATERIALS", name: "Materiais da escrivaninha", value: "MDF" },
        ...(over.attrs || []),
      ], ...over.anuncio }, { categoriaNome: "Escrivaninhas", limiteCategoria: 50000, descricaoAtual: desc, descricaoEstado: "ok" });
    const txt = (frase) => "Mesa Ouro 120cm\n\nMesa da marca Genus, com tampo em MDF. " + frase;
    const termosClaim = (f, frase) => ((engine.validarDescricao(txt(frase), [], f).problemas || []).find((p) => p.codigo === "CLAIM_TECNICO_HERDADO") || {}).termos;
    assert.deepStrictEqual(termosClaim(mesa(), "A estrutura é em aço carbono reforçado, com tratamento antioxidante."), ["reforcado", "antioxidante"],
      "afirmação técnica só do vendedor não é fato");
    assert.ok(!termosClaim(mesa(), "Acompanha pés niveladores."), "fato concreto da descrição atual (sem claim técnico) segue valendo");
    assert.ok(!termosClaim(mesa({ attrs: [{ id: "IS_REINFORCED", name: "É reforçada", value: "Sim" }] }), "A estrutura é em aço carbono reforçado."),
      "fato estruturado sustenta o claim");
    assert.ok(!termosClaim(mesa({ anuncio: { titulo: "Mesa Ouro 120cm Aço Reforçado" } }), "A estrutura é em aço carbono reforçado."),
      "título sustenta o claim");
    ok("39a. F7A.12: claim técnico (antioxidante, reforçado…) vindo só da descrição atual → CLAIM_TECNICO_HERDADO; fato estruturado ou título liberam");

    // nome neutro com fatos de vestuário (tamanho/gênero → "Peça")
    const fr = engine.montarFicha({ item_id: "MLB-R2", titulo: "Kit 2 Regata Infantil Dinossauro Sem Manga Zenite", attributes_json: [
      { id: "BRAND", name: "Marca", value: "Zenite" }, { id: "GARMENT_TYPE", name: "Tipo de roupa", value: "Camiseta" },
      { id: "GENDER", name: "Gênero", value: "Meninos" }, { id: "COLOR", name: "Cor", value: "Branco/preto" },
      { id: "SIZE", name: "Tamanho", value: "12" },
    ] }, { categoriaNome: "Camisetas e Regatas", limiteCategoria: 50000, descricaoAtual: null, descricaoEstado: "sem_descricao" });
    const r = engine.limparNomeConflitante("Kit 2 Regata Infantil Dinossauro Zenite\n\nPeça infantil da marca Zenite.", fr);
    assert.strictEqual(r.nomeNeutro, "Kit 2 Peça Zenite Meninos Branco/preto Tamanho 12");
    assert.strictEqual(r.descricao.split("\n")[0], r.nomeNeutro);
    assert.ok(!engine.validarDescricao(r.descricao, [], fr).problemas, JSON.stringify(engine.validarDescricao(r.descricao, [], fr).problemas));

    // duplicados e ordem fixa
    const bagunca = ["Nome X", "", "Abertura.", "", "Observações:", "- Lavar à mão", "", "Dimensões:", "- Altura: 10 cm",
      "", "Especificações:", "- Cor: azul", "- Cor: Azul.", "", "Informações adicionais:", "- Lavar à mão"].join("\n");
    const a = engine.arrumarEstrutura(bagunca);
    assert.deepStrictEqual(a.descricao.split("\n").filter((l) => /:$/.test(l)), ["Especificações:", "Dimensões:", "Observações:"],
      "seção que ficou vazia sai; o resto na ordem fixa");
    assert.ok(a.reordenou && a.duplicados.length === 2);
    assert.ok(a.descricao.startsWith("Nome X\n\nAbertura.\n\nEspecificações:\n- Cor: azul\n\nDimensões:"));
    ok("39b. F7A.12: nome sem tipo vira nome neutro de fatos; itens duplicados saem; seções em ordem fixa");
  }

  // 40 ─ F7B: HARD × SOFT
  {
    const f = ficha({}, { descricaoAtual: DESC_ATUAL + " Tamanhos do P ao GG. Empresa fundada em 1990." });
    const base = ["Tênis Infantil Molekinho", "", "Tênis infantil da marca Molekinho, na cor azul marinho. O material principal é sintético.",
      "Tem fechamento por cadarço e possui luzes.", "", "Especificações:", "- Gênero: Meninos"];
    const com = (...extras) => base.concat(extras).join("\n");
    const sev = (p) => engine.severidade(p, f);
    // HARD continua HARD
    for (const [codigo, termos] of [["CONFLITO_DE_FONTES", ["x"]], ["NUMERO_NAO_COMPROVADO", ["40"]], ["MARCA_CONFLITANTE", ["Nike"]],
      ["CLAIM_TECNICO_HERDADO", ["antiderrapante"]], ["ATRIBUTO_PROIBIDO", ["impermeável"]], ["LINGUAGEM_PROIBIDA", ["oferta"]],
      ["FATO_INVENTADO", ["couro"]], ["CLAIM_NAO_SUSTENTADO", ["original"]],
      ["LINGUAGEM_PROIBIDA", ["frete"]], ["LINGUAGEM_PROIBIDA", ["perfeito", "garantia"]], ["CONTATO_EXTERNO", ["whatsapp"]]]) {
      assert.strictEqual(sev({ codigo, termos }), "hard", codigo + " " + termos);
    }
    assert.strictEqual(sev({ codigo: "NOME_NAO_COMPROVADO", termos: ["Nike"] }), "hard", "nome sem origem em fonte nenhuma = invenção");
    for (const [codigo, termos] of [["NOME_NAO_COMPROVADO", ["GG"]], ["TERMO_NAO_COMPROVADO", ["palmilha"]], ["LINGUAGEM_PROIBIDA", ["perfeito"]],
      ["ROTULO_INVENTADO", ["Tipo"]], ["SECAO_VAZIA", ["Dimensões"]], ["REPETE_INTRODUCAO", ["x"]], ["FATO_DESCONHECIDO", ["attr:X"]],
      ["BENEFICIO_DEDUZIDO", ["facilita"]]]) { // F7C: benefício é linguagem, não fato → SOFT
      assert.strictEqual(sev({ codigo, termos }), "soft", codigo + " " + termos);
    }
    // SOFT: só remove (frase/item inteiro), revalida e devolve avisos
    const r = engine.validarComCorrecoes(com("- Tamanhos do P ao GG", "- Tipo: Tênis", "- Palmilha de couro legítimo",
      "", "Dimensões:", "", "Observações:", "- Empresa fundada em 1990"), ["brand", "attr:INEXISTENTE"], f);
    assert.strictEqual(r.valida, true, JSON.stringify(r.problemas));
    assert.strictEqual(r.descricao, com());
    assert.ok(r.descricao.split("\n").every((l) => com().split("\n").includes(l)), "nenhuma linha reescrita");
    assert.deepStrictEqual(Array.from(new Set(r.avisos.map((a) => a.codigo))).sort(),
      ["FATO_DESCONHECIDO", "NOME_NAO_COMPROVADO", "ROTULO_INVENTADO", "SECAO_VAZIA", "TERMO_NAO_COMPROVADO", "VOZ_DA_LOJA"]);
    assert.deepStrictEqual(r.fatosUsados, ["brand"]);
    // frase da abertura com termo sem origem: sai só a frase
    const rf = engine.validarComCorrecoes(base.join("\n").replace("possui luzes.", "possui luzes. Ideal para trilhas."), [], f);
    assert.deepStrictEqual([rf.valida, rf.descricao], [true, com()]);
    // HARD não é corrigido, mesmo com SOFT junto
    const rh = engine.validarComCorrecoes(com("- Palmilha de couro", "- Frete grátis"), [], f);
    assert.deepStrictEqual([rh.valida, rh.hard.map((p) => p.codigo)], [false, ["LINGUAGEM_PROIBIDA"]]);
    // correção demais = HARD
    const rx = engine.validarComCorrecoes(com("- Palmilha de couro", "- Sola de gel", "- Cano de camurça", "- Forro de lã", "- Bico de aço"), [], f);
    assert.deepStrictEqual([rx.valida, rx.hard.map((p) => p.codigo)], [false, ["CORRECAO_EXCESSIVA"]]);
    // problema na 1ª linha não tem correção segura
    const rn = engine.validarComCorrecoes(com().replace("Tênis Infantil Molekinho", "Tênis Infantil Molekinho leve"), [], f);
    assert.ok(!rn.valida && rn.hard.some((p) => p.codigo === "CORRECAO_EXCESSIVA"), JSON.stringify(rn.hard));
    // nome sem origem nenhuma na 1ª linha já é HARD (invenção), antes de qualquer correção
    const ri = engine.validarComCorrecoes(com().replace("Tênis Infantil Molekinho", "Tênis Infantil Molekinho Trilha"), [], f);
    assert.deepStrictEqual([ri.valida, ri.hard.map((p) => p.codigo)], [false, ["NOME_NAO_COMPROVADO"]]);
    ok("40. F7B: HARD (conflito, número, marca, claim, benefício, logística, nome inventado) rejeita; SOFT sai por remoção de frase/item e o texto é revalidado; >4 remoções ou 1ª linha = CORRECAO_EXCESSIVA");
  }

  // 41 ─ F7B.1: conflito genérico de material
  {
    const mk = (titulo, attrs, categoria = "Casacos e Jaquetas") => engine.montarFicha({ item_id: "MLB-T", titulo,
      attributes_json: [{ id: "BRAND", name: "Marca", value: "Alianza" }, ...attrs] },
    { categoriaNome: categoria, limiteCategoria: 50000, descricaoAtual: null, descricaoEstado: "sem_descricao" });
    const mat = (f) => f.conflitos.filter((c) => c.tipo === "MATERIAL").map((c) => [c.label, c.chaves.slice().sort()]);
    // mesma dimensão, famílias diferentes → conflito (tecido × tecido; fibra × fibra)
    const jaq = mk("Jaqueta Verde Militar De Sarja Com Botões Forrados", [
      { id: "FABRIC_TYPE", name: "Tipo de tecido", value: "Jeans" },
      { id: "MAIN_MATERIAL", name: "Material principal", value: "Algodão" },
      { id: "COMPOSITION", name: "Composição", value: "100% algodão" },
    ]);
    assert.deepStrictEqual(mat(jaq), [["Tipo de tecido", ["jeans", "sarja"]]], "Algodão × Sarja não conflita (fibra × tecido)");
    assert.ok(!jaq.fatos.some((x) => x.id === "attr:FABRIC_TYPE") && jaq.fatos.some((x) => x.id === "attr:MAIN_MATERIAL"));
    assert.deepStrictEqual(mat(mk("Camiseta Poliéster Azul", [{ id: "MAIN_MATERIAL", name: "Material principal", value: "Algodão" }], "Camisetas")),
      [["Material principal", ["algodao", "poliester"]]]);
    // NÃO é conflito
    for (const [titulo, attrs, categoria, porque] of [
      ["Mesa Ouro Em Aço E Madeira", [{ id: "DESK_MATERIALS", name: "Materiais da escrivaninha", value: "MDF" }], "Escrivaninhas", "título com 2 materiais = partes"],
      ["Mesa Ouro De Madeira", [{ id: "DESK_MATERIALS", name: "Materiais da escrivaninha", value: "MDF" }], "Escrivaninhas", "MDF e madeira = mesma família"],
      ["Lixeira De Aço 50 Litros", [{ id: "LID_MATERIAL", name: "Material da tampa", value: "Plástico" },
        { id: "STRUCTURE_MATERIALS", name: "Materiais da estrutura", value: "Plástico" }], "Lixeiras", "material de PARTE"],
      ["Camiseta De Algodão", [{ id: "FABRIC_TYPE", name: "Tipo de tecido", value: "Malha" }], "Camisetas", "fibra × tecido"],
      ["Short Jeans Preto", [{ id: "MAIN_MATERIAL", name: "Material principal", value: "Jeans Premium" }], "Shorts", "mesmo material"],
      ["Bolsa Clutch Festa", [{ id: "EXTERNAL_MATERIAL", name: "Material externo", value: "Tecido Brilhante Nylon" }], "Bolsas", "título sem material"],
    ]) assert.deepStrictEqual(mat(mk(titulo, attrs, categoria)), [], porque);
    // nenhum dos dois materiais pode aparecer; o nome perde o trecho em conflito
    const corpo = "\n\nJaqueta da marca Alianza, feita em algodão. Possui botões forrados.";
    assert.strictEqual(engine.validarDescricao("Jaqueta Verde Militar Com Botões Forrados" + corpo, [], jaq).valida, true);
    for (const w of ["jeans", "sarja"]) {
      assert.ok(codigos(engine.validarDescricao("Jaqueta Verde Militar Com Botões Forrados" + corpo.replace("algodão", "algodão " + w), [], jaq))
        .includes("CONFLITO_DE_FONTES"), w);
    }
    const nome = engine.limparNomeConflitante("Jaqueta Verde Militar De Sarja Com Botões Forrados" + corpo, jaq);
    assert.deepStrictEqual([nome.descricao.split("\n")[0], nome.removidos], ["Jaqueta Verde Militar Com Botões Forrados", ["De Sarja"]]);
    assert.ok(engine.montarPrompt(jaq).includes("- Tipo de tecido (não escreva: sarja, jeans)"));
    ok("41. F7B.1: material do título × atributo de papel principal na mesma dimensão → CONFLITO (Jeans×Sarja, Algodão×Poliéster); partes, família igual e fibra×tecido não");
  }

  // 42 ─ F7C: padrão operacional — FATOS rigorosos, COPY com liberdade
  {
    const f = ficha();
    const blocos = (copy = {}) => [
      "DESCRIÇÃO PRINCIPAL",
      "Tênis infantil da marca Molekinho, para meninos, na cor azul marinho.",
      "O material principal é sintético e o fechamento é por cadarço.",
      "Possui luzes e tem visual moderno.",
      "", "DESTAQUES DO PRODUTO", "* Luzes no tênis", "* Fechamento por cadarço",
      "", "COMO USAR", ...(copy.uso || ["* Ótimo para passeios e brincadeiras", "* Combine com bermudas e camisetas"]),
      "", "ESPECIFICAÇÕES", "* Marca: Molekinho", "* Cor: Azul marinho", "* Material principal: Sintético",
      "", "BENEFÍCIOS", ...(copy.ben || ["* Mais praticidade para calçar e tirar", "* Luzes que deixam o passeio mais divertido"]),
      "", "EXPERIÊNCIA DE COMPRA", ...(copy.exp || ["Escolha o tamanho e finalize o pedido com tranquilidade. Aproveite!"]),
    ].join("\n");
    const v = engine.validarDescricao(blocos(), ["brand"], f);
    assert.strictEqual(v.valida, true, JSON.stringify(v.problemas));
    // copy livre não libera FATO
    const hard = (copy) => engine.validarComCorrecoes(blocos(copy), [], f);
    const codHard = (copy) => (hard(copy).hard || []).map((p) => p.codigo);
    assert.ok(codHard({ ben: ["* Couro que dura anos"] }).includes("FATO_INVENTADO"), "material inventado na copy");
    assert.ok(codHard({ ben: ["* Fica lindo na versão vermelha"] }).includes("FATO_INVENTADO"), "cor inventada na copy");
    // COMO USAR: material/cor/objeto citados como CONTEXTO de uso são livres
    const ctx = engine.validarComCorrecoes(blocos({ uso: ["* Combine com calça jeans e camiseta branca", "* Guarde perto da porta"] }), [], f);
    assert.ok(ctx.valida, JSON.stringify(ctx.hard || ctx.problemas));
    assert.ok(codHard({ ben: ["* Produto original de fábrica"] }).includes("CLAIM_NAO_SUSTENTADO"));
    assert.ok(codHard({ ben: ["* Material resistente para o dia a dia"] }).includes("CLAIM_TECNICO_HERDADO"));
    assert.ok(codHard({ exp: ["Envio rápido para todo o Brasil."] }).includes("LINGUAGEM_PROIBIDA"));
    assert.ok(codHard({ exp: ["Aproveite a oferta enquanto durar."] }).includes("LINGUAGEM_PROIBIDA"), "preço/estoque é HARD");
    assert.ok(codHard({ ben: ["* Ideal para tênis de 40 cm"] }).includes("NUMERO_NAO_COMPROVADO"));
    assert.ok(codHard({ uso: ["* Use com a palmilha Nike"] }).includes("NOME_NAO_COMPROVADO"));
    // benefício e CTA: livres na copy, não nos blocos de fato
    // benefício: livre na DESCRIÇÃO PRINCIPAL e na copy; num item de DESTAQUES (fato) o item sai (SOFT)
    assert.strictEqual(engine.validarDescricao(blocos().replace("Possui luzes e tem visual moderno.", "As luzes facilitam brincar à noite."), [], f).valida, true);
    const bd = engine.validarComCorrecoes(blocos().replace("* Luzes no tênis", "* Luzes que facilitam brincar à noite"), [], f);
    assert.ok(bd.valida && !bd.descricao.includes("facilitam") && bd.avisos.some((a) => a.codigo === "BENEFICIO_DEDUZIDO"));
    assert.ok(codHard({ ben: ["* O capuz removível protege do vento"] }).includes("FATO_INVENTADO"), "componente inventado");
    // termo sem origem na copy não é removido (grounding lexical só nos blocos de fato)
    const livre = engine.validarComCorrecoes(blocos({ uso: ["* Ótimo para passeios no parque e na escola"] }), [], f);
    assert.ok(livre.valida && livre.descricao.includes("parque") && !livre.avisos.length, JSON.stringify(livre.avisos));
    const qualidade = engine.validarComCorrecoes(blocos({ exp: ["Produto de qualidade, pronto para você.", "Finalize o pedido com tranquilidade."] }), [], f);
    assert.ok(qualidade.valida && qualidade.avisos.some((a) => a.codigo === "PROPAGANDA_HERDADA"), "'qualidade' sem fato sai da copy (SOFT)");
    // estrutura: ESPECIFICAÇÕES pode repetir a DESCRIÇÃO PRINCIPAL; título sem conteúdo é vazio
    assert.ok(!codigos(v).includes("REPETE_INTRODUCAO"));
    assert.deepStrictEqual(engine.podarItens(blocos(), f).removidos, []);
    assert.deepStrictEqual(codigos(engine.validarDescricao(blocos().replace("\nEscolha o tamanho e finalize o pedido com tranquilidade. Aproveite!", ""), [], f)), ["SECAO_VAZIA"]);
    const embaralhada = engine.arrumarEstrutura(blocos().replace(/\nCOMO USAR[\s\S]*?(?=\n\nESPECIFICAÇÕES)/, "") + "\n\nCOMO USAR\n* Use no dia a dia");
    assert.ok(embaralhada.reordenou && embaralhada.descricao.indexOf("COMO USAR") < embaralhada.descricao.indexOf("ESPECIFICAÇÕES"));
    ok("42. F7C: padrão operacional; copy aceita uso/benefício/CTA leve; material/cor/número/marca/claim/logística/preço na copy seguem HARD; benefício no bloco de fato barrado");
  }

  // 43 ─ F7C.1: preço/custo, facilidade técnica e logística sem fonte
  {
    const f = ficha();
    const texto = (exp, ben = "* Mais praticidade para calçar") => ["DESCRIÇÃO PRINCIPAL",
      "Tênis infantil da marca Molekinho, para meninos, na cor azul marinho, com visual moderno.", "",
      "BENEFÍCIOS", ben, "", "EXPERIÊNCIA DE COMPRA", exp].join("\n");
    const r = (exp, ben) => engine.validarComCorrecoes(texto(exp, ben), [], f);
    const hardDe = (exp, ben) => (r(exp, ben).hard || []).map((p) => p.codigo + ":" + (p.termos || []).join("|"));
    for (const [exp, esperado] of [
      ["Um produto de custo acessível.", "CLAIM_COMERCIAL_SEM_FONTE:acessivel"],
      ["Ótima relação custo-benefício.", "CLAIM_COMERCIAL_SEM_FONTE:relacao custo"],
      ["Barato e bonito.", "CLAIM_COMERCIAL_SEM_FONTE:barato"],
      ["Simples de usar no dia a dia.", "CLAIM_COMERCIAL_SEM_FONTE:simples de usar"],
      ["Instalação rápida, sem complicação.", "CLAIM_COMERCIAL_SEM_FONTE:instalacao rapida|sem complicacao"],
      ["Receba no endereço de sua preferência.", "LINGUAGEM_PROIBIDA:receba"],
      ["Pronto para chegar até você.", "LINGUAGEM_PROIBIDA:chegar ate voce"],
      ["Produto entregue bem embalado.", "LINGUAGEM_PROIBIDA:entregue|bem embalado"],
    ]) assert.ok(hardDe(exp).includes(esperado), exp + " → " + JSON.stringify(hardDe(exp)));
    assert.ok(hardDe("Compra simples.", "* Fácil de montar em minutos").some((x) => x.startsWith("CLAIM_COMERCIAL_SEM_FONTE")), "vale também em BENEFÍCIOS");
    // com fonte, passa
    const fFonte = ficha({}, { descricaoAtual: DESC_ATUAL + " Fácil de usar e de custo acessível." });
    assert.ok(engine.validarComCorrecoes(texto("Um produto de custo acessível e fácil de usar."), [], fFonte).valida, "a descrição atual sustenta");
    // a liberdade comercial continua
    for (const exp of ["Escolha o tamanho e finalize a compra com confiança e praticidade.", "Uma compra simples, prática e segura. Aproveite!"]) {
      assert.ok(r(exp).valida, exp + " → " + JSON.stringify(r(exp).hard));
    }
    assert.ok(r("Compra simples.", "* Fácil de combinar com qualquer look").valida, "fácil de combinar é estilo, não claim técnico");
    ok("43. F7C.1: preço/custo e facilidade técnica sem fonte → CLAIM_COMERCIAL_SEM_FONTE; receba/chega até você/entregue → logística HARD; copy comercial segue livre");
  }

  // 44 ─ F7C.2: nome de plataforma não é marca em pedaços
  {
    const f = ficha();
    const texto = (exp) => ["DESCRIÇÃO PRINCIPAL", "Tênis infantil da marca Molekinho, para meninos, na cor azul marinho.", "",
      "EXPERIÊNCIA DE COMPRA", exp].join("\n");
    const v = (exp, ff = f) => engine.validarComCorrecoes(texto(exp), [], ff);
    for (const exp of ["Finalize sua compra no Mercado Livre com praticidade.", "Pague com Mercado Pago e finalize com tranquilidade."]) {
      const r = v(exp);
      assert.ok(r.valida, exp + " → " + JSON.stringify(r.hard));
    }
    // o mecanismo de marca continua: marca de verdade ainda conflita
    assert.ok((v("Mesma qualidade da Nike.").hard || []).some((p) => p.codigo === "MARCA_CONFLITANTE" || p.codigo === "NOME_NAO_COMPROVADO"));
    // outro marketplace: não é marca, é direcionamento para fora → CONTATO_EXTERNO (HARD)
    for (const [exp, termo] of [["Também vendemos na Shopee.", "shopee"], ["Compare com a Amazon.", "amazon"], ["Veja na Magazine Luiza.", "magazine luiza"]]) {
      const hard = (v(exp).hard || []);
      assert.ok(hard.some((p) => p.codigo === "CONTATO_EXTERNO" && p.termos.includes(termo)), exp + " → " + JSON.stringify(hard));
      assert.ok(!hard.some((p) => p.codigo === "MARCA_CONFLITANTE"), "plataforma não vira marca: " + exp);
    }
    // marca do próprio produto que coincide com marketplace não é contato externo
    const fa = engine.montarFicha({ item_id: "MLB-K", titulo: "Kindle Amazon 16 GB", marca: "Amazon",
      attributes_json: [{ id: "BRAND", name: "Marca", value: "Amazon" }, { id: "COLOR", name: "Cor", value: "Preto" }] },
    { categoriaNome: "Leitores", limiteCategoria: 50000, descricaoAtual: null, descricaoEstado: "sem_descricao" });
    assert.ok(!(v("Um leitor da marca Amazon, na cor preto.", fa).hard || []).some((p) => p.codigo === "CONTATO_EXTERNO"));
    ok("44. F7C.2: 'Mercado Livre'/'Mercado Pago' não viram marca em pedaços; outro marketplace → CONTATO_EXTERNO (salvo BRAND); marca real segue conflitando");
  }

  // 45 ─ F8.1: afirmação objetiva de desempenho/propriedade exige fato
  {
    const mk = (titulo, attrs) => engine.montarFicha({ item_id: "MLB-O", titulo, attributes_json: attrs },
      { categoriaNome: "Utilidades", limiteCategoria: 50000, descricaoAtual: "Ferve rapidamente. Baixo consumo de energia.", descricaoEstado: "ok" });
    const f = mk("Spot Lumi Preto 10w", [{ id: "BRAND", name: "Marca", value: "Lumi" }, { id: "COLOR", name: "Cor", value: "Preto" },
      { id: "POWER", name: "Potência", value: "10 W" }, { id: "IS_WATER_RESISTANT", name: "É resistente à água", value: "Sim" }]);
    const texto = (b) => ["DESCRIÇÃO PRINCIPAL", "Spot Lumi na cor preto.", "", "BENEFÍCIOS", "* " + b].join("\n");
    const obj = (b, ff = f) => ((engine.validarDescricao(texto(b), [], ff).problemas || []).find((p) => p.codigo === "CLAIM_OBJETIVO_SEM_FONTE") || {}).termos || [];
    // objetivo sem fato estruturado nem título → bloqueia (a descrição atual do vendedor não basta)
    for (const [b, termo] of [
      ["A fonte LED contribui com o baixo consumo de energia.", "baixo consumo"],
      ["O aço oferece boa resistência ao uso contínuo.", "boa resistencia"],
      ["Aquece a água rapidamente.", "rapidamente"],
      ["Prepara a água em pouco tempo.", "em pouco tempo"],
      ["Mais estabilidade e firmeza durante o treino.", "mais estabilidade"],
      ["Ajuste confortável para uso prolongado.", "uso prolongado"],
      ["Aquecimento eficiente no buffet.", "eficiente"],
      ["Estampa que não desbota.", "nao desbota"],
    ]) assert.ok(obj(b).includes(termo), b + " → " + JSON.stringify(obj(b)));
    // experiência/estilo é copy livre
    for (const b of ["Mais praticidade no dia a dia.", "Maior flexibilidade no uso.", "Visual elegante e moderno.",
      "Uma boa escolha para decorar.", "Mais conforto e mais estilo para a rotina.", "Deixa o ambiente mais aconchegante."]) {
      assert.deepStrictEqual(obj(b), [], b);
    }
    // com evidência estruturada ou no título passa: Potência (rótulo), "É resistente à água: Sim"
    assert.deepStrictEqual(obj("Maior potência para o dia a dia."), []);
    assert.deepStrictEqual(obj("É resistente à água."), []);
    const fTitulo = mk("Lâmpada Lumi Baixo Consumo 10w", [{ id: "BRAND", name: "Marca", value: "Lumi" }]);
    assert.deepStrictEqual(obj("Lâmpada de baixo consumo.", fTitulo), [], "mesma expressão no título");
    // a marca não sustenta desempenho ("Resistencia" como marca)
    const fMarca = mk("Resistência Para Buffet 2500w", [{ id: "BRAND", name: "Marca", value: "Resistencia" }]);
    assert.ok(obj("Boa resistência ao uso contínuo.", fMarca).includes("boa resistencia"));
    assert.strictEqual(engine.severidade({ codigo: "CLAIM_OBJETIVO_SEM_FONTE", termos: [] }, f), "hard");
    ok("45. F8.1: desempenho objetivo (consumo, resistência ao uso, rapidez, estabilidade, uso prolongado…) exige fato/título; experiência é livre");
  }

  // 46 ─ F8.1: conflitos além de atributo × título (comparação segura com a descrição atual)
  {
    const mk = (titulo, attrs, desc, categoria = "Utilidades") => engine.montarFicha({ item_id: "MLB-C", titulo, attributes_json: attrs },
      { categoriaNome: categoria, limiteCategoria: 50000, descricaoAtual: desc, descricaoEstado: desc ? "ok" : "sem_descricao" });
    const tipos = (ff) => ff.conflitos.map((c) => [c.id, c.tipo, c.fonte]);
    // quantidade: atributo 5 × "kit … com 3 peças" na descrição
    const faixas = mk("Kit 5 Faixa Elástica Mini Band", [{ id: "BRAND", name: "Marca", value: "Lumi" }, { id: "UNITS_PER_PACK", name: "Unidades por kit", value: "5" }],
      "KIT DE MINI BANDS DE TECIDO COM 3 PEÇAS. Kit com 3 mini bands.");
    assert.deepStrictEqual(tipos(faixas), [["attr:UNITS_PER_PACK", "QUANTIDADE", "descricao_atual"]]);
    assert.strictEqual(faixas.kit, null, "quantidade em conflito não vira kit");
    const cf = (t, ff) => codigos(engine.validarDescricao(t, [], ff)).includes("CONFLITO_DE_FONTES");
    assert.ok(cf("Kit com 5 faixas elásticas Lumi.", faixas) && cf("São 3 unidades.", faixas));
    assert.ok(!cf("Faixas elásticas Lumi de 5 cm de largura.", faixas), "5 cm não é quantidade");
    // material: só a declaração ROTULADA na descrição; texto livre não; marca com a palavra não conta
    const attrsShort = [{ id: "BRAND", name: "Marca", value: "Influencia Jeans" }, { id: "MAIN_MATERIAL", name: "Material principal", value: "Jeans" }];
    const short = mk("Short Saia Cargo Branco", attrsShort, "Características: * Material: Sarja de alta qualidade * Composição: 98% Algodão / 2% Elastano", "Saias");
    assert.deepStrictEqual(tipos(short), [["attr:MAIN_MATERIAL", "MATERIAL", "descricao_atual"]]);
    assert.ok(!cf("Short saia cargo da Influencia Jeans, na cor branca.", short), "nome da marca não é o material");
    assert.ok(cf("Short saia em jeans.", short));
    assert.deepStrictEqual(mk("Short Saia Cargo Branco", attrsShort, "O tecido de sarja não fica transparente.", "Saias").conflitos, [], "texto livre não compara");
    // medida com vários atributos: amarrada ao rótulo ("140 cm de comprimento"); a que bate não conflita
    const esteira = mk("Esteira Elétrica Lumi", [{ id: "TOTAL_LENGTH", name: "Comprimento total", value: "1.215 m" },
      { id: "TOTAL_WIDTH", name: "Largura total", value: "54.5 cm" }, { id: "TOTAL_HEIGHT", name: "Altura total", value: "1.355 m" },
      { id: "WEIGHT", name: "Peso", value: "32.5 kg" }, { id: "MAX_WEIGHT_SUPPORTED", name: "Peso máximo suportado", value: "100 kg" }],
    "Dimensões de 140 cm de comprimento, 54,5 cm de largura e 135,5 cm de altura. Com peso de 32,5 kg, para até 100 kg.");
    assert.deepStrictEqual(tipos(esteira), [["attr:TOTAL_LENGTH", "MEDIDA", "descricao_atual"]]);
    // faixa (mínima/máxima) × título
    const bastao = mk("Bastão De Luz Rgb 3500k 5500k", [{ id: "MIN_COLOR_TEMPERATURE", name: "Temperatura mínima da cor", value: "3000 K" },
      { id: "MAX_COLOR_TEMPERATURE", name: "Temperatura máxima da cor", value: "6000 K" }]);
    assert.deepStrictEqual(tipos(bastao).map((x) => x[0]).sort(), ["attr:MAX_COLOR_TEMPERATURE", "attr:MIN_COLOR_TEMPERATURE"]);
    assert.ok(cf("Temperatura de cor de 3000 K a 6000 K.", bastao));
    assert.deepStrictEqual(mk("Bastão 3000k 6000k", [{ id: "MIN_COLOR_TEMPERATURE", name: "Temperatura mínima da cor", value: "3000 K" },
      { id: "MAX_COLOR_TEMPERATURE", name: "Temperatura máxima da cor", value: "6000 K" }]).conflitos, []);
    assert.deepStrictEqual(mk("Monitor 4k 27", [{ id: "MIN_COLOR_TEMPERATURE", name: "Temperatura mínima da cor", value: "3000 K" }]).conflitos, [], "4k não é kelvin");
    // lista de tensão × "Tensão: …" (nome da grandeza amarra quando o atributo é único).
    // F8.2 — 127/220V cabe na faixa 100 - 240V: compatível; fora da faixa, conflito
    const voltagem = [{ id: "VOLTAGE", name: "Voltagem", value: "127/220V" }];
    assert.deepStrictEqual(mk("Kit 3 Mini Spot 127/220v", voltagem, "Especificações: Potência: 10W Tensão: 100 - 240V IP20").conflitos, []);
    const spot = mk("Kit 3 Mini Spot 127/220v", voltagem, "Especificações: Potência: 10W Tensão: 12V IP20");
    assert.deepStrictEqual(tipos(spot), [["attr:VOLTAGE", "MEDIDA", "descricao_atual"]]);
    assert.ok(cf("Opera em 127/220V.", spot));
    assert.deepStrictEqual(tipos(mk("Spot 127/220v", voltagem, "Tensão: 100 a 120 V")).map((x) => x[1]), ["MEDIDA"], "faixa que não cobre 220");
    // sem amarração segura, nada: dimensão que a ficha não tem, embalagem, parte com o valor do atributo na mesma fonte
    for (const [titulo, attrs, desc] of [
      ["Mesa Lumi 100 cm", [{ id: "WIDTH", name: "Largura", value: "60 cm" }, { id: "LENGTH", name: "Comprimento", value: "120 cm" }], null],
      ["Bicicleta Lumi", [{ id: "MAX_WEIGHT_SUPPORTED", name: "Peso máximo suportado", value: "130 kg" }], "Embalagem de 92 cm de altura, com peso de 34 kg."],
      ["Cortina Lumi 4,00 X 2,80", [{ id: "WIDTH", name: "Largura", value: "4 m" }], "Cortina 4,00x2,80 dividida em duas partes de 2,00m de largura."],
    ]) assert.deepStrictEqual(mk(titulo, attrs, desc).conflitos, [], titulo);
    ok("46. F8.1: quantidade (5 × kit 3), material rotulado (Jeans × Sarja), medida amarrada (1,215 m × 140 cm), faixa K × título, 127/220V × 100-240V; sem amarração segura não compara");
  }

  // 47 ─ F8.1: "Kit N" confiável não pode virar descrição de uma peça só
  {
    const mk = (titulo, attrs) => engine.montarFicha({ item_id: "MLB-K", titulo, attributes_json: attrs },
      { categoriaNome: "Iluminação", limiteCategoria: 50000, descricaoAtual: null, descricaoEstado: "sem_descricao" });
    const spot = mk("Kit 3 Mini Spot De Embutir Lumi Preto", [{ id: "BRAND", name: "Marca", value: "Lumi" }, { id: "COLOR", name: "Cor", value: "Preto" }]);
    assert.deepStrictEqual(spot.kit, { n: 3, fonte: "contexto:titulo" });
    assert.deepStrictEqual(mk("Pacote Com 50 Unidade Ilhós Lumi", [{ id: "BRAND", name: "Marca", value: "Lumi" },
      { id: "UNITS_PER_PACK", name: "Unidades por kit", value: "50" }]).kit, { n: 50, fonte: "attr:UNITS_PER_PACK" });
    assert.strictEqual(mk("Spot Lumi Preto 3 cm", [{ id: "BRAND", name: "Marca", value: "Lumi" }]).kit, null, "medida não é kit");
    assert.strictEqual(mk("Kit 2 Regata Lumi", [{ id: "BRAND", name: "Marca", value: "Lumi" }, { id: "UNITS_PER_PACK", name: "Unidades por kit", value: "1" }]).kit, null,
      "título × atributo divergentes: sem kit confiável");
    const kitOmitido = (t) => codigos(engine.validarDescricao(t, [], spot)).includes("KIT_OMITIDO");
    assert.ok(kitOmitido("Mini spot de embutir Lumi na cor preto."));
    assert.ok(kitOmitido("Mini spot Lumi preto com 3 cm de recuo."), "3 cm não é quantidade");
    for (const t of ["Kit com 3 mini spots de embutir Lumi.", "São 3 unidades na cor preto.", "Três mini spots Lumi na cor preto.",
      "Mini spots Lumi.\n* Unidades por kit: 3"]) assert.ok(!kitOmitido(t), t);
    assert.ok(engine.montarPrompt(spot).includes("kit com 3 unidades"));
    assert.strictEqual(engine.severidade({ codigo: "KIT_OMITIDO", termos: [] }, spot), "hard");
    ok("47. F8.1: Kit N confiável (atributo ≥ 2 ou título sem divergência) → descrição tem de citar a quantidade (KIT_OMITIDO HARD); prompt avisa");
  }

  // 48 ─ F8.2: falsos positivos da amostra de 50, corrigidos por regra genérica
  {
    const mk = (titulo, attrs, desc, categoria = "Utilidades") => engine.montarFicha({ item_id: "MLB-F", titulo, attributes_json: attrs },
      { categoriaNome: categoria, limiteCategoria: 50000, descricaoAtual: desc, descricaoEstado: desc ? "ok" : "sem_descricao" });
    const hard = (ff, secao, frase) => (engine.validarDescricao(["DESCRIÇÃO PRINCIPAL", "Produto.", "", secao, frase].join("\n"), [], ff).problemas || [])
      .filter((p) => engine.severidade(p, ff) === "hard").map((p) => p.codigo);
    const f = mk("Ebulidor Mergulhão 2000w", [{ id: "BRAND", name: "Marca", value: "Lumi" }, { id: "COLOR", name: "Cor", value: "Preto" }]);
    // claim objetivo: compra (advérbio de modo), papel do item, resistência-peça
    assert.deepStrictEqual(hard(f, "EXPERIÊNCIA DE COMPRA", "Compre com confiança e praticidade, de forma rápida e segura."), []);
    // F8.3 — "rápido" só é da compra quando modifica o ATO de comprar
    for (const fr of ["Compre de forma rápida e segura.", "Finalize sua compra rapidamente.", "Uma compra simples e rápida.",
      "Comprar é simples, rápido e seguro."]) assert.deepStrictEqual(hard(f, "EXPERIÊNCIA DE COMPRA", fr), [], fr);
    for (const fr of ["Compre e tenha aquecimento rápido.", "Compre já e tenha aquecimento rápido.", "Compre um produto de instalação rápida.",
      "Adquira com secagem rápida.", "Finalize a compra e aproveite o carregamento rápido."]) {
      assert.ok(hard(f, "EXPERIÊNCIA DE COMPRA", fr).includes("CLAIM_OBJETIVO_SEM_FONTE"), fr);
    }
    assert.deepStrictEqual(hard(f, "EXPERIÊNCIA DE COMPRA", "Esta peça é uma ótima adição à sua cozinha."), []);
    assert.deepStrictEqual(hard(f, "DESCRIÇÃO PRINCIPAL", "Ebulidor com resistência de imersão, na cor preto."), []);
    // …e o claim real continua
    assert.ok(hard(f, "BENEFÍCIOS", "* Tenha aquecimento de forma rápida e eficiente.").includes("CLAIM_OBJETIVO_SEM_FONTE"));
    assert.ok(hard(f, "BENEFÍCIOS", "* Oferece boa resistência ao uso contínuo.").includes("CLAIM_OBJETIVO_SEM_FONTE"));
    assert.ok(hard(f, "BENEFÍCIOS", "* Tecido com resistência à água.").includes("CLAIM_TECNICO_HERDADO"));
    // efeito: homógrafo e substantivo da atividade não são claim; promessa de efeito é
    const beb = mk("Bebedouro Industrial 100 Litros", [{ id: "BRAND", name: "Marca", value: "Lumi" }],
      "Bebedouro para as necessidades de hidratação de escolas. Indicado para restaurantes.");
    for (const fr of ["* Atende às necessidades de hidratação coletiva em escolas.", "* Para restaurantes, hotéis e residências."]) {
      assert.deepStrictEqual(hard(beb, "BENEFÍCIOS", fr), [], fr);
    }
    for (const fr of ["* Hidrata a pele.", "* Proporciona hidratação intensa da pele.", "* Restaura os fios danificados.", "* Hidratação profunda."]) {
      assert.ok(hard(beb, "BENEFÍCIOS", fr).includes("CLAIM_NAO_SUSTENTADO"), fr);
    }
    // conflito: valor dentro da faixa é compatível; "sem" de outro objeto não nega o produto
    assert.deepStrictEqual(mk("Spot 127/220v", [{ id: "VOLTAGE", name: "Voltagem", value: "127/220V" }], "Tensão: 100 - 240V").conflitos, []);
    const adaptador = [{ id: "INPUT_CONNECTOR", name: "Conector de entrada", value: "USB" }];
    assert.deepStrictEqual(mk("Adaptador De Rede Usb Rj45", adaptador, "Solução para adicionar uma porta RJ45 em dispositivos sem entrada de rede integrada.",
      "Adaptadores de Cabos de Rede").conflitos, []);
    assert.deepStrictEqual(mk("Adaptador De Rede Usb Rj45", adaptador, "Adaptador sem entrada USB.", "Adaptadores de Cabos de Rede").conflitos.map((c) => c.tipo), ["NEGACAO"],
      "o próprio produto 'sem entrada' continua conflito");
    // nome: termo técnico/norma com origem numa fonte não é marca; marca real e nome inventado continuam
    const camisa = mk("Camiseta Pesca Uv Proteção", [{ id: "BRAND", name: "Marca", value: "RedFishBrasil" }],
      "Camisa de pesca. Tecido Dry Fit Sport leve. Função Lockout/Tagout. Uso em procedimentos de NR-10 e NR-12.");
    for (const fr of ["* Tecido: Dry Fit Sport", "* O tecido Dry Fit leve.", "* Função: Lockout/Tagout com cadeado",
      "* Procedimentos de bloqueio e etiquetagem (Lockout/Tagout)", "* A aplicação em procedimentos de NR-10 e NR-12 traz organização."]) {
      assert.deepStrictEqual(hard(camisa, "DESTAQUES DO PRODUTO", fr), [], fr);
    }
    assert.ok(hard(camisa, "DESCRIÇÃO PRINCIPAL", "Mesma qualidade da Nike.").includes("MARCA_CONFLITANTE"));
    assert.ok(hard(camisa, "DESTAQUES DO PRODUTO", "* Tecido: Nike Dri-FIT").includes("MARCA_CONFLITANTE"), "termo sem fonte não vira técnico");
    assert.ok(hard(camisa, "DESCRIÇÃO PRINCIPAL", "Atende à NR-35.").includes("NOME_NAO_COMPROVADO"), "norma sem fonte continua HARD");
    ok("48. F8.2: compra 'de forma rápida', 'ótima adição', resistência-peça, restaurantes, hidratação-atividade, 127/220V na faixa 100-240V, 'dispositivos sem entrada', Dry Fit/Lockout/NR-12 → sem bloqueio; claims e marcas reais seguem HARD");
  }

  // 49 ─ F9.1: função técnica em qualquer bloco (inclusive COMO USAR), marca entre fontes, "receber"
  {
    const mk = (titulo, attrs, desc) => engine.montarFicha({ item_id: "MLB-G", titulo, attributes_json: attrs },
      { categoriaNome: "Utilidades", limiteCategoria: 50000, descricaoAtual: desc, descricaoEstado: desc ? "ok" : "sem_descricao" });
    const hard = (ff, secao, frase) => (engine.validarDescricao(["DESCRIÇÃO PRINCIPAL", "Produto Lumi.", "", secao, frase].join("\n"), [], ff).problemas || [])
      .filter((p) => engine.severidade(p, ff) === "hard");
    const termos = (ff, secao, frase, cod) => (hard(ff, secao, frase).find((p) => p.codigo === cod) || {}).termos || [];
    const f = mk("Máscara Lumi Dobrável", [{ id: "BRAND", name: "Marca", value: "Lumi" }],
      "Sistema antiembaçante. Filtro com tratamento eletrostático. Para poeiras, névoas e fumos. Filtra partículas.");
    // a descrição atual do vendedor não sustenta função técnica — nem em COMO USAR
    for (const [secao, frase, termo] of [
      ["DESCRIÇÃO PRINCIPAL", "Conta com sistema antiembaçante.", "antiembacante"],
      ["DESTAQUES DO PRODUTO", "* Filtro com tratamento eletrostático", "tratamento eletrostatico"],
      ["COMO USAR", "* Use em ambientes com poeiras, névoas e fumos", "poeiras"],
      ["COMO USAR", "* Filtra partículas finas durante o trabalho", "filtra"],
      ["BENEFÍCIOS", "* Repele insetos no quintal", "repele"],
    ]) assert.ok(termos(f, secao, frase, "CLAIM_OBJETIVO_SEM_FONTE").includes(termo), frase + " → " + JSON.stringify(hard(f, secao, frase)));
    // sugestão de baixo risco em COMO USAR continua livre; instrução "evite" e "antigo" não são função
    for (const frase of ["* Indicada para carpintaria, limpeza e montagem", "* Evite dobrar a peça ao guardar", "* Combine com móveis de estilo antigo"]) {
      assert.deepStrictEqual(hard(f, "COMO USAR", frase).map((p) => p.codigo), [], frase);
    }
    // fato estruturado sustenta
    const fFato = mk("Ponteira Lumi", [{ id: "BRAND", name: "Marca", value: "Lumi" }, { id: "PRODUCT_TYPE", name: "Tipo de produto", value: "Ponteira antiderrapante" }]);
    assert.deepStrictEqual(hard(fFato, "COMO USAR", "* Ponteira antiderrapante para cadeiras").map((p) => p.codigo), []);

    // marca: BRAND × marca DECLARADA → conflito, nenhuma é fato; nome solto não é declaração
    const attrsMarca = [{ id: "BRAND", name: "Marca", value: "Dy Fragrancias" }, { id: "COLOR", name: "Cor", value: "Branco" }];
    const sab = mk("Saboneteira Dispenser 1000ml", attrsMarca, "Saboneteira da marca JSN, linha Elite.");
    assert.deepStrictEqual(sab.conflitos.map((c) => [c.id, c.tipo, c.fonte]), [["brand", "MARCA", "descricao_atual"]]);
    assert.strictEqual(sab.marca, null);
    assert.ok(!sab.fatos.some((x) => x.id === "brand"));
    const cod = (t) => (engine.validarDescricao(t, [], sab).problemas || []).map((p) => p.codigo);
    assert.ok(cod("Saboneteira JSN branca.").includes("CONFLITO_DE_FONTES") && cod("Saboneteira Dy Fragrancias branca.").includes("CONFLITO_DE_FONTES"));
    assert.ok(!cod("Saboneteira branca de parede.").includes("CONFLITO_DE_FONTES"));
    for (const desc of ["Saboneteira Jsn Elite de parede.", "Marca: Dy Fragrancias.", "Produto sem marca registrada.", "Fabricante: Dy Fragrancias Ltda"]) {
      assert.deepStrictEqual(mk("Saboneteira Dispenser 1000ml", attrsMarca, desc).conflitos, [], desc);
    }
    assert.deepStrictEqual(mk("Kit Faixa Elástica", [{ id: "BRAND", name: "Marca", value: "LIFE PRO IMPORT" }], "Da marca LongLifePro.").conflitos, [],
      "uma contém palavra da outra: mesma marca");

    // receber com o comprador como sujeito = promessa de entrega (HARD); função do produto não
    const fr = mk("Patch Panel Lumi 24 Portas", [{ id: "BRAND", name: "Marca", value: "Lumi" }]);
    for (const frase of ["Compre em poucos passos e receba tudo o que precisa.", "Comprar em poucos passos e receber tudo o que precisa.",
      "Com uma compra simples, você recebe tudo o que precisa.", "Você decide com confiança e recebe uma peça estilosa."]) {
      const p = hard(fr, "EXPERIÊNCIA DE COMPRA", frase);
      assert.ok(p.some((x) => x.codigo === "LINGUAGEM_PROIBIDA"), frase + " → " + JSON.stringify(p));
    }
    for (const frase of ["O suporte recebe até 3 lâmpadas.", "Recebe notificações do celular.", "Ideal para receber visitas."]) {
      assert.ok(!hard(fr, "DESCRIÇÃO PRINCIPAL", frase).some((p) => p.codigo === "LINGUAGEM_PROIBIDA"), frase);
    }
    ok("49. F9.1: função técnica sem fato bloqueia em qualquer bloco (antiembaçante, tratamento eletrostático, poeiras/névoas/fumos, filtra); BRAND × marca declarada → conflito; 'você recebe/receber tudo' → logística HARD");
  }

  // 50 ─ F10: polimento editorial do texto aprovado (só forma; cada regra revalidada)
  {
    const mk = (titulo, attrs, cat) => engine.montarFicha({ item_id: "MLB-P", titulo, attributes_json: attrs },
      { categoriaNome: cat, limiteCategoria: 50000, descricaoAtual: "", descricaoEstado: "sem_descricao" });
    const f = mk("Lixeira Lumi Com Pedal 60 Litros Branco", [
      { id: "BRAND", name: "Marca", value: "Lumi Casa" }, { id: "MODEL", name: "Modelo", value: "Lixeira Lumi" },
      { id: "COLOR", name: "Cor", value: "Branco" }, { id: "CAPACITY", name: "Capacidade", value: "60 L" },
      { id: "MATERIAL", name: "Material", value: "Plástico" }, { id: "GENDER", name: "Gênero", value: "Sem gênero" },
      { id: "PRODUCT_FEATURES", name: "Características do produto", value: "Sem validade" },
      { id: "OPENING_TYPE", name: "Tipo de abertura", value: "Pedal" },
    ], "Lixeiras");
    const texto = [
      "DESCRICAO PRINCIPAL",
      "A Lixeira Lumi, modelo Lixeira Lumi, é feita em material Plástico na cor branco, com gênero sem gênero. Tem capacidade de 60 litros e abertura por pedal. Produto sem validade.",
      "DESTAQUES DO PRODUTO",
      "* Abertura por pedal",
      "* Capacidade de 60 litros e abertura por pedal",
      "* Capacidade de 60 litros",
      "* Características do produto: Sem validade",
      "COMO USAR",
      "* Use na cozinha ou na area de serviço para manter o ambiente organizado",
      "ESPECIFICACOES",
      "* Marca: Lumi Casa",
      "* Cor: Branco",
      "* Capacidade: 60 L",
      "* Material: Plástico",
      "BENEFICIOS",
      "* Uma opcao versatil para a rotina da casa",
      "* Medidas objetivas para ajudar na escolha do modelo adequado",
      "EXPERIENCIA DE COMPRA",
      "Escolha a sua lixeira Lumi Casa com tranquilidade. Com informações claras, você decide com confiança.",
    ].join("\n");
    assert.ok(engine.validarDescricao(texto, [], f).valida, "o texto de partida é aprovado");
    const p = engine.polirDescricao(texto, [], f);
    assert.deepStrictEqual(p.ajustes, ["ACENTUACAO", "VALOR_SEM_INFORMACAO", "ROTULO_ECOADO", "QUALIFICADOR_REDUNDANTE", "METATEXTO",
      "CONCORDANCIA_DE_COR", "MATERIAL_MINUSCULO", "ITEM_CONTIDO", "SECAO_POBRE"]);
    assert.strictEqual(p.descricao, [
      "DESCRIÇÃO PRINCIPAL",
      "A Lixeira Lumi é feita em material plástico na cor branca. Tem capacidade de 60 litros e abertura por pedal.",
      "COMO USAR",
      "* Use na cozinha ou na área de serviço para manter o ambiente organizado",
      "ESPECIFICAÇÕES",
      "* Marca: Lumi Casa",
      "* Cor: Branco",
      "* Capacidade: 60 L",
      "* Material: Plástico",
      "BENEFÍCIOS",
      "* Uma opção versátil para a rotina da casa",
      "EXPERIÊNCIA DE COMPRA",
      "Escolha a sua lixeira Lumi Casa com tranquilidade.",
    ].join("\n"));
    assert.ok(engine.validarDescricao(p.descricao, [], f).valida, "o texto polido continua aprovado");
    assert.strictEqual(p.chars, p.descricao.length);
    assert.deepStrictEqual(engine.polirDescricao(p.descricao, [], f).ajustes, [], "idempotente");

    // nome próprio/marca e valor da ficha não são reescritos; repetição imediata sai;
    // regra que faria a validação falhar é descartada (a frase de metatexto é a única
    // que cita o kit: tirá-la daria KIT_OMITIDO)
    const fk = mk("Kit 2 Toalha Influencia Branca", [{ id: "BRAND", name: "Marca", value: "Influencia" }, { id: "COLOR", name: "Cor", value: "Branco" },
      { id: "UNITS_PER_PACK", name: "Unidades por kit", value: "2" }, { id: "MAIN_MATERIAL", name: "Material principal", value: "Algodão" }], "Toalhas");
    const tk = [
      "DESCRIÇÃO PRINCIPAL",
      "Toalha Influencia em algodão, na cor branca. Peça para para o banho do dia a dia.",
      "DESTAQUES DO PRODUTO",
      "* Toalha em algodão",
      "* Cor branca",
      "ESPECIFICAÇÕES",
      "* Marca: Influencia",
      "* Material principal: Algodão",
      "* Cor: Branco",
      "EXPERIÊNCIA DE COMPRA",
      "Escolha a sua toalha com tranquilidade. Kit com 2 unidades e informações claras para decidir.",
    ].join("\n");
    const pk = engine.polirDescricao(tk, [], fk);
    assert.deepStrictEqual(pk.ajustes, ["REPETICAO_IMEDIATA"]);
    assert.strictEqual(pk.descricao, tk.replace("para para", "para"));
    const tc = tk.replace("* Cor branca", "* Cor branco").replace("para para", "para").replace(" e informações claras para decidir.", ".")
      .replace("Escolha a sua toalha com tranquilidade.", "Escolha a sua toalha com tranquilidade. Confira as características e finalize a compra.");
    const pc = engine.polirDescricao(tc, [], fk);
    assert.deepStrictEqual(pc.ajustes, ["METATEXTO", "CONCORDANCIA_DE_COR"]);
    assert.ok(pc.descricao.includes("* Cor branca\n") && !/Confira as caracter/.test(pc.descricao), pc.descricao);

    // item "Rótulo: valor" é fato próprio: não sai por estar contido em outro; texto inválido não é polido
    const fsh = mk("Short Saia Lumi", [{ id: "BRAND", name: "Marca", value: "Lumi" }, { id: "SHORT_TYPE", name: "Tipo de short", value: "Short saia" },
      { id: "SKIRT_TYPE", name: "Tipo de saia", value: "Short saia cargo" }], "Shorts");
    const ts = ["DESCRIÇÃO PRINCIPAL", "Short saia Lumi.", "ESPECIFICAÇÕES", "* Tipo de short: Short saia", "* Tipo de saia: Short saia cargo"].join("\n");
    assert.deepStrictEqual(engine.polirDescricao(ts, [], fsh).ajustes, []);
    const invalido = engine.polirDescricao(ts + "\n* Frete grátis", [], fsh);
    assert.deepStrictEqual(invalido.ajustes, []);
    ok("50. F10: polimento editorial — acentos, valor sem informação, rótulo ecoado, qualificador redundante, metatexto, concordância de cor, item contido, seção pobre; marca intacta; regra que quebra a validação é descartada");
  }

  // 51 ─ F14: descritor comprovado não é marca ("Blackout" com IS_BLACK_OUT=Sim)
  {
    const mk = (attrs, titulo = "Cortina Blackout Tecido 4,00 X 2,80") => engine.montarFicha({ item_id: "MLB-BO", titulo,
      attributes_json: [{ id: "BRAND", name: "Marca", value: "Doce Lar" }, { id: "MATERIAL", name: "Material", value: "Poliéster" }, ...attrs] },
    { categoriaNome: "Cortinas", limiteCategoria: 50000, descricaoAtual: null, descricaoEstado: "sem_descricao" });
    const com = mk([{ id: "IS_BLACK_OUT", name: "É blecaute", value: "Sim" }]);
    const base = "Cortina blackout da Doce Lar, em poliéster.\n\nDESTAQUES DO PRODUTO\n* LINHA\n* Material poliéster";
    const marcas = (f, linha) => (engine.validarDescricao(base.replace("LINHA", linha), ["brand"], f).problemas || [])
      .filter((p) => /MARCA|NOME/.test(p.codigo)).map((p) => p.codigo + ":" + p.termos.join("/"));
    assert.deepStrictEqual([...com.descritoresDeAtributo], ["blackout"]);
    assert.deepStrictEqual(marcas(com, "Blackout em tecido"), [], "IS_BLACK_OUT=Sim: abrir item com Blackout não é marca");
    assert.deepStrictEqual(marcas(com, "BLACKOUT em tecido"), [], "caixa alta também, se o atributo prova");
    // sem o atributo, a forma estrangeira abrindo item com BRAND continua conflito (regra antiga intacta)
    assert.deepStrictEqual(marcas(mk([]), "Blackout em tecido"), ["MARCA_CONFLITANTE:Blackout"]);
    // fonte que usa a palavra em minúscula também prova descritor
    const minuscula = engine.montarFicha({ item_id: "MLB-BO2", titulo: "Cortina blackout tecido", attributes_json: [
      { id: "BRAND", name: "Marca", value: "Doce Lar" }, { id: "MATERIAL", name: "Material", value: "Poliéster" }] },
    { categoriaNome: "Cortinas", limiteCategoria: 50000, descricaoAtual: null, descricaoEstado: "sem_descricao" });
    assert.deepStrictEqual(marcas(minuscula, "Blackout em tecido"), []);
    // posição de marca e marca concorrente continuam bloqueadas
    assert.deepStrictEqual(marcas(com, "Da marca Blackout"), ["MARCA_CONFLITANTE:Blackout"]);
    assert.deepStrictEqual(marcas(com, "Feito pela Blackout"), ["MARCA_CONFLITANTE:Blackout"]);
    assert.deepStrictEqual(marcas(com, "Nike em tecido"), ["MARCA_CONFLITANTE:Nike"]);
    assert.deepStrictEqual(marcas(com, "Blackout oferece conforto"), ["MARCA_CONFLITANTE:Blackout"]);
    ok("51. F14: descritor comprovado (atributo booleano Sim ou minúscula nas fontes) não é marca fora de posição de marca; posição de marca e marca concorrente seguem bloqueadas");
  }

  // 52 ─ F14: correção SOFT tira só a oração com o termo, não o item inteiro
  {
    const P = (codigo, termos) => ({ codigo, termos });
    assert.strictEqual(engine.removerFragmento("* Composição: 100% algodão, sem lycra", P("TERMO_NAO_COMPROVADO", ["lycra"])), "* Composição: 100% algodão");
    assert.strictEqual(engine.removerFragmento("* Revestimento em borracha texturizada para uma pegada firme durante as séries", P("CLAIM_OBJETIVO_SEM_FONTE", ["firme"])),
      "* Revestimento em borracha texturizada");
    assert.strictEqual(engine.removerFragmento("Lixeira em plástico, com tampa e resistente ao uso diário.", P("CLAIM_OBJETIVO_SEM_FONTE", ["resistente"])), "Lixeira em plástico, com tampa.");
    // a cabeça da frase não sai; sobra curta demais → null (quem chama apaga o segmento)
    assert.strictEqual(engine.removerFragmento("* Resistente e durável", P("CLAIM_OBJETIVO_SEM_FONTE", ["resistente"])), null);
    assert.strictEqual(engine.removerFragmento("* Tecido que protege do sol", P("CLAIM_OBJETIVO_SEM_FONTE", ["protege"])), null);
    assert.strictEqual(engine.removerFragmento("* Material plástico", P("TERMO_NAO_COMPROVADO", ["cromado"])), null);

    const f = engine.montarFicha({ item_id: "MLB-SF", titulo: "Lixeira Plástica Com Pedal 60 Litros Acme Branco", attributes_json: [
      { id: "BRAND", name: "Marca", value: "Acme" }, { id: "COLOR", name: "Cor", value: "Branco" },
      { id: "VOLUME_CAPACITY", name: "Capacidade em volume", value: "60 L" }, { id: "OPENING_TYPES", name: "Tipos de aberturas", value: "Pedal" },
      { id: "STRUCTURE_MATERIALS", name: "Materiais da estrutura", value: "Plástico" }] },
    { categoriaNome: "Lixeiras", limiteCategoria: 50000, descricaoAtual: null, descricaoEstado: "sem_descricao" });
    const t = ["DESCRIÇÃO PRINCIPAL", "Lixeira da marca Acme, em plástico branco, com abertura por pedal e capacidade de 60 L.", "",
      "ESPECIFICAÇÕES", "* Cor: Branco", "* Capacidade em volume: 60 L", "* Tipos de aberturas: Pedal",
      "* Materiais da estrutura: Plástico, com acabamento cromado"].join("\n");
    const usados = ["brand", "attr:COLOR", "attr:VOLUME_CAPACITY", "attr:OPENING_TYPES", "attr:STRUCTURE_MATERIALS"];
    const c = engine.validarComCorrecoes(t, usados, f);
    assert.strictEqual(c.valida, true, JSON.stringify(c.problemas));
    assert.ok(c.descricao.includes("* Materiais da estrutura: Plástico\n") || c.descricao.endsWith("* Materiais da estrutura: Plástico"), c.descricao);
    assert.ok(!/cromado/.test(c.descricao));
    const aviso = c.avisos.find((a) => a.codigo === "TERMO_NAO_COMPROVADO");
    assert.ok(aviso && /cromado/.test(aviso.trecho), "a remoção continua registrada");
    ok("52. F14: correção SOFT tira só a oração com o termo (\"Plástico, com acabamento cromado\" → \"Plástico\"); cabeça da frase nunca sai; sobra curta → segmento sai como antes");
  }

  // Compra sem complicação é experiência; a âncora não libera claims do produto.
  {
    const f = ficha();
    const t = (exp) => "DESCRIÇÃO PRINCIPAL\nTênis infantil Molekinho para meninos.\n\nEXPERIÊNCIA DE COMPRA\n" + exp;
    for (const exp of ["Compra simples, segura e sem complicação.", "Compra simples e sem complicações.",
      "Finalize sua compra sem complicação."]) {
      const v = engine.validarComCorrecoes(t(exp), [], f);
      assert.ok(v.valida && v.descricao.includes(exp), exp + " → " + JSON.stringify(v));
    }
    for (const exp of ["Compre um produto de instalação sem complicação.",
      "Finalize a compra e tenha montagem sem complicação.", "Compra sem complicação e instalação fácil.", "Sem complicação."]) {
      const v = engine.validarComCorrecoes(t(exp), [], f);
      assert.ok(!v.valida && v.hard.some((p) => p.codigo === "CLAIM_COMERCIAL_SEM_FONTE"), exp);
    }
    ok("53. compra sem complicação passa sem remoção; facilidade técnica continua HARD");
  }

  // Modo de uma instrução simples não promete estabilidade/desempenho.
  {
    const f = ficha();
    const t = (secao, frase) => "DESCRIÇÃO PRINCIPAL\nTênis infantil Molekinho para meninos.\n\n" + secao + "\n* " + frase;
    const frase = "Posicione o produto de forma firme.";
    const v = engine.validarComCorrecoes(t("COMO USAR", frase), [], f);
    assert.ok(v.valida && v.descricao.includes(frase), JSON.stringify(v));
    for (const [secao, claim] of [["BENEFÍCIOS", frase], ["COMO USAR", "Mais estabilidade e firmeza durante o treino."],
      ["COMO USAR", "Posicione o produto e obtenha fixação firme sob carga."],
      ["COMO USAR", "Posicione o produto de forma firme para proteção contra impacto."],
      ["COMO USAR", "Fixação firme garantida."],
      ["COMO USAR", "Posicione o produto de forma firme, com uso prolongado."]]) {
      const r = engine.validarComCorrecoes(t(secao, claim), [], f);
      assert.ok(!r.valida && r.hard.length, secao + ": " + claim);
    }
    ok("54. instrução simples de posicionamento só em COMO USAR; desempenho/proteção seguem HARD");
  }

  // Claims objetivos continuam globais, inclusive com a instrução segura ao lado.
  {
    const f = engine.montarFicha({ titulo: "Lixeira plástica", attributes_json: [
      { id: "BRAND", name: "Marca", value: "JSN" }, { id: "MATERIAL", name: "Material", value: "Plástico" }] },
    { categoriaNome: "Lixeiras", descricaoEstado: "sem_descricao" });
    const base = "DESCRIÇÃO PRINCIPAL\nLixeira JSN em plástico.";
    const segura = "\n\nCOMO USAR\n* Posicione o produto de forma firme.";
    const falhas = [];
    for (const [claim, termo] of [["Baixo\nconsumo.", "baixo consumo"],
      ["Revestimento\neletrostático.", "revestimento\neletrostatico"]]) {
      for (const instrucao of ["", segura]) {
        const t = base + "\n\nBENEFÍCIOS\n" + claim + instrucao;
        const v = engine.validarDescricao(t, [], f);
        const objetivo = (v.problemas || []).find((p) => p.codigo === "CLAIM_OBJETIVO_SEM_FONTE");
        if (v.valida || !objetivo || !objetivo.termos.includes(termo)) falhas.push(t);
        const r = engine.validarComCorrecoes(t, [], f);
        if (r.valida || !r.hard.some((p) => p.codigo === "CLAIM_OBJETIVO_SEM_FONTE")) falhas.push("correções: " + t);
      }
    }
    assert.deepStrictEqual(falhas, [], "claims entre linhas devem continuar HARD, com ou sem instrução segura");
    const limpa = engine.validarComCorrecoes(base + segura, [], f);
    assert.ok(limpa.valida, JSON.stringify(limpa));
    assert.strictEqual(limpa.descricao, base + segura, "mascaramento não altera a descrição retornada");
    for (const insegura of ["\n* Fixação firme.", "\n\nBENEFÍCIOS\n* Posicione o produto de forma firme."]) {
      const v = engine.validarDescricao(base + segura + insegura, [], f);
      assert.ok(!v.valida && v.problemas.some((p) => p.codigo === "CLAIM_OBJETIVO_SEM_FONTE" && p.termos.includes("firme")), JSON.stringify(v));
    }
    ok("54b. claims separados por newline continuam HARD; só o firme da instrução exata em COMO USAR é isolado");
  }

  // A exceção exige instrução completa, não prefixo de frase continuada.
  {
    const f = engine.montarFicha({ titulo: "Lixeira plástica", attributes_json: [
      { id: "BRAND", name: "Marca", value: "JSN" }, { id: "MATERIAL", name: "Material", value: "Plástico" }] },
    { categoriaNome: "Lixeiras", descricaoEstado: "sem_descricao" });
    const base = "DESCRIÇÃO PRINCIPAL\nLixeira JSN em plástico.\n\n";
    const instrucao = "* Posicione o produto de forma firme";
    const falhas = [];
    for (const complemento of ["sob carga.", "durante uso prolongado."]) {
      for (const separador of ["\n", "\n\n"]) {
        const texto = base + "COMO USAR\n" + instrucao + separador + complemento;
        const v = engine.validarDescricao(texto, [], f);
        if (v.valida || !v.problemas.some((p) => p.codigo === "CLAIM_OBJETIVO_SEM_FONTE" && p.termos.includes("firme"))) {
          falhas.push("validarDescricao: " + JSON.stringify(separador + complemento));
        }
        const corrigida = engine.validarComCorrecoes(texto, [], f);
        if (corrigida.valida || !corrigida.hard.some((p) => p.codigo === "CLAIM_OBJETIVO_SEM_FONTE" && p.termos.includes("firme"))) {
          falhas.push("validarComCorrecoes: " + JSON.stringify(separador + complemento));
        }
        const gerada = await engine.gerarDescricao({ ficha: f,
          aiProvider: provider({ ok: true, data: { descricao: texto, fatosUsados: [] } }) });
        if (gerada.ok || !gerada.problemas.some((p) => p.codigo === "CLAIM_OBJETIVO_SEM_FONTE" && p.termos.includes("firme"))) {
          falhas.push("gerarDescricao: " + JSON.stringify(separador + complemento));
        }
      }
    }
    assert.deepStrictEqual(falhas, [], "continuação da instrução sem ponto deve manter firme sob detector global");
    for (const ponto of ["", "."]) {
      for (const fronteira of ["", "\n\n", "\n* Posicione o item.", "\n\nESPECIFICAÇÕES\n* Material: Plástico."]) {
        const texto = base + "COMO USAR\n" + instrucao + ponto + fronteira;
        assert.ok(engine.validarDescricao(texto, [], f).valida, texto);
        const corrigida = engine.validarComCorrecoes(texto, [], f);
        assert.ok(corrigida.valida && corrigida.descricao.includes(instrucao + ponto), JSON.stringify(corrigida));
        const gerada = await engine.gerarDescricao({ ficha: f,
          aiProvider: provider({ ok: true, data: { descricao: texto, fatosUsados: [] } }) });
        assert.ok(gerada.ok && gerada.descricao.includes(instrucao + ponto), JSON.stringify(gerada));
      }
      const fora = engine.validarComCorrecoes(base + "BENEFÍCIOS\n" + instrucao + ponto, [], f);
      assert.ok(!fora.valida && fora.hard.some((p) => p.termos.includes("firme")), JSON.stringify(fora));
    }
    const terminada = base + "COMO USAR\n" + instrucao + ".\n\nPosicione o item.";
    assert.ok(engine.validarDescricao(terminada, [], f).valida, terminada);
    const adicional = engine.validarComCorrecoes(base + "COMO USAR\n" + instrucao + ".\n\ndurante uso prolongado.", [], f);
    assert.ok(!adicional.valida && adicional.hard.some((p) => p.codigo === "CLAIM_OBJETIVO_SEM_FONTE" &&
      p.termos.includes("uso prolongado") && !p.termos.includes("firme")), JSON.stringify(adicional));
    ok("54c. fronteira completa de instrução: continuação mesmo após blank line é HARD; isolada preservada também em gerarDescricao");
  }

  // Valor factual inequívoco + adjetivo sem fonte: só o adjetivo sai.
  {
    const base = "DESCRIÇÃO PRINCIPAL\nLixeira JSN em plástico.\n\nESPECIFICAÇÕES\n";
    for (const [id, label, value] of [["COLOR", "Cor", "Azul"], ["COLOR", "Cor", "Azul marinho"],
      ["COMPOSITION", "Composição", "100% algodão"], ["VOLUME_CAPACITY", "Capacidade em volume", "60 L"]]) {
      const f = engine.montarFicha({ titulo: "Lixeira plástica", attributes_json: [
        { id: "BRAND", name: "Marca", value: "JSN" }, { id: "MATERIAL", name: "Material", value: "Plástico" },
        { id, name: label, value }] }, { categoriaNome: "Lixeiras", descricaoEstado: "sem_descricao" });
      const item = "* " + label + ": " + value;
      const v = engine.validarComCorrecoes(base + item + " acetinado.", [], f);
      assert.ok(v.valida && v.descricao.includes(item) && !v.descricao.includes("acetinado"), JSON.stringify(v));
      assert.ok(v.avisos.some((a) => a.codigo === "TERMO_NAO_COMPROVADO" && a.trecho.includes("acetinado")));
    }
    const f = engine.montarFicha({ titulo: "Lixeira plástica", attributes_json: [
      { id: "BRAND", name: "Marca", value: "JSN" }, { id: "COLOR", name: "Cor", value: "Azul acetinado" }] },
    { categoriaNome: "Lixeiras", descricaoEstado: "sem_descricao" });
    assert.ok(engine.validarComCorrecoes(base + "* Cor: Azul acetinado.", [], f).descricao.includes("Azul acetinado"), "adjetivo comprovado fica");
    ok("55. correção de item rotulado conserva valor composto, número e unidade; adjetivo comprovado fica");
  }

  // Uma frase SOFT não pode levar a única ocorrência de um fato útil.
  {
    const f = engine.montarFicha({ titulo: "Lixeira plástica", attributes_json: [
      { id: "BRAND", name: "Marca", value: "JSN" }, { id: "COLOR", name: "Cor", value: "Azul" },
      { id: "MATERIAL", name: "Material", value: "Plástico" }] },
    { categoriaNome: "Lixeiras", descricaoEstado: "sem_descricao" });
    const base = "DESCRIÇÃO PRINCIPAL\nLixeira JSN em plástico.";
    const ruim = base + "\n\nDESTAQUES DO PRODUTO\nA cor azul tem acabamento acetinado.";
    const v = engine.validarComCorrecoes(ruim, [], f);
    assert.ok(!v.valida && v.hard.some((p) => p.codigo === "FATO_PERDIDO"), JSON.stringify(v));
    assert.strictEqual(v.descricao, ruim, "não retorna texto mutilado como aprovado");
    const p = provider({ ok: true, data: { descricao: ruim, fatosUsados: [] } });
    const gerada = await engine.gerarDescricao({ ficha: f, aiProvider: p });
    assert.ok(!gerada.ok && gerada.problemas.some((q) => q.codigo === "FATO_PERDIDO"));
    assert.ok(!("descricao" in gerada));
    // Presença em outro trecho preserva o fato; omissão desde o início não é perda.
    assert.ok(engine.validarComCorrecoes(ruim.replace("em plástico.", "em plástico azul."), [], f).valida);
    assert.ok(engine.validarComCorrecoes(base, [], f).valida);
    // Cor verdadeira junto de alternativa/negação não vira item factual reconstituído.
    for (const item of ["* Cor: Azul ou acetinado.", "* Cor: Quase azul acetinado."]) {
      const r = engine.validarComCorrecoes(base + "\n\nESPECIFICAÇÕES\n" + item, [], f);
      assert.ok(!r.valida, item + " → " + JSON.stringify(r));
    }
    ok("56. SOFT não aprova perda de fato útil; presença alternativa e omissão original não são perda");
  }

  {
    const f = engine.montarFicha({ titulo: "Lixeira plástica", attributes_json: [
      { id: "BRAND", name: "Marca", value: "JSN" }, { id: "COLOR", name: "Cor", value: "Azul" }] },
    { categoriaNome: "Lixeiras", descricaoEstado: "sem_descricao" });
    const t = "DESCRIÇÃO PRINCIPAL\nLixeira JSN. Confira as características na cor azul.";
    assert.ok(engine.validarDescricao(t, [], f).valida);
    const p = engine.polirDescricao(t, [], f);
    assert.ok(p.descricao.includes("azul"), JSON.stringify(p));
    assert.ok(!p.ajustes.includes("METATEXTO"), "regra editorial que apagaria fato útil é descartada");
    ok("57. polimento não apaga fato útil único; descarte de valor sem informação mantém política anterior");
  }

  {
    const f = engine.montarFicha({ titulo: "Lixeira JSN", attributes_json: [
      { id: "BRAND", name: "Marca", value: "JSN" },
      { id: "LID_MATERIAL", name: "Material da tampa", value: "Plástico" }] },
    { categoriaNome: "Lixeiras", descricaoEstado: "sem_descricao" });
    const t = "DESCRIÇÃO PRINCIPAL\nLixeira JSN.\n\nESPECIFICAÇÕES\n* Material: Plástico acetinado.";
    const v = engine.validarComCorrecoes(t, [], f);
    assert.ok(!v.valida, "rótulo genérico não reconstrói o material de uma parte como material do produto: " + JSON.stringify(v));
    ok("58. reconstrução exige rótulo completo: material de uma parte não vira material genérico");
  }

  console.log(`\n✓ ${checks} verificações do Description Engine`);
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
