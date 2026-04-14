const DEFAULT_SERVER_PORT = 8080;
const DEFAULT_MDNS_HOSTNAME = "clipboard-share.local";
const LOCAL_HOSTS = new Set(["", "localhost", "127.0.0.1", "::1"]);

export function normalizeServerUrl(input, protocol = "ws") {
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

export function buildHttpUrlFromWebSocket(input) {
  const normalized = normalizeServerUrl(input);

  if (!normalized) {
    return "";
  }

  const parsed = new URL(normalized);
  parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
  parsed.pathname = "/discovery";

  return parsed.toString();
}

function buildWebSocketUrl(hostname, protocol = "ws", port = DEFAULT_SERVER_PORT) {
  const value = typeof hostname === "string" ? hostname.trim() : "";

  if (!value) {
    return "";
  }

  return normalizeServerUrl(`${protocol}://${value}:${port}`, protocol);
}

function appendAutomaticCandidates(candidates, seen, {
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

  addCandidate("localhost");
}

export function buildExtensionConnectionCandidates({
  manualValue = "",
  discoveryPayload = null,
  protocol = "ws",
  mdnsHostname = DEFAULT_MDNS_HOSTNAME
} = {}) {
  const candidates = [];
  const seen = new Set();

  if (manualValue) {
    const normalized = normalizeServerUrl(manualValue, protocol);

    if (normalized) {
      seen.add(normalized);
      candidates.push(normalized);
    }
  }

  appendAutomaticCandidates(candidates, seen, {
    discoveryPayload,
    protocol,
    mdnsHostname
  });

  return candidates;
}

export {
  DEFAULT_MDNS_HOSTNAME,
  DEFAULT_SERVER_PORT,
  LOCAL_HOSTS
};
