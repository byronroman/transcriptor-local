import { register } from "../runtime.js";

function apiDetailMessage(detail) {
  if (!detail) return "";
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((item) => {
        if (typeof item === "string") return item;
        if (!item || typeof item !== "object") return "";
        const location = Array.isArray(item.loc) ? item.loc.join(".") : "";
        const message = item.msg || item.message || item.detail || "";
        return [location, message].filter(Boolean).join(": ");
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof detail === "object") {
    for (const key of ["message", "msg", "error", "detail"]) {
      if (detail[key]) return apiDetailMessage(detail[key]);
    }
    return "";
  }
  return String(detail);
}

function normalizeErrorMessage(error, fallback = "No se pudo completar la operacion.") {
  if (!error) return fallback;
  if (typeof error === "string") return error;
  const detail = apiDetailMessage(error.data?.detail || error.detail);
  const text = String(error.text || "").trim();
  const message = String(error.message || "").trim();
  return detail || message || text || fallback;
}

function sanitizeVisibleErrorMessage(message, fallback = "No se pudo completar la operacion.") {
  const text = String(message || "").trim();
  if (!text) return fallback;
  const lowered = text.toLowerCase();
  if ((lowered.includes("winerror 5") || lowered.includes("access is denied")) && lowered.includes("project.json")) {
    return "Windows bloqueo temporalmente el archivo del proyecto. Reinicia la app local y presiona Reanudar.";
  }
  return text
    .replace(/[A-Za-z]:\\[^\n\r'"<>|]+/g, "[ruta local]")
    .replace(/\/(?:Users|home|var|tmp|private|Volumes)\/[^\n\r'"<>]+/g, "[ruta local]")
    .replace(/['"]?\[ruta local\]['"]?/g, "[ruta local]")
    .trim()
    .slice(0, 500);
}

function visibleErrorMessage(error, fallback = "No se pudo completar la operacion.") {
  return sanitizeVisibleErrorMessage(normalizeErrorMessage(error, fallback), fallback);
}

function showError(error, fallback) {
  alert(visibleErrorMessage(error, fallback));
}

register({
  apiDetailMessage,
  normalizeErrorMessage,
  sanitizeVisibleErrorMessage,
  visibleErrorMessage,
  showError,
});
