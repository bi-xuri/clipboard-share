const fs = require("fs");
const dgram = require("dgram");
const http = require("http");
const path = require("path");
const { WebSocketServer, WebSocket } = require("ws");

const DEFAULT_HTTP_PORT = 8080;
const DEFAULT_DISCOVERY_PORT = 41234;
const MDNS_SERVICE_NAME = "clipboard-share";
const MDNS_BONJOUR_TYPE = "http";
const MDNS_SERVICE_TYPE = `_${MDNS_BONJOUR_TYPE}._tcp.local`;
const MDNS_DEFAULT_HOSTNAME = "clipboard-share.local";
const DISCOVERY_MAGIC = "lan-clipboard-discovery";
const WEB_ROOT = path.resolve(__dirname, "../web");

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

function getLanAddresses() {
  const interfaces = require("os").networkInterfaces();
  const addresses = [];

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (!entry || entry.internal || entry.family !== "IPv4") {
        continue;
      }

      addresses.push(entry.address);
    }
  }

  return [...new Set(addresses)];
}

function sanitizeMdnsHostname(input) {
  const cleaned = String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  const hostname = cleaned || "lan-clipboard";
  return hostname.endsWith(".local") ? hostname : `${hostname}.local`;
}

function buildDiscoveryPayload({ req, httpPort, discoveryPort, mdnsHostname, latestText, updatedAt }) {
  const protocol = req?.socket?.encrypted ? "https" : "http";
  const wsProtocol = protocol === "https" ? "wss" : "ws";
  const lanAddresses = getLanAddresses();

  return {
    ok: true,
    http: {
      port: httpPort,
      urls: lanAddresses.map((address) => `${protocol}://${address}:${httpPort}`)
    },
    websocket: {
      port: httpPort,
      urls: lanAddresses.map((address) => `${wsProtocol}://${address}:${httpPort}`)
    },
    discovery: {
      port: discoveryPort,
      magic: DISCOVERY_MAGIC
    },
    mdns: {
      name: MDNS_SERVICE_NAME,
      hostname: mdnsHostname,
      serviceType: MDNS_SERVICE_TYPE,
      urls: [`${protocol}://${mdnsHostname}:${httpPort}`],
      websocketUrls: [`${wsProtocol}://${mdnsHostname}:${httpPort}`]
    },
    interfaces: lanAddresses,
    latestText,
    updatedAt
  };
}

function sendJsonResponse(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendStaticFile(res, requestPath) {
  const parsedUrl = new URL(requestPath || "/", "http://127.0.0.1");
  const relativePath = parsedUrl.pathname === "/" ? "/index.html" : parsedUrl.pathname;
  const resolvedPath = path.resolve(WEB_ROOT, `.${relativePath}`);

  if (!resolvedPath.startsWith(WEB_ROOT)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  let stat;

  try {
    stat = fs.statSync(resolvedPath);
  } catch (error) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  if (!stat.isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  const extension = path.extname(resolvedPath).toLowerCase();
  const contentType = mimeTypes[extension] || "application/octet-stream";

  res.writeHead(200, { "Content-Type": contentType });
  fs.createReadStream(resolvedPath).pipe(res);
}

function createMdnsAdvertiser({ hostname, serviceName, getHttpPort }) {
  let bonjourInstance = null;
  let publishedService = null;

  return {
    async start() {
      let createBonjour;

      try {
        createBonjour = require("bonjour");
      } catch (error) {
        throw new Error("bonjour is not installed in server/. Run `npm install` there.");
      }

      bonjourInstance = createBonjour();
      publishedService = bonjourInstance.publish({
        name: serviceName,
        type: MDNS_BONJOUR_TYPE,
        port: getHttpPort(),
        host: hostname,
        txt: {
          path: "/",
          websocketPort: String(getHttpPort()),
          version: "1"
        }
      });
    },
    stop() {
      if (publishedService && typeof publishedService.stop === "function") {
        publishedService.stop();
      }

      publishedService = null;

      if (bonjourInstance && typeof bonjourInstance.destroy === "function") {
        bonjourInstance.destroy();
      }

      bonjourInstance = null;
    }
  };
}

function createUdpDiscoveryResponder({ host, discoveryPort, getHttpPort }) {
  let socket = null;
  let resolvedPort = discoveryPort;

  return {
    async start() {
      socket = dgram.createSocket("udp4");

      socket.on("error", (error) => {
        console.warn(`UDP discovery unavailable: ${error.message}`);
      });

      socket.on("message", (message, remote) => {
        const text = String(message).trim();

        if (text !== DISCOVERY_MAGIC) {
          return;
        }

        const payload = JSON.stringify({
          ok: true,
          websocketPort: getHttpPort(),
          httpPort: getHttpPort(),
          interfaces: getLanAddresses()
        });

        socket.send(payload, remote.port, remote.address);
      });

      await new Promise((resolve) => {
        socket.bind(discoveryPort, host, () => {
          const address = socket.address();
          resolvedPort = typeof address === "object" ? address.port : discoveryPort;
          resolve();
        });
      });
    },
    stop() {
      if (socket) {
        socket.close();
        socket = null;
      }
    },
    getPort() {
      return resolvedPort;
    }
  };
}

function createApp(options = {}) {
  const host = options.host || "0.0.0.0";
  const configuredPort = Number(options.port ?? process.env.PORT ?? DEFAULT_HTTP_PORT);
  const configuredDiscoveryPort = Number(
    options.discoveryPort ?? process.env.DISCOVERY_PORT ?? DEFAULT_DISCOVERY_PORT
  );
  const enableMdns = options.enableMdns !== false;
  const enableUdpDiscovery = options.enableUdpDiscovery !== false;
  const mdnsHostname = sanitizeMdnsHostname(
    options.mdnsHostname ?? process.env.MDNS_HOSTNAME ?? MDNS_DEFAULT_HOSTNAME
  );
  const mdnsServiceName = options.mdnsServiceName ?? process.env.MDNS_SERVICE_NAME ?? MDNS_SERVICE_NAME;

  let latestText = "";
  let updatedAt = new Date().toISOString();
  let nextClientId = 1;
  let resolvedHttpPort = configuredPort;

  const udpDiscoveryResponder = createUdpDiscoveryResponder({
    host,
    discoveryPort: configuredDiscoveryPort,
    getHttpPort: () => resolvedHttpPort
  });
  const mdnsAdvertiser = createMdnsAdvertiser({
    hostname: mdnsHostname,
    serviceName: mdnsServiceName,
    getHttpPort: () => resolvedHttpPort
  });

  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      sendJsonResponse(res, 200, { ok: true, latestText, updatedAt });
      return;
    }

    if (req.url === "/discovery") {
      sendJsonResponse(
        res,
        200,
        buildDiscoveryPayload({
          req,
          httpPort: resolvedHttpPort,
          discoveryPort: udpDiscoveryResponder.getPort(),
          mdnsHostname,
          latestText,
          updatedAt
        })
      );
      return;
    }

    sendStaticFile(res, req.url || "/");
  });

  const wss = new WebSocketServer({ server });

  function sendJson(socket, payload) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  }

  function broadcast(payload, exceptClientId) {
    const encoded = JSON.stringify(payload);

    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) {
        continue;
      }

      if (exceptClientId && client.clientId === exceptClientId) {
        continue;
      }

      client.send(encoded);
    }
  }

  function applyClipboardUpdate(text, sourceClientId) {
    latestText = text;
    updatedAt = new Date().toISOString();

    broadcast(
      {
        type: "clipboard",
        text: latestText,
        updatedAt,
        source: sourceClientId || null
      },
      sourceClientId
    );
  }

  wss.on("connection", (socket, req) => {
    socket.clientId = nextClientId;
    nextClientId += 1;

    sendJson(socket, {
      type: "init",
      text: latestText,
      updatedAt
    });

    socket.on("message", (raw) => {
      let message;

      try {
        message = JSON.parse(String(raw));
      } catch (error) {
        sendJson(socket, {
          type: "error",
          message: "Invalid JSON payload"
        });
        return;
      }

      if (message.type === "setClipboard" && typeof message.text === "string") {
        applyClipboardUpdate(message.text, socket.clientId);
        sendJson(socket, {
          type: "ack",
          text: latestText,
          updatedAt
        });
        return;
      }

      if (message.type === "ping") {
        sendJson(socket, { type: "pong", ts: Date.now() });
        return;
      }

      sendJson(socket, {
        type: "error",
        message: "Unsupported message type"
      });
    });

    socket.on("close", () => {
      console.log(`Client ${socket.clientId} disconnected`);
    });

    console.log(`Client ${socket.clientId} connected from ${req.socket.remoteAddress}`);
  });

  async function start() {
    await new Promise((resolve) => {
      server.listen(configuredPort, host, () => {
        const address = server.address();
        resolvedHttpPort = typeof address === "object" ? address.port : configuredPort;
        resolve();
      });
    });

    if (enableUdpDiscovery) {
      await udpDiscoveryResponder.start();
    }

    if (enableMdns) {
      try {
        await mdnsAdvertiser.start();
      } catch (error) {
        console.warn(`mDNS unavailable: ${error.message}`);
      }
    }

    return {
      host,
      httpPort: resolvedHttpPort,
      discoveryPort: udpDiscoveryResponder.getPort(),
      mdnsHostname
    };
  }

  async function stop() {
    if (enableMdns) {
      mdnsAdvertiser.stop();
    }

    if (enableUdpDiscovery) {
      udpDiscoveryResponder.stop();
    }

    for (const client of wss.clients) {
      client.close();
    }

    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  return {
    start,
    stop,
    buildDiscoveryPayload: (req) =>
      buildDiscoveryPayload({
        req,
        httpPort: resolvedHttpPort,
        discoveryPort: udpDiscoveryResponder.getPort(),
        mdnsHostname,
        latestText,
        updatedAt
      })
  };
}

async function main(app) {
  const info = await app.start();

  console.log(`LAN clipboard server listening on http://0.0.0.0:${info.httpPort}`);
  console.log(`WebSocket endpoint available on ws://0.0.0.0:${info.httpPort}`);
  console.log(`Bonjour service: ${MDNS_SERVICE_NAME} (${MDNS_SERVICE_TYPE})`);
  console.log(`Bonjour hostname: ${info.mdnsHostname}`);
  console.log(`UDP discovery responder listening on udp://0.0.0.0:${info.discoveryPort}`);
  console.log("Open the web client from another device with a LAN IP address or the Bonjour hostname.");
}

if (require.main === module) {
  const app = createApp();

  main(app).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

  async function shutdown() {
    try {
      await app.stop();
    } catch (error) {
      console.error(error);
    } finally {
      process.exit(0);
    }
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

module.exports = {
  MDNS_DEFAULT_HOSTNAME,
  MDNS_SERVICE_NAME,
  MDNS_SERVICE_TYPE,
  buildDiscoveryPayload,
  createApp,
  sendStaticFile,
  sanitizeMdnsHostname
};
