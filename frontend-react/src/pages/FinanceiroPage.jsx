// frontend-react/src/pages/FinanceiroPage.jsx
//
// Financeiro V3 — mesa de trabalho do fechamento (MELI e Shopee).
//
// Paridade operacional com Portal/financeiro.html: o MESMO motor
// (POST /fechamentos/financeiro) processa; esta tela só apresenta o que o
// backend devolveu. Três áreas:
//
//   Fechamento         contexto → arquivos → ajustes → processar →
//                      resultado do processamento → salvar → apresentação
//                      para o cliente → publicar. É onde o trabalho acontece.
//   Relatórios gerados as entregas (artefatos) desta operação — e as legadas
//                      sem operação registrada, rotuladas como tal.
//   Histórico          a sequência de competências desta operação.
//
// As antigas abas "Resultado" e "Conciliação" deixaram de ser processos à
// parte: o resultado nasce logo abaixo de Processar, e o fechamento SALVO
// da competência (com a conciliação Mercado Pago, quando MELI) aparece na
// própria aba Fechamento.
//
// Cliente, conta e marketplace vêm do Shell (vf-context). Nenhum seletor
// próprio. A competência é o único controle de contexto desta tela, e trocá-la
// com trabalho em andamento pede confirmação.
//
// TikTok Shop continua no Financeiro legado (fallback em NovoFechamento).

import { useEffect, useState } from "react";
import { useOperacaoAtual } from "../hooks/useVfContext.js";
import { useFinanceiro } from "../hooks/useFinanceiro.js";
import { useEntregasFechamento, entregaDoPeriodo, entregaLegadaDoPeriodo } from "../hooks/useEntregasFechamento.js";
import { useSnapshotsFechamento } from "../hooks/useSnapshotsFechamento.js";
import { revisoesDoPeriodo } from "../utils/financeiro/revisoes.js";
import { rotularCompetencia } from "../utils/dates.js";
import { statusDaCompetencia } from "../utils/financeiro/statusCompetencia.js";
import { Tabs } from "../components/financeiro/Tabs.jsx";
import { FechamentoTab } from "../components/financeiro/FechamentoTab.jsx";
import { RelatoriosTab } from "../components/financeiro/RelatoriosTab.jsx";
import { HistoricoTab } from "../components/financeiro/HistoricoTab.jsx";
import { CompetenciaFechamento } from "../components/financeiro/fechamento/CompetenciaFechamento.jsx";
import { FechamentoContextoBar } from "../components/financeiro/fechamento/FechamentoContextoBar.jsx";

const ABAS = [
  { id: "fechamento", label: "Fechamento" },
  { id: "relatorios", label: "Relatórios gerados" },
  { id: "historico", label: "Histórico" },
];

const SEM_TRABALHO = { temTrabalho: false, processadoNaoSalvo: false };

export default function FinanceiroPage() {
  const { snapshot, pronta, clienteSlug, clienteNome, clienteContaId, marketplace } = useOperacaoAtual();
  const contaNome = snapshot?.meta?.nome ?? null;
  const contaRotuloExterno = snapshot?.meta?.externalAccountLabel ?? null;
  const { periodo, setPeriodo, dados, carregando, erro, recarregar: recarregarFinanceiro } = useFinanceiro({ clienteSlug, clienteContaId, pronta });
  const entregas = useEntregasFechamento({ clienteSlug, clienteContaId, habilitado: pronta });
  // Revisões (snapshots) DESTA conta — cabeçalho, fechamento salvo e histórico.
  const snapshots = useSnapshotsFechamento({ clienteSlug, clienteContaId, habilitado: pronta });
  const [abaAtiva, setAbaAtiva] = useState("fechamento");
  const [trabalho, setTrabalho] = useState(SEM_TRABALHO);
  const [trocaPendente, setTrocaPendente] = useState(null);
  // Revisão pedida pelo Histórico ("Abrir v1"): o fechamento salvo abre nela.
  const [revisaoPreferida, setRevisaoPreferida] = useState(null);

  // Trocou a operação no Shell: qualquer troca de mês pendente era sobre a
  // operação anterior.
  useEffect(() => {
    setTrocaPendente(null);
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

  // `null` = lista indisponível (a tela cai no fechamento antigo); `[]` = sem revisões.
  const revisoes = Array.isArray(snapshots.snapshots) ? revisoesDoPeriodo(snapshots.snapshots, periodo) : null;

  const aoSalvarFechamento = () => {
    setRevisaoPreferida(null); // salvou: o fechamento salvo volta para a revisão mais nova
    entregas.recarregar?.();
    snapshots.recarregar?.();
    recarregarFinanceiro?.();
  };
  // Publicar/despublicar muda "Publicado: vN" — a lista de revisões recarrega junto.
  const entregasComRevisoes = {
    ...entregas,
    publicar: (id) => entregas.publicar(id).then((r) => { snapshots.recarregar?.(); return r; }),
    despublicar: (id) => entregas.despublicar(id).then((r) => { snapshots.recarregar?.(); return r; }),
    excluir: (id) => entregas.excluir(id).then((r) => { snapshots.recarregar?.(); return r; }),
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

  return (
    <div className="vf-page-shell">
      <div className="vf-page-container vf-page-container--wide">
        <header className="vf-page-header">
          <div className="vf-page-header__main">
            <p className="vf-page-header__eyebrow">Financeiro · V3</p>
            <h1 className="vf-page-header__title">Fechamento financeiro</h1>
            <p className="vf-page-header__description">
              Processe, confira, salve e publique o fechamento desta operação. O{" "}
              <a href={`financeiro.html?cliente=${encodeURIComponent(clienteSlug)}`}>Financeiro (legado) →</a>{" "}
              segue disponível como fallback (e para TikTok Shop).
            </p>
          </div>
        </header>

        <section className="vf-section vf-fin-cabecalho" aria-label="Contexto do fechamento">
          <FechamentoContextoBar
            clienteNome={clienteNome}
            marketplace={marketplace}
            contaNome={contaNome}
            contaRotuloExterno={contaRotuloExterno}
            clienteContaId={clienteContaId}
          />
          <CompetenciaFechamento
            periodo={periodo}
            status={status}
            revisoes={revisoes}
            processadoNaoSalvo={trabalho.processadoNaoSalvo}
            trocaPendente={trocaPendente}
            onPedirTroca={(p) => {
              setRevisaoPreferida(null);
              pedirTroca(p);
            }}
            onConfirmarTroca={confirmarTroca}
            onCancelarTroca={() => setTrocaPendente(null)}
          />
        </section>

        {erro && !dados && (
          <div className="vf-banner is-danger" role="alert" style={{ marginTop: 16 }}>
            <div className="vf-banner__content">
              <p className="vf-banner__title">Não foi possível carregar o Financeiro</p>
              <p className="vf-banner__description">{erro.mensagem}</p>
            </div>
          </div>
        )}

        <section className={`vf-section${carregando ? " is-atualizando" : ""}`} style={{ marginTop: 16 }}>
          <Tabs abas={ABAS} ativa={abaAtiva} onChange={setAbaAtiva} />
          {/* A aba Fechamento fica MONTADA: trocar para Relatórios e voltar não
              pode jogar fora arquivos escolhidos nem o resultado processado. */}
          <div className="vf-fin-painel" hidden={abaAtiva !== "fechamento"}>
            <FechamentoTab
              resultado={dados?.resultado || null}
              conciliacao={dados?.conciliacao || null}
              carregandoLeitura={!dados && carregando}
              clienteSlug={clienteSlug}
              clienteNome={clienteNome}
              clienteContaId={clienteContaId}
              marketplace={marketplace}
              contaNome={contaNome}
              periodo={periodo}
              periodoLabel={periodoLabel}
              entregas={entregasComRevisoes}
              entrega={entregaDaConta}
              onSalvo={aoSalvarFechamento}
              onTrabalho={setTrabalho}
              revisoes={revisoes}
              snapshots={snapshots.snapshots}
              revisaoPreferida={revisaoPreferida}
            />
          </div>
          {abaAtiva === "relatorios" && (
            <div className="vf-fin-painel">
              <RelatoriosTab
                relatorios={dados?.relatorios || null}
                entregas={entregasComRevisoes}
                snapshots={snapshots.snapshots}
                periodo={periodo}
                clienteNome={clienteNome}
                clienteContaId={clienteContaId}
                marketplace={marketplace}
                contaNome={contaNome}
                contaRotuloExterno={contaRotuloExterno}
              />
            </div>
          )}
          {abaAtiva === "historico" && (
            <div className="vf-fin-painel">
              <HistoricoTab
                relatorios={dados?.relatorios || null}
                entregas={entregas}
                periodo={periodo}
                clienteContaId={clienteContaId}
                snapshots={snapshots}
                onEscolherCompetencia={(p, snapshotId = null) => {
                  setRevisaoPreferida(snapshotId);
                  if (p !== periodo) pedirTroca(p);
                  setAbaAtiva("fechamento");
                }}
              />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
