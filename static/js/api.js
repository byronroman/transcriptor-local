import { register } from "./runtime.js";

function createApiError(message, response, data, text) {
  const error = new Error(message || response?.statusText || "Error de servidor");
  error.name = "ApiError";
  error.status = response?.status || 0;
  error.statusText = response?.statusText || "";
  error.url = response?.url || "";
  error.data = data;
  error.text = text || "";
  return error;
}

function apiFireAndForget(path, options = {}) {
  fetch(path, options).catch(() => {});
}

async function api(path, options = {}) {
  let response = null;
  try {
    response = await fetch(path, options);
  } catch (error) {
    throw createApiError(
      error?.name === "AbortError" ? "La solicitud fue cancelada." : "No se pudo conectar con la app local.",
      null,
      null,
      ""
    );
  }
  let text = "";
  try {
    text = await response.text();
  } catch (_) {
    text = "";
  }
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (_) {
      data = null;
    }
  }
  if (!response.ok) {
    const detail = data && typeof data === "object" ? apiDetailMessage(data.detail) : "";
    const message = detail || text.trim() || response.statusText || `HTTP ${response.status}`;
    throw createApiError(message, response, data, text);
  }
  return data ?? {};
}

register({
  createApiError,
  apiFireAndForget,
  api,
});
