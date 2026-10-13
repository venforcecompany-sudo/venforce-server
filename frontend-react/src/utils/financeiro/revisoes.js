// frontend-react/src/utils/financeiro/revisoes.js
//
// REVISÕES do fechamento (snapshots — server/services/fechamentoSnapshot).
// Uma competência de uma conta tem v1, v2, … imutáveis; a entrega
// (apresentação) aponta para uma delas, e é publicando a entrega que uma
// revisão chega ao cliente.
//
// Só leitura e organização: nada aqui calcula número financeiro.

import { mesmaCompetencia } from "./competencia.js";

export const rotuloRevisao = (s) => (s && s.revisao != null ? `v${s.revisao}` : "—");

// Revisões da competência, mais nova primeiro.
export function revisoesDoPeriodo(snapshots, periodo) {
  if (!Array.isArray(snapshots) || !periodo) return [];
  return snapshots.filter((s) => mesmaCompetencia(s.periodo, periodo)).sort((a, b) => b.revisao - a.revisao);
}

// O que a competência tem a dizer sobre as revisões:
//   ultima            a revisão mais nova (o "salvo" atual);
//   publicada         a revisão de uma entrega PUBLICADA (o que o cliente vê);
//   novaNaoPublicada  existe revisão mais nova do que a publicada.
// Com mais de uma publicada (duas entregas com link — legado), vale a mais
// nova, e `publicadas` lista todas para a tela não esconder.
export function resumoRevisoes(revisoes) {
  const lista = Array.isArray(revisoes) ? revisoes : [];
  const ultima = lista[0] || null;
  const publicadas = lista.filter((s) => s.publicado);
  const publicada = publicadas[0] || null;
  return {
    total: lista.length,
    ultima,
    publicada,
    publicadas,
    novaNaoPublicada: !!ultima && (!publicada || ultima.revisao > publicada.revisao),
  };
}

// A revisão que uma entrega apresenta (pela lista de entregas de cada
// snapshot). Entrega antiga, sem snapshot → null.
export function revisaoDaEntrega(snapshots, entregaId) {
  if (!entregaId || !Array.isArray(snapshots)) return null;
  return snapshots.find((s) => (s.entregas || []).some((e) => Number(e.id) === Number(entregaId))) || null;
}

// Snapshot → o mesmo formato da resposta do processamento, para os MESMOS
// componentes de resultado lerem o histórico. Sem `detailedRows` (as linhas
// são paginadas no backend) e sem planilha (não é guardada).
export function processamentoDoSnapshot(snapshot) {
  if (!snapshot) return null;
  const diag = snapshot.diagnostico || {};
  return {
    ...diag,
    summary: snapshot.summary || {},
    costsSource: snapshot.origemCustos?.costsSource ?? null,
    costsBase: snapshot.origemCustos?.costsBase ?? null,
    // O mesmo bloco `processamento` da resposta do motor (manifesto, custos,
    // ajustes, quem/quando). O DTO do snapshot não expõe o selo.
    processamento: {
      arquivos: Array.isArray(snapshot.arquivos) ? snapshot.arquivos : [],
      custos: snapshot.origemCustos?.custos ?? null,
      ajustes: snapshot.ajustes || {},
      processadoEm: snapshot.processadoEm ?? null,
      processadoPor: snapshot.processadoPor ?? null,
    },
    detailedRows: [],
    excelBase64: null,
    incidente: null,
  };
}

// Filtro da tabela de produtos → status do backend.
export const STATUS_DO_FILTRO = {
  todos: null,
  saudaveis: "saudavel",
  atencao: "atencao",
  criticos: "critico",
  sem_custo: "sem_custo",
  custo_ambiguo: "custo_ambiguo",
  aguardando_financeiro: "aguardando_financeiro",
  cancelados: "cancelados",
};

// Contagens gravadas no snapshot → as chaves dos filtros da tabela.
export function contagemDosFiltros(contagens = {}) {
  const c = contagens || {};
  return {
    todos: c.total ?? 0,
    saudaveis: c.saudavel ?? 0,
    atencao: c.atencao ?? 0,
    criticos: c.critico ?? 0,
    sem_custo: c.sem_custo ?? 0,
    custo_ambiguo: c.custo_ambiguo ?? 0,
    aguardando_financeiro: c.aguardando_financeiro ?? 0,
    cancelados: c.cancelados ?? 0,
  };
}
