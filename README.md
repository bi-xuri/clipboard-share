# LAN Clipboard Sharing

This workspace contains three local components:

- `server/`: Node.js server that serves the web app, exposes the WebSocket endpoint, stores the latest clipboard text in memory, and exposes LAN discovery metadata. It listens on `0.0.0.0:8080` by default so other LAN devices can connect.
- `extension/`: Chrome extension (Manifest V3) that now uses the same mDNS-first LAN discovery flow as the web client, with an optional manual WebSocket fallback.
- `web/`: Static web page assets that can be served directly by the Node server or by a separate Python static server during local development.

## Start everything

```bash
npm run start:all
```

The root `start:all` script launches the Node server in `server/` and a Python static server for `web/` simultaneously. The Node server remains on `http://127.0.0.1:8080` and the static web client is served from `http://127.0.0.1:8001`.

If you only want the bundled Node flow that waits for `/health` and opens a browser automatically, use:

```bash
npm start
```

Install dependencies once before the first run:

```bash
npm install
npm --prefix server install
```

Open the web app at:

```bash
http://192.168.1.10:8080
```

The web client will auto-try:

- the saved/manual host value
- the Bonjour hostname `clipboard-share.local`
- the `/discovery` endpoint exposed by the server
- LAN interface WebSocket URLs returned by `/discovery`

When the app is served directly by the Node server, the current page hostname is also used automatically before LAN IP fallbacks.

The server now advertises itself over Bonjour/mDNS as the `clipboard-share` service on `_http._tcp.local` and uses the hostname `clipboard-share.local`, so LAN devices that support `.local` host resolution can connect without typing the IP address. The manual input field is still available for explicit IP/hostname entry or environments where mDNS is blocked.

Health check:

```bash
curl http://localhost:8080/health
```

Discovery metadata:

```bash
curl http://localhost:8080/discovery
```

UDP discovery probe:

```bash
printf 'lan-clipboard-discovery' | nc -u -w1 127.0.0.1 41234
```

Run the automated tests with:

```bash
npm test
```

The WebSocket server accepts `setClipboard` messages and broadcasts `clipboard` updates to every other connected client.

## Load the Chrome extension

1. Open `chrome://extensions`
2. Enable Developer mode
3. Click **Load unpacked**
4. Select the `extension/` directory

The extension popup lets you set an optional manual fallback URL, manually sync from the local clipboard, push text to the server, and copy the server text back to your local clipboard. If left blank, the extension prefers `clipboard-share.local`, then server-advertised LAN endpoints, then localhost for local development.
