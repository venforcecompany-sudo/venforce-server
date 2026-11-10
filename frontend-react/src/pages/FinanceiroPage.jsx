// frontend-react/src/pages/FinanceiroPage.jsx
//
// Financeiro V3 — a mesa do fechamento (MELI e Shopee), no modelo B aprovado
// em 20/10/2026, na linguagem de Anúncios ML.
//
// Paridade operacional com Portal/financeiro.html: o MESMO motor
// (POST /fechamentos/financeiro) processa; esta tela só apresenta o que o
// backend devolveu. Uma tela só, sem abas:
//
//   Cabeçalho   competência (seletor + status desta conta), e os botões
//               Histórico e Relatórios — cada um abre um drawer.
//   Mesa        resultado + cascata à esquerda, as seis etapas do fechamento
//               à direita, produtos em largura total embaixo
//               (components/financeiro/MesaFechamento.jsx).
//
// Cliente, conta e marketplace vêm do Shell (vf-context, na sidebar).
// Nenhum seletor próprio. A competência é o único controle de contexto desta
// tela, e trocá-la com trabalho em andamento pede confirmação.
//
// TikTok Shop continua no Financeiro legado (fallback em MesaFechamento).

import { useEffect, useState } from "react";
import { useOperacaoAtual } from "../hooks/useVfContext.js";
import { useFinanceiro } from "../hooks/useFinanceiro.js";
import { useEntregasFechamento, entregaDoPeriodo, entregaLegadaDoPeriodo } from "../hooks/useEntregasFechamento.js";
import { rotularCompetencia } from "../utils/dates.js";
import { MK_LABEL } from "../utils/financeiro/marketplace.js";
import { statusDaCompetencia } from "../utils/financeiro/statusCompetencia.js";
import { VFButton } from "../components/ui/VFButton/index.js";
import { VFDrawer } from "../components/ui/VFDrawer/index.js";
import { MesaFechamento } from "../components/financeiro/MesaFechamento.jsx";
import { RelatoriosTab } from "../components/financeiro/RelatoriosTab.jsx";
import { HistoricoTab } from "../components/financeiro/HistoricoTab.jsx";
import { CompetenciaFechamento, AvisosCompetencia } from "../components/financeiro/fechamento/CompetenciaFechamento.jsx";

const SEM_TRABALHO = { temTrabalho: false, processadoNaoSalvo: false };

export default function FinanceiroPage() {
  const { snapshot, pronta, clienteId, clienteSlug, clienteNome, clienteContaId, marketplace } = useOperacaoAtual();
  const contaNome = snapshot?.meta?.nome ?? null;
  const contaRotuloExterno = snapshot?.meta?.externalAccountLabel ?? null;
  const { periodo, setPeriodo, dados, carregando, erro, recarregar: recarregarFinanceiro } = useFinanceiro({ clienteSlug, clienteContaId, pronta });
  const entregas = useEntregasFechamento({ clienteSlug, clienteContaId, habilitado: pronta });
  const [painel, setPainel] = useState(null); // historico | relatorios
  const [trabalho, setTrabalho] = useState(SEM_TRABALHO);
  const [trocaPendente, setTrocaPendente] = useState(null);

  // Trocou a operação no Shell: qualquer troca de mês pendente era sobre a
  // operação anterior.
  useEffect(() => {
    setTrocaPendente(null);
    setPainel(null);
  }, [clienteSlug, clienteContaId]);

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
  const entregaDaConta = entregaDoPeriodo(entregas.entregas, periodo, clienteContaId);
  const entregaLegada = entregaLegadaDoPeriodo(entregas.entregas, periodo);
  const status = statusDaCompetencia({
    entrega: entregaDaConta,
    entregaLegada,
    processadoNaoSalvo: trabalho.processadoNaoSalvo,
  });

  const aoSalvarFechamento = () => {
    entregas.recarregar?.();
    recarregarFinanceiro?.();
  };

  function pedirTroca(nova) {
    if (!nova || nova === periodo) return;
    if (trabalho.temTrabalho) {
      setTrocaPendente(nova);
      return;
    }
    setPeriodo(nova);
  }

  function confirmarTroca() {
    const nova = trocaPendente;
    setTrocaPendente(null);
    if (nova) setPeriodo(nova);
  }

  const canal = MK_LABEL[String(marketplace || "").toLowerCase()] || null;

  return (
    <div className="vf-page-shell">
      <div className="vf-page-container vf-page-container--wide vf-fin-pagina-b">
        <header className="vf-page-header vf-fin-cabecalho-b">
          <div className="vf-page-header__main">
            <p className="vf-page-header__eyebrow">{canal ? `${canal} · Financeiro` : "Financeiro"}</p>
            <h1 className="vf-page-header__title">Fechamento financeiro</h1>
            <p className="vf-page-header__description">
              Processe, confira, salve e publique o fechamento desta operação.{" "}
              <a href={`financeiro.html?cliente=${encodeURIComponent(clienteSlug)}`}>Financeiro (legado) →</a>
            </p>
          </div>
          <div className="vf-fin-cabecalho-b__acoes">
            <CompetenciaFechamento periodo={periodo} status={status} onPedirTroca={pedirTroca} />
            <div className="vf-cluster">
              <VFButton variant="ghost" size="sm" onClick={() => setPainel("historico")}>
                Histórico
              </VFButton>
              <VFButton variant="ghost" size="sm" onClick={() => setPainel("relatorios")}>
                Relatórios
              </VFButton>
            </div>
          </div>
        </header>

        <AvisosCompetencia
          periodo={periodo}
          status={status}
          trocaPendente={trocaPendente}
          onConfirmarTroca={confirmarTroca}
          onCancelarTroca={() => setTrocaPendente(null)}
        />

        {erro && !dados && (
          <div className="vf-banner is-danger" role="alert">
            <div className="vf-banner__content">
              <p className="vf-banner__title">Não foi possível carregar o Financeiro</p>
              <p className="vf-banner__description">{erro.mensagem}</p>
            </div>
          </div>
        )}

        <section className={`vf-fin-mesa-secao${carregando ? " is-atualizando" : ""}`} aria-label="Fechamento">
          <MesaFechamento
            clienteSlug={clienteSlug}
            clienteNome={clienteNome}
            clienteId={clienteId}
            clienteContaId={clienteContaId}
            marketplace={marketplace}
            contaNome={contaNome}
            periodo={periodo}
            periodoLabel={periodoLabel}
            entrega={entregaDaConta}
            entregas={entregas}
            resultadoSalvo={dados?.resultado || null}
            conciliacao={dados?.conciliacao || null}
            carregandoLeitura={!dados && carregando}
            onSalvo={aoSalvarFechamento}
            onTrabalho={setTrabalho}
          />
        </section>
      </div>

      {painel === "historico" && (
        <VFDrawer title="Histórico" subtitle="Competências desta operação, mês a mês" onClose={() => setPainel(null)}>
          <HistoricoTab
            relatorios={dados?.relatorios || null}
            entregas={entregas}
            periodo={periodo}
            clienteContaId={clienteContaId}
            onEscolherCompetencia={(p) => {
              pedirTroca(p);
              setPainel(null);
            }}
          />
        </VFDrawer>
      )}

      {painel === "relatorios" && (
        <VFDrawer title="Relatórios" subtitle="Entregas geradas para esta operação" size="lg" onClose={() => setPainel(null)}>
          <RelatoriosTab
            relatorios={dados?.relatorios || null}
            entregas={entregas}
            periodo={periodo}
            clienteNome={clienteNome}
            clienteContaId={clienteContaId}
            marketplace={marketplace}
            contaNome={contaNome}
            contaRotuloExterno={contaRotuloExterno}
          />
        </VFDrawer>
      )}
    </div>
  );
}
