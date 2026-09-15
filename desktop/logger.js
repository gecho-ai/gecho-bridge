"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_BACKUP_FILES = 3;

let logDirectory = null;
let currentLogFile = null;

function initLogger(customDir) {
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
  } catch (err) {
    console.error("Failed to create log directory:", err);
  }
}

function rotateLogsIfNeeded() {
  if (!currentLogFile || !fs.existsSync(currentLogFile)) return;
  try {
    const stats = fs.statSync(currentLogFile);
    if (stats.size < MAX_LOG_SIZE) return;

    for (let i = MAX_BACKUP_FILES - 1; i >= 1; i -= 1) {
      const oldFile = `${currentLogFile}.${i}`;
      const nextFile = `${currentLogFile}.${i + 1}`;
      if (fs.existsSync(oldFile)) {
        if (i + 1 > MAX_BACKUP_FILES) {
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

  return `[${timestamp}] [${level}] ${text}\n`;
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
    rotateLogsIfNeeded();
    if (currentLogFile) {
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

  getRecentLogs: (lineCount = 100) => {
    if (!currentLogFile || !fs.existsSync(currentLogFile)) return "No log records found.";
    try {
      const content = fs.readFileSync(currentLogFile, "utf8");
      const lines = content.trim().split("\n");
      return lines.slice(-lineCount).join("\n");
    } catch (err) {
      return `Failed to read log file: ${err.message}`;
    }
  },

  exportDiagnostics: ({ appVersion, platform, bridgeStatus, dataDir, extraInfo } = {}) => {
    if (!logDirectory) initLogger();
    const timestampStr = new Date().toISOString().replace(/[:.]/g, "-");
    const reportFileName = `gecho-diagnostics-${timestampStr}.txt`;
    const reportPath = path.join(logDirectory, reportFileName);

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
      JSON.stringify(bridgeStatus || {}, null, 2),
      "",
      ...(extraInfo ? ["--- Additional Information ---", JSON.stringify(extraInfo, null, 2), ""] : []),
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
