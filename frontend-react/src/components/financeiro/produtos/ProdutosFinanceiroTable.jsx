// frontend-react/src/components/financeiro/produtos/ProdutosFinanceiroTable.jsx
//
// Tabela detalhada do processamento — as linhas COMPLETAS em memória (não a
// amostra de 50 que vai para o payload salvo). Colunas aparecem só quando o
// motor do marketplace devolve aquele dado; paginação local porque o
// Order.all pode ter milhares de linhas.

import { useMemo, useState } from "react";
import { contarPorFiltro, filtrarLinhas } from "../../../utils/financeiro/produtos.js";
import { formatarValor } from "../shared/ValorFinanceiro.jsx";
import { ProdutoFinanceiroStatus } from "./ProdutoFinanceiroStatus.jsx";
import { ProdutosFinanceiroFilters } from "./ProdutosFinanceiroFilters.jsx";

// Página de tamanho razoável: o Order.all chega a milhares de linhas e a tela
// nunca renderiza mais que isto de uma vez.
export const TAMANHOS_PAGINA = [25, 50, 100];
const POR_PAGINA_PADRAO = 25;

export const COLUNAS = [
  { id: "titulo", rotulo: "Produto", texto: true },
  { id: "pedidoId", rotulo: "Pedido", texto: true, mono: true },
  { id: "itemId", rotulo: "MLB / Item ID", texto: true, mono: true },
  { id: "sku", rotulo: "SKU", texto: true, mono: true },
  { id: "modelId", rotulo: "Model ID", texto: true, mono: true },
  { id: "unidades", rotulo: "Un.", tipo: "numero" },
  { id: "receita", rotulo: "Receita", tipo: "moeda" },
  { id: "custoUnitario", rotulo: "Custo unit.", tipo: "moeda" },
  { id: "custoTotal", rotulo: "Custo total", tipo: "moeda" },
  { id: "impostoPercentual", rotulo: "Imposto %", tipo: "pontos" },
  { id: "impostoValor", rotulo: "Imposto", tipo: "moeda" },
  { id: "repasse", rotulo: "Repasse / líquido", tipo: "moeda" },
  { id: "lc", rotulo: "LC", tipo: "moeda" },
  { id: "mc", rotulo: "MC", tipo: "pontos" },
];

export function ProdutosFinanceiroTable({ linhas }) {
  const [filtro, setFiltro] = useState("todos");
  const [busca, setBusca] = useState("");
  const [pagina, setPagina] = useState(0);
  const [porPagina, setPorPagina] = useState(POR_PAGINA_PADRAO);

  const contagem = useMemo(() => contarPorFiltro(linhas), [linhas]);
  const filtradas = useMemo(() => filtrarLinhas(linhas, { filtro, busca }), [linhas, filtro, busca]);
  // Coluna sem nenhum valor em nenhuma linha (do marketplace) não é exibida.
  const colunas = useMemo(
    () => COLUNAS.filter((c) => linhas.some((l) => l[c.id] !== null && l[c.id] !== undefined && l[c.id] !== "")),
    [linhas]
  );

  if (!linhas.length) {
    return (
      <div className="vf-empty">
        <p className="vf-empty__description">O processamento não devolveu linhas detalhadas.</p>
      </div>
    );
  }

  const totalPaginas = Math.max(1, Math.ceil(filtradas.length / porPagina));
  const paginaAtual = Math.min(pagina, totalPaginas - 1);
  const visiveis = filtradas.slice(paginaAtual * porPagina, (paginaAtual + 1) * porPagina);

  return (
    <div className="vf-stack vf-stack--sm vf-fin-produtos">
      <ProdutosFinanceiroFilters
        filtro={filtro}
        onFiltro={(f) => { setFiltro(f); setPagina(0); }}
        busca={busca}
        onBusca={(b) => { setBusca(b); setPagina(0); }}
        contagem={contagem}
      />
      <div className="vf-table-wrap vf-table-scroll">
        <table className="vf-table vf-table--compact" aria-label="Produtos do fechamento">
          <thead>
            <tr>
              {colunas.map((c) => (
                <th key={c.id} className={c.texto ? undefined : "is-numeric"}>{c.rotulo}</th>
              ))}
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {visiveis.length === 0 ? (
              <tr>
                <td colSpan={colunas.length + 1} className="vf-table__empty">Nenhum produto neste filtro.</td>
              </tr>
            ) : (
              visiveis.map((l, i) => (
                <tr key={`${paginaAtual}-${i}`} data-status={l.statusPrincipal}>
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
          {filtradas.length.toLocaleString("pt-BR")} de {linhas.length.toLocaleString("pt-BR")} linhas
          {filtradas.length > 0 && ` · mostrando ${(paginaAtual * porPagina + 1).toLocaleString("pt-BR")}–${Math.min((paginaAtual + 1) * porPagina, filtradas.length).toLocaleString("pt-BR")}`}
        </span>
        <div className="vf-pagination__actions">
          <label className="vf-fin-produtos__tamanho">
            <span className="vf-field__hint">Linhas por página</span>
            <select
              className="vf-input vf-input--sm"
              aria-label="Linhas por página"
              value={porPagina}
              onChange={(e) => { setPorPagina(Number(e.target.value)); setPagina(0); }}
            >
              {TAMANHOS_PAGINA.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          {totalPaginas > 1 && (
            <>
              <button type="button" className="vf-btn vf-btn--ghost vf-btn--sm" disabled={paginaAtual === 0} onClick={() => setPagina(paginaAtual - 1)}>
                Anterior
              </button>
              <span className="vf-field__hint">Página {paginaAtual + 1} de {totalPaginas}</span>
              <button type="button" className="vf-btn vf-btn--ghost vf-btn--sm" disabled={paginaAtual >= totalPaginas - 1} onClick={() => setPagina(paginaAtual + 1)}>
                Próxima
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
