import { useMemo } from "react";
import { useCentralExecutiva } from "../hooks/useCentralExecutiva.js";
import { formatarMoeda, formatarMoedaCompacta, formatarVariacaoMoeda } from "../utils/currency.js";
import { formatarPercentual, formatarPontosPercentuais } from "../utils/percentage.js";

const STATUS = {
  critico: { label: "Crítico", classe: "is-danger" },
  atencao: { label: "Atenção", classe: "is-warning" },
  saudavel: { label: "Saudável", classe: "is-success" },
  sem_dados: { label: "Sem leitura", classe: "is-neutral" },
};

function Kpi({ label, value, trend, state, featured = false, note }) {
  const classeEstado = state ? ` vf-kpi--${state}` : "";
  return (
    <div className={`vf-kpi${featured ? " vf-kpi--featured" : ""}${classeEstado}`}>
      <span className="vf-kpi__label">{label}</span>
      <span className="vf-kpi__value vf-kpi__value--currency">{value}</span>
      {trend && <span className={`vf-kpi__trend ${state ? `is-${state}` : ""}`}>{trend}</span>}
      {note && <span className="vf-kpi__foot">{note}</span>}
    </div>
  );
}

function StatusConta({ status }) {
  const config = STATUS[status] || STATUS.sem_dados;
  return <span className={`vf-status ${config.classe}`}>{config.label}</span>;
}

function Confianca({ nivel }) {
  const config = nivel === "confiavel"
    ? { classe: "is-success", label: "Confiável" }
    : nivel === "parcial"
      ? { classe: "is-warning", label: "Parcial" }
      : { classe: "is-danger", label: "Insuficiente" };
  return <span className={`vf-status ${config.classe}`}>{config.label}</span>;
}

function MovimentoCarteira({ resumo }) {
  const itens = [
    { label: "Melhoraram", valor: resumo?.melhoraram || 0, classe: "is-success" },
    { label: "Pioraram", valor: resumo?.pioraram || 0, classe: "is-danger" },
    { label: "Estáveis", valor: resumo?.estaveis || 0, classe: "is-neutral" },
    { label: "Sem leitura", valor: resumo?.semDados || 0, classe: "is-warning" },
  ];

  return (
    <section className="vf-section ce-movimento" aria-labelledby="ce-movimento-titulo">
      <div className="vf-section__header">
        <div>
          <h2 className="vf-section__title" id="ce-movimento-titulo">Movimento da carteira</h2>
          <p className="vf-section__description">Quantas contas melhoraram, pioraram ou ficaram sem leitura confiável.</p>
        </div>
      </div>
      <div className="ce-movimento__grid">
        {itens.map((item) => (
          <div className="ce-movimento__item" key={item.label}>
            <span className={`vf-status ${item.classe}`}>{item.label}</span>
            <strong className="num">{item.valor}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

function CausasCarteira({ causas }) {
  if (!causas.length) return null;

  return (
    <section className="vf-section" aria-labelledby="ce-causas-titulo">
      <div className="vf-section__header">
        <div>
          <h2 className="vf-section__title" id="ce-causas-titulo">O que mais pressionou o resultado</h2>
          <p className="vf-section__description">Causas negativas consolidadas pela ponte operacional das contas.</p>
        </div>
      </div>
      <div className="ce-causas">
        {causas.slice(0, 4).map((causa, indice) => (
          <article className="vf-card vf-card--compact ce-causa-card" key={causa.chave}>
            <div className="ce-causa-card__rank num">{String(indice + 1).padStart(2, "0")}</div>
            <div>
              <h3 className="ce-causa-card__title">{causa.titulo}</h3>
              <p className="ce-causa-card__meta">{causa.contas} conta{causa.contas === 1 ? "" : "s"} afetada{causa.contas === 1 ? "" : "s"}</p>
              <div className="ce-causa-card__clientes">
                {(causa.clientes || []).slice(0, 3).map((cliente) => (
                  <a key={cliente.slug} href={`cliente-360-react.html?slug=${encodeURIComponent(cliente.slug)}`}>
                    {cliente.nome}
                  </a>
                ))}
              </div>
            </div>
            <strong className="num is-negative">{formatarVariacaoMoeda(causa.impacto)}</strong>
          </article>
        ))}
      </div>
    </section>
  );
}

export default function CentralExecutivaPage() {
  const {
    filtros,
    atualizarFiltro,
    resumo,
    narrativa,
    causas,
    contasFiltradas,
    carregando,
    erro,
    recarregar,
  } = useCentralExecutiva();

  const coberturaLabel = useMemo(() => {
    if (!resumo) return "—";
    return formatarPercentual(resumo.coberturaContas);
  }, [resumo]);

  return (
    <div className="vf-page-shell">
      <div className="vf-page-container vf-page-container--wide ce">
        <header className="vf-page-header">
          <div className="vf-page-header__main">
            <p className="vf-page-header__eyebrow">Gestão da carteira</p>
            <h1 className="vf-page-header__title">Central Executiva de Contas</h1>
            <p className="vf-page-header__description">
              Prioridade, impacto, causa, confiança e acompanhamento das ações de todas as contas.
            </p>
          </div>
          <div className="vf-page-header__actions">
            <button
              className={`vf-btn vf-btn--secondary vf-btn--sm${carregando ? " is-loading" : ""}`}
              type="button"
              onClick={recarregar}
              disabled={carregando}
            >
              Atualizar carteira
            </button>
          </div>
        </header>

        <section className="vf-card vf-card--compact ce-filtros" aria-label="Filtros da carteira">
          <div className="ce-filtros__grid">
            <label className="vf-field">
              <span className="vf-field__label">Competência</span>
              <input
                className="vf-input vf-input--sm"
                type="month"
                value={filtros.competencia}
                onChange={(e) => atualizarFiltro({ competencia: e.target.value, compararCom: "" })}
              />
            </label>
            <label className="vf-field">
              <span className="vf-field__label">Comparar com</span>
              <input
                className="vf-input vf-input--sm"
                type="month"
                value={filtros.compararCom}
                onChange={(e) => atualizarFiltro({ compararCom: e.target.value })}
              />
            </label>
            <label className="vf-field">
              <span className="vf-field__label">Buscar conta ou causa</span>
              <input
                className="vf-input vf-input--sm vf-search"
                value={filtros.busca}
                onChange={(e) => atualizarFiltro({ busca: e.target.value })}
                placeholder="Nome, slug ou causa"
              />
            </label>
            <label className="vf-field">
              <span className="vf-field__label">Situação</span>
              <select
                className="vf-select vf-select--sm"
                value={filtros.status}
                onChange={(e) => atualizarFiltro({ status: e.target.value })}
              >
                <option value="todos">Todas</option>
                <option value="critico">Críticas</option>
                <option value="atencao">Em atenção</option>
                <option value="saudavel">Saudáveis</option>
                <option value="sem_dados">Sem leitura</option>
              </select>
            </label>
          </div>
        </section>

        {erro && (
          <div className="vf-banner is-danger" role="alert">
            <div className="vf-banner__content">
              <p className="vf-banner__title">Não foi possível carregar a carteira</p>
              <p className="vf-banner__description">{erro.mensagem}</p>
            </div>
            <div className="vf-banner__actions">
              <button className="vf-btn vf-btn--secondary vf-btn--sm" type="button" onClick={recarregar}>
                Tentar novamente
              </button>
            </div>
          </div>
        )}

        {carregando && !resumo && (
          <div className="vf-loading-state ce-loading" role="status">
            <span className="vf-spinner" aria-hidden="true" />
            <p>Consolidando fechamentos e prioridades da carteira…</p>
          </div>
        )}

        {resumo && (
          <>
            <section className="vf-kpi-grid ce-kpis" aria-label="Resumo executivo">
              <Kpi
                label="Faturamento da carteira"
                value={formatarMoedaCompacta(resumo.faturamento)}
                note={`${resumo.contasComLeitura}/${resumo.totalContas} contas com leitura`}
                featured
              />
              <Kpi
                label="Resultado operacional"
                value={formatarMoedaCompacta(resumo.resultadoOperacional)}
                trend={formatarVariacaoMoeda(resumo.deltaResultadoLiquido)}
                state={resumo.deltaResultadoLiquido < 0 ? "danger" : "success"}
              />
              <Kpi
                label="Resultado após Ads"
                value={formatarMoedaCompacta(resumo.resultadoAposAds)}
                note="Ads só entra após o operacional"
              />
              <Kpi
                label="Contas críticas"
                value={String(resumo.criticas)}
                trend={`${resumo.atencao} em atenção`}
                state={resumo.criticas ? "danger" : resumo.atencao ? "warning" : "success"}
              />
              <Kpi
                label="Potencial de recuperação"
                value={formatarMoedaCompacta(resumo.potencialRecuperacao)}
                note="Estimativa operacional comprovável"
              />
              <Kpi
                label="Cobertura da carteira"
                value={coberturaLabel}
                trend={`${formatarMoedaCompacta(resumo.receitaBloqueada)} sem confiança`}
                state={resumo.semDados ? "warning" : "success"}
              />
            </section>

            <div className="ce-narrativa" role="status">
              <span className="ce-narrativa__label">Leitura executiva</span>
              <p>{narrativa}</p>
            </div>

            <div className="ce-grid-apoio">
              <MovimentoCarteira resumo={resumo} />
              <section className="vf-section ce-controle" aria-labelledby="ce-controle-titulo">
                <div className="vf-section__header">
                  <div>
                    <h2 className="vf-section__title" id="ce-controle-titulo">Controle das ações</h2>
                    <p className="vf-section__description">Registros operacionais já vinculados às contas no período.</p>
                  </div>
                </div>
                <div className="ce-controle__grid">
                  <div><span>Ações registradas</span><strong className="num">{resumo.acoesRegistradas}</strong></div>
                  <div><span>Crédito apurado</span><strong className="num">{formatarMoeda(resumo.creditoApurado)}</strong></div>
                  <div><span>Produtos no vermelho</span><strong className="num">{resumo.produtosNegativos}</strong></div>
                  <div><span>Curva A em risco</span><strong className="num">{resumo.produtosCurvaAEmRisco}</strong></div>
                </div>
              </section>
            </div>

            <CausasCarteira causas={causas} />

            <section className="vf-section">
              <div className="vf-section__header">
                <div>
                  <h2 className="vf-section__title">Contas que exigem acompanhamento</h2>
                  <p className="vf-section__description">
                    Ordenadas pelo backend por gravidade, perda financeira, recuperação e receita sem confiança.
                  </p>
                </div>
                <span className="vf-status is-neutral">{contasFiltradas.length} contas</span>
              </div>

              <div className="vf-table-wrap">
                <table className="vf-table vf-table--compact ce-table">
                  <thead>
                    <tr>
                      <th>Conta</th>
                      <th>Situação</th>
                      <th className="num">Faturamento</th>
                      <th className="num">Resultado</th>
                      <th className="num">Margem</th>
                      <th className="num">Variação</th>
                      <th>O que aconteceu</th>
                      <th>Acompanhamento</th>
                      <th>Confiança</th>
                      <th aria-label="Ação" />
                    </tr>
                  </thead>
                  <tbody>
                    {!contasFiltradas.length && !carregando && (
                      <tr>
                        <td colSpan="10">
                          <div className="vf-empty-state">
                            <h3 className="vf-empty-state__title">Nenhuma conta encontrada</h3>
                            <p className="vf-empty-state__description">Ajuste os filtros para ampliar a leitura.</p>
                          </div>
                        </td>
                      </tr>
                    )}
                    {contasFiltradas.map((conta) => (
                      <tr
                        key={conta.cliente.slug}
                        className={conta.status === "critico" ? "is-danger" : conta.status === "atencao" ? "is-warning" : ""}
                      >
                        <td>
                          <strong>{conta.cliente.nome}</strong>
                          <span className="ce-table__slug vf-mono">{conta.cliente.slug}</span>
                        </td>
                        <td>
                          <StatusConta status={conta.status} />
                          <span className="ce-table__meta">{conta.motivosStatus?.[0] || "Sem motivo informado"}</span>
                        </td>
                        <td className="num">{formatarMoeda(conta.faturamento)}</td>
                        <td className="num">{formatarMoeda(conta.resultadoOperacional)}</td>
                        <td className="num">{formatarPercentual(conta.margemOperacional)}</td>
                        <td className={`num ${conta.deltaResultado < 0 ? "is-negative" : conta.deltaResultado > 0 ? "is-positive" : ""}`}>
                          <strong>{formatarVariacaoMoeda(conta.deltaResultado)}</strong>
                          <span className="ce-table__meta">{formatarPontosPercentuais(conta.deltaMargemPp)}</span>
                        </td>
                        <td>
                          <strong className="ce-causa">{conta.causa?.titulo || "Sem causa material identificada"}</strong>
                          <span className="ce-table__meta">
                            {conta.causa?.impacto != null
                              ? `${formatarVariacaoMoeda(conta.causa.impacto)} de impacto principal`
                              : conta.narrativa || "Abra a Cliente 360 para investigar."}
                          </span>
                        </td>
                        <td>
                          {conta.acoes?.ultima ? (
                            <>
                              <strong className="ce-causa">{conta.acoes.ultima.titulo || conta.acoes.ultima.tipo}</strong>
                              <span className="ce-table__meta">
                                {conta.acoes.noPeriodo} no período
                                {conta.acoes.ultima.autor ? ` · ${conta.acoes.ultima.autor}` : ""}
                              </span>
                            </>
                          ) : (
                            <span className="ce-table__meta">Nenhuma ação registrada</span>
                          )}
                        </td>
                        <td><Confianca nivel={conta.confianca} /></td>
                        <td>
                          <a className="vf-btn vf-btn--ghost vf-btn--sm" href={conta.href}>
                            Abrir 360
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
