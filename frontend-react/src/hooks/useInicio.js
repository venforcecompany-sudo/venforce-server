// frontend-react/src/hooks/useInicio.js
//
// Busca a tela de Início (GET /operacao/inicio/:cliente) sempre que a
// operação atual (cliente+conta) ou o período mudam. Mesmo padrão da antiga
// useVisao: AbortController + guarda de corrida por `seq` (uma resposta que
// chega depois de o contexto já ter mudado é descartada). Os dados antigos
// ficam na tela enquanto o novo período carrega (`carregando` sinaliza).
//
// O período (hoje | 7d | 30d | 90d) vive na URL como `?periodo=`; o padrão
// (30 dias) não aparece na URL.

import { useCallback, useEffect, useRef, useState } from "react";
import { obterInicio } from "../services/inicioApi.js";
import { ApiError } from "../services/apiClient.js";

export const PERIODOS = [
  { id: "hoje", rotulo: "Hoje" },
  { id: "7d", rotulo: "7 dias" },
  { id: "30d", rotulo: "30 dias" },
  { id: "90d", rotulo: "90 dias" },
];
export const PERIODO_PADRAO = "30d";

function lerPeriodo(search = typeof window === "undefined" ? "" : window.location.search) {
  const valor = new URLSearchParams(search).get("periodo");
  return PERIODOS.some((p) => p.id === valor) ? valor : PERIODO_PADRAO;
}

function escreverPeriodo(periodo) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (periodo === PERIODO_PADRAO) url.searchParams.delete("periodo");
  else url.searchParams.set("periodo", periodo);
  window.history.replaceState(window.history.state, "", url);
}

function normalizarErro(err) {
  if (err instanceof ApiError) return { codigo: err.codigo, mensagem: err.message, status: err.status };
  return { codigo: "desconhecido", mensagem: err?.message || "Erro inesperado.", status: 0 };
}

export function useInicio({ clienteSlug, clienteContaId, pronta }) {
  const [periodo, setPeriodo] = useState(() => lerPeriodo());
  const [dados, setDados] = useState(null);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState(null);
  // Recarregar sem trocar nada (ex.: depois de sincronizar os pedidos de hoje).
  const [versao, setVersao] = useState(0);
  const recarregar = useCallback(() => setVersao((v) => v + 1), []);
  const seqRef = useRef(0);
  const abortRef = useRef(null);
  const chaveRef = useRef(null);

  useEffect(() => {
    escreverPeriodo(periodo);
  }, [periodo]);

  useEffect(() => {
    if (!pronta || !clienteSlug || !clienteContaId) {
      setDados(null);
      setErro(null);
      setCarregando(false);
      return undefined;
    }

    // Trocou de operação: some o dado da anterior. Só trocou de período: o
    // dado fica na tela (esmaecido) até o novo chegar.
    const chave = `${clienteSlug}|${clienteContaId}`;
    if (chaveRef.current !== chave) setDados(null);
    chaveRef.current = chave;

    const seq = ++seqRef.current;
    abortRef.current?.abort();
    const controlador = new AbortController();
    abortRef.current = controlador;
    setCarregando(true);
    setErro(null);

    obterInicio(clienteSlug, { clienteContaId, periodo, signal: controlador.signal })
      .then((payload) => {
        if (seq !== seqRef.current) return;
        setDados(payload);
      })
      .catch((err) => {
        if (err?.name === "AbortError" || seq !== seqRef.current) return;
        setDados(null);
        setErro(normalizarErro(err));
      })
      .finally(() => {
        if (seq === seqRef.current) setCarregando(false);
      });

    return () => controlador.abort();
  }, [clienteSlug, clienteContaId, periodo, pronta, versao]);

  useEffect(() => () => abortRef.current?.abort(), []);

  return { periodo, setPeriodo, dados, carregando, erro, recarregar };
}
