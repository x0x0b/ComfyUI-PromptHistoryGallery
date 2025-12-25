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

const OUTPUT_COLLECTION_KEYS = ["files", "images", "outputs"];

function lowerExtension(name) {
  if (typeof name !== "string") return "";
  const index = name.lastIndexOf(".");
  if (index === -1) return "";
  return name.slice(index).trim().toLowerCase();
}

function isLikelyImage(name) {
  return IMAGE_EXTENSIONS.has(lowerExtension(name));
}

function resolveUrl(api, params) {
  const search = new URLSearchParams(params);
  const path = `/view?${search.toString()}`;
  if (api?.fileURL) {
    try {
      return api.fileURL(path);
    } catch (_) {
      /* ignore and fall back */
    }
  }
  return path;
}

function normalizeDescriptor(candidate, { allowMissingExtension = false } = {}) {
  if (!candidate) return null;
  if (typeof candidate === "string") {
    const trimmed = candidate.trim();
    if (!trimmed) return null;
    if (!allowMissingExtension && !isLikelyImage(trimmed)) return null;
    return { filename: trimmed };
  }
  if (typeof candidate !== "object") return null;

  const filename = candidate.filename ?? candidate.name;
  if (!filename) return null;
  if (!allowMissingExtension && !isLikelyImage(filename)) return null;

  const record = {
    filename: String(filename),
  };

  const entryId = candidate.entry_id ?? candidate.entryId ?? candidate.source_entry_id;
  if (entryId) {
    record.entryId = String(entryId);
  }

  if (candidate.subfolder) {
    record.subfolder = String(candidate.subfolder);
  }

  const type = candidate.type ?? candidate.kind ?? (candidate.metadata && candidate.metadata.type);
  if (type) {
    record.type = String(type);
  }

  if (candidate.preview !== undefined) {
    record.preview = candidate.preview;
  }

  if (candidate.thumbnail ?? candidate.thumb ?? candidate.preview_url ?? candidate.url) {
    record.thumbnail =
      candidate.thumbnail ?? candidate.thumb ?? candidate.preview_url ?? candidate.url;
  }

  if (
    candidate.title ??
    candidate.label ??
    candidate.caption ??
    candidate.prompt ??
    candidate.name
  ) {
    record.title =
      candidate.title ?? candidate.label ?? candidate.caption ?? candidate.prompt ?? candidate.name;
  }

  return record;
}

function appendFromCollection(result, seen, collection, { allowMissingExtension = false } = {}) {
  if (!Array.isArray(collection)) return;
  for (const item of collection) {
    const descriptor = normalizeDescriptor(item, {
      allowMissingExtension,
    });
    if (!descriptor) continue;

  const params = {
    filename: descriptor.filename,
    type: descriptor.type ? String(descriptor.type) : "output",
  };
    if (descriptor.subfolder) {
      params.subfolder = descriptor.subfolder;
    }
    if (descriptor.preview !== undefined) {
      params.preview = String(descriptor.preview);
    }

    const rawUrl = resolveUrl(null, params);
    const key = rawUrl;
    if (seen.has(key)) continue;
    seen.add(key);

  result.push({
    params,
    title: descriptor.title ? String(descriptor.title) : descriptor.filename,
    thumbHint: descriptor.thumbnail ?? null,
    entryId: descriptor.entryId ?? null,
  });
}
}

function collectMetadataCollections(entry) {
  const collections = [];
  const metadata = entry?.metadata;
  if (!metadata || typeof metadata !== "object") {
    return collections;
  }

  for (const key of OUTPUT_COLLECTION_KEYS) {
    const value = metadata[key];
    if (Array.isArray(value)) {
      collections.push(value);
    } else if (value && typeof value === "object") {
      collections.push(...Object.values(value).filter(Array.isArray));
    }
  }

  return collections;
}

export function buildImageSources(entry, api) {
  const result = [];
  const seen = new Set();
  const collections = [
    { items: Array.isArray(entry?.files) ? entry.files : null, allowMissingExtension: false },
    ...collectMetadataCollections(entry).map((items) => ({
      items,
      allowMissingExtension: true,
    })),
  ];

  for (const { items, allowMissingExtension } of collections) {
    if (!items) continue;
    appendFromCollection(result, seen, items, { allowMissingExtension });
  }

  return result.map((item) => {
    const url = resolveUrl(api, item.params);
    let thumb = resolveUrl(api, item.params);
    if (item.thumbHint) {
      const hint = String(item.thumbHint);
      if (hint.startsWith("/view?")) {
        const searchParams = new URLSearchParams(hint.slice(hint.indexOf("?") + 1));
        thumb = resolveUrl(api, Object.fromEntries(searchParams.entries()));
      } else {
        thumb = hint;
      }
    }
    return {
      url,
      thumb,
      title: item.title,
      entryId: item.entryId ?? null,
    };
  });
}
