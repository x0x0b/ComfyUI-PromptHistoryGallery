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

  return {
    async list(limit = DEFAULT_LIMIT) {
      const safeLimit = Math.max(1, Math.min(Number(limit) || DEFAULT_LIMIT, 200));
      const response = await fetcher(`/prompt-history?limit=${safeLimit}`, {
        method: "GET",
      });
      const handled = await handleResponse(response);
      const payload = await handled.json();
      const entries = Array.isArray(payload?.entries) ? payload.entries : [];
      return entries;
    },

    async remove(entryId) {
      if (!entryId) {
        throw new Error("Entry id is required.");
      }
      const response = await fetcher(`/prompt-history/${entryId}`, {
        method: "DELETE",
      });
      await handleResponse(response);
    },

    async clear() {
      const response = await fetcher("/prompt-history", {
        method: "DELETE",
      });
      await handleResponse(response);
    },
  };
}
