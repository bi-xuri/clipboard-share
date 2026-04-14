(function createLanClipboardDiscovery(root, factory) {
  const api = factory();

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  root.LanClipboardDiscovery = api;
})(typeof globalThis !== "undefined" ? globalThis : window, () => {
  const DEFAULT_SERVER_PORT = 8080;
  const DEFAULT_MDNS_HOSTNAME = "clipboard-share.local";
  const LOCAL_HOSTS = new Set(["", "localhost", "127.0.0.1", "::1"]);

  function normalizeServerUrl(input, protocol = "ws") {
    const trimmed = typeof input === "string" ? input.trim() : "";

    if (!trimmed) {
      return "";
    }

    const hasProtocol = /^[a-z]+:\/\//i.test(trimmed);
    const rawUrl = hasProtocol ? trimmed : `${protocol}://${trimmed}`;

    let parsed;

    try {
      parsed = new URL(rawUrl);
    } catch (error) {
      return "";
    }

    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
    }

    if (!parsed.port) {
      parsed.port = String(DEFAULT_SERVER_PORT);
    }

    parsed.pathname = "/";
    parsed.search = "";
    parsed.hash = "";

    return parsed.toString().replace(/\/$/, "");
  }

  function buildWebSocketUrl(hostname, protocol = "ws", port = DEFAULT_SERVER_PORT) {
    const value = typeof hostname === "string" ? hostname.trim() : "";

    if (!value) {
      return "";
    }

    return normalizeServerUrl(`${protocol}://${value}:${port}`, protocol);
  }

  function appendAutomaticConnectionCandidates(candidates, seen, {
    pageHostname = "",
    discoveryPayload = null,
    protocol = "ws",
    mdnsHostname = DEFAULT_MDNS_HOSTNAME
  }) {
    function addCandidate(value) {
      const normalized = normalizeServerUrl(value, protocol);

      if (!normalized || seen.has(normalized)) {
        return;
      }

      seen.add(normalized);
      candidates.push(normalized);
    }

    if (discoveryPayload?.mdns?.websocketUrls) {
      for (const url of discoveryPayload.mdns.websocketUrls) {
        addCandidate(url);
      }
    }

    addCandidate(mdnsHostname);

    if (pageHostname && !LOCAL_HOSTS.has(pageHostname)) {
      addCandidate(pageHostname);
    }

    if (discoveryPayload?.websocket?.urls) {
      for (const url of discoveryPayload.websocket.urls) {
        addCandidate(url);
      }
    }

    if (discoveryPayload?.interfaces) {
      for (const address of discoveryPayload.interfaces) {
        addCandidate(buildWebSocketUrl(address, protocol));
      }
    }
  }

  function buildAutomaticConnectionCandidates(options = {}) {
    const candidates = [];
    const seen = new Set();

    appendAutomaticConnectionCandidates(candidates, seen, options);

    return candidates;
  }

  function buildConnectionCandidates({
    manualValue = "",
    ...options
  } = {}) {
    const candidates = [];
    const seen = new Set();

    if (manualValue) {
      const normalized = normalizeServerUrl(manualValue, options.protocol || "ws");

      if (normalized) {
        seen.add(normalized);
        candidates.push(normalized);
      }
    }

    appendAutomaticConnectionCandidates(candidates, seen, options);

    return candidates;
  }

  return {
    DEFAULT_MDNS_HOSTNAME,
    DEFAULT_SERVER_PORT,
    LOCAL_HOSTS,
    buildAutomaticConnectionCandidates,
    buildConnectionCandidates,
    buildWebSocketUrl,
    normalizeServerUrl
  };
});
