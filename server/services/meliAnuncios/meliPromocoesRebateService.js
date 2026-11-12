// server/services/meliAnuncios/meliPromocoesRebateService.js
// -----------------------------------------------------------------------------
// Módulo: Anúncios Meli — "Promoções com rebate"
// (contrato: docs/specs/2026-10-15-anuncios-ml-promocoes-rebate.md).
//
// Para os anúncios que JÁ estão numa promoção de referência (em geral a
// "Vendex" do mês), procura promoções com SUBSÍDIO do Mercado Livre que deixem
// o anúncio com margem e/ou lucro maiores do que tem hoje na referência — e,
// só com a confirmação do usuário, faz o anúncio participar delas.
//
// Disparado SÓ por clique. Nada de cron, worker agendado ou piloto automático:
// o job nasce numa requisição, roda em background no mesmo processo e morre
// com ela (job 'processando' sem atualização há mais de 10 min = 'erro').
//
// Base da comparação = a promoção que forma o preço HOJE (sale_price →
// statusExibicao "ATIVA"): a referência ou uma promoção com rebate em que o
// anúncio já entrou. Candidata precisa ser mais barata que ESSE preço.
//
// Peças reaproveitadas (nenhuma fórmula nova):
//   promoções do item ..... meliPromocoesService.listarPromocoesDoItemDetalhado
//                           (mesma leitura ao vivo do modal, sem engolir 429)
//   comissão/frete em P' .. margemCotacaoEmP.criarCotadorEmP (cotação REAL; falha
//                           NUNCA vira estimativa → COTACAO_INDISPONIVEL)
//   margem/lucro .......... core.calcularComposicao → marginEngine.computeMargin,
//                           a mesma composição do cenário de preço do
//                           margemSimularService (custo/alíquota/taxa fixa da
//                           Base + comissão/frete cotados no preço + rebate)
//   custo/alíquota/taxa ... Motor de Margem (prepareWorkspaceContext +
//                           enrichBatch), origem "projected" — a mesma Base que
//                           o modal usa (extrairValoresBaseParaSimulacao)
//   escrita ............... meliPromocoesEscritaService.participarPromocaoAceite
//                           com `antesDeEscrever` revalidando na releitura
//
// A promoção de referência NUNCA é tocada (nem PUT, nem DELETE): ela é a rede
// de segurança — quando a promoção com rebate acaba, o anúncio volta ao preço
// da referência. Só existe POST de participação em candidatas ACEITE.
// -----------------------------------------------------------------------------

const pool = require("../../config/database");
const core = require("../motorMargem/core");
const { criarCotadorEmP, mapComLimite } = require("../motorMargem/margemCotacaoEmP");
const { rotuloTipoPromocao } = require("./meliPromocoesService");
const { TIPOS_ESCRITA_ACEITE } = require("./promocaoTiposSuportados");

// ─── Configuração ────────────────────────────────────────────────────────────
// Concorrência BAIXA com o ML: cada item já faz algumas chamadas (promoções do
// item + sale_price + vigências + 2 GETs por preço cotado).
const CONCORRENCIA_ITENS = Number(process.env.PROMO_REBATE_CONCORRENCIA || 3);
const LOTE_CUSTOS = 20; // teto do multiget do Motor (PAGE_LIMIT_MAX)
const JOB_ORFAO_MINUTOS = 10;
const LIMITE_PAGINA_ML = 50; // máximo documentado em gerenciar-ofertas.md
const MAX_PAGINAS_ML = 200;
const MAX_TENTATIVAS_429 = 3;
const MAX_ITEM_IDS = 5000;
const COTACAO_TIMEOUT_MS = 8000;

const STATUS_ATIVOS = new Set(["started", "active"]);
const STATUS_REFERENCIA_LISTAVEL = new Set(["started", "active", "pending"]);

const MOTIVOS = Object.freeze({
  SEM_CUSTO: "SEM_CUSTO",
  COTACAO_INDISPONIVEL: "COTACAO_INDISPONIVEL",
  FORA_DA_REFERENCIA: "FORA_DA_REFERENCIA",
  SEM_CANDIDATA: "SEM_CANDIDATA",
  PRECO_NAO_MENOR: "PRECO_NAO_MENOR",
  ERRO_ML: "ERRO_ML",
  // Aditivo ao contrato: o anúncio está na referência no ML mas não existe em
  // meli_anuncios (sem título/categoria/tipo para cotar) — sincronizar resolve.
  ANUNCIO_NAO_SINCRONIZADO: "ANUNCIO_NAO_SINCRONIZADO",
  // O preço de hoje já vem de OUTRA promoção com rebate (não a referência) e
  // nenhuma candidata melhora margem nem lucro sobre ela — vai para sem_ganho.
  JA_EM_REBATE_MELHOR: "JA_EM_REBATE_MELHOR",
});

const MOTIVO_TEXTO = Object.freeze({
  SEM_CUSTO: "Sem custo na Base de Custos — cadastre o custo para comparar a margem.",
  COTACAO_INDISPONIVEL: "O Mercado Livre não informou comissão ou frete neste preço — nada foi estimado.",
  FORA_DA_REFERENCIA: "O anúncio não está ativo na promoção de referência.",
  SEM_CANDIDATA: "Nenhuma promoção com subsídio do Mercado Livre disponível para este anúncio.",
  PRECO_NAO_MENOR: "As promoções com subsídio têm preço igual ou maior que o preço de hoje — o rebate nunca entraria.",
  ERRO_ML: "Não foi possível ler as promoções do anúncio no Mercado Livre.",
  ANUNCIO_NAO_SINCRONIZADO: "Anúncio não encontrado no VenForce — sincronize os anúncios deste cliente.",
  JA_EM_REBATE_MELHOR: "Já está numa promoção com rebate melhor — nenhuma outra melhora margem nem lucro.",
});

const STATUS_ITEM_ORDEM = { recomendado: 0, escolha: 1, sem_ganho: 2, descartado: 3 };

// ─── Utilitários puros ───────────────────────────────────────────────────────

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round2(v) {
  return v === null || v === undefined ? null : Math.round((v + Number.EPSILON) * 100) / 100;
}

// Preços e lucros são comparados em CENTAVOS — nunca em ponto flutuante cru.
function centavos(v) {
  const n = num(v);
  return n === null ? null : Math.round(n * 100);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunk(lista, tamanho) {
  const out = [];
  for (let i = 0; i < lista.length; i += tamanho) out.push(lista.slice(i, i + tamanho));
  return out;
}

function normalizarTexto(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

// ─── Referência padrão ("Vendex" do mês) ─────────────────────────────────────

const MESES_PT = [
  "janeiro", "fevereiro", "marco", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];

// Mês corrente em America/Sao_Paulo (1–12). Sem ICU de fuso disponível, cai no
// UTC−3 fixo (o Brasil não tem horário de verão desde 2019).
function mesAtualSaoPaulo(agora = new Date()) {
  try {
    const m = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", month: "numeric" }).format(agora));
    if (m >= 1 && m <= 12) return m;
  } catch (_) {
    // fallback abaixo
  }
  return new Date(agora.getTime() - 3 * 3600 * 1000).getUTCMonth() + 1;
}

function ehVendex(nome) {
  return /\bvendex\b/.test(normalizarTexto(nome));
}

// "Outubro - Vendex", "Vendex Outubro", "VENDEX - OUTUBRO" casam em outubro;
// "Vendex - Setembro" não. Sem acento e sem caixa, palavra inteira.
function ehVendexDoMes(nome, agora = new Date()) {
  if (!ehVendex(nome)) return false;
  const mes = MESES_PT[mesAtualSaoPaulo(agora) - 1];
  return new RegExp(`\\b${mes}\\b`).test(normalizarTexto(nome));
}

function tsInicio(r) {
  const t = r && r.inicio ? new Date(r.inicio).getTime() : NaN;
  return Number.isFinite(t) ? t : -Infinity;
}

// Ativa antes de agendada; depois a de início mais recente.
function maisRecente(lista) {
  return lista.slice().sort((a, b) => {
    const aa = STATUS_ATIVOS.has(a.status) ? 0 : 1;
    const ba = STATUS_ATIVOS.has(b.status) ? 0 : 1;
    return aa - ba || tsInicio(b) - tsInicio(a);
  })[0] || null;
}

/**
 * Referência pré-selecionada: a que tem "vendex" E o mês atual no nome; sem
 * ela, a Vendex ATIVA mais recente; sem nenhuma Vendex, nenhuma (null).
 */
function escolherReferenciaPadrao(referencias, agora = new Date()) {
  const lista = Array.isArray(referencias) ? referencias : [];
  const doMes = lista.filter((r) => ehVendexDoMes(r.nome, agora));
  if (doMes.length) return maisRecente(doMes);
  const vendexAtivas = lista.filter((r) => ehVendex(r.nome) && STATUS_ATIVOS.has(r.status));
  if (vendexAtivas.length) return maisRecente(vendexAtivas);
  return null;
}

/** Ordem do seletor: padrão primeiro, depois Vendex, depois por início desc. */
function ordenarReferencias(referencias, padrao) {
  const chavePadrao = padrao ? `${padrao.id}::${padrao.tipo}` : null;
  return referencias
    .map((r) => ({ ...r, padrao: chavePadrao !== null && `${r.id}::${r.tipo}` === chavePadrao }))
    .sort((a, b) => {
      if (a.padrao !== b.padrao) return a.padrao ? -1 : 1;
      const av = ehVendex(a.nome) ? 0 : 1;
      const bv = ehVendex(b.nome) ? 0 : 1;
      return av - bv || tsInicio(b) - tsInicio(a);
    });
}

// ─── Referência e candidatas (por item) ──────────────────────────────────────

function mesmoTipo(a, b) {
  return String(a || "").toUpperCase().trim() === String(b || "").toUpperCase().trim();
}

/**
 * Localiza a referência na lista AO VIVO do item (id+tipo — o id só é único
 * dentro do tipo). Só vale se estiver started/active e com preço.
 */
function localizarReferencia(promocoes, referencia) {
  if (!referencia || !referencia.id) return null;
  const alvo = String(referencia.id);
  const achada = (promocoes || []).find(
    (p) =>
      p &&
      (String(p.id) === alvo || (p.refId != null && String(p.refId) === alvo)) &&
      mesmoTipo(p.tipo, referencia.tipo) &&
      STATUS_ATIVOS.has(String(p.status || "").toLowerCase())
  );
  if (!achada || num(achada.precoFinal) === null || !(num(achada.precoFinal) > 0)) return null;
  return achada;
}

/**
 * Promoção que forma o preço de venda HOJE: a que o ML aponta em
 * sale_price.metadata.promotion_id (statusExibicao "ATIVA", ver
 * meliPromocoesService) — pode ser a própria referência ou uma ACEITE com
 * rebate em que o anúncio já entrou. No ML vale o menor preço para o
 * comprador, então é contra ESTE preço que uma candidata precisa ganhar.
 * Sem uma ATIVA identificável (o ML não informou ou houve ambiguidade), a
 * base é a referência — o comportamento anterior.
 */
function localizarPromoAtual(promocoes, referenciaPromo) {
  // ATIVA basta: o normalizador só a concede quando o ML aponta a promoção
  // pelo sale_price — inclusive uma relâmpago ainda `pending` na listagem.
  const ativa = (promocoes || []).find(
    (p) => p && p.statusExibicao === "ATIVA" && num(p.precoFinal) > 0
  );
  return ativa || referenciaPromo || null;
}

function mesmaPromocao(a, b) {
  return Boolean(a && b && String(a.id) === String(b.id) && mesmoTipo(a.tipo, b.tipo));
}

/**
 * Candidatas de UM item, todas as condições da regra 3:
 *   tipo ACEITE (preço definido pelo ML), subsídio do ML (meliPercentage > 0
 *   e subsidioMl > 0), status candidate, preço conhecido e ESTRITAMENTE menor
 *   que o preço de HOJE em centavos (`base`: a promoção que forma o preço —
 *   a referência ou uma promoção com rebate já ativa) — no ML vale o menor
 *   preço para o comprador, então com preço igual ou maior o rebate nunca
 *   entra. A referência e a base nunca são candidatas.
 *
 * @returns {{ candidatas: object[], motivo: null|'SEM_CANDIDATA'|'PRECO_NAO_MENOR' }}
 */
function filtrarCandidatas(promocoes, referenciaPromo, base = referenciaPromo) {
  const precoRef = centavos(base && base.precoFinal);
  const candidatas = [];
  let algumaComPrecoNaoMenor = false;
  for (const p of promocoes || []) {
    if (!p) continue;
    if (mesmaPromocao(p, referenciaPromo) || mesmaPromocao(p, base)) continue;
    if (!TIPOS_ESCRITA_ACEITE.has(String(p.tipo || "").toUpperCase())) continue;
    if (String(p.status || "").toLowerCase() !== "candidate") continue;
    if (!(num(p.meliPercentage) > 0) || !(num(p.subsidioMl) > 0)) continue;
    const preco = centavos(p.precoFinal);
    if (preco === null || preco <= 0) continue;
    if (precoRef === null || preco >= precoRef) {
      algumaComPrecoNaoMenor = true;
      continue;
    }
    candidatas.push(p);
  }
  if (candidatas.length) return { candidatas, motivo: null };
  return { candidatas, motivo: algumaComPrecoNaoMenor ? MOTIVOS.PRECO_NAO_MENOR : MOTIVOS.SEM_CANDIDATA };
}

// ─── Margem num preço (mesma composição do cenário de preço do Simular) ──────

/**
 * Margem e lucro por unidade de UM preço, com a mesma composição do cenário
 * de preço do margemSimularService (core.calcularCenario → composicao →
 * computeMargin): custo/alíquota/taxa fixa da Base + comissão e frete COTADOS
 * neste preço + rebate (subsídio ML). A taxa fixa é a da Base (não varia com
 * o preço; a tarifa fixa do ML já vem dentro da comissão cotada). Logística
 * sem frete previsto pelo ML = frete 0 DECLARADO (frete_aplicavel:false).
 * Qualquer componente ausente bloqueia — nunca estima.
 *
 * @returns {{ ok:true, margemRatio:number, lucro:number } | { ok:false, motivo:string }}
 */
function margemNoPreco({ preco, rebate = 0, custo, aliquota, taxaFixa = null, cotacao }) {
  const p = num(preco);
  if (p === null || p <= 0) return { ok: false, motivo: "preco_invalido" };
  if (num(custo) === null) return { ok: false, motivo: "custo_ausente" };
  const aliq = num(aliquota);
  if (aliq === null) return { ok: false, motivo: "aliquota_ausente" };
  if (aliq < 0 || aliq > 1) return { ok: false, motivo: "aliquota_fora_da_faixa" };
  const reb = rebate === null || rebate === undefined ? 0 : num(rebate);
  if (reb === null || reb < 0) return { ok: false, motivo: "rebate_invalido" };
  if (!cotacao) return { ok: false, motivo: "cotacao_ausente" };
  if (cotacao.limite_excedido === true) return { ok: false, motivo: "limite_de_cotacoes_excedido" };
  const comissao = num(cotacao.comissao);
  const freteAplicavel = cotacao.frete_aplicavel !== false;
  const frete = freteAplicavel ? num(cotacao.frete) : (num(cotacao.frete) ?? 0);
  if (comissao === null) return { ok: false, motivo: (cotacao.motivos && cotacao.motivos.comissao) || "comissao_indisponivel" };
  if (frete === null) return { ok: false, motivo: (cotacao.motivos && cotacao.motivos.frete) || "frete_indisponivel" };
  // Frete estimado de confiança baixa (custo cobrado) ou apoiado em envios antigos: não decide participação
  // em promoção no Mercado Livre — mesma regra do cockpit (P0 12/11/2026). O gate vale na análise; a execução
  // só roda o que a análise guardou.
  const qf = freteAplicavel ? cotacao.frete_qualidade : null;
  if (qf && (qf.confianca === "baixa" || qf.historicoAntigo)) return { ok: false, motivo: "frete_confianca_baixa" };

  const comp = core.calcularComposicao({ preco: p, custo: num(custo), aliquota: aliq, taxa_fixa: num(taxaFixa), comissao, frete, rebate: reb });
  if (!comp.computavel || comp.lc === null || comp.margem_ratio === null) return { ok: false, motivo: "nao_computavel" };
  return { ok: true, margemRatio: comp.margem_ratio, lucro: comp.lc, comissao, frete };
}

// ─── Classificação (pura) ────────────────────────────────────────────────────

function chaveCandidata(c) {
  return `${c.id}::${c.tipo}`;
}

function melhorPor(lista, comparar) {
  return lista.reduce((melhor, c) => (melhor === null || comparar(c, melhor) > 0 ? c : melhor), null);
}

/**
 * Classifica UM anúncio a partir da referência e das candidatas já avaliadas
 * ({ ...promoção normalizada, margemRatio, lucro }).
 *   - só entram candidatas que melhoram PELO MENOS uma medida (margem ou lucro);
 *   - recomendado: a mesma candidata é a melhor em margem E em lucro e não
 *     piora nenhuma das duas;
 *   - escolha: melhor em margem ≠ melhor em lucro, ou a melhor piora uma delas;
 *   - sem_ganho: nenhuma melhora.
 * Sem ganho mínimo na v1: qualquer melhora (1 centavo / 0,0001 pp) aparece.
 *
 * @returns {{ status, candidatas: object[], sugestao: null|{porMargem, porLucro} }}
 */
function classificarItem({ referencia, candidatas }) {
  const refM = num(referencia && referencia.margemRatio);
  const refL = centavos(referencia && referencia.lucro);
  const lista = (candidatas || []).filter((c) => num(c.margemRatio) !== null && centavos(c.lucro) !== null);
  const melhoram = lista.filter((c) => c.margemRatio > refM || centavos(c.lucro) > refL);
  if (!melhoram.length) return { status: "sem_ganho", candidatas: [], sugestao: null };

  const porMargem = melhorPor(melhoram, (a, b) => a.margemRatio - b.margemRatio || centavos(a.lucro) - centavos(b.lucro));
  const porLucro = melhorPor(melhoram, (a, b) => centavos(a.lucro) - centavos(b.lucro) || a.margemRatio - b.margemRatio);
  const mesma = chaveCandidata(porMargem) === chaveCandidata(porLucro);
  const naoPiora = (c) => c.margemRatio >= refM && centavos(c.lucro) >= refL;
  const status = mesma && naoPiora(porMargem) ? "recomendado" : "escolha";

  const saida = melhoram
    .slice()
    .sort((a, b) => b.margemRatio - a.margemRatio || centavos(b.lucro) - centavos(a.lucro))
    .map((c) => ({
      promotionId: c.id,
      tipo: c.tipo,
      tipoLabel: c.tipoLabel || rotuloTipoPromocao(c.tipo),
      nome: c.nome || null,
      preco: round2(num(c.precoFinal)),
      subsidioMl: round2(num(c.subsidioMl)),
      // Taxa de rebate do ML (meli_percentage sobre o preço original) — a tela
      // mostra "Rebate ML x%" ao lado do valor em R$.
      meliPercentage: round2(num(c.meliPercentage)),
      margemPercent: round2(c.margemRatio * 100),
      lucro: round2(c.lucro),
      ganhoMargemPp: round2((c.margemRatio - refM) * 100),
      ganhoLucro: round2((centavos(c.lucro) - refL) / 100),
      inicio: c.inicio || null,
      fim: c.fim || null,
      melhorMargem: chaveCandidata(c) === chaveCandidata(porMargem),
      melhorLucro: chaveCandidata(c) === chaveCandidata(porLucro),
    }));

  return { status, candidatas: saida, sugestao: { porMargem: porMargem.id, porLucro: porLucro.id } };
}

function resumir(itens) {
  const resumo = { recomendado: 0, escolha: 0, sem_ganho: 0, descartado: 0 };
  for (const it of itens || []) if (Object.prototype.hasOwnProperty.call(resumo, it.status)) resumo[it.status] += 1;
  return resumo;
}

function ordenarItensResultado(itens) {
  return itens
    .map((it, i) => ({ it, i }))
    .sort((a, b) => (STATUS_ITEM_ORDEM[a.it.status] ?? 9) - (STATUS_ITEM_ORDEM[b.it.status] ?? 9) || a.i - b.i)
    .map((x) => x.it);
}

// ─── Execução: validação das escolhas e revalidação antes de gravar (puras) ──

function falha(codigo, motivo, extra = {}) {
  return { ok: false, codigo, motivo, ...extra };
}

/**
 * Cada escolha precisa existir entre as `candidatas` daquele item no resultado
 * salvo (promotionId + tipo). Pode haver várias por item. Nunca a referência.
 */
function validarEscolhas(escolhasBrutas, resultado, referencia) {
  if (!Array.isArray(escolhasBrutas) || escolhasBrutas.length === 0) {
    return falha("ESCOLHA_INVALIDA", "Informe ao menos uma escolha em `escolhas`.");
  }
  const porItem = new Map(((resultado && resultado.itens) || []).map((it) => [String(it.itemId), it]));
  const vistos = new Set();
  const escolhas = [];
  for (let i = 0; i < escolhasBrutas.length; i += 1) {
    const e = escolhasBrutas[i];
    const itemId = e && e.itemId != null ? String(e.itemId).trim() : "";
    const promotionId = e && e.promotionId != null ? String(e.promotionId).trim() : "";
    const tipo = e && e.tipo != null ? String(e.tipo).trim() : "";
    if (!itemId || !promotionId || !tipo) {
      return falha("ESCOLHA_INVALIDA", `escolhas[${i}] precisa de itemId, promotionId e tipo.`);
    }
    // Um anúncio pode participar de várias promoções; só o par repetido é erro.
    const chave = `${itemId}|${promotionId}|${tipo}`;
    if (vistos.has(chave)) {
      return falha("ESCOLHA_INVALIDA", `A promoção ${promotionId} aparece mais de uma vez para o anúncio ${itemId}.`);
    }
    vistos.add(chave);
    if (referencia && String(referencia.id) === promotionId && mesmoTipo(referencia.tipo, tipo)) {
      return falha("ESCOLHA_INVALIDA", `A promoção de referência nunca é alterada (anúncio ${itemId}).`);
    }
    const item = porItem.get(itemId);
    const candidata = item && (item.candidatas || []).find((c) => String(c.promotionId) === promotionId && mesmoTipo(c.tipo, tipo));
    if (!candidata) {
      return falha("ESCOLHA_INVALIDA", `A promoção ${promotionId} (${tipo}) não está entre as candidatas analisadas do anúncio ${itemId}.`);
    }
    escolhas.push({ itemId, promotionId: candidata.promotionId, tipo: candidata.tipo });
  }
  return { ok: true, escolhas };
}

/**
 * Gancho `antesDeEscrever` de participarPromocaoAceite: revalida na MESMA
 * releitura ao vivo que a escrita fez (nada de cache do frontend):
 * candidata ainda candidate, com subsídio, preço ainda MENOR que o preço de
 * hoje (a promoção que forma o preço — referência ou outra com rebate já
 * ativa), e a referência ainda ativa no anúncio.
 */
function criarRevalidacao(referencia) {
  return function revalidar({ promo, lista }) {
    if (!promo || String(promo.status || "").toLowerCase() !== "candidate") {
      return falha("PROMOCAO_JA_PARTICIPA", "A promoção não está mais disponível para entrar (o anúncio já participa ou ela saiu). Nada foi enviado.");
    }
    const ref = localizarReferencia(lista, referencia);
    if (!ref) {
      return falha("REFERENCIA_INATIVA", "A promoção de referência não está mais ativa neste anúncio. Nada foi enviado.");
    }
    const atual = localizarPromoAtual(lista, ref);
    const pc = centavos(promo.precoFinal);
    if (pc === null || pc >= centavos(atual.precoFinal)) {
      const deQuem = mesmaPromocao(atual, ref) ? "o da referência" : `o preço de hoje (${atual.nome || atual.id})`;
      return falha("PRECO_NAO_MENOR", `O preço desta promoção não é mais menor que ${deQuem} — o rebate não entraria. Nada foi enviado.`);
    }
    if (!(num(promo.subsidioMl) > 0)) {
      return falha("SEM_SUBSIDIO", "Esta promoção não tem mais subsídio do Mercado Livre. Nada foi enviado.");
    }
    return { ok: true };
  };
}

// ─── Dependências (injetáveis para teste) ────────────────────────────────────

function extrairCustosDoMotor(item) {
  const v = (e) => (e && e.value != null ? e.value : null);
  return {
    custo: v(item.costs && item.costs.cost && item.costs.cost.projected),
    aliquota: v(item.costs && item.costs.taxRate && item.costs.taxRate.projected),
    taxaFixa: v(item.costs && item.costs.fixedFee && item.costs.fixedFee.projected),
  };
}

// Custo/alíquota/taxa fixa da Base via Motor: contexto preparado UMA vez por
// job, enriquecimento por lote de até 20 (teto do multiget do Motor).
function criarCarregadorCustosPadrao({ clienteSlug, clienteContaId }) {
  let preparado = null;
  return async function carregar(itemIds) {
    const mapa = new Map();
    if (!itemIds.length) return mapa;
    const motor = require("../motorMargem/motorMargemService");
    if (!preparado) {
      preparado = motor.prepareWorkspaceContext({ clienteSlug, clienteContaId: clienteContaId || null }, {});
      preparado.catch(() => {});
    }
    const prepared = await preparado;
    const { itens } = await motor.enrichBatch(prepared, { itemIds }, {});
    for (const it of itens || []) mapa.set(String(it.identity.itemId), extrairCustosDoMotor(it));
    return mapa;
  };
}

async function carregarAnunciosPadrao(clienteId, itemIds) {
  if (!itemIds.length) return new Map();
  const anunciosService = require("./meliAnunciosService");
  await anunciosService.ensureSchema();
  const { rows } = await pool.query(
    `SELECT item_id, titulo, thumbnail, listing_type_id, category_id, logistic_type, ml_user_id
       FROM meli_anuncios
      WHERE cliente_id = $1 AND item_id = ANY($2::text[])`,
    [clienteId, itemIds]
  );
  return new Map(rows.map((r) => [String(r.item_id), r]));
}

function criarRepositorio(db) {
  return {
    async limparOrfaos({ clienteId = null, jobId = null } = {}) {
      await db.query(
        `UPDATE promocoes_rebate_jobs
            SET status = 'erro',
                erro = 'Interrompido: o servidor reiniciou ou o job ficou mais de ${JOB_ORFAO_MINUTOS} minutos sem progresso.',
                updated_at = NOW()
          WHERE status = 'processando'
            AND updated_at < NOW() - ($1 * INTERVAL '1 minute')
            AND ($2::bigint IS NULL OR cliente_id = $2)
            AND ($3::bigint IS NULL OR id = $3)`,
        [JOB_ORFAO_MINUTOS, clienteId, jobId]
      );
    },
    async emAndamento(clienteId) {
      const r = await db.query(
        `SELECT id FROM promocoes_rebate_jobs
          WHERE cliente_id = $1 AND status = 'processando'
          ORDER BY id DESC LIMIT 1`,
        [clienteId]
      );
      return r.rows.length ? Number(r.rows[0].id) : null;
    },
    async criar({ userId, clienteId, clienteSlug, clienteContaId, mlUserId, referencia, itemIds }) {
      const r = await db.query(
        `INSERT INTO promocoes_rebate_jobs
           (user_id, cliente_id, cliente_slug, cliente_conta_id, ml_user_id, referencia, item_ids, fase, status)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, 'analise', 'processando')
         RETURNING id`,
        [userId ?? null, clienteId, clienteSlug ?? null, clienteContaId ?? null, mlUserId != null ? String(mlUserId) : null,
          JSON.stringify(referencia), itemIds ? JSON.stringify(itemIds) : null]
      );
      return Number(r.rows[0].id);
    },
    async obter(jobId) {
      const r = await db.query(`SELECT * FROM promocoes_rebate_jobs WHERE id = $1`, [jobId]);
      return r.rows[0] || null;
    },
    async atualizarProgresso(jobId, total, processados, resumoParcial = null) {
      await db.query(
        `UPDATE promocoes_rebate_jobs
            SET progresso_total = $2,
                progresso_processados = GREATEST(progresso_processados, $3),
                progresso_resumo = COALESCE($4::jsonb, progresso_resumo),
                updated_at = NOW()
          WHERE id = $1 AND status = 'processando'`,
        [jobId, total, processados, resumoParcial ? JSON.stringify(resumoParcial) : null]
      );
    },
    async concluirAnalise(jobId, resultado) {
      await db.query(
        `UPDATE promocoes_rebate_jobs
            SET status = 'concluido', resultado = $2::jsonb,
                progresso_processados = progresso_total, updated_at = NOW()
          WHERE id = $1 AND status = 'processando'`,
        [jobId, JSON.stringify(resultado)]
      );
    },
    async marcarErro(jobId, mensagem) {
      await db.query(
        `UPDATE promocoes_rebate_jobs
            SET status = 'erro', erro = $2, updated_at = NOW()
          WHERE id = $1`,
        [jobId, String(mensagem || "Erro desconhecido").slice(0, 800)]
      );
    },
    // Condicional: só sai de um estado parado e com análise concluída. Sem
    // linha devolvida = alguém começou antes (ou a análise não concluiu).
    async iniciarExecucao(jobId, execucao) {
      const r = await db.query(
        `UPDATE promocoes_rebate_jobs
            SET fase = 'execucao', status = 'processando', erro = NULL,
                execucao = $2::jsonb, updated_at = NOW()
          WHERE id = $1 AND status <> 'processando' AND resultado IS NOT NULL
          RETURNING id`,
        [jobId, JSON.stringify(execucao)]
      );
      return r.rows.length > 0;
    },
    async atualizarExecucao(jobId, execucao) {
      await db.query(
        `UPDATE promocoes_rebate_jobs SET execucao = $2::jsonb, updated_at = NOW() WHERE id = $1`,
        [jobId, JSON.stringify(execucao)]
      );
    },
    async concluirExecucao(jobId, execucao) {
      await db.query(
        `UPDATE promocoes_rebate_jobs
            SET status = 'concluido', execucao = $2::jsonb, updated_at = NOW()
          WHERE id = $1`,
        [jobId, JSON.stringify(execucao)]
      );
    },
  };
}

function defaults(deps = {}) {
  const d = {
    db: deps.db || pool,
    now: deps.now || (() => new Date()),
    sleep: deps.sleep || sleep,
    logger: deps.logger || console,
    mlFetch: deps.mlFetch || ((...a) => require("../../utils/mlClient").mlFetch(...a)),
    listarPromocoesDoItemDetalhado:
      deps.listarPromocoesDoItemDetalhado || ((...a) => require("./meliPromocoesService").listarPromocoesDoItemDetalhado(...a)),
    participarPromocaoAceite:
      deps.participarPromocaoAceite || ((...a) => require("./meliPromocoesEscritaService").participarPromocaoAceite(...a)),
    buscarComissaoEFrete:
      deps.buscarComissaoEFrete || ((...a) => require("../shared/marketplaceCurrentQuoteService").buscarComissaoEFrete(...a)),
    carregarAnuncios: deps.carregarAnuncios || carregarAnunciosPadrao,
    criarCarregadorCustos: deps.criarCarregadorCustos || criarCarregadorCustosPadrao,
    registrarLog: deps.registrarLog || ((...a) => require("../activityLogService").registrarLog(...a)),
    ensureSchema: deps.ensureSchema || (() => require("../schema/schemaEnsure").ensurePromocoesRebateSchema()),
    // Background no mesmo processo, disparado pela requisição.
    agendar: deps.agendar || ((fn) => setImmediate(fn)),
  };
  d.repo = deps.repo || criarRepositorio(d.db);
  return d;
}

// ─── Leitura paginada do ML (respeitando 429) ────────────────────────────────

function esperaDo429(resp, tentativa) {
  const ra = num(resp && resp.retryAfter);
  if (ra !== null && ra >= 0) return Math.min(ra * 1000, 15000);
  return Math.min(1500 * 2 ** (tentativa - 1), 10000);
}

async function mlGetComRetry(d, clienteId, caminho, mlUserId) {
  let resp = null;
  for (let t = 1; t <= MAX_TENTATIVAS_429; t += 1) {
    resp = await d.mlFetch(clienteId, caminho, { mlUserId });
    if (!resp || resp.status !== 429 || t === MAX_TENTATIVAS_429) return resp;
    await d.sleep(esperaDo429(resp, t));
  }
  return resp;
}

function tokenSearchAfter(data) {
  const p = data && data.paging && typeof data.paging === "object" && !Array.isArray(data.paging) ? data.paging : {};
  const t = p.searchAfter ?? p.search_after ?? (data && (data.searchAfter ?? data.search_after));
  return t != null && String(t) !== "" ? String(t) : null;
}

/**
 * Pagina um recurso de seller-promotions tratando OS DOIS formatos da doc
 * (gerenciar-ofertas.md): `search_after` (devolvido em todas as páginas menos a
 * última, TTL 5 min) e `paging { offset, limit, total }`. `paging` vazio ({}
 * ou []) sem token = página única.
 */
async function paginarSellerPromotions(d, { clienteId, mlUserId, caminho }) {
  const resultados = [];
  const sep = caminho.includes("?") ? "&" : "?";
  let searchAfter = null;
  let offset = 0;
  for (let pagina = 0; pagina < MAX_PAGINAS_ML; pagina += 1) {
    let url = `${caminho}${sep}limit=${LIMITE_PAGINA_ML}`;
    if (searchAfter) url += `&search_after=${encodeURIComponent(searchAfter)}`;
    else if (offset > 0) url += `&offset=${offset}`;
    const resp = await mlGetComRetry(d, clienteId, url, mlUserId);
    if (!resp || !resp.ok) return { ok: false, status: (resp && resp.status) ?? null, resultados };
    const data = resp.data || {};
    const lote = Array.isArray(data) ? data : Array.isArray(data.results) ? data.results : [];
    resultados.push(...lote.filter((x) => x && typeof x === "object"));

    const token = tokenSearchAfter(data);
    if (token && lote.length) { searchAfter = token; continue; }
    const paging = data.paging && typeof data.paging === "object" && !Array.isArray(data.paging) ? data.paging : null;
    const total = paging ? num(paging.total) : null;
    if (!searchAfter && total !== null && lote.length && offset + lote.length < total) {
      offset += lote.length;
      continue;
    }
    break;
  }
  return { ok: true, status: 200, resultados };
}

async function listarPromocoesDaConta(d, { clienteId, mlUserId }) {
  return paginarSellerPromotions(d, {
    clienteId, mlUserId, caminho: `/seller-promotions/users/${encodeURIComponent(mlUserId)}?app_version=v2`,
  });
}

function referenciaPublica(p) {
  return {
    id: String(p.id),
    tipo: p.type || null,
    tipoLabel: rotuloTipoPromocao(p.type),
    nome: p.name || null,
    status: String(p.status || "").toLowerCase() || null,
    inicio: p.start_date || null,
    fim: p.finish_date || null,
  };
}

// ─── GET /promocoes-rebate/referencias ───────────────────────────────────────

async function listarReferencias({ clienteId, mlUserId }, deps = {}) {
  const d = defaults(deps);
  const lido = await listarPromocoesDaConta(d, { clienteId, mlUserId });
  if (!lido.ok) {
    return falha("ERRO_ML", `Não foi possível ler as promoções da conta no Mercado Livre${lido.status ? ` (HTTP ${lido.status})` : ""}.`);
  }
  const vistas = new Set();
  const refs = [];
  for (const p of lido.resultados) {
    if (!p.id) continue;
    const r = referenciaPublica(p);
    if (!STATUS_REFERENCIA_LISTAVEL.has(r.status)) continue;
    const chave = `${r.id}::${r.tipo}`;
    if (vistas.has(chave)) continue;
    vistas.add(chave);
    refs.push(r);
  }
  const padrao = escolherReferenciaPadrao(refs, d.now());
  return { ok: true, padraoId: padrao ? padrao.id : null, referencias: ordenarReferencias(refs, padrao) };
}

// ─── POST /promocoes-rebate/analises ─────────────────────────────────────────

function validarItemIds(bruto) {
  if (bruto === undefined || bruto === null) return { ok: true, itemIds: null };
  if (!Array.isArray(bruto)) return falha("ITEM_IDS_INVALIDOS", "itemIds precisa ser uma lista de anúncios (MLB).");
  const ids = Array.from(new Set(bruto.map((x) => String(x || "").trim().toUpperCase()).filter(Boolean)));
  if (ids.some((id) => !/^MLB\d+$/.test(id))) return falha("ITEM_IDS_INVALIDOS", "itemIds aceita só anúncios no formato MLB123.");
  if (ids.length > MAX_ITEM_IDS) return falha("ITEM_IDS_INVALIDOS", `No máximo ${MAX_ITEM_IDS} anúncios por análise.`);
  return { ok: true, itemIds: ids.length ? ids : null };
}

/**
 * @param {{ cliente:{id,slug}, contexto:{mlUserId, contaId}, body:object, user?:object }} p
 * @returns {Promise<{ok:true, jobId}|{ok:false, codigo, motivo, httpStatus?}>}
 */
async function iniciarAnalise({ cliente, contexto, body, user } = {}, deps = {}) {
  const d = defaults(deps);
  const b = body || {};
  const ref = b.referencia && typeof b.referencia === "object" ? b.referencia : {};
  const refId = ref.id != null ? String(ref.id).trim() : "";
  const refTipo = ref.tipo != null ? String(ref.tipo).trim().toUpperCase() : "";
  if (!refId || !refTipo) {
    return { ...falha("REFERENCIA_INVALIDA", "Informe a promoção de referência (referencia.id e referencia.tipo)."), httpStatus: 400 };
  }
  const ids = validarItemIds(b.itemIds);
  if (!ids.ok) return { ...ids, httpStatus: 400 };
  if (!contexto || !contexto.mlUserId) return falha("CONTA_SEM_GRANT_ML", "A conta não tem conexão do Mercado Livre vinculada.");

  await d.ensureSchema();
  await d.repo.limparOrfaos({ clienteId: cliente.id });
  const ativo = await d.repo.emAndamento(cliente.id);
  if (ativo) {
    return falha("ANALISE_EM_ANDAMENTO", "Já existe uma análise (ou execução) de promoções com rebate em andamento para este cliente.", { jobId: ativo });
  }

  // A referência precisa existir entre as promoções da conta — de lá vem o nome.
  const lido = await listarPromocoesDaConta(d, { clienteId: cliente.id, mlUserId: contexto.mlUserId });
  if (!lido.ok) {
    return falha("ERRO_ML", `Não foi possível ler as promoções da conta no Mercado Livre${lido.status ? ` (HTTP ${lido.status})` : ""}.`);
  }
  const achada = lido.resultados.find((p) => String(p.id) === refId && mesmoTipo(p.type, refTipo));
  if (!achada || !STATUS_REFERENCIA_LISTAVEL.has(String(achada.status || "").toLowerCase())) {
    return falha("REFERENCIA_NAO_ENCONTRADA", "A promoção de referência não está entre as promoções ativas ou agendadas desta conta.");
  }

  let jobId;
  try {
    jobId = await d.repo.criar({
      userId: user && user.id,
      clienteId: cliente.id,
      clienteSlug: cliente.slug,
      clienteContaId: contexto.contaId ?? null,
      mlUserId: contexto.mlUserId,
      referencia: { id: String(achada.id), tipo: achada.type, nome: achada.name || null },
      itemIds: ids.itemIds,
    });
  } catch (err) {
    // Índice único parcial: outro clique ganhou a corrida.
    if (err && err.code === "23505") {
      const outro = await d.repo.emAndamento(cliente.id);
      return falha("ANALISE_EM_ANDAMENTO", "Já existe uma análise de promoções com rebate em andamento para este cliente.", { jobId: outro });
    }
    throw err;
  }

  // Devolve a promessa (setImmediate a ignora; teste pode aguardá-la).
  d.agendar(() =>
    executarAnalise(jobId, deps).catch((err) => d.logger.error(`[promo-rebate ${jobId}] análise:`, err && err.message)));
  return { ok: true, jobId };
}

// ─── Worker da análise ───────────────────────────────────────────────────────

async function lerPromocoesComRetry(d, { clienteId, itemId, mlUserId }) {
  let r = null;
  for (let t = 1; t <= MAX_TENTATIVAS_429; t += 1) {
    r = await d.listarPromocoesDoItemDetalhado({ clienteId, itemId, mlUserId });
    if (!r || r.ok || r.status !== 429 || t === MAX_TENTATIVAS_429) return r || { ok: false, status: null, promocoes: [] };
    await d.sleep(esperaDo429(r, t));
  }
  return r;
}

function foiRateLimit(cot) {
  return Boolean(cot && cot.motivos && (cot.motivos.comissao === "ml_rate_limit" || cot.motivos.frete === "ml_rate_limit"));
}

// Cotação por preço de UM item, com cache e nova tentativa em 429 (um cotador
// novo por tentativa: o do margemCotacaoEmP guarda a promessa do preço).
function criarCotacaoDoItem(d, { clienteId, itemId, anuncio, mlUserId }) {
  const cache = new Map();
  return function cotar(preco) {
    const chave = Number(preco).toFixed(2);
    if (cache.has(chave)) return cache.get(chave);
    const promessa = (async () => {
      let cot = null;
      for (let t = 1; t <= MAX_TENTATIVAS_429; t += 1) {
        const cotador = criarCotadorEmP({
          clienteId, itemId, anuncio, sellerId: mlUserId, mlUserId,
          buscarComissaoEFrete: d.buscarComissaoEFrete, mlFetch: d.mlFetch, now: d.now,
          maxCotacoes: 1, timeoutMs: COTACAO_TIMEOUT_MS,
        });
        cot = await cotador.cotar(Number(chave));
        if (!foiRateLimit(cot) || t === MAX_TENTATIVAS_429) return cot;
        await d.sleep(Math.min(1500 * 2 ** (t - 1), 10000));
      }
      return cot;
    })();
    cache.set(chave, promessa);
    return promessa;
  };
}

/**
 * Avalia UM anúncio (I/O injetado): lê as promoções ao vivo, localiza a
 * referência, filtra candidatas, cota cada preço e classifica.
 */
async function avaliarItem({ itemId, anuncio, naReferencia, referencia, custos, clienteId, mlUserId }, d) {
  const base = {
    itemId,
    titulo: (anuncio && anuncio.titulo) || null,
    thumbnail: (anuncio && anuncio.thumbnail) || null,
    status: "descartado",
    motivo: null,
    motivoTexto: null,
    referencia: { preco: null, subsidioMl: null, margemPercent: null, lucro: null },
    // Promoção que forma o preço HOJE — base de todas as comparações.
    atual: null,
    candidatas: [],
    sugestao: null,
  };
  const descartar = (motivo, texto = null, extra = {}) => ({ ...base, ...extra, status: "descartado", motivo, motivoTexto: texto || MOTIVO_TEXTO[motivo] });

  if (!naReferencia) return descartar(MOTIVOS.FORA_DA_REFERENCIA);
  if (!anuncio) return descartar(MOTIVOS.ANUNCIO_NAO_SINCRONIZADO);

  const lido = await lerPromocoesComRetry(d, { clienteId, itemId, mlUserId });
  if (!lido.ok) {
    return descartar(MOTIVOS.ERRO_ML, `${MOTIVO_TEXTO.ERRO_ML}${lido.status ? ` (HTTP ${lido.status})` : ""}`);
  }
  const refPromo = localizarReferencia(lido.promocoes, referencia);
  if (!refPromo) return descartar(MOTIVOS.FORA_DA_REFERENCIA);

  const subsidioRef = num(refPromo.subsidioMl) > 0 ? num(refPromo.subsidioMl) : 0;
  base.referencia = {
    preco: round2(num(refPromo.precoFinal)), subsidioMl: round2(subsidioRef),
    meliPercentage: subsidioRef > 0 ? round2(num(refPromo.meliPercentage)) : null,
    margemPercent: null, lucro: null,
  };

  const promoAtual = localizarPromoAtual(lido.promocoes, refPromo);
  const atualEhReferencia = mesmaPromocao(promoAtual, refPromo);
  const subsidioAtual = num(promoAtual.subsidioMl) > 0 ? num(promoAtual.subsidioMl) : 0;
  base.atual = {
    promotionId: String(promoAtual.id),
    tipo: promoAtual.tipo || null,
    tipoLabel: promoAtual.tipoLabel || rotuloTipoPromocao(promoAtual.tipo),
    nome: promoAtual.nome || null,
    ehReferencia: atualEhReferencia,
    preco: round2(num(promoAtual.precoFinal)),
    subsidioMl: round2(subsidioAtual),
    meliPercentage: subsidioAtual > 0 ? round2(num(promoAtual.meliPercentage)) : null,
    margemPercent: null,
    lucro: null,
  };
  // Já numa promoção com rebate que não é a referência: sem candidata melhor,
  // o anúncio fica como está (sem_ganho), não é descartado.
  const jaEmRebate = !atualEhReferencia && subsidioAtual > 0;
  const semGanhoRebate = () => ({
    ...base, status: "sem_ganho", motivo: MOTIVOS.JA_EM_REBATE_MELHOR, motivoTexto: MOTIVO_TEXTO.JA_EM_REBATE_MELHOR,
  });

  const { candidatas, motivo } = filtrarCandidatas(lido.promocoes, refPromo, promoAtual);
  if (!candidatas.length) return jaEmRebate ? semGanhoRebate() : descartar(motivo);

  if (!custos || custos.erro) {
    return descartar(MOTIVOS.SEM_CUSTO, custos && custos.erro ? `Base de Custos indisponível: ${custos.erro}` : null);
  }
  if (num(custos.custo) === null) return descartar(MOTIVOS.SEM_CUSTO);
  const aliq = num(custos.aliquota);
  if (aliq === null || aliq < 0 || aliq > 1) {
    return descartar(MOTIVOS.SEM_CUSTO, "Base de Custos sem alíquota de imposto válida para este anúncio.");
  }

  const cotar = criarCotacaoDoItem(d, { clienteId, itemId, anuncio, mlUserId });
  const insumos = { custo: custos.custo, aliquota: aliq, taxaFixa: custos.taxaFixa };

  const mAtual = margemNoPreco({ ...insumos, preco: promoAtual.precoFinal, rebate: subsidioAtual, cotacao: await cotar(promoAtual.precoFinal) });
  if (!mAtual.ok) {
    const qual = atualEhReferencia ? "preço da referência" : "preço de hoje";
    return descartar(MOTIVOS.COTACAO_INDISPONIVEL, `${MOTIVO_TEXTO.COTACAO_INDISPONIVEL} (${qual}: ${mAtual.motivo})`);
  }
  base.atual.margemPercent = round2(mAtual.margemRatio * 100);
  base.atual.lucro = round2(mAtual.lucro);
  // Margem/lucro "na referência" só existem quando é ela que forma o preço;
  // senão não seriam o hoje e não entram na comparação.
  if (atualEhReferencia) {
    base.referencia.margemPercent = base.atual.margemPercent;
    base.referencia.lucro = base.atual.lucro;
  }

  const avaliadas = [];
  const ignoradas = [];
  for (const c of candidatas) {
    const m = margemNoPreco({ ...insumos, preco: c.precoFinal, rebate: c.subsidioMl, cotacao: await cotar(c.precoFinal) });
    if (m.ok) avaliadas.push({ ...c, margemRatio: m.margemRatio, lucro: m.lucro });
    else ignoradas.push({ promotionId: c.id, tipo: c.tipo, motivo: MOTIVOS.COTACAO_INDISPONIVEL, detalhe: m.motivo });
  }
  if (!avaliadas.length) return descartar(MOTIVOS.COTACAO_INDISPONIVEL, null, { candidatasIgnoradas: ignoradas });

  const cls = classificarItem({ referencia: { margemRatio: mAtual.margemRatio, lucro: mAtual.lucro }, candidatas: avaliadas });
  if (cls.status === "sem_ganho" && jaEmRebate) return { ...semGanhoRebate(), candidatasIgnoradas: ignoradas };
  return { ...base, status: cls.status, candidatas: cls.candidatas, sugestao: cls.sugestao, candidatasIgnoradas: ignoradas };
}

async function listarItensDaReferencia(d, { clienteId, mlUserId, referencia }) {
  const caminho =
    `/seller-promotions/promotions/${encodeURIComponent(referencia.id)}/items` +
    `?promotion_type=${encodeURIComponent(referencia.tipo)}&status=started&app_version=v2`;
  const lido = await paginarSellerPromotions(d, { clienteId, mlUserId, caminho });
  if (!lido.ok) return lido;
  const ids = new Set();
  for (const it of lido.resultados) {
    const id = it.id != null ? String(it.id).toUpperCase() : null;
    if (!id) continue;
    if (!STATUS_ATIVOS.has(String(it.status || "").toLowerCase())) continue;
    if (!(num(it.price) > 0)) continue;
    ids.add(id);
  }
  return { ok: true, ids };
}

async function executarAnalise(jobId, deps = {}) {
  const d = defaults(deps);
  const job = await d.repo.obter(jobId);
  if (!job) return;
  try {
    const referencia = job.referencia || {};
    const clienteId = Number(job.cliente_id);
    const mlUserId = job.ml_user_id;

    const universo = await listarItensDaReferencia(d, { clienteId, mlUserId, referencia });
    if (!universo.ok) {
      await d.repo.marcarErro(jobId, `Não foi possível ler os anúncios da promoção de referência no Mercado Livre${universo.status ? ` (HTTP ${universo.status})` : ""}.`);
      return;
    }
    const pedidos = Array.isArray(job.item_ids) && job.item_ids.length ? job.item_ids.map((x) => String(x).toUpperCase()) : null;
    const ids = pedidos ? Array.from(new Set(pedidos)) : Array.from(universo.ids);
    const total = ids.length;
    await d.repo.atualizarProgresso(jobId, total, 0);

    const anuncios = await d.carregarAnuncios(clienteId, ids);
    const carregarCustos = d.criarCarregadorCustos({ clienteSlug: job.cliente_slug, clienteContaId: job.cliente_conta_id });

    const itens = [];
    let processados = 0;
    // Contagem parcial por status, para o placar ao vivo do Portal.
    const parcial = resumir([]);
    for (const lote of chunk(ids, LOTE_CUSTOS)) {
      const precisamCusto = lote.filter((id) => universo.ids.has(id) && anuncios.has(id));
      let custos;
      try {
        custos = await carregarCustos(precisamCusto);
      } catch (err) {
        custos = { erro: (err && (err.payload && err.payload.erro)) || (err && err.message) || "erro desconhecido" };
      }
      const resultados = await mapComLimite(lote, CONCORRENCIA_ITENS, async (itemId) => {
        let r;
        try {
          r = await avaliarItem({
            itemId,
            anuncio: anuncios.get(itemId) || null,
            naReferencia: universo.ids.has(itemId),
            referencia,
            custos: custos instanceof Map ? (custos.get(itemId) || { erro: "o Motor de Margem não devolveu este anúncio." }) : custos,
            clienteId,
            mlUserId,
          }, d);
        } catch (err) {
          r = {
            itemId, titulo: null, thumbnail: null, status: "descartado", motivo: MOTIVOS.ERRO_ML,
            motivoTexto: `${MOTIVO_TEXTO.ERRO_ML} (${(err && err.message) || "erro"})`,
            referencia: { preco: null, subsidioMl: null, margemPercent: null, lucro: null }, atual: null, candidatas: [], sugestao: null,
          };
        }
        processados += 1;
        if (Object.prototype.hasOwnProperty.call(parcial, r.status)) parcial[r.status] += 1;
        await d.repo.atualizarProgresso(jobId, total, processados, { ...parcial });
        return r;
      });
      itens.push(...resultados);
    }

    const ordenados = ordenarItensResultado(itens);
    await d.repo.concluirAnalise(jobId, { resumo: resumir(ordenados), itens: ordenados });
  } catch (err) {
    d.logger.error(`[promo-rebate ${jobId}] erro na análise:`, err && err.message);
    await d.repo.marcarErro(jobId, (err && err.message) || "Erro inesperado na análise.");
  }
}

// ─── GET /promocoes-rebate/analises/:jobId ───────────────────────────────────

function parseJobId(bruto) {
  const n = Number(bruto);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function serializarExecucao(execucao, statusJob) {
  if (!execucao || typeof execucao !== "object") return null;
  const interrompido = statusJob === "erro";
  const itens = (execucao.itens || []).map((it) =>
    interrompido && it.status === "pendente"
      ? { ...it, status: "falha", codigo: "INTERROMPIDO", motivo: "A execução foi interrompida antes deste anúncio. Nada foi enviado para ele." }
      : it
  );
  return {
    total: itens.length,
    processados: itens.filter((it) => it.status !== "pendente").length,
    itens,
  };
}

function serializarJob(row) {
  const ref = row.referencia || {};
  return {
    id: Number(row.id),
    fase: row.fase,
    status: row.status,
    erro: row.erro || null,
    referencia: { id: ref.id || null, tipo: ref.tipo || null, nome: ref.nome || null },
    progresso: {
      total: Number(row.progresso_total) || 0,
      processados: Number(row.progresso_processados) || 0,
      resumo: row.progresso_resumo || null,
    },
    resultado: row.resultado || null,
    execucao: serializarExecucao(row.execucao, row.status),
  };
}

// Job só é lido/executado pelo MESMO cliente e pela MESMA conta ML.
async function carregarJobDoCliente(d, { jobId, cliente, mlUserId }) {
  const id = parseJobId(jobId);
  if (!id) return { ...falha("JOB_INVALIDO", "jobId inválido."), httpStatus: 400 };
  await d.ensureSchema();
  await d.repo.limparOrfaos({ jobId: id });
  const row = await d.repo.obter(id);
  const naoAchou = { ...falha("JOB_NAO_ENCONTRADO", "Análise não encontrada para este cliente."), httpStatus: 404 };
  if (!row || Number(row.cliente_id) !== Number(cliente.id)) return naoAchou;
  if (mlUserId && row.ml_user_id && String(row.ml_user_id) !== String(mlUserId)) return naoAchou;
  return { ok: true, row };
}

async function lerJob({ jobId, cliente, mlUserId }, deps = {}) {
  const d = defaults(deps);
  const r = await carregarJobDoCliente(d, { jobId, cliente, mlUserId });
  if (!r.ok) return r;
  return { ok: true, job: serializarJob(r.row) };
}

// ─── POST /promocoes-rebate/analises/:jobId/executar ─────────────────────────

/**
 * Valida tudo ANTES de qualquer escrita; o lote roda em background, um item
 * por vez. Reexecutar só as falhas = novo POST com as escolhas que falharam:
 * os itens já gravados de execuções anteriores continuam em `execucao`.
 */
async function iniciarExecucao({ jobId, cliente, mlUserId, body, user, ip = null } = {}, deps = {}) {
  const d = defaults(deps);
  const r = await carregarJobDoCliente(d, { jobId, cliente, mlUserId });
  if (!r.ok) return r;
  const row = r.row;

  if (!row.resultado) {
    return falha("ANALISE_NAO_CONCLUIDA", "A análise ainda não terminou (ou terminou com erro) — não há candidatas para executar.");
  }
  if (row.status === "processando") {
    return falha("EXECUCAO_EM_ANDAMENTO", "Já existe uma execução em andamento para esta análise.");
  }

  const v = validarEscolhas(body && body.escolhas, row.resultado, row.referencia);
  if (!v.ok) return { ...v, httpStatus: 400 };

  // `execucao` traz SÓ as escolhas deste POST (contrato combinado com o
  // frontend): "Tentar de novo as falhas" manda um novo POST e a tela passa a
  // acompanhar apenas essa rodada. O histórico de cada participação fica no
  // log de atividade.
  const execucao = {
    total: v.escolhas.length,
    processados: 0,
    itens: v.escolhas.map((e) => ({ itemId: e.itemId, promotionId: e.promotionId, tipo: e.tipo, status: "pendente", codigo: null, motivo: null, precoConfirmado: null })),
  };

  // Marca fase 'execucao' + status 'processando' ANTES de responder: o primeiro
  // polling já enxerga a execução.
  let iniciou;
  try {
    iniciou = await d.repo.iniciarExecucao(row.id, execucao);
  } catch (err) {
    if (err && err.code === "23505") {
      const ativo = await d.repo.emAndamento(Number(row.cliente_id));
      return falha("ANALISE_EM_ANDAMENTO", "Existe outra análise ou execução em andamento para este cliente.", { jobId: ativo });
    }
    throw err;
  }
  if (!iniciou) return falha("EXECUCAO_EM_ANDAMENTO", "Já existe uma execução em andamento para esta análise.");

  const ctx = {
    jobId: Number(row.id),
    clienteId: Number(row.cliente_id),
    clienteSlug: row.cliente_slug,
    clienteContaId: row.cliente_conta_id ?? null,
    mlUserId: row.ml_user_id,
    referencia: row.referencia,
    user: user || null,
    ip,
  };
  d.agendar(() =>
    executarParticipacoes(ctx, v.escolhas, execucao, deps).catch((err) =>
      d.logger.error(`[promo-rebate ${ctx.jobId}] execução:`, err && err.message)));
  return { ok: true };
}

async function executarParticipacoes(ctx, escolhas, execucao, deps = {}) {
  const d = defaults(deps);
  const revalidar = criarRevalidacao(ctx.referencia);
  try {
    for (const escolha of escolhas) {
      let r;
      // Defesa em profundidade: a referência nunca recebe escrita.
      if (String(escolha.promotionId) === String(ctx.referencia && ctx.referencia.id) && mesmoTipo(escolha.tipo, ctx.referencia && ctx.referencia.tipo)) {
        r = falha("ESCOLHA_INVALIDA", "A promoção de referência nunca é alterada.");
      } else {
        try {
          r = await d.participarPromocaoAceite({
            clienteId: ctx.clienteId,
            itemId: escolha.itemId,
            mlUserId: ctx.mlUserId,
            promotionId: escolha.promotionId,
            tipo: escolha.tipo,
            antesDeEscrever: revalidar,
          });
        } catch (err) {
          r = falha("ERRO_INTERNO", `Erro ao participar da promoção: ${(err && err.message) || "erro desconhecido"}`);
        }
      }

      const alvo = execucao.itens.find((it) => String(it.itemId) === String(escolha.itemId) && String(it.promotionId) === String(escolha.promotionId));
      if (alvo) {
        alvo.status = r && r.ok ? "ok" : "falha";
        alvo.codigo = r && r.ok ? null : (r && r.codigo) || "FALHA";
        alvo.motivo = r && r.ok ? null : (r && r.motivo) || null;
        alvo.precoConfirmado = r && r.ok ? (r.precoConfirmado ?? null) : null;
      }
      execucao.processados = execucao.itens.filter((it) => it.status !== "pendente").length;
      await d.repo.atualizarExecucao(ctx.jobId, execucao);

      try {
        await d.registrarLog({
          userId: ctx.user ? ctx.user.id ?? null : null,
          userEmail: ctx.user ? ctx.user.email ?? null : null,
          userNome: ctx.user ? ctx.user.nome ?? null : null,
          acao: "anuncios_meli.promocoes_rebate.participar",
          detalhes: {
            job_id: ctx.jobId,
            cliente_slug: ctx.clienteSlug,
            cliente_conta_id: ctx.clienteContaId,
            item_id: escolha.itemId,
            promotion_id: escolha.promotionId,
            tipo: escolha.tipo,
            referencia: ctx.referencia,
            preco_confirmado: r && r.ok ? (r.precoConfirmado ?? null) : null,
            codigo: r && r.ok ? null : (r && r.codigo) || null,
            motivo: r && r.ok ? null : (r && r.motivo) || null,
          },
          ip: ctx.ip,
          status: r && r.ok ? "sucesso" : "erro",
        });
      } catch (_) {
        // falha de log não derruba o lote
      }
    }
    await d.repo.concluirExecucao(ctx.jobId, execucao);
  } catch (err) {
    d.logger.error(`[promo-rebate ${ctx.jobId}] erro na execução:`, err && err.message);
    await d.repo.marcarErro(ctx.jobId, (err && err.message) || "Erro inesperado na execução.");
  }
}

module.exports = {
  // API usada pelo controller
  listarReferencias,
  iniciarAnalise,
  lerJob,
  iniciarExecucao,
  // workers (exportados para teste)
  executarAnalise,
  executarParticipacoes,
  avaliarItem,
  // puras
  normalizarTexto,
  mesAtualSaoPaulo,
  ehVendex,
  ehVendexDoMes,
  escolherReferenciaPadrao,
  ordenarReferencias,
  localizarReferencia,
  localizarPromoAtual,
  filtrarCandidatas,
  margemNoPreco,
  classificarItem,
  resumir,
  validarEscolhas,
  criarRevalidacao,
  serializarJob,
  paginarSellerPromotions,
  criarRepositorio,
  MOTIVOS,
  MOTIVO_TEXTO,
  JOB_ORFAO_MINUTOS,
};
