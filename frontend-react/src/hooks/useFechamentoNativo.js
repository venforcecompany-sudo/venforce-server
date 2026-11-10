// frontend-react/src/hooks/useFechamentoNativo.js
//
// A máquina de estados de GERAR + SALVAR um fechamento dentro do Financeiro
// V3. O que o legado (Portal/financeiro.js) fazia em ~600 linhas de DOM,
// aqui em estado React: origem das vendas (API do ML × planilha), origem dos
// custos (base vinculada × upload), envio, competência declarada pelo
// backend, divergência de período, salvamento da entrega e o 409 de
// duplicidade.
//
// REGRAS QUE ESTE HOOK EXISTE PARA GARANTIR:
//  · Cliente/Conta/Período/Marketplace NÃO são escolhidos aqui — vêm do VF
//    Context (o marketplace é o da OPERAÇÃO, 1 conta = 1 marketplace). O que
//    for para o backend é exatamente o que a tela mostra no cabeçalho.
//  · Origem das vendas (só MELI): "api" é o padrão — o fechamento sai dos
//    pedidos que a Central já sincronizou da API do ML. "planilha" é o fluxo
//    de sempre. Os dois geram o MESMO entregável (mesmo summary, mesma entrega).
//  · No modo API os custos vêm da base aplicada no sync, então não há upload
//    de custos nem de vendas; o que é obrigatório é o sync do mês existir.
//  · No modo planilha a origem dos custos segue a base vinculada: se a
//    operação já tem base, o upload de custos NÃO é pedido; sem base, o upload
//    passa a ser obrigatório. "Usar outra planilha de custos" é um override
//    explícito, nunca o caminho principal.
//  · Competência divergente NUNCA é salva em silêncio. Sync incompleto também
//    não: exige confirmação explícita (cobertura parcial do mês).
//  · 409 ENTREGA_JA_EXISTE vira a escolha "cancelar × substituir", e
//    substituir preserva o token público.
//  · Uma ação por vez; abort em troca de contexto / unmount.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { processarFechamento, salvarEntregaFechamento, FechamentoApiError } from "../services/financeiroFechamentoApi.js";
import { processarFechamentoApi } from "../services/fechamentoViaApiApi.js";
import { montarPayloadFechamento } from "../utils/fechamentoPayload.js";
import { buscarEntrega } from "../services/entregasApi.js";
import { useBaseVinculada } from "./useBaseVinculada.js";
import { useAdsMercadoAds, origemDoAds } from "./useAdsMercadoAds.js";
import { useStatusFechamentoApi } from "./useStatusFechamentoApi.js";
import { useSyncCentral } from "./useSyncCentral.js";

const AJUSTES_INICIAIS = { ads: "", venforce: "", affiliates: "", fullCost: "", additionalCosts: "" };
const ARQUIVOS_INICIAIS = { sales: null, costs: null, ordersAll: null };

// TikTok Shop depende de uma Base TikTok escolhida à mão (o endpoint exige
// `costsBaseId` e não aceita upload de custos) — um seletor de base que o V3
// ainda não tem. Até ele existir, TikTok continua no legado.
export const MARKETPLACES_NATIVOS = ["meli", "shopee"];

function normalizarErro(err) {
  if (err instanceof FechamentoApiError) {
    if (err.codigo === "CENTRAL_SEM_SYNC") {
      // Não é falha técnica: o caminho é sincronizar o mês e processar de novo.
      return {
        mensagem: "Este mês ainda não foi sincronizado com a API do Mercado Livre. Use “Sincronizar agora” e processe de novo.",
        codigo: err.codigo,
        status: err.status,
      };
    }
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
  const [confirmouSyncIncompleto, setConfirmouSyncIncompleto] = useState(false);
  const [entregaSalva, setEntregaSalva] = useState(null);
  // "api" é o padrão; só vale para MELI (ver fonteVendas abaixo).
  const [fonte, setFonte] = useState("api");
  const [fonteTrocaPendente, setFonteTrocaPendente] = useState(null);

  const mkt = String(marketplace || "").trim().toLowerCase();
  const marketplaceSuportado = MARKETPLACES_NATIVOS.includes(mkt);
  const fonteVendas = mkt === "meli" && fonte === "api" ? "api" : "planilha";
  const modoApi = fonteVendas === "api";

  const base = useBaseVinculada({
    clienteSlug,
    marketplace: mkt,
    clienteContaId,
    // Fica ativa também no resultado: as pendências de custo precisam saber
    // qual é a base vinculada desta conta para oferecer a correção rápida.
    // Os deps do hook não mudam com o `estado`, então não há nova leitura.
    habilitado: marketplaceSuportado,
  });

  // Modo API: o status do sync da competência (sincronizado? completo?) e o
  // "Sincronizar agora" (admin). Só leem/disparam quando o modo API está ativo.
  const statusApi = useStatusFechamentoApi({ clienteSlug, clienteContaId, periodo, habilitado: modoApi });
  const sincronizacao = useSyncCentral({
    clienteSlug,
    clienteContaId,
    periodo,
    runEmAndamento: statusApi.runEmAndamento,
    onConcluido: statusApi.recarregar,
    habilitado: modoApi,
  });

  // Campo ADS (modelo B): o investimento do Mercado Ads entra sozinho no
  // campo. Só substitui o campo quando ele está vazio ou ainda tem o valor
  // que a API pôs antes (troca de conta/período, ↻) — nunca por cima do que
  // a pessoa digitou.
  const ads = useAdsMercadoAds({
    clienteSlug,
    clienteContaId,
    periodo,
    habilitado: mkt === "meli",
  });
  const ultimoAdsDaApiRef = useRef(null);
  useEffect(() => {
    if (ads.status !== "ok" || ads.valorCampo === null) return;
    const anterior = ultimoAdsDaApiRef.current;
    const novo = ads.valorCampo;
    ultimoAdsDaApiRef.current = novo;
    setAjustes((a) => {
      const atual = String(a.ads ?? "").trim();
      if (atual === "" || (anterior !== null && atual === anterior)) return { ...a, ads: novo };
      return a;
    });
  }, [ads.status, ads.valorCampo]);
  const usarAdsDaApi = useCallback(() => {
    if (ads.valorCampo !== null) setAjustes((a) => ({ ...a, ads: ads.valorCampo }));
  }, [ads.valorCampo]);
  const adsOrigem = origemDoAds(ajustes.ads, ads);

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
    setConfirmouSyncIncompleto(false);
    setEntregaSalva(null);
    setUsarUploadDeCustos(false);
    setArquivos(ARQUIVOS_INICIAIS);
    setFonteTrocaPendente(null);
  }, [clienteSlug, clienteContaId, periodo, mkt]);

  const competencia = processamento?.competencia || null;
  const divergente = competencia?.divergente === true;
  // Modo API: o backend diz se o sync cobre o mês inteiro. Incompleto não
  // impede gerar, mas exige confirmação antes de salvar.
  const syncIncompleto = modoApi && processamento?.sync?.completo === false;

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
  // sentido pedir upload sem saber se a base cobre. No modo API não há
  // upload de custos: a base já foi aplicada no sync.
  const custosBloqueiaVerificacao =
    !modoApi && (baseAindaResolvendo || base.status === "erro" || base.status === "ambigua");
  // Upload de custos obrigatório: sem base (ou com o override ligado).
  const custosObrigatorios = !modoApi && !custosBloqueiaVerificacao && !baseCobreCustos;

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
    if (modoApi) {
      if (statusApi.status === "carregando" || statusApi.status === "inativo") {
        itens.push({ campo: "sync", mensagem: "Verificando os dados sincronizados da Central." });
      } else if (statusApi.status === "erro") {
        itens.push({ campo: "sync", mensagem: "Não foi possível verificar os dados sincronizados." });
      } else if (!statusApi.sincronizado) {
        itens.push({ campo: "sync", mensagem: "Este mês ainda não foi sincronizado. Use “Sincronizar agora”." });
      }
      if (sincronizacao.emAndamento) {
        itens.push({ campo: "sync", mensagem: "Aguarde a sincronização terminar para processar." });
      }
    } else {
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
    }
    return { ok: itens.length === 0, itens, problemas: itens.map((i) => i.mensagem) };
  }, [
    marketplaceSuportado,
    clienteContaId,
    modoApi,
    statusApi.status,
    statusApi.sincronizado,
    sincronizacao.emAndamento,
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
    setConfirmouSyncIncompleto(false);
    setEntregaSalva(null);

    try {
      let resposta;
      if (modoApi) {
        resposta = await processarFechamentoApi(
          { clienteSlug, clienteContaId, periodo, ajustes },
          { signal: controlador.signal }
        );
      } else {
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
        resposta = await processarFechamento(form, { signal: controlador.signal });
      }
      if (controlador.signal.aborted) return;
      contextoDoProcessamentoRef.current = { clienteSlug, clienteContaId, periodo, marketplace: mkt, fonteVendas };
      setProcessamento(resposta);
      setEstado("preview");
    } catch (err) {
      if (err?.name === "AbortError") return;
      // Reprocessamento que falhou não deixa o resultado ANTERIOR na tela
      // como se fosse o atual.
      setProcessamento(null);
      setErro(normalizarErro(err));
      setEstado("form");
    }
  }, [validacao, arquivos, mkt, clienteSlug, clienteContaId, periodo, ajustes, modoApi, fonteVendas]);

  // Voltar aos arquivos/ajustes SEM perder o que foi escolhido (trocar a
  // planilha de custos, corrigir um ajuste). O resultado processado deixa de
  // valer — Processar de novo gera o novo.
  const voltarAoFormulario = useCallback(() => {
    abortRef.current?.abort();
    setProcessamento(null);
    setErro(null);
    setDuplicidade(null);
    setConfirmouDivergencia(false);
    setConfirmouSyncIncompleto(false);
    setEntregaSalva(null);
    setEstado("form");
  }, []);

  const salvar = useCallback(
    async ({ substituir = false } = {}) => {
      if (!processamento) return;
      if (divergente && !confirmouDivergencia && !substituir) {
        setErro({ mensagem: "Confirme a divergência de competência antes de salvar.", codigo: "divergencia", status: 0 });
        return;
      }
      if (syncIncompleto && !confirmouSyncIncompleto && !substituir) {
        setErro({ mensagem: "Confirme que o fechamento usa dados sincronizados incompletos antes de salvar.", codigo: "sync_incompleto", status: 0 });
        return;
      }
      const ctx = contextoDoProcessamentoRef.current;
      if (
        !ctx ||
        ctx.clienteSlug !== clienteSlug ||
        ctx.clienteContaId !== clienteContaId ||
        ctx.periodo !== periodo ||
        ctx.marketplace !== mkt ||
        ctx.fonteVendas !== fonteVendas
      ) {
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
        fonteVendas,
        adsOrigem: adsOrigem === "mercado_ads"
          ? { origem: "mercado_ads", consultadoEm: ads.dados?.consultadoEm || null }
          : adsOrigem === "manual" ? { origem: "manual" } : null,
      });

      // Substituir NÃO pode apagar a apresentação (destaques/prioridades) que
      // já foi escrita na entrega existente: ela é levada para o novo payload.
      // Só texto manual — os números são os do processamento atual.
      if (substituir && duplicidade?.entregaId) {
        try {
          const existente = await buscarEntrega(duplicidade.entregaId, { signal: controlador.signal });
          const apresentacao = existente?.entrega?.payload_json?.entrega;
          if (apresentacao && typeof apresentacao === "object") payload.entrega = apresentacao;
        } catch (err) {
          if (err?.name === "AbortError") return;
          /* sem a apresentação anterior, segue sem ela */
        }
      }

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
        // "Salvar e publicar" precisa do id da entrega recém-gravada.
        return entrega;
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
    [processamento, divergente, confirmouDivergencia, syncIncompleto, confirmouSyncIncompleto, clienteSlug, clienteNome, clienteContaId, periodo, mkt, fonteVendas, ajustes, onSalvo, duplicidade, adsOrigem, ads.dados]
  );

  const substituir = useCallback(() => salvar({ substituir: true }), [salvar]);

  // Há trabalho que uma troca de competência jogaria fora? Arquivos
  // escolhidos, ajustes digitados ou um resultado processado.
  const temArquivo = !!(arquivos.sales || arquivos.costs || arquivos.ordersAll);
  // O ADS que o Mercado Ads preencheu sozinho não é trabalho da pessoa: a
  // troca de competência traz o do mês novo.
  const temAjuste = Object.entries(ajustes).some(
    ([campo, v]) => String(v ?? "").trim() !== "" && !(campo === "ads" && adsOrigem === "mercado_ads")
  );
  const temResultado = !!processamento && estado !== "form" && estado !== "processando";
  const trabalho = useMemo(
    () => ({
      temTrabalho: temArquivo || temAjuste || !!processamento || estado === "processando",
      temResultado,
      processadoNaoSalvo: temResultado && estado !== "salvo",
    }),
    [temArquivo, temAjuste, processamento, estado, temResultado]
  );

  // Trocar a origem descarta arquivo escolhido e resultado (o que cada origem
  // gera não se aproveita da outra). Os ajustes digitados ficam.
  const trocaDescartaTrabalho = temArquivo || estado === "processando" || trabalho.processadoNaoSalvo;
  const aplicarFonte = useCallback((nova) => {
    abortRef.current?.abort();
    setFonte(nova);
    setFonteTrocaPendente(null);
    setEstado("form");
    setProcessamento(null);
    setErro(null);
    setDuplicidade(null);
    setConfirmouDivergencia(false);
    setConfirmouSyncIncompleto(false);
    setEntregaSalva(null);
    setArquivos(ARQUIVOS_INICIAIS);
    setUsarUploadDeCustos(false);
  }, []);
  const definirFonte = useCallback(
    (nova) => {
      if (mkt !== "meli" || nova === fonte) return;
      if (trocaDescartaTrabalho) {
        setFonteTrocaPendente(nova);
        return;
      }
      aplicarFonte(nova);
    },
    [mkt, fonte, trocaDescartaTrabalho, aplicarFonte]
  );
  const confirmarTrocaFonte = useCallback(() => {
    if (fonteTrocaPendente) aplicarFonte(fonteTrocaPendente);
  }, [fonteTrocaPendente, aplicarFonte]);
  const cancelarTrocaFonte = useCallback(() => setFonteTrocaPendente(null), []);

  const resetar = useCallback(() => {
    abortRef.current?.abort();
    setEstado("form");
    setProcessamento(null);
    setErro(null);
    setDuplicidade(null);
    setConfirmouDivergencia(false);
    setConfirmouSyncIncompleto(false);
    setEntregaSalva(null);
    setArquivos(ARQUIVOS_INICIAIS);
    setUsarUploadDeCustos(false);
  }, []);

  return {
    estado,
    trabalho,
    marketplace: mkt,
    marketplaceSuportado,
    fonteVendas,
    modoApi,
    definirFonte,
    fonteTrocaPendente,
    confirmarTrocaFonte,
    cancelarTrocaFonte,
    statusApi,
    sincronizacao,
    arquivos, setArquivo,
    ajustes, setAjuste,
    ads, adsOrigem, usarAdsDaApi,
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
    syncIncompleto,
    confirmouSyncIncompleto,
    confirmarSyncIncompleto: () => setConfirmouSyncIncompleto(true),
    erro,
    limparErro: () => setErro(null),
    duplicidade,
    entregaSalva,
    processar,
    // Reprocessar = o MESMO processamento, com os arquivos/ajustes atuais
    // (ex.: depois de corrigir a base vinculada). Nenhum endpoint novo.
    reprocessar: processar,
    voltarAoFormulario,
    salvar,
    substituir,
    resetar,
  };
}
