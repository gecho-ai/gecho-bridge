"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const logger = require("../desktop/logger");

test("logger: redactSensitiveData masks tokens, cookies, passwords and auth params", () => {
  const { redact } = logger;

  // 1. Authorization: Bearer
  const authHeader = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.sampletoken";
  assert.equal(redact(authHeader), "Authorization: Bearer ***REDACTED_TOKEN***");

  // 2. Token 键值
  const tokenJson = JSON.stringify({ token: "secret_12345678", apiKey: "pk_live_abcdefgh1234" });
  const redactedToken = redact(tokenJson);
  assert.ok(!redactedToken.includes("secret_12345678"), "Token must be masked");
  assert.ok(!redactedToken.includes("pk_live_abcdefgh1234"), "API Key must be masked");
  assert.ok(redactedToken.includes("***REDACTED***"));

  // 3. Cookie
  const cookieStr = 'Cookie: session_id=abc123xyz456; gecho_user=test@example.com';
  const redactedCookie = redact(cookieStr);
  assert.ok(!redactedCookie.includes("abc123xyz456"), "Session ID must be masked");
  assert.ok(redactedCookie.includes("***REDACTED_COOKIE***"));

  // 4. URL 查询参数
  const urlWithKey = "https://api.gecho.ai/v1/sync?token=sec_token_9999&limit=10";
  const redactedUrl = redact(urlWithKey);
  assert.ok(!redactedUrl.includes("sec_token_9999"), "URL token parameter must be masked");
  assert.ok(redactedUrl.includes("token=***REDACTED***"));
  assert.ok(redactedUrl.includes("limit=10"), "Non-sensitive params must be preserved");
});

test("logger: writes sanitized logs and handles log rotation", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gecho-log-rotation-"));

  try {
    // 设置 1KB 小日志大小以快速测试轮转
    logger.init(tmpDir, { maxLogSize: 1024, maxBackupFiles: 2 });

    // 写入包含敏感信息的日志
    logger.info("User logged in with token:", "secret_token_abcdef1234");
    const logFile = logger.getLogFile();
    assert.ok(fs.existsSync(logFile), "Log file should exist");

    const content = fs.readFileSync(logFile, "utf8");
    assert.ok(!content.includes("secret_token_abcdef1234"), "Sensitive token must not appear in log file");
    assert.ok(content.includes("***REDACTED***"), "Redaction marker must appear in log file");

    // 写入大量数据触发日志轮转
    for (let i = 0; i < 40; i++) {
      logger.info(`Bulk log message entry line ${i} with padding text ------------------------`);
    }

    // 检查是否产生了轮转备份文件 gecho-desktop.log.1
    const backupFile = `${logFile}.1`;
    assert.ok(fs.existsSync(backupFile), "Backup log file .1 must be generated after rotation");

    // 测试导出诊断信息时也进行脱敏
    const diag = logger.exportDiagnostics({
      appVersion: "1.1.38",
      platform: process.platform,
      bridgeStatus: { service: "running", authToken: "super_secret_auth_token_999" },
      extraInfo: { cookie: "user_session=12345" },
    });

    assert.equal(diag.success, true);
    assert.ok(fs.existsSync(diag.reportPath));
    const reportText = fs.readFileSync(diag.reportPath, "utf8");
    assert.ok(!reportText.includes("super_secret_auth_token_999"), "Diagnostics must not expose authToken");
    assert.ok(!reportText.includes("user_session=12345"), "Diagnostics must not expose cookie session");
    assert.ok(reportText.includes("***REDACTED***"));
  } finally {
    logger.init();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("logger: cleans old logs exceeding retention days", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gecho-log-retention-"));
  try {
    logger.init(tmpDir);
    const logsDir = logger.getLogDir();

    // 创建一个模拟 10 天前的旧备份日志与诊断文件
    const oldBackup = path.join(logsDir, "gecho-desktop.log.3");
    const oldDiag = path.join(logsDir, "gecho-diagnostics-2026-01-01.txt");
    fs.writeFileSync(oldBackup, "Old log content");
    fs.writeFileSync(oldDiag, "Old diag report");

    const tenDaysAgoSec = (Date.now() - 10 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(oldBackup, tenDaysAgoSec, tenDaysAgoSec);
    fs.utimesSync(oldDiag, tenDaysAgoSec, tenDaysAgoSec);

    assert.ok(fs.existsSync(oldBackup));
    assert.ok(fs.existsSync(oldDiag));

    // 执行清理（7天保留期）
    logger.cleanOldLogs(7);

    assert.equal(fs.existsSync(oldBackup), false, "Old backup log should be cleaned");
    assert.equal(fs.existsSync(oldDiag), false, "Old diagnostic report should be cleaned");
  } finally {
    logger.init();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
