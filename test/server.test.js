const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Writable } = require("node:stream");

const {
  MDNS_SERVICE_TYPE,
  MDNS_SERVICE_NAME,
  SHARED_FILES_DIR,
  buildFileDownloadMessage,
  buildFileListMessage,
  buildFileUploadBroadcastMessage,
  buildFileUploadDescriptorMessage,
  buildInitMessage,
  buildDiscoveryPayload,
  createApp,
  sendStaticFile
} = require("../server/index.js");

const { WebSocket } = globalThis;

class MockResponse extends Writable {
  constructor() {
    super();
    this.statusCode = null;
    this.headers = {};
    this.body = "";
  }

  writeHead(statusCode, headers) {
    this.statusCode = statusCode;
    this.headers = headers;
  }

  _write(chunk, encoding, callback) {
    this.body += chunk.toString();
    callback();
  }

  end(chunk) {
    if (chunk) {
      this.body += chunk.toString();
    }

    super.end();
  }
}

test("buildDiscoveryPayload includes Bonjour metadata and websocket targets", () => {
  const payload = buildDiscoveryPayload({
    req: {
      socket: {
        encrypted: false
      }
    },
    httpPort: 8080,
    discoveryPort: 41234,
    mdnsHostname: "clipboard-share.local",
    latestText: "hello",
    updatedAt: "2026-04-14T00:00:00.000Z"
  });

  assert.equal(payload.ok, true);
  assert.equal(payload.discovery.magic, "lan-clipboard-discovery");
  assert.equal(payload.mdns.name, MDNS_SERVICE_NAME);
  assert.equal(payload.mdns.hostname, "clipboard-share.local");
  assert.equal(payload.mdns.serviceType, MDNS_SERVICE_TYPE);
  assert.deepEqual(payload.mdns.websocketUrls, ["ws://clipboard-share.local:8080"]);
});

test("sendStaticFile serves the web entrypoint", async () => {
  const response = new MockResponse();

  sendStaticFile(response, "/");

  await new Promise((resolve) => response.on("finish", resolve));

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["Content-Type"], "text/html; charset=utf-8");
  assert.match(response.body, /Shared Clipboard/);
  assert.match(response.body, /discovery\.js/);
});

test("file sharing message builders return consistent config and urls", () => {
  const metadata = {
    name: "demo file.txt",
    size: 42,
    type: "text/plain",
    uploadTime: "2026-04-15T00:00:00.000Z"
  };

  const fileListMessage = buildFileListMessage([metadata]);
  const fileUploadMessage = buildFileUploadBroadcastMessage(metadata);
  const fileDownloadMessage = buildFileDownloadMessage(metadata);
  const uploadDescriptorMessage = buildFileUploadDescriptorMessage();
  const initMessage = buildInitMessage({
    text: "shared text",
    updatedAt: "2026-04-15T00:00:00.000Z"
  });

  assert.equal(fileListMessage.type, "fileList");
  assert.equal(fileListMessage.files[0].url, "/files/demo%20file.txt");
  assert.equal(fileListMessage.config.listEndpoint, "/files");
  assert.equal(fileListMessage.config.upload.endpoint, "/upload");

  assert.equal(fileUploadMessage.type, "fileUpload");
  assert.equal(fileUploadMessage.file.url, "/files/demo%20file.txt");
  assert.equal(fileUploadMessage.url, "/files/demo%20file.txt");
  assert.equal(fileUploadMessage.config.pathPrefix, "/files/");

  assert.equal(fileDownloadMessage.type, "fileDownload");
  assert.equal(fileDownloadMessage.file.url, "/files/demo%20file.txt");
  assert.equal(fileDownloadMessage.url, "/files/demo%20file.txt");

  assert.equal(uploadDescriptorMessage.type, "fileUpload");
  assert.equal(uploadDescriptorMessage.ok, true);
  assert.equal(uploadDescriptorMessage.upload.fieldName, "file");
  assert.equal(uploadDescriptorMessage.config.upload.method, "POST");

  assert.equal(initMessage.type, "init");
  assert.equal(initMessage.text, "shared text");
  assert.deepEqual(initMessage.fileConfig, initMessage.files);
});

test("HTTP file sharing endpoints upload, list, and download shared files", async () => {
  fs.mkdirSync(SHARED_FILES_DIR, { recursive: true });

  const uniqueName = `test-upload-${Date.now()}.txt`;
  const storedPath = path.join(SHARED_FILES_DIR, uniqueName);
  const app = createApp({
    port: 0,
    host: "127.0.0.1",
    enableMdns: false,
    enableUdpDiscovery: false
  });

  try {
    const info = await app.start();

    const baseUrl = `http://127.0.0.1:${info.httpPort}`;
    const formData = new FormData();

    formData.append("file", new Blob(["hello from test"]), uniqueName);

    const uploadResponse = await fetch(`${baseUrl}/upload`, {
      method: "POST",
      body: formData
    });
    const uploadPayload = await uploadResponse.json();

    assert.equal(uploadResponse.status, 201);
    assert.equal(uploadPayload.ok, true);
    assert.equal(uploadPayload.file.name, uniqueName);
    assert.equal(uploadPayload.url, `/files/${encodeURIComponent(uniqueName)}`);
    assert.equal(fs.existsSync(storedPath), true);

    const listResponse = await fetch(`${baseUrl}/files`);
    const listPayload = await listResponse.json();
    const uploadedFile = listPayload.find((entry) => entry.name === uniqueName);

    assert.equal(listResponse.status, 200);
    assert.equal(listResponse.headers.get("access-control-expose-headers"), "Content-Disposition, Content-Length, Content-Type");
    assert.ok(uploadedFile);
    assert.equal(uploadedFile.url, `/files/${encodeURIComponent(uniqueName)}`);

    const downloadResponse = await fetch(`${baseUrl}${uploadPayload.url}`);
    const downloadedText = await downloadResponse.text();

    assert.equal(downloadResponse.status, 200);
    assert.equal(downloadedText, "hello from test");
    assert.equal(downloadResponse.headers.get("access-control-allow-origin"), "*");
    assert.equal(downloadResponse.headers.get("access-control-expose-headers"), "Content-Disposition, Content-Length, Content-Type");
    assert.match(
      downloadResponse.headers.get("content-disposition") || "",
      new RegExp(encodeURIComponent(uniqueName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    );
  } finally {
    await app.stop().catch(() => {});

    if (fs.existsSync(storedPath)) {
      fs.unlinkSync(storedPath);
    }
  }
});

test("WebSocket file sharing messages expose list, upload descriptor, and download path", async () => {
  fs.mkdirSync(SHARED_FILES_DIR, { recursive: true });

  const uniqueName = `test-ws-file-${Date.now()}.txt`;
  const storedPath = path.join(SHARED_FILES_DIR, uniqueName);
  fs.writeFileSync(storedPath, "websocket payload");

  const app = createApp({
    port: 0,
    host: "127.0.0.1",
    enableMdns: false,
    enableUdpDiscovery: false
  });

  try {
    const info = await app.start();
    const ws = new WebSocket(`ws://127.0.0.1:${info.httpPort}`);
    const received = [];

    ws.on("message", (raw) => {
      received.push(JSON.parse(String(raw)));
    });

    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    await waitForMessage(received, (message) => message.type === "init");

    ws.send(JSON.stringify({ type: "fileList" }));
    const fileListMessage = await waitForMessage(received, (message) => message.type === "fileList");
    const listedFile = fileListMessage.files.find((entry) => entry.name === uniqueName);

    assert.ok(listedFile);
    assert.equal(listedFile.url, `/files/${encodeURIComponent(uniqueName)}`);

    ws.send(JSON.stringify({ type: "fileUpload" }));
    const fileUploadMessage = await waitForMessage(
      received,
      (message) => message.type === "fileUpload" && message.ok === true && message.upload?.endpoint === "/upload"
    );

    assert.equal(fileUploadMessage.upload.method, "POST");
    assert.equal(fileUploadMessage.upload.fieldName, "file");

    ws.send(JSON.stringify({ type: "fileDownload", name: uniqueName }));
    const fileDownloadMessage = await waitForMessage(
      received,
      (message) => message.type === "fileDownload" && message.file?.name === uniqueName
    );

    assert.equal(fileDownloadMessage.url, `/files/${encodeURIComponent(uniqueName)}`);
    ws.close();
  } finally {
    await app.stop().catch(() => {});

    if (fs.existsSync(storedPath)) {
      fs.unlinkSync(storedPath);
    }
  }
});

test("HTTP uploads broadcast file announcements to connected WebSocket clients", async () => {
  fs.mkdirSync(SHARED_FILES_DIR, { recursive: true });

  const uniqueName = `test-broadcast-${Date.now()}.txt`;
  const storedPath = path.join(SHARED_FILES_DIR, uniqueName);
  const app = createApp({
    port: 0,
    host: "127.0.0.1",
    enableMdns: false,
    enableUdpDiscovery: false
  });

  try {
    const info = await app.start();
    const baseUrl = `http://127.0.0.1:${info.httpPort}`;
    const wsA = new WebSocket(`ws://127.0.0.1:${info.httpPort}`);
    const wsB = new WebSocket(`ws://127.0.0.1:${info.httpPort}`);
    const receivedA = [];
    const receivedB = [];

    wsA.on("message", (raw) => {
      receivedA.push(JSON.parse(String(raw)));
    });

    wsB.on("message", (raw) => {
      receivedB.push(JSON.parse(String(raw)));
    });

    await Promise.all([
      new Promise((resolve, reject) => {
        wsA.once("open", resolve);
        wsA.once("error", reject);
      }),
      new Promise((resolve, reject) => {
        wsB.once("open", resolve);
        wsB.once("error", reject);
      })
    ]);

    await Promise.all([
      waitForMessage(receivedA, (message) => message.type === "init"),
      waitForMessage(receivedB, (message) => message.type === "init")
    ]);

    const formData = new FormData();
    formData.append("file", new Blob(["broadcast payload"]), uniqueName);

    const uploadResponse = await fetch(`${baseUrl}/upload`, {
      method: "POST",
      body: formData
    });
    const uploadPayload = await uploadResponse.json();

    assert.equal(uploadResponse.status, 201);
    assert.equal(uploadPayload.file.name, uniqueName);

    const broadcastMessage = await waitForMessage(
      receivedB,
      (message) => message.type === "fileUpload" && message.file?.name === uniqueName
    );
    const fileListMessage = await waitForMessage(
      receivedB,
      (message) => message.type === "fileList" && message.files?.some((entry) => entry.name === uniqueName)
    );

    assert.equal(broadcastMessage.file.url, `/files/${encodeURIComponent(uniqueName)}`);
    assert.equal(fileListMessage.config.listEndpoint, "/files");

    wsA.close();
    wsB.close();
  } finally {
    await app.stop().catch(() => {});

    if (fs.existsSync(storedPath)) {
      fs.unlinkSync(storedPath);
    }
  }
});

function waitForMessage(messages, predicate, timeoutMs = 2000) {
  const existingMatch = messages.find(predicate);

  if (existingMatch) {
    return Promise.resolve(existingMatch);
  }

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const intervalId = setInterval(() => {
      const match = messages.find(predicate);

      if (match) {
        clearInterval(intervalId);
        clearTimeout(timeoutId);
        resolve(match);
        return;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(intervalId);
        clearTimeout(timeoutId);
        reject(new Error("Timed out waiting for WebSocket message"));
      }
    }, 10);

    const timeoutId = setTimeout(() => {
      clearInterval(intervalId);
      reject(new Error("Timed out waiting for WebSocket message"));
    }, timeoutMs);
  });
}
