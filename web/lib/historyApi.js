const DEFAULT_LIMIT = 50;

function resolveFetcher(api) {
  if (api && typeof api.fetchApi === "function") {
    return (path, options = {}) => api.fetchApi(path, options);
  }
  return (path, options = {}) => fetch(path, options);
}

export function createHistoryApi(api) {
  const fetcher = resolveFetcher(api);

  const handleResponse = async (response) => {
    if (response.ok) {
      return response;
    }
    const message = await extractErrorMessage(response);
    throw new Error(message || `Request failed (${response.status})`);
  };

  const extractErrorMessage = async (response) => {
    try {
      const data = await response.json();
      if (data && typeof data.message === "string") {
        return data.message;
      }
    } catch (_) {
      /* swallow JSON failures */
    }
    return response.statusText;
  };

  const request = async (path, { parseJson = false, ...options } = {}) => {
    const handled = await handleResponse(await fetcher(path, options));
    return parseJson ? handled.json() : handled;
  };

  return {
    async list(limit = DEFAULT_LIMIT) {
      const safeLimit = Math.max(1, Math.min(Number(limit) || DEFAULT_LIMIT, 200));
      const payload = await request(`/prompt-history?limit=${safeLimit}`, {
        method: "GET",
        parseJson: true,
      });
      const entries = Array.isArray(payload?.entries) ? payload.entries : [];
      return entries;
    },

    async remove(entryId) {
      if (!entryId) {
        throw new Error("Entry id is required.");
      }
      await request(`/prompt-history/${entryId}`, {
        method: "DELETE",
      });
    },

    async clear() {
      await request("/prompt-history", {
        method: "DELETE",
      });
    },
  };
}
