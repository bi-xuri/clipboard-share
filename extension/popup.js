const statusEl = document.getElementById("status");
const updatedAtEl = document.getElementById("updatedAt");
const textEl = document.getElementById("clipboardText");
const serverUrlInput = document.getElementById("serverUrl");
const fileListEl = document.getElementById("fileList");
const clipboardTabEl = document.getElementById("clipboardTab");
const filesTabEl = document.getElementById("filesTab");
const clipboardPanelEl = document.getElementById("clipboardPanel");
const filesPanelEl = document.getElementById("filesPanel");

let currentServerUrl = "";
let resolvedServerUrl = "ws://clipboard-share.local:8080";
let activeView = "clipboard";

async function askBackground(action, payload = {}) {
  return chrome.runtime.sendMessage({
    target: "background",
    action,
    ...payload
  });
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

function renderFiles(files) {
  fileListEl.textContent = "";

  if (!Array.isArray(files) || files.length === 0) {
    const emptyItem = document.createElement("li");
    emptyItem.className = "file-empty";
    emptyItem.textContent = "No shared files yet.";
    fileListEl.appendChild(emptyItem);
    return;
  }

  for (const file of files) {
    const item = document.createElement("li");
    item.className = "file-item";

    const info = document.createElement("div");
    info.className = "file-info";

    const name = document.createElement("span");
    name.className = "file-name";
    name.textContent = file.name || "Unnamed file";
    name.title = file.name || "Unnamed file";

    const meta = document.createElement("span");
    meta.className = "file-meta";
    meta.textContent = formatFileSize(file.size);

    const downloadButton = document.createElement("button");
    downloadButton.type = "button";
    downloadButton.className = "secondary-button file-download";
    downloadButton.textContent = "Download";
    downloadButton.addEventListener("click", async () => {
      await askBackground("downloadFile", { name: file.name });
    });

    info.appendChild(name);
    info.appendChild(meta);
    item.appendChild(info);
    item.appendChild(downloadButton);
    fileListEl.appendChild(item);
  }
}

function setActiveView(view) {
  activeView = view;
  const showClipboard = view === "clipboard";

  clipboardTabEl.classList.toggle("is-active", showClipboard);
  filesTabEl.classList.toggle("is-active", !showClipboard);
  clipboardTabEl.setAttribute("aria-selected", String(showClipboard));
  filesTabEl.setAttribute("aria-selected", String(!showClipboard));
  clipboardPanelEl.classList.toggle("is-active", showClipboard);
  filesPanelEl.classList.toggle("is-active", !showClipboard);
  clipboardPanelEl.hidden = !showClipboard;
  filesPanelEl.hidden = showClipboard;
}

function renderState(state) {
  currentServerUrl = state.currentServerUrl || "";
  resolvedServerUrl = state.resolvedServerUrl || resolvedServerUrl;
  statusEl.textContent = currentServerUrl
    ? `Status: ${state.connectionStatus} (manual fallback: ${currentServerUrl}, connected: ${resolvedServerUrl})`
    : `Status: ${state.connectionStatus} (auto-discovery, connected: ${resolvedServerUrl})`;

  if (state.connectionStatus === 'error' && !currentServerUrl) {
    statusEl.classList.add('error');
    statusEl.textContent = "Connection Error. Please check server or enter manual URL.";
  } else {
    statusEl.classList.remove('error');
  }

  textEl.value = state.latestServerText || "";
  renderFiles(state.latestFiles || []);
  updatedAtEl.textContent = state.latestUpdatedAt
    ? `Last update: ${new Date(state.latestUpdatedAt).toLocaleString()}`
    : "Last update: none";
}

async function refresh() {
  const state = await askBackground("getState");
  renderState(state);
}

async function refreshFiles() {
  await askBackground("requestFileList");
  await refresh();
}

// Load saved server URL on startup
async function loadServerUrl() {
  try {
    const result = await chrome.storage.local.get(["manualServerUrl"]);
    if (result.manualServerUrl) {
      currentServerUrl = result.manualServerUrl;
      serverUrlInput.value = currentServerUrl;
    } else {
      serverUrlInput.value = "";
    }
  } catch (error) {
    console.error("Failed to load server URL:", error);
    serverUrlInput.value = "";
  }
}

document.getElementById("saveServerUrl").addEventListener("click", async () => {
  const newUrl = serverUrlInput.value.trim();

  try {
    await chrome.runtime.sendMessage({
      target: "background",
      action: "updateServerUrl",
      url: newUrl
    });

    currentServerUrl = newUrl;
    refresh();
  } catch (error) {
    console.error("Failed to save server URL:", error);
  }
});

document.getElementById("syncFromClipboard").addEventListener("click", async () => {
  await askBackground("syncFromClipboard");
  await refresh();
});

document.getElementById("pushToServer").addEventListener("click", async () => {
  await askBackground("pushText", { text: textEl.value });
  await refresh();
});

document.getElementById("copyFromServer").addEventListener("click", async () => {
  await askBackground("pullToClipboard");
  await refresh();
});

clipboardTabEl.addEventListener("click", () => {
  setActiveView("clipboard");
});

filesTabEl.addEventListener("click", async () => {
  setActiveView("files");
  await refreshFiles();
});

document.getElementById("refreshFiles").addEventListener("click", async () => {
  await refreshFiles();
});

// Initialize: load URL and refresh state
setActiveView(activeView);
loadServerUrl().then(refresh);
