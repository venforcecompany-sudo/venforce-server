// frontend-react/src/components/financeiro/fechamento/FechamentoContextoBar.jsx
//
// Uma linha só, no topo do fechamento: o que está sendo fechado. Cliente,
// marketplace, operação e competência — tudo já vem do Shell, aqui é só
// exibição compacta para o formulário não parecer uma tela solta.

const MK_LABEL = { meli: "Mercado Livre", shopee: "Shopee", tiktok: "TikTok Shop" };

export function FechamentoContextoBar({ clienteNome, marketplace, contaNome, clienteContaId, periodoLabel }) {
  const itens = [
    clienteNome,
    MK_LABEL[marketplace] || marketplace,
    contaNome || (clienteContaId ? `Operação #${clienteContaId}` : null),
    periodoLabel,
  ].filter(Boolean);

  return (
    <p className="vf-fin-novo__contexto">
      {itens.map((item, i) => (
        <span key={i} className="vf-fin-novo__contexto-item">{item}</span>
      ))}
    </p>
  );
}
