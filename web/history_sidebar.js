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

const VIEWER_CSS_URL = new URL("./vendor/viewerjs/viewer.min.css", import.meta.url).href;
const VIEWER_JS_URL = new URL("./vendor/viewerjs/viewer.min.js", import.meta.url).href;

const externalAssetPromises = new Map();

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".webp",
  ".tiff",
  ".tif",
  ".avif",
  ".svg",
]);

function ensureExternalStylesheet(href) {
  if (!href) return Promise.reject(new Error("Stylesheet URL is required"));
  const key = `style:${href}`;
  if (externalAssetPromises.has(key)) {
    return externalAssetPromises.get(key);
  }
  const existing = Array.from(
    document.head.querySelectorAll('link[data-phg-asset]')
  ).find((link) => link.dataset.phgAsset === href);
  if (existing) {
    return Promise.resolve();
  }
  const promise = new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.dataset.phgAsset = href;
    link.addEventListener("load", () => resolve());
    link.addEventListener("error", () =>
      reject(new Error(`Failed to load stylesheet: ${href}`))
    );
    document.head.appendChild(link);
  });
  externalAssetPromises.set(key, promise);
  return promise;
}

function ensureExternalScript(src) {
  if (!src) return Promise.reject(new Error("Script URL is required"));
  const key = `script:${src}`;
  if (externalAssetPromises.has(key)) {
    return externalAssetPromises.get(key);
  }
  const existing = Array.from(
    document.head.querySelectorAll('script[data-phg-asset]')
  ).find((script) => script.dataset.phgAsset === src);
  if (existing) {
    return existing.dataset.phgLoaded === "true"
      ? Promise.resolve()
      : new Promise((resolve, reject) => {
          existing.addEventListener("load", () => resolve());
          existing.addEventListener("error", () =>
            reject(new Error(`Failed to load script: ${src}`))
          );
        });
  }
  const promise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.defer = false;
    script.dataset.phgAsset = src;
    script.addEventListener("load", () => {
      script.dataset.phgLoaded = "true";
      resolve();
    });
    script.addEventListener("error", () =>
      reject(new Error(`Failed to load script: ${src}`))
    );
    document.head.appendChild(script);
  });
  externalAssetPromises.set(key, promise);
  return promise;
}

let viewerLoader = null;
async function ensureViewer() {
  if (viewerLoader) return viewerLoader;
  viewerLoader = (async () => {
    await ensureExternalStylesheet(VIEWER_CSS_URL);
    await ensureExternalScript(VIEWER_JS_URL);
    if (typeof window.Viewer !== "function") {
      throw new Error("Viewer global was not found after loading assets.");
    }
    return window.Viewer;
  })();
  return viewerLoader;
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
  const seen = new Set();

  const appendSource = (descriptor, { skipExtensionCheck = false } = {}) => {
    if (!descriptor || !descriptor.filename) return;
    const filename = String(descriptor.filename);
    if (
      !skipExtensionCheck &&
      !isLikelyImageFilename(filename)
    ) {
      return;
    }
    const params = new URLSearchParams();
    params.set("filename", filename);
    const typeValue =
      descriptor.type && String(descriptor.type).trim()
        ? String(descriptor.type).trim()
        : "output";
    params.set("type", typeValue);
    if (descriptor.subfolder) params.set("subfolder", String(descriptor.subfolder));
    if (descriptor.preview !== undefined) {
      params.set("preview", String(descriptor.preview));
    }
    const path = `/view?${params.toString()}`;
    const url = api?.fileURL ? api.fileURL(path) : path;
    if (seen.has(url)) return;
    seen.add(url);
    const title =
      descriptor.title !== undefined && descriptor.title !== null
        ? String(descriptor.title)
        : filename;
    const thumbnailSource =
      descriptor.thumbnail !== undefined && descriptor.thumbnail !== null
        ? String(descriptor.thumbnail)
        : descriptor.thumb !== undefined && descriptor.thumb !== null
        ? String(descriptor.thumb)
        : url;
    result.push({ url, title, thumb: thumbnailSource });
  };

  const normalizeDescriptor = (item) => {
    if (!item) return null;
    if (typeof item === "string") {
      const trimmed = item.trim();
      if (!trimmed) return null;
      return { filename: trimmed };
    }
    if (typeof item === "object") {
      const filename = item.filename ?? item.name;
      if (!filename) return null;
      const descriptor = {
        filename: String(filename),
        subfolder:
          item.subfolder !== undefined ? String(item.subfolder) : undefined,
        type:
          item.type !== undefined
            ? String(item.type)
            : item.kind !== undefined
            ? String(item.kind)
            : undefined,
        preview: item.preview,
      };
      const label =
        item.title ??
        item.label ??
        item.caption ??
        item.prompt ??
        item.name ??
        filename;
      if (label !== undefined && label !== null) {
        descriptor.title = String(label);
      }
      const thumbnail =
        item.thumbnail ??
        item.thumb ??
        item.preview_url ??
        item.previewUrl ??
        item.poster ??
        item.poster_url ??
        item.url;
      if (thumbnail !== undefined && thumbnail !== null) {
        descriptor.thumbnail = String(thumbnail);
      }
      return descriptor;
    }
    return null;
  };

  const isLikelyImageFilename = (name) => {
    if (typeof name !== "string") return false;
    const trimmed = name.trim().toLowerCase();
    if (!trimmed) return false;
    const index = trimmed.lastIndexOf(".");
    if (index === -1) return false;
    const ext = trimmed.slice(index);
    return IMAGE_EXTENSIONS.has(ext);
  };

  const addFromCollection = (collection, options = {}) => {
    if (!Array.isArray(collection)) return;
    for (const item of collection) {
      const descriptor = normalizeDescriptor(item);
      if (!descriptor) continue;
      appendSource(descriptor, options);
    }
  };

  addFromCollection(entry?.metadata?.images, { skipExtensionCheck: true });
  addFromCollection(entry?.files);
  addFromCollection(entry?.metadata?.files);

  const outputs = entry?.metadata?.outputs;
  if (outputs && typeof outputs === "object") {
    for (const value of Object.values(outputs)) {
      if (Array.isArray(value)) {
        addFromCollection(value);
        continue;
      }
      if (value && typeof value === "object") {
        for (const nested of Object.values(value)) {
          if (Array.isArray(nested)) {
            addFromCollection(nested);
          }
        }
      }
    }
  }
  return result;
}

const VIEWER_ROOT_ID = "phg-viewer-root";

function ensureViewerRoot() {
  if (typeof document === "undefined") return null;
  let container = document.getElementById(VIEWER_ROOT_ID);
  if (!container) {
    container = document.createElement("div");
    container.id = VIEWER_ROOT_ID;
    container.style.display = "none";
    container.setAttribute("aria-hidden", "true");
    document.body.appendChild(container);
  }
  return container;
}

function clearViewerRoot() {
  if (typeof document === "undefined") return;
  const container = document.getElementById(VIEWER_ROOT_ID);
  if (container) {
    container.innerHTML = "";
  }
}

function removeViewerRoot() {
  if (typeof document === "undefined") return;
  const container = document.getElementById(VIEWER_ROOT_ID);
  if (container?.parentNode) {
    container.parentNode.removeChild(container);
  }
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
    nextTick,
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
      let activeViewerInstance = null;
      let activeViewerEntryId = null;
      let activeViewerCleanup = null;

      const hasEntries = computed(() => entries.value.length > 0);

      const destroyActiveViewer = () => {
        const cleanup = activeViewerCleanup;
        activeViewerCleanup = null;
        if (typeof cleanup === "function") {
          cleanup(false);
          return;
        }
        if (!activeViewerInstance) {
          activeViewerEntryId = null;
          clearViewerRoot();
          return;
        }
        const instance = activeViewerInstance;
        activeViewerInstance = null;
        activeViewerEntryId = null;
        try {
          instance.destroy();
        } catch (error) {
          logError("destroyActiveViewer error", error);
        }
        clearViewerRoot();
      };

      const showToast = (detail, severity = "info") => {
        toastStore?.add({
          severity,
          summary: "Prompt History",
          detail,
          life: 2500,
        });
      };

      const openGallery = async (entry, galleryItems, startIndex = 0) => {
        if (!entry || !Array.isArray(galleryItems) || galleryItems.length === 0) {
          showToast("No images available for this prompt.", "warn");
          return;
        }
        try {
          await ensureViewer();
          await nextTick();
          destroyActiveViewer();

          const root = ensureViewerRoot();
          if (!root) {
            throw new Error("Unable to create viewer root element.");
          }
          root.innerHTML = "";

          const fragment = document.createDocumentFragment();
          galleryItems.forEach((item, index) => {
            const image = document.createElement("img");
            image.src = item.thumb ?? item.url;
            image.setAttribute("data-original", item.url);
            if (item.title) {
              image.alt = item.title;
              image.setAttribute("data-caption", item.title);
            } else {
              image.alt = "";
            }
            image.dataset.index = String(index);
            image.loading = "lazy";
            fragment.appendChild(image);
          });
          if (!fragment.childNodes.length) {
            showToast("No images available for this prompt.", "warn");
            return;
          }
          root.appendChild(fragment);

          const safeIndex = Math.min(
            Math.max(startIndex || 0, 0),
            Math.max(galleryItems.length - 1, 0)
          );

          let isCleaning = false;
          let cleanup = () => {};
          const hiddenHandler = () => cleanup(true);

          const viewer = new window.Viewer(root, {
            navbar: true,
            toolbar: true,
            tooltip: true,
            movable: true,
            zoomable: true,
            rotatable: true,
            scalable: true,
            transition: true,
            fullscreen: true,
            keyboard: true,
            initialViewIndex: safeIndex,
            url(image) {
              return image?.getAttribute?.("data-original") || image?.src || "";
            },
            title: [
              1,
              (image) => image?.getAttribute?.("data-caption") || image?.alt || "",
            ],
          });

          cleanup = (fromHidden = false) => {
            if (isCleaning) return;
            isCleaning = true;
            viewer.element.removeEventListener("hidden", hiddenHandler);
            if (activeViewerInstance === viewer) {
              activeViewerInstance = null;
              activeViewerEntryId = null;
            }
            activeViewerCleanup = null;
            clearViewerRoot();
            if (!fromHidden) {
              try {
                viewer.hide?.();
              } catch (error) {
                logError("viewer hide error", error);
              }
            }
            try {
              viewer.destroy();
            } catch (error) {
              logError("viewer destroy error", error);
            }
            isCleaning = false;
          };

          viewer.element.addEventListener("hidden", hiddenHandler);

          activeViewerInstance = viewer;
          activeViewerEntryId = entry.id ?? null;
          activeViewerCleanup = cleanup;

          viewer.show();
        } catch (error) {
          logError("openGallery error", error);
          destroyActiveViewer();
          showToast("Failed to open image gallery.", "warn");
        }
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
          destroyActiveViewer();
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
          if (entry?.id && entry.id === activeViewerEntryId) {
            destroyActiveViewer();
          }
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
          destroyActiveViewer();
          showToast("Cleared all history.", "success");
        } catch (error) {
          logError("clearAll error", error);
          showToast("Failed to clear history.", "error");
        }
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
        destroyActiveViewer();
        removeViewerRoot();
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
        openGallery,
      };
    },
    render() {
      const h = vueHelpers.h;

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

          const galleryItems = buildImageSources(entry, api);
          const hasGallery = galleryItems.length > 0;
          const galleryLabel = hasGallery
            ? `Gallery (${galleryItems.length})`
            : "Gallery";
          const galleryButton = h(
            "button",
            {
              class: "phg-button phg-button--icon",
              title: hasGallery
                ? `Open gallery (${galleryItems.length} images)`
                : "No generated images were captured",
              disabled: !hasGallery,
              onClick: () => this.openGallery(entry, galleryItems, 0),
            },
            galleryLabel
          );

          const metadataNotes = entry?.metadata?.notes
            ? h(
                "div",
                { class: "phg-entry-meta" },
                String(entry.metadata.notes)
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
                  galleryButton,
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
