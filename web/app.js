const statusEl = document.getElementById("connectionStatus");
const textEl = document.getElementById("clipboardText");
const updatedAtEl = document.getElementById("updatedAt");
const serverHostEl = document.getElementById("serverHost");
const saveServerButtonEl = document.getElementById("saveServerButton");

const SERVER_HOST_STORAGE_KEY = "lanClipboardServerHost";
const DISCOVERY_TIMEOUT_MS = 1500;

const {
  DEFAULT_MDNS_HOSTNAME,
  buildAutomaticConnectionCandidates,
  buildConnectionCandidates,
  normalizeServerUrl
} = window.LanClipboardDiscovery;

let socket;
let reconnectTimer = null;
let shouldReconnect = true;
let currentServerUrl = "";
let reconnectAttemptUrl = "";
let isConnecting = false;
let reconnectMode = "auto";
let queuedConnectMode = null;

function setStatus(text) {
  statusEl.textContent = text;
}

function setClipboardText(text, updatedAt) {
  textEl.value = text;
  updatedAtEl.textContent = updatedAt
    ? `Last update: ${new Date(updatedAt).toLocaleString()}`
    : "Last update: none";
}

function getInitialServerHost() {
  return window.localStorage.getItem(SERVER_HOST_STORAGE_KEY) || "";
}

function getPreferredManualValue() {
  return serverHostEl.value.trim() || window.localStorage.getItem(SERVER_HOST_STORAGE_KEY) || "";
}

async function fetchDiscoveryPayload() {
  if (!/^https?:$/.test(window.location.protocol)) {
    return null;
  }

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);

  try {
    const response = await window.fetch("/discovery", {
      cache: "no-store",
      signal: controller.signal
    });

    if (!response.ok) {
      return null;
    }

    return await response.json();
  } catch (error) {
    return null;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function getDefaultUrlProtocol() {
  return window.location.protocol === "https:" ? "wss" : "ws";
}

function queueReconnect() {
  if (!shouldReconnect || reconnectTimer) {
    return;
  }

  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connect({ mode: reconnectMode });
  }, 2000);
}

async function connect({ mode = "auto" } = {}) {
  if (isConnecting) {
    queuedConnectMode = mode;
    return;
  }

  isConnecting = true;
  let candidates;

  try {
    const discoveryPayload = await fetchDiscoveryPayload();
    const options = {
      pageHostname: window.location.hostname,
      discoveryPayload,
      protocol: getDefaultUrlProtocol(),
      mdnsHostname: discoveryPayload?.mdns?.hostname || DEFAULT_MDNS_HOSTNAME
    };

    candidates = mode === "manual"
      ? buildConnectionCandidates({
        manualValue: getPreferredManualValue(),
        ...options
      })
      : buildAutomaticConnectionCandidates(options);
  } finally {
    isConnecting = false;
  }

  if (queuedConnectMode) {
    const nextMode = queuedConnectMode;
    queuedConnectMode = null;
    connect({ mode: nextMode });
    return;
  }

  if (candidates.length === 0) {
    setStatus("Auto-discovery found no server. Enter a WebSocket URL, host, or .local name to connect manually.");
    return;
  }

  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  reconnectMode = mode;
  attemptConnection(candidates, 0, mode);
}

function attemptConnection(candidates, index, mode) {
  const serverUrl = candidates[index];
  let didOpen = false;
  const attemptLabel = mode === "manual" ? "manual fallback" : "auto-discovery";

  reconnectAttemptUrl = serverUrl;
  setStatus(`Using ${attemptLabel}: connecting to ${serverUrl}`);

  try {
    socket = new WebSocket(serverUrl);
  } catch (error) {
    socket = null;

    if (index + 1 < candidates.length) {
      setStatus(`Unable to open ${serverUrl}. Trying ${candidates[index + 1]}...`);
      attemptConnection(candidates, index + 1, mode);
      return;
    }

    const fallbackHint = mode === "manual"
      ? "Check the URL and try again."
      : "Enter a WebSocket URL manually if mDNS cannot resolve.";
    setStatus(`Unable to open ${serverUrl}. ${fallbackHint}`);
    queueReconnect();
    return;
  }

  socket.addEventListener("open", () => {
    didOpen = true;
    currentServerUrl = serverUrl;
    reconnectAttemptUrl = "";
    setStatus(`Connected to ${serverUrl} via ${attemptLabel}`);
  });

  socket.addEventListener("message", (event) => {
    let message;

    try {
      message = JSON.parse(event.data);
    } catch (error) {
      setStatus("Received invalid message from server");
      return;
    }

    if (message.type === "init" || message.type === "clipboard" || message.type === "ack") {
      setClipboardText(message.text || "", message.updatedAt);
      return;
    }

    if (message.type === "error" && message.message) {
      setStatus(`Server error: ${message.message}`);
    }
  });

  socket.addEventListener("close", () => {
    socket = null;

    if (!shouldReconnect) {
      return;
    }

    if (!didOpen && index + 1 < candidates.length) {
      setStatus(`Unable to reach ${serverUrl}. Trying ${candidates[index + 1]}...`);
      attemptConnection(candidates, index + 1, mode);
      return;
    }

    const disconnectedUrl = reconnectAttemptUrl || currentServerUrl;
    if (!didOpen) {
      const retryMessage = mode === "manual"
        ? `Manual connection failed for ${disconnectedUrl || serverUrl}. Retrying...`
        : `Auto-discovery could not reach ${disconnectedUrl || serverUrl}. Retrying clipboard-share.local:8080 and LAN fallbacks...`;
      setStatus(retryMessage);
    } else {
      setStatus(disconnectedUrl ? `Disconnected from ${disconnectedUrl}. Retrying...` : "Disconnected. Retrying...");
    }
    queueReconnect();
  });

  socket.addEventListener("error", () => {
    setStatus(`Connection error${serverUrl ? ` (${serverUrl})` : ""}`);
    socket.close();
  });
}

function saveServerHost() {
  const host = serverHostEl.value.trim();
  const normalizedHost = normalizeServerUrl(host, getDefaultUrlProtocol());

  if (host && !normalizedHost) {
    setStatus("Enter a valid host, IP, http(s) URL, or ws(s) URL");
    return;
  }

  if (!host) {
    window.localStorage.removeItem(SERVER_HOST_STORAGE_KEY);
    queuedConnectMode = null;
    setStatus("Manual fallback cleared. Auto-discovery will keep trying the server's .local name and LAN endpoints.");

    shouldReconnect = false;

    if (reconnectTimer) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    if (socket) {
      socket.close();
      socket = null;
    }

    shouldReconnect = true;
    connect({ mode: "auto" });
    return;
  }

  window.localStorage.setItem(SERVER_HOST_STORAGE_KEY, host);

  shouldReconnect = false;

  if (reconnectTimer) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (socket) {
    socket.close();
    socket = null;
  }

  shouldReconnect = true;
  connect({ mode: "manual" });
}

document.getElementById("pushButton").addEventListener("click", () => {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    setStatus("Server is not connected");
    return;
  }

  socket.send(
    JSON.stringify({
      type: "setClipboard",
      text: textEl.value
    })
  );
  setStatus(`Shared clipboard updated via ${currentServerUrl || reconnectAttemptUrl}`);
});

document.getElementById("copyButton").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(textEl.value);
    setStatus("Copied current text to local clipboard");
  } catch (error) {
    setStatus("Clipboard write failed");
  }
});

saveServerButtonEl.addEventListener("click", saveServerHost);

serverHostEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    saveServerHost();
  }
});

serverHostEl.value = getInitialServerHost();
setStatus(`Auto-discovery will try Bonjour at ${DEFAULT_MDNS_HOSTNAME} before falling back to LAN addresses.`);
connect({ mode: "auto" });
