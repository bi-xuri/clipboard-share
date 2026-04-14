chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "offscreen") {
    return false;
  }

  (async () => {
    try {
      if (message.action === "readClipboard") {
        const text = await navigator.clipboard.readText();
        sendResponse({ ok: true, text });
        return;
      }

      if (message.action === "writeClipboard") {
        const text = typeof message.text === "string" ? message.text : "";
        await navigator.clipboard.writeText(text);
        sendResponse({ ok: true });
        return;
      }

      sendResponse({ ok: false, error: "Unknown action" });
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
  })();

  return true;
});
