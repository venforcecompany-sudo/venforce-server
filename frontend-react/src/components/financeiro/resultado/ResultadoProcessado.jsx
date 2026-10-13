// frontend-react/src/components/financeiro/resultado/ResultadoProcessado.jsx
//
// RESULTADO DO PROCESSAMENTO — nasce logo abaixo de Processar, no mesmo
// fluxo. A ordem segue o dashboard do Financeiro legado (a referência de
// leitura pós-processamento), sem os banners grandes dele:
//
//   1. Quanto fechou?            Grade de KPIs (Resultado, receitas, LC, MCs)
//                                + Leitura numa faixa discreta logo abaixo
//   2. Bate com o marketplace?   Reconciliação (Shopee)
//   3. Como se compõe?           Composição: os 4 cartões do legado + eventos
//   4. Posso confiar?            Cobertura (uma faixa — apoio, não protagonista)
//   5. O que está errado?        Pendências (slot `pendencias`)
//   6. Quero salvar/publicar?    Ações (slot `acoes`)
//
// Os produtos NÃO moram aqui: são a investigação detalhada e vêm por último,
// fora deste componente (NovoFechamento). Tudo vem da resposta de
// POST /fechamentos/financeiro; nada é recalculado.

import { useMemo } from "react";
import { ehAdmin } from "../../../services/apiClient.js";
import { normalizarLinhas } from "../../../utils/financeiro/produtos.js";
import { ReconciliacaoShopee } from "../shopee/ReconciliacaoShopee.jsx";
import { rotuloModo, CONFIANCA_LABEL } from "../../../utils/financeiro/resumoFechamento.js";
import { base64ParaBlob, baixarBlob, nomeDaPlanilhaProcessada, TIPO_XLSX } from "../../../utils/financeiro/arquivos.js";
import { SecaoFinanceira } from "../shared/SecaoFinanceira.jsx";
import { ResumoKpis } from "./ResumoKpis.jsx";
import { ComposicaoFinanceira } from "./ComposicaoFinanceira.jsx";
import { CoberturaFechamento } from "./CoberturaFechamento.jsx";
import { LeituraFechamento } from "./LeituraFechamento.jsx";
import { MetricasSecundarias } from "./MetricasSecundarias.jsx";
import { EstadoDoResultado } from "../snapshot/EstadoDoResultado.jsx";
import { OrigemDoFechamento } from "../snapshot/OrigemDoFechamento.jsx";

// `estado`: de QUANDO são estes números (processamento atual × revisão
// salva) — ver EstadoDoResultado. O histórico passa `processamento` montado
// do snapshot (processamentoDoSnapshot) e os MESMOS componentes leem.
export function ResultadoProcessado({ processamento, marketplace, periodo, linhas: linhasDoPai = null, pendencias = null, acoes = null, estado = null }) {
  // Linhas COMPLETAS do processamento em memória, normalizadas uma vez — a
  // mesma lista alimenta pendências e tabela de produtos. O pai pode entregar
  // a lista pronta (para não normalizar duas vezes).
  const linhasProprias = useMemo(
    () => (linhasDoPai ? null : normalizarLinhas(processamento?.detailedRows, { ambiguousIds: processamento?.summary?.ambiguousCostIds })),
    [linhasDoPai, processamento]
  );
  const linhas = linhasDoPai || linhasProprias;

  if (!processamento) {
    return (
      <div className="vf-empty">
        <p className="vf-empty__description">Processe um fechamento para visualizar o resultado.</p>
      </div>
    );
  }
  const summary = processamento.summary || {};
  const modo = rotuloModo(summary);
  const confianca = CONFIANCA_LABEL[summary.financialConfidence] || null;
  const origemCustos = processamento.costsSource === "base" ? processamento.costsBase : null;

  function baixarPlanilha() {
    baixarBlob(base64ParaBlob(processamento.excelBase64, TIPO_XLSX), nomeDaPlanilhaProcessada({ marketplace, periodo }));
  }

  return (
    <section className="vf-fin-resultado vf-fin-pagina" aria-label={estado?.tipo === "revisao" ? "Resultado da revisão salva" : "Resultado do processamento"}>
      <EstadoDoResultado estado={estado} />
      <SecaoFinanceira
        id="resultado"
        titulo="Resultado do fechamento"
        descricao={[
          modo,
          confianca ? `confiança ${confianca.toLowerCase()}` : null,
          // A ORIGEM dos custos fica sempre à vista: é ela que explica a
          // diferença para um processamento feito com outra fonte (o legado
          // Shopee sempre usa a planilha enviada; a V3 usa a base vinculada).
          origemCustos ? `custos: base vinculada ${origemCustos.nome || origemCustos.slug}` : processamento.costsSource === "upload" ? "custos: planilha enviada" : null,
        ]
          .filter(Boolean)
          .join(" · ")}
        acoes={
          processamento.excelBase64 ? (
            <button type="button" className="vf-btn vf-btn--secondary vf-btn--sm" onClick={baixarPlanilha}>
              Baixar planilha processada
            </button>
          ) : null
        }
      >
        {processamento.emptySales && (
          <div className="vf-banner is-info vf-banner--compact" role="status">
            <div className="vf-banner__content">
              <p className="vf-banner__description">Planilha válida sem vendas no período.</p>
            </div>
          </div>
        )}

        {/* Caixa-preta do fechamento: captura automática no backend. Só avisa
            que já aconteceu — sem dado sensível na tela. */}
        {processamento.incidente?.codigo && (
          <div className="vf-cluster vf-fin-incidente" role="status">
            <span className="vf-field__hint">
              Ocorrência de suporte <strong className="vf-mono">{processamento.incidente.codigo}</strong> — arquivos
              preservados temporariamente para diagnóstico.
            </span>
            <button
              type="button"
              className="vf-btn vf-btn--ghost vf-btn--sm"
              onClick={() => navigator.clipboard?.writeText(processamento.incidente.codigo)}
            >
              Copiar código
            </button>
            {ehAdmin() && (
              <a
                className="vf-btn vf-btn--ghost vf-btn--sm"
                href={`financeiro-debug.html?incidente=${encodeURIComponent(processamento.incidente.codigo)}`}
              >
                Abrir diagnóstico
              </a>
            )}
          </div>
        )}

        {/* Topo: os números em largura total; a leitura vem logo abaixo, como
            faixa de apoio (ao lado, ela espremia os KPIs). */}
        <div className="vf-fin-topo">
          <div className="vf-fin-topo__numeros">
            <ResumoKpis summary={summary} />
          </div>
          <LeituraFechamento processamento={processamento} marketplace={marketplace} />
        </div>
      </SecaoFinanceira>

      <ReconciliacaoShopee summary={summary} marketplace={marketplace} />

      <SecaoFinanceira id="composicao" titulo="Composição financeira" descricao="Como o resultado se forma: receitas, deduções, custos e investimentos.">
        <ComposicaoFinanceira summary={summary} marketplace={marketplace} />
        {/* Eventos do período: a grade de KPIs secundários do legado. */}
        <MetricasSecundarias summary={summary} marketplace={marketplace} />
      </SecaoFinanceira>

      <SecaoFinanceira id="cobertura" titulo="Cobertura" className="vf-fin-secao--compacta">
        <CoberturaFechamento
          summary={summary}
          unmatchedIds={processamento.unmatchedIds}
          unmatchedCosts={processamento.unmatchedCosts}
        />
        {/* De onde vieram estes números (manifesto + origem dos custos). */}
        <OrigemDoFechamento processamento={processamento} snapshotId={estado?.tipo === "revisao" ? estado.snapshot?.id ?? null : null} />
      </SecaoFinanceira>

      {typeof pendencias === "function" ? pendencias({ linhas }) : pendencias}

      {acoes}
    </section>
  );
}
