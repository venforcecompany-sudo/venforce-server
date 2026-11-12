// frontend-react/src/services/financeiroApi.js
// GET /financeiro/:cliente?conta=&periodo=YYYY-MM — ver
// server/services/financeiroVisaoService.js. Só leitura (F4.1): não envia
// nem processa fechamento — isso continua em Portal/financeiro.html
// (upload real), intocado.

import { requisitar } from "./apiClient.js";

export function obterFinanceiro(clienteSlug, { clienteContaId, periodo, signal } = {}) {
  return requisitar(`/financeiro/${encodeURIComponent(clienteSlug)}`, {
    params: { conta: clienteContaId, periodo },
    signal,
  });
}

// GET /financeiro/:cliente/ads?conta=&periodo=YYYY-MM[&atualizar=1] — o
// investimento do Mercado Ads da conta na competência, para o campo ADS do
// Fechamento. Ver server/services/financeiroAdsService.js.
export function obterAdsFechamento(clienteSlug, { clienteContaId, periodo, atualizar = false, signal } = {}) {
  return requisitar(`/financeiro/${encodeURIComponent(clienteSlug)}/ads`, {
    params: { conta: clienteContaId, periodo, atualizar: atualizar ? 1 : undefined },
    signal,
  });
}

// GET /financeiro/:cliente/miniaturas?conta=&itens=MLB1,MLB2 — foto dos
// produtos da lista (Mercado Livre). Ver server/services/financeiroMiniaturasService.js.
export function obterMiniaturasProdutos(clienteSlug, { clienteContaId, itens, signal } = {}) {
  return requisitar(`/financeiro/${encodeURIComponent(clienteSlug)}/miniaturas`, {
    params: { conta: clienteContaId, itens: itens.join(",") },
    signal,
  });
}

// GET /financeiro/:cliente/full?conta=&periodo=YYYY-MM[&atualizar=1] — custo
// do Full da conta na competência (armazenagem, armazenamento prolongado,
// coleta, retirada), lido do faturamento do ML, para o campo FULL do
// Fechamento. A 1ª consulta de um mês pode levar ~1 min (limite do ML).
// Ver server/services/financeiroFullService.js.
export function obterFullFechamento(clienteSlug, { clienteContaId, periodo, atualizar = false, signal } = {}) {
  return requisitar(`/financeiro/${encodeURIComponent(clienteSlug)}/full`, {
    params: { conta: clienteContaId, periodo, atualizar: atualizar ? 1 : undefined },
    signal,
  });
}
