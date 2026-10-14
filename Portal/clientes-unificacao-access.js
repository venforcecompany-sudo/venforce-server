import { vfApi } from "./vf-api.js";

// Configuração por sessão da página; nunca localStorage/query string como flag.
let pending;
export function loadUnificacaoAccess(api = vfApi) {
  if (api !== vfApi) return api.get("/admin/clientes-unificacao/config");
  return (pending ||= api
    .get("/admin/clientes-unificacao/config")
    .catch((error) => {
      pending = null;
      throw error;
    }));
}
