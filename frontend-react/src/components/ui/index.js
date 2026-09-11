// Camada React de componentes primitivos globais.
//
// Todo componente aqui usa só tokens da Fundação Global V2
// (Portal/css/vf-tokens-v2.css) — nenhum token novo, nenhuma cor/raio/espaço
// inventado. A maioria (ex.: VFButton) é um wrapper fino sobre classes que já
// existem em Portal/css/vf-components-v2.css. Quando o padrão visual ainda
// não existe na Fundação (ex.: VFMonthYearSelector), o componente traz seu
// próprio CSS, sempre construído só com var(--vf-*).

export { VFButton } from "./VFButton/index.js";
export { VFMonthYearSelector } from "./VFMonthYearSelector/index.js";
