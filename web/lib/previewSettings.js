const STORAGE_KEY = "phg.preview.settings";
const DEFAULT_SETTINGS = Object.freeze({
  imageSize: 110,
  displayDuration: 6000,
  position: "bottom-left",
  enabled: true,
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
  normalized.position = POSITION_SET.has(normalized.position)
    ? normalized.position
    : DEFAULT_SETTINGS.position;
  if (typeof normalized.enabled !== "boolean") {
    normalized.enabled = DEFAULT_SETTINGS.enabled;
  }
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

export { DEFAULT_SETTINGS };
