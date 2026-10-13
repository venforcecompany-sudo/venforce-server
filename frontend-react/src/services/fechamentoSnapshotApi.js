// frontend-react/src/services/fechamentoSnapshotApi.js
//
// Leitura das REVISÕES do fechamento (snapshots) — server/routes/
// fechamentoSnapshotRoutes.js. A gravação mora em financeiroFechamentoApi.js
// (salvarSnapshotFechamento), junto do processar/salvar, porque precisa do
// `code` do erro (SELO_INVALIDO etc.).
//
// Sempre por CONTA: o backend recusa listar sem cliente + conta, e um
// snapshot nunca é devolvido sob outro cliente.

import { requisitar } from "./apiClient.js";

export function listarSnapshots(clienteSlug, clienteContaId, { periodo = null, signal } = {}) {
  return requisitar("/fechamento-snapshots", {
    params: { cliente_slug: clienteSlug, cliente_conta_id: clienteContaId, ...(periodo ? { periodo } : {}) },
    signal,
  });
}

export function buscarSnapshot(id, { signal } = {}) {
  return requisitar(`/fechamento-snapshots/${encodeURIComponent(id)}`, { signal });
}

// Itens paginados NO BACKEND. `status`: os mesmos filtros da tabela
// (saudavel, atencao, critico, sem_custo, custo_ambiguo,
// aguardando_financeiro, cancelados); `busca`: título/ID/SKU/Model/pedido.
export function listarItensDoSnapshot(id, { offset = 0, limit = 25, status = null, busca = "", signal } = {}) {
  return requisitar(`/fechamento-snapshots/${encodeURIComponent(id)}/itens`, {
    params: { offset, limit, ...(status ? { status } : {}), ...(busca ? { busca } : {}) },
    signal,
  });
}

// "A base de custos desta revisão ainda é a mesma?" — o backend relê a base
// e compara a impressão digital com a gravada. Só leitura.
export function conferirBaseAtual(id, { signal } = {}) {
  return requisitar(`/fechamento-snapshots/${encodeURIComponent(id)}/base-atual`, { signal });
}
