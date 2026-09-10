// frontend-react/src/pages/FinanceiroPage.jsx
//
// F4.1/F4.2 — Financeiro V3. As 5 seções (Resultado, Conciliação,
// Fechamento, Relatórios gerados, Histórico) continuam vindo de um único
// GET /financeiro/:cliente; F4.2 acrescentou a camada OPERACIONAL sobre as
// entregas de fechamento (GET /entregas-cliente + publicar/despublicar),
// que o backend já suportava e nenhuma tela chamava.
//
// O que continua no legado (Portal/financeiro.html): upload, cálculo e
// salvamento do fechamento. Não por falta de vontade — o endpoint que
// processa não recebe `periodo` e a entrega salva não guarda
// `cliente_conta_id`; migrar esses botões seria prometer, numa tela que
// exibe cliente + operação + competência, uma garantia que o contrato não
// dá. Ver Squads_migration/VENFORCE_V3_F4_2_DEPENDENCIAS_P2_6.md.
//
// Central de Vendas e Margem permanecem módulos próprios (D20 do Master
// Spec) — o Financeiro linka para elas, não as absorve.

import { useState } from "react";
import { useOperacaoAtual } from "../hooks/useVfContext.js";
import { useFinanceiro } from "../hooks/useFinanceiro.js";
import { useEntregasFechamento } from "../hooks/useEntregasFechamento.js";
import { competenciasRecentes, rotularCompetencia } from "../utils/dates.js";
import { Tabs } from "../components/financeiro/Tabs.jsx";
import { ResultadoTab } from "../components/financeiro/ResultadoTab.jsx";
import { ConciliacaoTab } from "../components/financeiro/ConciliacaoTab.jsx";
import { FechamentoTab } from "../components/financeiro/FechamentoTab.jsx";
import { RelatoriosTab } from "../components/financeiro/RelatoriosTab.jsx";
import { HistoricoTab } from "../components/financeiro/HistoricoTab.jsx";

const PERIODOS = competenciasRecentes(13);
const ABAS = [
  { id: "resultado", label: "Resultado" },
  { id: "conciliacao", label: "Conciliação" },
  { id: "fechamento", label: "Fechamento" },
  { id: "relatorios", label: "Relatórios gerados" },
  { id: "historico", label: "Histórico" },
];

export default function FinanceiroPage() {
  const { snapshot, pronta, clienteSlug, clienteContaId, marketplace } = useOperacaoAtual();
  const clienteNome = snapshot?.context?.clienteNome ?? null;
  const contaNome = snapshot?.meta?.nome ?? null;
  const { periodo, setPeriodo, dados, carregando, erro, recarregar: recarregarFinanceiro } = useFinanceiro({ clienteSlug, clienteContaId, pronta });
  // Entregas são de CLIENTE (entregas_cliente não tem cliente_conta_id), por
  // isso a chave aqui é só o slug: trocar de operação não reabre esta lista.
  const entregas = useEntregasFechamento({ clienteSlug, habilitado: pronta });
  const [abaAtiva, setAbaAtiva] = useState("resultado");

  // Convergência #3 §14 — o backend virou fail-safe (conta não resolvida =
  // legado-NULL, nunca união silenciosa). Se o contexto já está READY mas não
  // tem conta, a tela DIZ isso — não mostra R$0/0% como se fosse dado real.
  if (!pronta) {
    if (snapshot?.state === "READY" && !clienteContaId) {
      return (
        <div className="vf-page-shell">
          <div className="vf-page-container">
            <div className="vf-banner is-warning" role="alert" style={{ marginTop: 24 }}>
              <div className="vf-banner__content">
                <p className="vf-banner__title">Operação não resolvida</p>
                <p className="vf-banner__description">
                  Este cliente não tem uma conta (operação) ativa selecionável. Escolha uma conta na
                  barra de contexto para ver o Financeiro desta operação — os números por conta não
                  aparecem enquanto nenhuma está resolvida.
                </p>
              </div>
            </div>
          </div>
        </div>
      );
    }
    // Ainda em BOOT/LOADING: o Shell (data-vf-scope="account") cuida do gating.
    return null;
  }

  const periodoLabel = rotularCompetencia(periodo);
  const aoSalvarFechamento = () => {
    entregas.recarregar?.();
    recarregarFinanceiro?.();
  };

  return (
    <div className="vf-page-shell">
      <div className="vf-page-container">
        <header className="vf-page-header">
          <div className="vf-page-header__main">
            <p className="vf-page-header__eyebrow">Financeiro · em validação (V3)</p>
            <h1 className="vf-page-header__title">Resultado e fechamento do período</h1>
            <p className="vf-page-header__description">
              Gera, salva e publica o fechamento do período nesta tela — aba <strong>Fechamento</strong>.
              O <a href={`financeiro.html?cliente=${encodeURIComponent(clienteSlug)}`}>Financeiro (legado) →</a>{" "}
              segue disponível como fallback (e para TikTok Shop).
            </p>
          </div>
          <div className="vf-page-header__actions">
            <label className="vf-field" style={{ margin: 0 }}>
              <span className="vf-visually-hidden">Período</span>
              <select className="vf-select vf-select--sm" value={periodo} onChange={(e) => setPeriodo(e.target.value)}>
                {PERIODOS.map((c) => (
                  <option key={c} value={c}>{rotularCompetencia(c)}</option>
                ))}
              </select>
            </label>
          </div>
        </header>

        {erro && !dados && (
          <div className="vf-banner is-danger" role="alert">
            <div className="vf-banner__content">
              <p className="vf-banner__title">Não foi possível carregar o Financeiro</p>
              <p className="vf-banner__description">{erro.mensagem}</p>
            </div>
          </div>
        )}

        {!dados && carregando && (
          <div className="vf-stack" style={{ marginTop: 20 }}>
            <div className="vf-skeleton vf-skeleton--title" />
            <div className="vf-skeleton vf-skeleton--row" />
            <div className="vf-skeleton vf-skeleton--row" />
          </div>
        )}

        {dados && (
          <section className={`vf-section${carregando ? " is-atualizando" : ""}`} style={{ marginTop: 20 }}>
            <Tabs abas={ABAS} ativa={abaAtiva} onChange={setAbaAtiva} />
            <div className="vf-fin-painel">
              {abaAtiva === "resultado" && (
                <ResultadoTab
                  resultado={dados.resultado}
                  clienteSlug={clienteSlug}
                  periodoLabel={periodoLabel}
                  onGerar={() => setAbaAtiva("fechamento")}
                />
              )}
              {abaAtiva === "conciliacao" && <ConciliacaoTab conciliacao={dados.conciliacao} />}
              {abaAtiva === "fechamento" && (
                <FechamentoTab
                  resultado={dados.resultado}
                  clienteSlug={clienteSlug}
                  clienteNome={clienteNome}
                  clienteContaId={clienteContaId}
                  marketplace={marketplace}
                  contaNome={contaNome}
                  periodo={periodo}
                  periodoLabel={periodoLabel}
                  entregas={entregas}
                  onSalvo={aoSalvarFechamento}
                />
              )}
              {abaAtiva === "relatorios" && (
                <RelatoriosTab relatorios={dados.relatorios} entregas={entregas} periodo={periodo} />
              )}
              {abaAtiva === "historico" && (
                <HistoricoTab relatorios={dados.relatorios} entregas={entregas} periodo={periodo} />
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
