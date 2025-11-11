import { createAssetLoader } from "./lib/assetLoader.js";
import { createHistoryApi } from "./lib/historyApi.js";
import { buildImageSources } from "./lib/imageSources.js";
import { createViewerBridge } from "./lib/viewerBridge.js";

export {};

const LOG_PREFIX = "[PromptHistoryGallery]";
const EXTENSION_NAME = "PromptHistoryGallery.Sidebar";
const TAB_ID = "prompt-history-gallery";

const logInfo = (...messages) => console.info(LOG_PREFIX, ...messages);
const logError = (...messages) => console.error(LOG_PREFIX, ...messages);

let isRegistered = false;

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

function resolveMainBundleScript() {
  return document.querySelector(
    'script[type="module"][src*="assets/index-"]'
  )?.src;
}

let cachedMainModule = null;
async function getMainBundleModule() {
  if (cachedMainModule) return cachedMainModule;
  const scriptSrc = resolveMainBundleScript();
  if (!scriptSrc) {
    throw new Error("Main bundle script not found");
  }
  cachedMainModule = await import(/* @vite-ignore */ scriptSrc);
  return cachedMainModule;
}

let cachedVueModule = null;
async function getVueModule() {
  if (cachedVueModule) return cachedVueModule;
  cachedVueModule = await import("vue");
  return cachedVueModule;
}

function resolveWorkspaceStore(module) {
  return module?.useWorkspaceStore ?? module?.u ?? null;
}

function resolveToastStore(module) {
  return module?.useToastStore ?? module?.a6 ?? null;
}

function createHistoryComponent({
  api,
  toastStore,
  vueHelpers,
  eventBus,
  assetLoader,
  comfyApp,
}) {
  const {
    defineComponent,
    ref,
    computed,
    nextTick,
    onMounted,
    onBeforeUnmount,
    h,
  } = vueHelpers;

  const viewerBridge = createViewerBridge({
    cssUrl: new URL("./vendor/viewerjs/viewer.min.css", import.meta.url).href,
    scriptUrl: new URL("./vendor/viewerjs/viewer.min.js", import.meta.url).href,
    assetLoader,
  });

  const historyApi = createHistoryApi(api);

  return defineComponent({
    name: "PromptHistorySidebar",
    setup() {
      const entries = ref([]);
      const isLoading = ref(false);
      const errorMessage = ref("");
      const limit = ref(50);

      const hasEntries = computed(() => entries.value.length > 0);
      const activePromptTarget = ref(null);
      const hasActivePromptTarget = computed(
        () => activePromptTarget.value != null
      );

      const resolvePromptWidget = (node) => {
        if (!node?.widgets || !Array.isArray(node.widgets)) return null;
        return node.widgets.find((widget) => widget?.name === "prompt") ?? null;
      };

      const resolveSelectedPromptNode = () => {
        const canvas = comfyApp?.canvas ?? null;
        if (!canvas?.selected_nodes) return null;
        const selectedNodes = canvas.selected_nodes;
        const candidates = Array.isArray(selectedNodes)
          ? selectedNodes
          : Object.values(selectedNodes);
        for (const candidate of candidates) {
          if (candidate?.comfyClass !== "PromptHistoryInput") continue;
          const widget = resolvePromptWidget(candidate);
          if (widget) {
            return { node: candidate, widget };
          }
        }
        return null;
      };

      const normalizeTargetPayload = (node, widget) => {
        if (!node || !widget) return null;
        const nodeId = node.id ?? null;
        if (nodeId == null) return null;
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
      };

      const updateActivePromptTarget = () => {
        const resolved = resolveSelectedPromptNode();
        if (!resolved) {
          if (activePromptTarget.value !== null) {
            activePromptTarget.value = null;
          }
          return;
        }
        const next = normalizeTargetPayload(resolved.node, resolved.widget);
        if (!next) {
          if (activePromptTarget.value !== null) {
            activePromptTarget.value = null;
          }
          return;
        }
        const current = activePromptTarget.value;
        if (
          current &&
          current.nodeId === next.nodeId &&
          current.graph === next.graph &&
          current.widgetName === next.widgetName
        ) {
          current.nodeRef = resolved.node;
          return;
        }
        activePromptTarget.value = next;
      };

      let selectionMonitorId = null;

      const startSelectionMonitor = () => {
        if (!comfyApp?.canvas) return;
        if (selectionMonitorId != null) return;
        updateActivePromptTarget();
        selectionMonitorId = window.setInterval(updateActivePromptTarget, 400);
      };

      const stopSelectionMonitor = () => {
        if (selectionMonitorId != null) {
          window.clearInterval(selectionMonitorId);
          selectionMonitorId = null;
        }
      };

      const resolveNodeFromTarget = (target) => {
        if (!target) return null;
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
        if (
          !node &&
          Array.isArray(comfyApp?.graph?.nodes)
        ) {
          node =
            comfyApp.graph.nodes.find((candidate) => candidate?.id === nodeId) ??
            null;
        }
        if (!node && nodeRef) {
          node = nodeRef;
        }
        return node ?? null;
      };

      const applyPromptToWidget = (node, widget, promptText) => {
        if (!node || !widget) return false;
        const normalized =
          typeof promptText === "string" ? promptText : String(promptText ?? "");
        const previous =
          typeof widget.value === "string"
            ? widget.value
            : widget.value ?? "";
        if (previous === normalized) {
          return false;
        }

        let handled = false;
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
              node.onWidgetChanged(
                widget.name ?? "",
                widget.value,
                previous,
                widget
              );
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
      };

      const usePrompt = (entry) => {
        if (!entry) return;
        const target = activePromptTarget.value;
        if (!target) {
          copyPrompt(entry);
          return;
        }
        const node = resolveNodeFromTarget(target);
        if (!node) {
          showToast(
            "Active Prompt History Input is no longer available.",
            "warn"
          );
          activePromptTarget.value = null;
          return;
        }
        const widget =
          node.widgets?.find((item) => item?.name === target.widgetName) ??
          resolvePromptWidget(node);
        if (!widget) {
          showToast("Prompt widget not found on active node.", "warn");
          return;
        }
        const updated = applyPromptToWidget(node, widget, entry.prompt ?? "");
        target.nodeRef = node;
        if (updated) {
          const destination = target.nodeTitle ?? "Prompt History Input";
          showToast(`Prompt sent to ${destination}.`, "success");
        } else {
          showToast("Prompt already matches selected input.", "info");
        }
      };

      const showToast = (detail, severity = "info") => {
        toastStore?.add({
          severity,
          summary: "Prompt History",
          detail,
          life: 2500,
        });
      };

      const confirmAction = (message) => {
        if (typeof window !== "undefined" && typeof window.confirm === "function") {
          return window.confirm(message);
        }
        return true;
      };

      const refreshEntries = async () => {
        isLoading.value = true;
        errorMessage.value = "";
        try {
          const items = await historyApi.list(limit.value);
          entries.value = items;
          viewerBridge.close();
        } catch (error) {
          logError("refreshEntries error", error);
          errorMessage.value =
            error?.message ?? "Failed to load prompt history.";
        } finally {
          isLoading.value = false;
        }
      };

      const copyPrompt = async (entry) => {
        try {
          await navigator.clipboard.writeText(entry.prompt ?? "");
          showToast("Prompt copied to clipboard.");
        } catch (error) {
          logError("copyPrompt error", error);
          showToast("Failed to copy prompt.", "warn");
        }
      };

      const deleteEntry = async (entry) => {
        if (!entry?.id) return;
        const confirmed = confirmAction("Delete this prompt history entry?");
        if (!confirmed) {
          return;
        }
        try {
          await historyApi.remove(entry.id);
          entries.value = entries.value.filter((item) => item.id !== entry.id);
          if (viewerBridge.isActive(entry.id)) {
            viewerBridge.close();
          }
          showToast("History entry deleted.", "success");
        } catch (error) {
          logError("deleteEntry error", error);
          showToast("Failed to delete history entry.", "error");
        }
      };

      const clearAll = async () => {
        const confirmed = confirmAction(
          "Delete all prompt history entries? This cannot be undone."
        );
        if (!confirmed) {
          return;
        }
        try {
          await historyApi.clear();
          entries.value = [];
          viewerBridge.close();
          showToast("Cleared all history.", "success");
        } catch (error) {
          logError("clearAll error", error);
          showToast("Failed to clear history.", "error");
        }
      };

      const openGallery = async (entry, startIndex = 0) => {
        try {
          const sources = buildImageSources(entry, api);
          if (!sources.length) {
            showToast("No images available for this prompt.", "warn");
            return;
          }
          await nextTick();
          await viewerBridge.open(entry.id ?? null, sources, startIndex);
        } catch (error) {
          logError("openGallery error", error);
          viewerBridge.close();
          showToast("Failed to open image gallery.", "warn");
        }
      };

      const updateEventName = "PromptHistoryGallery.updated";
      const handleHistoryUpdate = () => {
        refreshEntries();
      };

      onMounted(() => {
        refreshEntries();
        startSelectionMonitor();
        if (api?.addEventListener) {
          api.addEventListener(updateEventName, handleHistoryUpdate);
        }
        eventBus?.on?.(updateEventName, handleHistoryUpdate);
      });

      onBeforeUnmount(() => {
        stopSelectionMonitor();
        if (api?.removeEventListener) {
          api.removeEventListener(updateEventName, handleHistoryUpdate);
        }
        eventBus?.off?.(updateEventName, handleHistoryUpdate);
        viewerBridge.dispose();
      });

      return {
        entries,
        isLoading,
        errorMessage,
        hasEntries,
        hasActivePromptTarget,
        activePromptTarget,
        refreshEntries,
        copyPrompt,
        usePrompt,
        deleteEntry,
        clearAll,
        openGallery,
        buildImageSources: (entry) => buildImageSources(entry, api),
      };
    },
    render() {
      const createText = (text) => h("span", text);
      const hasPromptTarget = this.hasActivePromptTarget;
      const createIconButton = ({
        icon,
        label,
        onClick,
        disabled = false,
        severity = null,
        badge = null,
      }) => {
        const classes = [
          "p-button",
          "p-button-rounded",
          "p-button-text",
          "p-button-icon-only",
          "p-button-sm",
          "phg-action-button",
        ];
        if (severity === "danger") {
          classes.push("p-button-danger");
        }

        return h(
          "button",
          {
            class: classes.join(" "),
            type: "button",
            disabled,
            onClick,
            title: label,
            "aria-label": label,
          },
          [
            h("i", { class: `pi ${icon}` }),
            badge != null
              ? h(
                  "span",
                  {
                    class: "p-badge phg-action-badge",
                  },
                  String(badge)
                )
              : null,
          ].filter(Boolean)
        );
      };

      const status = this.errorMessage
        ? h("div", { class: "phg-message phg-message--error" }, [
            createText(this.errorMessage),
          ])
        : null;

      const empty = !this.isLoading && !this.hasEntries
        ? h(
            "div",
            { class: "phg-message phg-message--empty" },
            "No prompt history yet. Run a workflow to populate this list."
          )
        : null;

      const entriesList = h(
        "div",
        { class: "phg-entries" },
        this.entries.map((entry) => {
          const galleryItems = this.buildImageSources(entry);
          const hasGallery = galleryItems.length > 0;

          const tags =
            Array.isArray(entry.tags) && entry.tags.length > 0
              ? h(
                  "div",
                  { class: "phg-entry-tags" },
                  entry.tags.map((tag) =>
                    h("span", { class: "phg-tag", key: tag }, tag)
                  )
                )
              : null;

          const metadataNotes = entry?.metadata?.notes
            ? h(
                "div",
                { class: "phg-entry-meta" },
                String(entry.metadata.notes)
              )
            : null;

          const lastUsed =
            entry?.last_used_at ?? entry?.created_at ?? "";
          const displayDate = lastUsed
            ? new Date(lastUsed).toLocaleString()
            : "Unknown";

          return h(
            "article",
            { class: "phg-entry", key: entry.id },
            [
              h("header", { class: "phg-entry-header" }, [
                h(
                  "span",
                  {
                    class: "phg-entry-date",
                    title:
                      entry.created_at && entry.created_at !== lastUsed
                        ? `Created: ${new Date(entry.created_at).toLocaleString()}`
                        : undefined,
                  },
                  displayDate
                ),
                h("div", { class: "phg-entry-actions" }, [
                  createIconButton({
                    icon: hasPromptTarget
                      ? "pi-arrow-circle-right"
                      : "pi-copy",
                    label: hasPromptTarget ? "Use prompt" : "Copy prompt",
                    onClick: () =>
                      hasPromptTarget
                        ? this.usePrompt(entry)
                        : this.copyPrompt(entry),
                  }),
                  createIconButton({
                    icon: "pi-image",
                    label: hasGallery
                      ? `Open gallery (${galleryItems.length} images)`
                      : "No generated images were captured",
                    disabled: !hasGallery,
                    onClick: () => this.openGallery(entry, 0),
                    badge: hasGallery ? galleryItems.length : null,
                  }),
                  createIconButton({
                    icon: "pi-trash",
                    label: "Delete entry",
                    severity: "danger",
                    onClick: () => this.deleteEntry(entry),
                  }),
                ]),
              ]),
              h("pre", { class: "phg-entry-prompt" }, entry.prompt ?? ""),
              tags,
              metadataNotes,
            ].filter(Boolean)
          );
        })
      );

      return h("div", { class: "phg-container" }, [
        status,
        this.isLoading
          ? h("div", { class: "phg-message" }, "Loading history…")
          : null,
        empty,
        entriesList,
      ]);
    },
  });
}

async function registerHistoryTab() {
  if (isRegistered) return;
  ensureStylesheet();

  const module = await getMainBundleModule();
  const vue = await getVueModule();
  const useWorkspaceStore = resolveWorkspaceStore(module);
  if (!useWorkspaceStore) {
    throw new Error("useWorkspaceStore was not found");
  }

  const workspaceStore = useWorkspaceStore();
  if (!workspaceStore?.registerSidebarTab) {
    throw new Error("workspaceStore is not initialized");
  }

  const existing = workspaceStore
    .getSidebarTabs()
    ?.find((tab) => tab.id === TAB_ID);
  if (existing) {
    isRegistered = true;
    logInfo("History tab already registered");
    return;
  }

  const useToastStore = resolveToastStore(module);
  const toastStore = useToastStore ? useToastStore() : null;

  const comfyApp = window.comfyAPI?.app?.app ?? null;
  const comfyApi = comfyApp?.api ?? window.comfyAPI?.api?.api ?? null;
  const eventBus = comfyApp?.eventBus ?? null;

  const vueHelpers = {
    defineComponent: vue.defineComponent,
    ref: vue.ref,
    computed: vue.computed,
    nextTick:
      typeof vue.nextTick === "function"
        ? vue.nextTick
        : (callback) => {
            const promise = Promise.resolve();
            return callback ? promise.then(callback) : promise;
          },
    onMounted: vue.onMounted,
    onBeforeUnmount: vue.onBeforeUnmount,
    h: vue.h,
  };

  const assetLoader = createAssetLoader("data-phg-asset");

  const component = createHistoryComponent({
    api: comfyApi,
    toastStore,
    vueHelpers,
    eventBus,
    assetLoader,
    comfyApp,
  });

  workspaceStore.registerSidebarTab({
    id: TAB_ID,
    icon: "pi pi-clock",
    title: "Prompt History",
    tooltip: "Prompt History",
    label: "Prompt History",
    type: "vue",
    component: vue.markRaw ? vue.markRaw(component) : component,
  });

  isRegistered = true;
  logInfo("History tab registered");
}

const MAX_ATTEMPTS = 20;
const RETRY_DELAY = 500;

async function attemptRegistration(attempt = 0) {
  if (isRegistered) return;

  try {
    await registerHistoryTab();
  } catch (error) {
    if (attempt >= MAX_ATTEMPTS) {
      logError("History tab registration failed", error);
      return;
    }
    setTimeout(() => attemptRegistration(attempt + 1), RETRY_DELAY);
  }
}

logInfo(`${EXTENSION_NAME} loading`);
const comfyAppInstance = window.comfyAPI?.app?.app;
if (comfyAppInstance?.registerExtension) {
  comfyAppInstance.registerExtension({
    name: EXTENSION_NAME,
    setup() {
      logInfo("setup hook called");
      attemptRegistration();
    },
  });
} else {
  attemptRegistration();
}
