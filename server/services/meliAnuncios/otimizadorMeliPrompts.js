// server/services/meliAnuncios/otimizadorMeliPrompts.js
// -----------------------------------------------------------------------------
// Prompts do Agente Otimizador Textual de Anúncios Meli.
//
// Centraliza system prompt + prompts por tipo (seo / descricao / ficha_tecnica).
// O VenForce define as regras de negócio; o Claude só executa o que está aqui.
//
// PROMPT_VERSION é salvo junto da sugestão — se um prompt mudar, suba a versão
// para conseguir comparar resultados antigos x novos depois.
// -----------------------------------------------------------------------------

const PROMPT_VERSION = "meli-otimizador-v1";

// ---------------------------------------------------------------------------
// System prompt — vale para todos os tipos (seção 12 do projeto).
// ---------------------------------------------------------------------------
const SYSTEM_BASE = [
  "Você é um agente otimizador de anúncios do Mercado Livre.",
  "Sua função é melhorar a parte textual dos anúncios sem alterar preço, estoque, categoria, marca, imagens ou informações técnicas não confirmadas.",
  "",
  "Você pode sugerir: título Mercado Livre, campo modelo, descrição e ficha técnica, conforme solicitado.",
  "",
  "Regras gerais:",
  "- Não usar negrito.",
  "- Não usar emojis.",
  "- Não usar HTML.",
  "- Não inventar marca, material, medidas, voltagem, peso ou compatibilidade.",
  "- Não prometer benefícios falsos.",
  "- Não alterar SKU.",
  "- Não alterar o sentido do produto.",
  "- Não usar linguagem artificial.",
  "- Usar linguagem comercial, clara, natural e otimizada para Mercado Livre.",
  "- Adaptar o texto à categoria real do produto, não focar só em moda.",
  "- Se alguma informação não estiver clara, incluir alerta de revisão humana.",
  "- Responder SEMPRE e SOMENTE com JSON válido, sem markdown, sem cercas de código, sem texto fora do JSON.",
].join("\n");

// ---------------------------------------------------------------------------
// Monta o bloco "dados do anúncio" comum a todos os prompts.
// ---------------------------------------------------------------------------
function blocoDadosAnuncio(anuncio) {
  let attrs = [];
  try {
    attrs = Array.isArray(anuncio.attributes_json)
      ? anuncio.attributes_json
      : JSON.parse(anuncio.attributes_json || "[]");
  } catch (e) {
    attrs = [];
  }

  const attrsTxt = attrs.length
    ? attrs
        .map(
          (a) =>
            "  - " +
            (a.name || a.id || "?") +
            ": " +
            (a.value ? a.value : "(vazio)")
        )
        .join("\n")
    : "  (nenhum atributo informado)";

  const descricao = (anuncio.descricao_atual || "").trim();

  return [
    "Dados atuais do anúncio:",
    "- SKU: " + (anuncio.sku || "(sem SKU)"),
    "- Título atual: " + (anuncio.titulo || "(sem título)"),
    "- Campo modelo atual: " + (anuncio.modelo || "(vazio)"),
    "- Marca: " + (anuncio.marca || "(não informada)"),
    "- Categoria (id): " + (anuncio.category_id || "(não informada)"),
    "- Preço: " + (anuncio.preco != null ? anuncio.preco : "(não informado)"),
    "Atributos atuais:",
    attrsTxt,
    "Descrição atual:",
    descricao ? descricao : "  (sem descrição)",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// SEO — título + campo modelo (seção 13).
// ---------------------------------------------------------------------------
function promptSeo(anuncio) {
  return [
  "Regras do título Mercado Livre:",
"- O título deve ter no máximo 60 caracteres.",
"- Use o máximo possível dos 60 caracteres.",
"- Objetivo ideal: entre 55 e 60 caracteres.",
"- Só aceite menos de 55 caracteres se realmente não houver uma palavra inteira relevante que caiba sem ultrapassar 60.",
"- Nunca corte palavra pela metade para chegar em 60.",
"- Priorize incluir o máximo de informações úteis: tipo do produto, medida, quantidade, material, marca, uso principal e característica relevante.",
"- Claro, descritivo e otimizado para busca.",
"- Evitar repetições desnecessárias.",
"- Não usar caixa alta forçada.",
"- Não usar emojis nem símbolos desnecessários.",
"- Não inventar informações. Preservar o sentido do produto.",
"- Se o título tiver menos de 55 caracteres, explique no motivo por que não foi possível preencher mais sem inventar informação.",
"- A resposta será considerada inválida se titulo_sugerido tiver menos de 55 caracteres.",
"- O título deve obrigatoriamente ficar entre 55 e 60 caracteres.",
"- Se estiver abaixo de 55 caracteres, adicione uma palavra real e relevante do produto, como uso, material, marca, medida, aplicação ou característica confirmada.",
    "",
    "Campo modelo:",
"- Criar um campo modelo rico em palavras indexadoras diretamente relacionadas ao produto.",
"- Use o máximo de informação útil possível, sem inventar dados.",
"- Incluir variações de busca, sinônimos, aplicações, termos técnicos e características relevantes.",
"- Não repetir o título inteiro, mas complementar o título.",
"- Não usar palavras genéricas demais ou sem relação com o produto.",
"- Evitar repetição inútil de termos.",
"- Objetivo: campo modelo com alta densidade de termos relevantes para busca.",
    "",
    blocoDadosAnuncio(anuncio),
    "",
    "Responda SOMENTE com este JSON:",
    "{",
    '  "titulo_sugerido": "",',
    '  "titulo_sugerido_chars": 0,',
    '  "modelo_sugerido": "",',
    '  "score_seo": 0,',
    '  "motivo": "",',
    '  "alertas": []',
    "}",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Descrição — blocos padronizados (seção 14).
// ---------------------------------------------------------------------------
function promptDescricao(anuncio) {
  return [
    "Tarefa: criar uma descrição otimizada para Mercado Livre, organizada em",
    "blocos padronizados, com títulos de bloco em caixa alta.",
    "",
    "Blocos obrigatórios, nesta ordem:",
    "DESCRIÇÃO PRINCIPAL — texto corrido de 4 a 7 linhas, comercial e claro.",
    "DESTAQUES DO PRODUTO — bullet points copiáveis.",
    "COMO USAR — bullet points copiáveis.",
    "ESPECIFICAÇÕES — bullet points copiáveis.",
    "BENEFÍCIOS — bullet points copiáveis.",
    "EXPERIÊNCIA DE COMPRA — texto corrido, tom natural e persuasivo.",
    "",
    "Regras:",
    "- Não usar negrito, emoji ou HTML.",
    "- Não repetir frases iguais do título.",
    "- Estrutura em pirâmide invertida (mais importante primeiro).",
    "- Bullet points em texto comum copiável, usando o caractere '•'.",
    "- Não inventar informações técnicas. Se faltar dado, escrever de forma",
    "  genérica segura ou gerar alerta.",
    "",
    blocoDadosAnuncio(anuncio),
    "",
    "Responda SOMENTE com este JSON:",
    "{",
    '  "descricao_sugerida": "",',
    '  "melhorias": [],',
    '  "alertas": []',
    "}",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Ficha técnica — sugestões cautelosas de atributos (seção 15).
// ---------------------------------------------------------------------------
function promptFichaTecnica(anuncio) {
  return [
    "Tarefa: sugerir melhorias para a ficha técnica do anúncio Mercado Livre.",
    "",
    "Regras:",
    "- Não inventar material, medida, marca, compatibilidade, peso ou voltagem.",
    "- Se a informação for apenas inferida pelo título/descrição, marcar a",
    '  confiança como "media" ou "baixa".',
    "- Se não houver evidência suficiente, não sugerir um valor definitivo.",
    "- Sempre indicar se o campo precisa de revisão humana.",
    "- Priorizar campos importantes para o Mercado Livre.",
    "- Não substituir um dado atual correto sem motivo.",
    "",
    blocoDadosAnuncio(anuncio),
    "",
    "Responda SOMENTE com este JSON:",
    "{",
    '  "ficha_tecnica_sugerida": [',
    "    {",
    '      "campo": "",',
    '      "valor_atual": "",',
    '      "valor_sugerido": "",',
    '      "confianca": "alta | media | baixa",',
    '      "motivo": "",',
    '      "precisa_revisao": true',
    "    }",
    "  ],",
    '  "alertas": []',
    "}",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Resolve o prompt pelo tipo. Retorna null se o tipo não for suportado.
// ---------------------------------------------------------------------------
function montarPrompt(tipo, anuncio) {
  switch (tipo) {
    case "seo":
      return promptSeo(anuncio);
    case "descricao":
      return promptDescricao(anuncio);
    case "ficha_tecnica":
      return promptFichaTecnica(anuncio);
    default:
      return null;
  }
}

module.exports = {
  PROMPT_VERSION,
  SYSTEM_BASE,
  montarPrompt,
  promptSeo,
  promptDescricao,
  promptFichaTecnica,
};
