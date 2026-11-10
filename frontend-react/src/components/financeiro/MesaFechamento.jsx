// frontend-react/src/components/financeiro/MesaFechamento.jsx
//
// A MESA do fechamento (modelo B, aprovado em artefato em 20/10/2026). Uma
// tela só, sem rolar por um formulário comprido:
//
//   ┌──────────────────────────────────────────────┬─────────────────────┐
//   │ avisos (erro, divergência, duplicidade…)     │ Fechamento de <mês> │
//   │ Resultado final + 6 números                  │ 1 Base de custos    │
//   │ aviso de pendências (uma linha)              │ 2 Arquivos          │
//   │ Da receita ao resultado (cascata)            │ … 6 Salvar/publicar │
//   │                                              │ [ação do próximo]   │
//   ├──────────────────────────────────────────────┴─────────────────────┤
//   │ Produtos (largura total): busca + filtros, lista expansível        │
//   └────────────────────────────────────────────────────────────────────┘
//
// Base, arquivos e ajustes moram no drawer "Preparar fechamento"; as
// pendências de custo, o detalhamento completo e a apresentação da entrega,
// cada um no seu drawer. O motor é o mesmo (POST /fechamentos/financeiro,
// via useFechamentoNativo) e nada é recalculado na tela.
//
// Sem processamento em memória, a mesa mostra o fechamento SALVO da
// competência (o `summary` gravado na entrega). Entrega legada sem summary
// cai na composição gravada em `cards`.
//
// O que NÃO está aqui: seletor de Cliente/Conta/Período (vêm do Shell) e de
// marketplace (é o da operação). TikTok segue no legado.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useFechamentoNativo } from "../../hooks/useFechamentoNativo.js";
import { useResumoSalvo } from "../../hooks/useResumoSalvo.js";
import { ehAdmin } from "../../services/apiClient.js";
import { formatarDataHora, rotularCompetencia } from "../../utils/dates.js";
import { normalizarLinhas } from "../../utils/financeiro/produtos.js";
import { MK_LABEL } from "../../utils/financeiro/marketplace.js";
import { etapasDoFechamento, resumoDePendencias } from "../../utils/financeiro/mesa.js";
import { rotuloModo } from "../../utils/financeiro/resumoFechamento.js";
import { base64ParaBlob, baixarBlob, nomeDaPlanilhaProcessada, TIPO_XLSX } from "../../utils/financeiro/arquivos.js";
import { formatarMoeda } from "../../utils/currency.js";
import { VFBanner } from "../ui/VFBanner/index.js";
import { VFButton, useFeedbackOk } from "../ui/VFButton/index.js";
import { VFDrawer } from "../ui/VFDrawer/index.js";
import { BaseCustosStatus } from "./fechamento/BaseCustosStatus.jsx";
import { FechamentoFileCard } from "./fechamento/FechamentoFileCard.jsx";
import { FechamentoAjustes } from "./fechamento/FechamentoAjustes.jsx";
import { OrigemVendas, SincronizacaoVendas } from "./fechamento/OrigemVendas.jsx";
import { CustosModoApi } from "./fechamento/CustosModoApi.jsx";
import { PendenciasCusto } from "./pendencias/PendenciasCusto.jsx";
import { EntregaPainel } from "./entrega/EntregaPainel.jsx";
import { linkPublico } from "./EntregaAcoes.jsx";
import { ResultadoTab } from "./ResultadoTab.jsx";
import { ConciliacaoTab } from "./ConciliacaoTab.jsx";
import { ResultadoDestaque } from "./mesa/ResultadoDestaque.jsx";
import { ReceitaAoResultado } from "./mesa/ReceitaAoResultado.jsx";
import { PainelEtapas, AcaoPrincipal, ICONES } from "./mesa/PainelEtapas.jsx";
import { ProdutosMesa } from "./mesa/ProdutosMesa.jsx";
import { DetalhesFechamento } from "./mesa/DetalhesFechamento.jsx";

const TITULO_ETAPA = {
  base: "Base de custos",
  arquivos: "Arquivos",
  ajustes: "Ajustes do período",
  processar: "Processar",
  pendencias: "Revisar pendências",
  publicar: "Salvar e publicar",
};

const ROTULO_AJUSTE = { ads: "ADS", venforce: "Venforce", affiliates: "Afiliados", fullCost: "FULL", additionalCosts: "Custos adicionais" };

const qtd = (n, um, varios) => `${n.toLocaleString("pt-BR")} ${n === 1 ? um : varios}`;

function avisoDoCampo(validacao, campo) {
  if (validacao.ok) return null;
  return validacao.itens.find((i) => i.campo === campo)?.mensagem || null;
}

// Publicar muda o que um TERCEIRO enxerga: confirmação em dois tempos que
// nomeia a competência (mesma regra de EntregaAcoes). Nunca window.confirm.
function Confirmacao({ texto, rotulo, onConfirmar, onCancelar }) {
  return (
    <div className="vf-fin-mesa-confirmar" role="group" aria-label="Confirmar publicação">
      <p className="vf-fin-mesa-confirmar__texto">{texto}</p>
      <div className="vf-cluster">
        <VFButton variant="primary" size="sm" onClick={onConfirmar}>
          {rotulo}
        </VFButton>
        <VFButton variant="ghost" size="sm" onClick={onCancelar}>
          Cancelar
        </VFButton>
      </div>
    </div>
  );
}

function horaCurta(data) {
  if (!data) return null;
  return data.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

export function MesaFechamento({
  clienteSlug,
  clienteNome,
  clienteId = null,
  clienteContaId,
  marketplace,
  contaNome,
  periodo,
  periodoLabel,
  entrega = null,
  entregas = null,
  resultadoSalvo = null,
  conciliacao = null,
  carregandoLeitura = false,
  onSalvo,
  onTrabalho,
}) {
  const f = useFechamentoNativo({ clienteSlug, clienteNome, clienteId, clienteContaId, marketplace, periodo, onSalvo });
  const [drawer, setDrawer] = useState(null); // preparar | pendencias | detalhes | entrega
  const [confirmando, setConfirmando] = useState(null); // salvar_publicar | publicar
  const [apresentacaoAlterada, setApresentacaoAlterada] = useState(false);
  const [pedidoProdutos, setPedidoProdutos] = useState(null);
  const [processadoEm, setProcessadoEm] = useState(null);
  const [copiado, confirmarCopia] = useFeedbackOk(1600);

  // Trabalho em andamento = formulário/resultado + apresentação não salva: a
  // página não troca de competência em silêncio.
  const { temTrabalho, temResultado, processadoNaoSalvo } = f.trabalho;
  useEffect(() => {
    onTrabalho?.({ temTrabalho: temTrabalho || apresentacaoAlterada, temResultado, processadoNaoSalvo });
  }, [onTrabalho, temTrabalho, temResultado, processadoNaoSalvo, apresentacaoAlterada]);

  useEffect(() => {
    setProcessadoEm(f.processamento ? new Date() : null);
  }, [f.processamento]);

  // Trocou a competência ou a operação: nenhuma confirmação/drawer sobrevive.
  useEffect(() => {
    setConfirmando(null);
    setDrawer(null);
    setPedidoProdutos(null);
  }, [clienteSlug, clienteContaId, periodo]);

  // Salvar a planilha de custos como base falhou (ex.: 409 nome já usado,
  // 403): o erro mora no card Custos, então o drawer de preparo volta a abrir
  // — com o arquivo ainda escolhido — em vez de a falha sumir com ele fechado.
  // O mesmo vale para falhas do processamento sobre a planilha de custos
  // (413 arquivo grande, 422 planilha sem custos reconhecidos…).
  const erroAoSalvarBase = f.custosApi.salvamentoBase.estado === "erro";
  const erroDeCustos = f.custosApi.erro;
  useEffect(() => {
    if (erroAoSalvarBase || erroDeCustos) setDrawer("preparar");
  }, [erroAoSalvarBase, erroDeCustos]);

  const fecharDrawer = useCallback(() => setDrawer(null), []);
  const fecharEntrega = useCallback(() => {
    setApresentacaoAlterada(false);
    setDrawer(null);
  }, []);

  const p = f.processamento;
  const processando = f.estado === "processando";
  const salvando = f.estado === "salvando";
  const salvoSemProcessar = !p && !!entrega;
  const salvo = useResumoSalvo({ entregaId: entrega?.id ?? null, habilitado: f.marketplaceSuportado && salvoSemProcessar });

  const summary = p?.summary || (salvoSemProcessar ? salvo.summary : null);
  // A leitura (GET /financeiro) tem um fechamento gravado da competência —
  // inclusive o legado, do cliente, sem operação registrada.
  const temLeituraSalva = !p && !!resultadoSalvo?.disponivel && !!resultadoSalvo.dados && resultadoSalvo.dados.status !== "nao_gerado";
  const linhasMemoria = useMemo(
    () => normalizarLinhas(p?.detailedRows, { ambiguousIds: p?.summary?.ambiguousCostIds }),
    [p]
  );
  const linhasSalvas = useMemo(
    () => normalizarLinhas(salvo.detailedRows, { ambiguousIds: salvo.summary?.ambiguousCostIds }),
    [salvo.detailedRows, salvo.summary]
  );
  const linhas = p ? linhasMemoria : summary ? linhasSalvas : [];
  const unmatchedIds = p ? p.unmatchedIds : salvo.unmatchedIds;
  const pend = summary ? resumoDePendencias(summary, { unmatchedIds, unmatchedCosts: p?.unmatchedCosts }) : { produtos: 0, receitaSemCusto: null };

  const legado = `financeiro.html?cliente=${encodeURIComponent(clienteSlug || "")}`;
  const conta = contaNome || (clienteContaId ? `Operação #${clienteContaId}` : null);
  const canal = MK_LABEL[f.marketplace] || f.marketplace || null;
  const modoApi = f.modoApi;
  const sincronizadoApi = f.statusApi.sincronizado;

  if (!f.marketplaceSuportado) {
    return (
      <div className="vf-stack vf-fin-mesa">
        <div className="vf-banner is-info" role="status">
          <div className="vf-banner__content">
            <p className="vf-banner__title">
              {marketplace ? "Este marketplace ainda não fecha aqui" : "Operação sem marketplace resolvido"}
            </p>
            <p className="vf-banner__description">
              {marketplace === "tiktok"
                ? "TikTok Shop precisa da Base TikTok — "
                : "Enquanto a operação não resolve o marketplace, use o "}
              <a href={legado}>Financeiro (legado) →</a>
            </p>
          </div>
        </div>
        {entrega && (
          <EntregaPainel
            entrega={entrega}
            entregas={entregas}
            clienteNome={clienteNome}
            marketplace={f.marketplace}
            contaNome={contaNome}
            clienteContaId={clienteContaId}
            periodo={periodo}
            periodoLabel={periodoLabel}
            onAlterado={setApresentacaoAlterada}
          />
        )}
      </div>
    );
  }

  // ── Ações ───────────────────────────────────────────────────────────
  function baixarPlanilha() {
    baixarBlob(base64ParaBlob(p.excelBase64, TIPO_XLSX), nomeDaPlanilhaProcessada({ marketplace: f.marketplace, periodo }));
  }

  async function salvarEPublicar() {
    setConfirmando(null);
    const gravada = await f.salvar();
    if (gravada?.id != null && entregas?.publicar) await entregas.publicar(gravada.id);
  }

  function publicar() {
    setConfirmando(null);
    if (entrega?.id != null) entregas?.publicar?.(entrega.id);
  }

  async function copiarLink() {
    try {
      await navigator.clipboard.writeText(linkPublico(entrega.token_publico));
      confirmarCopia();
    } catch {
      /* clipboard indisponível — sem quebrar a tela */
    }
  }

  function processarAgora() {
    setDrawer(null);
    f.processar();
  }

  // "+ Custo" na lista grava na base vinculada da conta — só quando é ela
  // que o fechamento usa (sem processamento nesta sessão, a base vinculada
  // é a que o próximo processamento vai usar).
  const baseVinculada = f.base.status === "encontrada" ? f.base.base : null;
  // No modo API, "sync" também é a base vinculada (a que o sync aplicou); o
  // reprocessamento depois da correção recalcula com a base atual.
  const baseParaCustoRapido =
    baseVinculada &&
    (!p || ((p.costsSource === "base" || p.costsSource === "sync") && p.costsBase?.slug === baseVinculada.slug))
      ? baseVinculada
      : null;

  function verPendencias() {
    if (p) {
      setDrawer("pendencias");
      return;
    }
    setPedidoProdutos((atual) => ({ filtro: "sem_custo", seq: (atual?.seq ?? 0) + 1 }));
    document.getElementById("produtos")?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }

  // ── Etapas ──────────────────────────────────────────────────────────
  const ajustesPreenchidos = Object.entries(f.ajustes).filter(([, v]) => String(v ?? "").trim() !== "");
  // No modo API as "vendas" são o sync do mês; os custos, a base (do sync ou
  // atual) ou a planilha de custos enviada.
  const custosApi = f.custosApi;
  const etapas = etapasDoFechamento({
    base: modoApi
      ? {
          status: custosApi.temBase ? "encontrada" : custosApi.baseConhecida ? "ausente" : "carregando",
          override: f.usarUploadDeCustos,
        }
      : { status: f.base.status, override: f.usarUploadDeCustos },
    arquivos: modoApi ? { sales: sincronizadoApi ? { name: "API do Mercado Livre" } : null, costs: f.arquivos.costs } : f.arquivos,
    ajustes: ajustesPreenchidos.length,
    temResultado: !!p,
    salvoSemProcessar,
    pendencias: pend.produtos,
    entrega,
  });

  const nomesDosArquivos = [f.arquivos.sales, f.arquivos.costs, f.arquivos.ordersAll].filter(Boolean).map((a) => a.name);
  const competenciaConfere = p ? (f.divergente ? "competência diverge" : "competência confere") : null;

  function detalheDaFonteApi() {
    if (salvoSemProcessar) return "Usada no fechamento salvo";
    const s = f.statusApi.status;
    if (s === "carregando" || s === "inativo") return "Verificando o sync do mês…";
    if (s === "erro") return "Não foi possível verificar o sync";
    if (!sincronizadoApi) return "Mês não sincronizado · use Sincronizar agora";
    const ate = f.statusApi.sync?.coberturaAte;
    const dia = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ate || ""));
    return `API do Mercado Livre · dados até ${dia ? `${dia[3]}/${dia[2]}` : "—"}${f.statusApi.sync?.completo === false ? " · incompleto" : ""}`;
  }

  function detalheDaBase() {
    if (salvoSemProcessar) return "Usada no fechamento salvo";
    if (p?.costsSource === "sync" && p.costsBase) return `${p.costsBase.nome || p.costsBase.slug} · custos do sync`;
    if (p?.costsSource === "base" && p.costsBase) return `${p.costsBase.nome || p.costsBase.slug} · vinculada`;
    if (p?.costsSource === "upload") return "Planilha de custos enviada";
    const s = f.base.status;
    if (modoApi) {
      if (!custosApi.baseConhecida) return "Verificando a base vinculada…";
      if (f.usarUploadDeCustos) return f.arquivos.costs ? `Planilha de custos: ${f.arquivos.costs.name}` : "Envie a planilha de custos";
      const nome = custosApi.base?.nome || "Base de custos";
      if (custosApi.origem === "base") return `${nome} · recalcula com a base atual`;
      if (custosApi.temBase) return `${nome} · aplicada no sync`;
      return "Sem base vinculada · lucro não calculado";
    }
    if (s === "carregando" || s === "inativo") return "Verificando a base vinculada…";
    if (s === "ambigua") return "Mais de uma conta possível";
    if (s === "erro") return "Não foi possível verificar a base";
    if (s === "encontrada" && !f.usarUploadDeCustos) return `${f.base.base?.nome || "Base de custos"} · vinculada`;
    if (f.arquivos.costs) return `Planilha de custos: ${f.arquivos.costs.name}`;
    return s === "ausente" ? "Sem base vinculada · envie a planilha de custos" : "Envie a planilha de custos";
  }

  const detalhes = {
    base: detalheDaBase(),
    arquivos: modoApi
      ? detalheDaFonteApi()
      : salvoSemProcessar && !nomesDosArquivos.length
        ? "Usados no fechamento salvo"
        : nomesDosArquivos.length ? nomesDosArquivos.join(" · ") : "Falta a planilha de vendas",
    ajustes: ajustesPreenchidos.length
      ? ajustesPreenchidos.map(([k]) => ROTULO_AJUSTE[k] || k).join(", ")
      : salvoSemProcessar ? "Gravados no fechamento salvo" : "Opcional",
    processar: processando
      ? "Processando…"
      : p
        ? `${horaCurta(processadoEm) ? `Hoje, ${horaCurta(processadoEm)} · ` : ""}${competenciaConfere}`
        : salvoSemProcessar
          ? `Salvo em ${formatarDataHora(entrega.created_at)}`
          : f.validacao.ok
            ? "Pronto para processar"
            : `Falta ${qtd(f.validacao.itens.length, "item obrigatório", "itens obrigatórios")}`,
    pendencias: summary
      ? pend.produtos > 0 ? qtd(pend.produtos, "produto sem custo confiável", "produtos sem custo confiável") : "Nenhuma pendência de custo"
      : "Depois de processar",
    publicar: entrega?.publicado
      ? `Publicado em ${formatarDataHora(entrega.published_at)} · link ativo`
      : entrega?.token_publico
        ? "Link revogado · publique de novo"
        : entrega
          ? "Rascunho salvo · falta publicar"
          : "Link de apresentação para o cliente",
  };

  const abrirPreparar = () => setDrawer("preparar");
  const acoes = {
    base: { rotulo: "Ver", onClick: abrirPreparar },
    arquivos: modoApi
      ? { rotulo: "Ver", onClick: abrirPreparar }
      : { rotulo: nomesDosArquivos.length || p ? "Trocar" : "Enviar", onClick: abrirPreparar },
    ajustes: { rotulo: "Editar", onClick: abrirPreparar },
    processar: p
      ? { rotulo: "Refazer", onClick: f.reprocessar, disabled: processando || salvando }
      : salvoSemProcessar
        ? { rotulo: "Reprocessar", onClick: abrirPreparar }
        : f.validacao.ok
          ? { rotulo: "Processar", onClick: f.processar, disabled: processando }
          : null,
    pendencias: summary && pend.produtos > 0 ? { rotulo: "Ver", onClick: verPendencias } : null,
    publicar: entrega ? { rotulo: "Apresentação", onClick: () => setDrawer("entrega") } : null,
  };

  const etapasDoPainel = etapas.map((e) => ({
    ...e,
    titulo: e.id === "arquivos" && modoApi ? "Vendas" : TITULO_ETAPA[e.id],
    detalhe: detalhes[e.id],
    acao: acoes[e.id],
  }));
  const feitas = etapas.filter((e) => e.estado === "feita").length;

  // ── Rodapé do painel: a ação do próximo passo ───────────────────────
  const ocupadaEntrega = entregas?.acaoEmCurso != null;
  const erroEntrega = entrega && entregas?.erroDeAcao?.id === entrega.id ? entregas.erroDeAcao.mensagem : null;
  // Salvar espera a confirmação de duas coisas que o backend pode apontar: a
  // competência dos dados não bater com o período, ou o sync do mês não cobrir
  // o mês inteiro (modo API). Cada uma tem o seu aviso no topo da mesa.
  const aguardaDivergencia = f.divergente && !f.confirmouDivergencia;
  const aguardaSyncIncompleto = f.syncIncompleto && !f.confirmouSyncIncompleto;
  const bloqueadoPorConfirmacao = aguardaDivergencia || aguardaSyncIncompleto;
  const motivoBloqueio = aguardaDivergencia
    ? "Confirme a divergência de competência para salvar."
    : "Confirme a cobertura incompleta dos dados para salvar.";

  const cancelarConfirmacao = () => setConfirmando(null);

  let rodape;
  if (processando) {
    rodape = (
      <AcaoPrincipal
        titulo="Processando…"
        apoio={
          custosApi.salvamentoBase.estado === "salvando"
            ? "Salvando a base de custos"
            : modoApi ? "Lendo os pedidos sincronizados" : "Lendo as planilhas do período"
        }
        icone={ICONES.processar}
        disabled
        aria-busy="true"
      />
    );
  } else if (p && f.estado !== "salvo") {
    rodape = f.duplicidade ? (
      <p className="vf-fin-mesa-painel__nota">Decida no aviso ao lado se substitui o fechamento salvo.</p>
    ) : confirmando === "salvar_publicar" ? (
      <Confirmacao texto={`Salvar e publicar ${periodoLabel}? Gera um link público sem senha.`} rotulo="Salvar e publicar" onConfirmar={salvarEPublicar} onCancelar={cancelarConfirmacao} />
    ) : (
      <>
        <AcaoPrincipal
          tom="sucesso"
          titulo={salvando ? "Salvando…" : "Salvar e publicar"}
          apoio="Gera o link do cliente"
          icone={ICONES.enviar}
          disabled={salvando || bloqueadoPorConfirmacao || ocupadaEntrega}
          aria-busy={salvando ? "true" : undefined}
          onClick={() => setConfirmando("salvar_publicar")}
        />
        <VFButton disabled={salvando || bloqueadoPorConfirmacao} onClick={() => f.salvar()}>
          Salvar como rascunho
        </VFButton>
        <p className="vf-fin-mesa-painel__nota">
          {bloqueadoPorConfirmacao
            ? motivoBloqueio
            : "Publicar gera um link público sem senha e sem validade."}
        </p>
      </>
    );
  } else if (entrega && !entrega.publicado) {
    rodape = confirmando === "publicar" ? (
      <Confirmacao texto={`Publicar ${periodoLabel}? Gera um link público sem senha.`} rotulo="Publicar" onConfirmar={publicar} onCancelar={cancelarConfirmacao} />
    ) : (
      <>
        <AcaoPrincipal
          tom="sucesso"
          titulo={ocupadaEntrega ? "Enviando…" : "Publicar"}
          apoio="Gera o link do cliente"
          icone={ICONES.enviar}
          disabled={ocupadaEntrega || apresentacaoAlterada}
          onClick={() => setConfirmando("publicar")}
        />
        <VFButton onClick={() => setDrawer("entrega")}>Editar apresentação</VFButton>
        {f.estado === "salvo" && <p className="vf-fin-mesa-painel__nota" role="status">Entrega salva como rascunho.</p>}
      </>
    );
  } else if (entrega?.publicado) {
    rodape = (
      <>
        <AcaoPrincipal
          titulo={copiado ? "Link copiado" : "Copiar link"}
          apoio="Link do cliente ativo"
          icone={ICONES.link}
          onClick={copiarLink}
        />
        <div className="vf-cluster">
          <VFButton variant="ghost" size="sm" href={linkPublico(entrega.token_publico)} target="_blank" rel="noreferrer">
            Abrir link
          </VFButton>
          <VFButton size="sm" onClick={() => setDrawer("entrega")}>
            Apresentação e link
          </VFButton>
        </div>
      </>
    );
  } else if (f.validacao.ok) {
    rodape = (
      <AcaoPrincipal
        titulo="Processar fechamento"
        apoio={modoApi ? "Vendas sincronizadas e pronta para processar" : "Base e planilhas prontas"}
        icone={ICONES.processar}
        onClick={f.processar}
      />
    );
  } else if (modoApi) {
    rodape = (
      <>
        <AcaoPrincipal titulo="Preparar vendas" apoio="Sincronize o mês pela API do Mercado Livre" icone={ICONES.arquivo} onClick={abrirPreparar} />
        <p className="vf-fin-mesa-painel__nota">
          Falta {qtd(f.validacao.itens.length, "item obrigatório", "itens obrigatórios")} para processar.
        </p>
      </>
    );
  } else {
    rodape = (
      <>
        <AcaoPrincipal titulo="Enviar planilha de vendas" apoio={`Relatório do ${canal || "marketplace"} do período`} icone={ICONES.arquivo} onClick={abrirPreparar} />
        <p className="vf-fin-mesa-painel__nota">
          Falta {qtd(f.validacao.itens.length, "item obrigatório", "itens obrigatórios")} para processar.
        </p>
      </>
    );
  }

  // ── Coluna da esquerda ──────────────────────────────────────────────
  const comp = f.competencia || {};
  const origemDestaque = p
    ? [
        modoApi ? "vendas: API do Mercado Livre" : null,
        rotuloModo(p.summary),
        (p.costsSource === "base" || p.costsSource === "sync") && p.costsBase
          ? `custos: base ${p.costsBase.nome || p.costsBase.slug}${p.costsSource === "sync" ? " (do sync)" : ""}`
          : p.costsSource === "upload" ? "custos: planilha enviada" : null,
      ].filter(Boolean).join(" · ") || null
    : salvoSemProcessar
      ? `Fechamento salvo em ${formatarDataHora(entrega.created_at)}${entrega.publicado ? ` · publicado em ${formatarDataHora(entrega.published_at)}` : ""}. Processe de novo para atualizar.`
      : null;

  let conteudo;
  if (summary) {
    conteudo = (
      <>
        <ResultadoDestaque summary={summary} periodoLabel={periodoLabel} origem={origemDestaque} />
        {pend.produtos > 0 && (
          <div className="vf-fin-mesa-aviso" role="status" data-testid="aviso-pendencias">
            <span className="vf-fin-mesa-aviso__texto">
              <strong>{qtd(pend.produtos, "produto sem custo confiável", "produtos sem custo confiável")}</strong>
              {pend.receitaSemCusto !== null && pend.receitaSemCusto > 0 ? ` · ${formatarMoeda(pend.receitaSemCusto)} de receita fora da LC` : ""}
            </span>
            <VFButton size="sm" onClick={verPendencias}>
              {p ? "Ver e corrigir" : "Ver produtos"}
            </VFButton>
          </div>
        )}
        <ReceitaAoResultado
          summary={summary}
          onBaixarPlanilha={p?.excelBase64 ? baixarPlanilha : null}
          onDetalhes={() => setDrawer("detalhes")}
        />
      </>
    );
  } else if ((salvoSemProcessar && salvo.carregando) || (carregandoLeitura && !entrega)) {
    conteudo = (
      <div className="vf-card vf-fin-mesa-vazio" aria-busy="true">
        <div className="vf-skeleton vf-skeleton--title" />
        <div className="vf-skeleton vf-skeleton--row" />
        <div className="vf-skeleton vf-skeleton--row" />
      </div>
    );
  } else if (salvoSemProcessar || temLeituraSalva) {
    // Sem summary gravado (entrega legada) ou fechamento só do cliente
    // (operação não registrada): a composição que a leitura devolveu.
    conteudo = (
      <div className="vf-card vf-fin-mesa-vazio is-legado">
        <h3 className="vf-fin-mesa__titulo">Fechamento salvo de {periodoLabel}</h3>
        {origemDestaque && <p className="vf-fin-mesa__descricao">{origemDestaque}</p>}
        {resultadoSalvo?.origemClientLevel && (
          <p className="vf-field__hint">Fechamento legado · operação não registrada — {resultadoSalvo.origemClientLevel.motivo}</p>
        )}
        {resultadoSalvo?.ambiguidade && (
          <p className="vf-field__hint">
            {resultadoSalvo.ambiguidade.total} fechamentos gravados para esta competência; exibindo o #{resultadoSalvo.ambiguidade.escolhidoId}.
          </p>
        )}
        {resultadoSalvo ? <ResultadoTab resultado={resultadoSalvo} periodoLabel={periodoLabel} /> : <p className="vf-field__hint">{salvo.erro || "Composição indisponível."}</p>}
      </div>
    );
  } else {
    const baseCobre = f.base.status === "encontrada" && !f.usarUploadDeCustos;
    let texto;
    if (modoApi) {
      texto = sincronizadoApi
        ? "As vendas do mês já estão sincronizadas da API do Mercado Livre: falta só processar."
        : "Sincronize as vendas do mês pela API do Mercado Livre e depois processe.";
      if (custosApi.baseConhecida && !custosApi.temBase && !f.usarUploadDeCustos) {
        texto += " Esta conta não tem base de custos: sem custos, o lucro não é calculado — envie a planilha de custos em Preparar fechamento.";
      }
    } else {
      texto = baseCobre
        ? "A base de custos já está vinculada, então só falta a planilha de vendas do mês."
        : "Envie a planilha de vendas e a de custos do mês para processar.";
    }
    conteudo = (
      <div className="vf-card vf-fin-mesa-vazio">
        <h3 className="vf-fin-mesa-vazio__titulo">{periodoLabel} ainda não foi fechado</h3>
        <p className="vf-fin-mesa-vazio__texto">Siga as etapas do painel. {texto}</p>
      </div>
    );
  }

  // Sem summary (nada processado, entrega legada ou nenhum fechamento), a
  // conciliação Mercado Pago da competência continua à vista — com summary,
  // ela mora em "Detalhes".
  const conciliacaoAvulsa = !summary && f.marketplace === "meli" && conciliacao ? (
    <details className="vf-fin-disclosure">
      <summary>Conciliação Mercado Pago (Central de Vendas)</summary>
      <ConciliacaoTab conciliacao={conciliacao} />
    </details>
  ) : null;

  return (
    <div className="vf-fin-mesa">
      <div className="vf-fin-mesa__topo">
        <div className={`vf-fin-mesa__principal${processando && p ? " is-atualizando" : ""}`} aria-busy={processando ? "true" : undefined}>
          {f.erro && (
            <VFBanner tone="danger" role="alert" title="Não foi possível concluir">
              {f.erro.mensagem}
            </VFBanner>
          )}

          {p && f.divergente && (
            <div className="vf-banner is-warning" role="alert">
              <div className="vf-banner__content">
                <p className="vf-banner__title">A competência dos dados não bate com o período em tela</p>
                <p className="vf-banner__description">
                  Você está processando <strong>{rotularCompetencia(comp.periodoSolicitado) || periodoLabel}</strong>, mas os
                  dados enviados correspondem a <strong>{rotularCompetencia(comp.periodoDetectado) || "—"}</strong>
                  {comp.multiplasCompetencias ? " (a planilha tem mais de um mês)" : ""}.
                  {comp.motivo ? ` ${comp.motivo}` : ""}
                </p>
                <label className="vf-cluster vf-fin-mesa-checagem">
                  <input type="checkbox" checked={f.confirmouDivergencia} onChange={f.confirmarDivergencia} />
                  <span className="vf-field__hint">Entendo a divergência e quero salvar este fechamento em {periodoLabel} mesmo assim.</span>
                </label>
              </div>
            </div>
          )}

          {p && f.syncIncompleto && (
            <div className="vf-banner is-warning" role="alert">
              <div className="vf-banner__content">
                <p className="vf-banner__title">Os dados sincronizados não cobrem o mês inteiro</p>
                <p className="vf-banner__description">
                  {p.sync?.coberturaAte ? `A cobertura vai até ${p.sync.coberturaAte.slice(8, 10)}/${p.sync.coberturaAte.slice(5, 7)}. ` : ""}
                  {p.sync?.motivoIncompleto ? `${p.sync.motivoIncompleto} ` : ""}
                  Os números valem só para o período coberto.
                </p>
                <label className="vf-cluster vf-fin-mesa-checagem">
                  <input type="checkbox" checked={f.confirmouSyncIncompleto} onChange={f.confirmarSyncIncompleto} />
                  <span className="vf-field__hint">Entendo que o fechamento está incompleto e quero salvar mesmo assim.</span>
                </label>
              </div>
            </div>
          )}

          {f.duplicidade && (
            <VFBanner
              tone={f.duplicidade.publicado ? "danger" : "warning"}
              role="alert"
              title={
                f.duplicidade.publicado
                  ? `${periodoLabel} já tem um fechamento PUBLICADO para esta operação`
                  : `${periodoLabel} já tem um fechamento salvo para esta operação`
              }
              actions={
                <>
                  <VFButton variant="danger" size="sm" disabled={salvando} onClick={f.substituir}>
                    {salvando ? "Substituindo…" : "Substituir"}
                  </VFButton>
                  <VFButton variant="ghost" size="sm" onClick={f.resetar}>
                    Cancelar
                  </VFButton>
                </>
              }
            >
              {f.duplicidade.publicado
                ? "Substituir grava um novo fechamento desta competência. O link que já está com o cliente continua abrindo o fechamento antigo; o novo ganha um link próprio quando for publicado."
                : "Substituir atualiza a entrega existente com o que acabou de ser processado."}
            </VFBanner>
          )}

          {p?.emptySales && (
            <VFBanner tone="info" role="status">
              Planilha válida sem vendas no período.
            </VFBanner>
          )}

          {/* Caixa-preta do fechamento: captura automática no backend. Só avisa
              que já aconteceu — sem dado sensível na tela. */}
          {p?.incidente?.codigo && (
            <div className="vf-cluster vf-fin-incidente" role="status">
              <span className="vf-field__hint">
                Ocorrência de suporte <strong className="vf-mono">{p.incidente.codigo}</strong> — arquivos preservados
                temporariamente para diagnóstico.
              </span>
              <button type="button" className="vf-btn vf-btn--ghost vf-btn--sm" onClick={() => navigator.clipboard?.writeText(p.incidente.codigo)}>
                Copiar código
              </button>
              {ehAdmin() && (
                <a className="vf-btn vf-btn--ghost vf-btn--sm" href={`financeiro-debug.html?incidente=${encodeURIComponent(p.incidente.codigo)}`}>
                  Abrir diagnóstico
                </a>
              )}
            </div>
          )}

          {conteudo}
          {conciliacaoAvulsa}
        </div>

        <PainelEtapas titulo={`Fechamento de ${periodoLabel}`} subtitulo={`${feitas} de ${etapas.length} etapas concluídas`} etapas={etapasDoPainel}>
          {rodape}
          {erroEntrega && <span className="vf-status is-danger" role="alert">{erroEntrega}</span>}
        </PainelEtapas>
      </div>

      {linhas.length > 0 && <ProdutosMesa
          linhas={linhas}
          pedido={pedidoProdutos}
          amostra={!p}
          clienteSlug={clienteSlug}
          clienteContaId={clienteContaId}
          marketplace={f.marketplace}
          baseDeCustos={baseParaCustoRapido}
          onAbrirPendencias={p ? () => setDrawer("pendencias") : null}
          onReprocessar={p ? f.reprocessarComBaseAtual : null}
          reprocessando={processando}
        />}

      {/* ── Drawers ────────────────────────────────────────────────── */}
      {drawer === "preparar" && (
        <VFDrawer
          title="Preparar fechamento"
          subtitle={[periodoLabel, conta, canal].filter(Boolean).join(" · ")}
          onClose={fecharDrawer}
          footer={
            <>
              <span className="vf-field__hint vf-fin-mesa-drawer__motivo">
                {f.validacao.ok ? "Tudo pronto para processar." : f.validacao.itens[0]?.mensagem}
              </span>
              <VFButton variant="ghost" onClick={fecharDrawer}>
                Cancelar
              </VFButton>
              <VFButton variant="primary" disabled={!f.validacao.ok || processando} onClick={processarAgora}>
                {p || salvoSemProcessar ? "Reprocessar" : "Processar fechamento"}
              </VFButton>
            </>
          }
        >
          <div className="vf-stack">
            {f.marketplace === "meli" && (
              <OrigemVendas
                valor={f.fonteVendas}
                onChange={f.definirFonte}
                pendente={f.fonteTrocaPendente}
                onConfirmar={f.confirmarTrocaFonte}
                onCancelar={f.cancelarTrocaFonte}
              />
            )}
            <section className="vf-stack vf-stack--sm">
              <h4 className="vf-fin-mesa__rotulo-grupo">{modoApi ? "Custos" : "Base de custos"}</h4>
              {modoApi ? (
                <CustosModoApi
                  custos={custosApi}
                  usarUpload={f.usarUploadDeCustos}
                  onAlternarUpload={f.alternarUploadDeCustos}
                  arquivo={f.arquivos.costs}
                  onArquivo={(file) => f.setArquivo("costs", file)}
                  aviso={avisoDoCampo(f.validacao, "costs")}
                  clienteNome={clienteNome || clienteSlug}
                  contaNome={conta}
                />
              ) : (
                <BaseCustosStatus
                  base={f.base}
                  marketplace={f.marketplace}
                  clienteNome={clienteNome}
                  usarUploadDeCustos={f.usarUploadDeCustos}
                  onAlternarUpload={f.alternarUploadDeCustos}
                />
              )}
            </section>
            {modoApi ? (
              <section className="vf-stack vf-stack--sm">
                <h4 className="vf-fin-mesa__rotulo-grupo">Vendas do período</h4>
                <SincronizacaoVendas
                  statusApi={f.statusApi}
                  sincronizacao={f.sincronizacao}
                  periodoLabel={periodoLabel}
                  admin={ehAdmin()}
                />
                {avisoDoCampo(f.validacao, "sync") && (
                  <p className="vf-field__hint" role="status">{avisoDoCampo(f.validacao, "sync")}</p>
                )}
              </section>
            ) : (
            <section className="vf-stack vf-stack--sm">
              <h4 className="vf-fin-mesa__rotulo-grupo">Arquivos</h4>
              <FechamentoFileCard
                rotulo={f.marketplace === "shopee" ? "Planilha de vendas / Performance" : "Planilha de vendas"}
                obrigatoriedade="obrigatorio"
                descricao={
                  f.marketplace === "shopee"
                    ? "Performance por produto/variação — a base das vendas pagas do período."
                    : "Relatório de vendas do período."
                }
                file={f.arquivos.sales}
                aviso={avisoDoCampo(f.validacao, "sales")}
                onPick={(file) => f.setArquivo("sales", file)}
              />
              {f.custosObrigatorios && (
                <FechamentoFileCard
                  rotulo="Planilha de custos"
                  obrigatoriedade="obrigatorio"
                  descricao="Custo e imposto por produto/variação."
                  file={f.arquivos.costs}
                  aviso={avisoDoCampo(f.validacao, "costs")}
                  onPick={(file) => f.setArquivo("costs", file)}
                />
              )}
              {f.marketplace === "shopee" && (
                <FechamentoFileCard
                  rotulo="Order.all (Shopee)"
                  obrigatoriedade="recomendado"
                  descricao="Usado para conciliação financeira e identificação dos pedidos — melhora a qualidade do fechamento."
                  file={f.arquivos.ordersAll}
                  onPick={(file) => f.setArquivo("ordersAll", file)}
                />
              )}
            </section>
            )}
            <section className="vf-stack vf-stack--sm">
              <h4 className="vf-fin-mesa__rotulo-grupo">Ajustes do período</h4>
              <FechamentoAjustes
                marketplace={f.marketplace}
                ajustes={f.ajustes}
                onAjuste={f.setAjuste}
                ads={f.ads}
                adsOrigem={f.adsOrigem}
                onUsarAdsDaApi={f.usarAdsDaApi}
              />
            </section>
            <p className="vf-field__hint">
              Processar pelo motor antigo continua possível no <a href={legado}>Financeiro (legado) →</a>
            </p>
          </div>
        </VFDrawer>
      )}

      {drawer === "pendencias" && p && (
        <VFDrawer title="Pendências de custo" subtitle={`${periodoLabel} · corrija na base e reprocesse`} size="lg" onClose={fecharDrawer}>
          <PendenciasCusto
            linhas={linhasMemoria}
            processamento={p}
            marketplace={f.marketplace}
            contexto={{ cliente: clienteNome, clienteSlug, conta, competencia: periodo }}
            base={f.base.status === "encontrada" ? f.base.base : null}
            onReprocessar={() => {
              setDrawer(null);
              f.reprocessarComBaseAtual();
            }}
            reprocessando={processando}
          />
        </VFDrawer>
      )}

      {drawer === "detalhes" && summary && (
        <VFDrawer title="Detalhes do fechamento" subtitle={periodoLabel} size="lg" onClose={fecharDrawer}>
          <DetalhesFechamento
            processamento={p || { summary, unmatchedIds: salvo.unmatchedIds, unmatchedCosts: [], competencia: null }}
            marketplace={f.marketplace}
            conciliacao={conciliacao}
          />
        </VFDrawer>
      )}

      {drawer === "entrega" && entrega && (
        <VFDrawer title="Entrega para o cliente" subtitle={periodoLabel} size="lg" onClose={fecharEntrega}>
          <EntregaPainel
            entrega={entrega}
            entregas={entregas}
            clienteNome={clienteNome}
            marketplace={f.marketplace}
            contaNome={contaNome}
            clienteContaId={clienteContaId}
            periodo={periodo}
            periodoLabel={periodoLabel}
            onAlterado={setApresentacaoAlterada}
          />
        </VFDrawer>
      )}
    </div>
  );
}
