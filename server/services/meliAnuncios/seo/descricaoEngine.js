// server/services/meliAnuncios/seo/descricaoEngine.js
// -----------------------------------------------------------------------------
// Description Engine (SEO ML · F5) — UMA sugestão de DESCRIÇÃO por chamada.
//
// Fluxo (gerarDescricao):
//   ficha factual (montarFicha) → LLM redige o texto e diz quais fatos usou →
//   validação determinística (validarDescricao) → válida ou inválida, com
//   motivos objetivos. Sem score: descrição não recebe nota de nenhum tipo.
//
// Este módulo é puro em relação a infraestrutura: não lê banco, não chama o
// Mercado Livre, não lê env. A descrição atual e a categoria chegam prontas do
// controller; o aiProvider entra como parâmetro (e é simulado nos testes).
// Conta, carteira e escrita são do controller — e escrita não existe aqui:
// "Usar" no front só muda o rascunho, o PATCH /conteudo continua sendo o único
// caminho até o Mercado Livre.
//
// Força das fontes:
//   A. fatos estruturados FORTES  — marca, gênero, material, cor, voltagem,
//      medidas, tipo, linha, fechamento, compatibilidade…
//   B. fatos estruturados SECUNDÁRIOS — os demais atributos com valor.
//   C. contexto FRACO — título atual e descrição atual. Servem para entender e
//      preservar conteúdo, nunca vencem um atributo.
//   D. PROIBIDOS — atributo booleano "Não" e conflitos de GÊNERO (fatosProduto).
//
// A validação não é um verificador semântico: ela pega o que dá para pegar sem
// ambiguidade (contato, URL, linguagem promocional, marca, números, atributo
// negado, cópia da ficha técnica, IDs de fatos, termo sem origem) e descarta a
// geração inteira quando algo falha. Os `fatosUsados` são rastreabilidade,
// não prova.
// -----------------------------------------------------------------------------

const seo = require("./seoText");
const fatosProduto = require("./fatosProduto");
const { AI_TASKS } = require("../../ai/aiTasks");

const {
  ATRIBUTOS_ESTRUTURAIS,
  PALAVRAS_DE_NOME_GENERICAS,
  texto,
  lerAtributos,
  valorAtributo,
  atributoIgnorado,
  marcaGenerica,
  valorBooleano,
  regrasGenero,
} = fatosProduto;

// Limite do Mercado Livre quando a categoria não pôde ser lida: 50.000
// caracteres em texto simples (settings.max_description_length de /categories
// — conferido em categorias reais em 2026-10-01).
const LIMITE_ML_PADRAO = 50000;
// Teto OPERACIONAL: a sugestão nunca passa disso, por maior que seja o limite
// da categoria. Descrição útil é curta; não há o que ganhar enchendo espaço.
const TETO_OPERACIONAL = 2500;
// Quanto da descrição atual vai para o prompt (contexto, não texto a copiar).
const DESCRICAO_ATUAL_MAX_PROMPT = 3000;
// Mínimo de fatos de PRODUTO (marca, modelo, atributos) para valer uma
// descrição. Categoria e título não contam; uma descrição atual real conta 1.
const MIN_FATOS = 2;
const DESCRICAO_ATUAL_MIN_UTIL = 80;
// Quantas linhas "Rótulo: valor" com rótulo da ficha, SEM frase de
// introdução, caracterizam despejo da ficha técnica (F7A.7: com introdução,
// a lista em "Especificações:" é o formato pedido).
const MAX_LINHAS_DE_FICHA = 3;

// Atributos FORTES além dos estruturais compartilhados (fatosProduto).
const FORTES_EXTRAS = new Set([
  "BRAND", "MODEL", "COLOR", "MAIN_COLOR", "CLOSURE_TYPE", "COMPOSITION",
]);
const FORTE_POR_PADRAO = [
  /(^|_)TYPE$/, /^TYPE_/, /COMPATIB/,
  /(WIDTH|HEIGHT|LENGTH|DEPTH|DIAMETER|WEIGHT|SIZE|VOLUME|THICKNESS)/,
];

// F7A.5 — atributos sem autoridade de fato: texto livre do vendedor
// (título manual, usos recomendados) e marcadores internos do ML (presente,
// grade de tamanhos, ids de cadastro). Não são fatos, não vão ao prompt e não
// autorizam vocabulário — mesma política por ID do ATRIBUTOS_IGNORADOS, sem
// olhar o produto.
const ATRIBUTOS_SEM_AUTORIDADE = new Set([
  "MANUAL_TITLE", "RECOMMENDED_USES", "GIFTABLE", "SYI_PYMES_ID", "SIZE_GRID_ID", "SIZE_GRID_ROW_ID",
]);

// F7A.8 — atributos verdadeiros que não ajudam a decidir a compra. Continuam
// na ficha (autorizam vocabulário e números, entram em conflitos), mas não vão
// ao prompt e não podem virar item da descrição: dados de embalagem/envio,
// metadados da plataforma (filtros, tags, provador virtual, temporada de
// cadastro), formato de venda e serviço do vendedor.
const ATRIBUTOS_NAO_LISTAVEIS = new Set([
  "WITH_VIRTUAL_TRY_ON", "FILTRABLE_SIZE", "FILTRABLE_GENDER", "VERTICAL_TAGS", "EMPTY_GTIN_REASON",
  "RELEASE_SEASON", "RELEASE_YEAR", "SALE_FORMAT", "INSTALLATION_SERVICE",
]);
const RE_ATRIBUTO_DE_EMBALAGEM = /^attr:(SELLER_)?PACKAG/;
// Valor que não informa nada ("Nome do desenho: Não listado").
const VALORES_SEM_INFORMACAO = new Set([
  "nao listado", "nao listada", "nao aplica", "nao se aplica", "n/a", "na", "outro", "outra", "outros",
  "outro motivo", "nenhum", "nenhuma", "generico", "generica", "indefinido", "nao informado",
]);
// "Quantidade de portas: 0" = o produto não tem portas (mesmo efeito de "Com portas: Não").
const RE_ROTULO_DE_QUANTIDADE = /^(quantidade|numero|qtd|qtde|n[ºo°])\b/;
const PALAVRAS_DE_QUANTIDADE = new Set(["quantidade", "numero", "qtd", "qtde"]);

function atributoForte(id) {
  return ATRIBUTOS_ESTRUTURAIS.has(id) || FORTES_EXTRAS.has(id) || FORTE_POR_PADRAO.some((re) => re.test(id));
}

function semAcento(s) {
  return String(s == null ? "" : s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function palavrasDeConteudo(t) {
  return seo.extractTokens(t).filter((x) => !x.stopword);
}

// -----------------------------------------------------------------------------
// Números — "12V", "30 cm", "1,5 L", "2 unidades", "duas unidades".
// Um número só é aceito se aparece nos fatos permitidos ou no contexto
// autorizado (título, descrição atual). Por extenso só conta quando quantifica
// algo ("duas unidades"); "os dois lados" não é medida.
// -----------------------------------------------------------------------------
const NUMEROS_POR_EXTENSO = new Map([
  ["dois", 2], ["duas", 2], ["tres", 3], ["quatro", 4], ["cinco", 5], ["seis", 6],
  ["sete", 7], ["oito", 8], ["nove", 9], ["dez", 10], ["onze", 11], ["doze", 12],
]);
const QUANTIFICADOS = /^(unidades?|pecas?|pares?|itens|item|pacotes?|kits?|camadas?|velocidades?|niveis|nivel|modos?|bolsos?|compartimentos?|lugares?|portas?)$/;

function normalizarNumero(bruto) {
  let s = String(bruto);
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, "").replace(",", "."); // 1.000 · 1.500,50
  else if (/^\d+,\d+$/.test(s)) s = s.replace(",", ".");                               // 1,5 → 1.5
  else if (!/^\d+(\.\d+)?$/.test(s)) return null;                                       // 1.2.3: não é medida
  const n = Number(s);
  return Number.isFinite(n) ? String(n) : null;
}

function extrairNumeros(t) {
  const encontrados = [];
  const bruto = String(t == null ? "" : t);
  for (const m of bruto.matchAll(/\d+(?:[.,]\d+)*/g)) {
    const n = normalizarNumero(m[0]);
    if (n != null) encontrados.push({ numero: n, trecho: m[0] });
  }
  const palavras = semAcento(bruto).split(/[^a-z0-9]+/).filter(Boolean);
  for (let i = 0; i < palavras.length - 1; i += 1) {
    const n = NUMEROS_POR_EXTENSO.get(palavras[i]);
    if (n != null && QUANTIFICADOS.test(palavras[i + 1])) {
      encontrados.push({ numero: String(n), trecho: palavras[i] + " " + palavras[i + 1] });
    }
  }
  return encontrados;
}

// -----------------------------------------------------------------------------
// Conflito de fontes (F7A.4/F7A.5) — só contradições EXPLÍCITAS, por regras
// genéricas (nada de sinônimo/antônimo de dicionário):
//   NEGACAO     — o contexto diz "sem <assunto do rótulo>" e o atributo afirma
//                 um valor ("Tipo de manga: Curta" × título "Sem Manga").
//   MEDIDA      — o atributo é a ÚNICA medida do produto naquela grandeza e o
//                 contexto traz medida da mesma grandeza com outro valor, na
//                 unidade-base ("240 L" × "120 Litros"; "2.4 Gbps" × "Gigabit").
//   ALTERNATIVA — a categoria lista alternativas e atributo e título escolhem
//                 alternativas diferentes ("Camiseta" × "Regata" em
//                 "Camisetas e Regatas"). Jeans × Sarja continua sem regra.
// Embalagem (SELLER_PACKAGE_*) não entra: medida da caixa ≠ medida do produto.
// -----------------------------------------------------------------------------
// F7A.5 — unidade → [grandeza, fator para a unidade-base]. Medidas da mesma
// grandeza são comparadas na base: 22 kg = 22000 g, 2.4 Gbps = 2400 Mbps.
const UNIDADES = new Map([
  ["ml", ["volume", 1]], ["l", ["volume", 1000]], ["lt", ["volume", 1000]], ["lts", ["volume", 1000]],
  ["litro", ["volume", 1000]], ["litros", ["volume", 1000]],
  ["g", ["massa", 1]], ["gr", ["massa", 1]], ["gramas", ["massa", 1]], ["kg", ["massa", 1000]],
  ["w", ["potencia", 1]], ["watt", ["potencia", 1]], ["watts", ["potencia", 1]], ["kw", ["potencia", 1000]],
  ["v", ["tensao", 1]], ["volts", ["tensao", 1]],
  ["mm", ["comprimento", 1]], ["cm", ["comprimento", 10]], ["m", ["comprimento", 1000]], ["metros", ["comprimento", 1000]],
  ["kbps", ["taxa", 0.001]], ["mbps", ["taxa", 1]], ["gbps", ["taxa", 1000]],
  ["mhz", ["frequencia", 1]], ["ghz", ["frequencia", 1000]],
]);
// Número (ou lista "10/100/1000") + unidade.
const RE_MEDIDA = /((?:\d+(?:[.,]\d+)?\/)*\d+(?:[.,]\d+)?)\s*(litros|litro|lts|lt|ml|kg|kw|kbps|mbps|gbps|mhz|ghz|gramas|gr|g|watts|watt|w|volts|v|cm|mm|metros|m|l)(?![a-z0-9])/g;
// Nomes de padrão que SÃO uma medida, sem número escrito.
const MEDIDAS_POR_NOME = [[/(^|[^a-z])gigabit([^a-z]|$)/, "gigabit", "taxa", 1000], [/(^|[^a-z])fast ethernet([^a-z]|$)/, "fast ethernet", "taxa", 100]];
// F8.1 — temperatura de cor ("3000 K", "5500k", "3.000k"). Só com 4–5
// dígitos: "4k" é resolução, não kelvin.
const RE_KELVIN = /(^|[^\d.,])(\d{1,2}\.?\d{3})\s*k(?![a-z0-9])/g;

// `antes`/`depois`: o que vem colado à medida ("Capacidade: 120 L", "140 cm
// de comprimento"). `pontoDecimal`: valor de atributo do ML usa ponto como
// decimal ("1.215 m", "54.5 cm"); em texto livre "1.215" é milhar.
// trecho da frase até a medida (ponto seguido de espaço, ; ! ? quebra ou marcador)
const fraseAte = (s, i) => s.slice(0, i).split(/[;!?\n•*]|\.\s/).pop();
function medidas(t, { pontoDecimal = false } = {}) {
  const out = [];
  let s = semAcento(t);
  if (pontoDecimal) s = s.replace(/(\d)\.(\d)/g, "$1,$2");
  for (const m of s.matchAll(RE_MEDIDA)) {
    const [grandeza, fator] = UNIDADES.get(m[2]);
    const antes = s.slice(Math.max(0, m.index - 40), m.index);
    const depois = s.slice(m.index + m[0].length, m.index + m[0].length + 30);
    // F8.2 — faixa "100 - 240V" / "100 a 240 V" / "100~240V": o limite de
    // baixo vem sem unidade (ou com a mesma) colado antes
    const fx = new RegExp("(\\d+(?:[.,]\\d+)?)\\s*(?:" + m[2] + ")?\\s*(?:-|–|~|a|ate)\\s*$").exec(antes);
    const baixo = fx ? normalizarNumero(fx[1]) : null;
    for (const parte of m[1].split("/")) {
      const numero = normalizarNumero(parte);
      if (numero == null) continue;
      const x = { numero, grandeza, base: Number(numero) * fator, trecho: m[0], antes, depois, frase: fraseAte(s, m.index) };
      if (baixo != null && Number(baixo) < Number(numero)) x.faixa = [Number(baixo) * fator, x.base];
      out.push(x);
    }
  }
  for (const m of s.matchAll(RE_KELVIN)) {
    const numero = normalizarNumero(m[2].replace(",", "."));
    const ini = m.index + m[1].length;
    if (numero != null) {
      out.push({ numero, grandeza: "temperatura_cor", base: Number(numero), trecho: m[0].slice(m[1].length),
        antes: s.slice(Math.max(0, ini - 40), ini), depois: s.slice(m.index + m[0].length, m.index + m[0].length + 30), frase: fraseAte(s, ini) });
    }
  }
  for (const [re, nome, grandeza, base] of MEDIDAS_POR_NOME) {
    const m = re.exec(s);
    if (m) out.push({ numero: null, grandeza, base, trecho: nome, antes: s.slice(Math.max(0, m.index - 40), m.index), depois: "", palavra: nome });
  }
  return out;
}

// F8.2 — preposição de DESTINO/LUGAR antes de outro substantivo ("para
// dispositivos sem…", "em notebooks sem…"). "de" fica fora: "camiseta de
// algodão sem manga" ainda fala do produto.
const PREPOSICOES_DE_OUTRO_OBJETO = new Set(["para", "em", "nos", "nas", "aos", "pros", "pras"]);
const mesmaMedida = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

// F8.1 — nome da própria grandeza: amarra a medida quando a grandeza tem um
// atributo só ("Tensão: 100 - 240V" × "Voltagem: 127/220V").
const NOMES_DE_GRANDEZA = {
  tensao: ["tensao", "voltagem"], potencia: ["potencia"], volume: ["capacidade", "volume"], massa: ["peso"],
  temperatura_cor: ["temperatura"], frequencia: ["frequencia"], taxa: ["velocidade", "taxa"],
};
// Palavra de rótulo colada à medida, na ordem de confiança: "de <palavra>"
// logo depois ("140 cm de comprimento"), depois a palavra logo antes
// ("Comprimento total: 140 cm", "Tensão: 100 - 240V", "peso de 32 kg").
const RE_ROTULO_DEPOIS = /^\s*de\s+([a-z]+)/;
const RE_ROTULO_ANTES = /([a-z]+)(?:\s+(?:total|maxim[oa]|minim[oa]|nominal|aproximad[oa]))?\s*(?::|=|-|de)?\s*(?:\d+(?:[.,]\d+)?\s*(?:-|~|a|ate)\s*)?$/;
// Rótulos que são a mesma propriedade em faixa: "Temperatura mínima da cor" e
// "Temperatura máxima da cor" (tirando mínima/máxima, sobra o mesmo rótulo).
const PALAVRAS_DE_FAIXA = new Set(["minima", "maxima", "minimo", "maximo", "min", "max"]);
function ehFaixa(rotulos) {
  const resto = rotulos.map((r) => seo.contentKeys(r).filter((k) => !PALAVRAS_DE_FAIXA.has(k)).sort().join(" "));
  return rotulos.some((r) => seo.contentKeys(r).some((k) => PALAVRAS_DE_FAIXA.has(k))) && resto.every((x) => x === resto[0]);
}
function palavrasDeRotulo(x) {
  const out = [];
  for (const m of [RE_ROTULO_DEPOIS.exec(x.depois || ""), RE_ROTULO_ANTES.exec(x.antes || "")]) {
    const t = m && seo.extractTokens(m[1])[0];
    if (t && !t.stopword) out.push(t.key);
  }
  return out;
}

// -----------------------------------------------------------------------------
// F7B.1 — conflito de MATERIAL, genérico (sem caso por produto).
//
// Léxico em 3 DIMENSÕES; dentro de cada uma, FAMÍLIAS de nomes equivalentes.
// Só existe conflito dentro da mesma dimensão e entre famílias diferentes:
//   fibra   (algodão, poliéster, linho…)    — do que o fio é feito
//   tecido  (jeans/denim, sarja, malha…)    — a construção do tecido
//   rigido  (madeira/MDF, aço/metal, plástico…)
// Algodão × Sarja NÃO conflita (dimensões diferentes: sarja de algodão);
// Jeans × Sarja conflita (duas construções diferentes); MDF × Madeira não
// (mesma família). Palavras ambíguas (lã/"la", acrílico, bambu, sintético)
// ficam de fora de propósito.
//
// Papel "material principal": rótulo cujas palavras, tirando as genéricas
// (material, tipo, tecido, principal, composição), são vazias ou só nomeiam
// o próprio produto ("Materiais da escrivaninha" em Escrivaninhas). Rótulo de
// PARTE ("Material da tampa", "Materiais da estrutura", "Material externo")
// nunca entra: tampo de MDF e estrutura de aço não se contradizem.
//
// Fonte: só o TÍTULO, e só quando ele cita UM material (palavras de material
// coladas contam como uma: "Couro Legítimo"). "Em Aço E Madeira" = partes
// diferentes → sem comparação. A descrição atual cita materiais de várias
// partes; comparar com ela geraria falso positivo.
// -----------------------------------------------------------------------------
const MATERIAIS = {
  fibra: [["algodao"], ["poliester"], ["linho"], ["seda"], ["viscose"], ["elastano", "lycra", "spandex"],
    ["nylon", "poliamida"], ["modal"], ["liocel", "lyocell", "tencel"]],
  tecido: [["jeans", "denim"], ["sarja"], ["malha"], ["moletom"], ["trico"], ["crepe"], ["cetim"], ["veludo"],
    ["tactel"], ["oxford"], ["tricoline"], ["chiffon"], ["renda"], ["suede", "camurca"], ["couro"], ["nobuck"],
    ["lona"], ["brim"], ["flanela"], ["fleece"], ["plush", "pelucia"], ["tule"], ["organza"], ["linhao"]],
  rigido: [["madeira", "mdf", "mdp", "compensado", "pinus", "eucalipto"],
    ["aco", "inox", "ferro", "aluminio", "metal", "metalico", "latao", "cobre"],
    ["plastico", "polipropileno", "pvc", "abs", "polietileno"], ["vidro"], ["ceramica", "porcelana"],
    ["borracha"], ["silicone"], ["marmore", "granito", "pedra"], ["papelao"]],
};
const MATERIAL_POR_CHAVE = new Map();
for (const [dimensao, familias] of Object.entries(MATERIAIS)) {
  familias.forEach((fam, i) => {
    for (const w of fam) for (const t of seo.extractTokens(w)) MATERIAL_POR_CHAVE.set(t.key, { dimensao, familia: dimensao + ":" + i });
  });
}
const PALAVRAS_DE_PAPEL_PRINCIPAL = new Set(["material", "tipo", "tecido", "principal", "composicao"].map((w) => seo.extractTokens(w)[0].key));
const PREPOSICOES_DE_MATERIAL = new Set(["de", "em", "da", "do"]);

function materiaisDe(texto) {
  return seo.extractTokens(texto).map((t) => ({ t, m: MATERIAL_POR_CHAVE.get(t.key) })).filter((x) => x.m);
}

function conflitosDeMaterial(atributos, titulo, categoria) {
  if (!titulo) return [];
  // frases de material no título (palavras de material coladas = uma frase)
  const tokens = seo.extractTokens(titulo);
  const frases = [];
  tokens.forEach((t, i) => {
    const m = MATERIAL_POR_CHAVE.get(t.key);
    if (!m) return;
    const anterior = frases[frases.length - 1];
    if (anterior && anterior.fim === i - 1) { anterior.itens.push({ t, m }); anterior.fim = i; } else frases.push({ ini: i, fim: i, itens: [{ t, m }] });
  });
  if (frases.length !== 1) return [];
  const frase = frases[0];
  const prep = tokens[frase.ini - 1] && PREPOSICOES_DE_MATERIAL.has(tokens[frase.ini - 1].normalized) ? tokens[frase.ini - 1] : null;
  const trecho = (prep ? prep.original + " " : "") + frase.itens.map((x) => x.t.original).join(" ");
  return compararMateriais(atributosDeMaterialPrincipal(atributos, titulo, categoria), frase.itens, "titulo", trecho);
}

// Atributos de papel "material principal" (rótulo de PARTE fica de fora).
function atributosDeMaterialPrincipal(atributos, titulo, categoria) {
  const doProduto = new Set(seo.contentKeys(categoria || ""));
  const tipo = seo.contentKeys(titulo || "").find((k) => !/^\d/.test(k) && !PALAVRAS_DE_KIT.has(k));
  if (tipo) doProduto.add(tipo);
  return atributos.filter((f) => {
    const resto = seo.contentKeys(f.label).filter((k) => !PALAVRAS_DE_PAPEL_PRINCIPAL.has(k) && !PALAVRAS_DE_NOME_GENERICAS.has(k));
    if (!seo.contentKeys(f.label).some((k) => PALAVRAS_DE_PAPEL_PRINCIPAL.has(k))) return false; // não é atributo de material
    return !resto.some((k) => !doProduto.has(k)); // material de uma PARTE
  });
}

// Mesma dimensão, nenhuma família em comum → conflito.
function compararMateriais(principais, itensDaFonte, fonte, trecho) {
  const out = [];
  for (const f of principais) {
    const doAtributo = materiaisDe(f.value);
    for (const dimensao of Object.keys(MATERIAIS)) {
      const naFonte = itensDaFonte.filter((x) => x.m.dimensao === dimensao);
      const noValor = doAtributo.filter((x) => x.m.dimensao === dimensao);
      if (!naFonte.length || !noValor.length) continue;
      if (noValor.some((v) => naFonte.some((t) => t.m.familia === v.m.familia))) continue;
      out.push({
        id: f.id, label: f.label, value: f.value, tipo: "MATERIAL", fonte, trecho,
        chaves: Array.from(new Set(naFonte.map((x) => x.t.key).concat(noValor.map((x) => x.t.key)))),
      });
      break;
    }
  }
  return out;
}

// F8.1 — material na descrição atual: só a declaração ROTULADA
// ("Material: Sarja de alta qualidade", "Tecido: Jeans"). Texto livre ("o
// tecido de sarja…", "estrutura de aço") não entra: a descrição fala de várias
// partes. Por dimensão (fibra/tecido/rígido), só compara se UMA declaração
// rotulada cita aquela dimensão — duas ("Material: MDF" e "Material: Aço")
// costumam ser partes diferentes.
const RE_MATERIAL_ROTULADO = /(^|[^a-z])(?:tipo de )?(?:material|materiais|tecido|composicao|materia[ -]prima)(?: (?:principal|predominante))?\s*:\s*([^\n:•*|;]{1,60})/g;
function conflitosDeMaterialRotulado(atributos, descricao, titulo, categoria) {
  if (!descricao) return [];
  const declaracoes = Array.from(semAcento(descricao).matchAll(RE_MATERIAL_ROTULADO))
    .map((m) => ({ trecho: m[0].slice(m[1].length).trim(), itens: materiaisDe(m[2]) })).filter((d) => d.itens.length);
  const principais = atributosDeMaterialPrincipal(atributos, titulo, categoria);
  const out = [];
  for (const dimensao of Object.keys(MATERIAIS)) {
    const comDimensao = declaracoes.filter((d) => d.itens.some((x) => x.m.dimensao === dimensao));
    if (comDimensao.length !== 1) continue;
    const d = comDimensao[0];
    for (const c of compararMateriais(principais, d.itens.filter((x) => x.m.dimensao === dimensao), "descricao_atual", d.trecho)) {
      if (!out.some((x) => x.id === c.id)) out.push(c);
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// F8.1 — QUANTIDADE do kit. Só expressão de quantidade do PRODUTO:
//   "Kit 5", "Kit com 3", "Pacote com 50", "50 unidades" (título) e, na
//   descrição atual, "kit … com 3 peças" (palavra de kit até 6 palavras antes).
// "5 palhetas" ou "2 bolsos" não contam: falam de partes. O atributo de
// unidades por kit/pacote é a referência; sem ele, título × descrição.
// -----------------------------------------------------------------------------
const QTD_POR_EXTENSO = "dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|doze";
const PALAVRAS_KIT_RE = "kit|kits|pacote|conjunto|combo|pack|lote";
const NAO_E_UNIDADE = "(?![\\d.,]|\\s*(?:x|cm|mm|m|kg|g|ml|l|w|v|k|hp|gb|mb|%|\")(?![a-z]))";
const RE_KIT_N = new RegExp("(^|[^a-z])(?:" + PALAVRAS_KIT_RE + ")\\s+(?:c\\/\\s*|com\\s+|de\\s+)?(\\d{1,3}|" + QTD_POR_EXTENSO + ")" + NAO_E_UNIDADE, "g");
const RE_KIT_PERTO = new RegExp("(^|[^a-z])(?:" + PALAVRAS_KIT_RE + ")(?:\\s+[a-z]+){0,6}?\\s+(?:com\\s+|c\\/\\s*)?(\\d{1,3}|" + QTD_POR_EXTENSO + ")\\s*(?:unidades?|pecas?|pares?|itens|un|pcs)(?![a-z])", "g");
const RE_N_UNIDADES = new RegExp("(^|[^\\d.,a-z])(\\d{1,3}|" + QTD_POR_EXTENSO + ")\\s*(?:unidades?|pecas?|pcs)(?![a-z])", "g");
const RE_ROTULO_QTD = /(^|[^a-z])(?:unidades por (?:kit|pacote|embalagem)|quantidade de unidades|quantidade)\s*:\s*(\d{1,3})(?![\d.,])/g;
const ATRIBUTOS_DE_QUANTIDADE = new Set(["attr:UNITS_PER_PACK", "attr:UNITS_PER_KIT", "attr:PACK_UNITS"]);

function numeroDeQuantidade(bruto) {
  const n = NUMEROS_POR_EXTENSO.get(bruto);
  return n != null ? n : Number(bruto);
}
function quantidadesDoTexto(t, padroes) {
  const s = semAcento(t || "");
  const out = new Set();
  for (const re of padroes) for (const m of s.matchAll(re)) out.add(numeroDeQuantidade(m[2]));
  return out;
}
const quantidadesDoTitulo = (t) => quantidadesDoTexto(t, [RE_KIT_N, RE_N_UNIDADES]);
const quantidadesDaDescricaoAtual = (t) => quantidadesDoTexto(t, [RE_KIT_N, RE_KIT_PERTO]);
// No texto gerado: as mesmas formas + o item "Unidades por kit: 5".
const quantidadesCitadas = (t) => quantidadesDoTexto(t, [RE_KIT_N, RE_KIT_PERTO, RE_N_UNIDADES, RE_ROTULO_QTD]);

function atributoDeQuantidade(atributos) {
  const f = atributos.find((x) => ATRIBUTOS_DE_QUANTIDADE.has(x.id) ||
    /^unidades por (kit|pacote|embalagem)$/.test(semAcento(x.label).trim()));
  const n = f && /^\s*\d{1,4}\s*$/.test(f.value) ? Number(f.value) : null;
  return n != null ? { f, n } : null;
}

function conflitosDeQuantidade(atributos, titulo, descricao) {
  const out = [];
  const doAtributo = atributoDeQuantidade(atributos);
  const qTitulo = quantidadesDoTitulo(titulo);
  const qDesc = quantidadesDaDescricaoAtual(descricao);
  const numeros = (xs) => Array.from(new Set(xs.map(String)));
  if (doAtributo) {
    for (const [fonte, qs] of [["titulo", qTitulo], ["descricao_atual", qDesc]]) {
      if (!qs.size || qs.has(doAtributo.n)) continue;
      out.push({
        id: doAtributo.f.id, label: doAtributo.f.label, value: doAtributo.f.value, tipo: "QUANTIDADE", fonte,
        trecho: Array.from(qs).join(", "), numeros: numeros([doAtributo.n, ...qs]), chaves: [],
      });
    }
    return out;
  }
  // sem atributo: título e descrição atual citam quantidades sem nenhuma em comum
  if (qTitulo.size && qDesc.size && ![...qTitulo].some((n) => qDesc.has(n))) {
    out.push({
      id: "contexto:quantidade", label: "Quantidade do kit", value: Array.from(qTitulo).join(", "), tipo: "QUANTIDADE",
      fonte: "descricao_atual", trecho: Array.from(qDesc).join(", "), numeros: numeros([...qTitulo, ...qDesc]), chaves: [],
    });
  }
  return out;
}

// -----------------------------------------------------------------------------
// F9.1 — MARCA entre fontes. Só marca DECLARADA ("marca JSN", "Marca: JSN",
// "Fabricante: JSN"); nome solto no título não é declaração. Se a declarada
// não bate com a BRAND estruturada, nenhuma das duas é fato: a marca sai da
// ficha e citar qualquer uma vira CONFLITO_DE_FONTES. Bate quando uma contém a
// outra, sem espaço/pontuação, ou contém uma palavra da outra ("LIFE PRO
// IMPORT" × "LongLifePro").
// -----------------------------------------------------------------------------
const RE_MARCA_DECLARADA = /(^|[^a-z])(?:marca|fabricante)\s*:?\s+([a-z0-9][a-z0-9&'-]*)/g;
// palavra depois de "marca" que não é nome ("marca registrada", "marca d'água",
// "da marca que…", "sem marca")
const NAO_E_NOME_DE_MARCA = new Set(["registrada", "registradas", "propria", "d", "dagua", "do", "da", "de", "dos", "das", "e",
  "que", "lider", "nacional", "brasileira", "original", "originais", "renomada", "famosa", "generica", "generico", "sem", "no",
  "na", "mais", "com", "para", "a", "o", "um", "uma", "sua", "seu", "nossa", "nosso", "preferida", "consagrada",
  "reconhecida", "contra", "conhecida", "parceira", "oficial", "importada", "exclusiva"]);
function conflitosDeMarca(brand, fontes) {
  if (!brand) return [];
  const junta = (s) => semAcento(s).replace(/[^a-z0-9]/g, "");
  const b = junta(brand.value);
  const palavrasDaMarca = semAcento(brand.value).split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  const out = [];
  for (const [fonte, t] of fontes) {
    if (!t) continue;
    for (const m of semAcento(t).matchAll(RE_MARCA_DECLARADA)) {
      const decl = junta(m[2]);
      if (decl.length < 2 || NAO_E_NOME_DE_MARCA.has(m[2])) continue;
      if (b.includes(decl) || decl.includes(b) || palavrasDaMarca.some((w) => decl.includes(w))) continue;
      const chaveMarca = seo.contentKeys(brand.value)[0];
      out.push({
        id: "brand", label: "Marca", value: brand.value, tipo: "MARCA", fonte, trecho: m[0].slice(m[1].length).trim(),
        chaves: Array.from(new Set([chaveMarca, seo.contentKeys(m[2])[0]].filter(Boolean))),
      });
      break;
    }
  }
  return out;
}

// Quantidade confiável do kit (N ≥ 2), para a descrição não falar de uma peça
// como se fosse o produto inteiro. Sem conflito de quantidade:
//   atributo de unidades por kit ≥ 2; ou, sem atributo, UMA quantidade no
//   título (a descrição atual, se citar quantidade, tem de concordar).
function quantidadeDoKit(atributos, titulo, descricao, conflitos) {
  if (conflitos.some((c) => c.tipo === "QUANTIDADE")) return null;
  const doAtributo = atributoDeQuantidade(atributos);
  if (doAtributo) return doAtributo.n >= 2 ? { n: doAtributo.n, fonte: doAtributo.f.id } : null;
  const qTitulo = Array.from(quantidadesDoTitulo(titulo));
  if (qTitulo.length !== 1 || qTitulo[0] < 2) return null;
  return { n: qTitulo[0], fonte: "contexto:titulo" };
}

function detectarConflitos(fatos, fontes, categoria) {
  const conflitos = [];
  const atributos = fatos.filter((f) => f.id.startsWith("attr:") && !/^attr:(SELLER_)?PACKAG/.test(f.id));
  // MEDIDA: GRANDEZA (volume, massa, taxa…) medida por um único atributo do
  // produto cujo VALOR É a medida ("240 L"; um título manual que cita "240
  // Litros" não conta). Comparação na unidade-base (F7A.5). No título
  // (curto) qualquer medida da grandeza vale; na descrição atual, que
  // costuma trazer outras grandezas ("58 kg de lixo"), só a medida precedida
  // por palavra do rótulo do atributo ("Capacidade: 120 L").
  //
  // F8.1 — também grandeza com VÁRIOS atributos (comprimento/largura/altura;
  // temperatura mínima/máxima) e valor em lista ("127/220V"):
  //   título — conflito se NENHUM valor do título bate com NENHUM atributo da
  //            grandeza ("3500k 5500k" × 3000 K e 6000 K): todos saem.
  //   descrição atual — só medida AMARRADA a um rótulo: "de <palavra>" logo
  //            depois ("140 cm de comprimento") ou palavra colada antes
  //            ("Comprimento: 140 cm", "Tensão: 100 - 240V"). A palavra tem de
  //            estar no rótulo do atributo — ou, se a grandeza tem atributo
  //            único, ser o nome da grandeza (tensão/voltagem, potência…).
  //            Conflito se nenhuma medida amarrada ao atributo bate com ele.
  const porGrandeza = new Map();
  for (const f of atributos) {
    if (!/^\s*\d+(?:[.,]\d+)?(?:\s*\/\s*\d+(?:[.,]\d+)?)*\s*[a-z]+\s*$/.test(semAcento(f.value))) continue;
    const ms = medidas(f.value, { pontoDecimal: true });
    if (!ms.length || ms.some((x) => x.grandeza !== ms[0].grandeza)) continue;
    const lista = porGrandeza.get(ms[0].grandeza) || [];
    // número como o valor está escrito (o validador compara com o texto gerado)
    const escritos = extrairNumeros(f.value).map((n) => n.numero);
    lista.push({ f, ms, numeros: Array.from(new Set(ms.map((x) => x.numero).concat(escritos))) });
    porGrandeza.set(ms[0].grandeza, lista);
  }
  // F8.2 — valor do atributo DENTRO de uma faixa do contexto é compatível
  // ("127/220V" × "100 - 240V")
  const dentro = (x, y) => y.faixa && x.base >= y.faixa[0] - 1e-9 && x.base <= y.faixa[1] + 1e-9;
  const bate = (xs, ys) => xs.some((x) => ys.some((y) => mesmaMedida(x.base, y.base) || dentro(x, y)));
  for (const [grandeza, lista] of porGrandeza) {
    const rotulos = lista.map(({ f }) => new Set(palavrasDeConteudo(f.label).map((t) => t.key).filter((k) => !PALAVRAS_DE_NOME_GENERICAS.has(k))));
    for (const [fonte, t] of fontes) {
      if (!t) continue;
      const doContexto = medidas(t).filter((x) => x.grandeza === grandeza);
      if (!doContexto.length) continue;
      const empurrar = (alvo, ctx) => conflitos.push({
        id: alvo.f.id, label: alvo.f.label, value: alvo.f.value, tipo: "MEDIDA", fonte, trecho: ctx[0].trecho,
        numeros: Array.from(new Set(alvo.numeros.concat(ctx.map((x) => x.numero).filter((n) => n != null)))),
        chaves: Array.from(new Set(ctx.filter((x) => x.palavra).map((x) => seo.contentKeys(x.palavra)[0]))),
      });
      if (fonte === "titulo") {
        // vários atributos: só se forem a MESMA propriedade em faixa
        // (mínima/máxima); "Mesa 100 cm" com largura e comprimento pode ser a
        // altura, que a ficha não tem
        if (lista.length > 1 && !ehFaixa(lista.map((a) => a.f.label))) continue;
        if (lista.some((a) => bate(a.ms, doContexto))) continue;
        for (const a of lista) empurrar(a, doContexto);
        continue;
      }
      // cada medida → atributos a que está amarrada ("peso" amarra a "Peso" e
      // a "Peso máximo suportado": a medida é explicada se bater com qualquer um).
      // Medida da embalagem não é do produto ("embalagem de 92 cm…, com peso
      // de 34 kg"); e se a mesma fonte também cita o valor do atributo (mesmo
      // sem unidade: "Cortina 4,00x2,80… partes de 2,00m de largura"), a outra
      // medida é de uma parte, não contradição.
      const numerosDaFonte = new Set(extrairNumeros(t).map((n) => n.numero));
      const amarras = doContexto.filter((x) => !/embalage/.test((x.frase || x.antes) + " " + x.depois)).map((x) => {
        for (const k of palavrasDeRotulo(x)) {
          const alvo = lista.filter((a, i) => rotulos[i].has(k) || (lista.length === 1 && (NOMES_DE_GRANDEZA[grandeza] || []).includes(k)));
          if (alvo.length) return { x, alvo };
        }
        // regra anterior (atributo único): palavra do rótulo nos 40 caracteres antes
        if (lista.length === 1 && seo.contentKeys(x.antes).some((k) => rotulos[0].has(k))) return { x, alvo: lista };
        return null;
      }).filter(Boolean);
      for (const a of lista) {
        if (a.numeros.some((n) => numerosDaFonte.has(n))) continue;
        const minhas = amarras.filter((m) => m.alvo.includes(a));
        if (minhas.length && !minhas.some((m) => m.alvo.some((b) => bate(b.ms, [m.x])))) empurrar(a, minhas.map((m) => m.x));
      }
    }
  }
  // ALTERNATIVA (F7A.5): a categoria nomeia alternativas ("Camisetas e
  // Regatas", "Bermudas e Shorts"); o atributo escolhe uma e o TÍTULO usa
  // outra, sem citar a do atributo ("Tipo de roupa: Camiseta" × "Kit 2
  // Regata"). As duas palavras ficam bloqueadas: nenhuma fonte vence.
  const alternativas = categoria
    ? categoria.split(/\s+e\s+|,|\//i).map((x) => seo.contentKeys(x)).filter((ks) => ks.length === 1).map((ks) => ks[0])
    : [];
  const titulo = (fontes.find(([nome]) => nome === "titulo") || [])[1];
  if (alternativas.length >= 2 && titulo) {
    const chavesTitulo = new Set(seo.contentKeys(titulo));
    for (const f of atributos) {
      const chavesValor = seo.contentKeys(f.value);
      const doAtributo = alternativas.filter((a) => chavesValor.includes(a));
      if (doAtributo.length !== 1 || chavesTitulo.has(doAtributo[0])) continue;
      const doTitulo = alternativas.filter((a) => a !== doAtributo[0] && chavesTitulo.has(a));
      if (!doTitulo.length) continue;
      conflitos.push({
        id: f.id, label: f.label, value: f.value, tipo: "ALTERNATIVA", fonte: "titulo",
        trecho: doTitulo.join(", "), chaves: [doAtributo[0], ...doTitulo],
      });
    }
  }
  // MATERIAL (F7B.1): o título cita UM material e um atributo de papel
  // "material principal" diz outro, incompatível, na MESMA dimensão.
  conflitos.push(...conflitosDeMaterial(atributos, titulo, categoria));
  // F8.1 — MATERIAL também contra a descrição atual, mas só a declaração
  // ROTULADA ("Material: Sarja…"); QUANTIDADE do kit contra título/descrição.
  const descricao = (fontes.find(([nome]) => nome === "descricao_atual") || [])[1];
  for (const c of conflitosDeMaterialRotulado(atributos, descricao, titulo, categoria)) {
    if (!conflitos.some((x) => x.id === c.id)) conflitos.push(c);
  }
  conflitos.push(...conflitosDeQuantidade(atributos, titulo, descricao));
  // F9.1 — MARCA: BRAND estruturada × marca DECLARADA no título/descrição atual
  conflitos.push(...conflitosDeMarca(fatos.find((f) => f.id === "brand"), fontes));
  // NEGACAO: "sem <assunto>" no contexto × atributo que afirma o assunto
  const doProdutoNeg = new Set(seo.contentKeys(categoria || ""));
  const tipoNeg = seo.contentKeys(titulo || "").find((k) => !/^\d/.test(k) && !PALAVRAS_DE_KIT.has(k));
  if (tipoNeg) doProdutoNeg.add(tipoNeg);
  for (const f of atributos) {
    if (conflitos.some((c) => c.id === f.id)) continue;
    const valorNega = valorBooleano(f.value) === false || seo.extractTokens(f.value).some((t) => t.normalized === "sem" || t.normalized === "nao");
    if (valorNega) continue;
    const chaves = palavrasDeConteudo(f.label).map((t) => t.key).filter((k) => !PALAVRAS_DE_NOME_GENERICAS.has(k));
    if (!chaves.length) continue;
    for (const [fonte, t] of fontes) {
      if (!t) continue;
      const tokens = seo.extractTokens(t);
      // F8.2 — "sem" que qualifica OUTRO objeto, introduzido por preposição
      // ("para/em dispositivos sem entrada de rede"), não nega o produto
      const deOutroObjeto = (j) => j >= 2 && !tokens[j - 1].stopword && !doProdutoNeg.has(tokens[j - 1].key) &&
        PREPOSICOES_DE_OUTRO_OBJETO.has(tokens[j - 2].normalized);
      const i = tokens.findIndex((x, j) => x.normalized === "sem" && tokens[j + 1] && chaves.includes(tokens[j + 1].key) && !deOutroObjeto(j));
      if (i < 0) continue;
      conflitos.push({
        id: f.id, label: f.label, value: f.value, tipo: "NEGACAO", fonte,
        trecho: tokens[i].original + " " + tokens[i + 1].original, chaves,
      });
      break;
    }
  }
  return conflitos;
}

// F7A.8 — quais fatos podem virar item da descrição. `f.listavel` false +
// `f.oculto` (motivo): EMBALAGEM, PLATAFORMA, SEM_INFORMACAO ou REDUNDANTE.
// REDUNDANTE: mesmo valor (não numérico, não "Sim") de um fato já listável e
// rótulo que não distingue parte do produto — um rótulo contém o outro ("Cor"
// × "Cor principal") ou não têm palavra em comum ("Marca" × "Fabricante",
// "Tipo de tecido" × "Material principal"). "Materiais da estrutura" ×
// "Material da tampa" (partes diferentes) ficam os dois. Fica o fato forte;
// entre iguais, o de rótulo mais curto e, depois, o primeiro.
function marcarListaveis(fatos) {
  for (const f of fatos) {
    const idMl = f.id.startsWith("attr:") ? f.id.slice(5) : "";
    const v = semAcento(f.value).trim();
    f.listavel = true;
    if (RE_ATRIBUTO_DE_EMBALAGEM.test(f.id)) f.oculto = "EMBALAGEM";
    else if (ATRIBUTOS_NAO_LISTAVEIS.has(idMl) || (idMl === "UNITS_PER_PACK" && /^0*1$/.test(v))) f.oculto = "PLATAFORMA";
    else if (VALORES_SEM_INFORMACAO.has(v)) f.oculto = "SEM_INFORMACAO";
    if (f.oculto) f.listavel = false;
  }
  const chavesRotulo = (f) => new Set(seo.contentKeys(f.label));
  const ordem = fatos.filter((f) => f.listavel).map((f, i) => ({ f, i }))
    .sort((a, b) => (a.f.grupo === b.f.grupo ? 0 : a.f.grupo === "forte" ? -1 : 1) ||
      chavesRotulo(a.f).size - chavesRotulo(b.f).size || a.i - b.i);
  const mantidos = [];
  for (const { f } of ordem) {
    const v = semAcento(f.value).trim();
    const comparavel = v && !/\d/.test(v) && valorBooleano(f.value) == null;
    const igual = comparavel && mantidos.find((m) => {
      if (semAcento(m.value).trim() !== v) return false;
      const a = chavesRotulo(m);
      const b = chavesRotulo(f);
      const comuns = [...a].filter((k) => b.has(k)).length;
      return comuns === 0 || comuns === a.size || comuns === b.size;
    });
    if (igual) { f.listavel = false; f.oculto = "REDUNDANTE"; f.redundanteCom = igual.id; continue; }
    mantidos.push(f);
  }
}

// -----------------------------------------------------------------------------
// montarFicha — a ficha do que é VERDADE sobre o anúncio (e do que é proibido).
//
// opts: {
//   categoriaNome,
//   limiteCategoria,          settings.max_description_length (null = não lido)
//   descricaoAtual,           texto lido ao vivo do ML (ou null)
//   descricaoEstado,          "ok" | "sem_descricao" | "erro" (mesmo contrato do detalhe)
// }
//
//   {
//     limite, alvo:{ min, max },
//     categoria, tituloAtual, marca, modelo,
//     descricaoAtual: { estado, texto },
//     fatos:     [{ id, label, value, grupo: "forte"|"secundario", listavel, oculto? }]
//     proibidos: [{ id, label, value, motivo, chaves:[[key…]…], exibir:[string] }]
//     idsConhecidos: Set, nomesAutorizados: Set(key), vocabularioFraco: Set(key),
//     vocabularioAutorizado: Set(key), vocabularioDeValores: Set(key),
//     numerosPermitidos: Set, vocabularioDoTitulo: Set(key),
//     conflitos: [{ id, label, value, tipo, fonte, trecho, chaves?, numeros? }]
//     nFatosProduto, suficiente
//   }
// -----------------------------------------------------------------------------
function montarFicha(anuncio, opts = {}) {
  const a = anuncio || {};
  const attrs = lerAtributos(a);
  const porId = new Map(attrs.map((x) => [String(x.id || ""), x]));

  const limiteCategoria = Number.isInteger(opts.limiteCategoria) && opts.limiteCategoria > 0
    ? opts.limiteCategoria : LIMITE_ML_PADRAO;
  const limite = Math.min(limiteCategoria, TETO_OPERACIONAL);

  const fatos = [];
  const proibidosBrutos = [];
  const afirmadas = new Set(); // chaves que algum fato AFIRMA (resolve contradição na ficha)

  function fato(id, label, value, grupo) {
    fatos.push({ id, label, value, grupo });
    for (const t of palavrasDeConteudo(value)) afirmadas.add(t.key);
  }

  const categoria = texto(opts.categoriaNome);
  const categoriaUtil = categoria && !marcaGenerica(categoria) ? categoria : null;

  const marca = texto(valorAtributo(porId.get("BRAND")) || a.marca);
  const marcaUtil = marca && !marcaGenerica(marca) ? marca : null;
  if (marcaUtil) fato("brand", "Marca", marcaUtil, "forte");

  // MODEL é dado factual (F4R), mas o legado gravou listas de palavras-chave
  // nele. Só entra quando parece um modelo de verdade: até 4 palavras, sem
  // vírgula/ponto e vírgula, até 40 caracteres. Fora disso, nem vai ao prompt.
  const modelo = texto(valorAtributo(porId.get("MODEL")) || a.modelo);
  const nModelo = seo.contentKeys(modelo).length;
  const modeloUtil = modelo && nModelo >= 1 && nModelo <= 4 && modelo.length <= 40 && !/[,;|]/.test(modelo)
    ? modelo : null;
  if (modeloUtil) fato("model", "Modelo", modeloUtil, "forte");

  let nAtributos = 0;
  for (const at of attrs) {
    const idMl = String(at.id || "");
    const valor = valorAtributo(at);
    if (!valor || idMl === "BRAND" || idMl === "MODEL" || atributoIgnorado(idMl) || ATRIBUTOS_SEM_AUTORIDADE.has(idMl)) continue;
    const id = "attr:" + idMl;
    const label = texto(at.name) || idMl;
    const zero = /^\s*0+\s*$/.test(valor) && RE_ROTULO_DE_QUANTIDADE.test(semAcento(label));
    const bool = zero ? false : valorBooleano(valor);
    const chavesNome = palavrasDeConteudo(label)
      .filter((t) => !PALAVRAS_DE_NOME_GENERICAS.has(t.key) && !(zero && PALAVRAS_DE_QUANTIDADE.has(t.key)));

    if (bool === false) {
      // "É impermeável: Não" — afirmar "impermeável" é falso.
      if (chavesNome.length) {
        proibidosBrutos.push({
          id, label, value: valor, motivo: "ATRIBUTO_NEGADO",
          chaves: [chavesNome.map((t) => t.key)],
          exibir: [chavesNome.map((t) => t.original).join(" ")],
        });
      }
      continue;
    }

    nAtributos += 1;
    if (bool === true) {
      fatos.push({ id, label, value: valor, grupo: "secundario" });
      for (const t of chavesNome) afirmadas.add(t.key);
      continue;
    }
    fato(id, label, valor, atributoForte(idMl) ? "forte" : "secundario");

    if (idMl === "GENDER") {
      const genero = regrasGenero(valor);
      if (genero && genero.proibidas.size) {
        const proibidas = Array.from(genero.proibidas);
        proibidosBrutos.push({
          id, label, value: valor, motivo: "CONFLITO_GENERO",
          chaves: proibidas.map((k) => [k]),
          exibir: proibidas,
        });
      }
    }
  }

  // Uma palavra proibida que outro fato AFIRMA (ficha contraditória) deixa de
  // ser proibida: na dúvida vale o fato — mesma regra do Title Engine.
  const proibidos = [];
  for (const p of proibidosBrutos) {
    const idx = p.chaves.map((seq, i) => i).filter((i) => !p.chaves[i].every((k) => afirmadas.has(k)));
    if (!idx.length) continue;
    proibidos.push({ ...p, chaves: idx.map((i) => p.chaves[i]), exibir: idx.map((i) => p.exibir[i]) });
  }

  const tituloAtual = texto(a.titulo);
  // Mesmo contrato do detalhe/F1: "erro" (não deu para ler) ≠ "sem_descricao".
  const textoLido = texto(opts.descricaoAtual);
  const descricaoAtual = opts.descricaoEstado === "erro"
    ? { estado: "erro", texto: null }
    : textoLido ? { estado: "ok", texto: textoLido } : { estado: "sem_descricao", texto: null };

  // F7A.4 — atributo que contradiz EXPLICITAMENTE o título/descrição atual.
  // Não há vencedor: o fato sai da ficha (não vai ao prompt nem autoriza
  // vocabulário), o conflito é sinalizado e a descrição não pode tocar no
  // assunto. O dado original não é alterado.
  const conflitos = detectarConflitos(fatos, [["titulo", tituloAtual], ["descricao_atual", descricaoAtual.texto]], categoriaUtil);
  const idsEmConflito = new Set(conflitos.map((c) => c.id));
  for (let i = fatos.length - 1; i >= 0; i -= 1) if (idsEmConflito.has(fatos[i].id)) fatos.splice(i, 1);
  marcarListaveis(fatos);
  // F8.1 — "Kit N" confiável: a descrição tem de dizer a quantidade.
  const kit = quantidadeDoKit(fatos.filter((f) => f.id.startsWith("attr:")), tituloAtual, descricaoAtual.texto, conflitos);

  // IDs que o LLM pode citar em fatosUsados.
  const idsConhecidos = new Set(fatos.map((f) => f.id));
  for (const p of proibidos) idsConhecidos.add(p.id);
  if (categoriaUtil) idsConhecidos.add("categoria");
  if (tituloAtual) idsConhecidos.add("contexto:titulo");
  if (descricaoAtual.texto) idsConhecidos.add("contexto:descricao_atual");

  // Nomes próprios: dois níveis. `nomesAutorizados` vem SÓ dos fatos
  // estruturados (marca, modelo seguro, linha e demais valores/rótulos de
  // atributos, categoria) e libera um nome em qualquer posição.
  // `vocabularioFraco` vem do título e da descrição atual: libera palavra
  // comum, mas nunca um nome em posição de marca quando há BRAND estruturada
  // — fato estruturado vence contexto fraco. O MODEL legado fora do padrão
  // não entra em nenhum dos dois.
  const fontesFortes = [categoriaUtil];
  for (const f of fatos) fontesFortes.push(f.label, f.value);
  for (const p of proibidos) fontesFortes.push(p.label);
  const fontesFracas = [tituloAtual, descricaoAtual.texto];
  const nomesAutorizados = new Set();
  const vocabularioFraco = new Set();
  const numerosPermitidos = new Set();
  // Palavras que o contexto fraco usa em minúscula: palavra comum, não nome.
  const vocabularioComum = new Set();
  for (const [fontes, destino] of [[fontesFortes, nomesAutorizados], [fontesFracas, vocabularioFraco]]) {
    for (const fonte of fontes) {
      if (!fonte) continue;
      for (const t of seo.extractTokens(fonte)) {
        destino.add(t.key);
        if (destino === vocabularioFraco && !/^\p{Lu}/u.test(t.original)) vocabularioComum.add(t.key);
      }
      for (const n of extrairNumeros(fonte)) numerosPermitidos.add(n.numero);
    }
  }
  // F7A.8 — "Quantidade de portas: 0" saiu dos fatos (virou proibido), mas o
  // 0 dele continua sendo número verdadeiro do anúncio.
  for (const p of proibidos) for (const n of extrairNumeros(p.value)) numerosPermitidos.add(n.numero);

  // Grounding lexical (F7A.2): toda palavra de conteúdo que alguma fonte
  // autorizada usa — fatos fortes/secundários, categoria, marca, MODEL seguro,
  // título e descrição atual. É só a ORIGEM léxica da palavra; as regras de
  // nome/marca (fato estruturado vence contexto fraco) continuam em
  // analisarNomes.
  const vocabularioAutorizado = new Set([...nomesAutorizados, ...vocabularioFraco]);
  // Onde a troca de gênero -o/-a vale (F7A.4): só VALOR de atributo
  // estruturado ("Reta", "Dourado", "Adultos") e rótulo de booleano "Sim"
  // ("É reforçada") — posições de adjetivo. Nunca título/descrição atual.
  const vocabularioDeValores = new Set();
  for (const f of fatos) {
    if (f.id === "brand" || f.id === "model") continue;
    const fonte = valorBooleano(f.value) === true ? f.label : f.value;
    for (const t of palavrasDeConteudo(fonte)) vocabularioDeValores.add(t.key);
  }

  // F14 — característica booleana "Sim" pelo ID do atributo: IS_BLACK_OUT=Sim
  // prova que "blackout" é DESCRITOR do produto, não marca de outro.
  const descritoresDeAtributo = new Set();
  for (const f of fatos) {
    if (!f.id.startsWith("attr:") || valorBooleano(f.value) !== true) continue;
    const id = f.id.slice(5).toLowerCase().replace(/^(is|has|with|includes?)_/, "");
    descritoresDeAtributo.add(id.replace(/[^a-z0-9]/g, ""));
  }

  const nFatosProduto = (marcaUtil ? 1 : 0) + (modeloUtil ? 1 : 0) + nAtributos;
  const descricaoUtil = !!(descricaoAtual.texto && descricaoAtual.texto.length >= DESCRICAO_ATUAL_MIN_UTIL);
  const suficiente = nFatosProduto + (descricaoUtil ? 1 : 0) >= MIN_FATOS;

  // Faixa operacional proporcional ao que existe para dizer.
  const peso = nFatosProduto + (descricaoUtil ? 2 : 0);
  let alvo = peso <= 3 ? { min: 300, max: 700 } : peso <= 7 ? { min: 500, max: 1200 } : { min: 800, max: 2000 };
  if (alvo.max > limite) alvo = { min: Math.min(alvo.min, Math.floor(limite / 2)), max: limite };

  return {
    limite,
    alvo,
    categoria: categoriaUtil,
    tituloAtual,
    // F9.1 — marca em conflito entre fontes não é fato confiável
    marca: conflitos.some((c) => c.tipo === "MARCA") ? null : marcaUtil,
    modelo: modeloUtil,
    descricaoAtual,
    fatos,
    proibidos,
    idsConhecidos,
    nomesAutorizados,
    vocabularioFraco,
    vocabularioComum,
    descritoresDeAtributo,
    vocabularioAutorizado,
    vocabularioDeValores,
    numerosPermitidos,
    vocabularioDoTitulo: new Set(seo.extractTokens(tituloAtual || "").map((t) => t.key)),
    conflitos,
    kit,
    nFatosProduto,
    suficiente,
  };
}

// -----------------------------------------------------------------------------
// Linguagem proibida — frases já sem acento e em minúsculas. Um termo que é
// VALOR de um fato estruturado (linha "Premium", por exemplo) deixa de ser
// promocional para aquele anúncio.
// -----------------------------------------------------------------------------
const LINGUAGEM_PROIBIDA = [
  // hipérbole / publicidade genérica
  "imperdivel", "incrivel", "incriveis", "incomparavel", "sensacional", "espetacular", "fantastico",
  "fantastica", "maravilhoso", "maravilhosa", "revolucionario", "revolucionaria", "perfeito", "perfeita",
  "perfeitos", "perfeitas", "descubra", "nao perca", "aproveite", "garanta ja", "garanta o seu",
  "garanta a sua", "garanta os seus", "garanta as suas", "compre ja", "compre agora", "corra",
  "ultimas unidades", "oferta", "promocao", "desconto", "liquidacao", "queima de estoque",
  "o melhor", "a melhor", "os melhores", "as melhores", "melhor escolha", "melhor custo", "melhor preco",
  "alta qualidade", "excelente qualidade", "qualidade superior", "qualidade premium", "top de linha",
  "sucesso de vendas", "mais vendido", "mais vendida", "lancamento", "premium", "exclusivo", "exclusiva",
  // logística e políticas (a descrição não promete frete, prazo, troca)
  "frete", "envio", "enviamos", "despachamos", "postagem", "pronta entrega", "entrega rapida",
  "entrega imediata", "entrega gratis", "prazo de entrega", "prazo de envio", "mesmo dia",
  "garantia", "devolucao", "reembolso", "troca gratis", "nota fiscal",
  // F7A.2 — limite/regra de pedido e envio. Só formas logísticas: "enviar"
  // sozinho fica de fora ("permite enviar mensagens" é recurso do produto).
  "por pedido", "cada pedido", "seu pedido", "pedido minimo", "possivel enviar", "enviar no maximo",
  "enviar ate", "enviar apenas", "enviar somente", "sera enviado", "sera enviada", "serao enviados",
  "serao enviadas", "transportadora", "transportadoras", "despacho", "despachado", "despachada",
  "despachados", "despachadas", "postado", "postada", "entrega em ate", "entregue em ate",
  // F7C.1 — entrega/recebimento genéricos também são promessa logística
  "receba", "recebe em casa", "recebera", "receber em casa", "receber no", "chega ate voce", "chegar ate voce",
  "chegara", "chega rapido", "chegue", "entregue", "entregues", "entregamos", "entregar", "rastreio", "rastreamento",
  "embalagem cuidadosa", "embalagem segura", "bem embalado", "bem embalada", "embalado com cuidado",
  "embalada com cuidado", "pronto para envio", "pronta para envio",
  // linguagem de chatbot
  "como assistente", "como uma ia", "modelo de linguagem", "espero que", "segue a descricao",
  "aqui esta", "certamente",
];
// F7C — na COPY (como usar, benefícios, experiência de compra) a chamada
// leve à compra é permitida; hipérbole forte, superlativo e preço/estoque não.
const COPY_LIBERADA = new Set([
  "aproveite", "garanta ja", "garanta o seu", "garanta a sua", "garanta os seus", "garanta as suas", "compre ja",
  "compre agora", "nao perca", "descubra", "perfeito", "perfeita", "perfeitos", "perfeitas",
]);
// Condição comercial (preço, estoque, ranking de venda) é fato que nenhuma
// fonte tem: HARD em qualquer seção.
const LINGUAGEM_PRECO_ESTOQUE = new Set([
  "oferta", "promocao", "desconto", "liquidacao", "queima de estoque", "ultimas unidades", "melhor preco",
  "melhor custo", "mais vendido", "mais vendida", "sucesso de vendas",
]);
// Na copy, "qualidade" sem fato continua claim (o resto da PROPAGANDA vira
// benefício subjetivo livre: praticidade, conforto, elegância, versatilidade).
const COPY_PROPAGANDA_VIGIADA = new Set(["qualidade"].map((w) => seo.reduceMorphology(w)));
// Claim objetivo na copy: originalidade, efeito prometido, compatibilidade.
// Só passa se a mesma raiz estiver num fato estruturado ou no título.
const RAIZES_CLAIM_DA_COPY = ["original", "autentic", "oficial", "hidrat", "nutri", "restaur", "revitaliz", "rejuvenesc",
  "regener", "compativ", "garantid", "comprovad", "clinicament", "dermatologic"];
const RE_CLAIM_DA_COPY = new RegExp("(^|[^a-z])((?:" + RAIZES_CLAIM_DA_COPY.join("|") + ")[a-z]*)", "g");
// F8.2 — palavra que só compartilha a GRAFIA da raiz, com outro sentido
// ("restaurante" não é "restaurar"). Lista fechada de homógrafos.
const HOMOGRAFOS_DE_CLAIM = new Set(["restaurante", "restaurantes"]);
// F8.2 — o substantivo do efeito ("hidratação", "nutrição", "restauração")
// pode nomear só a ATIVIDADE ("necessidades de hidratação", "hidratação
// coletiva" num bebedouro). É promessa de efeito quando vem com alvo ("da
// pele", "dos fios"), intensidade ("intensa", "profunda") ou verbo de
// promessa antes ("proporciona", "garante"). Verbo/adjetivo ("hidrata",
// "hidratante", "restaura") continua sempre claim.
const RE_EFEITO_NOMINAL = /(cao|coes|mento|mentos)$/;
const RE_ALVO_OU_INTENSIDADE = /^\s+(?:[a-z]+\s+){0,1}(?:intens|profund|prolongad|imediat|extra|total|duradour|d[aoe]s?\s+(?:pele|fios?|cabelos?|labios|unhas|rosto|corpo|maos|barba|couro|cuticulas?|madeira|superficies?))/;
const RE_PROMESSA_ANTES = /(promove|promover|garante|garantir|proporciona|proporcionar|oferece|oferecer|traz|trazer|entrega|assegura|potencializa|potencializar)(?:\s+[a-z]+){0,2}\s*$/;
function claimsDaCopy(texto, ficha) {
  const fortes = Array.from(ficha.nomesAutorizados).concat(Array.from(ficha.vocabularioDoTitulo || []));
  const out = [];
  const s = semAcento(texto);
  for (const m of s.matchAll(RE_CLAIM_DA_COPY)) {
    if (HOMOGRAFOS_DE_CLAIM.has(m[2])) continue;
    const ini = m.index + m[1].length;
    if (RE_EFEITO_NOMINAL.test(m[2]) && !RE_ALVO_OU_INTENSIDADE.test(s.slice(ini + m[2].length, ini + m[2].length + 40)) &&
      !RE_PROMESSA_ANTES.test(s.slice(Math.max(0, ini - 40), ini))) continue;
    const raiz = RAIZES_CLAIM_DA_COPY.find((r) => m[2].startsWith(r));
    if (!fortes.some((k) => k.startsWith(raiz)) && !out.includes(m[2])) out.push(m[2]);
  }
  return out;
}
// F7C.1 — claim comercial objetivo sem fonte, em QUALQUER bloco:
//   preço/custo   — "custo acessível", "barato", "boa relação custo-benefício";
//   facilidade    — "fácil/simples de instalar/montar/usar", "instalação rápida".
// Passa só se a mesma expressão estiver numa fonte (fato, título, descrição
// atual). "Fácil de combinar/vestir/transportar" fica livre: é estilo ou
// benefício de característica real, não afirmação técnica.
const RE_PRECO = /(^|[^a-z])(acessive(?:l|is)|barat[oa]s?|economic[oa]s?|economi(?:a|za|zar|zando)|custo[ -]?beneficio|relacao (?:entre )?(?:o )?custo|baixo custo|bom preco|preco (?:justo|baixo|acessivel|otimo|imbativel|competitivo|camarada)|cabe no (?:seu )?bolso|vale (?:cada centavo|o investimento)|em conta)(?=[^a-z]|$)/g;
const RE_FACILIDADE = /(^|[^a-z])((?:facil|faceis|simples|rapid[oa]s?|descomplicad[oa]s?) (?:de |para )?(?:instalar|instalacao|montar|montagem|usar|utilizar|manusear|limpar|lavar|aplicar|encaixar|trocar|substituir|configurar|operar|conectar)|(?:instalacao|montagem|limpeza|aplicacao|troca|manutencao|configuracao) (?:facil|simples|rapida|pratica|descomplicada|intuitiva)|sem complicac(?:ao|oes)|plug and play|intuitiv[oa]s?)(?=[^a-z]|$)/g;
function claimsComerciaisSemFonte(texto, ficha) {
  const fontes = semAcento([ficha.tituloAtual, ficha.descricaoAtual && ficha.descricaoAtual.texto,
    ...ficha.fatos.map((f) => f.label + " " + f.value)].filter(Boolean).join(" \n "));
  const out = [];
  const s = semAcento(texto);
  for (const re of [RE_PRECO, RE_FACILIDADE]) {
    for (const m of s.matchAll(re)) {
      // Só a complicação do ATO de comprar é experiência, nunca instalação/uso.
      if (/^sem complicac/.test(m[2]) && modificaACompra(fraseAte(s, m.index))) continue;
      if (!fontes.includes(m[2]) && !out.includes(m[2])) out.push(m[2]);
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// F8.1 — afirmação OBJETIVA de desempenho/propriedade, em QUALQUER bloco. A
// copy é livre para estilo e experiência de uso, não para desempenho. Regra
// por FORMA da frase, não por produto:
//   AVALIAÇÃO  — avaliação + propriedade ("baixo consumo", "boa resistência",
//                "mais estabilidade", "maior durabilidade"). A forma inteira é
//                suspeita; só qualidade de EXPERIÊNCIA (lista fechada abaixo:
//                praticidade, conforto, estilo, versatilidade…) é copy livre —
//                propriedade nova cai no bloqueio sem precisar entrar em lista.
//                Com "mais/menos", só substantivo de propriedade (-ção, -dade,
//                -ência, -eza, -mento…): "mais prático" é adjetivo de estilo.
//   DESEMPENHO — as dimensões de desempenho em si: eficiência, rapidez,
//                potência, estabilidade, firmeza, robustez, silêncio,
//                durabilidade, resistência, precisão, desempenho.
//   USO        — duração e comportamento sob uso ("uso prolongado", "longa
//                duração", "em pouco tempo", "com agilidade", "não desbota").
// Evidência: a propriedade num fato ESTRUTURADO (rótulo ou valor, fora marca e
// modelo) ou a MESMA expressão no título. A descrição atual do vendedor não
// sustenta desempenho (F7A.12); o nome da marca também não ("Resistencia").
// -----------------------------------------------------------------------------
const EXPERIENCIA = new Set([
  "praticidade", "conforto", "estilo", "elegancia", "versatilidade", "charme", "beleza", "sofisticacao",
  "personalidade", "identidade", "liberdade", "flexibilidade", "leveza", "variedade", "diversao", "organizacao",
  "espaco", "possibilidade", "opcao", "combinacao", "tranquilidade", "confianca", "facilidade", "harmonia", "frescor",
  "aconchego", "destaque", "presenca", "movimento", "comodidade", "criatividade", "delicadeza", "descontracao",
  "escolha", "compra", "pedida", "presente", "ideia", "aliado", "aliada", "companhia", "gosto", "aparencia",
  "caimento", "ajuste", "look", "alegria", "emocao", "momento", "conveniencia", "motivacao", "constancia",
  "naturalidade", "simplicidade", "requinte", "modernidade", "autoestima", "vida", "cor", "encanto", "graca",
  "agilidade",
  // F8.2 — papel do item na vida do comprador ("ótima adição ao guarda-roupa")
  "adicao", "aquisicao", "complemento", "acrescimo",
]);
// + os adjetivos subjetivos leves (VOCABULARIO_SUBJETIVO, declarado adiante)
const ehExperiencia = (w) => EXPERIENCIA.has(w) || VOCABULARIO_SUBJETIVO.includes(w) || EXPERIENCIA.has(w.replace(/s$/, "")) ||
  (w.endsWith("oes") && EXPERIENCIA.has(w.slice(0, -3) + "ao")) || (w.endsWith("es") && EXPERIENCIA.has(w.slice(0, -2)));
const RE_AVALIACAO = /(^|[^a-z-])(baix[oa]s?|alt[oa]s?|bo[ma]|bons|boas|otim[oa]s?|excelentes?|maior(?:es)?|menor(?:es)?|maxim[oa]|superior(?:es)?|elevad[oa]|reduzid[oa]|mais|menos)\s+([a-z]+)/g;
// A palavra depois da avaliação tem de ser SUBSTANTIVO de propriedade — pelo
// sufixo, ou um dos poucos sem sufixo. Assim "cintura alta valoriza" (adjetivo
// do nome anterior + verbo) e "ficou ótimo pendurado" não são claim.
const RE_SUBSTANTIVO_DE_PROPRIEDADE = /(cao|coes|dade|dades|encia|encias|ancia|ancias|anca|ancas|eza|ezas|mento|mentos|ura|uras|agem)$|^(consumo|ruido|impacto|atrito|alcance|brilho|contraste|fluxo|rendimento|desempenho)$/;
const DIMENSOES_DE_DESEMPENHO = [/^(eficien|eficaz|eficac)/, /^(rapid|veloz|velocid)/, /^(potent|potenc)/, /^(estavel|estaveis|estabil)/,
  /^firme(s|za)?$/, /^robust/, /^silenc/, /^(durav|durab)/, /^resist/, /^precisao$/, /^(desempenh|performance)/];
const RE_DESEMPENHO = /(^|[^a-z])(eficientes?|eficiencia|eficaz(?:es)?|eficacia|rapid[oa]s?|rapidamente|rapidez|velozes|veloz|potentes?|potencia|estave(?:l|is)|estabilidade|firmes?|firmeza|robust[oa]s?|robustez|silencios[oa]s?|silencio|dura(?:vel|veis)|durabilidade|resistentes?|resistencia|precisao|desempenho|performance)(?=[^a-z]|$)/g;
const RE_USO = /(^|[^a-z])(uso (?:prolongado|continuo|intenso|pesado|constante|severo)|longa (?:duracao|vida)|vida util|(?:por|durante) (?:muito|mais|longo) tempo|por (?:varias |muitas )?horas|horas de uso|em (?:pouco|menos) tempo|em (?:poucos )?(?:segundos|minutos)|tempo indeterminado|sem esforco|com (?:agilidade|rapidez|eficiencia|precisao|firmeza)|nao (?:desbotam?|amassam?|enrolam?|deformam?|quebram?|enferrujam?|descascam?|mancham?|vazam?|escorregam?|esquentam?|encolhem?|desfiam?|perdem? a (?:cor|forma)))(?=[^a-z]|$)/g;

// F9.1 — formas de FUNÇÃO técnica (ver claimsObjetivosSemFonte). Classes de
// forma, não lista de produto:
//   prefixo de propriedade — anti-/hipo- + radical ("antigo/antiguidade" não);
//   tratamento/filtragem nomeado — "tratamento X", "revestimento X",
//     "filtragem X", "filtro X", "camada X", "barreira X", "membrana X";
//   ação sobre agente — filtra, retém, bloqueia, repele, isola, veda,
//     neutraliza, elimina (3ª pessoa/infinitivo: instrução "evite" fica fora);
//   agente físico-químico — poeira, névoa, fumo, gás, vapor, respingo,
//     umidade, corrosão, ferrugem, mofo, bactéria, germe, ácaro, alérgeno,
//     radiação, chama, faísca, produto químico.
const RE_FUNCAO_PREFIXO = /(^|[^a-z])((?:anti(?!g)|hipo)[a-z]{5,})(?=[^a-z]|$)/g;
const RE_FUNCAO_TRATAMENTO = /(^|[^a-z])((?:tratamento|revestimento|filtragem|filtro|camada|barreira|membrana)\s+(?:de\s+)?([a-z]{5,}))(?=[^a-z]|$)/g;
const RE_FUNCAO_ACAO = /(^|[^a-z])(filtra(?:m|r)?|filtragem|ret[eé]m|reter|bloqueia(?:m)?|repele(?:m)?|repelir|isola(?:m|r)?|veda(?:m|r)?|vedacao|neutraliza(?:m|r)?|elimina(?:m|r)?)(?=[^a-z]|$)/g;
const RE_AGENTE = /(^|[^a-z])(poeiras?|nevoas?|fumos?|gases|vapor(?:es)?|respingos?|umidade|corrosao|ferrugem|mofo|bacterias?|germes?|acaros?|alergenos?|radiacao|chamas|faiscas?|produtos? quimicos?|agentes? quimicos?)(?=[^a-z]|$)/g;

// F8.3 — a exceção de compra só vale quando a palavra modifica o ATO de
// comprar: entre a âncora (comprar, finalizar, concluir, adquirir, compra,
// pedido) e a palavra só pode haver artigo/possessivo, o objeto da compra,
// moldura de modo ("de forma", "com confiança") e qualidade da própria compra
// ("simples", "segura"). Qualquer outra palavra ("tenha aquecimento",
// "um produto de instalação", "com secagem", "aproveite o carregamento")
// muda o assunto para o produto: continua claim.
//   "Compre de forma rápida e segura"   · "Finalize sua compra rapidamente"
//   "Uma compra simples e rápida"       · "Comprar é simples e rápido"
const RE_ANCORA_DE_COMPRA = /(^|[^a-z])(compr(?:a|as|ar|e|em|ando)|finaliz[a-z]*|conclu(?:a|ir|i|indo|ido)|adquir(?:a|ir|e|indo)|pedido|aquisicao)(?=[^a-z]|$)/g;
const LIGAM_A_COMPRA = new Set(["a", "o", "as", "os", "um", "uma", "sua", "seu", "suas", "seus", "e", "de", "forma", "maneira",
  "modo", "jeito", "com", "compra", "pedido", "confianca", "praticidade", "seguranca", "tranquilidade", "facilidade",
  "simples", "segura", "seguro", "pratica", "pratico", "facil", "tranquila", "tranquilo", "muito", "mais", "bem", "ja",
  "agora", "foi", "fica", "ficou", "sera", "totalmente",
  "pelo", "pela", "no", "na", "mercado", "livre"]); // "Comprar pelo Mercado Livre é rápido"
function modificaACompra(fraseAntes) {
  for (const m of fraseAntes.matchAll(RE_ANCORA_DE_COMPRA)) {
    const meio = fraseAntes.slice(m.index + m[0].length).split(/[^a-z]+/).filter(Boolean);
    if (meio.every((w) => LIGAM_A_COMPRA.has(w))) return true;
  }
  return false;
}

function claimsObjetivosSemFonte(texto, ficha) {
  const fatosFortes = ficha.fatos.filter((f) => f.id !== "brand" && f.id !== "model");
  const fortes = semAcento(fatosFortes.map((f) => f.label + " : " + f.value).join(" \n "));
  const titulo = semAcento(ficha.tituloAtual || "");
  const tokensFortes = (fortes + " \n " + titulo).split(/[^a-z0-9]+/).filter(Boolean);
  const chavesRotulos = new Set(fatosFortes.flatMap((f) => seo.contentKeys(f.label)));
  const temFrase = (frase) => contemFrase(fortes, frase) || contemFrase(titulo, frase);
  const s = semAcento(texto);
  const out = [];
  const add = (w) => { if (!out.includes(w)) out.push(w); };
  for (const m of s.matchAll(RE_AVALIACAO)) {
    const [, , aval, prop] = m;
    const t = seo.extractTokens(prop)[0];
    if (!t || t.stopword || /^\d/.test(prop) || ehExperiencia(prop) || !RE_SUBSTANTIVO_DE_PROPRIEDADE.test(prop)) continue;
    if (temFrase(aval + " " + prop) || chavesRotulos.has(t.key)) continue;
    add(aval + " " + prop);
  }
  // o que vem antes na mesma frase
  const antesNaFrase = (i) => s.slice(Math.max(0, i - 40), i).split(/[.;!?\n•*]/).pop();
  for (const m of s.matchAll(RE_DESEMPENHO)) {
    // nome da dimensão + medida ("potência de 2500w", "velocidade: 12 km/h") é
    // fato medido — o número passa pela checagem de números, não é avaliação
    if (/^\s*(?:de|:)?\s*(?:ate\s+)?\d/.test(s.slice(m.index + m[0].length, m.index + m[0].length + 12))) continue;
    const antes = antesNaFrase(m.index);
    // rapidez da COMPRA ("comprar é simples e rápido") não é desempenho do
    // produto; adjetivo do VISUAL ("design robusto") é estilo
    if (modificaACompra(fraseAte(s, m.index))) continue;
    // F8.2 — "resistência elétrica/de imersão/de aquecimento" é a PEÇA que
    // aquece, não resistência a uso/impacto
    if (ehResistenciaComponente(s, m.index + m[1].length, m[2])) continue;
    if (/(^|[^a-z])(design|visual|estilo|aparencia|look|linhas)\s+$/.test(antes)) continue;
    const dim = DIMENSOES_DE_DESEMPENHO.find((re) => re.test(m[2]));
    if (dim && tokensFortes.some((w) => dim.test(w))) continue;
    add(m[2]);
  }
  for (const m of s.matchAll(RE_USO)) if (!temFrase(m[2])) add(m[2]);
  // F9.1 — FUNÇÃO técnica, também em COMO USAR: propriedade por prefixo
  // ("antiembaçante", "hipoalergênico"), tratamento/filtragem nomeados
  // ("tratamento eletrostático"), ação sobre um agente ("filtra", "repele",
  // "veda") e exposição a agente físico-químico ("ambientes com poeiras,
  // névoas e fumos"). Mesma evidência: fato estruturado ou título.
  const temRaiz = (w, n = 6) => tokensFortes.some((x) => x.startsWith(w.slice(0, n)));
  for (const m of s.matchAll(RE_FUNCAO_PREFIXO)) if (!temRaiz(m[2], Math.min(m[2].length, 9))) add(m[2]);
  for (const m of s.matchAll(RE_FUNCAO_TRATAMENTO)) if (!temFrase(m[2]) && !temRaiz(m[3])) add(m[2]);
  for (const m of s.matchAll(RE_FUNCAO_ACAO)) if (!temRaiz(m[2], 5)) add(m[2]);
  for (const m of s.matchAll(RE_AGENTE)) if (!temRaiz(m[2], 5)) add(m[2]);
  return out;
}

// F8.1 — kit de N (ficha.kit) tem de aparecer como quantidade: "Kit com 3",
// "3 unidades", "3 mini spots", "Unidades por kit: 3". "3 cm"/"2 hp" não.
const NAO_SAO_ITENS = new Set([...UNIDADES.keys(), "x", "hp", "k", "gb", "mb", "tb", "mah", "mpx", "fps", "dpi", "pol",
  "polegadas", "vezes", "hora", "horas", "ano", "anos", "mes", "meses", "dia", "dias", "minutos", "segundos", "graus"]);
function kitCitado(texto, n) {
  if (quantidadesCitadas(texto).has(n)) return true;
  const formas = [String(n), ...Array.from(NUMEROS_POR_EXTENSO).filter(([, v]) => v === n).map(([k]) => k)];
  const re = new RegExp("(^|[^\\d.,a-z])(" + formas.join("|") + ")\\s+([a-z]+)", "g");
  return Array.from(semAcento(texto).matchAll(re)).some((m) => !NAO_SAO_ITENS.has(m[3]));
}

// Fato objetivo na copy: material (léxico da F7B.1) ou cor que não está nos dados.
const CORES = ["preto", "branco", "azul", "vermelho", "verde", "amarelo", "rosa", "roxo", "lilas", "cinza", "marrom",
  "bege", "dourado", "prateado", "laranja", "vinho", "bordo", "nude", "caramelo", "creme", "grafite", "chumbo",
  "turquesa", "marinho", "prata", "ouro"];
const CHAVES_DE_COR = new Set(CORES.map((w) => seo.extractTokens(w)[0].key));
// Componentes/recursos: citar um que os dados não têm é inventar fato
// ("com capuz", "palmilha de gel", "porta USB").
// Palavras com outro sentido comum (controle, suporte, barra, pé, tela, capa) ficam
// fora: "oferece controle simples" não cita controle remoto.
const COMPONENTES = ["bolso", "ziper", "capuz", "forro", "roda", "rodinha", "gaveta", "porta", "prateleira", "tampa", "alca",
  "fecho", "botao", "luz", "led", "usb", "bateria", "pilha", "cabo", "carregador", "palmilha", "solado",
  "cadarco", "velcro", "elastico", "cordao", "estojo", "regulagem", "trava", "fechadura",
  "chave", "visor", "display", "camera", "microfone", "alto-falante", "bluetooth", "wifi", "sensor", "timer",
  "motor", "filtro", "refil", "lamina", "escova", "bico", "mangueira", "manga", "gola", "punho", "bordado",
  "estampa", "brilho", "strass", "pedraria", "lantejoula", "spike", "rebite", "tachas"];
const CHAVES_DE_COMPONENTE = new Set(COMPONENTES.map((w) => (seo.extractTokens(w)[0] || {}).key).filter(Boolean));
function fatosObjetivosDaCopy(texto, ficha) {
  const out = [];
  for (const t of seo.extractTokens(texto)) {
    if (!(MATERIAL_POR_CHAVE.has(t.key) || CHAVES_DE_COR.has(t.key) || CHAVES_DE_COMPONENTE.has(t.key)) || out.includes(t.original.toLowerCase())) continue;
    if (ficha.vocabularioAutorizado.has(t.key) || autorizadaPorMorfologia(t.key, ficha)) continue;
    out.push(t.original.toLowerCase());
  }
  return out;
}

// F9.1 — RECEBER com o comprador como sujeito ("você recebe tudo o que
// precisa", "receber o produto", "recebe uma peça estilosa") promete entrega:
// logística HARD. Fica de fora a FUNÇÃO do produto — "recebe chamadas /
// mensagens / notificações / até 3 lâmpadas", "receber visitas" — e o verbo
// que um fato estruturado ou o título já tem.
const RE_RECEBER = /(^|[^a-z])(receb(?:e|em|era|erao|er|endo|ido|ida|imento)|receba|recebam)(?=[^a-z]|$)/g;
const OBJETOS_DE_FUNCAO_DE_RECEBER = /^\s+(?:(?:a|as|o|os|ate|ate\s+\d+)\s+)?(?:\d+\s+)?(chamadas?|ligacoes?|mensagens?|notificacoes?|sinal|sinais|dados|arquivos|carga|energia|agua|luz|lampadas?|visitas?|convidados?|hospedes?|amigos?|cartoes?|moedas?|pagamentos?|pecas?|cabos?|parafusos?)(?=[^a-z]|$)/;
function recebimentosSemFonte(normalizado, ficha) {
  const fortes = semAcento([ficha.tituloAtual, ...ficha.fatos.filter((f) => f.id !== "brand" && f.id !== "model").map((f) => f.label + " " + f.value)].join(" \n "));
  if (/(^|[^a-z])receb/.test(fortes)) return [];
  const out = [];
  for (const m of normalizado.matchAll(RE_RECEBER)) {
    const depois = normalizado.slice(m.index + m[0].length, m.index + m[0].length + 40);
    if (OBJETOS_DE_FUNCAO_DE_RECEBER.test(depois)) continue;
    if (!out.includes(m[2])) out.push(m[2]);
  }
  return out;
}

// F7B — dentro da linguagem proibida, logística/garantia/políticas é HARD
// (promessa operacional indevida); hipérbole, publicidade e chatbot são SOFT
// (a frase sai, o resto do texto fica).
const LINGUAGEM_LOGISTICA = new Set(LINGUAGEM_PROIBIDA.slice(LINGUAGEM_PROIBIDA.indexOf("frete"), LINGUAGEM_PROIBIDA.indexOf("como assistente")));
const CONTATO_EXTERNO = [
  "whatsapp", "whats", "zap", "instagram", "facebook", "telegram", "tiktok", "youtube",
  "ligue", "entre em contato", "fale conosco", "chame no", "mande mensagem",
];
// Voz do vendedor — com acento, porque "nos" sem acento é contração (em + os).
// F7A.8 — também verbo na 1ª pessoa do plural, comum no texto do vendedor
// ("Recomendamos lavar…", "Trabalhamos com…"). Lista fechada: terminação
// -amos/-emos sozinha pegaria "ramos", "extremos", "últimos".
const VOZ_DA_LOJA = new RegExp("(^|[^\\p{L}])(nós|nosso|nossa|nossos|nossas|conosco|" + [
  "recomendamos", "indicamos", "sugerimos", "aconselhamos", "orientamos", "oferecemos", "garantimos", "trabalhamos",
  "vendemos", "temos", "fabricamos", "produzimos", "enviamos", "entregamos", "atendemos", "aceitamos",
  "prezamos", "buscamos", "priorizamos", "selecionamos", "utilizamos", "usamos", "embalamos", "possuímos",
  "contamos", "disponibilizamos", "informamos", "pedimos", "agradecemos", "estamos", "somos", "fazemos",
  "queremos", "desejamos", "esperamos", "asseguramos", "testamos", "conferimos", "revisamos",
].join("|") + ")(?=[^\\p{L}]|$)", "iu");
// F7B — dados da empresa em 3ª pessoa (texto já sem acento). Lista fechada.
const RE_TEXTO_DE_LOJA = /(^|[^a-z])(empresa|loja|lojista|sede|fundada|fundado|estabelecida desde|estabelecido desde|desde \d{4}|nossos clientes|clientes|atendimento|cnpj|razao social|revendedor autorizado)(?=[^a-z]|$)/;

// F7A.8 — claim de qualidade/benefício que o anúncio só tem porque o
// vendedor escreveu na descrição atual ("com qualidade e durabilidade", "para
// manter a qualidade do tecido"). O contexto fraco autoriza a palavra no
// grounding, mas não a propaganda: estas chaves só valem quando um fato
// estruturado ou o título também as têm.
const PROPAGANDA = [
  "qualidade", "durabilidade", "duravel", "resistente", "resistencia", "conforto", "confortavel", "elegante",
  "elegancia", "sofisticado", "sofisticacao", "bonito", "lindo", "beleza", "charme", "charmoso", "versatil",
  "versatilidade", "praticidade", "pratico", "seguranca", "original", "originalidade", "encantador", "garantir",
  "proporciona", "proporcionar", "valoriza", "valorizar", "realca", "realcar", "estiloso", "tendencia", "satisfacao",
  "confianca", "excelente", "otimo", "superior", "impecavel", "caprichado", "diferenciado", "renomado",
  "confiavel", "eficiente", "eficiencia",
  // resultado prometido ("fios hidratados, nutridos, macios e brilhantes")
  "hidratado", "nutrido", "restaurado", "revitalizado", "macio", "maciez", "brilhante", "brilho", "sedoso",
  "saudavel", "rejuvenescido", "renovado", "protegido",
  // F7A.10 — claims objetivos: só valem se um fato estruturado ou o título os têm
  "compativel", "compatibilidade", "impermeavel", "impermeabilidade", "performance", "desempenho", "potente",
  "garantido", "garantida",
];

// F7A.10 — linguagem subjetiva LEVE, lista fechada: descreve visual/estilo e
// não é verificável nem afirma propriedade técnica ("visual moderno",
// "estilo clássico", "peça versátil"). Entra no grounding como vocabulário
// neutro e sai da PROPAGANDA. Nada de claim objetivo aqui (durável,
// resistente, confortável, impermeável, original… continuam exigindo fato).
const VOCABULARIO_SUBJETIVO = [
  "visual", "estilo", "design", "moderno", "classico", "elegante", "versatil", "sofisticado", "delicado",
  "discreto", "atual", "contemporaneo", "estiloso", "charmoso", "bonito", "basico", "despojado", "minimalista",
  "marcante", "harmonioso", "refinado",
];
const CHAVES_SUBJETIVAS = new Set(VOCABULARIO_SUBJETIVO.map((w) => seo.reduceMorphology(w)));
const CHAVES_DE_PROPAGANDA = new Set(PROPAGANDA.map((w) => seo.reduceMorphology(w)).filter((k) => !CHAVES_SUBJETIVAS.has(k)));

function contemFrase(normalizado, frase) {
  const re = new RegExp("(^|[^a-z0-9])" + frase.replace(/ /g, "\\s+") + "(?=[^a-z0-9]|$)");
  return re.test(normalizado);
}

const RE_URL = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|br|io|shop|store|link|ly|me)\b)/i;
const RE_EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const RE_TELEFONE = /(\+?55[\s-]?)?\(?\b\d{2}\)?[\s-]?9?\d{4}[\s-]?\d{4}\b/;
const RE_HANDLE = /(^|\s)@[\w.]{2,}/;
const RE_HTML = /<\/?[a-z][^>]*>/i;
const RE_MARKDOWN = /\*\*|__|^\s{0,3}#{1,6}\s/m;
const RE_EMOJI = /\p{Extended_Pictographic}/u;

// Palavras genéricas de seção que podem aparecer com maiúscula no meio da
// linha sem serem nome próprio ("Conteúdo da Embalagem").
const PALAVRAS_DE_SECAO = new Set([
  "conteudo", "embalagem", "caracteristica", "uso", "indicacao", "observacao", "importante", "especificacao", "dimensao", "adicional",
  "destaque", "beneficio",
  "cuidado", "aplicacao", "modo", "como", "usar", "detalhe", "informacao", "produto",
  "peca", // F7A.12 — substantivo do nome neutro ("Kit 2 Peça Zenite …")
]);

// -----------------------------------------------------------------------------
// Nomes próprios / marca — sem reconhecedor de entidades. Uma palavra vira
// CANDIDATA a nome comercial em qualquer posição (início, meio, fim, depois de
// quebra de linha ou pontuação) quando:
//   1. está em POSIÇÃO DE MARCA: depois de "marca", "da", "pela", "pelo",
//      "produto", "fabricante", "grife", "linha" ("Produto da Nike") ou antes
//      de "apresenta", "oferece", "traz", "desenvolveu/desenvolvido",
//      "fabrica", "produz", "modelo", "ideal"… ("Nike oferece", "Samsung
//      ideal para"). Depois de "marca", vale até em minúsculas;
//   2. tem maiúscula fora do início de frase ("no estilo Nike Air");
//   3. está TODA em maiúsculas ("NIKE");
//   4. abre a frase com maiúscula e tem grafia estrangeira (k/w/y, final em
//      consoante que o português não usa, "ph", "th", "pp"…: Nike, Samsung,
//      Olympikus). Palavra portuguesa comum abrindo frase ("Este", "Ideal",
//      "Desenvolvido", "Possui", "Com") não é candidata.
// Candidata autorizada = todas as chaves em `nomesAutorizados` (fatos
// estruturados) ou palavras de seção. O contexto fraco (título/descrição
// atual) autoriza sem restrição só quando NÃO há BRAND estruturada; com BRAND,
// nunca libera marca explícita, caixa alta ou grafia estrangeira — a descrição
// antiga nunca libera "Nike" num anúncio de BRAND = Molekinho.
// Não autorizada em posição de marca com BRAND → MARCA_CONFLITANTE; o resto →
// NOME_NAO_COMPROVADO.
// -----------------------------------------------------------------------------
const ANTES_DA_MARCA = new Set(["marca", "marcas", "da", "pela", "pelo", "produto", "produtos", "fabricante", "grife", "linha"]);
const DEPOIS_DA_MARCA = new Set([
  "apresenta", "oferece", "traz", "desenvolveu", "desenvolvido", "desenvolvida", "lanca", "lancou",
  "fabrica", "fabricado", "fabricada", "produz", "produzido", "produzida", "criou", "assina",
  "garante", "modelo", "linha", "ideal",
]);
// Palavras de uso corrente no português com grafia "estrangeira".
const EMPRESTIMOS_COMUNS = new Set([
  "kit", "kits", "design", "led", "leds", "show", "web", "wifi", "fitness", "notebook", "mouse",
  "smartphone", "smartwatch", "online", "light", "top", "spray", "skate", "short", "shorts", "jeans",
]);

function pareceEstrangeira(palavra) {
  const s = semAcento(palavra).replace(/[^a-z]/g, "");
  if (s.length < 3 || EMPRESTIMOS_COMUNS.has(s)) return false;
  return /[kwy]/.test(s) || /(ph|th|sh|ck|pp|tt|ff|gg|dd|bb|oo)/.test(s) || /[bcdfghjkpqtvx]$/.test(s);
}

function palavrasDaDescricao(textoDesc) {
  const palavras = [];
  for (const linha of String(textoDesc).split(/\n/)) {
    const semMarcador = linha.replace(/^\s*[-•*–]\s*/, "");
    const re = /([.!?:;,()"“”])|([\p{L}\p{N}][\p{L}\p{N}'’&-]*)/gu;
    let inicioDeFrase = true;
    let colado = false; // só espaço entre esta palavra e a anterior
    let sinal = null;   // F8.2 — pontuação logo antes (":" de rótulo, "(" de glosa)
    let ultima = null;
    let m;
    while ((m = re.exec(semMarcador))) {
      if (m[1]) {
        if (/[.!?:;]/.test(m[1])) inicioDeFrase = true;
        colado = false;
        sinal = m[1];
        continue;
      }
      const p = { palavra: m[2], inicio: inicioDeFrase, coladaNaAnterior: colado };
      if (sinal && ultima) { p.sinalAntes = sinal; p.antesDoSinal = ultima; }
      palavras.push(p);
      inicioDeFrase = false;
      colado = true;
      sinal = null;
      ultima = p;
    }
    // quebra de linha separa palavras
    if (palavras.length) palavras[palavras.length - 1].fimDeLinha = true;
  }
  for (const p of palavras) p.chaves = seo.extractTokens(p.palavra).map((t) => ({ key: t.key, stop: t.stopword }));
  palavras.forEach((p, i) => {
    p.anterior = p.coladaNaAnterior ? palavras[i - 1] : null;
    p.proxima = !p.fimDeLinha && palavras[i + 1] && palavras[i + 1].coladaNaAnterior ? palavras[i + 1] : null;
  });
  return palavras;
}

// F7A.6 — nome/linha do produto copiado EXATO do título atual: uma sequência
// contígua da descrição com 2+ palavras de NOME (maiúscula fora do início,
// caixa alta ou grafia estrangeira) que aparece igual, contígua, no título
// ("Hawaiian Coconut PinaPow"). Não vale: palavra isolada (o título não
// libera "Nike" sozinho), posição explícita de marca ("da marca X", "da X")
// — aí segue MARCA_CONFLITANTE com BRAND — nem sequência precedida de
// referência a outro produto ("estilo", "tipo", "similar", "compatível"…),
// no título ou na descrição.
const REFERENCIA_A_OUTRO = new Set(["estilo", "tipo", "similar", "compativel", "inspirado", "inspirada", "igual", "replica", "imitacao"]);

function nomesDoTitulo(palavras, ficha) {
  const autorizadas = new Set();
  const titulo = seo.extractTokens(ficha.tituloAtual || "").map((t) => t.key);
  if (titulo.length < 2) return autorizadas;
  const ehNome = (p) => /^\p{L}/u.test(p.palavra) && (/^\p{Lu}/u.test(p.palavra) && !p.inicio ||
    (p.palavra.length >= 2 && p.palavra === p.palavra.toUpperCase() && p.palavra !== p.palavra.toLowerCase()) || pareceEstrangeira(p.palavra));
  const chave1 = (p) => (p && p.chaves.length === 1 ? p.chaves[0].key : null);
  const noTitulo = (keys) => {
    for (let q = 0; q + keys.length <= titulo.length; q += 1) {
      if (keys.every((k, d) => titulo[q + d] === k) && !REFERENCIA_A_OUTRO.has(titulo[q - 1])) return true;
    }
    return false;
  };
  for (let i = 0; i < palavras.length; i += 1) {
    const ini = palavras[i];
    if (ANTES_DA_MARCA.has(chave1(ini.anterior)) || REFERENCIA_A_OUTRO.has(chave1(ini.anterior))) continue;
    let melhor = -1;
    const keys = [];
    for (let j = i; j < palavras.length && (j === i || palavras[j].coladaNaAnterior); j += 1) {
      if (palavras[j].chaves.some((c) => REFERENCIA_A_OUTRO.has(c.key))) break;
      keys.push(...palavras[j].chaves.map((c) => c.key));
      const run = palavras.slice(i, j + 1);
      if (run.filter(ehNome).length >= 2 && noTitulo(keys)) melhor = j;
    }
    for (let j = i; j <= melhor; j += 1) autorizadas.add(palavras[j]);
  }
  return autorizadas;
}

// F7C.2 — nomes de PLATAFORMA são uma unidade, nunca marca do produto em
// pedaços ("Mercado Livre" não vira a marca "Livre"). Listas fechadas, só com
// nomes sem outro sentido comum:
//   própria — o marketplace do anúncio: não é marca (é só metatexto);
//   outros  — citar outro marketplace numa descrição do ML é direcionar o
//             comprador para fora: CONTATO_EXTERNO (HARD), salvo se for a
//             marca do próprio produto (BRAND = Amazon).
const PLATAFORMAS_PROPRIAS = ["mercado livre", "mercadolivre", "mercado pago", "mercado envios", "mercado shops"];
const OUTROS_MARKETPLACES = ["shopee", "amazon", "magalu", "magazine luiza", "lojas americanas", "americanas.com", "shein",
  "aliexpress", "casas bahia", "netshoes", "dafiti", "olx", "kabum", "elo7", "temu", "ebay", "enjoei", "carrefour",
  "tiktok shop", "shoptime"];
// (nomes com ponto, como "americanas.com", só entram na checagem de contato)
const NOMES_DE_PLATAFORMA = PLATAFORMAS_PROPRIAS.concat(OUTROS_MARKETPLACES).filter((n) => !n.includes("."))
  .map((n) => n.split(/\s+/));

// Palavras da descrição que formam um nome de plataforma (sequência colada).
function palavrasDePlataforma(palavras) {
  const marcadas = new Set();
  const norm = (p) => semAcento(p.palavra);
  for (let i = 0; i < palavras.length; i += 1) {
    for (const nome of NOMES_DE_PLATAFORMA) {
      let ok = true;
      for (let d = 0; d < nome.length && ok; d += 1) {
        const p = palavras[i + d];
        ok = !!p && norm(p) === nome[d] && (d === 0 || p.coladaNaAnterior);
      }
      if (ok) for (let d = 0; d < nome.length; d += 1) marcadas.add(palavras[i + d]);
    }
  }
  return marcadas;
}

function outrosMarketplacesCitados(normalizado, ficha) {
  return OUTROS_MARKETPLACES.filter((n) => contemFrase(normalizado, n.replace(/\./g, "\\.")) &&
    !seo.extractTokens(n).every((t) => ficha.nomesAutorizados.has(t.key)));
}

// F8.2 — termo técnico/norma, nunca marca (só quando tem origem em alguma
// fonte; inventado continua NOME_NAO_COMPROVADO sem origem = HARD):
//   norma/código — sigla + número: "NR-12", "NBR 14136", "ISO 9001", "IP67";
//   qualificador de substantivo de TIPO — "tecido Dry Fit", "Tecido: Dry
//     Fit", "Função: Lockout/Tagout", "padrão Lockout";
//   glosa entre parênteses logo depois de palavra comum — "etiquetagem
//     (Lockout/Tagout)";
//   continuação colada de um termo técnico — "Dry Fit Sport".
// Posição explícita de marca ("da marca X", "da X") não entra aqui: a regra
// de marca segue igual.
const SUBSTANTIVOS_DE_TIPO = new Set(["tecido", "tecnologia", "padrao", "sistema", "norma", "funcao", "procedimento",
  "tratamento", "acabamento", "fibra", "metodo", "protocolo", "modo", "tipo"].map((w) => seo.extractTokens(w)[0].key));
function termoTecnico(p) {
  const w = p.palavra;
  if (/^\p{Lu}{2,5}-?\d/u.test(w)) return true;
  if (/^\p{Lu}{2,5}$/u.test(w) && p.proxima && /^\d/.test(p.proxima.palavra)) return true;
  const chaveDe = (q) => (q && q.chaves.length === 1 ? q.chaves[0].key : null);
  if (p.anterior && (SUBSTANTIVOS_DE_TIPO.has(chaveDe(p.anterior)) || p.anterior.tecnico)) return true;
  if (p.sinalAntes === ":" && SUBSTANTIVOS_DE_TIPO.has(chaveDe(p.antesDoSinal))) return true;
  if (p.sinalAntes === "(" && p.antesDoSinal && /^\p{Ll}/u.test(p.antesDoSinal.palavra)) return true;
  return false;
}

function analisarNomes(textoDesc, ficha) {
  const conflitantes = [];
  const naoComprovados = [];
  const chave = (p) => (p && p.chaves.length === 1 ? p.chaves[0].key : null);
  const autorizadaForte = (p) => p.chaves.every((c) => ficha.nomesAutorizados.has(c.key) || PALAVRAS_DE_SECAO.has(c.key));
  const naFraca = (p) => p.chaves.every((c) => ficha.vocabularioFraco.has(c.key) || ficha.nomesAutorizados.has(c.key) || PALAVRAS_DE_SECAO.has(c.key));
  const comum = (p) => p.chaves.every((c) => ficha.vocabularioComum.has(c.key) || ficha.nomesAutorizados.has(c.key) || PALAVRAS_DE_SECAO.has(c.key));

  const palavras = palavrasDaDescricao(textoDesc);
  const doTitulo = nomesDoTitulo(palavras, ficha);
  const dePlataforma = palavrasDePlataforma(palavras);
  for (const p of palavras) {
    const w = p.palavra;
    if (!/^\p{L}/u.test(w) || !p.chaves.length || p.chaves.every((c) => c.stop)) continue;
    if (doTitulo.has(p)) continue;
    if (dePlataforma.has(p)) continue; // F7C.2 — plataforma não é marca (outros marketplaces: CONTATO_EXTERNO)
    // F7C — palavra gramatical/neutra nunca é nome ("Possui modelo pendurável":
    // "Possui" antes de "modelo" parecia posição de marca)
    if (p.chaves.every((c) => CHAVES_FUNCIONAIS.has(c.key) || CHAVES_NEUTRAS.has(c.key))) continue;
    const maiuscula = /^\p{Lu}/u.test(w);
    const caixaAlta = w.length >= 2 && w === w.toUpperCase() && w !== w.toLowerCase();
    const depoisDeMarca = chave(p.anterior) === "marca" || chave(p.anterior) === "marcas";
    const marcaExplicita = depoisDeMarca || ((maiuscula || caixaAlta) && ANTES_DA_MARCA.has(chave(p.anterior)));
    const antesDeVerbo = (maiuscula || caixaAlta) && DEPOIS_DA_MARCA.has(chave(p.proxima)) && !DEPOIS_DA_MARCA.has(chave(p));
    const posicaoDeMarca = marcaExplicita || antesDeVerbo;
    const estrangeira = pareceEstrangeira(w);
    const candidata = posicaoDeMarca || (maiuscula && !p.inicio) || caixaAlta || (maiuscula && p.inicio && estrangeira);
    if (!candidata || autorizadaForte(p)) continue;
    // F8.2 — termo técnico ou norma COM origem numa fonte não é marca
    if (naFraca(p) && termoTecnico(p)) { p.tecnico = true; continue; }
    // F14 — coincidência de FORMA com marca (maiúscula, grafia estrangeira)
    // não basta fora de posição de marca: termo que é descritor comprovado
    // do produto ("* Blackout em tecido" com IS_BLACK_OUT=Sim, ou palavra que
    // as fontes usam em minúscula) não é marca. "da marca X", "X oferece"
    // continuam na regra de marca.
    if (!posicaoDeMarca) {
      const compacto = semAcento(w).replace(/[^a-z0-9]/g, "");
      if (ficha.descritoresDeAtributo && ficha.descritoresDeAtributo.has(compacto)) continue;
      if (!caixaAlta && comum(p)) continue;
    }

    // Contexto fraco: sem BRAND, autoriza o que está no título/descrição atual.
    // Com BRAND, nunca autoriza marca explícita, caixa alta ou grafia
    // estrangeira; antes de verbo ("Tênis ideal"), só palavra que o contexto
    // usa em minúscula (palavra comum, não nome).
    let fracaVale;
    if (!ficha.marca) fracaVale = naFraca(p);
    else if (marcaExplicita || estrangeira || caixaAlta) fracaVale = false;
    else if (antesDeVerbo) fracaVale = comum(p);
    else fracaVale = naFraca(p);
    if (fracaVale) continue;
    if (ficha.marca && (posicaoDeMarca || (p.inicio && estrangeira))) conflitantes.push(w);
    else naoComprovados.push(w);
  }
  const unicos = (xs) => Array.from(new Set(xs));
  return { conflitantes: unicos(conflitantes), naoComprovados: unicos(naoComprovados).filter((w) => !conflitantes.includes(w)) };
}

// -----------------------------------------------------------------------------
// Grounding lexical (F7A.2) — conservador, sem semântica. Cada palavra de
// conteúdo da descrição precisa ter ORIGEM: estar no vocabulário autorizado da
// ficha (mesma chave morfológica do seoText: plural/gênero, nada de sinônimo)
// ou numa das duas listas abaixo. O que sobra é TERMO_NAO_COMPROVADO.
// "manteiga de karité" sem karité nos dados → manteiga, karite.
//
// Falso negativo (descartar uma frase verdadeira com palavra nova) é aceito;
// aceitar característica inventada não é. Por isso as listas são fechadas e
// NUNCA levam palavra que cria característica ou benefício (premium,
// confortável, resistente, durável, elegante, moderno, profissional,
// impermeável, antiderrapante…) — essas só passam quando os dados as têm.
// -----------------------------------------------------------------------------
// Classe fechada: artigos, pronomes, preposições, conjunções, advérbios de
// ligação, numerais por extenso (o valor é do NUMERO_NAO_COMPROVADO) e
// verbos de ligação/auxiliares. Não descrevem o produto.
const PALAVRAS_FUNCIONAIS = [
  "um", "uma", "uns", "umas", "este", "esta", "estes", "estas", "esse", "essa", "esses", "essas",
  "isso", "isto", "aquele", "aquela", "aqueles", "aquelas", "aquilo", "seu", "sua", "seus", "suas",
  "dele", "dela", "deles", "delas", "cada", "todo", "toda", "todos", "todas", "outro", "outra",
  "outros", "outras", "mesmo", "mesma", "qualquer", "ambos", "ambas", "algum", "alguma", "alguns",
  "algumas", "nenhum", "nenhuma", "tal", "tais", "muito", "muita", "muitos", "muitas",
  "ele", "ela", "eles", "elas", "se", "lhe", "voce", "que", "qual", "quais", "quem", "onde", "quando",
  "com", "sem", "sob", "sobre", "entre", "ate", "desde", "contra", "conforme", "pelo", "pela", "pelos",
  "pelas", "num", "numa", "neste", "nesta", "nesse", "nessa", "deste", "desta", "desse", "dessa",
  "ou", "mas", "porem", "tambem", "nem", "pois", "porque", "como", "enquanto", "ja", "assim", "entao",
  "alem", "disso", "ainda", "portanto", "caso", "quanto", "tanto", "inclusive", "apenas", "somente",
  "so", "nao", "sim", "mais", "menos", "bem", "sempre", "x",
  "dois", "duas", "tres", "quatro", "cinco", "seis", "sete", "oito", "nove", "dez", "onze", "doze",
  "ser", "sao", "sera", "serao", "seja", "sejam", "foi", "foram", "estar", "estao", "fica", "ficam",
  "ficar", "ter", "tem", "pode", "podem", "poder", "deve", "devem", "vem", "ha",
];
// Vocabulário neutro de descrição: estrutura a frase sem afirmar nada sobre
// o produto ("Este produto possui…", "É indicado para…", "A embalagem
// acompanha…"). O que vem depois continua sendo verificado.
const VOCABULARIO_NEUTRO = [
  "produto", "item", "unidade", "peca", "embalagem", "conteudo", "caracteristica", "detalhe",
  "informacao", "observacao", "importante", "uso", "usar", "usado", "usada", "utilizar", "utiliza",
  "utilizado", "utilizada", "utilizacao", "possui", "possuem", "contem", "conta", "contam",
  "apresenta", "apresentam", "traz", "trazem", "oferece", "oferecem", "permite", "permitem",
  "acompanha", "acompanham", "inclui", "incluem", "feito", "feita", "fabricado", "fabricada",
  "desenvolvido", "desenvolvida", "pensado", "pensada", "indicado", "indicada", "indicacao", "ideal",
  "aplicacao", "modo", "marca", "modelo", "linha",
  // F7A.6 — rótulo/estado neutros: "Medidas: …", "Dimensões: …", "Disponível em 127 ou 220 V".
  "medida", "dimensao", "disponivel",
  // F7A.7 — títulos das seções do formato ("Especificações:", "Informações adicionais:").
  "especificacao", "adicional",
  // F7A.10 — títulos "DESTAQUES DO PRODUTO" e "BENEFÍCIOS".
  "destaque", "beneficio",
];
const chavesDe = (lista) => new Set(lista.map((w) => seo.reduceMorphology(w)));
const CHAVES_FUNCIONAIS = chavesDe(PALAVRAS_FUNCIONAIS);
const CHAVES_NEUTRAS = chavesDe(VOCABULARIO_NEUTRO);

// Morfologia conservadora (F7A.4), só no grounding — o seoText é do Title
// Engine e fica intacto. Uma palavra nova vale se uma FORMA-BASE dela já
// estiver autorizada; nunca o contrário (base nova não é liberada por
// derivada), e nada de prefixo/aproximação.
//   1. gênero -o ↔ -a: "reto" ← "Reta", "dourada" ← "Dourado", "adulta" ←
//      "Adultos" — só contra VALOR de atributo/rótulo de booleano Sim
//      (vocabularioDeValores), e nunca nos pares em que -o/-a muda o sentido.
//   2. particípio/gerúndio → verbo, nome ou adjetivo da mesma raiz:
//      "vendido" ← "venda", "pendurada" ← "pendurável", "incluído" ←
//      "inclui", "pesando" ← "peso", "composto" ← "composição".
const PARES_DE_SENTIDO_DISTINTO = new Set([
  "bolso", "bolsa", "porto", "porta", "cesto", "cesta", "tampo", "tampa", "copo", "copa", "barro", "barra",
  "pasto", "pasta", "fruto", "fruta", "menino", "menina", "garoto", "garota", "filho", "filha", "caixo", "caixa",
]);
const DERIVACOES = [
  ["ando", ["ar", "o", "a", "e"]],
  ["endo", ["er", "o", "a", "e"]],
  ["indo", ["ir", "i"]],
  ["ado", ["ar", "o", "a", "e", "avel", "acao"]],
  ["ada", ["ar", "o", "a", "e", "avel", "acao"]],
  ["ido", ["er", "ir", "o", "a", "e", "i", "ivel", "icao"]],
  ["ida", ["er", "ir", "o", "a", "e", "i", "ivel", "icao"]],
  ["sto", ["sicao"]],
  ["sta", ["sicao"]],
];

function autorizadaPorMorfologia(k, ficha) {
  if (!/^[a-z]{4,}$/.test(k)) return false;
  if (!PARES_DE_SENTIDO_DISTINTO.has(k) && /[ao]$/.test(k)) {
    const outro = k.slice(0, -1) + (k.endsWith("a") ? "o" : "a");
    if (ficha.vocabularioDeValores.has(outro)) return true;
  }
  for (const [suf, bases] of DERIVACOES) {
    if (!k.endsWith(suf) || k.length - suf.length < 3) continue;
    const raiz = k.slice(0, -suf.length);
    if (bases.some((b) => ficha.vocabularioAutorizado.has(raiz + b))) return true;
  }
  return false;
}

// Chaves sem origem autorizada, na ordem do texto. Número puro é do
// NUMERO_NAO_COMPROVADO; `ignorar` = palavras já apontadas como nome/marca
// (um problema, um código).
function termosNaoComprovados(textoDesc, ficha, ignorar = new Set()) {
  const out = [];
  for (const t of seo.extractTokens(textoDesc)) {
    const k = t.key;
    if (t.stopword || !k || /^[0-9.]+$/.test(k) || out.includes(k)) continue;
    if (ficha.vocabularioAutorizado.has(k) || CHAVES_FUNCIONAIS.has(k) || CHAVES_NEUTRAS.has(k) || CHAVES_SUBJETIVAS.has(k)) continue;
    if (autorizadaPorMorfologia(k, ficha)) continue;
    if (ignorar.has(k)) continue;
    out.push(k);
  }
  return out;
}

// Afirmação de atributo proibido. Negada logo antes ("não é impermeável",
// "sem bolsos") é a informação correta e passa.
// F7A.6 — negação em LISTA: "Não possui portas, gavetas, prateleiras ou
// rodas" nega todos os itens. Depois do gatilho ("não [verbo de posse]" ou
// "sem"), cada item separado por vírgula/e/ou/nem conta como negado enquanto
// for curto (até 3 palavras) e não abrir outra oração ("é", "com", "mas",
// verbo de posse…) — "sem bolsos e com zíper" não nega o zíper; "não desbota
// e é impermeável" não nega o impermeável. Itens negados saem do texto antes
// da busca por afirmação proibida; o resto segue a regra antiga.
const RE_GATILHO_NEGACAO = /(^|[^\p{L}])(não|nao|sem)(\s+(possui|possuem|tem|têm|acompanha|acompanham|inclui|incluem|traz|trazem|apresenta|apresentam|vem com|vêm com|conta com|contam com))?\s+/u;
const ABRE_ORACAO = new Set(["é", "são", "com", "mas", "porém", "porem", "tem", "têm", "possui", "possuem", "inclui",
  "incluem", "acompanha", "acompanham", "traz", "trazem", "conta", "contam", "apresenta", "apresentam", "vem", "vêm", "está", "estão"]);

function semItensNegados(textoDesc) {
  return String(textoDesc).split(/(?<=[.!?;:\n])/).map((frase) => {
    const s = frase.toLowerCase();
    const g = RE_GATILHO_NEGACAO.exec(s);
    if (!g) return frase;
    const inicio = g.index + g[0].length;
    const fim = s.search(/[.!?;:\n]|$/u);
    const itens = s.slice(inicio, fim).split(/\s*,\s*|\s+(?:e|ou|nem)\s+/u);
    let consumidos = 0;
    let n = 0;
    for (const item of itens) {
      const palavras = item.trim().split(/\s+/).filter(Boolean);
      if (!palavras.length || palavras.length > 3 || ABRE_ORACAO.has(palavras[0])) break;
      n += 1;
    }
    if (n < 2) return frase; // item único: a regra antiga (3 tokens antes) já cobre
    // posição do fim do n-ésimo item no texto original
    let resto = s.slice(inicio);
    for (let i = 0; i < n; i += 1) {
      const m = new RegExp("^\\s*(?:,|e|ou|nem)?\\s*" + itens[i].trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).exec(resto);
      if (!m) return frase;
      consumidos += m[0].length;
      resto = resto.slice(m[0].length);
    }
    return frase.slice(0, inicio) + " " + frase.slice(inicio + consumidos);
  }).join("");
}

// F7A.8 — linha "Rótulo: 0" / "Rótulo: Não" / "Rótulo: Nenhum" nega o rótulo.
const RE_LINHA_NEGADA = /^[ \t]*(?:[-•*–][ \t]*)?[^:\n]{2,60}:[ \t]*(?:0+|n[ãa]o|nenhum|nenhuma)[ \t]*\.?[ \t]*$/gimu;

function afirmacoesProibidas(textoDesc, ficha) {
  if (!ficha.proibidos.length) return [];
  const tokens = seo.extractTokens(semItensNegados(String(textoDesc).replace(RE_LINHA_NEGADA, "")));
  const conteudo = tokens.map((t, i) => ({ t, i })).filter((x) => !x.t.stopword);
  const achados = [];
  for (const p of ficha.proibidos) {
    for (let s = 0; s < p.chaves.length; s += 1) {
      const seq = p.chaves[s];
      for (let j = 0; j + seq.length <= conteudo.length; j += 1) {
        if (!seq.every((k, d) => conteudo[j + d].t.key === k)) continue;
        const antes = tokens.slice(Math.max(0, conteudo[j].i - 3), conteudo[j].i).map((t) => t.key);
        if (antes.includes("nao") || antes.includes("sem")) continue;
        achados.push({ id: p.id, termo: p.exibir[s] });
      }
    }
  }
  return achados;
}

// F7A.7 — formato em seções + itens. "Especificações:" com itens
// "Rótulo: valor" passa a ser o formato pedido; cópia da ficha agora é só o
// DESPEJO: 4+ linhas "Rótulo: valor" sem nenhuma frase de introdução.
// Seção vazia = título de seção ("Algo:" sozinho na linha) sem item "-" logo
// abaixo.
// F7C — seções do padrão operacional (o mesmo do otimizador legado). Seções
// de FATO passam pela validação completa; seções de COPY (uso, benefício,
// experiência de compra) têm liberdade de linguagem, mas não de fato.
// DESCRIÇÃO PRINCIPAL é texto comercial: linguagem livre como a copy, com as
// mesmas travas de fato objetivo (material, cor, componente, número, marca,
// conflito, atributo negado, claim técnico, logística).
const SECOES_CONHECIDAS = new Map([
  ["descricao principal", "copy"], ["destaques do produto", "fato"], ["especificacoes", "fato"],
  ["dimensoes", "fato"], ["conteudo da embalagem", "fato"], ["informacoes adicionais", "fato"], ["observacoes", "fato"],
  ["como usar", "copy"], ["beneficios", "copy"], ["experiencia de compra", "copy"],
]);
const chaveDeSecao = (linha) => semAcento(linha).replace(/:\s*$/, "").replace(/\s+/g, " ").trim();
// Texto no formato operacional F7C: começa pela seção DESCRIÇÃO PRINCIPAL.
const formatoOperacional = (descricao) => chaveDeSecao(String(descricao).trim().split("\n")[0] || "") === "descricao principal";
const ehSecaoConhecida = (linha) => SECOES_CONHECIDAS.has(chaveDeSecao(linha));

// Linhas com a seção a que pertencem: [{ i, linha, secao (chave ou null), tipo: "fato"|"copy", titulo:boolean }]
function linhasPorSecao(descricao) {
  let secao = null;
  return String(descricao).split("\n").map((linha, i) => {
    const t = linha.trim();
    const titulo = !!t && ((i > 0 && ehTituloDeSecao(t)) || ehSecaoConhecida(t));
    if (titulo) secao = chaveDeSecao(t);
    return { i, linha, secao, tipo: SECOES_CONHECIDAS.get(secao) || "fato", titulo };
  });
}

// F7A.10 — título de seção: "Especificações:" (F7A.7) ou linha curta toda em
// maiúsculas, sem pontuação final ("DESTAQUES DO PRODUTO").
function ehTituloDeSecao(linha) {
  const l = String(linha).trim();
  if (!l || /^[-•*–]/.test(l)) return false;
  if (/^[^:]{2,40}:$/.test(l)) return true;
  return l.length <= 40 && /\p{L}{2}/u.test(l) && l === l.toUpperCase() && l !== l.toLowerCase() && !/[.!?:,;]$/.test(l);
}

function estruturaDaDescricao(textoDesc, ficha) {
  const rotulos = new Set(ficha.fatos.map((f) => semAcento(f.label).trim()));
  const linhas = String(textoDesc).split(/\n/).map((l) => l.trim());
  let n = 0;
  let introducao = false;
  const vazias = [];
  linhas.forEach((linha, i) => {
    if (!linha) return;
    const item = /^[-•*–]\s*/.test(linha);
    const l = semAcento(linha).replace(/^\s*[-•*–]\s*/, "").trim();
    const m = /^([^:]{2,40}):\s*\S/.exec(l);
    if (m && rotulos.has(m[1].trim())) n += 1;
    const secao = (i > 0 && ehTituloDeSecao(linha)) || ehSecaoConhecida(linha);
    if (secao) {
      // F7C — vazia = sem NENHUM conteúdo até o próximo título (seção de
      // texto corrido, como DESCRIÇÃO PRINCIPAL, não precisa de itens)
      const prox = linhas.slice(i + 1).find((x) => x);
      if (!prox || ehTituloDeSecao(prox) || ehSecaoConhecida(prox)) vazias.push(linha.replace(/:$/, ""));
      return;
    }
    if (!item && !m && /[.!?]$/.test(linha)) introducao = true;
  });
  return { n, introducao, vazias };
}

// F7A.8 — partes do formato: 1ª linha (nome), introdução (frases antes da
// primeira seção) e itens ("- …").
function partesDaDescricao(textoDesc) {
  const linhas = String(textoDesc).split(/\n/).map((l) => l.trim()).filter(Boolean);
  const ehItem = (l) => /^[-•*–]\s*\S/.test(l);
  const ehSecao = (l) => ehTituloDeSecao(l) || ehSecaoConhecida(l);
  // a 1ª linha pode ser o título em maiúsculas: só "Algo:" ou título de
  // seção conhecido ("DESCRIÇÃO PRINCIPAL", F7C) não é nome
  const nome = linhas.length && !ehItem(linhas[0]) && !/:$/.test(linhas[0]) && !/[.!?]$/.test(linhas[0]) &&
    !ehSecaoConhecida(linhas[0]) ? linhas[0] : null;
  const introducao = [];
  let i = nome ? 1 : 0;
  // F7C — no formato operacional a abertura é a seção DESCRIÇÃO PRINCIPAL
  if (linhas[i] && chaveDeSecao(linhas[i]) === "descricao principal") i += 1;
  for (; i < linhas.length && !ehItem(linhas[i]) && !ehSecao(linhas[i]); i += 1) introducao.push(linhas[i]);
  // itens de seções de COPY não são itens de ficha (rótulo/repetição não se aplicam)
  const itens = linhasPorSecao(linhas.join("\n")).filter((x) => x.tipo === "fato" && ehItem(x.linha.trim()))
    .map((x) => x.linha.trim().replace(/^[-•*–]\s*/, ""));
  return { nome, introducao: introducao.join(" "), itens };
}

const RE_VALOR_NEGATIVO = /^(0+|nao|nenhum|nenhuma)\.?$/;
const PALAVRAS_DE_ROTULO_IRRELEVANTE = new Set(["categoria", "embalagem", "vendor", "frete", "envio"].map((w) => seo.reduceMorphology(w)));
// Rótulo neutro de medida: "Medidas: 120 x 60 x 76 cm" (os números seguem a regra de número).
const ROTULOS_DE_MEDIDA = new Set(["medida", "dimensao"].map((w) => seo.reduceMorphology(w)));

// Cada item "Rótulo: valor" precisa ter rótulo REAL: o de um fato com o mesmo
// valor (pode ser encurtado: "Cintura" ← "Cintura do short"), o de um atributo
// negado com valor "Não"/0, um rótulo neutro de medida ou um rótulo escrito
// assim na descrição atual. Rótulo de fato não listável (embalagem,
// plataforma, redundante) ou de categoria/embalagem/envio = item irrelevante;
// o resto é inventado ("Tipo: Cafeteiras", "Voltagem: 127 V").
// Repetição: item "Rótulo: valor" cujo conteúdo inteiro já está na introdução.
function analisarItens(textoDesc, ficha) {
  const { introducao, itens } = partesDaDescricao(textoDesc);
  const inventados = [];
  const irrelevantes = [];
  const repetidos = [];
  const podaveis = []; // itens irrelevantes ou repetidos (texto do item, sem o "- ")
  const chavesIntro = new Set(seo.contentKeys(introducao));
  const rotulosDoContexto = semAcento(ficha.descricaoAtual && ficha.descricaoAtual.texto);
  const numeros = (t) => new Set(extrairNumeros(t).map((n) => n.numero));
  const valorBate = (v, f) => {
    if (valorBooleano(f.value) === true) return valorBooleano(v) === true;
    const kv = seo.contentKeys(v);
    const kf = new Set(seo.contentKeys(f.value));
    if (kv.some((k) => kf.has(k))) return true;
    const nf = numeros(f.value);
    return [...numeros(v)].some((n) => nf.has(n));
  };
  for (const item of itens) {
    const m = /^([^:]{2,40}):\s*(\S.*)$/.exec(item);
    let conteudo;
    if (m) {
      const rotulo = m[1].trim();
      const valor = m[2].trim();
      const kr = seo.contentKeys(rotulo);
      const contido = (f) => kr.length && kr.every((k) => seo.contentKeys(f.label).includes(k));
      const candidatos = ficha.fatos.filter((f) => contido(f) && valorBate(valor, f));
      const negado = RE_VALOR_NEGATIVO.test(semAcento(valor)) && ficha.proibidos.some(contido);
      if (candidatos.some((f) => f.listavel !== false) || negado) {
        // rótulo real
      } else if (candidatos.length || kr.some((k) => PALAVRAS_DE_ROTULO_IRRELEVANTE.has(k))) {
        irrelevantes.push(rotulo);
        podaveis.push(item);
      } else if (!(kr.length && kr.every((k) => ROTULOS_DE_MEDIDA.has(k))) &&
        !new RegExp("(^|[\\n.;•-])\\s*" + semAcento(rotulo).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*:").test(rotulosDoContexto)) {
        inventados.push(rotulo);
      }
      conteudo = valorBooleano(valor) === true
        ? kr.filter((k) => !PALAVRAS_DE_NOME_GENERICAS.has(k))
        : seo.contentKeys(valor);
      // F7A.9 — valor que outro fato também tem ("Material interno: Tecido" ×
      // "Material externo: Tecido Brilhante Nylon"): a introdução só repete o
      // item se citar também o rótulo dele.
      const outroComOValor = ficha.fatos.some((g) => g.listavel !== false && !candidatos.includes(g) &&
        conteudo.length && conteudo.every((k) => seo.contentKeys(g.value).includes(k)));
      if (outroComOValor) conteudo = conteudo.concat(kr.filter((k) => !PALAVRAS_DE_NOME_GENERICAS.has(k)));
    }
    // F7A.10 — só item "Rótulo: valor" conta como repetição: destaque em frase
    // pode retomar o que a abertura comercial apresentou.
    if (m && conteudo.length && chavesIntro.size && conteudo.every((k) => chavesIntro.has(k))) {
      repetidos.push(item);
      // F7C — no formato operacional, ESPECIFICAÇÕES é a lista copiável:
      // repetir o que a DESCRIÇÃO PRINCIPAL disse é esperado (só aviso)
      if (!podaveis.includes(item) && !formatoOperacional(textoDesc)) podaveis.push(item);
    }
  }
  return { inventados, irrelevantes, repetidos, podaveis };
}

// F7A.8 — poda determinística, antes da validação: tira os itens que só
// repetem a introdução ou que são irrelevantes (categoria, embalagem,
// plataforma, fato redundante) e os títulos de seção que ficarem vazios.
// Só REMOVE linhas inteiras — nunca reescreve, nunca acrescenta —, então não
// cria afirmação nova; o texto podado passa por toda a validação. Rótulo
// inventado não é podado: é sinal de invenção e descarta a geração.
// F7A.10 — dentro de uma seção, linha "Rótulo: valor" sem marcador (a IA
// esquece o hífen sob títulos em maiúsculas) ganha "- ". Só o marcador muda;
// o item passa a ser checado como item (rótulo real, repetição, irrelevância).
function normalizarMarcadores(textoDesc) {
  const linhas = String(textoDesc).split("\n");
  let dentroDeSecao = false;
  return linhas.map((l, i) => {
    const t = l.trim();
    if (!t) return l;
    if (i > 0 && ehTituloDeSecao(t)) { dentroDeSecao = true; return l; }
    if (dentroDeSecao && !/^[-•*–]/.test(t) && /^[^:]{2,40}:\s*\S/.test(t) && !/[.!?]$/.test(t)) return "- " + t;
    return l;
  }).join("\n");
}

function podarItens(textoDesc, ficha) {
  const descricao = normalizarMarcadores(normalizarTexto(textoDesc));
  const remover = new Set(analisarItens(descricao, ficha).podaveis);
  if (!remover.size) return { descricao, removidos: [] };
  const removidos = [];
  let linhas = descricao.split("\n").filter((l) => {
    const t = l.trim();
    if (!/^[-•*–]\s*\S/.test(t)) return true;
    const item = t.replace(/^[-•*–]\s*/, "");
    if (!remover.has(item)) return true;
    removidos.push(item);
    return false;
  });
  linhas = linhas.filter((l, i) => {
    const t = l.trim();
    if (!((i > 0 && ehTituloDeSecao(t)) || ehSecaoConhecida(t))) return true;
    // F7C — some só se ficou sem NENHUM conteúdo (texto corrido também conta)
    const prox = linhas.slice(i + 1).find((x) => x.trim());
    return !!prox && !ehTituloDeSecao(prox.trim()) && !ehSecaoConhecida(prox.trim());
  });
  return { descricao: normalizarTexto(linhas.join("\n")), removidos };
}

// F7A.11 — benefício deduzido: verbo que transforma característica em
// vantagem ("rodas facilitam o manejo", "combina com diferentes espaços",
// "proporciona conforto"). Barrado mesmo com origem no título/descrição
// atual; só passa se a palavra vier de um fato ESTRUTURADO ("Com proteção UV").
const RE_BENEFICIO_DEDUZIDO = /(^|[^a-z])((?:facilit|ajud|combin|proporcion|garant|valoriz|realc|favorec|contribu|otimiz|assegur|evit|proteg)[a-z]*|melhor(?:a|am|ar|ando|ado|ada)?(?=[^a-z]|$))/g;

function beneficiosDeduzidos(textoDesc, ficha) {
  const out = [];
  for (const m of semAcento(textoDesc).matchAll(RE_BENEFICIO_DEDUZIDO)) {
    const w = m[2];
    if (w === "melhor") continue; // adjetivo: "o melhor" já é LINGUAGEM_PROIBIDA
    const k = seo.extractTokens(w).map((t) => t.key)[0];
    if (k && ficha.nomesAutorizados.has(k)) continue;
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

// F7A.12 — claim TÉCNICO/objetivo cuja única origem é a descrição atual
// (contexto fraco): "tratamento antioxidante", "aço reforçado", "proteção
// UV", "antiderrapante". O grounding autoriza a palavra, mas o vendedor
// afirmar não é fato. Passa só se um fato estruturado ou o título tiver a
// mesma raiz ("É reforçada: Sim"; "Resistência Para Cafeteira" no título).
const RAIZES_DE_CLAIM_TECNICO = [
  "antioxid", "oxid", "ferrug", "anticorros", "corros", "inoxid", "resist", "protec", "protet", "durab", "durav",
  "reforc", "imperme", "antiderrap", "antialerg", "hipoalerg", "antibacter", "antimicrob", "antiac", "antichama",
  "termic", "isolament", "inquebr", "atoxic", "blindad", "certific", "testad", "aprovad", "silencios", "econom",
  "potent", "ergonom", "anatomic", "ultra", "turbo",
];
const RE_CLAIM_TECNICO = new RegExp("(^|[^a-z])((?:" + RAIZES_DE_CLAIM_TECNICO.join("|") + ")[a-z]*)", "g");

// F8.2 — "resistência" seguida de qualificador de PEÇA (elétrica, de imersão,
// de aquecimento, blindada, tubular, aletada) é o componente que aquece.
const RE_RESISTENCIA_COMPONENTE = /^\s+(?:eletricas?|de imersao|de aquecimento|blindadas?|tubular(?:es)?|aletadas?)(?=[^a-z]|$)/;
function ehResistenciaComponente(s, ini, w) {
  return /^resistencias?$/.test(w) && RE_RESISTENCIA_COMPONENTE.test(s.slice(ini + w.length, ini + w.length + 25));
}

function claimsTecnicosHerdados(textoDesc, ficha) {
  const fortes = Array.from(ficha.nomesAutorizados).concat(Array.from(ficha.vocabularioDoTitulo || []));
  const out = [];
  const s = semAcento(textoDesc);
  for (const m of s.matchAll(RE_CLAIM_TECNICO)) {
    const w = m[2];
    if (ehResistenciaComponente(s, m.index + m[1].length, w)) continue; // F8.2
    const raiz = RAIZES_DE_CLAIM_TECNICO.find((r) => w.startsWith(r));
    if (fortes.some((k) => k.startsWith(raiz))) continue;
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

// F7A.8 — palavras de propaganda cuja ÚNICA origem é a descrição atual.
function propagandaHerdada(textoDesc, ficha) {
  const out = [];
  for (const t of seo.extractTokens(textoDesc)) {
    if (t.stopword || !CHAVES_DE_PROPAGANDA.has(t.key) || out.includes(t.original.toLowerCase())) continue;
    if (ficha.nomesAutorizados.has(t.key) || (ficha.vocabularioDoTitulo && ficha.vocabularioDoTitulo.has(t.key))) continue;
    out.push(t.original.toLowerCase());
  }
  return out;
}

// F7A.12 — arrumação final, só estrutura (nada é reescrito):
//   1. item duplicado sai (mesmo texto, ignorando caixa/acento/pontuação);
//   2. seções na ordem fixa do formato; título desconhecido vai para o fim,
//      na ordem em que veio. Nome e abertura ficam no topo, como vieram.
// F7C — ordem do padrão operacional; as seções antigas ficam dentro do bloco de fatos.
const ORDEM_DAS_SECOES = ["descricao principal", "destaques do produto", "como usar", "especificacoes", "dimensoes",
  "conteudo da embalagem", "informacoes adicionais", "beneficios", "observacoes", "experiencia de compra"];
function arrumarEstrutura(textoDesc) {
  const linhas = normalizarTexto(textoDesc).split("\n");
  const topo = [];
  const secoes = [];
  linhas.forEach((l, i) => {
    if ((i > 0 && ehTituloDeSecao(l)) || ehSecaoConhecida(l)) secoes.push({ titulo: l, linhas: [] });
    else if (secoes.length) secoes[secoes.length - 1].linhas.push(l);
    else topo.push(l);
  });
  const vistos = new Set();
  const duplicados = [];
  const chaveItem = (l) => semAcento(l.replace(/^\s*[-•*–]\s*/, "")).replace(/[^a-z0-9%/]+/g, " ").trim();
  for (const s of secoes) {
    const antes = s.linhas.some((l) => /^\s*[-•*–]\s*\S/.test(l));
    s.linhas = s.linhas.filter((l) => {
      if (!/^\s*[-•*–]\s*\S/.test(l)) return true;
      const k = chaveItem(l);
      if (!vistos.has(k)) { vistos.add(k); return true; }
      duplicados.push(l.trim().replace(/^[-•*–]\s*/, ""));
      return false;
    });
    s.esvaziada = antes && !s.linhas.some((l) => /^\s*[-•*–]\s*\S/.test(l));
  }
  const posicao = (s) => {
    const k = semAcento(s.titulo).replace(/:$/, "").trim();
    const i = ORDEM_DAS_SECOES.indexOf(k);
    return i < 0 ? ORDEM_DAS_SECOES.length : i;
  };
  const ordenadas = secoes.map((s, i) => ({ s, i })).sort((a, b) => posicao(a.s) - posicao(b.s) || a.i - b.i).map((x) => x.s);
  // seção esvaziada SÓ pela retirada de duplicado sai junto; a que já veio
  // vazia fica (e é SECAO_VAZIA na validação)
  const temItem = (s) => s.linhas.some((l) => /^\s*[-•*–]\s*\S/.test(l));
  const corpo = ordenadas.filter((s) => temItem(s) || !s.esvaziada).map((s) => [s.titulo, ...s.linhas.filter((l) => l.trim())].join("\n"));
  const descricao = normalizarTexto([topo.join("\n"), ...corpo].join("\n\n"));
  const reordenou = ordenadas.some((s, i) => s !== secoes[i]);
  return { descricao, duplicados, reordenou };
}

// F7A.11 — a 1ª linha (nome comercial, copiado do título) sai SEM o trecho
// em conflito: "Kit 2 Lixeira … 120 Litros Jsn Preto" com capacidade em
// conflito vira "Kit 2 Lixeira … Jsn Preto". Remove (1) o trecho exato que a
// detecção apontou ("120 litros", "Sem Manga", "regata", "gigabit") e (2)
// palavra com número em conflito ("10/100/1000") ou com chave bloqueada.
// Só tira palavras da 1ª linha; nada é reescrito. Substitui a exceção da
// F7A.8 (1ª linha não disparava conflito): agora a linha é limpa e a
// validação de conflito vale para o texto inteiro.
function limparNomeConflitante(textoDesc, ficha) {
  const descricao = String(textoDesc);
  const conflitos = ficha.conflitos || [];
  const { nome } = partesDaDescricao(descricao);
  if (!nome || !conflitos.length) return { descricao, removidos: [] };
  const removidos = [];
  let limpo = nome;
  for (const c of conflitos) {
    const trecho = semAcento(c.trecho || "").trim();
    if (!trecho) continue;
    for (;;) {
      const s = semAcento(limpo);
      const m = new RegExp("(^|[^a-z0-9])(" + trecho.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+") + ")(?=[^a-z0-9]|$)").exec(s);
      if (!m) break;
      const ini = m.index + m[1].length;
      removidos.push(limpo.slice(ini, ini + m[2].length));
      limpo = limpo.slice(0, ini) + " " + limpo.slice(ini + m[2].length);
    }
  }
  const chaves = new Set(conflitos.flatMap((c) => c.chaves || []));
  const numeros = new Set(conflitos.flatMap((c) => c.numeros || []).map((n) => normalizarNumero(String(n))));
  const palavras = limpo.split(/\s+/).filter(Boolean);
  const ficam = [];
  for (let i = 0; i < palavras.length; i += 1) {
    const w = palavras[i];
    const nums = Array.from(w.matchAll(/(?<![\p{L}\d.,])\d+(?:[.,]\d+)*/gu)).map((x) => normalizarNumero(x[0]));
    const fora = seo.contentKeys(w).some((k) => chaves.has(k)) || nums.some((n) => n != null && numeros.has(n));
    if (!fora) { ficam.push(w); continue; }
    removidos.push(w);
    // número em conflito leva junto a unidade solta logo depois ("120 Litros")
    if (nums.length && palavras[i + 1] && UNIDADES.has(semAcento(palavras[i + 1]).replace(/[^a-z]/g, ""))) removidos.push(palavras[++i]);
  }
  if (!removidos.length) return { descricao, removidos };
  // F7A.12 — sem tipo de produto compreensível ("Kit 2 Infantil Dinossauro…"
  // depois de tirar "Regata"), o nome mutilado não é usado: vira um nome
  // neutro feito só de fatos não conflitantes.
  const novoNome = temTipoDeProduto(ficam.join(" "), ficha) ? ficam.join(" ") : nomeNeutro(ficha);
  return { descricao: descricao.replace(nome, novoNome), removidos, ...(novoNome === ficam.join(" ") ? {} : { nomeNeutro: novoNome }) };
}

// Tipo do produto no título = 1ª palavra de conteúdo que não é kit/número
// ("Kit 2 Lixeira …" → lixeira). O nome tem tipo se ainda tiver essa palavra
// ou alguma palavra da categoria.
const PALAVRAS_DE_KIT = new Set(["kit", "conjunto", "par", "combo", "jogo", "pack", "lote"]);
function temTipoDeProduto(nome, ficha) {
  const kn = new Set(seo.contentKeys(nome));
  const tipo = seo.contentKeys(ficha.tituloAtual || "").find((k) => !/^\d/.test(k) && !PALAVRAS_DE_KIT.has(k));
  if (tipo && kn.has(tipo)) return true;
  return seo.contentKeys(ficha.categoria || "").some((k) => kn.has(k));
}

// Nome neutro: "Kit N" (se o título começa assim) + "Peça" (produto com
// tamanho/gênero) ou "Produto" + marca + modelo + gênero + cor + tamanho.
// Só fatos que sobraram na ficha (os conflitantes já saíram) e palavras do
// vocabulário neutro.
function nomeNeutro(ficha) {
  const valor = (id) => { const f = ficha.fatos.find((x) => x.id === id && x.listavel !== false); return f ? f.value : null; };
  const chavesEmConflito = new Set((ficha.conflitos || []).flatMap((c) => c.chaves || []));
  const kit = /^\s*(kit\s+\d+)\b/i.exec(ficha.tituloAtual || "");
  const partes = [];
  if (kit) partes.push("Kit " + kit[1].replace(/\D+/g, ""));
  partes.push(valor("attr:SIZE") || valor("attr:GENDER") ? "Peça" : "Produto");
  for (const v of [ficha.marca, ficha.modelo, valor("attr:GENDER"), valor("attr:COLOR")]) {
    if (v && !seo.contentKeys(v).some((k) => chavesEmConflito.has(k))) partes.push(v);
  }
  if (valor("attr:SIZE")) partes.push("Tamanho " + valor("attr:SIZE"));
  return partes.join(" ");
}

// -----------------------------------------------------------------------------
// validarDescricao — pura e determinística (mesma entrada, mesma saída; não
// altera a ficha).
//   { valida:true,  descricao, chars, fatosUsados:[id] }
//   { valida:false, descricao, problemas:[{ codigo, detalhe, termos? }] }
// Códigos: VAZIA · EXCEDE_LIMITE · FORMATACAO_INVALIDA · URL · EMAIL ·
//   TELEFONE · CONTATO_EXTERNO · LINGUAGEM_PROIBIDA · VOZ_DA_LOJA ·
//   MARCA_CONFLITANTE · NOME_NAO_COMPROVADO · TERMO_NAO_COMPROVADO · ATRIBUTO_PROIBIDO ·
//   CONFLITO_DE_FONTES · PROPAGANDA_HERDADA · CLAIM_TECNICO_HERDADO · CLAIM_NAO_SUSTENTADO · FATO_INVENTADO ·
//   CLAIM_COMERCIAL_SEM_FONTE · BENEFICIO_DEDUZIDO · ROTULO_INVENTADO · ITEM_IRRELEVANTE · REPETE_INTRODUCAO ·
//   NUMERO_NAO_COMPROVADO · COPIA_FICHA_TECNICA · SECAO_VAZIA · FATOS_USADOS_INVALIDOS ·
//   FATO_DESCONHECIDO
// -----------------------------------------------------------------------------
function normalizarTexto(bruto) {
  return String(bruto == null ? "" : bruto)
    .replace(/\r\n?/g, "\n")
    .split("\n").map((l) => l.replace(/[ \t]+$/g, "")).join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// -----------------------------------------------------------------------------
// normalizarIdFato — sintaxe, não semântica. O prompt mostra cada fato como
// "[attr:COLOR] Cor: Azul"; se a IA devolver o id com esses colchetes de
// exibição, tira UMA camada externa que envolva a string inteira. Nada de
// fuzzy, case-insensitive ou prefixo: o resultado ainda precisa existir
// EXATAMENTE em ficha.idsConhecidos.
//   "brand" → "brand" · "[brand]" → "brand" · " brand " → "brand"
//   "[[brand]]", "[brand] texto", "brand extra" → inalterados (desconhecidos)
// -----------------------------------------------------------------------------
function normalizarIdFato(valor) {
  const t = String(valor).trim();
  const m = /^\[([^[\]]+)\]$/.exec(t);
  return m ? m[1] : t;
}

function validarDescricao(descricaoBruta, fatosUsados, ficha) {
  const descricao = normalizarTexto(descricaoBruta);
  const problemas = [];
  const add = (codigo, detalhe, termos) => problemas.push(termos && termos.length ? { codigo, detalhe, termos } : { codigo, detalhe });

  if (!descricao) {
    return { valida: false, descricao, problemas: [{ codigo: "VAZIA", detalhe: "A IA devolveu uma descrição vazia." }] };
  }
  if (descricao.length > ficha.limite) {
    add("EXCEDE_LIMITE", "A descrição tem " + descricao.length + " caracteres; o limite é " + ficha.limite + ".");
  }
  if (RE_HTML.test(descricao) || RE_MARKDOWN.test(descricao) || RE_EMOJI.test(descricao)) {
    add("FORMATACAO_INVALIDA", "A descrição do Mercado Livre é texto simples: sem HTML, markdown ou emoji.");
  }

  const normalizado = semAcento(descricao);
  // F7C — FATO × COPY. Seções de fato (e o topo) passam por tudo; seções de
  // copy (COMO USAR, BENEFÍCIOS, EXPERIÊNCIA DE COMPRA) têm linguagem livre,
  // mas número, marca, conflito, atributo negado, claim técnico, logística e
  // fato objetivo (material/cor) continuam valendo para o texto INTEIRO.
  // Títulos de seção conhecidos não são conteúdo.
  const porSecao = linhasPorSecao(descricao);
  const juntar = (filtro) => porSecao.filter(filtro).map((x) => x.linha).join("\n");
  const textoFato = juntar((x) => x.tipo === "fato" && !x.titulo);
  const textoCopy = juntar((x) => x.tipo === "copy" && !x.titulo);
  const semTitulos = juntar((x) => !(x.titulo && ehSecaoConhecida(x.linha.trim())));
  if (RE_URL.test(descricao)) add("URL", "A descrição não pode ter links ou endereços de site.");
  if (RE_EMAIL.test(descricao)) add("EMAIL", "A descrição não pode ter e-mail.");
  if (RE_TELEFONE.test(descricao)) add("TELEFONE", "A descrição não pode ter telefone.");
  const contato = CONTATO_EXTERNO.filter((f) => contemFrase(normalizado, f)).concat(outrosMarketplacesCitados(normalizado, ficha));
  if (contato.length || RE_HANDLE.test(descricao)) {
    add("CONTATO_EXTERNO", "A descrição não pode direcionar para contato fora do Mercado Livre.", contato);
  }

  const valoresDosFatos = semAcento(ficha.fatos.map((f) => f.value).join(" | "));
  // F7A.6 — o RÓTULO exato de um fato estruturado não é claim promocional:
  // "temporada de lançamento Primavera/Verão" vem de RELEASE_SEASON. Só a
  // frase inteira do rótulo sai da checagem; "lançamento" solto continua
  // proibido.
  let semRotulos = semAcento(textoFato);
  for (const f of ficha.fatos) {
    const rotulo = semAcento(f.label).trim();
    if (!rotulo || !LINGUAGEM_PROIBIDA.some((x) => contemFrase(rotulo, x))) continue;
    const re = new RegExp("(^|[^a-z0-9])" + rotulo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+") + "(?=[^a-z0-9]|$)", "g");
    semRotulos = semRotulos.replace(re, "$1 ");
  }
  const copyNormalizada = semAcento(textoCopy);
  const proibida = LINGUAGEM_PROIBIDA.filter((f) => !contemFrase(valoresDosFatos, f) &&
    (contemFrase(semRotulos, f) || (!COPY_LIBERADA.has(f) && contemFrase(copyNormalizada, f))));
  // F9.1 — "você recebe…", "receber tudo o que precisa": promessa de entrega
  proibida.push(...recebimentosSemFonte(normalizado, ficha).filter((t) => !proibida.includes(t)));
  const exclamacoes = (descricao.match(/!/g) || []).length;
  if (exclamacoes > 1) proibida.push("excesso de exclamações");
  if (proibida.length) {
    add("LINGUAGEM_PROIBIDA", "Linguagem promocional, de logística/garantia ou de chatbot.", proibida);
  }
  const voz = VOZ_DA_LOJA.exec(descricao);
  // F7B — texto de loja na 3ª pessoa ("Empresa estabelecida desde 1985…,
  // com sede em…") também é voz da loja: não fala do produto.
  const loja = RE_TEXTO_DE_LOJA.exec(semAcento(descricao));
  if (voz || loja) {
    add("VOZ_DA_LOJA", "A descrição fala do produto, não da loja (sem \"nós\"/\"nossa\"/\"recomendamos\"/dados da empresa).",
      [voz ? voz[2] : loja[2]]);
  }
  // na copy, benefício subjetivo ("praticidade", "conforto", "elegância") é
  // livre; "qualidade" sem fato continua sendo claim
  const herdada = Array.from(new Set(propagandaHerdada(textoFato, ficha)
    .concat(propagandaHerdada(textoCopy, ficha).filter((w) => COPY_PROPAGANDA_VIGIADA.has(seo.extractTokens(w)[0].key)))));
  if (herdada.length) {
    add("PROPAGANDA_HERDADA", "Claim de qualidade ou benefício copiado da descrição atual do vendedor.", herdada);
  }
  const tecnicos = claimsTecnicosHerdados(semTitulos, ficha);
  if (tecnicos.length) {
    add("CLAIM_TECNICO_HERDADO", "Afirmação técnica que só a descrição atual do vendedor faz, sem fato estruturado ou título que a sustente.", tecnicos);
  }
  const deduzidos = beneficiosDeduzidos(textoFato, ficha);
  if (deduzidos.length) {
    add("BENEFICIO_DEDUZIDO", "A descrição transforma característica em vantagem (facilita, ajuda, combina, proporciona…).", deduzidos);
  }
  // F7C — na copy: claim objetivo sem fato (originalidade, efeito, compatibilidade)
  // e fato objetivo (material, cor) que não está nos dados
  const claimsCopy = claimsDaCopy(textoCopy, ficha);
  if (claimsCopy.length) {
    add("CLAIM_NAO_SUSTENTADO", "Texto comercial afirma originalidade, efeito ou compatibilidade sem fato que sustente.", claimsCopy);
  }
  // COMO USAR fica fora: lá material/cor/objeto é CONTEXTO de uso ("combine
  // com calça jeans", "pendure em portas"), não característica do produto
  const comerciais = claimsComerciaisSemFonte(semTitulos, ficha);
  if (comerciais.length) {
    add("CLAIM_COMERCIAL_SEM_FONTE", "Preço/custo ou facilidade técnica afirmados sem fonte (fatos, título ou descrição atual).", comerciais);
  }
  // F8.1 — desempenho/propriedade objetiva sem fato estruturado ou título
  // Isola só "firme" na instrução completa autorizada, sem quebrar claims
  // entre linhas nem alterar o texto retornado ou os demais caracteres.
  const textoObjetivos = porSecao.filter((x) => !(x.titulo && ehSecaoConhecida(x.linha.trim())))
    .map((x) => {
      if (x.secao !== "como usar" ||
        !/^\s*[-•*–]?\s*posicione (?:o produto|a peca|o item) de forma firme[.!?]?\s*$/.test(semAcento(x.linha))) return x.linha;
      // Sem pontuação, blank line não encerra uma instrução continuada.
      const proxima = porSecao.slice(x.i + 1).find((p) => p.linha.trim());
      const completa = /[.!?]\s*$/.test(x.linha) || !proxima ||
        ehSecaoConhecida(proxima.linha.trim()) || /^\s*[-•*–]\s+\S/.test(proxima.linha);
      return completa ? x.linha.replace(/\bfirme\b/i, "     ") : x.linha;
    }).join("\n");
  const objetivos = claimsObjetivosSemFonte(textoObjetivos, ficha);
  if (objetivos.length) {
    add("CLAIM_OBJETIVO_SEM_FONTE", "Afirmação objetiva de desempenho ou propriedade (consumo, resistência, estabilidade, " +
      "duração…) sem fato estruturado ou título que a sustente.", objetivos);
  }
  // F8.1 — kit de N descrito como se fosse uma peça só
  if (ficha.kit && !kitCitado(semTitulos, ficha.kit.n)) {
    add("KIT_OMITIDO", "O produto é um kit com " + ficha.kit.n + " unidades e a descrição não diz a quantidade.",
      [String(ficha.kit.n)]);
  }
  const inventadosCopy = fatosObjetivosDaCopy(juntar((x) => x.tipo === "copy" && !x.titulo && x.secao !== "como usar"), ficha);
  if (inventadosCopy.length) {
    add("FATO_INVENTADO", "Texto comercial cita material, cor ou componente que não está nos dados do anúncio.", inventadosCopy);
  }

  const nomes = analisarNomes(semTitulos, ficha);
  if (nomes.conflitantes.length) {
    add("MARCA_CONFLITANTE", "A descrição cita uma marca diferente de " + ficha.marca + ".", nomes.conflitantes);
  }
  if (nomes.naoComprovados.length) {
    add("NOME_NAO_COMPROVADO", "Nome próprio (marca, linha ou modelo) que não está nos dados do anúncio.", nomes.naoComprovados);
  }

  const jaApontados = new Set();
  for (const w of nomes.conflitantes.concat(nomes.naoComprovados)) {
    for (const t of seo.extractTokens(w)) jaApontados.add(t.key);
  }
  // F7C — grounding lexical só nas seções de FATO; a copy tem as checagens próprias acima
  const termos = termosNaoComprovados(textoFato, ficha, jaApontados);
  if (termos.length) {
    add("TERMO_NAO_COMPROVADO", "Termo que não aparece nos fatos, no título nem na descrição atual do anúncio.", termos);
  }

  const negados = afirmacoesProibidas(descricao, ficha);
  if (negados.length) {
    add("ATRIBUTO_PROIBIDO", "A descrição afirma algo que a ficha do anúncio nega.",
      Array.from(new Set(negados.map((x) => x.termo))));
  }

  // Assunto em conflito entre ficha e contexto: não pode aparecer nem negado
  // (negar seria escolher o título como vencedor).
  if (ficha.conflitos && ficha.conflitos.length) {
    // F7A.11 — vale para o texto inteiro, inclusive a 1ª linha: gerarDescricao
    // limpa o trecho em conflito do nome (limparNomeConflitante) antes daqui.
    const corpo = descricao;
    // F8.1 — o nome da marca não é afirmação sobre o assunto em conflito
    // ("Influencia Jeans" com Jeans × Sarja em conflito)
    let semMarca = semAcento(corpo);
    if (ficha.marca) semMarca = semMarca.split(semAcento(ficha.marca)).join(" ");
    const chavesDesc = new Set(seo.contentKeys(semMarca));
    const qtdCitadas = quantidadesCitadas(corpo);
    // Número colado em letra antes dele é código, não medida ("C240p").
    const numerosDesc = new Set();
    for (const m of corpo.matchAll(/(?<![\p{L}\d.,])\d+(?:[.,]\d+)*/gu)) {
      const n = normalizarNumero(m[0]);
      if (n != null) numerosDesc.add(n);
    }
    // QUANTIDADE: só conta número citado COMO quantidade ("kit com 5", "3
    // unidades"); "5 cm" não fala do tamanho do kit.
    const tocados = ficha.conflitos.filter((c) => (c.tipo === "QUANTIDADE"
      ? (c.numeros || []).some((n) => qtdCitadas.has(Number(n)))
      : (c.chaves || []).some((k) => chavesDesc.has(k)) || (c.numeros || []).some((n) => numerosDesc.has(n))));
    if (tocados.length) {
      add("CONFLITO_DE_FONTES", "A descrição fala de um dado em que a ficha e o título/descrição atual se contradizem.",
        Array.from(new Set(tocados.map((c) => c.label))));
    }
  }

  const numeros = extrairNumeros(descricao).filter((n) => !ficha.numerosPermitidos.has(n.numero));
  if (numeros.length) {
    add("NUMERO_NAO_COMPROVADO", "Número ou medida que não está nos dados do anúncio.",
      Array.from(new Set(numeros.map((n) => n.trecho))));
  }

  const ficha_ = estruturaDaDescricao(descricao, ficha);
  if (!ficha_.introducao && ficha_.n > MAX_LINHAS_DE_FICHA) {
    add("COPIA_FICHA_TECNICA", "A descrição só repete a ficha técnica em lista, sem introdução sobre o produto.");
  }
  if (ficha_.vazias.length) {
    add("SECAO_VAZIA", "A descrição tem título de seção sem itens.", ficha_.vazias);
  }
  const itens = analisarItens(descricao, ficha);
  if (itens.inventados.length) {
    add("ROTULO_INVENTADO", "Item com rótulo que não é o nome de nenhum dado do anúncio.", Array.from(new Set(itens.inventados)));
  }
  if (itens.irrelevantes.length) {
    add("ITEM_IRRELEVANTE", "Item com dado que não ajuda a decidir a compra (categoria, embalagem, plataforma ou repetido).",
      Array.from(new Set(itens.irrelevantes)));
  }
  if (itens.repetidos.length) {
    // F7C — no formato operacional a repetição em ESPECIFICAÇÕES é esperada
    if (!formatoOperacional(descricao)) add("REPETE_INTRODUCAO", "Item que só repete o que a introdução já disse.", itens.repetidos);
  }

  let usados = [];
  if (!Array.isArray(fatosUsados) || fatosUsados.some((x) => typeof x !== "string")) {
    add("FATOS_USADOS_INVALIDOS", "A IA não informou a lista de fatos usados.");
  } else {
    usados = Array.from(new Set(fatosUsados.map(normalizarIdFato).filter(Boolean)));
    const desconhecidos = usados.filter((id) => !ficha.idsConhecidos.has(id));
    if (desconhecidos.length) add("FATO_DESCONHECIDO", "A IA citou fatos que não foram enviados.", desconhecidos);
  }

  if (problemas.length) return { valida: false, descricao, problemas };
  return { valida: true, descricao, chars: descricao.length, fatosUsados: usados };
}

// -----------------------------------------------------------------------------
// F7B — segurança factual × qualidade. validarDescricao continua apontando
// TUDO; aqui cada problema ganha severidade:
//   HARD  → descarta a geração (o texto não pode ser salvo assim).
//   SOFT  → corrigido de forma determinística, SEM reescrever: tira a frase
//           ou o item inteiro, tira só o rótulo do item, tira marcação; ou
//           vira aviso. O texto corrigido passa de novo por TODA a validação.
// Nada de exceção por anúncio: a regra é por código de problema.
// -----------------------------------------------------------------------------
const CODIGOS_HARD = new Set([
  "VAZIA", "EXCEDE_LIMITE", "URL", "EMAIL", "TELEFONE", "CONTATO_EXTERNO", "MARCA_CONFLITANTE",
  "ATRIBUTO_PROIBIDO", "CONFLITO_DE_FONTES", "NUMERO_NAO_COMPROVADO", "CLAIM_TECNICO_HERDADO",
  "CORRECAO_EXCESSIVA",
  "CLAIM_NAO_SUSTENTADO", "FATO_INVENTADO", // F7C — fato/claim objetivo na copy
  "CLAIM_COMERCIAL_SEM_FONTE", // F7C.1 — preço/custo ou facilidade técnica sem fonte
  "CLAIM_OBJETIVO_SEM_FONTE", "KIT_OMITIDO", // F8.1 — desempenho sem fonte; kit descrito como unidade
  "FATO_PERDIDO", // correção não pode apagar a única ocorrência de um fato útil
]);
// SOFT por remoção da frase/item onde o termo aparece.
// F7C — benefício deduzido virou SOFT: é linguagem, não fato novo (sai do bloco de FATO).
const CODIGOS_REMOVER_TRECHO = new Set(["TERMO_NAO_COMPROVADO", "NOME_NAO_COMPROVADO", "PROPAGANDA_HERDADA", "VOZ_DA_LOJA",
  "LINGUAGEM_PROIBIDA", "BENEFICIO_DEDUZIDO"]);
// Só valem nos blocos de FATO: a remoção nunca toca a copy por causa deles.
const CODIGOS_SO_DE_FATO = new Set(["TERMO_NAO_COMPROVADO", "BENEFICIO_DEDUZIDO"]);
// Mais que isso, a geração está contaminada demais para ser aproveitada.
// Conta trechos removidos por problema de conteúdo + itens de rótulo inventado.
const MAX_TRECHOS_REMOVIDOS = 4;
const CODIGOS_QUE_CONTAM = new Set([...CODIGOS_REMOVER_TRECHO, "ROTULO_INVENTADO"]);

function severidade(p, ficha) {
  if (CODIGOS_HARD.has(p.codigo)) return "hard";
  // logística/garantia/política é promessa operacional: HARD
  if (p.codigo === "LINGUAGEM_PROIBIDA" && (p.termos || []).some((t) => LINGUAGEM_LOGISTICA.has(t) || LINGUAGEM_PRECO_ESTOQUE.has(t) ||
    /^receb/.test(t))) return "hard"; // F9.1 — receber (recebimentosSemFonte)
  // nome sem origem em fonte NENHUMA é invenção; com origem no título ou na
  // descrição atual (contexto fraco), é só nome que não pode ser afirmado
  if (p.codigo === "NOME_NAO_COMPROVADO" &&
    (p.termos || []).some((w) => seo.extractTokens(w).some((t) => !ficha.vocabularioFraco.has(t.key) && !ficha.nomesAutorizados.has(t.key)))) return "hard";
  return "soft";
}

// Segmentos removíveis: cada item "- …" e cada frase das linhas de texto
// corrido. 1ª linha (nome) e títulos de seção não são removíveis.
function segmentosDe(descricao) {
  const linhas = descricao.split("\n");
  const { nome } = partesDaDescricao(descricao);
  const segs = [];
  linhas.forEach((l, i) => {
    const t = l.trim();
    if (!t) return;
    const ehNome = nome && t === nome && !segs.some((s) => s.tipo === "nome");
    if (ehNome) { segs.push({ i, tipo: "nome", texto: t }); return; }
    if ((i > 0 && ehTituloDeSecao(t)) || ehSecaoConhecida(t)) { segs.push({ i, tipo: "secao", texto: t }); return; }
    if (/^[-•*–]\s*\S/.test(t)) { segs.push({ i, tipo: "item", texto: t }); return; }
    for (const frase of t.split(/(?<=[.!?])\s+/)) if (frase.trim()) segs.push({ i, tipo: "frase", texto: frase.trim() });
  });
  return segs;
}

function segmentoTem(seg, p) {
  const s = semAcento(seg.texto);
  const chaves = new Set(seo.extractTokens(seg.texto).map((t) => t.key));
  return (p.termos || []).some((termo) => {
    if (p.codigo === "TERMO_NAO_COMPROVADO") return chaves.has(termo);
    if (p.codigo === "LINGUAGEM_PROIBIDA") return termo === "excesso de exclamações" ? false : contemFrase(s, termo);
    const t = semAcento(termo);
    return seo.extractTokens(termo).every((x) => chaves.has(x.key)) ||
      new RegExp("(^|[^a-z0-9])" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?=[^a-z0-9]|$)").test(s);
  });
}

// F14 — tira só a ORAÇÃO do segmento que tem o termo do problema, quando o
// resto se sustenta sozinho, em vez de apagar o item inteiro:
//   "* Composição: 100% algodão, sem lycra"  → "* Composição: 100% algodão"
//   "* Revestimento em borracha texturizada para uma pegada firme" →
//     "* Revestimento em borracha texturizada"
// Oração = pedaço entre vírgula, ";", " e ", " com ", " para ", " que ". A
// cabeça da frase (1ª oração, fora de item "Rótulo: valores") nunca sai; o
// que sobra precisa ter 2+ palavras de conteúdo (1+ depois de rótulo) e não
// pode conter o termo. Sem isso → null (quem chama decide: apagar o segmento).
// O texto resultante passa pela validação completa de novo.
const SEPARADORES_DE_ORACAO = /(,\s+|;\s+|\s+e\s+|\s+com\s+|\s+para\s+|\s+que\s+)/i;
function removerFragmento(texto, p) {
  const m = /^(\s*[-•*–]\s*)?([\s\S]*?)([.!?]?)$/.exec(String(texto).trim());
  if (!m) return null;
  const marcador = m[1] || "";
  const fim = m[3] || "";
  const rot = /^([^:]{2,40}):\s*(.+)$/.exec(m[2]);
  const prefixo = rot ? rot[1] + ": " : "";
  const pedacos = (rot ? rot[2] : m[2]).split(SEPARADORES_DE_ORACAO);
  if (pedacos.length < 3) return null;
  const tem = (t) => segmentoTem({ texto: t }, p);
  const out = [];
  let removeu = false;
  for (let k = 0; k < pedacos.length; k += 2) {
    if (tem(pedacos[k])) {
      if (k === 0 && !rot) return null;
      removeu = true;
      continue;
    }
    if (out.length) out.push(pedacos[k - 1]);
    out.push(pedacos[k]);
  }
  if (!removeu || !out.length) return null;
  const corpo = out.join("").replace(/(\s+(de|da|do|das|dos|com|para|e|em|que))+\s*$/i, "").replace(/[,;\s]+$/, "").trim();
  if (!corpo || tem(corpo)) return null;
  const conteudo = seo.extractTokens(corpo).filter((t) => !t.stopword && !CHAVES_FUNCIONAIS.has(t.key)).length;
  if (conteudo < (rot ? 1 : 2)) return null;
  return marcador + prefixo + corpo + fim;
}

// Item factual inequívoco cujo valor ORIGINAL começa pelo valor comprovado.
// Só corta um sufixo léxico sem fonte; não reconstrói frase, negação ou alternativa.
function conservarValorRotulado(seg, p, ficha) {
  if (seg.tipo !== "item" || p.codigo !== "TERMO_NAO_COMPROVADO") return null;
  const m = /^(\s*[-•*–]\s*)([^:]{2,40}):\s*(.+?)([.!?]?)$/.exec(seg.texto);
  if (!m) return null;
  const kr = seo.contentKeys(m[2]);
  const candidatos = ficha.fatos.filter((f) => {
    const kl = seo.contentKeys(f.label);
    return !f.oculto && f.listavel !== false && kr.length && kr.length === kl.length &&
      kr.every((k, i) => k === kl[i]);
  });
  if (candidatos.length !== 1) return null;
  const f = candidatos[0];
  if (valorBooleano(f.value) !== null) return null;
  const valor = String(f.value).trim();
  const original = m[3].trim();
  const vn = semAcento(valor);
  const on = semAcento(original);
  if (!vn || !on.startsWith(vn) || !/^\s+/.test(on.slice(vn.length))) return null;
  const sufixo = original.slice(valor.length).trim();
  // Uma oração, número ou conectivo pode mudar o significado do valor: não cortar.
  if (!/^[\p{L}\s]+$/u.test(sufixo)) return null;
  const tokens = seo.extractTokens(sufixo);
  if (!tokens.length || tokens.some((t) => t.stopword || !(p.termos || []).includes(t.key))) return null;
  return m[1] + m[2] + ": " + original.slice(0, valor.length) + m[4];
}

// Aplica UMA rodada de correções SOFT. Devolve null se algum problema não
// tem correção segura (vira HARD CORRECAO_EXCESSIVA).
function corrigirUmaVez(descricao, usados, problemas, ficha, registro) {
  let linhas = descricao.split("\n");
  let novosUsados = usados;
  const avisos = [];
  for (const p of problemas) {
    if (CODIGOS_REMOVER_TRECHO.has(p.codigo) && !(p.codigo === "LINGUAGEM_PROIBIDA" && p.termos.every((t) => t === "excesso de exclamações"))) {
      const atual = linhas.join("\n");
      const tipos = linhasPorSecao(atual);
      const naCopy = (seg) => tipos[seg.i] && tipos[seg.i].tipo === "copy";
      // termo que a copy pode usar livremente não é motivo para tirar trecho dela
      const liberadoNaCopy = (seg) => naCopy(seg) && (CODIGOS_SO_DE_FATO.has(p.codigo) ||
        (p.codigo === "LINGUAGEM_PROIBIDA" && p.termos.every((t) => COPY_LIBERADA.has(t))) ||
        (p.codigo === "PROPAGANDA_HERDADA" && p.termos.every((t) => !COPY_PROPAGANDA_VIGIADA.has(seo.extractTokens(t)[0].key))));
      const alvos = segmentosDe(atual).filter((seg) => segmentoTem(seg, p) && !liberadoNaCopy(seg));
      // Sem trecho removível: outro problema da mesma rodada já o tirou. Se o
      // problema persistir, a revalidação da próxima rodada o acha de novo e,
      // esgotadas as rodadas, a geração é rejeitada — nunca passa calada.
      if (!alvos.length) continue;
      if (alvos.some((seg) => seg.tipo !== "item" && seg.tipo !== "frase")) return { erro: "Problema na 1ª linha ou em título de seção (" + p.codigo + ")." };
      for (const seg of alvos) {
        const l = linhas[seg.i];
        // F14 — só a oração com o termo sai quando o resto se sustenta
        const resto = removerFragmento(seg.texto, p) || conservarValorRotulado(seg, p, ficha);
        if (resto) {
          linhas[seg.i] = l.replace(seg.texto, resto);
          registro.removidos.push({ codigo: p.codigo, termos: p.termos, trecho: seg.texto, ficou: resto });
          continue;
        }
        linhas[seg.i] = seg.tipo === "item" ? null : l.replace(seg.texto, "").replace(/\s{2,}/g, " ").trim();
        registro.removidos.push({ codigo: p.codigo, termos: p.termos, trecho: seg.texto });
      }
      linhas = linhas.filter((l) => l !== null);
      continue;
    }
    switch (p.codigo) {
      case "LINGUAGEM_PROIBIDA": // só excesso de exclamações
        linhas = linhas.map((l) => l.replace(/!/g, "."));
        registro.corrigidos.push({ codigo: p.codigo, acao: "exclamações viraram ponto" });
        break;
      case "ROTULO_INVENTADO": {
        // O item inteiro sai. Tirar só o rótulo NÃO é seguro: o rótulo dá o
        // sentido ("Linha: Shampoo, Máscara…" sem rótulo parece conteúdo do
        // produto; "Bolsos: Frontais e traseiros" vira frase sem sujeito).
        const rotulos = new Set(p.termos);
        linhas = linhas.filter((l) => {
          const m = /^\s*[-•*–]\s*([^:]{2,40}):\s*\S/.exec(l);
          if (!m || !rotulos.has(m[1].trim())) return true;
          registro.removidos.push({ codigo: p.codigo, termos: [m[1].trim()], trecho: l.trim() });
          return false;
        });
        break;
      }
      case "ITEM_IRRELEVANTE":
      case "REPETE_INTRODUCAO": {
        const alvo = new Set(p.termos);
        linhas = linhas.filter((l) => {
          const item = l.trim().replace(/^[-•*–]\s*/, "");
          const m = /^([^:]{2,40}):/.exec(item);
          const bate = /^[-•*–]/.test(l.trim()) && (alvo.has(item) || (m && alvo.has(m[1].trim())));
          if (bate) registro.removidos.push({ codigo: p.codigo, termos: [], trecho: l.trim() });
          return !bate;
        });
        break;
      }
      case "SECAO_VAZIA": {
        const vazias = new Set(p.termos);
        linhas = linhas.filter((l, i) => !(((i > 0 && ehTituloDeSecao(l)) || ehSecaoConhecida(l)) && vazias.has(l.trim().replace(/:$/, ""))));
        registro.corrigidos.push({ codigo: p.codigo, acao: "título sem itens removido", termos: p.termos });
        break;
      }
      case "FORMATACAO_INVALIDA":
        linhas = linhas.map((l) => l.replace(/<\/?[a-z][^>]*>/gi, "").replace(/\*\*|__/g, "").replace(/^\s{0,3}#{1,6}\s+/, "")
          .replace(/\p{Extended_Pictographic}️?/gu, "").replace(/\s{2,}/g, " ").replace(/\s+$/, ""));
        registro.corrigidos.push({ codigo: p.codigo, acao: "marcação removida" });
        break;
      case "FATO_DESCONHECIDO":
        novosUsados = (Array.isArray(novosUsados) ? novosUsados : []).filter((id) => !p.termos.includes(normalizarIdFato(id)));
        avisos.push({ codigo: p.codigo, termos: p.termos, acao: "ids desconhecidos descartados de fatosUsados" });
        break;
      case "FATOS_USADOS_INVALIDOS":
        novosUsados = [];
        avisos.push({ codigo: p.codigo, acao: "fatosUsados ausente: rastreabilidade vazia" });
        break;
      case "COPIA_FICHA_TECNICA":
        avisos.push({ codigo: p.codigo, acao: "aviso: texto muito próximo da ficha técnica" });
        break;
      default:
        return { erro: "Sem correção segura para " + p.codigo + "." };
    }
  }
  return { descricao: normalizarTexto(linhas.join("\n")), usados: novosUsados, avisos };
}

// Presença lexical factual compartilhada com o autorreparo. Não é prova semântica.
const chavesDePreservacao = (t) => seo.extractTokens(String(t || ""))
  .filter((x) => !x.stopword && x.key.length >= 3 && !CHAVES_FUNCIONAIS.has(x.key)).map((x) => x.key);
const numerosDePreservacao = (t) => new Set(extrairNumeros(String(t || "")).map((n) => n.numero));
const fonteDoFato = (f) => /^sim$/i.test(String(f.value).trim()) ? f.label : String(f.value == null ? "" : f.value);

function fatosPresentes(textoDesc, ficha) {
  const chaves = new Set(chavesDePreservacao(textoDesc));
  const nums = numerosDePreservacao(textoDesc);
  return (ficha.fatos || []).filter((f) => {
    if (f.oculto || f.id === "model" || /^(nao|não)$/i.test(String(f.value).trim())) return false;
    const fonte = fonteDoFato(f);
    const ks = chavesDePreservacao(fonte);
    const ns = Array.from(numerosDePreservacao(fonte));
    return (ks.length || ns.length) && ks.every((k) => chaves.has(k)) && ns.every((n) => nums.has(n));
  });
}

function fatoDoErro(f, problemas) {
  // FATO_PERDIDO localiza o que deve permanecer, não o que pode ser retirado.
  const termos = problemas.filter((p) => p.codigo !== "FATO_PERDIDO").flatMap((p) => p.termos || []).join(" ");
  const kt = new Set(chavesDePreservacao(termos));
  const nt = numerosDePreservacao(termos);
  return chavesDePreservacao(fonteDoFato(f)).some((k) => kt.has(k)) ||
    Array.from(numerosDePreservacao(fonteDoFato(f))).some((n) => nt.has(n));
}

function fatosPerdidos(antes, depois, ficha, problemas = []) {
  const ficam = new Set(fatosPresentes(depois, ficha).map((f) => f.id));
  return fatosPresentes(antes, ficha).filter((f) => !ficam.has(f.id) &&
    !fatoDoErro(f, problemas))
    .map((f) => ({ id: f.id, label: f.label, value: f.value }));
}

// Descartes editoriais intencionais/metadados não viram obrigação de conteúdo.
function fatoUtil(f) {
  const v = semAcento(f.value).trim();
  return !f.oculto && f.listavel !== false && !VALORES_SEM_INFORMACAO.has(v) && v !== "sem validade" &&
    v !== "sem " + semAcento(f.label).trim();
}

// Valida; se só houver SOFT, corrige e valida de novo (até 4 rodadas).
//   { valida, descricao, fatosUsados?, problemas?, hard?, avisos: [...] }
function validarComCorrecoes(descricaoBruta, fatosUsados, ficha) {
  const registro = { removidos: [], corrigidos: [], avisos: [] };
  let descricao = normalizarTexto(descricaoBruta);
  let usados = fatosUsados;
  for (let rodada = 0; rodada < 4; rodada += 1) {
    const v = validarDescricao(descricao, usados, ficha);
    const avisosFinais = () => registro.avisos.concat(
      registro.removidos.map((r) => ({ codigo: r.codigo, acao: "trecho removido", trecho: r.trecho, termos: r.termos })),
      registro.corrigidos.map((c) => ({ codigo: c.codigo, acao: c.acao, ...(c.trecho ? { trecho: c.trecho } : {}), ...(c.termos ? { termos: c.termos } : {}) })));
    if (v.valida) return { ...v, avisos: avisosFinais() };
    const hard = v.problemas.filter((p) => severidade(p, ficha) === "hard");
    if (hard.length) return { ...v, hard, avisos: avisosFinais() };
    const r = corrigirUmaVez(descricao, usados, v.problemas, ficha, registro);
    if (r.descricao != null) {
      const uteis = new Set(ficha.fatos.filter(fatoUtil).map((f) => f.id));
      const perdidos = fatosPerdidos(descricao, r.descricao, ficha, v.problemas).filter((f) => uteis.has(f.id));
      if (perdidos.length) {
        const p = { codigo: "FATO_PERDIDO", detalhe: "A correção removeria informação comprovada do produto: " +
          perdidos.map((f) => f.label + ": " + f.value).join("; ") + ".", termos: perdidos.map((f) => String(f.value)) };
        return { ...v, hard: [p], problemas: v.problemas.concat(p), avisos: registro.avisos };
      }
    }
    const removidosDeConteudo = registro.removidos.filter((x) => CODIGOS_QUE_CONTAM.has(x.codigo)).length;
    const semAbertura = r.descricao != null && !partesDaDescricao(r.descricao).introducao;
    if (r.erro || removidosDeConteudo > MAX_TRECHOS_REMOVIDOS || semAbertura) {
      const motivo = r.erro || (semAbertura ? "A correção esvaziaria a abertura." :
        "A correção precisaria remover " + removidosDeConteudo + " trechos (máximo " + MAX_TRECHOS_REMOVIDOS + ").");
      const problemas = v.problemas.concat([{ codigo: "CORRECAO_EXCESSIVA", detalhe: motivo }]);
      return { valida: false, descricao, problemas, hard: problemas.filter((p) => p.codigo === "CORRECAO_EXCESSIVA"), avisos: avisosFinais() };
    }
    registro.avisos.push(...r.avisos);
    descricao = r.descricao;
    usados = r.usados;
  }
  const v = validarDescricao(descricao, usados, ficha);
  return v.valida ? { ...v, avisos: registro.avisos } : { ...v, hard: v.problemas, avisos: registro.avisos };
}

// -----------------------------------------------------------------------------
// F10 — polimento editorial do texto JÁ APROVADO. Só forma: nenhuma regra
// acrescenta palavra de conteúdo; cada uma tira ruído ou corrige grafia e
// concordância. Cada regra roda sozinha e o texto é revalidado: se a
// validação deixar de passar, a regra é descartada — o texto aprovado nunca
// piora nem perde trava.
// -----------------------------------------------------------------------------
const ehItemDeLista = (t) => /^[-•*–]\s*\S/.test(t);
const ehItemRotulado = (t) => /^[-•*–]\s*[^:]{2,40}:\s*\S/.test(t);
const frasesDe = (t) => t.split(/(?<=[.!?])\s+/).filter((f) => f.trim());

// Linhas com a seção a que pertencem; o nome (1ª linha fora do formato
// operacional) e os títulos de seção nunca são reescritos.
function linhasEditaveis(descricao) {
  const { nome } = partesDaDescricao(descricao);
  return linhasPorSecao(descricao).map((x) => ({ ...x, fixa: x.titulo || !x.linha.trim() || (x.i === 0 && nome && x.linha.trim() === nome) }));
}

// Aplica fn ao texto de cada linha editável (o marcador "* " fica).
function reescreverLinhas(descricao, fn) {
  return linhasEditaveis(descricao).map((x) => {
    if (x.fixa) return x.linha;
    const m = /^(\s*[-•*–]\s*)?([\s\S]*)$/.exec(x.linha);
    const novo = fn(m[2], { item: !!m[1], rotulado: ehItemRotulado(x.linha.trim()), tipo: x.tipo, secao: x.secao });
    return novo == null ? null : (m[1] || "") + novo;
  }).filter((l) => l !== null).join("\n");
}

// Pontuação que sobra de um trecho tirado do meio da frase.
const arrumarPontuacao = (t) => t.replace(/\s+([,.;:!?])/g, "$1").replace(/,\s*([.;!?])/g, "$1").replace(/([,;])\1+/g, "$1")
  .replace(/^\s*[,;]\s*/, "").replace(/\s{2,}/g, " ").trim();

// Remove frases/itens que casam com pred. Seção que ficaria sem conteúdo:
// com esvaziar, sai junto com o título; sem, fica como estava. A DESCRIÇÃO
// PRINCIPAL nunca é esvaziada.
function removerSegmentos(descricao, pred, { esvaziar = false } = {}) {
  const linhas = linhasEditaveis(descricao);
  const porSecao = new Map();
  for (const x of linhas) {
    if (x.fixa) continue;
    const t = x.linha.trim();
    const novo = ehItemDeLista(t) ? (pred(t.replace(/^[-•*–]\s*/, ""), x) ? null : x.linha)
      : (() => { const fs = frasesDe(t); const ficam = fs.filter((f) => !pred(f, x)); return ficam.length === fs.length ? x.linha : (ficam.join(" ") || null); })();
    const k = x.secao || "";
    if (!porSecao.has(k)) porSecao.set(k, []);
    porSecao.get(k).push({ x, novo });
  }
  const resultado = new Map(linhas.map((x) => [x.i, x.linha]));
  const tirarTitulo = new Set();
  for (const [secao, lista] of porSecao) {
    if (lista.every((e) => e.novo === e.x.linha)) continue;
    const vazia = lista.every((e) => e.novo == null);
    if (vazia && (!esvaziar || !secao || secao === "descricao principal")) continue;
    for (const e of lista) resultado.set(e.x.i, e.novo);
    if (vazia) tirarTitulo.add(secao);
  }
  for (const x of linhas) if (x.titulo && tirarTitulo.has(x.secao)) resultado.set(x.i, null);
  return linhas.map((x) => resultado.get(x.i)).filter((l) => l != null).join("\n");
}

// 1. Grafia sem acento (a IA às vezes devolve "versatil", "padrao", "opcao").
// Só palavra toda em minúscula — ou maiúscula no início da frase/item —, para
// não tocar nome próprio ou marca. Lista fechada + terminações sem ambiguidade.
const ACENTOS = new Map(Object.entries({
  nao: "não", voce: "você", voces: "vocês", tambem: "também", ja: "já", ate: "até", alem: "além", porem: "porém", apos: "após",
  padrao: "padrão", padroes: "padrões", botao: "botão", botoes: "botões", algodao: "algodão", mao: "mão", maos: "mãos",
  classico: "clássico", classica: "clássica", classicos: "clássicos", classicas: "clássicas",
  basico: "básico", basica: "básica", basicos: "básicos", basicas: "básicas", versatil: "versátil", versateis: "versáteis",
  numerico: "numérico", numerica: "numérica", numericos: "numéricos", numericas: "numéricas", pratico: "prático", praticos: "práticos",
  otimo: "ótimo", otima: "ótima", otimos: "ótimos", otimas: "ótimas", facil: "fácil", faceis: "fáceis", util: "útil", uteis: "úteis",
  unico: "único", unica: "única", unicos: "únicos", unicas: "únicas", agil: "ágil", espaco: "espaço", espacos: "espaços",
  mantem: "mantém", contem: "contém", area: "área", areas: "áreas", agua: "água", rapido: "rápido", rapida: "rápida",
  rapidos: "rápidos", rapidas: "rápidas", solido: "sólido", solida: "sólida", liquido: "líquido", liquida: "líquida",
  proprio: "próprio", propria: "própria", tecnico: "técnico", tecnica: "técnica", tecnicos: "técnicos", tecnicas: "técnicas",
  eletrico: "elétrico", eletrica: "elétrica", eletricos: "elétricos", eletricas: "elétricas", termico: "térmico", termica: "térmica",
  plastico: "plástico", plastica: "plástica", plasticos: "plásticos", metalico: "metálico", metalica: "metálica",
  automatico: "automático", automatica: "automática", acessorio: "acessório", acessorios: "acessórios", estetica: "estética",
  ceramica: "cerâmica", aluminio: "alumínio", poliester: "poliéster", conteudo: "conteúdo", video: "vídeo", videos: "vídeos",
  audio: "áudio", codigo: "código", genero: "gênero", generos: "gêneros", lancamento: "lançamento", lancamentos: "lançamentos",
  harmonico: "harmônico", ergonomico: "ergonômico", ergonomica: "ergonômica", cafe: "café", numero: "número", numeros: "números",
  contemporaneo: "contemporâneo", contemporanea: "contemporânea", contemporaneos: "contemporâneos", contemporaneas: "contemporâneas",
  movel: "móvel", moveis: "móveis", eletronico: "eletrônico", eletronica: "eletrônica", eletronicos: "eletrônicos", eletronicas: "eletrônicas",
}));
const TERMINACOES_SEM_ACENTO = [[/cao$/, "ção"], [/coes$/, "ções"], [/sao$/, "são"], [/soes$/, "sões"], [/xao$/, "xão"], [/xoes$/, "xões"],
  [/encia$/, "ência"], [/encias$/, "ências"], [/ancia$/, "ância"], [/ancias$/, "âncias"], [/avel$/, "ável"], [/aveis$/, "áveis"],
  [/ivel$/, "ível"], [/iveis$/, "íveis"]];
const TITULOS_ACENTUADOS = new Map([["descricao principal", "DESCRIÇÃO PRINCIPAL"], ["especificacoes", "ESPECIFICAÇÕES"],
  ["dimensoes", "DIMENSÕES"], ["conteudo da embalagem", "CONTEÚDO DA EMBALAGEM"], ["informacoes adicionais", "INFORMAÇÕES ADICIONAIS"],
  ["beneficios", "BENEFÍCIOS"], ["observacoes", "OBSERVAÇÕES"], ["experiencia de compra", "EXPERIÊNCIA DE COMPRA"]]);
function acentuar(w) {
  if (ACENTOS.has(w)) return ACENTOS.get(w);
  if (w.length < 5 || !/^[a-z]+$/.test(w)) return null;
  const t = TERMINACOES_SEM_ACENTO.find(([re]) => re.test(w));
  return t ? w.replace(t[0], t[1]) : null;
}
function corrigirAcentos(descricao) {
  const corpo = reescreverLinhas(descricao, (t) => t.replace(/(?<![\p{L}\d])\p{L}+(?![\p{L}\d])/gu, (w, ini, s) => {
    // depois de "Rótulo:" vem valor da ficha (marca, nome): não conta como início
    const inicio = /^\s*$|[.!?]\s*$/.test(s.slice(0, ini));
    const minuscula = w === w.toLowerCase();
    if (!minuscula && !(inicio && w === w[0] + w.slice(1).toLowerCase())) return w;
    const a = acentuar(w.toLowerCase());
    return !a ? w : minuscula ? a : a[0].toUpperCase() + a.slice(1);
  }));
  // título de seção do formato operacional escrito sem acento ("ESPECIFICACOES")
  return corpo.split("\n").map((l) => {
    const t = l.trim();
    const canon = TITULOS_ACENTUADOS.get(chaveDeSecao(t));
    return canon && t === t.toUpperCase() && t.replace(/:$/, "") !== canon && semAcento(t.replace(/:$/, "")) === semAcento(canon) ? canon + (/:$/.test(t) ? ":" : "") : l;
  }).join("\n");
}

// 2. Valor sem informação vindo da ficha ("Características do produto: Sem
// validade", "Produto sem validade", "Não se aplica"): frase/item sai; num
// trecho de frase ("…, sem validade."), só o trecho sai.
const RE_SEM_INFORMACAO = /(^|[^a-z])(sem validade|nao se aplica|nao aplicavel|nao informad[oa]|nao especificad[oa])(?=[^a-z]|$)/;
const PALAVRAS_DE_VALOR_VAZIO = new Set(["produto", "item", "caracteristica", "sem", "validade", "aplica", "aplicavel", "informado",
  "informada", "especificado", "especificada", "nao", "possui", "tem", "e"].map((w) => seo.reduceMorphology(w)));
function tirarValoresSemInformacao(descricao) {
  const trecho = reescreverLinhas(descricao, (t, x) => {
    if (x.item || !RE_SEM_INFORMACAO.test(semAcento(t))) return t;
    return frasesDe(t).map((f) => {
      const sem = f.replace(/(,\s*|\s+e\s+)(?:(?:é|e|o produto é)\s+)?(sem validade|n[ãa]o se aplica)(?=\s*[.;!?]?\s*$)/i, "")
        .replace(/^((?:o\s+)?produto|item)\s+sem validade,\s*/i, "$1 "); // "Produto sem validade, indicado…" → "Produto indicado…"
      return sem === f ? f : arrumarPontuacao(sem);
    }).join(" ");
  });
  return removerSegmentos(trecho, (seg) => {
    if (!RE_SEM_INFORMACAO.test(semAcento(seg))) return false;
    const resto = seo.extractTokens(seg).filter((tk) => !tk.stopword && !PALAVRAS_DE_VALOR_VAZIO.has(tk.key));
    // item/frase que é só o valor vazio, ou que gira em torno dele ("Sem validade, oferecem…")
    return !resto.length || /^\s*[-•*–]?\s*(sem validade|n[ãa]o se aplica)/i.test(seg) || /^[^:]{2,40}:\s*(sem validade|n[ãa]o se aplica)/i.test(seg);
  }, { esvaziar: true });
}

// 3. Rótulo ecoado no valor: "e com gênero sem gênero", "de cor sem cor".
function tirarRotuloEcoado(descricao) {
  return reescreverLinhas(descricao, (t, x) => {
    if (x.rotulado) return t;
    const novo = t.replace(/(,\s*|\s+)(?:e\s+)?(?:com|de|do|da)\s+(\p{L}+)\s+sem\s+(\p{L}+)(?!\p{L})/giu,
      (m, a, w1, w2) => (semAcento(w1.toLowerCase()) === semAcento(w2.toLowerCase()) ? "" : m));
    return novo === t ? t : arrumarPontuacao(novo);
  });
}

// 4. Qualificador que só repete o que a frase já disse: "O Trator BS Toys,
// modelo Trator Bs Toys, é…" → "O Trator BS Toys é…"; "O SSD NTC, da linha
// SSD, é…" → "O SSD NTC é…".
const CONTINUA_SEM_VIRGULA = /^\s*(?:é|são|tem|têm|possui|possuem|traz|trazem|conta|contam|oferece|oferecem|foi|vem|vêm|chega|chegam|apresenta|em|de|com|na|no|nas|nos|para|da|do)(?!\p{L})/u;
function tirarQualificadorRedundante(descricao) {
  return reescreverLinhas(descricao, (t, x) => {
    if (x.rotulado) return t;
    return frasesDe(t).map((f) => f.replace(/,\s*(?:d[ao]\s+)?(?:modelo|linha)\s+([^,.;:!?]+?)\s*(,|(?=[.;!?]\s*$)|$)/giu, (m, valor, fim, ini) => {
      const chaves = seo.contentKeys(valor);
      const antes = new Set(seo.contentKeys(f.slice(0, ini)));
      if (!chaves.length || !chaves.every((k) => antes.has(k))) return m;
      if (fim !== ",") return "";
      // aposto entre vírgulas antes do verbo/complemento: as duas vírgulas saem
      return CONTINUA_SEM_VIRGULA.test(f.slice(ini + m.length)) ? " " : ", ";
    }).replace(/\s{2,}/g, " ").replace(/\s+([.;!?])/g, "$1")).join(" ");
  });
}

// 5. Palavra (ou sequência de até 3) repetida em seguida: "para para",
// "de alta qualidade de alta qualidade". Só minúsculas: nome próprio e
// marca ("Bora Bora") ficam.
function tirarRepeticaoImediata(descricao) {
  return reescreverLinhas(descricao, (t) => t.replace(/(?<!\p{L})(\p{Ll}{2,}(?:\s+\p{Ll}{2,}){0,2})\s+\1(?!\p{L})/gu, "$1"));
}

// 6. Metatexto: frase que fala da própria descrição ou das informações em vez
// do produto ("quando as informações estão claras", "confira as
// especificações", "medidas objetivas para ajudar na escolha").
const RE_METATEXTO = /(^|[^a-z])(informacoes (?:estao )?(?:claras|essenciais|completas|detalhadas|objetivas|corretas)|com as informacoes|medidas objetivas|confira as (?:especificacoes|informacoes|caracteristicas)|veja as especificacoes|(?:para )?ajuda(?:m|r)? na escolha|(?:nesta|esta|desta) descricao|(?:neste|este|deste) anuncio|consulte a (?:ficha|tabela))(?=[^a-z]|$)/;
function tirarMetatexto(descricao) {
  return removerSegmentos(descricao, (seg, x) => x.tipo === "copy" && RE_METATEXTO.test(semAcento(seg)));
}

// 7. Concordância de cor fora do item "Rótulo: valor": "na cor branco" →
// "na cor branca", "* Cor amarelo" → "* Cor amarela", "cor principal
// multicolorido" → "multicolorida". O valor fica se vier com maiúscula ou
// combinado ("Cor: Branco" e "Preto + Branco" vêm da ficha e ficam).
const RE_COR_MASCULINA = /(?<!\p{L})([Cc]or(?:\s+principal|\s+predominante)?)\s+(branc|pret|amarel|vermelh|rox|dourad|prated|cromad|multicolorid|variad|escur|clar)o(?!\p{L}|\s*[+/]|\s+e\s+\p{Ll}+o(?!\p{L}))/gu;
function concordarCor(descricao) {
  return reescreverLinhas(descricao, (t, x) => (x.rotulado ? t : t.replace(RE_COR_MASCULINA, "$1 $2a")));
}

// 8. Material com maiúscula no meio da frase ("em material Plástico",
// "Fabricada em Alumínio"): vira minúscula. Só nomes da lista de materiais.
const PALAVRAS_DE_MATERIAL = new Set(Object.values(MATERIAIS).flat(2));
function minusculaDeMaterial(descricao) {
  return reescreverLinhas(descricao, (t, x) => (x.rotulado ? t : t.replace(/(?<!\p{L})(material|materiais|em|de|feit[oa]s?|fabricad[oa]s?)\s+(\p{Lu}\p{Ll}+)(?!\p{L}|\s*[+/]|\s+\p{Lu})/gu,
    (m, antes, w) => (PALAVRAS_DE_MATERIAL.has(semAcento(w.toLowerCase())) ? antes + " " + w.toLowerCase() : m))));
}

// 9. Item que repete outro da MESMA seção: todas as palavras de conteúdo dele
// já estão num item mais completo ("Cor branca" ao lado de "Cor branca, de
// visual delicado"). O mais curto sai; idênticos, fica o primeiro.
function tirarItensContidos(descricao) {
  const linhas = linhasEditaveis(descricao);
  const itens = linhas.filter((x) => !x.fixa && ehItemDeLista(x.linha.trim()))
    .map((x) => ({ x, rotulado: ehItemRotulado(x.linha.trim()), chaves: new Set(seo.contentKeys(x.linha.trim().replace(/^[-•*–]\s*/, ""))) }));
  const sai = new Set();
  for (const a of itens) {
    if (!a.chaves.size) continue;
    for (const b of itens) {
      if (a === b || a.x.secao !== b.x.secao || sai.has(b.x.i)) continue;
      const contido = Array.from(a.chaves).every((k) => b.chaves.has(k));
      const igual = contido && a.chaves.size === b.chaves.size;
      // item "Rótulo: valor" é um fato próprio ("Tipo de short" ≠ "Tipo de saia"):
      // só sai se for idêntico a outro
      if (!igual && (a.rotulado || b.rotulado)) continue;
      if (contido && (!igual || b.x.i < a.x.i)) { sai.add(a.x.i); break; }
    }
  }
  return linhas.filter((x) => !sai.has(x.i)).map((x) => x.linha).join("\n");
}

// 10. Seção pobre: bloco de fato que ficou com um único item, e esse item já
// está dito no resto do texto — o bloco não acrescenta nada e sai inteiro.
function tirarSecaoPobre(descricao) {
  const linhas = linhasEditaveis(descricao);
  const sai = new Set();
  const secoes = new Set(linhas.filter((x) => x.titulo && x.tipo === "fato" && x.secao).map((x) => x.secao));
  for (const secao of secoes) {
    const conteudo = linhas.filter((x) => x.secao === secao && !x.fixa);
    if (conteudo.length !== 1 || !ehItemDeLista(conteudo[0].linha.trim())) continue;
    const fora = new Set(seo.contentKeys(linhas.filter((x) => x.secao !== secao && !x.titulo).map((x) => x.linha).join("\n")));
    const chaves = seo.contentKeys(conteudo[0].linha.replace(/^\s*[-•*–]\s*/, ""));
    if (chaves.length && chaves.every((k) => fora.has(k))) for (const x of linhas) if (x.secao === secao) sai.add(x.i);
  }
  return linhas.filter((x) => !sai.has(x.i)).map((x) => x.linha).join("\n");
}

const REGRAS_EDITORIAIS = [
  ["ACENTUACAO", corrigirAcentos],
  ["VALOR_SEM_INFORMACAO", tirarValoresSemInformacao],
  ["ROTULO_ECOADO", tirarRotuloEcoado],
  ["QUALIFICADOR_REDUNDANTE", tirarQualificadorRedundante],
  ["REPETICAO_IMEDIATA", tirarRepeticaoImediata],
  ["METATEXTO", tirarMetatexto],
  ["CONCORDANCIA_DE_COR", concordarCor],
  ["MATERIAL_MINUSCULO", minusculaDeMaterial],
  ["ITEM_CONTIDO", tirarItensContidos],
  ["SECAO_POBRE", tirarSecaoPobre],
];

//   { descricao, chars, fatosUsados, ajustes: [codigo] }
// Entrada: texto que JÁ passou em validarDescricao. Regra que faria a
// validação falhar é ignorada.
function polirDescricao(descricaoValida, fatosUsados, ficha) {
  let atual = normalizarTexto(descricaoValida);
  let v = validarDescricao(atual, fatosUsados, ficha);
  if (!v.valida) return { descricao: atual, chars: atual.length, fatosUsados, ajustes: [] };
  const ajustes = [];
  for (const [codigo, regra] of REGRAS_EDITORIAIS) {
    const novo = normalizarTexto(regra(atual, ficha));
    if (novo === atual) continue;
    const rv = validarDescricao(novo, fatosUsados, ficha);
    if (!rv.valida) continue;
    const uteis = new Set(ficha.fatos.filter(fatoUtil).map((f) => f.id));
    if (fatosPerdidos(atual, novo, ficha).some((f) => uteis.has(f.id))) continue;
    ajustes.push(codigo);
    atual = novo;
    v = rv;
  }
  return { descricao: v.descricao, chars: v.chars, fatosUsados: v.fatosUsados, ajustes };
}

// -----------------------------------------------------------------------------
// Prompt — fatos com ID, proibidos, contexto fraco e regras de estilo.
// Nada de score, ranking, keywords ou volume de busca.
// -----------------------------------------------------------------------------
const SYSTEM = [
  "Você redige descrições de anúncios do Mercado Livre Brasil.",
  "Escreve só com os fatos fornecidos. SE UMA INFORMAÇÃO NÃO ESTIVER NOS FATOS OU NO CONTEXTO AUTORIZADO, NÃO INVENTE.",
  "Responda SOMENTE com JSON válido, sem markdown e sem texto fora do JSON. Não explique o raciocínio.",
].join("\n");

function linhaFato(f) {
  return "- [" + f.id + "] " + f.label + ": " + String(f.value).slice(0, 160);
}

// F7A.3 — faixa pedida no prompt menor que ficha.alvo: o espaço extra virava
// enchimento (benefício e uso deduzidos). Nunca passa do limite.
// F7C — o padrão operacional tem até 6 blocos: a faixa cresce (mínimo 500,
// máximo de pelo menos 1500), sempre dentro do limite.
function faixaPrompt(ficha) {
  const max = Math.min(ficha.limite, Math.max(1500, ficha.alvo.max));
  return { min: Math.min(Math.max(500, Math.floor(ficha.alvo.min * 0.8)), Math.floor(max / 2)), max };
}

function montarPrompt(ficha) {
  // F7A.8 — só o que ajuda a decidir a compra vai ao prompt (marcarListaveis).
  const listaveis = ficha.fatos.filter((f) => f.listavel !== false);
  const fortes = listaveis.filter((f) => f.grupo === "forte");
  const secundarios = listaveis.filter((f) => f.grupo === "secundario");
  const linhas = ["Tarefa: escrever UMA descrição para este anúncio.", ""];

  linhas.push("FATOS PRINCIPAIS (estruturados, confiáveis):");
  for (const f of fortes) linhas.push(linhaFato(f));
  if (!fortes.length) linhas.push("- (nenhum)");
  if (secundarios.length) {
    linhas.push("", "FATOS COMPLEMENTARES (estruturados, menos centrais):");
    for (const f of secundarios.slice(0, 40)) linhas.push(linhaFato(f));
  }

  if (ficha.proibidos.length) {
    linhas.push("", "PROIBIDO AFIRMAR (a ficha do anúncio nega ou contradiz):");
    for (const p of ficha.proibidos) {
      linhas.push("- [" + p.id + "] " + p.label + " = " + p.value + " → nunca escreva: " + p.exibir.join(", "));
    }
  }

  if (ficha.conflitos && ficha.conflitos.length) {
    linhas.push("", "DADOS CONFLITANTES (a ficha e o título/descrição atual se contradizem — NÃO mencione estes assuntos " +
      "nem os valores deles, nem para negar):");
    // F7A.8 — com as palavras/números bloqueados: só o rótulo não bastava
    // (a IA escrevia "Regata" no corpo com "Tipo de roupa" em conflito).
    for (const l of Array.from(new Set(ficha.conflitos.map((c) => c.label)))) {
      const doRotulo = ficha.conflitos.filter((c) => c.label === l);
      const bloqueados = Array.from(new Set(doRotulo.flatMap((c) => (c.chaves || []).concat(c.numeros || []))));
      linhas.push("- " + l + (bloqueados.length ? " (não escreva: " + bloqueados.join(", ") + ")" : ""));
    }
  }

  // F8.1 — kit confiável: a quantidade tem de aparecer
  if (ficha.kit) {
    linhas.push("", "QUANTIDADE: o produto é um kit com " + ficha.kit.n + " unidades. Diga isso na DESCRIÇÃO PRINCIPAL " +
      "(\"Kit com " + ficha.kit.n + " …\"); nunca descreva como se fosse uma peça só.");
  }

  linhas.push("", "CONTEXTO (mais fraco que os fatos; se contradizer um fato, siga o fato):");
  if (ficha.categoria) {
    linhas.push("- [categoria] Categoria do Mercado Livre (só para entender o produto; não vira item nem frase): " + ficha.categoria);
  }
  linhas.push("- [contexto:titulo] Título atual: " + (ficha.tituloAtual || "(sem título)"));
  const d = ficha.descricaoAtual;
  if (d.texto) {
    const corpo = d.texto.length > DESCRICAO_ATUAL_MAX_PROMPT ? d.texto.slice(0, DESCRICAO_ATUAL_MAX_PROMPT) + "…" : d.texto;
    linhas.push("- [contexto:descricao_atual] Descrição atual do vendedor (pode reaproveitar informação concreta e útil; " +
      "ignore promessas de frete, prazo, garantia, contato e linguagem promocional):");
    linhas.push('"""', corpo, '"""');
  } else {
    linhas.push("- Descrição atual: (o anúncio não tem descrição hoje)");
  }

  linhas.push(
    "",
    "Como escrever (F7C — padrão operacional: FATOS rigorosos, COPY comercial com liberdade):",
    "- Estrutura, nesta ordem, cada título em CAIXA ALTA sozinho na linha, uma linha em branco entre os blocos. " +
      "Use só os blocos que tiverem conteúdo; NUNCA escreva um título sem conteúdo embaixo:",
    "  DESCRIÇÃO PRINCIPAL",
    "  Texto corrido, comercial, natural e elegante, em 4 a 7 linhas curtas. Pirâmide invertida: o mais importante " +
      "primeiro (o que é o produto, marca, material e principais características).",
    "  DESTAQUES DO PRODUTO",
    "  * itens curtos com as características reais que mais pesam na compra",
    "  COMO USAR",
    "  * sugestões naturais de uso, combinação ou contexto, coerentes com o produto",
    "  ESPECIFICAÇÕES",
    "  * Rótulo: valor — os principais fatos objetivos; não despeje a ficha inteira",
    "  BENEFÍCIOS",
    "  * benefícios comerciais derivados de características REAIS (\"Possui bolsos\" → \"Mais praticidade no dia a dia\"; " +
      "\"Elastano na composição\" → \"Maior flexibilidade no uso\")",
    "  EXPERIÊNCIA DE COMPRA",
    "  Parágrafo curto e persuasivo de fechamento, com confiança e facilidade de compra de forma genérica.",
    "- Itens começam com \"* \" (asterisco e espaço). Sem negrito, emoji, HTML ou markdown.",
    "- FATOS (DESCRIÇÃO PRINCIPAL, DESTAQUES DO PRODUTO, ESPECIFICAÇÕES): só o que está nos FATOS e no contexto, com as " +
      "palavras deles. Pode usar, com moderação, adjetivos subjetivos desta lista: " + VOCABULARIO_SUBJETIVO.join(", ") +
      ". Nestes blocos NÃO escreva benefício (facilita, ajuda, combina, proporciona, garante): benefício vai em BENEFÍCIOS.",
    "- ESPECIFICAÇÕES: o rótulo é o NOME de um fato da lista acima, igual ou encurtado (\"Cintura do short\" → \"Cintura\"). " +
      "Nunca invente rótulo e nunca use \"Categoria\". Fato \"Sim\" vira frase (\"Possui rodas\"); valor 0 ou \"Não\" = o produto " +
      "NÃO tem aquilo: não liste. Não liste embalagem, frete, formato de venda nem dados internos do Mercado Livre.",
    "- COPY (COMO USAR, BENEFÍCIOS, EXPERIÊNCIA DE COMPRA): linguagem comercial livre e sugestões de baixo risco. Mas " +
      "sugestão não vira fato: não cite material, cor, medida, número, marca, compatibilidade ou recurso que não esteja " +
      "nos FATOS.",
    "- PROIBIDO em qualquer bloco, se não houver fato que comprove: impermeável, resistente, durável, hipoalergênico, " +
      "proteção UV, antiderrapante, original/originalidade, compatível, efeito garantido (\"hidrata\", \"restaura\"), " +
      "\"alta qualidade\", \"o melhor\", \"premium\", \"exclusivo\".",
    "- COPY fala de experiência (praticidade, conforto, estilo, organização, versatilidade), nunca de DESEMPENHO sem " +
      "fato: consumo, aquecimento, rapidez, eficiência, potência, resistência ao uso, estabilidade, firmeza, " +
      "durabilidade, uso prolongado, proteção, isolamento.",
    "- EXPERIÊNCIA DE COMPRA: NUNCA afirme envio rápido, frete, prazo, garantia, devolução, troca, originalidade, " +
      "qualidade garantida, atendimento, estoque, oferta, promoção ou desconto. Nada de \"nós\"/\"nossa loja\".",
    "- Afirmação técnica que só a descrição atual faz NÃO é fato: não escreva \"antioxidante\", \"reforçado\", " +
      "\"resistente\", \"proteção\", \"certificação\" e parecidos, a menos que estejam nos FATOS ou no título.",
    "- Da descrição atual, aproveite fato concreto (medida, material, modo de uso). Nunca copie frase do vendedor com " +
      "\"recomendamos\", opinião, promessa, regra de pedido/envio ou aviso sobre foto/tela.",
    "- Evite texto robótico de ficha técnica e repetição desnecessária entre os blocos.",
    "- Tamanho: entre " + faixaPrompt(ficha).min + " e " + faixaPrompt(ficha).max + " caracteres. Máximo absoluto: " +
      ficha.limite + " caracteres.",
    "- Fale só do produto, nunca do anúncio ou da página: não use \"confira\", \"anúncio\", \"categoria\", \"guia de tamanhos\".",
    "- Maiúsculas só no início de frase, em nomes que aparecem nos fatos e nos títulos dos blocos.",
    "- Números e medidas: só os que aparecem nos fatos ou no contexto. Marca e modelo: só os dos fatos; não cite " +
      "outras marcas, linhas ou modelos.",
    "- Links, telefone, e-mail, redes sociais e contato externo: nunca.",
    "- Em fatosUsados, liste SOMENTE os identificadores exatos dos fatos que você usou, SEM COLCHETES " +
      "(os colchetes acima são só exibição). Exemplo: para a linha \"[attr:COLOR] Cor: Azul\", escreva " +
      "attr:COLOR, nunca [attr:COLOR].",
    "",
    "IDS VÁLIDOS PARA fatosUsados (COPIE EXATAMENTE um valor desta lista; não traduza, não renomeie, não invente — " +
      "nunca \"category\", nunca \"attr:BRAND\"):",
    ...Array.from(ficha.idsConhecidos).map((id) => "- " + id),
    "",
    "Responda SOMENTE com este JSON:",
    '{ "descricao": "texto da descrição, com \\n entre as linhas", "fatosUsados": ["identificadores dos fatos que você usou, sem colchetes"] }'
  );
  return linhas.join("\n");
}

// -----------------------------------------------------------------------------
// gerarDescricao — uma chamada ao LLM e a validação. Nunca lança.
//   { ok:true,  descricao, chars, limite, fatosUsados:[{ id, label, value }], itensRemovidos? }
//   { ok:false, codigo, motivo, problemas?, itensRemovidos? }
//   itensRemovidos (F7A.8): itens que a poda tirou (repetiam a introdução ou eram irrelevantes).
//   removidosDoNome (F7A.11): trechos em conflito tirados da 1ª linha.
//   avisos (F7B): correções SOFT aplicadas (trecho removido, rótulo removido…) e avisos.
//   problemas (F7B): só os problemas HARD que bloquearam.
//   nomeNeutro (F7A.12): nome montado de fatos quando a limpeza deixou a 1ª linha sem tipo de produto.
//   itensRemovidos também traz os itens duplicados (F7A.12).
//     codigo: FATOS_INSUFICIENTES · DESCRICAO_ATUAL_INDISPONIVEL · IA_ERRO ·
//             AI_RESPONSE_TRUNCATED · JSON_INVALIDO · (demais do provider) ·
//             RESPOSTA_INVALIDA · DESCRICAO_INVALIDA
// -----------------------------------------------------------------------------
async function gerarDescricao({ ficha, aiProvider }) {
  // Não dá para saber o que o anúncio tem hoje: uma sugestão poderia apagar
  // conteúdo real (e o front bloqueia a edição nesse estado). Não gasta IA.
  if (ficha.descricaoAtual.estado === "erro") {
    return {
      ok: false, codigo: "DESCRICAO_ATUAL_INDISPONIVEL",
      motivo: "Não foi possível ler a descrição atual no Mercado Livre. Tente novamente em instantes.",
    };
  }
  if (!ficha.suficiente) {
    return {
      ok: false, codigo: "FATOS_INSUFICIENTES",
      motivo: "Este anúncio tem poucos dados confiáveis para uma descrição útil. Preencha a ficha técnica e tente de novo.",
    };
  }

  let ia;
  try {
    ia = await aiProvider.gerarJSON({
      task: AI_TASKS.SEO_DESCRIPTION,
      system: SYSTEM,
      prompt: montarPrompt(ficha),
      maxTokens: 1800,
      temperature: 0.6,
    });
  } catch (err) {
    return { ok: false, codigo: "IA_ERRO", motivo: "Falha ao consultar a IA." };
  }
  if (!ia || !ia.ok) {
    const codigo = (ia && ia.codigo) || "IA_ERRO";
    const motivo = codigo === "AI_RESPONSE_TRUNCATED"
      ? "A resposta da IA veio cortada. Tente gerar novamente."
      : (ia && ia.erro) || "Falha ao gerar a descrição com a IA.";
    return { ok: false, codigo, motivo };
  }
  const d = ia.data;
  if (!d || typeof d !== "object" || typeof d.descricao !== "string") {
    return { ok: false, codigo: "RESPOSTA_INVALIDA", motivo: "A IA não devolveu a descrição no formato esperado." };
  }

  // Conflitos de fonte seguem na resposta (só quando existem) para o front
  // poder sinalizar o dado inconsistente.
  const conflitos = (ficha.conflitos || []).length
    ? { conflitos: ficha.conflitos.map((c) => ({ id: c.id, label: c.label, value: c.value, fonte: c.fonte, trecho: c.trecho })) }
    : {};

  // F7A.8 — itens repetidos/irrelevantes saem antes da validação (só remoção).
  const poda = podarItens(d.descricao, ficha);
  // F7A.11 — trecho em conflito sai da 1ª linha (nome copiado do título).
  const nomeLimpo = limparNomeConflitante(poda.descricao, ficha);
  // F7A.12 — duplicados saem e as seções ficam na ordem fixa.
  const arrumada = arrumarEstrutura(nomeLimpo.descricao);
  poda.descricao = arrumada.descricao;
  const removidosTodos = poda.removidos.concat(arrumada.duplicados);
  const podados = {
    ...(removidosTodos.length ? { itensRemovidos: removidosTodos } : {}),
    ...(nomeLimpo.removidos.length ? { removidosDoNome: nomeLimpo.removidos } : {}),
    ...(nomeLimpo.nomeNeutro ? { nomeNeutro: nomeLimpo.nomeNeutro } : {}),
  };

  // F7B — problema SOFT é corrigido (remoção/correção determinística) e o
  // texto é revalidado; só problema HARD descarta a geração.
  const v = validarComCorrecoes(poda.descricao, d.fatosUsados, ficha);
  const avisos = v.avisos && v.avisos.length ? { avisos: v.avisos } : {};
  if (!v.valida) {
    const bloqueios = v.hard && v.hard.length ? v.hard : v.problemas;
    return {
      ok: false,
      codigo: "DESCRICAO_INVALIDA",
      motivo: "A descrição gerada não passou na validação: " + bloqueios.map((p) => p.detalhe).join(" ") +
        " Tente gerar novamente.",
      problemas: bloqueios,
      ...conflitos,
      ...podados,
      ...avisos,
    };
  }

  // F10 — polimento editorial (só forma; cada regra revalidada).
  const polida = polirDescricao(v.descricao, v.fatosUsados, ficha);
  return {
    ...conflitos,
    ...podados,
    ...avisos,
    ...(polida.ajustes.length ? { ajustesEditoriais: polida.ajustes } : {}),
    ok: true,
    descricao: polida.descricao,
    chars: polida.chars,
    limite: ficha.limite,
    fatosUsados: descreverFatosUsados(polida.fatosUsados, ficha),
  };
}

// ids de fatosUsados → { id, label, value } do contrato da rota.
function descreverFatosUsados(ids, ficha) {
  const porId = new Map(ficha.fatos.map((f) => [f.id, f]));
  return (ids || []).map((id) => {
    const f = porId.get(id);
    if (f) return { id, label: f.label, value: f.value };
    if (id === "categoria") return { id, label: "Categoria", value: ficha.categoria };
    if (id === "contexto:titulo") return { id, label: "Título atual", value: null };
    if (id === "contexto:descricao_atual") return { id, label: "Descrição atual", value: null };
    const p = ficha.proibidos.find((x) => x.id === id);
    return { id, label: p ? p.label : id, value: p ? p.value : null };
  });
}

module.exports = {
  montarFicha,
  montarPrompt,
  validarDescricao,
  validarComCorrecoes,
  fatosPresentes,
  fatosPerdidos,
  fatoDoErro,
  polirDescricao,
  severidade,
  podarItens,
  limparNomeConflitante,
  arrumarEstrutura,
  normalizarIdFato,
  termosNaoComprovados,
  gerarDescricao,
  descreverFatosUsados,
  extrairNumeros,
  SYSTEM,
  LIMITE_ML_PADRAO,
  TETO_OPERACIONAL,
  MIN_FATOS,
  PALAVRAS_FUNCIONAIS,
  VOCABULARIO_NEUTRO,
  VOCABULARIO_SUBJETIVO,
  ATRIBUTOS_SEM_AUTORIDADE,
  // Autorreparo (descricaoReparo.js) — só leitura dos mesmos auxiliares que a
  // correção SOFT usa.
  CODIGOS_HARD,
  segmentosDe,
  segmentoTem,
  linhasPorSecao,
  partesDaDescricao,
  normalizarTexto,
  removerFragmento,
};
