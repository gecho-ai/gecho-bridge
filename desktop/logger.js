"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const DEFAULT_MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB
const DEFAULT_MAX_BACKUP_FILES = 3;
const DEFAULT_MAX_RETENTION_DAYS = 7;

let maxLogSize = DEFAULT_MAX_LOG_SIZE;
let maxBackupFiles = DEFAULT_MAX_BACKUP_FILES;

let logDirectory = null;
let currentLogFile = null;

/**
 * 敏感数据脱敏过滤器，避免将用户凭证、Token、Cookie、密码等明文写入日志或导出报告
 */
function redactSensitiveData(text) {
  if (typeof text !== "string") return text;
  return text
    // 匹配 Bearer token: Authorization: Bearer xxx
    .replace(/(Bearer\s+)[a-zA-Z0-9_\-\.]{8,}/gi, "$1***REDACTED_TOKEN***")
    // 匹配键值对 token / api_key / secret / password
    .replace(/(["']?(?:token|apiKey|api_key|secret|password|passwd|auth_token|authToken|access_token|refreshToken)["']?\s*[:=]\s*["']?)([^"' \r\n,;&]{4,})(["']?)/gi, (match, prefix, val, suffix) => {
      return `${prefix}***REDACTED***${suffix}`;
    })
    // 匹配 Cookie / Cookies: cookie: session=xxx; token=yyy
    .replace(/(["']?cookie[s]?["']?\s*[:=]\s*["']?)([^"'\r\n]+)(["']?)/gi, (match, prefix, val, suffix) => {
      return `${prefix}***REDACTED_COOKIE***${suffix}`;
    })
    // 匹配 URL 查询参数中的敏感信息: ?token=xxx 或 &key=xxx
    .replace(/([?&](?:token|key|api_key|auth|signature|secret)=)([^&\s"']+)/gi, "$1***REDACTED***");
}

/**
 * 清理指定天数之前的旧日志与诊断包
 */
function cleanOldLogs(maxAgeDays = DEFAULT_MAX_RETENTION_DAYS) {
  if (!logDirectory || !fs.existsSync(logDirectory)) return;
  const now = Date.now();
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;

  try {
    const files = fs.readdirSync(logDirectory);
    for (const file of files) {
      if (file.startsWith("gecho-desktop.log.") || file.startsWith("gecho-diagnostics-")) {
        const fullPath = path.join(logDirectory, file);
        try {
          const stats = fs.statSync(fullPath);
          if (now - stats.mtimeMs > maxAgeMs) {
            fs.unlinkSync(fullPath);
          }
        } catch (_err) {
          // ignore individual file deletion error
        }
      }
    }
  } catch (err) {
    console.error("Failed to clean old logs:", err);
  }
}

function initLogger(customDir, options = {}) {
  if (options.maxLogSize) maxLogSize = options.maxLogSize;
  if (options.maxBackupFiles) maxBackupFiles = options.maxBackupFiles;

  if (customDir) {
    logDirectory = path.join(customDir, "logs");
  } else {
    try {
      const { app } = require("electron");
      logDirectory = path.join(app.getPath("userData"), "logs");
    } catch (_e) {
      logDirectory = path.join(process.cwd(), "logs");
    }
  }

  try {
    fs.mkdirSync(logDirectory, { recursive: true });
    currentLogFile = path.join(logDirectory, "gecho-desktop.log");
    cleanOldLogs(options.retentionDays || DEFAULT_MAX_RETENTION_DAYS);
  } catch (err) {
    console.error("Failed to create log directory:", err);
  }
}

function rotateLogsIfNeeded() {
  if (!currentLogFile || !fs.existsSync(currentLogFile)) return;
  try {
    const stats = fs.statSync(currentLogFile);
    if (stats.size < maxLogSize) return;

    for (let i = maxBackupFiles - 1; i >= 1; i -= 1) {
      const oldFile = `${currentLogFile}.${i}`;
      const nextFile = `${currentLogFile}.${i + 1}`;
      if (fs.existsSync(oldFile)) {
        if (i + 1 > maxBackupFiles) {
          fs.unlinkSync(oldFile);
        } else {
          fs.renameSync(oldFile, nextFile);
        }
      }
    }
    fs.renameSync(currentLogFile, `${currentLogFile}.1`);
  } catch (err) {
    console.error("Log rotation error:", err);
  }
}

function formatMessage(level, args) {
  const timestamp = new Date().toISOString();
  const text = args.map((arg) => {
    if (arg instanceof Error) {
      return `${arg.message}\n${arg.stack || ""}`;
    }
    if (typeof arg === "object") {
      try {
        return JSON.stringify(arg);
      } catch (_e) {
        return String(arg);
      }
    }
    return String(arg);
  }).join(" ");

  return `[${timestamp}] [${level}] ${redactSensitiveData(text)}\n`;
}

function writeLog(level, ...args) {
  const formatted = formatMessage(level, args);
  if (level === "ERROR") {
    process.stderr.write(formatted);
  } else {
    process.stdout.write(formatted);
  }

  if (!currentLogFile) {
    initLogger();
  }

  try {
    if (currentLogFile) {
      const logDir = path.dirname(currentLogFile);
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      rotateLogsIfNeeded();
      fs.appendFileSync(currentLogFile, formatted, "utf8");
    }
  } catch (err) {
    console.error("Failed to write to log file:", err);
  }
}

const logger = {
  init: initLogger,
  info: (...args) => writeLog("INFO", ...args),
  warn: (...args) => writeLog("WARN", ...args),
  error: (...args) => writeLog("ERROR", ...args),
  debug: (...args) => writeLog("DEBUG", ...args),
  getLogFile: () => currentLogFile,
  getLogDir: () => logDirectory,
  redact: redactSensitiveData,
  cleanOldLogs,

  getRecentLogs: (lineCount = 100) => {
    if (!currentLogFile || !fs.existsSync(currentLogFile)) return "No log records found.";
    try {
      const content = fs.readFileSync(currentLogFile, "utf8");
      const lines = content.trim().split("\n");
      return redactSensitiveData(lines.slice(-lineCount).join("\n"));
    } catch (err) {
      return `Failed to read log file: ${err.message}`;
    }
  },

  exportDiagnostics: ({ appVersion, platform, bridgeStatus, dataDir, extraInfo } = {}) => {
    if (!logDirectory) initLogger();
    const timestampStr = new Date().toISOString().replace(/[:.]/g, "-");
    const reportFileName = `gecho-diagnostics-${timestampStr}.txt`;
    const reportPath = path.join(logDirectory, reportFileName);

    const safeBridgeStatus = redactSensitiveData(JSON.stringify(bridgeStatus || {}, null, 2));
    const safeExtraInfo = extraInfo ? redactSensitiveData(JSON.stringify(extraInfo, null, 2)) : "";

    const reportContent = [
      "=================================================================",
      `  Gecho Desktop Diagnostics Report (Generated at ${new Date().toLocaleString()})`,
      "=================================================================",
      "",
      "--- System Information ---",
      `Operating System : ${process.platform} (${os.type()} ${os.release()} ${process.arch})`,
      `Node.js Version  : ${process.versions.node}`,
      `Electron Version : ${process.versions.electron || "N/A"}`,
      `App Version      : ${appVersion || "Unknown"}`,
      `App Data Dir     : ${dataDir || "Unknown"}`,
      `Diagnostics Dir  : ${logDirectory}`,
      `Total Memory     : ${(os.totalmem() / (1024 * 1024 * 1024)).toFixed(2)} GB`,
      `Free Memory      : ${(os.freemem() / (1024 * 1024 * 1024)).toFixed(2)} GB`,
      `CPU Cores        : ${os.cpus().length}`,
      "",
      "--- Bridge Status ---",
      safeBridgeStatus,
      "",
      ...(safeExtraInfo ? ["--- Additional Information ---", safeExtraInfo, ""] : []),
      "--- Recent Application Logs (Latest 100 lines) ---",
      logger.getRecentLogs(100),
      "",
      "=================================================================",
      "End of Diagnostics Report",
      "=================================================================",
    ].join("\n");

    try {
      fs.writeFileSync(reportPath, reportContent, "utf8");
      return { success: true, reportPath, fileName: reportFileName };
    } catch (err) {
      logger.error("Failed to write diagnostics report:", err);
      return { success: false, error: err.message };
    }
  },
};

module.exports = logger;
