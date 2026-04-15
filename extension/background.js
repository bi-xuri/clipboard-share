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
let latestFiles = [];
let lastPushedText = "";
let lastClipboardRead = "";
let reconnectMode = "auto";
let reconnectAttemptUrl = "";
let isConnecting = false;
let queuedConnectMode = null;
let fileRouteConfig = {
  listEndpoint: "/files",
  pathPrefix: "/files/",
  upload: {
    endpoint: "/upload",
    method: "POST",
    fieldName: "file"
  }
};
const pendingDownloadRequests = new Map();
let pendingFileListRequest = null;

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
    latestUpdatedAt,
    latestFiles,
    fileRouteConfig
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

function applyFileConfig(config) {
  if (!config || typeof config !== "object") {
    return;
  }

  fileRouteConfig = {
    ...fileRouteConfig,
    ...config,
    upload: {
      ...fileRouteConfig.upload,
      ...(config.upload || {})
    }
  };
}

function getIncomingFileConfig(message) {
  if (!message || typeof message !== "object") {
    return null;
  }

  return message.fileConfig || message.config || message.files || null;
}

function normalizeFileRecord(file) {
  if (!file || typeof file.name !== "string") {
    return null;
  }

  const pathPrefix = typeof fileRouteConfig.pathPrefix === "string" && fileRouteConfig.pathPrefix
    ? fileRouteConfig.pathPrefix
    : "/files/";

  return {
    name: file.name,
    size: Number(file.size) || 0,
    type: file.type || "application/octet-stream",
    uploadTime: file.uploadTime || null,
    url: typeof file.url === "string" && file.url
      ? file.url
      : `${pathPrefix}${encodeURIComponent(file.name)}`
  };
}

function sortFiles(files) {
  return [...files].sort((left, right) => {
    const leftTime = left.uploadTime ? new Date(left.uploadTime).getTime() : 0;
    const rightTime = right.uploadTime ? new Date(right.uploadTime).getTime() : 0;
    return rightTime - leftTime;
  });
}

function setFileList(files) {
  latestFiles = sortFiles(
    (Array.isArray(files) ? files : [])
      .map(normalizeFileRecord)
      .filter(Boolean)
  );
}

function mergeFileRecord(file) {
  const normalized = normalizeFileRecord(file);

  if (!normalized) {
    return;
  }

  latestFiles = sortFiles([
    ...latestFiles.filter((entry) => entry.name !== normalized.name),
    normalized
  ]);
}

function buildHttpUrl(pathname = "/") {
  const normalized = normalizeServerUrl(reconnectAttemptUrl || currentServerUrl || manualServerUrl);

  if (!normalized) {
    return "";
  }

  try {
    const parsed = new URL(normalized);
    parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
    parsed.pathname = pathname.startsWith("/") ? pathname : `/${pathname}`;
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch (error) {
    return "";
  }
}

async function startDownload(downloadPath, fileName) {
  const url = /^https?:\/\//i.test(downloadPath || "")
    ? downloadPath
    : buildHttpUrl(downloadPath || "");

  if (!url) {
    return { ok: false, error: "No reachable file download endpoint is available yet." };
  }

  try {
    const downloadId = await chrome.downloads.download({
      url,
      filename: fileName || undefined,
      saveAs: true
    });

    return { ok: true, downloadId, url };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function requestAvailableFiles() {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return Promise.resolve({ ok: false, reason: "disconnected", files: latestFiles });
  }

  if (pendingFileListRequest) {
    return pendingFileListRequest.promise;
  }

  let resolvePromise = null;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });

  const timeoutId = setTimeout(() => {
    pendingFileListRequest = null;
    resolvePromise({ ok: false, error: "Timed out waiting for the server file list.", files: latestFiles });
  }, 5000);

  pendingFileListRequest = {
    promise,
    resolve(result) {
      clearTimeout(timeoutId);
      pendingFileListRequest = null;
      resolvePromise(result);
    }
  };

  socket.send(JSON.stringify({ type: "fileList" }));
  return promise;
}

function requestFileDownload(fileName) {
  const existingFile = latestFiles.find((file) => file.name === fileName);

  if (!socket || socket.readyState !== WebSocket.OPEN) {
    if (existingFile?.url) {
      return startDownload(existingFile.url, existingFile.name);
    }

    return Promise.resolve({ ok: false, error: "Connect to a LAN clipboard server before downloading files." });
  }

  if (pendingDownloadRequests.has(fileName)) {
    return pendingDownloadRequests.get(fileName).promise;
  }

  let resolvePromise = null;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });

  const timeoutId = setTimeout(() => {
    pendingDownloadRequests.delete(fileName);

    if (existingFile?.url) {
      startDownload(existingFile.url, existingFile.name).then(resolvePromise);
      return;
    }

    resolvePromise({ ok: false, error: "The server did not provide a file download URL." });
  }, 5000);

  pendingDownloadRequests.set(fileName, {
    promise,
    async resolve(result) {
      clearTimeout(timeoutId);
      pendingDownloadRequests.delete(fileName);
      resolvePromise(result);
    }
  });

  socket.send(JSON.stringify({ type: "fileDownload", name: fileName }));
  return promise;
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
      const response = await fetch(discoveryUrl, {
        cache: "no-store"
      });

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

  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
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

    const fallbackHint = mode === "manual"
      ? "Check the URL and try again."
      : "Enter a WebSocket URL manually if mDNS cannot resolve.";
    chrome.storage.local.set({ connectionStatus: "error" });
    setStatusWithStorage(`Unable to open ${serverUrl}. ${fallbackHint}`);
    scheduleReconnect();
    return;
  }

  socket.addEventListener("open", async () => {
    didOpen = true;
    await chrome.storage.local.set({ connectionStatus: "connected" });
    await syncFromLocalClipboard();
    requestAvailableFiles();
  });

  socket.addEventListener("message", async (event) => {
    let message;

    try {
      message = JSON.parse(event.data);
    } catch (error) {
      return;
    }

    if (message.type === "init" || message.type === "clipboard" || message.type === "ack") {
      applyFileConfig(getIncomingFileConfig(message));
      latestServerText = typeof message.text === "string" ? message.text : "";
      latestUpdatedAt = message.updatedAt || new Date().toISOString();
      await saveState();

      if (latestServerText !== lastPushedText) {
        await writeClipboardFromServer(latestServerText);
      }

      return;
    }

    if (message.type === "fileList") {
      applyFileConfig(getIncomingFileConfig(message));
      setFileList(message.files);
      await saveState();
      pendingFileListRequest?.resolve({ ok: true, files: latestFiles });
      return;
    }

    if (message.type === "fileUpload") {
      applyFileConfig(getIncomingFileConfig(message));

      if (message.file) {
        mergeFileRecord(message.file);
        await saveState();
      }

      return;
    }

    if (message.type === "fileDownload") {
      applyFileConfig(getIncomingFileConfig(message));

      const fileName = message.file?.name || message.name;
      const downloadPath = message.file?.url || message.url;
      const pendingRequest = fileName ? pendingDownloadRequests.get(fileName) : null;

      if (message.ok === false) {
        await pendingRequest?.resolve({ ok: false, error: message.message || "Download request failed." });
        return;
      }

      if (message.file) {
        mergeFileRecord(message.file);
        await saveState();
      }

      if (pendingRequest && downloadPath) {
        await pendingRequest.resolve(await startDownload(downloadPath, fileName));
      }
    }
  });

  socket.addEventListener("close", async () => {
    await chrome.storage.local.set({ connectionStatus: "disconnected" });
    pendingFileListRequest?.resolve({ ok: false, reason: "disconnected", files: latestFiles });
    socket = null;

    if (!didOpen && index + 1 < candidates.length) {
      attemptConnection(candidates, index + 1, mode);
      return;
    }

    scheduleReconnect();
  });

  socket.addEventListener("error", async () => {
    await chrome.storage.local.set({ connectionStatus: "error" });
    pendingFileListRequest?.resolve({ ok: false, reason: "error", files: latestFiles });
    socket.close();
  });
}

async function setStatusWithStorage(text) {
  // Since background can't update UI directly, we just store it for the next popup/page refresh
  // or rely on the status being derived from connectionStatus in storage.
  console.log(`[Background Status]: ${text}`);
}

chrome.runtime.onInstalled.addListener(async () => {
  await loadServerPreference();
  await chrome.storage.local.set({
    connectionStatus: "starting",
    latestServerText: "",
    latestUpdatedAt: "",
    latestFiles: [],
    fileRouteConfig
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
        "latestFiles",
        MANUAL_SERVER_STORAGE_KEY,
        "resolvedServerUrl"
      ]);

      sendResponse({
        ok: true,
        connectionStatus: stored.connectionStatus || "unknown",
        latestServerText: stored.latestServerText || "",
        latestUpdatedAt: stored.latestUpdatedAt || "",
        latestFiles: stored.latestFiles || [],
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

    if (message.action === "requestFileList") {
      const result = requestAvailableFiles();
      sendResponse(result);
      return;
    }

    if (message.action === "downloadFile") {
      const result = await requestFileDownload(message.name);
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
