"use strict";
const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { spawn } = require("node:child_process");

function safeUpdateUrl(value) {
  const url = new URL(value);
  if (url.username || url.password || !(url.protocol === "https:" ||
      (url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("Updates require HTTPS (loopback test feeds excepted)");
  return url;
}
function safeAssetName(name) {
  if (!name || /[/\\\x00-\x1f]/.test(name) || name === "." || name === ".." || /[. ]$/.test(name)) throw new Error("Invalid installer filename");
  return name;
}
function openResponse(value, { timeoutMs = 10000, headers = {}, redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = safeUpdateUrl(value); } catch (error) { reject(error); return; }
    if (redirects > 5) { reject(new Error("Too many update redirects")); return; }
    const req = (url.protocol === "http:" ? http : https).get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url);
        if (url.protocol === "https:" && next.protocol !== "https:") { reject(new Error("Update redirect downgraded HTTPS")); return; }
        resolve(openResponse(next.href, { timeoutMs, headers, redirects: redirects + 1 })); return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        const error = new Error(`Update server returned HTTP ${res.statusCode}`);
        error.errorType = res.statusCode === 404 ? "NO_RELEASES" : res.statusCode === 403 ? "RATE_LIMIT" : "SERVER_ERROR";
        reject(error); return;
      }
      resolve(res);
    });
    req.once("error", (error) => { error.errorType ||= "OFFLINE"; reject(error); });
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error("Update request timed out"), { errorType: "TIMEOUT" })));
  });
}
async function fetchUpdateJson(url, options = {}, timeoutMs = 10000) {
  const res = await openResponse(url, { headers: options.headers, timeoutMs });
  let body = "", bytes = 0;
  for await (const chunk of res) {
    bytes += chunk.length;
    if (bytes > 2 * 1024 * 1024) { res.destroy(); throw new Error("Update feed is too large"); }
    body += chunk.toString("utf8");
  }
  return JSON.parse(body);
}
async function downloadFile(url, target, { size, onProgress, headers } = {}) {
  let res;
  try {
    res = await openResponse(url, { timeoutMs: 60000, headers });
    const totalBytes = Number(res.headers["content-length"]) || size || 0;
    const maxBytes = 512 * 1024 * 1024;
    if (totalBytes > maxBytes) throw new Error("Installer exceeds 512MB limit");
    let transferredBytes = 0;
    const progress = new Transform({ transform(chunk, _encoding, callback) {
      transferredBytes += chunk.length;
      if (transferredBytes > maxBytes) { callback(new Error("Installer exceeds 512MB limit")); return; }
      onProgress?.({ transferredBytes, totalBytes, percent: totalBytes ? Math.min(100, transferredBytes / totalBytes * 100) : 0 });
      callback(null, chunk);
    } });
    await pipeline(res, progress, fs.createWriteStream(target, { flags: "wx", mode: 0o600 }));
    if (totalBytes && transferredBytes !== totalBytes) throw new Error("Truncated installer download");
    return { transferredBytes, totalBytes };
  } catch (error) {
    res?.destroy();
    try { fs.unlinkSync(target); } catch (_) {}
    throw error;
  }
}
async function launchInstaller(file, { platform = process.platform, spawnFn = spawn, openPath } = {}) {
  if (platform === "darwin") {
    const error = await openPath(file);
    if (error) throw new Error(error);
    // Opening a DMG is not an installed update. Keep Gecho running until the user quits.
    return { launched: true, shouldQuit: false, manualInstall: true };
  }
  if (platform !== "win32") throw new Error(`Unsupported update platform: ${platform}`);
  if (!file.toLowerCase().endsWith(".exe")) throw new Error("Expected a Windows installer");
  await new Promise((resolve, reject) => {
    const child = spawnFn(file, [], { detached: true, stdio: "ignore", windowsHide: false });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
  return { launched: true, shouldQuit: true, manualInstall: true };
}
module.exports = { safeUpdateUrl, safeAssetName, fetchUpdateJson, downloadFile, launchInstaller };
