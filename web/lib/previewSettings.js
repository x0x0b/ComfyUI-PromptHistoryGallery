const STORAGE_KEY = "phg.preview.settings";

const MIN_VIEWPORT_PERCENT = 5;
const MAX_VIEWPORT_PERCENT = 75;
const DEFAULT_SETTINGS = Object.freeze({
  imageSize: 110,
  displayDuration: 6000,
  position: "bottom-left",
  enabled: true,
  landscapeViewportPercent: 20,
  portraitViewportPercent: 40,
  highlightUsage: true,
  highlightUsageRatio: 0.80,
  highlightUsageStartCount: 5,
  historyLimit: 120,
});

export const PREVIEW_POSITIONS = Object.freeze([
  { value: "top-left", label: "Top Left" },
  { value: "top-right", label: "Top Right" },
  { value: "bottom-left", label: "Bottom Left" },
  { value: "bottom-right", label: "Bottom Right" },
]);

const POSITION_SET = new Set(PREVIEW_POSITIONS.map((item) => item.value));

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function clampInt(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  const clamped = clamp(Math.round(num), min, max);
  return clamped;
}

function clampPercent(value, fallback) {
  const numeric = Number.isFinite(value) ? value : fallback;
  return clamp(numeric, MIN_VIEWPORT_PERCENT, MAX_VIEWPORT_PERCENT);
}

function clampHistoryLimit(value) {
  return clampInt(value, 20, 1000, DEFAULT_SETTINGS.historyLimit);
}

function normalizeSettings(overrides = {}) {
  const normalized = { ...DEFAULT_SETTINGS, ...(overrides || {}) };
  const size = Number(normalized.imageSize);
  normalized.imageSize = clamp(
    Number.isFinite(size) ? size : DEFAULT_SETTINGS.imageSize,
    72,
    220
  );
  const duration = Number(normalized.displayDuration);
  normalized.displayDuration = clamp(
    Number.isFinite(duration) ? duration : DEFAULT_SETTINGS.displayDuration,
    1500,
    60000
  );
  const usageRatio = Number(normalized.highlightUsageRatio);
  normalized.highlightUsageRatio = clamp(
    Number.isFinite(usageRatio)
      ? usageRatio
      : DEFAULT_SETTINGS.highlightUsageRatio,
    0.05,
    1
  );
  if (typeof normalized.highlightUsage !== "boolean") {
    normalized.highlightUsage = DEFAULT_SETTINGS.highlightUsage;
  }
  normalized.highlightUsageStartCount = clampInt(
    normalized.highlightUsageStartCount,
    1,
    100,
    DEFAULT_SETTINGS.highlightUsageStartCount
  );
  normalized.landscapeViewportPercent = clampPercent(
    Number(normalized.landscapeViewportPercent),
    DEFAULT_SETTINGS.landscapeViewportPercent
  );
  normalized.portraitViewportPercent = clampPercent(
    Number(normalized.portraitViewportPercent),
    DEFAULT_SETTINGS.portraitViewportPercent
  );
  normalized.position = POSITION_SET.has(normalized.position)
    ? normalized.position
    : DEFAULT_SETTINGS.position;
  if (typeof normalized.enabled !== "boolean") {
    normalized.enabled = DEFAULT_SETTINGS.enabled;
  }
  normalized.historyLimit = clampHistoryLimit(normalized.historyLimit);
  return normalized;
}

function readSettingsFromStorage() {
  if (typeof localStorage === "undefined") {
    return DEFAULT_SETTINGS;
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return DEFAULT_SETTINGS;
    }
    const parsed = JSON.parse(raw);
    return normalizeSettings(parsed);
  } catch (_) {
    return DEFAULT_SETTINGS;
  }
}

function writeSettingsToStorage(settings) {
  if (typeof localStorage === "undefined") {
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch (_) {
    /* ignore quota errors */
  }
}

function createPreviewSettingsStore() {
  let state = readSettingsFromStorage();
  const listeners = new Set();

  const notify = () => {
    const snapshot = state;
    listeners.forEach((listener) => {
      try {
        listener(snapshot);
      } catch (error) {
        console.error("[PromptHistoryGallery] settings listener error", error);
      }
    });
  };

  return {
    getState() {
      return state;
    },
    subscribe(listener) {
      if (typeof listener !== "function") {
        return () => {};
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update(patch) {
      state = normalizeSettings({ ...state, ...(patch || {}) });
      writeSettingsToStorage(state);
      notify();
    },
    reset() {
      state = normalizeSettings(DEFAULT_SETTINGS);
      writeSettingsToStorage(state);
      notify();
    },
  };
}

let singletonStore = null;

export function getPreviewSettingsStore() {
  if (singletonStore) {
    return singletonStore;
  }
  singletonStore = createPreviewSettingsStore();
  return singletonStore;
}

export {
  DEFAULT_SETTINGS,
  MIN_VIEWPORT_PERCENT,
  MAX_VIEWPORT_PERCENT,
  clampPercent,
};
