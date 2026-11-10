// frontend-react/src/components/financeiro/fechamento/CustosModoApi.jsx
//
// Card "Custos" do modo API (drawer Preparar fechamento). Responde de onde
// saem os custos do fechamento pela API — o que o backend chama de
// `custosOrigem`:
//   · "sync"   os custos que o sync da Central gravou (padrão);
//   · "base"   recalcular agora com a base vinculada ATUAL (padrão quando a
//              base mudou depois do sync, ou foi salva agora);
//   · "upload" uma planilha de custos enviada aqui — em destaque quando a
//              conta não tem base (sem custos, o lucro não é calculado).
//
// A planilha pode virar a base da conta ("Salvar como base de custos"), mas
// só quando a conta AINDA NÃO tem base: atualizar uma base existente é na
// tela Bases, que tem a pré-visualização. Aqui nada é calculado — o card só
// mostra o estado que o hook (useFechamentoNativo) mantém.

import { useId } from "react";
import { formatarDataHora } from "../../../utils/dates.js";
import { cx } from "../../../utils/cx.js";
import { FechamentoFileCard } from "./FechamentoFileCard.jsx";

export function CustosModoApi({ custos, usarUpload, onAlternarUpload, arquivo, onArquivo, aviso, clienteNome, contaNome }) {
  const nomeId = useId();
  const {
    temBase,
    baseConhecida,
    base,
    baseMudouDepoisDoSync,
    manterCustosDoSync,
    definirManterCustosDoSync,
    salvarComoBase,
    definirSalvarComoBase,
    salvarBaseBloqueio,
    nomeBase,
    definirNomeBase,
    salvamentoBase,
  } = custos;

  if (!baseConhecida) {
    return (
      <div className="vf-fin-base is-carregando">
        <span className="vf-spinner vf-spinner--sm" aria-hidden="true" />
        <span className="vf-fin-base__texto">Verificando a base de custos…</span>
      </div>
    );
  }

  const destino = [clienteNome, contaNome].filter(Boolean).join(" · ") || "esta conta";
  const salvo = salvamentoBase.estado === "salvo" ? salvamentoBase.base : null;

  return (
    <div className="vf-stack vf-stack--sm" data-testid="custos-modo-api">
      {temBase ? (
        <div className={cx("vf-fin-base", "is-encontrada", (usarUpload || baseMudouDepoisDoSync) && "is-override")}>
          <div className="vf-fin-base__principal">
            <span className="vf-fin-base__marca" aria-hidden="true">✓</span>
            <div className="vf-fin-base__corpo">
              <p className="vf-fin-base__titulo">Base vinculada</p>
              <p className="vf-fin-base__detalhe">
                <strong>{base?.nome || base?.slug || "Base de custos"}</strong>
                {base?.atualizadaEm ? ` · atualizada em ${formatarDataHora(base.atualizadaEm)}` : ""}
              </p>
              <p className="vf-fin-base__nota">
                {usarUpload
                  ? "Você optou por usar a planilha de custos abaixo neste fechamento."
                  : baseMudouDepoisDoSync && !manterCustosDoSync
                    ? "Os custos serão recalculados com a base atual."
                    : "Os custos vêm da base aplicada na última sincronização."}
              </p>
            </div>
          </div>
          <button type="button" className="vf-btn vf-btn--ghost vf-btn--sm" onClick={() => onAlternarUpload(!usarUpload)}>
            {usarUpload ? "Voltar a usar a base vinculada" : "Usar planilha de custos"}
          </button>
        </div>
      ) : (
        <div className="vf-fin-base is-ausente">
          <span className="vf-fin-base__marca" aria-hidden="true">⚠</span>
          <div className="vf-fin-base__corpo">
            <p className="vf-fin-base__titulo">Esta conta não tem base de custos vinculada</p>
            <p className="vf-fin-base__nota">
              {usarUpload
                ? "O fechamento vai usar a planilha de custos abaixo."
                : "Sem custos, o lucro (LC, margem e resultado) não é calculado. Envie a planilha de custos do cliente."}
            </p>
          </div>
          {!usarUpload && (
            <button type="button" className="vf-btn vf-btn--primary vf-btn--sm" onClick={() => onAlternarUpload(true)}>
              Usar planilha de custos
            </button>
          )}
          {usarUpload && (
            <button type="button" className="vf-btn vf-btn--ghost vf-btn--sm" onClick={() => onAlternarUpload(false)}>
              Não usar planilha de custos
            </button>
          )}
        </div>
      )}

      {temBase && !usarUpload && baseMudouDepoisDoSync && (
        <div className="vf-banner is-warning vf-banner--compact" role="status">
          <div className="vf-banner__content">
            <p className="vf-banner__title">A base mudou depois da última sincronização</p>
            <p className="vf-banner__description">
              {manterCustosDoSync
                ? "Este fechamento vai usar os custos gravados no sync, não os da base atual."
                : "Por isso este fechamento recalcula os custos com a base atual."}
            </p>
            <div className="vf-cluster">
              <button type="button" className="vf-btn vf-btn--ghost vf-btn--sm" onClick={() => definirManterCustosDoSync(!manterCustosDoSync)}>
                {manterCustosDoSync ? "Recalcular com a base atual" : "Manter os custos do sync"}
              </button>
            </div>
          </div>
        </div>
      )}

      {custos.erro && (
        <p className="vf-status is-danger" role="alert" data-testid="custos-erro">
          {custos.erro}
        </p>
      )}

      {salvo && (
        <p className="vf-status is-success" role="status">
          Base “{salvo.nome}” salva e vinculada{salvo.total != null ? ` (${salvo.total.toLocaleString("pt-BR")} produtos)` : ""}. Os
          próximos syncs e a Central de Margem passam a usá-la.
        </p>
      )}

      {usarUpload && (
        <>
          <FechamentoFileCard
            rotulo="Planilha de custos"
            obrigatoriedade="obrigatorio"
            descricao="Custo e imposto por anúncio (MLB). Vale para este fechamento."
            file={arquivo}
            aviso={aviso}
            onPick={onArquivo}
          />
          {arquivo && (
            <div className="vf-stack vf-stack--sm vf-fin-custos-api__salvar">
              <label className="vf-cluster vf-fin-mesa-checagem">
                <input
                  type="checkbox"
                  checked={salvarBaseBloqueio === null && salvarComoBase}
                  disabled={salvarBaseBloqueio !== null}
                  onChange={(e) => definirSalvarComoBase(e.target.checked)}
                />
                <span className="vf-field__hint">Salvar como base de custos de {destino}</span>
              </label>
              {salvarBaseBloqueio === "base_existente" && (
                <p className="vf-field__hint">
                  Para atualizar a base existente, use a tela Bases. <a href="bases.html">Abrir Bases →</a>
                </p>
              )}
              {salvarBaseBloqueio === null && salvarComoBase && (
                <div className="vf-field">
                  <label className="vf-field__hint" htmlFor={nomeId}>Nome da base</label>
                  <input id={nomeId} type="text" className="vf-input" value={nomeBase} onChange={(e) => definirNomeBase(e.target.value)} />
                  <span className="vf-field__hint">
                    A base é criada e vinculada a {destino} antes de processar. Os próximos syncs e a Central de Margem passam a usá-la.
                  </span>
                </div>
              )}
              {salvamentoBase.estado === "salvando" && (
                <p className="vf-field__hint" role="status">Salvando a base de custos…</p>
              )}
              {salvamentoBase.estado === "erro" && (
                <p className="vf-status is-danger" role="alert">
                  Não foi possível salvar a base: {salvamentoBase.mensagem} O arquivo continua escolhido.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
