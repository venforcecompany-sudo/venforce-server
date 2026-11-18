// frontend-react/src/hooks/useResumoSalvo.js
//
// O fechamento SALVO da competência, lido da própria entrega
// (GET /entregas-cliente/:id → payload_json). O payload nativo grava o
// `summary` do motor e as `detailedRows` (todas desde 18/11/2026; antes, amostra de 50) — é com eles que a mesa
// mostra o mesmo destaque e a mesma cascata de um processamento em memória,
// sem recalcular nada. Entrega legada sem `summary` → `summary: null` (a
// tela cai na composição gravada em `cards`).

import { useEffect, useState } from "react";
import { buscarEntrega } from "../services/entregasApi.js";

const VAZIO = { carregando: false, summary: null, detailedRows: [], detailedRowsCompletas: false, unmatchedIds: [], erro: null };

export function useResumoSalvo({ entregaId, habilitado = true }) {
  const [estado, setEstado] = useState(VAZIO);

  useEffect(() => {
    if (!habilitado || entregaId == null) {
      setEstado(VAZIO);
      return undefined;
    }
    const controlador = new AbortController();
    setEstado({ ...VAZIO, carregando: true });
    buscarEntrega(entregaId, { signal: controlador.signal })
      .then((resposta) => {
        if (controlador.signal.aborted) return;
        const payload = resposta?.entrega?.payload_json || {};
        const summary = payload.summary && typeof payload.summary === "object" ? payload.summary : null;
        setEstado({
          carregando: false,
          summary,
          detailedRows: Array.isArray(payload.detailedRows) ? payload.detailedRows : [],
          detailedRowsCompletas: payload.detailedRowsCompletas === true,
          unmatchedIds: Array.isArray(payload.unmatchedIds) ? payload.unmatchedIds : [],
          erro: null,
        });
      })
      .catch((err) => {
        if (err?.name === "AbortError") return;
        setEstado({ ...VAZIO, erro: err?.message || "Não foi possível ler o fechamento salvo." });
      });
    return () => controlador.abort();
  }, [entregaId, habilitado]);

  return estado;
}
