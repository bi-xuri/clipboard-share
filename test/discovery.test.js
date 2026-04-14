const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_MDNS_HOSTNAME,
  buildAutomaticConnectionCandidates,
  buildConnectionCandidates,
  normalizeServerUrl
} = require("../web/discovery.js");

test("normalizeServerUrl accepts hostnames and http URLs", () => {
  assert.equal(normalizeServerUrl("192.168.1.10"), "ws://192.168.1.10:8080");
  assert.equal(normalizeServerUrl("http://clipboard-share.local"), "ws://clipboard-share.local:8080");
  assert.equal(DEFAULT_MDNS_HOSTNAME, "clipboard-share.local");
});

test("buildAutomaticConnectionCandidates tries mDNS before other LAN fallbacks", () => {
  const candidates = buildAutomaticConnectionCandidates({
    pageHostname: "localhost",
    protocol: "ws",
    discoveryPayload: {
      mdns: {
        websocketUrls: ["ws://bonjour-host.local:8080"]
      },
      websocket: {
        urls: ["ws://192.168.1.15:8080"]
      },
      interfaces: ["192.168.1.25"]
    }
  });

  assert.deepEqual(candidates, [
    "ws://bonjour-host.local:8080",
    `ws://${DEFAULT_MDNS_HOSTNAME}:8080`,
    "ws://192.168.1.15:8080",
    "ws://192.168.1.25:8080"
  ]);
});

test("buildConnectionCandidates prefers manual input and includes mDNS fallback", () => {
  const candidates = buildConnectionCandidates({
    manualValue: "office-mac.local",
    pageHostname: "localhost",
    protocol: "ws",
    discoveryPayload: {
      mdns: {
        websocketUrls: ["ws://bonjour-host.local:8080"]
      },
      websocket: {
        urls: ["ws://192.168.1.15:8080"]
      },
      interfaces: ["192.168.1.25"]
    }
  });

  assert.deepEqual(candidates, [
    "ws://office-mac.local:8080",
    "ws://bonjour-host.local:8080",
    `ws://${DEFAULT_MDNS_HOSTNAME}:8080`,
    "ws://192.168.1.15:8080",
    "ws://192.168.1.25:8080"
  ]);
});
