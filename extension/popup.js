const statusEl = document.getElementById("status");
const updatedAtEl = document.getElementById("updatedAt");
const textEl = document.getElementById("clipboardText");
const serverUrlInput = document.getElementById("serverUrl");

let currentServerUrl = "";
let resolvedServerUrl = "ws://clipboard-share.local:8080";

async function askBackground(action, text) {
  return chrome.runtime.sendMessage({
    target: "background",
    action,
    text
  });
}

function renderState(state) {
  currentServerUrl = state.currentServerUrl || "";
  resolvedServerUrl = state.resolvedServerUrl || resolvedServerUrl;
  statusEl.textContent = currentServerUrl
    ? `Status: ${state.connectionStatus} (manual fallback: ${currentServerUrl}, connected: ${resolvedServerUrl})`
    : `Status: ${state.connectionStatus} (auto-discovery, connected: ${resolvedServerUrl})`;
  textEl.value = state.latestServerText || "";
  updatedAtEl.textContent = state.latestUpdatedAt
    ? `Last update: ${new Date(state.latestUpdatedAt).toLocaleString()}`
    : "Last update: none";
}

async function refresh() {
  const state = await askBackground("getState");
  renderState(state);
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
  await askBackground("pushText", textEl.value);
  await refresh();
});

document.getElementById("copyFromServer").addEventListener("click", async () => {
  await askBackground("pullToClipboard");
  await refresh();
});

// Initialize: load URL and refresh state
loadServerUrl().then(refresh);
