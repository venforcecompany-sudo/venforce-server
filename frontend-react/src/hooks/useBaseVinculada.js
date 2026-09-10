// frontend-react/src/hooks/useBaseVinculada.js
//
// Missão Financeiro V3 — descobrir, ANTES de processar, se a operação em tela
// já tem uma base de custos vinculada. É o que decide se o formulário pede
// upload de custos ou não.
//
// Isto é uma leitura de EXIBIÇÃO. A resolução autoritativa (isolamento por
// clienteContaId, IDOR, 409 de ambiguidade) mora em
// server/services/bases/baseCustosService.resolverBaseVinculada e roda de
// novo no POST /fechamentos/financeiro. Aqui só espelhamos a mesma regra
// para a tela não prometer "base vinculada" e depois o backend recusar —
// nem o contrário (pedir upload que o backend nem usaria).
//
// Fonte: GET /base-vinculos (mesma que o Financeiro legado usa). Filtra por
// cliente_slug + marketplace + cliente_conta_id, com o fallback legado
// (cliente_conta_id NULL) só quando a conta não tem vínculo próprio — nunca
// cai na base de OUTRA conta.

import { useCallback, useEffect, useRef, useState } from "react";
import { requisitar, ApiError } from "../services/apiClient.js";

const norm = (v) => String(v ?? "").trim().toLowerCase();

export function resolverBaseDosVinculos({ bases, clienteSlug, marketplace, clienteContaId }) {
  const slug = norm(clienteSlug);
  const mkt = norm(marketplace);
  if (!slug || !mkt) return { status: "inativo", base: null, contas: [] };

  const candidatos = (Array.isArray(bases) ? bases : []).filter((b) => {
    const v = b?.vinculo;
    return (
      v &&
      b?.ativo !== false &&
      norm(v.cliente_slug) === slug &&
      norm(v.marketplace) === mkt
    );
  });

  if (!candidatos.length) return { status: "ausente", base: null, contas: [] };

  const contaId = clienteContaId != null ? String(clienteContaId) : null;
  const daConta = contaId
    ? candidatos.find((b) => String(b.vinculo.cliente_conta_id ?? "") === contaId)
    : null;
  const legado = candidatos.find((b) => b.vinculo.cliente_conta_id == null);

  const escolhido = daConta || (contaId ? legado : null) || (!contaId && candidatos.length === 1 ? candidatos[0] : null);

  if (escolhido) {
    return {
      status: "encontrada",
      base: { id: escolhido.id, slug: escolhido.slug, nome: escolhido.nome },
      contas: [],
    };
  }

  // Sem clienteContaId e 2+ contas distintas: o backend recusaria escolher
  // sozinho (409). Sem essa resolução não dá para dizer qual base.
  const contasDistintas = [
    ...new Map(
      candidatos
        .filter((b) => b.vinculo.cliente_conta_id != null)
        .map((b) => [
          String(b.vinculo.cliente_conta_id),
          { id: b.vinculo.cliente_conta_id, nome: b.vinculo.conta_nome || `Conta ${b.vinculo.cliente_conta_id}` },
        ])
    ).values(),
  ];
  if (contasDistintas.length > 1) {
    return { status: "ambigua", base: null, contas: contasDistintas };
  }

  // Conta informada, mas nenhum vínculo (próprio ou legado) serve.
  return { status: "ausente", base: null, contas: [] };
}

export function useBaseVinculada({ clienteSlug, marketplace, clienteContaId, habilitado }) {
  const [estado, setEstado] = useState({ status: "inativo", base: null, contas: [] });
  const seqRef = useRef(0);
  const abortRef = useRef(null);

  const verificar = useCallback(() => {
    if (!habilitado || !clienteSlug || !marketplace) {
      abortRef.current?.abort();
      setEstado({ status: "inativo", base: null, contas: [] });
      return;
    }
    const seq = ++seqRef.current;
    abortRef.current?.abort();
    const controlador = new AbortController();
    abortRef.current = controlador;
    setEstado({ status: "carregando", base: null, contas: [] });

    requisitar("/base-vinculos", { signal: controlador.signal })
      .then((data) => {
        if (seq !== seqRef.current) return;
        const bases = Array.isArray(data) ? data : data?.bases || [];
        setEstado(resolverBaseDosVinculos({ bases, clienteSlug, marketplace, clienteContaId }));
      })
      .catch((err) => {
        if (err?.name === "AbortError" || seq !== seqRef.current) return;
        setEstado({
          status: "erro",
          base: null,
          contas: [],
          erro: err instanceof ApiError ? err.message : "Não foi possível verificar a base.",
        });
      });
  }, [habilitado, clienteSlug, marketplace, clienteContaId]);

  useEffect(() => {
    verificar();
    return () => abortRef.current?.abort();
  }, [verificar]);

  return { ...estado, recarregar: verificar };
}
