// frontend-react/src/components/financeiro/snapshot/OrigemDoFechamento.jsx
//
// "Arquivos e origem" — o que gerou estes números: os arquivos (nome,
// tamanho, sha256 — o manifesto; o binário não é guardado), a origem dos
// custos (base vinculada × planilha, com a impressão digital das linhas),
// os ajustes que o motor recebeu e quando foi processado. Mesmo bloco no
// processamento atual e na revisão salva; na revisão, dá para conferir se a
// base de custos mudou desde então.
//
// Discreto (details): é a resposta para "por que fechou com esse número?",
// não um passo do fechamento.

import { useState } from "react";
import { conferirBaseAtual } from "../../../services/fechamentoSnapshotApi.js";
import { formatarDataHora } from "../../../utils/dates.js";
import { formatarMoeda } from "../../../utils/currency.js";
import { formatarNumero } from "../../../utils/numbers.js";

const TIPO = {
  vendas: "Vendas / Performance",
  custos: "Planilha de custos",
  order_all: "Order.all",
  onhold: "Onhold (TikTok)",
  resultado: "Planilha processada (gerada)",
};
const AJUSTES = [
  ["ads", "ADS"],
  ["venforce", "Venforce"],
  ["affiliates", "Afiliados"],
  ["fullCost", "FULL"],
  ["additionalCosts", "Custos adicionais"],
];

function tamanho(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${formatarNumero(n / 1024, 0)} KB`;
  return `${formatarNumero(n / (1024 * 1024), 1)} MB`;
}

const curto = (sha) => (sha ? `${String(sha).slice(0, 12)}…` : "—");

function ConferirBase({ snapshotId }) {
  const [estado, setEstado] = useState({ fase: "parado", r: null, erro: null });
  async function conferir() {
    setEstado({ fase: "conferindo", r: null, erro: null });
    try {
      const r = await conferirBaseAtual(snapshotId);
      setEstado({ fase: "pronto", r, erro: null });
    } catch (err) {
      setEstado({ fase: "pronto", r: null, erro: err?.message || "Não foi possível conferir." });
    }
  }
  const { r } = estado;
  return (
    <div className="vf-cluster" data-testid="conferir-base">
      <button type="button" className="vf-btn vf-btn--ghost vf-btn--sm" disabled={estado.fase === "conferindo"} onClick={conferir}>
        {estado.fase === "conferindo" ? "Conferindo…" : "Conferir se a base mudou"}
      </button>
      {estado.erro && <span className="vf-status is-danger">{estado.erro}</span>}
      {r && !r.aplicavel && <span className="vf-field__hint">{r.motivo}</span>}
      {r && r.aplicavel && !r.disponivel && <span className="vf-status is-warning">Base indisponível agora: {r.motivo}</span>}
      {r && r.aplicavel && r.disponivel && (
        r.mesma ? (
          <span className="vf-status is-success" data-base="mesma">A base é a mesma desta revisão ({formatarNumero(r.linhasAgora)} linhas).</span>
        ) : (
          <span className="vf-status is-warning" data-base="mudou">
            A base mudou depois desta revisão ({formatarNumero(r.linhasNaRevisao)} → {formatarNumero(r.linhasAgora)} linhas). Reprocessar hoje pode dar outro número.
          </span>
        )
      )}
    </div>
  );
}

export function OrigemDoFechamento({ processamento, snapshotId = null }) {
  const bloco = processamento?.processamento;
  if (!bloco) return null;
  const arquivos = Array.isArray(bloco.arquivos) ? bloco.arquivos : [];
  const base = processamento.costsSource === "base" ? processamento.costsBase : null;
  const custos = bloco.custos;
  const ajustes = AJUSTES.filter(([k]) => bloco.ajustes && bloco.ajustes[k] != null);

  return (
    <details className="vf-fin-disclosure vf-fin-origem" data-testid="origem-fechamento">
      <summary>Arquivos e origem · {arquivos.filter((a) => a.origem === "upload").length} arquivo(s){base ? ` · base ${base.nome || base.slug}` : ""}</summary>
      <div className="vf-stack vf-stack--sm">
        <dl className="vf-fin-contexto vf-fin-contexto--compacto">
          <div className="vf-fin-contexto__item">
            <dt>Custos</dt>
            <dd>
              {base ? `Base vinculada ${base.nome || base.slug}` : processamento.costsSource === "upload" ? "Planilha de custos enviada" : "—"}
              {custos ? ` · ${formatarNumero(custos.linhas)} linhas · impressão ${curto(custos.sha256)}` : ""}
            </dd>
          </div>
          <div className="vf-fin-contexto__item">
            <dt>Processado em</dt>
            <dd>{formatarDataHora(bloco.processadoEm)}</dd>
          </div>
          {ajustes.length > 0 && (
            <div className="vf-fin-contexto__item">
              <dt>Ajustes</dt>
              <dd>{ajustes.map(([k, rotulo]) => `${rotulo} ${formatarMoeda(bloco.ajustes[k])}`).join(" · ")}</dd>
            </div>
          )}
        </dl>
        {arquivos.length > 0 && (
          <div className="vf-table-wrap">
            <table className="vf-table vf-table--compact" aria-label="Arquivos do fechamento">
              <thead>
                <tr><th>Tipo</th><th>Arquivo</th><th className="is-numeric">Tamanho</th><th>sha256</th></tr>
              </thead>
              <tbody>
                {arquivos.map((a) => (
                  <tr key={`${a.tipo}-${a.sha256}`} data-arquivo={a.tipo}>
                    <td>{TIPO[a.tipo] || a.tipo}</td>
                    <td><span className="vf-fin-clamp" title={a.nomeOriginal}>{a.nomeOriginal || "—"}</span></td>
                    <td className="is-numeric">{tamanho(a.tamanhoBytes)}</td>
                    <td className="vf-mono" title={a.sha256}>{curto(a.sha256)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="vf-field__hint">
          Os arquivos não ficam guardados — só o manifesto (nome, tamanho e sha256), que prova qual arquivo gerou o número.
        </p>
        {snapshotId && base && <ConferirBase snapshotId={snapshotId} />}
      </div>
    </details>
  );
}
