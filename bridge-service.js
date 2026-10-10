#!/usr/bin/env node

"use strict";

const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const packageJson = require("./package.json");
const { getDefaultDataDir } = require("./data-dir");
const {
  getStartupStatus,
  installStartup,
  uninstallStartup
} = require("./bridge-startup");

const { getServiceBaseUrl, isBridgeInfo } = require("./service-discovery");
const SERVICE_PATH = path.join(__dirname, "server.js");
const SERVICE_PROTOCOL_VERSION = 2;
const START_TIMEOUT_MS = Math.max(1000, Number(process.env.GECHO_SERVICE_START_TIMEOUT_MS || 10000));
const POLL_INTERVAL_MS = 200;

function requestJson(requestPath, method = "GET") {
  return new Promise((resolve) => {
    const request = http.request(`${getServiceBaseUrl()}${requestPath}`, { method }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        let parsed = {};
        try { parsed = JSON.parse(body || "{}"); } catch (_error) {}
        resolve({
          ok: response.statusCode >= 200 && response.statusCode < 300,
          statusCode: response.statusCode || 0,
          body: parsed
        });
      });
    });
    request.on("error", () => resolve({ ok: false, statusCode: 0, body: {} }));
    request.setTimeout(800, () => {
      request.destroy();
      resolve({ ok: false, statusCode: 0, body: {} });
    });
    request.end();
  });
}

function expectedDataDir() {
  return path.resolve(process.env.GECHO_DATA_DIR || getDefaultDataDir());
}

function isCompatibleService(info) {
  if (!info || info.status !== "ok") return false;
  if (Number(info.serviceProtocolVersion || 0) !== SERVICE_PROTOCOL_VERSION) return false;
  if (info.packageVersion && info.packageVersion !== packageJson.version) return false;
  return !info.dataDir || path.resolve(String(info.dataDir)) === expectedDataDir();
}

async function getServiceInfo() {
  const response = await requestJson("/ping");
  return response.ok && isBridgeInfo(response.body) ? response.body : null;
}

async function waitForService({ running = true, timeoutMs = START_TIMEOUT_MS } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const info = await getServiceInfo();
    if (running ? isCompatibleService(info) : !info) return info;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return null;
}

async function stopService() {
  const info = await getServiceInfo();
  if (!info) return { status: "not running" };

  await requestJson("/shutdown", "POST");
  const stopped = await waitForService({ running: false });
  if (stopped === null && Number.isInteger(Number(info.pid)) && Number(info.pid) > 0) {
    try { process.kill(Number(info.pid), "SIGTERM"); } catch (_error) {}
    await waitForService({ running: false, timeoutMs: 3000 });
  }
  return { status: "stopped", pid: info.pid || null };
}

async function startService() {
  const current = await getServiceInfo();
  if (isCompatibleService(current)) {
    return { status: "already running", pid: current.pid || null };
  }
  if (current) await stopService();

  const child = spawn(process.execPath, [SERVICE_PATH], {
    cwd: __dirname,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  const started = await waitForService();
  if (!started) {
    const error = new Error("Bridge service did not become ready");
    error.code = "BRIDGE_SERVICE_START_FAILED";
    throw error;
  }
  return { status: "started", pid: started.pid || child.pid || null };
}

async function printStatus() {
  const info = await getServiceInfo();
  if (info) {
    process.stdout.write(`${JSON.stringify(info)}\n`);
    return true;
  }
  process.stdout.write(`${JSON.stringify({ status: "not running", url: getServiceBaseUrl() })}\n`);
  return false;
}

function printUsage() {
  process.stdout.write([
    "Usage: gecho-bridge-server <start|status|stop|restart|install|uninstall|startup-status>",
    "",
    "  start    Start the standalone local Bridge service",
    "  status   Print Bridge health and scheduler status",
    "  stop     Stop the local Bridge service",
    "  restart  Restart the local Bridge service",
    "  install  Install a user-level login startup entry",
    "  uninstall Remove the user-level login startup entry",
    "  startup-status  Print login startup configuration status",
    ""
  ].join("\n"));
}

async function main(argv = process.argv.slice(2)) {
  const command = String(argv[0] || "start").trim().toLowerCase();
  if (command === "status") {
    const running = await printStatus();
    process.exitCode = running ? 0 : 1;
    return;
  }
  if (command === "start") {
    process.stdout.write(`${JSON.stringify(await startService())}\n`);
    return;
  }
  if (command === "stop") {
    process.stdout.write(`${JSON.stringify(await stopService())}\n`);
    return;
  }
  if (command === "restart") {
    await stopService();
    process.stdout.write(`${JSON.stringify(await startService())}\n`);
    return;
  }
  if (command === "install") {
    process.stdout.write(`${JSON.stringify(installStartup())}\n`);
    return;
  }
  if (command === "uninstall") {
    process.stdout.write(`${JSON.stringify(uninstallStartup())}\n`);
    return;
  }
  if (command === "startup-status") {
    const status = getStartupStatus();
    process.stdout.write(`${JSON.stringify(status)}\n`);
    process.exitCode = status.configured ? 0 : 1;
    return;
  }
  printUsage();
  process.exitCode = 2;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`gecho-bridge-server: ${error.message || error}`);
    process.exitCode = 1;
  });
}

module.exports = {
  getServiceInfo,
  isCompatibleService,
  main,
  startService,
  stopService
};
