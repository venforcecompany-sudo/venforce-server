import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { obterCarteiraExecutiva } from "../services/centralExecutivaApi.js";
import { competenciaAnterior, competenciaAtual, ehCompetencia } from "../utils/dates.js";

function filtrosIniciais() {
  const query = new URLSearchParams(window.location.search || "");
  const competencia = ehCompetencia(query.get("competencia"))
    ? query.get("competencia")
    : competenciaAnterior(competenciaAtual());

  return {
    competencia,
    compararCom: ehCompetencia(query.get("compararCom"))
      ? query.get("compararCom")
      : competenciaAnterior(competencia),
    marketplace: query.get("marketplace") || "meli",
    margemAlvo: query.get("margemAlvo") || "15",
    busca: query.get("busca") || "",
    status: query.get("status") || "todos",
  };
}

function escreverUrl(filtros) {
  const query = new URLSearchParams();
  for (const [chave, valor] of Object.entries(filtros)) {
    if (valor !== null && valor !== undefined && valor !== "" && valor !== "todos") {
      query.set(chave, String(valor));
    }
  }
  const sufixo = query.toString() ? `?${query}` : "";
  window.history.replaceState({}, "", `${window.location.pathname}${sufixo}`);
}

function normalizarErro(err) {
  return {
    mensagem: err?.message || "Não foi possível carregar a carteira.",
    codigo: err?.codigo || "erro_api",
    status: err?.status || 0,
  };
}

export function useCentralExecutiva() {
  const [filtros, setFiltros] = useState(filtrosIniciais);
  const [dados, setDados] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState(null);
  const abortRef = useRef(null);

  const carregar = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setCarregando(true);
    setErro(null);

    try {
      const resposta = await obterCarteiraExecutiva({
        competencia: filtros.competencia,
        compararCom: filtros.compararCom,
        marketplace: filtros.marketplace,
        margemAlvo: filtros.margemAlvo,
        signal: controller.signal,
      });
      if (!controller.signal.aborted) setDados(resposta);
    } catch (err) {
      if (err?.name !== "AbortError" && !controller.signal.aborted) {
        setErro(normalizarErro(err));
      }
    } finally {
      if (!controller.signal.aborted) setCarregando(false);
    }
  }, [filtros.competencia, filtros.compararCom, filtros.marketplace, filtros.margemAlvo]);

  useEffect(() => {
    escreverUrl(filtros);
  }, [filtros]);

  useEffect(() => {
    carregar();
    return () => abortRef.current?.abort();
  }, [carregar]);

  const contas = dados?.contas || [];

  const contasFiltradas = useMemo(() => {
    const termo = filtros.busca.trim().toLowerCase();
    return contas
      .filter((conta) => filtros.status === "todos" || conta.status === filtros.status)
      .filter((conta) => {
        if (!termo) return true;
        const nome = String(conta.cliente?.nome || "").toLowerCase();
        const slug = String(conta.cliente?.slug || "").toLowerCase();
        const causa = String(conta.causa?.titulo || "").toLowerCase();
        return nome.includes(termo) || slug.includes(termo) || causa.includes(termo);
      });
  }, [contas, filtros.busca, filtros.status]);

  function atualizarFiltro(parcial) {
    setFiltros((atual) => {
      const proximo = { ...atual, ...parcial };
      if (parcial.competencia && !parcial.compararCom) {
        proximo.compararCom = competenciaAnterior(parcial.competencia);
      }
      return proximo;
    });
  }

  return {
    filtros,
    atualizarFiltro,
    dados,
    resumo: dados?.resumo || null,
    narrativa: dados?.narrativa || null,
    causas: dados?.causas || [],
    contas,
    contasFiltradas,
    carregando,
    erro,
    recarregar: carregar,
  };
}
