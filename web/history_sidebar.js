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

      const showToast = (detail, severity = "info") => {
        toastStore?.add({
          severity,
          summary: "Prompt History",
          detail,
          life: 2500,
        });
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
        if (api?.addEventListener) {
          api.addEventListener(updateEventName, handleHistoryUpdate);
        }
        eventBus?.on?.(updateEventName, handleHistoryUpdate);
      });

      onBeforeUnmount(() => {
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
        refreshEntries,
        copyPrompt,
        deleteEntry,
        clearAll,
        openGallery,
        buildImageSources: (entry) => buildImageSources(entry, api),
      };
    },
    render() {
      const createText = (text) => h("span", text);

      const toolbar = h("div", { class: "phg-toolbar" }, [
        h(
          "button",
          {
            class: "phg-button",
            disabled: this.isLoading,
            onClick: this.refreshEntries,
          },
          this.isLoading ? "Refreshing…" : "Refresh"
        ),
        h(
          "button",
          {
            class: "phg-button phg-button--danger",
            disabled: this.isLoading || !this.hasEntries,
            onClick: this.clearAll,
            title: "Clear all history",
          },
          "Clear"
        ),
      ]);

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
          const galleryLabel = hasGallery
            ? `Gallery (${galleryItems.length})`
            : "Gallery";

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
                  `Last used: ${displayDate}`
                ),
                h("div", { class: "phg-entry-actions" }, [
                  h(
                    "button",
                    {
                      class: "phg-button phg-button--icon",
                      title: "Copy prompt",
                      onClick: () => this.copyPrompt(entry),
                    },
                    "Copy"
                  ),
                  h(
                    "button",
                    {
                      class: "phg-button phg-button--icon",
                      title: hasGallery
                        ? `Open gallery (${galleryItems.length} images)`
                        : "No generated images were captured",
                      disabled: !hasGallery,
                      onClick: () => this.openGallery(entry, 0),
                    },
                    galleryLabel
                  ),
                  h(
                    "button",
                    {
                      class: "phg-button phg-button--icon phg-button--danger",
                      title: "Delete entry",
                      onClick: () => this.deleteEntry(entry),
                    },
                    "Delete"
                  ),
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
        toolbar,
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
