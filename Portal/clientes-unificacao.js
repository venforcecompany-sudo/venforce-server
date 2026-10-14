import { vfApi } from "./vf-api.js";
import { format } from "./vf-format.js";
import { loadUnificacaoAccess } from "./clientes-unificacao-access.js";

const ROOT = "/admin/clientes-unificacao";
const e = format.escapeHTML;
const MARKETS = {
  meli: ["Mercado Livre", "mercado-livre.svg"],
  shopee: ["Shopee", "shopee.svg"],
  tiktok: ["TikTok Shop", "tiktok-shop.svg"],
};
const LABELS = {
  CLIENTES_UNIFICACAO_EXECUTE_DISABLED:
    "Execução ainda não habilitada neste ambiente. O preview e a validação estão disponíveis.",
  CLIENTES_UNIFICACAO_ROLLBACK_DISABLED:
    "Rollback ainda não habilitado neste ambiente.",
  MERGE_PLAN_CHANGED:
    "Os dados mudaram desde o preview. Gere uma nova validação antes de continuar.",
  SQUAD_MISMATCH: "Os clientes pertencem a Squads diferentes.",
  SELLER_AMBIGUOUS: "Há ambiguidade na identidade do seller.",
  GRANT_AMBIGUOUS:
    "O backend encontrou um Grant ausente, ambíguo ou incompatível.",
  BASE_AMBIGUOUS: "O backend encontrou ambiguidade no vínculo da Base.",
  UNIQUE_COLLISION:
    "Existe conflito de unicidade. Revise as decisões exigidas pelo backend.",
  UNIQUE_OR_CONSTRAINT_COLLISION:
    "A operação foi bloqueada por uma restrição de integridade.",
  CLIENT_ALREADY_MERGED: "Um cliente selecionado já foi unificado.",
  ACCOUNT_CONTEXT_AMBIGUOUS: "O contexto da conta é ambíguo.",
  ACCOUNT_OWNER_MISMATCH:
    "Há um vínculo de conta com proprietário incompatível.",
  ACCOUNT_WITHOUT_BASE: "A conta não possui Base ativa vinculada.",
  GRANT_NOT_ONLINE_VALIDATED: "O Grant não foi validado online.",
  BUSINESS_DECISION_REQUIRED:
    "Registre a aprovação empresarial e a referência documental.",
  BUSINESS_APPROVAL_IS_EXTERNAL:
    "A aprovação empresarial depende de evidência e decisão humana externas.",
  NO_ONLINE_GRANT_CHECK: "Este preview não consulta o provedor OAuth online.",
  ROLLBACK_STATE_DIVERGED:
    "Rollback bloqueado porque os dados mudaram após a unificação. Nenhuma alteração foi realizada.",
  ROLLBACK_OPERATION_NOT_COMPLETED:
    "Esta operação não está disponível para rollback.",
  MERGE_BUSY:
    "Outra operação está usando estes registros. Aguarde e consulte a auditoria antes de repetir.",
  MERGE_CONNECTION_LOST:
    "A conexão foi interrompida. O resultado pode já estar registrado. Repita a mesma tentativa ou consulte a auditoria.",
  TIMEOUT:
    "A resposta demorou demais. Consulte a auditoria ou repita a mesma tentativa.",
  REDE: "Não foi possível falar com o servidor. Tente novamente.",
  MERGE_TRANSACTION_TIMEOUT:
    "A transação excedeu o prazo. Gere um novo preview antes de tentar novamente.",
  MERGE_VALIDATION_BLOCKED:
    "A validação do backend bloqueou a unificação. Gere um novo preview.",
  STRONG_CONFIRMATION_REQUIRED:
    "A confirmação textual não corresponde ao contrato do backend.",
  IDEMPOTENCY_KEY_REUSED:
    "Esta tentativa não corresponde ao pedido registrado. Consulte a auditoria.",
  IDEMPOTENCY_RETRY_REQUIRES_NEW_KEY:
    "A tentativa anterior falhou. Gere um novo preview para iniciar outra tentativa.",
  UNKNOWN_CRITICAL_REFERENCE:
    "Há uma referência crítica sem cobertura segura no backend.",
  APPROVAL_REFERENCE_INVALID:
    "Use uma referência documental curta, sem conteúdo do documento ou segredos.",
  CANDIDATE_SCOPE_TOO_LARGE:
    "O catálogo excede o limite de candidatos. Use a busca manual.",
  ADMIN_REQUIRED: "Acesso restrito a administradores ativos.",
};
const STATUSES = {
  planned: "Planejada",
  validated: "Validada / aguardando execução",
  blocked: "Bloqueada",
  executing: "Em execução",
  completed: "Concluída",
  failed: "Falhou",
  rolled_back: "Revertida",
  rollback_failed: "Rollback bloqueado ou falhou",
};
const STRATEGIES = {
  MOVE_TO_CANONICAL: "Mover vínculo para o canônico",
  KEEP_AS_LEGACY_ORIGIN: "Manter origem legada",
  ACCOUNT_ALREADY_AUTHORITATIVE: "Referência já vinculada à Conta",
  DERIVED_REBUILDABLE: "Dado derivado (conforme plano)",
  BLOCKED_UNKNOWN: "Referência bloqueada",
};
const DETAIL_FIELDS = {
  clienteId: "Cliente",
  clienteContaId: "Conta",
  grantId: "Grant",
  id: "Registro",
  table: "Tabela",
  marketplace: "Marketplace",
  kind: "Tipo",
  reason: "Motivo",
  squadIds: "Squads",
  clienteIds: "Clientes",
  column: "Coluna",
  constraint: "Restrição",
  index: "Índice",
};
const clone = (value) => JSON.parse(JSON.stringify(value));
const equalId = (a, b) => String(a) === String(b);
const date = (value) =>
  value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString("pt-BR")
    : "—";
const clientLabel = (c) => `${c?.nome || "Cliente"} (#${c?.id ?? "—"})`;
const button = (action, label, data = "") =>
  `<button type="button" class="vf-btn vf-btn--secondary vf-btn--sm" data-action="${action}" ${data}>${e(label)}</button>`;
function table(headers, rows) {
  return `<div class="cu-table-wrap" tabindex="0" role="region" aria-label="Tabela de ${e(headers[0])}"><table class="cu-table"><thead><tr>${headers.map((h) => `<th scope="col">${e(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
function market(key) {
  const m = MARKETS[key];
  return m
    ? `<span class="cu-marketplace"><img src="assets/marketplaces/${m[1]}" alt="">${e(m[0])}</span>`
    : e(key);
}
function facts(entries) {
  return `<dl class="cu-facts">${entries.map(([k, v]) => `<dt>${e(k)}</dt><dd>${e(v ?? "—")}</dd>`).join("")}</dl>`;
}
function issues(title, items = [], tone = "info") {
  return `<section><h3>${e(title)}</h3>${
    items.length
      ? items
          .map((item) => {
            const detail = Object.entries(item.detail || {}).filter(
              ([key, value]) =>
                DETAIL_FIELDS[key] &&
                (Array.isArray(value)
                  ? value.every(
                      (v) => typeof v === "string" || typeof v === "number",
                    )
                  : ["string", "number", "boolean"].includes(typeof value)),
            );
            return `<div class="cu-issue cu-${tone}"><strong class="vf-mono">${e(item.code)}</strong><p>${e(LABELS[item.code] || "Informação retornada pela validação do backend.")}</p>${facts(detail.map(([k, v]) => [DETAIL_FIELDS[k], Array.isArray(v) ? v.join(", ") : v]))}</div>`;
          })
          .join("")
      : `<p class="cu-muted">Nenhum ${tone === "blocker" ? "bloqueio" : tone === "warning" ? "aviso" : "registro informativo"} retornado.</p>`
  }</section>`;
}
function impact(counts = []) {
  return counts.length
    ? table(
        ["Referência", "Registros", "Estratégia do backend"],
        counts.map((i) => [
          e(i.table),
          e(i.count),
          e(STRATEGIES[i.strategy] || i.strategy),
        ]),
      )
    : '<p class="cu-muted">Nenhum impacto adicional informado.</p>';
}
function selectedClient(c, action) {
  return `<div class="cu-selected"><div><strong>${e(c.nome || "Cliente")}</strong><small class="cu-muted"> #${e(c.id)} · ${e(c.slug || "—")}</small></div>${action ? button(action, "Remover", `data-id="${e(c.id)}" aria-label="Remover ${e(c.nome || c.id)}"`) : ""}</div>`;
}
function identity(c, preview) {
  const squads = (preview.squad || []).filter((s) =>
    equalId(s.cliente_id, c.id),
  );
  const people = (preview.responsaveis || []).filter((r) =>
    equalId(r.cliente_id, c.id),
  );
  return `<strong>${e(clientLabel(c))}</strong>${facts([
    ["Slug", c.slug],
    ["Status", c.ativo === true ? "Ativo" : "Inativo"],
    [
      "Squad",
      squads.map((s) => `#${s.squad_id}`).join(", ") || "Não informado",
    ],
    [
      "Responsáveis",
      people
        .map((r) => `Usuário #${r.user_id}${r.papel ? ` · ${r.papel}` : ""}`)
        .join(", ") || "Nenhum retornado",
    ],
  ])}`;
}
function previewMarkup(p) {
  // Apenas apresenta o plano retornado: não calcula novo estado/regra.
  const accounts = (p.clienteContas || []).map((a) => {
    const after =
      p.plan?.changes?.find(
        (c) => c.table === "cliente_contas" && equalId(c.pk.id, a.id),
      )?.after || {};
    const grants = (p.grants || []).filter((g) =>
      equalId(g.cliente_conta_id, a.id),
    );
    const bindings = (p.baseVinculos || []).filter((b) =>
      equalId(b.cliente_conta_id, a.id),
    );
    return [
      market(a.marketplace),
      `<strong>Conta #${e(a.id)}</strong><small>${e(a.nome || a.slug || "")}</small>`,
      e(a.external_account_id || "Não informado"),
      grants
        .map((g) => `Grant #${e(g.id)} · ${e(g.token_status || "Sem status")}`)
        .join("<br>") || "Sem vínculo explícito; veja Grants",
      bindings
        .map((v) => {
          const b = p.bases?.find((b) => equalId(b.id, v.base_id));
          return `${e(b?.nome || b?.slug || `Base #${v.base_id}`)} · ${v.ativo ? "vínculo ativo" : "vínculo inativo"}`;
        })
        .join("<br>") || "Sem vínculo retornado",
      e((after.is_primary ?? a.is_primary) ? "Sim" : "Não"),
      `Cliente #${e(a.cliente_id)}`,
      e(a.ativo ? "Ativa" : "Inativa"),
    ];
  });
  const preserved = p.plan?.preserved || {};
  return `<section class="cu-review-section"><h3>1. Empresa que permanece</h3><div class="cu-review-identity"><div>${identity(p.clienteCanonico || {}, p)}</div><div><h3>Clientes incorporados</h3>${(p.clientesLegados || []).map((c) => identity(c, p)).join("")}</div></div></section>
    <section class="cu-review-section"><h3>2. Contas após a unificação</h3>${accounts.length ? table(["Marketplace", "Conta", "Seller / ID externo", "Grant registrado", "Base", "Principal após", "Origem", "Status"], accounts) : '<p class="cu-muted">Nenhuma conta retornada.</p>'}
      <details class="cu-technical"><summary>Grants e Bases retornados</summary>${table(
        ["Grant", "Cliente / Conta de origem", "Seller", "Status registrado"],
        (p.grants || []).map((g) => [
          e(`#${g.id}`),
          e(
            `#${g.cliente_id} / ${g.cliente_conta_id == null ? "vínculo legado NULL" : `#${g.cliente_conta_id}`}`,
          ),
          e(g.ml_user_id),
          e(g.token_status || "Não informado"),
        ]),
      )}${table(
        ["Base", "Marketplace", "Status"],
        (p.bases || []).map((b) => [
          e(b.nome || b.slug || `#${b.id}`),
          market(b.marketplace),
          e(b.ativo ? "Ativa" : "Inativa"),
        ]),
      )}</details></section>
    <section class="cu-review-section"><h3>3. Impacto e preservação</h3>${facts(
      [
        [
          "Contas preservadas (IDs)",
          (preserved.clienteContaIds || []).join(", "),
        ],
        ["Grants preservados (IDs)", (preserved.grantIds || []).join(", ")],
        ["Bases preservadas (IDs)", (preserved.baseIds || []).join(", ")],
      ],
    )}${impact(p.impactCounts)}<details class="cu-technical"><summary>Alterações de vínculo previstas</summary>${table(
      ["Referência", "Registro", "Campos alterados"],
      (p.plan?.changes || []).map((c) => [
        e(c.table),
        e(
          Object.entries(c.pk || {})
            .map(([k, v]) => `${k}=${v}`)
            .join(", "),
        ),
        e(Object.keys(c.after || {}).join(", ")),
      ]),
    )}</details></section>
    <section class="cu-review-section"><h3>4. Validação e decisões</h3>${issues("Bloqueios", p.blockers, "blocker")}${issues("Avisos", p.warnings, "warning")}${issues("Informações", p.info)}</section>`;
}

export function createUnificacaoPage({
  document: doc,
  api = vfApi,
  uuid = () => globalThis.crypto.randomUUID(),
  delay = setTimeout,
  cancelDelay = clearTimeout,
} = {}) {
  const el = (id) => doc.getElementById(`cu-${id}`);
  const state = {
    config: null,
    canonical: null,
    legacies: [],
    preview: null,
    revision: 0,
    busy: null,
    key: null,
    keyHash: null,
    uncertain: false,
    operation: null,
    detail: null,
    required: [],
    decisions: { primaryAccounts: {}, primaryGrantId: null, referencias: {} },
    approval: { aprovada: false, aprovadorUserId: null, evidencia: null },
    candidates: [],
    history: [],
    nextCursor: null,
  };
  const search = { canonical: { revision: 0 }, legacy: { revision: 0 } };
  let historyRevision = 0;
  let detailRevision = 0;
  const feedback = (message) => {
    el("feedback").textContent = message || "";
  };
  function errorText(error) {
    // Jamais mostra error.message/raw/details/stack arbitrários.
    const code = String(error?.code || "");
    return (
      LABELS[code] ||
      "Não foi possível concluir a solicitação. Tente novamente ou consulte o histórico."
    );
  }
  function invalidate({ newAttempt = false } = {}) {
    state.revision++;
    state.preview = null;
    if (newAttempt) {
      state.key = null;
      state.keyHash = null;
    }
    el("confirm").hidden = true;
    el("reviewed").checked = false;
    el("confirmation").value = "";
    feedback("Preview invalidado. Gere uma nova validação antes de continuar.");
    updateButtons();
  }
  function updateButtons() {
    const locked = !!state.busy || state.uncertain;
    el("new").disabled = locked;
    el("selection").disabled = locked;
    el("close-editor").disabled = locked;
    el("decisions")
      .querySelectorAll("fieldset")
      .forEach((f) => {
        f.disabled = locked;
      });
    el("preview").disabled =
      locked || !state.canonical || !state.legacies.length;
    const p = state.preview;
    el("execute").disabled =
      !!state.busy ||
      !p?.canExecute ||
      !!p.blockers?.length ||
      !!p.decisionsRequired?.length ||
      !el("reviewed").checked ||
      el("confirmation").value !== p.confirmationText;
    el("execute").textContent =
      state.busy === "execute"
        ? "Unificando…"
        : state.uncertain
          ? "Consultar / repetir mesma tentativa"
          : "Unificar clientes";
    el("preview").textContent =
      state.busy === "preview"
        ? "Validando…"
        : p
          ? "Atualizar preview"
          : "Gerar preview";
  }
  function renderSelection() {
    el("canonical").innerHTML = state.canonical
      ? selectedClient(state.canonical, "remove-canonical")
      : '<p class="cu-muted">Escolha explicitamente quem permanecerá.</p>';
    el("legacies").innerHTML = state.legacies.length
      ? state.legacies.map((c) => selectedClient(c, "remove-legacy")).join("")
      : '<p class="cu-muted">Adicione pelo menos um cliente legado.</p>';
    updateButtons();
  }
  function clearSearch() {
    for (const kind of ["canonical", "legacy"]) {
      const s = search[kind];
      cancelDelay(s.timer);
      s.controller?.abort();
      s.revision++;
      el(`search-${kind}`).value = "";
      el(`results-${kind}`).innerHTML = "";
    }
  }
  function begin(candidate = null) {
    if (state.busy || state.uncertain) return;
    cancelDelay(decisionTimer);
    Object.assign(state, {
      canonical: null,
      legacies: [],
      required: [],
      key: null,
      keyHash: null,
      operation: null,
      decisions: { primaryAccounts: {}, primaryGrantId: null, referencias: {} },
      approval: { aprovada: false, aprovadorUserId: null, evidencia: null },
    });
    invalidate({ newAttempt: true });
    clearSearch();
    feedback("");
    el("review").hidden = true;
    el("decisions").hidden = true;
    el("result").hidden = true;
    el("detail").hidden = true;
    state.detail = null;
    detailRevision++;
    el("editor").hidden = false;
    el("candidate-context").textContent = candidate
      ? `Revisando Cliente #${candidate.cliente_a} e Cliente #${candidate.cliente_b}. Escolha quem permanecerá; a triagem não aprova a empresa.`
      : "Escolha o canônico e os legados. Nenhum cliente é selecionado automaticamente.";
    renderSelection();
    el("editor-title").focus();
    if (candidate) {
      searchNow("canonical", String(candidate.cliente_a));
      searchNow("legacy", String(candidate.cliente_b));
    }
  }
  function choose(kind, c) {
    if (state.busy || state.uncertain || !c) return;
    if (
      equalId(state.canonical?.id, c.id) ||
      state.legacies.some((x) => equalId(x.id, c.id))
    )
      return;
    if (kind === "canonical") state.canonical = c;
    else state.legacies.push(c);
    state.required = [];
    state.decisions = {
      primaryAccounts: {},
      primaryGrantId: null,
      referencias: {},
    };
    state.approval = {
      aprovada: false,
      aprovadorUserId: null,
      evidencia: null,
    };
    invalidate({ newAttempt: true });
    el("review").hidden = true;
    el("decisions").hidden = true;
    clearSearch();
    renderSelection();
    el(`search-${kind}`).focus();
  }
  async function searchNow(kind, query, revision) {
    const s = search[kind];
    s.controller?.abort();
    s.controller = new AbortController();
    const current = revision ?? ++s.revision;
    el(`results-${kind}`).textContent = "Buscando…";
    try {
      const data = await api.get(`${ROOT}/busca`, {
        params: { q: query },
        signal: s.controller.signal,
      });
      if (!data || current !== s.revision) return;
      s.results = (data.clientes || []).filter(
        (c) =>
          !equalId(c.id, state.canonical?.id) &&
          !state.legacies.some((x) => equalId(x.id, c.id)),
      );
      el(`results-${kind}`).innerHTML = s.results.length
        ? s.results
            .map(
              (c, index) =>
                `<button type="button" class="vf-btn vf-btn--ghost cu-search-result" data-action="choose-${kind}" data-index="${index}"><strong>${e(c.nome)}</strong> · #${e(c.id)}<small class="cu-muted"> · ${e(c.slug)}${c.ativo === false ? " · Inativo" : ""}${c.merged_into_cliente_id ? ` · Já unificado em #${e(c.merged_into_cliente_id)}` : ""}</small></button>`,
            )
            .join("")
        : '<p class="cu-muted">Nenhum cliente disponível nessa busca.</p>';
    } catch (error) {
      if (current !== s.revision) return;
      el(`results-${kind}`).innerHTML =
        `<p>${e(errorText(error))}</p>${button(`retry-search-${kind}`, "Tentar novamente")}`;
      s.query = query;
    }
  }
  function queueSearch(kind) {
    const s = search[kind];
    cancelDelay(s.timer);
    s.controller?.abort();
    s.revision++;
    const q = el(`search-${kind}`).value.trim();
    if (!q) {
      el(`results-${kind}`).innerHTML = "";
      return;
    }
    el(`results-${kind}`).textContent = "Buscando…";
    const revision = s.revision;
    s.timer = delay(() => searchNow(kind, q, revision), 300);
  }
  async function candidates() {
    el("candidates").textContent = "Carregando candidatos…";
    try {
      const data = await api.get(`${ROOT}/candidatos`);
      if (!data) return;
      state.candidates = data.candidatos || [];
      el("candidates").innerHTML = state.candidates.length
        ? `<p class="cu-muted">Indícios para revisão humana. A pontuação prioriza a triagem e não comprova que os registros representam a mesma empresa. Contas, Squad e bloqueios serão verificados no preview.</p>${table(
            [
              "Cliente A",
              "Cliente B",
              "Classificação",
              "Indícios",
              "Status",
              "Ação",
            ],
            state.candidates.map((c, index) => [
              e(`#${c.cliente_a}`),
              e(`#${c.cliente_b}`),
              `${e(c.classificacao)}<small>Priorização: ${e(c.score_priorizacao)}</small>`,
              (c.motivos || []).map((m) => e(m.motivo)).join("<br>"),
              e(c.decisao),
              button("review-candidate", "Revisar", `data-index="${index}"`),
            ]),
          )}`
        : '<div class="cu-empty"><h3>Nenhum candidato pendente para revisão.</h3><p>Você ainda pode iniciar uma unificação manual.</p></div>';
    } catch (error) {
      el("candidates").innerHTML =
        `<div class="cu-empty"><p>${e(errorText(error))}</p>${button("retry-candidates", "Tentar novamente")}</div>`;
    }
  }
  function manifest() {
    return {
      schemaVersion: 1,
      clienteCanonicoId: Number(state.canonical.id),
      clientesLegadosIds: state.legacies.map((c) => Number(c.id)),
      decisoes: clone(state.decisions),
      aprovacao: clone(state.approval),
    };
  }
  function renderDecisions(p) {
    const focusedId = doc.activeElement?.id;
    const caret = doc.activeElement?.selectionStart;
    state.required = [
      ...new Set([...state.required, ...(p.decisionsRequired || [])]),
    ];
    const fields = state.required.map((path) => {
      if (path === "aprovacao")
        return `<fieldset class="cu-decision"><legend>Aprovação empresarial obrigatória</legend><label><input id="cu-approved" type="checkbox" data-decision="approved" ${state.approval.aprovada ? "checked" : ""}> Confirmo que a unificação foi aprovada com evidência empresarial externa.</label><label for="cu-approver">ID do usuário aprovador declarado</label><input id="cu-approver" class="vf-input" type="number" min="1" step="1" data-decision="approver" value="${e(state.approval.aprovadorUserId || "")}"><label for="cu-evidence">Referência documental da aprovação</label><input id="cu-evidence" class="vf-input" maxlength="160" data-decision="evidence" value="${e(state.approval.evidencia || "")}" placeholder="Ex.: APROVACAO-2026-001"><p class="cu-muted">Informe apenas a referência. Não envie documentos, credenciais ou segredos.</p></fieldset>`;
      if (path.startsWith("decisoes.primaryAccounts.")) {
        const key = path.split(".").at(-1);
        return `<fieldset class="cu-decision"><legend>Conta principal · ${e(MARKETS[key]?.[0] || key)}</legend>${(
          p.clienteContas || []
        )
          .filter((a) => a.marketplace === key && a.ativo === true)
          .map(
            (a) =>
              `<label><input type="radio" name="cu-primary-${e(key)}" data-decision="primary" data-marketplace="${e(key)}" value="${e(a.id)}" ${equalId(state.decisions.primaryAccounts[key], a.id) ? "checked" : ""}> ${e(a.nome || `Conta #${a.id}`)} · Conta #${e(a.id)} · Origem #${e(a.cliente_id)}</label>`,
          )
          .join("")}</fieldset>`;
      }
      if (path === "decisoes.primaryGrantId")
        return `<fieldset class="cu-decision"><legend>Grant principal</legend>${(p.grants || []).map((g) => `<label><input type="radio" name="cu-primary-grant" data-decision="grant" value="${e(g.id)}" ${equalId(state.decisions.primaryGrantId, g.id) ? "checked" : ""}> Grant #${e(g.id)} · Seller ${e(g.ml_user_id)} · Origem #${e(g.cliente_id)}</label>`).join("")}</fieldset>`;
      return `<p class="cu-issue cu-blocker">Decisão sem controle disponível nesta versão: ${e(path)}. A execução permanece bloqueada pelo backend.</p>`;
    });
    el("decisions").hidden = !fields.length;
    el("decisions").innerHTML = fields.length
      ? `<h3>Decisões obrigatórias</h3>${fields.join("")}<p class="cu-muted">Cada alteração invalida o preview anterior e solicita uma nova validação.</p>`
      : "";
    if (focusedId && el("decisions").contains(doc.getElementById(focusedId))) {
      const focused = doc.getElementById(focusedId);
      focused.focus();
      if (typeof caret === "number") focused.setSelectionRange(caret, caret);
    }
  }
  async function preview() {
    if (
      state.busy ||
      state.uncertain ||
      !state.canonical ||
      !state.legacies.length
    )
      return;
    const revision = state.revision;
    let rerun = true;
    const request = manifest();
    state.preview = null;
    el("confirm").hidden = true;
    el("reviewed").checked = false;
    el("confirmation").value = "";
    state.busy = "preview";
    updateButtons();
    feedback("Validando com o backend…");
    try {
      const p = await api.post(`${ROOT}/preview`, {
        body: { manifest: request },
        timeoutMs: 30000,
      });
      if (!p || revision !== state.revision) return;
      if (state.keyHash !== p.planHash) {
        state.key = null;
        state.keyHash = p.planHash;
      }
      state.preview = p;
      state.decisions = clone(p.manifest.decisoes);
      state.approval = clone(p.manifest.aprovacao);
      el("review").innerHTML = previewMarkup(p);
      el("review").hidden = false;
      renderDecisions(p);
      el("confirmation-text").textContent = p.confirmationText;
      el("confirm").hidden = false;
      el("execution-state").textContent = p.canExecute
        ? "Preview validado. Revise os dados e confirme para executar."
        : p.validationReady
          ? LABELS.CLIENTES_UNIFICACAO_EXECUTE_DISABLED
          : "Unificação bloqueada. Resolva as decisões pendentes e os bloqueios retornados pelo backend.";
      feedback(
        p.blockers?.length
          ? `Unificação bloqueada: ${p.blockers.length} bloqueio(s).`
          : "Preview atualizado pelo backend.",
      );
    } catch (error) {
      rerun = false;
      invalidate();
      feedback(errorText(error));
    } finally {
      state.busy = null;
      updateButtons();
      if (
        rerun &&
        revision !== state.revision &&
        state.canonical &&
        state.legacies.length
      )
        preview();
    }
  }
  let decisionTimer;
  function changeDecision(target) {
    if (state.uncertain || state.busy === "execute") return;
    const kind = target.dataset.decision;
    if (kind === "primary")
      state.decisions.primaryAccounts[target.dataset.marketplace] = Number(
        target.value,
      );
    else if (kind === "grant")
      state.decisions.primaryGrantId = Number(target.value);
    else if (kind === "approved") state.approval.aprovada = target.checked;
    else if (kind === "approver")
      state.approval.aprovadorUserId = target.value
        ? Number(target.value)
        : null;
    else if (kind === "evidence")
      state.approval.evidencia = target.value || null;
    else return;
    invalidate();
    cancelDelay(decisionTimer);
    decisionTimer = delay(preview, 500);
  }
  function showOperation(op, { focus = true } = {}) {
    state.operation = op;
    state.uncertain = ["planned", "validated", "executing"].includes(op.status);
    el("result").hidden = false;
    el("result").classList.toggle("cu-success", op.status === "completed");
    el("result").innerHTML =
      `<h2>${e(op.status === "completed" ? "Unificação concluída" : op.status === "rolled_back" ? "Unificação revertida" : "Operação registrada")}</h2>${facts(
        [
          ["Cliente principal", `#${op.clienteCanonicoId}`],
          [
            "Clientes incorporados",
            (op.clientesLegadosIds || []).map((id) => `#${id}`).join(", "),
          ],
          ["Status", STATUSES[op.status] || op.status],
          ["Operação", op.operationKey],
          [
            "Contas preservadas",
            state.preview?.plan?.preserved?.clienteContaIds?.length,
          ],
        ],
      )}<div class="cu-actions">${button("open-detail", "Ver auditoria", `data-id="${e(op.id)}"`)}${op.status === "completed" ? `<a class="vf-btn vf-btn--secondary" href="clientes.html">Abrir Clientes e Contas</a>` : ""}</div>${state.uncertain ? '<p class="cu-muted">O backend ainda não confirmou a conclusão. Consulte a auditoria. A mesma tentativa mantém a chave de idempotência; não inicie outra operação.</p>' : ""}`;
    if (!state.uncertain) {
      el("confirm").hidden = true;
      el("editor").hidden = true;
    }
    if (focus) el("result").focus();
    updateButtons();
  }
  async function execute() {
    updateButtons();
    if (el("execute").disabled) return;
    try {
      state.key ||= uuid();
    } catch {
      feedback(
        "Este navegador não oferece geração segura de chave de tentativa. Use um navegador atualizado.",
      );
      return;
    }
    state.busy = "execute";
    updateButtons();
    feedback("Executando. Aguarde o resultado registrado pelo backend.");
    try {
      const data = await api.post(`${ROOT}/execute`, {
        timeoutMs: 45000,
        body: {
          manifest: clone(state.preview.manifest),
          planHash: state.preview.planHash,
          idempotencyKey: state.key,
          confirmationText: el("confirmation").value,
        },
      });
      if (data?.operation) showOperation(data.operation);
    } catch (error) {
      if (["REDE", "TIMEOUT", "MERGE_CONNECTION_LOST"].includes(error.code))
        state.uncertain = true;
      else {
        state.uncertain = false;
        if (error.code === "CLIENTES_UNIFICACAO_EXECUTE_DISABLED") {
          state.preview.canExecute = false;
          el("execution-state").textContent = errorText(error);
        } else
          invalidate({
            newAttempt: error.code === "IDEMPOTENCY_RETRY_REQUIRES_NEW_KEY",
          });
      }
      feedback(errorText(error));
    } finally {
      state.busy = null;
      updateButtons();
    }
  }
  async function history({ more = false } = {}) {
    const revision = ++historyRevision;
    if (!more) {
      state.history = [];
      state.nextCursor = null;
      el("history").textContent = "Carregando histórico…";
    }
    try {
      const data = await api.get(ROOT, {
        params: { limit: 25, cursor: more ? state.nextCursor : null },
      });
      if (!data || revision !== historyRevision) return;
      state.history = [...state.history, ...(data.operations || [])];
      state.nextCursor = data.nextCursor;
      el("history").innerHTML = state.history.length
        ? `${table(
            [
              "Data",
              "Operação",
              "Canônico",
              "Legados",
              "Usuário",
              "Status",
              "Ação",
            ],
            state.history.map((op) => [
              e(date(op.createdAt)),
              e(op.operationKey),
              e(`#${op.clienteCanonicoId}`),
              e((op.clientesLegadosIds || []).map((id) => `#${id}`).join(", ")),
              e(`#${op.actor?.requestedByUserId ?? "—"}`),
              e(STATUSES[op.status] || op.status),
              button("open-detail", "Ver detalhes", `data-id="${e(op.id)}"`),
            ]),
          )}${state.nextCursor ? `<div class="cu-actions">${button("more-history", "Carregar mais")}</div>` : ""}`
        : '<div class="cu-empty"><h3>Nenhuma unificação registrada.</h3></div>';
    } catch (error) {
      if (revision === historyRevision)
        el("history").innerHTML =
          `<div class="cu-empty"><p>${e(errorText(error))}</p>${button("retry-history", "Tentar novamente")}</div>`;
    }
  }
  function showDetail(op) {
    state.detail = op;
    const rollback =
      op.rollbackAvailable === true && state.config.rollbackEnabled === true;
    el("detail").innerHTML =
      `<div class="cu-toolbar"><h2>Auditoria da operação</h2>${button("close-detail", "Fechar detalhe")}</div>${facts(
        [
          ["Operação", op.operationKey],
          ["Status", STATUSES[op.status] || op.status],
          ["Criada em", date(op.createdAt)],
          ["Concluída em", date(op.finishedAt)],
          ["Revertida em", date(op.rolledBackAt)],
          ["Solicitante", `#${op.actor?.requestedByUserId ?? "—"}`],
          ["Confirmante", `#${op.actor?.confirmedByUserId ?? "—"}`],
          ["Canônico", `#${op.clienteCanonicoId}`],
          ["Legados", (op.clientesLegadosIds || []).join(", ")],
          [
            "Resultado",
            op.errorCode
              ? LABELS[op.errorCode] ||
                "Consulte o código da operação nos dados técnicos."
              : STATUSES[op.status] || op.status,
          ],
        ],
      )}
      <h3>Manifesto</h3>${facts([
        ["Versão", op.manifest?.schemaVersion],
        [
          "Aprovação declarada",
          op.manifest?.aprovacao?.aprovada ? "Sim" : "Não",
        ],
        ["Aprovador declarado", op.manifest?.aprovacao?.aprovadorUserId],
        ["Referência documental", op.manifest?.aprovacao?.evidencia],
        [
          "Contas principais",
          Object.entries(op.manifest?.decisoes?.primaryAccounts || {})
            .map(([m, id]) => `${MARKETS[m]?.[0] || m}: #${id}`)
            .join(", "),
        ],
        ["Grant principal", op.manifest?.decisoes?.primaryGrantId],
      ])}
      <h3>Plano</h3>${impact(op.plan?.impactCounts)}${issues("Bloqueios", op.validation?.blockers, "blocker")}${issues("Avisos", op.validation?.warnings, "warning")}${issues("Informações", op.validation?.info)}
      <details class="cu-technical"><summary>Dados técnicos</summary>${facts([
        ["ID", op.id],
        ["Plan hash", op.planHash],
        ["Erro", op.errorCode],
        ["Before hash", op.beforeSummary?.hash],
        ["After hash", op.afterSummary?.hash],
        ["Tabelas before", op.beforeSummary?.tables?.join(", ")],
        ["Tabelas after", op.afterSummary?.tables?.join(", ")],
      ])}</details>
      <section class="cu-review-section"><h3>Rollback</h3><p>${e(rollback ? "Disponível para tentativa pelo backend. Esta ação tenta restaurar o estado anterior da unificação. Ela será bloqueada se os dados tiverem mudado depois." : op.rollbackAvailable ? LABELS.CLIENTES_UNIFICACAO_ROLLBACK_DISABLED : "Não disponível para esta operação.")}</p>${rollback ? `<fieldset id="cu-rollback-fields"><label class="vf-field__label" for="cu-rollback-confirmation">Digite <strong class="vf-mono">${e(op.rollbackConfirmationText)}</strong></label><input id="cu-rollback-confirmation" class="vf-input vf-mono" autocomplete="off" spellcheck="false"><div class="cu-actions"><button type="button" id="cu-rollback" class="vf-btn vf-btn--danger" disabled>Reverter unificação</button></div></fieldset>` : ""}<p id="cu-rollback-feedback" role="status" aria-live="polite"></p></section><div class="cu-actions">${button("refresh-detail", "Atualizar auditoria", `data-id="${e(op.id)}"`)}</div>`;
    el("detail").hidden = false;
    el("detail").focus();
    el("rollback-confirmation")?.addEventListener("input", () => {
      el("rollback").disabled =
        !!state.busy ||
        el("rollback-confirmation").value !== op.rollbackConfirmationText;
    });
    el("rollback")?.addEventListener("click", rollbackOperation);
    if (
      state.operation &&
      equalId(state.operation.id, op.id) &&
      !["planned", "validated", "executing"].includes(op.status)
    )
      showOperation(op, { focus: false });
  }
  async function detail(id) {
    if (state.busy === "rollback") return;
    const revision = ++detailRevision;
    el("detail").hidden = false;
    el("detail").textContent = "Carregando auditoria…";
    try {
      const data = await api.get(`${ROOT}/${encodeURIComponent(id)}`);
      if (revision === detailRevision && data?.operation)
        showDetail(data.operation);
    } catch (error) {
      if (revision === detailRevision)
        el("detail").innerHTML =
          `<p>${e(errorText(error))}</p>${button("refresh-detail", "Tentar novamente", `data-id="${e(id)}"`)}`;
    }
  }
  async function rollbackOperation() {
    if (
      state.busy ||
      !state.detail?.rollbackAvailable ||
      !state.config.rollbackEnabled ||
      el("rollback")?.disabled
    )
      return;
    state.busy = "rollback";
    el("rollback-fields").disabled = true;
    updateButtons();
    const op = state.detail;
    try {
      const data = await api.post(
        `${ROOT}/${encodeURIComponent(op.id)}/rollback`,
        {
          timeoutMs: 45000,
          body: { confirmationText: el("rollback-confirmation").value },
        },
      );
      if (data?.operation) {
        showDetail(data.operation);
        el("rollback-feedback").textContent =
          data.operation.status === "rolled_back"
            ? "Rollback concluído. O estado anterior foi restaurado pelo backend."
            : "Consulte o status registrado na auditoria.";
      }
    } catch (error) {
      el("rollback-feedback").textContent = errorText(error);
      if (
        [
          "CLIENTES_UNIFICACAO_ROLLBACK_DISABLED",
          "ROLLBACK_STATE_DIVERGED",
          "ROLLBACK_OPERATION_NOT_COMPLETED",
        ].includes(error.code)
      ) {
        if (error.code === "CLIENTES_UNIFICACAO_ROLLBACK_DISABLED")
          state.config.rollbackEnabled = false;
        el("rollback-fields").hidden = true;
      }
    } finally {
      state.busy = null;
      if (el("rollback-fields")) el("rollback-fields").disabled = false;
      updateButtons();
    }
  }
  function tab(kind) {
    for (const name of ["candidates", "history"]) {
      const active = kind === name;
      el(name).hidden = !active;
      el(`tab-${name}`).setAttribute("aria-selected", String(active));
      el(`tab-${name}`).tabIndex = active ? 0 : -1;
      el(`tab-${name}`).classList.toggle("is-active", active);
    }
    if (kind === "history") history();
  }
  function wire() {
    el("new").addEventListener("click", () => begin());
    el("close-editor").addEventListener("click", () => {
      if (!state.busy && !state.uncertain) {
        el("editor").hidden = true;
        clearSearch();
        el("new").focus();
      }
    });
    for (const kind of ["canonical", "legacy"])
      el(`search-${kind}`).addEventListener("input", () => queueSearch(kind));
    for (const kind of ["candidates", "history"]) {
      el(`tab-${kind}`).addEventListener("click", () => tab(kind));
      el(`tab-${kind}`).addEventListener("keydown", (event) => {
        if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const next =
            event.key === "Home"
              ? "candidates"
              : event.key === "End"
                ? "history"
                : kind === "history"
                  ? "candidates"
                  : "history";
          tab(next);
          el(`tab-${next}`).focus();
        }
      });
    }
    el("preview").addEventListener("click", preview);
    el("execute").addEventListener("click", execute);
    el("reviewed").addEventListener("change", updateButtons);
    el("confirmation").addEventListener("input", updateButtons);
    el("decisions").addEventListener("change", (event) =>
      changeDecision(event.target),
    );
    el("decisions").addEventListener("input", (event) => {
      if (["approver", "evidence"].includes(event.target.dataset.decision))
        changeDecision(event.target);
    });
    el("app").addEventListener("click", (event) => {
      const target = event.target.closest("[data-action]");
      if (!target) return;
      const action = target.dataset.action;
      if (action === "review-candidate")
        begin(state.candidates[Number(target.dataset.index)]);
      if (action.startsWith("choose-")) {
        const kind = action.slice(7);
        choose(kind, search[kind]?.results?.[Number(target.dataset.index)]);
      }
      if (action.startsWith("remove-") && !state.busy && !state.uncertain) {
        if (action === "remove-canonical") state.canonical = null;
        else
          state.legacies = state.legacies.filter(
            (c) => !equalId(c.id, target.dataset.id),
          );
        state.required = [];
        state.decisions = {
          primaryAccounts: {},
          primaryGrantId: null,
          referencias: {},
        };
        state.approval = {
          aprovada: false,
          aprovadorUserId: null,
          evidencia: null,
        };
        invalidate({ newAttempt: true });
        clearSearch();
        renderSelection();
        el("review").hidden = true;
        el("decisions").hidden = true;
      }
      if (action === "retry-candidates") candidates();
      if (action === "retry-history") history();
      if (action === "more-history") {
        target.disabled = true;
        history({ more: true });
      }
      if (action.startsWith("retry-search-")) {
        const kind = action.slice(13);
        searchNow(kind, search[kind].query);
      }
      if (action === "open-detail" || action === "refresh-detail")
        detail(target.dataset.id);
      if (action === "close-detail" && !state.busy) {
        detailRevision++;
        el("detail").hidden = true;
        el("tab-history").focus();
      }
    });
  }
  async function start(config) {
    if (config?.actor?.role !== "admin" || config.uiEnabled !== true) {
      el("access").textContent =
        config?.actor?.role !== "admin"
          ? "Acesso restrito a administradores."
          : "Interface de unificação não habilitada neste ambiente.";
      return false;
    }
    state.config = config;
    el("access").hidden = true;
    el("app").hidden = false;
    el("new").hidden = false;
    wire();
    await candidates();
    return true;
  }
  return {
    start,
    state,
    begin,
    choose,
    preview,
    execute,
    candidates,
    history,
    detail,
    rollbackOperation,
    searchNow,
    queueSearch,
    invalidate,
  };
}

export async function bootUnificacao({
  document: doc = document,
  storage = localStorage,
  api = vfApi,
  redirect = (url) => window.location.replace(url),
  shell = () => import("./vf-shell.js"),
} = {}) {
  const access = doc.getElementById("cu-access");
  let user;
  try {
    if (!storage.getItem("vf-token")) {
      redirect("index.html");
      return null;
    }
    user = JSON.parse(storage.getItem("vf-user") || "{}");
  } catch {
    redirect("index.html");
    return null;
  }
  if (user?.role !== "admin") {
    access.textContent = "Acesso restrito a administradores.";
    return null;
  }
  try {
    const config = await loadUnificacaoAccess(api);
    if (!config) return null; // 401 já tratado por vf-api
    const page = createUnificacaoPage({ document: doc, api });
    if (await page.start(config)) await shell();
    return page;
  } catch (error) {
    if (error?.status === 403) {
      access.textContent = "Acesso restrito a administradores ativos.";
      return null;
    }
    access.textContent = "Não foi possível validar o acesso. ";
    const retry = doc.createElement("button");
    retry.type = "button";
    retry.className = "vf-btn vf-btn--secondary";
    retry.textContent = "Tentar novamente";
    retry.addEventListener("click", () => {
      access.textContent = "Validando acesso…";
      bootUnificacao({ document: doc, storage, api, redirect, shell });
    });
    access.appendChild(retry);
    return null;
  }
}
if (typeof window !== "undefined" && typeof document !== "undefined")
  bootUnificacao();
