// frontend-react/src/components/financeiro/snapshot/ProdutosSnapshot.jsx
//
// Produtos de uma REVISÃO salva — TODAS as linhas do motor (não a amostra de
// 50 da entrega), paginadas, filtradas e buscadas NO BACKEND
// (GET /fechamento-snapshots/:id/itens): uma conta grande de Order.all tem
// milhares de linhas e a tela nunca baixa todas.
//
// Mesma tabela da tela ao vivo (colunas, filtros, status): o backend devolve
// a linha EXATA do motor e ela passa pelo MESMO normalizador. As contagens
// dos filtros são as gravadas no snapshot.

import { useEffect, useMemo, useRef, useState } from "react";
import { listarItensDoSnapshot } from "../../../services/fechamentoSnapshotApi.js";
import { normalizarLinhaProduto } from "../../../utils/financeiro/produtos.js";
import { STATUS_DO_FILTRO, contagemDosFiltros } from "../../../utils/financeiro/revisoes.js";
import { formatarValor } from "../shared/ValorFinanceiro.jsx";
import { COLUNAS, TAMANHOS_PAGINA } from "../produtos/ProdutosFinanceiroTable.jsx";
import { ProdutoFinanceiroStatus } from "../produtos/ProdutoFinanceiroStatus.jsx";
import { ProdutosFinanceiroFilters } from "../produtos/ProdutosFinanceiroFilters.jsx";
import { SecaoFinanceira } from "../shared/SecaoFinanceira.jsx";

// Colunas de cada formato do motor (as que o normalizador preenche). Fixas
// por formato para a tabela não "mudar de colunas" entre páginas.
const COLUNAS_DO_FORMATO = {
  meli: ["titulo", "itemId", "unidades", "receita", "custoUnitario", "custoTotal", "impostoPercentual", "repasse", "lc", "mc"],
  shopee_performance: ["titulo", "itemId", "modelId", "unidades", "receita", "custoUnitario", "impostoPercentual", "lc", "mc"],
  shopee_orderall: ["titulo", "pedidoId", "itemId", "sku", "unidades", "receita", "custoTotal", "impostoValor", "repasse", "lc", "mc"],
};

export function ProdutosSnapshot({ snapshot }) {
  const [filtro, setFiltro] = useState("todos");
  const [busca, setBusca] = useState("");
  const [buscaAplicada, setBuscaAplicada] = useState("");
  const [pagina, setPagina] = useState(0);
  const [porPagina, setPorPagina] = useState(TAMANHOS_PAGINA[0]);
  const [dados, setDados] = useState({ total: 0, itens: [] });
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState(null);
  const seqRef = useRef(0);

  const ambiguousIds = snapshot?.summary?.ambiguousCostIds;
  const contagem = useMemo(() => contagemDosFiltros(snapshot?.contagens), [snapshot]);

  // Busca com pequena espera: não dispara uma requisição por tecla.
  useEffect(() => {
    const t = setTimeout(() => setBuscaAplicada(busca.trim()), 300);
    return () => clearTimeout(t);
  }, [busca]);

  // Trocou de revisão: volta ao começo.
  useEffect(() => {
    setFiltro("todos");
    setBusca("");
    setBuscaAplicada("");
    setPagina(0);
  }, [snapshot?.id]);

  useEffect(() => {
    if (!snapshot?.id) return undefined;
    const seq = ++seqRef.current;
    const controlador = new AbortController();
    setCarregando(true);
    setErro(null);
    listarItensDoSnapshot(snapshot.id, {
      offset: pagina * porPagina,
      limit: porPagina,
      status: STATUS_DO_FILTRO[filtro],
      busca: buscaAplicada,
      signal: controlador.signal,
    })
      .then((r) => {
        if (seq !== seqRef.current) return;
        setDados({ total: r?.total ?? 0, itens: Array.isArray(r?.itens) ? r.itens : [] });
      })
      .catch((err) => {
        if (err?.name === "AbortError" || seq !== seqRef.current) return;
        setErro(err?.message || "Não foi possível carregar os produtos desta revisão.");
      })
      .finally(() => {
        if (seq === seqRef.current) setCarregando(false);
      });
    return () => controlador.abort();
  }, [snapshot?.id, pagina, porPagina, filtro, buscaAplicada]);

  const linhas = useMemo(
    () => dados.itens.map((i) => normalizarLinhaProduto(i.linha, { ambiguousIds })),
    [dados.itens, ambiguousIds]
  );
  const formato = linhas[0]?.formato;
  const colunas = useMemo(() => {
    const doFormato = COLUNAS_DO_FORMATO[formato];
    if (doFormato) return COLUNAS.filter((c) => doFormato.includes(c.id));
    return COLUNAS.filter((c) => linhas.some((l) => l[c.id] !== null && l[c.id] !== undefined && l[c.id] !== ""));
  }, [formato, linhas]);

  const total = snapshot?.totalItens ?? 0;
  const totalPaginas = Math.max(1, Math.ceil(dados.total / porPagina));

  return (
    <SecaoFinanceira
      id="produtos"
      titulo="Produtos da revisão"
      descricao={`${total.toLocaleString("pt-BR")} ${total === 1 ? "linha" : "linhas"} gravadas nesta revisão — todas, não uma amostra.`}
    >
      <div className={`vf-stack vf-stack--sm vf-fin-produtos${carregando ? " is-atualizando" : ""}`} aria-busy={carregando ? "true" : undefined}>
        <ProdutosFinanceiroFilters
          filtro={filtro}
          onFiltro={(f) => { setFiltro(f); setPagina(0); }}
          busca={busca}
          onBusca={(b) => { setBusca(b); setPagina(0); }}
          contagem={contagem}
        />
        {erro && <div className="vf-status is-danger" role="alert">{erro}</div>}
        <div className="vf-table-wrap vf-table-scroll">
          <table className="vf-table vf-table--compact" aria-label="Produtos da revisão">
            <thead>
              <tr>
                {colunas.map((c) => (
                  <th key={c.id} className={c.texto ? undefined : "is-numeric"}>{c.rotulo}</th>
                ))}
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {linhas.length === 0 ? (
                <tr>
                  <td colSpan={colunas.length + 1} className="vf-table__empty">
                    {carregando ? "Carregando…" : "Nenhum produto neste filtro."}
                  </td>
                </tr>
              ) : (
                linhas.map((l, i) => (
                  <tr key={dados.itens[i]?.ordem ?? i} data-status={l.statusPrincipal}>
                    {colunas.map((c) => (
                      <td key={c.id} className={`${c.texto ? "" : "is-numeric"}${c.mono ? " vf-mono" : ""}`.trim() || undefined}>
                        {c.id === "titulo" ? (
                          <span className="vf-fin-clamp" title={l.titulo || undefined}>{l.titulo || "—"}</span>
                        ) : c.texto ? (
                          l[c.id] || "—"
                        ) : (
                          formatarValor(l[c.id], c.tipo)
                        )}
                      </td>
                    ))}
                    <td><ProdutoFinanceiroStatus linha={l} /></td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="vf-pagination">
          <span className="vf-pagination__info">
            {dados.total.toLocaleString("pt-BR")} de {total.toLocaleString("pt-BR")} linhas
            {dados.total > 0 && ` · mostrando ${(pagina * porPagina + 1).toLocaleString("pt-BR")}–${Math.min((pagina + 1) * porPagina, dados.total).toLocaleString("pt-BR")}`}
          </span>
          <div className="vf-pagination__actions">
            <label className="vf-fin-produtos__tamanho">
              <span className="vf-field__hint">Linhas por página</span>
              <select className="vf-input vf-input--sm" aria-label="Linhas por página" value={porPagina} onChange={(e) => { setPorPagina(Number(e.target.value)); setPagina(0); }}>
                {TAMANHOS_PAGINA.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            {totalPaginas > 1 && (
              <>
                <button type="button" className="vf-btn vf-btn--ghost vf-btn--sm" disabled={pagina === 0 || carregando} onClick={() => setPagina(pagina - 1)}>Anterior</button>
                <span className="vf-field__hint">Página {pagina + 1} de {totalPaginas}</span>
                <button type="button" className="vf-btn vf-btn--ghost vf-btn--sm" disabled={pagina >= totalPaginas - 1 || carregando} onClick={() => setPagina(pagina + 1)}>Próxima</button>
              </>
            )}
          </div>
        </div>
      </div>
    </SecaoFinanceira>
  );
}
