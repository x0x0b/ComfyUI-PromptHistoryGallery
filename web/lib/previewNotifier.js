import { createHistoryApi } from "./historyApi.js";
import { buildImageSources } from "./imageSources.js";
import {
  getPreviewSettingsStore,
  DEFAULT_SETTINGS,
  clampPercent,
} from "./previewSettings.js";

const HOST_ATTR = "data-phg-preview-root";
const DEFAULT_DURATION_MS = 6000;
const DEFAULT_MAX_VISIBLE = 3;
const DEFAULT_MAX_IMAGES = Number.POSITIVE_INFINITY;
const DUPLICATE_WINDOW_MS = 800;
const HOST_MARGIN = "1.25rem";
const HOST_MARGIN_PX = 20;
const MIN_IMAGE_SIZE = 72;
const MAX_IMAGE_SIZE = 220;
const DEFAULT_IMAGE_SIZE = 110;
const MIN_DISPLAY_MS = 1500;
const MAX_DISPLAY_MS = 60000;

function ensureHostElement(hostId) {
  if (typeof document === "undefined") return null;
  let host = document.querySelector(`[${HOST_ATTR}="${hostId}"]`);
  if (host) return host;
  if (!document.body) return null;
  host = document.createElement("div");
  host.className = "phg-preview-host";
  host.setAttribute(HOST_ATTR, hostId);
  document.body.appendChild(host);
  return host;
}

function sanitizeEntryId(value) {
  if (value == null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "object") {
    return sanitizeEntryId(
      value.id ??
        value.entry_id ??
        value.entryId ??
        value.value ??
        value.pk ??
        null
    );
  }
  return null;
}

export function extractEntryIds(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) {
    return payload.map(sanitizeEntryId).filter(Boolean);
  }
  const detail = payload.detail ?? payload.data ?? payload.payload;
  if (detail && detail !== payload) {
    const nested = extractEntryIds(detail);
    if (nested.length) {
      return nested;
    }
  }
  const candidate =
    payload.entry_ids ??
    payload.entryIds ??
    payload.ids ??
    payload.entries ??
    payload.id ??
    null;
  if (Array.isArray(candidate)) {
    return candidate.map(sanitizeEntryId).filter(Boolean);
  }
  const single = sanitizeEntryId(candidate);
  return single ? [single] : [];
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function computeRuntimeSettings(settings = {}, fallbackDuration = DEFAULT_DURATION_MS) {
  const resolved = settings || {};
  const useCustom = resolved.enabled !== false;
  const source = useCustom ? resolved : {};
  const displayDurationRaw = Number(
    source.displayDuration ?? fallbackDuration ?? DEFAULT_DURATION_MS
  );
  const imageSizeRaw = Number(source.imageSize ?? DEFAULT_IMAGE_SIZE);
  return {
    displayDuration: clamp(
      Number.isFinite(displayDurationRaw)
        ? displayDurationRaw
        : DEFAULT_DURATION_MS,
      MIN_DISPLAY_MS,
      MAX_DISPLAY_MS
    ),
    imageSize: clamp(
      Number.isFinite(imageSizeRaw) ? imageSizeRaw : DEFAULT_IMAGE_SIZE,
      MIN_IMAGE_SIZE,
      MAX_IMAGE_SIZE
    ),
    landscapeViewportPercent: clampPercent(
      Number(
        source.landscapeViewportPercent ?? DEFAULT_SETTINGS.landscapeViewportPercent
      ),
      DEFAULT_SETTINGS.landscapeViewportPercent
    ),
    portraitViewportPercent: clampPercent(
      Number(
        source.portraitViewportPercent ?? DEFAULT_SETTINGS.portraitViewportPercent
      ),
      DEFAULT_SETTINGS.portraitViewportPercent
    ),
    position:
      typeof source.position === "string"
        ? source.position
        : "bottom-left",
    enabled: useCustom,
  };
}

function applyHostStyles(host, runtimeSettings) {
  if (!host) return;
  const position = runtimeSettings.position ?? "bottom-left";
  host.style.top = "auto";
  host.style.bottom = "auto";
  host.style.left = "auto";
  host.style.right = "auto";
  if (position.startsWith("top")) {
    host.style.top = HOST_MARGIN;
    host.style.justifyContent = "flex-start";
  } else {
    host.style.bottom = HOST_MARGIN;
    host.style.justifyContent = "flex-end";
  }
  if (position.endsWith("right")) {
    host.style.right = HOST_MARGIN;
    host.style.alignItems = "flex-end";
  } else {
    host.style.left = HOST_MARGIN;
    host.style.alignItems = "flex-start";
  }
  host.style.display = runtimeSettings.enabled === false ? "none" : "flex";
}

function applyCardStyles(card, grid, runtimeSettings) {
  const thumbSize = clamp(
    Number(runtimeSettings.imageSize ?? DEFAULT_IMAGE_SIZE),
    MIN_IMAGE_SIZE,
    MAX_IMAGE_SIZE
  );
  if (grid) {
    grid.style.display = "flex";
    grid.style.flexWrap = "wrap";
    grid.style.gap = "0.4rem";
    grid.style.alignItems = "flex-start";
    grid.style.justifyContent = "flex-start";
    grid.style.width = "auto";
    grid.style.maxWidth = "100%";
  }
  if (card) {
    const viewportWidth = Math.max(
      window.innerWidth || document.documentElement?.clientWidth || 1200,
      480
    );
    const minWidth = Math.max(220, thumbSize * 2);
    const maxWidth = Math.min(
      viewportWidth - HOST_MARGIN_PX * 2,
      Math.max(thumbSize * 4, minWidth + 140)
    );
    card.style.minWidth = `${Math.round(minWidth)}px`;
    card.style.maxWidth = `${Math.round(maxWidth)}px`;
    card.style.width = "fit-content";
    card.style.alignSelf = "flex-start";
    card.style.backgroundColor = "rgba(6, 6, 12, 0.92)";
    card.style.borderColor = "rgba(255, 255, 255, 0.14)";
  }
  return thumbSize;
}

function restyleCards(host, runtimeSettings) {
  if (!host) return;
  const cards = host.querySelectorAll?.(".phg-preview-card");
  cards?.forEach((card) => {
    const grid = card.querySelector?.(".phg-preview-grid") ?? null;
    const thumbSize = applyCardStyles(card, grid, runtimeSettings);
    card
      .querySelectorAll?.(".phg-preview-image")
      ?.forEach((button) => {
        button.style.minHeight = `${Math.round(thumbSize)}px`;
        const img = button.querySelector?.("img");
        if (img) {
          applyResponsiveSizing(button, img, card, runtimeSettings);
        }
      });
  });
}

function clearHostCards(host, beforeRemove) {
  if (!host) return;
  const cards = Array.from(host.children);
  cards.forEach((card) => {
    if (typeof beforeRemove === "function") {
      beforeRemove(card);
    }
    card.remove();
  });
}

function viewportSize() {
  if (typeof window === "undefined") {
    return { width: 1280, height: 720 };
  }
  const width =
    window.innerWidth ||
    document.documentElement?.clientWidth ||
    document.body?.clientWidth ||
    1280;
  const height =
    window.innerHeight ||
    document.documentElement?.clientHeight ||
    document.body?.clientHeight ||
    720;
  return {
    width: Math.max(width, 320),
    height: Math.max(height, 320),
  };
}

function computePreviewDimensions(img, runtimeSettings) {
  if (!img?.naturalWidth || !img?.naturalHeight) return null;
  const { width: viewportWidth, height: viewportHeight } = viewportSize();
  const landscapePct = clampPercent(
    Number(
      runtimeSettings?.landscapeViewportPercent ??
        DEFAULT_SETTINGS.landscapeViewportPercent
    ),
    DEFAULT_SETTINGS.landscapeViewportPercent
  );
  const portraitPct = clampPercent(
    Number(
      runtimeSettings?.portraitViewportPercent ??
        DEFAULT_SETTINGS.portraitViewportPercent
    ),
    DEFAULT_SETTINGS.portraitViewportPercent
  );
  const maxLandscapeWidth = (viewportWidth * landscapePct) / 100;
  const maxPortraitHeight = (viewportHeight * portraitPct) / 100;
  const isPortrait = img.naturalHeight > img.naturalWidth;
  const aspect = img.naturalWidth / Math.max(img.naturalHeight, 1);
  if (isPortrait) {
    const targetHeight = Math.min(
      Math.max(maxPortraitHeight, MIN_IMAGE_SIZE),
      viewportHeight - HOST_MARGIN_PX * 2
    );
    const targetWidth = Math.min(
      targetHeight * aspect,
      viewportWidth - HOST_MARGIN_PX * 2
    );
    return {
      width: Math.max(MIN_IMAGE_SIZE, Math.round(targetWidth)),
      height: Math.max(MIN_IMAGE_SIZE, Math.round(targetHeight)),
      isPortrait: true,
    };
  }
  const targetWidth = Math.min(
    Math.max(maxLandscapeWidth, MIN_IMAGE_SIZE),
    viewportWidth - HOST_MARGIN_PX * 2
  );
  const targetHeight = Math.min(
    targetWidth / (aspect || 1),
    viewportHeight - HOST_MARGIN_PX * 2
  );
  return {
    width: Math.max(MIN_IMAGE_SIZE, Math.round(targetWidth)),
    height: Math.max(MIN_IMAGE_SIZE, Math.round(targetHeight)),
    isPortrait: false,
  };
}

function updateCardWidthHint(card, desiredWidth) {
  if (!card || !desiredWidth) return;
  const current = Number(card.dataset.maxWidthHint || 0);
  const next = Math.max(current, desiredWidth);
  card.dataset.maxWidthHint = String(next);
  const { width: viewportWidth } = viewportSize();
  const target = Math.min(
    viewportWidth - HOST_MARGIN_PX * 2,
    Math.max(next + 32, Number.parseFloat(card.style.minWidth) || 0)
  );
  if (target > 0) {
    card.style.maxWidth = `${Math.round(target)}px`;
  }
}

function applyResponsiveSizing(button, img, card, runtimeSettings) {
  const dims = computePreviewDimensions(img, runtimeSettings);
  if (!dims) return;
  img.style.objectFit = "contain";
  img.style.width = `${dims.width}px`;
  img.style.height = `${dims.height}px`;
  img.style.maxWidth = `${dims.width}px`;
  img.style.maxHeight = `${dims.height}px`;
  if (button) {
    button.style.width = `${dims.width}px`;
    button.style.height = `${dims.height}px`;
    button.style.display = "inline-flex";
    button.style.alignItems = "center";
    button.style.justifyContent = "center";
  }
  updateCardWidthHint(card, dims.width);
}

function normalizeGeneratedFile(candidate) {
  if (!candidate) return null;
  if (typeof candidate === "string") {
    const trimmed = candidate.trim();
    if (!trimmed) return null;
    return { filename: trimmed };
  }
  if (typeof candidate !== "object") {
    return null;
  }
  const filename = candidate.filename ?? candidate.name ?? candidate.path;
  if (typeof filename !== "string") {
    return null;
  }
  const record = { filename: filename.trim() };
  if (!record.filename) {
    return null;
  }
  if (candidate.subfolder) {
    record.subfolder = String(candidate.subfolder);
  }
  const type =
    candidate.type ??
    candidate.kind ??
    candidate.folder ??
    null;
  if (type) {
    record.type = String(type);
  }
  return record;
}

function extractGeneratedFiles(payload) {
  if (!payload) return [];
  const detail = payload.detail ?? payload.data ?? payload.payload;
  if (detail && detail !== payload) {
    const nested = extractGeneratedFiles(detail);
    if (nested.length) {
      return nested;
    }
  }
  const candidate =
    payload.files ??
    payload.generated_files ??
    payload.generatedFiles ??
    payload.new_files ??
    payload.newFiles ??
    null;
  if (!Array.isArray(candidate)) {
    return [];
  }
  return candidate
    .map(normalizeGeneratedFile)
    .filter((item) => !!item);
}

export function createPreviewNotifier({
  api,
  historyApi,
  logger = console,
  hostId = "phg-preview-root",
  displayMs = DEFAULT_DURATION_MS,
  maxVisible = DEFAULT_MAX_VISIBLE,
  maxImages = DEFAULT_MAX_IMAGES,
  openGallery = null,
} = {}) {
  if (typeof window === "undefined") {
    return null;
  }

  const settingsStore = getPreviewSettingsStore();
  let runtimeSettings = computeRuntimeSettings(
    settingsStore?.getState?.() ?? {},
    displayMs
  );
  const cardTimers = new WeakMap();
  const recentEntries = new Map();

  function clearTimer(card) {
    const timeoutId = cardTimers.get(card);
    if (timeoutId) {
      window.clearTimeout(timeoutId);
      cardTimers.delete(card);
    }
  }

  const updateHostStyles = () => {
    const host = document.querySelector(`[${HOST_ATTR}="${hostId}"]`);
    if (host) {
      applyHostStyles(host, runtimeSettings);
      restyleCards(host, runtimeSettings);
      if (runtimeSettings.enabled === false) {
        clearHostCards(host, clearTimer);
      }
    }
  };

  const syncRuntimeSettings = (nextState) => {
    runtimeSettings = computeRuntimeSettings(nextState, displayMs);
    updateHostStyles();
  };

  updateHostStyles();

  const unsubscribeSettings = settingsStore?.subscribe
    ? settingsStore.subscribe((state) => syncRuntimeSettings(state))
    : null;

  const resolvedHistoryApi = historyApi ?? createHistoryApi(api);
  const logError =
    typeof logger?.error === "function"
      ? (...args) => logger.error("[PromptHistoryGallery]", ...args)
      : () => {};
  const previewsDisabled = () => runtimeSettings.enabled === false;
  const getHost = () => {
    if (previewsDisabled()) {
      const existing = document.querySelector(`[${HOST_ATTR}="${hostId}"]`);
      if (existing) {
        applyHostStyles(existing, runtimeSettings);
        clearHostCards(existing, clearTimer);
      }
      return null;
    }
    const host = ensureHostElement(hostId);
    if (host) {
      applyHostStyles(host, runtimeSettings);
    }
    return host;
  };

  const markEntryShown = (entryId) => {
    if (!entryId) return false;
    const now = Date.now();
    const previous = recentEntries.get(entryId);
    if (previous && now - previous < DUPLICATE_WINDOW_MS) {
      return false;
    }
    recentEntries.set(entryId, now);
    if (recentEntries.size > 200) {
      const cutoff = now - 60_000;
      for (const [key, value] of recentEntries.entries()) {
        if (value < cutoff) {
          recentEntries.delete(key);
        }
      }
    }
    return true;
  };

  const removeCard = (card) => {
    if (!card || card.dataset.removing === "true") return;
    card.dataset.removing = "true";
    clearTimer(card);
    card.classList.add("phg-preview-card--leaving");
    window.setTimeout(() => {
      card?.remove?.();
    }, 220);
  };

  const resolveDisplayDuration = () =>
    clamp(
      Number(runtimeSettings.displayDuration ?? displayMs ?? DEFAULT_DURATION_MS),
      MIN_DISPLAY_MS,
      MAX_DISPLAY_MS
    );

  const scheduleRemoval = (card) => {
    clearTimer(card);
    const duration = resolveDisplayDuration();
    if (!(duration > 0)) {
      return;
    }
    const timeoutId = window.setTimeout(() => removeCard(card), duration);
    cardTimers.set(card, timeoutId);
  };

  const enforceVisibleLimit = () => {
    if (maxVisible <= 0) return;
    const host = getHost();
    if (!host) return;
    const cards = Array.from(host.children);
    const excess = cards.length - maxVisible;
    if (excess > 0) {
      cards.slice(0, excess).forEach((card) => removeCard(card));
    }
  };

  const limitSources = (sources) => {
    if (!Array.isArray(sources) || !sources.length) {
      return [];
    }
    if (
      typeof maxImages === "number" &&
      Number.isFinite(maxImages) &&
      maxImages > 0
    ) {
      const safeLimit = Math.max(1, Math.floor(maxImages));
      return sources.slice(0, safeLimit);
    }
    return sources;
  };

  const createPreviewCard = (entry, previewImages, allImages) => {
    if (previewsDisabled()) {
      return null;
    }
    const host = getHost();
    if (!host) return null;

    const card = document.createElement("article");
    card.className = "phg-preview-card";
    if (entry?.id) {
      card.dataset.entryId = entry.id;
    }

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "phg-preview-dismiss";
    closeButton.title = "Dismiss preview";
    closeButton.setAttribute("aria-label", "Dismiss preview");
    closeButton.textContent = "x";
    closeButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      removeCard(card);
    });

    const grid = document.createElement("div");
    grid.className = "phg-preview-grid";
    const thumbSize = applyCardStyles(card, grid, runtimeSettings);

    previewImages.forEach((source, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "phg-preview-image";
      button.setAttribute(
        "aria-label",
        source.title ? `Open ${source.title}` : "Open image"
      );
      const img = document.createElement("img");
      img.src = source.thumb ?? source.url;
      img.alt = source.title ?? "";
      img.loading = "lazy";
      img.decoding = "async";
      img.addEventListener("error", () => {
        button.remove();
        if (!grid.children.length) {
          removeCard(card);
        }
      });
      const applySize = () => applyResponsiveSizing(button, img, card, runtimeSettings);
      img.addEventListener("load", applySize, { once: false });
      if (img.complete && img.naturalWidth && img.naturalHeight) {
        applySize();
      }
      button.addEventListener("click", (event) => {
        event.preventDefault();
        const gallerySources =
          Array.isArray(allImages) && allImages.length ? allImages : previewImages;
        const matchedIndex = gallerySources.findIndex(
          (item) => item?.url === source.url || item?.thumb === source.thumb
        );
        const startIndex = matchedIndex >= 0 ? matchedIndex : index;
        const result =
          typeof openGallery === "function"
            ? openGallery(entry, gallerySources, startIndex)
            : null;
        if (result === false) {
          window.open(source.url, "_blank", "noopener,noreferrer");
        } else if (result && typeof result.then === "function") {
          result.catch((error) => logError("preview openGallery error", error));
        }
      });
      button.style.minHeight = `${Math.round(thumbSize)}px`;
      button.appendChild(img);
      grid.appendChild(button);
    });

    card.appendChild(closeButton);
    card.appendChild(grid);

    host.appendChild(card);
    enforceVisibleLimit();
    scheduleRemoval(card);
    return card;
  };

  const showEntries = (entries) => {
    if (previewsDisabled()) {
      return;
    }
    entries.forEach((entry) => {
      if (!entry || (entry.id && !markEntryShown(entry.id))) {
        return;
      }
      const sources = buildImageSources(entry, api);
      const previewSources = limitSources(sources);
      if (!previewSources.length) {
        return;
      }
      createPreviewCard(entry, previewSources, sources);
    });
  };

  const claimEntrySlot = (entryIds) => {
    if (!Array.isArray(entryIds) || entryIds.length === 0) {
      return { show: true, entryId: null };
    }
    let fallback = null;
    for (const entryId of entryIds) {
      const sanitized = sanitizeEntryId(entryId);
      if (!sanitized) continue;
      fallback = fallback ?? sanitized;
      if (markEntryShown(sanitized)) {
        return { show: true, entryId: sanitized };
      }
    }
    return { show: false, entryId: fallback };
  };

  async function fetchEntriesByIds(entryIds) {
    const unique = Array.from(
      new Set(entryIds.map(sanitizeEntryId).filter(Boolean))
    );
    if (!unique.length) {
      return [];
    }
    try {
      const limit = Math.max(10, Math.min(200, unique.length * 4));
      const items = await resolvedHistoryApi.list(limit);
      const map = new Map(items.map((entry) => [entry.id, entry]));
      return unique
        .map((entryId) => map.get(entryId))
        .filter((entry) => !!entry);
    } catch (error) {
      logError("preview entry fetch failed", error);
      return [];
    }
  }

  const tryShowGeneratedFiles = async (entryIds, filesPayload) => {
    if (previewsDisabled()) {
      return false;
    }
    if (!Array.isArray(filesPayload) || !filesPayload.length) {
      return false;
    }

    // Preview thumbnails come from the freshly generated files,
    // but we prefer the full gallery from the matched history entry.
    const previewSources = limitSources(
      buildImageSources(
        {
          files: filesPayload,
        },
        api
      )
    );

    const claim = claimEntrySlot(entryIds);
    if (!claim.show) {
      return false;
    }

    let entry = null;
    let gallerySources = [];

    if (claim.entryId) {
      const fetched = await fetchEntriesByIds([claim.entryId]);
      entry = fetched?.[0] ?? null;
      if (entry) {
        gallerySources = buildImageSources(entry, api);
      }
    }

    if (!entry) {
      entry = { id: claim.entryId ?? null };
    }

    if (!entry.id) {
      try {
        const recent = await resolvedHistoryApi.list(50);
        const targetNames = new Set(
          filesPayload
            .map(normalizeGeneratedFile)
            .map((item) => item?.filename ?? null)
            .filter(Boolean)
        );
        const match = recent.find((item) =>
          Array.isArray(item?.files) &&
          item.files.some((file) => {
            if (typeof file === "string") {
              return targetNames.has(file);
            }
            if (file && typeof file === "object") {
              const name = file.filename ?? file.name ?? null;
              return name ? targetNames.has(String(name)) : false;
            }
            return false;
          })
        );
        if (match) {
          entry = match;
          gallerySources = buildImageSources(entry, api);
        }
      } catch (error) {
        logError("preview match recent entry failed", error);
      }
    }

    if (!gallerySources.length && entry?.files) {
      gallerySources = buildImageSources(entry, api);
    }

    const previews = previewSources.length
      ? previewSources
      : limitSources(gallerySources);
    if (!previews.length) {
      return false;
    }

    const gallery = gallerySources.length ? gallerySources : previews;
    createPreviewCard(entry, previews, gallery);
    return true;
  };

  return {
    async handleHistoryEvent(event) {
      if (previewsDisabled()) {
        updateHostStyles();
        return;
      }
      const entryIds = extractEntryIds(event);
      const generatedFiles = extractGeneratedFiles(event);
      const handledGenerated = await tryShowGeneratedFiles(
        entryIds,
        generatedFiles
      );
      if (handledGenerated) {
        return;
      }
      if (entryIds.length > 0) {
        const entries = await fetchEntriesByIds(entryIds);
        if (entries.length > 0) {
          showEntries(entries);
        }
      }
    },
    async notifyEntryIds(entryIds) {
      if (previewsDisabled()) {
        return;
      }
      const entries = await fetchEntriesByIds(entryIds);
      if (entries.length > 0) {
        showEntries(entries);
      }
    },
    notifyEntries(entries) {
      if (previewsDisabled()) {
        return;
      }
      if (Array.isArray(entries) && entries.length > 0) {
        showEntries(entries);
      }
    },
    dispose() {
      if (typeof unsubscribeSettings === "function") {
        unsubscribeSettings();
      }
    },
  };
}
