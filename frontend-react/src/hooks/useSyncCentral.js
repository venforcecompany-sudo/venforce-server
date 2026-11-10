// frontend-react/src/hooks/useSyncCentral.js
//
// "Sincronizar agora" do modo API: dispara o sync da Central de Vendas para a
// competência (POST sync-runs) e acompanha o run até um estado final
// (GET sync-runs/:id a cada 3 s — a mesma cadência do Portal legado). Ao
// terminar, chama `onConcluido` para a tela reler o status.
//
// Um run que já está em andamento (outra aba, outro clique) é retomado sozinho
// quando o status o informa (`runEmAndamento`). Trocar de conta/período deixa
// de acompanhar o run antigo — ele continua no servidor, sem perder nada.

import { useCallback, useEffect, useRef, useState } from "react";
import { iniciarSyncCentral, obterSyncRunCentral } from "../services/fechamentoViaApiApi.js";

const INTERVALO_POLL_MS = 3000;
const EM_CURSO = new Set(["queued", "running"]);
const OCIOSO = { fase: "ocioso", run: null, erro: null };

export function useSyncCentral({ clienteSlug, clienteContaId, periodo, runEmAndamento = null, onConcluido, habilitado = true }) {
  const ativo = !!(habilitado && clienteSlug && clienteContaId && periodo);
  const chave = ativo ? `${clienteSlug}|${clienteContaId}|${periodo}` : null;
  const [estado, setEstado] = useState({ chave: null, ...OCIOSO });
  const [tick, setTick] = useState(0);

  const onConcluidoRef = useRef(onConcluido);
  useEffect(() => {
    onConcluidoRef.current = onConcluido;
  });

  const atual = ativo && estado.chave === chave ? estado : { chave, ...OCIOSO };
  const runIdSeguido = ativo && (atual.fase === "acompanhando") && atual.run?.id != null ? atual.run.id : null;

  // Retomada: o status diz que há um run em curso desta competência.
  const runIdDoStatus = ativo ? runEmAndamento?.id ?? null : null;
  const statusDoRunDoStatus = runEmAndamento?.status ?? null;
  useEffect(() => {
    if (runIdDoStatus == null) return;
    setEstado((e) => {
      if (e.chave === chave && (e.fase === "iniciando" || e.fase === "acompanhando")) return e;
      // Já concluído nesta sessão: não volta a seguir o mesmo run por causa de
      // uma leitura de status que chegou antes do servidor atualizar.
      if (e.chave === chave && e.fase === "concluido" && e.run?.id === runIdDoStatus) return e;
      return { chave, fase: "acompanhando", run: { id: runIdDoStatus, status: statusDoRunDoStatus }, erro: null };
    });
  }, [runIdDoStatus, statusDoRunDoStatus, chave]);

  // Acompanhamento: uma leitura por vez; enquanto o run está em curso agenda a
  // próxima. Trocar de contexto (ou desmontar) cancela a leitura pendente.
  useEffect(() => {
    if (runIdSeguido == null) return undefined;
    const controlador = new AbortController();
    let timer = null;
    const agendar = () => {
      timer = setTimeout(() => setTick((t) => t + 1), INTERVALO_POLL_MS);
    };

    obterSyncRunCentral({ clienteSlug, runId: runIdSeguido }, { signal: controlador.signal })
      .then((dados) => {
        if (controlador.signal.aborted) return;
        const run = dados?.run || {};
        if (EM_CURSO.has(run.status)) {
          setEstado((e) => (e.chave === chave ? { ...e, run } : e));
          agendar();
          return;
        }
        const falhou = run.status === "failed";
        setEstado((e) =>
          e.chave === chave
            ? {
                ...e,
                fase: falhou ? "falhou" : "concluido",
                run,
                erro: falhou ? `Sincronização falhou: ${run.error?.message || "erro desconhecido"}.` : null,
              }
            : e
        );
        if (!falhou) onConcluidoRef.current?.(run);
      })
      .catch((err) => {
        if (controlador.signal.aborted || err?.name === "AbortError") return;
        // Queda de rede no meio do acompanhamento: tenta de novo, sem desistir.
        agendar();
      });

    return () => {
      controlador.abort();
      clearTimeout(timer);
    };
  }, [runIdSeguido, tick, clienteSlug, chave]);

  const iniciar = useCallback(async () => {
    if (!ativo) return;
    setEstado({ chave, fase: "iniciando", run: null, erro: null });
    try {
      const dados = await iniciarSyncCentral({ clienteSlug, clienteContaId, periodo });
      setEstado((e) =>
        e.chave === chave ? { chave, fase: "acompanhando", run: dados.run, erro: null } : e
      );
    } catch (err) {
      setEstado((e) =>
        e.chave === chave ? { chave, fase: "falhou", run: null, erro: err?.message || "Falha ao iniciar a sincronização." } : e
      );
    }
  }, [ativo, chave, clienteSlug, clienteContaId, periodo]);

  return {
    fase: atual.fase,
    run: atual.run,
    erro: atual.erro,
    // Sync em curso (criando ou acompanhando): bloqueia "Sincronizar" e "Processar".
    emAndamento: atual.fase === "iniciando" || atual.fase === "acompanhando",
    iniciar,
  };
}
