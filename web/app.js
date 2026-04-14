const discoveryApi = window.LanClipboardDiscovery || {};

const statusEl = document.getElementById("connectionStatus");
const textEl = document.getElementById("clipboardText");
const updatedAtEl = document.getElementById("updatedAt");
const serverHostEl = document.getElementById("serverHost");
const saveServerButtonEl = document.getElementById("saveServerButton");

const SERVER_HOST_STORAGE_KEY = "lanClipboardServerHost";
const DEFAULT_MDNS_HOSTNAME = discoveryApi.DEFAULT_MDNS_HOSTNAME || "clipboard-share.local";
const DISCOVERY_TIMEOUT_MS = 1500;
const RECONNECT_DELAY_MS = 1800;
const CONNECT_TIMEOUT_MS = 2500;
const MANUAL_INPUT_DEBOUNCE_MS = 420;

const normalizeServerUrl = discoveryApi.normalizeServerUrl || fallbackNormalizeServerUrl;
const buildConnectionCandidates = discoveryApi.buildConnectionCandidates || fallbackBuildConnectionCandidates;
const buildAutomaticConnectionCandidates = discoveryApi.buildAutomaticConnectionCandidates || fallbackBuildAutomaticConnectionCandidates;

let socket = null;
let isConnecting = false;
let queuedConnectOptions = null;
let reconnectTimer = null;
let inputTimer = null;
let shouldReconnect = true;
let reconnectMode = "auto";
let currentServerUrl = "";
let connectRunId = 0;

let lastRequestedManualHost = "";
let clipboardText = "";
let lastUpdatedAt = null;

function fallbackNormalizeServerUrl(host, protocol) {
  if (!host) return "";
  const trimmed = String(host).trim();
  if (!trimmed) return "";

  const rawValue = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `${protocol}://${trimmed}`;

  try {
    const parsed = new URL(rawValue);
    if (parsed.protocol === "http:") parsed.protocol = "ws:";
    if (parsed.protocol === "https:") parsed.protocol = "wss:";
    if (!parsed.port) parsed.port = "8080";
    parsed.pathname = "/";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch (error) {
    return "";
  }
}

function fallbackBuildConnectionCandidates({ manualValue = "", pageHostname = "", protocol = "ws", mdnsHostname = DEFAULT_MDNS_HOSTNAME }) {
  const candidates = [];
  if (manualValue) candidates.push(normalizeServerUrl(manualValue, protocol));
  candidates.push(normalizeServerUrl(mdnsHostname, protocol));
  if (pageHostname && pageHostname !== "localhost") {
    candidates.push(normalizeServerUrl(pageHostname, protocol));
  }
  return [...new Set(candidates.filter(Boolean))];
}

function fallbackBuildAutomaticConnectionCandidates({ pageHostname = "", protocol = "ws", mdnsHostname = DEFAULT_MDNS_HOSTNAME }) {
  return fallbackBuildConnectionCandidates({ pageHostname, protocol, mdnsHostname });
}

function getDefaultUrlProtocol() {
  return window.location.protocol === "https:" ? "wss" : "ws";
}

function getPreferredManualValue() {
  return window.localStorage.getItem(SERVER_HOST_STORAGE_KEY) || "";
}

function getInitialServerHost() {
  return getPreferredManualValue();
}

function getConnectionLabel(serverUrl) {
  try {
    return new URL(serverUrl).host;
  } catch (error) {
    return serverUrl;
  }
}

function setStatus(text, state = "idle") {
  statusEl.textContent = text;
  statusEl.dataset.state = state;
}

function setClipboardText(text, updatedAt) {
  clipboardText = text;
  lastUpdatedAt = updatedAt;
  textEl.value = text;
  updatedAtEl.textContent = updatedAt ? `Last synced ${new Date(updatedAt).toLocaleTimeString()}` : "";
}

function closeSocket() {
  if (!socket) return;

  const activeSocket = socket;
  socket = null;
  activeSocket.onopen = null;
  activeSocket.onmessage = null;
  activeSocket.onclose = null;
  activeSocket.onerror = null;

  if (activeSocket.readyState === WebSocket.OPEN || activeSocket.readyState === WebSocket.CONNECTING) {
    activeSocket.close();
  }
}

function clearReconnectTimer() {
  if (!reconnectTimer) return;
  window.clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function queueReconnect() {
  if (!shouldReconnect || reconnectTimer) return;

  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connect({ mode: reconnectMode });
  }, RECONNECT_DELAY_MS);
}

async function fetchDiscoveryPayload() {
  if (!window.location.protocol.startsWith("https")) {
    return null;
  }

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);

  try {
    const response = await window.fetch("/discovery", {
      cache: "no-store",
      signal: controller.signal
    });

    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    return null;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function isValidManualHost(value) {
  return Boolean(normalizeServerUrl(value, getDefaultUrlProtocol()));
}

function updateInputState() {
  const value = serverHostEl.value.trim();
  const state = value ? (isValidManualHost(value) ? "valid" : "invalid") : "empty";
  serverHostEl.dataset.state = state;
}

async function connect({ mode = "auto", preferredHost = getPreferredManualValue(), force = false } = {}) {
  if (isConnecting) {
    queuedConnectOptions = { mode, preferredHost, force };
    return;
  }

  isConnecting = true;
  const runId = ++connectRunId;
  clearReconnectTimer();

  let candidates;

  try {
    const discoveryPayload = await fetchDiscoveryPayload();
    const options = {
      pageHostname: window.location.hostname,
      discoveryPayload,
      protocol: getDefaultUrlProtocol(),
      mdnsHostname: discoveryPayload?.mdns?.hostname || DEFAULT_MDNS_HOSTNAME
    };

    candidates = mode === "manual" && preferredHost
      ? buildConnectionCandidates({ manualValue: preferredHost, ...options })
      : buildAutomaticConnectionCandidates(options);
  } finally {
    isConnecting = false;
  }

  if (queuedConnectOptions) {
    const nextOptions = queuedConnectOptions;
    queuedConnectOptions = null;
    connect(nextOptions);
    return;
  }

  if (runId !== connectRunId) {
    return;
  }

  if (!candidates || candidates.length === 0) {
    setStatus("No LAN clipboard server found yet.", "error");
    queueReconnect();
    return;
  }

  reconnectMode = mode;

  if (socket && !force && socket.readyState === WebSocket.OPEN && candidates.includes(currentServerUrl)) {
    setStatus(`Connected to ${getConnectionLabel(currentServerUrl)}`, "connected");
    return;
  }

  closeSocket();
  attemptConnection({
    candidates,
    index: 0,
    mode,
    runId
  });
}

function attemptConnection({ candidates, index, mode, runId }) {
  if (runId !== connectRunId) {
    return;
  }

  const serverUrl = candidates[index];

  if (!serverUrl) {
    setStatus("No reachable LAN clipboard host responded.", "error");
    queueReconnect();
    return;
  }

  const label = getConnectionLabel(serverUrl);
  let didOpen = false;
  let initialSyncReceived = false;
  let timeoutId = null;
  let localSocket = null;

  setStatus(`Connecting to ${label}…`, "connecting");

  try {
    localSocket = new WebSocket(serverUrl);
  } catch (error) {
    if (index + 1 < candidates.length) {
      attemptConnection({ candidates, index: index + 1, mode, runId });
      return;
    }

    setStatus(`Unable to connect to ${label}. Retrying in the background…`, "error");
    queueReconnect();
    return;
  }

  socket = localSocket;

  timeoutId = window.setTimeout(() => {
    if (didOpen || runId !== connectRunId || socket !== localSocket) {
      return;
    }

    setStatus(`Timed out on ${label}. Trying the next route…`, "connecting");
    localSocket.close();
  }, CONNECT_TIMEOUT_MS);

  localSocket.onopen = () => {
    if (runId !== connectRunId || socket !== localSocket) {
      localSocket.close();
      return;
    }

    didOpen = true;
    currentServerUrl = serverUrl;
    setStatus(`Connected to ${label}. Syncing latest clipboard…`, "connected");
  };

  localSocket.onmessage = (event) => {
    if (runId !== connectRunId || socket !== localSocket) {
      return;
    }

    let message;
    try {
      message = JSON.parse(event.data);
    } catch (error) {
      return;
    }

    if (message.type === "init" || message.type === "clipboard" || message.type === "ack") {
      initialSyncReceived = true;
      setClipboardText(message.text || "", message.updatedAt);
      setStatus(`Connected to ${label}`, "connected");
      return;
    }

    if (message.type === "error") {
      setStatus(`Server error: ${message.message}`, "error");
    }
  };

  localSocket.onerror = () => {
    if (runId !== connectRunId || socket !== localSocket) {
      return;
    }

    setStatus(`Connection issue on ${label}. Trying another route…`, "connecting");
  };

  localSocket.onclose = () => {
    if (timeoutId) {
      window.clearTimeout(timeoutId);
      timeoutId = null;
    }

    if (runId !== connectRunId || socket !== localSocket) {
      return;
    }

    socket = null;

    if (!shouldReconnect) {
      return;
    }

    if (!didOpen && index + 1 < candidates.length) {
      attemptConnection({ candidates, index: index + 1, mode, runId });
      return;
    }

    currentServerUrl = "";

    if (didOpen && !initialSyncReceived) {
      setStatus(`Connected, but initial sync was interrupted. Reconnecting…`, "connecting");
    } else {
      setStatus(`Disconnected. Reconnecting in the background…`, "connecting");
    }

    queueReconnect();
  };
}

function scheduleManualConnect() {
  const manualHost = serverHostEl.value.trim();
  updateInputState();
  clearReconnectTimer();

  if (inputTimer) {
    window.clearTimeout(inputTimer);
  }

  inputTimer = window.setTimeout(() => {
    const latestValue = serverHostEl.value.trim();

    if (!latestValue) {
      window.localStorage.removeItem(SERVER_HOST_STORAGE_KEY);
      lastRequestedManualHost = "";
      connect({ mode: "auto", force: true });
      return;
    }

    const normalizedHost = normalizeServerUrl(latestValue, getDefaultUrlProtocol());

    if (!normalizedHost) {
      setStatus("Keep typing a valid hostname, IP, or WebSocket URL.", "error");
      return;
    }

    if (latestValue === lastRequestedManualHost && currentServerUrl === normalizedHost && socket?.readyState === WebSocket.OPEN) {
      setStatus(`Connected to ${getConnectionLabel(normalizedHost)}`, "connected");
      return;
    }

    window.localStorage.setItem(SERVER_HOST_STORAGE_KEY, latestValue);
    lastRequestedManualHost = latestValue;
    connect({ mode: "manual", preferredHost: latestValue, force: true });
  }, MANUAL_INPUT_DEBOUNCE_MS);
}

function resetToAutomaticDiscovery() {
  serverHostEl.value = "";
  updateInputState();
  window.localStorage.removeItem(SERVER_HOST_STORAGE_KEY);
  lastRequestedManualHost = "";
  setStatus("Automatic LAN discovery enabled.", "connecting");
  connect({ mode: "auto", force: true });
}

document.getElementById("pushButton").addEventListener("click", () => {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    setStatus("Not connected to a LAN clipboard server.", "error");
    return;
  }

  socket.send(JSON.stringify({ type: "setClipboard", text: textEl.value }));
  setStatus("Shared to the LAN clipboard.", "connected");
});

document.getElementById("copyButton").addEventListener("click", async () => {
  try {
    const text = textEl.value;
    if (!text) return;
    await navigator.clipboard.writeText(text);
    setStatus("Copied to your local clipboard.", "connected");
  } catch (err) {
    console.error("Failed to copy: ", err);
    // Fallback for environments where navigator.clipboard might be restricted
    try {
      const textArea = document.createElement("textarea");
      textArea.value = textEl.value;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand("copy");
      document.body.removeChild(textArea);
      setStatus("Copied to your local clipboard (fallback).", "connected");
    } catch (fallbackErr) {
      console.error("Fallback copy failed: ", fallbackErr);
      setStatus("Copy failed. Please select and copy manually.", "error");
    }
  }
});

saveServerButtonEl.addEventListener("click", resetToAutomaticDiscovery);
serverHostEl.addEventListener("input", scheduleManualConnect);
serverHostEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    scheduleManualConnect();
  }
});

serverHostEl.value = getInitialServerHost();
lastRequestedManualHost = serverHostEl.value.trim();
updateInputState();
connect({
  mode: serverHostEl.value.trim() ? "manual" : "auto",
  preferredHost: serverHostEl.value.trim()
});