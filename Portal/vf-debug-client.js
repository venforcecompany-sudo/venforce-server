(function () {
  "use strict";

  const USER_KEY = "vf-user";
  const TOKEN_KEY = "vf-token";
  const DEBUG_ENABLED_KEY = "vf-debug-enabled";
  const DEBUG_LOG_KEY = "vf-debug-logs";
  const MAX_LOGS = 100;
  const MAX_TEXT_CHARS = 4000;
  const MAX_RESPONSE_BYTES = 50000;
  const SENSITIVE_KEY_PARTS = [
    "authorization",
    "accesstoken",
    "refreshtoken",
    "apikey",
    "token",
    "password",
    "senha",
    "xapikey",
    "clientsecret"
  ];

  syncUrlFlag();
  exposeApi();

  if (isActive()) {
    install();
  }

  function install() {
    try {
      if (typeof window.fetch !== "function") return false;
      if (window.fetch.__vfDebugWrapped) return true;

      const originalFetch = window.fetch.__vfDebugOriginalFetch || window.fetch.bind(window);

      function vfDebugFetch() {
        const args = Array.prototype.slice.call(arguments);
        if (!isActive()) {
          return originalFetch.apply(window, args);
        }
        return observeFetch(originalFetch, args);
      }

      vfDebugFetch.__vfDebugWrapped = true;
      vfDebugFetch.__vfDebugOriginalFetch = originalFetch;
      window.fetch = vfDebugFetch;
      exposeApi();
      return true;
    } catch {
      return false;
    }
  }

  function observeFetch(originalFetch, args) {
    const startedAt = now();
    const requestMeta = buildRequestMeta(args);

    return originalFetch.apply(window, args)
      .then((response) => {
        const duration = Math.round(now() - startedAt);
        const baseEntry = buildBaseEntry(requestMeta, {
          status: response.status,
          duration,
          contentType: response.headers?.get?.("content-type") || "",
          error: buildHttpError(response.status)
        });

        captureResponse(response)
          .then((responsePayload) => {
            saveLog({ ...baseEntry, response: responsePayload });
          })
          .catch((error) => {
            saveLog({
              ...baseEntry,
              response: { captured: false, reason: "response clone unavailable" },
              error: baseEntry.error || {
                type: "debug-capture",
                message: sanitizeText(error?.message || "response clone unavailable")
              }
            });
          });

        return response;
      })
      .catch((error) => {
        const duration = Math.round(now() - startedAt);
        saveLog(buildBaseEntry(requestMeta, {
          status: 0,
          duration,
          contentType: "",
          response: null,
          error: {
            type: "network",
            message: sanitizeText(error?.message || "fetch error")
          }
        }));
        throw error;
      });
  }

  function buildBaseEntry(meta, result) {
    const timestamp = new Date().toISOString();
    const status = Number(result.status || 0);

    return sanitizePayload({
      id: `browser-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      source: "browser",
      timestamp,
      time: formatClock(new Date(timestamp)),
      screen: currentPage(),
      method: meta.method,
      endpoint: meta.endpoint,
      url: meta.url,
      status,
      duration: Number(result.duration || 0),
      description: describeRequest(meta.method, status, meta.endpoint),
      payload: meta.payload,
      response: result.response || null,
      error: result.error || null,
      contentType: result.contentType || "",
      storage: "sessionStorage"
    });
  }

  function buildRequestMeta(args) {
    const input = args[0];
    const init = args[1] || {};
    const rawUrl = getInputUrl(input);
    const method = String(init.method || getInputMethod(input) || "GET").toUpperCase();
    const inputHeaders = getInputHeaders(input);
    const initHeaders = headersToObject(init.headers);
    const headers = { ...inputHeaders, ...initHeaders };
    const body = Object.prototype.hasOwnProperty.call(init, "body")
      ? summarizeBody(init.body, headers)
      : summarizeInputBody(input);

    const payload = sanitizePayload({
      headers,
      body
    });

    return {
      method,
      url: sanitizeUrl(rawUrl),
      endpoint: endpointFromUrl(rawUrl),
      payload
    };
  }

  async function captureResponse(response) {
    const clone = response.clone();
    const contentType = response.headers?.get?.("content-type") || "";
    const contentLength = Number(response.headers?.get?.("content-length") || 0);

    if (contentLength > MAX_RESPONSE_BYTES) {
      return sanitizePayload({
        captured: false,
        reason: `response too large (${contentLength} bytes)`,
        contentType
      });
    }

    if (!isTextLikeContent(contentType)) {
      return sanitizePayload({
        captured: false,
        reason: contentType ? `content type ${contentType}` : "non text response",
        contentType
      });
    }

    const text = await clone.text();
    const clipped = truncateLongText(text);

    if (contentType.includes("json")) {
      try {
        return sanitizePayload(JSON.parse(clipped));
      } catch {
        return sanitizePayload({ raw: clipped });
      }
    }

    return sanitizePayload({ raw: clipped });
  }

  function saveLog(entry) {
    try {
      const logs = readLogs();
      logs.push(sanitizePayload(entry));
      const limited = logs.slice(-MAX_LOGS);
      sessionStorage.setItem(DEBUG_LOG_KEY, JSON.stringify(limited));
      window.dispatchEvent(new CustomEvent("vf-debug-log", { detail: limited[limited.length - 1] }));
    } catch {
      // Debug logging must never affect application requests.
    }
  }

  function readLogs() {
    try {
      const parsed = JSON.parse(sessionStorage.getItem(DEBUG_LOG_KEY) || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function clearLogs() {
    try {
      sessionStorage.removeItem(DEBUG_LOG_KEY);
      localStorage.removeItem(DEBUG_LOG_KEY);
    } catch {
      // Storage can fail in restricted browser contexts.
    }
  }

  function enable() {
    if (!isAdminUser() || !hasToken()) return false;
    localStorage.setItem(DEBUG_ENABLED_KEY, "true");
    return install();
  }

  function disable() {
    localStorage.setItem(DEBUG_ENABLED_KEY, "false");
    restoreOriginalFetch();
    exposeApi();
    return true;
  }

  function restoreOriginalFetch() {
    try {
      if (window.fetch?.__vfDebugWrapped && window.fetch.__vfDebugOriginalFetch) {
        window.fetch = window.fetch.__vfDebugOriginalFetch;
      }
    } catch {
      // Leave fetch as-is if the browser refuses assignment.
    }
  }

  function exposeApi() {
    window.VFDebugClient = {
      version: "1.0.0",
      logKey: DEBUG_LOG_KEY,
      maxLogs: MAX_LOGS,
      isActive,
      isAdmin: isAdminUser,
      install,
      enable,
      disable,
      getLogs: readLogs,
      clearLogs,
      sanitizePayload,
      maskSensitive
    };
  }

  function syncUrlFlag() {
    try {
      const params = new URLSearchParams(window.location.search || "");
      const value = params.get("vf_debug");
      if (value === "0" || value === "false" || value === "off") {
        localStorage.setItem(DEBUG_ENABLED_KEY, "false");
      }
      if ((value === "1" || value === "true" || value === "on") && isAdminUser() && hasToken()) {
        localStorage.setItem(DEBUG_ENABLED_KEY, "true");
      }
    } catch {
      // URL parsing should not influence the page if it fails.
    }
  }

  function isActive() {
    return isAdminUser() && hasToken() && localStorage.getItem(DEBUG_ENABLED_KEY) === "true";
  }

  function isAdminUser() {
    const role = String(readUserSafe().role || "").toLowerCase();
    return role === "admin";
  }

  function hasToken() {
    return !!localStorage.getItem(TOKEN_KEY);
  }

  function readUserSafe() {
    try {
      return JSON.parse(localStorage.getItem(USER_KEY) || "{}") || {};
    } catch {
      return {};
    }
  }

  function getInputUrl(input) {
    if (typeof Request !== "undefined" && input instanceof Request) return input.url;
    if (typeof URL !== "undefined" && input instanceof URL) return input.href;
    return String(input || "");
  }

  function getInputMethod(input) {
    if (typeof Request !== "undefined" && input instanceof Request) return input.method;
    return "";
  }

  function getInputHeaders(input) {
    if (typeof Request !== "undefined" && input instanceof Request) {
      return headersToObject(input.headers);
    }
    return {};
  }

  function summarizeInputBody(input) {
    if (typeof Request !== "undefined" && input instanceof Request) {
      return "[Request body not inspected]";
    }
    return null;
  }

  function headersToObject(headers) {
    const out = {};
    if (!headers) return out;

    try {
      if (typeof Headers !== "undefined" && headers instanceof Headers) {
        headers.forEach((value, key) => {
          out[key] = value;
        });
        return out;
      }

      if (Array.isArray(headers)) {
        headers.forEach((pair) => {
          if (Array.isArray(pair) && pair.length >= 2) out[pair[0]] = pair[1];
        });
        return out;
      }

      if (typeof headers === "object") {
        Object.entries(headers).forEach(([key, value]) => {
          out[key] = value;
        });
      }
    } catch {
      return {};
    }

    return out;
  }

  function summarizeBody(body, headers) {
    if (body === null || body === undefined) return null;

    if (typeof FormData !== "undefined" && body instanceof FormData) {
      const form = {};
      body.forEach((value, key) => {
        form[key] = summarizeBodyValue(value);
      });
      return form;
    }

    if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
      return Object.fromEntries(body.entries());
    }

    if (typeof Blob !== "undefined" && body instanceof Blob) {
      return {
        blob: true,
        size: body.size,
        type: body.type || "application/octet-stream"
      };
    }

    if (typeof ArrayBuffer !== "undefined" && body instanceof ArrayBuffer) {
      return { arrayBuffer: true, bytes: body.byteLength };
    }

    if (ArrayBuffer.isView?.(body)) {
      return { typedArray: true, bytes: body.byteLength };
    }

    if (typeof body === "string") {
      const text = truncateLongText(body);
      const contentType = String(
        Object.entries(headers || {})
          .find(([key]) => String(key).toLowerCase() === "content-type")?.[1] || ""
      );

      if (contentType.includes("json") || /^[\[{]/.test(text.trim())) {
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      }

      return text;
    }

    if (typeof body === "object") {
      return "[Request body stream/object not inspected]";
    }

    return String(body);
  }

  function summarizeBodyValue(value) {
    if (typeof File !== "undefined" && value instanceof File) {
      return {
        file: value.name,
        size: value.size,
        type: value.type || "application/octet-stream"
      };
    }
    return value;
  }

  function sanitizePayload(data, seen = new WeakSet()) {
    if (data === null || data === undefined) return data;

    if (typeof data === "string") {
      return looksSensitiveValue(data) ? maskSensitive(data) : truncateLongText(data);
    }

    if (typeof data === "number" || typeof data === "boolean") return data;

    if (Array.isArray(data)) {
      return data.map((item) => sanitizePayload(item, seen));
    }

    if (typeof data === "object") {
      if (seen.has(data)) return "[Circular]";
      seen.add(data);

      if (data instanceof Date) return data.toISOString();

      return Object.entries(data).reduce((acc, [key, value]) => {
        acc[key] = isSensitiveKey(key) ? maskSensitive(value) : sanitizePayload(value, seen);
        return acc;
      }, {});
    }

    return String(data);
  }

  function isSensitiveKey(key) {
    const normalized = String(key || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
  }

  function maskSensitive(value) {
    const text = String(value || "");
    if (!text) return "ausente";

    if (/^Bearer\s+/i.test(text)) {
      const token = text.replace(/^Bearer\s+/i, "");
      if (!token) return "Bearer ausente";
      return `Bearer ${token.slice(0, 3)}...****`;
    }

    if (text.length <= 8) return "****";
    return `${text.slice(0, 4)}...****`;
  }

  function looksSensitiveValue(value) {
    const text = String(value || "").trim();
    if (/^Bearer\s+/i.test(text)) return true;
    if (/^eyJ[a-zA-Z0-9_-]+\./.test(text)) return true;
    if (/^vf_[a-f0-9]{16,}$/i.test(text)) return true;
    if (/^(sk|pk|ghp|glpat)_[a-zA-Z0-9_-]{16,}$/i.test(text)) return true;
    return text.length > 80 && /^[a-zA-Z0-9._-]+$/.test(text);
  }

  function sanitizeUrl(value) {
    const raw = String(value || "");
    if (!raw) return "";

    try {
      const url = new URL(raw, window.location.href);
      url.searchParams.forEach((paramValue, key) => {
        if (isSensitiveKey(key) || looksSensitiveValue(paramValue)) {
          url.searchParams.set(key, maskSensitive(paramValue));
        }
      });

      url.pathname = url.pathname.split("/").map((segment) => {
        const decoded = safeDecode(segment);
        return looksSensitiveValue(decoded) ? encodeURIComponent(maskSensitive(decoded)) : segment;
      }).join("/");

      return url.toString();
    } catch {
      return looksSensitiveValue(raw) ? maskSensitive(raw) : raw;
    }
  }

  function endpointFromUrl(value) {
    try {
      const url = new URL(String(value || ""), window.location.href);
      url.searchParams.forEach((paramValue, key) => {
        if (isSensitiveKey(key) || looksSensitiveValue(paramValue)) {
          url.searchParams.set(key, maskSensitive(paramValue));
        }
      });
      url.pathname = url.pathname.split("/").map((segment) => {
        const decoded = safeDecode(segment);
        return looksSensitiveValue(decoded) ? encodeURIComponent(maskSensitive(decoded)) : segment;
      }).join("/");
      return `${url.pathname}${url.search}`;
    } catch {
      return sanitizeUrl(value);
    }
  }

  function safeDecode(value) {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  function isTextLikeContent(contentType) {
    const type = String(contentType || "").toLowerCase();
    if (!type) return true;
    return type.includes("json")
      || type.includes("text")
      || type.includes("html")
      || type.includes("xml")
      || type.includes("javascript")
      || type.includes("form-urlencoded");
  }

  function buildHttpError(status) {
    if (status === 401) return { type: "auth", message: "HTTP 401" };
    if (status === 403) return { type: "permission", message: "HTTP 403" };
    if (status >= 500) return { type: "server", message: `HTTP ${status}` };
    if (status >= 400) return { type: "http", message: `HTTP ${status}` };
    return null;
  }

  function describeRequest(method, status, endpoint) {
    if (status === 0) return `${method} network ${endpoint}`;
    if (status >= 500) return `${method} ${status} server error`;
    if (status >= 400) return `${method} ${status} auth/client error`;
    return `${method} ${status} ${endpoint}`;
  }

  function currentPage() {
    const page = (window.location.pathname || "").split("/").pop();
    return page || "portal";
  }

  function formatClock(date) {
    return [
      String(date.getHours()).padStart(2, "0"),
      String(date.getMinutes()).padStart(2, "0"),
      String(date.getSeconds()).padStart(2, "0")
    ].join(":");
  }

  function now() {
    return window.performance?.now ? window.performance.now() : Date.now();
  }

  function truncateLongText(value) {
    const text = String(value || "");
    return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}...[truncated]` : text;
  }

  function sanitizeText(value) {
    return truncateLongText(String(value || "").replace(/\s+/g, " ").trim());
  }
})();
