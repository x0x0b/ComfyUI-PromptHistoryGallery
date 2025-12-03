import { createHistoryApi } from "./lib/historyApi.js";
import { buildImageSources } from "./lib/imageSources.js";
import { createViewerBridge } from "./lib/viewerBridge.js";
import { createPreviewNotifier, extractEntryIds } from "./lib/previewNotifier.js";

export {};

const LOG_PREFIX = "[PromptHistoryGallery]";
const EXTENSION_NAME = "PromptHistoryGallery.NodeDialog";
const HISTORY_UPDATE_EVENT = "PromptHistoryGallery.updated";
const HISTORY_LIMIT = 120;
const HISTORY_WIDGET_FLAG = "__phg_history_widget__";
const HISTORY_WIDGET_LABEL = "⏱ History";

const logInfo = (...messages) => console.info(LOG_PREFIX, ...messages);
const logError = (...messages) => console.error(LOG_PREFIX, ...messages);

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

    this.state = {
      isOpen: false,
      loading: false,
      error: "",
      entries: [],
      target: null,
    };

    this.messageTimeout = null;
    this._buildLayout();
    this._updateTargetLabel();
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
    this._setMessage("Loading history…", "muted");
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

  _buildLayout() {
    this.backdrop = document.createElement("div");
    this.backdrop.className = "phg-dialog-backdrop phg-hidden";
    this.backdrop.dataset.phg = "history";

    this.dialog = document.createElement("div");
    this.dialog.className = "phg-dialog";

    const header = document.createElement("header");
    header.className = "phg-dialog__header";

    const titleBlock = document.createElement("div");
    titleBlock.className = "phg-dialog__titles";
    this.titleEl = document.createElement("div");
    this.titleEl.className = "phg-dialog__title";
    this.titleEl.textContent = "Prompt History";
    this.targetLabel = document.createElement("div");
    this.targetLabel.className = "phg-dialog__subtitle";
    titleBlock.append(this.titleEl, this.targetLabel);

    const actions = document.createElement("div");
    actions.className = "phg-dialog__actions";

    this.refreshBtn = this._createButton("Refresh", "Reload history", () => this.refresh());
    this.closeBtn = this._createButton("Close", "Close history", () => this.close(), "ghost");
    actions.append(this.refreshBtn, this.closeBtn);

    header.append(titleBlock, actions);

    this.statusEl = document.createElement("div");
    this.statusEl.className = "phg-dialog__status";

    this.listEl = document.createElement("div");
    this.listEl.className = "phg-history-list";

    const body = document.createElement("div");
    body.className = "phg-dialog__body";
    body.append(this.statusEl, this.listEl);

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

  _createChip(label, variant = "") {
    const chip = document.createElement("span");
    chip.className = "phg-chip" + (variant ? ` phg-chip--${variant}` : "");
    chip.textContent = label;
    return chip;
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
      this.targetLabel.textContent = `Sending to: ${target.nodeTitle ?? "Prompt History Input"}`;
    } else {
      this.targetLabel.textContent = "No active Prompt History Input — prompts will be copied.";
    }
  }

  _renderEntries() {
    this.listEl.innerHTML = "";

    if (this.state.error) {
      this.listEl.appendChild(this._renderMessage(this.state.error, "error"));
      return;
    }

    if (this.state.loading) {
      this.listEl.appendChild(this._renderMessage("Loading history…", "muted"));
      return;
    }

    if (!this.state.entries.length) {
      this.listEl.appendChild(
        this._renderMessage("No prompt history yet. Run a workflow to populate this list.", "muted")
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
    const article = document.createElement("article");
    article.className = "phg-entry-card";

    const header = document.createElement("div");
    header.className = "phg-entry-card__header";

    const stamp = document.createElement("div");
    stamp.className = "phg-entry-card__stamp";
    const lastUsed = entry?.last_used_at ?? entry?.created_at;
    stamp.textContent = formatTimestamp(lastUsed);

    const badges = document.createElement("div");
    badges.className = "phg-entry-card__badges";

    const sources = buildImageSources(entry, this.api);
    const hasImages = sources.length > 0;
    const preview = hasImages ? sources[sources.length - 1] : null; // latest
    const countChip = this._createChip(
      hasImages ? `${sources.length} image${sources.length === 1 ? "" : "s"}` : "No images",
      hasImages ? "accent" : "muted"
    );
    badges.append(countChip);

    const actions = document.createElement("div");
    actions.className = "phg-entry-card__actions";

    const useLabel = this.state.target ? "Use" : "Copy";
    const useBtn = this._createButton(
      useLabel,
      this.state.target ? "Send prompt to the selected node" : "Copy prompt to clipboard",
      () => this._handleUse(entry)
    );
    actions.appendChild(useBtn);

    const copyBtn = this._createButton("Copy", "Copy prompt", () => this._copyPrompt(entry), "ghost");
    actions.appendChild(copyBtn);

    const galleryBtn = this._createButton(
      "Gallery",
      hasImages ? "Open generated images" : "No generated images",
      () => this._openGallery(entry, sources.length - 1),
      "ghost"
    );
    galleryBtn.disabled = !hasImages;
    actions.appendChild(galleryBtn);

    const deleteBtn = this._createButton("Delete", "Delete entry", () => this._deleteEntry(entry), "danger");
    actions.appendChild(deleteBtn);

    header.append(stamp, badges, actions);

    const body = document.createElement("div");
    body.className = "phg-entry-card__body";

    const previewBox = document.createElement("div");
    previewBox.className = "phg-entry-card__preview";

    if (preview) {
      const img = document.createElement("img");
      img.src = preview.thumb ?? preview.url;
      img.alt = preview.title ?? "Generated image";
      img.loading = "lazy";
      img.addEventListener("click", (event) => {
        event.stopPropagation();
        this._openGallery(entry, sources.length - 1);
      });
      previewBox.appendChild(img);
    } else {
      const placeholder = document.createElement("div");
      placeholder.className = "phg-preview-placeholder";
      placeholder.textContent = "No image";
      previewBox.appendChild(placeholder);
    }

    const promptBox = document.createElement("div");
    promptBox.className = "phg-entry-card__prompt";
    const pre = document.createElement("pre");
    pre.textContent = entry.prompt ?? "";
    promptBox.appendChild(pre);

    body.append(previewBox, promptBox);

    const metaRow = document.createElement("div");
    metaRow.className = "phg-entry-card__footer";
    if (Array.isArray(entry.tags) && entry.tags.length) {
      const tagLine = document.createElement("div");
      tagLine.className = "phg-entry-card__tags";
      for (const tag of entry.tags) {
        const chip = this._createChip(String(tag));
        chip.classList.add("phg-chip--muted");
        tagLine.appendChild(chip);
      }
      metaRow.appendChild(tagLine);
    }

    article.append(header, body, metaRow);
    return article;
  }

  async _handleUse(entry) {
    if (!entry) return;
    const target = this.state.target;
    if (!target) {
      await this._copyPrompt(entry);
      this._setMessage("Prompt copied (no active node).", "info");
      this.close();
      return;
    }

    const node = resolveNodeFromTarget(target);
    if (!node) {
      this.state.target = null;
      this._updateTargetLabel();
      await this._copyPrompt(entry);
      this._setMessage("Target node was removed. Prompt copied instead.", "warn");
      this.close();
      return;
    }

    const widget = node.widgets?.find((item) => item?.name === target.widgetName) ?? resolvePromptWidget(node);
    if (!widget) {
      await this._copyPrompt(entry);
      this._setMessage("Prompt widget missing on node. Copied instead.", "warn");
      this.close();
      return;
    }

    const updated = applyPromptToWidget(node, widget, entry.prompt ?? "");
    this.state.target = normalizeTargetPayload(node) ?? null;
    this._updateTargetLabel();
    if (updated) {
      this._setMessage(`Prompt sent to ${this.state.target?.nodeTitle ?? "node"}.`, "success");
    } else {
      this._setMessage("Prompt already matches the node input.", "muted");
    }
    this.close();
  }

  async _copyPrompt(entry) {
    try {
      await navigator.clipboard.writeText(entry.prompt ?? "");
      this._setMessage("Prompt copied to clipboard.", "info");
    } catch (error) {
      logError("copyPrompt error", error);
      this._setMessage("Failed to copy prompt.", "error");
    }
  }

  async _deleteEntry(entry) {
    if (!entry?.id) return;
    if (!window.confirm("Delete this prompt history entry?")) return;
    try {
      await this.historyApi.remove(entry.id);
      this.state.entries = this.state.entries.filter((item) => item.id !== entry.id);
      this.viewer.close();
      this._renderEntries();
      this._setMessage("History entry deleted.", "success");
    } catch (error) {
      logError("delete error", error);
      this._setMessage("Failed to delete entry.", "error");
    }
  }

  async _openGallery(entry, startIndex = 0) {
    const sources = buildImageSources(entry, this.api);
    if (!sources.length) {
      this._setMessage("No images available for this prompt.", "warn");
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
