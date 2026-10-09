import { clamp } from "./numberUtils.js";

const STORAGE_KEY = "phg.preview.settings";

const MIN_VIEWPORT_PERCENT = 5;
const MAX_VIEWPORT_PERCENT = 75;

const DIALOG_THEMES = Object.freeze([
  {
    value: "blue",
    label: "Blue",
    from: "#0e1628",
    to: "#0f111f",
    accent: "#38bdf8",
    accentAlt: "#2dd4bf",
    tint: "#38bdf8",
    glow: "#5eead4",
  },
  {
    value: "violet",
    label: "Violet",
    from: "#150e26",
    to: "#120f20",
    accent: "#a78bfa",
    accentAlt: "#e879f9",
    tint: "#a78bfa",
    glow: "#e879f9",
  },
  {
    value: "teal",
    label: "Teal",
    from: "#0a1e21",
    to: "#0c1719",
    accent: "#2dd4bf",
    accentAlt: "#38bdf8",
    tint: "#2dd4bf",
    glow: "#38bdf8",
  },
  {
    value: "amber",
    label: "Amber",
    from: "#221809",
    to: "#1b130a",
    accent: "#fbbf24",
    accentAlt: "#fb7185",
    tint: "#fbbf24",
    glow: "#fb7185",
  },
  {
    value: "rose",
    label: "Rose",
    from: "#230e18",
    to: "#1a0c13",
    accent: "#fb7185",
    accentAlt: "#f472b6",
    tint: "#fb7185",
    glow: "#f472b6",
  },
  {
    value: "neutral",
    label: "Neutral",
    from: "#15171b",
    to: "#101114",
    accent: "#94a3b8",
    accentAlt: "#cbd5e1",
    tint: "#cbd5e1",
    glow: "#94a3b8",
  },
]);

const DEFAULT_DIALOG_THEME = DIALOG_THEMES[0].value;

const THEME_SET = new Set(DIALOG_THEMES.map((theme) => theme.value));

const DEFAULT_SETTINGS = Object.freeze({
  imageSize: 110,
  displayDuration: 6000,
  position: "bottom-left",
  enabled: true,
  landscapeViewportPercent: 20,
  portraitViewportPercent: 40,
  highlightUsage: true,
  highlightUsageRatio: 0.8,
  highlightUsageStartCount: 5,
  historyLimit: 120,
  captureHistory: true,
  dialogTheme: DEFAULT_DIALOG_THEME,
});

export function resolveDialogTheme(value) {
  return DIALOG_THEMES.find((theme) => theme.value === value) ?? DIALOG_THEMES[0];
}

export function dialogThemeVariables(value) {
  const theme = resolveDialogTheme(value);
  return {
    "--phg-surface-from": theme.from,
    "--phg-surface-to": theme.to,
    "--phg-backdrop-tint": theme.tint,
    "--phg-backdrop-glow": theme.glow,
    "--phg-accent": theme.accent,
    "--phg-accent-alt": theme.accentAlt,
  };
}

export const PREVIEW_POSITIONS = Object.freeze([
  { value: "top-left", label: "Top Left" },
  { value: "top-right", label: "Top Right" },
  { value: "bottom-left", label: "Bottom Left" },
  { value: "bottom-right", label: "Bottom Right" },
]);

const POSITION_SET = new Set(PREVIEW_POSITIONS.map((item) => item.value));

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
  normalized.imageSize = clamp(Number.isFinite(size) ? size : DEFAULT_SETTINGS.imageSize, 72, 220);
  const duration = Number(normalized.displayDuration);
  normalized.displayDuration = clamp(
    Number.isFinite(duration) ? duration : DEFAULT_SETTINGS.displayDuration,
    1500,
    60000
  );
  const usageRatio = Number(normalized.highlightUsageRatio);
  normalized.highlightUsageRatio = clamp(
    Number.isFinite(usageRatio) ? usageRatio : DEFAULT_SETTINGS.highlightUsageRatio,
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
  if (typeof normalized.captureHistory !== "boolean") {
    normalized.captureHistory = DEFAULT_SETTINGS.captureHistory;
  }
  normalized.dialogTheme = THEME_SET.has(normalized.dialogTheme)
    ? normalized.dialogTheme
    : DEFAULT_SETTINGS.dialogTheme;
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
  DIALOG_THEMES,
  MIN_VIEWPORT_PERCENT,
  MAX_VIEWPORT_PERCENT,
  clampPercent,
};
