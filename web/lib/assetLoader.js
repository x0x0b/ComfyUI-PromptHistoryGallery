export class AssetLoader {
  constructor(attributeName = "data-phg-asset") {
    this.attributeName = attributeName;
    this.datasetKey = this._deriveDatasetKey(attributeName);
    this.promises = new Map();
  }

  _deriveDatasetKey(attributeName) {
    if (!attributeName.startsWith("data-")) {
      return attributeName;
    }
    const raw = attributeName.slice(5);
    return raw.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
  }

  _getExistingNode(tagName, url) {
    const selector = `${tagName}[${this.attributeName}="${url}"]`;
    const existing = document.head.querySelector(selector);
    if (existing) {
      return existing;
    }

    const collection =
      tagName === "link"
        ? document.head.querySelectorAll('link[rel="stylesheet"]')
        : document.head.querySelectorAll("script");

    return Array.from(collection).find((node) => node?.dataset?.[this.datasetKey] === url);
  }

  _registerPromise(key, creator) {
    if (this.promises.has(key)) {
      return this.promises.get(key);
    }
    const promise = creator();
    this.promises.set(key, promise);
    return promise;
  }

  ensureStyle(href) {
    if (!href) {
      return Promise.reject(new Error("Stylesheet URL is required"));
    }
    const key = `style:${href}`;
    return this._registerPromise(key, () => {
      const existing = this._getExistingNode("link", href);
      if (existing) {
        return Promise.resolve(existing);
      }
      return new Promise((resolve, reject) => {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = href;
        link.setAttribute(this.attributeName, href);
        if (this.datasetKey) {
          link.dataset[this.datasetKey] = href;
        }
        link.addEventListener("load", () => resolve(link));
        link.addEventListener("error", () =>
          reject(new Error(`Failed to load stylesheet: ${href}`))
        );
        document.head.appendChild(link);
      });
    });
  }

  ensureScript(src) {
    if (!src) {
      return Promise.reject(new Error("Script URL is required"));
    }
    const key = `script:${src}`;
    return this._registerPromise(key, () => {
      const existing = this._getExistingNode("script", src);
      if (existing) {
        if (existing.dataset.phgLoaded === "true") {
          return Promise.resolve(existing);
        }
        return new Promise((resolve, reject) => {
          existing.addEventListener("load", () => resolve(existing));
          existing.addEventListener("error", () =>
            reject(new Error(`Failed to load script: ${src}`))
          );
        });
      }
      return new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = src;
        script.async = true;
        script.defer = false;
        script.setAttribute(this.attributeName, src);
        if (this.datasetKey) {
          script.dataset[this.datasetKey] = src;
        }
        script.dataset.phgLoaded = "false";
        script.addEventListener("load", () => {
          script.dataset.phgLoaded = "true";
          resolve(script);
        });
        script.addEventListener("error", () => reject(new Error(`Failed to load script: ${src}`)));
        document.head.appendChild(script);
      });
    });
  }

  async ensureAssets({ styles = [], scripts = [] } = {}) {
    const tasks = [];
    for (const href of styles) {
      tasks.push(this.ensureStyle(href));
    }
    for (const src of scripts) {
      tasks.push(this.ensureScript(src));
    }
    await Promise.all(tasks);
  }
}

export function createAssetLoader(attributeName) {
  return new AssetLoader(attributeName);
}
