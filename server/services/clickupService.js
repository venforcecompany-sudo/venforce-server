const CLICKUP_API_BASE = 'https://api.clickup.com/api/v2';
const DEFAULT_LIST_NAME = 'Nova Gestão Tarefas';

const cache = new Map();

class ClickUpServiceError extends Error {
  constructor(publicMessage, statusCode = 500, code = 'CLICKUP_SERVICE_ERROR') {
    super(publicMessage);
    this.publicMessage = publicMessage;
    this.statusCode = statusCode;
    this.code = code;
  }
}

function getConfig() {
  const token = process.env.CLICKUP_TOKEN;
  const teamId = process.env.CLICKUP_TEAM_ID || '';
  const spaceId = process.env.CLICKUP_SPACE_ID || '';
  const defaultListId = process.env.CLICKUP_NOVA_GESTAO_LIST_ID || '';
  const defaultPageLimit = toSafeInteger(process.env.CLICKUP_DEFAULT_PAGE_LIMIT, 120, 1, 200);
  const cacheTtlSeconds = toSafeInteger(process.env.CLICKUP_CACHE_TTL_SECONDS, 300, 0, 3600);

  if (!token) {
    throw new ClickUpServiceError('CLICKUP_TOKEN não configurado no backend.', 500, 'CLICKUP_TOKEN_MISSING');
  }

  if (!defaultListId) {
    throw new ClickUpServiceError('CLICKUP_NOVA_GESTAO_LIST_ID não configurado.', 500, 'CLICKUP_NOVA_GESTAO_LIST_ID_MISSING');
  }

  return {
    token,
    teamId,
    spaceId,
    defaultListId,
    defaultPageLimit,
    cacheTtlSeconds,
  };
}

async function getResumoExecutivo(options = {}) {
  const config = getConfig();

  const range = normalizeDateRange(options.dateFrom, options.dateTo);
  const pageLimit = toSafeInteger(options.pageLimit, config.defaultPageLimit, 1, 200);
  const includeComments = Boolean(options.includeComments);

  const targetListId = String(config.defaultListId).trim();
  const targetListName = String(options.listName || DEFAULT_LIST_NAME).trim();

  const cacheKey = JSON.stringify({
    route: 'executivo/resumo',
    dateFrom: range.dateFrom,
    dateTo: range.dateTo,
    targetListId,
    targetListName,
    includeComments,
    pageLimit,
  });

  const cached = getCache(cacheKey, config.cacheTtlSeconds);
  if (cached) return cached;

  const { tasks: allTasks, pagesFetched } = await fetchListTasks({
    config,
    listId: targetListId,
    pageLimit,
  });

  const listTasks = allTasks;

  const deliveries = listTasks
    .filter(isDeliveryTask)
    .filter((task) => isTaskDoneWithinRange(task, range.startMs, range.endMs));

  const deliveriesWithComments = includeComments
    ? await enrichDeliveriesWithComments(deliveries, config)
    : deliveries.map((task) => mapDelivery(task, null));

  const payload = buildDashboardPayload({
    listTasks,
    deliveries: deliveriesWithComments,
    range,
    meta: {
      source_endpoint: 'list_tasks',
      fetched_tasks: allTasks.length,
      filtered_list_tasks: listTasks.length,
      deliveries_in_period: deliveries.length,
      target_list_id: targetListId,
      target_list_name: targetListName,
      page_limit: pageLimit,
      pages_fetched: pagesFetched,
      include_comments: includeComments,
    },
  });

  setCache(cacheKey, payload);
  return payload;
}

async function fetchListTasks({ config, listId, pageLimit }) {
  const tasks = [];
  let pagesFetched = 0;

  for (let page = 0; page < pageLimit; page += 1) {
    const url = new URL(`${CLICKUP_API_BASE}/list/${encodeURIComponent(listId)}/task`);

    url.searchParams.set('archived', 'false');
    url.searchParams.set('include_closed', 'true');
    url.searchParams.set('subtasks', 'true');
    url.searchParams.set('page', String(page));

    const data = await clickupFetchJson(url.toString(), config.token);
    pagesFetched += 1;

    const pageTasks = Array.isArray(data.tasks) ? data.tasks : [];

    if (pageTasks.length === 0) break;

    tasks.push(...pageTasks);
  }

  return { tasks, pagesFetched };
}

async function fetchTaskComments(taskId, config) {
  if (!taskId) return [];

  const url = `${CLICKUP_API_BASE}/task/${encodeURIComponent(taskId)}/comment`;
  const data = await clickupFetchJson(url, config.token);

  return Array.isArray(data.comments) ? data.comments : [];
}

async function clickupFetchJson(url, token) {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: token,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
  });

  if (response.status === 401 || response.status === 403) {
    throw new ClickUpServiceError('Token ClickUp sem permissão ou inválido.', 502, 'CLICKUP_AUTH_ERROR');
  }

  if (response.status === 429) {
    throw new ClickUpServiceError('Rate limit da API ClickUp atingido. Tente novamente em alguns minutos.', 429, 'CLICKUP_RATE_LIMIT');
  }

  if (!response.ok) {
    throw new ClickUpServiceError(`Erro ao consultar API ClickUp. Status ${response.status}.`, 502, 'CLICKUP_API_ERROR');
  }

  return response.json();
}

async function enrichDeliveriesWithComments(tasks, config) {
  const MAX_WITH_COMMENTS = 200;

  if (tasks.length > MAX_WITH_COMMENTS) {
    return tasks.map((task) => mapDelivery(task, null));
  }

  const results = await mapLimit(tasks, 4, async (task) => {
    try {
      const comments = await fetchTaskComments(task.id, config);
      const lastComment = pickLastComment(comments);
      return mapDelivery(task, lastComment);
    } catch (_error) {
      return mapDelivery(task, null);
    }
  });

  return results;
}

function buildDashboardPayload({ listTasks, deliveries, range, meta }) {
  const now = Date.now();

  const openTasks = listTasks.filter((task) => !isDeliveryTask(task));
  const lateOpenTasks = openTasks.filter((task) => {
    const dueDate = toNumberOrNull(task.due_date);
    return dueDate !== null && dueDate < now;
  });

  const noDueTasks = listTasks.filter((task) => task.due_date === null || task.due_date === undefined);
  const clientsWithDelivery = new Set(deliveries.map((delivery) => delivery.cliente).filter(Boolean));
  const commentedDeliveries = deliveries.filter((delivery) => hasRealComment(delivery.comentario));

  return {
    periodo: {
      date_from: range.dateFrom,
      date_to: range.dateTo,
    },
    resumo: {
      total: listTasks.length,
      concluidas: deliveries.length,
      abertas: openTasks.length,
      atrasadas_abertas: lateOpenTasks.length,
      sem_prazo: noDueTasks.length,
      clientes_atendidos: clientsWithDelivery.size,
      percentual_com_comentario: deliveries.length
        ? Math.round((commentedDeliveries.length / deliveries.length) * 100)
        : 0,
    },
    por_pessoa: buildPeopleSummary({ listTasks, deliveries, now }),
    por_cliente: buildGroupedSummary({
      listTasks,
      deliveries,
      keyGetter: (taskOrDelivery) => taskOrDelivery.cliente || safeNested(taskOrDelivery, ['folder', 'name']) || 'sem_cliente',
      outputKey: 'cliente',
      now,
    }),
    por_canal: buildGroupedSummary({
      listTasks,
      deliveries,
      keyGetter: (taskOrDelivery) => taskOrDelivery.canal || safeNested(taskOrDelivery, ['list', 'name']) || 'sem_canal',
      outputKey: 'canal',
      now,
    }),
    entregas: deliveries.sort((a, b) => new Date(b.data_conclusao).getTime() - new Date(a.data_conclusao).getTime()),
    meta,
  };
}

function buildPeopleSummary({ listTasks, deliveries, now }) {
  const peopleMap = new Map();

  for (const task of listTasks) {
    const responsibles = getAssigneeNames(task);

    for (const person of responsibles) {
      const item = getOrCreatePerson(peopleMap, person);
      item.total_tarefas += 1;

      if (!isDeliveryTask(task)) {
        item.abertas += 1;

        const dueDate = toNumberOrNull(task.due_date);
        if (dueDate !== null && dueDate < now) {
          item.atrasadas_abertas += 1;
        }
      }

      if (task.due_date === null || task.due_date === undefined) {
        item.sem_prazo += 1;
      }
    }
  }

  for (const delivery of deliveries) {
    const responsibles = Array.isArray(delivery.responsaveis) && delivery.responsaveis.length
      ? delivery.responsaveis
      : ['sem_responsavel'];

    for (const person of responsibles) {
      const item = getOrCreatePerson(peopleMap, person);
      item.concluidas += 1;

      if (hasRealComment(delivery.comentario)) {
        item.com_comentario += 1;
      }
    }
  }

  return Array.from(peopleMap.values())
    .map((item) => ({
      ...item,
      score_uso: calculateUsageScore(item),
    }))
    .sort((a, b) => b.concluidas - a.concluidas);
}

function buildGroupedSummary({ listTasks, deliveries, keyGetter, outputKey, now }) {
  const map = new Map();

  for (const task of listTasks) {
    const key = keyGetter(task);

    if (!map.has(key)) {
      map.set(key, {
        [outputKey]: key,
        concluidas: 0,
        abertas: 0,
        atrasadas_abertas: 0,
      });
    }

    const item = map.get(key);

    if (!isDeliveryTask(task)) {
      item.abertas += 1;

      const dueDate = toNumberOrNull(task.due_date);
      if (dueDate !== null && dueDate < now) {
        item.atrasadas_abertas += 1;
      }
    }
  }

  for (const delivery of deliveries) {
    const key = keyGetter(delivery);

    if (!map.has(key)) {
      map.set(key, {
        [outputKey]: key,
        concluidas: 0,
        abertas: 0,
        atrasadas_abertas: 0,
      });
    }

    map.get(key).concluidas += 1;
  }

  return Array.from(map.values()).sort((a, b) => b.concluidas - a.concluidas);
}

function getOrCreatePerson(map, person) {
  const key = person || 'sem_responsavel';

  if (!map.has(key)) {
    map.set(key, {
      responsavel: key,
      total_tarefas: 0,
      concluidas: 0,
      abertas: 0,
      atrasadas_abertas: 0,
      sem_prazo: 0,
      com_comentario: 0,
      score_uso: 0,
    });
  }

  return map.get(key);
}

function calculateUsageScore(item) {
  let score = 50;

  score += Math.min(25, item.concluidas * 0.15);
  score += Math.min(20, item.com_comentario * 0.12);
  score -= Math.min(25, item.atrasadas_abertas * 2);
  score -= Math.min(15, item.sem_prazo * 0.5);

  return Math.max(0, Math.min(100, Math.round(score)));
}

function mapDelivery(task, comment) {
  return {
    id: String(task.id || ''),
    data_conclusao: timestampToIso(getCompletionTimestamp(task) || task.date_updated),
    tarefa: task.name || '-',
    comentario: comment ? extractCommentText(comment) : 'Sem comentário',
    responsaveis: getAssigneeNames(task),
    criador: safeNested(task, ['creator', 'username']) || safeNested(task, ['creator', 'name']) || null,
    canal: safeNested(task, ['list', 'name']) || 'sem_canal',
    cliente: safeNested(task, ['folder', 'name']) || 'sem_cliente',
    status_final: safeNested(task, ['status', 'status']) || 'sem_status',
    link: task.url || null,
  };
}

function isDeliveryTask(task) {
  return getCompletionTimestamp(task) !== null;
}

function isTaskDoneWithinRange(task, startMs, endMs) {
  const dateDone = getCompletionTimestamp(task);

  if (dateDone === null) return false;

  return dateDone >= startMs && dateDone <= endMs;
}

function getCompletionTimestamp(task) {
  return toNumberOrNull(task.date_done) || toNumberOrNull(task.date_closed);
}

function getAssigneeNames(task) {
  const assignees = Array.isArray(task.assignees) ? task.assignees : [];

  const names = assignees
    .map((assignee) => assignee.username || assignee.name)
    .filter(Boolean);

  return names.length ? names : ['sem_responsavel'];
}

function pickLastComment(comments) {
  if (!Array.isArray(comments) || comments.length === 0) return null;

  return [...comments].sort((a, b) => {
    const dateA = toNumberOrNull(a.date) || 0;
    const dateB = toNumberOrNull(b.date) || 0;
    return dateB - dateA;
  })[0];
}

function extractCommentText(comment) {
  if (!comment) return 'Sem comentário';

  if (typeof comment.comment_text === 'string' && comment.comment_text.trim()) {
    return comment.comment_text.trim();
  }

  if (typeof comment.comment === 'string' && comment.comment.trim()) {
    return comment.comment.trim();
  }

  if (typeof comment.text_content === 'string' && comment.text_content.trim()) {
    return comment.text_content.trim();
  }

  if (Array.isArray(comment.comment)) {
    return comment.comment
      .map((part) => part.text || part.plain_text || '')
      .filter(Boolean)
      .join(' ')
      .trim() || 'Sem comentário';
  }

  return 'Sem comentário';
}

function hasRealComment(value) {
  const text = String(value || '').trim();
  return text.length > 0 && text !== 'Sem comentário';
}

function normalizeDateRange(dateFrom, dateTo) {
  const now = new Date();
  const defaultFrom = new Date(now.getFullYear(), now.getMonth(), 1);
  const defaultTo = new Date(now.getFullYear(), now.getMonth() + 1, 0);

  const fromStr = dateFrom || formatDateYYYYMMDD(defaultFrom);
  const toStr = dateTo || formatDateYYYYMMDD(defaultTo);

  const start = new Date(`${fromStr}T00:00:00.000Z`);
  const end = new Date(`${toStr}T23:59:59.999Z`);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new ClickUpServiceError('Período inválido.', 400, 'INVALID_DATE_RANGE');
  }

  if (start.getTime() > end.getTime()) {
    throw new ClickUpServiceError('date_from não pode ser maior que date_to.', 400, 'INVALID_DATE_RANGE');
  }

  return {
    dateFrom: fromStr,
    dateTo: toStr,
    startMs: start.getTime(),
    endMs: end.getTime(),
  };
}

function timestampToIso(value) {
  const number = toNumberOrNull(value);

  if (number === null) return null;

  return new Date(number).toISOString();
}

function formatDateYYYYMMDD(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

function safeNested(obj, path) {
  return path.reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), obj);
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toSafeInteger(value, defaultValue, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const number = Number.parseInt(value, 10);

  if (!Number.isFinite(number)) return defaultValue;

  return Math.max(min, Math.min(max, number));
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

async function mapLimit(items, limit, mapper) {
  const results = [];
  const executing = [];

  for (const item of items) {
    const promise = Promise.resolve().then(() => mapper(item));
    results.push(promise);

    const clean = () => {
      const index = executing.indexOf(promise);
      if (index >= 0) executing.splice(index, 1);
    };

    promise.then(clean, clean);
    executing.push(promise);

    if (executing.length >= limit) {
      await Promise.race(executing);
    }
  }

  return Promise.all(results);
}

function getCache(key, ttlSeconds) {
  if (!ttlSeconds) return null;

  const item = cache.get(key);
  if (!item) return null;

  if (Date.now() > item.expiresAt) {
    cache.delete(key);
    return null;
  }

  return item.value;
}

function setCache(key, value) {
  const ttlSeconds = toSafeInteger(process.env.CLICKUP_CACHE_TTL_SECONDS, 300, 0, 3600);
  if (!ttlSeconds) return;

  cache.set(key, {
    value,
    expiresAt: Date.now() + ttlSeconds * 1000,
  });
}

module.exports = {
  getResumoExecutivo,
  ClickUpServiceError,
};
