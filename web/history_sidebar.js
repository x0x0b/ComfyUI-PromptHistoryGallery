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

function buildImageSources(entry, api) {
  const result = [];
  const images = entry?.metadata?.images;
  if (!Array.isArray(images)) return result;

  for (const image of images) {
    if (!image?.filename) continue;
    const params = new URLSearchParams();
    params.set("filename", image.filename);
    params.set("type", image.type ?? "output");
    if (image.subfolder) params.set("subfolder", image.subfolder);
    if (image.preview) params.set("preview", String(image.preview));
    const path = `/view?${params.toString()}`;
    const url = api?.fileURL ? api.fileURL(path) : path;
    result.push({ url, title: image.title ?? image.filename });
  }
  return result;
}

function toDateLabel(value) {
  try {
    return new Date(value).toLocaleString();
  } catch (_) {
    return value;
  }
}

function createHistoryComponent(api, toastStore, vueHelpers, eventBus) {
  const {
    defineComponent,
    ref,
    computed,
    onMounted,
    onBeforeUnmount,
    h,
  } = vueHelpers;

  return defineComponent({
    name: "PromptHistorySidebar",
    setup() {
      const entries = ref([]);
      const isLoading = ref(false);
      const errorMessage = ref("");
      const limit = ref(50);
      const expandedFiles = ref(new Set());

      const hasEntries = computed(() => entries.value.length > 0);

      const resetExpandedFiles = () => {
        expandedFiles.value = new Set();
      };

      const toggleFiles = (entryId) => {
        const next = new Set(expandedFiles.value);
        if (next.has(entryId)) {
          next.delete(entryId);
        } else {
          next.add(entryId);
        }
        expandedFiles.value = next;
      };

      const collapseFiles = (entryId) => {
        if (!expandedFiles.value.has(entryId)) return;
        const next = new Set(expandedFiles.value);
        next.delete(entryId);
        expandedFiles.value = next;
      };

      const isFilesVisible = (entryId) => expandedFiles.value.has(entryId);

      const showToast = (detail, severity = "info") => {
        toastStore?.add({
          severity,
          summary: "Prompt History",
          detail,
          life: 2500,
        });
      };

      const fetchEntries = async () => {
        isLoading.value = true;
        errorMessage.value = "";
        try {
          const response = await (api
            ? api.fetchApi(`/prompt-history?limit=${limit.value}`, {
                method: "GET",
              })
            : fetch(`/prompt-history?limit=${limit.value}`, { method: "GET" }));
          if (!response.ok) {
            throw new Error(`Failed to fetch history (${response.status})`);
          }
          const data = await response.json();
          entries.value = Array.isArray(data.entries) ? data.entries : [];
          resetExpandedFiles();
        } catch (error) {
          logError("fetchEntries error", error);
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
        try {
          const path = `/prompt-history/${entry.id}`;
          const response = await (api
            ? api.fetchApi(path, { method: "DELETE" })
            : fetch(path, { method: "DELETE" }));
          if (!response.ok) {
            throw new Error(`Delete failed (${response.status})`);
          }
          entries.value = entries.value.filter((item) => item.id !== entry.id);
          collapseFiles(entry.id);
          showToast("History entry deleted.", "success");
        } catch (error) {
          logError("deleteEntry error", error);
          showToast("Failed to delete history entry.", "error");
        }
      };

      const clearAll = async () => {
        try {
          const response = await (api
            ? api.fetchApi("/prompt-history", { method: "DELETE" })
            : fetch("/prompt-history", { method: "DELETE" }));
          if (!response.ok) {
            throw new Error(`Clear failed (${response.status})`);
          }
          entries.value = [];
          resetExpandedFiles();
          showToast("Cleared all history.", "success");
        } catch (error) {
          logError("clearAll error", error);
          showToast("Failed to clear history.", "error");
        }
      };

      const openImage = (url) => {
        window.open(url, "_blank", "noopener,noreferrer");
      };

      const updateEventName = "PromptHistoryGallery.updated";
      const handleHistoryUpdate = () => {
        fetchEntries();
      };

      onMounted(() => {
        fetchEntries();
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
      });

      return {
        entries,
        isLoading,
        errorMessage,
        hasEntries,
        fetchEntries,
        copyPrompt,
        deleteEntry,
        clearAll,
        openImage,
        toggleFiles,
        isFilesVisible,
      };
    },
    render() {
      const h = vueHelpers.h;

      const toFileLabel = (file) => {
        if (typeof file === "string") {
          return file;
        }
        if (!file || typeof file !== "object") {
          return "(unknown file)";
        }
        const filename = file.filename ?? "";
        const location = file.subfolder
          ? `${file.subfolder}/${filename}`
          : filename;
        if (file.type && file.type !== "output") {
          return location ? `${location} (${file.type})` : `(${file.type})`;
        }
        return location || "(unknown file)";
      };

      const toFileKey = (file, index) => {
        if (typeof file === "string") {
          return `${file}-${index}`;
        }
        if (!file || typeof file !== "object") {
          return `file-${index}`;
        }
        const parts = [file.subfolder ?? "", file.filename ?? "", file.type ?? "", index];
        return parts.join("|");
      };

      const toLastUsedTimestamp = (entry) =>
        entry?.last_used_at ?? entry?.created_at ?? "";

      const toolbar = h("div", { class: "phg-toolbar" }, [
        h(
          "button",
          {
            class: "phg-button",
            disabled: this.isLoading,
            onClick: this.fetchEntries,
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

      const statusMessage = this.errorMessage
        ? h("div", { class: "phg-message phg-message--error" }, [
            this.errorMessage,
          ])
        : null;

      const emptyMessage =
        !this.isLoading && !this.hasEntries
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

          const files = Array.isArray(entry.files)
            ? entry.files
            : Array.isArray(entry?.metadata?.files)
            ? entry.metadata.files
            : [];
          const hasFiles = files.length > 0;

          const filesButton = h(
            "button",
            {
              class: "phg-button phg-button--icon",
              title: hasFiles
                ? this.isFilesVisible(entry.id)
                  ? "Hide generated files"
                  : "Show generated files"
                : "No generated files were captured",
              disabled: !hasFiles,
              onClick: () => this.toggleFiles(entry.id),
            },
            hasFiles && this.isFilesVisible(entry.id) ? "Hide Files" : "Files"
          );

          const galleryItems = buildImageSources(entry, api);
          const gallery =
            galleryItems.length > 0
              ? h(
                  "div",
                  { class: "phg-entry-gallery" },
                  galleryItems.map((image) =>
                    h("img", {
                      src: image.url,
                      alt: image.title,
                      class: "phg-entry-image",
                      title: "Open image in new tab",
                      onClick: () => this.openImage(image.url),
                    })
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

          const filesList =
            hasFiles && this.isFilesVisible(entry.id)
              ? h(
                  "div",
                  { class: "phg-entry-files" },
                  [
                    h(
                      "div",
                      { class: "phg-entry-files-title" },
                      "Generated files"
                    ),
                    h(
                      "ul",
                      { class: "phg-file-list" },
                      files.map((file, index) =>
                        h(
                          "li",
                          {
                            class: "phg-file-item",
                            key: toFileKey(file, index),
                          },
                          toFileLabel(file)
                        )
                      )
                    ),
                  ]
                )
              : null;

          const lastUsed = toLastUsedTimestamp(entry);
          const displayDate = lastUsed ? toDateLabel(lastUsed) : "Unknown";

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
                        ? `Created: ${toDateLabel(entry.created_at)}`
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
                  filesButton,
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
              filesList,
              gallery,
            ].filter(Boolean)
          );
        })
      );

      return h("div", { class: "phg-container" }, [
        toolbar,
        statusMessage,
        this.isLoading
          ? h("div", { class: "phg-message" }, "Loading history…")
          : null,
        emptyMessage,
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
  const api = comfyApp?.api ?? window.comfyAPI?.api?.api ?? null;
  const eventBus = comfyApp?.eventBus ?? null;

  const vueHelpers = {
    defineComponent: vue.defineComponent,
    ref: vue.ref,
    computed: vue.computed,
    onMounted: vue.onMounted,
    onBeforeUnmount: vue.onBeforeUnmount,
    h: vue.h,
  };

  const component = createHistoryComponent(
    api,
    toastStore,
    vueHelpers,
    eventBus
  );

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
