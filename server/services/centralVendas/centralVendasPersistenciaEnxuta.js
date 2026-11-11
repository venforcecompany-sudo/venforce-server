// server/services/centralVendas/centralVendasPersistenciaEnxuta.js
//
// Persistência ENXUTA dos imports gerados pelo Sync (fonte orders_api + run).
//
// Por que existe (diagnóstico de crescimento do PG, nov/2026): cada run grava
// um snapshot completo da competência, e cada pedido/item/componente era
// gravado TRÊS vezes:
//   1. nas colunas tipadas (o que os leitores usam);
//   2. em <tabela>.payload_json — para itens e componentes, uma cópia do
//      MESMO objeto que já está nas colunas, e que nenhum caminho de leitura
//      seleciona (ITEM_READ_COLUMNS / COMPONENTE_READ_COLUMNS /
//      loadRealizadoByImportIds em centralVendasRepository);
//   3. em central_vendas_imports.payload_json — o motorPayload INTEIRO
//      (pedidos + itens + componentes + resumo), sem leitor nenhum.
//
// Com CENTRAL_VENDAS_SYNC_PERSISTENCIA_ENXUTA=true (opt-in; ausente = formato
// antigo, idêntico ao de antes):
//   - item/componente.payload_json guarda só os `extras`: as chaves que as
//     colunas NÃO reproduzem exatamente. colunas + extras reconstroem o
//     objeto original (reconstruirItem/reconstruirComponente; testado);
//   - import.payload_json guarda um MANIFESTO (contagens + digest por pedido)
//     no lugar do motorPayload — os dados continuam nas linhas e o resumo em
//     resumo_json;
//   - central_vendas_pedidos.payload_json NÃO muda (é lido por
//     buildPedidoContrato: logística/full/pós-venda).
// Só vale para imports do Sync (orders_api com sync_run_id). Planilhas manuais
// e qualquer outra fonte continuam com o formato completo.
//
// O manifesto também permite MEDIR a redundância (pedidos novos / alterados /
// inalterados / removidos em relação ao import vigente) — base de evidência
// para a etapa 2 (cobertura em mosaico), sem mudar nenhuma leitura agora.

const crypto = require("crypto");

const ENV_NAME = "CENTRAL_VENDAS_SYNC_PERSISTENCIA_ENXUTA";
const FORMATO_MANIFESTO = "cv_sync_manifesto_v1";
const VALORES_LIGADO = new Set(["true", "1", "on", "yes", "sim"]);

function isPersistenciaEnxutaHabilitada(env = process.env) {
  const raw = env[ENV_NAME];
  if (raw == null) return false;
  return VALORES_LIGADO.has(String(raw).trim().toLowerCase());
}

// Só imports do Sync: dado automático, reconstruível pela API. Nunca planilha.
function aplicaPersistenciaEnxuta({ fonte, syncRunId }, env = process.env) {
  return isPersistenciaEnxutaHabilitada(env) && fonte === "orders_api" && syncRunId != null;
}

// ---------------------------------------------------------------------------
// Mapa chave do objeto → como a coluna guarda (espelha insertItem/
// insertComponente em centralVendasRepository). `coberto(v)` diz se a coluna
// devolve EXATAMENTE v; senão a chave vai para os extras.
// ---------------------------------------------------------------------------
function texto(v) { return v === null || v === undefined || typeof v === "string"; }
function textoNaoVazio(v) { return v === null || v === undefined || (typeof v === "string" && v !== ""); }
function numerico(escala) {
  return (v) => {
    if (v === null || v === undefined) return true;
    if (typeof v !== "number" || !Number.isFinite(v)) return false;
    return Number(v.toFixed(escala)) === v;
  };
}
function listaJson(v) { return Array.isArray(v); }

const MAPA_ITEM = {
  pedidoId: texto,
  itemId: texto,
  mlb: textoNaoVazio,           // item.mlb || null
  sku: textoNaoVazio,           // item.sku || null
  titulo: textoNaoVazio,        // item.titulo || null
  quantidade: numerico(4),
  valorUnitario: numerico(2),
  receitaProduto: numerico(2),
  custoProduto: numerico(2),
  impostoInterno: numerico(2),
  lucroContribuicao: numerico(2),
  resultado: numerico(2),
  margemContribuicaoPercentual: numerico(4),
  confianca: texto,
  pendencias: listaJson,        // pendencias_json = asJson(pendencias, [])
};

const MAPA_COMPONENTE = {
  pedidoId: texto,
  itemId: textoNaoVazio,        // componente.itemId || null
  tipo: texto,
  valor: numerico(2),
  fonte: textoNaoVazio,         // componente.fonte || null
  confianca: texto,
  obs: textoNaoVazio,           // componente.obs || null
};

function extrasDe(obj, mapa) {
  const extras = {};
  for (const [chave, valor] of Object.entries(obj || {})) {
    if (valor === undefined) continue; // JSON.stringify também a descartaria
    const coberto = mapa[chave];
    if (!coberto || !coberto(valor)) extras[chave] = valor;
  }
  return extras;
}

function extrasDoItem(item) { return extrasDe(item, MAPA_ITEM); }
function extrasDoComponente(componente) { return extrasDe(componente, MAPA_COMPONENTE); }

// ---------------------------------------------------------------------------
// Reconstrução (para auditoria/restauração): linha lida do banco → objeto
// equivalente ao que o motor produziu. Chave ausente no original volta como
// null (o código trata null = ausente; JSON nunca guardou undefined).
// ---------------------------------------------------------------------------
function num(v) { return v === null || v === undefined ? null : Number(v); }
function parseJson(v, fallback) {
  if (v === null || v === undefined) return fallback;
  if (typeof v === "string") { try { return JSON.parse(v); } catch { return fallback; } }
  return v;
}

function reconstruirItem(row) {
  return {
    pedidoId: row.pedido_id,
    itemId: row.item_id,
    mlb: row.mlb ?? null,
    sku: row.sku ?? null,
    titulo: row.titulo ?? null,
    quantidade: num(row.quantidade),
    valorUnitario: num(row.valor_unitario),
    receitaProduto: num(row.receita_produto),
    custoProduto: num(row.custo_produto),
    impostoInterno: num(row.imposto_interno),
    lucroContribuicao: num(row.lucro_contribuicao),
    resultado: num(row.resultado),
    margemContribuicaoPercentual: num(row.margem_contribuicao_percentual),
    confianca: row.confianca,
    pendencias: parseJson(row.pendencias_json, []),
    ...parseJson(row.payload_json, {}),
  };
}

function reconstruirComponente(row) {
  return {
    pedidoId: row.pedido_id,
    itemId: row.item_id ?? null,
    tipo: row.tipo,
    valor: num(row.valor),
    fonte: row.fonte ?? null,
    confianca: row.confianca,
    obs: row.obs ?? null,
    ...parseJson(row.payload_json, {}),
  };
}

// ---------------------------------------------------------------------------
// Digest canônico por pedido (pedido + seus itens + seus componentes).
// ---------------------------------------------------------------------------
function canonico(valor) {
  if (valor === null || typeof valor !== "object") {
    return valor === undefined ? null : valor;
  }
  if (Array.isArray(valor)) return valor.map((v) => (v === undefined ? null : canonico(v)));
  const out = {};
  for (const chave of Object.keys(valor).sort()) {
    if (valor[chave] === undefined) continue;
    out[chave] = canonico(valor[chave]);
  }
  return out;
}

function hash(texto, tamanho = 16) {
  return crypto.createHash("sha256").update(texto).digest("hex").slice(0, tamanho);
}

function digestsPorPedido(motorPayload) {
  const pedidos = motorPayload?.pedidos || [];
  const itensPorPedido = new Map();
  const compsPorPedido = new Map();
  for (const item of motorPayload?.itens || []) {
    const k = String(item.pedidoId);
    if (!itensPorPedido.has(k)) itensPorPedido.set(k, []);
    itensPorPedido.get(k).push(item);
  }
  for (const c of motorPayload?.componentes || []) {
    const k = String(c.pedidoId);
    if (!compsPorPedido.has(k)) compsPorPedido.set(k, []);
    compsPorPedido.get(k).push(c);
  }
  const out = {};
  for (const pedido of pedidos) {
    const k = String(pedido.pedidoId);
    out[k] = hash(JSON.stringify(canonico({
      pedido,
      itens: itensPorPedido.get(k) || [],
      componentes: compsPorPedido.get(k) || [],
    })));
  }
  return out;
}

// Resumo sem o que muda a cada run por construção (identidade do run).
function resumoComparavel(resumo) {
  const { syncRunId, ...resto } = resumo || {};
  return canonico(resto);
}

function construirManifesto({ motorPayload, resumo }) {
  const digests = digestsPorPedido(motorPayload);
  const linhas = Object.keys(digests).sort().map((k) => `${k}:${digests[k]}`).join("\n");
  return {
    formato: FORMATO_MANIFESTO,
    contagens: {
      pedidos: (motorPayload?.pedidos || []).length,
      itens: (motorPayload?.itens || []).length,
      componentes: (motorPayload?.componentes || []).length,
    },
    digestPedidos: hash(linhas, 64),
    digestResumo: hash(JSON.stringify(resumoComparavel(resumo ?? motorPayload?.resumo)), 64),
    digests,
  };
}

// Comparação com o manifesto do import vigente (ou null = sem base).
function compararManifestos(atual, anterior) {
  if (!anterior || anterior.formato !== FORMATO_MANIFESTO || !anterior.digests) {
    return { comparavel: false, motivo: anterior ? "MANIFESTO_ANTERIOR_INVALIDO" : "SEM_MANIFESTO_ANTERIOR" };
  }
  let novos = 0, alterados = 0, inalterados = 0;
  for (const [k, d] of Object.entries(atual.digests)) {
    const antes = anterior.digests[k];
    if (antes === undefined) novos += 1;
    else if (antes === d) inalterados += 1;
    else alterados += 1;
  }
  let removidos = 0;
  for (const k of Object.keys(anterior.digests)) if (!(k in atual.digests)) removidos += 1;
  return {
    comparavel: true,
    novos, alterados, inalterados, removidos,
    identico: novos === 0 && alterados === 0 && removidos === 0
      && atual.digestResumo === anterior.digestResumo,
  };
}

module.exports = {
  ENV_NAME,
  FORMATO_MANIFESTO,
  isPersistenciaEnxutaHabilitada,
  aplicaPersistenciaEnxuta,
  extrasDoItem,
  extrasDoComponente,
  reconstruirItem,
  reconstruirComponente,
  digestsPorPedido,
  construirManifesto,
  compararManifestos,
  canonico,
};
