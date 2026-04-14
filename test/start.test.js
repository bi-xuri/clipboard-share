const test = require("node:test");
const assert = require("node:assert/strict");

const { getOpenCommand } = require("../scripts/start.js");

test("getOpenCommand returns a usable command shape", () => {
  const command = getOpenCommand("http://127.0.0.1:8080");

  assert.equal(typeof command.command, "string");
  assert.ok(command.command.length > 0);
  assert.ok(Array.isArray(command.args));
  assert.ok(command.args.includes("http://127.0.0.1:8080"));
});
