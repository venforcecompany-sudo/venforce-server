// frontend-react/src/components/financeiro/NovoFechamento.jsx
//
// GERAR um fechamento sem sair do Financeiro V3. O motor de processamento é
// o mesmo dos dois lados (POST /fechamentos/financeiro); esta tela manda o
// que o cabeçalho mostra (cliente, operação, período, marketplace) e trata
// competência declarada + duplicidade.
//
// A experiência: quem opera não deveria precisar pensar "qual arquivo subo?".
// A leitura é de cima para baixo —
//   1. contexto da operação (uma linha)
//   2. base de custos (usa a vinculada? precisa de upload?)
//   3. arquivos do fechamento (só os que ainda faltam)
//   4. ajustes do período
//   5. processar (com o motivo de bloqueio à vista)
//
// O que NÃO está aqui: seletor de Cliente/Conta/Período (vêm do Shell),
// seletor de marketplace (é o da operação) e TikTok (segue no legado).

import { useFechamentoNativo } from "../../hooks/useFechamentoNativo.js";
import { cardsDoSummary } from "../../utils/fechamentoPayload.js";
import { formatarMoeda } from "../../utils/currency.js";
import { rotularCompetencia } from "../../utils/dates.js";
import { ehAdmin } from "../../services/apiClient.js";
import { FechamentoContextoBar } from "./fechamento/FechamentoContextoBar.jsx";
import { BaseCustosStatus } from "./fechamento/BaseCustosStatus.jsx";
import { FechamentoFileCard } from "./fechamento/FechamentoFileCard.jsx";
import { FechamentoAjustes } from "./fechamento/FechamentoAjustes.jsx";
import { FechamentoAcao } from "./fechamento/FechamentoAcao.jsx";

function avisoDoCampo(validacao, campo) {
  if (validacao.ok) return null;
  return validacao.itens.find((i) => i.campo === campo)?.mensagem || null;
}

export function NovoFechamento({ clienteSlug, clienteNome, clienteContaId, marketplace, contaNome, periodo, periodoLabel, onSalvo }) {
  const f = useFechamentoNativo({ clienteSlug, clienteNome, clienteContaId, marketplace, periodo, onSalvo });
  const legado = `financeiro.html?cliente=${encodeURIComponent(clienteSlug || "")}`;

  const noForm = f.estado === "form" || f.estado === "processando";
  const processando = f.estado === "processando";

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
      </div>
    );
  }

  return (
    <div className="vf-stack vf-fin-novo">
      <FechamentoContextoBar
        clienteNome={clienteNome}
        marketplace={f.marketplace}
        contaNome={contaNome}
        clienteContaId={clienteContaId}
        periodoLabel={periodoLabel}
      />

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

          <FechamentoAcao validacao={f.validacao} processando={processando} onProcessar={f.processar} />
        </>
      )}

      {f.erro && <div className="vf-status is-danger" role="alert">{f.erro.mensagem}</div>}

      {!noForm && f.processamento && (
        <PreviewFechamento f={f} periodoLabel={periodoLabel} legado={legado} />
      )}
    </div>
  );
}

function PreviewFechamento({ f, periodoLabel, legado }) {
  const comp = f.competencia || {};
  const cards = cardsDoSummary(f.processamento.summary);
  const salvando = f.estado === "salvando";
  const salvo = f.estado === "salvo";
  const origemCustos = f.processamento.costsSource === "base" ? f.processamento.costsBase : null;

  return (
    <div className="vf-stack vf-stack--sm">
      {/* ── Competência ─────────────────────────────────────────────────── */}
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

      {origemCustos && (
        <p className="vf-field__hint">
          Custos da base vinculada <strong>{origemCustos.nome || origemCustos.slug}</strong>.
        </p>
      )}

      {/* ── Cards do resultado ──────────────────────────────────────────── */}
      <div className="vf-fin-novo__cards">
        {cards.map((c) => (
          <div className="vf-fin-novo__card" key={c.titulo}>
            <span className="vf-fin-novo__card-rotulo">{c.titulo}</span>
            <span className="vf-fin-novo__card-valor">
              {c.disponivel
                ? (c.titulo.includes("%") ? `${Number(c.valor).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%` : formatarMoeda(c.valor))
                : "—"}
            </span>
          </div>
        ))}
      </div>

      {/* ── Incidente de suporte (caixa-preta do fechamento) ───────────────
          Captura 100% automática no backend quando há anomalia relevante —
          este banner só avisa que já aconteceu, sem exigir ação do usuário. */}
      {f.processamento.incidente?.codigo && (
        <div className="vf-banner is-info" role="status">
          <div className="vf-banner__content">
            <p className="vf-banner__title">Ocorrência de suporte {f.processamento.incidente.codigo} criada</p>
            <p className="vf-banner__description">
              Os arquivos utilizados foram preservados temporariamente para diagnóstico. Se precisar de ajuda, informe este código.
            </p>
            <div className="vf-cluster">
              <button
                type="button"
                className="vf-btn vf-btn--secondary vf-btn--sm"
                onClick={() => navigator.clipboard?.writeText(f.processamento.incidente.codigo)}
              >
                Copiar código
              </button>
              {ehAdmin() && (
                <a
                  className="vf-btn vf-btn--ghost vf-btn--sm"
                  href={`financeiro-debug.html?incidente=${encodeURIComponent(f.processamento.incidente.codigo)}`}
                >
                  Abrir diagnóstico
                </a>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Duplicidade (409) ───────────────────────────────────────────── */}
      {f.duplicidade && (
        <div className={`vf-banner ${f.duplicidade.publicado ? "is-danger" : "is-warning"}`} role="alert">
          <div className="vf-banner__content">
            <p className="vf-banner__title">
              {f.duplicidade.publicado
                ? `${periodoLabel} já tem um fechamento PUBLICADO para esta operação`
                : `${periodoLabel} já tem um fechamento salvo para esta operação`}
            </p>
            <p className="vf-banner__description">
              {f.duplicidade.publicado
                ? "Substituir troca os números por trás do link que já está com o cliente — o link continua o mesmo (o token público é preservado)."
                : "Substituir atualiza a entrega existente com o que acabou de ser processado."}
            </p>
            <div className="vf-cluster">
              <button type="button" className="vf-btn vf-btn--danger vf-btn--sm" disabled={salvando} onClick={f.substituir}>
                {salvando ? "Substituindo…" : "Substituir"}
              </button>
              <button type="button" className="vf-btn vf-btn--ghost vf-btn--sm" onClick={f.resetar}>
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Ações ───────────────────────────────────────────────────────── */}
      {salvo ? (
        <div className="vf-stack vf-stack--sm">
          <div className="vf-status is-success" role="status">
            Fechamento salvo. A entrega aparece abaixo — publique por lá quando quiser gerar o link do cliente.
          </div>
          <div className="vf-cluster">
            <button type="button" className="vf-btn vf-btn--ghost vf-btn--sm" onClick={f.resetar}>
              Processar outro
            </button>
          </div>
        </div>
      ) : !f.duplicidade ? (
        <div className="vf-cluster">
          <button
            type="button"
            className="vf-btn vf-btn--primary"
            disabled={salvando || (f.divergente && !f.confirmouDivergencia)}
            aria-busy={salvando ? "true" : undefined}
            onClick={() => f.salvar()}
          >
            {salvando ? "Salvando…" : "Salvar fechamento"}
          </button>
          <button type="button" className="vf-btn vf-btn--ghost vf-btn--sm" onClick={f.resetar}>
            Voltar
          </button>
        </div>
      ) : null}

      <p className="vf-field__hint">
        Reprocessar pelo motor antigo continua possível no <a href={legado}>Financeiro (legado) →</a>
      </p>
    </div>
  );
}
