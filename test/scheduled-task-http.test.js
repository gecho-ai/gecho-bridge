const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const WebSocket = require("ws");

const ROOT = path.resolve(__dirname, "..");

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = address.port;
      probe.close(() => resolve(port));
    });
  });
}

function requestJson(port, method, requestPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const request = http.request({
      host: "127.0.0.1",
      port,
      method,
      path: requestPath,
      headers: {
        ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
        ...headers
      }
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => {
        let parsed = {};
        try { parsed = text ? JSON.parse(text) : {}; } catch (_error) { parsed = { raw: text }; }
        resolve({ statusCode: response.statusCode, headers: response.headers, body: parsed });
      });
    });
    request.once("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}

async function waitForPing(port, child) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < 5000) {
    if (child.exitCode !== null) {
      throw new Error(`Bridge exited before ready: ${lastError?.message || "unknown error"}`);
    }
    try {
      const response = await requestJson(port, "GET", "/ping");
      if (response.statusCode === 200) return response;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Bridge did not become ready: ${lastError?.message || "timeout"}`);
}

async function startBridge(dataDir, httpPort, wsPort) {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      GECHO_DATA_DIR: dataDir,
      GECHO_HTTP_PORT: String(httpPort),
      GECHO_WS_PORT: String(wsPort),
      GECHO_BROWSER: "chrome",
      GECHO_AUTO_LAUNCH_BROWSER: "0",
      GECHO_AUTO_OPEN_ONBOARDING_ON_FIRST_START: "0",
      GECHO_EXTENSION_CONNECT_TIMEOUT_MS: "1000",
      GECHO_EXTENSION_RECONNECT_PROBE_TIMEOUT_MS: "1000",
      GECHO_EXTENSION_READY_GRACE_MS: "0",
      GECHO_SCHEDULED_TRIGGER_TIMEOUT_MS: "2000",
      GECHO_SCHEDULED_ALLOWED_ORIGINS: "https://gecho.ai"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  try {
    await waitForPing(httpPort, child);
  } catch (error) {
    child.kill("SIGTERM");
    throw new Error(`${error.message}\n${output}`);
  }
  return { child, getOutput: () => output };
}

async function stopBridge(child, httpPort) {
  if (child.exitCode === null) {
    try { await requestJson(httpPort, "POST", "/shutdown"); } catch (_error) {}
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGTERM");
        resolve();
      }, 2000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

function createTask(overrides = {}) {
  return {
    taskRef: "flywheel-http-123",
    taskVersion: 3,
    entryUrl: "https://gecho.ai/flywheel/tasks/flywheel-http-123",
    schedule: { type: "daily", time: "09:00", timezone: "Asia/Shanghai" },
    enabled: true,
    ...overrides
  };
}

test("scheduled HTTP API supports website upsert, CORS protection, manual trigger and restart recovery", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gecho-scheduled-http-"));
  const httpPort = await getFreePort();
  const wsPort = await getFreePort();
  let bridge;
  let extension;

  try {
    bridge = await startBridge(dataDir, httpPort, wsPort);

    const denied = await requestJson(httpPort, "PUT", "/scheduled-jobs/task-ref/flywheel-http-123", createTask(), {
      Origin: "https://malicious.example"
    });
    assert.equal(denied.statusCode, 403);

    const first = await requestJson(
      httpPort,
      "PUT",
      "/scheduled-jobs/task-ref/flywheel-http-123",
      createTask(),
      { Origin: "https://gecho.ai" }
    );
    assert.equal(first.statusCode, 201);
    assert.equal(first.body.created, true);
    assert.equal(first.body.job.taskRef, "flywheel-http-123");

    const second = await requestJson(
      httpPort,
      "PUT",
      "/scheduled-jobs/task-ref/flywheel-http-123",
      createTask({ taskVersion: 4 }),
      { Origin: "https://gecho.ai" }
    );
    assert.equal(second.statusCode, 200);
    assert.equal(second.body.created, false);
    assert.equal(second.body.job.taskVersion, 4);
    const jobId = second.body.job.id;

    extension = new WebSocket(`ws://127.0.0.1:${wsPort}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36"
      }
    });
    const received = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("did not receive flywheel trigger")), 2000);
      extension.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.method !== "execute_action") return;
        clearTimeout(timer);
        resolve(message);
        extension.send(JSON.stringify({
          method: "action_result",
          requestId: message.requestId,
          data: { accepted: true }
        }));
      });
      extension.on("error", reject);
    });
    await new Promise((resolve, reject) => {
      extension.once("open", resolve);
      extension.once("error", reject);
    });

    const runResponsePromise = requestJson(
      httpPort,
      "POST",
      `/scheduled-jobs/${encodeURIComponent(jobId)}/run`,
      {},
      { Origin: "https://gecho.ai" }
    );
    const trigger = await received;
    assert.equal(trigger.params.action, "start_flywheel_task");
    assert.equal(trigger.params.params.taskRef, "flywheel-http-123");
    assert.equal(trigger.params.params.taskVersion, 4);
    assert.ok(trigger.params.params.triggerId);
    const runResponse = await runResponsePromise;
    assert.equal(runResponse.statusCode, 200);
    assert.equal(runResponse.body.success, true);
    assert.equal(runResponse.body.run.status, "dispatched");

    const runs = await requestJson(
      httpPort,
      "GET",
      `/scheduled-jobs/${encodeURIComponent(jobId)}/runs`,
      undefined,
      { Origin: "https://gecho.ai" }
    );
    assert.equal(runs.statusCode, 200);
    assert.equal(runs.body.runs.length, 1);

    await stopBridge(bridge.child, httpPort);
    bridge = await startBridge(dataDir, httpPort, wsPort);
    const restored = await requestJson(
      httpPort,
      "GET",
      "/scheduled-jobs",
      undefined,
      { Origin: "https://gecho.ai" }
    );
    assert.equal(restored.statusCode, 200);
    assert.equal(restored.body.jobs.length, 1);
    assert.equal(restored.body.jobs[0].taskRef, "flywheel-http-123");
    assert.equal(restored.body.jobs[0].taskVersion, 4);
    assert.equal(restored.body.jobs[0].runCount, 1);
  } finally {
    extension?.close();
    if (bridge) await stopBridge(bridge.child, httpPort);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Bridge automatically dispatches a one-time task at its scheduled time", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gecho-scheduled-auto-"));
  const httpPort = await getFreePort();
  const wsPort = await getFreePort();
  let bridge;
  let extension;

  try {
    bridge = await startBridge(dataDir, httpPort, wsPort);
    extension = new WebSocket(`ws://127.0.0.1:${wsPort}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36"
      }
    });
    const trigger = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("scheduled trigger was not sent")), 4000);
      extension.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.method !== "execute_action") return;
        if (message.params?.params?.taskRef !== "flywheel-auto-123") return;
        clearTimeout(timer);
        extension.send(JSON.stringify({
          method: "action_result",
          requestId: message.requestId,
          data: { accepted: true }
        }));
        resolve(message);
      });
      extension.on("error", reject);
    });
    await new Promise((resolve, reject) => {
      extension.once("open", resolve);
      extension.once("error", reject);
    });

    const response = await requestJson(
      httpPort,
      "PUT",
      "/scheduled-jobs/task-ref/flywheel-auto-123",
      createTask({
        taskRef: "flywheel-auto-123",
        entryUrl: "https://gecho.ai/flywheel/tasks/flywheel-auto-123",
        schedule: { type: "once", runAt: new Date(Date.now() + 700).toISOString() }
      }),
      { Origin: "https://gecho.ai" }
    );
    assert.equal(response.statusCode, 201);
    const message = await trigger;
    assert.equal(message.params.action, "start_flywheel_task");
    assert.equal(message.params.params.taskRef, "flywheel-auto-123");
  } finally {
    extension?.close();
    if (bridge) await stopBridge(bridge.child, httpPort);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
