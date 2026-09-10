// frontend-react/src/components/financeiro/fechamento/FechamentoAcao.jsx
//
// A ação primária da tela. Bloqueado: diz POR QUÊ, ao lado do botão, com a
// contagem de pendências. Pronto: confirma. Processando: spinner + disabled.
//
// Os avisos por campo já aparecem nos próprios cards — aqui é o resumo:
// "Falta 1 item obrigatório para processar."

export function FechamentoAcao({ validacao, processando, onProcessar }) {
  const pendencias = validacao.itens.length;
  const pronto = validacao.ok;

  return (
    <div className="vf-fin-novo__acao">
      <p className={pronto ? "vf-fin-novo__acao-msg is-pronto" : "vf-fin-novo__acao-msg"}>
        {processando
          ? "Processando fechamento…"
          : pronto
            ? "✓ Tudo pronto para processar"
            : `Falta ${pendencias} ${pendencias === 1 ? "item obrigatório" : "itens obrigatórios"} para processar.`}
      </p>
      <button
        type="button"
        className="vf-btn vf-btn--primary vf-btn--lg"
        disabled={!pronto || processando}
        aria-busy={processando ? "true" : undefined}
        onClick={onProcessar}
      >
        {processando ? "Processando…" : "Processar fechamento"}
      </button>
    </div>
  );
}
