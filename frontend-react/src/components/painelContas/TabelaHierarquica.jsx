// frontend-react/src/components/painelContas/TabelaHierarquica.jsx
//
// Tabela hierárquica do Painel de Contas operacional. Continua sendo uma
// TABELA (não cards): comparar muitos clientes depende de colunas alinhadas.
// Construída sobre `.vf-table` (Fundação Global V2); o específico deste padrão
// mora em TabelaHierarquica.css.
//
// ── Os níveis ────────────────────────────────────────────────────────────
// CLIENTE    → o número CONSOLIDADO da competência selecionada — a linha
//              DOMINANTE. Nome + escopo ("Consolidado · 3 contas"), estado ·
//              dados até e, quando alguma conta pede ação, UMA frase na linha
//              de baixo ("2 contas precisam de ação") em vez de repetir o botão
//              de cada conta. Na coluna de contexto: squad + selo de origem
//              (API · Manual · API + manual) e "atualizado em". Sem dado, a
//              linha diz POR QUÊ — nunca mostra outro mês.
// CONTA      → cada conta/operação, SECUNDÁRIA e pendurada no eixo do
//              cliente (galho ├), com o próprio número (o mesmo escopo que a
//              Central de Vendas mostra ao selecionar a conta). É nela que
//              mora a AÇÃO "Lançar dados" / "Editar dados". Já vem na lista:
//              abrir um cliente não custa requisição.
// DETALHES   → uma linha de ferramentas: "Composição do faturamento" (seção
//              de detalhe na largura visível) e "Consolidado semanal".
//
// ATUALIZAR  → admin: "↻ Atualizar" na linha do cliente dispara a atualização
//              sob demanda (servidor). Em curso, a âncora diz o período
//              ("Atualizando até hoje") e o botão, a contagem ("Atualizando
//              1/2"); terminada com pendência, uma linha logo abaixo diz QUAL
//              conta falhou e por quê.
// HISTÓRICO  → meses do consolidado (lazy) → semanas (lazy). A competência
//              selecionada fica marcada.
//
// NÃO existe "expandir todos": seria uma requisição de histórico por cliente,
// o oposto do que o lazy loading protege.

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { VFTooltip } from "../ui/VFTooltip/index.js";
import { formatarMoeda } from "../../utils/currency.js";
import { formatarPercentual, formatarVariacaoPercentual, formatarPontosPercentuais } from "../../utils/percentage.js";
import { AUSENTE, ehAusente, direcao } from "../../utils/numbers.js";
import { rotularCompetenciaCurta, formatarData, formatarDataHora } from "../../utils/dates.js";
import { colunasVisiveis, gruposVisiveis, COLUNAS_ESSENCIAIS } from "./colunas.js";
import { atualizacaoEmCurso } from "../../utils/painelContasAtualizacao.js";
import { DemonstrativoComposicao } from "./ComposicaoFaturamento.jsx";
import "./TabelaHierarquica.css";

// Squad é identidade, não estado: tag NEUTRA (cor fica reservada para o que
// tem semântica). É a ÚNICA etiqueta da linha: estado vira `.vf-status`
// (ponto + texto, forma codifica o tom) e fonte vira texto.
const TOM_SQUAD = "is-neutral";

// Tom por status: cor é a segunda pista — o rótulo em texto é a primeira, e a
// FORMA do ponto (●/◇/○ da Fundação) a terceira. Quatro tons só:
// verde = sincronizado · âmbar = parcial/atenção · cinza = ausência ou fonte
// neutra (manual, sincronizando) · vermelho = erro real. "" = `.vf-status`
// base (ponto cheio cinza), distinto do ○ vazado de ausência.
const TOM_STATUS = {
  sincronizado: "is-success",
  manual: "",
  parcial: "is-warning",
  sem_dados: "is-empty",
  sem_conta: "is-warning",
  sem_conexao: "is-warning",
  sem_integracao: "is-empty",
  sincronizando: "",
  erro_sync: "is-danger",
  nao_publicado: "is-warning",
  conta_inativa: "is-empty",
};

const NOTA_ADS_POR_CONTA = "Ads é medido por cliente (todas as contas juntas) — não existe valor por conta, e nada é rateado.";

// ── Vista (V4) ──────────────────────────────────────────────────────────────
// "detalhada" é a tabela por grupos (contexto logo depois do nome).
// "essencial" é a worklist V4: Cliente · FAT · Margem · Ads · Dados — a
// coluna de contexto vira "Dados" e vai para o FIM da linha. As duas vistas
// leem exatamente os mesmos campos; só a disposição muda.
const VistaContext = createContext("detalhada");
const useEssencial = () => useContext(VistaContext) === "essencial";

// Âncora primeiro, sempre; o contexto troca de lado conforme a vista.
function dispor(essencial, contexto, celulas) {
  return essencial ? <>{celulas}{contexto}</> : <>{contexto}{celulas}</>;
}

const SIGLA_MARKETPLACE = { meli: "ML", shopee: "Shopee", tiktok: "TikTok" };

// "8 contas · ML 4 · Shopee 2 · TikTok 2" — só CONTAGEM das contas ativas que
// já vêm na lista. Uma conta só: o próprio rótulo do servidor.
export function composicaoContas(cliente) {
  const ativas = (cliente.contas || []).filter((c) => c.ativa);
  if (ativas.length === 0) return cliente.escopo?.rotulo || "Nenhuma conta ativa";
  if (ativas.length === 1) return ativas[0].rotulo || cliente.escopo?.rotulo || "1 conta";
  const porMp = new Map();
  for (const c of ativas) {
    const mp = String(c.marketplace || "").toLowerCase();
    porMp.set(mp, (porMp.get(mp) || 0) + 1);
  }
  const partes = [...porMp.entries()].map(([mp, n]) => `${SIGLA_MARKETPLACE[mp] || (mp ? mp[0].toUpperCase() + mp.slice(1) : "Outro")} ${n}`);
  return `${ativas.length} contas · ${partes.join(" · ")}`;
}

// Vocabulário V4 sobre o status do SERVIDOR (nenhuma reclassificação):
// sincronizado/manual → Completo · parcial → Parcial · sem_dados/sem_conta →
// Sem dados. "k de n" é o escopo que o servidor já devolve.
export function rotuloSituacao(cliente, competencia) {
  const codigo = cliente.status?.codigo;
  const n = cliente.escopo?.contasOperacionais;
  const k = cliente.escopo?.contasComDado;
  const fracao = n > 1 && k != null ? ` · ${k} de ${n}` : "";
  if (codigo === "sincronizado" || codigo === "manual") return { texto: `Completo${fracao}`, tom: "ok" };
  if (codigo === "parcial") return { texto: `Parcial${fracao}`, tom: "parc" };
  if (codigo === "sem_dados") return { texto: `Sem dados em ${rotularCompetenciaCurta(competencia)}`, tom: "nd" };
  if (codigo === "sem_conta") return { texto: "Sem conta ativa", tom: "nd" };
  return { texto: cliente.status?.rotulo || "—", tom: "nd" };
}

// Um quadradinho por conta ativa: ● API · ● manual (azul) · ◇ pede ação ·
// ○ sem dado. Forma + cor + título: nunca só a cor.
export function pipConta(conta) {
  if (!conta.ativa) return { classe: "x", titulo: "inativa" };
  if (conta.resumo) return conta.fonte?.tipo === "manual" ? { classe: "m", titulo: "manual" } : { classe: "a", titulo: "API" };
  if (conta.precisaAcao) return { classe: "w", titulo: conta.status?.rotulo || "pede ação" };
  return { classe: "o", titulo: conta.status?.rotulo || "sem dados" };
}

function Pips({ contas }) {
  const lista = (contas || []).filter((c) => c.ativa);
  if (lista.length === 0) return <span className="vf-ph-pips" aria-hidden="true" />;
  return (
    <span className="vf-ph-pips" aria-hidden="true">
      {lista.map((c) => {
        const p = pipConta(c);
        return <i key={c.id} className={`vf-ph-pip is-${p.classe}`} title={`${c.rotulo}: ${p.titulo}`} />;
      })}
    </span>
  );
}

function formatarValor(tipo, valor) {
  if (tipo === "indisponivel") return AUSENTE;
  // `casas: 0` é escolha de densidade; o valor exato fica no `title`.
  if (tipo === "moeda") return formatarMoeda(valor, { casas: 0 });
  return formatarPercentual(valor);
}

function valorExato(tipo, valor) {
  if (tipo !== "moeda" || ehAusente(valor)) return undefined;
  return formatarMoeda(valor);
}

// fat/lc/ads variam em {abs,pct} -> mostra pct. mc/acos/tacos variam em {pp}.
function lerVariacao(tipo, variacao) {
  if (!variacao) return null;
  if (tipo === "moeda" && !ehAusente(variacao.pct)) {
    return { valor: variacao.pct, texto: formatarVariacaoPercentual(variacao.pct) };
  }
  if (tipo === "fracao" && !ehAusente(variacao.pp)) {
    return { valor: variacao.pp, texto: formatarPontosPercentuais(variacao.pp) };
  }
  return null;
}

// Direção NUNCA sai do sinal matemático sozinho: `sentido` vem da coluna.
function Delta({ sentido, valor, texto }) {
  const n = Number(valor);
  const tom = sentido === "neutro" ? "neutro" : direcao(n, { inverso: sentido === "positivo-ruim" });
  const simbolo = n === 0 ? "=" : n > 0 ? "▲" : "▼";
  return (
    <span className={`vf-ph-delta is-${tom}`}>
      <span className="vf-ph-delta__simbolo" aria-hidden="true">{simbolo}</span>
      {texto}
    </span>
  );
}

// Classes de apresentação do número — nenhuma muda o valor exibido:
//   vf-ph-col--<chave>  peso por métrica (FAT domina a linha; ver CSS)
//   is-inicio-grupo     divisor vertical discreto entre Financeiro e Ads
//   is-ausente          "—" em tom secundário (ausência não compete com dado)
//   is-negativo         negativo diferenciado sem depender só da cor (o "−"
//                       já vem do formatador)
// Cobertura de custos: só SINALIZA. LC/MC continuam os números calculados;
// quando parte do FAT não tem custo, uma marca discreta diz quanto está coberto.
export function textoCoberturaParcial(custos) {
  const pct = formatarPercentual(custos.cobertura);
  return `Cálculo parcial: os custos cobrem ${pct} do FAT (${formatarMoeda(custos.faturamentoComCusto)} de `
    + `${formatarMoeda(custos.faturamentoComCusto + custos.faturamentoSemCusto)}). O LC soma só os pedidos com custo `
    + "cadastrado e a MC é LC ÷ faturamento com custo — valem para a parte coberta.";
}

function marcaParcial(coluna, custos) {
  if (custos?.estado !== "parcial") return false;
  return (custos.indicadores || ["lc", "mc"]).includes(coluna.chave);
}

// `manual`: o FAT LANÇADO numa conta ganha uma legenda discreta embaixo —
// só no FAT e só na conta (no cliente, estado e selo de origem já dizem).
function Celula({ coluna, valor, variacao, titulo, custos = null, manual = false, subValor = null, fracao = null, rotuloAusente = null }) {
  const formatado = formatarValor(coluna.tipo, valor);
  const delta = lerVariacao(coluna.tipo, variacao);
  const indisponivel = coluna.tipo === "indisponivel";
  const ausente = indisponivel || ehAusente(valor);
  const negativo = !ausente && Number(valor) < 0;
  const texto = ausente && rotuloAusente ? rotuloAusente : formatado;
  const classes = [
    "num",
    `vf-ph-col--${coluna.chave}`,
    coluna.inicioGrupo ? "is-inicio-grupo" : "",
    indisponivel ? "vf-ph-indisponivel" : "",
  ].filter(Boolean).join(" ");
  return (
    <td
      className={classes}
      title={titulo || (indisponivel ? "Sem fonte de dado auditada nesta versão" : valorExato(coluna.tipo, valor))}
    >
      <span className={`vf-ph-valor${ausente ? " is-ausente" : ""}${negativo ? " is-negativo" : ""}${ausente && rotuloAusente ? " vf-ph-valor--nota" : ""}`}>{texto}</span>
      {delta && <Delta sentido={coluna.sentido} valor={delta.valor} texto={delta.texto} />}
      {manual && coluna.chave === "fat" && !ausente && <span className="vf-ph-valor__origem">manual</span>}
      {coluna.sub && !ehAusente(subValor) && (
        <span className="vf-ph-sub" title={coluna.sub.definicao}>{coluna.sub.prefixo}{formatarValor(coluna.sub.tipo, subValor)}</span>
      )}
      {coluna.barra && !ausente && fracao != null && (
        <span className="vf-ph-share" aria-hidden="true"><span style={{ width: `${Math.max(2, Math.min(100, fracao * 100))}%` }} /></span>
      )}
      {!ausente && marcaParcial(coluna, custos) && (
        <VFTooltip content={textoCoberturaParcial(custos)}>
          <span className="vf-ph-parcial" tabIndex={0} aria-label={textoCoberturaParcial(custos)}>
            <span aria-hidden="true">◐ {formatarPercentual(custos.cobertura)}</span>
          </span>
        </VFTooltip>
      )}
    </td>
  );
}

function StatusCompacto({ status, rotulo, titulo }) {
  if (!status) return null;
  return (
    <span className={`vf-status vf-ph-status ${TOM_STATUS[status.codigo] ?? "is-empty"}`} title={titulo || status.motivo || undefined}>
      {rotulo || status.rotulo}
    </span>
  );
}

// "28/09" quando o ano é o da competência (a tela inteira já diz o ano);
// data completa quando não é — nunca uma data ambígua.
function dataCurta(iso, competencia) {
  const completa = formatarData(iso);
  return String(iso).slice(0, 4) === String(competencia).slice(0, 4) ? completa.slice(0, 5) : completa;
}

// Origem do número: API · Manual · API + manual — o MESMO selo no cliente e
// na conta. Neutro para API; Manual em tom informativo (o mesmo do aviso de
// modo manual), para o valor lançado se distinguir sem gritar.
function Origem({ fonte, vazio = "sem fonte" }) {
  if (!fonte) {
    return vazio ? <span className="vf-ph-origem is-vazio" title="Sem fonte na competência">{vazio}</span> : null;
  }
  return (
    <span className={`vf-ph-origem is-${fonte.tipo || "api"}`} title={`Origem do dado: ${fonte.rotulo}`}>
      {fonte.rotulo}
    </span>
  );
}

// Frescor do CLIENTE: quando a última atualização concluída aconteceu —
// ausente vira "—", nunca some. "Dados até" mora ao lado do estado, na
// âncora (o mesmo lugar que na conta). Em andamento, quem fala é o botão ↻ —
// esta linha continua mostrando a última atualização concluída.
function FrescorCliente({ cliente, concluidaAgora }) {
  return (
    <span className="vf-ph-contexto__linha vf-ph-meta">
      <span className={concluidaAgora ? "vf-ph-frescor--ok" : undefined}>
        {concluidaAgora && <span aria-hidden="true">✓ </span>}
        atualizado {cliente.atualizadoEm ? formatarDataHora(cliente.atualizadoEm) : AUSENTE}
      </span>
    </span>
  );
}

// ── Atualizar dados ─────────────────────────────────────────────────────────
// O texto de ajuda É a regra: automático até ontem; agora inclui hoje (mês
// corrente) ou reprocessa o mês inteiro (mês anterior).
export function explicarAtualizacao(competencia, competenciaAtual) {
  const mes = rotularCompetenciaCurta(competencia);
  return competencia === competenciaAtual
    ? `Atualizar agora: ${mes} do dia 1 até hoje, incluindo dados parciais de hoje. A atualização automática (de madrugada) vai só até ontem.`
    : `Atualizar agora: reprocessa ${mes} completo (mês encerrado).`;
}

// Fase visível do botão. Só LÊ o estado que o hook já mantém — nenhuma regra
// nova: em curso = `atualizacaoEmCurso`; o resto sai do `estado` do job.
function faseAtualizacao(atualizacao) {
  if (!atualizacao) return "normal";
  if (atualizacaoEmCurso(atualizacao)) return "andamento";
  const estadoJob = atualizacao.job?.estado;
  if (atualizacao.erro || estadoJob === "falhou") return "falha";
  if (estadoJob === "concluida_com_pendencias") return "pendencia";
  if (estadoJob === "concluida") return "ok";
  return "normal";
}

function progressoBotao(job) {
  const { concluidas = 0, total = 0 } = job?.progresso || {};
  return total > 0 ? `Atualizando ${concluidas}/${total}` : "Atualizando…";
}

// ↻ Atualizar — rótulo em texto (descobrível sem hover), estados escritos:
//   normal     ↻ Atualizar            (hover/foco: "Atualizar até hoje")
//   andamento  ↻ Atualizando 1/3      (travado; ícone gira)
//   ok         ✓ Atualizado           (hover/foco: "Atualizar até hoje")
//   falha      Falhou · tentar novamente
// O rótulo de hover é empilhado na MESMA célula de grid do normal: a largura
// do botão é a do maior dos dois, então trocar o texto não desloca nada.
// O nome acessível continua "Atualizar dados de <cliente>" (+ o estado, quando
// não é o normal) e o `title` segue explicando a regra de período.
export function BotaoAtualizar({ cliente, competencia, competenciaAtual, atualizacao, onAtualizar }) {
  const sincronizavel = (cliente.contas || []).some((c) => c.ativa && c.marketplace === "meli" && c.conectada);
  const fase = faseAtualizacao(atualizacao);
  const emCurso = fase === "andamento";
  const ajuda = sincronizavel
    ? explicarAtualizacao(competencia, competenciaAtual)
    : "Nenhuma conta Mercado Livre ativa e conectada — não há o que sincronizar.";
  const rotuloHover = competencia === competenciaAtual ? "Atualizar até hoje" : "Reprocessar o mês";

  let icone = "↻";
  let rotulo = "Atualizar";
  let estadoAcessivel = "";
  if (emCurso) {
    rotulo = progressoBotao(atualizacao.job);
    estadoAcessivel = ` — ${rotulo.toLowerCase()}`;
  } else if (fase === "ok") {
    icone = "✓";
    rotulo = "Atualizado";
    estadoAcessivel = " — atualizado";
  } else if (fase === "falha" || fase === "pendencia") {
    icone = null;
    rotulo = `${fase === "falha" ? "Falhou" : "Pendências"} · tentar novamente`;
    estadoAcessivel = ` — ${fase === "falha" ? "falhou" : "concluída com pendências"}, tentar novamente`;
  }
  const trocaNoHover = sincronizavel && (fase === "normal" || fase === "ok");

  return (
    <button
      type="button"
      className={`vf-btn vf-btn--ghost vf-btn--sm vf-ph-atualizar is-${fase}${trocaNoHover ? " tem-hover" : ""}`}
      onClick={() => onAtualizar(cliente.id)}
      disabled={emCurso || !sincronizavel}
      aria-label={`Atualizar dados de ${cliente.nome}${estadoAcessivel}`}
      title={emCurso ? "Atualização em andamento" : ajuda}
    >
      <span className="vf-ph-atualizar__rotulos">
        <span className="vf-ph-atualizar__rotulo">
          {icone && <span aria-hidden="true" className={`vf-ph-atualizar__icone${emCurso ? " is-girando" : ""}`}>{icone}</span>}
          {rotulo}
        </span>
        {trocaNoHover && (
          <span className="vf-ph-atualizar__rotulo vf-ph-atualizar__rotulo--hover" aria-hidden="true">
            <span className="vf-ph-atualizar__icone">↻</span>
            {rotuloHover}
          </span>
        )}
      </span>
    </button>
  );
}

// Na âncora, só O QUE está acontecendo (período); a contagem de contas mora
// no botão ↻ — as duas peças juntas, sem repetir nenhuma.
function progressoTexto(job, competencia, competenciaAtual) {
  const mesCompleto = job ? job.periodo?.mesCompleto : competencia !== competenciaAtual;
  return mesCompleto ? "Reprocessando o mês" : "Atualizando até hoje";
}

// Desfecho da atualização com pendência ou falha: logo abaixo do cliente,
// visível mesmo com a linha recolhida — diz QUAL conta e POR QUÊ.
export function LinhaAtualizacao({ cliente, atualizacao, colSpan, onAtualizar, onDispensar }) {
  const { job, erro } = atualizacao;
  const rotuloConta = (id) => cliente.contas?.find((c) => c.id === id)?.rotulo || `Conta #${id}`;
  const pendentes = (job?.contas || []).filter((c) => c.estado !== "ok");
  const falhou = Boolean(erro) || job?.estado === "falhou";
  const titulo = erro
    ? `Não foi possível atualizar: ${erro.mensagem}`
    : `${falhou ? "Atualização falhou" : "Atualização concluída com pendências"}`
      + `${job?.concluidaEm ? ` às ${formatarDataHora(job.concluidaEm).slice(-5)}` : ""} · ${job?.mensagem || ""}`;
  const podeTentar = !erro || erro.status !== 403;
  return (
    <tr className={`vf-ph-row vf-ph-row--atualizacao ${falhou ? "is-falha" : "is-pendencia"}`}>
      <td colSpan={colSpan}>
        <div className="vf-ph-atualizacao" role="status">
          <p className="vf-ph-atualizacao__titulo">{titulo}</p>
          {pendentes.length > 0 && (
            <ul className="vf-ph-atualizacao__contas">
              {pendentes.map((c) => (
                <li key={c.contaId} className={`vf-ph-atualizacao__conta is-${c.estado}`}>
                  <span className="vf-ph-atualizacao__conta-rotulo">{rotuloConta(c.contaId)}</span>
                  {" — "}
                  {c.mensagem || (c.estado === "falha" ? "falhou" : "pendente")}
                </li>
              ))}
            </ul>
          )}
          <span className="vf-ph-atualizacao__acoes">
            {podeTentar && (
              <button type="button" className="vf-btn vf-btn--sm" onClick={() => onAtualizar(cliente.id)}>Tentar de novo</button>
            )}
            <button type="button" className="vf-btn vf-btn--ghost vf-btn--sm" onClick={() => onDispensar(cliente.id)}>Dispensar</button>
          </span>
        </div>
      </td>
    </tr>
  );
}

// Seta de expansão: traço, não glifo — nítida em qualquer fonte, e gira.
function Chevron({ aberto }) {
  return (
    <svg className="vf-ph-chevron" data-aberto={aberto ? "true" : "false"} aria-hidden="true" viewBox="0 0 12 12" focusable="false">
      <path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Área de expansão: o BOTÃO ocupa a célula inteira, não só o chevron.
function CelulaExpansivel({ aberto, onClick, rotuloAcessivel, nivel, children }) {
  return (
    <th scope="row" className="vf-table__sticky-cell vf-ph-ancora">
      <button
        type="button"
        className={`vf-ph-toggle vf-ph-toggle--${nivel}`}
        onClick={onClick}
        aria-expanded={aberto}
        aria-label={rotuloAcessivel}
      >
        <Chevron aberto={aberto} />
        <span className="vf-ph-ancora__conteudo">{children}</span>
      </button>
    </th>
  );
}

function LinhaEstado({ colSpan, children, tom = "" }) {
  return (
    <tr className={`vf-ph-row vf-ph-row--estado ${tom}`}>
      <td colSpan={colSpan}>{children}</td>
    </tr>
  );
}

// Loading da expansão como LINHAS de esqueleto: a tabela não salta.
function LinhasEsqueleto({ colSpan, linhas = 2, rotulo }) {
  return (
    <>
      {Array.from({ length: linhas }).map((_, i) => (
        <tr key={i} className="vf-ph-row vf-ph-row--esqueleto" aria-hidden={i > 0}>
          <td colSpan={colSpan}>
            {i === 0 && <span className="vf-visually-hidden">{rotulo}</span>}
            <span className="vf-skeleton vf-skeleton--row" />
          </td>
        </tr>
      ))}
    </>
  );
}

function LinhaErro({ colSpan, mensagem, onTentar }) {
  return (
    <tr className="vf-ph-row vf-ph-row--estado is-erro">
      <td colSpan={colSpan}>
        <span className="vf-ph-erro__texto">{mensagem}</span>
        <button type="button" className="vf-btn vf-btn--sm" onClick={onTentar}>Tentar novamente</button>
      </td>
    </tr>
  );
}

function textoAcoes(n) {
  return n === 1 ? "1 conta precisa de ação" : `${n} contas precisam de ação`;
}

// "Lançar dados" / "Editar dados": AÇÃO da conta — botão pequeno com borda,
// não texto solto. Editar (já existe lançamento) ganha o tom da marca.
function BotaoLancar({ rotulo, onClick, editar = false }) {
  return (
    <button
      type="button"
      className={`vf-btn vf-btn--sm vf-ph-lancar${editar ? " is-editar" : ""}`}
      onClick={onClick}
      aria-label={rotulo}
    >
      {editar ? "Editar dados" : "Lançar dados"}
    </button>
  );
}

function classeContexto(essencial) {
  return essencial ? "vf-ph-contexto vf-ph-dados-cel" : "vf-table__sticky-cell vf-ph-contexto";
}

function LinhaSemana({ semana, colunas, origem = "consolidado" }) {
  const essencial = useEssencial();
  const intervalo = `${String(semana.de).slice(8)}–${String(semana.ate).slice(8)}`;
  return (
    <tr className={`vf-ph-row vf-ph-row--semana vf-ph-row--semana-${origem}`}>
      <th scope="row" className="vf-table__sticky-cell vf-ph-ancora">
        <span className={`vf-ph-indent ${origem === "conta" ? "vf-ph-indent--2" : "vf-ph-indent--3"}`}>
          <span className="vf-ph-semana__rotulo">{semana.semana}</span>
          <span className="vf-ph-semana__dias">{intervalo}</span>
        </span>
      </th>
      {dispor(essencial, <td className={classeContexto(essencial)} />, colunas.map((c) => (
        <Celula key={c.chave} coluna={c} valor={semana.resumo?.[c.chave] ?? null} subValor={c.sub ? semana.resumo?.[c.sub.chave] ?? null : null} />
      )))}
    </tr>
  );
}

function LinhaMes({ clienteId, clienteNome, mes, selecionada, aberto, onAlternar, semanasPorChave, carregarSemanas, colunas }) {
  const essencial = useEssencial();
  const chave = `${clienteId}:${mes.competencia}`;
  const estado = semanasPorChave[chave];
  const colSpan = colunas.length + 2;
  const rotulo = rotularCompetenciaCurta(mes.competencia);

  useEffect(() => {
    if (aberto && !estado) carregarSemanas(clienteId, mes.competencia);
  }, [aberto, estado, carregarSemanas, clienteId, mes.competencia]);

  return (
    <>
      <tr className={`vf-ph-row vf-ph-row--mes${selecionada ? " is-selecionada" : ""}`}>
        <CelulaExpansivel
          aberto={aberto}
          onClick={onAlternar}
          nivel="mes"
          rotuloAcessivel={`Competência ${rotulo} de ${clienteNome} — ${aberto ? "recolher" : "expandir"} semanas`}
        >
          <span className="vf-ph-indent vf-ph-indent--2">
            <span className="vf-ph-mes__rotulo">{rotulo}</span>
            {selecionada && <span className="vf-ph-meta"> · selecionada</span>}
          </span>
        </CelulaExpansivel>
        {dispor(essencial, (
          <td className={classeContexto(essencial)}>
            {mes.sincronizadoEm && (
              <span className="vf-ph-meta" title={`Snapshot sincronizado em ${formatarDataHora(mes.sincronizadoEm)}`}>
                sync {formatarData(mes.sincronizadoEm)}
              </span>
            )}
          </td>
        ), colunas.map((c) => (
          <Celula
            key={c.chave}
            coluna={c}
            valor={mes.resumo?.[c.chave] ?? null}
            variacao={mes.variacaoVsMesAnterior?.[c.chave]}
            subValor={c.sub ? mes.resumo?.[c.sub.chave] ?? null : null}
          />
        )))}
      </tr>

      {aberto && estado?.carregando && <LinhasEsqueleto colSpan={colSpan} linhas={2} rotulo="Carregando semanas" />}
      {aberto && estado?.erro && !estado.carregando && (
        <LinhaErro
          colSpan={colSpan}
          mensagem={`Não foi possível carregar as semanas. ${estado.erro.mensagem}`}
          onTentar={() => carregarSemanas(clienteId, mes.competencia, { forcar: true })}
        />
      )}
      {aberto && estado?.semanas && estado.semanas.length === 0 && (
        <LinhaEstado colSpan={colSpan}>Sem dia sincronizado nesta competência.</LinhaEstado>
      )}
      {aberto && estado?.semanas?.map((s) => <LinhaSemana key={s.semana} semana={s} colunas={colunas} />)}
    </>
  );
}

// Estado da conta DENTRO de uma atualização em curso/terminada: só aparece
// quando diz algo (pendente = sincronizando agora; falha/parcial = por quê).
function EstadoNaAtualizacao({ estadoConta, emCurso }) {
  if (!estadoConta) return null;
  if (estadoConta.estado === "pendente" && emCurso) {
    return <span className="vf-ph-meta vf-ph-conta__sync"><span className="vf-spinner vf-spinner--sm vf-ph-spinner" aria-hidden="true" /> sincronizando…</span>;
  }
  if (estadoConta.estado === "falha") {
    return <span className="vf-ph-conta__sync is-falha" title={estadoConta.mensagem || undefined}>· falhou na atualização</span>;
  }
  return null;
}

// "Mercado Livre 1 · AMARO SOLUÇÕES" → canal em primeiro plano, operação em
// tom secundário. O texto é o mesmo rótulo do servidor, só em dois pesos.
function RotuloConta({ rotulo }) {
  const texto = String(rotulo ?? "");
  const i = texto.indexOf(" · ");
  if (i < 0) return <span className="vf-ph-conta__canal">{texto}</span>;
  return (
    <>
      <span className="vf-ph-conta__canal">{texto.slice(0, i)}</span>
      <span className="vf-ph-conta__operacao"> · {texto.slice(i + 3)}</span>
    </>
  );
}

// Manual lançado SOBRE o dado da API (modo manual): o servidor manda a
// referência automática guardada em `referenciaApi`.
export function manualSobreApi(conta) {
  return Boolean(conta?.referenciaApi) && conta?.fonte?.tipo === "manual";
}

const CAUSAS_TECNICAS = new Set(["sem_conexao", "erro_sync", "nao_publicado"]);

// Detalhe da conta (abre junto com as semanas): situação, origem, frescor,
// responsável, referência da API e as AÇÕES da conta. Só leitura do que a
// lista já trouxe — nenhuma requisição nova.
export function LinhaDetalheConta({ cliente, conta, colSpan, onLancar, children = null }) {
  const sobreApi = manualSobreApi(conta);
  const ref = conta.referenciaApi;
  const itens = [
    ["Situação", `${conta.status?.rotulo || "—"}${conta.status?.motivo && !["manual", "sincronizado"].includes(conta.status?.codigo) ? ` — ${conta.status.motivo}` : ""}`],
    ["Origem", conta.fonte ? (sobreApi ? "Manual sobre API (override)" : conta.fonte.rotulo) : "—"],
    ["Dados até", conta.dadosAte ? formatarData(conta.dadosAte) : "não informado"],
    ["Atualizado em", conta.atualizadoEm ? formatarDataHora(conta.atualizadoEm) : AUSENTE],
  ];
  if (conta.manual && conta.fonte?.tipo === "manual") itens.push(["Responsável", conta.manual.atualizadoPor || AUSENTE]);
  if (sobreApi) {
    itens.push([`${ref.rotulo || "API"} (referência)`, [
      `FAT ${formatarMoeda(ref.fat, { casas: 0 })}`,
      ref.mc != null ? `MC ${formatarPercentual(ref.mc)}` : null,
      ref.dadosAte ? `até ${formatarData(ref.dadosAte).slice(0, 5)}` : null,
    ].filter(Boolean).join(" · ")]);
  }
  const acoes = [];
  if (conta.ativa && conta.podeLancarManual) {
    if (!conta.resumo) {
      acoes.push({ chave: "lancar", rotulo: CAUSAS_TECNICAS.has(conta.status?.codigo) ? "Lançar como contingência" : "Lançar dados", primario: true });
    } else if (conta.fonte?.tipo === "manual") {
      acoes.push({ chave: "editar", rotulo: "Editar lançamento" });
    } else {
      acoes.push({ chave: "corrigir", rotulo: "Corrigir com lançamento manual", titulo: "Cria um lançamento manual que prevalece sobre a API (modo manual); a API continua guardada" });
    }
    if (sobreApi) acoes.push({ chave: "voltar", rotulo: "Voltar ao automático", fantasma: true, intencao: "remover" });
  }
  const codigo = conta.status?.codigo;
  return (
    <tr className="vf-ph-row vf-ph-row--detalhe-conta">
      <td colSpan={colSpan}>
        <div className="vf-ph-det" data-testid={`detalhe-conta-${conta.id}`}>
          <dl className="vf-ph-det__grid">
            {itens.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
          </dl>
          {conta.manual?.observacao && conta.fonte?.tipo === "manual" && (
            <p className="vf-ph-det__nota">“{conta.manual.observacao}”</p>
          )}
          {conta.avisos?.length > 0 && <p className="vf-ph-det__nota">⚠ {conta.avisos.join(" · ")}</p>}
          {(acoes.length > 0 || CAUSAS_TECNICAS.has(codigo)) && (
            <div className="vf-ph-det__acoes">
              {acoes.map((a) => (
                <button
                  key={a.chave}
                  type="button"
                  className={`vf-btn vf-btn--sm${a.primario ? " vf-btn--primary" : ""}${a.fantasma ? " vf-btn--ghost" : ""}`}
                  title={a.titulo}
                  onClick={() => onLancar(cliente, conta, a.intencao || null)}
                >
                  {a.rotulo}
                </button>
              ))}
              {codigo === "sem_conexao" && (
                <a className="vf-btn vf-btn--ghost vf-btn--sm" href="clientes.html">Conectar em Clientes e Contas ↗</a>
              )}
              {(codigo === "erro_sync" || codigo === "nao_publicado") && (
                <a className="vf-btn vf-btn--ghost vf-btn--sm" href="financeiro-v3.html">Ver sincronização no Financeiro ↗</a>
              )}
            </div>
          )}
          {children}
        </div>
      </td>
    </tr>
  );
}

function LinhaConta({
  cliente, competencia, conta, colunas, onLancar, atualizacao,
  aberto, onAlternar, estadoSemanas, carregarSemanasContas,
}) {
  const semDado = !conta.resumo;
  const manualSubstituido = conta.manual?.substituidoPorAutomatico;
  const adsPorCliente = conta.fonte?.tipo !== "manual";
  const estadoConta = atualizacao?.job?.contas?.find((c) => c.contaId === conta.id) || null;
  // Motivo só quando acrescenta: "Sem integração" já diz o que o motivo diria,
  // e a conta sincronizando AGORA mostra isso, não o erro da rodada anterior.
  const sincronizandoAgora = estadoConta?.estado === "pendente" && atualizacaoEmCurso(atualizacao);
  const motivo = semDado && !sincronizandoAgora && conta.status?.motivo && conta.status.codigo !== "sem_integracao"
    ? conta.status.motivo
    : null;
  const essencial = useEssencial();
  const colSpan = colunas.length + 2;
  const semanasConta = estadoSemanas?.contas?.find((item) => Number(item.contaId) === Number(conta.id))?.semanas;

  useEffect(() => {
    if (aberto && !estadoSemanas) carregarSemanasContas(cliente.id, competencia);
  }, [aberto, estadoSemanas, carregarSemanasContas, cliente.id, competencia]);

  const metaConta = (
    <span className="vf-ph-conta__meta">
      <StatusCompacto
        status={conta.status}
        rotulo={manualSobreApi(conta) ? "Manual sobre API" : undefined}
        titulo={manualSobreApi(conta)
          ? `${conta.referenciaApi.rotulo || "API"}: FAT ${formatarMoeda(conta.referenciaApi.fat, { casas: 0 })} · o lançamento manual prevalece (modo manual)`
          : undefined}
      />
      {motivo && <span className="vf-ph-meta vf-ph-conta__motivo">· {motivo}</span>}
      {!semDado && conta.dadosAte && (
        <span
          className="vf-ph-meta"
          title={`Dados até ${formatarData(conta.dadosAte)}${conta.atualizadoEm ? ` · atualizado ${formatarDataHora(conta.atualizadoEm)}` : ""}`}
        >
          · dados até {dataCurta(conta.dadosAte, competencia)}
        </span>
      )}
      {conta.avisos?.length > 0 && (
        <VFTooltip content={conta.avisos.join("\n")}>
          <span className="vf-ph-aviso" tabIndex={0} aria-label={conta.avisos.join(". ")}>⚠</span>
        </VFTooltip>
      )}
      <EstadoNaAtualizacao estadoConta={estadoConta} emCurso={atualizacaoEmCurso(atualizacao)} />
      {manualSubstituido && (
        <span
          className="vf-ph-meta"
          title={`Lançamento manual guardado (FAT ${formatarMoeda(conta.manual.valores?.fat, { casas: 0 })}${conta.manual.atualizadoPor ? `, por ${conta.manual.atualizadoPor}` : ""}) — o dado automático é o exibido.`}
        >
          · manual substituído pelo automático
        </span>
      )}
    </span>
  );
  // Na linha só "Lançar dados" (sem dado) e "Editar dados" (manual); corrigir
  // um dado da API por cima mora no detalhe da conta.
  const botaoLancar = conta.podeLancarManual && (!conta.resumo || conta.fonte?.tipo === "manual") && (
    <BotaoLancar
      rotulo={`${conta.fonte?.tipo === "manual" ? "Editar dados" : "Lançar dados"} — ${conta.rotulo}`}
      editar={conta.fonte?.tipo === "manual"}
      onClick={() => onLancar(cliente, conta)}
    />
  );

  return (
    <>
      <tr className={`vf-ph-row vf-ph-row--conta${semDado ? " is-sem-dado" : ""}${conta.ativa ? "" : " is-inativa"}${conta.precisaAcao ? " is-acao" : ""}${aberto ? " is-aberta" : ""}`}>
        <CelulaExpansivel
          aberto={aberto}
          onClick={onAlternar}
          nivel="conta"
          rotuloAcessivel={`Conta ${conta.rotulo} — ${aberto ? "recolher" : "expandir"} semanas`}
        >
          <span className="vf-ph-indent">
            <span className="vf-ph-conta__rotulo" title={conta.rotulo}><RotuloConta rotulo={conta.rotulo} /></span>
            {!essencial && metaConta}
          </span>
        </CelulaExpansivel>
        {dispor(essencial, (
          <td className={classeContexto(essencial)}>
            {essencial ? (
              <span className="vf-ph-dados">
                <span className="vf-ph-pips" aria-hidden="true"><i className={`vf-ph-pip is-${pipConta(conta).classe}`} /></span>
                <span className="vf-ph-dados__txt">{metaConta}</span>
                {/* A origem da conta já está no estado (Sincronizado = API ·
                    Manual = lançado); aqui sobra espaço para o motivo. */}
                {botaoLancar && <span className="vf-ph-dados__acoes">{botaoLancar}</span>}
              </span>
            ) : (
              <span className="vf-ph-contexto__linha vf-ph-contexto__conta">
                <Origem fonte={conta.fonte} vazio={null} />
                {botaoLancar}
              </span>
            )}
          </td>
        ), colunas.map((c) => {
          const semAdsPorConta = c.grupo === "ads" && adsPorCliente;
          return (
            <Celula
              key={c.chave}
              coluna={c}
              valor={semAdsPorConta ? null : conta.resumo?.[c.chave] ?? null}
              titulo={semAdsPorConta ? NOTA_ADS_POR_CONTA : undefined}
              rotuloAusente={semAdsPorConta && c.chave === "ads" && conta.resumo ? "no cliente" : null}
              custos={conta.custos}
              manual={conta.fonte?.tipo === "manual"}
              subValor={c.sub && !semAdsPorConta ? conta.resumo?.[c.sub.chave] ?? null : null}
            />
          );
        }))}
      </tr>
      {aberto && <LinhaDetalheConta cliente={cliente} conta={conta} colSpan={colSpan} onLancar={onLancar} />}
      {aberto && estadoSemanas?.carregando && <LinhasEsqueleto colSpan={colSpan} linhas={2} rotulo="Carregando semanas da conta" />}
      {aberto && estadoSemanas?.erro && !estadoSemanas.carregando && (
        <LinhaErro
          colSpan={colSpan}
          mensagem={`Não foi possível carregar as semanas da conta. ${estadoSemanas.erro.mensagem}`}
          onTentar={() => carregarSemanasContas(cliente.id, competencia, { forcar: true })}
        />
      )}
      {aberto && Array.isArray(semanasConta) && semanasConta.length === 0 && (
        <LinhaEstado colSpan={colSpan}>Sem dados semanais reais para esta conta na competência.</LinhaEstado>
      )}
      {aberto && semanasConta?.map((semana) => (
        <LinhaSemana key={semana.semana} semana={semana} colunas={colunas} origem="conta" />
      ))}
    </>
  );
}

// Detalhes do cliente aberto: "Composição do faturamento" e "Consolidado
// semanal" são DUAS ações de uma mesma linha de ferramentas, logo abaixo das
// contas — não duas linhas de tabela vazias. Cada botão abre o seu bloco
// embaixo (composição primeiro, histórico depois), e ambos são lazy.
function BotaoDetalhe({ aberto, onClick, rotuloAcessivel, children }) {
  return (
    <button
      type="button"
      className={`vf-ph-detalhe${aberto ? " is-aberto" : ""}`}
      onClick={onClick}
      aria-expanded={aberto}
      aria-label={rotuloAcessivel}
    >
      <Chevron aberto={aberto} />
      {children}
    </button>
  );
}

function LinhaFerramentas({ cliente, colSpan, composicao, historico }) {
  return (
    <tr className="vf-ph-row vf-ph-row--historico vf-ph-row--ferramentas">
      <td colSpan={colSpan}>
        <div className="vf-ph-ferramentas">
          {composicao && (
            <BotaoDetalhe
              aberto={composicao.aberto}
              onClick={composicao.onAlternar}
              rotuloAcessivel={`Composição do faturamento de ${cliente.nome} por conta — ${composicao.aberto ? "recolher" : "expandir"}`}
            >
              <span className="vf-ph-historico__rotulo">Composição do faturamento</span>
              <span className="vf-ph-meta">por conta</span>
            </BotaoDetalhe>
          )}
          {historico && (
            <BotaoDetalhe
              aberto={historico.aberto}
              onClick={historico.onAlternar}
              rotuloAcessivel={`Consolidado semanal do cliente ${cliente.nome} — ${historico.aberto ? "recolher" : "expandir"} histórico`}
            >
              <span className="vf-ph-historico__rotulo">Consolidado semanal do cliente</span>
              <span className="vf-ph-meta">histórico mensal</span>
            </BotaoDetalhe>
          )}
        </div>
      </td>
    </tr>
  );
}

// Composição do faturamento: demonstrativo por conta (lazy). Só existe
// quando alguma conta ativa tem pedidos importados — conta manual não tem
// pedido para compor.
export function temComposicao(cliente) {
  return (cliente.contas || []).some((c) => c.ativa && c.importId != null);
}

function LinhasComposicao({ cliente, competencia, aberto, estado, carregar, colSpan }) {
  useEffect(() => {
    if (aberto && !estado) carregar(cliente.id, competencia);
  }, [aberto, estado, carregar, cliente.id, competencia]);

  if (!aberto) return null;
  return (
    <>
      {estado?.carregando && <LinhasEsqueleto colSpan={colSpan} linhas={1} rotulo="Carregando composição do faturamento" />}
      {estado?.erro && !estado.carregando && (
        <LinhaErro
          colSpan={colSpan}
          mensagem={`Não foi possível carregar a composição. ${estado.erro.mensagem}`}
          onTentar={() => carregar(cliente.id, competencia, { forcar: true })}
        />
      )}
      {estado?.contas && !estado.carregando && (
        <tr className="vf-ph-row vf-ph-row--composicao">
          <td colSpan={colSpan}>
            <DemonstrativoComposicao contas={estado.contas} somaDasContas={estado.somaDasContas} competencia={competencia} />
          </td>
        </tr>
      )}
    </>
  );
}

// Segunda linha do cliente: estado compacto + UMA frase de ação/motivo.
// Nunca repete o que o escopo (linha de cima) ou o contexto (ao lado) já diz.
// Mora DENTRO do botão da âncora — por isso "N contas precisam de ação" é
// texto, não outro botão: clicar nele já abre o cliente e mostra as contas.
// Sem dado, o motivo/ação desce para uma linha própria — ele é a informação
// da linha, então não pode ser o primeiro a ser cortado:
//   Cliente X            Mercado Livre 1 · LOJA
//   ○ Sem dados em set/2026
//   Mercado Livre não conectado · último dado: ago/2026
function MetaCliente({ cliente, competencia, competenciaAtual, atualizacao, essencial = false }) {
  const emCurso = atualizacaoEmCurso(atualizacao);
  const acoes = cliente.escopo?.contasPrecisamAcao
    ?? (cliente.contas || []).filter((c) => c.precisaAcao).length;
  const semDado = !cliente.resumo;
  const ultimo = semDado && cliente.ultimaCompetenciaComDado && cliente.ultimaCompetenciaComDado !== competencia
    ? cliente.ultimaCompetenciaComDado
    : null;

  let detalhe = null;
  if (emCurso) {
    detalhe = <span className="vf-ph-progresso">{progressoTexto(atualizacao.job, competencia, competenciaAtual)}</span>;
  } else if (acoes > 0) {
    detalhe = <span className="vf-ph-acoes">{textoAcoes(acoes)}</span>;
  } else if (semDado && cliente.status?.motivo) {
    detalhe = <span className="vf-ph-motivo" title={cliente.status.motivo}>{cliente.status.motivo}</span>;
  }

  const situacao = essencial ? rotuloSituacao(cliente, competencia) : null;
  const status = essencial ? (
    <span className={`vf-ph-situacao is-${situacao.tom}`} title={cliente.status?.motivo || cliente.status?.rotulo || undefined}>
      {situacao.texto}
    </span>
  ) : (
    <StatusCompacto
      status={cliente.status}
      rotulo={semDado && cliente.status?.codigo === "sem_dados" ? `Sem dados em ${rotularCompetenciaCurta(competencia)}` : undefined}
    />
  );
  const ultimoDado = ultimo && <span className="vf-ph-meta vf-ph-ultimo">último dado: {rotularCompetenciaCurta(ultimo)}</span>;
  const dadosAte = !semDado && cliente.dadosAte && (
    <span className="vf-ph-meta vf-ph-dados-ate" title={`Dados até ${formatarData(cliente.dadosAte)}`}>
      dados até {dataCurta(cliente.dadosAte, competencia)}
    </span>
  );

  if (semDado) {
    return (
      <span className="vf-ph-cliente__meta vf-ph-cliente__meta--vazio">
        <span className="vf-ph-cliente__meta-linha">{status}</span>
        {(detalhe || ultimoDado) && <span className="vf-ph-cliente__meta-linha">{detalhe}{ultimoDado}</span>}
      </span>
    );
  }
  // Com dado: estado · dados até numa linha; o que FAZER (ou o progresso da
  // atualização) ganha a linha de baixo — nunca é cortado nem quebra no meio.
  return (
    <span className="vf-ph-cliente__meta vf-ph-cliente__meta--empilhado">
      <span className="vf-ph-cliente__meta-linha">{status}{dadosAte}</span>
      {detalhe && <span className="vf-ph-cliente__meta-linha">{detalhe}</span>}
    </span>
  );
}

function LinhaCliente({
  cliente, competencia, competenciaAtual, expansao,
  mesesPorCliente, carregarMeses, semanasPorChave, carregarSemanas,
  semanasContasPorCliente, carregarSemanasContas,
  composicaoPorCliente = {}, carregarComposicao = () => {},
  colunas, onLancar, atualizacao, podeAtualizar, onAtualizar, onDispensar,
  mostrarHistoricoCliente = true, agrupado = false, fracaoFat = null, destaque = false,
}) {
  const essencial = useEssencial();
  const aberto = expansao.clientesAbertos.has(cliente.id);
  // O histórico mensal é o snapshot CONSOLIDADO do cliente (Central/ML): numa
  // seção Shopee/TikTok ele mostraria número de outro marketplace.
  const historicoAberto = mostrarHistoricoCliente && expansao.historicosAbertos.has(cliente.id);
  const estado = mesesPorCliente[cliente.id];
  const estadoSemanasContas = semanasContasPorCliente[`${cliente.id}:${competencia}`];
  const colSpan = colunas.length + 2;
  const semDado = !cliente.resumo;
  const emCurso = atualizacaoEmCurso(atualizacao);
  const job = atualizacao?.job;
  const mostrarDesfecho = !emCurso && atualizacao
    && (atualizacao.erro || job?.estado === "falhou" || job?.estado === "concluida_com_pendencias");

  // Lazy de verdade: o histórico nasce de a linha de HISTÓRICO estar aberta.
  useEffect(() => {
    if (aberto && historicoAberto && !estado) carregarMeses(cliente.id);
  }, [aberto, historicoAberto, estado, carregarMeses, cliente.id]);

  return (
    <>
      <tr
        id={`vf-ph-cliente-${cliente.id}`}
        className={`vf-ph-row vf-ph-row--cliente${semDado ? " is-sem-dado" : ""}${cliente.status?.precisaAtencao ? " is-atencao" : ""}${emCurso ? " is-atualizando-linha" : ""}${aberto ? " is-aberto" : ""}${destaque ? " is-destaque" : ""}`}
      >
        <CelulaExpansivel
          aberto={aberto}
          onClick={() => expansao.alternarCliente(cliente.id)}
          nivel="cliente"
          rotuloAcessivel={`Cliente ${cliente.nome} — ${aberto ? "recolher" : "expandir"} contas`}
        >
          <span className="vf-ph-cliente">
            <span className="vf-ph-cliente__linha">
              <span className="vf-ph-cliente__nome">{cliente.nome}</span>
              {!essencial && cliente.escopo?.rotulo && <span className="vf-ph-escopo">{cliente.escopo.rotulo}</span>}
            </span>
            {essencial
              ? <span className="vf-ph-cliente__comp" title={cliente.escopo?.rotulo || undefined}>{composicaoContas(cliente)}</span>
              : <MetaCliente cliente={cliente} competencia={competencia} competenciaAtual={competenciaAtual} atualizacao={atualizacao} />}
          </span>
        </CelulaExpansivel>

        {dispor(essencial, essencial ? (
          <td className={classeContexto(true)}>
            <span className="vf-ph-dados">
              <Pips contas={cliente.contas} />
              <span className="vf-ph-dados__txt">
                <MetaCliente cliente={cliente} competencia={competencia} competenciaAtual={competenciaAtual} atualizacao={atualizacao} essencial />
                <span className="vf-ph-dados__origem">
                  {!agrupado && (cliente.squad
                    ? <span className={`vf-tag vf-ph-tag ${TOM_SQUAD}`} title={`Squad: ${cliente.squad.nome}`}>{cliente.squad.nome}</span>
                    : <span className="vf-ph-meta is-vazio">sem squad</span>)}
                  {cliente.fonte && <Origem fonte={cliente.fonte} />}
                  {(cliente.atualizadoEm || job?.estado === "concluida") && (
                    <FrescorCliente cliente={cliente} concluidaAgora={job?.estado === "concluida"} />
                  )}
                </span>
              </span>
              {podeAtualizar && (
                <span className="vf-ph-dados__acoes">
                  <BotaoAtualizar
                    cliente={cliente}
                    competencia={competencia}
                    competenciaAtual={competenciaAtual}
                    atualizacao={atualizacao}
                    onAtualizar={onAtualizar}
                  />
                </span>
              )}
            </span>
          </td>
        ) : (
          <td className="vf-table__sticky-cell vf-ph-contexto">
            <span className="vf-ph-contexto__linha vf-ph-contexto__topo">
              {cliente.squad
                ? <span className={`vf-tag vf-ph-tag ${TOM_SQUAD}`} title={`Squad: ${cliente.squad.nome}`}>{cliente.squad.nome}</span>
                : <span className="vf-ph-meta is-vazio">sem squad</span>}
              <Origem fonte={cliente.fonte} />
              {podeAtualizar && (
                <BotaoAtualizar
                  cliente={cliente}
                  competencia={competencia}
                  competenciaAtual={competenciaAtual}
                  atualizacao={atualizacao}
                  onAtualizar={onAtualizar}
                />
              )}
            </span>
            <FrescorCliente cliente={cliente} concluidaAgora={job?.estado === "concluida"} />
          </td>
        ), colunas.map((c) => (
          <Celula
            key={c.chave}
            coluna={c}
            valor={cliente.resumo?.[c.chave] ?? null}
            custos={cliente.custos}
            subValor={c.sub ? cliente.resumo?.[c.sub.chave] ?? null : null}
            fracao={c.barra ? fracaoFat : null}
          />
        )))}
      </tr>

      {mostrarDesfecho && (
        <LinhaAtualizacao
          cliente={cliente}
          atualizacao={atualizacao}
          colSpan={colSpan}
          onAtualizar={onAtualizar}
          onDispensar={onDispensar}
        />
      )}

      {aberto && cliente.contas?.map((conta) => (
        <LinhaConta
          key={conta.id}
          cliente={cliente}
          competencia={competencia}
          conta={conta}
          colunas={colunas}
          onLancar={onLancar}
          atualizacao={atualizacao}
          aberto={expansao.contasAbertas.has(`${cliente.id}:${conta.id}`)}
          onAlternar={() => expansao.alternarConta(cliente.id, conta.id)}
          estadoSemanas={estadoSemanasContas}
          carregarSemanasContas={carregarSemanasContas}
        />
      ))}
      {aberto && (!cliente.contas || cliente.contas.length === 0) && (
        <LinhaEstado colSpan={colSpan}>
          Nenhuma conta/operação cadastrada — cadastre a operação em <a href="clientes.html">Clientes</a> para separar o número por conta.
        </LinhaEstado>
      )}
      {aberto && (temComposicao(cliente) || mostrarHistoricoCliente) && (
        <LinhaFerramentas
          cliente={cliente}
          colSpan={colSpan}
          composicao={temComposicao(cliente) && {
            aberto: expansao.composicoesAbertas.has(cliente.id),
            onAlternar: () => expansao.alternarComposicao(cliente.id),
          }}
          historico={mostrarHistoricoCliente && {
            aberto: historicoAberto,
            onAlternar: () => expansao.alternarHistorico(cliente.id),
          }}
        />
      )}
      {aberto && temComposicao(cliente) && (
        <LinhasComposicao
          cliente={cliente}
          competencia={competencia}
          aberto={expansao.composicoesAbertas.has(cliente.id)}
          estado={composicaoPorCliente[`${cliente.id}:${competencia}`]}
          carregar={carregarComposicao}
          colSpan={colSpan}
        />
      )}
      {aberto && historicoAberto && estado?.carregando && (
        <LinhasEsqueleto colSpan={colSpan} linhas={3} rotulo="Carregando histórico" />
      )}
      {aberto && historicoAberto && estado?.erro && !estado.carregando && (
        <LinhaErro
          colSpan={colSpan}
          mensagem={`Não foi possível carregar o histórico. ${estado.erro.mensagem}`}
          onTentar={() => carregarMeses(cliente.id, { forcar: true })}
        />
      )}
      {aberto && historicoAberto && estado?.meses && estado.meses.length === 0 && (
        <LinhaEstado colSpan={colSpan}>Sem competência sincronizada em {String(competencia).slice(0, 4)}.</LinhaEstado>
      )}
      {aberto && historicoAberto && estado?.meses?.map((mes) => (
        <LinhaMes
          key={mes.competencia}
          clienteId={cliente.id}
          clienteNome={cliente.nome}
          mes={mes}
          selecionada={mes.competencia === competencia}
          aberto={expansao.mesesAbertos.has(`${cliente.id}:${mes.competencia}`)}
          onAlternar={() => expansao.alternarMes(cliente.id, mes.competencia)}
          semanasPorChave={semanasPorChave}
          carregarSemanas={carregarSemanas}
          colunas={colunas}
        />
      ))}
    </>
  );
}

// ── Expansão ────────────────────────────────────────────────────────────────
// Estado elevado para fora das linhas porque "Recolher tudo" precisa alcançar
// todas de uma vez. Recolher é 100% local: não cancela, não descarta cache e
// não dispara requisição nenhuma.
function alternarEm(setter, chave) {
  setter((prev) => {
    const proximo = new Set(prev);
    if (proximo.has(chave)) proximo.delete(chave);
    else proximo.add(chave);
    return proximo;
  });
}

export function useExpansao() {
  const [clientesAbertos, setClientesAbertos] = useState(() => new Set());
  const [contasAbertas, setContasAbertas] = useState(() => new Set());
  const [historicosAbertos, setHistoricosAbertos] = useState(() => new Set());
  const [mesesAbertos, setMesesAbertos] = useState(() => new Set());
  const [composicoesAbertas, setComposicoesAbertas] = useState(() => new Set());

  const alternarCliente = useCallback((id) => alternarEm(setClientesAbertos, id), []);
  const alternarConta = useCallback((clienteId, contaId) => alternarEm(setContasAbertas, `${clienteId}:${contaId}`), []);
  const alternarHistorico = useCallback((id) => alternarEm(setHistoricosAbertos, id), []);
  const alternarMes = useCallback((clienteId, competencia) => alternarEm(setMesesAbertos, `${clienteId}:${competencia}`), []);
  const alternarComposicao = useCallback((id) => alternarEm(setComposicoesAbertas, id), []);

  // "Abrir pendentes": abre de uma vez os clientes indicados (as contas já
  // vieram na lista — nenhuma requisição).
  const abrirClientes = useCallback((ids) => {
    setClientesAbertos((prev) => {
      const proximo = new Set(prev);
      for (const id of ids) proximo.add(id);
      return proximo;
    });
  }, []);

  const recolherTudo = useCallback(() => {
    setClientesAbertos(new Set());
    setContasAbertas(new Set());
    setHistoricosAbertos(new Set());
    setMesesAbertos(new Set());
    setComposicoesAbertas(new Set());
  }, []);

  return {
    clientesAbertos, contasAbertas, historicosAbertos, mesesAbertos, composicoesAbertas,
    alternarCliente, alternarConta, alternarHistorico, alternarMes, alternarComposicao, recolherTudo, abrirClientes,
    temExpandido: clientesAbertos.size > 0,
  };
}

// ── Ordenação ───────────────────────────────────────────────────────────────
// Client-side, sobre a lista JÁ carregada, e SÓ no nível cliente: contas
// acompanham o cliente e meses são cronológicos por natureza.
function compararTexto(a, b) {
  return String(a || "").localeCompare(String(b || ""), "pt-BR", { sensitivity: "base" });
}

export function ordenarClientes(clientes, ordem) {
  if (!ordem?.chave) return clientes;
  const { chave, ascendente } = ordem;
  const fator = ascendente ? 1 : -1;

  return [...clientes].sort((a, b) => {
    if (chave === "nome") return compararTexto(a.nome, b.nome) * fator;
    if (chave === "squad") {
      if (!a.squad && !b.squad) return compararTexto(a.nome, b.nome);
      if (!a.squad) return 1;
      if (!b.squad) return -1;
      const porSquad = compararTexto(a.squad.nome, b.squad.nome) * fator;
      return porSquad !== 0 ? porSquad : compararTexto(a.nome, b.nome);
    }
    // Ausência de dado nunca disputa posição: vai para o fim nos dois sentidos.
    const va = a.resumo?.[chave];
    const vb = b.resumo?.[chave];
    const aAusente = ehAusente(va);
    const bAusente = ehAusente(vb);
    if (aAusente && bAusente) return compararTexto(a.nome, b.nome);
    if (aAusente) return 1;
    if (bAusente) return -1;
    if (Number(va) === Number(vb)) return compararTexto(a.nome, b.nome);
    return (Number(va) - Number(vb)) * fator;
  });
}

function BotaoOrdenar({ chave, label, titulo, ordem, onOrdenar }) {
  const ativo = ordem?.chave === chave;
  const classe = ativo ? (ordem.ascendente ? "is-asc" : "is-desc") : "";
  return (
    <button
      type="button"
      className={`vf-table__sort ${classe}`}
      onClick={() => onOrdenar(chave)}
      aria-label={`Ordenar clientes por ${titulo || label}`}
      title={titulo}
    >
      <span>{label}</span>
    </button>
  );
}

export function TabelaHierarquica({
  clientes, competencia, competenciaAtual = competencia, colunas: colunasProp, grupos, expansao,
  mesesPorCliente, carregarMeses, semanasPorChave, carregarSemanas,
  semanasContasPorCliente = {}, carregarSemanasContas = () => {},
  composicaoPorCliente = {}, carregarComposicao = () => {},
  atualizando, onLancar = () => {},
  atualizacoes = {}, podeAtualizar = false, onAtualizar = () => {}, onDispensarAtualizacao = () => {},
  mostrarHistoricoCliente = true,
  // V4: "essencial" (worklist, página rola com cabeçalho preso) ou
  // "detalhada" (tabela por grupos, rolagem interna — o comportamento de
  // antes). `agruparPorSquad` só agrupa a lista já carregada.
  vista = "detalhada", agruparPorSquad = false, destaqueId = null,
}) {
  const essencial = vista === "essencial";
  // `inicioGrupo` é só apresentação (divisor vertical entre grupos, do
  // cabeçalho ao corpo); a lista e a ordem das colunas não mudam.
  const colunas = useMemo(
    () => (essencial ? COLUNAS_ESSENCIAIS : colunasProp ?? colunasVisiveis(grupos)).map((c, i, todas) => ({
      ...c,
      inicioGrupo: !essencial && i > 0 && todas[i - 1].grupo !== c.grupo,
    })),
    [essencial, colunasProp, grupos],
  );
  const cabecalhoGrupos = useMemo(() => gruposVisiveis(grupos), [grupos]);
  const [ordem, setOrdem] = useState(null);

  const ordenados = useMemo(() => ordenarClientes(clientes, ordem), [clientes, ordem]);

  // Barra discreta sob o FAT: proporção do maior FAT DA LISTA na tela — só
  // apresentação, o número exibido continua o do servidor.
  const maiorFat = useMemo(() => {
    let max = 0;
    for (const c of clientes) {
      const v = Number(c.resumo?.fat);
      if (Number.isFinite(v) && v > max) max = v;
    }
    return max;
  }, [clientes]);

  const grupoDeSquad = useMemo(() => {
    if (!agruparPorSquad) return null;
    const mapa = new Map();
    for (const c of ordenados) {
      const chave = c.squad?.id ?? "sem";
      if (!mapa.has(chave)) mapa.set(chave, { chave, nome: c.squad?.nome || "Sem squad", clientes: [] });
      mapa.get(chave).clientes.push(c);
    }
    // Ordem estável do cadastro (id do Squad); "sem squad" por último.
    return [...mapa.values()].sort((a, b) => {
      if (a.chave === "sem") return 1;
      if (b.chave === "sem") return -1;
      return Number(a.chave) - Number(b.chave) || compararTexto(a.nome, b.nome);
    });
  }, [agruparPorSquad, ordenados]);
  const [gruposFechados, setGruposFechados] = useState(() => new Set());
  const alternarGrupoSquad = useCallback((chave) => alternarEm(setGruposFechados, chave), []);

  const ordenar = useCallback((chave) => {
    setOrdem((prev) => {
      if (prev?.chave !== chave) return { chave, ascendente: chave === "nome" || chave === "squad" };
      if (prev.ascendente !== (chave === "nome" || chave === "squad")) return null; // 3º clique: ordem do servidor
      return { chave, ascendente: !prev.ascendente };
    });
  }, []);

  // A segunda linha do cabeçalho gruda logo abaixo da primeira — altura medida.
  const linhaGrupoRef = useRef(null);
  const [alturaGrupo, setAlturaGrupo] = useState(0);
  useLayoutEffect(() => {
    const el = linhaGrupoRef.current;
    if (!el) return undefined;
    const medir = () => setAlturaGrupo(el.getBoundingClientRect().height);
    medir();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observador = new ResizeObserver(medir);
    observador.observe(el);
    return () => observador.disconnect();
  }, [cabecalhoGrupos.length]);

  // Altura do corpo rolável MEDIDA: tudo o que vem depois da tabela na
  // página (borda do painel, rodapé, respiro) é descontado — a página não
  // rola, só a tabela. Também publica a largura VISÍVEL do wrapper
  // (--vf-ph-viewport): o detalhe da composição ocupa a área visível, não a
  // largura inteira da tabela quando há scroll horizontal.
  const wrapRef = useRef(null);
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return undefined;
    // Vista essencial: a PÁGINA rola (filtros e cabeçalho presos); sem altura
    // máxima medida.
    if (essencial) {
      wrap.style.maxHeight = "";
      wrap.style.setProperty("--vf-ph-viewport", `${wrap.clientWidth}px`);
      return undefined;
    }
    const ajustar = () => {
      wrap.style.maxHeight = "";
      wrap.style.setProperty("--vf-ph-viewport", `${wrap.clientWidth}px`);
      const caixa = wrap.getBoundingClientRect();
      const topoNoDocumento = caixa.top + window.scrollY;
      // Sobe do wrapper até a página somando o que vem DEPOIS em cada nível
      // (irmãos seguintes + padding/borda de baixo do contêiner). Não depende
      // de quem rola (janela ou o `main` do Shell).
      let depoisDaTabela = 0;
      for (let el = wrap; el && el.parentElement && !el.classList.contains("vf-ph-shell"); el = el.parentElement) {
        const pai = window.getComputedStyle(el.parentElement);
        const vao = parseFloat(pai.rowGap) || 0;
        for (let irmao = el.nextElementSibling; irmao; irmao = irmao.nextElementSibling) {
          const estilo = window.getComputedStyle(irmao);
          if (estilo.display === "none" || estilo.position === "fixed" || estilo.position === "absolute") continue;
          depoisDaTabela += irmao.getBoundingClientRect().height + (parseFloat(estilo.marginTop) || 0) + vao;
        }
        depoisDaTabela += (parseFloat(pai.paddingBottom) || 0) + (parseFloat(pai.borderBottomWidth) || 0);
      }
      const respiro = 8;
      const disponivel = window.innerHeight - topoNoDocumento - depoisDaTabela - respiro;
      wrap.style.maxHeight = `${Math.max(260, Math.round(disponivel))}px`;
    };
    ajustar();
    // As fontes web mudam a altura do que vem antes da tabela (a barra pode
    // quebrar linha): mede de novo quando terminam de carregar.
    let vivo = true;
    document.fonts?.ready?.then(() => { if (vivo) ajustar(); });
    window.addEventListener("resize", ajustar);
    return () => {
      vivo = false;
      window.removeEventListener("resize", ajustar);
    };
  });

  return (
    <VistaContext.Provider value={essencial ? "essencial" : "detalhada"}>
    <div ref={wrapRef} className={`vf-table-wrap vf-ph-wrap${atualizando ? " is-atualizando" : ""}${essencial ? " is-pagina" : ""}`}>
      <table
        className={`vf-table vf-table--compact vf-ph-table${podeAtualizar ? " tem-atualizar" : ""}${essencial ? " vf-ph-table--essencial" : ""}`}
        style={{ "--vf-ph-head-2": `${alturaGrupo}px` }}
      >
        <caption className="vf-visually-hidden">
          Clientes da carteira na competência selecionada. Cada linha é o número consolidado do cliente; ao expandir,
          aparecem as contas/operações expansíveis por semana e o histórico do consolidado semanal do cliente.
        </caption>
        {essencial ? (
          <>
            <colgroup>
              <col className="vf-ph-colw--ancora" />
              {colunas.map((c) => <col key={c.chave} className={`vf-ph-colw--${c.chave}`} />)}
              <col className="vf-ph-colw--dados" />
            </colgroup>
            <thead>
              <tr className="vf-ph-thead-metricas">
                <th scope="col" className="vf-ph-th-ancora">
                  <span className="vf-ph-th-ancora__conteudo">
                    <BotaoOrdenar chave="nome" label="Cliente" titulo="nome do cliente" ordem={ordem} onOrdenar={ordenar} />
                  </span>
                </th>
                {colunas.map((c) => (
                  <th key={c.chave} scope="col" className="num vf-ph-th-metrica">
                    <BotaoOrdenar chave={c.chave} label={c.label} titulo={c.definicao} ordem={ordem} onOrdenar={ordenar} />
                  </th>
                ))}
                <th scope="col" className="vf-ph-th-dados">Dados</th>
              </tr>
            </thead>
          </>
        ) : (
        <thead>
          <tr className="vf-ph-thead-grupos" ref={linhaGrupoRef}>
            <th scope="col" rowSpan={2} className="vf-table__sticky-cell vf-ph-th-ancora">
              {/* "Recolher tudo" no cabeçalho preso: sempre à mão durante o
                  scroll, e aparecer/sumir não desloca a tabela. */}
              <span className="vf-ph-th-ancora__conteudo">
                <BotaoOrdenar chave="nome" label="Cliente / Conta" titulo="nome do cliente" ordem={ordem} onOrdenar={ordenar} />
                {expansao.temExpandido && (
                  <button type="button" className="vf-ph-recolher" onClick={expansao.recolherTudo}>Recolher tudo</button>
                )}
              </span>
            </th>
            <th scope="col" rowSpan={2} className="vf-table__sticky-cell vf-ph-th-contexto">
              <BotaoOrdenar chave="squad" label="Squad · Origem" titulo="Squad" ordem={ordem} onOrdenar={ordenar} />
            </th>
            {cabecalhoGrupos.map((g) => (
              <th key={g.chave} scope="colgroup" colSpan={g.colunas.length} className={`vf-ph-th-grupo${g.disponivel ? "" : " is-indisponivel"}`}>
                {g.label}
                {!g.disponivel && <span className="vf-ph-th-grupo__nota" title={g.nota}>sem fonte</span>}
              </th>
            ))}
          </tr>
          <tr className="vf-ph-thead-metricas">
            {colunas.map((c, i) => (
              <th
                key={c.chave}
                scope="col"
                className={[
                  "num vf-ph-th-metrica",
                  c.tipo === "indisponivel" ? "is-indisponivel" : "",
                  i === 0 || colunas[i - 1].grupo !== c.grupo ? "is-primeira-do-grupo" : "",
                ].filter(Boolean).join(" ")}
              >
                {c.tipo === "indisponivel"
                  ? <abbr title={c.definicao}>{c.label}</abbr>
                  : <BotaoOrdenar chave={c.chave} label={c.label} titulo={c.definicao} ordem={ordem} onOrdenar={ordenar} />}
              </th>
            ))}
          </tr>
        </thead>
        )}
        {(grupoDeSquad || [{ chave: "todos", clientes: ordenados }]).map((grupo) => (
        <tbody key={grupo.chave} className="vf-ph-tbody">
          {grupoDeSquad && (
            <LinhaGrupoSquad
              grupo={grupo}
              colSpan={colunas.length + 2}
              aberto={!gruposFechados.has(grupo.chave)}
              onAlternar={() => alternarGrupoSquad(grupo.chave)}
            />
          )}
          {!gruposFechados.has(grupo.chave) && grupo.clientes.map((cliente) => (
            <LinhaCliente
              key={cliente.id}
              cliente={cliente}
              competencia={competencia}
              expansao={expansao}
              mesesPorCliente={mesesPorCliente}
              carregarMeses={carregarMeses}
              semanasPorChave={semanasPorChave}
              carregarSemanas={carregarSemanas}
              semanasContasPorCliente={semanasContasPorCliente}
              carregarSemanasContas={carregarSemanasContas}
              composicaoPorCliente={composicaoPorCliente}
              carregarComposicao={carregarComposicao}
              colunas={colunas}
              onLancar={onLancar}
              competenciaAtual={competenciaAtual}
              atualizacao={atualizacoes[cliente.id]?.competencia === competencia ? atualizacoes[cliente.id] : null}
              podeAtualizar={podeAtualizar}
              onAtualizar={onAtualizar}
              onDispensar={onDispensarAtualizacao}
              mostrarHistoricoCliente={mostrarHistoricoCliente}
              agrupado={Boolean(grupoDeSquad)}
              fracaoFat={maiorFat > 0 && !ehAusente(cliente.resumo?.fat) ? Number(cliente.resumo.fat) / maiorFat : null}
              destaque={destaqueId === cliente.id}
            />
          ))}
        </tbody>
        ))}
      </table>
    </div>
    </VistaContext.Provider>
  );
}

// Cabeçalho do grupo (Squad): nome, quantos clientes e a situação em
// CONTAGEM (nenhuma soma de dinheiro — agregado financeiro por Squad depende
// do backend). Recolher o grupo é local.
function LinhaGrupoSquad({ grupo, colSpan, aberto, onAlternar }) {
  const n = grupo.clientes.length;
  const comDado = grupo.clientes.filter((c) => c.resumo).length;
  const acao = grupo.clientes.filter((c) => c.status?.precisaAtencao).length;
  return (
    <tr className="vf-ph-row vf-ph-row--grupo">
      <th scope="rowgroup" colSpan={colSpan}>
        <button type="button" className="vf-ph-grupo" aria-expanded={aberto} onClick={onAlternar}>
          <Chevron aberto={aberto} />
          <span className="vf-ph-grupo__nome">{grupo.nome}</span>
          <span className="vf-ph-grupo__n">{n} {n === 1 ? "cliente" : "clientes"}</span>
          <span className="vf-ph-grupo__sit">
            {comDado} de {n} com dados{acao > 0 ? ` · ${acao} ${acao === 1 ? "pede" : "pedem"} ação` : ""}
          </span>
        </button>
      </th>
    </tr>
  );
}
