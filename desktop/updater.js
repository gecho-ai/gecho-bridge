"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { app, dialog, shell } = require("electron");
const logger = require("./logger");
const i18n = require("./i18n");
const transport = require("./update-transport");

const GITHUB_REPO = "gecho-ai/gecho-bridge";
const DEFAULT_RELEASES_API = `https://api.github.com/repos/${GITHUB_REPO}/releases`;
const RELEASES_PAGE = `https://github.com/${GITHUB_REPO}/releases/latest`;

// 升级状态机常量
const UPDATE_STATUS = {
  IDLE: "idle",
  CHECKING: "checking",
  AVAILABLE: "available",
  NOT_AVAILABLE: "not-available",
  NO_MATCHING_ASSET: "no-matching-asset",
  DOWNLOADING: "downloading",
  DOWNLOADED: "downloaded",
  INSTALLING: "installing",
  ERROR: "error",
};

// 内部状态
let currentState = {
  status: UPDATE_STATUS.IDLE,
  currentVersion: "",
  latestVersion: null,
  releaseNotes: "",
  asset: null,
  downloadedFilePath: null,
  progress: { percent: 0, transferredBytes: 0, totalBytes: 0 },
  error: null,
  errorType: null,
};

let stateListeners = new Set();
let isChecking = false;
let activeDownloadPromise = null;

function notifyStateChange() {
  const stateCopy = { ...currentState };
  for (const listener of stateListeners) {
    try {
      listener(stateCopy);
    } catch (err) {
      logger.error("Error in updater state listener:", err);
    }
  }
}

function setState(patch) {
  currentState = { ...currentState, ...patch };
  notifyStateChange();
}

function onStateChange(listener) {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}

function getUpdateState() {
  return { ...currentState };
}

/**
 * SemVer 比较算法
 * 默认比较主次修订核心版本（兼容旧版本忽略 prerelease 行为）
 * 当传入 { strict: true } 时遵循严格 SemVer 规范比较 pre-release
 * 返回: v1 > v2 => 1, v1 < v2 => -1, v1 === v2 => 0
 */
function compareVersions(v1, v2, options = {}) {
  if (!v1 && !v2) return 0;
  if (!v1) return -1;
  if (!v2) return 1;

  const strict = Boolean(options && options.strict);

  const parse = (v) => {
    const raw = String(v).trim().replace(/^v/, "").split("+")[0];
    const [main, ...preParts] = raw.split("-");
    const pre = preParts.join("-");
    const nums = main.split(".").map((n) => Number.parseInt(n, 10) || 0);
    while (nums.length < 3) nums.push(0);
    return { nums, pre };
  };

  const p1 = parse(v1);
  const p2 = parse(v2);

  for (let i = 0; i < 3; i++) {
    if (p1.nums[i] > p2.nums[i]) return 1;
    if (p1.nums[i] < p2.nums[i]) return -1;
  }

  if (strict) {
    // 主版本号完全相同时，无 pre-release 的版本（正式版）高于有 pre-release 的版本
    if (!p1.pre && p2.pre) return 1;
    if (p1.pre && !p2.pre) return -1;
    if (p1.pre && p2.pre) {
      const a = p1.pre.split("."), b = p2.pre.split(".");
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (a[i] === b[i]) continue;
        if (a[i] === undefined) return -1;
        if (b[i] === undefined) return 1;
        const numericA = /^\d+$/.test(a[i]), numericB = /^\d+$/.test(b[i]);
        if (numericA && numericB) return Number(a[i]) > Number(b[i]) ? 1 : -1;
        if (numericA !== numericB) return numericA ? -1 : 1;
        return a[i] > b[i] ? 1 : -1;
      }
    }
  }

  return 0;
}

function compareSemver(v1, v2) {
  return compareVersions(v1, v2, { strict: true });
}

/**
 * 依据操作系统与架构从 assets 列表中匹配对应安装包
 */
function findMatchingAsset(assets, platform = process.platform, arch = process.arch) {
  if (!Array.isArray(assets) || assets.length === 0) return null;

  const validAssets = assets.filter((a) => {
    const name = (a.name || "").toLowerCase();
    // 过滤掉 blockmap 和非安装包文件
    if (name.endsWith(".blockmap") || name.endsWith(".yml") || name.endsWith(".yaml")) return false;
    if (name.includes("__uninstaller") || name.includes(".uninstaller.")) return false;
    if (arch === "arm64" && /x64|x86_64|intel|win64/.test(name) && !name.includes("universal")) return false;
    if (arch === "x64" && /arm64|aarch64/.test(name) && !name.includes("universal")) return false;
    return true;
  });

  if (platform === "win32") {
    // Windows: 寻找 .exe 安装包
    const exeAssets = validAssets.filter((a) => (a.name || "").toLowerCase().endsWith(".exe"));
    if (exeAssets.length === 0) return null;

    // 若系统为 x64，优先匹配名称包含 x64 或 win-x64 的
    if (arch === "x64") {
      const match = exeAssets.find((a) => {
        const name = a.name.toLowerCase();
        return name.includes("x64") || name.includes("win64");
      });
      if (match) return match;
    }

    if (arch === "arm64") {
      const match = exeAssets.find((a) => a.name.toLowerCase().includes("arm64"));
      if (match) return match;
    }

    // 默认回退选择第一个有效的 exe
    return exeAssets[0];
  }

  if (platform === "darwin") {
    // macOS: 优先寻找 .dmg，其次 .zip
    const macCandidates = validAssets.filter((a) => {
      const name = (a.name || "").toLowerCase();
      return name.endsWith(".dmg") || (name.endsWith(".zip") && (name.includes("mac") || name.includes("darwin")));
    });

    if (macCandidates.length === 0) return null;

    // 优先架构匹配
    if (arch === "arm64") {
      const armMatch = macCandidates.find((a) => {
        const name = a.name.toLowerCase();
        return name.includes("arm64") || name.includes("aarch64");
      });
      if (armMatch) return armMatch;
    } else if (arch === "x64") {
      const intelMatch = macCandidates.find((a) => {
        const name = a.name.toLowerCase();
        return name.includes("x64") || name.includes("x86_64") || name.includes("intel");
      });
      if (intelMatch) return intelMatch;
    }

    // 通用包 (universal) 或无特定架构标识的包
    const universalMatch = macCandidates.find((a) => {
      const name = a.name.toLowerCase();
      return name.includes("universal") || (!name.includes("arm64") && !name.includes("x64"));
    });
    if (universalMatch) return universalMatch;

    return macCandidates[0];
  }

  return null;
}

/**
 * 统一 HTTP/HTTPS 异步请求封装
 */
function fetchJson(url, options = {}, timeoutMs = 10000) {
  return transport.fetchUpdateJson(url, { headers: { "User-Agent": "Gecho-Desktop", ...options.headers } }, timeoutMs);
}

/**
 * 获取最新 Release 描述
 * 支持 GitHub Releases 列表、单一 release 对象、或自建 Generic Feed JSON
 */
async function fetchReleaseFeed(customFeedUrl) {
  const feedUrl = customFeedUrl || process.env.GECHO_UPDATE_FEED_URL || DEFAULT_RELEASES_API;
  logger.info("Fetching update feed from:", feedUrl);

  const data = await fetchJson(feedUrl);

  if (Array.isArray(data)) {
    if (data.length === 0) {
      const err = new Error("Release list is empty");
      err.errorType = "NO_RELEASES";
      throw err;
    }
    // 过滤掉草稿 (draft)
    const published = data.filter((r) => !r.draft && !r.prerelease && !String(r.tag_name || r.version || "").includes("-"))
      .sort((a, b) => compareSemver(b.tag_name || b.version, a.tag_name || a.version));
    if (published.length === 0) {
      const err = new Error("No published releases found");
      err.errorType = "NO_RELEASES";
      throw err;
    }
    // 优先选择最新的发布版本
    return published[0];
  }

  if (data && typeof data === "object") {
    if (data.draft || data.prerelease || String(data.tag_name || data.version || "").includes("-")) {
      const error = new Error("No stable published release"); error.errorType = "NO_RELEASES"; throw error;
    }
    return data;
  }

  const err = new Error("Invalid release feed payload");
  err.errorType = "SERVER_ERROR";
  throw err;
}

/**
 * 核心检查更新方法
 * @param {Object} options
 * @param {boolean} options.manual 是否为用户主动发起的检查
 * @param {string} [options.feedUrl] 自定义更新源
 * @param {string} [options.currentVersion] 覆盖当前版本（测试用）
 * @param {string} [options.targetPlatform] 覆盖目标平台（测试用）
 * @param {string} [options.targetArch] 覆盖目标架构（测试用）
 */
async function checkForUpdates({ manual = false, feedUrl, currentVersion: versionOverride, targetPlatform, targetArch } = {}) {
  const currentVersion = versionOverride || app?.getVersion?.() || require("../package.json").version || "1.1.38";
  const platform = targetPlatform || process.platform;
  const arch = targetArch || process.arch;
  currentState.currentVersion = currentVersion;

  if (isChecking) {
    logger.info("Update check already in progress, skipping duplicate request.");
    return { ...currentState, alreadyChecking: true };
  }
  if (activeDownloadPromise || currentState.status === UPDATE_STATUS.INSTALLING) return { ...currentState, success: false, error: "Update operation is busy" };

  isChecking = true;
  setState({
    status: UPDATE_STATUS.CHECKING,
    currentVersion,
    error: null,
    errorType: null,
    downloadedFilePath: null,
  });

  logger.info(`Checking for updates (current: v${currentVersion}, manual: ${manual})...`);

  const canShowDialog = dialog && typeof dialog.showMessageBoxSync === "function";

  try {
    const release = await fetchReleaseFeed(feedUrl);
    const tagName = release.tag_name || release.version || release.name || "";
    const latestVersion = tagName.replace(/^v/, "").trim();

    if (!latestVersion) {
      const err = new Error("Release has no valid tag_name or version");
      err.errorType = "SERVER_ERROR";
      throw err;
    }

    const hasNewerVersion = compareSemver(latestVersion, currentVersion) > 0;
    const releaseNotes = release.body || release.releaseNotes || "";
    const assets = release.assets || [];
    const matchingAsset = findMatchingAsset(assets, platform, arch);

    if (!hasNewerVersion) {
      setState({
        status: UPDATE_STATUS.NOT_AVAILABLE,
        latestVersion,
        releaseNotes,
        asset: null,
      });

      if (manual && canShowDialog) {
        dialog.showMessageBoxSync({
          type: "info",
          title: i18n.t("updateLatestTitle"),
          message: i18n.t("updateLatestMsg", { version: currentVersion }),
          buttons: ["OK"],
        });
      }

      return {
        success: true,
        updateAvailable: false,
        currentVersion,
        latestVersion,
      };
    }

    // 发现更高版本，但检查是否有适配当前系统架构的安装包
    if (!matchingAsset) {
      logger.warn(`Newer version v${latestVersion} found, but no matching package for ${platform}-${arch}`);
      setState({
        status: UPDATE_STATUS.NO_MATCHING_ASSET,
        latestVersion,
        releaseNotes,
        asset: null,
        platform,
        arch,
      });

      if (manual && canShowDialog) {
        dialog.showMessageBoxSync({
          type: "warning",
          title: i18n.t("updateAvailableTitle"),
          message: i18n.t("updateNoMatchingAsset", {
            version: latestVersion,
            platform,
            arch,
          }),
          buttons: ["OK"],
        });
      }

      return {
        success: false,
        updateAvailable: false,
        hasNewerVersion: true,
        noMatchingAsset: true,
        errorCode: "NO_MATCHING_ASSET",
        currentVersion,
        latestVersion,
      };
    }

    // 成功发现可用新版本与对应安装包
    setState({
      status: UPDATE_STATUS.AVAILABLE,
      latestVersion,
      releaseNotes,
      asset: matchingAsset,
    });

    if (manual && canShowDialog) {
      const choice = dialog.showMessageBoxSync({
        type: "info",
        title: i18n.t("updateAvailableTitle"),
        message: i18n.t("updateAvailableMsg", { version: latestVersion }),
        detail: releaseNotes ? `${releaseNotes.slice(0, 350)}\n\n${i18n.t("updateDataPreservedNotice")}` : i18n.t("updateDataPreservedNotice"),
        buttons: [i18n.t("btnGoDownload"), i18n.t("btnLater")],
        defaultId: 0,
        cancelId: 1,
      });

      if (choice === 0) {
        // 用户确认下载，自动启动下载流程
        downloadUpdate({ asset: matchingAsset }).catch((dlErr) => {
          logger.error("Auto download failed after dialog confirmation:", dlErr);
        });
      }
    }

    return {
      success: true,
      updateAvailable: true,
      currentVersion,
      latestVersion,
      releaseNotes,
      asset: matchingAsset,
    };
  } catch (error) {
    const errorType = error.errorType || "UNKNOWN";
    logger.warn(`Update check failed [${errorType}]:`, error.message);

    setState({
      status: UPDATE_STATUS.ERROR,
      error: error.message,
      errorType,
    });

    if (manual && canShowDialog) {
      let localizedMsg = i18n.t("updateErrorMsg") || i18n.t("updateErrorTitle");
      if (errorType === "RATE_LIMIT") localizedMsg = i18n.t("updateRateLimit");
      else if (errorType === "TIMEOUT") localizedMsg = i18n.t("updateTimeout");
      else if (errorType === "OFFLINE") localizedMsg = i18n.t("updateOffline");
      else if (errorType === "NO_RELEASES") localizedMsg = i18n.t("updateNoRelease");

      dialog.showMessageBoxSync({
        type: "warning",
        title: i18n.t("updateErrorTitle"),
        message: localizedMsg,
        buttons: ["OK"],
      });
    }

    return {
      success: false,
      updateAvailable: false,
      currentVersion,
      error: error.message,
      errorCode: errorType,
      errorType,
    };
  } finally {
    isChecking = false;
  }
}

/**
 * 校验下载文件的有效性与哈希完整性
 * @param {string} filePath - 下载文件路径
 * @param {Object} options - 校验选项
 * @param {string} [options.expectedSha256] - 期望的 SHA256 哈希（也支持 sha256 字段名）
 * @param {number} [options.expectedSize] - 期望的文件大小（也支持 size 字段名）
 * @param {string} [options.platform] - 用于 PE 头校验的目标平台（也支持 process.platform 回退）
 * @returns {{ valid: boolean, errorCode?: string, error?: string }}
 */
function verifyDownloadedFile(filePath, options = {}) {
  if (!fs.existsSync(filePath)) {
    return { valid: false, errorCode: "VERIFICATION_FAILED", error: "Downloaded file does not exist on disk" };
  }

  const stat = fs.statSync(filePath);
  if (stat.size === 0) {
    return { valid: false, errorCode: "VERIFICATION_FAILED", error: "Downloaded file is empty (0 bytes)" };
  }

  // 兼容旧 asset 对象结构与新 options 结构
  const expectedSize = options.expectedSize || options.size || null;
  const expectedSha256 = options.expectedSha256 || options.sha256 || null;
  const targetPlatform = options.platform || process.platform;

  // 1. 如果有 expected size，比对大小
  if (expectedSize && typeof expectedSize === "number" && expectedSize > 0) {
    if (stat.size !== expectedSize) {
      return {
        valid: false,
        errorCode: "VERIFICATION_FAILED",
        error: `File size mismatch: expected ${expectedSize} bytes, got ${stat.size} bytes`,
      };
    }
  }

  // 2. 如果提供了 SHA256，进行哈希比对
  if (expectedSha256 && typeof expectedSha256 === "string") {
    const fileBuffer = fs.readFileSync(filePath);
    const actualHash = crypto.createHash("sha256").update(fileBuffer).digest("hex").toLowerCase();
    if (actualHash !== expectedSha256.toLowerCase()) {
      return {
        valid: false,
        errorCode: "VERIFICATION_FAILED",
        error: `SHA256 mismatch: expected ${expectedSha256}, got ${actualHash}`,
      };
    }
  }

  // 3. Windows 基本 PE 格式完整性校验
  if (targetPlatform === "win32" && filePath.toLowerCase().endsWith(".exe")) {
    const fd = fs.openSync(filePath, "r");
    const headerBuf = Buffer.alloc(2);
    fs.readSync(fd, headerBuf, 0, 2, 0);
    fs.closeSync(fd);
    if (headerBuf.toString("utf8") !== "MZ") {
      return {
        valid: false,
        errorCode: "VERIFICATION_FAILED",
        error: "Invalid Windows PE executable format (missing MZ magic bytes)",
      };
    }
  }

  return { valid: true };
}

/**
 * 执行安装包文件下载并校验
 */
function downloadUpdate({ asset, onProgress, expectedSha256 } = {}) {
  if (activeDownloadPromise) return activeDownloadPromise;
  const targetAsset = asset || currentState.asset;
  if (!targetAsset) return Promise.reject(new Error("No update asset available"));
  activeDownloadPromise = (async () => {
    let targetFilePath;
    try {
      const url = targetAsset.browser_download_url || targetAsset.url;
      transport.safeUpdateUrl(url);
      const name = transport.safeAssetName(targetAsset.name || path.basename(new URL(url).pathname));
      const hash = expectedSha256 || targetAsset.sha256 || targetAsset.digest?.replace(/^sha256:/, "");
      if (hash && !/^[a-f0-9]{64}$/i.test(hash)) throw new Error("Invalid SHA256 digest");
      const dir = fs.mkdtempSync(path.join(app?.getPath?.("temp") || os.tmpdir(), "gecho-update-"));
      targetFilePath = path.join(dir, name);
      setState({ status: UPDATE_STATUS.DOWNLOADING, downloadedFilePath: null, error: null, errorType: null });
      const progress = await transport.downloadFile(url, targetFilePath, {
        size: targetAsset.size,
        headers: { "User-Agent": "Gecho-Desktop" },
        onProgress(value) {
          setState({ progress: value });
          try { onProgress?.(value); } catch (_) {}
        },
      });
      const verified = verifyDownloadedFile(targetFilePath, { size: targetAsset.size, sha256: hash });
      if (!verified.valid) throw Object.assign(new Error(verified.error), { errorType: "VERIFICATION_FAILED" });
      setState({ status: UPDATE_STATUS.DOWNLOADED, asset: targetAsset, downloadedFilePath: targetFilePath, verifiedSha256: hash || null, progress: { ...progress, percent: 100 } });
      return { success: true, filePath: targetFilePath, asset: targetAsset };
    } catch (error) {
      if (targetFilePath) { try { fs.unlinkSync(targetFilePath); } catch (_) {} }
      setState({ status: UPDATE_STATUS.ERROR, downloadedFilePath: null, error: error.message, errorType: error.errorType || "DOWNLOAD_FAILED" });
      throw error;
    }
  })().finally(() => { activeDownloadPromise = null; });
  return activeDownloadPromise;
}

/**
 * 退出当前应用并启动安装程序完成升级
 */
async function quitAndInstall({ cleanupCallback } = {}) {
  const filePath = currentState.downloadedFilePath;
  if (currentState.status !== UPDATE_STATUS.DOWNLOADED || !filePath) throw new Error("No verified installer available");
  const verified = verifyDownloadedFile(filePath, { size: currentState.asset?.size, sha256: currentState.verifiedSha256 });
  if (!verified.valid) throw new Error(verified.error);
  setState({ status: UPDATE_STATUS.INSTALLING });
  try {
    const result = await transport.launchInstaller(filePath, { openPath: (file) => shell.openPath(file) });
    if (result.shouldQuit) {
      cleanupCallback?.();
      app.quit();
    } else {
      setState({ status: UPDATE_STATUS.DOWNLOADED });
    }
    return { success: true, platform: process.platform, ...result };
  } catch (error) {
    setState({ status: UPDATE_STATUS.DOWNLOADED, error: error.message, errorType: "INSTALL_FAILED" });
    throw error;
  }
}

module.exports = {
  UPDATE_STATUS,
  compareVersions,
  compareSemver,
  findMatchingAsset,
  fetchJson,
  fetchReleaseFeed,
  checkForUpdates,
  downloadUpdate,
  verifyDownloadedFile,
  quitAndInstall,
  getUpdateState,
  onStateChange,
  RELEASES_PAGE,
};
