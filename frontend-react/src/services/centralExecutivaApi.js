import { requisitar } from "./apiClient.js";

// A Central Executiva usa uma única chamada agregada. O backend limita a
// concorrência por conta e reutiliza o mesmo motor oficial da Cliente 360 V2.
// Assim o navegador não dispara N requisições nem replica regras financeiras.
export function obterCarteiraExecutiva({
  competencia,
  compararCom,
  marketplace = "meli",
  margemAlvo,
  signal,
} = {}) {
  return requisitar("/operacao/cliente-360/carteira/resultado", {
    params: { competencia, compararCom, marketplace, margemAlvo },
    signal,
  });
}
