// frontend-react/src/components/financeiro/NovoFechamento.jsx
//
// GERAR um fechamento sem sair do Financeiro V3. O motor de processamento é
// o mesmo dos dois lados (POST /fechamentos/financeiro); esta tela manda o
// que o cabeçalho mostra (cliente, operação, período, marketplace) e trata
// competência declarada + duplicidade.
//
// A experiência: quem opera não deveria precisar pensar "qual arquivo subo?".
// A leitura é de cima para baixo —
//   1. base de custos (usa a vinculada? precisa de upload?)
//   2. arquivos do fechamento (só os que ainda faltam)
//   3. ajustes do período
//   4. processar (com o motivo de bloqueio à vista)
//   5. RESULTADO DO PROCESSAMENTO completo, no mesmo fluxo, na ordem das
//      perguntas: quanto fechou → posso confiar → o que está errado → como
//      se compõe → salvar / reprocessar / editar arquivos
//   6. (slot) painel da entrega desta competência
//   7. PRODUTOS por último — a investigação detalhada, paginada
//
// O contexto (cliente, marketplace, conta, competência) fica no cabeçalho da
// página. O que NÃO está aqui: seletor de Cliente/Conta/Período (vêm do
// Shell), seletor de marketplace (é o da operação) e TikTok (segue no legado).

import { useEffect, useMemo } from "react";
import { useFechamentoNativo } from "../../hooks/useFechamentoNativo.js";
import { rotularCompetencia } from "../../utils/dates.js";
import { normalizarLinhas } from "../../utils/financeiro/produtos.js";
import { BaseCustosStatus } from "./fechamento/BaseCustosStatus.jsx";
import { FechamentoFileCard } from "./fechamento/FechamentoFileCard.jsx";
import { FechamentoAjustes } from "./fechamento/FechamentoAjustes.jsx";
import { FechamentoAcao } from "./fechamento/FechamentoAcao.jsx";
import { AcoesFechamento } from "./fechamento/AcoesFechamento.jsx";
import { ResultadoProcessado } from "./resultado/ResultadoProcessado.jsx";
import { ProdutosFechamento } from "./produtos/ProdutosFechamento.jsx";
import { SecaoFinanceira } from "./shared/SecaoFinanceira.jsx";
import { PendenciasCusto } from "./pendencias/PendenciasCusto.jsx";
import { resumoRevisoes } from "../../utils/financeiro/revisoes.js";
import { montarPreCheck } from "../../utils/financeiro/preCheck.js";
import { useAssinaturaArquivos } from "../../hooks/useAssinaturaArquivos.js";
import { PreCheckFechamento } from "./fechamento/PreCheckFechamento.jsx";

function avisoDoCampo(validacao, campo) {
  if (validacao.ok) return null;
  return validacao.itens.find((i) => i.campo === campo)?.mensagem || null;
}

export function NovoFechamento({ clienteSlug, clienteNome, clienteContaId, marketplace, contaNome, periodo, periodoLabel, onSalvo, onTrabalho, entregaSlot = null, revisoes = null, snapshots = null }) {
  const f = useFechamentoNativo({ clienteSlug, clienteNome, clienteContaId, marketplace, periodo, onSalvo });
  // Pré-check: sha256 dos arquivos escolhidos (o mesmo do manifesto) para
  // pegar "é o arquivo do mês passado" antes de processar.
  const assinaturas = useAssinaturaArquivos(f.arquivos);
  const preCheck = useMemo(
    () =>
      montarPreCheck({
        clienteNome, contaNome, clienteContaId, periodo, marketplace: f.marketplace,
        base: f.base, usarUploadDeCustos: f.usarUploadDeCustos, custosObrigatorios: f.custosObrigatorios,
        arquivos: f.arquivos, ajustes: f.ajustes, snapshots, assinaturas,
      }),
    [clienteNome, contaNome, clienteContaId, periodo, f.marketplace, f.base, f.usarUploadDeCustos, f.custosObrigatorios, f.arquivos, f.ajustes, snapshots, assinaturas]
  );

  // A página precisa saber se há trabalho em andamento para não trocar de
  // competência em silêncio (CompetenciaFechamento pede confirmação).
  const { temTrabalho, temResultado, processadoNaoSalvo } = f.trabalho;
  useEffect(() => {
    onTrabalho?.({ temTrabalho, temResultado, processadoNaoSalvo });
  }, [onTrabalho, temTrabalho, temResultado, processadoNaoSalvo]);
  const legado = `financeiro.html?cliente=${encodeURIComponent(clienteSlug || "")}`;

  // Linhas COMPLETAS do processamento, normalizadas uma vez: alimentam as
  // pendências (no meio da página) e a tabela de produtos (no fim).
  const linhas = useMemo(
    () => normalizarLinhas(f.processamento?.detailedRows, { ambiguousIds: f.processamento?.summary?.ambiguousCostIds }),
    [f.processamento]
  );

  const processando = f.estado === "processando";
  // Reprocessar mantém o resultado anterior visível (ocupado) até o novo
  // chegar; o formulário só reaparece quando não há resultado.
  const noForm = f.estado === "form" || (processando && !f.processamento);
  const comResultado = !!f.processamento && f.estado !== "form";

  if (!f.marketplaceSuportado) {
    return (
      <div className="vf-fin-novo">
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
        {entregaSlot}
      </div>
    );
  }

  return (
    <div className="vf-stack vf-fin-novo">
      {noForm && (
        <>
          <section className="vf-fin-novo__passo">
            <h3 className="vf-fin-novo__passo-titulo">Base de custos</h3>
            <BaseCustosStatus
              base={f.base}
              marketplace={f.marketplace}
              clienteNome={clienteNome}
              usarUploadDeCustos={f.usarUploadDeCustos}
              onAlternarUpload={f.alternarUploadDeCustos}
            />
          </section>

          <section className="vf-fin-novo__passo">
            <h3 className="vf-fin-novo__passo-titulo">Arquivos do fechamento</h3>
            <div className="vf-fin-novo__files">
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
            </div>
          </section>

          <section className="vf-fin-novo__passo">
            <h3 className="vf-fin-novo__passo-titulo">Ajustes do período</h3>
            <p className="vf-fin-novo__passo-nota">Valores adicionais que afetam o resultado deste fechamento.</p>
            <FechamentoAjustes marketplace={f.marketplace} ajustes={f.ajustes} onAjuste={f.setAjuste} />
          </section>

          <PreCheckFechamento preCheck={preCheck} />

          <FechamentoAcao validacao={f.validacao} processando={processando} onProcessar={f.processar} />
        </>
      )}

      {f.erro && <div className="vf-status is-danger" role="alert">{f.erro.mensagem}</div>}

      {comResultado && (
        <PreviewFechamento
          f={f}
          revisoes={revisoes}
          linhas={linhas}
          periodo={periodo}
          periodoLabel={periodoLabel}
          legado={legado}
          contexto={{ cliente: clienteNome, clienteSlug, conta: contaNome || (clienteContaId ? `#${clienteContaId}` : null), competencia: periodo }}
        />
      )}

      {/* Painel da entrega: SEMPRE neste mesmo lugar da árvore (entre o
          preview e os produtos), com ou sem resultado — assim não é remontado
          ao processar e o que o operador editou nele não se perde. */}
      {entregaSlot}

      {comResultado && <ProdutosFechamento linhas={linhas} />}
    </div>
  );
}

function PreviewFechamento({ f, linhas, periodo, periodoLabel, legado, contexto, revisoes }) {
  const comp = f.competencia || {};
  const reprocessando = f.estado === "processando";
  // Próxima revisão desta competência (a tela diz o número ANTES de salvar).
  const resumo = resumoRevisoes(revisoes);
  const proximaRevisao = (resumo.ultima?.revisao || 0) + 1;

  return (
    <div className={`vf-fin-pagina${reprocessando ? " is-atualizando" : ""}`} aria-busy={reprocessando ? "true" : undefined}>
      {/* ── Competência declarada pelo backend ─────────────────────────── */}
      {f.divergente ? (
        <div className="vf-banner is-warning" role="alert">
          <div className="vf-banner__content">
            <p className="vf-banner__title">A competência dos dados não bate com o período em tela</p>
            <p className="vf-banner__description">
              Você está processando <strong>{rotularCompetencia(comp.periodoSolicitado) || periodoLabel}</strong>, mas os
              dados enviados correspondem a <strong>{rotularCompetencia(comp.periodoDetectado) || "—"}</strong>
              {comp.multiplasCompetencias ? " (a planilha tem mais de um mês)" : ""}.
              {comp.motivo ? ` ${comp.motivo}` : ""}
            </p>
            <label className="vf-field" style={{ marginTop: 8, flexDirection: "row", gap: 8, alignItems: "center" }}>
              <input
                type="checkbox"
                checked={f.confirmouDivergencia}
                onChange={f.confirmarDivergencia}
              />
              <span className="vf-field__hint">
                Entendo a divergência e quero salvar este fechamento em {periodoLabel} mesmo assim.
              </span>
            </label>
          </div>
        </div>
      ) : (
        <p className="vf-field__hint">
          Competência confere: dados de {rotularCompetencia(comp.periodoDetectado) || periodoLabel}.
        </p>
      )}

      <ResultadoProcessado
        processamento={f.processamento}
        marketplace={f.marketplace}
        periodo={periodo}
        linhas={linhas}
        estado={{ tipo: "atual", salvo: f.snapshotSalvo || null, proximaRevisao: revisoes ? proximaRevisao : null }}
        pendencias={() => (
          <PendenciasCusto
            linhas={linhas}
            processamento={f.processamento}
            marketplace={f.marketplace}
            contexto={contexto}
            base={f.base.status === "encontrada" ? f.base.base : null}
            onReprocessar={f.reprocessar}
            reprocessando={reprocessando}
          />
        )}
        acoes={
          <SecaoFinanceira id="acoes" titulo="Ações do fechamento">
            <AcoesFechamento f={f} periodoLabel={periodoLabel} legado={legado} proximaRevisao={revisoes ? proximaRevisao : null} revisaoPublicada={resumo.publicada} />
          </SecaoFinanceira>
        }
      />
    </div>
  );
}
