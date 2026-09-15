"use strict";

const https = require("node:https");
const { app, dialog, shell } = require("electron");
const logger = require("./logger");
const i18n = require("./i18n");

const GITHUB_REPO = "gecho-ai/gecho-bridge";
const RELEASES_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${GITHUB_REPO}/releases/latest`;

/**
 * Compare two semver strings: a > b => 1, a < b => -1, a === b => 0
 */
function compareVersions(v1, v2) {
  const clean1 = (v1 || "").replace(/^v/, "").split("-")[0];
  const clean2 = (v2 || "").replace(/^v/, "").split("-")[0];
  const parts1 = clean1.split(".").map(Number);
  const parts2 = clean2.split(".").map(Number);

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const num1 = parts1[i] || 0;
    const num2 = parts2[i] || 0;
    if (num1 > num2) return 1;
    if (num1 < num2) return -1;
  }
  return 0;
}

function fetchLatestRelease(timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        "User-Agent": `Gecho-Desktop/${app?.getVersion?.() || "1.0.0"}`,
        Accept: "application/vnd.github.v3+json",
      },
    };

    const req = https.get(RELEASES_API, options, (res) => {
      // Follow redirect if 301/302
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        https.get(res.headers.location, options, (redirectRes) => {
          let body = "";
          redirectRes.on("data", (chunk) => (body += chunk));
          redirectRes.on("end", () => {
            try {
              resolve(JSON.parse(body));
            } catch (err) {
              reject(err);
            }
          });
        }).on("error", reject);
        return;
      }

      if (res.statusCode !== 200) {
        return reject(new Error(`Server returned HTTP ${res.statusCode}`));
      }

      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });
  });
}

async function checkForUpdates(manual = false) {
  const currentVersion = app?.getVersion?.() || "1.0.0";
  logger.info(`Checking for updates (current: v${currentVersion}, manual: ${manual})...`);

  try {
    const release = await fetchLatestRelease();
    const tagName = release.tag_name || release.name || "";
    const latestVersion = tagName.replace(/^v/, "");

    const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;
    const downloadUrl = release.html_url || RELEASES_PAGE;
    const releaseNotes = release.body || "";

    const result = {
      success: true,
      updateAvailable: hasUpdate,
      currentVersion,
      latestVersion,
      releaseNotes,
      downloadUrl,
    };

    if (manual) {
      if (hasUpdate) {
        const choice = dialog.showMessageBoxSync({
          type: "info",
          title: i18n.t("updateAvailableTitle"),
          message: i18n.t("updateAvailableMsg", { version: latestVersion }),
          detail: releaseNotes ? releaseNotes.slice(0, 300) : undefined,
          buttons: [i18n.t("btnGoDownload"), i18n.t("btnLater")],
          defaultId: 0,
          cancelId: 1,
        });
        if (choice === 0) {
          shell.openExternal(downloadUrl);
        }
      } else {
        dialog.showMessageBoxSync({
          type: "info",
          title: i18n.t("updateLatestTitle"),
          message: i18n.t("updateLatestMsg", { version: currentVersion }),
          buttons: ["OK"],
        });
      }
    }

    return result;
  } catch (error) {
    logger.warn("Update check failed:", error.message);
    if (manual) {
      dialog.showMessageBoxSync({
        type: "warning",
        title: i18n.t("updateErrorTitle"),
        message: i18n.t("updateErrorMsg"),
        buttons: ["OK"],
      });
    }
    return {
      success: false,
      updateAvailable: false,
      currentVersion,
      error: error.message,
    };
  }
}

module.exports = {
  compareVersions,
  fetchLatestRelease,
  checkForUpdates,
  RELEASES_PAGE,
};
