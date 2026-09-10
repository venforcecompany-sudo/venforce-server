// cx — composição mínima de classes CSS condicionais.
//
// Substitui o padrão `"a" + (cond ? " b" : "")` espalhado pelos componentes.
// NÃO é uma dependência externa (classnames/clsx): é uma função de ~5 linhas.
//
//   cx("vf-btn", "vf-btn--primary", grande && "vf-btn--lg")
//   // => "vf-btn vf-btn--primary vf-btn--lg"  (ou sem --lg se `grande` for falsy)
//
// Regras:
//   - valores falsy (false, null, undefined, "") são ignorados;
//   - espaços extras entre tokens são colapsados em um só.

export function cx(...classes) {
  return classes
    .filter(Boolean)
    .join(" ")
    .trim()
    .replace(/\s+/g, " ");
}
