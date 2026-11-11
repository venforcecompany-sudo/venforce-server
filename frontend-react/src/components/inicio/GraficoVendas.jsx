// frontend-react/src/components/inicio/GraficoVendas.jsx
// Faturamento por dia (barras) e lucro (linha) no mesmo eixo em reais — porte
// do gráfico do Início do Lucratto. Barra e linha se distinguem pela forma e
// pela legenda, não só pela cor; o lucro só soma as vendas com lucro
// calculado. Ponteiro ou setas mostram o dia; os mesmos números estão na
// tabela abaixo do gráfico.

import { useEffect, useId, useRef, useState } from "react";
import { diaCompleto, diaCurto, escalaRedonda, reais, reaisCompacto } from "./formato.js";

const ALTURA = 260;
const MARGEM = { topo: 12, direita: 8, base: 28, esquerda: 64 };
const LARGURA_PADRAO = 720;

// Largura real do contêiner: o desenho refaz as contas nela para o texto
// nunca encolher no celular.
function useLargura(ref) {
  const [largura, setLargura] = useState(LARGURA_PADRAO);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const medir = () => { if (el.clientWidth > 0) setLargura(el.clientWidth); };
    medir();
    const observador = new ResizeObserver(medir);
    observador.observe(el);
    return () => observador.disconnect();
  }, [ref]);
  return largura;
}

export function GraficoVendas({ serie }) {
  const id = useId();
  const caixa = useRef(null);
  const largura = useLargura(caixa);
  const [ativo, setAtivo] = useState(null);

  const area = { w: Math.max(120, largura - MARGEM.esquerda - MARGEM.direita), h: ALTURA - MARGEM.topo - MARGEM.base };
  const valores = serie.flatMap((p) => [p.faturamento, p.lucro]);
  const escala = escalaRedonda(Math.min(0, ...valores), Math.max(0, ...valores));
  const y = (v) => MARGEM.topo + area.h * (1 - (v - escala.min) / (escala.max - escala.min));
  const passo = area.w / Math.max(1, serie.length);
  const x = (i) => MARGEM.esquerda + passo * (i + 0.5);
  const larguraBarra = Math.max(2, Math.min(28, passo * 0.68));
  const zero = y(0);
  const anoRef = serie[serie.length - 1]?.dia.slice(0, 4);
  const cadaN = Math.max(1, Math.ceil(serie.length / Math.max(2, Math.floor(area.w / 56))));
  const comMarcas = serie.length <= 31;
  const linha = serie.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(p.lucro).toFixed(1)}`).join(" ");

  function noPonteiro(e) {
    const caixaSvg = e.currentTarget.getBoundingClientRect();
    const i = Math.floor((e.clientX - caixaSvg.left) / (caixaSvg.width / serie.length));
    setAtivo(Math.min(serie.length - 1, Math.max(0, i)));
  }
  function noTeclado(e) {
    if (e.key === "Escape") return setAtivo(null);
    const delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!delta) return undefined;
    e.preventDefault();
    setAtivo((a) => Math.min(serie.length - 1, Math.max(0, (a ?? (delta > 0 ? -1 : serie.length)) + delta)));
    return undefined;
  }

  const p = ativo === null ? null : serie[ativo];
  const total = serie.reduce((s, d) => s + d.faturamento, 0);
  const resumo = `Faturamento por dia e lucro, de ${diaCompleto(serie[0]?.dia ?? "")} a ${diaCompleto(serie[serie.length - 1]?.dia ?? "")}. Total vendido: ${reais(total)}. Use as setas para ler cada dia.`;

  return (
    <figure className="vf-inicio-grafico">
      <figcaption className="vf-inicio-grafico__legenda">
        <span><i className="vf-inicio-grafico__chave vf-inicio-grafico__chave--barra" aria-hidden="true" />Faturamento</span>
        <span><i className="vf-inicio-grafico__chave vf-inicio-grafico__chave--linha" aria-hidden="true" />Lucro</span>
      </figcaption>
      <div
        ref={caixa}
        className="vf-inicio-grafico__caixa"
        tabIndex={0}
        role="group"
        aria-label={resumo}
        aria-describedby={`${id}-dia`}
        onKeyDown={noTeclado}
        onBlur={() => setAtivo(null)}
        onPointerLeave={() => setAtivo(null)}
      >
        <svg width={largura} height={ALTURA} viewBox={`0 0 ${largura} ${ALTURA}`} role="presentation" focusable="false">
          {escala.ticks.map((t) => (
            <g key={t}>
              <line className={t === 0 ? "vf-inicio-grafico__base" : "vf-inicio-grafico__grade"} x1={MARGEM.esquerda} x2={largura - MARGEM.direita} y1={y(t)} y2={y(t)} />
              <text className="vf-inicio-grafico__eixo" x={MARGEM.esquerda - 8} y={y(t)} textAnchor="end" dominantBaseline="middle">{reaisCompacto(t)}</text>
            </g>
          ))}
          {serie.map((d, i) => {
            if (!(d.faturamento > 0)) return null;
            const topo = y(d.faturamento);
            return (
              <rect key={d.dia} className={`vf-inicio-grafico__barra${ativo === i ? " vf-inicio-grafico__barra--ativa" : ""}`} x={x(i) - larguraBarra / 2} y={topo}
                width={larguraBarra} height={Math.max(1, zero - topo)} rx={Math.min(4, larguraBarra / 2)} />
            );
          })}
          {serie.map((d, i) => i % cadaN === 0 && (
            <text key={d.dia} className="vf-inicio-grafico__eixo" x={x(i)} y={ALTURA - 8} textAnchor="middle">{diaCurto(d.dia, anoRef)}</text>
          ))}
          {serie.length > 1 && <path className="vf-inicio-grafico__linha" d={linha} />}
          {comMarcas && serie.map((d, i) => <circle key={d.dia} className="vf-inicio-grafico__marca" cx={x(i)} cy={y(d.lucro)} r={ativo === i ? 5 : 3.5} />)}
          {p && <line className="vf-inicio-grafico__guia" x1={x(ativo)} x2={x(ativo)} y1={MARGEM.topo} y2={MARGEM.topo + area.h} />}
          <rect x={MARGEM.esquerda} y={0} width={area.w} height={ALTURA} fill="transparent" onPointerMove={noPonteiro} onPointerDown={noPonteiro} />
        </svg>
        {p && (
          <div className="vf-inicio-grafico__dica" style={{ left: Math.min(Math.max(x(ativo), 90), largura - 90) }}>
            <strong>{diaCompleto(p.dia)}</strong>
            <span><i className="vf-inicio-grafico__chave vf-inicio-grafico__chave--barra" aria-hidden="true" />Faturamento <b className="vf-inicio-num">{reais(p.faturamento)}</b></span>
            <span><i className="vf-inicio-grafico__chave vf-inicio-grafico__chave--linha" aria-hidden="true" />Lucro <b className="vf-inicio-num">{reais(p.lucro)}</b></span>
            <small>{p.vendas === 1 ? "1 venda" : `${p.vendas} vendas`}</small>
          </div>
        )}
        <p id={`${id}-dia`} className="vf-inicio-oculto" aria-live="polite">
          {p ? `${diaCompleto(p.dia)}: faturamento ${reais(p.faturamento)}, lucro ${reais(p.lucro)}, ${p.vendas} vendas.` : ""}
        </p>
      </div>
      <details className="vf-inicio-grafico__tabela">
        <summary>Ver os dados do gráfico em tabela</summary>
        <div className="vf-inicio-grafico__rolagem">
          <table aria-label="Faturamento e lucro por dia">
            <thead><tr><th scope="col">Dia</th><th scope="col">Vendas</th><th scope="col">Faturamento</th><th scope="col">Lucro</th></tr></thead>
            <tbody>
              {serie.filter((d) => d.vendas > 0).map((d) => (
                <tr key={d.dia}><th scope="row">{diaCompleto(d.dia)}</th><td className="vf-inicio-num">{d.vendas}</td><td className="vf-inicio-num">{reais(d.faturamento)}</td><td className="vf-inicio-num">{reais(d.lucro)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
