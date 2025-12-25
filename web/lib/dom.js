export const LOG_PREFIX = "[PromptHistoryGallery]";

export const logInfo = (logger = console, ...messages) => logger?.info?.(LOG_PREFIX, ...messages);
export const logError = (logger = console, ...messages) => logger?.error?.(LOG_PREFIX, ...messages);

export const createEl = (tag, className = "", text = null) => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== null && text !== undefined) el.textContent = text;
  return el;
};

export const safeText = (value, fallback = "") =>
  value === null || value === undefined ? fallback : String(value);

export { clamp } from "./numberUtils.js";

export function ensureStylesheet() {
  const attr = "data-phg-style";
  if (document.head.querySelector(`link[${attr}]`)) return;
  const styleHref = new URL("../style.css", import.meta.url).href;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = styleHref;
  link.setAttribute(attr, "true");
  document.head.appendChild(link);
}

export function formatTimestamp(value) {
  if (!value) return "Unknown";
  try {
    return new Date(value).toLocaleString();
  } catch (_) {
    return String(value);
  }
}
