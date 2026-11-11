// frontend-react/src/services/inicioApi.js
// GET /operacao/inicio/:cliente?conta=&periodo= — ver server/services/inicioService.js.
// Um único request compõe todos os blocos da tela de Início no servidor.

import { requisitar } from "./apiClient.js";

export function obterInicio(clienteSlug, { clienteContaId, periodo, signal } = {}) {
  return requisitar(`/operacao/inicio/${encodeURIComponent(clienteSlug)}`, {
    params: { conta: clienteContaId, periodo },
    signal,
  });
}
