// server/services/fechamentoSnapshot/seloProcessamento.js
//
// O "selo" do processamento: a prova de que um snapshot é a SAÍDA DO MOTOR,
// não um número montado ou alterado no navegador.
//
// POR QUE EXISTE: o processamento (POST /fechamentos/financeiro) é stateless
// — o resultado vai para o navegador e volta quando o operador salva. Sem
// selo, o servidor gravaria como "histórico financeiro" o que o cliente
// mandasse. Com selo, o servidor assina o resultado na saída do motor
// (HMAC-SHA256) e só aceita gravar o snapshot se a assinatura bater.
// Alternativa descartada: gravar todo processamento no banco e "promover" ao
// salvar — gera lixo a cada teste do operador e exige job de limpeza.
//
// O QUE É ASSINADO: o contexto (cliente, conta, competência, marketplace,
// quem/quando processou), tudo o que o snapshot persiste do resultado
// (summary, TODAS as detailedRows, diagnósticos), a origem dos custos, os
// ajustes e o manifesto dos arquivos. Trocar qualquer um invalida o selo —
// inclusive salvar o processamento do Cliente A sob o Cliente B.
//
// JSON CANÔNICO: chaves ordenadas, mesma semântica do JSON.stringify
// (undefined some, NaN/Infinity viram null, toJSON respeitado). O resultado
// atravessa res.json → navegador → express.json e volta idêntico, então o
// mesmo valor sempre gera a mesma string.
//
// CHAVE: derivada do JWT_SECRET (config/jwtSecret.js — que já recusa subir em
// produção sem segredo forte), com separação de domínio. Nenhum env novo.

"use strict";

const crypto = require("crypto");
const { getJwtSecret } = require("../../config/jwtSecret");

const VERSAO_SELO = 1;
const DOMINIO = "vf:fechamento-snapshot:selo:v1";

// Campos da resposta do processamento que o snapshot guarda (e o selo cobre).
// `excelBase64` e `incidente` ficam fora: a planilha entra só como hash no
// manifesto, o incidente é da caixa-preta.
const CAMPOS_DO_RESULTADO = [
  "summary",
  "detailedRows",
  "unmatchedIds",
  "unmatchedCosts",
  "unmatchedCancelled",
  "ignoredRowsWithoutCost",
  "ignoredRevenue",
  "emptySales",
  "message",
  "competencia",
  "costsSource",
  "costsBase",
  "diagnostico",
  "pendingRows",
  "onholdSummary",
];

const AJUSTES = ["ads", "venforce", "affiliates", "fullCost", "additionalCosts"];

function json(valor) {
  if (valor === null || valor === undefined) return "null";
  if (typeof valor.toJSON === "function") return json(valor.toJSON());
  if (typeof valor === "number") return Number.isFinite(valor) ? JSON.stringify(valor) : "null";
  if (typeof valor === "string" || typeof valor === "boolean") return JSON.stringify(valor);
  if (typeof valor === "bigint") return JSON.stringify(valor.toString());
  if (Array.isArray(valor)) {
    return `[${valor.map((v) => (v === undefined || typeof v === "function" ? "null" : json(v))).join(",")}]`;
  }
  if (typeof valor === "object") {
    const partes = [];
    for (const chave of Object.keys(valor).sort()) {
      const v = valor[chave];
      if (v === undefined || typeof v === "function" || typeof v === "symbol") continue;
      partes.push(`${JSON.stringify(chave)}:${json(v)}`);
    }
    return `{${partes.join(",")}}`;
  }
  return "null";
}

function sha256(conteudo) {
  return crypto.createHash("sha256").update(conteudo).digest("hex");
}

function chaveDoSelo() {
  return crypto.createHmac("sha256", getJwtSecret()).update(DOMINIO).digest();
}

// Só o que o snapshot persiste — na MESMA forma nas duas pontas.
function resultadoAssinavel(resposta) {
  const r = {};
  for (const campo of CAMPOS_DO_RESULTADO) {
    if (resposta && resposta[campo] !== undefined) r[campo] = resposta[campo];
  }
  return r;
}

function conteudoDoSelo({ contexto, resultado, processamento }) {
  return json({
    v: VERSAO_SELO,
    contexto: {
      clienteSlug: contexto?.clienteSlug ?? null,
      clienteContaId: contexto?.clienteContaId ?? null,
      periodo: contexto?.periodo ?? null,
      marketplace: contexto?.marketplace ?? null,
    },
    resultado: resultadoAssinavel(resultado),
    processamento: {
      versao: processamento?.versao ?? null,
      processadoEm: processamento?.processadoEm ?? null,
      processadoPor: processamento?.processadoPor ?? null,
      ajustes: processamento?.ajustes ?? null,
      arquivos: processamento?.arquivos ?? null,
      custos: processamento?.custos ?? null,
    },
  });
}

function assinar(dados) {
  return crypto.createHmac("sha256", chaveDoSelo()).update(conteudoDoSelo(dados)).digest("hex");
}

// Comparação em tempo constante; selo malformado nunca lança.
function verificar(dados, selo) {
  if (typeof selo !== "string" || !/^[0-9a-f]{64}$/.test(selo)) return false;
  const esperado = Buffer.from(assinar(dados), "hex");
  const recebido = Buffer.from(selo, "hex");
  return esperado.length === recebido.length && crypto.timingSafeEqual(esperado, recebido);
}

// Manifesto de UM arquivo enviado (multer). Sem binário: nome, tamanho, tipo e
// sha256 — o bastante para provar depois QUAL arquivo gerou o número.
function manifestoDoArquivo(tipo, file) {
  if (!file || !Buffer.isBuffer(file.buffer)) return null;
  return {
    tipo,
    nomeOriginal: String(file.originalname || "arquivo").replace(/[\\/]/g, "_").replace(/[\u0000-\u001f]/g, "").slice(0, 180),
    tamanhoBytes: file.buffer.length,
    mimeType: file.mimetype || "application/octet-stream",
    sha256: sha256(file.buffer),
    origem: "upload",
  };
}

// Impressão digital das linhas de custo efetivamente entregues ao motor
// (planilha OU base vinculada). A base muda com o tempo (upsert); com este
// hash dá para afirmar depois se ela ainda é a mesma daquele fechamento.
// INDEPENDENTE DA ORDEM: a leitura da base não tem ORDER BY (a ordem física
// muda sem o conteúdo mudar), então o hash é do conjunto de linhas canônicas
// ordenadas — mesmo conteúdo, mesmo hash.
function impressaoDosCustos(costRowsRaw) {
  const linhas = Array.isArray(costRowsRaw) ? costRowsRaw : [];
  return { linhas: linhas.length, sha256: sha256(linhas.map((l) => json(l)).sort().join("\n")) };
}

function ajustesDoMotor(valores) {
  const a = {};
  for (const campo of AJUSTES) a[campo] = valores && Number.isFinite(valores[campo]) ? valores[campo] : null;
  return a;
}

// Bloco `processamento` acrescentado à resposta de POST /fechamentos/financeiro.
// Aditivo: o legado (Portal/financeiro.js) ignora.
function selarProcessamento({ contexto, resultado, usuarioId, ajustes, arquivos, costRowsRaw, agora = new Date() }) {
  const processamento = {
    versao: VERSAO_SELO,
    processadoEm: agora.toISOString(),
    processadoPor: usuarioId ?? null,
    ajustes: ajustesDoMotor(ajustes),
    arquivos: (arquivos || []).filter(Boolean),
    custos: impressaoDosCustos(costRowsRaw),
  };
  processamento.selo = assinar({ contexto, resultado, processamento });
  return processamento;
}

module.exports = {
  VERSAO_SELO,
  CAMPOS_DO_RESULTADO,
  json,
  sha256,
  assinar,
  verificar,
  resultadoAssinavel,
  manifestoDoArquivo,
  impressaoDosCustos,
  selarProcessamento,
};
