import { createHistoryApi } from "./lib/historyApi.js";
import { buildImageSources } from "./lib/imageSources.js";
import { createViewerBridge } from "./lib/viewerBridge.js";
import { createPreviewNotifier, extractEntryIds } from "./lib/previewNotifier.js";
import {
  getPreviewSettingsStore,
  DEFAULT_SETTINGS,
  MIN_VIEWPORT_PERCENT,
  MAX_VIEWPORT_PERCENT,
} from "./lib/previewSettings.js";

export {};

const LOG_PREFIX = "[PromptHistoryGallery]";
const EXTENSION_NAME = "PromptHistoryGallery.NodeDialog";
const HISTORY_UPDATE_EVENT = "PromptHistoryGallery.updated";
const HISTORY_LIMIT_MIN = 20;
const HISTORY_LIMIT_MAX = 1000;
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
  settingsTitle: "Settings",
  settingsHint: "Configure extension behavior.",
  settingsReset: "Reset to defaults",
  settingsClose: "Close",
  tabHistory: "History",
  tabSettings: "Settings",
  sectionGeneral: "General",
  sectionUsage: "List Appearance",
  sectionPreview: "Popup Preview",
  historyLimitLabel: "History Limit",
  historyLimitHint: "Number of prompts to keep in history.",
  searchPlaceholder: "Search prompts or tags…",
  searchClear: "Clear",
  searchNoResults: "No prompts match your search.",
  usageSettingsHighlight: "Highlight Frequent Prompts",
  usageSettingsRatio: "Highlight Threshold (% of max)",
  usageSettingsStart: "Minimum Images to Highlight",
  previewToggle: "Enable Popup Preview",
  previewDuration: "Popup Duration",
  previewSizeLandscape: "Landscape Size (% width)",
  previewSizePortrait: "Portrait Size (% height)",
};

const USAGE_RATIO_MIN = 0.05;
const USAGE_RATIO_MAX = 1;
const USAGE_START_MIN = 1;
const USAGE_START_MAX = 100;

const PREVIEW_MIN_MS = 1000;
const PREVIEW_MAX_MS = 15000;
const PREVIEW_STEP_MS = 250;
const PREVIEW_MIN_PERCENT = MIN_VIEWPORT_PERCENT;
const PREVIEW_MAX_PERCENT = MAX_VIEWPORT_PERCENT;

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
        const previous = this.settingsState;
        this.settingsState = next ?? this.settingsState;
        this._syncSettingsUI();
        if (
          previous?.highlightUsage !== this.settingsState?.highlightUsage ||
          previous?.highlightUsageRatio !== this.settingsState?.highlightUsageRatio
        ) {
          this._renderEntries();
        }
        if (
          previous?.historyLimit !== this.settingsState?.historyLimit &&
          this.state?.isOpen
        ) {
          this.refresh();
        }
      }) ?? null;

    this.state = {
      isOpen: false,
      loading: false,
      error: "",
      entries: [],
      target: null,
      activeTab: "history",
      searchQuery: "",
    };

    this.messageTimeout = null;
    this._buildLayout();
    this._updateTargetLabel();
    this._syncSettingsUI();
    this._switchTab("history"); // Default tab
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
    this.viewer.close();
  }

  isOpen() {
    return this.state.isOpen;
  }

  async refresh() {
    this._setLoading(true);
    this._setMessage(TEXT.loading, "muted");
    try {
      const items = await this.historyApi.list(this._getHistoryLimit());
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

  _getHistoryLimit() {
    const settingValue =
      this.settingsState?.historyLimit ?? DEFAULT_SETTINGS.historyLimit;
    return clamp(
      Number(settingValue) || DEFAULT_SETTINGS.historyLimit,
      HISTORY_LIMIT_MIN,
      HISTORY_LIMIT_MAX
    );
  }

  _switchTab(tabId) {
    this.state.activeTab = tabId;

    // Update Tab Buttons
    [this.historyTabBtn, this.settingsTabBtn].forEach(btn => {
      if (btn) btn.dataset.active = btn.dataset.tab === tabId ? "true" : "false";
    });

    // Update Views
    if (this.historyView && this.settingsView) {
      if (tabId === "history") {
        this.historyView.classList.remove("phg-hidden");
        this.settingsView.classList.add("phg-hidden");
      } else {
        this.historyView.classList.add("phg-hidden");
        this.settingsView.classList.remove("phg-hidden");
      }
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

  _resetSettings() {
    if (!this.settingsStore?.reset) return;
    this.settingsStore.reset();
    this.settingsState = this.settingsStore.getState?.() ?? DEFAULT_SETTINGS;
    this._syncSettingsUI();
  }

  _buildSettingsView() {
    const container = createEl("div", "phg-settings-container phg-hidden");

    // -- List Appearance --
    const listGroup = this._buildSettingsGroup(TEXT.sectionUsage, [
        this._buildHistoryLimitField(),
        this._buildToggleField(
          TEXT.usageSettingsHighlight,
          () => this.settingsState?.highlightUsage !== false,
          (checked) => this._applySettingsPatch({ highlightUsage: checked }),
          "highlightToggleInput"
        ),
        this._buildNumberField(
          TEXT.usageSettingsStart,
          () => this.settingsState?.highlightUsageStartCount ?? DEFAULT_SETTINGS.highlightUsageStartCount,
          (val) => this._applySettingsPatch({ highlightUsageStartCount: val }),
          USAGE_START_MIN, USAGE_START_MAX, 1,
          (v) => `${v} images`,
          "highlightStartInput"
        ),
        this._buildNumberField(
          TEXT.usageSettingsRatio,
          () => Math.round((this.settingsState?.highlightUsageRatio ?? DEFAULT_SETTINGS.highlightUsageRatio) * 100),
          (val) => this._applySettingsPatch({ highlightUsageRatio: val / 100 }),
          Math.round(USAGE_RATIO_MIN * 100), 100, 5,
          (v) => `${v}%`,
          "highlightRatioInput"
        ),
    ]);

    // -- Preview Popup --
    // -- Preview Popup --
    const previewContainer = createEl("div", "phg-settings-group");

    // Header with Toggle
    const previewHeader = createEl("div", "phg-settings-group__header");
    previewHeader.style.display = "flex";
    previewHeader.style.justifyContent = "space-between";
    previewHeader.style.alignItems = "center";

    const previewTitle = createEl("div", "phg-settings-group__title", TEXT.sectionPreview);

    // Wrapper for the toggle to sit in the header
    const toggleControl = createEl("div", "phg-settings-control");
    const toggleLabel = createEl("label", "phg-toggle");
    const toggleInput = document.createElement("input");
    toggleInput.type = "checkbox";
    toggleInput.checked = this.settingsState?.enabled !== false;

    const toggleSlider = createEl("span", "phg-toggle-slider");
    toggleLabel.append(toggleInput, toggleSlider);
    toggleControl.append(toggleLabel);

    previewHeader.append(previewTitle, toggleControl);

    // Collapsible Content
    const previewContent = createEl("div", "phg-settings-group__content");
    if (!toggleInput.checked) {
        previewContent.style.display = "none";
    }

    // Toggle Logic
    toggleInput.addEventListener("change", () => {
        const checked = toggleInput.checked;
        this._applySettingsPatch({ enabled: checked });
        previewContent.style.display = checked ? "block" : "none";
    });
    this.previewToggleInput = toggleInput; // Bind for sync

    // Add items to content
    previewContent.append(
        this._buildNumberField(
            TEXT.previewDuration,
            () => this.settingsState?.displayDuration ?? DEFAULT_SETTINGS.displayDuration,
            (val) => this._applySettingsPatch({ displayDuration: val }),
            PREVIEW_MIN_MS, PREVIEW_MAX_MS, PREVIEW_STEP_MS,
            (v) => this._formatDuration(v),
            "durationInput"
        ),
        this._buildNumberField(
          TEXT.previewSizeLandscape,
          () => this.settingsState?.landscapeViewportPercent ?? DEFAULT_SETTINGS.landscapeViewportPercent,
          (val) => this._applySettingsPatch({ landscapeViewportPercent: val }),
          PREVIEW_MIN_PERCENT, PREVIEW_MAX_PERCENT, 1,
          (v) => `${v}%`,
          "landscapeInput"
        ),
        this._buildNumberField(
          TEXT.previewSizePortrait,
          () => this.settingsState?.portraitViewportPercent ?? DEFAULT_SETTINGS.portraitViewportPercent,
          (val) => this._applySettingsPatch({ portraitViewportPercent: val }),
          PREVIEW_MIN_PERCENT, PREVIEW_MAX_PERCENT, 1,
          (v) => `${v}%`,
          "portraitInput"
        )
    );

    previewContainer.append(previewHeader, previewContent);
    const previewGroup = previewContainer;

    const footer = createEl("div", "phg-settings-footer");
    const resetBtn = this._createButton(
        TEXT.settingsReset,
        "Restore defaults",
        () => this._resetSettings(),
        "ghost"
    );
    footer.append(resetBtn);

    container.append(listGroup, previewGroup, footer);
    return container;
  }

  _buildSettingsGroup(title, items) {
      const group = createEl("div", "phg-settings-group");
      const header = createEl("div", "phg-settings-group__header");
      const titleEl = createEl("div", "phg-settings-group__title", title);
      header.append(titleEl);
      group.append(header, ...items);
      return group;
  }

  _buildToggleField(label, getValue, onChange, refName) {
      const item = createEl("div", "phg-settings-item");
      const info = createEl("div", "phg-settings-item__info");
      info.append(createEl("div", "phg-settings-item__label", label));

      const control = createEl("div", "phg-settings-control");
      const toggle = createEl("label", "phg-toggle");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = getValue();
      input.addEventListener("change", () => onChange(input.checked));

      const slider = createEl("span", "phg-toggle-slider");
      toggle.append(input, slider);
      control.append(toggle);

      item.append(info, control);

      if (refName) this[refName] = input;
      return item;
  }

  _buildNumberField(label, getValue, onChange, min, max, step, formatDisplay, refName) {
      const item = createEl("div", "phg-settings-item phg-settings-item--col");

      const headerObj = createEl("div", "phg-settings-item__header");

      const labelEl = createEl("div", "phg-settings-item__label", label);
      const valueEl = createEl("div", "phg-range-value");
      const currentVal = getValue();
      valueEl.textContent = formatDisplay(currentVal);

      headerObj.append(labelEl, valueEl);

      const control = createEl("div", "phg-range-wrapper");
      const range = document.createElement("input");
      range.type = "range";
      range.className = "phg-range";
      range.min = String(min);
      range.max = String(max);
      range.step = String(step);
      range.value = String(currentVal);

      range.addEventListener("input", () => {
         const val = Number(range.value);
         valueEl.textContent = formatDisplay(val);
      });
      range.addEventListener("change", () => {
         onChange(Number(range.value));
      });

      control.append(range);
      item.append(headerObj, control);

      if (refName) this[refName] = range;
      // We can also store the value label to update it if state changes externally
      if (refName) this[refName + "Display"] = valueEl;

      return item;
  }
  _buildHistoryLimitField() {
    const getValue = () => this._getHistoryLimit();
    const item = createEl("div", "phg-settings-item phg-settings-item--col");

    const headerObj = createEl("div", "phg-settings-item__header");
    headerObj.append(
      createEl("div", "phg-settings-item__label", TEXT.historyLimitLabel),
      createEl("div", "phg-range-value", `${getValue()} items`)
    );
    this.historyLimitValue = headerObj.lastChild;

    const control = createEl("div", "phg-range-wrapper");
    const range = document.createElement("input");
    range.type = "range";
    range.className = "phg-range";
    range.min = String(HISTORY_LIMIT_MIN);
    range.max = String(HISTORY_LIMIT_MAX);
    range.step = "10";
    range.value = String(getValue());

    range.addEventListener("input", () => {
       this.historyLimitValue.textContent = `${range.value} items`;
    });
    range.addEventListener("change", () => {
       const next = clamp(Number(range.value) || DEFAULT_SETTINGS.historyLimit, HISTORY_LIMIT_MIN, HISTORY_LIMIT_MAX);
       this._applySettingsPatch({ historyLimit: next });
    });

    control.append(range);
    item.append(headerObj, control);
    this.historyLimitRange = range;
    return item;
  }

  _syncSettingsUI() {
    const state = this.settingsStore?.getState?.() ?? this.settingsState ?? DEFAULT_SETTINGS;
    this.settingsState = state;

    // History Limit
    if (this.historyLimitRange) {
        const limit = this._getHistoryLimit();
        this.historyLimitRange.value = String(limit);
        if (this.historyLimitValue) this.historyLimitValue.textContent = `${limit} items`;
    }

    // Toggle: Highlight Usage
    if (this.highlightToggleInput) {
        this.highlightToggleInput.checked = state.highlightUsage !== false;
    }

    // Number: Highlight Start
    if (this.highlightStartInput) {
         const start = clamp(
            Number(state.highlightUsageStartCount ?? DEFAULT_SETTINGS.highlightUsageStartCount),
            USAGE_START_MIN, USAGE_START_MAX
         );
         this.highlightStartInput.value = String(start);
         if (this.highlightStartInputDisplay) {
            this.highlightStartInputDisplay.textContent = `${start} images`;
         }
         this.highlightStartInput.disabled = state.highlightUsage === false;
    }

    // Number: Ratio
    if (this.highlightRatioInput) {
        const ratioValue = clamp(
            Number(state.highlightUsageRatio ?? DEFAULT_SETTINGS.highlightUsageRatio),
            USAGE_RATIO_MIN, USAGE_RATIO_MAX
        );
        const percent = Math.round(ratioValue * 100);
        this.highlightRatioInput.value = String(percent);
        if (this.highlightRatioInputDisplay) {
            this.highlightRatioInputDisplay.textContent = `${percent}%`;
        }
        this.highlightRatioInput.disabled = state.highlightUsage === false;
    }

    // Toggle: Preview
    if (this.previewToggleInput) {
        const isEnabled = state.enabled !== false;
        this.previewToggleInput.checked = isEnabled;
        // Update content visibility
        const toggleLabel = this.previewToggleInput.closest('.phg-settings-control');
        const header = toggleLabel?.parentNode;
        const content = header?.nextElementSibling;
        if (content && content.classList.contains('phg-settings-group__content')) {
            content.style.display = isEnabled ? 'block' : 'none';
        }
    }

    // Number: Duration
    if (this.durationInput) {
        const val = clamp(
            Number(state.displayDuration ?? DEFAULT_SETTINGS.displayDuration),
            PREVIEW_MIN_MS, PREVIEW_MAX_MS
        );
        this.durationInput.value = String(val);
        if (this.durationInputDisplay) {
            this.durationInputDisplay.textContent = this._formatDuration(val);
        }
    }

    // Number: Landscape
    if (this.landscapeInput) {
        const val = clamp(Number(state.landscapeViewportPercent ?? DEFAULT_SETTINGS.landscapeViewportPercent), PREVIEW_MIN_PERCENT, PREVIEW_MAX_PERCENT);
        this.landscapeInput.value = String(val);
        if (this.landscapeInputDisplay) this.landscapeInputDisplay.textContent = `${val}%`;
    }

     // Number: Portrait
    if (this.portraitInput) {
        const val = clamp(Number(state.portraitViewportPercent ?? DEFAULT_SETTINGS.portraitViewportPercent), PREVIEW_MIN_PERCENT, PREVIEW_MAX_PERCENT);
        this.portraitInput.value = String(val);
        if (this.portraitInputDisplay) this.portraitInputDisplay.textContent = `${val}%`;
    }
  }

  _buildPreviewToggleField() {
    const field = createEl("div", "phg-settings-field");
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
    field.append(switchLabel);
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

  _buildLandscapeSizeField() {
    const field = createEl("div", "phg-settings-field");
    const label = createEl("div", "phg-settings-label", TEXT.settingsLandscapeSize);
    const range = document.createElement("input");
    range.type = "range";
    range.min = String(PREVIEW_MIN_PERCENT);
    range.max = String(PREVIEW_MAX_PERCENT);
    range.step = "1";
    const initial = clamp(
      Number(this.settingsState?.landscapeViewportPercent ?? DEFAULT_SETTINGS.landscapeViewportPercent),
      PREVIEW_MIN_PERCENT,
      PREVIEW_MAX_PERCENT
    );
    range.value = String(initial);
    const value = createEl(
      "div",
      "phg-settings-value",
      `${initial}% of viewport width`
    );
    range.addEventListener("input", () => {
      const next = clamp(Number(range.value), PREVIEW_MIN_PERCENT, PREVIEW_MAX_PERCENT);
      value.textContent = `${next}% of viewport width`;
    });
    range.addEventListener("change", () => {
      const next = clamp(Number(range.value), PREVIEW_MIN_PERCENT, PREVIEW_MAX_PERCENT);
      this._applySettingsPatch({ landscapeViewportPercent: next });
    });
    field.append(label, range, value);
    this.landscapeInput = range;
    this.landscapeValue = value;
    this.landscapeField = field;
    return field;
  }

  _buildPortraitSizeField() {
    const field = createEl("div", "phg-settings-field");
    const label = createEl("div", "phg-settings-label", TEXT.settingsPortraitSize);
    const range = document.createElement("input");
    range.type = "range";
    range.min = String(PREVIEW_MIN_PERCENT);
    range.max = String(PREVIEW_MAX_PERCENT);
    range.step = "1";
    const initial = clamp(
      Number(this.settingsState?.portraitViewportPercent ?? DEFAULT_SETTINGS.portraitViewportPercent),
      PREVIEW_MIN_PERCENT,
      PREVIEW_MAX_PERCENT
    );
    range.value = String(initial);
    const value = createEl(
      "div",
      "phg-settings-value",
      `${initial}% of viewport height`
    );
    range.addEventListener("input", () => {
      const next = clamp(Number(range.value), PREVIEW_MIN_PERCENT, PREVIEW_MAX_PERCENT);
      value.textContent = `${next}% of viewport height`;
    });
    range.addEventListener("change", () => {
      const next = clamp(Number(range.value), PREVIEW_MIN_PERCENT, PREVIEW_MAX_PERCENT);
      this._applySettingsPatch({ portraitViewportPercent: next });
    });
    field.append(label, range, value);
    this.portraitInput = range;
    this.portraitValue = value;
    this.portraitField = field;
    return field;
  }

  _buildUsageHighlightField() {
    const field = createEl("div", "phg-settings-field");
    const switchLabel = createEl("label", "phg-switch");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = this.settingsState?.highlightUsage !== false;
    input.addEventListener("change", () => {
      this._applySettingsPatch({ highlightUsage: input.checked });
    });
    const switchText = createEl("span", "phg-switch-label", TEXT.usageSettingsToggle);
    switchLabel.append(input, switchText);
    field.append(switchLabel);
    this.highlightToggleInput = input;
    return field;
  }

  _buildUsageStartField() {
    const field = createEl("div", "phg-settings-field");
    const label = createEl("div", "phg-settings-label", TEXT.usageSettingsStart);
    const range = document.createElement("input");
    range.type = "range";
    range.min = String(USAGE_START_MIN);
    range.max = String(USAGE_START_MAX);
    range.step = "1";
    const initial = clamp(
      Number(
        this.settingsState?.highlightUsageStartCount ??
          DEFAULT_SETTINGS.highlightUsageStartCount ??
          5
      ),
      USAGE_START_MIN,
      USAGE_START_MAX
    );
    range.value = String(initial);
    const value = createEl(
      "div",
      "phg-settings-value",
      `${initial} images`
    );
    range.addEventListener("input", () => {
      const next = clamp(Number(range.value), USAGE_START_MIN, USAGE_START_MAX);
      value.textContent = `${next} images`;
    });
    range.addEventListener("change", () => {
      const next = clamp(Number(range.value), USAGE_START_MIN, USAGE_START_MAX);
      this._applySettingsPatch({ highlightUsageStartCount: next });
    });
    const hint = createEl("div", "phg-settings-hint", TEXT.usageSettingsStartHint);
    field.append(label, range, value, hint);
    this.highlightStartInput = range;
    this.highlightStartValue = value;
    this.highlightStartField = field;
    return field;
  }

  _buildUsageThresholdField() {
    const field = createEl("div", "phg-settings-field");
    const label = createEl("div", "phg-settings-label", TEXT.usageSettingsRatio);
    const range = document.createElement("input");
    range.type = "range";
    range.min = String(Math.round(USAGE_RATIO_MIN * 100));
    range.max = "100";
    range.step = "5";
    const initial = clamp(
      Math.round(
        (Number(this.settingsState?.highlightUsageRatio ?? DEFAULT_SETTINGS.highlightUsageRatio ?? 0.80) ||
          DEFAULT_SETTINGS.highlightUsageRatio) * 100
      ),
      Math.round(USAGE_RATIO_MIN * 100),
      100
    );
    range.value = String(initial);
    const value = createEl("div", "phg-settings-value", `${initial}% of top image count`);
    range.addEventListener("input", () => {
      const next = clamp(Number(range.value), Math.round(USAGE_RATIO_MIN * 100), 100);
      value.textContent = `${next}% of top image count`;
    });
    range.addEventListener("change", () => {
      const next = clamp(Number(range.value), Math.round(USAGE_RATIO_MIN * 100), 100);
      this._applySettingsPatch({ highlightUsageRatio: next / 100 });
    });
    const hint = createEl("div", "phg-settings-hint", TEXT.usageSettingsRatioHint);
    field.append(label, range, value, hint);
    this.highlightRatioInput = range;
    this.highlightRatioValue = value;
    this.highlightRatioField = field;
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

    // --- Tabs in Header ---
    const tabs = createEl("div", "phg-tabs");

    // History Tab Button
    const historyBtn = document.createElement("button");
    historyBtn.className = "phg-tab-button";
    historyBtn.textContent = TEXT.tabHistory;
    historyBtn.dataset.tab = "history";
    historyBtn.addEventListener("click", () => this._switchTab("history"));
    this.historyTabBtn = historyBtn;

    // Settings Tab Button
    const settingsBtn = document.createElement("button");
    settingsBtn.className = "phg-tab-button";
    settingsBtn.textContent = TEXT.tabSettings;
    settingsBtn.dataset.tab = "settings";
    settingsBtn.addEventListener("click", () => this._switchTab("settings"));
    this.settingsTabBtn = settingsBtn;

    tabs.append(historyBtn, settingsBtn);

    const actions = createEl("div", "phg-dialog__actions");
    // We only need Refresh loop here or inside History view.
    // Global Header Actions: Close. (Refresh makes sense in header too).
    this.refreshBtn = this._createButton("🔄", "Reload history", () => this.refresh(), "ghost");
    this.refreshBtn.classList.add("phg-button--icon");

    this.closeBtn = this._createButton("×", TEXT.settingsClose, () => this.close(), "ghost");
    this.closeBtn.classList.add("phg-button--icon");

    actions.append(this.refreshBtn, this.closeBtn);

    // Insert tabs between title and actions
    header.append(titleBlock, tabs, actions);

    // --- Views ---
    this.historyView = createEl("div", "phg-history-view");
    this.historyView.style.display = "flex";
    this.historyView.style.flexDirection = "column";
    this.historyView.style.height = "100%";

    this.statusEl = createEl("div", "phg-dialog__status");
    this.searchRow = this._buildSearchRow();
    this.listEl = createEl("div", "phg-history-list");
    this.historyView.append(this.statusEl, this.searchRow, this.listEl);

    this.settingsView = this._buildSettingsView();

    const body = createEl("div", "phg-dialog__body");
    // Override default body padding/style slightly for full view behavior if needed, or just append
    body.append(this.historyView, this.settingsView);

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

  _buildSearchRow() {
    const row = createEl("div", "phg-search");
    const input = document.createElement("input");
    input.type = "search";
    input.className = "phg-search__input";
    input.placeholder = TEXT.searchPlaceholder;
    input.value = this.state.searchQuery;
    input.addEventListener("input", () => {
      this.state.searchQuery = input.value;
      this._renderEntries();
    });

    const clearBtn = this._createButton(
      "×",
      TEXT.searchClear,
      () => {
        input.value = "";
        this.state.searchQuery = "";
        this._renderEntries();
        input.focus();
      },
      "ghost"
    );
    clearBtn.classList.add("phg-search__clear");

    const icon = createEl("span", "phg-search__icon", "🔍");
    row.append(icon, input, clearBtn);
    this.searchInput = input;
    return row;
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

    // Make focusable so we can intercept events.
    pre.tabIndex = 0;

    pre.addEventListener("keydown", (e) => {
      // Stop propagation for Copy to prevent ComfyUI from stealing it
      if ((e.ctrlKey || e.metaKey) && e.key === "c") {
        e.stopPropagation();
      }
    });

    pre.addEventListener("copy", (e) => {
      const selection = window.getSelection();
      const selectedText = selection.toString();
      if (selectedText) {
        e.clipboardData.setData("text/plain", selectedText);
        e.preventDefault(); // Prevent default browser behavior just in case
        e.stopPropagation();
      }
    });

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

    const entries = this._filterEntries(this.state.entries);

    if (this.state.error) {
      this.listEl.appendChild(this._renderMessage(this.state.error, "error"));
      return;
    }

    if (this.state.loading) {
      this.listEl.appendChild(this._renderMessage(TEXT.loading, "muted"));
      return;
    }

    if (!entries.length && this.state.entries.length) {
      this.listEl.appendChild(
        this._renderMessage(TEXT.searchNoResults, "muted")
      );
      return;
    }

    if (!entries.length) {
      this.listEl.appendChild(
        this._renderMessage(TEXT.empty, "muted")
      );
      return;
    }

    const preparedEntries = entries.map((entry) => {
      const sources = buildImageSources(entry, this.api);
      return {
        entry,
        sources,
        imageCount: sources.length,
      };
    });

    const maxImages = preparedEntries.reduce(
      (max, item) => Math.max(max, item.imageCount),
      0
    );
    const highlightEnabled = this.settingsState?.highlightUsage !== false;
    const startCount = clamp(
      Number(
        this.settingsState?.highlightUsageStartCount ??
          DEFAULT_SETTINGS.highlightUsageStartCount ??
          5
      ),
      USAGE_START_MIN,
      USAGE_START_MAX
    );
    const ratio = clamp(
      Number(
        this.settingsState?.highlightUsageRatio ??
          DEFAULT_SETTINGS.highlightUsageRatio ??
          0.80
      ),
      USAGE_RATIO_MIN,
      USAGE_RATIO_MAX
    );
    const fullGlowAt = maxImages > 1
      ? Math.max(startCount + 1, Math.round(maxImages * ratio))
      : null;

    for (const item of preparedEntries) {
      const highlight =
        highlightEnabled &&
        maxImages >= startCount &&
        item.imageCount >= startCount;

      const strength = (() => {
        if (!highlight || !maxImages || !fullGlowAt || fullGlowAt <= startCount) {
          return 0;
        }
        const numerator = item.imageCount - startCount;
        const denom = fullGlowAt - startCount;
        if (denom <= 0) return 1;
        return clamp(numerator / denom, 0, 1);
      })();

      this.listEl.appendChild(
        this._renderEntry(item.entry, item.sources, {
          imageCount: item.imageCount,
          maxImages,
          highlight,
          highlightStrength: Number.isFinite(strength) ? strength : 0,
          highlightThreshold: fullGlowAt,
        })
      );
    }
  }

  _renderMessage(text, tone = "") {
    const box = document.createElement("div");
    box.className = "phg-message" + (tone ? ` phg-message--${tone}` : "");
    box.textContent = text;
    return box;
  }

  _filterEntries(entries) {
    if (!Array.isArray(entries) || !entries.length) return [];
    const query = (this.state.searchQuery ?? "").trim().toLowerCase();
    if (!query) return entries;
    return entries.filter((entry) => {
      const promptText = String(entry.prompt ?? "").toLowerCase();
      const tags = Array.isArray(entry.tags)
        ? entry.tags.map((tag) => String(tag ?? "").toLowerCase())
        : [];
      if (promptText.includes(query)) return true;
      return tags.some((tag) => tag.includes(query));
    });
  }

  _renderEntry(entry, sourcesArg = null, usageMeta = {}) {
    const article = createEl("article", "phg-entry-card");

    const sources = Array.isArray(sourcesArg)
      ? sourcesArg
      : buildImageSources(entry, this.api);
    const hasImages = sources.length > 0;
    const preview = hasImages ? sources[sources.length - 1] : null; // latest

    const imageCount = usageMeta.imageCount ?? sources.length;
    const maxImages = usageMeta.maxImages ?? imageCount;
    const highlight = Boolean(usageMeta.highlight);
    const threshold = usageMeta.highlightThreshold;
    const strength = clamp(Number(usageMeta.highlightStrength ?? 0), 0, 1);

    if (highlight) {
      article.classList.add("phg-entry-card--popular");
      article.style.setProperty("--phg-usage-strength", String(strength));
      article.dataset.usageCount = String(imageCount);
      if (maxImages) {
        article.dataset.usageMax = String(maxImages);
      }
      if (threshold) {
        article.dataset.usageThreshold = String(threshold);
      }
    }

    const header = createEl("div", "phg-entry-card__header");
    const stamp = createEl(
      "div",
      "phg-entry-card__stamp",
      formatTimestamp(entry?.last_used_at ?? entry?.created_at)
    );
    const badges = createEl("div", "phg-entry-card__badges");
    const imagesChip = this._createChip(
      imageCount ? `${imageCount} image${imageCount === 1 ? "" : "s"}` : "No images",
      hasImages ? "accent" : "muted",
      hasImages ? () => this._openGallery(entry, sources.length - 1) : null
    );

    imagesChip.title = hasImages
      ? highlight && Number.isFinite(threshold) && maxImages
        ? `Frequent prompt: ${imageCount} images (top ${maxImages}, full glow at ≥ ${threshold}). Click to open.`
        : "Open generated images"
      : TEXT.noImages;
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
