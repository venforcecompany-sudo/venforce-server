const ClickUpExecutivo = (() => {
  const DEFAULT_API_URL = 'https://venforce-server.onrender.com';

  const state = {
    data: null,
    filteredDeliveries: [],
  };

  const els = {};

  function init() {
    bindElements();
    setDefaultDates();
    bindEvents();
    loadData();
  }

  function bindElements() {
    els.dateFrom = document.getElementById('clickup-date-from');
    els.dateTo = document.getElementById('clickup-date-to');
    els.personFilter = document.getElementById('clickup-person-filter');
    els.clientFilter = document.getElementById('clickup-client-filter');
    els.channelFilter = document.getElementById('clickup-channel-filter');
    els.search = document.getElementById('clickup-search');

    els.refresh = document.getElementById('btn-clickup-refresh');
    els.export = document.getElementById('btn-clickup-export');
    els.alert = document.getElementById('clickup-alert');

    els.kpiConcluidas = document.getElementById('kpi-concluidas');
    els.kpiAbertas = document.getElementById('kpi-abertas');
    els.kpiAtrasadas = document.getElementById('kpi-atrasadas');
    els.kpiSemPrazo = document.getElementById('kpi-sem-prazo');
    els.kpiClientes = document.getElementById('kpi-clientes');
    els.kpiComentario = document.getElementById('kpi-comentario');

    els.peopleBody = document.querySelector('#clickup-people-table tbody');
    els.deliveriesBody = document.querySelector('#clickup-deliveries-table tbody');
    els.clientRanking = document.getElementById('clickup-client-ranking');
    els.channelRanking = document.getElementById('clickup-channel-ranking');
    els.tableCount = document.getElementById('clickup-table-count');
  }

  function bindEvents() {
    els.refresh?.addEventListener('click', loadData);
    els.export?.addEventListener('click', exportCsv);

    [
      els.personFilter,
      els.clientFilter,
      els.channelFilter,
      els.search,
    ].forEach((input) => input?.addEventListener('input', applyFiltersAndRender));

    [els.dateFrom, els.dateTo].forEach((input) => {
      input?.addEventListener('change', loadData);
    });
  }

  function setDefaultDates() {
    const today = new Date();
    const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);

    els.dateFrom.value = toInputDate(firstDay);
    els.dateTo.value = toInputDate(today);
  }

  async function loadData() {
    setLoading(true);
    hideAlert();

    try {
      const token = localStorage.getItem('vf-token');
      if (!token) {
        window.location.href = 'index.html';
        return;
      }

      const apiBase = window.API_URL || window.VF_API_URL || DEFAULT_API_URL;
      const params = new URLSearchParams({
        date_from: els.dateFrom.value,
        date_to: els.dateTo.value,
        include_comments: 'false',
      });

      const response = await fetch(`${apiBase}/api/clickup/executivo/resumo?${params.toString()}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      });

      const payload = await response.json();

      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error || `Erro HTTP ${response.status}`);
      }

      state.data = payload;
      hydrateFilters(payload);
      applyFiltersAndRender();
    } catch (error) {
      showAlert(error.message || 'Erro ao carregar dados do ClickUp.');
      renderEmpty();
    } finally {
      setLoading(false);
    }
  }

  function hydrateFilters(payload) {
    const entregas = Array.isArray(payload.entregas) ? payload.entregas : [];

    fillSelect(els.personFilter, unique(entregas.flatMap((item) => item.responsaveis || [])), 'Todos');
    fillSelect(els.clientFilter, unique(entregas.map((item) => item.cliente || 'sem_cliente')), 'Todos');
    fillSelect(els.channelFilter, unique(entregas.map((item) => item.canal || 'sem_canal')), 'Todos');
  }

  function applyFiltersAndRender() {
    if (!state.data) return;

    const search = normalize(els.search.value);
    const person = els.personFilter.value;
    const client = els.clientFilter.value;
    const channel = els.channelFilter.value;

    const entregas = Array.isArray(state.data.entregas) ? state.data.entregas : [];

    state.filteredDeliveries = entregas.filter((item) => {
      const text = normalize([
        item.tarefa,
        item.comentario,
        item.cliente,
        item.canal,
        item.status_final,
        ...(item.responsaveis || []),
      ].join(' '));

      const matchesSearch = !search || text.includes(search);
      const matchesPerson = !person || (item.responsaveis || []).includes(person);
      const matchesClient = !client || item.cliente === client;
      const matchesChannel = !channel || item.canal === channel;

      return matchesSearch && matchesPerson && matchesClient && matchesChannel;
    });

    const summary = buildFilteredSummary(state.data, state.filteredDeliveries);

    renderKpis(summary);
    renderPeople(summary.por_pessoa);
    renderRanking(els.clientRanking, countBy(state.filteredDeliveries, 'cliente'), 'entregas');
    renderRanking(els.channelRanking, countBy(state.filteredDeliveries, 'canal'), 'entregas');
    renderDeliveries(state.filteredDeliveries);
  }

  function buildFilteredSummary(payload, deliveries) {
    const originalResumo = payload.resumo || {};
    const clients = new Set(deliveries.map((item) => item.cliente).filter(Boolean));
    const withComments = deliveries.filter((item) => hasComment(item.comentario)).length;

    return {
      resumo: {
        concluidas: deliveries.length,
        abertas: originalResumo.abertas || 0,
        atrasadas_abertas: originalResumo.atrasadas_abertas || 0,
        sem_prazo: originalResumo.sem_prazo || 0,
        clientes_atendidos: clients.size,
        percentual_com_comentario: deliveries.length ? Math.round((withComments / deliveries.length) * 100) : 0,
      },
      por_pessoa: buildPeopleFromDeliveries(deliveries, payload.por_pessoa || []),
    };
  }

  function buildPeopleFromDeliveries(deliveries, backendPeople) {
    const map = new Map();
    const backendMap = new Map(backendPeople.map((item) => [item.responsavel, item]));

    for (const delivery of deliveries) {
      const people = delivery.responsaveis?.length ? delivery.responsaveis : ['sem_responsavel'];

      for (const person of people) {
        if (!map.has(person)) {
          const fromBackend = backendMap.get(person) || {};
          map.set(person, {
            responsavel: person,
            total_tarefas: fromBackend.total_tarefas || 0,
            concluidas: 0,
            abertas: fromBackend.abertas || 0,
            atrasadas_abertas: fromBackend.atrasadas_abertas || 0,
            sem_prazo: fromBackend.sem_prazo || 0,
            com_comentario: 0,
            score_uso: fromBackend.score_uso || 0,
          });
        }

        const item = map.get(person);
        item.concluidas += 1;
        if (hasComment(delivery.comentario)) item.com_comentario += 1;
      }
    }

    return [...map.values()].sort((a, b) => b.concluidas - a.concluidas);
  }

  function renderKpis(summary) {
    const resumo = summary.resumo || {};

    els.kpiConcluidas.textContent = formatNumber(resumo.concluidas);
    els.kpiAbertas.textContent = formatNumber(resumo.abertas);
    els.kpiAtrasadas.textContent = formatNumber(resumo.atrasadas_abertas);
    els.kpiSemPrazo.textContent = formatNumber(resumo.sem_prazo);
    els.kpiClientes.textContent = formatNumber(resumo.clientes_atendidos);
    els.kpiComentario.textContent = `${resumo.percentual_com_comentario || 0}%`;
  }

  function renderPeople(items) {
    if (!items.length) {
      els.peopleBody.innerHTML = `<tr><td class="vf-clickup-empty" colspan="8">Nenhum responsável encontrado.</td></tr>`;
      return;
    }

    els.peopleBody.innerHTML = items.map((item) => `
      <tr>
        <td><strong>${escapeHtml(item.responsavel)}</strong></td>
        <td>${formatNumber(item.total_tarefas)}</td>
        <td>${formatNumber(item.concluidas)}</td>
        <td>${formatNumber(item.abertas)}</td>
        <td>${formatNumber(item.atrasadas_abertas)}</td>
        <td>${formatNumber(item.sem_prazo)}</td>
        <td>${formatNumber(item.com_comentario)}</td>
        <td>${scorePill(item.score_uso)}</td>
      </tr>
    `).join('');
  }

  function renderDeliveries(items) {
    els.tableCount.textContent = `${formatNumber(items.length)} registros`;

    if (!items.length) {
      els.deliveriesBody.innerHTML = `<tr><td class="vf-clickup-empty" colspan="8">Nenhuma entrega encontrada.</td></tr>`;
      return;
    }

    els.deliveriesBody.innerHTML = items.map((item) => `
      <tr>
        <td>${formatDate(item.data_conclusao)}</td>
        <td>${escapeHtml(item.tarefa || '-')}</td>
        <td>${escapeHtml(item.comentario || 'Sem comentário')}</td>
        <td>${escapeHtml((item.responsaveis || []).join(', ') || 'sem_responsavel')}</td>
        <td>${escapeHtml(item.canal || '-')}</td>
        <td>${escapeHtml(item.cliente || '-')}</td>
        <td><span class="vf-clickup-pill">${escapeHtml(item.status_final || '-')}</span></td>
        <td>${item.link ? `<a class="vf-clickup-link" href="${escapeAttribute(item.link)}" target="_blank" rel="noopener">Abrir</a>` : '-'}</td>
      </tr>
    `).join('');
  }

  function renderRanking(container, data, label) {
    const rows = Object.entries(data).sort((a, b) => b[1] - a[1]).slice(0, 8);

    if (!rows.length) {
      container.innerHTML = `<div class="vf-clickup-empty">Sem dados.</div>`;
      return;
    }

    container.innerHTML = rows.map(([name, value], index) => `
      <div class="vf-clickup-ranking-row">
        <div>
          <strong>${index + 1}. ${escapeHtml(name)}</strong>
          <span>${escapeHtml(label)}</span>
        </div>
        <div class="vf-clickup-ranking-value">${formatNumber(value)}</div>
      </div>
    `).join('');
  }

  function renderEmpty() {
    renderKpis({ resumo: {} });
    els.peopleBody.innerHTML = `<tr><td class="vf-clickup-empty" colspan="8">Sem dados carregados.</td></tr>`;
    els.deliveriesBody.innerHTML = `<tr><td class="vf-clickup-empty" colspan="8">Sem dados carregados.</td></tr>`;
    els.clientRanking.innerHTML = `<div class="vf-clickup-empty">Sem dados.</div>`;
    els.channelRanking.innerHTML = `<div class="vf-clickup-empty">Sem dados.</div>`;
  }

  function exportCsv() {
    const headers = ['data_conclusao', 'tarefa', 'comentario', 'responsaveis', 'canal', 'cliente', 'status', 'link'];
    const rows = state.filteredDeliveries.map((item) => [
      formatDate(item.data_conclusao),
      item.tarefa || '',
      item.comentario || '',
      (item.responsaveis || []).join(', '),
      item.canal || '',
      item.cliente || '',
      item.status_final || '',
      item.link || '',
    ]);

    const csv = [headers, ...rows]
      .map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(';'))
      .join('\n');

    const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');

    a.href = url;
    a.download = `gestao_clickup_${els.dateFrom.value}_${els.dateTo.value}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();

    URL.revokeObjectURL(url);
  }

  function fillSelect(select, values, label) {
    const current = select.value;

    select.innerHTML = `<option value="">${label}</option>`;
    values.forEach((value) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      select.appendChild(option);
    });

    if ([...select.options].some((option) => option.value === current)) {
      select.value = current;
    }
  }

  function unique(values) {
    return [...new Set(values.filter(Boolean).map(String))]
      .sort((a, b) => a.localeCompare(b, 'pt-BR'));
  }

  function countBy(items, key) {
    return items.reduce((acc, item) => {
      const value = item[key] || `sem_${key}`;
      acc[value] = (acc[value] || 0) + 1;
      return acc;
    }, {});
  }

  function scorePill(value) {
    const number = Number(value || 0);
    const klass = number >= 80 ? '' : number >= 60 ? 'mid' : 'low';
    return `<span class="vf-clickup-score ${klass}">${number}</span>`;
  }

  function setLoading(isLoading) {
    if (!els.refresh) return;
    els.refresh.disabled = isLoading;
    els.refresh.textContent = isLoading ? 'Carregando...' : 'Atualizar';
  }

  function showAlert(message) {
    els.alert.hidden = false;
    els.alert.textContent = message;
  }

  function hideAlert() {
    els.alert.hidden = true;
    els.alert.textContent = '';
  }

  function hasComment(value) {
    const text = String(value || '').trim();
    return text && text !== 'Sem comentário';
  }

  function normalize(value) {
    return String(value || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  function formatNumber(value) {
    return new Intl.NumberFormat('pt-BR').format(Number(value || 0));
  }

  function formatDate(value) {
    if (!value) return '-';

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '-';

    return new Intl.DateTimeFormat('pt-BR', {
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(date);
  }

  function toInputDate(date) {
    return date.toISOString().slice(0, 10);
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replaceAll('`', '&#096;');
  }

  return {
    init,
  };
})();

document.addEventListener('DOMContentLoaded', ClickUpExecutivo.init);
