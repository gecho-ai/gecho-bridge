"use strict";

/**
 * desktop/health-check.js
 * 桌面端一键环境诊断医生
 * 检测项目：Bridge 端口、磁盘空间、Chrome/Edge 可用性、Gecho 插件握手状态、关键域名连通性
 */

const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");

/**
 * 逐一运行健康检查项，返回结果数组
 * @param {Object} opts
 * @param {number} opts.servicePort - 当前 Bridge 运行端口
 * @param {string} opts.dataDir - 数据目录路径
 * @param {number} [opts.timeoutMs=4000] - 网络连通性检查超时
 * @returns {Promise<Array<{id, label, status, detail, suggestion}>>}
 */
async function runHealthChecks({ servicePort, dataDir, timeoutMs = 4000, checkNetwork = false } = {}) {
  const results = [];
  const port = servicePort || Number(process.env.GECHO_HTTP_PORT) || 18793;
  const dir = dataDir || os.homedir();

  // 1. Bridge 端口与服务连通性
  results.push(await checkBridgeService(port, timeoutMs));

  // 2. Gecho 浏览器插件握手状态（通过 Bridge /ping 返回信息判断）
  results.push(await checkExtensionHandshake(port, timeoutMs));

  // 3. 磁盘空间（数据目录）
  results.push(checkDiskSpace(dir));

  // 4. Chromium 浏览器可用性（macOS/Windows）
  results.push(await checkBrowserAvailability());

  // 5. 关键域名连通性
  const connectChecks = checkNetwork ? await checkConnectivity(timeoutMs) : [];
  results.push(...connectChecks);

  return results;
}

/** 检查 Bridge HTTP 服务是否在指定端口响应 */
async function checkBridgeService(port, timeoutMs) {
  const id = "bridge-service";
  const label = "本地 Bridge 服务";
  try {
    const resp = await httpGet(`http://127.0.0.1:${port}/ping`, timeoutMs);
    if (isBridgeResponse(resp)) {
      return { id, label, status: "ok", detail: `Bridge 运行正常（端口 ${port}）` };
    }
    return { id, label, status: "warn", detail: `端口 ${port} 响应异常（HTTP ${resp.statusCode}）`, suggestion: "尝试重启 Gecho 桌面端" };
  } catch (err) {
    return {
      id, label, status: "error",
      detail: `端口 ${port} 无响应：${err.message}`,
      suggestion: `端口 ${port} 可能被其他应用占用，重启 Gecho 会自动切换到空闲端口`,
    };
  }
}

/** 检查浏览器插件握手状态 */
async function checkExtensionHandshake(port, timeoutMs) {
  const id = "extension-handshake";
  const label = "Gecho 浏览器插件";
  try {
    const resp = await httpGet(`http://127.0.0.1:${port}/ping`, timeoutMs);
    if (!isBridgeResponse(resp)) throw new Error("未识别到 Gecho Bridge 服务");
    if (resp.data?.extensionConnected) {
      return {
        id, label, status: "ok",
        detail: `插件已连接（浏览器: ${resp.data.lastConnectedBrowser || "未知"}，Profile: ${resp.data.lastConnectedProfile || "默认"}）`,
      };
    }
    return {
      id, label, status: "warn",
      detail: "插件尚未与 Bridge 建立握手",
      suggestion: "请打开 Chrome/Edge，确认 Gecho 插件已安装并处于启用状态；可点击「连接引导」获取安装链接",
    };
  } catch (err) {
    return {
      id, label, status: "error",
      detail: `无法检查插件状态：${err.message}`,
      suggestion: "Bridge 服务未启动，请先解决上一项问题",
    };
  }
}

/** 检查磁盘空间（数据目录所在磁盘） */
function checkDiskSpace(dataDir) {
  const id = "disk-space";
  const label = "磁盘可用空间";
  const MIN_FREE_MB = 500; // 至少 500MB 空余
  try {
    const stat = fs.statfsSync(dataDir);
    const freeMB = Math.round((stat.bavail * stat.bsize) / (1024 * 1024));
    const totalMB = Math.round((stat.blocks * stat.bsize) / (1024 * 1024));
    const usedPercent = Math.round((1 - stat.bfree / stat.blocks) * 100);

    if (freeMB < MIN_FREE_MB) {
      return {
        id, label, status: "error",
        detail: `磁盘空间不足！可用 ${freeMB}MB / 共 ${totalMB}MB（已使用 ${usedPercent}%）`,
        suggestion: "请清理磁盘后再运行，建议至少保留 1GB 可用空间以保障数据采集稳定运行",
      };
    }
    if (freeMB < MIN_FREE_MB * 4) {
      return {
        id, label, status: "warn",
        detail: `磁盘空间偏少，可用 ${freeMB}MB / 共 ${totalMB}MB（已使用 ${usedPercent}%）`,
        suggestion: "建议适当清理日志和缓存文件，保留充足空间",
      };
    }
    return { id, label, status: "ok", detail: `可用 ${freeMB}MB / 共 ${totalMB}MB（已使用 ${usedPercent}%）` };
  } catch (_err) {
    // fs.statfsSync 在一些平台不可用，降级处理
    return { id, label, status: "skip", detail: "无法读取磁盘使用情况（该平台不支持）" };
  }
}

/** 检查 Chromium 系浏览器是否已安装 */
async function checkBrowserAvailability() {
  const id = "browser-availability";
  const label = "Chromium 浏览器";

  const browserPaths = {
    darwin: [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      "/Applications/Arc.app/Contents/MacOS/Arc",
    ],
    win32: [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ],
    linux: ["/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium"],
  };

  const paths = browserPaths[process.platform] || [];
  const found = [];
  for (const p of paths) {
    if (fs.existsSync(p)) {
      found.push(path.basename(p).replace(/\.exe$/i, ""));
    }
  }

  if (found.length > 0) {
    return {
      id, label, status: "ok",
      detail: `检测到：${found.slice(0, 3).join("、")}`,
    };
  }

  // 尝试 which / where 命令查找
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const browsers = process.platform === "win32"
      ? ["chrome", "msedge"]
      : ["google-chrome", "chromium", "chromium-browser"];
    for (const b of browsers) {
      const result = await runCommand(cmd, [b]);
      if (result.code === 0 && result.stdout.trim()) {
        return { id, label, status: "ok", detail: `检测到 ${b} 位于：${result.stdout.trim().split("\n")[0]}` };
      }
    }
  } catch (_e) {}

  return {
    id, label, status: "error",
    detail: "未检测到任何 Chromium 系浏览器",
    suggestion: "请安装 Google Chrome 或 Microsoft Edge 后重启 Gecho，插件只能在 Chromium 浏览器中运行",
  };
}

/** 检查关键域名网络连通性 */
async function checkConnectivity(timeoutMs) {
  const targets = [
    { id: "connectivity-tiktok", label: "TikTok 连通性", url: "https://www.tiktok.com/favicon.ico" },
    { id: "connectivity-gecho", label: "Gecho 官网网络可达性", url: "https://gecho.ai/" },
  ];

  return Promise.all(
    targets.map(async ({ id, label, url }) => {
      try {
        const resp = await httpsGet(url, timeoutMs);
        if (resp.statusCode >= 200 && resp.statusCode < 400) {
          return { id, label, status: "ok", detail: `连接正常（HTTP ${resp.statusCode}）` };
        }
        return { id, label, status: "warn", detail: `服务器可达，但返回 HTTP ${resp.statusCode}；不代表浏览器实际访问结果`, suggestion: "请在常用浏览器中确认访问及代理设置" };
      } catch (err) {
        return {
          id, label, status: "error",
          detail: `无法连接：${err.message}`,
          suggestion: "请检查网络连接、防火墙或代理设置；若使用全局代理，请确认 127.0.0.1 回环流量已排除在代理外",
        };
      }
    })
  );
}

/** HTTP GET（http: 协议用于本地 Bridge） */
function httpGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("error", reject);
      res.on("end", () => {
        try {
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, statusCode: res.statusCode, data: JSON.parse(body) });
        } catch (_e) {
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, statusCode: res.statusCode, data: null });
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error("Request timed out")); });
  });
}

/** HTTPS HEAD（外部域名连通性检查，避免下载内容） */
function httpsGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request({ hostname: parsed.hostname, path: parsed.pathname + parsed.search, method: "HEAD", timeout: timeoutMs }, (res) => {
      res.resume();
      resolve({ statusCode: res.statusCode });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

/** 执行系统命令，返回 {code, stdout, stderr} */
function runCommand(cmd, args = []) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 3000 }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code ?? 1 : 0, stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

function isBridgeResponse(resp) {
  return resp.ok && resp.data?.status === "ok"
    && Number.isInteger(resp.data.serviceProtocolVersion)
    && typeof resp.data.packageVersion === "string";
}

module.exports = { runHealthChecks };
