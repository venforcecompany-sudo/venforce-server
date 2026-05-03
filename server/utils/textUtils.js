// server/utils/textUtils.js
// Helpers de texto e normalização extraídos de server/index.js.
// Funções puras. NÃO alterar comportamento sem revisar todos os usos.

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function normalizeKey(value) {
  return normalizeText(value).replace(/\s+/g, " ");
}

function normalizeId(value) {
  if (value === null || value === undefined) return "";

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "";
    return Math.trunc(value).toString();
  }

  let text = String(value).trim();
  if (!text) return "";

  const scientificLike = text.replace(",", ".");
  if (/^\d+(\.\d+)?e\+\d+$/i.test(scientificLike)) {
    const num = Number(scientificLike);
    if (Number.isFinite(num)) {
      return Math.trunc(num).toString();
    }
  }

  const cleaned = text.replace(/^MLB/i, "").replace(/\D/g, "");
  return cleaned ? `MLB${cleaned}` : "";
}

function normalizeIdNoPrefix(value) {
  const full = normalizeId(value);
  return full.replace(/^MLB/i, "");
}

function normalizeMatchKey(value) {
  let text = String(value ?? "").trim();
  if (!text) return "";
  text = text
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
  if (/^-?\d+(\.0+)?$/.test(text)) {
    text = text.replace(/\.0+$/, "");
  }
  return text;
}

function normalizeShopeeId(value) {
  let text = String(value ?? "").trim();
  if (!text) return "";
  text = text
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "");
  if (/^-?\d+(\.0+)?$/.test(text)) {
    text = text.replace(/\.0+$/, "");
  }
  return text;
}

function findField(row, candidates) {
  const entries = Object.entries(row);

  for (const [key, value] of entries) {
    const normalized = normalizeKey(key);

    for (const candidate of candidates) {
      if (normalized === candidate) return value;
    }
  }

  for (const [key, value] of entries) {
    const normalized = normalizeKey(key);

    for (const candidate of candidates) {
      if (normalized.includes(candidate)) return value;
    }
  }

  return "";
}

module.exports = {
  normalizeText,
  normalizeKey,
  normalizeId,
  normalizeIdNoPrefix,
  normalizeMatchKey,
  normalizeShopeeId,
  findField,
};
