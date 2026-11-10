/*
 * Central de Margem — contrato único de dados do frontend.
 *
 * Ordem de leitura:
 *   GET /operacao/central-margem/:slug (contrato canônico do Motor). Sem o
 *   Motor não há leitura de reserva: calcular margem na tela seria uma segunda
 *   fórmula.
 *
 * A página nunca chama endpoints por linha. null continua significando ausente;
 * nenhum valor financeiro inexistente é convertido silenciosamente em zero.
 * NENHUMA fórmula financeira vive aqui: LC e margem de qualquer composição vêm
 * do núcleo do Motor (ver "CÁLCULO — SEMPRE DO BACKEND").
 */
(function (root, factory) {
  var api = factory(root || {});
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.VFCentralMargemApi = api;
})(typeof window !== "undefined" ? window : globalThis, function (root) {
  "use strict";

  var DEFAULT_API_BASE = "https://venforce-server.onrender.com";
  var STATUSES = ["HEALTHY", "LOW_MARGIN", "LOSS", "UNVALIDATED", "SUSPECT_DATA", "RECONCILING"];
  var LEVELS = ["HIGH", "MEDIUM", "LOW", "UNKNOWN"];

  var SOURCE_LABELS = {
    MELI_API: "API do Mercado Livre",
    MELI_ORDER: "Pedido do Mercado Livre",
    MERCADO_PAGO: "Mercado Pago",
    VENFORCE_BASE: "Base VenForce",
    VENFORCE_BASE_HIST: "Base VenForce na venda (histórico)",
    EXTENSION_DOM: "Extensão VenForce",
    DERIVED: "Derivado pelo Motor",
    central_vendas_db: "Central de Vendas",
    orders_api: "Orders API do Mercado Livre",
    planilha_vendas: "Planilha de vendas",
    planilha_custos: "Base de custos",
    ausente: "Não disponível",
  };

  // Rótulo curto da fonte para o cabeçalho da planilha, onde não cabe o nome longo.
  var SOURCE_SHORT_LABELS = {
    MELI_API: "ML API",
    MELI_ORDER: "Pedido ML",
    MERCADO_PAGO: "Mercado Pago",
    VENFORCE_BASE: "Base",
    VENFORCE_BASE_HIST: "Base na venda",
    EXTENSION_DOM: "Extensão",
    DERIVED: "Derivado",
  };

  // Rótulo ULTRA curto para o controle compacto do cabeçalho da planilha
  // (o nome completo continua disponível via title/aria-label do <select>).
  var SOURCE_SELECT_LABELS = {
    MELI_API: "ML",
    MELI_ORDER: "Pedido",
    MERCADO_PAGO: "Mercado Pago",
    VENFORCE_BASE: "Base",
    VENFORCE_BASE_HIST: "Base venda",
    EXTENSION_DOM: "Extensão",
    DERIVED: "Derivado",
  };

  /*
   * Composição da planilha
   * ----------------------
   * As seis variáveis que entram na fórmula de LC/MC, com as fontes que o
   * Motor de Margem realmente sabe produzir para cada uma (ver
   * server/services/motorMargem/adapters/*). Fonte que não existe no contrato
   * não vira opção fantasma: ela aparece como "Indisponível" e o valor
   * permanece null.
   *
   * SLOT = FONTE + MOMENTO. Uma mesma fonte pode observar os dois momentos:
   * a Base VenForce declara o custo/imposto de HOJE (PROJECTED) e a Central
   * de Vendas grava o custo/imposto que a Base tinha NO MOMENTO DA VENDA
   * (VENFORCE_BASE, kind REALIZED — centralVendasEvidenceAdapter). Escolher
   * só pela fonte misturaria os dois momentos (o mais recente venceria), então
   * cada slot fixa fonte E momento:
   *   VENFORCE_BASE       Base atual            (PROJECTED)
   *   VENFORCE_BASE_HIST  Base na venda         (REALIZED) — o que `valueForKind`
   *                       usa no realizado do backend
   * Taxa fixa não tem histórico: no preset Realizado ela fica indisponível
   * (o realizado do backend também não a desconta) — nunca a taxa fixa atual.
   */
  var VARIABLES = ["price", "cost", "tax", "commission", "freight", "fixedFee"];

  var VARIABLE_META = {
    price: { label: "Preço", field: "price", format: "money" },
    cost: { label: "Custo", field: "cost", format: "money" },
    tax: { label: "Imposto", field: "taxRate", format: "percent" },
    commission: { label: "Comissão", field: "commission", format: "money" },
    freight: { label: "Frete", field: "freight", format: "money" },
    fixedFee: { label: "Taxa fixa", field: "fixedFee", format: "money" },
  };

  var SLOT_DEFS = {
    MELI_API: { source: "MELI_API", kind: "PROJECTED" },
    EXTENSION_DOM: { source: "EXTENSION_DOM", kind: "PROJECTED" },
    MELI_ORDER: { source: "MELI_ORDER", kind: "REALIZED" },
    MERCADO_PAGO: { source: "MERCADO_PAGO", kind: "REALIZED" },
    VENFORCE_BASE: { source: "VENFORCE_BASE", kind: "PROJECTED" },
    VENFORCE_BASE_HIST: { source: "VENFORCE_BASE", kind: "REALIZED" },
  };

  function slotDef(slot) {
    return SLOT_DEFS[slot] || { source: slot, kind: null };
  }

  /** Slot que representa uma observação (fonte + momento) do contrato. */
  function slotOf(source, kind) {
    var wanted = String(kind || "").toUpperCase();
    var ids = Object.keys(SLOT_DEFS);
    for (var i = 0; i < ids.length; i += 1) {
      if (SLOT_DEFS[ids[i]].source === source && SLOT_DEFS[ids[i]].kind === wanted) return ids[i];
    }
    return source || null;
  }

  var SOURCE_SLOTS = {
    price: ["MELI_API", "EXTENSION_DOM", "MELI_ORDER"],
    cost: ["VENFORCE_BASE", "VENFORCE_BASE_HIST"],
    tax: ["VENFORCE_BASE", "VENFORCE_BASE_HIST"],
    commission: ["MELI_API", "MELI_ORDER"],
    freight: ["MELI_API", "EXTENSION_DOM", "MELI_ORDER"],
    fixedFee: ["VENFORCE_BASE", "VENFORCE_BASE_HIST"],
  };

  var PRESETS = {
    projected: {
      price: "MELI_API",
      cost: "VENFORCE_BASE",
      tax: "VENFORCE_BASE",
      commission: "MELI_API",
      freight: "MELI_API",
      fixedFee: "VENFORCE_BASE",
    },
    realized: {
      price: "MELI_ORDER",
      cost: "VENFORCE_BASE_HIST",
      tax: "VENFORCE_BASE_HIST",
      commission: "MELI_ORDER",
      freight: "MELI_ORDER",
      fixedFee: "VENFORCE_BASE_HIST",
    },
  };

  // Mesmas tolerâncias de marginEvidence.js: duas observações só "divergem"
  // quando passam da absoluta e da relativa.
  var MONEY_TOLERANCE = { absolute: 0.05, relative: 0.02 };
  var RATE_TOLERANCE = { absolute: 0.001, relative: 0.02 };

  function toleranceFor(variableKey) {
    return VARIABLE_META[variableKey] && VARIABLE_META[variableKey].format === "percent"
      ? RATE_TOLERANCE
      : MONEY_TOLERANCE;
  }

  function isDifferent(a, b, tolerance) {
    if (a === null || a === undefined || b === null || b === undefined) return false;
    var absolute = Math.abs(a - b);
    if (absolute <= tolerance.absolute) return false;
    var scale = Math.max(Math.abs(a), Math.abs(b));
    return scale > 0 ? absolute / scale > tolerance.relative : true;
  }

  function presetFor(selection) {
    var names = Object.keys(PRESETS);
    for (var i = 0; i < names.length; i += 1) {
      var preset = PRESETS[names[i]];
      var equal = VARIABLES.every(function (key) { return selection[key] === preset[key]; });
      if (equal) return names[i];
    }
    return "custom";
  }

  function clonePreset(name) {
    var preset = PRESETS[name] || PRESETS.projected;
    var out = {};
    VARIABLES.forEach(function (key) { out[key] = preset[key]; });
    return out;
  }

  function numberOrNull(value) {
    if (value === null || value === undefined || value === "") return null;
    var number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function round(value, digits) {
    var number = numberOrNull(value);
    if (number === null) return null;
    var factor = Math.pow(10, digits === undefined ? 2 : digits);
    return Math.round((number + Number.EPSILON) * factor) / factor;
  }

  /*
   * Razões (margem, meta, imposto, comissão) trafegam SEMPRE como fração
   * (0,12 = 12%), em todas as fontes do backend. Nenhuma conversão de escala
   * acontece aqui: valor fora da faixa vira null + motivo (`sink`), nunca um
   * número "corrigido" em silêncio. Margem não tem piso — prejuízo de 113%
   * (−1,1309) é um valor legítimo quando o custo supera o preço.
   */
  var RATIO_RANGES = {
    margin: { min: -Infinity, max: 1, expected: "fração menor ou igual a 1" },
    target: { min: 0, max: 1, expected: "fração entre 0 e 1" },
    rate: { min: 0, max: 1, expected: "fração entre 0 e 1" },
  };

  function checkedRatio(value, kind, label, sink) {
    var number = numberOrNull(value);
    if (number === null) return null;
    var range = RATIO_RANGES[kind];
    if (number >= range.min && number <= range.max) return number;
    if (sink) {
      sink.push({
        field: label,
        value: number,
        reason: label + " fora da faixa esperada (" + range.expected + "): o backend enviou " + number + ".",
      });
    }
    return null;
  }

  function firstValue() {
    for (var i = 0; i < arguments.length; i += 1) {
      var value = arguments[i];
      if (value !== null && value !== undefined && value !== "") return value;
    }
    return null;
  }

  function arrayOf(value) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") return Object.keys(value).map(function (key) { return value[key]; });
    return [];
  }

  function sourceLabel(source) {
    if (!source) return "Fonte não informada";
    return SOURCE_LABELS[source] || String(source).replace(/_/g, " ");
  }

  function normalizeConfidence(input, fallbackExplanation) {
    var raw = input;
    var explanation = fallbackExplanation || null;
    var score = null;

    if (input && typeof input === "object") {
      raw = firstValue(input.level, input.nivel, input.value, input.confidence, input.confianca);
      explanation = firstValue(input.explanation, input.explicacao, input.reason, input.motivo, explanation);
      score = numberOrNull(firstValue(input.score, input.percentual, input.percentage));
    }

    var text = String(raw || "UNKNOWN").trim().toUpperCase();
    var level = "UNKNOWN";
    if (LEVELS.indexOf(text) !== -1) level = text;
    else if (["ALTA", "CONFIAVEL", "REAL", "TRUSTED"].indexOf(text) !== -1) level = "HIGH";
    else if (["MEDIA", "MÉDIA", "PARCIAL", "PARTIAL"].indexOf(text) !== -1) level = "MEDIUM";
    else if (["BAIXA", "BLOQUEADO", "BLOCKED", "SUSPEITO"].indexOf(text) !== -1) level = "LOW";
    else if (["AUSENTE", "NAO_INFORMADA", "NÃO_INFORMADA", "UNAVAILABLE"].indexOf(text) !== -1) level = "UNKNOWN";

    return {
      level: level,
      score: score,
      explanation: explanation || (level === "UNKNOWN" ? "O backend não informou a confiabilidade deste dado." : null),
    };
  }

  function normalizeStatus(value) {
    var text = String(value || "").trim().toUpperCase().replace(/[ -]+/g, "_");
    var aliases = {
      SAUDAVEL: "HEALTHY",
      SAUDÁVEL: "HEALTHY",
      MARGEM_BAIXA: "LOW_MARGIN",
      PREJUIZO: "LOSS",
      PREJUÍZO: "LOSS",
      NAO_VALIDADO: "UNVALIDATED",
      NÃO_VALIDADO: "UNVALIDATED",
      DADO_SUSPEITO: "SUSPECT_DATA",
      DADOS_SUSPEITOS: "SUSPECT_DATA",
      EM_CONCILIACAO: "RECONCILING",
      EM_CONCILIAÇÃO: "RECONCILING",
    };
    text = aliases[text] || text;
    return STATUSES.indexOf(text) !== -1 ? text : "UNVALIDATED";
  }

  function variable(value, options) {
    var opts = options || {};
    var numeric = numberOrNull(value);
    return {
      value: numeric,
      rate: numberOrNull(opts.rate),
      format: opts.format || "money",
      source: opts.source || null,
      sourceLabel: sourceLabel(opts.source),
      confidence: normalizeConfidence(opts.confidence, opts.explanation),
      updatedAt: opts.updatedAt || null,
      detail: opts.detail || null,
      available: numeric !== null,
      estimated: opts.estimated === true,
      raw: opts.raw || null,
    };
  }

  /*
   * Camada de fontes por variável
   * -----------------------------
   * Transforma `fields[x].evidences` (contrato do Motor) em um mapa
   * fonte -> observação, preservando exatamente o que veio: valor, momento
   * (PROJECTED/REALIZED), qualidade, observedAt e nota.
   *
   * O contrato NÃO possui `effectiveAt`; ele é sempre exposto como null para
   * a UI dizer "Não informado" em vez de inventar um horário.
   */
  function evidenceEntry(source, raw, options) {
    var opts = options || {};
    var value = raw ? numberOrNull(firstValue(raw.value, raw.valor)) : null;
    return {
      // `source` é o SLOT (fonte + momento); `origin` é a fonte do contrato.
      source: source,
      origin: slotDef(source).source,
      sourceLabel: sourceLabel(source),
      sourceShort: SOURCE_SHORT_LABELS[source] || sourceLabel(source),
      value: value,
      available: value !== null,
      kind: raw ? firstValue(raw.kind, raw.tipo) : opts.kind || slotDef(source).kind || null,
      quality: raw ? firstValue(raw.quality, raw.qualidade) : null,
      observedAt: raw ? firstValue(raw.observedAt, raw.observadoEm) : null,
      effectiveAt: null,
      note: raw ? firstValue(raw.note, raw.nota, raw.detail) : null,
      declared: opts.declared === true,
      estimated: opts.estimated === true,
    };
  }

  function strongestEvidenceOf(evidences, source, kind) {
    var chosen = null;
    (evidences || []).forEach(function (evidence) {
      if (!evidence) return;
      var evidenceSource = firstValue(evidence.source, evidence.fonte);
      if (evidenceSource !== source) return;
      // Momento faz parte da identidade da observação: Base atual e Base na
      // venda nunca competem entre si pelo "mais recente".
      if (kind && String(firstValue(evidence.kind, evidence.tipo) || "").toUpperCase() !== kind) return;
      if (numberOrNull(firstValue(evidence.value, evidence.valor)) === null) return;
      if (!chosen) { chosen = evidence; return; }
      var current = String(firstValue(evidence.observedAt, evidence.observadoEm) || "");
      var best = String(firstValue(chosen.observedAt, chosen.observadoEm) || "");
      if (current > best) chosen = evidence;
    });
    return chosen;
  }

  /**
   * Monta `item.sources`: para cada variável, uma entrada por fonte conhecida.
   * Fontes declaradas no catálogo aparecem sempre (mesmo ausentes, como
   * "Indisponível"); fontes observadas fora do catálogo são acrescentadas ao
   * final para que a aba Evidências nunca esconda uma observação real.
   */
  function buildSourceMap(fieldsByVariable) {
    var sources = {};
    VARIABLES.forEach(function (variableKey) {
      var field = fieldsByVariable[variableKey] || {};
      var evidences = arrayOf(field.evidences || field.evidencias);
      var entries = {};
      var order = SOURCE_SLOTS[variableKey].slice();
      order.forEach(function (slot) {
        var def = slotDef(slot);
        entries[slot] = evidenceEntry(slot, strongestEvidenceOf(evidences, def.source, def.kind), {
          declared: def.source === "VENFORCE_BASE",
        });
      });
      evidences.forEach(function (evidence) {
        var source = firstValue(evidence && evidence.source, evidence && evidence.fonte);
        if (!source) return;
        var slot = slotOf(source, firstValue(evidence.kind, evidence.tipo));
        if (entries[slot]) return;
        order.push(slot);
        entries[slot] = evidenceEntry(slot, evidence, {});
      });
      sources[variableKey] = { order: order, entries: entries };
    });
    return sources;
  }

  /**
   * O que o PRÓPRIO Motor escolheu para cada variável (`resolveField`:
   * realizado tem precedência sobre projetado). É diferente do que a planilha
   * escolheu via preset, e a aba Evidências mostra os dois lado a lado.
   */
  function buildMotorChoice(fieldsByVariable, sources) {
    var choice = {};
    VARIABLES.forEach(function (variableKey) {
      var field = fieldsByVariable[variableKey] || {};
      var source = firstValue(field.selectedSource, field.fonteSelecionada);
      var value = numberOrNull(firstValue(field.selectedValue, field.valorSelecionado));
      var kind = firstValue(field.selectedKind, field.tipoSelecionado);
      if (source === null || value === null) {
        // Sem os campos `selected*` do contrato, reproduz a mesma regra:
        // realizado vence; dentro do momento, a ordem do catálogo já reflete a
        // força relativa das fontes.
        var bucket = sources[variableKey];
        var realized = null;
        var projected = null;
        bucket.order.forEach(function (candidate) {
          var entry = bucket.entries[candidate];
          if (!entry || !entry.available) return;
          if (entry.kind === "REALIZED") { if (!realized) realized = entry; return; }
          if (!projected) projected = entry;
        });
        var selected = realized || projected;
        source = selected ? selected.source : null;
        value = selected ? selected.value : null;
        kind = selected ? selected.kind : null;
      }
      // `selectedKind` é opcional no contrato: quando não vem, o momento sai
      // da própria evidência escolhida em vez de ficar nulo.
      if (!kind && source) {
        // Mesma regra do resolveField: havendo evidência realizada, é ela a
        // escolhida. Só sem os blocos projected/realized cai na entrada da fonte.
        if (field.realized && firstValue(field.realized.source, field.realized.fonte) === source) kind = "REALIZED";
        else if (field.projected && firstValue(field.projected.source, field.projected.fonte) === source) kind = "PROJECTED";
        else {
          var picked = sources[variableKey] && sources[variableKey].entries[source];
          kind = picked ? picked.kind : null;
        }
      }
      // A escolha do contrato vem como fonte crua; na planilha ela é um slot.
      if (source && kind) source = slotOf(source, kind);
      choice[variableKey] = {
        source: source,
        sourceLabel: source ? sourceLabel(source) : null,
        value: value,
        kind: kind,
        available: value !== null,
      };
    });
    return choice;
  }

  /**
   * Observação de UM slot (fonte + momento) de uma variável. O slot
   * VENFORCE_BASE_HIST devolve o custo/imposto que a Base tinha na venda —
   * o mesmo que `valueForKind(REALIZED)` usa no backend —, nunca a Base de hoje.
   */
  function sourceEntry(item, variableKey, source) {
    var bucket = item && item.sources && item.sources[variableKey];
    if (!bucket) return null;
    return bucket.entries[source] || null;
  }

  function pickEvidence(field, kind, source) {
    if (!field || typeof field !== "object") return null;
    var direct = kind === "REALIZED" ? field.realized : field.projected;
    if (direct && (!source || direct.source === source)) return direct;
    var evidences = arrayOf(field.evidences || field.evidencias);
    for (var i = 0; i < evidences.length; i += 1) {
      var evidence = evidences[i] || {};
      var evidenceKind = String(firstValue(evidence.kind, evidence.tipo) || "").toUpperCase();
      if (kind && evidenceKind !== kind) continue;
      if (source && evidence.source !== source && evidence.fonte !== source) continue;
      return evidence;
    }
    return null;
  }

  function variableFromCanonical(field, options) {
    var opts = options || {};
    if (typeof field === "number" || typeof field === "string") {
      return variable(field, opts);
    }
    field = field || {};
    var evidence = opts.evidence || null;
    var selected = evidence || field.selected || null;
    var value = firstValue(
      opts.value,
      selected && selected.value,
      field.value,
      field.valor,
      field.selectedValue,
      field.valorSelecionado
    );
    var source = firstValue(
      opts.source,
      selected && firstValue(selected.source, selected.fonte),
      field.source,
      field.fonte,
      field.selectedSource
    );
    var updatedAt = firstValue(
      opts.updatedAt,
      selected && firstValue(selected.observedAt, selected.observadoEm),
      field.updatedAt,
      field.observedAt,
      field.atualizadoEm
    );
    return variable(value, {
      rate: firstValue(opts.rate, field.rate, field.percentual),
      format: opts.format,
      source: source,
      confidence: firstValue(opts.confidence, field.confidence, field.confianca),
      explanation: firstValue(opts.explanation, field.explanation, field.explicacao),
      updatedAt: updatedAt,
      detail: firstValue(opts.detail, field.detail, field.detalhe, selected && selected.note),
      estimated: opts.estimated === true || field.estimated === true,
      raw: field,
    });
  }

  var DIVERGENCE_EXPLANATIONS = {
    // Vocabulário do Motor (marginEvidence.DIVERGENCE_TYPES): conflito é
    // defeito de dado; drift é previsto × realizado e não é defeito.
    CONFLICT: "Duas fontes descreveram o mesmo momento e discordaram: alguma delas está errada.",
    DRIFT: "O previsto e o realizado ficaram diferentes. Não é defeito de dado: é o desvio da projeção.",
  };

  function normalizeDivergence(input, fieldName) {
    input = input || {};
    var a = input.a || input.sourceA || input.fonteA || {};
    var b = input.b || input.sourceB || input.fonteB || {};
    var type = String(firstValue(input.type, input.tipo, "CONFLICT")).toUpperCase();
    var fieldKey = firstValue(input.field, input.campo, input.variable, input.variavel, fieldName);
    var variableKey = variableOfField(fieldKey);
    return {
      // `field` preserva a chave canônica do Motor; `variable` continua sendo o
      // rótulo humano que a UI já usava.
      field: fieldKey || null,
      variableKey: variableKey,
      variable: variableKey
        ? VARIABLE_META[variableKey].label
        : firstValue(input.variable, input.variavel, fieldKey, "Dado"),
      type: type,
      sourceAKey: firstValue(a.source, a.fonte, input.sourceA, input.fonteA),
      sourceBKey: firstValue(b.source, b.fonte, input.sourceB, input.fonteB),
      sourceA: sourceLabel(firstValue(a.source, a.fonte, input.sourceA, input.fonteA)),
      sourceB: sourceLabel(firstValue(b.source, b.fonte, input.sourceB, input.fonteB)),
      kindA: firstValue(a.kind, a.tipo),
      kindB: firstValue(b.kind, b.tipo),
      observedAtA: firstValue(a.observedAt, a.observadoEm),
      observedAtB: firstValue(b.observedAt, b.observadoEm),
      valueA: numberOrNull(firstValue(a.value, a.valor, input.valueA, input.valorA)),
      valueB: numberOrNull(firstValue(b.value, b.valor, input.valueB, input.valorB)),
      explanation: firstValue(
        input.explanation, input.explicacao, input.reason, input.motivo,
        DIVERGENCE_EXPLANATIONS[type],
        "As fontes informaram valores diferentes."
      ),
      // "motor" = relatada pelo Motor. "adapter" = comparação feita na leitura
      // de compatibilidade, com a mesma tolerância do núcleo.
      origin: firstValue(input.origin, "motor"),
      format: firstValue(input.format, input.formato, variableKey ? VARIABLE_META[variableKey].format : null, "money"),
    };
  }

  /*
   * O Motor publica a MESMA divergência em dois lugares: dentro de
   * `fields[x].divergences` e achatada em `quality.divergences` (com `field`).
   * Ler os dois é o que garante compatibilidade com payloads parciais — mas
   * exige deduplicar, senão a fila mostraria cada conflito duas vezes.
   */
  function collectDivergences(item, fields) {
    var all = arrayOf(firstValue(item.divergences, item.divergencias, []));
    Object.keys(fields || {}).forEach(function (key) {
      var raw = fields[key];
      arrayOf(raw && firstValue(raw.divergences, raw.divergencias, [])).forEach(function (entry) {
        all.push(Object.assign({ field: key }, entry));
      });
    });
    var seen = {};
    return all.map(function (entry) {
      return normalizeDivergence(entry, firstValue(entry.field, entry.variable));
    }).filter(function (entry) {
      var key = [entry.field, entry.type, entry.sourceAKey, entry.sourceBKey, entry.valueA, entry.valueB].join("|");
      if (seen[key]) return false;
      seen[key] = true;
      return true;
    });
  }

  function normalizeCanonicalItem(raw, context) {
    raw = raw || {};
    var fields = raw.variables || raw.variaveis || raw.fields || raw.campos || {};
    var priceField = fields.price || fields.preco || {};
    var costField = fields.cost || fields.custo || {};
    var taxField = fields.taxRate || fields.imposto || fields.tax || {};
    var commissionField = fields.commission || fields.comissao || {};
    var commissionRateField = fields.commissionRate || fields.comissaoPercentual || {};
    var freightField = fields.freight || fields.frete || {};
    var receiptField = fields.netReceipt || fields.recebimento || {};
    var quality = raw.quality || raw.qualidade || {};
    var confidenceByField = quality.confidenceByField || quality.confiancaPorCampo || {};

    function confidenceFor(fieldKey) {
      var entry = confidenceByField[fieldKey] || {};
      var reasons = arrayOf(firstValue(entry.reasons, entry.motivos, [])).map(function (reason) {
        return typeof reason === "string" ? reason : firstValue(reason.message, reason.mensagem, reason.code, reason.codigo);
      }).filter(Boolean);
      return {
        level: firstValue(entry.level, entry.nivel, "UNKNOWN"),
        explanation: reasons.length ? reasons.join(" ") : null,
      };
    }

    var priceProjected = pickEvidence(priceField, "PROJECTED", "MELI_API") || pickEvidence(priceField, "PROJECTED");
    var priceObserved = pickEvidence(priceField, "PROJECTED", "EXTENSION_DOM");
    var priceRealized = pickEvidence(priceField, "REALIZED", "MELI_ORDER") || pickEvidence(priceField, "REALIZED");
    var freightProjected = pickEvidence(freightField, "PROJECTED", "MELI_API") || pickEvidence(freightField, "PROJECTED");
    var freightRealized = pickEvidence(freightField, "REALIZED", "MELI_ORDER") || pickEvidence(freightField, "REALIZED");
    var receiptRealized = pickEvidence(receiptField, "REALIZED", "MERCADO_PAGO") || pickEvidence(receiptField, "REALIZED");
    var commissionProjected = pickEvidence(commissionField, "PROJECTED", "MELI_API") || pickEvidence(commissionField, "PROJECTED");

    var projectedBlock = raw.projected || raw.projetada || raw.projection || {};
    var realizedBlock = raw.realized || raw.realizada || raw.actual || {};
    var invalidFields = [];
    var projectedMargin = checkedRatio(firstValue(projectedBlock.margin, projectedBlock.margem, raw.projectedMargin, raw.margemProjetada), "margin", "Margem projetada", invalidFields);
    var realizedMargin = checkedRatio(firstValue(realizedBlock.margin, realizedBlock.margem, raw.realizedMargin, raw.margemRealizada), "margin", "Margem realizada", invalidFields);
    var overallReasons = arrayOf(firstValue(quality.reasons, quality.motivos, [])).map(function (reason) {
      return typeof reason === "string" ? reason : firstValue(reason.message, reason.mensagem, reason.code, reason.codigo);
    }).filter(Boolean);
    var confidence = normalizeConfidence({
      level: firstValue(raw.confidence, raw.confianca, raw.overallConfidence, raw.confiancaGeral, quality.confidence),
      explanation: overallReasons.length ? overallReasons.join(" ") : null,
    });
    var itemId = String(firstValue(raw.itemId, raw.item_id, raw.mlb, raw.id, "") || "");

    var variables = {
      price: variableFromCanonical(priceField, { evidence: priceProjected, value: firstValue(raw.price, raw.preco), format: "money", confidence: confidenceFor("price") }),
      observedPrice: variableFromCanonical(priceField, { evidence: priceObserved, format: "money", source: priceObserved && firstValue(priceObserved.source, priceObserved.fonte), confidence: confidenceFor("price") }),
      lastSoldPrice: variableFromCanonical(priceField, { evidence: priceRealized, format: "money", confidence: confidenceFor("price") }),
      cost: variableFromCanonical(costField, { format: "money", value: firstValue(raw.cost, raw.custo), confidence: confidenceFor("cost") }),
      tax: variableFromCanonical(taxField, { format: "percent", value: firstValue(raw.taxRate, raw.impostoPercentual), confidence: confidenceFor("taxRate") }),
      commission: variableFromCanonical(commissionField, {
        evidence: commissionProjected,
        format: "money",
        rate: firstValue(commissionRateField.value, commissionRateField.valor, raw.commissionRate, raw.comissaoPercentual),
        confidence: confidenceFor("commission"),
      }),
      freightExpected: variableFromCanonical(freightField, { evidence: freightProjected, format: "money", confidence: confidenceFor("freight") }),
      freightActual: variableFromCanonical(freightField, { evidence: freightRealized, format: "money", confidence: confidenceFor("freight") }),
      soldValue: variable(firstValue(realizedBlock.soldValue, realizedBlock.valorVendido, raw.soldValue, raw.valorVendido, raw.sales && raw.sales.receita), {
        format: "money", source: "MELI_ORDER", confidence: confidence,
      }),
      netReceipt: variableFromCanonical(receiptField, { evidence: receiptRealized, format: "money", confidence: confidenceFor("netReceipt") }),
      mercadoPago: variableFromCanonical(fields.mercadoPago || receiptField, { format: "money", evidence: receiptRealized, confidence: confidenceFor("netReceipt") }),
    };

    variables.tax.value = checkedRatio(variables.tax.value, "rate", "Alíquota de imposto", invalidFields);
    variables.tax.available = variables.tax.value !== null;
    variables.commission.rate = checkedRatio(variables.commission.rate, "rate", "Taxa de comissão", invalidFields);

    // Simulação de preço é PROSPECTIVA: usa sempre o momento projetado (Base
    // de hoje). `variables.cost/tax` seguem a escolha do Motor (realizado tem
    // precedência) e trariam o custo/imposto HISTÓRICO de quem vendeu.
    function projectedValueOf(field) {
      var evidence = pickEvidence(field, "PROJECTED");
      return evidence ? numberOrNull(firstValue(evidence.value, evidence.valor)) : null;
    }
    var fixedFeeField = fields.fixedFee || fields.taxaFixa || null;
    var projectedTax = projectedValueOf(taxField);
    projectedTax = checkedRatio(projectedTax, "rate", "Alíquota de imposto (projetada)", invalidFields);
    var projectedCost = projectedValueOf(costField);
    var projectedFixedFee = fixedFeeField && typeof fixedFeeField === "object"
      ? projectedValueOf(fixedFeeField)
      : numberOrNull(fixedFeeField);
    var simulationInputs = {
      cost: projectedCost,
      taxRate: projectedTax,
      commissionRate: numberOrNull(firstValue(variables.commission.rate, commissionRateField.selectedValue)),
      freight: variables.freightExpected.value,
      fixedFee: projectedFixedFee === null ? 0 : projectedFixedFee,
      complete: projectedCost !== null && projectedTax !== null &&
        numberOrNull(firstValue(variables.commission.rate, commissionRateField.selectedValue)) !== null &&
        variables.freightExpected.value !== null,
      source: "Motor de Margem",
    };

    var divergences = collectDivergences(raw, fields);
    var status = normalizeStatus(firstValue(raw.status, raw.situacao, raw.operationalStatus, raw.estadoOperacional));
    if (!firstValue(raw.status, raw.situacao, raw.operationalStatus, raw.estadoOperacional) && divergences.length) status = "SUSPECT_DATA";

    // Mapa fonte -> observação por variável, direto das evidências do Motor.
    var fieldsByVariable = {
      price: priceField,
      cost: costField,
      tax: taxField,
      commission: commissionField,
      freight: freightField,
      fixedFee: fields.fixedFee || fields.taxaFixa || {},
    };
    var sources = buildSourceMap(fieldsByVariable);
    var motorChoice = buildMotorChoice(fieldsByVariable, sources);

    // Confiança indexada pelas variáveis da planilha (o mapa `variables` usa
    // nomes de exibição como freightExpected/freightActual e não serve aqui).
    var confidenceByVariable = {
      price: normalizeConfidence(confidenceFor("price")),
      cost: normalizeConfidence(confidenceFor("cost")),
      tax: normalizeConfidence(confidenceFor("taxRate")),
      commission: normalizeConfidence(confidenceFor("commission")),
      freight: normalizeConfidence(confidenceFor("freight")),
      fixedFee: normalizeConfidence(confidenceFor("fixedFee")),
    };

    var salesBlock = raw.sales || raw.vendas || {};
    var settlementBlock = raw.settlement || raw.conciliacaoFinanceira || {};
    var marginBlock = raw.margin || {};
    var comparison = normalizeComparison(raw.projectedVsRealized);

    return {
      id: itemId,
      itemId: itemId,
      sku: firstValue(raw.sku, raw.sellerSku, raw.seller_sku),
      title: firstValue(raw.title, raw.titulo, itemId || "Produto sem título"),
      image: firstValue(raw.image, raw.thumbnail, raw.imagem),
      permalink: firstValue(raw.permalink, raw.url),
      client: context.client,
      marketplace: firstValue(raw.marketplace, context.marketplace, "meli"),
      statusAnuncio: firstValue(raw.statusAnuncio, raw.diagnostico && raw.diagnostico.statusAnuncio),
      status: status,
      confidence: confidence,
      problem: firstValue(raw.problem, raw.problema, raw.mainProblem, raw.problemaPrincipal, invalidFields.length ? invalidFields[0].reason : null, arrayOf(quality.statusReasons)[0], divergences.length ? "Fontes divergentes" : null),
      targetMargin: checkedRatio(firstValue(raw.targetMargin, raw.margemAlvo), "target", "Meta de margem", invalidFields),
      // Preço que atinge a meta, ESTIMADO pelo Motor com a taxa de comissão e o frete do snapshot
      // (a Bancada confirma com cotação real). null quando o Motor não consegue calcular.
      targetPrice: marginBlock.target && marginBlock.target.computable !== false ? numberOrNull(marginBlock.target.price) : null,
      breakEvenPrice: marginBlock.target ? numberOrNull(marginBlock.target.breakEvenPrice) : null,
      invalidFields: invalidFields,
      // Problema de dado detectado pelo Motor (ex.: "custo_suspeito"). Não é
      // recalculado aqui: a tela só exibe o código e o motivo que o backend mandou.
      integrityCode: firstValue(quality.integrityCode, raw.integrityCode),
      integrityReason: firstValue(quality.integrityReason, raw.integrityReason),
      // Central de Vendas fora do ar para este período: o realizado do item é
      // desconhecido (≠ "sem venda"). Só repassa o motivo do backend.
      realizedUnavailable: raw.realizado_motivo ? { reason: raw.realizado_motivo } : null,
      projected: {
        margin: projectedMargin,
        profit: numberOrNull(firstValue(projectedBlock.profit, projectedBlock.lucro, raw.projectedProfit, raw.lucroProjetado)),
        estimated: projectedBlock.estimated === true,
        note: firstValue(projectedBlock.note, projectedBlock.explicacao),
        // Retorno ML da promoção em andamento, já somado à margem pelo backend
        // (margemAtualRebate). A tela só o exibe e o repassa à Composição.
        rebate: numberOrNull(projectedBlock.rebate),
        rebateReason: firstValue(projectedBlock.rebateMotivo, null),
      },
      realized: {
        margin: realizedMargin,
        profit: numberOrNull(firstValue(realizedBlock.profit, realizedBlock.lucro, raw.realizedProfit, raw.lucroRealizado)),
        pending: realizedMargin === null,
      },
      variables: variables,
      sources: sources,
      motorChoice: motorChoice,
      confidenceByVariable: confidenceByVariable,
      divergences: divergences,
      hasOrders: salesBlock.hasOrders === true || numberOrNull(salesBlock.pedidos) > 0,
      // Projetado × Realizado calculado pelo núcleo do Motor
      // (core/marginComparison). A tela só EXIBE — nenhum desvio é
      // recalculado aqui. null quando o backend ainda não envia o bloco.
      comparison: comparison,
      sales: {
        units: numberOrNull(salesBlock.unidades),
        orders: numberOrNull(salesBlock.pedidos),
        revenue: numberOrNull(salesBlock.receita),
        avgPrice: numberOrNull(salesBlock.precoMedio),
        lastSaleAt: firstValue(salesBlock.ultimaVendaEm, salesBlock.lastSoldAt),
        coverage: salesBlock.cobertura || null,
        refund: salesBlock.reembolso || null,
        persistedResult: numberOrNull(salesBlock.resultadoPersistido),
        recalculatedResult: numberOrNull(salesBlock.resultadoRecalculado),
      },
      settlementAvailable: settlementBlock.available === true,
      settlementReason: firstValue(settlementBlock.motivo, settlementBlock.reason),
      reconciliation: firstValue(raw.reconciliation, raw.conciliacao, realizedMargin === null ? "Pendente" : "Disponível"),
      latestOrderId: firstValue(realizedBlock.orderId, realizedBlock.pedidoId, raw.latestOrderId),
      links: raw.links || {},
      simulationInputs: simulationInputs,
      // Rastro da LEITURA ATUAL (não é histórico persistido — o backend não
      // guarda audit trail da Central).
      audit: {
        itemId: itemId,
        sku: firstValue(raw.sku, raw.sellerSku, raw.seller_sku),
        marketplace: firstValue(raw.marketplace, context.marketplace, "meli"),
        clientSlug: context.client && context.client.slug,
        statusReasons: arrayOf(firstValue(quality.statusReasons, quality.motivosStatus, [])),
        qualityReasons: overallReasons,
        projectedMissing: arrayOf(marginBlock.projected && marginBlock.projected.missing),
        projectedAssumed: arrayOf(marginBlock.projected && marginBlock.projected.assumed),
        realizedMissing: arrayOf(marginBlock.realized && marginBlock.realized.missing),
        realizedAssumed: arrayOf(marginBlock.realized && marginBlock.realized.assumed),
        hasConflict: quality.hasConflict === true,
        hasDrift: quality.hasDrift === true,
        settlementReason: firstValue(settlementBlock.motivo, settlementBlock.reason),
        lastSoldAt: firstValue(salesBlock.ultimaVendaEm, salesBlock.lastSoldAt),
        orders: numberOrNull(salesBlock.pedidos),
        units: numberOrNull(salesBlock.unidades),
      },
      raw: raw,
    };
  }

  /*
   * Bloco `projectedVsRealized` do Motor (core/marginComparison) no formato
   * da tela. Nenhuma conta nova: só normaliza nomes e preserva null.
   */
  var COMPARISON_FIELDS = ["price", "commission", "freight", "cost", "taxRate", "fixedFee"];

  function normalizeComparison(raw) {
    if (!raw || typeof raw !== "object") return null;
    function lado(block) {
      block = block || {};
      var out = {};
      COMPARISON_FIELDS.forEach(function (key) { out[key] = numberOrNull(block[key]); });
      out.profit = numberOrNull(block.profit);
      out.margin = numberOrNull(block.margin);
      out.marginPercent = numberOrNull(block.marginPercent);
      out.computable = block.computable === true;
      out.assumed = arrayOf(block.assumed);
      return out;
    }
    var projected = lado(raw.projected);
    var p = raw.projected || {};
    // Retorno ML da promoção em andamento — a MESMA margem/lucro do header já
    // o inclui; aqui é só a linha própria "Retorno ML" do painel.
    projected.rebate = numberOrNull(p.rebate);
    projected.rebateMotivo = firstValue(p.rebateMotivo, null);

    var realized = lado(raw.realized);
    var r = raw.realized || {};
    realized.available = r.available === true;
    realized.missing = arrayOf(r.missing);
    realized.units = numberOrNull(r.units);
    realized.orders = numberOrNull(r.orders);
    realized.revenue = numberOrNull(r.revenue);
    realized.lastSaleAt = r.lastSaleAt || null;
    realized.totalProfit = numberOrNull(r.totalProfit);
    realized.coverage = r.coverage || null;
    // Informativo: retorno ML já embutido na comissão realizada (líquida do
    // subsídio). Nunca somado de novo — só explica a comissão menor.
    realized.rebateEmbutido = numberOrNull(r.rebateEmbutido);
    var drift = null;
    if (raw.drift && typeof raw.drift === "object") {
      drift = {};
      COMPARISON_FIELDS.forEach(function (key) { drift[key] = numberOrNull(raw.drift[key]); });
      drift.taxRatePp = numberOrNull(raw.drift.taxRatePp);
      drift.profit = numberOrNull(raw.drift.profit);
      // Mesmo nome do núcleo (marginComparison.js): o painel e o chip da worklist leem `marginPercentagePoints`.
      drift.marginPercentagePoints = numberOrNull(raw.drift.marginPercentagePoints);
    }
    return {
      status: String(raw.status || "NO_SALES"),
      projected: projected,
      realized: realized,
      drift: drift,
      notComparable: arrayOf(raw.notComparable),
    };
  }

  function countStatuses(items) {
    var counts = { HEALTHY: 0, LOW_MARGIN: 0, LOSS: 0, UNVALIDATED: 0, SUSPECT_DATA: 0, RECONCILING: 0 };
    (items || []).forEach(function (item) {
      if (Object.prototype.hasOwnProperty.call(counts, item.status)) counts[item.status] += 1;
    });
    return counts;
  }

  function normalizeCanonicalResponse(payload, context) {
    payload = payload || {};
    context = context || {};
    var rows = arrayOf(firstValue(payload.items, payload.itens, payload.products, payload.produtos, payload.data && payload.data.items, []));
    var items = rows.map(function (row) { return normalizeCanonicalItem(row, context); });
    var pagination = payload.pagination || payload.paginacao || {};
    var total = numberOrNull(firstValue(pagination.total, pagination.totalItensMl, payload.total, items.length));
    var summaryRaw = payload.summary || payload.resumo || {};
    var statusSummary = summaryRaw.counts || summaryRaw.porStatus || {};
    var counts = countStatuses(items);
    var derivedLastUpdated = items.reduce(function (latest, item) {
      Object.keys(item.variables || {}).forEach(function (key) {
        var timestamp = item.variables[key] && item.variables[key].updatedAt;
        if (timestamp && (!latest || String(timestamp) > String(latest))) latest = timestamp;
      });
      return latest;
    }, null);
    var rawScope = firstValue(summaryRaw.scope, summaryRaw.escopo, "dataset");
    var normalizedScope = ["page", "pagina", "página"].indexOf(String(rawScope).toLowerCase()) !== -1 ? "page" : rawScope;

    return {
      ok: true,
      sourceMode: "motor",
      sourceLabel: "Motor de Margem",
      partial: payload.partial === true || payload.parcial === true,
      client: context.client,
      marketplace: context.marketplace || "meli",
      items: items,
      pagination: {
        page: numberOrNull(firstValue(pagination.page, pagination.pagina, context.page, 1)) || 1,
        limit: numberOrNull(firstValue(pagination.limit, pagination.limite, context.limit, 20)) || 20,
        total: total === null ? items.length : total,
        totalPages: numberOrNull(firstValue(pagination.totalPages, pagination.totalPaginas)) || Math.max(Math.ceil((total || items.length) / (numberOrNull(pagination.limit) || context.limit || 20)), 1),
      },
      summary: {
        monitored: numberOrNull(firstValue(summaryRaw.monitored, summaryRaw.monitorados, summaryRaw.totalItensMl, pagination.totalItensMl, total, items.length)) || 0,
        counts: {
          HEALTHY: numberOrNull(firstValue(summaryRaw.healthy, summaryRaw.saudaveis, statusSummary.HEALTHY, counts.HEALTHY)) || 0,
          LOW_MARGIN: numberOrNull(firstValue(summaryRaw.lowMargin, summaryRaw.margemBaixa, statusSummary.LOW_MARGIN, counts.LOW_MARGIN)) || 0,
          LOSS: numberOrNull(firstValue(summaryRaw.loss, summaryRaw.prejuizo, statusSummary.LOSS, counts.LOSS)) || 0,
          UNVALIDATED: numberOrNull(firstValue(summaryRaw.unvalidated, summaryRaw.naoValidados, statusSummary.UNVALIDATED, counts.UNVALIDATED)) || 0,
          SUSPECT_DATA: numberOrNull(firstValue(summaryRaw.suspectData, summaryRaw.dadosSuspeitos, statusSummary.SUSPECT_DATA, counts.SUSPECT_DATA)) || 0,
          RECONCILING: numberOrNull(firstValue(summaryRaw.reconciling, summaryRaw.emConciliacao, statusSummary.RECONCILING, counts.RECONCILING)) || 0,
        },
        scope: normalizedScope,
      },
      lastUpdated: firstValue(payload.lastUpdated, payload.updatedAt, payload.ultimaAtualizacao, payload.geradoEm, derivedLastUpdated),
      period: payload.period || payload.periodo || null,
      warnings: arrayOf(firstValue(payload.warnings, payload.avisos, [])),
      gaps: arrayOf(firstValue(payload.gaps, payload.lacunas, [])),
    };
  }

  /*
   * WORKSPACE — normaliza o payload de `/operacao/central-margem/:slug/workspace`.
   * Diferente de `normalizeCanonicalResponse` (paginação do servidor), aqui
   * `items` é O CATÁLOGO CARREGADO inteiro (até o teto seguro do backend) e a
   * cobertura (`loaded`/`total`/`partial`) é o que a UI usa para nunca
   * apresentar uma amostra como se fosse o catálogo inteiro.
   */
  function normalizeWorkspaceResponse(payload, context) {
    payload = payload || {};
    context = context || {};
    var rows = arrayOf(firstValue(payload.items, payload.itens, []));
    var items = rows.map(function (row) { return normalizeCanonicalItem(row, context); });
    var coverageRaw = payload.coverage || payload.cobertura || {};
    var loaded = numberOrNull(firstValue(coverageRaw.loaded, coverageRaw.carregados, items.length));
    if (loaded === null) loaded = items.length;
    var total = numberOrNull(firstValue(coverageRaw.total, coverageRaw.totalItensMl, loaded));
    if (total === null) total = loaded;
    var summaryRaw = payload.summary || payload.resumo || {};
    var statusSummary = summaryRaw.counts || summaryRaw.porStatus || {};
    var counts = countStatuses(items);
    var partial = payload.partial === true || payload.parcial === true || coverageRaw.parcial === true || loaded < total;

    return {
      ok: true,
      sourceMode: "motor",
      sourceLabel: "Motor de Margem",
      client: context.client,
      marketplace: context.marketplace || "meli",
      items: items,
      partial: partial,
      coverage: { loaded: loaded, total: total, partial: partial },
      summary: {
        counts: {
          HEALTHY: numberOrNull(firstValue(statusSummary.HEALTHY, counts.HEALTHY)) || 0,
          LOW_MARGIN: numberOrNull(firstValue(statusSummary.LOW_MARGIN, counts.LOW_MARGIN)) || 0,
          LOSS: numberOrNull(firstValue(statusSummary.LOSS, counts.LOSS)) || 0,
          UNVALIDATED: numberOrNull(firstValue(statusSummary.UNVALIDATED, counts.UNVALIDATED)) || 0,
          SUSPECT_DATA: numberOrNull(firstValue(statusSummary.SUSPECT_DATA, counts.SUSPECT_DATA)) || 0,
          RECONCILING: numberOrNull(firstValue(statusSummary.RECONCILING, counts.RECONCILING)) || 0,
        },
        scope: "workspace",
      },
      lastUpdated: firstValue(payload.lastUpdated, payload.updatedAt, payload.ultimaAtualizacao, payload.geradoEm),
      period: payload.period || payload.periodo || null,
      warnings: arrayOf(firstValue(payload.warnings, payload.avisos, [])),
      gaps: arrayOf(firstValue(payload.gaps, payload.lacunas, [])),
    };
  }

  /* =========================================================================
   * CÁLCULO — SEMPRE DO BACKEND
   *
   * Esta tela NÃO tem fórmula financeira. LC e margem de qualquer composição
   * vêm do núcleo do Motor (server/services/motorMargem/core):
   *   - presets Projetado e Realizado: os números que o próprio item já traz;
   *   - qualquer outra seleção de fontes, a hipótese da simulação avançada e o
   *     impacto de cada divergência: POST /api/margem/composicao, em lote,
   *     guardado aqui por chave de insumos.
   * Enquanto o backend não respondeu a composição fica `pending` (e `failed`
   * se ele recusou): nunca um número calculado na tela.
   * ========================================================================= */

  var CALC_INPUTS = ["price", "cost", "tax", "commission", "freight", "fixedFee", "rebate"];
  var CALC_FIELD = { price: "preco", cost: "custo", tax: "aliquota", commission: "comissao", freight: "frete", fixedFee: "taxa_fixa", rebate: "rebate" };
  // Nomes dos campos do núcleo (`faltando`/`assumido`) → variáveis da planilha.
  var CORE_VARIABLE = { price: "price", cost: "cost", taxRate: "tax", commission: "commission", freight: "freight", fixedFee: "fixedFee" };

  var calcStore = {};
  var calcInflight = {};

  function coreVariables(list) {
    return arrayOf(list).map(function (name) { return CORE_VARIABLE[name] || name; });
  }

  function insumosOf(values) {
    var out = {};
    CALC_INPUTS.forEach(function (key) {
      var value = values ? numberOrNull(values[key]) : null;
      out[CALC_FIELD[key]] = value;
    });
    return out;
  }

  function calcKey(values, baseValues, targetMargin) {
    function part(set) {
      return set ? CALC_INPUTS.map(function (key) {
        var value = numberOrNull(set[key]);
        return value === null ? "·" : String(value);
      }).join("|") : "-";
    }
    var target = numberOrNull(targetMargin);
    return part(values) + "#" + part(baseValues) + "#" + (target === null ? "-" : String(target));
  }

  /** Resultado do backend (linha de /composicao) no formato que a tela usa. */
  function normalizeCalc(row) {
    if (!row || typeof row.computavel !== "boolean") return { failed: true, reason: "Resposta do cálculo inválida." };
    var assumed = coreVariables(row.assumido);
    return {
      computable: row.computavel,
      profit: numberOrNull(row.lc),
      margin: numberOrNull(row.margem_ratio),
      missing: coreVariables(row.faltando),
      assumed: assumed,
      strict: row.estrito === true,
      deltaProfit: numberOrNull(row.delta_lc),
      deltaMarginPp: numberOrNull(row.delta_margem_pp),
      deltaTargetPp: numberOrNull(row.delta_meta_pp),
    };
  }

  /** Números do PRÓPRIO item para um preset (calculados pelo Motor, não aqui). */
  function presetCalcOf(item, presetName) {
    var block = presetName === "projected" ? item && item.projected : presetName === "realized" ? item && item.realized : null;
    if (!block) return null;
    var audit = (item && item.audit) || {};
    var assumed = coreVariables(presetName === "projected" ? audit.projectedAssumed : audit.realizedAssumed);
    var computable = block.margin !== null && block.margin !== undefined && block.profit !== null && block.profit !== undefined;
    return {
      computable: computable,
      profit: computable ? block.profit : null,
      margin: computable ? block.margin : null,
      missing: coreVariables(presetName === "projected" ? audit.projectedMissing : audit.realizedMissing),
      assumed: assumed,
      strict: computable && assumed.length === 0,
    };
  }

  /** Guarda as respostas de /composicao. `requests[i]` ↔ `rows[i]` (id = índice). */
  function recordCalcResults(requests, rows) {
    var byId = {};
    arrayOf(rows).forEach(function (row) { if (row && row.id !== undefined) byId[String(row.id)] = row; });
    arrayOf(requests).forEach(function (request, index) {
      delete calcInflight[request.key];
      calcStore[request.key] = normalizeCalc(byId[String(index)]);
    });
  }

  function recordCalcFailure(requests, reason) {
    arrayOf(requests).forEach(function (request) {
      delete calcInflight[request.key];
      calcStore[request.key] = { failed: true, reason: reason || "Não foi possível calcular agora." };
    });
  }

  function markCalcInflight(requests) {
    arrayOf(requests).forEach(function (request) { calcInflight[request.key] = true; });
  }

  /** O pedido ainda precisa ir ao backend? (nem respondido nem a caminho) */
  function needsCalc(request) {
    return Boolean(request) && !calcOf(request.key) && !calcInflight[request.key];
  }

  function resetCalcs() {
    calcStore = {};
    calcInflight = {};
  }

  function calcOf(key) {
    return Object.prototype.hasOwnProperty.call(calcStore, key) ? calcStore[key] : null;
  }

  /**
   * Resolve a composição de um item para uma seleção de fontes. Fonte ausente
   * devolve valor null — nunca zero implícito. LC/MC vêm do backend (ver acima).
   */
  function resolveComposition(item, selection) {
    var chosen = selection && typeof selection === "object" ? selection : PRESETS.projected;
    var values = {};
    var entries = {};
    var unavailable = [];
    VARIABLES.forEach(function (variableKey) {
      var source = chosen[variableKey] || PRESETS.projected[variableKey];
      var entry = sourceEntry(item, variableKey, source);
      entries[variableKey] = entry || evidenceEntry(source, null, {});
      values[variableKey] = entry ? entry.value : null;
      if (!entry || entry.value === null) unavailable.push(variableKey);
    });
    // Retorno ML da promoção em andamento: só acompanha o preço PROJETADO (o
    // preço atual já é o promocional). Preço de pedido/DOM não leva rebate.
    var rebate = (chosen.price || PRESETS.projected.price) === PRESETS.projected.price && item && item.projected
      ? numberOrNull(item.projected.rebate)
      : null;
    values.rebate = rebate;

    var preset = presetFor(chosen);
    var key = calcKey(values);
    var calc = preset === "custom" ? calcOf(key) : presetCalcOf(item, preset);
    var pending = calc === null;
    var failed = Boolean(calc && calc.failed);
    return {
      selection: chosen,
      preset: preset,
      values: values,
      entries: entries,
      unavailable: unavailable,
      pending: pending,
      failed: failed,
      failureReason: failed ? calc.reason : null,
      computable: !pending && !failed && calc.computable === true,
      profit: !pending && !failed ? calc.profit : null,
      margin: !pending && !failed ? calc.margin : null,
      missing: !pending && !failed ? calc.missing : [],
      assumed: !pending && !failed ? calc.assumed : [],
      strict: !pending && !failed && calc.strict === true,
      // O que falta pedir ao backend para esta composição (null = nada).
      request: pending ? { key: key, insumos: insumosOf(values) } : null,
    };
  }

  /**
   * Cenário do drawer: overrides LOCAIS por variável.
   * `{ price: { source, value, manual } }`. Nada aqui é evidência, nada é
   * gravado em Bases e nada altera o produto ou o marketplace. O resultado
   * (LC, MC, Δ) é do backend, comparado com a composição da seleção atual.
   */
  function simulateScenario(item, scenario, baselineSelection) {
    var overrides = scenario && typeof scenario === "object" ? scenario : {};
    var baseline = resolveComposition(item, baselineSelection || PRESETS.projected);
    var values = {};
    var entries = {};
    var changed = [];
    VARIABLES.forEach(function (variableKey) {
      var override = overrides[variableKey] || {};
      var source = override.source || baseline.selection[variableKey];
      var entry = sourceEntry(item, variableKey, source) || evidenceEntry(source, null, {});
      var manual = override.manual === true;
      var value = manual ? numberOrNull(override.value) : entry.value;
      values[variableKey] = value;
      entries[variableKey] = entry;
      if (manual || source !== baseline.selection[variableKey]) changed.push(variableKey);
    });
    // O retorno ML acompanha o preço atual; trocar o preço no cenário o descarta.
    var priceChanged = (overrides.price || {}).manual === true || values.price !== baseline.values.price;
    values.rebate = priceChanged ? null : baseline.values.rebate;
    var targetMargin = item && item.targetMargin;
    targetMargin = targetMargin === undefined ? null : targetMargin;

    var key = calcKey(values, baseline.values, targetMargin);
    var calc = calcOf(key);
    var pending = calc === null;
    var failed = Boolean(calc && calc.failed);
    var ready = !pending && !failed;
    return {
      pending: pending,
      failed: failed,
      failureReason: failed ? calc.reason : null,
      computable: ready && calc.computable === true,
      profit: ready ? calc.profit : null,
      margin: ready ? calc.margin : null,
      missing: ready ? calc.missing : [],
      assumed: ready ? calc.assumed : [],
      strict: ready && calc.strict === true,
      values: values,
      entries: entries,
      changed: changed,
      baseline: baseline,
      deltaProfit: ready ? calc.deltaProfit : null,
      deltaMarginPp: ready ? calc.deltaMarginPp : null,
      targetMargin: targetMargin,
      deltaTargetPp: ready ? calc.deltaTargetPp : null,
      // Sempre local. O backend revalidaria tudo antes de qualquer escrita.
      persisted: false,
      request: pending ? { key: key, insumos: insumosOf(values), base_insumos: insumosOf(baseline.values), meta_margem: targetMargin } : null,
    };
  }

  /* =========================================================================
   * DERIVAÇÕES DE APRESENTAÇÃO
   *
   * O backend classifica cada item em UM status (marginStatus.STATUS_PRECEDENCE):
   * UNVALIDATED > SUSPECT_DATA > LOSS > LOW_MARGIN > RECONCILING > HEALTHY.
   * A precedência é correta para decidir a AÇÃO, mas esconde o resultado
   * financeiro sempre que a qualidade do dado tem precedência — um item em
   * prejuízo com custo ausente aparece só como "Não validado".
   *
   * A Central separa as duas leituras. Estas funções são PURAS e
   * DETERMINÍSTICAS e nunca reescrevem o status canônico:
   *  - quando o status do backend já é financeiro, ele é usado como está;
   *  - só quando o status canônico está ocupado por qualidade de dado é que o
   *    resultado financeiro é derivado das margens que o próprio Motor calculou.
   * O status original continua disponível em `item.status`.
   * ========================================================================= */

  var FINANCIAL_STATUSES = ["HEALTHY", "LOW_MARGIN", "LOSS"];
  var QUALITY_STATUSES = ["UNVALIDATED", "SUSPECT_DATA", "RECONCILING"];

  var FINANCIAL_RESULTS = {
    HEALTHY: { label: "Saudável", tone: "is-success" },
    LOW_MARGIN: { label: "Margem baixa", tone: "is-warning" },
    LOSS: { label: "Prejuízo", tone: "is-danger" },
    UNKNOWN: { label: "Indeterminado", tone: "is-neutral" },
  };

  var INTEGRITY_STATES = {
    RELIABLE: { label: "Confiável", tone: "is-success" },
    SUSPECT: { label: "Suspeito", tone: "is-warning" },
    MISSING: { label: "Não validado", tone: "is-neutral" },
    RECONCILING: { label: "Em conciliação", tone: "is-info" },
  };

  /** Margem que o Motor exibe: a realizada quando existe, senão a projetada. */
  function displayedMargin(item) {
    if (!item) return null;
    if (item.realized && item.realized.margin !== null && item.realized.margin !== undefined) return item.realized.margin;
    if (item.projected && item.projected.margin !== null && item.projected.margin !== undefined) return item.projected.margin;
    return null;
  }

  function financialResult(item) {
    if (!item) return { key: "UNKNOWN", label: FINANCIAL_RESULTS.UNKNOWN.label, tone: FINANCIAL_RESULTS.UNKNOWN.tone, origin: "derived", margin: null, reason: "Item indisponível." };
    if (FINANCIAL_STATUSES.indexOf(item.status) !== -1) {
      return {
        key: item.status,
        label: FINANCIAL_RESULTS[item.status].label,
        tone: FINANCIAL_RESULTS[item.status].tone,
        origin: "backend",
        margin: displayedMargin(item),
        reason: "Classificação financeira informada pelo Motor.",
      };
    }
    var margin = displayedMargin(item);
    if (margin === null) {
      return { key: "UNKNOWN", label: FINANCIAL_RESULTS.UNKNOWN.label, tone: FINANCIAL_RESULTS.UNKNOWN.tone, origin: "derived", margin: null, reason: "Nenhuma margem calculável com os dados disponíveis." };
    }
    if (margin < 0) {
      return { key: "LOSS", label: FINANCIAL_RESULTS.LOSS.label, tone: FINANCIAL_RESULTS.LOSS.tone, origin: "derived", margin: margin, reason: "Margem calculada pelo Motor é negativa." };
    }
    var target = item.targetMargin;
    if (target !== null && target !== undefined && margin < target) {
      return { key: "LOW_MARGIN", label: FINANCIAL_RESULTS.LOW_MARGIN.label, tone: FINANCIAL_RESULTS.LOW_MARGIN.tone, origin: "derived", margin: margin, reason: "Margem abaixo da meta informada pelo Motor." };
    }
    return {
      key: "HEALTHY",
      label: FINANCIAL_RESULTS.HEALTHY.label,
      tone: FINANCIAL_RESULTS.HEALTHY.tone,
      origin: "derived",
      margin: margin,
      reason: target === null || target === undefined
        ? "Margem positiva; nenhuma meta foi informada para comparar."
        : "Margem igual ou acima da meta informada pelo Motor.",
    };
  }

  function dataIntegrity(item) {
    if (!item) return { key: "MISSING", label: INTEGRITY_STATES.MISSING.label, tone: INTEGRITY_STATES.MISSING.tone, origin: "derived", reason: "Item indisponível." };
    // Código de integridade do Motor: vale mesmo quando o status persistido
    // ainda é o anterior à regra (o snapshot só reclassifica no próximo cálculo).
    if (item.integrityCode) {
      return {
        key: "SUSPECT",
        code: item.integrityCode,
        label: INTEGRITY_STATES.SUSPECT.label,
        tone: INTEGRITY_STATES.SUSPECT.tone,
        origin: "backend",
        reason: item.integrityReason || item.problem || "Dado suspeito informado pelo Motor.",
      };
    }
    var map = { UNVALIDATED: "MISSING", SUSPECT_DATA: "SUSPECT", RECONCILING: "RECONCILING" };
    if (QUALITY_STATUSES.indexOf(item.status) !== -1) {
      var key = map[item.status];
      return {
        key: key,
        label: INTEGRITY_STATES[key].label,
        tone: INTEGRITY_STATES[key].tone,
        origin: "backend",
        reason: item.problem || "Estado de qualidade informado pelo Motor.",
      };
    }
    // Campo numérico fora da faixa esperada: o valor foi descartado (null),
    // então o dado é suspeito — nunca "confiável com campo ausente".
    if (item.invalidFields && item.invalidFields.length) {
      return { key: "SUSPECT", label: INTEGRITY_STATES.SUSPECT.label, tone: INTEGRITY_STATES.SUSPECT.tone, origin: "derived", reason: item.invalidFields[0].reason };
    }
    // Status canônico financeiro: a integridade é derivada das mesmas
    // evidências que o Motor expôs, sem inventar sinal novo.
    var variables = item.variables || {};
    if (!variables.price || variables.price.value === null || !variables.cost || variables.cost.value === null) {
      return { key: "MISSING", label: INTEGRITY_STATES.MISSING.label, tone: INTEGRITY_STATES.MISSING.tone, origin: "derived", reason: "Variável obrigatória ausente (preço ou custo)." };
    }
    var divergences = item.divergences || [];
    if (divergences.some(function (entry) { return String(entry.type).toUpperCase() === "CONFLICT"; })) {
      return { key: "SUSPECT", label: INTEGRITY_STATES.SUSPECT.label, tone: INTEGRITY_STATES.SUSPECT.tone, origin: "derived", reason: "Fontes do mesmo momento informaram valores diferentes." };
    }
    if (item.confidence && item.confidence.level === "LOW") {
      return { key: "SUSPECT", label: INTEGRITY_STATES.SUSPECT.label, tone: INTEGRITY_STATES.SUSPECT.tone, origin: "derived", reason: "Confiança baixa em pelo menos uma variável do cálculo." };
    }
    // `reconciling` é estado de PROCESSAMENTO informado pela Central de Vendas.
    // Mercado Pago indisponível não conta: a integração nunca existiu, e tratar
    // ausência permanente como "conciliando" marcaria o catálogo inteiro.
    if (item.reconciling === true) {
      return { key: "RECONCILING", label: INTEGRITY_STATES.RECONCILING.label, tone: INTEGRITY_STATES.RECONCILING.tone, origin: "derived", reason: "A leitura financeira do período ainda está sendo processada." };
    }
    return { key: "RELIABLE", label: INTEGRITY_STATES.RELIABLE.label, tone: INTEGRITY_STATES.RELIABLE.tone, origin: "derived", reason: "Sem dado obrigatório ausente, conflito ou conciliação pendente." };
  }

  /** Placar das duas leituras sobre os itens carregados. */
  function summarizeItems(items) {
    var financial = { HEALTHY: 0, LOW_MARGIN: 0, LOSS: 0, UNKNOWN: 0 };
    var integrity = { RELIABLE: 0, SUSPECT: 0, MISSING: 0, RECONCILING: 0 };
    (items || []).forEach(function (item) {
      financial[financialResult(item).key] += 1;
      integrity[dataIntegrity(item).key] += 1;
    });
    return { financial: financial, integrity: integrity, total: (items || []).length };
  }

  /* =========================================================================
   * FILA DE DIVERGÊNCIAS
   * Uma linha por divergência REAL relatada pelo Motor (CONFLICT/DRIFT).
   * O impacto é recalculado com o núcleo: MC com o valor alternativo menos a
   * MC da composição atual. Nenhuma divergência é inventada.
   * ========================================================================= */

  function variableOfField(fieldKey) {
    var normalized = String(fieldKey || "").trim();
    var keys = Object.keys(VARIABLE_META);
    for (var i = 0; i < keys.length; i += 1) {
      if (VARIABLE_META[keys[i]].field === normalized || keys[i] === normalized) return keys[i];
    }
    return null;
  }

  /**
   * Alguma outra fonte disponível desta variável discorda da selecionada?
   * Usa a mesma tolerância do núcleo — é o marcador "outra fonte difere" da
   * célula, não uma divergência nova.
   */
  function hasSourceDisagreement(item, variableKey, source) {
    var bucket = item && item.sources && item.sources[variableKey];
    if (!bucket) return false;
    var selected = bucket.entries[source];
    if (!selected || !selected.available) return false;
    var tolerance = toleranceFor(variableKey);
    return bucket.order.some(function (other) {
      if (other === source) return false;
      var entry = bucket.entries[other];
      return entry && entry.available && isDifferent(selected.value, entry.value, tolerance);
    });
  }

  /** Valor alternativo de uma divergência e o pedido de cálculo do seu impacto na MC. */
  function divergenceAlternative(item, composition, divergence, chosen) {
    var variableKey = variableOfField(divergence.field);
    if (!variableKey) return null;
    var selectedSource = chosen[variableKey];
    // Lados da divergência como SLOT (fonte + momento): um DRIFT da Base
    // (atual × na venda) tem a mesma fonte nos dois lados.
    var sideA = { source: slotOf(divergence.sourceAKey, divergence.kindA), value: divergence.valueA };
    var sideB = { source: slotOf(divergence.sourceBKey, divergence.kindB), value: divergence.valueB };
    var alternative = sideA.source === selectedSource ? sideB : sideB.source === selectedSource ? sideA : sideB;
    if (alternative.value === null || alternative.value === undefined) return null;
    var alternativeValues = Object.assign({}, composition.values);
    alternativeValues[variableKey] = alternative.value;
    var key = calcKey(alternativeValues, composition.values);
    return {
      variableKey: variableKey,
      selectedSource: selectedSource,
      alternative: alternative,
      key: key,
      request: { key: key, insumos: insumosOf(alternativeValues), base_insumos: insumosOf(composition.values) },
    };
  }

  /**
   * Fila de divergências: uma linha por divergência REAL relatada pelo Motor
   * (CONFLICT/DRIFT). O impacto na MC (em pp) é calculado pelo núcleo no
   * backend (MC com o valor alternativo menos a MC da composição atual);
   * enquanto não chega, `impactPending` e `impactPp: null`. Nenhuma divergência
   * é inventada.
   */
  function divergenceQueue(items, selection) {
    var chosen = selection || PRESETS.projected;
    var rows = [];
    (items || []).forEach(function (item) {
      var composition = resolveComposition(item, chosen);
      (item.divergences || []).forEach(function (divergence) {
        var info = divergenceAlternative(item, composition, divergence, chosen);
        if (!info) return;
        var variableKey = info.variableKey;
        var selectedValue = composition.values[variableKey];
        var calc = calcOf(info.key);
        var impactReady = Boolean(calc && !calc.failed);
        var impactPp = impactReady ? calc.deltaMarginPp : null;

        // CONFLICT é defeito de dado: duas fontes do mesmo momento discordam.
        // DRIFT é previsto × realizado — informação, não defeito — e só sobe a
        // crítica quando o impacto na MC é material.
        var type = String(divergence.type || "").toUpperCase();
        var critical = type === "CONFLICT" || (impactPp !== null && Math.abs(impactPp) >= 2);

        rows.push({
          itemId: item.id,
          title: item.title,
          sku: item.sku,
          variable: variableKey,
          variableLabel: VARIABLE_META[variableKey].label,
          format: VARIABLE_META[variableKey].format,
          type: type || "CONFLICT",
          origin: divergence.origin || "motor",
          selectedSource: info.selectedSource,
          selectedSourceLabel: sourceLabel(info.selectedSource),
          selectedValue: selectedValue,
          alternativeSource: info.alternative.source,
          alternativeSourceLabel: sourceLabel(info.alternative.source),
          alternativeValue: numberOrNull(info.alternative.value),
          impactPp: impactPp,
          impactPending: !calc,
          severity: critical ? "CRITICA" : "REVISAR",
          explanation: divergence.explanation,
        });
      });
    });
    return rows;
  }

  /**
   * O que ainda falta pedir ao backend para a tela renderizar sem número
   * local: composições pendentes (seleção personalizada) dos `compositionItems`
   * e o impacto de cada divergência dos `divergenceItems`. Sem repetição e sem
   * o que já foi respondido ou está a caminho.
   */
  function pendingCalcRequests(compositionItems, divergenceItems, selection) {
    var chosen = selection || PRESETS.projected;
    var seen = {};
    var list = [];
    function add(request) {
      if (!request || seen[request.key] || calcOf(request.key) || calcInflight[request.key]) return;
      seen[request.key] = true;
      list.push(request);
    }
    (compositionItems || []).forEach(function (item) {
      var composition = resolveComposition(item, chosen);
      if (composition.pending) add(composition.request);
    });
    (divergenceItems || []).forEach(function (item) {
      if (!(item.divergences || []).length) return;
      var composition = resolveComposition(item, chosen);
      (item.divergences || []).forEach(function (divergence) {
        var info = divergenceAlternative(item, composition, divergence, chosen);
        if (info) add(info.request);
      });
    });
    return list;
  }

  /* =========================================================================
   * SAÚDE DAS FONTES — derivada apenas do que a resposta carregada informa.
   * Nada é presumido disponível: Mercado Pago e Extensão continuam pendentes
   * enquanto nenhuma evidência real chegar por eles.
   * ========================================================================= */

  var SOURCE_HEALTH_SPEC = [
    { key: "MELI_API", name: "Mercado Livre API", variable: "price", pendingLabel: "sem leitura da API nesta página" },
    { key: "VENFORCE_BASE", name: "Bases VenForce", variable: "cost", pendingLabel: "nenhum custo exposto nesta página" },
    { key: "MELI_ORDER", name: "Pedidos ML", variable: "price", pendingLabel: "sem venda no período" },
    { key: "MERCADO_PAGO", name: "Mercado Pago", variable: null, pendingLabel: "integração pendente" },
    { key: "EXTENSION_DOM", name: "Extensão", variable: "price", pendingLabel: "ingestão pendente" },
  ];

  function sourceHealth(response) {
    var items = (response && response.items) || [];
    var total = items.length;
    return SOURCE_HEALTH_SPEC.map(function (spec) {
      if (spec.key === "MERCADO_PAGO") {
        // Só o adapter de settlement alimentaria esta fonte; enquanto ele não
        // existir no backend, a Central não pode fabricar recebimento líquido.
        var settled = items.filter(function (item) { return item.settlementAvailable === true; }).length;
        if (!total) return { key: spec.key, name: spec.name, state: "UNAVAILABLE", detail: spec.pendingLabel, covered: 0, total: 0 };
        if (settled === 0) return { key: spec.key, name: spec.name, state: "PENDING", detail: spec.pendingLabel, covered: 0, total: total };
        return { key: spec.key, name: spec.name, state: settled === total ? "OK" : "PARTIAL", detail: settled + "/" + total + " conciliados", covered: settled, total: total };
      }
      var covered = items.filter(function (item) {
        var entry = sourceEntry(item, spec.variable, spec.key);
        if (entry && entry.available) return true;
        // Fonte pode alimentar outras variáveis além da amostrada.
        return VARIABLES.some(function (variableKey) {
          var other = sourceEntry(item, variableKey, spec.key);
          return other && other.available;
        });
      }).length;
      if (!total) return { key: spec.key, name: spec.name, state: "UNAVAILABLE", detail: "sem itens carregados", covered: 0, total: 0 };
      if (covered === 0) return { key: spec.key, name: spec.name, state: "PENDING", detail: spec.pendingLabel, covered: 0, total: total };
      return {
        key: spec.key,
        name: spec.name,
        state: covered === total ? "OK" : "PARTIAL",
        detail: covered + "/" + total + " itens nesta página",
        covered: covered,
        total: total,
      };
    });
  }

  /* =========================================================================
   * LEITURA PERSISTIDA (Margin Snapshot)
   * A projetada vem do snapshot calculado em background pelo worker; a tela
   * pagina/filtra/ordena NO SERVIDOR (nunca baixa o catálogo inteiro) e
   * acompanha o run de atualização por polling leve.
   * ========================================================================= */

  var SNAPSHOT_RUN_TERMINAL = ["completed", "failed"];

  function isRunTerminal(status) {
    return SNAPSHOT_RUN_TERMINAL.indexOf(String(status || "")) !== -1;
  }

  // Filtros da planilha → status canônico do Motor (é por ele que o banco
  // filtra e conta). Combinação impossível devolve [] (nenhum resultado).
  var SNAPSHOT_FINANCIAL_STATUS = {
    HEALTHY: ["HEALTHY"],
    LOW_MARGIN: ["LOW_MARGIN"],
    LOSS: ["LOSS"],
    UNKNOWN: ["UNVALIDATED"],
  };
  var SNAPSHOT_INTEGRITY_STATUS = {
    RELIABLE: ["HEALTHY", "LOW_MARGIN", "LOSS"],
    SUSPECT: ["SUSPECT_DATA"],
    MISSING: ["UNVALIDATED"],
    RECONCILING: ["RECONCILING"],
  };

  function snapshotStatusFilter(financial, integrity) {
    var sets = [];
    if (financial) sets.push(SNAPSHOT_FINANCIAL_STATUS[financial] || []);
    if (integrity) sets.push(SNAPSHOT_INTEGRITY_STATUS[integrity] || []);
    if (!sets.length) return null;
    return sets.reduce(function (acc, set) {
      return acc.filter(function (status) { return set.indexOf(status) !== -1; });
    });
  }

  function snapshotRun(raw) {
    if (!raw) return null;
    return {
      runId: raw.runId,
      status: raw.status,
      reason: raw.reason || null,
      totalItems: numberOrNull(raw.totalItems),
      processedItems: numberOrNull(raw.processedItems) || 0,
      successItems: numberOrNull(raw.successItems) || 0,
      failedItems: numberOrNull(raw.failedItems) || 0,
      startedAt: raw.startedAt || null,
      heartbeatAt: raw.heartbeatAt || null,
      finishedAt: raw.finishedAt || null,
      errorCode: raw.errorCode || null,
      errorMessage: raw.errorMessage || null,
      // Sem heartbeat (running) ou sem worker (queued) há N min: o backend avisa, a tela não finge progresso.
      semProgressoMinutos: numberOrNull(raw.semProgressoMinutos),
      parado: raw.parado === true,
    };
  }

  function normalizeSnapshotResumo(payload) {
    payload = payload || {};
    if (payload.habilitado !== true) return { ok: true, enabled: false };
    var refresh = payload.refresh || {};
    var kpis = payload.kpis || null;
    return {
      ok: true,
      enabled: true,
      state: payload.estado === "ready" ? "ready" : "missing",
      action: payload.acao || null,
      message: payload.mensagem || null,
      account: payload.conta || null,
      totalItems: payload.snapshot ? numberOrNull(payload.snapshot.totalItens) : null,
      outsideCatalog: payload.snapshot ? numberOrNull(payload.snapshot.foraDoCatalogo) : null,
      lastCalculatedAt: payload.snapshot ? payload.snapshot.ultimoCalculoEm || null : null,
      kpis: kpis ? {
        total: numberOrNull(kpis.total) || 0,
        counts: {
          HEALTHY: numberOrNull(kpis.porStatus && kpis.porStatus.HEALTHY) || 0,
          LOW_MARGIN: numberOrNull(kpis.porStatus && kpis.porStatus.LOW_MARGIN) || 0,
          LOSS: numberOrNull(kpis.porStatus && kpis.porStatus.LOSS) || 0,
          UNVALIDATED: numberOrNull(kpis.porStatus && kpis.porStatus.UNVALIDATED) || 0,
          SUSPECT_DATA: numberOrNull(kpis.porStatus && kpis.porStatus.SUSPECT_DATA) || 0,
          RECONCILING: numberOrNull(kpis.porStatus && kpis.porStatus.RECONCILING) || 0,
        },
        refresh: kpis.porRefreshStatus || {},
        listings: {
          total: numberOrNull(firstValue(kpis.anuncios && kpis.anuncios.total, kpis.total)) || 0,
          active: numberOrNull(kpis.anuncios && kpis.anuncios.ativos) || 0,
          paused: numberOrNull(kpis.anuncios && kpis.anuncios.pausados) || 0,
        },
        withMargin: numberOrNull(kpis.comMargem) || 0,
        // LC/un somado dos anúncios em Prejuízo (calculado pelo Motor; null = o servidor não informou).
        lossLc: numberOrNull(kpis.lcPrejuizo),
      } : null,
      activeRun: snapshotRun(refresh.runAtivo),
      lastRun: snapshotRun(refresh.ultimoRun),
    };
  }

  function normalizeSnapshotItens(payload, context) {
    payload = payload || {};
    context = context || {};
    var rows = arrayOf(payload.itens);
    var items = rows.map(function (row) {
      var item = normalizeCanonicalItem(row, context);
      item.snapshot = row.snapshot || null;
      item.statusBase = row.statusBase || null;
      return item;
    });
    var pagination = payload.paginacao || {};
    var total = numberOrNull(pagination.total);
    var periodo = payload.periodo || null;
    return {
      ok: true,
      sourceMode: "snapshot",
      sourceLabel: "Leitura persistida",
      client: context.client,
      marketplace: context.marketplace || "meli",
      state: payload.estado === "ready" ? "ready" : "missing",
      items: items,
      partial: false,
      coverage: { loaded: total === null ? 0 : total, total: total === null ? 0 : total, partial: false },
      pagination: {
        page: numberOrNull(pagination.page) || 1,
        limit: numberOrNull(pagination.limit) || 50,
        total: total,
        totalPages: numberOrNull(pagination.totalPaginas) || 1,
      },
      summary: { counts: countStatuses(items), scope: "page" },
      lastUpdated: payload.ultimoCalculoEm || null,
      // Período resolvido pelo SERVIDOR (fuso da operação, padrão até ontem).
      period: periodo
        ? { inicio: periodo.dateFrom, fim: periodo.dateTo, mode: periodo.modo || null, value: periodo.periodo || null, label: periodo.rotulo || (context.period && context.period.label) || null }
        : (context.period || null),
      salesCoverage: normalizeSalesCoverage(payload.vendas && payload.vendas.cobertura),
      salesUnavailable: payload.vendas && payload.vendas.realizado_motivo
        ? { reason: payload.vendas.realizado_motivo, message: payload.vendas.realizado_mensagem || null }
        : null,
      refresh: {
        activeRun: snapshotRun(payload.refresh && payload.refresh.runAtivo),
        lastRun: snapshotRun(payload.refresh && payload.refresh.ultimoRun),
      },
      warnings: [],
      gaps: [],
    };
  }

  function normalizeSalesCoverage(raw) {
    if (!raw || typeof raw !== "object") return null;
    return {
      state: raw.estado || null,
      origin: raw.origem || null,
      syncedUntil: raw.sincronizadoAte || null,
      lastPublishedAt: raw.ultimaPublicacaoEm || null,
      lastImportAt: raw.ultimoImportEm || null,
      months: numberOrNull(raw.meses),
      monthsWithImport: numberOrNull(raw.mesesComImport),
      gaps: arrayOf(raw.lacunas).map(function (gap) {
        return {
          month: gap.competencia,
          from: gap.segmento && gap.segmento.dateFrom,
          to: gap.segmento && gap.segmento.dateTo,
          reason: gap.motivo,
          publishedFrom: gap.publicadoDe || null,
          publishedUntil: gap.publicadoAte || null,
          publishedAt: gap.publicadoEm || null,
        };
      }),
    };
  }

  /* Realizado da CONTA no período (GET .../snapshot/realizado). */
  function normalizeSnapshotRealizado(payload) {
    payload = payload || {};
    if (payload.habilitado === false) return { ok: true, enabled: false };
    var periodo = payload.periodo || {};
    var fresh = payload.freshness || {};
    var k = payload.kpis || {};
    var margem = k.margem || {};
    var drift = k.drift || {};
    var lucro = k.lucro || {};
    // Central de Vendas falhou / nada sincronizado: o backend manda
    // `realizado: null` + `realizado_motivo` e KPIs null. A tela mostra
    // "Indisponível" com o motivo — nunca R$ 0 / 0 pedidos.
    var unavailable = payload.realizado_motivo
      ? { reason: payload.realizado_motivo, message: payload.realizado_mensagem || null }
      : null;
    var out = {
      ok: true,
      enabled: true,
      period: { inicio: periodo.dateFrom || null, fim: periodo.dateTo || null, mode: periodo.modo || null, value: periodo.periodo || null, label: periodo.rotulo || null, reference: periodo.referencia || null },
      coverage: normalizeSalesCoverage(payload.cobertura),
      freshness: {
        state: fresh.estado || null,
        syncedUntil: fresh.sincronizadoAte || null,
        lastPublishedAt: fresh.ultimaPublicacaoEm || null,
        lastImportAt: fresh.ultimoImportEm || null,
        syncInProgress: fresh.syncEmAndamento === true,
        activeSync: fresh.syncAtivo || null,
      },
      kpis: {
        revenue: numberOrNull(k.receita),
        revenueWithoutListing: numberOrNull(k.receitaSemMlb),
        units: numberOrNull(k.unidades),
        orders: numberOrNull(k.pedidos),
        productsWithSales: numberOrNull(k.produtosComVenda),
        profit: numberOrNull(lucro.valor),
        margin: {
          percent: numberOrNull(margem.percent),
          state: margem.estado || "indisponivel",
          revenueCoverage: numberOrNull(margem.coberturaReceita),
          computableProducts: numberOrNull(margem.produtosCalculaveis),
          productsWithoutMargin: numberOrNull(margem.produtosSemMargem),
          estimatedProducts: numberOrNull(margem.produtosEstimados),
          reasons: margem.semMargemPorMotivo || {},
          formula: margem.formula || null,
          fixedFeeNote: margem.taxaFixa || null,
        },
        drift: {
          available: drift.disponivel === true,
          pp: numberOrNull(drift.pp),
          realizedMixPercent: numberOrNull(drift.margemRealizadaMixPercent),
          projectedMixPercent: numberOrNull(drift.margemProjetadaMixPercent),
          compared: numberOrNull(drift.produtosComparados),
          withoutProjection: numberOrNull(drift.produtosSemProjecao),
          thresholdPp: numberOrNull(drift.limitePp),
          negative: numberOrNull(drift.produtosNegativos),
          worst: arrayOf(drift.piores),
          formula: drift.formula || null,
        },
      },
    };
    out.unavailable = unavailable;
    if (unavailable) out.kpis = null;
    return out;
  }

  function apiBase() {
    return String(root.VF_API_BASE || DEFAULT_API_BASE).replace(/\/$/, "");
  }

  function defaultToken() {
    try { return root.localStorage ? root.localStorage.getItem("vf-token") : null; } catch (_) { return null; }
  }

  function buildQuery(params) {
    var query = new URLSearchParams();
    Object.keys(params || {}).forEach(function (key) {
      var value = params[key];
      if (value === null || value === undefined || value === "") return;
      query.set(key, String(value));
    });
    var text = query.toString();
    return text ? "?" + text : "";
  }

  function createClient(options) {
    var opts = options || {};

    function call(path, requestOptions) {
      if (typeof opts.request === "function") return Promise.resolve(opts.request(path, requestOptions || {}));
      var request = requestOptions || {};
      var token = typeof opts.token === "function" ? opts.token() : firstValue(opts.token, defaultToken());
      if (!token) return Promise.resolve({ ok: false, status: 401, error: "Sessão sem token.", type: "auth" });
      var headers = Object.assign({ Authorization: "Bearer " + token }, request.headers || {});
      var init = { method: request.method || "GET", headers: headers, signal: request.signal };
      if (request.body !== undefined) {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(request.body);
      }
      return fetch(apiBase() + path, init).then(function (response) {
        return response.json().catch(function () { return null; }).then(function (data) {
          if (!response.ok || !data || data.ok === false) {
            return {
              ok: false,
              status: response.status,
              data: data,
              error: firstValue(data && data.erro, data && data.motivo, "HTTP " + response.status),
              code: firstValue(data && data.codigo, data && data.code),
              type: response.status === 404 ? "not-found" : "api",
            };
          }
          return { ok: true, status: response.status, data: data };
        });
      }).catch(function (error) {
        if (error && error.name === "AbortError") return { ok: false, status: 0, aborted: true, type: "aborted" };
        return { ok: false, status: 0, error: error && error.message || "Falha de rede.", type: "network" };
      });
    }

    function getClients(signal) {
      return call("/anuncios-meli/clientes", { signal: signal }).then(function (result) {
        if (!result.ok) return result;
        return {
          ok: true,
          clients: arrayOf(result.data.clientes).map(function (client) {
            return {
              id: client.id,
              slug: client.slug,
              name: firstValue(client.nome, client.name, client.slug),
              mlConnected: client.mlConectado === true,
              totalItems: numberOrNull(client.totalAnuncios) || 0,
            };
          }),
        };
      });
    }

    // Leitura AO VIVO (workspace legado): últimos 30 dias ATÉ ONTEM. O sync
    // noturno da Central de Vendas publica o mês corrente só até ontem e um
    // período até hoje faria o backend recusar o import do mês (ver
    // server/services/motorMargem/marginRealizadoPeriodo.js). No modo
    // persistido o período é resolvido pelo SERVIDOR (fuso da operação).
    function dateRange(params) {
      if (params.dateFrom && params.dateTo) return { dateFrom: params.dateFrom, dateTo: params.dateTo };
      var end = new Date();
      end.setDate(end.getDate() - 1);
      var start = new Date(end.getTime());
      start.setDate(start.getDate() - 29);
      function iso(date) {
        var year = date.getFullYear();
        var month = String(date.getMonth() + 1).padStart(2, "0");
        var day = String(date.getDate()).padStart(2, "0");
        return year + "-" + month + "-" + day;
      }
      return { dateFrom: iso(start), dateTo: iso(end) };
    }

    // O Motor canônico não responde neste ambiente (rota ausente). Não há
    // leitura de reserva: calcular margem fora do Motor seria uma segunda
    // fórmula. A tela mostra o erro explícito.
    function motorIndisponivel(result) {
      return {
        ok: false,
        status: result.status,
        error: "O Motor de Margem não está disponível neste ambiente (rota da Central ausente). A margem só é exibida quando calculada pelo Motor.",
        code: "MOTOR_INDISPONIVEL",
        type: "motor-indisponivel",
      };
    }

    function getCentral(params, signal) {
      params = params || {};
      var slug = String(params.clientSlug || "").trim();
      if (!slug) return Promise.resolve({ ok: false, status: 400, error: "Selecione um cliente.", type: "no-client" });
      var context = {
        client: { slug: slug, name: params.clientName || slug },
        marketplace: params.marketplace || "meli",
        page: params.page || 1,
        limit: params.limit || 20,
      };
      var range = dateRange(params);
      context.period = { inicio: range.dateFrom, fim: range.dateTo, label: "Últimos 30 dias (até ontem)" };
      var canonicalQuery = buildQuery({
        marketplace: context.marketplace,
        q: params.search,
        status: params.status,
        view: params.view,
        page: context.page,
        limit: context.limit,
        dateFrom: range.dateFrom,
        dateTo: range.dateTo,
      });

      return call("/operacao/central-margem/" + encodeURIComponent(slug) + canonicalQuery, { signal: signal })
        .then(function (canonical) {
          if (canonical.ok) return normalizeCanonicalResponse(canonical.data, context);
          if (canonical.aborted) return canonical;
          if ([404, 501].indexOf(canonical.status) === -1) {
            return { ok: false, status: canonical.status, error: canonical.error || "O Motor de Margem não respondeu.", code: canonical.code || null, type: canonical.type || "api" };
          }

          return motorIndisponivel(canonical);
        });
    }

    /*
     * WORKSPACE — uma única leitura que alimenta planilha, filtros, KPIs e
     * fila de divergências. Diferente de `getCentral` (paginado no servidor),
     * aqui a página inteira do catálogo carregado (até o teto seguro do
     * backend) volta em `items`; filtro, busca e paginação visual acontecem
     * no cliente sobre esse array. Nenhuma chamada por linha nesta função.
     */
    function getWorkspace(params, signal) {
      params = params || {};
      var slug = String(params.clientSlug || "").trim();
      if (!slug) return Promise.resolve({ ok: false, status: 400, error: "Selecione um cliente.", type: "no-client" });
      var context = {
        client: { slug: slug, name: params.clientName || slug },
        marketplace: params.marketplace || "meli",
      };
      var range = dateRange(params);
      context.period = { inicio: range.dateFrom, fim: range.dateTo, label: "Últimos 30 dias (até ontem)" };
      var workspaceQuery = buildQuery({
        marketplace: context.marketplace,
        dateFrom: range.dateFrom,
        dateTo: range.dateTo,
        maxItens: params.maxItens,
      });

      return call("/operacao/central-margem/" + encodeURIComponent(slug) + "/workspace" + workspaceQuery, { signal: signal })
        .then(function (canonical) {
          if (canonical.ok) return normalizeWorkspaceResponse(canonical.data, context);
          if (canonical.aborted) return canonical;
          if ([404, 501].indexOf(canonical.status) === -1) {
            return { ok: false, status: canonical.status, error: canonical.error || "O Motor de Margem não respondeu.", code: canonical.code || null, type: canonical.type || "api" };
          }

          return motorIndisponivel(canonical);
        });
    }

    function apiError(result, fallback) {
      return { ok: false, status: result.status, error: result.error || fallback, code: result.code || null, type: result.type || "api", aborted: result.aborted === true };
    }

    function snapshotBase(slug) {
      return "/operacao/central-margem/" + encodeURIComponent(slug) + "/snapshot";
    }

    /*
     * Estado da leitura persistida da conta. `enabled:false` = a leitura por
     * snapshot está desligada para este cliente (a tela segue o workspace ao
     * vivo). Chamada ANTES de exigir conta: o backend responde a flag sem
     * resolver conta.
     */
    function getSnapshotResumo(params, signal) {
      params = params || {};
      var slug = String(params.clientSlug || "").trim();
      if (!slug) return Promise.resolve({ ok: false, status: 400, error: "Selecione um cliente.", type: "no-client" });
      return call(snapshotBase(slug) + "/resumo" + buildQuery({ clienteContaId: params.clienteContaId }), { signal: signal })
        .then(function (result) {
          if (!result.ok) return apiError(result, "Não foi possível ler o estado da Central.");
          return normalizeSnapshotResumo(result.data);
        });
    }

    /* Uma PÁGINA do snapshot: filtro, busca, ordenação e paginação no servidor. */
    function getSnapshotItens(params, signal) {
      params = params || {};
      var slug = String(params.clientSlug || "").trim();
      if (!slug) return Promise.resolve({ ok: false, status: 400, error: "Selecione um cliente.", type: "no-client" });
      var context = { client: { slug: slug, name: params.clientName || slug }, marketplace: params.marketplace || "meli" };
      var query = buildQuery({
        clienteContaId: params.clienteContaId,
        page: params.page,
        limit: params.limit,
        status: Array.isArray(params.status) ? params.status.join(",") : params.status,
        statusAnuncio: params.statusAnuncio,
        busca: params.search,
        ordenacao: params.sort,
        direcao: params.direction,
        // Período do REALIZADO: `periodo=YYYY-MM` (parâmetro global do Shell)
        // ou datas explícitas; sem nada, o servidor usa "30 dias até ontem".
        periodo: params.periodo,
        dateFrom: params.dateFrom,
        dateTo: params.dateTo,
      });
      return call(snapshotBase(slug) + "/itens" + query, { signal: signal }).then(function (result) {
        if (!result.ok) return apiError(result, "Não foi possível carregar os itens da leitura persistida.");
        return normalizeSnapshotItens(result.data, context);
      });
    }

    /* Realizado da CONTA no período: KPIs, cobertura e freshness. */
    function getSnapshotRealizado(params, signal) {
      params = params || {};
      var slug = String(params.clientSlug || "").trim();
      if (!slug) return Promise.resolve({ ok: false, status: 400, error: "Selecione um cliente.", type: "no-client" });
      var query = buildQuery({ clienteContaId: params.clienteContaId, periodo: params.periodo, dateFrom: params.dateFrom, dateTo: params.dateTo });
      return call(snapshotBase(slug) + "/realizado" + query, { signal: signal }).then(function (result) {
        if (!result.ok) return apiError(result, "Não foi possível carregar o realizado do período.");
        return normalizeSnapshotRealizado(result.data);
      });
    }

    /* POST refresh: 202 com runId (reaproveita o run ativo da conta). */
    function requestSnapshotRefresh(params) {
      params = params || {};
      var slug = String(params.clientSlug || "").trim();
      return call(snapshotBase(slug) + "/refresh", { method: "POST", body: { clienteContaId: params.clienteContaId } })
        .then(function (result) {
          if (!result.ok) return apiError(result, "Não foi possível iniciar a atualização.");
          return { ok: true, runId: result.data.runId, reused: result.data.reaproveitado === true, run: snapshotRun(result.data.run) };
        });
    }

    function getSnapshotRefreshStatus(params, signal) {
      params = params || {};
      var slug = String(params.clientSlug || "").trim();
      return call(snapshotBase(slug) + "/refresh/" + encodeURIComponent(params.runId) + buildQuery({ clienteContaId: params.clienteContaId }), { signal: signal })
        .then(function (result) {
          if (!result.ok) return apiError(result, "Não foi possível consultar a atualização.");
          return { ok: true, run: snapshotRun(result.data.run) };
        });
    }

    /* =====================================================================
     * PRECIFICAÇÃO (camada segura da Central — /precificacao/*)
     * O backend é a autoridade do cálculo: a tela só envia o preço proposto
     * e o preço que MOSTROU ao operador (precoVisto, stale check). Nenhuma
     * fórmula nova aqui. Recusa esperada chega como ok:false + `data`.
     * ===================================================================== */
    function precificacaoBase(slug) {
      return "/operacao/central-margem/" + encodeURIComponent(slug) + "/precificacao";
    }

    function pricingResult(result, fallback) {
      if (!result.ok) {
        var erro = apiError(result, fallback);
        erro.data = result.data || null;
        return erro;
      }
      return Object.assign({ ok: true }, result.data);
    }

    function pricingBody(params) {
      return {
        clienteContaId: params.clienteContaId,
        itemId: params.itemId,
        tipo: params.tipo || "PRICE",
        novoPreco: params.novoPreco === undefined ? null : params.novoPreco,
        precoVisto: params.precoVisto === undefined ? null : params.precoVisto,
        promotionId: params.promotionId || undefined,
      };
    }

    /*
     * LC/MC de composições (Composição da tabela, simulação avançada e impacto
     * das divergências): o NÚCLEO do Motor calcula, em lote (até 200 por
     * chamada). Somente leitura; a conta é o escopo (cliente_conta_id).
     */
    var COMPOSICAO_LOTE = 200;

    function composicaoChunk(clienteContaId, chunk, offset, signal) {
      var itens = chunk.map(function (request, i) {
        var entry = { id: String(offset + i), insumos: request.insumos };
        if (request.base_insumos) entry.base_insumos = request.base_insumos;
        if (request.meta_margem !== undefined && request.meta_margem !== null) entry.meta_margem = request.meta_margem;
        return entry;
      });
      return call("/api/margem/composicao", { method: "POST", body: { cliente_conta_id: clienteContaId, itens: itens }, signal: signal });
    }

    function calcularComposicoes(params, signal) {
      params = params || {};
      var requests = arrayOf(params.requests);
      if (!requests.length) return Promise.resolve({ ok: true, itens: [] });
      var chunks = [];
      for (var offset = 0; offset < requests.length; offset += COMPOSICAO_LOTE) {
        chunks.push({ offset: offset, list: requests.slice(offset, offset + COMPOSICAO_LOTE) });
      }
      return Promise.all(chunks.map(function (chunk) {
        return composicaoChunk(params.clienteContaId, chunk.list, chunk.offset, signal);
      })).then(function (results) {
        var failed = results.filter(function (result) { return !result.ok; })[0];
        if (failed) return apiError(failed, "Não foi possível calcular a composição agora.");
        var rows = [];
        results.forEach(function (result) { rows = rows.concat(arrayOf(result.data.itens)); });
        return { ok: true, itens: rows };
      });
    }

    /*
     * Bancada do drawer: POST /api/margem/simular — cenários (preco | promo |
     * todas_promos | preco_alvo) de UM anúncio, calculados pelo núcleo do Motor
     * com a cotação real do Mercado Livre em cada preço. Somente leitura.
     * Falha de cotação volta como cenário `bloqueado` com motivo (nunca estimado).
     */
    function simular(params, signal) {
      params = params || {};
      return call("/api/margem/simular", {
        method: "POST",
        body: { cliente_conta_id: params.clienteContaId, mlb: params.mlb, cenarios: arrayOf(params.cenarios) },
        signal: signal,
      }).then(function (result) {
        if (!result.ok) {
          var erro = apiError(result, "Não foi possível simular agora.");
          erro.data = result.data || null;
          return erro;
        }
        return Object.assign({ ok: true }, result.data);
      });
    }

    /* Simulação ao vivo (digitação): não persiste nada, não escreve nada. */
    function simulatePricing(params, signal) {
      params = params || {};
      var slug = String(params.clientSlug || "").trim();
      return call(precificacaoBase(slug) + "/simular", { method: "POST", body: pricingBody(params), signal: signal })
        .then(function (result) { return pricingResult(result, "Não foi possível simular este preço agora."); });
    }

    /* Preview confirmável: tudo relido ao vivo + intenção registrada + fingerprint. */
    function previewPricing(params, signal) {
      params = params || {};
      var slug = String(params.clientSlug || "").trim();
      return call(precificacaoBase(slug) + "/preview", { method: "POST", body: pricingBody(params), signal: signal })
        .then(function (result) { return pricingResult(result, "Não foi possível gerar o preview."); });
    }

    /* Aplicar UM preview. A mesma chave de idempotência em retries nunca gera 2ª escrita. */
    function applyPricing(params) {
      params = params || {};
      var slug = String(params.clientSlug || "").trim();
      var path = params.promotionId
        ? "/operacao/central-margem/" + encodeURIComponent(slug) + "/promocoes/" + encodeURIComponent(params.promotionId) + "/aplicar"
        : precificacaoBase(slug) + "/aplicar";
      // A chave vai no CORPO (não em cabeçalho custom): não exige mudar a
      // lista global de cabeçalhos CORS do servidor.
      return call(path, {
        method: "POST",
        // fingerprint: o do preview que a tela mostrou — o backend recusa se
        // não for exatamente o preview gerado (o id sozinho nunca basta).
        body: { clienteContaId: params.clienteContaId, previewId: params.previewId, idempotencyKey: params.idempotencyKey, fingerprint: params.fingerprint },
      }).then(function (result) { return pricingResult(result, "Não foi possível aplicar a alteração."); });
    }

    function getPricingApplication(params, signal) {
      params = params || {};
      var slug = String(params.clientSlug || "").trim();
      return call(precificacaoBase(slug) + "/aplicacoes/" + encodeURIComponent(params.id) + buildQuery({ clienteContaId: params.clienteContaId }), { signal: signal })
        .then(function (result) { return pricingResult(result, "Não foi possível consultar a aplicação."); });
    }

    function getPricingHistory(params, signal) {
      params = params || {};
      var slug = String(params.clientSlug || "").trim();
      return call(precificacaoBase(slug) + "/historico" + buildQuery({ clienteContaId: params.clienteContaId, itemId: params.itemId }), { signal: signal })
        .then(function (result) { return pricingResult(result, "Não foi possível carregar o histórico."); });
    }

    /* Promoções do ITEM ABERTO (nunca por linha da tabela). */
    function getItemPromotions(params, signal) {
      params = params || {};
      var slug = String(params.clientSlug || "").trim();
      return call(precificacaoBase(slug) + "/promocoes" + buildQuery({ clienteContaId: params.clienteContaId, itemId: params.itemId }), { signal: signal })
        .then(function (result) { return pricingResult(result, "Não foi possível carregar as promoções do Mercado Livre."); });
    }

    /* Promoções da conta (aba Promoções): fonte bulk persistida. `cotacao`:
       "estimada" (padrão, zero chamadas ao ML) ou "viva" (cota só a página ao
       vivo). Filtros `veredito`/`tipo` e paginação NO SERVIDOR
       (page/limit → page, limit, total, hasNext). */
    function getOpportunities(params, signal) {
      params = params || {};
      var slug = String(params.clientSlug || "").trim();
      return call(precificacaoBase(slug) + "/oportunidades" + buildQuery({
        clienteContaId: params.clienteContaId, periodo: params.periodo, page: params.page, limit: params.limit,
        veredito: params.veredito, tipo: params.tipo, busca: params.busca, ordem: params.ordem, cotacao: params.cotacao,
      }), { signal: signal })
        .then(function (result) { return pricingResult(result, "Não foi possível carregar as oportunidades."); });
    }

    /* Promo Snapshot da CONTA (aba Promoções): estado, run em andamento
       (progresso real), última tentativa e se o Atualizar está disponível.
       Só lê o banco — nunca enfileira nada. */
    function promoSnapshotBase(slug) {
      return "/operacao/central-margem/" + encodeURIComponent(slug) + "/promocoes";
    }

    function getPromoSyncStatus(params, signal) {
      params = params || {};
      var slug = String(params.clientSlug || "").trim();
      if (!slug) return Promise.resolve({ ok: false, status: 400, error: "Selecione um cliente.", type: "no-client" });
      return call(promoSnapshotBase(slug) + "/status" + buildQuery({ clienteContaId: params.clienteContaId }), { signal: signal })
        .then(function (result) { return pricingResult(result, "Não foi possível ler o estado das promoções."); });
    }

    /* POST sync: SÓ enfileira a leitura (dedupe por conta + cooldown no
       servidor). Nunca aplica promoção nem altera preço. */
    function requestPromoSync(params) {
      params = params || {};
      var slug = String(params.clientSlug || "").trim();
      if (!slug) return Promise.resolve({ ok: false, status: 400, error: "Selecione um cliente.", type: "no-client" });
      return call(promoSnapshotBase(slug) + "/sync", { method: "POST", body: { clienteContaId: params.clienteContaId } })
        .then(function (result) { return pricingResult(result, "Não foi possível pedir a atualização das promoções."); });
    }

    return {
      getClients: getClients,
      getCentral: getCentral,
      getWorkspace: getWorkspace,
      getSnapshotResumo: getSnapshotResumo,
      getSnapshotItens: getSnapshotItens,
      getSnapshotRealizado: getSnapshotRealizado,
      requestSnapshotRefresh: requestSnapshotRefresh,
      getPromoSyncStatus: getPromoSyncStatus,
      requestPromoSync: requestPromoSync,
      getSnapshotRefreshStatus: getSnapshotRefreshStatus,
      calcularComposicoes: calcularComposicoes,
      simular: simular,
      simulatePricing: simulatePricing,
      previewPricing: previewPricing,
      applyPricing: applyPricing,
      getPricingApplication: getPricingApplication,
      getPricingHistory: getPricingHistory,
      getItemPromotions: getItemPromotions,
      getOpportunities: getOpportunities,
      call: call,
    };
  }

  return {
    STATUSES: STATUSES,
    LEVELS: LEVELS,
    SOURCE_LABELS: SOURCE_LABELS,
    SOURCE_SHORT_LABELS: SOURCE_SHORT_LABELS,
    SOURCE_SELECT_LABELS: SOURCE_SELECT_LABELS,
    VARIABLES: VARIABLES,
    VARIABLE_META: VARIABLE_META,
    SOURCE_SLOTS: SOURCE_SLOTS,
    SLOT_DEFS: SLOT_DEFS,
    slotDef: slotDef,
    slotOf: slotOf,
    PRESETS: PRESETS,
    FINANCIAL_RESULTS: FINANCIAL_RESULTS,
    INTEGRITY_STATES: INTEGRITY_STATES,
    presetFor: presetFor,
    clonePreset: clonePreset,
    resolveComposition: resolveComposition,
    simulateScenario: simulateScenario,
    sourceEntry: sourceEntry,
    buildSourceMap: buildSourceMap,
    financialResult: financialResult,
    dataIntegrity: dataIntegrity,
    summarizeItems: summarizeItems,
    divergenceQueue: divergenceQueue,
    hasSourceDisagreement: hasSourceDisagreement,
    sourceHealth: sourceHealth,
    displayedMargin: displayedMargin,
    sourceLabel: sourceLabel,
    normalizeConfidence: normalizeConfidence,
    normalizeStatus: normalizeStatus,
    normalizeCanonicalItem: normalizeCanonicalItem,
    normalizeCanonicalResponse: normalizeCanonicalResponse,
    normalizeWorkspaceResponse: normalizeWorkspaceResponse,
    pendingCalcRequests: pendingCalcRequests,
    recordCalcResults: recordCalcResults,
    recordCalcFailure: recordCalcFailure,
    markCalcInflight: markCalcInflight,
    needsCalc: needsCalc,
    resetCalcs: resetCalcs,
    calcKey: calcKey,
    insumosOf: insumosOf,
    countStatuses: countStatuses,
    isRunTerminal: isRunTerminal,
    snapshotStatusFilter: snapshotStatusFilter,
    normalizeSnapshotResumo: normalizeSnapshotResumo,
    normalizeSnapshotItens: normalizeSnapshotItens,
    normalizeSnapshotRealizado: normalizeSnapshotRealizado,
    normalizeSalesCoverage: normalizeSalesCoverage,
    normalizeComparison: normalizeComparison,
    createClient: createClient,
    numberOrNull: numberOrNull,
    checkedRatio: checkedRatio,
  };
});
