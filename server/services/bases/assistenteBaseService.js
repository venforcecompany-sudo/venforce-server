// server/services/bases/assistenteBaseService.js
// Serviço do Assistente de Base: analisa planilhas fora do padrão e gera
// preview normalizado (ID / Custo / Imposto) SEM salvar no banco.

const path = require("path");
const XLSX = require("xlsx");
const { repairWorksheetRef } = require("../../utils/excelUtils");
const { normalizeKey } = require("../../utils/textUtils");
const { toNumber, round2 } = require("../../utils/numberUtils");

// ─── Utilitários de letra de coluna ─────────────────────────────────────────

function indicePraLetra(idx) {
  let result = "";
  let n = idx;
  while (n >= 0) {
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26) - 1;
  }
  return result;
}

function letraParaIndice(letra) {
  const upper = String(letra || "").toUpperCase().trim();
  if (!upper) return -1;
  let result = 0;
  for (let i = 0; i < upper.length; i++) {
    result = result * 26 + (upper.charCodeAt(i) - 64);
  }
  return result - 1;
}

// ─── Candidatos de detecção ──────────────────────────────────────────────────

const CANDIDATOS_ID = [
  "id", "mlb", "id anuncio", "id do anuncio", "codigo do anuncio",
  "cod anuncio", "anuncio", "item id", "id mercado livre", "produto id",
];

const CANDIDATOS_CUSTO = [
  "custo", "preco custo", "preco de custo", "custo unitario",
  "custo produto", "cmv", "valor custo", "compra", "preco compra",
];

const EXCLUIR_CUSTO = [
  "venda", "atual", "sugerido", "lucro", "margem",
  "comissao", "frete", "repasse", "receita", "faturamento",
];

const CANDIDATOS_IMPOSTO = [
  "imposto", "aliquota", "tributo", "icms", "taxa imposto", "percentual imposto",
];

// ─── Pontuação de coluna ─────────────────────────────────────────────────────

function pontuarColuna(header, candidatos, exclusoes) {
  const norm = normalizeKey(String(header || ""))
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!norm) return 0;

  if (exclusoes) {
    for (const ex of exclusoes) {
      if (norm.includes(ex)) return 0;
    }
  }
  for (const c of candidatos) {
    if (norm === c) return 95;
  }
  for (const c of candidatos) {
    if (norm.startsWith(c) || c.startsWith(norm)) return 80;
  }
  for (const c of candidatos) {
    if (norm.includes(c) || c.includes(norm)) return 65;
  }
  return 0;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function listarAbas(workbook) {
  return workbook.SheetNames || [];
}

function criarErro(statusCode, mensagem) {
  const err = new Error(mensagem);
  err.statusCode = statusCode;
  return err;
}

// ─── Detecção de linha de cabeçalho ──────────────────────────────────────────

function detectarCabecalho(rowsAsArrays) {
  const MAX_SCAN = Math.min(15, rowsAsArrays.length);
  let melhorLinha = 0;
  let melhorScore = -1;

  for (let i = 0; i < MAX_SCAN; i++) {
    const row = rowsAsArrays[i] || [];
    let score = 0;

    for (const cell of row) {
      const texto = String(cell || "").trim();
      if (!texto) continue;
      score += pontuarColuna(texto, CANDIDATOS_ID);
      score += pontuarColuna(texto, CANDIDATOS_CUSTO, EXCLUIR_CUSTO);
      score += pontuarColuna(texto, CANDIDATOS_IMPOSTO);
    }

    if (score > melhorScore) {
      melhorScore = score;
      melhorLinha = i;
    }
  }

  return melhorLinha;
}

// ─── Detecção de colunas ──────────────────────────────────────────────────────

function detectarColunas(headerRow) {
  const disponiveis = [];
  const scoresId = [];
  const scoresCusto = [];
  const scoresImposto = [];

  headerRow.forEach((cell, idx) => {
    const letra = indicePraLetra(idx);
    const texto = String(cell || "").trim();
    if (texto) disponiveis.push({ coluna: letra, cabecalho: texto });

    scoresId.push({ coluna: letra, cabecalho: texto, score: pontuarColuna(texto, CANDIDATOS_ID) });
    scoresCusto.push({ coluna: letra, cabecalho: texto, score: pontuarColuna(texto, CANDIDATOS_CUSTO, EXCLUIR_CUSTO) });
    scoresImposto.push({ coluna: letra, cabecalho: texto, score: pontuarColuna(texto, CANDIDATOS_IMPOSTO) });
  });

  function melhorCandidato(scores) {
    const sorted = [...scores].sort((a, b) => b.score - a.score);
    const best = sorted[0];
    return best && best.score > 0
      ? { coluna: best.coluna, cabecalho: best.cabecalho, confianca: best.score }
      : null;
  }

  return {
    detectadas: {
      id:      melhorCandidato(scoresId),
      custo:   melhorCandidato(scoresCusto),
      imposto: melhorCandidato(scoresImposto),
    },
    disponiveis,
  };
}

// ─── Normalização ─────────────────────────────────────────────────────────────

function normalizarIdBase(value) {
  if (value === null || value === undefined) return null;
  let text = String(value)
    .replace(/^﻿/, "")
    .trim()
    .replace(/^['"]+|['"]+$/g, "")
    .trim();
  if (!text) return null;

  // Excel serializa números como "12345.0"
  if (/^\d+\.0+$/.test(text)) text = text.replace(/\.0+$/, "");

  // Notação científica (ex: 1.23E+11)
  const sci = text.replace(",", ".");
  if (/^\d+(\.\d+)?[eE]\+?\d+$/.test(sci)) {
    const n = Number(sci);
    if (Number.isFinite(n)) text = Math.trunc(n).toString();
  }

  const upper = text.toUpperCase();
  const mlbMatch = upper.match(/MLB[U]?\d+/);
  if (mlbMatch) return mlbMatch[0];
  if (/^\d+$/.test(text)) return `MLB${text}`;
  if (/^MLB[U]?\d+$/i.test(text)) return upper;

  return text;
}

function normalizarCustoBase(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return round2(toNumber(text));
}

function normalizarImpostoBase(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  const hasPercent = text.includes("%");
  const n = toNumber(text);
  if (hasPercent) return n / 100;
  if (n >= 1) return n / 100;
  return n;
}

// ─── Processamento de linhas ──────────────────────────────────────────────────

function processarLinhas(rowsAsArrays, linhaHeader, mapeamento) {
  const idxId      = mapeamento.id      ? letraParaIndice(mapeamento.id)      : -1;
  const idxCusto   = mapeamento.custo   ? letraParaIndice(mapeamento.custo)   : -1;
  const idxImposto = mapeamento.imposto ? letraParaIndice(mapeamento.imposto) : -1;

  const todas = [];
  const dataRows = rowsAsArrays.slice(linhaHeader + 1);

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i] || [];
    const hasContent = row.some((c) => String(c || "").trim() !== "");
    if (!hasContent) continue;

    const linhaOriginal = linhaHeader + 2 + i; // 1-based, considera header

    todas.push({
      linha_original: linhaOriginal,
      id:      normalizarIdBase(idxId      >= 0 ? row[idxId]      : ""),
      custo:   normalizarCustoBase(idxCusto   >= 0 ? row[idxCusto]   : ""),
      imposto: normalizarImpostoBase(idxImposto >= 0 ? row[idxImposto] : ""),
    });
  }

  return todas;
}

// ─── Resumo ───────────────────────────────────────────────────────────────────

function calcularResumo(linhas) {
  const total    = linhas.length;
  const validas  = linhas.filter((l) => l.id && l.custo !== null).length;
  const importaveis = linhas.filter((l) => l.id && l.custo !== null).length;
  const ignoradas = total - validas;

  const idCounts   = {};
  const idParaCusto = {};
  let duplicados   = 0;
  let conflitos    = 0;

  for (const l of linhas) {
    if (!l.id) continue;
    idCounts[l.id] = (idCounts[l.id] || 0) + 1;
    if (!(l.id in idParaCusto)) {
      idParaCusto[l.id] = l.custo;
    } else if (idParaCusto[l.id] !== l.custo) {
      conflitos++;
    }
  }

  for (const cnt of Object.values(idCounts)) {
    if (cnt > 1) duplicados++;
  }

  return { linhas_lidas: total, linhas_validas: validas, linhas_ignoradas: ignoradas, duplicados, conflitos, linhas_importaveis: importaveis };
}

// ─── Alertas ──────────────────────────────────────────────────────────────────

function gerarAlertas(linhas, mapeamento, resumo) {
  const alertas = [];

  if (!mapeamento.id) {
    alertas.push({ tipo: "sem_coluna_id",    nivel: "erro",    mensagem: "Não foi possível detectar a coluna de ID. Selecione manualmente." });
  }
  if (!mapeamento.custo) {
    alertas.push({ tipo: "sem_coluna_custo", nivel: "erro",    mensagem: "Não foi possível detectar a coluna de custo. Selecione manualmente." });
  }
  if (!mapeamento.imposto) {
    alertas.push({ tipo: "sem_coluna_imposto", nivel: "aviso", mensagem: "Coluna de imposto não detectada. Use 0 ou selecione manualmente." });
  }

  if (resumo.duplicados > 0) {
    alertas.push({ tipo: "duplicidade",    nivel: "warning", mensagem: `Foram encontrados ${resumo.duplicados} IDs duplicados.` });
  }
  if (resumo.conflitos > 0) {
    alertas.push({ tipo: "conflito_custo", nivel: "warning", mensagem: `${resumo.conflitos} IDs com custos diferentes em linhas duplicadas.` });
  }

  const semId = linhas.filter((l) => !l.id).length;
  if (semId > 0) {
    alertas.push({ tipo: "linhas_sem_id", nivel: "warning", mensagem: `${semId} linhas ignoradas por ID ausente ou inválido.` });
  }

  const semCusto = linhas.filter((l) => l.custo === null).length;
  if (semCusto > 0) {
    alertas.push({ tipo: "linhas_sem_custo", nivel: "warning", mensagem: `${semCusto} linhas sem custo detectado.` });
  }

  const custoZero = linhas.filter((l) => l.id && l.custo === 0).length;
  if (custoZero > 0) {
    alertas.push({ tipo: "custo_zerado", nivel: "info", mensagem: `${custoZero} linhas com custo igual a R$ 0,00.` });
  }

  const custoNeg = linhas.filter((l) => l.id && l.custo !== null && l.custo < 0).length;
  if (custoNeg > 0) {
    alertas.push({ tipo: "custo_negativo", nivel: "warning", mensagem: `${custoNeg} linhas com custo negativo.` });
  }

  const impostoAlto = linhas.filter((l) => l.imposto !== null && l.imposto > 1).length;
  if (impostoAlto > 0) {
    alertas.push({ tipo: "imposto_acima_100pct", nivel: "warning", mensagem: `${impostoAlto} linhas com imposto acima de 100%.` });
  }

  return alertas;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

async function analisarPlanilhaBase(buffer, originalname, config) {
  config = config || {};

  const ext = path.extname(String(originalname || "")).toLowerCase();
  if (![".xlsx", ".xls", ".csv"].includes(ext)) {
    throw criarErro(400, "Formato inválido. Envie .xlsx, .xls ou .csv.");
  }

  const workbook = XLSX.read(buffer, { type: "buffer" });
  const abas = listarAbas(workbook);
  if (!abas.length) throw criarErro(400, "A planilha não possui abas válidas.");

  // Seleciona aba: config.aba se fornecida e válida, senão a primeira
  if (config.aba && !workbook.Sheets[config.aba]) {
    throw criarErro(400, `Aba "${config.aba}" não encontrada. Disponíveis: ${abas.join(", ")}.`);
  }
  const nomeAba = (config.aba && workbook.Sheets[config.aba]) ? config.aba : abas[0];

  const sheet = workbook.Sheets[nomeAba];
  repairWorksheetRef(sheet);
  const rowsAsArrays = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false });
  if (!rowsAsArrays.length) throw criarErro(400, "A planilha está vazia.");

  // Linha de cabeçalho
  const linhaHeader = config.linhaCabecalho !== undefined
    ? Math.max(0, parseInt(config.linhaCabecalho) || 0)
    : detectarCabecalho(rowsAsArrays);

  const headerRow = rowsAsArrays[linhaHeader] || [];
  const { detectadas, disponiveis } = detectarColunas(headerRow);

  // Aplica overrides manuais de coluna
  const colunasFinais = {
    id:      detectadas.id,
    custo:   detectadas.custo,
    imposto: detectadas.imposto,
  };

  if (config.colunas) {
    for (const tipo of ["id", "custo", "imposto"]) {
      const letraOverride = config.colunas[tipo];
      if (letraOverride) {
        const letra    = String(letraOverride).toUpperCase().trim();
        const idx      = letraParaIndice(letra);
        const cabecalho = String(headerRow[idx] || "").trim();
        colunasFinais[tipo] = { coluna: letra, cabecalho, confianca: 100 };
      }
    }
  }

  const mapeamento = {
    id:      colunasFinais.id      ? colunasFinais.id.coluna      : null,
    custo:   colunasFinais.custo   ? colunasFinais.custo.coluna   : null,
    imposto: colunasFinais.imposto ? colunasFinais.imposto.coluna : null,
  };

  const todasLinhas     = processarLinhas(rowsAsArrays, linhaHeader, mapeamento);
  const resumo          = calcularResumo(todasLinhas);
  const alertas         = gerarAlertas(todasLinhas, mapeamento, resumo);
  const dadosImportacao = todasLinhas
    .filter((l) => l.id && l.custo !== null)
    .map((l) => ({ id: l.id, custo: l.custo, imposto: l.imposto }));

  // Confiança geral = média das colunas detectadas
  const scoresParciais = ["id", "custo", "imposto"]
    .map((t) => (colunasFinais[t] ? colunasFinais[t].confianca : 0))
    .filter((s) => s > 0);
  const confiancaGeral = scoresParciais.length
    ? Math.round(scoresParciais.reduce((a, b) => a + b, 0) / scoresParciais.length)
    : 0;

  if (confiancaGeral > 0 && confiancaGeral < 50) {
    alertas.push({
      tipo: "baixa_confianca",
      nivel: "warning",
      mensagem: `Confiança geral na detecção automática é baixa (${confiancaGeral}%). Revise os mapeamentos.`,
    });
  }

  return {
    ok: true,
    arquivo:            originalname,
    abas_disponiveis:   abas,
    aba_detectada:      nomeAba,
    linha_cabecalho:    linhaHeader,
    colunas_detectadas: colunasFinais,
    colunas_disponiveis: disponiveis,
    confianca_geral:    confiancaGeral,
    resumo,
    alertas,
    preview:           todasLinhas.slice(0, 50),
    dados_importacao:  dadosImportacao,
  };
}

module.exports = {
  analisarPlanilhaBase,
  listarAbas,
  detectarCabecalho,
  detectarColunas,
  normalizarIdBase,
  normalizarCustoBase,
  normalizarImpostoBase,
  calcularResumo,
  gerarAlertas,
};
