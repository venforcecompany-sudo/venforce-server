const clickupService = require('../services/clickupService');

function isValidDateString(value) {
  if (!value) return true;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime());
}

function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return String(value).toLowerCase() === 'true';
}

function parseInteger(value, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue;

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

async function getResumoExecutivo(req, res) {
  try {
    const {
      date_from: dateFrom,
      date_to: dateTo,
      list_id: listId,
      list_name: listName,
    } = req.query;

    if (!isValidDateString(dateFrom) || !isValidDateString(dateTo)) {
      return res.status(400).json({
        ok: false,
        error: 'date_from/date_to devem estar no formato YYYY-MM-DD.',
      });
    }

    const includeComments = parseBoolean(req.query.include_comments, false);
    const pageLimit = parseInteger(req.query.page_limit, undefined);

    const data = await clickupService.getResumoExecutivo({
      dateFrom,
      dateTo,
      listId,
      listName,
      includeComments,
      pageLimit,
    });

    return res.json({
      ok: true,
      ...data,
    });
  } catch (error) {
    const statusCode = error.statusCode || 500;

    return res.status(statusCode).json({
      ok: false,
      error: error.publicMessage || 'Erro ao buscar resumo executivo do ClickUp.',
      code: error.code || 'CLICKUP_EXECUTIVO_ERROR',
    });
  }
}

module.exports = {
  getResumoExecutivo,
};
