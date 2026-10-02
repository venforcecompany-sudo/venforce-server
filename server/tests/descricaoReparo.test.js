// server/tests/descricaoReparo.test.js
//
// Autorreparo da descrição (descricaoReparo.js, F13/F14), com o aiProvider
// SIMULADO. Nenhuma chamada real à IA, ao ML ou ao banco.
//
// Protege:
//   - HARD em frase dispensável (sem fato) → só a frase sai, sem nova IA;
//   - HARD em frase com fato do produto (material…) → NUNCA some calada:
//     vai para UMA chamada de reparo, com o texto rejeitado e a proibição de
//     fato novo, e o resultado é revalidado por inteiro;
//   - reparo que continua inválido → mesma rejeição de hoje (no máximo 2 chamadas);
//   - aprovada na 1ª → 1 chamada, igual à produção;
//   - gerarDescricaoSeo (o que a rota chama): flag OFF = gerarDescricao puro;
//     ON = contrato da produção + autorreparo, rejeição idêntica quando falha.

const assert = require("assert");
const eng = require("../services/meliAnuncios/seo/descricaoEngine");
const rep = require("../services/meliAnuncios/seo/descricaoReparo");

let falhas = 0;
let total = 0;
async function check(nome, fn) {
  total += 1;
  try { await fn(); console.log("  ✓ " + nome); }
  catch (e) { falhas += 1; console.error("  ✗ " + nome + "\n    " + (e.stack || e.message)); }
}

const ANUNCIO = {
  item_id: "MLB1",
  titulo: "Lixeira Plástica Quadrada Com Pedal 60 Litros Acme Branco",
  marca: "Acme",
  attributes_json: [
    { id: "BRAND", name: "Marca", value: "Acme" },
    { id: "COLOR", name: "Cor", value: "Branco" },
    { id: "VOLUME_CAPACITY", name: "Capacidade em volume", value: "60 L" },
    { id: "OPENING_TYPES", name: "Tipos de aberturas", value: "Pedal" },
    { id: "STRUCTURE_MATERIALS", name: "Materiais da estrutura", value: "Plástico" },
    { id: "SHAPE", name: "Formato", value: "Quadrado" },
    { id: "INSTALLATION_PLACEMENT", name: "Lugar de colocação", value: "De piso" },
  ],
};
const FICHA = eng.montarFicha(ANUNCIO, { categoriaNome: "Lixeiras", limiteCategoria: null, descricaoAtual: null, descricaoEstado: "sem_descricao" });

function texto(fechamento, extraPrincipal = "") {
  return [
    "DESCRIÇÃO PRINCIPAL",
    "Lixeira de piso da marca Acme, em plástico branco, com formato quadrado. Possui abertura por pedal e capacidade de 60 L." + extraPrincipal,
    "",
    "DESTAQUES DO PRODUTO",
    "* Marca Acme",
    "* Cor branca",
    "* Capacidade em volume de 60 L",
    "* Abertura por pedal",
    "",
    "COMO USAR",
    "* Ótima opção para manter a organização da cozinha ou do escritório.",
    "",
    "ESPECIFICAÇÕES",
    "* Cor: Branco",
    "* Capacidade em volume: 60 L",
    "* Tipos de aberturas: Pedal",
    "* Materiais da estrutura: Plástico",
    "",
    "BENEFÍCIOS",
    "* O pedal traz mais praticidade no dia a dia.",
    "",
    "EXPERIÊNCIA DE COMPRA",
    "Escolha uma lixeira prática para diferentes espaços." + fechamento,
  ].join("\n");
}
const USADOS = ["brand", "attr:COLOR", "attr:VOLUME_CAPACITY", "attr:OPENING_TYPES", "attr:STRUCTURE_MATERIALS"];
const resposta = (descricao) => ({ ok: true, provider: "mimo", model: "m", data: { descricao, fatosUsados: USADOS } });

function provider(...respostas) {
  const chamadas = [];
  return {
    chamadas,
    async gerarJSON(opts) {
      chamadas.push(opts);
      const r = respostas[Math.min(chamadas.length - 1, respostas.length - 1)];
      return typeof r === "function" ? r(opts) : r;
    },
  };
}

(async () => {
  console.log("descricaoReparo (autorreparo da descrição)");

  await check("pré-condição: o texto-base é aprovado pela validação de produção", async () => {
    const r = await eng.gerarDescricao({ ficha: FICHA, aiProvider: provider(resposta(texto(""))) });
    assert.strictEqual(r.ok, true, JSON.stringify(r.problemas || r.codigo));
  });

  await check("aprovada na 1ª → etapa 'primeira', 1 chamada (igual à produção)", async () => {
    const p = provider(resposta(texto("")));
    const r = await rep.gerarDescricaoComReparo({ ficha: FICHA, aiProvider: p });
    assert.strictEqual(r.etapa, "primeira");
    assert.strictEqual(r.chamadasIa, 1);
    assert.strictEqual(p.chamadas.length, 1);
  });

  await check("A — HARD em frase dispensável (promessa de recebimento) → só a frase sai, sem nova IA", async () => {
    const promessa = " Compre com confiança e receba tudo de forma simples e segura.";
    const p = provider(resposta(texto(promessa)));
    const r = await rep.gerarDescricaoComReparo({ ficha: FICHA, aiProvider: p });
    assert.strictEqual(r.producao.ok, false, "a produção rejeita este texto");
    assert.strictEqual(r.etapa, "remocao", JSON.stringify(r));
    assert.strictEqual(p.chamadas.length, 1, "remoção localizada não chama a IA");
    assert.deepStrictEqual(r.removidas.map((x) => x.trecho), [promessa.trim()]);
    assert.ok(!/receba/.test(r.descricao));
    assert.ok(/60 L/.test(r.descricao) && /Acme/.test(r.descricao), "nenhum fato saiu junto");
  });

  const comFato = " A estrutura em plástico é robusta e resistente ao uso diário.";
  const troca = (texto) => ({ ok: true, provider: "mimo", model: "m", data: { trocas: [{ id: "S1", texto }] } });

  await check("B — HARD em frase com fato (material) → NÃO remove; UMA chamada de reparo só com o trecho [S1], fatos a manter e proibição de fato novo", async () => {
    const p = provider(resposta(texto("", comFato)), troca("A estrutura é de plástico."));
    const r = await rep.gerarDescricaoComReparo({ ficha: FICHA, aiProvider: p });
    assert.strictEqual(r.producao.ok, false);
    assert.strictEqual(r.etapa, "reparo_ia", JSON.stringify(r));
    assert.strictEqual(p.chamadas.length, 2);
    assert.deepStrictEqual(r.removidas, [], "frase com fato nunca é removida em silêncio");
    assert.deepStrictEqual(r.autorizados.map((s) => s.texto), [comFato.trim()]);
    const prompt = p.chamadas[1].prompt;
    assert.ok(prompt.includes('[S1] "' + comFato.trim() + '"'), "o trecho vai numerado");
    assert.ok(/DEVEM continuar nele: Materiais da estrutura: Plástico/.test(prompt), "o fato do trecho vai como obrigatório");
    assert.ok(/NÃO introduza nenhum fato novo/.test(prompt));
    assert.ok(/"trocas"/.test(prompt));
    assert.strictEqual(p.chamadas[1].task, "seo_description");
    assert.ok(r.descricao.includes("A estrutura é de plástico."));
  });

  await check("B — tudo fora do segmento autorizado fica IDÊNTICO, mesmo se a IA devolver id extra", async () => {
    const rejeitada = texto("", comFato);
    const p = provider(resposta(rejeitada), { ok: true, data: { trocas: [
      { id: "S1", texto: "A estrutura é de plástico." }, { id: "S9", texto: "Lixeira inventada da marca Tramontina." }] } });
    const r = await rep.gerarDescricaoComReparo({ ficha: FICHA, aiProvider: p });
    assert.strictEqual(r.etapa, "reparo_ia", JSON.stringify(r));
    assert.strictEqual(r.aplicada, eng.normalizarTexto(r.rejeitada.replace(comFato.trim(), "A estrutura é de plástico.")));
    assert.ok(!/Tramontina/.test(r.descricao));
  });

  await check("B — troca que apaga fato válido sem relação com o erro → FATO_PERDIDO (reprova)", async () => {
    const p = provider(resposta(texto("", comFato)), troca(""));
    const r = await rep.gerarDescricaoComReparo({ ficha: FICHA, aiProvider: p });
    // "plástico" também está nas ESPECIFICAÇÕES: tirar a frase não perde o fato do texto
    assert.strictEqual(r.etapa, "reparo_ia", JSON.stringify(r.hardFinais));
    const soNaFrase = texto("", comFato).replace("* Materiais da estrutura: Plástico\n", "").replace("em plástico branco", "branco");
    const p2 = provider(resposta(soNaFrase), troca(""));
    const r2 = await rep.gerarDescricaoComReparo({ ficha: FICHA, aiProvider: p2 });
    assert.strictEqual(r2.ok, false, JSON.stringify(r2));
    assert.deepStrictEqual(r2.hardFinais, ["FATO_PERDIDO"]);
    assert.deepStrictEqual(r2.fatosPerdidos.map((f) => f.value), ["Plástico"]);
  });

  await check("C — reparo ainda inválido → falha com a rejeição de hoje; no máximo 2 chamadas", async () => {
    const p = provider(resposta(texto("", comFato)), troca(comFato.trim()), resposta(texto("")));
    const r = await rep.gerarDescricaoComReparo({ ficha: FICHA, aiProvider: p });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.etapa, "falha");
    assert.strictEqual(p.chamadas.length, 2, "uma geração + UMA chamada de reparo, nunca mais");
    assert.strictEqual(r.producao.codigo, "DESCRICAO_INVALIDA");
  });

  await check("troca que inventa fato novo (outra marca) é barrada pela revalidação completa", async () => {
    const p = provider(resposta(texto("", comFato)), troca("A estrutura em plástico é compatível com sacos Tramontina."));
    const r = await rep.gerarDescricaoComReparo({ ficha: FICHA, aiProvider: p });
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.strictEqual(r.etapa, "falha");
  });

  await check("resposta sem trocas (formato antigo, texto inteiro) → falha, nunca aceita reescrita total", async () => {
    const p = provider(resposta(texto("", comFato)), resposta(texto("")));
    const r = await rep.gerarDescricaoComReparo({ ficha: FICHA, aiProvider: p });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.codigoReparo, "RESPOSTA_INVALIDA");
  });

  await check("marca: termo que é descritor comprovado (IS_BLACK_OUT=Sim) não é marca fora de posição de marca", async () => {
    const cortina = eng.montarFicha({ item_id: "MLB2", titulo: "Cortina Blackout Tecido 4,00 X 2,80", attributes_json: [
      { id: "BRAND", name: "Marca", value: "Doce Lar" }, { id: "IS_BLACK_OUT", name: "É blecaute", value: "Sim" },
      { id: "MATERIAL", name: "Material", value: "Poliéster" }] }, { categoriaNome: "Cortinas" });
    const base = "Cortina blackout da Doce Lar, em poliéster.\n\nDESTAQUES DO PRODUTO\n* LINHA\n* Material poliéster";
    const codigos = (linha) => (eng.validarDescricao(base.replace("LINHA", linha), ["brand"], cortina).problemas || [])
      .filter((x) => /MARCA|NOME/.test(x.codigo)).map((x) => x.codigo + ":" + x.termos.join("/"));
    assert.deepStrictEqual(codigos("Blackout em tecido"), []);
    assert.deepStrictEqual(codigos("Nike em tecido"), ["MARCA_CONFLITANTE:Nike"]);
    assert.deepStrictEqual(codigos("Da marca Blackout"), ["MARCA_CONFLITANTE:Blackout"]);
  });

  await check("afirmação sem fonte: IA que troca por outro benefício é contida — só o fragmento inválido sai; trecho sem fato sai inteiro", async () => {
    const comPedal = " A lixeira tem abertura por pedal, com acabamento resistente ao uso diário.";
    const semFato = " Um produto robusto que traz mais segurança para o dia a dia.";
    const p = provider(resposta(texto(semFato, comPedal)), { ok: true, data: { trocas: [
      { id: "S1", texto: "A lixeira tem abertura por pedal, com design elegante e moderno." },
      { id: "S2", texto: "Um produto que traz elegância para o dia a dia." }] } });
    const r = await rep.gerarDescricaoComReparo({ ficha: FICHA, aiProvider: p });
    assert.strictEqual(r.etapa, "reparo_ia", JSON.stringify(r.hardFinais || r.motivoLocal));
    assert.ok(/só RETIRE o fragmento sem fonte/.test(p.chamadas[1].prompt), "o prompt pede só retirar");
    const [s1, s2] = r.trocas;
    assert.strictEqual(s1.contida, "FRAGMENTO");
    assert.strictEqual(s1.depois, "A lixeira tem abertura por pedal.");
    assert.strictEqual(s2.contida, "TRECHO");
    assert.strictEqual(s2.depois, "");
    assert.ok(!/elegante|eleg[aâ]ncia|moderno|resistente|robusto/i.test(r.descricao), r.descricao);
    assert.ok(r.descricao.includes("A lixeira tem abertura por pedal."));
  });

  await check("afirmação sem fonte: IA que só retira o fragmento não é alterada", async () => {
    const comPedal = " A lixeira tem abertura por pedal, com acabamento resistente ao uso diário.";
    const p = provider(resposta(texto("", comPedal)), troca("A lixeira tem abertura por pedal, com acabamento ao uso diário."));
    const r = await rep.gerarDescricaoComReparo({ ficha: FICHA, aiProvider: p });
    assert.strictEqual(r.trocas[0].contida, undefined);
    assert.strictEqual(r.trocas[0].depois, "A lixeira tem abertura por pedal, com acabamento ao uso diário.");
  });

  await check("zero atributo factual some: polimento que tiraria 'Sem validade' (atributo) é descartado", async () => {
    const ficha = eng.montarFicha({ ...ANUNCIO, attributes_json: ANUNCIO.attributes_json.concat([
      { id: "PRODUCT_FEATURES", name: "Características do produto", value: "Sem validade" }]) },
    { categoriaNome: "Lixeiras", limiteCategoria: null, descricaoAtual: null, descricaoEstado: "sem_descricao" });
    const t = texto("").replace("* Materiais da estrutura: Plástico", "* Materiais da estrutura: Plástico\n* Características do produto: Sem validade");
    assert.ok(!/Sem validade/.test(eng.polirDescricao(t, USADOS, ficha).descricao), "pré-condição: o polimento de produção tira");
    const r = rep.polirSemPerder({ descricao: t, fatosUsados: USADOS }, ficha);
    assert.strictEqual(r.semPolimento, true);
    assert.ok(r.descricao.includes("* Características do produto: Sem validade"));
    assert.deepStrictEqual(rep.fatosPerdidos(t, r.descricao, ficha, []), []);
  });

  await check("erro da IA na 1ª geração → etapa 'erro', sem reparo", async () => {
    const p = provider({ ok: false, codigo: "TIMEOUT", erro: "timeout" });
    const r = await rep.gerarDescricaoComReparo({ ficha: FICHA, aiProvider: p });
    assert.strictEqual(r.etapa, "erro");
    assert.strictEqual(r.codigo, "TIMEOUT");
    assert.strictEqual(p.chamadas.length, 1);
  });

  // ── gerarDescricaoSeo: o que a rota chama, com a flag OFF e ON ──────────────
  const OFF = {};
  const ON = { SEO_DESCRICAO_AUTORREPARO: "on" };

  await check("flag: desligada por padrão; só 1/true/on ligam", async () => {
    assert.strictEqual(rep.autorreparoAtivo({}), false);
    for (const v of ["", "0", "false", "off", "sim", "yes", " ligado "]) assert.strictEqual(rep.autorreparoAtivo({ SEO_DESCRICAO_AUTORREPARO: v }), false, v);
    for (const v of ["1", "true", "on", " ON ", "True"]) assert.strictEqual(rep.autorreparoAtivo({ SEO_DESCRICAO_AUTORREPARO: v }), true, v);
  });

  await check("OFF: resposta IDÊNTICA a gerarDescricao em aprovada, rejeitada e erro; 1 chamada; sem campo autorreparo", async () => {
    for (const resp of [resposta(texto("")), resposta(texto(" Compre com confiança e receba tudo de forma simples e segura.")),
      resposta(texto("", comFato)), { ok: false, codigo: "TIMEOUT", erro: "timeout" }]) {
      const p = provider(resp, troca("A estrutura é de plástico."));
      const r = await rep.gerarDescricaoSeo({ ficha: FICHA, aiProvider: p, env: OFF });
      assert.deepStrictEqual(r, await eng.gerarDescricao({ ficha: FICHA, aiProvider: provider(resp) }));
      assert.strictEqual(p.chamadas.length, 1, "flag OFF nunca chama o reparo");
      assert.ok(!("autorreparo" in r));
    }
  });

  await check("ON + aprovada na 1ª: resposta idêntica à produção, 1 chamada", async () => {
    const p = provider(resposta(texto("")));
    const r = await rep.gerarDescricaoSeo({ ficha: FICHA, aiProvider: p, env: ON });
    assert.deepStrictEqual(r, await eng.gerarDescricao({ ficha: FICHA, aiProvider: provider(resposta(texto(""))) }));
    assert.strictEqual(p.chamadas.length, 1);
  });

  await check("ON + remoção localizada: contrato ok da produção + autorreparo { remocao }, sem 2ª chamada", async () => {
    const promessa = " Compre com confiança e receba tudo de forma simples e segura.";
    const p = provider(resposta(texto(promessa)));
    const r = await rep.gerarDescricaoSeo({ ficha: FICHA, aiProvider: p, env: ON });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(p.chamadas.length, 1);
    assert.strictEqual(r.autorreparo.etapa, "remocao");
    assert.deepStrictEqual(r.autorreparo.removidas.map((x) => x.trecho), [promessa.trim()]);
    assert.strictEqual(r.limite, FICHA.limite);
    assert.strictEqual(r.chars, r.descricao.length);
    assert.ok(r.fatosUsados.some((f) => f.id === "brand" && f.label === "Marca" && f.value === "Acme"), JSON.stringify(r.fatosUsados));
    assert.ok(!/receba/.test(r.descricao));
  });

  await check("ON + reparo restrito: 2 chamadas, trocas expostas, todos os atributos estruturais seguem no texto", async () => {
    const p = provider(resposta(texto("", comFato)), troca("A estrutura é de plástico."));
    const r = await rep.gerarDescricaoSeo({ ficha: FICHA, aiProvider: p, env: ON });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(p.chamadas.length, 2);
    assert.strictEqual(r.autorreparo.etapa, "reparo_ia");
    assert.deepStrictEqual(r.autorreparo.trocas.map((t) => [t.id, t.antes, t.depois]), [["S1", comFato.trim(), "A estrutura é de plástico."]]);
    assert.deepStrictEqual(rep.fatosPerdidos(texto("", comFato), r.descricao, FICHA, []), [], "zero atributo factual some");
    assert.ok(r.fatosUsados.every((f) => f.label), "fatosUsados no formato { id, label, value }");
  });

  await check("ON + reparo que não resolve: a MESMA rejeição da produção + autorreparo { falha }; nunca mais de 2 chamadas", async () => {
    const p = provider(resposta(texto("", comFato)), troca(comFato.trim()), resposta(texto("")));
    const r = await rep.gerarDescricaoSeo({ ficha: FICHA, aiProvider: p, env: ON });
    const prod = await eng.gerarDescricao({ ficha: FICHA, aiProvider: provider(resposta(texto("", comFato))) });
    assert.strictEqual(p.chamadas.length, 2);
    const { autorreparo, ...resto } = r;
    assert.deepStrictEqual(resto, prod, "mesmo codigo/motivo/problemas da produção");
    assert.strictEqual(autorreparo.etapa, "falha");
    assert.ok(!("descricao" in r), "texto inválido não chega ao front");
  });

  await check("ON + erro da IA no reparo ou na 1ª geração: contrato de erro de hoje", async () => {
    const p = provider(resposta(texto("", comFato)), { ok: false, codigo: "TIMEOUT", erro: "timeout" });
    const r = await rep.gerarDescricaoSeo({ ficha: FICHA, aiProvider: p, env: ON });
    assert.deepStrictEqual([r.ok, r.codigo, r.autorreparo.etapa, r.autorreparo.codigo], [false, "DESCRICAO_INVALIDA", "falha", "TIMEOUT"]);
    const p2 = provider({ ok: false, codigo: "AI_RESPONSE_TRUNCATED", erro: "cortada" });
    const r2 = await rep.gerarDescricaoSeo({ ficha: FICHA, aiProvider: p2, env: ON });
    assert.deepStrictEqual(r2, await eng.gerarDescricao({ ficha: FICHA, aiProvider: provider({ ok: false, codigo: "AI_RESPONSE_TRUNCATED", erro: "cortada" }) }));
    assert.strictEqual(p2.chamadas.length, 1);
    const r3 = await rep.gerarDescricaoSeo({ ficha: FICHA, aiProvider: { async gerarJSON() { throw new Error("boom"); } }, env: ON });
    assert.strictEqual(r3.ok, false);
  });

  await check("guarda SOFT: reparo não pode tratar FATO_PERDIDO como autorização de apagar o fato", async () => {
    const f = eng.montarFicha({ titulo: "Lixeira plástica", attributes_json: [
      { id: "BRAND", name: "Marca", value: "JSN" }, { id: "COLOR", name: "Cor", value: "Azul" },
      { id: "MATERIAL", name: "Material", value: "Plástico" }] },
    { categoriaNome: "Lixeiras", descricaoEstado: "sem_descricao" });
    const t = "DESCRIÇÃO PRINCIPAL\nLixeira JSN em plástico.\n\nDESTAQUES DO PRODUTO\nA cor azul tem acabamento acetinado.";
    const p = provider(resposta(t), troca(""));
    const r = await rep.gerarDescricaoSeo({ ficha: f, aiProvider: p, env: ON });
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.ok(!("descricao" in r));
    assert.strictEqual(p.chamadas.length, 2);
    assert.ok(p.chamadas[1].prompt.includes("DEVEM continuar nele: Cor: Azul"), p.chamadas[1].prompt);
    const seguro = provider(resposta(t), troca("A cor é azul."));
    const aprovado = await rep.gerarDescricaoSeo({ ficha: f, aiProvider: seguro, env: ON });
    assert.ok(aprovado.ok && aprovado.descricao.includes("azul"), JSON.stringify(aprovado));
    const off = await rep.gerarDescricaoSeo({ ficha: f, aiProvider: provider(resposta(t)), env: OFF });
    assert.ok(!off.ok && off.problemas.some((q) => q.codigo === "FATO_PERDIDO"));
  });

  if (falhas) { console.error(`\n${falhas}/${total} falha(s)`); process.exit(1); }
  console.log(`\n✓ descricaoReparo ok (${total} verificações)`);
})();
