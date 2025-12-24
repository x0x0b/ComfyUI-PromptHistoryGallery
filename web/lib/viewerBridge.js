import { createAssetLoader } from "./assetLoader.js";
import { extractMetadata, formatMetadata } from "./metadata.js";

const DEFAULT_ROOT_ID = "phg-viewer-root";

function ensureElement(id) {
  let element = document.getElementById(id);
  if (!element) {
    element = document.createElement("div");
    element.id = id;
    element.style.display = "none";
    element.setAttribute("aria-hidden", "true");
    document.body.appendChild(element);
  }
  return element;
}

export class ViewerBridge {
  constructor({ cssUrl, scriptUrl, assetLoader = createAssetLoader(), rootId = DEFAULT_ROOT_ID }) {
    this.assetLoader = assetLoader;
    this.cssUrl = cssUrl;
    this.scriptUrl = scriptUrl;
    this.rootId = rootId;
    this.instance = null;
    this.activeEntryId = null;
    this.cleanupFn = null;
    this.hiddenHandler = null;
  }

  async ensureAssets() {
    await this.assetLoader.ensureAssets({
      styles: [this.cssUrl],
      scripts: [this.scriptUrl],
    });
    if (typeof window.Viewer !== "function") {
      throw new Error("Viewer.js did not load correctly.");
    }
  }

  ensureRoot() {
    return ensureElement(this.rootId);
  }

  _teardown(fromHidden = false) {
    const cleanup = this.cleanupFn;
    this.cleanupFn = null;
    if (typeof cleanup === "function") {
      cleanup(fromHidden);
      return;
    }

    if (!this.instance) {
      this.activeEntryId = null;
      this._clearRoot();
      return;
    }

    try {
      if (!fromHidden) {
        this.instance.hide?.();
      }
      this.instance.destroy?.();
    } catch (error) {
      console.error("[PromptHistoryGallery]", "Viewer teardown error", error);
    }
    this.instance = null;
    this.activeEntryId = null;
    this._clearRoot();
  }

  _clearRoot() {
    const root = document.getElementById(this.rootId);
    if (root) {
      root.innerHTML = "";
    }
  }

  removeRoot() {
    const root = document.getElementById(this.rootId);
    if (root?.parentNode) {
      root.parentNode.removeChild(root);
    }
  }

  async open(entryId, items, startIndex = 0, entry = null) {
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error("No images available for this entry.");
    }
    await this.ensureAssets();
    this._teardown(false);

    const root = this.ensureRoot();
    root.innerHTML = "";

    const fragment = document.createDocumentFragment();
    items.forEach((item, index) => {
      const image = document.createElement("img");
      image.src = item.thumb ?? item.url;
      image.setAttribute("data-original", item.url);
      image.alt = item.title ?? "";
      if (item.title) {
        image.setAttribute("data-caption", item.title);
      }
      image.loading = "lazy";
      image.dataset.index = String(index);
      fragment.appendChild(image);
    });

    root.appendChild(fragment);

    const viewer = new window.Viewer(root, {
      navbar: true,
      toolbar: true,
      tooltip: true,
      movable: true,
      zoomable: true,
      rotatable: true,
      scalable: true,
      transition: false,
      fullscreen: true,
      keyboard: true,
      initialViewIndex: Math.min(Math.max(startIndex || 0, 0), items.length - 1),
      url(image) {
        return image?.getAttribute?.("data-original") || image?.src || "";
      },
      title: [
        1,
        (image) => {
          const caption = image?.getAttribute?.("data-caption") || image?.alt || "";
          if (entry) {
            const metadata = extractMetadata(entry);
            const metaString = formatMetadata(metadata);
            if (metaString) {
              return caption ? `${caption} (${metaString})` : metaString;
            }
          }
          return caption;
        },
      ],
    });

    const hiddenHandler = () => this._teardown(true);
    viewer.element.addEventListener("hidden", hiddenHandler);

    this.instance = viewer;
    this.activeEntryId = entryId ?? null;
    this.hiddenHandler = hiddenHandler;
    this.cleanupFn = (fromHidden = false) => {
      if (this.instance) {
        this.instance.element.removeEventListener("hidden", hiddenHandler);
      }
      this.hiddenHandler = null;
      this.instance = null;
      this.activeEntryId = null;
      this._clearRoot();
      if (!fromHidden) {
        try {
          viewer.hide?.();
        } catch (error) {
          console.error("[PromptHistoryGallery]", "Viewer hide error", error);
        }
      }
      try {
        viewer.destroy();
      } catch (error) {
        console.error("[PromptHistoryGallery]", "Viewer destroy error", error);
      }
    };

    viewer.show();
  }

  close() {
    this._teardown(false);
  }

  dispose() {
    this._teardown(false);
    this.removeRoot();
  }

  isActive(entryId) {
    return !!this.instance && entryId != null && entryId === this.activeEntryId;
  }
}

export function createViewerBridge(options) {
  return new ViewerBridge(options);
}
