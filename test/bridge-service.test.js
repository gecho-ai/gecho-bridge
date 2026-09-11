const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

function runCli(command, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["bridge-service.js", command], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test("standalone Bridge service CLI can start, report status, restart and stop the server", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gecho-bridge-service-"));
  const httpPort = await getFreePort();
  const wsPort = await getFreePort();
  const env = {
    ...process.env,
    GECHO_DATA_DIR: dataDir,
    GECHO_HTTP_PORT: String(httpPort),
    GECHO_WS_PORT: String(wsPort),
    GECHO_BROWSER: "chrome",
    GECHO_AUTO_LAUNCH_BROWSER: "0",
    GECHO_AUTO_OPEN_ONBOARDING_ON_FIRST_START: "0",
    GECHO_SCHEDULED_ALLOWED_ORIGINS: "https://gecho.ai"
  };

  try {
    const started = await runCli("start", env);
    assert.equal(started.code, 0, started.stderr);
    assert.match(started.stdout, /started|already running/i);

    const status = await runCli("status", env);
    assert.equal(status.code, 0, status.stderr);
    const statusBody = JSON.parse(status.stdout);
    assert.equal(statusBody.status, "ok");
    assert.equal(statusBody.scheduler.triggerAction, "start_flywheel_task");

    const restarted = await runCli("restart", env);
    assert.equal(restarted.code, 0, restarted.stderr);
    const afterRestart = await runCli("status", env);
    assert.equal(afterRestart.code, 0, afterRestart.stderr);

    const stopped = await runCli("stop", env);
    assert.equal(stopped.code, 0, stopped.stderr);
    const afterStop = await runCli("status", env);
    assert.equal(afterStop.code, 1);
    assert.match(afterStop.stdout, /not running|unavailable/i);
  } finally {
    await runCli("stop", env);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
