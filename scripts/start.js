const { spawn } = require("child_process");
const path = require("path");

const HEALTH_URL = process.env.START_URL || "http://127.0.0.1:8080/health";
const APP_URL = process.env.APP_URL || "http://127.0.0.1:8080";
const serverCwd = path.resolve(__dirname, "../server");

function getNpmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function getOpenCommand(url) {
  if (process.platform === "darwin") {
    return { command: "open", args: [url] };
  }

  if (process.platform === "win32") {
    return { command: "cmd", args: ["/c", "start", "", url] };
  }

  return { command: "xdg-open", args: [url] };
}

function shouldOpenBrowser() {
  const value = String(process.env.BROWSER || process.env.OPEN_BROWSER || "").trim().toLowerCase();
  return value !== "0" && value !== "false" && value !== "none";
}

async function waitForServer(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { cache: "no-store" });

      if (response.ok) {
        return true;
      }
    } catch (error) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      continue;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Server did not become ready within ${timeoutMs}ms`);
}

function openBrowser(url) {
  if (!shouldOpenBrowser()) {
    console.log(`Server is ready at ${url}`);
    return;
  }

  const { command, args } = getOpenCommand(url);
  const browser = spawn(command, args, {
    stdio: "ignore",
    detached: true
  });

  browser.on("error", () => {
    console.log(`Server is ready at ${url}`);
  });

  browser.unref();
}

async function main() {
  console.log("Starting LAN clipboard server and bundled web client...");

  const serverProcess = spawn(getNpmCommand(), ["start"], {
    cwd: serverCwd,
    stdio: "inherit"
  });

  let shuttingDown = false;

  function shutdown(signal) {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;

    if (!serverProcess.killed) {
      serverProcess.kill(signal);
    }
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  serverProcess.on("exit", (code, signal) => {
    process.exit(code ?? (signal ? 1 : 0));
  });

  try {
    await waitForServer(HEALTH_URL);
    openBrowser(APP_URL);
  } catch (error) {
    shutdown("SIGTERM");
    throw error;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  getNpmCommand,
  getOpenCommand,
  shouldOpenBrowser,
  waitForServer
};
