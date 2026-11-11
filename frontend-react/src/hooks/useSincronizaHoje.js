// frontend-react/src/hooks/useSincronizaHoje.js
//
// O sync diário da Central cobre só até ontem. Quando o Início abre e os
// pedidos de hoje ainda não foram sincronizados, dispara sozinho o mesmo
// "Sincronizar agora" do Financeiro (POST sync-runs do mês corrente, via
// useSyncCentral) e, ao terminar, pede para a tela recarregar.
//
// Só para admin (o servidor só deixa admin sincronizar a Central) e só em
// operação Mercado Livre. Dispara no máximo uma vez a cada 10 minutos por
// conta (marcado em sessionStorage), para recarregar a página não virar uma
// fila de syncs; depois disso fica o botão.

import { useEffect, useRef } from "react";
import { ehAdmin } from "../services/apiClient.js";
import { useSyncCentral } from "./useSyncCentral.js";

const INTERVALO_MINIMO_MS = 10 * 60 * 1000;
const PREFIXO = "vf-inicio-sync:";

function lerMarca(chave) {
  try {
    return Number(window.sessionStorage.getItem(PREFIXO + chave)) || 0;
  } catch {
    return 0;
  }
}

function gravarMarca(chave) {
  try {
    window.sessionStorage.setItem(PREFIXO + chave, String(Date.now()));
  } catch {
    /* sem storage: vale só a guarda em memória */
  }
}

export function useSincronizaHoje({ clienteSlug, clienteContaId, dados, onConcluido }) {
  const vendas = dados?.vendas?.disponivel ? dados.vendas.dados : null;
  const hoje = dados?.periodo?.hoje || null;
  const meli = dados?.contexto?.marketplace === "meli";
  const podeSincronizar = meli && ehAdmin();
  const faltaHoje = !!(vendas?.dadosAte && hoje && vendas.dadosAte < hoje);

  const sync = useSyncCentral({
    clienteSlug,
    clienteContaId,
    periodo: hoje ? hoje.slice(0, 7) : null,
    onConcluido,
    habilitado: podeSincronizar,
  });

  const chave = `${clienteSlug}|${clienteContaId}|${hoje}`;
  const tentadasRef = useRef(new Set());
  const { fase, iniciar } = sync;

  useEffect(() => {
    if (!podeSincronizar || !faltaHoje || fase !== "ocioso") return;
    if (tentadasRef.current.has(chave)) return;
    tentadasRef.current.add(chave);
    if (Date.now() - lerMarca(chave) < INTERVALO_MINIMO_MS) return;
    gravarMarca(chave);
    iniciar();
  }, [podeSincronizar, faltaHoje, fase, chave, iniciar]);

  return {
    podeSincronizar,
    faltaHoje,
    fase: sync.fase,
    erro: sync.erro,
    emAndamento: sync.emAndamento,
    sincronizar: () => {
      gravarMarca(chave);
      iniciar();
    },
  };
}
