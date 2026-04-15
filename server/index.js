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
const UPLOADS_DIR = path.resolve(__dirname, "uploads");
const MAX_FILE_SIZE = 100 * 1024 * 1024;
const MAX_MULTIPART_BODY_SIZE = MAX_FILE_SIZE + 1024 * 1024;
const MAX_FILENAME_LENGTH = 255;
const HEADER_SEPARATOR = Buffer.from("\r\n\r\n");
const FILE_PATH_PREFIX = "/files/";

ensureDirectory(UPLOADS_DIR);

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp"
};

function ensureDirectory(directoryPath) {
  if (!fs.existsSync(directoryPath)) {
    fs.mkdirSync(directoryPath, { recursive: true });
  }
}

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function getMimeType(fileName, fallback = "application/octet-stream") {
  return mimeTypes[path.extname(fileName).toLowerCase()] || fallback;
}

function sanitizeUploadedName(input) {
  const value = String(input || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  const baseName = path.basename(value);

  if (!baseName || baseName === "." || baseName === "..") {
    return null;
  }

  const sanitized = baseName
    .replace(/[<>:"/\\|?*]+/g, "-")
    .replace(/^\.+/, "")
    .replace(/\s+/g, " ")
    .slice(0, MAX_FILENAME_LENGTH)
    .trim();

  return sanitized || null;
}

function parseMultipartBoundary(contentType) {
  const match = String(contentType || "").match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  return match ? (match[1] || match[2]).trim() : null;
}

function parseContentDisposition(headerValue) {
  const parameters = {};

  for (const part of String(headerValue || "").split(";").slice(1)) {
    const [rawKey, ...rawValueParts] = part.split("=");
    const key = rawKey ? rawKey.trim().toLowerCase() : "";

    if (!key) {
      continue;
    }

    const rawValue = rawValueParts.join("=").trim();
    parameters[key] = rawValue.startsWith("\"") && rawValue.endsWith("\"")
      ? rawValue.slice(1, -1)
      : rawValue;
  }

  return parameters;
}

function parseMultipartFile(body, boundary) {
  const boundaryBuffer = Buffer.from(`--${boundary}`);

  if (!body.subarray(0, boundaryBuffer.length).equals(boundaryBuffer)) {
    throw createHttpError(400, "Malformed multipart payload");
  }

  let position = boundaryBuffer.length;
  let foundFile = null;
  let filePartCount = 0;

  while (position < body.length) {
    if (body[position] === 45 && body[position + 1] === 45) {
      break;
    }

    if (body[position] !== 13 || body[position + 1] !== 10) {
      throw createHttpError(400, "Malformed multipart payload");
    }

    position += 2;

    const headersEnd = body.indexOf(HEADER_SEPARATOR, position);

    if (headersEnd === -1) {
      throw createHttpError(400, "Malformed multipart payload");
    }

    const headers = body.subarray(position, headersEnd).toString("utf8");
    const dataStart = headersEnd + HEADER_SEPARATOR.length;
    const nextBoundary = body.indexOf(Buffer.from(`\r\n--${boundary}`), dataStart);

    if (nextBoundary === -1) {
      throw createHttpError(400, "Malformed multipart payload");
    }

    const content = body.subarray(dataStart, nextBoundary);
    position = nextBoundary + 2 + boundaryBuffer.length;

    const headerMap = {};

    for (const line of headers.split("\r\n")) {
      const separatorIndex = line.indexOf(":");

      if (separatorIndex === -1) {
        continue;
      }

      const key = line.slice(0, separatorIndex).trim().toLowerCase();
      const value = line.slice(separatorIndex + 1).trim();
      headerMap[key] = value;
    }

    const disposition = parseContentDisposition(headerMap["content-disposition"]);
    const originalName = disposition.filename;

    if (originalName !== undefined) {
      filePartCount += 1;

      if (filePartCount > 1) {
        throw createHttpError(400, "Only one file can be uploaded per request");
      }

      foundFile = {
        fieldName: disposition.name || "file",
        originalName,
        contentType: headerMap["content-type"] || getMimeType(originalName),
        buffer: content
      };
    }

    if (body[position] === 45 && body[position + 1] === 45) {
      break;
    }
  }

  if (!foundFile) {
    throw createHttpError(400, "Multipart request did not include a file");
  }

  if (foundFile.buffer.length > MAX_FILE_SIZE) {
    throw createHttpError(413, "Uploaded file exceeds size limit");
  }

  return foundFile;
}

function readRequestBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalLength = 0;

    req.on("data", (chunk) => {
      totalLength += chunk.length;

      if (totalLength > limit) {
        reject(createHttpError(413, "Request body too large"));
        req.destroy();
        return;
      }

      chunks.push(chunk);
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks));
    });

    req.on("error", (error) => {
      reject(error);
    });

    req.on("aborted", () => {
      reject(createHttpError(400, "Request aborted"));
    });
  });
}

function formatUploadTime(stats) {
  const timestamp = stats.birthtimeMs > 0 ? stats.birthtime : stats.mtime;
  return timestamp.toISOString();
}

function buildStoredFileMetadata(fileName, stats, contentType) {
  return {
    name: fileName,
    size: stats.size,
    type: contentType || getMimeType(fileName),
    uploadTime: formatUploadTime(stats)
  };
}

function getRequestedFileName(rawName) {
  let decodedName;

  try {
    decodedName = decodeURIComponent(String(rawName || ""));
  } catch (error) {
    return null;
  }

  if (!decodedName || decodedName.includes("\0")) {
    return null;
  }

  const normalized = path.basename(decodedName);

  if (normalized !== decodedName) {
    return null;
  }

  return sanitizeUploadedName(normalized);
}

function getContentLength(req) {
  const header = req.headers["content-length"];

  if (header === undefined) {
    return null;
  }

  const parsed = Number(header);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : NaN;
}

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

  if (!resolvedPath.startsWith(`${WEB_ROOT}${path.sep}`) && resolvedPath !== WEB_ROOT) {
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

  const fileMetadata = new Map();

  function syncStoredFiles() {
    ensureDirectory(UPLOADS_DIR);

    const seenFileNames = new Set();
    const entries = fs.readdirSync(UPLOADS_DIR, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }

      const fileName = entry.name;
      const filePath = path.resolve(UPLOADS_DIR, fileName);
      const stats = fs.statSync(filePath);
      const existing = fileMetadata.get(fileName);

      fileMetadata.set(fileName, buildStoredFileMetadata(fileName, stats, existing?.type));
      seenFileNames.add(fileName);
    }

    for (const fileName of fileMetadata.keys()) {
      if (!seenFileNames.has(fileName)) {
        fileMetadata.delete(fileName);
      }
    }
  }

  function listAvailableFiles() {
    syncStoredFiles();

    return [...fileMetadata.values()].sort(
      (left, right) => new Date(right.uploadTime).getTime() - new Date(left.uploadTime).getTime()
    );
  }

  function resolveStoredFilePath(fileName) {
    const resolvedPath = path.resolve(UPLOADS_DIR, fileName);

    if (!resolvedPath.startsWith(`${UPLOADS_DIR}${path.sep}`)) {
      throw createHttpError(400, "Invalid file name");
    }

    return resolvedPath;
  }

  function getDownloadUrl(fileName) {
    return `${FILE_PATH_PREFIX}${encodeURIComponent(fileName)}`;
  }

  function findFileMetadata(fileName) {
    syncStoredFiles();
    return fileMetadata.get(fileName) || null;
  }

  function createUniqueFileName(originalName) {
    const extension = path.extname(originalName);
    const baseName = path.basename(originalName, extension);
    let candidate = originalName;
    let suffix = 1;

    while (fs.existsSync(resolveStoredFilePath(candidate))) {
      candidate = `${baseName} (${suffix})${extension}`;
      suffix += 1;
    }

    return candidate;
  }

  async function handleFileUpload(req, res) {
    const contentType = req.headers["content-type"];
    const boundary = parseMultipartBoundary(contentType);
    const contentLength = getContentLength(req);

    if (!String(contentType || "").toLowerCase().startsWith("multipart/form-data") || !boundary) {
      throw createHttpError(400, "Content-Type must be multipart/form-data with a boundary");
    }

    if (Number.isNaN(contentLength)) {
      throw createHttpError(400, "Invalid Content-Length header");
    }

    if (contentLength !== null && contentLength > MAX_MULTIPART_BODY_SIZE) {
      throw createHttpError(413, "Request body too large");
    }

    const body = await readRequestBody(req, MAX_MULTIPART_BODY_SIZE);
    const file = parseMultipartFile(body, boundary);
    const sanitizedName = sanitizeUploadedName(file.originalName);

    if (!sanitizedName) {
      throw createHttpError(400, "Invalid uploaded file name");
    }

    const storedName = createUniqueFileName(sanitizedName);
    const filePath = resolveStoredFilePath(storedName);
    let stats;

    try {
      fs.writeFileSync(filePath, file.buffer, { flag: "wx" });
      stats = fs.statSync(filePath);
    } catch (error) {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }

      throw createHttpError(500, "Failed to store uploaded file");
    }

    const metadata = buildStoredFileMetadata(storedName, stats, file.contentType);
    fileMetadata.set(storedName, metadata);

    broadcast({
      type: "fileUpload",
      file: metadata,
      url: getDownloadUrl(metadata.name)
    });

    sendJsonResponse(res, 201, {
      ok: true,
      file: metadata,
      url: getDownloadUrl(metadata.name)
    });
  }

  function handleFileList(res) {
    sendJsonResponse(res, 200, listAvailableFiles());
  }

  function handleFileDownload(res, rawName) {
    const requestedName = getRequestedFileName(rawName);

    if (!requestedName) {
      throw createHttpError(400, "Invalid file name");
    }

    const metadata = findFileMetadata(requestedName);

    if (!metadata) {
      throw createHttpError(404, "File not found");
    }

    const filePath = resolveStoredFilePath(metadata.name);
    const stream = fs.createReadStream(filePath);

    stream.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      }

      res.end("Failed to read file");
    });

    res.writeHead(200, {
      "Content-Length": metadata.size,
      "Content-Type": metadata.type || "application/octet-stream",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(metadata.name)}`,
      "X-Content-Type-Options": "nosniff"
    });

    stream.pipe(res);
  }

  async function handleRequest(req, res) {
    const parsedUrl = new URL(req.url || "/", "http://127.0.0.1");

    if (req.method === "GET" && parsedUrl.pathname === "/health") {
      sendJsonResponse(res, 200, { ok: true, latestText, updatedAt });
      return;
    }

    if (req.method === "GET" && parsedUrl.pathname === "/discovery") {
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

    if (req.method === "POST" && parsedUrl.pathname === "/upload") {
      await handleFileUpload(req, res);
      return;
    }

    if (req.method === "GET" && parsedUrl.pathname === "/files") {
      handleFileList(res);
      return;
    }

    if (req.method === "GET" && parsedUrl.pathname.startsWith(FILE_PATH_PREFIX)) {
      const rawName = parsedUrl.pathname.slice(FILE_PATH_PREFIX.length);

      if (rawName) {
        handleFileDownload(res, rawName);
        return;
      }
    }

    if (
      req.method === "OPTIONS" &&
      (
        parsedUrl.pathname === "/upload" ||
        parsedUrl.pathname === "/files" ||
        parsedUrl.pathname.startsWith(FILE_PATH_PREFIX)
      )
    ) {
      res.writeHead(204, {
        "Access-Control-Allow-Methods": parsedUrl.pathname === "/upload" ? "POST, OPTIONS" : "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Content-Length": "0"
      });
      res.end();
      return;
    }

    if (
      parsedUrl.pathname === "/files" ||
      parsedUrl.pathname === "/upload" ||
      parsedUrl.pathname.startsWith(FILE_PATH_PREFIX)
    ) {
      res.writeHead(405, {
        "Allow": parsedUrl.pathname === "/upload" ? "POST, OPTIONS" : "GET, OPTIONS",
        "Content-Type": "application/json; charset=utf-8"
      });
      res.end(JSON.stringify({ ok: false, message: "Method not allowed" }));
      return;
    }

    sendStaticFile(res, req.url || "/");
  }

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
    handleRequest(req, res).catch((error) => {
      const statusCode = Number(error?.statusCode) || 500;
      const message = statusCode >= 500 ? "Internal server error" : error.message;

      if (!res.headersSent) {
        sendJsonResponse(res, statusCode, {
          ok: false,
          message
        });
        return;
      }

      res.end();
    });
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

  function sendAvailableFiles(socket) {
    sendJson(socket, {
      type: "fileList",
      files: listAvailableFiles().map((file) => ({
        ...file,
        url: getDownloadUrl(file.name)
      }))
    });
  }

  function sendFileDownload(socket, fileName) {
    if (typeof fileName !== "string") {
      sendJson(socket, {
        type: "error",
        message: "Invalid file name"
      });
      return;
    }

    const requestedName = getRequestedFileName(fileName);

    if (!requestedName) {
      sendJson(socket, {
        type: "error",
        message: "Invalid file name"
      });
      return;
    }

    const metadata = findFileMetadata(requestedName);

    if (!metadata) {
      sendJson(socket, {
        type: "error",
        message: "File not found"
      });
      return;
    }

    sendJson(socket, {
      type: "fileDownload",
      file: metadata,
      url: getDownloadUrl(metadata.name)
    });
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

      if (message.type === "fileList") {
        sendAvailableFiles(socket);
        return;
      }

      if (message.type === "fileDownload") {
        sendFileDownload(socket, message.name);
        return;
      }

      if (message.type === "fileUpload") {
        sendJson(socket, {
          type: "fileUpload",
          ok: true,
          upload: {
            endpoint: "/upload",
            method: "POST",
            contentType: "multipart/form-data",
            maxFileSize: MAX_FILE_SIZE
          }
        });
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
    syncStoredFiles();

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
