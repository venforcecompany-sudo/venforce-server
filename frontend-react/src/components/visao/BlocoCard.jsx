// frontend-react/src/components/visao/BlocoCard.jsx
// Casca comum de todo bloco da Visão: título + link de aprofundamento
// ("Ver detalhes") para o módulo que resolve.
// "A Visão nunca é onde o trabalho acontece; é onde ele é priorizado."
//
// O redesign V3 removeu o badge de escopo ("cliente inteiro"). A limitação de
// alguns blocos ainda serem escopo-CLIENTE e não conta (Saúde, Margem) continua
// real e documentada no backend (VENFORCE_V3_BACKEND_READINESS §14) — só deixou
// de ser sinalizada na tela, por decisão de design. O envelope segue trazendo
// `escopoConta` no contrato; a Visão apenas não o exibe mais.

export function BlocoCard({ titulo, linkHref, linkLabel, className, children }) {
  return (
    <section className={"vf-section vf-visao-bloco" + (className ? " " + className : "")}>
      <header className="vf-section__header">
        <h2 className="vf-section__title">{titulo}</h2>
        {linkHref && (
          <a className="vf-btn vf-btn--ghost vf-btn--sm" href={linkHref}>
            {linkLabel} →
          </a>
        )}
      </header>
      {children}
    </section>
  );
}

export function BlocoIndisponivel({ motivo }) {
  return (
    <div className="vf-empty">
      <p className="vf-empty__description">{motivo || "Este bloco não está disponível no momento."}</p>
    </div>
  );
}

export function BlocoSkeleton({ linhas = 3 }) {
  return (
    <div className="vf-stack vf-stack--sm" aria-hidden="true">
      {Array.from({ length: linhas }).map((_, i) => (
        <div key={i} className="vf-skeleton vf-skeleton--row" />
      ))}
    </div>
  );
}
