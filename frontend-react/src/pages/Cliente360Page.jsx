// Página Cliente 360 — a primeira tela do Portal em React.
//
// Ordem fixada em produto:
//   1. Cabeçalho do cliente
//   2. Filtros de competência e comparação
//   3. Status de confiança (faixa curta no topo)
//   4-6. Fechamento do mês → resultado operacional → resultado após Ads
//   7. Comparação mensal
//   8. Bloco separado "Ads no fechamento"
//   9. Ponte do resultado operacional
//   10-13. Produtos: ajudaram · prejudicaram · no vermelho · abaixo da margem-alvo
//   14. Oportunidades operacionais
//   15. Simulador
//   16. Confiança dos dados
//   17. Placar operacional do consultor (admin)

import { useCliente360 } from "../hooks/useCliente360.js";
import Cliente360Header from "../components/cliente360/Cliente360Header.jsx";
import Cliente360Filters from "../components/cliente360/Cliente360Filters.jsx";
import FechamentoResumo from "../components/cliente360/FechamentoResumo.jsx";
import ComparacaoMensal from "../components/cliente360/ComparacaoMensal.jsx";
import AdsFechamento from "../components/cliente360/AdsFechamento.jsx";
import PonteResultado from "../components/cliente360/PonteResultado.jsx";
import ProdutosImpacto from "../components/cliente360/ProdutosImpacto.jsx";
import ProdutosNegativos from "../components/cliente360/ProdutosNegativos.jsx";
import ProdutosAbaixoMeta from "../components/cliente360/ProdutosAbaixoMeta.jsx";
import OportunidadesRecuperacao from "../components/cliente360/OportunidadesRecuperacao.jsx";
import SimuladorResultado from "../components/cliente360/SimuladorResultado.jsx";
import ConfiancaDados from "../components/cliente360/ConfiancaDados.jsx";
import PlacarConsultor from "../components/cliente360/PlacarConsultor.jsx";
import ErrorState from "../components/cliente360/ErrorState.jsx";
import { VFEmpty, VFLoading } from "../components/ui/VFEstados/index.js";

const NIVEL_CONFIANCA = {
  confiavel: { classe: "is-success", label: "Dados confiáveis" },
  parcial: { classe: "is-warning", label: "Confiança parcial" },
  insuficiente: { classe: "is-danger", label: "Confiança insuficiente" },
};

export default function Cliente360Page() {
  const { filtros, atualizarFiltro, recarregar, clientes, clientesCarregando, dados, carregando, erro, ehAdmin } =
    useCliente360();

  const semFechamento = dados?.estado?.chave === "sem_fechamento";
  const confiancaNivel = dados ? NIVEL_CONFIANCA[dados.confianca.nivel] : null;

  return (
    <div className="vf-page-shell">
      <div className="vf-page-container vf-page-container--wide c360">
        <Cliente360Header
          cliente={dados?.cliente}
          periodo={dados?.periodo}
          comparacao={dados?.comparacao}
        />

        <Cliente360Filters
          filtros={filtros}
          clientes={clientes}
          clientesCarregando={clientesCarregando}
          carregando={carregando}
          onAtualizar={atualizarFiltro}
          onRecarregar={recarregar}
        />

        {erro && <ErrorState erro={erro} onTentarNovamente={recarregar} />}

        {!erro && carregando && !dados && <VFLoading label="Carregando fechamento…" />}

        {!erro && !carregando && !filtros.slug && (
          <VFEmpty title="Escolha um cliente">
            Selecione um cliente no filtro acima para carregar o fechamento.
          </VFEmpty>
        )}

        {!erro && dados && (
          <>
            {/* 3. Status de confiança, curto, no topo */}
            {confiancaNivel && (
              <p className={`vf-status ${confiancaNivel.classe} c360-status-confianca`}>
                {confiancaNivel.label}
                {dados.confianca.nivel !== "confiavel" && dados.confianca.alertas?.[0]
                  ? ` — ${dados.confianca.alertas[0].mensagem}`
                  : ""}
              </p>
            )}

            {dados.estado && dados.estado.chave !== "ok" && (
              <div className={`vf-banner ${dados.estado.bloqueante ? "is-danger" : "is-warning"}`}>
                <div className="vf-banner__content">
                  <p className="vf-banner__title">
                    {semFechamento ? "Competência sem fechamento" : "Atenção"}
                  </p>
                  <p className="vf-banner__description">{dados.estado.mensagem}</p>
                </div>
                <div className="vf-banner__actions">
                  <a className="vf-btn vf-btn--secondary vf-btn--sm" href="financeiro-v3.html">
                    Abrir Fechamento — API
                  </a>
                </div>
              </div>
            )}

            {!semFechamento && (
              <>
                {dados.narrativa?.texto && <p className="c360-narrativa">{dados.narrativa.texto}</p>}

                <FechamentoResumo fechamento={dados.fechamento} ads={dados.ads} />

                <ComparacaoMensal
                  fechamento={dados.fechamento}
                  periodo={dados.periodo}
                  comparacao={dados.comparacao}
                />

                <AdsFechamento
                  ads={dados.ads}
                  periodo={dados.periodo}
                  comparacao={dados.comparacao}
                />

                <PonteResultado
                  ponte={dados.ponte}
                  confianca={dados.confianca}
                  periodo={dados.periodo}
                  comparacao={dados.comparacao}
                />

                <ProdutosImpacto
                  titulo="Produtos que mais ajudaram"
                  descricao="Maiores contribuições positivas para o resultado operacional do período."
                  itens={dados.produtos.ajudaram}
                  vazioTitulo="Nenhum produto puxou o resultado para cima"
                  vazioDescricao="Nenhum item teve contribuição positiva material nesta comparação."
                />

                <ProdutosImpacto
                  titulo="Produtos que mais prejudicaram"
                  descricao="Maiores contribuições negativas para o resultado operacional do período."
                  itens={dados.produtos.prejudicaram}
                  vazioTitulo="Nenhum produto derrubou o resultado"
                  vazioDescricao="Nenhum item teve contribuição negativa material nesta comparação."
                />

                <ProdutosNegativos itens={dados.produtos.noVermelho} />

                <ProdutosAbaixoMeta
                  itens={dados.produtos.abaixoDaMargem}
                  margemAlvo={dados.thresholds?.margemAlvo}
                />

                <OportunidadesRecuperacao oportunidades={dados.oportunidades} />

                {dados.simulacao && (
                  <SimuladorResultado
                    simulacao={dados.simulacao}
                    slug={filtros.slug}
                    competencia={dados.periodo.competencia}
                    marketplace={filtros.marketplace}
                  />
                )}

                <ConfiancaDados confianca={dados.confianca} fechamento={dados.fechamento} />

                {ehAdmin && dados.placar?.disponivel && (
                  <PlacarConsultor slug={filtros.slug} marketplace={filtros.marketplace} />
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
