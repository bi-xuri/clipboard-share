const test = require("node:test");
const assert = require("node:assert/strict");

test("extension discovery tries manual URL, mDNS, LAN metadata, then localhost", async () => {
  const module = await import("../extension/discovery.mjs");

  const candidates = module.buildExtensionConnectionCandidates({
    manualValue: "office-mac.local",
    discoveryPayload: {
      mdns: {
        hostname: "clipboard-share.local",
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
    "ws://clipboard-share.local:8080",
    "ws://192.168.1.15:8080",
    "ws://192.168.1.25:8080",
    "ws://localhost:8080"
  ]);
});
