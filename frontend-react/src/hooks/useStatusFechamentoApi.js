// frontend-react/src/hooks/useStatusFechamentoApi.js
//
// Estado do modo API do Fechamento: a Central já tem pedidos sincronizados
// desta conta na competência em tela? Lê GET .../fechamento-api/status e
// mostra o que o backend disse (sync.disponivel, completo, runEmAndamento).
// Nada é recalculado aqui.
//
// Troca de conta/período zera o que estava na tela (nunca mostra o sync de
// outro mês). `recarregar()` relê sem zerar — usado ao fim de um sync.

import { useCallback, useEffect, useState } from "react";
import { obterStatusFechamentoApi } from "../services/fechamentoViaApiApi.js";

const SEM_LEITURA = { chave: null, status: "inativo", dados: null, erro: null };

export function useStatusFechamentoApi({ clienteSlug, clienteContaId, periodo, habilitado }) {
  const ativo = !!(habilitado && clienteSlug && clienteContaId && periodo);
  const chave = ativo ? `${clienteSlug}|${clienteContaId}|${periodo}` : null;
  const [leitura, setLeitura] = useState(SEM_LEITURA);
  const [versao, setVersao] = useState(0);

  useEffect(() => {
    if (!ativo) return undefined;
    const controlador = new AbortController();
    setLeitura((atual) =>
      atual.chave === chave
        ? { ...atual, status: "carregando" }
        : { chave, status: "carregando", dados: null, erro: null }
    );
    obterStatusFechamentoApi({ clienteSlug, clienteContaId, periodo }, { signal: controlador.signal })
      .then((dados) => {
        if (!controlador.signal.aborted) setLeitura({ chave, status: "ok", dados, erro: null });
      })
      .catch((err) => {
        if (controlador.signal.aborted || err?.name === "AbortError") return;
        setLeitura({ chave, status: "erro", dados: null, erro: err });
      });
    return () => controlador.abort();
  }, [ativo, chave, versao, clienteSlug, clienteContaId, periodo]);

  const recarregar = useCallback(() => setVersao((v) => v + 1), []);

  const atual = !ativo
    ? { status: "inativo", dados: null, erro: null }
    : leitura.chave === chave
      ? leitura
      : { status: "carregando", dados: null, erro: null };

  const sync = atual.dados?.sync ?? null;
  return {
    status: atual.status,
    sync,
    sincronizado: sync?.disponivel === true,
    runEmAndamento: atual.dados?.runEmAndamento ?? null,
    erro: atual.erro,
    recarregar,
  };
}
