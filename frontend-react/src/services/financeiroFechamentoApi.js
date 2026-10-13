// frontend-react/src/services/financeiroFechamentoApi.js
//
// Convergência #3 — o wiring que faltava: GERAR um fechamento (upload +
// processamento) e SALVAR a entrega, direto do Financeiro V3, sem passar
// pelo Portal legado.
//
// Nenhum endpoint novo (Backend Readiness pós-Conv.#2 §5): são os mesmos
//   POST /fechamentos/financeiro   (multipart, motor reusado)
//   POST /entregas-cliente         (grava a entrega; 409 se já existe)
// que o legado (Portal/financeiro.js) sempre chamou. A diferença é que aqui
// `periodo` e `clienteContaId` viajam sempre (a tela V3 mostra os dois no
// cabeçalho), então o backend consegue COMPARAR competência e REGISTRAR a
// operação — as duas coisas que a Pessoa 2 abriu no BLOCO 8/D2.
//
// `apiClient.requisitar` não serve para estes dois: ele só fala JSON e, no
// erro, joga fora `code`/`entregaId`/`publicado` — que é justamente o que o
// fluxo de duplicidade (409 ENTREGA_JA_EXISTE) precisa. Por isso um cliente
// próprio, colado no contrato real destes endpoints.

import { API_BASE, getToken, irParaLogin } from "./apiClient.js";

export class FechamentoApiError extends Error {
  constructor(mensagem, { status = 0, codigo = "erro_api", entregaId = null, publicado = false, contas = null } = {}) {
    super(mensagem);
    this.name = "FechamentoApiError";
    this.status = status;
    this.codigo = codigo;
    // 409 ENTREGA_JA_EXISTE — o backend devolve o id do que já existe e se
    // ele está publicado, para a tela oferecer "substituir" em vez de
    // repassar um "use substituir=true" que ninguém consegue acionar.
    this.entregaId = entregaId;
    this.publicado = publicado;
    // 409 CONTA_NAO_PERTENCE_AO_CLIENTE às vezes traz a lista de contas
    // válidas — repassada para a tela sem interpretação.
    this.contas = contas;
  }
}

function exigirToken() {
  const token = getToken();
  if (!token) {
    irParaLogin();
    throw new FechamentoApiError("Sessão expirada.", { status: 401, codigo: "nao_autenticado" });
  }
  return token;
}

// O envelope de erro dos dois endpoints não é o mesmo: /fechamentos/financeiro
// usa `error`, /entregas-cliente usa `erro`. Ler os dois (e `message`).
function mensagemDeErro(dados, status) {
  return (
    dados?.erro ||
    dados?.error ||
    dados?.message ||
    `Falha na requisição (HTTP ${status}).`
  );
}

async function lerJson(resposta) {
  try {
    return await resposta.json();
  } catch {
    return null;
  }
}

function tratarComuns(resposta) {
  if (resposta.status === 401) {
    irParaLogin();
    throw new FechamentoApiError("Sessão expirada. Faça login novamente.", { status: 401, codigo: "nao_autenticado" });
  }
}

// ── POST /fechamentos/financeiro (multipart) ─────────────────────────────────
//
// `form` é um FormData já montado pelo hook (arquivos + marketplace +
// cliente_slug + clienteContaId + periodo + ads/venforce/affiliates/…).
// NÃO seta Content-Type: o browser preenche o boundary do multipart sozinho.
export async function processarFechamento(form, { signal } = {}) {
  const token = exigirToken();

  let resposta;
  try {
    resposta = await fetch(`${API_BASE}/fechamentos/financeiro`, {
      method: "POST",
      signal,
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    throw new FechamentoApiError("Não foi possível falar com o servidor. Verifique a conexão.", {
      status: 0,
      codigo: "rede",
    });
  }

  tratarComuns(resposta);
  const dados = await lerJson(resposta);

  if (!resposta.ok || dados?.ok === false) {
    throw new FechamentoApiError(mensagemDeErro(dados, resposta.status), {
      status: resposta.status,
      codigo: dados?.code || (resposta.status >= 500 ? "servidor" : "erro_api"),
      contas: Array.isArray(dados?.contas) ? dados.contas : null,
    });
  }

  return dados; // { ok, summary, competencia, detailedRows, unmatchedIds, excelBase64, ... }
}

// ── POST /entregas-cliente (JSON) ────────────────────────────────────────────
//
// Cria (ou, com substituir:true, atualiza) a entrega de fechamento. Retorna
// a entrega criada; lança FechamentoApiError com `entregaId`/`publicado`
// quando o backend recusa por duplicidade (409 ENTREGA_JA_EXISTE).
export async function salvarEntregaFechamento(body, { signal } = {}) {
  const token = exigirToken();

  let resposta;
  try {
    resposta = await fetch(`${API_BASE}/entregas-cliente`, {
      method: "POST",
      signal,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    throw new FechamentoApiError("Não foi possível falar com o servidor. Verifique a conexão.", {
      status: 0,
      codigo: "rede",
    });
  }

  tratarComuns(resposta);
  const dados = await lerJson(resposta);

  if (!resposta.ok || dados?.ok === false) {
    throw new FechamentoApiError(mensagemDeErro(dados, resposta.status), {
      status: resposta.status,
      codigo: dados?.code || (resposta.status >= 500 ? "servidor" : "erro_api"),
      entregaId: dados?.entregaId ?? null,
      publicado: dados?.publicado === true,
      contas: Array.isArray(dados?.contas) ? dados.contas : null,
    });
  }

  return dados?.entrega || dados;
}

// ── POST /fechamento-snapshots (JSON) ────────────────────────────────────────
//
// Grava a REVISÃO do fechamento (snapshot): o resultado do motor exatamente
// como veio do processamento + o bloco `processamento` (selo). O backend só
// aceita se o selo bater — números alterados no navegador, linha a menos ou
// outro cliente/conta/competência viram 409 SELO_INVALIDO. Mesmo
// processamento salvo de novo devolve a MESMA revisão (`reaproveitado`).
export async function salvarSnapshotFechamento(body, { signal } = {}) {
  const token = exigirToken();

  let resposta;
  try {
    resposta = await fetch(`${API_BASE}/fechamento-snapshots`, {
      method: "POST",
      signal,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    throw new FechamentoApiError("Não foi possível falar com o servidor. Verifique a conexão.", { status: 0, codigo: "rede" });
  }

  tratarComuns(resposta);
  const dados = await lerJson(resposta);

  if (!resposta.ok || dados?.ok === false) {
    throw new FechamentoApiError(mensagemDeErro(dados, resposta.status), {
      status: resposta.status,
      codigo: dados?.code || (resposta.status >= 500 ? "servidor" : "erro_api"),
    });
  }

  return { snapshot: dados?.snapshot || null, reaproveitado: dados?.reaproveitado === true };
}

// ── PATCH /entregas-cliente/:id (JSON) ───────────────────────────────────────
//
// Atualiza a apresentação (payload_json.entrega) de uma entrega que NUNCA
// teve link público. Entrega que já teve link é histórica: o backend recusa
// com 409 ENTREGA_PUBLICADA_IMUTAVEL — e o `codigo` precisa chegar à tela
// para ela dizer isso em vez de um erro genérico (por isso este cliente, e não
// apiClient.requisitar, que descarta o `code`).
export async function atualizarEntregaFechamento(id, body, { signal } = {}) {
  const token = exigirToken();

  let resposta;
  try {
    resposta = await fetch(`${API_BASE}/entregas-cliente/${encodeURIComponent(id)}`, {
      method: "PATCH",
      signal,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    throw new FechamentoApiError("Não foi possível falar com o servidor. Verifique a conexão.", { status: 0, codigo: "rede" });
  }

  tratarComuns(resposta);
  const dados = await lerJson(resposta);

  if (!resposta.ok || dados?.ok === false) {
    throw new FechamentoApiError(mensagemDeErro(dados, resposta.status), {
      status: resposta.status,
      codigo: dados?.code || (resposta.status >= 500 ? "servidor" : "erro_api"),
      entregaId: dados?.entregaId ?? null,
    });
  }

  return dados?.entrega || dados;
}
