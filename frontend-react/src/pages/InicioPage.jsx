// frontend-react/src/pages/InicioPage.jsx
//
// Início do Portal (substitui a Visão): cópia da tela de Início do Lucratto
// 360 sobre o Shell V3 — nasce de Cliente+Operação escolhidos no Shell
// (vf-context), sem seletor próprio de contexto.
//
// Ordem, como no Lucratto:
//   período (Hoje · 7 · 30 · 90 dias)
//   Faturamento · Lucro · Margem · Ticket médio (com variação)
//   Precisa de atenção | Saúde da conta
//   Saúde do catálogo  | MercadoLíder
//   Faturamento e lucro por dia
//   Os que mais lucraram | Os que mais perdem
// E os dois blocos que a Visão já tinha e continuam:
//   Ads | Configuração da operação (checklist)
//
// Tudo vem de um request só (GET /operacao/inicio/:cliente); cada bloco tem
// envelope próprio e a falha de um não derruba os outros.

import { useOperacaoAtual } from "../hooks/useVfContext.js";
import { PERIODOS, useInicio } from "../hooks/useInicio.js";
import { BlocoCard, BlocoIndisponivel, BlocoSkeleton } from "../components/visao/BlocoCard.jsx";
import { AdsBloco } from "../components/visao/AdsBloco.jsx";
import { SaudeOperacional } from "../components/visao/SaudeOperacional.jsx";
import { Cartoes } from "../components/inicio/Cartoes.jsx";
import { GraficoVendas } from "../components/inicio/GraficoVendas.jsx";
import { MercadoLider, SaudeConta } from "../components/inicio/Reputacao.jsx";
import { Atencao, itensDeAtencao, Ranking, SaudeCatalogo } from "../components/inicio/Blocos.jsx";
import { diaCurto, horario } from "../components/inicio/formato.js";

function Bloco({ envelope, render, ...props }) {
  if (!envelope) return null;
  return (
    <BlocoCard {...props}>
      {envelope.disponivel ? render(envelope.dados) : <BlocoIndisponivel motivo={envelope.motivo} />}
    </BlocoCard>
  );
}

function Carregando() {
  return (
    <div className="vf-inicio-esqueleto" aria-busy="true" aria-label="Carregando o Início">
      <section className="vf-inicio-bloco"><BlocoSkeleton linhas={2} /></section>
      {Array.from({ length: 2 }).map((_, i) => (
        <div key={i} className="vf-inicio-duo">
          <section className="vf-inicio-bloco"><BlocoSkeleton linhas={4} /></section>
          <section className="vf-inicio-bloco"><BlocoSkeleton linhas={4} /></section>
        </div>
      ))}
    </div>
  );
}

export default function InicioPage() {
  const { pronta, clienteSlug, clienteContaId } = useOperacaoAtual();
  const { periodo, setPeriodo, dados, carregando, erro } = useInicio({ clienteSlug, clienteContaId, pronta });

  // Contexto incompleto: o Shell (data-vf-scope="account") já esconde a
  // página e mostra o próprio estado.
  if (!pronta) return null;

  const cliente = encodeURIComponent(clienteSlug);
  const conta = encodeURIComponent(clienteContaId);
  const links = {
    vendas: `financeiro-v3.html?cliente=${cliente}&conta=${conta}`,
    margem: `central-margem.html?cliente=${cliente}`,
    bases: "bases.html",
    ads: `anuncios-meli.html?cliente=${cliente}`,
    configuracao: `cliente-360-react.html?slug=${cliente}`,
  };

  const vendas = dados?.vendas?.disponivel ? dados.vendas.dados : null;
  const catalogo = dados?.catalogo?.disponivel ? dados.catalogo.dados : null;
  const reputacao = dados?.reputacao?.disponivel ? dados.reputacao.dados : null;
  const configuracao = dados?.configuracao?.disponivel ? dados.configuracao.dados : null;
  const t = vendas?.totais;
  const semVendas = t && t.vendas === 0 && t.canceladas === 0;
  const umDia = dados?.periodo?.de === dados?.periodo?.ate;
  const prejuizos = catalogo?.porStatus?.prejuizo ?? 0;
  // O sync diário cobre até ontem: os períodos terminam no último dia com
  // pedidos sincronizados, e a tela diz qual é.
  const dadosAte = vendas?.dadosAte && dados?.periodo?.hoje && vendas.dadosAte < dados.periodo.hoje ? vendas.dadosAte : null;
  const hojePendente = !!vendas?.hojePendente;

  return (
    <div className="vf-page-shell">
      <div className="vf-page-container vf-inicio">
        <header className="vf-page-header">
          <div className="vf-page-header__main">
            <p className="vf-page-header__eyebrow">Início</p>
            <h1 className="vf-page-header__title">Como está a loja</h1>
          </div>
          <div className="vf-page-header__actions vf-inicio-topo">
            {vendas?.atualizadoEm && (
              <span className="vf-field__hint">
                {dadosAte ? `Vendas até ${diaCurto(dadosAte)} · sincronizadas em ${horario(vendas.atualizadoEm)}` : `Vendas atualizadas em ${horario(vendas.atualizadoEm)}`}
              </span>
            )}
            <div className="vf-inicio-atalhos" role="group" aria-label="Período">
              {PERIODOS.map((p) => (
                <button key={p.id} type="button" className="vf-inicio-atalho" aria-pressed={periodo === p.id} onClick={() => setPeriodo(p.id)}>
                  {p.rotulo}
                </button>
              ))}
            </div>
          </div>
        </header>

        {erro && !dados && (
          <div className="vf-banner is-danger" role="alert">
            <div className="vf-banner__content">
              <p className="vf-banner__title">Não foi possível carregar o Início</p>
              <p className="vf-banner__description">{erro.mensagem}</p>
            </div>
          </div>
        )}

        {!dados && carregando && <Carregando />}

        {dados && (
          <div className={`vf-inicio-corpo${carregando ? " is-atualizando" : ""}`}>
            {hojePendente ? (
              <p className="vf-inicio-vazio" role="status">
                Os pedidos de hoje ainda não foram sincronizados — as vendas vão até {diaCurto(vendas.dadosAte)}.{" "}
                <a href={links.vendas}>Sincronize no Financeiro</a> para ver o dia de hoje.
              </p>
            ) : vendas && t ? (
              <Cartoes totais={t} anterior={vendas.anterior} />
            ) : (
              <section className="vf-inicio-bloco"><BlocoIndisponivel motivo={dados.vendas?.motivo} /></section>
            )}

            <div className="vf-inicio-duo vf-inicio-duo--cheio">
              <Atencao itens={itensDeAtencao({ vendas, catalogo, reputacao, configuracao, links })} />
              <SaudeConta envelope={dados.reputacao} vendasHref={links.vendas} />
            </div>

            <div className="vf-inicio-duo vf-inicio-duo--cheio">
              <SaudeCatalogo envelope={dados.catalogo} href={links.margem} />
              <MercadoLider envelope={dados.reputacao} janela={vendas?.sincronizado ? vendas.lider : null} metas={dados.metasMercadoLider} limites={dados.limitesMercadoLider} />
            </div>

            {vendas && !hojePendente && (semVendas ? (
              <p className="vf-inicio-vazio">
                Nenhuma venda {periodo === "hoje" ? "hoje" : "neste período"}. <a href={links.vendas}>Sincronize as vendas</a> no Financeiro para trazer os pedidos do Mercado Livre.
              </p>
            ) : umDia ? null : (
              <section className="vf-inicio-bloco" aria-labelledby="inicio-grafico">
                <h2 id="inicio-grafico" className="vf-inicio-bloco__titulo">Faturamento e lucro por dia</h2>
                <GraficoVendas serie={vendas.serie} />
              </section>
            ))}

            {vendas && !hojePendente && (
              <div className="vf-inicio-duo">
                <Ranking id="inicio-lucraram" titulo="Os que mais lucraram" itens={vendas.lucraram} tom="positivo"
                  vazio="Nenhuma venda com lucro calculado neste período." ver={{ href: links.vendas, rotulo: "Ver vendas" }} />
                <Ranking id="inicio-perdem" titulo="Os que mais perdem dinheiro" itens={vendas.perdem} tom="negativo"
                  vazio="Nenhum produto vendeu com prejuízo neste período."
                  ver={{ href: links.margem, rotulo: prejuizos > 0 ? `Ver os ${prejuizos}` : "Ver anúncios" }} />
              </div>
            )}

            <div className="vf-inicio-duo vf-inicio-duo--legado">
              <Bloco envelope={dados.ads} titulo="Ads" linkHref={links.ads} linkLabel="Ver detalhes"
                render={(d) => <AdsBloco dados={d} conectarHref={links.ads} />} />
              <Bloco envelope={dados.configuracao} titulo="Configuração da operação" linkHref={links.configuracao} linkLabel="Ver detalhes"
                render={(d) => <SaudeOperacional dados={d} />} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
