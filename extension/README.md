# LAN Clipboard Chrome Extension

## Load locally

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `extension/` folder

The extension connects to `ws://localhost:8080`.

## Notes

- The popup supports manual sync, push, and copy actions.
- The background service worker keeps a WebSocket open and polls the local clipboard through an offscreen document.
- Clipboard access in extensions depends on Chrome permissions and the platform clipboard state. Manual popup actions are the most reliable path.
