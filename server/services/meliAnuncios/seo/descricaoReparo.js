// server/services/meliAnuncios/seo/descricaoReparo.js
// -----------------------------------------------------------------------------
// Autorreparo da descrição (F13/F14). A rota POST /seo/descricao chama
// gerarDescricaoSeo: com a flag SEO_DESCRICAO_AUTORREPARO desligada (padrão)
// é exatamente descricaoEngine.gerarDescricao; ligada, roda o pipeline abaixo.
//
//   geração (a mesma de produção) → validação
//     → A) reparo localizado: HARD em frase independente e dispensável →
//          remove só a frase → revalida (determinístico, sem IA)
//     → B) HARD de fato estrutural (marca, quantidade/kit, material, medida,
//          compatibilidade, composição…) ou A que não deu certo → no máximo UMA
//          chamada de reparo à IA, RESTRITA AOS SEGMENTOS rejeitados: a IA
//          devolve só a troca de cada trecho [S1…] e o sistema aplica no lugar
//          (o resto fica idêntico por construção) → revalida tudo → fato
//          válido sem relação com o erro que sumiu reprova (FATO_PERDIDO)
//     → C) ainda inválida → a mesma rejeição de hoje
//
// Fato estrutural NUNCA é removido em silêncio: a remoção (A) só vale para
// frase de claim/linguagem que não carrega número, marca nem quantidade e
// não está em ESPECIFICAÇÕES.
// -----------------------------------------------------------------------------

const eng = require("./descricaoEngine");
const seo = require("./seoText");
const { AI_TASKS } = require("../../ai/aiTasks");

// HARD que é afirmação/linguagem dispensável — candidata a remoção localizada.
const HARD_LOCALIZAVEIS = new Set([
  "CLAIM_OBJETIVO_SEM_FONTE", "CLAIM_COMERCIAL_SEM_FONTE", "CLAIM_NAO_SUSTENTADO",
  "LINGUAGEM_PROIBIDA", "URL", "EMAIL", "TELEFONE", "CONTATO_EXTERNO",
]);
// Mesmo dentro de um código localizável, compatibilidade é fato estrutural.
const RE_ESTRUTURAL_NO_TERMO = /compat|serve em|encaixa|kit|unidade|peca|par\b|\d/;
// Frase que fala de fato estrutural não é dispensável.
const RE_FRASE_ESTRUTURAL = /\d|\bkit\b|\bunidades?\b|\bpe[cç]as?\b|\bpares?\b|compat[ií]vel|compatibilidade/i;

const MAX_REMOCOES = 2;

function semAcento(s) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

// O mesmo pós-processamento de gerarDescricao (poda → nome → estrutura →
// validação com correções SOFT).
function posProcessar(texto, fatosUsados, ficha) {
  const poda = eng.podarItens(texto, ficha);
  const nomeLimpo = eng.limparNomeConflitante(poda.descricao, ficha);
  const arrumada = eng.arrumarEstrutura(nomeLimpo.descricao);
  return eng.validarComCorrecoes(arrumada.descricao, fatosUsados, ficha);
}

function hardDe(v, ficha) {
  if (v.valida) return [];
  return (v.hard && v.hard.length ? v.hard : v.problemas).filter((p) => eng.severidade(p, ficha) === "hard" ||
    eng.CODIGOS_HARD.has(p.codigo));
}

function ehLocalizavel(p) {
  if (!HARD_LOCALIZAVEIS.has(p.codigo)) return false;
  return !(p.termos || []).some((t) => RE_ESTRUTURAL_NO_TERMO.test(semAcento(t)));
}

// Segmentos (frase/item) onde o problema está. Sem termos (URL, telefone…),
// acha por tentativa: o segmento cuja remoção sozinha faz o código sumir.
function localizar(descricao, p, ficha) {
  const segs = eng.segmentosDe(descricao);
  let alvos = (p.termos && p.termos.length) ? segs.filter((s) => eng.segmentoTem(s, p)) : [];
  if (!alvos.length) {
    alvos = segs.filter((s) => (s.tipo === "frase" || s.tipo === "item") &&
      !eng.validarDescricao(removerSegmentos(descricao, [s]), [], ficha).problemas
        ?.some((q) => q.codigo === p.codigo));
    alvos = alvos.slice(0, 1);
  }
  return alvos;
}

function removerSegmentos(descricao, segs) {
  const linhas = descricao.split("\n");
  for (const seg of segs) {
    if (linhas[seg.i] == null) continue;
    linhas[seg.i] = seg.tipo === "item" ? null : linhas[seg.i].replace(seg.texto, "").replace(/\s{2,}/g, " ").trim();
  }
  return eng.normalizarTexto(linhas.filter((l) => l !== null).join("\n"));
}

// Palavras de conteúdo (sem "com", "um", "que"…) com 3+ letras.
const FUNCIONAIS = new Set([...eng.PALAVRAS_FUNCIONAIS, "com", "sem"].map((w) => seo.normalizeText(w)));
const chavesConteudo = (t) => seo.extractTokens(String(t || ""))
  .filter((x) => !x.stopword && x.key.length >= 3 && !FUNCIONAIS.has(seo.normalizeText(x.original))).map((x) => x.key);

// Palavras que carregam fato do produto: valores dos fatos estruturados
// ("Ferro fundido", "USB") e, para booleano "Sim", a característica do nome
// ("Inclui protetor" → protetor). O tipo do produto (categoria, 1ª palavra do
// título) não conta: citá-lo não torna a frase essencial.
function chavesDeFato(ficha) {
  const genericas = new Set(chavesConteudo((ficha.categoria || "") + " " + (chavesConteudo(ficha.tituloAtual || "")[0] || "")));
  const out = new Set();
  for (const f of ficha.fatos || []) {
    const v = String(f.value == null ? "" : f.value);
    const fonte = /^(sim|nao|não)$/i.test(v.trim()) ? (/^sim$/i.test(v.trim()) ? f.label : "") : v;
    for (const k of chavesConteudo(fonte)) if (!genericas.has(k)) out.add(k);
  }
  return out;
}

// A frase é independente e dispensável? Fora de ESPECIFICAÇÕES, frase ou item
// (nunca nome/título de seção), e SEM fato do produto: número, quantidade,
// marca, compatibilidade ou qualquer valor de atributo (material, conexão,
// componente…). Frase com fato vai para o reparo (B), nunca some calada.
function dispensavel(descricao, seg, ficha) {
  if (seg.tipo !== "frase" && seg.tipo !== "item") return false;
  const secao = (eng.linhasPorSecao(descricao)[seg.i] || {}).secao;
  if (secao === "especificacoes") return false;
  if (RE_FRASE_ESTRUTURAL.test(seg.texto)) return false;
  if (ficha.marca && semAcento(seg.texto).includes(semAcento(ficha.marca))) return false;
  const fatos = chavesDeFato(ficha);
  if (chavesConteudo(seg.texto).some((k) => fatos.has(k))) return false;
  return true;
}

// A) Reparo localizado. → { ok, descricao?, removidas, motivo? }
function repararLocalmente(rejeitada, hard, ficha, fatosUsados) {
  if (!hard.length || !hard.every(ehLocalizavel)) return { ok: false, removidas: [], motivo: "HARD_ESTRUTURAL" };
  const segs = [];
  for (const p of hard) {
    const alvos = localizar(rejeitada, p, ficha);
    if (!alvos.length) return { ok: false, removidas: [], motivo: "NAO_LOCALIZADO:" + p.codigo };
    for (const s of alvos) {
      if (!dispensavel(rejeitada, s, ficha)) return { ok: false, removidas: [], motivo: "TRECHO_NAO_DISPENSAVEL:" + p.codigo };
      if (!segs.some((x) => x.i === s.i && x.texto === s.texto)) segs.push({ ...s, codigo: p.codigo });
    }
  }
  if (segs.length > MAX_REMOCOES) return { ok: false, removidas: [], motivo: "REMOCOES_DEMAIS:" + segs.length };
  const texto = removerSegmentos(rejeitada, segs);
  if (!eng.partesDaDescricao(texto).introducao) return { ok: false, removidas: [], motivo: "ESVAZIARIA_ABERTURA" };
  const v = eng.validarComCorrecoes(texto, fatosUsados, ficha);
  const removidas = segs.map((s) => ({ codigo: s.codigo, trecho: s.texto }));
  if (!v.valida) return { ok: false, removidas, motivo: "REVALIDACAO:" + hardDe(v, ficha).map((p) => p.codigo).join(","), v };
  return { ok: true, removidas, v };
}

// -----------------------------------------------------------------------------
// Fatos do produto presentes num texto. Um fato está presente quando todas as
// palavras de conteúdo do valor (ou do rótulo, para booleano "Sim") e todos os
// números dele aparecem no texto. Base da preservação factual: um fato que
// estava na descrição rejeitada e não tem relação com o erro tem de continuar.
// -----------------------------------------------------------------------------
// O mesmo critério lexical da primeira geração, sem duplicação/circularidade.
const { fatosPresentes, fatosPerdidos, fatoDoErro } = eng;

// -----------------------------------------------------------------------------
// B) Reparo RESTRITO A SEGMENTOS. A IA não reescreve a descrição: recebe os
// trechos rejeitados numerados ([S1]…) e devolve só a troca de cada um. O
// sistema aplica as trocas no lugar exato; todo o resto do texto fica idêntico
// por construção.
// -----------------------------------------------------------------------------

// Problemas que o reparo precisa resolver: todo HARD e também todo SOFT que
// aponta termos num trecho. Sem isso, depois do reparo a correção SOFT de
// produção apaga o ITEM inteiro por um termo ("Composição: 100% algodão, sem
// lycra" some por causa de "lycra") — fato válido perdido e trecho fora do
// autorizado alterado. CORRECAO_EXCESSIVA não tem trecho: o que a causou são
// esses mesmos SOFT. SOFT sem termo (formatação, fatosUsados…) fica com a
// correção determinística de sempre.
function problemasAlvo(v0, hard) {
  const hardSet = new Set(hard);
  const soft = (v0.problemas || []).filter((p) => !hardSet.has(p) && p.codigo !== "CORRECAO_EXCESSIVA" && (p.termos || []).length);
  return hard.filter((p) => p.codigo !== "CORRECAO_EXCESSIVA").concat(soft.map((p) => ({ ...p, soft: true })));
}

// Segmentos autorizados, em ordem do texto, cada um com os problemas dele.
// Problema sem trecho (KIT_OMITIDO: falta algo) autoriza a 1ª frase da
// abertura, onde o dado tem de entrar. Título de seção nunca é autorizado.
function segmentosAutorizados(rejeitada, problemas, ficha) {
  const segs = eng.segmentosDe(rejeitada);
  const abertura = segs.find((s) => s.tipo === "frase");
  const porChave = new Map();
  const naoLocalizados = [];
  for (const p of problemas) {
    let alvos = (p.soft ? (p.termos || []).length ? eng.segmentosDe(rejeitada).filter((s) => eng.segmentoTem(s, p)) : []
      : localizar(rejeitada, p, ficha)).filter((s) => s.tipo !== "secao");
    if (!alvos.length && !p.soft && (p.codigo === "KIT_OMITIDO" || !(p.termos || []).length) && abertura) alvos = [abertura];
    if (!alvos.length) { if (!p.soft) naoLocalizados.push(p.codigo); continue; }
    for (const s of alvos) {
      const k = s.i + "|" + s.texto;
      if (!porChave.has(k)) porChave.set(k, { ...s, problemas: [] });
      porChave.get(k).problemas.push(p);
    }
  }
  const ordem = segs.map((s) => s.i + "|" + s.texto);
  const lista = Array.from(porChave.entries()).sort((a, b) => ordem.indexOf(a[0]) - ordem.indexOf(b[0])).map(([, s]) => s);
  lista.forEach((s, n) => { s.id = "S" + (n + 1); });
  return { segmentos: lista, naoLocalizados };
}

const semMarcador = (t) => t.replace(/^[-•*–]\s*/, "");

function montarPromptReparo(ficha, rejeitada, segmentos) {
  const base = eng.montarPrompt(ficha).replace(
    "Tarefa: escrever UMA descrição para este anúncio.",
    "Tarefa: CORRIGIR apenas os TRECHOS listados no fim de uma descrição que foi REJEITADA pela checagem de fatos. " +
      "Use somente os fatos e o contexto listados."
  );
  const blocos = segmentos.map((s) => {
    const fatos = fatosPresentes(s.texto, ficha).filter((f) => !fatoDoErro(f, s.problemas));
    return [
      "[" + s.id + "] " + (s.tipo === "item" ? "(item de lista) " : "") + '"' + semMarcador(s.texto) + '"',
      ...s.problemas.map((p) => "  Problema " + p.codigo + ": " + p.detalhe +
        (p.codigo === "KIT_OMITIDO" ? " Inclua neste trecho a quantidade exata: " + ficha.kit.n + " unidades." : "") +
        (p.termos && p.termos.length && p.codigo !== "KIT_OMITIDO" ? " Termos: " + p.termos.join(", ") + "." : "")),
      "  Fatos deste trecho que DEVEM continuar nele: " + (fatos.length ? fatos.map((f) => f.label + ": " + f.value).join("; ") : "(nenhum)"),
      ...(soRetirar(s) ? ["  Como corrigir ESTE trecho: só RETIRE o fragmento sem fonte. Não acrescente nenhuma palavra nova e não troque por outro benefício."] : []),
    ].join("\n");
  });
  return base + "\n\n" + [
    "DESCRIÇÃO REJEITADA (só contexto — NÃO a reescreva; o sistema mantém todo o resto idêntico):",
    '"""', rejeitada, '"""',
    "",
    "TRECHOS A CORRIGIR (só estes podem mudar):",
    ...blocos,
    "",
    "Como corrigir:",
    "- Devolva a nova versão de CADA trecho listado, pelo id. Nada fora deles muda.",
    "- Corrija só a parte que causou o problema; o resto do trecho fica igual, palavra por palavra.",
    "- Todo fato listado em \"DEVEM continuar\" fica no trecho reescrito, com o mesmo valor.",
    "- Se o trecho for só o problema e não tiver fato a manter, devolva texto vazio \"\" para retirá-lo.",
    "- Item de lista continua item curto (sem o marcador; o sistema mantém o \"* \"). Frase continua frase completa.",
    "- NÃO introduza nenhum fato novo: nenhuma marca, número, medida, material, quantidade, compatibilidade ou característica " +
      "que não esteja nos FATOS ou no contexto acima. Se um dado não está nos fatos, retire a afirmação; nunca troque por outro dado.",
    "- Responda só JSON: { \"trocas\": [ { \"id\": \"S1\", \"texto\": \"…\" } ] }",
  ].join("\n");
}

// Aplica as trocas no lugar de cada segmento. → { texto, faltando: [id] }
function aplicarTrocas(rejeitada, segmentos, trocas) {
  const porId = new Map((Array.isArray(trocas) ? trocas : []).filter((t) => t && typeof t.id === "string" && typeof t.texto === "string")
    .map((t) => [t.id.trim().replace(/^\[|\]$/g, ""), t.texto.trim()]));
  const linhas = rejeitada.split("\n");
  const faltando = [];
  // de trás para frente: várias frases da mesma linha não se atrapalham
  for (const s of segmentos.slice().reverse()) {
    if (!porId.has(s.id)) { faltando.push(s.id); continue; }
    let novo = porId.get(s.id).replace(/\s*\n\s*/g, " ");
    if (s.tipo === "item") {
      novo = semMarcador(novo);
      linhas[s.i] = novo ? (/^\s*[-•*–]\s*/.exec(linhas[s.i]) || ["* "])[0] + novo : null;
    } else {
      if (novo && /[.!?]$/.test(s.texto) && !/[.!?]$/.test(novo)) novo += ".";
      linhas[s.i] = linhas[s.i].replace(s.texto, novo).replace(/\s{2,}/g, " ").trim();
    }
  }
  return { texto: eng.normalizarTexto(linhas.filter((l) => l !== null).join("\n")), faltando };
}

// Afirmação/linguagem sem fonte: a correção é RETIRAR o fragmento, nunca
// trocar por outro benefício.
const CODIGOS_SO_RETIRAR = new Set([
  "CLAIM_COMERCIAL_SEM_FONTE", "CLAIM_OBJETIVO_SEM_FONTE", "CLAIM_NAO_SUSTENTADO", "CLAIM_TECNICO_HERDADO",
  "LINGUAGEM_PROIBIDA", "PROPAGANDA_HERDADA", "VOZ_DA_LOJA",
]);
const soRetirar = (s) => s.problemas.every((p) => CODIGOS_SO_RETIRAR.has(p.codigo));
const NEUTRAS = new Set([...eng.PALAVRAS_FUNCIONAIS, ...eng.VOCABULARIO_NEUTRO, "com", "sem"].map((w) => seo.normalizeText(w)));
const palavrasNovas = (antes, depois, ficha) => {
  const a = new Set(chavesConteudo(antes));
  const fatos = chavesDeFato(ficha);
  return seo.extractTokens(String(depois || "")).filter((x) => !x.stopword && x.key.length >= 3 && !NEUTRAS.has(seo.normalizeText(x.original)) &&
    !a.has(x.key) && !fatos.has(x.key)).map((x) => x.original);
};

// Troca da IA num trecho de afirmação que traz palavra nova (outro benefício)
// é descartada: no lugar, tira só a oração com o termo (determinístico); se
// não der e o trecho não tiver fato do produto, o trecho sai inteiro; se tiver
// fato, a troca da IA fica (a revalidação completa e a guarda de fato seguem).
function conterTrocaDeAfirmacao(seg, troca, ficha) {
  if (!soRetirar(seg) || troca.depois == null) return troca;
  const novas = palavrasNovas(seg.texto, troca.depois, ficha);
  if (!novas.length) return troca;
  let texto = seg.texto;
  for (const p of seg.problemas) {
    if (!eng.segmentoTem({ texto }, p)) continue;
    texto = eng.removerFragmento(texto, p);
    if (!texto) break;
  }
  if (texto) return { ...troca, depois: semMarcador(texto), ia: troca.depois, contida: "FRAGMENTO", novas };
  const temFato = chavesConteudo(seg.texto).some((k) => chavesDeFato(ficha).has(k)) || RE_FRASE_ESTRUTURAL.test(seg.texto);
  if (!temFato) return { ...troca, depois: "", ia: troca.depois, contida: "TRECHO", novas };
  return { ...troca, novas, contida: null };
}

// Polimento editorial (F10) sem perder fato: se uma regra tirou um atributo
// que estava no texto validado ("Sem validade"), fica o texto sem polimento.
function polirSemPerder(v, ficha) {
  const polida = eng.polirDescricao(v.descricao, v.fatosUsados, ficha);
  if (fatosPerdidos(v.descricao, polida.descricao, ficha, []).length) return { descricao: v.descricao, chars: v.descricao.length, semPolimento: true };
  return polida;
}

// Pipeline completo. Nunca lança.
//   { ok, etapa: primeira|remocao|reparo_ia|falha|erro, chamadasIa, removidas,
//     hardIniciais, hardFinais, rejeitada?, descricao?, chars?, producao }
async function gerarDescricaoComReparo({ ficha, aiProvider }) {
  let bruto = null;
  let chamadasIa = 0;
  const captura = {
    async gerarJSON(opts) {
      chamadasIa += 1;
      const r = await aiProvider.gerarJSON(opts);
      if (r && r.ok) bruto = r.data;
      return r;
    },
  };
  const producao = await eng.gerarDescricao({ ficha, aiProvider: captura });
  const base = { chamadasIa, removidas: [], hardIniciais: [], hardFinais: [], producao };
  if (producao.ok) return { ...base, ok: true, etapa: "primeira", descricao: producao.descricao, chars: producao.chars };
  if (producao.codigo !== "DESCRICAO_INVALIDA" || !bruto) return { ...base, ok: false, etapa: "erro", codigo: producao.codigo };

  // Reconstrói o texto exatamente como a validação o rejeitou (determinístico).
  const v0 = posProcessar(bruto.descricao, bruto.fatosUsados, ficha);
  const rejeitada = v0.descricao;
  const hard = hardDe(v0, ficha);
  const hardIniciais = hard.map((p) => p.codigo);

  // A) reparo localizado
  const local = repararLocalmente(rejeitada, hard, ficha, v0.fatosUsados || bruto.fatosUsados);
  // Zero atributo factual pode sumir: se a correção SOFT que roda depois da
  // remoção levou um fato junto, a remoção não vale e o caso vai para o reparo.
  if (local.ok && fatosPerdidos(rejeitada, local.v.descricao, ficha, hard).length) {
    local.ok = false;
    local.motivo = "FATO_PERDIDO_NA_REMOCAO";
  }
  if (local.ok) {
    const polida = polirSemPerder(local.v, ficha);
    return { ...base, ok: true, etapa: "remocao", hardIniciais, rejeitada, removidas: local.removidas,
      validada: local.v.descricao, descricao: polida.descricao, chars: polida.chars, ...contratoAprovada(local.v, polida) };
  }

  // B) UMA chamada de reparo, restrita aos segmentos rejeitados
  const problemas = problemasAlvo(v0, hard);
  const { segmentos, naoLocalizados } = segmentosAutorizados(rejeitada, problemas, ficha);
  const comum = { ...base, hardIniciais, rejeitada, motivoLocal: local.motivo,
    autorizados: segmentos.map((s) => ({ id: s.id, texto: s.texto, codigos: s.problemas.map((p) => p.codigo) })) };
  if (!segmentos.length || naoLocalizados.length) {
    return { ...comum, ok: false, etapa: "falha", codigoReparo: "NAO_LOCALIZADO:" + naoLocalizados.join(","), hardFinais: hardIniciais };
  }
  let ia;
  try {
    chamadasIa += 1;
    ia = await aiProvider.gerarJSON({
      task: AI_TASKS.SEO_DESCRIPTION,
      system: eng.SYSTEM,
      prompt: montarPromptReparo(ficha, rejeitada, segmentos),
      maxTokens: 1200,
      temperature: 0.2,
    });
  } catch (e) {
    ia = { ok: false, codigo: "IA_ERRO" };
  }
  if (!ia || !ia.ok || !ia.data || !Array.isArray(ia.data.trocas)) {
    return { ...comum, chamadasIa, ok: false, etapa: "falha", codigoReparo: (ia && ia.codigo) || "RESPOSTA_INVALIDA", hardFinais: hardIniciais };
  }
  const trocas = segmentos.map((s) => {
    const t = ia.data.trocas.find((x) => x && String(x.id).replace(/^\[|\]$/g, "").trim() === s.id);
    return conterTrocaDeAfirmacao(s, { id: s.id, antes: s.texto, depois: t ? String(t.texto) : null }, ficha);
  });
  const aplicada = aplicarTrocas(rejeitada, segmentos, trocas.filter((t) => t.depois != null).map((t) => ({ id: t.id, texto: t.depois })));
  const usados = v0.fatosUsados || bruto.fatosUsados;
  const v1 = eng.validarComCorrecoes(aplicada.texto, usados, ficha);
  const fim = { ...comum, chamadasIa, trocas, aplicada: aplicada.texto, faltando: aplicada.faltando };
  if (!v1.valida) {
    return { ...fim, ok: false, etapa: "falha", reparada: v1.descricao, hardFinais: hardDe(v1, ficha).map((p) => p.codigo),
      problemasFinais: hardDe(v1, ficha) };
  }
  // Preservação factual: fato válido que não tem relação com o erro e saiu → reprova.
  const perdidos = fatosPerdidos(rejeitada, v1.descricao, ficha, problemas);
  if (perdidos.length) {
    return { ...fim, ok: false, etapa: "falha", reparada: v1.descricao, hardFinais: ["FATO_PERDIDO"], fatosPerdidos: perdidos };
  }
  const polida = polirSemPerder(v1, ficha);
  return { ...fim, ok: true, etapa: "reparo_ia", validada: v1.descricao, descricao: polida.descricao, chars: polida.chars,
    ...contratoAprovada(v1, polida) };
}

// O que a rota precisa de uma versão aprovada (mesmos campos de gerarDescricao).
function contratoAprovada(v, polida) {
  return {
    fatosUsadosIds: polida.fatosUsados || v.fatosUsados || [],
    avisos: v.avisos || [],
    ajustesEditoriais: polida.ajustes || [],
  };
}

// -----------------------------------------------------------------------------
// Flag do autorreparo na rota. Desligado por padrão: só "1", "true" ou "on"
// em SEO_DESCRICAO_AUTORREPARO ligam; qualquer outro valor = desligado.
// -----------------------------------------------------------------------------
const ENV_AUTORREPARO = "SEO_DESCRICAO_AUTORREPARO";
function autorreparoAtivo(env = process.env) {
  return ["1", "true", "on"].includes(String(env[ENV_AUTORREPARO] || "").trim().toLowerCase());
}

// -----------------------------------------------------------------------------
// gerarDescricaoSeo — o que a rota POST /seo/descricao chama. Nunca lança.
//   flag OFF → exatamente descricaoEngine.gerarDescricao (1 chamada à IA).
//   flag ON  → gerarDescricaoComReparo (no máximo 1 chamada de reparo):
//     · aprovada na 1ª, erro da IA, FATOS_INSUFICIENTES etc. → a resposta da
//       produção, sem mudança;
//     · reparada (remoção localizada ou reparo restrito aos trechos) → o
//       contrato ok da produção + autorreparo { etapa, removidas | trocas };
//     · o reparo não resolveu → a MESMA rejeição da produção (DESCRICAO_INVALIDA,
//       problemas da 1ª geração) + autorreparo { etapa:"falha", codigo }.
// -----------------------------------------------------------------------------
async function gerarDescricaoSeo({ ficha, aiProvider, env = process.env }) {
  if (!autorreparoAtivo(env)) return eng.gerarDescricao({ ficha, aiProvider });
  let r;
  try {
    r = await gerarDescricaoComReparo({ ficha, aiProvider });
  } catch (e) {
    // Defesa: o pipeline não lança, mas se lançar a rota não pode cair.
    return { ok: false, codigo: "IA_ERRO", motivo: "Falha ao gerar a descrição com a IA." };
  }
  const prod = r.producao;
  if (r.etapa === "primeira" || r.etapa === "erro") return prod;
  if (!r.ok) {
    const codigo = r.codigoReparo || (r.hardFinais || []).join(",") || "REPARO_INVALIDO";
    return { ...prod, autorreparo: { etapa: "falha", codigo, chamadasIa: r.chamadasIa } };
  }
  // Mesmos campos que a produção devolveria se a 1ª versão tivesse passado:
  // conflitos e o que a poda tirou vêm da 1ª geração; avisos, ajustes e fatos
  // da versão reparada.
  const herdados = {};
  for (const k of ["conflitos", "itensRemovidos", "removidosDoNome", "nomeNeutro"]) if (prod[k] !== undefined) herdados[k] = prod[k];
  const autorreparo = r.etapa === "remocao"
    ? { etapa: "remocao", chamadasIa: r.chamadasIa, removidas: r.removidas }
    : { etapa: "reparo_ia", chamadasIa: r.chamadasIa,
      trocas: r.trocas.filter((t) => t.depois != null).map((t) => ({ id: t.id, antes: t.antes, depois: t.depois, ...(t.contida ? { contida: t.contida } : {}) })) };
  return {
    ...herdados,
    ...(r.avisos.length ? { avisos: r.avisos } : {}),
    ...(r.ajustesEditoriais.length ? { ajustesEditoriais: r.ajustesEditoriais } : {}),
    ok: true,
    descricao: r.descricao,
    chars: r.chars,
    limite: ficha.limite,
    fatosUsados: eng.descreverFatosUsados(r.fatosUsadosIds, ficha),
    autorreparo,
  };
}

module.exports = {
  gerarDescricaoSeo,
  autorreparoAtivo,
  ENV_AUTORREPARO,
  gerarDescricaoComReparo,
  repararLocalmente,
  montarPromptReparo,
  segmentosAutorizados,
  aplicarTrocas,
  fatosPresentes,
  fatosPerdidos,
  polirSemPerder,
  conterTrocaDeAfirmacao,
  ehLocalizavel,
  dispensavel,
  HARD_LOCALIZAVEIS,
  MAX_REMOCOES,
};
