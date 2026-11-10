// frontend-react/src/services/fechamentoViaApiApi.js
//
// Modo "API do Mercado Livre" do Financeiro V3: o fechamento sai dos pedidos
// que a Central de Vendas JÁ sincronizou da API do ML, em vez de planilha.
// Chamadas deste modo:
//   GET  /financeiro/:cliente/fechamento-api/status   há dados sincronizados desta competência?
//   POST /financeiro/:cliente/fechamento-api          gera o fechamento (mesmo formato da planilha)
//   POST /operacao/central-vendas/:slug/sync-runs     "Sincronizar agora" (só admin)
//   GET  /operacao/central-vendas/:slug/sync-runs/:id acompanha o sync até um estado final
//
// Os dois últimos são o mesmo sync que o Portal legado (Central de Vendas)
// usava; a Central some do menu, mas o endpoint continua — ele é o que
// alimenta o modo API.
//
// Por que um cliente próprio e não apiClient.requisitar: o requisitar joga
// fora o `code` do envelope de erro, e o front precisa dele (ex.:
// CENTRAL_SEM_SYNC vira orientação "sincronize antes", não erro técnico).

import { API_BASE, getToken, irParaLogin } from "./apiClient.js";
import { FechamentoApiError } from "./financeiroFechamentoApi.js";

async function chamar(caminho, { metodo = "GET", corpo, signal } = {}) {
  const token = getToken();
  if (!token) {
    irParaLogin();
    throw new FechamentoApiError("Sessão expirada.", { status: 401, codigo: "nao_autenticado" });
  }

  let resposta;
  try {
    resposta = await fetch(`${API_BASE}${caminho}`, {
      method: metodo,
      signal,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(corpo ? { "Content-Type": "application/json" } : {}),
      },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    throw new FechamentoApiError("Não foi possível falar com o servidor. Verifique a conexão.", { status: 0, codigo: "rede" });
  }

  if (resposta.status === 401) {
    irParaLogin();
    throw new FechamentoApiError("Sessão expirada. Faça login novamente.", { status: 401, codigo: "nao_autenticado" });
  }

  let dados = null;
  try {
    dados = await resposta.json();
  } catch {
    dados = null;
  }

  if (!resposta.ok || dados?.ok === false) {
    // Envelopes diferentes entre os endpoints: `error` (fechamento), `erro` (Central).
    const mensagem = dados?.error || dados?.erro || dados?.message || `Falha na requisição (HTTP ${resposta.status}).`;
    const codigo = dados?.code || (resposta.status === 403 ? "sem_permissao" : resposta.status >= 500 ? "servidor" : "erro_api");
    throw new FechamentoApiError(mensagem, { status: resposta.status, codigo });
  }

  return dados;
}

// "2026-10" → { dateFrom: "2026-10-01", dateTo: "2026-10-31" }. Mesmo intervalo
// que o sync da Central recebe; o backend decide o que já está coberto.
export function intervaloDoMes(periodo) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(periodo || "").trim());
  if (!m) return null;
  const ultimoDia = new Date(Number(m[1]), Number(m[2]), 0).getDate();
  return {
    dateFrom: `${m[1]}-${m[2]}-01`,
    dateTo: `${m[1]}-${m[2]}-${String(ultimoDia).padStart(2, "0")}`,
  };
}

// → { ok, marketplace, periodo, sync: { disponivel, importId, publicadoEm,
//     coberturaDe, coberturaAte, completo, motivoIncompleto }, runEmAndamento }
export function obterStatusFechamentoApi({ clienteSlug, clienteContaId, periodo }, { signal } = {}) {
  const query = new URLSearchParams({ conta: String(clienteContaId), periodo: String(periodo) });
  return chamar(`/financeiro/${encodeURIComponent(clienteSlug)}/fechamento-api/status?${query}`, { signal });
}

// Ajustes chegam como texto pt-BR ("1.234,56"); o backend faz o parse.
// → mesmo formato da resposta de POST /fechamentos/financeiro, + fonteVendas,
//   sync. Erros relevantes: CENTRAL_SEM_SYNC (409), FECHAMENTO_API_SO_MELI (400).
export function processarFechamentoApi({ clienteSlug, clienteContaId, periodo, ajustes = {} }, { signal } = {}) {
  return chamar(`/financeiro/${encodeURIComponent(clienteSlug)}/fechamento-api`, {
    metodo: "POST",
    signal,
    corpo: {
      clienteContaId,
      periodo,
      ads: String(ajustes.ads || "0"),
      venforce: String(ajustes.venforce || "0"),
      affiliates: String(ajustes.affiliates || "0"),
      fullCost: String(ajustes.fullCost || "0"),
      additionalCosts: String(ajustes.additionalCosts || "0"),
    },
  });
}

// → { ok, run, reaproveitado }. `reaproveitado` = já havia um run em andamento.
export function iniciarSyncCentral({ clienteSlug, clienteContaId, periodo }, { signal } = {}) {
  const intervalo = intervaloDoMes(periodo);
  return chamar(`/operacao/central-vendas/${encodeURIComponent(clienteSlug)}/sync-runs`, {
    metodo: "POST",
    signal,
    corpo: { marketplace: "meli", clienteContaId, dateFrom: intervalo?.dateFrom, dateTo: intervalo?.dateTo },
  });
}

// → { ok, run, completeness, sources }
export function obterSyncRunCentral({ clienteSlug, runId }, { signal } = {}) {
  return chamar(`/operacao/central-vendas/${encodeURIComponent(clienteSlug)}/sync-runs/${encodeURIComponent(runId)}`, { signal });
}
