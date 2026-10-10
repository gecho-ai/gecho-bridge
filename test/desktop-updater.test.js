"use strict";

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");

const {
  UPDATE_STATUS,
  compareVersions,
  compareSemver,
  findMatchingAsset,
  fetchReleaseFeed,
  checkForUpdates,
  downloadUpdate,
  verifyDownloadedFile,
  getUpdateState,
  onStateChange,
} = require("../desktop/updater");

test("updater: compareVersions and compareSemver handle version ranges correctly", () => {
  // 核心版本号比对
  assert.equal(compareVersions("1.1.37", "1.1.38"), -1);
  assert.equal(compareVersions("1.1.38", "1.1.37"), 1);
  assert.equal(compareVersions("1.1.38", "1.1.38"), 0);
  assert.equal(compareVersions("v1.2.0", "1.1.38"), 1);
  assert.equal(compareVersions("2.0.0", "1.99.99"), 1);
  assert.equal(compareVersions("1.1", "1.1.0"), 0);

  // 默认模式下忽略 pre-release 差异（兼容现有桌面断言）
  assert.equal(compareVersions("1.1.38-beta", "1.1.38"), 0);
  assert.equal(compareVersions("1.1.38", "1.1.38-alpha"), 0);

  // 严格 SemVer 模式下能正确区分正式版与预发布版
  assert.equal(compareSemver("1.1.38", "1.1.38-beta"), 1, "正式版应高于同版本的预发布版");
  assert.equal(compareSemver("1.1.38-beta", "1.1.38"), -1, "预发布版应低于同版本的正式版");
  assert.equal(compareSemver("1.1.38-alpha", "1.1.38-beta"), -1, "alpha 应低于 beta");
  assert.equal(compareSemver("1.1.39-alpha", "1.1.38"), 1, "更高主/次版本的预发布版应高于低版本的正式版");
  assert.equal(compareSemver("1.1.38-beta.10", "1.1.38-beta.2"), 1);
});

test("updater: findMatchingAsset matches assets based on platform and arch", () => {
  const assets = [
    { name: "Gecho-1.1.39-mac-arm64.dmg", browser_download_url: "https://mock.download/mac-arm64.dmg", size: 90000000 },
    { name: "Gecho-1.1.39-mac-x64.dmg", browser_download_url: "https://mock.download/mac-x64.dmg", size: 95000000 },
    { name: "Gecho-Setup-1.1.39.exe", browser_download_url: "https://mock.download/win-x64.exe", size: 85000000 },
    { name: "Gecho-1.1.39-win-arm64.exe", browser_download_url: "https://mock.download/win-arm64.exe", size: 82000000 },
    { name: "latest.yml", browser_download_url: "https://mock.download/latest.yml", size: 400 },
    { name: "latest-mac.yml", browser_download_url: "https://mock.download/latest-mac.yml", size: 400 },
    { name: "Gecho-Setup-1.1.39.exe.blockmap", browser_download_url: "https://mock.download/win.blockmap", size: 1000 },
  ];

  // Windows x64
  const winX64 = findMatchingAsset(assets, "win32", "x64");
  assert.ok(winX64);
  assert.equal(winX64.name, "Gecho-Setup-1.1.39.exe");

  // Windows arm64
  const winArm64 = findMatchingAsset(assets, "win32", "arm64");
  assert.ok(winArm64);
  assert.equal(winArm64.name, "Gecho-1.1.39-win-arm64.exe");

  // macOS arm64
  const macArm64 = findMatchingAsset(assets, "darwin", "arm64");
  assert.ok(macArm64);
  assert.equal(macArm64.name, "Gecho-1.1.39-mac-arm64.dmg");

  // macOS x64
  const macX64 = findMatchingAsset(assets, "darwin", "x64");
  assert.ok(macX64);
  assert.equal(macX64.name, "Gecho-1.1.39-mac-x64.dmg");

  // 无对应平台的资产时返回 null
  const linuxAsset = findMatchingAsset(assets, "linux", "x64");
  assert.equal(linuxAsset, null);

  // 只有 Windows 安装包时，macOS 查询应返回 null
  const winOnlyAssets = [
    { name: "Gecho-Setup-1.1.39.exe", browser_download_url: "https://mock.download/win.exe", size: 80000000 },
  ];
  assert.equal(findMatchingAsset(winOnlyAssets, "darwin", "arm64"), null);
  assert.equal(findMatchingAsset([{ name: "Gecho-mac-x64.dmg" }], "darwin", "arm64"), null);
  assert.equal(findMatchingAsset([{ name: "Gecho-win-arm64.exe" }], "win32", "x64"), null);
});

test("updater ignores drafts and prereleases in a stable release feed", async (t) => {
  const server = http.createServer((_req, res) => res.end(JSON.stringify([
    { tag_name: "v99.0.0-beta", prerelease: true }, { tag_name: "v2.0.0" }, { tag_name: "v3.0.0" }
  ])));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const release = await fetchReleaseFeed(`http://127.0.0.1:${server.address().port}`);
  assert.equal(release.tag_name, "v3.0.0");
});

test("updater: handles empty releases and rate limit errors gracefully", async () => {
  // 模拟返回空列表的 HTTP 服务
  const emptyServer = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify([]));
  });

  await new Promise((resolve) => emptyServer.listen(0, "127.0.0.1", resolve));
  const emptyPort = emptyServer.address().port;
  const emptyUrl = `http://127.0.0.1:${emptyPort}/releases`;

  try {
    const res = await checkForUpdates({ feedUrl: emptyUrl, manual: true });
    assert.equal(res.success, false);
    assert.equal(res.errorCode, "NO_RELEASES");
    assert.equal(res.updateAvailable, false);
  } finally {
    emptyServer.close();
  }

  // 模拟返回 403 Rate Limit 的 HTTP 服务
  const rateLimitServer = http.createServer((req, res) => {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "API rate limit exceeded" }));
  });

  await new Promise((resolve) => rateLimitServer.listen(0, "127.0.0.1", resolve));
  const ratePort = rateLimitServer.address().port;
  const rateUrl = `http://127.0.0.1:${ratePort}/releases`;

  try {
    const res = await checkForUpdates({ feedUrl: rateUrl, manual: true });
    assert.equal(res.success, false);
    assert.equal(res.errorCode, "RATE_LIMIT");
  } finally {
    rateLimitServer.close();
  }
});

test("updater: checks for update, downloads package, reports progress, and verifies checksum", async () => {
  // 生成一个模拟的安装包文件内容
  // 如果是 Windows，需要包含 MZ 头以满足 PE 校验测试
  const fakePackageBuffer = Buffer.concat([
    Buffer.from("MZ"), // PE 标识
    Buffer.from("GechoDesktopInstallerMockData".repeat(1024)),
  ]);
  const expectedHash = crypto.createHash("sha256").update(fakePackageBuffer).digest("hex");

  let downloadHitCount = 0;

  // 搭建本地 Mock 更新源服务器
  const mockServer = http.createServer((req, res) => {
    if (req.url === "/releases") {
      const mockReleases = [
        {
          tag_name: "v9.9.0",
          name: "v9.9.0 Major Upgrade",
          body: "### Release notes\n- Feature A\n- Fix B",
          draft: false,
          prerelease: false,
          assets: [
            {
              name: `Gecho-9.9.0-${process.platform === "win32" ? "win-x64.exe" : "mac-arm64.dmg"}`,
              browser_download_url: `http://127.0.0.1:${mockServer.address().port}/download/installer`,
              size: fakePackageBuffer.length,
            },
          ],
        },
      ];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(mockReleases));
      return;
    }

    if (req.url === "/download/installer") {
      downloadHitCount++;
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": fakePackageBuffer.length,
      });
      // 分两段发送以测试下载进度变化
      const half = Math.floor(fakePackageBuffer.length / 2);
      res.write(fakePackageBuffer.subarray(0, half));
      setTimeout(() => {
        res.end(fakePackageBuffer.subarray(half));
      }, 50);
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
  const port = mockServer.address().port;
  const feedUrl = `http://127.0.0.1:${port}/releases`;

  try {
    const statesRecorded = [];
    const unsubscribe = onStateChange((st) => {
      statesRecorded.push(st.status);
    });

    // 1. 检查更新
    const checkRes = await checkForUpdates({
      feedUrl,
      currentVersion: "1.1.38",
      targetPlatform: process.platform,
      targetArch: process.platform === "win32" ? "x64" : "arm64",
      manual: true,
    });

    assert.equal(checkRes.success, true);
    assert.equal(checkRes.updateAvailable, true);
    assert.equal(checkRes.latestVersion, "9.9.0");
    assert.ok(checkRes.asset);

    // 检查内部状态
    const stateAfterCheck = getUpdateState();
    assert.equal(stateAfterCheck.status, UPDATE_STATUS.AVAILABLE);
    assert.equal(stateAfterCheck.latestVersion, "9.9.0");

    // 2. 下载安装包
    const downloadRes = await downloadUpdate({
      expectedSha256: expectedHash,
    });

    assert.equal(downloadRes.success, true);
    assert.ok(downloadRes.filePath);
    assert.ok(fs.existsSync(downloadRes.filePath));
    assert.equal(downloadHitCount, 1);

    // 校验文件内容一致
    const downloadedBuf = fs.readFileSync(downloadRes.filePath);
    assert.equal(downloadedBuf.length, fakePackageBuffer.length);

    // 状态流转应包含 checking, available, downloading, downloaded
    assert.ok(statesRecorded.includes(UPDATE_STATUS.CHECKING));
    assert.ok(statesRecorded.includes(UPDATE_STATUS.AVAILABLE));
    assert.ok(statesRecorded.includes(UPDATE_STATUS.DOWNLOADING));
    assert.ok(statesRecorded.includes(UPDATE_STATUS.DOWNLOADED));

    // 3. 测试文件校验方法
    const verifySuccess = verifyDownloadedFile(downloadRes.filePath, {
      expectedSha256: expectedHash,
      expectedSize: fakePackageBuffer.length,
      platform: "win32",
    });
    assert.equal(verifySuccess.valid, true);

    // 4. 测试哈希不匹配时校验失败
    const verifyFail = verifyDownloadedFile(downloadRes.filePath, {
      expectedSha256: "0000000000000000000000000000000000000000000000000000000000000000",
      platform: "win32",
    });
    assert.equal(verifyFail.valid, false);
    assert.equal(verifyFail.errorCode, "VERIFICATION_FAILED");

    // 清理临时测试文件
    try {
      fs.unlinkSync(downloadRes.filePath);
    } catch (_e) {}

    unsubscribe();
  } finally {
    mockServer.close();
  }
});

test("updater: detects when higher version exists but matching platform asset is missing", async () => {
  const mockServer = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify([
        {
          tag_name: "v2.0.0",
          assets: [
            // 只提供了 Linux 资产
            { name: "Gecho-2.0.0.AppImage", browser_download_url: "https://mock.download/appimage", size: 80000000 },
          ],
        },
      ])
    );
  });

  await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
  const port = mockServer.address().port;
  const feedUrl = `http://127.0.0.1:${port}/releases`;

  try {
    const res = await checkForUpdates({
      feedUrl,
      currentVersion: "1.1.38",
      targetPlatform: "darwin",
      targetArch: "arm64",
      manual: true,
    });

    assert.equal(res.success, false);
    assert.equal(res.errorCode, "NO_MATCHING_ASSET");
    assert.equal(getUpdateState().status, UPDATE_STATUS.NO_MATCHING_ASSET);
  } finally {
    mockServer.close();
  }
});
