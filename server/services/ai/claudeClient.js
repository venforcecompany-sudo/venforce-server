// server/services/ai/claudeClient.js
// -----------------------------------------------------------------------------
// Client isolado da API da Anthropic (Claude).
//
// Detalhe interno: NÃO é chamado direto pelos services do otimizador.
// Quem fala com o resto do sistema é o aiProvider.js — este arquivo é só o
// "driver" do provedor Claude. Para trocar/adicionar provedor (OpenAI, Gemini),
// cria-se outro client e o aiProvider passa a apontar para ele.
//
// Sem dependências externas: usa o fetch nativo do Node (>= 18).
// A chave vem SOMENTE de process.env.ANTHROPIC_API_KEY.
// -----------------------------------------------------------------------------

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

// Modelo padrão: Haiku 4.5 (rápido e barato, suficiente para texto comercial).
// Pode ser sobrescrito pela env ANTHROPIC_MODEL.
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

const PROVIDER = "anthropic";

function getModel() {
  return process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
}

// ---------------------------------------------------------------------------
// gerarTexto — chamada bruta ao Claude.
//
// Parâmetros:
//   { system, prompt, maxTokens?, temperature? }
//
// Retorno padronizado (NUNCA lança — sempre devolve objeto):
//   sucesso -> { ok:true,  texto, provider, model, usage }
//   erro    -> { ok:false, erro, codigo, provider, model }
//
// Códigos de erro possíveis:
//   NO_API_KEY | HTTP_<status> | TIMEOUT | NETWORK | EMPTY_RESPONSE
// ---------------------------------------------------------------------------
async function gerarTexto({ system, prompt, maxTokens, temperature }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = getModel();

  if (!apiKey) {
    return {
      ok: false,
      codigo: "NO_API_KEY",
      erro: "ANTHROPIC_API_KEY não está configurada no servidor.",
      provider: PROVIDER,
      model,
    };
  }

  const body = {
    model,
    max_tokens: maxTokens || 1500,
    temperature: typeof temperature === "number" ? temperature : 0.4,
    messages: [{ role: "user", content: String(prompt || "") }],
  };
  if (system) body.system = String(system);

  // timeout defensivo de 45s
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);

  let resp;
  try {
    resp = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const abortado = err && err.name === "AbortError";
    return {
      ok: false,
      codigo: abortado ? "TIMEOUT" : "NETWORK",
      erro: abortado
        ? "A chamada à IA excedeu o tempo limite."
        : "Falha de rede ao contatar a IA.",
      provider: PROVIDER,
      model,
    };
  }
  clearTimeout(timer);

  if (!resp.ok) {
    // não loga corpo de erro inteiro para não vazar nada sensível
    let detalhe = "";
    try {
      const j = await resp.json();
      detalhe =
        (j && j.error && j.error.message) ||
        (j && j.error && j.error.type) ||
        "";
    } catch (e) {
      detalhe = "";
    }
    return {
      ok: false,
      codigo: "HTTP_" + resp.status,
      erro:
        "A API da IA respondeu com erro " +
        resp.status +
        (detalhe ? " (" + detalhe + ")" : "") +
        ".",
      provider: PROVIDER,
      model,
    };
  }

  let data;
  try {
    data = await resp.json();
  } catch (e) {
    return {
      ok: false,
      codigo: "EMPTY_RESPONSE",
      erro: "Resposta da IA não pôde ser interpretada.",
      provider: PROVIDER,
      model,
    };
  }

  // O conteúdo vem em data.content[], blocos do tipo "text".
  const texto = Array.isArray(data && data.content)
    ? data.content
        .filter((b) => b && b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("\n")
        .trim()
    : "";

  if (!texto) {
    return {
      ok: false,
      codigo: "EMPTY_RESPONSE",
      erro: "A IA retornou uma resposta vazia.",
      provider: PROVIDER,
      model,
    };
  }

  return {
    ok: true,
    texto,
    provider: PROVIDER,
    model,
    usage: (data && data.usage) || null,
  };
}

module.exports = {
  gerarTexto,
  getModel,
  PROVIDER,
  DEFAULT_MODEL,
};
