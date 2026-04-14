const test = require("node:test");
const assert = require("node:assert/strict");
const { Writable } = require("node:stream");

const {
  MDNS_SERVICE_TYPE,
  MDNS_SERVICE_NAME,
  buildDiscoveryPayload,
  sendStaticFile
} = require("../server/index.js");

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
