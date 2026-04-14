const { spawn } = require("child_process");
const path = require("path");

const rootCwd = path.resolve(__dirname, "..");
const serverCwd = path.resolve(rootCwd, "server");
const webCwd = path.resolve(rootCwd, "web");
const WEB_PORT = Number(process.env.WEB_PORT || 8001);

function getNpmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function getPythonCommand() {
  return process.platform === "win32" ? "py" : "python3";
}

function startProcess(command, args, cwd) {
  return spawn(command, args, {
    cwd,
    stdio: "inherit"
  });
}

async function main() {
  console.log(`Starting Node server from ${serverCwd}`);
  console.log(`Starting Python web server from ${webCwd}`);

  const serverProcess = startProcess(getNpmCommand(), ["start"], serverCwd);
  const webProcess = startProcess(
    getPythonCommand(),
    ["-m", "http.server", String(WEB_PORT), "--directory", webCwd],
    rootCwd
  );

  let shuttingDown = false;

  function shutdown(signal) {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;

    if (!serverProcess.killed) {
      serverProcess.kill(signal);
    }

    if (!webProcess.killed) {
      webProcess.kill(signal);
    }
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  serverProcess.on("exit", (code, signal) => {
    shutdown("SIGTERM");
    process.exit(code ?? (signal ? 1 : 0));
  });

  webProcess.on("exit", (code, signal) => {
    shutdown("SIGTERM");
    process.exit(code ?? (signal ? 1 : 0));
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  getNpmCommand,
  getPythonCommand
};
