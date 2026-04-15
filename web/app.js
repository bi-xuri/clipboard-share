const discoveryApi = window.LanClipboardDiscovery || {};

const statusEl = document.getElementById("connectionStatus");
const textEl = document.getElementById("clipboardText");
const updatedAtEl = document.getElementById("updatedAt");
const serverHostEl = document.getElementById("serverHost");
const saveServerButtonEl = document.getElementById("saveServerButton");
const dropZoneEl = document.getElementById("dropZone");
const fileInputEl = document.getElementById("fileInput");
const fileInputButtonEl = document.getElementById("fileInputBtn");
const fileListEl = document.getElementById("fileList");

const SERVER_HOST_STORAGE_KEY = "lanClipboardServerHost";
const DEFAULT_MDNS_HOSTNAME = discoveryApi.DEFAULT_MDNS_HOSTNAME || "clipboard-share.local";
const DISCOVERY_TIMEOUT_MS = 1500;
const RECONNECT_DELAY_MS = 1800;
const CONNECT_TIMEOUT_MS = 2500;
const MANUAL_INPUT_DEBOUNCE_MS = 420;
const FILE_LIST_REFRESH_DEBOUNCE_MS = 250;
const DEFAULT_FILE_PATH_PREFIX = "/files/";
const DEFAULT_FILE_LIST_ENDPOINT = "/files";
const DEFAULT_FILE_UPLOAD_ENDPOINT = "/upload";

const normalizeServerUrl = discoveryApi.normalizeServerUrl || fallbackNormalizeServerUrl;
const buildConnectionCandidates = discoveryApi.buildConnectionCandidates || fallbackBuildConnectionCandidates;
const buildAutomaticConnectionCandidates =
  discoveryApi.buildAutomaticConnectionCandidates || fallbackBuildAutomaticConnectionCandidates;

let socket = null;
let isConnecting = false;
let queuedConnectOptions = null;
let reconnectTimer = null;
let inputTimer = null;
let shouldReconnect = true;
let reconnectMode = "auto";
let currentServerUrl = "";
let connectRunId = 0;
let latestFiles = [];
let isUploading = false;
let uploadEndpointPath = DEFAULT_FILE_UPLOAD_ENDPOINT;
let fileListEndpointPath = DEFAULT_FILE_LIST_ENDPOINT;
let filePathPrefix = DEFAULT_FILE_PATH_PREFIX;
let pendingUploadRequest = null;
let fileListRefreshTimer = null;
let dropZoneDragDepth = 0;
let dropZoneBaseText = "";
let pendingUploads = [];

let lastRequestedManualHost = "";
let clipboardText = "";
let lastUpdatedAt = null;

function normalizeEndpointPath(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return fallback;
  }

  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function normalizePathPrefix(value, fallback) {
  const normalized = normalizeEndpointPath(value, fallback);
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

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

function fallbackBuildConnectionCandidates({
  manualValue = "",
  pageHostname = "",
  protocol = "ws",
  mdnsHostname = DEFAULT_MDNS_HOSTNAME
}) {
  const candidates = [];

  if (manualValue) candidates.push(normalizeServerUrl(manualValue, protocol));
  candidates.push(normalizeServerUrl(mdnsHostname, protocol));

  if (pageHostname && pageHostname !== "localhost") {
    candidates.push(normalizeServerUrl(pageHostname, protocol));
  }

  return [...new Set(candidates.filter(Boolean))];
}

function fallbackBuildAutomaticConnectionCandidates({
  pageHostname = "",
  protocol = "ws",
  mdnsHostname = DEFAULT_MDNS_HOSTNAME
}) {
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

function getServerHttpBase() {
  if (currentServerUrl) {
    try {
      const parsed = new URL(currentServerUrl);
      parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
      parsed.pathname = "/";
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString().replace(/\/$/, "");
    } catch (error) {
      return "";
    }
  }

  if (window.location.port === "8080") {
    return window.location.origin;
  }

  return "";
}

function buildServerHttpUrl(pathname) {
  const baseUrl = getServerHttpBase();

  if (!baseUrl) {
    return "";
  }

  try {
    return new URL(pathname, `${baseUrl}/`).toString();
  } catch (error) {
    return "";
  }
}

function setStatus(text, state = "idle") {
  statusEl.textContent = text;
  statusEl.dataset.state = state;
}

function getDropZoneMessageEl() {
  return dropZoneEl.querySelector("p");
}

function setDropZoneMessage(text) {
  const messageEl = getDropZoneMessageEl();

  if (messageEl) {
    messageEl.textContent = text;
  }
}

function setDropZoneUploading(isActive, label = "") {
  dropZoneEl.classList.toggle("uploading", Boolean(isActive));
  dropZoneEl.setAttribute("aria-busy", isActive ? "true" : "false");

  if (isActive) {
    setDropZoneMessage(label ? `Uploading ${label}...` : "Uploading files...");
    return;
  }

  setDropZoneMessage(dropZoneBaseText || "Drag & drop files here or");
}

function setDropZoneActive(isActive) {
  dropZoneEl.classList.toggle("dragover", Boolean(isActive));
}

function resetDropZoneState() {
  dropZoneDragDepth = 0;

  if (!isUploading) {
    setDropZoneActive(false);
  }
}

function eventIncludesFiles(event) {
  const dataTransfer = event?.dataTransfer;
  const types = dataTransfer?.types;

  if (dataTransfer?.files?.length) {
    return true;
  }

  if (dataTransfer?.items?.length) {
    return Array.from(dataTransfer.items).some((item) => item.kind === "file");
  }

  if (!types) {
    return false;
  }

  return Array.from(types).includes("Files");
}

function setClipboardText(text, updatedAt) {
  clipboardText = text;
  lastUpdatedAt = updatedAt;
  textEl.value = text;
  updatedAtEl.textContent = updatedAt ? `Last synced ${new Date(updatedAt).toLocaleTimeString()}` : "";
}

function applyFileConfig(config) {
  if (!config || typeof config !== "object") {
    return;
  }

  if (typeof config.pathPrefix === "string" && config.pathPrefix) {
    filePathPrefix = normalizePathPrefix(config.pathPrefix, DEFAULT_FILE_PATH_PREFIX);
  }

  if (typeof config.listEndpoint === "string" && config.listEndpoint) {
    fileListEndpointPath = normalizeEndpointPath(config.listEndpoint, DEFAULT_FILE_LIST_ENDPOINT);
  }

  if (config.upload?.endpoint) {
    uploadEndpointPath = normalizeEndpointPath(config.upload.endpoint, DEFAULT_FILE_UPLOAD_ENDPOINT);
  }
}

function getIncomingFileConfig(message) {
  if (!message || typeof message !== "object") {
    return null;
  }

  return message.fileConfig || message.config || message.files || null;
}

function formatFileSize(size) {
  const value = Number(size) || 0;

  if (value < 1024) {
    return `${value} B`;
  }

  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }

  if (value < 1024 * 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }

  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function normalizeFileRecord(file) {
  if (!file || typeof file.name !== "string") {
    return null;
  }

  const url = typeof file.url === "string"
    ? file.url
    : `${filePathPrefix}${encodeURIComponent(file.name)}`;

  return {
    name: file.name,
    size: Number(file.size) || 0,
    type: file.type || "application/octet-stream",
    uploadTime: file.uploadTime || null,
    url
  };
}

function createPendingUploadRecord(file) {
  if (!(file instanceof File)) {
    return null;
  }

  return {
    id: `${file.name}:${file.size}:${file.lastModified}`,
    name: file.name || "Unnamed file",
    size: Number(file.size) || 0,
    type: file.type || "application/octet-stream",
    uploadTime: null,
    isPending: true
  };
}

function sortFiles(files) {
  return [...files].sort((left, right) => {
    const leftTime = left.uploadTime ? new Date(left.uploadTime).getTime() : 0;
    const rightTime = right.uploadTime ? new Date(right.uploadTime).getTime() : 0;
    return rightTime - leftTime;
  });
}

function mergeFileRecord(file) {
  const normalized = normalizeFileRecord(file);

  if (!normalized) {
    return;
  }

  const nextFiles = latestFiles.filter((entry) => entry.name !== normalized.name);
  nextFiles.push(normalized);
  latestFiles = sortFiles(nextFiles);
  renderFileList();
}

function findFileRecord(fileName) {
  return latestFiles.find((file) => file.name === fileName) || null;
}

function setFileList(files) {
  latestFiles = sortFiles(
    (Array.isArray(files) ? files : [])
      .map(normalizeFileRecord)
      .filter(Boolean)
  );
  renderFileList();
}

function addPendingUploads(files) {
  const nextPending = files
    .map(createPendingUploadRecord)
    .filter(Boolean);

  if (nextPending.length === 0) {
    return [];
  }

  pendingUploads = [
    ...pendingUploads.filter(
      (existing) => !nextPending.some((candidate) => candidate.id === existing.id)
    ),
    ...nextPending
  ];
  renderFileList();
  return nextPending;
}

function removePendingUpload(recordId) {
  const nextPending = pendingUploads.filter((entry) => entry.id !== recordId);

  if (nextPending.length === pendingUploads.length) {
    return;
  }

  pendingUploads = nextPending;
  renderFileList();
}

function renderFileList() {
  fileListEl.textContent = "";
  const visibleFiles = [...pendingUploads, ...latestFiles];

  if (visibleFiles.length === 0) {
    const emptyItem = document.createElement("li");
    emptyItem.className = "file-item file-item-empty";

    const info = document.createElement("div");
    info.className = "file-info";

    const name = document.createElement("span");
    name.className = "file-name";
    name.textContent = "No shared files yet";

    const hint = document.createElement("span");
    hint.className = "file-size";
    hint.textContent = "Drop a file above or use Select Files.";

    info.appendChild(name);
    info.appendChild(hint);
    emptyItem.appendChild(info);
    fileListEl.appendChild(emptyItem);
    return;
  }

  for (const file of visibleFiles) {
    const item = document.createElement("li");
    item.className = file.isPending ? "file-item file-item-pending" : "file-item";

    const info = document.createElement("div");
    info.className = "file-info";

    const name = document.createElement("span");
    name.className = "file-name";
    name.textContent = file.name;
    name.title = file.name;

    const size = document.createElement("span");
    size.className = "file-size";
    size.textContent = file.isPending
      ? `${formatFileSize(file.size)} • Uploading…`
      : formatFileSize(file.size);

    info.appendChild(name);
    info.appendChild(size);
    item.appendChild(info);

    if (!file.isPending) {
      const actions = document.createElement("div");
      actions.className = "file-actions";

      const button = document.createElement("button");
      button.type = "button";
      button.className = "secondary";
      button.textContent = "Download";
      button.addEventListener("click", () => {
        requestFileDownload(file.name);
      });

      actions.appendChild(button);
      item.appendChild(actions);
    }

    fileListEl.appendChild(item);
  }
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

async function requestAvailableFiles() {
  const listUrl = buildServerHttpUrl(fileListEndpointPath);

  if (listUrl) {
    try {
      const response = await window.fetch(listUrl, { cache: "no-store" });
      const payload = await response.json().catch(() => null);

      if (response.ok && Array.isArray(payload)) {
        setFileList(payload);
        return;
      }
    } catch (error) {
      console.warn("HTTP file list refresh failed, falling back to WebSocket:", error);
    }
  }

  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "fileList" }));
  }
}

function scheduleFileListRefresh() {
  if (fileListRefreshTimer) {
    return;
  }

  fileListRefreshTimer = window.setTimeout(() => {
    fileListRefreshTimer = null;
    requestAvailableFiles();
  }, FILE_LIST_REFRESH_DEBOUNCE_MS);
}

function requestUploadTarget() {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("Connect to a LAN clipboard server before uploading files."));
  }

  if (pendingUploadRequest) {
    return pendingUploadRequest.promise;
  }

  let settled = false;
  let timeoutId = null;
  let resolvePromise;
  let rejectPromise;

  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  const finalize = (callback, value) => {
    if (settled) {
      return;
    }

    settled = true;

    if (timeoutId) {
      window.clearTimeout(timeoutId);
    }

    pendingUploadRequest = null;
    callback(value);
  };

  pendingUploadRequest = {
    promise,
    resolve(payload) {
      finalize(resolvePromise, payload);
    },
    reject(error) {
      finalize(rejectPromise, error);
    }
  };

  timeoutId = window.setTimeout(() => {
    pendingUploadRequest?.reject(new Error("The server did not respond with an upload endpoint."));
  }, CONNECT_TIMEOUT_MS);

  socket.send(JSON.stringify({ type: "fileUpload" }));
  return promise;
}

async function resolveUploadTarget() {
  const uploadUrl = buildServerHttpUrl(uploadEndpointPath);

  if (uploadUrl) {
    return {
      endpoint: uploadEndpointPath,
      fieldName: "file",
      method: "POST",
      url: uploadUrl
    };
  }

  const negotiatedTarget = await requestUploadTarget();
  const endpointPath = negotiatedTarget?.endpoint || uploadEndpointPath;
  const negotiatedUploadUrl = buildServerHttpUrl(endpointPath);

  if (!negotiatedUploadUrl) {
    throw new Error("The file upload endpoint is not available yet.");
  }

  return {
    endpoint: endpointPath,
    fieldName: negotiatedTarget?.fieldName || "file",
    method: negotiatedTarget?.method || "POST",
    url: negotiatedUploadUrl
  };
}

async function startDownloadFromUrl(downloadPath, fileName) {
  const downloadUrl = /^https?:\/\//i.test(downloadPath)
    ? downloadPath
    : buildServerHttpUrl(downloadPath);

  if (!downloadUrl) {
    setStatus("No reachable file download endpoint is available yet.", "error");
    return;
  }

  try {
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = fileName || "download";
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    setStatus(`Downloading ${fileName}…`, "connected");
  } catch (error) {
    console.error("Download failed:", error);
    setStatus(`Failed to download ${fileName}.`, "error");
  }
}

function requestFileDownload(fileName) {
  const existingFile = findFileRecord(fileName);

  if (!socket || socket.readyState !== WebSocket.OPEN) {
    if (existingFile?.url) {
      startDownloadFromUrl(existingFile.url, existingFile.name);
      return;
    }

    setStatus("Connect to a LAN clipboard server before downloading files.", "error");
    return;
  }

  socket.send(JSON.stringify({ type: "fileDownload", name: fileName }));
}

async function uploadFiles(fileList) {
  const files = [...(fileList || [])].filter((file) => file instanceof File);

  if (files.length === 0) {
    resetDropZoneState();
    return;
  }

  if (!buildServerHttpUrl(uploadEndpointPath) && (!socket || socket.readyState !== WebSocket.OPEN)) {
    resetDropZoneState();
    setStatus("No reachable file upload endpoint is available yet.", "error");
    return;
  }

  isUploading = true;
  setDropZoneActive(true);
  setDropZoneUploading(true, files.length === 1 ? files[0].name : `${files.length} files`);
  const pendingRecords = addPendingUploads(files);

  try {
    const uploadTarget = await resolveUploadTarget();
    const fieldName = uploadTarget.fieldName || "file";

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const pendingRecord = pendingRecords[index];
      const formData = new FormData();
      formData.append(fieldName, file, file.name);

      setStatus(`Uploading ${file.name}…`, "connecting");

      const response = await window.fetch(uploadTarget.url, {
        method: uploadTarget.method || "POST",
        body: formData
      });

      const payload = await response.json().catch(() => null);

      if (!response.ok || !payload?.ok || !payload.file) {
        const message = payload?.message || `Upload failed with status ${response.status}`;
        throw new Error(message);
      }

      applyFileConfig(payload.config);
      mergeFileRecord(payload.file.url ? payload.file : { ...payload.file, url: payload.url });
      if (pendingRecord) {
        removePendingUpload(pendingRecord.id);
      }
      setStatus(`Uploaded ${payload.file.name}.`, "connected");
    }

    requestAvailableFiles();
  } catch (error) {
    console.error("Upload failed:", error);
    for (const pendingRecord of pendingRecords) {
      removePendingUpload(pendingRecord.id);
    }
    setStatus(error.message || "Failed to upload file.", "error");
  } finally {
    isUploading = false;
    setDropZoneUploading(false);
    resetDropZoneState();
    fileInputEl.value = "";
  }
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
    requestAvailableFiles();
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
    requestAvailableFiles();
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
      applyFileConfig(getIncomingFileConfig(message));
      initialSyncReceived = true;
      setClipboardText(message.text || "", message.updatedAt);
      setStatus(`Connected to ${label}`, "connected");
      return;
    }

    switch (message.type) {
      case "fileList":
        applyFileConfig(getIncomingFileConfig(message));
        setFileList(message.files);
        return;
      case "fileUpload":
        applyFileConfig(getIncomingFileConfig(message) || { upload: message.upload });

        if (message.ok === false) {
          if (pendingUploadRequest) {
            pendingUploadRequest.reject(new Error(message.message || "Upload negotiation failed."));
          }

          setStatus(message.message || "Upload negotiation failed.", "error");
          return;
        }

        if (message.ok && message.upload && pendingUploadRequest) {
          pendingUploadRequest.resolve(message.upload);
        }

        if (message.file) {
          mergeFileRecord(message.file.url ? message.file : { ...message.file, url: message.url });
          scheduleFileListRefresh();
        }
        return;
      case "fileDownload":
        applyFileConfig(getIncomingFileConfig(message));

        if (message.ok === false) {
          setStatus(message.message || "Download request failed.", "error");
          return;
        }

        const downloadUrl = message.file?.url || message.url;

        if (!downloadUrl) {
          setStatus("The server did not provide a file download URL.", "error");
          return;
        }

        startDownloadFromUrl(downloadUrl, message.file?.name || "download");
        return;
      case "error":
        if (pendingUploadRequest) {
          pendingUploadRequest.reject(new Error(message.message || "Upload negotiation failed."));
        }

        setStatus(`Server error: ${message.message}`, "error");
        return;
      default:
        return;
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
    if (pendingUploadRequest) {
      pendingUploadRequest.reject(new Error("The server disconnected before the upload could start."));
    }

    if (!shouldReconnect) {
      return;
    }

    if (!didOpen && index + 1 < candidates.length) {
      attemptConnection({ candidates, index: index + 1, mode, runId });
      return;
    }

    currentServerUrl = "";

    if (didOpen && !initialSyncReceived) {
      setStatus("Connected, but initial sync was interrupted. Reconnecting…", "connecting");
    } else {
      setStatus("Disconnected. Reconnecting in the background…", "connecting");
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

    if (
      latestValue === lastRequestedManualHost &&
      currentServerUrl === normalizedHost &&
      socket?.readyState === WebSocket.OPEN
    ) {
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

function preventDragDefaults(event) {
  event.preventDefault();
  event.stopPropagation();
}

function isDropZoneTarget(target) {
  return Boolean(target) && (target === dropZoneEl || dropZoneEl.contains(target));
}

function extractDroppedFiles(dataTransfer) {
  if (!dataTransfer) {
    return [];
  }

  if (dataTransfer.items?.length) {
    return [...dataTransfer.items]
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file) => file instanceof File);
  }

  return [...(dataTransfer.files || [])].filter((file) => file instanceof File);
}

for (const eventName of ["dragenter", "dragover", "drop"]) {
  document.addEventListener(eventName, (event) => {
    if (eventIncludesFiles(event)) {
      preventDragDefaults(event);
    }
  });
}

for (const eventName of ["dragenter", "dragover", "dragleave", "drop"]) {
  dropZoneEl.addEventListener(eventName, (event) => {
    if (eventIncludesFiles(event)) {
      preventDragDefaults(event);
    }
  });
}

for (const eventName of ["dragenter", "dragover"]) {
  dropZoneEl.addEventListener(eventName, (event) => {
    if (!eventIncludesFiles(event) || isUploading) {
      return;
    }

    if (eventName === "dragenter") {
      dropZoneDragDepth += 1;
    }

    setDropZoneActive(true);

    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "copy";
    }
  });
}

for (const eventName of ["dragleave", "drop"]) {
  dropZoneEl.addEventListener(eventName, (event) => {
    if (!eventIncludesFiles(event) || isUploading) {
      return;
    }

    if (eventName === "dragleave") {
      const relatedTarget = event.relatedTarget;

      if (relatedTarget && isDropZoneTarget(relatedTarget)) {
        return;
      }

      dropZoneDragDepth = Math.max(0, dropZoneDragDepth - 1);
    } else {
      dropZoneDragDepth = 0;
    }

    if (dropZoneDragDepth === 0) {
      setDropZoneActive(false);
    }
  });
}

dropZoneEl.addEventListener("drop", (event) => {
  if (!eventIncludesFiles(event)) {
    return;
  }

  dropZoneDragDepth = 0;
  uploadFiles(extractDroppedFiles(event.dataTransfer));
});

dropZoneEl.addEventListener("click", (event) => {
  if (isUploading || event.target.closest("button")) {
    return;
  }

  fileInputEl.click();
});

fileInputButtonEl.addEventListener("click", (event) => {
  if (isUploading) {
    return;
  }

  event.stopPropagation();
  fileInputEl.click();
});

fileInputEl.addEventListener("change", () => {
  uploadFiles(fileInputEl.files || []);
});

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
dropZoneBaseText = getDropZoneMessageEl()?.textContent?.trim() || "Drag & drop files here or";
setDropZoneUploading(false);
renderFileList();
connect({
  mode: serverHostEl.value.trim() ? "manual" : "auto",
  preferredHost: serverHostEl.value.trim()
});
