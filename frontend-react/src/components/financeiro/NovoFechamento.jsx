// frontend-react/src/components/financeiro/NovoFechamento.jsx
//
// Convergência #3 — GERAR um fechamento sem sair do Financeiro V3.
//
// Antes desta tela, a aba Fechamento só sabia dizer "vá para o Financeiro
// (legado)". O motor de processamento sempre foi o mesmo dos dois lados
// (POST /fechamentos/financeiro); o que faltava era o formulário V3 mandar
// `periodo` + `clienteContaId` (que a tela mostra no cabeçalho) e tratar a
// competência declarada e a duplicidade. É isso que este componente faz.
//
// O que NÃO está aqui: seletor de Cliente/Conta (vem do Shell), seletor de
// período (vem do cabeçalho da página), e TikTok (precisa da Base TikTok —
// segue no legado, dito explicitamente).

import { useFechamentoNativo, MARKETPLACES_NATIVOS } from "../../hooks/useFechamentoNativo.js";
import { cardsDoSummary } from "../../utils/fechamentoPayload.js";
import { formatarMoeda } from "../../utils/currency.js";
import { rotularCompetencia } from "../../utils/dates.js";
import { ehAdmin } from "../../services/apiClient.js";

const MK_LABEL = { meli: "Mercado Livre", shopee: "Shopee" };

function CampoArquivo({ id, rotulo, hint, obrigatorio, file, onPick }) {
  return (
    <label className="vf-field" htmlFor={id}>
      <span className="vf-field__label">
        {rotulo} {obrigatorio ? <span aria-hidden="true">*</span> : <span className="vf-field__hint">(opcional)</span>}
      </span>
      <input
        id={id}
        type="file"
        className="vf-input"
        accept=".xlsx,.xls,.csv"
        onChange={(e) => onPick(e.target.files?.[0] || null)}
      />
      {file ? <span className="vf-field__hint">{file.name}</span> : hint ? <span className="vf-field__hint">{hint}</span> : null}
    </label>
  );
}

function CampoMoeda({ id, rotulo, valor, onChange }) {
  return (
    <label className="vf-field" htmlFor={id}>
      <span className="vf-field__label">{rotulo}</span>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        className="vf-input"
        placeholder="0,00"
        value={valor}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

export function NovoFechamento({ clienteSlug, clienteNome, clienteContaId, periodo, periodoLabel, onSalvo }) {
  const f = useFechamentoNativo({ clienteSlug, clienteNome, clienteContaId, periodo, onSalvo });
  const legado = `financeiro.html?cliente=${encodeURIComponent(clienteSlug || "")}`;

  const noForm = f.estado === "form" || f.estado === "processando";
  const processando = f.estado === "processando";

  return (
    <div className="vf-stack vf-fin-novo">
      <div className="vf-cluster" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <p className="vf-field__label" style={{ margin: 0 }}>Gerar fechamento de {periodoLabel}</p>
        <span className="vf-field__hint">Operação #{clienteContaId}</span>
      </div>

      {noForm && (
        <>
          <label className="vf-field" htmlFor="fin-novo-mk">
            <span className="vf-field__label">Marketplace *</span>
            <select
              id="fin-novo-mk"
              className="vf-select"
              value={f.marketplace}
              onChange={(e) => f.setMarketplace(e.target.value)}
            >
              <option value="">Selecione…</option>
              {MARKETPLACES_NATIVOS.map((mk) => (
                <option key={mk} value={mk}>{MK_LABEL[mk] || mk}</option>
              ))}
            </select>
            <span className="vf-field__hint">
              TikTok Shop continua no <a href={legado}>Financeiro (legado) →</a> (precisa da Base TikTok).
            </span>
          </label>

          {f.marketplace && (
            <>
              <div className="vf-fin-novo__grid">
                <CampoArquivo
                  id="fin-novo-sales"
                  rotulo="Planilha de vendas"
                  obrigatorio
                  file={f.arquivos.sales}
                  onPick={(file) => f.setArquivo("sales", file)}
                />
                <CampoArquivo
                  id="fin-novo-costs"
                  rotulo="Planilha de custos"
                  obrigatorio={f.marketplace === "shopee"}
                  hint={
                    f.marketplace === "meli"
                      ? "Sem envio, usa a base de custos vinculada ao cliente."
                      : null
                  }
                  file={f.arquivos.costs}
                  onPick={(file) => f.setArquivo("costs", file)}
                />
                {f.marketplace === "shopee" && (
                  <CampoArquivo
                    id="fin-novo-orders"
                    rotulo="Order.all (Shopee)"
                    file={f.arquivos.ordersAll}
                    onPick={(file) => f.setArquivo("ordersAll", file)}
                  />
                )}
              </div>

              <div className="vf-fin-novo__grid">
                <CampoMoeda id="fin-novo-ads" rotulo="ADS" valor={f.ajustes.ads} onChange={(v) => f.setAjuste("ads", v)} />
                <CampoMoeda id="fin-novo-venforce" rotulo="Venforce" valor={f.ajustes.venforce} onChange={(v) => f.setAjuste("venforce", v)} />
                <CampoMoeda id="fin-novo-aff" rotulo="Afiliados" valor={f.ajustes.affiliates} onChange={(v) => f.setAjuste("affiliates", v)} />
                {f.marketplace === "meli" && (
                  <>
                    <CampoMoeda id="fin-novo-full" rotulo="FULL" valor={f.ajustes.fullCost} onChange={(v) => f.setAjuste("fullCost", v)} />
                    <CampoMoeda id="fin-novo-add" rotulo="Custos adicionais" valor={f.ajustes.additionalCosts} onChange={(v) => f.setAjuste("additionalCosts", v)} />
                  </>
                )}
              </div>
            </>
          )}

          {!f.validacao.ok && f.marketplace && (
            <ul className="vf-field__hint" style={{ margin: 0, paddingLeft: 18 }}>
              {f.validacao.problemas.map((p) => <li key={p}>{p}</li>)}
            </ul>
          )}

          <div className="vf-cluster">
            <button
              type="button"
              className="vf-btn vf-btn--primary"
              disabled={!f.validacao.ok || processando}
              aria-busy={processando ? "true" : undefined}
              onClick={f.processar}
            >
              {processando ? "Processando…" : "Processar fechamento"}
            </button>
          </div>
        </>
      )}

      {f.erro && (
        <div className="vf-status is-danger" role="alert">{f.erro.mensagem}</div>
      )}

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
