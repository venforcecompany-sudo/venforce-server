// frontend-react/src/components/financeiro/fechamento/PreCheckFechamento.jsx
//
// "Antes de processar" — o checklist compacto (utils/financeiro/preCheck.js).
// Uma linha por item, com o nível ao lado. Não bloqueia nada por conta
// própria: o que é obrigatório já bloqueia o botão pela validação do hook;
// recomendado e aviso só informam.

const ICONE = { ok: "✓", falta: "✕", aviso: "⚠", recomendado: "○", pendente: "…" };
const NIVEL = { obrigatorio: "obrigatório", recomendado: "recomendado", aviso: "aviso" };

export function PreCheckFechamento({ preCheck }) {
  if (!preCheck?.itens?.length) return null;
  const { contagem } = preCheck;
  return (
    <section className="vf-fin-novo__passo vf-fin-precheck" aria-label="Antes de processar">
      <div className="vf-cluster vf-cluster--between">
        <h3 className="vf-fin-novo__passo-titulo">Antes de processar</h3>
        <span className="vf-field__hint" data-testid="precheck-resumo">
          {contagem.faltando ? `${contagem.faltando} obrigatório${contagem.faltando > 1 ? "s" : ""} faltando` : "obrigatórios ok"}
          {contagem.avisos ? ` · ${contagem.avisos} aviso${contagem.avisos > 1 ? "s" : ""}` : ""}
        </span>
      </div>
      <ul className="vf-fin-precheck__lista">
        {preCheck.itens.map((i) => (
          <li key={i.id} className={`vf-fin-precheck__item is-${i.estado}`} data-precheck={i.id} data-estado={i.estado}>
            <span className="vf-fin-precheck__icone" aria-hidden="true">{ICONE[i.estado] || "•"}</span>
            <span className="vf-fin-precheck__texto">
              <strong>{i.rotulo}</strong> <span className="vf-field__hint">{i.detalhe}</span>
            </span>
            <span className="vf-fin-precheck__nivel">{NIVEL[i.nivel]}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
