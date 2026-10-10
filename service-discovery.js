"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { getDefaultDataDir } = require("./data-dir");

function endpointPath(dataDir) {
  return path.join(dataDir || process.env.GECHO_DATA_DIR || getDefaultDataDir(), ".service-endpoint.json");
}

function validPort(port) {
  return Number.isInteger(Number(port)) && Number(port) > 0 && Number(port) <= 65535;
}

function getServiceBaseUrl({ dataDir, port = process.env.GECHO_HTTP_PORT } = {}) {
  if (port !== undefined && port !== "") {
    if (!validPort(port)) throw new Error("Invalid Bridge HTTP port");
    return `http://127.0.0.1:${Number(port)}`;
  }
  try {
    const record = JSON.parse(fs.readFileSync(endpointPath(dataDir), "utf8"));
    if (validPort(record.port)) return `http://127.0.0.1:${Number(record.port)}`;
  } catch (_) {}
  return "http://127.0.0.1:18793";
}

function getServiceEnvironment({ dataDir, env = process.env } = {}) {
  return { ...env, GECHO_HTTP_PORT: new URL(getServiceBaseUrl({ dataDir, port: env.GECHO_HTTP_PORT })).port };
}

function publishServiceEndpoint({ dataDir, port, pid = process.pid }) {
  if (!validPort(port)) throw new Error("Invalid Bridge HTTP port");
  const target = endpointPath(dataDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ port: Number(port), pid }), { mode: 0o600 });
  fs.renameSync(temporary, target);
}

function removeServiceEndpoint({ dataDir, pid = process.pid } = {}) {
  const target = endpointPath(dataDir);
  try {
    const record = JSON.parse(fs.readFileSync(target, "utf8"));
    if (record.pid === pid) fs.unlinkSync(target);
  } catch (_) {}
}

function isBridgeInfo(info) {
  return !!info && info.status === "ok" && info.serviceProtocolVersion === 2 &&
    typeof info.packageVersion === "string" && info.packageVersion.length > 0;
}

module.exports = { getServiceBaseUrl, getServiceEnvironment, publishServiceEndpoint, removeServiceEndpoint, isBridgeInfo };
