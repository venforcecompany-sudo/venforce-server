// frontend-react/src/components/financeiro/FechamentoTab.jsx
//
// A mesa de trabalho do fechamento, de cima para baixo:
//
//   1. NovoFechamento — arquivos, ajustes, Processar e, logo abaixo, o
//      RESULTADO DO PROCESSAMENTO completo (não uma aba à parte), terminando
//      nos produtos (a investigação detalhada vem por último).
//   2. Entrega desta competência — a entrega DESTA conta (salva agora ou
//      antes): apresentação para o cliente, publicar, copiar/abrir o link.
//      É passada como slot ao NovoFechamento, que a posiciona entre as ações
//      e os produtos (sempre no mesmo ponto da árvore: sem remontar).
//   3. Fechamento salvo — quando nada foi processado agora: a REVISÃO
//      gravada (snapshot) com o resultado completo e todos os produtos; sem
//      revisão (fechamento anterior a elas), a composição gravada na entrega
//      (GET /financeiro/:cliente). No MELI, a conciliação Mercado Pago da
//      Central de Vendas.
//
// Publicar/despublicar agem sobre uma entrega concreta, por `id`, e só a
// entrega DESTA conta é operável aqui (entregaDoPeriodo). A legada, sem
// operação registrada, é rotulada em Relatórios gerados.

import { useCallback, useEffect, useState } from "react";
import { formatarDataHora } from "../../utils/dates.js";
import { EntregaPainel } from "./entrega/EntregaPainel.jsx";
import { NovoFechamento } from "./NovoFechamento.jsx";
import { ResultadoTab } from "./ResultadoTab.jsx";
import { ConciliacaoTab } from "./ConciliacaoTab.jsx";
import { SnapshotFechamento } from "./snapshot/SnapshotFechamento.jsx";

export function FechamentoTab({
  resultado,
  conciliacao,
  carregandoLeitura = false,
  clienteSlug,
  clienteNome,
  clienteContaId,
  marketplace,
  contaNome,
  periodo,
  periodoLabel,
  entregas,
  entrega,
  onSalvo,
  onTrabalho,
  revisoes = null,
  snapshots = null,
  revisaoPreferida = null,
}) {
  const [trabalhoForm, setTrabalhoForm] = useState({ temTrabalho: false, temResultado: false, processadoNaoSalvo: false });
  const [apresentacaoAlterada, setApresentacaoAlterada] = useState(false);
  const mkt = String(marketplace || "").toLowerCase();
  const processadoAgora = trabalhoForm.temResultado;

  // Trabalho da página = formulário/resultado + apresentação não salva. Os
  // dois chegam por efeitos dos filhos; callbacks estáveis (setState) evitam
  // laço de renders.
  const aoMudarTrabalho = useCallback((t) => setTrabalhoForm(t), []);
  useEffect(() => {
    onTrabalho?.({ ...trabalhoForm, temTrabalho: trabalhoForm.temTrabalho || apresentacaoAlterada });
  }, [onTrabalho, trabalhoForm, apresentacaoAlterada]);

  return (
    <div className="vf-stack">
      <NovoFechamento
        clienteSlug={clienteSlug}
        clienteNome={clienteNome}
        clienteContaId={clienteContaId}
        marketplace={marketplace}
        contaNome={contaNome}
        periodo={periodo}
        periodoLabel={periodoLabel}
        onSalvo={onSalvo}
        onTrabalho={aoMudarTrabalho}
        revisoes={revisoes}
        snapshots={snapshots}
        entregaSlot={
          <EntregaPainel
            entrega={entrega}
            entregas={entregas}
            clienteNome={clienteNome}
            marketplace={mkt}
            contaNome={contaNome}
            clienteContaId={clienteContaId}
            periodo={periodo}
            periodoLabel={periodoLabel}
            onAlterado={setApresentacaoAlterada}
            revisoes={revisoes}
            snapshots={snapshots}
          />
        }
      />

      {!processadoAgora && (
        <FechamentoSalvo
          revisoes={revisoes}
          revisaoPreferida={revisaoPreferida}
          contexto={{ clienteSlug, clienteNome, clienteContaId }}
          onApresentado={onSalvo}
          resultado={resultado}
          conciliacao={conciliacao}
          carregando={carregandoLeitura}
          entrega={entrega}
          marketplace={mkt}
          periodo={periodo}
          periodoLabel={periodoLabel}
        />
      )}
    </div>
  );
}

// O fechamento JÁ SALVO desta competência — leitura. Sem processamento em
// memória, é o que a tela tem a dizer sobre o mês.
function FechamentoSalvo({ revisoes, revisaoPreferida, contexto, onApresentado, resultado, conciliacao, carregando, entrega, marketplace, periodo, periodoLabel }) {
  const conciliacaoMeli = marketplace === "meli" && conciliacao && (
    <details className="vf-fin-disclosure">
      <summary>Conciliação Mercado Pago (Central de Vendas)</summary>
      <ConciliacaoTab conciliacao={conciliacao} />
    </details>
  );

  // Com revisão gravada, o salvo É a revisão (resultado completo + todas as
  // linhas). O bloco antigo (cards do payload) fica para fechamentos
  // anteriores às revisões.
  if (Array.isArray(revisoes) && revisoes.length) {
    return (
      <section className="vf-section vf-section--inset vf-stack vf-stack--sm" aria-label="Fechamento salvo">
        <SnapshotFechamento
          revisoes={revisoes}
          revisaoPreferida={revisaoPreferida}
          marketplace={marketplace}
          periodo={periodo}
          periodoLabel={periodoLabel}
          entrega={entrega}
          contexto={contexto}
          onApresentado={onApresentado}
        />
        {conciliacaoMeli}
      </section>
    );
  }

  if (carregando) {
    return (
      <div className="vf-stack vf-stack--sm" aria-busy="true">
        <div className="vf-skeleton vf-skeleton--title" />
        <div className="vf-skeleton vf-skeleton--row" />
      </div>
    );
  }
  if (!resultado) return null;

  // O bloco de leitura escolhe a entrega da competência com a mesma regra do
  // backend; `escopoConta=false` com entrega significa que ela é legada (do
  // cliente) — dito, nunca escondido.
  const dados = resultado.dados;
  const temSalvo = resultado.disponivel && dados && dados.status !== "nao_gerado";

  return (
    <section className="vf-section vf-section--inset vf-stack vf-stack--sm" aria-label="Fechamento salvo">
      <div className="vf-cluster vf-cluster--between">
        <h3 className="vf-fin-novo__passo-titulo">Fechamento salvo de {periodoLabel}</h3>
        {temSalvo && (
          <span className="vf-field__hint">
            Gerado em {formatarDataHora(entrega?.created_at || dados?.geradoEm)}
            {entrega?.publicado ? ` · publicado em ${formatarDataHora(entrega?.published_at)}` : ""}
          </span>
        )}
      </div>
      {temSalvo && (
        <p className="vf-field__hint" data-estado-leitura="salvo">
          É o fechamento GRAVADO ({dados.status === "publicado" ? "publicado" : "rascunho"}), não um processamento novo: os números são os
          que foram salvos naquele dia, com os arquivos e a base de custos daquele momento. Ele é anterior às revisões, então só a
          composição foi guardada. Processar de novo acima e salvar cria a revisão v1, com todos os produtos.
        </p>
      )}
      {resultado.origemClientLevel && (
        <p className="vf-field__hint">
          Fechamento legado · operação não registrada — {resultado.origemClientLevel.motivo}
        </p>
      )}
      {resultado.ambiguidade && (
        <p className="vf-field__hint">
          {resultado.ambiguidade.total} fechamentos gravados para esta competência; exibindo o #{resultado.ambiguidade.escolhidoId}.
        </p>
      )}
      <ResultadoTab resultado={resultado} periodoLabel={periodoLabel} />

      {conciliacaoMeli}
    </section>
  );
}
