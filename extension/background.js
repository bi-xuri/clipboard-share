import {
  DEFAULT_MDNS_HOSTNAME,
  DEFAULT_SERVER_PORT,
  buildExtensionConnectionCandidates,
  buildHttpUrlFromWebSocket,
  normalizeServerUrl
} from "./discovery.mjs";

const OFFSCREEN_PATH = "offscreen.html";
const POLL_ALARM = "clipboard-poll";
const MANUAL_SERVER_STORAGE_KEY = "manualServerUrl";

let socket = null;
let reconnectTimer = null;
let currentServerUrl = "";
let manualServerUrl = "";
let latestServerText = "";
let latestUpdatedAt = "";
let lastPushedText = "";
let lastClipboardRead = "";
let reconnectMode = "auto";
let reconnectAttemptUrl = "";
let isConnecting = false;
let queuedConnectMode = null;

async function ensureOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)]
  });

  if (existingContexts.length > 0) {
    return;
  }

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["CLIPBOARD"],
    justification: "Read and write clipboard text for LAN sync."
  });
}

async function callOffscreen(action, text) {
  await ensureOffscreenDocument();
  return chrome.runtime.sendMessage({
    target: "offscreen",
    action,
    text
  });
}

function scheduleReconnect(delayMs = 2000) {
  if (reconnectTimer) {
    return;
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectSocket({ mode: reconnectMode });
  }, delayMs);
}

function saveState() {
  return chrome.storage.local.set({
    latestServerText,
    latestUpdatedAt
  });
}

async function pushClipboardToServer(text) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return { ok: false, reason: "disconnected" };
  }

  socket.send(
    JSON.stringify({
      type: "setClipboard",
      text
    })
  );

  lastPushedText = text;
  latestServerText = text;
  latestUpdatedAt = new Date().toISOString();
  await saveState();

  return { ok: true };
}

async function writeClipboardFromServer(text) {
  try {
    await callOffscreen("writeClipboard", text);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function syncFromLocalClipboard() {
  try {
    const result = await callOffscreen("readClipboard");
    const text = typeof result?.text === "string" ? result.text : "";

    if (text === lastClipboardRead || text === latestServerText) {
      lastClipboardRead = text;
      return { ok: true, skipped: true, text };
    }

    lastClipboardRead = text;
    return pushClipboardToServer(text);
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function getPreferredManualValue() {
  return manualServerUrl.trim();
}

async function fetchDiscoveryPayload(seedCandidates) {
  for (const candidate of seedCandidates) {
    const discoveryUrl = buildHttpUrlFromWebSocket(candidate);

    if (!discoveryUrl) {
      continue;
    }

    try {
      const response = await fetch(discoveryUrl, { cache: "no-store" });

      if (response.ok) {
        return await response.json();
      }
    } catch (error) {
      continue;
    }
  }

  return null;
}

async function loadServerPreference() {
  const stored = await chrome.storage.local.get([MANUAL_SERVER_STORAGE_KEY, "serverUrl"]);
  manualServerUrl = String(stored[MANUAL_SERVER_STORAGE_KEY] || stored.serverUrl || "").trim();
  await chrome.storage.local.set({
    [MANUAL_SERVER_STORAGE_KEY]: manualServerUrl
  });
}

async function updateServerUrl(serverUrl) {
  manualServerUrl = String(serverUrl || "").trim();
  await chrome.storage.local.set({
    [MANUAL_SERVER_STORAGE_KEY]: manualServerUrl,
    connectionStatus: "reconnecting"
  });

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (socket) {
    socket.close();
    socket = null;
  }

  connectSocket({ mode: manualServerUrl ? "manual" : "auto" });
  return { ok: true, serverUrl: manualServerUrl };
}

async function connectSocket({ mode = "auto" } = {}) {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  if (isConnecting) {
    queuedConnectMode = mode;
    return;
  }

  isConnecting = true;

  let candidates = [];

  try {
    const seedCandidates = [
      normalizeServerUrl(getPreferredManualValue()),
      normalizeServerUrl(DEFAULT_MDNS_HOSTNAME),
      normalizeServerUrl(`localhost:${DEFAULT_SERVER_PORT}`)
    ].filter(Boolean);

    const discoveryPayload = await fetchDiscoveryPayload(seedCandidates);
    candidates = buildExtensionConnectionCandidates({
      manualValue: mode === "manual" ? getPreferredManualValue() : "",
      discoveryPayload,
      protocol: "ws",
      mdnsHostname: discoveryPayload?.mdns?.hostname || DEFAULT_MDNS_HOSTNAME
    });
  } finally {
    isConnecting = false;
  }

  if (queuedConnectMode) {
    const nextMode = queuedConnectMode;
    queuedConnectMode = null;
    connectSocket({ mode: nextMode });
    return;
  }

  if (candidates.length === 0) {
    await chrome.storage.local.set({
      connectionStatus: "disconnected",
      currentServerUrl: "",
      resolvedServerUrl: ""
    });
    scheduleReconnect();
    return;
  }

  reconnectMode = mode;
  attemptConnection(candidates, 0, mode);
}

function attemptConnection(candidates, index, mode) {
  const serverUrl = candidates[index];
  let didOpen = false;

  reconnectAttemptUrl = serverUrl;
  currentServerUrl = serverUrl;
  chrome.storage.local.set({
    connectionStatus: "connecting",
    currentServerUrl: manualServerUrl,
    resolvedServerUrl: serverUrl
  });

  try {
    socket = new WebSocket(serverUrl);
  } catch (error) {
    socket = null;

    if (index + 1 < candidates.length) {
      attemptConnection(candidates, index + 1, mode);
      return;
    }

    chrome.storage.local.set({ connectionStatus: "error" });
    scheduleReconnect();
    return;
  }

  socket.addEventListener("open", async () => {
    didOpen = true;
    await chrome.storage.local.set({ connectionStatus: "connected" });
    await syncFromLocalClipboard();
  });

  socket.addEventListener("message", async (event) => {
    let message;

    try {
      message = JSON.parse(event.data);
    } catch (error) {
      return;
    }

    if (message.type === "init" || message.type === "clipboard" || message.type === "ack") {
      latestServerText = typeof message.text === "string" ? message.text : "";
      latestUpdatedAt = message.updatedAt || new Date().toISOString();
      await saveState();

      if (latestServerText !== lastPushedText) {
        await writeClipboardFromServer(latestServerText);
      }
    }
  });

  socket.addEventListener("close", async () => {
    await chrome.storage.local.set({ connectionStatus: "disconnected" });
    socket = null;

    if (!didOpen && index + 1 < candidates.length) {
      attemptConnection(candidates, index + 1, mode);
      return;
    }

    scheduleReconnect();
  });

  socket.addEventListener("error", async () => {
    await chrome.storage.local.set({ connectionStatus: "error" });
    socket.close();
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  await loadServerPreference();
  await chrome.storage.local.set({
    connectionStatus: "starting",
    latestServerText: "",
    latestUpdatedAt: ""
  });
  await chrome.alarms.create(POLL_ALARM, { periodInMinutes: 0.5 });
  connectSocket({ mode: manualServerUrl ? "manual" : "auto" });
});

chrome.runtime.onStartup.addListener(async () => {
  await loadServerPreference();
  await chrome.alarms.create(POLL_ALARM, { periodInMinutes: 0.5 });
  connectSocket({ mode: manualServerUrl ? "manual" : "auto" });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) {
    connectSocket({ mode: reconnectMode });
    syncFromLocalClipboard();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "background") {
    return false;
  }

  (async () => {
    if (message.action === "getState") {
      const stored = await chrome.storage.local.get([
        "connectionStatus",
        "latestServerText",
        "latestUpdatedAt",
        MANUAL_SERVER_STORAGE_KEY,
        "resolvedServerUrl"
      ]);

      sendResponse({
        ok: true,
        connectionStatus: stored.connectionStatus || "unknown",
        latestServerText: stored.latestServerText || "",
        latestUpdatedAt: stored.latestUpdatedAt || "",
        currentServerUrl: stored[MANUAL_SERVER_STORAGE_KEY] || "",
        resolvedServerUrl: stored.resolvedServerUrl || currentServerUrl
      });
      return;
    }

    if (message.action === "pushText") {
      const text = typeof message.text === "string" ? message.text : "";
      const result = await pushClipboardToServer(text);

      if (result.ok) {
        await callOffscreen("writeClipboard", text);
      }

      sendResponse(result);
      return;
    }

    if (message.action === "updateServerUrl") {
      const result = await updateServerUrl(message.url);
      sendResponse(result);
      return;
    }

    if (message.action === "pullToClipboard") {
      const result = await writeClipboardFromServer(latestServerText);
      sendResponse({
        ...result,
        text: latestServerText,
        updatedAt: latestUpdatedAt
      });
      return;
    }

    if (message.action === "syncFromClipboard") {
      const result = await syncFromLocalClipboard();
      sendResponse(result);
      return;
    }

    sendResponse({ ok: false, error: "Unknown action" });
  })();

  return true;
});

(async () => {
  await loadServerPreference();
  connectSocket({ mode: manualServerUrl ? "manual" : "auto" });
})();
