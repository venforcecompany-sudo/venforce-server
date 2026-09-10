// frontend-react/src/hooks/useFechamentoNativo.js
//
// A máquina de estados de GERAR + SALVAR um fechamento dentro do Financeiro
// V3. O que o legado (Portal/financeiro.js) fazia em ~600 linhas de DOM,
// aqui em estado React: origem dos custos (base vinculada × upload), envio
// multipart, competência declarada pelo backend, divergência de período,
// salvamento da entrega e o 409 de duplicidade.
//
// REGRAS QUE ESTE HOOK EXISTE PARA GARANTIR:
//  · Cliente/Conta/Período/Marketplace NÃO são escolhidos aqui — vêm do VF
//    Context (o marketplace é o da OPERAÇÃO, 1 conta = 1 marketplace). O que
//    for para o backend é exatamente o que a tela mostra no cabeçalho.
//  · A origem dos custos segue a base vinculada: se a operação já tem base,
//    o fechamento usa ela e o upload de custos NÃO é pedido; sem base, o
//    upload passa a ser obrigatório. "Usar outra planilha de custos" é um
//    override explícito, nunca o caminho principal.
//  · Competência divergente NUNCA é salva em silêncio.
//  · 409 ENTREGA_JA_EXISTE vira a escolha "cancelar × substituir", e
//    substituir preserva o token público.
//  · Uma ação por vez; abort em troca de contexto / unmount.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { processarFechamento, salvarEntregaFechamento, FechamentoApiError } from "../services/financeiroFechamentoApi.js";
import { montarPayloadFechamento } from "../utils/fechamentoPayload.js";
import { useBaseVinculada } from "./useBaseVinculada.js";

const AJUSTES_INICIAIS = { ads: "", venforce: "", affiliates: "", fullCost: "", additionalCosts: "" };
const ARQUIVOS_INICIAIS = { sales: null, costs: null, ordersAll: null };

// TikTok Shop depende de uma Base TikTok escolhida à mão (o endpoint exige
// `costsBaseId` e não aceita upload de custos) — um seletor de base que o V3
// ainda não tem. Até ele existir, TikTok continua no legado.
export const MARKETPLACES_NATIVOS = ["meli", "shopee"];

function normalizarErro(err) {
  if (err instanceof FechamentoApiError) {
    return { mensagem: err.message, codigo: err.codigo, status: err.status };
  }
  return { mensagem: err?.message || "Erro inesperado.", codigo: "desconhecido", status: 0 };
}

export function useFechamentoNativo({ clienteSlug, clienteNome, clienteContaId, marketplace, periodo, onSalvo }) {
  const [estado, setEstado] = useState("form"); // form | processando | preview | salvando | salvo
  const [arquivos, setArquivos] = useState(ARQUIVOS_INICIAIS);
  const [ajustes, setAjustes] = useState(AJUSTES_INICIAIS);
  const [usarUploadDeCustos, setUsarUploadDeCustos] = useState(false);
  const [processamento, setProcessamento] = useState(null);
  const [erro, setErro] = useState(null);
  const [duplicidade, setDuplicidade] = useState(null); // { entregaId, publicado }
  const [confirmouDivergencia, setConfirmouDivergencia] = useState(false);
  const [entregaSalva, setEntregaSalva] = useState(null);

  const mkt = String(marketplace || "").trim().toLowerCase();
  const marketplaceSuportado = MARKETPLACES_NATIVOS.includes(mkt);

  const base = useBaseVinculada({
    clienteSlug,
    marketplace: mkt,
    clienteContaId,
    habilitado: marketplaceSuportado && (estado === "form" || estado === "processando"),
  });

  const abortRef = useRef(null);
  const contextoDoProcessamentoRef = useRef(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Trocou o cliente, a conta, o período ou o marketplace debaixo do
  // formulário: o resultado processado deixa de valer. Volta ao form.
  useEffect(() => {
    abortRef.current?.abort();
    setEstado("form");
    setProcessamento(null);
    setErro(null);
    setDuplicidade(null);
    setConfirmouDivergencia(false);
    setEntregaSalva(null);
    setUsarUploadDeCustos(false);
    setArquivos(ARQUIVOS_INICIAIS);
  }, [clienteSlug, clienteContaId, periodo, mkt]);

  const competencia = processamento?.competencia || null;
  const divergente = competencia?.divergente === true;

  const setArquivo = useCallback((campo, file) => {
    setArquivos((a) => ({ ...a, [campo]: file || null }));
  }, []);
  const setAjuste = useCallback((campo, valor) => {
    setAjustes((a) => ({ ...a, [campo]: valor }));
  }, []);

  // A base cobre os custos quando foi encontrada E o usuário não pediu
  // explicitamente para enviar outra planilha.
  const baseCobreCustos = base.status === "encontrada" && !usarUploadDeCustos;
  const baseAindaResolvendo = base.status === "inativo" || base.status === "carregando";
  // Enquanto a base não resolve (ou resolve com erro/ambiguidade) o
  // processamento fica bloqueado e o card de custos NÃO aparece — não faz
  // sentido pedir upload sem saber se a base cobre.
  const custosBloqueiaVerificacao =
    baseAindaResolvendo || base.status === "erro" || base.status === "ambigua";
  // Upload de custos obrigatório: sem base (ou com o override ligado).
  const custosObrigatorios = !custosBloqueiaVerificacao && !baseCobreCustos;

  const alternarUploadDeCustos = useCallback((ligar) => {
    setUsarUploadDeCustos((atual) => {
      const proximo = typeof ligar === "boolean" ? ligar : !atual;
      if (!proximo) setArquivos((a) => ({ ...a, costs: null }));
      return proximo;
    });
  }, []);

  // Validação em ITENS: cada pendência aponta um campo, para o card certo
  // poder mostrar o próprio aviso em vez de uma lista solta no rodapé.
  const validacao = useMemo(() => {
    const itens = [];
    if (!marketplaceSuportado) {
      itens.push({ campo: "marketplace", mensagem: "Este marketplace ainda é processado no Financeiro legado." });
    }
    if (!clienteContaId) {
      itens.push({ campo: "contexto", mensagem: "Operação (conta) não resolvida no contexto." });
    }
    if (!arquivos.sales) {
      itens.push({ campo: "sales", mensagem: "Planilha de vendas necessária." });
    }
    if (custosBloqueiaVerificacao) {
      itens.push({
        campo: "costs",
        mensagem:
          baseAindaResolvendo
            ? "Aguardando a verificação da base de custos."
            : base.status === "ambigua"
              ? "Há mais de uma conta possível — resolva a operação para continuar."
              : "Não foi possível verificar a base de custos.",
      });
    } else if (custosObrigatorios && !arquivos.costs) {
      itens.push({ campo: "costs", mensagem: "Planilha de custos necessária." });
    }
    return { ok: itens.length === 0, itens, problemas: itens.map((i) => i.mensagem) };
  }, [
    marketplaceSuportado,
    clienteContaId,
    arquivos.sales,
    arquivos.costs,
    custosObrigatorios,
    custosBloqueiaVerificacao,
    baseAindaResolvendo,
    base.status,
  ]);

  const processar = useCallback(async () => {
    if (!validacao.ok) {
      setErro({ mensagem: validacao.problemas[0], codigo: "validacao", status: 0 });
      return;
    }
    abortRef.current?.abort();
    const controlador = new AbortController();
    abortRef.current = controlador;

    setEstado("processando");
    setErro(null);
    setDuplicidade(null);
    setConfirmouDivergencia(false);
    setEntregaSalva(null);

    const form = new FormData();
    form.append("sales", arquivos.sales);
    form.append("marketplace", mkt);
    if (clienteSlug) form.append("cliente_slug", clienteSlug);
    if (clienteContaId) form.append("clienteContaId", String(clienteContaId));
    if (periodo) form.append("periodo", periodo);
    // Custos: só sobe arquivo quando NÃO é a base vinculada que cobre. Sem
    // arquivo e com base disponível, o backend resolve os custos da base.
    if (arquivos.costs) form.append("costs", arquivos.costs);
    if (mkt === "shopee" && arquivos.ordersAll) form.append("ordersAll", arquivos.ordersAll);
    form.append("ads", String(ajustes.ads || "0"));
    form.append("venforce", String(ajustes.venforce || "0"));
    form.append("affiliates", String(ajustes.affiliates || "0"));
    if (mkt === "meli") {
      form.append("fullCost", String(ajustes.fullCost || "0"));
      form.append("additionalCosts", String(ajustes.additionalCosts || "0"));
    }

    try {
      const resposta = await processarFechamento(form, { signal: controlador.signal });
      if (controlador.signal.aborted) return;
      contextoDoProcessamentoRef.current = { clienteSlug, clienteContaId, periodo, marketplace: mkt };
      setProcessamento(resposta);
      setEstado("preview");
    } catch (err) {
      if (err?.name === "AbortError") return;
      setErro(normalizarErro(err));
      setEstado("form");
    }
  }, [validacao, arquivos, mkt, clienteSlug, clienteContaId, periodo, ajustes]);

  const salvar = useCallback(
    async ({ substituir = false } = {}) => {
      if (!processamento) return;
      if (divergente && !confirmouDivergencia && !substituir) {
        setErro({ mensagem: "Confirme a divergência de competência antes de salvar.", codigo: "divergencia", status: 0 });
        return;
      }
      const ctx = contextoDoProcessamentoRef.current;
      if (!ctx || ctx.clienteSlug !== clienteSlug || ctx.clienteContaId !== clienteContaId || ctx.periodo !== periodo) {
        setErro({ mensagem: "O contexto mudou desde o processamento. Processe novamente.", codigo: "contexto", status: 0 });
        setEstado("form");
        return;
      }

      abortRef.current?.abort();
      const controlador = new AbortController();
      abortRef.current = controlador;
      setEstado("salvando");
      setErro(null);

      const payload = montarPayloadFechamento({
        processamento,
        clienteSlug,
        clienteNome,
        periodo,
        marketplace: mkt,
        ajustes,
      });

      const body = {
        tipo: "fechamento_mensal",
        titulo: payload.titulo,
        periodo,
        cliente_slug: clienteSlug,
        cliente_conta_id: clienteContaId,
        status: "rascunho",
        payload_json: payload,
        origem_tipo: "fechamento_financeiro",
        ...(substituir ? { substituir: true } : {}),
      };

      try {
        const entrega = await salvarEntregaFechamento(body, { signal: controlador.signal });
        if (controlador.signal.aborted) return;
        setEntregaSalva(entrega);
        setDuplicidade(null);
        setEstado("salvo");
        onSalvo?.(entrega);
      } catch (err) {
        if (err?.name === "AbortError") return;
        if (err instanceof FechamentoApiError && err.codigo === "ENTREGA_JA_EXISTE") {
          setDuplicidade({ entregaId: err.entregaId, publicado: err.publicado });
          setEstado("preview");
          return;
        }
        setErro(normalizarErro(err));
        setEstado("preview");
      }
    },
    [processamento, divergente, confirmouDivergencia, clienteSlug, clienteNome, clienteContaId, periodo, mkt, ajustes, onSalvo]
  );

  const substituir = useCallback(() => salvar({ substituir: true }), [salvar]);

  const resetar = useCallback(() => {
    abortRef.current?.abort();
    setEstado("form");
    setProcessamento(null);
    setErro(null);
    setDuplicidade(null);
    setConfirmouDivergencia(false);
    setEntregaSalva(null);
    setArquivos(ARQUIVOS_INICIAIS);
    setUsarUploadDeCustos(false);
  }, []);

  return {
    estado,
    marketplace: mkt,
    marketplaceSuportado,
    arquivos, setArquivo,
    ajustes, setAjuste,
    base,
    baseCobreCustos,
    custosObrigatorios,
    usarUploadDeCustos,
    alternarUploadDeCustos,
    validacao,
    processamento,
    competencia,
    divergente,
    confirmouDivergencia,
    confirmarDivergencia: () => setConfirmouDivergencia(true),
    erro,
    limparErro: () => setErro(null),
    duplicidade,
    entregaSalva,
    processar,
    salvar,
    substituir,
    resetar,
  };
}
