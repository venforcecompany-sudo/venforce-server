// frontend-react/src/hooks/useFullMercadoLivre.js
//
// Campo FULL do Fechamento: o custo do Full da conta na competência
// (armazenagem, armazenamento prolongado, coleta, retirada) chega SOZINHO,
// lido do faturamento do ML. Mesmo desenho do ADS (useAdsMercadoAds): o
// backend responde do cache por conta+mês ou consulta o ML; `atualizar()`
// (o ↻ do campo) força a consulta ao vivo.
//
// O frete das vendas Full (CFFE/CFFI) NÃO entra: já é descontado por venda.
// Só Mercado Livre. Sem dado da API o status vira "indisponivel" com o
// código — o campo segue manual, nunca bloqueia o fechamento.

import { useCallback, useEffect, useRef, useState } from "react";
import { obterFullFechamento } from "../services/financeiroApi.js";
import { ApiError } from "../services/apiClient.js";
import { formatarValorCampo } from "./useAdsMercadoAds.js";

const INATIVO = { status: "inativo", dados: null, codigo: null, atualizando: false };

// De onde veio o FULL que vai para o fechamento: "ml_billing" quando o campo
// ainda tem o valor da API, "manual" quando foi digitado, null quando vazio.
export function origemDoFull(valorCampo, full) {
  const atual = String(valorCampo ?? "").trim();
  if (!atual) return null;
  if (full?.status === "ok" && full.valorCampo === atual) return "ml_billing";
  return "manual";
}

export function useFullMercadoLivre({ clienteSlug, clienteContaId, periodo, habilitado }) {
  const [estado, setEstado] = useState(INATIVO);
  const seqRef = useRef(0);
  const abortRef = useRef(null);
  const ativo = !!(habilitado && clienteSlug && clienteContaId && periodo);

  const carregar = useCallback(
    (atualizar = false) => {
      if (!ativo) {
        abortRef.current?.abort();
        setEstado(INATIVO);
        return;
      }
      const seq = ++seqRef.current;
      abortRef.current?.abort();
      const controlador = new AbortController();
      abortRef.current = controlador;
      setEstado((e) => (atualizar && e.status === "ok" ? { ...e, atualizando: true } : { ...INATIVO, status: "carregando" }));

      obterFullFechamento(clienteSlug, { clienteContaId, periodo, atualizar, signal: controlador.signal })
        .then((r) => {
          if (seq !== seqRef.current) return;
          if (r?.disponivel === true && Number.isFinite(Number(r.custoFull))) {
            setEstado({ status: "ok", dados: r, codigo: null, atualizando: false });
          } else {
            setEstado({ status: "indisponivel", dados: null, codigo: r?.codigo || "ML_BILLING_API_ERROR", atualizando: false });
          }
        })
        .catch((err) => {
          if (err?.name === "AbortError" || seq !== seqRef.current) return;
          setEstado({
            status: "erro",
            dados: null,
            codigo: err instanceof ApiError ? err.codigo || null : null,
            atualizando: false,
          });
        });
    },
    [ativo, clienteSlug, clienteContaId, periodo]
  );

  useEffect(() => {
    carregar(false);
    return () => abortRef.current?.abort();
  }, [carregar]);

  const atualizar = useCallback(() => carregar(true), [carregar]);
  const valorCampo = estado.status === "ok" ? formatarValorCampo(estado.dados.custoFull) : null;

  return { ...estado, valorCampo, atualizar };
}
