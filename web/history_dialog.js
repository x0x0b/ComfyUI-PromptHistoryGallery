import { createHistoryApi } from "./lib/historyApi.js";
import { buildImageSources } from "./lib/imageSources.js";
import { createViewerBridge } from "./lib/viewerBridge.js";
import { createPreviewNotifier, extractEntryIds } from "./lib/previewNotifier.js";
import { getPreviewSettingsStore, DEFAULT_SETTINGS } from "./lib/previewSettings.js";

export {};

const LOG_PREFIX = "[PromptHistoryGallery]";
const EXTENSION_NAME = "PromptHistoryGallery.NodeDialog";
const HISTORY_UPDATE_EVENT = "PromptHistoryGallery.updated";
const HISTORY_LIMIT = 120;
const HISTORY_WIDGET_FLAG = "__phg_history_widget__";
const HISTORY_WIDGET_LABEL = "⏱ History";

const TEXT = {
  title: "Prompt History",
  subtitleMissing: "No active Prompt History Input — prompts will be copied.",
  subtitleTarget: (name) => `Sending to: ${name ?? "Prompt History Input"}`,
  loading: "Loading history…",
  empty: "No prompt history yet. Run a workflow to populate this list.",
  copied: "Prompt copied to clipboard.",
  copiedFallback: "Prompt copied (no active node).",
  copiedMissingWidget: "Prompt widget missing on node. Copied instead.",
  copiedMissingNode: "Target node was removed. Prompt copied instead.",
  sent: (name) => `Prompt sent to ${name ?? "node"}.`,
  same: "Prompt already matches the node input.",
  noImages: "No images available for this prompt.",
  deleteConfirm: "Delete this prompt history entry?",
  deleteSuccess: "History entry deleted.",
  deleteError: "Failed to delete entry.",
  settingsTitle: "Preview Popup Settings",
  settingsHint: "Controls the small pop-up shown after images are generated.",
  settingsToggle: "Show pop-up previews",
  settingsDuration: "Display time",
  settingsReset: "Reset to defaults",
  settingsClose: "Close settings",
};

const PREVIEW_MIN_MS = 1000;
const PREVIEW_MAX_MS = 15000;
const PREVIEW_STEP_MS = 250;

const logInfo = (...messages) => console.info(LOG_PREFIX, ...messages);
const logError = (...messages) => console.error(LOG_PREFIX, ...messages);

const createEl = (tag, className = "", text = null) => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== null && text !== undefined) el.textContent = text;
  return el;
};

const safeText = (value, fallback = "") =>
  value === null || value === undefined ? fallback : String(value);

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function ensureStylesheet() {
  const attr = "data-phg-style";
  if (document.head.querySelector(`link[${attr}]`)) return;
  const styleHref = new URL("./style.css", import.meta.url).href;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = styleHref;
  link.setAttribute(attr, "true");
  document.head.appendChild(link);
}

function formatTimestamp(value) {
  if (!value) return "Unknown";
  try {
    return new Date(value).toLocaleString();
  } catch (_) {
    return String(value);
  }
}

function resolveComfyApp() {
  return window.comfyAPI?.app?.app ?? window.app ?? null;
}

function resolveComfyApi() {
  const comfyApp = resolveComfyApp();
  return (
    comfyApp?.api ??
    window.comfyAPI?.api?.api ??
    window.comfyAPI?.api ??
    null
  );
}

function resolvePromptWidget(node) {
  if (!node?.widgets || !Array.isArray(node.widgets)) return null;
  return node.widgets.find((widget) => widget?.name === "prompt") ?? null;
}

function normalizeTargetPayload(node) {
  if (!node) return null;
  const widget = resolvePromptWidget(node);
  const nodeId = node.id ?? null;
  if (nodeId == null || !widget) return null;
  const nodeTitle =
    typeof node.getTitle === "function"
      ? node.getTitle()
      : node.title ?? node.comfyClass ?? "Prompt History Input";
  return {
    nodeId,
    graph: node.graph ?? null,
    nodeRef: node,
    widgetName: widget.name ?? "prompt",
    nodeTitle,
  };
}

function resolveNodeFromTarget(target) {
  if (!target) return null;
  const comfyApp = resolveComfyApp();
  const { nodeRef, nodeId, graph } = target;

  const resolveFromGraph = (graphInstance) => {
    if (!graphInstance?.getNodeById) return null;
    try {
      return graphInstance.getNodeById(nodeId) ?? null;
    } catch (error) {
      logError("resolveNodeFromTarget getNodeById error", error);
      return null;
    }
  };

  let node = resolveFromGraph(graph);
  if (!node && nodeRef?.graph) {
    node = resolveFromGraph(nodeRef.graph);
  }
  if (!node && comfyApp?.graph) {
    node = resolveFromGraph(comfyApp.graph);
  }
  if (!node && Array.isArray(comfyApp?.graph?.nodes)) {
    node = comfyApp.graph.nodes.find((candidate) => candidate?.id === nodeId) ?? null;
  }
  if (!node && nodeRef) {
    node = nodeRef;
  }
  return node ?? null;
}

function applyPromptToWidget(node, widget, promptText) {
  if (!node || !widget) return false;
  const normalized =
    typeof promptText === "string" ? promptText : String(promptText ?? "");
  const previous = typeof widget.value === "string" ? widget.value : widget.value ?? "";
  if (previous === normalized) {
    return false;
  }

  let handled = false;
  const comfyApp = resolveComfyApp();
  if (typeof widget.setValue === "function") {
    try {
      widget.setValue(normalized, {
        node,
        canvas: comfyApp?.canvas ?? null,
      });
      handled = true;
    } catch (error) {
      logError("applyPromptToWidget.setValue error", error);
    }
  }

  if (!handled) {
    try {
      widget.value = normalized;
      handled = true;
    } catch (error) {
      logError("applyPromptToWidget.value assignment error", error);
      return false;
    }
    if (typeof widget.callback === "function") {
      try {
        widget.callback(
          widget.value,
          comfyApp?.canvas ?? null,
          node,
          comfyApp?.canvas?.graph_mouse ?? null,
          null
        );
      } catch (error) {
        logError("applyPromptToWidget.callback error", error);
      }
    }
    if (typeof node.onWidgetChanged === "function") {
      try {
        node.onWidgetChanged(widget.name ?? "", widget.value, previous, widget);
      } catch (error) {
        logError("applyPromptToWidget.onWidgetChanged error", error);
      }
    }
  }

  if (Array.isArray(node.widgets_values)) {
    const index = node.widgets?.indexOf?.(widget) ?? -1;
    if (index !== -1) {
      node.widgets_values[index] = widget.value;
    }
  }

  node.setDirtyCanvas?.(true, true);
  node.graph?.setDirtyCanvas?.(true, true);
  if (node.graph) {
    node.graph._version = (node.graph._version ?? 0) + 1;
  }
  return true;
}

class HistoryDialog {
  constructor({ api, comfyApp }) {
    ensureStylesheet();
    this.api = api ?? resolveComfyApi();
    this.comfyApp = comfyApp ?? resolveComfyApp();
    this.historyApi = createHistoryApi(this.api);
    this.viewer = createViewerBridge({
      cssUrl: new URL("./vendor/viewerjs/viewer.min.css", import.meta.url).href,
      scriptUrl: new URL("./vendor/viewerjs/viewer.min.js", import.meta.url).href,
    });
    this.settingsStore = getPreviewSettingsStore();
    this.settingsState = this.settingsStore?.getState?.() ?? DEFAULT_SETTINGS;
    this.unsubscribeSettings =
      this.settingsStore?.subscribe?.((next) => {
        this.settingsState = next ?? this.settingsState;
        this._syncSettingsUI();
      }) ?? null;

    this.state = {
      isOpen: false,
      loading: false,
      error: "",
      entries: [],
      target: null,
      settingsOpen: false,
    };

    this.messageTimeout = null;
    this._buildLayout();
    this._updateTargetLabel();
    this._syncSettingsUI();
  }

  openWithNode(node) {
    this.state.target = normalizeTargetPayload(node) ?? null;
    this._updateTargetLabel();
    this.open();
  }

  open() {
    if (this.state.isOpen) {
      this.refresh();
      return;
    }
    this.state.isOpen = true;
    this.backdrop.classList.remove("phg-hidden");
    this.refresh();
  }

  close() {
    if (!this.state.isOpen) return;
    this.state.isOpen = false;
    this.backdrop.classList.add("phg-hidden");
    this._toggleSettings(false);
    this.viewer.close();
  }

  isOpen() {
    return this.state.isOpen;
  }

  async refresh() {
    this._setLoading(true);
    this._setMessage(TEXT.loading, "muted");
    try {
      const items = await this.historyApi.list(HISTORY_LIMIT);
      this.state.entries = items;
      this.state.error = "";
      this._setMessage("");
    } catch (error) {
      logError("refresh error", error);
      this.state.error = error?.message ?? "Failed to load prompt history.";
      this._setMessage(this.state.error, "error");
    } finally {
      this._setLoading(false);
      this._renderEntries();
    }
  }

  refreshIfOpen() {
    if (this.state.isOpen) {
      this.refresh();
    }
  }

  _toggleSettings(forceValue) {
    const next =
      typeof forceValue === "boolean" ? forceValue : !this.state.settingsOpen;
    this.state.settingsOpen = next;
    if (this.settingsPanel) {
      this.settingsPanel.classList.toggle("phg-hidden", !next);
    }
    if (this.settingsBtn) {
      this.settingsBtn.textContent = next ? TEXT.settingsClose : "Settings";
      this.settingsBtn.dataset.active = next ? "true" : "false";
    }
  }

  _formatDuration(ms) {
    const safeValue = clamp(
      Number(ms) || DEFAULT_SETTINGS.displayDuration,
      PREVIEW_MIN_MS,
      PREVIEW_MAX_MS
    );
    const seconds = safeValue / 1000;
    const precision = seconds >= 10 ? 0 : 1;
    return `${seconds.toFixed(precision)}s`;
  }

  _syncSettingsUI() {
    const state =
      this.settingsStore?.getState?.() ??
      this.settingsState ??
      DEFAULT_SETTINGS;
    this.settingsState = state;
    const enabled = state.enabled !== false;

    if (this.previewToggleInput) {
      this.previewToggleInput.checked = enabled;
    }

    if (this.durationInput) {
      const duration = clamp(
        Number(state.displayDuration ?? DEFAULT_SETTINGS.displayDuration),
        PREVIEW_MIN_MS,
        PREVIEW_MAX_MS
      );
      this.durationInput.value = String(duration);
      if (this.durationValue) {
        this.durationValue.textContent = `${this._formatDuration(
          duration
        )} (${Math.round(duration)} ms)`;
      }
      this.durationInput.disabled = !enabled;
      if (this.durationField) {
        this.durationField.classList.toggle(
          "phg-settings-field--disabled",
          !enabled
        );
      }
    }
  }

  _applySettingsPatch(patch) {
    if (!this.settingsStore?.update) return;
    this.settingsStore.update(patch);
    this.settingsState = this.settingsStore.getState?.() ?? this.settingsState;
    this._syncSettingsUI();
  }

  _resetSettings() {
    if (!this.settingsStore?.reset) return;
    this.settingsStore.reset();
    this.settingsState = this.settingsStore.getState?.() ?? DEFAULT_SETTINGS;
    this._syncSettingsUI();
  }

  _buildSettingsPanel() {
    const panel = createEl("section", "phg-settings phg-hidden");
    panel.setAttribute("aria-label", TEXT.settingsTitle);

    const header = createEl("div", "phg-settings-header");
    const title = createEl("div", "phg-settings-title", TEXT.settingsTitle);
    const actions = createEl("div", "phg-settings-actions");
    const resetBtn = this._createButton(
      TEXT.settingsReset,
      "Restore preview defaults",
      () => this._resetSettings(),
      "ghost"
    );
    const closeBtn = this._createButton(
      TEXT.settingsClose,
      "Hide preview settings",
      () => this._toggleSettings(false),
      "ghost"
    );
    actions.append(resetBtn, closeBtn);
    header.append(title, actions);

    const grid = createEl("div", "phg-settings-grid");
    grid.append(this._buildPreviewToggleField(), this._buildDurationField());

    const hint = createEl("p", "phg-settings-hint", TEXT.settingsHint);

    panel.append(header, grid, hint);
    return panel;
  }

  _buildPreviewToggleField() {
    const field = createEl("div", "phg-settings-field");
    const label = createEl("div", "phg-settings-label", TEXT.settingsToggle);
    const switchLabel = createEl("label", "phg-switch");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = this.settingsState?.enabled !== false;
    input.addEventListener("change", () => {
      const enabled = input.checked;
      this._applySettingsPatch({ enabled });
    });
    const switchText = createEl("span", "phg-switch-label", TEXT.settingsToggle);
    switchLabel.append(input, switchText);
    field.append(label, switchLabel);
    this.previewToggleInput = input;
    return field;
  }

  _buildDurationField() {
    const field = createEl("div", "phg-settings-field");
    const label = createEl("div", "phg-settings-label", TEXT.settingsDuration);
    const range = document.createElement("input");
    range.type = "range";
    range.min = String(PREVIEW_MIN_MS);
    range.max = String(PREVIEW_MAX_MS);
    range.step = String(PREVIEW_STEP_MS);
    const initialDuration = clamp(
      Number(this.settingsState?.displayDuration ?? DEFAULT_SETTINGS.displayDuration),
      PREVIEW_MIN_MS,
      PREVIEW_MAX_MS
    );
    range.value = String(initialDuration);
    const value = createEl(
      "div",
      "phg-settings-value",
      `${this._formatDuration(initialDuration)} (${Math.round(initialDuration)} ms)`
    );
    range.addEventListener("input", () => {
      const next = clamp(Number(range.value), PREVIEW_MIN_MS, PREVIEW_MAX_MS);
      value.textContent = `${this._formatDuration(next)} (${Math.round(next)} ms)`;
    });
    range.addEventListener("change", () => {
      const next = clamp(Number(range.value), PREVIEW_MIN_MS, PREVIEW_MAX_MS);
      this._applySettingsPatch({ displayDuration: next });
    });
    field.append(label, range, value);
    this.durationInput = range;
    this.durationValue = value;
    this.durationField = field;
    return field;
  }

  _buildLayout() {
    this.backdrop = createEl("div", "phg-dialog-backdrop phg-hidden");
    this.backdrop.dataset.phg = "history";

    this.dialog = createEl("div", "phg-dialog");

    const header = createEl("header", "phg-dialog__header");

    const titleBlock = createEl("div", "phg-dialog__titles");
    this.titleEl = createEl("div", "phg-dialog__title", TEXT.title);
    this.targetLabel = createEl("div", "phg-dialog__subtitle");
    titleBlock.append(this.titleEl, this.targetLabel);

    const actions = createEl("div", "phg-dialog__actions");
    this.refreshBtn = this._createButton("Refresh", "Reload history", () => this.refresh());
    this.settingsBtn = this._createButton("Settings", "Preview popup settings", () => this._toggleSettings());
    this.closeBtn = this._createButton("Close", "Close history", () => this.close(), "ghost");
    actions.append(this.refreshBtn, this.settingsBtn, this.closeBtn);

    header.append(titleBlock, actions);

    this.statusEl = createEl("div", "phg-dialog__status");
    this.listEl = createEl("div", "phg-history-list");

    this.settingsPanel = this._buildSettingsPanel();

    const body = createEl("div", "phg-dialog__body");
    body.append(this.settingsPanel, this.statusEl, this.listEl);

    this.dialog.append(header, body);
    this.backdrop.appendChild(this.dialog);
    document.body.appendChild(this.backdrop);

    this.backdrop.addEventListener("click", (event) => {
      if (event.target === this.backdrop) {
        this.close();
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.state.isOpen) {
        this.close();
      }
    });
  }

  _createButton(label, title, onClick, variant = "primary") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `phg-button phg-button--${variant}`;
    button.textContent = label;
    button.title = title;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      onClick?.();
    });
    return button;
  }

  _createChip(label, variant = "", onClick = null) {
    const chip = document.createElement("span");
    chip.className = "phg-chip" + (variant ? ` phg-chip--${variant}` : "");
    chip.textContent = label;
    if (typeof onClick === "function") {
      chip.classList.add("phg-chip--clickable");
      chip.setAttribute("role", "button");
      chip.tabIndex = 0;
      const handler = (event) => {
        event.stopPropagation();
        onClick();
      };
      chip.addEventListener("click", handler);
      chip.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          handler(event);
        }
      });
    }
    return chip;
  }

  _buildActions(entry, sources) {
    const hasImages = Array.isArray(sources) && sources.length > 0;
    const actions = createEl("div", "phg-entry-card__actions");

    const useLabel = this.state.target ? "Use" : "Copy";
    actions.append(
      this._createButton(
        useLabel,
        this.state.target ? "Send prompt to the selected node" : "Copy prompt to clipboard",
        () => this._handleUse(entry)
      ),
      this._createButton("Copy", "Copy prompt", () => this._copyPrompt(entry), "ghost"),
      this._createButton("Delete", "Delete entry", () => this._deleteEntry(entry), "danger")
    );

    return actions;
  }

  _buildPreview(preview, entry, sources) {
    const box = createEl("div", "phg-entry-card__preview");
    if (!preview) {
      box.append(createEl("div", "phg-preview-placeholder", "No image"));
      return box;
    }
    const img = createEl("img");
    img.src = preview.thumb ?? preview.url;
    img.alt = preview.title ?? "Generated image";
    img.loading = "lazy";
    img.addEventListener("click", (event) => {
      event.stopPropagation();
      this._openGallery(entry, sources.length - 1);
    });
    box.append(img);
    return box;
  }

  _buildPrompt(text) {
    const container = createEl("div", "phg-entry-card__prompt");
    const pre = createEl("pre");
    pre.textContent = text ?? "";
    container.append(pre);
    return container;
  }

  _buildTags(tags) {
    if (!Array.isArray(tags) || !tags.length) return null;
    const row = createEl("div", "phg-entry-card__tags");
    for (const tag of tags) {
      const chip = this._createChip(safeText(tag));
      chip.classList.add("phg-chip--muted");
      row.append(chip);
    }
    return row;
  }

  _setLoading(value) {
    this.state.loading = Boolean(value);
    this.refreshBtn.disabled = this.state.loading;
  }

  _setMessage(text, tone = "") {
    if (this.messageTimeout) {
      clearTimeout(this.messageTimeout);
      this.messageTimeout = null;
    }
    this.statusEl.textContent = text || "";
    this.statusEl.dataset.tone = tone || "";
    if (text) {
      this.messageTimeout = setTimeout(() => {
        this.statusEl.textContent = "";
      }, 3200);
    }
  }

  _updateTargetLabel() {
    const target = this.state.target;
    if (target) {
      this.targetLabel.textContent = TEXT.subtitleTarget(target.nodeTitle);
    } else {
      this.targetLabel.textContent = TEXT.subtitleMissing;
    }
  }

  _renderEntries() {
    this.listEl.innerHTML = "";

    if (this.state.error) {
      this.listEl.appendChild(this._renderMessage(this.state.error, "error"));
      return;
    }

    if (this.state.loading) {
      this.listEl.appendChild(this._renderMessage(TEXT.loading, "muted"));
      return;
    }

    if (!this.state.entries.length) {
      this.listEl.appendChild(
        this._renderMessage(TEXT.empty, "muted")
      );
      return;
    }

    for (const entry of this.state.entries) {
      this.listEl.appendChild(this._renderEntry(entry));
    }
  }

  _renderMessage(text, tone = "") {
    const box = document.createElement("div");
    box.className = "phg-message" + (tone ? ` phg-message--${tone}` : "");
    box.textContent = text;
    return box;
  }

  _renderEntry(entry) {
    const article = createEl("article", "phg-entry-card");

    const sources = buildImageSources(entry, this.api);
    const hasImages = sources.length > 0;
    const preview = hasImages ? sources[sources.length - 1] : null; // latest

    const header = createEl("div", "phg-entry-card__header");
    const stamp = createEl("div", "phg-entry-card__stamp", formatTimestamp(entry?.last_used_at ?? entry?.created_at));
    const badges = createEl("div", "phg-entry-card__badges");
    const imagesChip = this._createChip(
      hasImages ? `${sources.length} image${sources.length === 1 ? "" : "s"}` : "No images",
      hasImages ? "accent" : "muted",
      hasImages ? () => this._openGallery(entry, sources.length - 1) : null
    );
    imagesChip.title = hasImages ? "Open generated images" : TEXT.noImages;
    badges.append(imagesChip);
    header.append(stamp, badges, this._buildActions(entry, sources));

    const body = createEl("div", "phg-entry-card__body");
    body.append(this._buildPreview(preview, entry, sources), this._buildPrompt(entry.prompt));

    const metaRow = createEl("div", "phg-entry-card__footer");
    const tagsRow = this._buildTags(entry.tags);
    if (tagsRow) metaRow.append(tagsRow);

    article.append(header, body, metaRow);
    return article;
  }

  async _handleUse(entry) {
    if (!entry) return;
    const target = this.state.target;
    if (!target) {
      await this._copyPrompt(entry);
      this._setMessage(TEXT.copiedFallback, "info");
      this.close();
      return;
    }

    const node = resolveNodeFromTarget(target);
    if (!node) {
      this.state.target = null;
      this._updateTargetLabel();
      await this._copyPrompt(entry);
      this._setMessage(TEXT.copiedMissingNode, "warn");
      this.close();
      return;
    }

    const widget = node.widgets?.find((item) => item?.name === target.widgetName) ?? resolvePromptWidget(node);
    if (!widget) {
      await this._copyPrompt(entry);
      this._setMessage(TEXT.copiedMissingWidget, "warn");
      this.close();
      return;
    }

    const updated = applyPromptToWidget(node, widget, entry.prompt ?? "");
    this.state.target = normalizeTargetPayload(node) ?? null;
    this._updateTargetLabel();
    if (updated) {
      this._setMessage(TEXT.sent(this.state.target?.nodeTitle), "success");
    } else {
      this._setMessage(TEXT.same, "muted");
    }
    this.close();
  }

  async _copyPrompt(entry) {
    try {
      await navigator.clipboard.writeText(entry.prompt ?? "");
      this._setMessage(TEXT.copied, "info");
    } catch (error) {
      logError("copyPrompt error", error);
      this._setMessage("Failed to copy prompt.", "error");
    }
  }

  async _deleteEntry(entry) {
    if (!entry?.id) return;
    if (!window.confirm(TEXT.deleteConfirm)) return;
    try {
      await this.historyApi.remove(entry.id);
      this.state.entries = this.state.entries.filter((item) => item.id !== entry.id);
      this.viewer.close();
      this._renderEntries();
      this._setMessage(TEXT.deleteSuccess, "success");
    } catch (error) {
      logError("delete error", error);
      this._setMessage(TEXT.deleteError, "error");
    }
  }

  async _openGallery(entry, startIndex = 0) {
    const sources = buildImageSources(entry, this.api);
    if (!sources.length) {
      this._setMessage(TEXT.noImages, "warn");
      return;
    }
    try {
      await this.viewer.open(entry.id ?? null, sources, Math.max(0, startIndex));
    } catch (error) {
      logError("openGallery error", error);
      this._setMessage("Failed to open gallery.", "error");
    }
  }
}

let dialogInstance = null;
let listenersAttached = false;
let previewNotifierInstance = null;

function ensureDialog() {
  if (!dialogInstance) {
    dialogInstance = new HistoryDialog({ api: resolveComfyApi(), comfyApp: resolveComfyApp() });
  }
  return dialogInstance;
}

function attachUpdateListeners(api, eventBus) {
  if (listenersAttached) return;
  const dialog = ensureDialog();
  previewNotifierInstance = createPreviewNotifier({
    api,
    historyApi: dialog.historyApi,
    logger: console,
    openGallery: (entry, sources, startIndex = 0) => {
      if (!dialog?.viewer || !Array.isArray(sources) || sources.length === 0) {
        return false;
      }
      const safeIndex = Math.max(0, Math.min(startIndex, sources.length - 1));
      try {
        const result = dialog.viewer.open(entry?.id ?? null, sources, safeIndex);
        return result ?? true;
      } catch (error) {
        logError("preview openGallery error", error);
        return false;
      }
    },
  });

  const handler = (event) => {
    dialog.refreshIfOpen();
    if (!previewNotifierInstance) return;
    try {
      const result =
        previewNotifierInstance.handleHistoryEvent?.(event) ??
        previewNotifierInstance.notifyEntryIds?.(extractEntryIds(event));
      if (result && typeof result.then === "function") {
        result.catch((error) => logError("preview handler error", error));
      }
    } catch (error) {
      logError("preview handler error", error);
    }
  };

  api?.addEventListener?.(HISTORY_UPDATE_EVENT, handler);
  eventBus?.on?.(HISTORY_UPDATE_EVENT, handler);
  listenersAttached = true;
}

function attachHistoryButton(node) {
  if (!node || typeof node.addWidget !== "function") return;
  const existing = Array.isArray(node.widgets)
    ? node.widgets.find(
        (widget) =>
          widget?.[HISTORY_WIDGET_FLAG] === true ||
          widget?.name === "phg_history" ||
          widget?.name === "History" ||
          widget?.name === HISTORY_WIDGET_LABEL
      )
    : null;
  const dialog = ensureDialog();
  const handler = () => dialog.openWithNode(node);
  if (existing) {
    existing.callback = handler;
    existing[HISTORY_WIDGET_FLAG] = true;
    existing.name = HISTORY_WIDGET_LABEL;
    return;
  }
  const widget = node.addWidget("button", HISTORY_WIDGET_LABEL, null, handler, {
    serialize: false,
  });
  if (widget) {
    widget[HISTORY_WIDGET_FLAG] = true;
    widget.name = HISTORY_WIDGET_LABEL;
  }
}

function registerExtension() {
  logInfo("loading");
  const comfyApp = resolveComfyApp();
  const comfyApi = resolveComfyApi();

  if (comfyApp?.registerExtension) {
    comfyApp.registerExtension({
      name: EXTENSION_NAME,
      setup() {
        ensureDialog();
        attachUpdateListeners(comfyApi, comfyApp?.eventBus ?? null);
      },
      beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== "PromptHistoryInput") return;
        const onCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function (...args) {
          const result = onCreated?.apply(this, args);
          attachHistoryButton(this);
          return result;
        };
      },
    });
    return;
  }

  // Fallback for older frontends without registerExtension hook.
  ensureDialog();
  attachUpdateListeners(comfyApi, comfyApp?.eventBus ?? null);
  const originalRegisterNode = window?.LiteGraph?.registerNodeType;
  if (originalRegisterNode) {
    window.LiteGraph.registerNodeType = function (type, nodeType) {
      originalRegisterNode.call(window.LiteGraph, type, nodeType);
      if (nodeType?.title === "Prompt History Input" || type?.endsWith("PromptHistoryInput")) {
        const onCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function (...args) {
          const res = onCreated?.apply(this, args);
          attachHistoryButton(this);
          return res;
        };
      }
    };
  }
}

registerExtension();
