// frontend-react/src/hooks/useSnapshotsFechamento.js
//
// As REVISÕES (snapshots) do fechamento DESTA conta, todas as competências
// (o histórico e o cabeçalho leem da mesma lista). Mesmas regras de
// useEntregasFechamento: abort + sequência em troca de contexto, erro sem
// apagar a tela, recarga autoritativa depois de salvar/publicar.
//
// Indisponível (backend sem as tabelas novas, erro de rede) NÃO é "sem
// revisões": `erro` fica preenchido e a tela cai no fechamento antigo
// (payload_json), dizendo isso.

import { useCallback, useEffect, useRef, useState } from "react";
import { listarSnapshots } from "../services/fechamentoSnapshotApi.js";

export function useSnapshotsFechamento({ clienteSlug, clienteContaId, habilitado }) {
  const [snapshots, setSnapshots] = useState(null);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState(null);
  const seqRef = useRef(0);
  const abortRef = useRef(null);

  const carregar = useCallback(() => {
    if (!habilitado || !clienteSlug || !clienteContaId) {
      setSnapshots(null);
      setErro(null);
      setCarregando(false);
      return Promise.resolve();
    }
    const seq = ++seqRef.current;
    abortRef.current?.abort();
    const controlador = new AbortController();
    abortRef.current = controlador;
    setCarregando(true);
    setErro(null);
    return listarSnapshots(clienteSlug, clienteContaId, { signal: controlador.signal })
      .then((r) => {
        if (seq !== seqRef.current) return;
        setSnapshots(Array.isArray(r?.snapshots) ? r.snapshots : []);
      })
      .catch((err) => {
        if (err?.name === "AbortError" || seq !== seqRef.current) return;
        setSnapshots(null);
        setErro({ mensagem: err?.message || "Revisões indisponíveis.", codigo: err?.codigo || "erro" });
      })
      .finally(() => {
        if (seq === seqRef.current) setCarregando(false);
      });
  }, [clienteSlug, clienteContaId, habilitado]);

  useEffect(() => {
    carregar();
    return () => abortRef.current?.abort();
  }, [carregar]);

  return { snapshots, carregando, erro, recarregar: carregar };
}
