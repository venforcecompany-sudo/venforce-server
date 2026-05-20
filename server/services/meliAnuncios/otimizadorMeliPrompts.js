// server/services/meliAnuncios/otimizadorMeliPrompts.js
// -----------------------------------------------------------------------------
// Prompts do Agente Otimizador Textual de Anúncios Meli.
//
// Reescritos para serem mais rigorosos, evitar invenção e gerar saída útil
// de verdade para um vendedor experiente de Mercado Livre Brasil.
//
// PROMPT_VERSION sobe a cada reescrita relevante — facilita comparar resultados
// antigos x novos nas linhas salvas em meli_anuncio_otimizacoes.
// -----------------------------------------------------------------------------

const PROMPT_VERSION = "meli-otimizador-v2";

// -----------------------------------------------------------------------------
// System prompt — vale para todos os tipos.
// -----------------------------------------------------------------------------
const SYSTEM_BASE = [
  "Você é um agente otimizador de anúncios do Mercado Livre.",
  "Melhora títulos, campo modelo, descrição e ficha técnica sem alterar preço, estoque, categoria ou imagens.",
  "Regras: sem negrito, sem emojis, sem HTML, sem inventar marca/medida/material/benefício.",
  "Linguagem comercial, clara e otimizada para busca no Mercado Livre.",
  "Responda SEMPRE e SOMENTE com JSON válido, sem markdown, sem texto fora do JSON.",
].join("\n");

// -----------------------------------------------------------------------------
// Bloco de dados — versão enxuta (para SEO).
// Não inclui descrição inteira nem atributos vazios — corta tokens à toa.
// -----------------------------------------------------------------------------
function blocoDadosEnxuto(anuncio) {
  let attrs = [];
  try {
    attrs = Array.isArray(anuncio.attributes_json)
      ? anuncio.attributes_json
      : JSON.parse(anuncio.attributes_json || "[]");
  } catch (e) {
    attrs = [];
  }
  const attrsFiltrados = attrs
    .filter((a) => a.value && String(a.value).trim() !== "")
    .slice(0, 20);
  const attrsTxt = attrsFiltrados.length
    ? attrsFiltrados.map((a) => "  - " + (a.name || a.id) + ": " + a.value).join("\n")
    : "  (nenhum atributo informado)";

  return [
    "Dados do anúncio:",
    "- Título atual: " + (anuncio.titulo || "(sem título)"),
    "  (" + (anuncio.titulo ? anuncio.titulo.length : 0) + " caracteres)",
    "- Campo modelo atual: " + (anuncio.modelo || "(vazio)"),
    "- Marca: " + (anuncio.marca || "(não informada)"),
    "- Categoria (id): " + (anuncio.category_id || "(não informada)"),
    "- SKU: " + (anuncio.sku || "(sem SKU)"),
    "- Preço: " + (anuncio.preco != null ? anuncio.preco : "(não informado)"),
    "Atributos preenchidos:",
    attrsTxt,
  ].join("\n");
}

// -----------------------------------------------------------------------------
// Bloco de dados — versão completa (para descrição e ficha técnica).
// Inclui descrição atual (truncada) e TODOS os atributos (vazios indicam
// lacuna a preencher na ficha técnica).
// -----------------------------------------------------------------------------
function blocoDadosCompleto(anuncio, descricaoAtual) {
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
            "  - " + (a.name || a.id || "?") + ": " + (a.value || "(vazio)")
        )
        .join("\n")
    : "  (nenhum atributo informado)";

  const descricao = (anuncio.descricao_atual || "").trim().slice(0, 350);

  return [
    "Dados do anúncio:",
    "- Título atual: " + (anuncio.titulo || "(sem título)"),
    "- Campo modelo atual: " + (anuncio.modelo || "(vazio)"),
    "- Marca: " + (anuncio.marca || "(não informada)"),
    "- Categoria (id): " + (anuncio.category_id || "(não informada)"),
    "- SKU: " + (anuncio.sku || "(sem SKU)"),
    "- Preço: " + (anuncio.preco != null ? anuncio.preco : "(não informado)"),
    "Atributos (atuais):",
    attrsTxt,
    "Descrição atual:",
    descricao ? (anuncio.descricao_atual.length > 350 ? descricao + "..." : descricao) : "(sem descrição)",
  ].join("\n");
}

// =============================================================================
// SEO — 3 opções de título + campo modelo + score.
// =============================================================================
function promptSeo(anuncio) {
  return [
    "Tarefa: gerar 3 opções de TÍTULO Mercado Livre e o campo MODELO ideal.",
    "",
    "Regras do título (rígidas):",
    "- Máximo 60 caracteres por título. NUNCA ultrapassar.",
    "- Alvo: entre 55 e 60 caracteres sempre que houver informação para isso.",
    "- Não cortar palavras. Se 60 estourar, encurte uma palavra inteira.",
    "- Não usar caixa alta agressiva. 'Kit Puxador' está OK; 'KIT PUXADOR' não.",
    "- Não repetir a mesma palavra dentro do mesmo título.",
    "- Não usar pontuação decorativa (***, !!!, ★, ►, |, /).",
    "- Não inventar marca. Use a marca apenas se estiver no campo Marca ou",
    "  visível nos atributos.",
    "- As 3 opções devem ser claramente diferentes entre si — não pequenas",
    "  variações da mesma frase.",
    "",
    "Regras do campo modelo:",
    "- O campo modelo é um indexador puro: palavras-chave separadas APENAS por espaço.",
    "- Objetivo: máxima densidade de termos relevantes para busca no Mercado Livre.",
    "- Inclua sinônimos, variações, termos técnicos, aplicações, nomes alternativos do produto.",
    "- NÃO repetir palavras já usadas no titulo_sugerido.",
    "- NÃO repetir nenhuma palavra dentro do próprio modelo.",
    "- NÃO usar conectivos: de, para, com, e, em, do, da, dos, das, por.",
    "- NÃO usar frases. Apenas palavras soltas.",
    "- NÃO inventar marca, medida, material, compatibilidade.",
    "- Gere o máximo de termos seguros que os dados permitirem.",
    "- Exemplo bom (strap musculação): \"munhequeira pulso academia treino levantamento powerlifting crossfit halter rosca desenvolvimento\"",
    "- Exemplo ruim: \"musculacao treino de forca pegada firme acessorio\"",
    "",
    "",
    "Score SEO (0 a 100):",
    "- Avalia a MELHOR das 3 opções considerando: clareza, palavras-chave,",
    "  aproveitamento do limite de caracteres, ausência de invenção,",
    "  diferenciação em relação ao título atual.",
    "- Use 80-100 só para títulos realmente fortes.",
    "- Use 50-70 quando faltam dados.",
    "- Use abaixo de 50 quando o melhor possível ainda é fraco.",
    "",
    "Motivo:",
    "- 1 a 2 linhas explicando qual estratégia você usou na sugestão",
    "  principal e por que ela funciona neste anúncio.",
    "",
    "Alertas:",
    "- Liste lacunas relevantes (ex.: 'marca não informada — sugestões usam",
    "  apenas a categoria genérica', 'sem dimensões na ficha técnica').",
    "",
    blocoDadosEnxuto(anuncio),
    "",
    "Responda SOMENTE com este JSON, sem nada antes ou depois:",
    "{",
    '  "titulo_sugerido": "",',
    '  "titulo_sugerido_chars": 0,',
    '  "titulos_alternativos": ["", "", ""],',
    '  "modelo_sugerido": "",',
    '  "modelo_sugerido_chars": 0,',
    '  "score_seo": 0,',
    '  "motivo": "",',
    '  "alertas": []',
    "}",
  ].join("\n");
}

// =============================================================================
// Descrição — blocos padronizados.
// =============================================================================
function promptDescricao(anuncio, descricaoAtual) {
  return [
    "Tarefa: gerar uma DESCRIÇÃO completa para o anúncio Mercado Livre,",
    "dividida em blocos padronizados.",
    "",
    "Estrutura obrigatória, nesta ordem exata, separada por UMA linha em branco:",
    "",
    "DESCRIÇÃO PRINCIPAL",
    "- 4 a 7 linhas de texto corrido, comercial e claro.",
    "- Mostre o que é o produto, pra quem serve e qual problema resolve.",
    "- Não enrole. Comece pelo mais importante (pirâmide invertida).",
    "",
    "DESTAQUES DO PRODUTO",
    "- Bullets iniciados com '• ' (caractere bullet seguido de espaço).",
    "- 4 a 7 itens.",
    "- Cada item é uma frase curta sobre uma característica ou benefício real.",
    "",
    "COMO USAR",
    "- Bullets com '• '. 3 a 5 itens.",
    "- Passos práticos de uso.",
    "- Se não fizer sentido para a categoria, escreva apenas:",
    "  '• Produto pronto para uso conforme características do fabricante.'",
    "",
    "ESPECIFICAÇÕES",
    "- Bullets com '• '.",
    "- Use APENAS dados da ficha técnica fornecida. Não invente.",
    "- Formato: '• Campo: valor'.",
    "- Se faltarem dados importantes, encerre o bloco com:",
    "  '• Demais especificações conforme ficha técnica do anúncio.'",
    "",
    "BENEFÍCIOS",
    "- Bullets com '• '. 3 a 5 itens.",
    "- Foque no que o comprador GANHA, não no produto em si.",
    "- Proibido: 'alta qualidade', 'tecnologia avançada', 'o melhor da",
    "  categoria', 'ideal para você' sem evidência nos dados.",
    "",
    "EXPERIÊNCIA DE COMPRA",
    "- 2 a 4 linhas de texto corrido, tom natural.",
    "- Não prometa prazo, garantia ou suporte específico sem dado.",
    "- Foque em facilidade de pedido, embalagem cuidadosa, atendimento.",
    "",
    "Regras gerais:",
    "- Sem HTML, sem emoji, sem negrito, sem markdown, sem asterisco.",
    "- Os títulos de bloco vão em CAIXA ALTA, em linha sozinha.",
    "- Não repita frases entre os blocos.",
    "- Não copie o título do anúncio inteiro dentro da descrição.",
    "- Máximo 2500 caracteres no total da descrição.",
    "- Use português brasileiro, comercial e direto.",
    "",
    "Melhorias:",
    "- Liste o que melhorou em relação à descrição atual. Se não havia",
    "  descrição, escreva 'Descrição criada do zero a partir dos dados.'",
    "",
    "Alertas:",
    "- Liste lacunas que impediram texto melhor (ex.: 'marca não informada',",
    "  'sem dimensões cadastradas', 'descrição atual genérica').",
    "",
    blocoDadosCompleto(anuncio, descricaoAtual),
    "",
    "Responda SOMENTE com este JSON, sem nada antes ou depois:",
    "{",
    '  "descricao_sugerida": "",',
    '  "melhorias": [],',
    '  "alertas": []',
    "}",
  ].join("\n");
}

// =============================================================================
// Ficha técnica — sugestões cautelosas com nível de confiança.
// =============================================================================
function promptFichaTecnica(anuncio, descricaoAtual) {
  return [
    "Tarefa: analisar a FICHA TÉCNICA atual do anúncio e sugerir melhorias",
    "ou preenchimento de campos faltantes.",
    "",
    "Como pensar:",
    "1. Liste os atributos atuais. Para cada um vazio, tente inferir do",
    "   título, descrição ou outros atributos — com cuidado.",
    "2. Para atributos preenchidos com valor estranho ou genérico, sugira",
    "   melhoria com confiança 'media' ou 'baixa'.",
    "3. Atributos preenchidos corretamente: NÃO inclua na resposta.",
    "4. Priorize atributos importantes (marca, modelo, material, cor,",
    "   tamanho, peso, voltagem, quantidade, dimensões).",
    "",
    "Para cada sugestão, retorne:",
    "- campo: nome do atributo (use o name dos dados quando houver).",
    "- valor_atual: o valor atualmente preenchido ou '(vazio)'.",
    "- valor_sugerido: sua sugestão. Se não puder inferir com segurança,",
    "  use '(deixar manual)'.",
    "- confianca:",
    "    'alta'  = dado claro no título/descrição/outros atributos.",
    "    'media' = inferência razoável mas não explícita.",
    "    'baixa' = inferência fraca, exige conferência humana.",
    "- motivo: 1 linha explicando de onde veio a sugestão.",
    "- precisa_revisao: true se o gestor precisa conferir antes de aplicar.",
    "",
    "Regras inegociáveis:",
    "- Não invente material, medida, peso, voltagem, compatibilidade ou marca.",
    "- Se a inferência for fraca: confianca 'baixa' e precisa_revisao=true.",
    "- Se não houver dado nenhum: valor_sugerido='(deixar manual)' e",
    "  precisa_revisao=true.",
    "- Não substitua um valor atual correto sem motivo claro.",
    "- Máximo 12 sugestões — foque nos atributos mais importantes.",
    "",
    "Alertas:",
    "- Liste limitações estruturais (ex.: 'categoria genérica impede inferir",
    "  atributos específicos', 'descrição vaga não permite identificar",
    "  material').",
    "",
    blocoDadosCompleto(anuncio, descricaoAtual),
    "",
    "Responda SOMENTE com este JSON, sem nada antes ou depois:",
    "{",
    '  "ficha_tecnica_sugerida": [',
    "    {",
    '      "campo": "",',
    '      "valor_atual": "",',
    '      "valor_sugerido": "",',
    '      "confianca": "alta",',
    '      "motivo": "",',
    '      "precisa_revisao": true',
    "    }",
    "  ],",
    '  "alertas": []',
    "}",
  ].join("\n");
}

// -----------------------------------------------------------------------------
// Resolve o prompt pelo tipo. Retorna null se o tipo não for suportado.
// -----------------------------------------------------------------------------
function montarPrompt(tipo, anuncio, extras) {
  extras = extras || {};
  switch (tipo) {
    case "seo":
      return promptSeo(anuncio);
    case "descricao":
      return promptDescricao(anuncio, extras.descricaoAtual);
    case "ficha_tecnica":
      return promptFichaTecnica(anuncio, extras.descricaoAtual);
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
