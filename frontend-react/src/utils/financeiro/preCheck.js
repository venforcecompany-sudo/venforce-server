// frontend-react/src/utils/financeiro/preCheck.js
//
// PRÉ-CHECK antes de Processar — tornar o fechamento difícil de fazer
// errado, sem bloquear por coisa recomendada. Três níveis:
//
//   obrigatorio  sem isso não processa (espelha a validação do hook — quem
//                bloqueia continua sendo ela; aqui só se mostra)
//   recomendado  melhora o fechamento (Order.all na Shopee)
//   aviso        algo que costuma ser erro: arquivo de outro mês, o MESMO
//                arquivo de um fechamento anterior, ADS vazio quando a conta
//                costuma ter, base diferente da última, pendências que
//                ficaram no último fechamento, competência já salva
//
// "Como esta conta costuma ser fechada" vem do PRECEDENTE: a última revisão
// salva da conta (base, arquivos e ajustes que ela usou). Não há tabela de
// configuração nova — o histórico já responde, e não diverge dele.
//
// O nome do arquivo não se repete aqui: o card do arquivo já o mostra.
//
// Nada aqui é regra financeira.

import { rotularCompetencia } from "../dates.js";
import { formatarMoeda } from "../currency.js";
import { rotuloRevisao, resumoRevisoes } from "./revisoes.js";

// Cobertura de custo que o fechamento deveria atingir antes de ir ao
// cliente. Abaixo dela, salvar/publicar pede confirmação (não bloqueia).
export const COBERTURA_MINIMA_ESPERADA = 95;

// Tipos do manifesto do snapshot (seloProcessamento.manifestoDoArquivo).
export const TIPO_DO_CAMPO = { sales: "vendas", costs: "custos", ordersAll: "order_all" };

// A revisão que serve de precedente: a mais nova de uma competência
// ANTERIOR à em tela (a "do mês passado"); sem ela, a mais nova de outra
// competência qualquer.
export function precedenteDaConta(snapshots, periodo) {
  const outras = (Array.isArray(snapshots) ? snapshots : []).filter((s) => s.periodo !== periodo);
  if (!outras.length) return null;
  const ordenar = (lista) => [...lista].sort((a, b) => (a.periodo === b.periodo ? b.revisao - a.revisao : a.periodo < b.periodo ? 1 : -1));
  const anteriores = outras.filter((s) => !periodo || s.periodo < periodo);
  return ordenar(anteriores.length ? anteriores : outras)[0] || null;
}

// "Order.all.20260901_20260930.xlsx" → ["2026-09"]. Só datas AAAAMMDD /
// AAAA-MM claras no nome; nenhuma = nenhuma opinião.
export function competenciasNoNome(nome) {
  const achadas = new Set();
  const texto = String(nome || "");
  for (const m of texto.matchAll(/(?<!\d)(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?!\d)/g)) achadas.add(`${m[1]}-${m[2]}`);
  for (const m of texto.matchAll(/(?<!\d)(20\d{2})[-_.](0[1-9]|1[0-2])(?![\d])/g)) achadas.add(`${m[1]}-${m[2]}`);
  return [...achadas].sort();
}

// O mesmo arquivo (sha256) já usado numa revisão de OUTRA competência.
function mesmoArquivoDe(snapshots, periodo, tipo, sha) {
  if (!sha) return null;
  for (const s of Array.isArray(snapshots) ? snapshots : []) {
    if (s.periodo === periodo) continue;
    if ((s.arquivos || []).some((a) => a && a.tipo === tipo && a.sha256 === sha)) return s;
  }
  return null;
}

const vazio = (v) => v === null || v === undefined || String(v).trim() === "" || Number(String(v).replace(/\./g, "").replace(",", ".")) === 0;

function avisosDoArquivo({ file, campo, periodo, snapshots, assinaturas }) {
  const avisos = [];
  if (!file) return avisos;
  const meses = competenciasNoNome(file.name);
  if (meses.length && periodo && !meses.includes(periodo)) {
    avisos.push(`O nome do arquivo sugere ${meses.map(rotularCompetencia).join(" a ")}, não ${rotularCompetencia(periodo)}.`);
  }
  const igual = mesmoArquivoDe(snapshots, periodo, TIPO_DO_CAMPO[campo], assinaturas?.[campo]);
  if (igual) avisos.push(`É o MESMO arquivo usado em ${rotularCompetencia(igual.periodo)} (${rotuloRevisao(igual)}).`);
  return avisos;
}

export function montarPreCheck({
  clienteNome, contaNome, clienteContaId, periodo, marketplace,
  base, usarUploadDeCustos = false, custosObrigatorios = false, arquivos = {}, ajustes = {},
  snapshots = null, assinaturas = {},
}) {
  const itens = [];
  const add = (item) => itens.push(item);
  const precedente = precedenteDaConta(snapshots, periodo);
  const deQuando = precedente ? `${rotularCompetencia(precedente.periodo)} ${rotuloRevisao(precedente)}` : null;

  add({ id: "cliente", nivel: "obrigatorio", estado: clienteNome ? "ok" : "falta", rotulo: "Cliente", detalhe: clienteNome || "não resolvido" });
  add({ id: "conta", nivel: "obrigatorio", estado: clienteContaId ? "ok" : "falta", rotulo: "Conta", detalhe: contaNome || (clienteContaId ? `#${clienteContaId}` : "não resolvida") });

  const rev = resumoRevisoes((Array.isArray(snapshots) ? snapshots : []).filter((s) => s.periodo === periodo).sort((a, b) => b.revisao - a.revisao));
  add({
    id: "competencia",
    nivel: "obrigatorio",
    estado: !periodo ? "falta" : rev.ultima ? "aviso" : "ok",
    rotulo: "Competência",
    detalhe: !periodo
      ? "não escolhida"
      : rev.ultima
        ? `${rotularCompetencia(periodo)} já tem ${rotuloRevisao(rev.ultima)} salva${rev.publicada ? ` (publicado ${rotuloRevisao(rev.publicada)})` : ""} — salvar cria v${rev.ultima.revisao + 1}.`
        : rotularCompetencia(periodo),
  });

  // Base de custos: a vinculada, ou a planilha (quando é ela que cobre).
  const nomeBase = base?.base?.nome || base?.base?.slug || null;
  let estadoBase;
  let detalheBase;
  if (base?.status === "carregando" || base?.status === "inativo") {
    estadoBase = "pendente";
    detalheBase = "verificando a base vinculada…";
  } else if (base?.status === "encontrada" && !usarUploadDeCustos) {
    estadoBase = "ok";
    detalheBase = `base vinculada ${nomeBase}`;
  } else if (custosObrigatorios) {
    estadoBase = arquivos.costs ? "ok" : "falta";
    detalheBase = arquivos.costs ? "planilha de custos enviada" : "envie a planilha de custos";
  } else {
    estadoBase = "falta";
    detalheBase = base?.status === "ambigua" ? "mais de uma conta possível" : "não foi possível verificar a base";
  }
  const basePrecedente = precedente?.origemCustos?.costsBase || null;
  const avisosBase = [];
  if (estadoBase === "ok" && basePrecedente && base?.base && !usarUploadDeCustos && Number(basePrecedente.id) !== Number(base.base.id)) {
    avisosBase.push(`No último fechamento (${deQuando}) a base foi ${basePrecedente.nome || basePrecedente.slug}.`);
  }
  if (estadoBase === "ok" && usarUploadDeCustos && precedente?.origemCustos?.costsSource === "base") {
    avisosBase.push(`O último fechamento (${deQuando}) usou a base vinculada, não uma planilha.`);
  }
  add({ id: "base", nivel: "obrigatorio", estado: avisosBase.length && estadoBase === "ok" ? "aviso" : estadoBase, rotulo: "Base de custos", detalhe: [detalheBase, ...avisosBase].join(" ") });

  const avisosVendas = avisosDoArquivo({ file: arquivos.sales, campo: "sales", periodo, snapshots, assinaturas });
  add({
    id: "vendas",
    nivel: "obrigatorio",
    estado: !arquivos.sales ? "falta" : avisosVendas.length ? "aviso" : "ok",
    rotulo: marketplace === "shopee" ? "Planilha principal (Performance)" : "Planilha de vendas",
    detalhe: [arquivos.sales ? "enviada" : "não enviada", ...avisosVendas].join(" "),
  });

  if (marketplace === "shopee") {
    const usouAntes = (precedente?.arquivos || []).some((a) => a?.tipo === "order_all");
    const avisosOA = avisosDoArquivo({ file: arquivos.ordersAll, campo: "ordersAll", periodo, snapshots, assinaturas });
    add({
      id: "order_all",
      nivel: "recomendado",
      estado: !arquivos.ordersAll ? "recomendado" : avisosOA.length ? "aviso" : "ok",
      rotulo: "Order.all",
      detalhe: [
        arquivos.ordersAll ? "enviado" : `não enviado${usouAntes ? ` — o último fechamento (${deQuando}) usou` : ""}`,
        ...avisosOA,
      ].join(" "),
    });
  }

  // Ajustes: zero pode ser real, mas ADS vazio numa conta que costuma ter
  // ADS é o esquecimento mais caro.
  const adsAntes = Number(precedente?.ajustes?.ads) || 0;
  const todosVazios = ["ads", "venforce", "affiliates", "fullCost", "additionalCosts"].every((k) => vazio(ajustes[k]));
  let estadoAjustes = "ok";
  let detalheAjustes = "informados";
  if (vazio(ajustes.ads) && adsAntes > 0) {
    estadoAjustes = "aviso";
    detalheAjustes = `ADS vazio — no último fechamento (${deQuando}) foi ${formatarMoeda(adsAntes)}.`;
  } else if (todosVazios) {
    estadoAjustes = "aviso";
    detalheAjustes = "nenhum ajuste informado (ADS, Venforce e afiliados entram como zero).";
  }
  add({ id: "ajustes", nivel: "aviso", estado: estadoAjustes, rotulo: "Ajustes", detalhe: detalheAjustes });

  const pendAntes = Number(precedente?.contagens?.pendencias) || 0;
  if (pendAntes > 0) {
    add({
      id: "pendencias_anteriores",
      nivel: "aviso",
      estado: "aviso",
      rotulo: `${pendAntes} ${pendAntes === 1 ? "produto ficou" : "produtos ficaram"} sem custo`,
      detalhe: `no último fechamento (${deQuando}) — potencialmente sem custo de novo. Confira a base antes de processar.`,
    });
  }

  const contagem = {
    faltando: itens.filter((i) => i.estado === "falta").length,
    avisos: itens.filter((i) => i.estado === "aviso").length,
    recomendados: itens.filter((i) => i.estado === "recomendado").length,
  };
  return { itens, contagem, precedente };
}
