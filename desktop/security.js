"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const logger = require("./logger");

const TOKEN_FILENAME = "local-token.json";

/**
 * Reads or generates a secure random 32-byte token for local IPC / HTTP authorization.
 * File permissions are restricted to current user (0o600).
 */
function getOrCreateLocalToken(dataDir) {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const tokenFile = path.join(dataDir, TOKEN_FILENAME);
  try {
    if (fs.existsSync(tokenFile)) {
      const content = fs.readFileSync(tokenFile, "utf8");
      const data = JSON.parse(content);
      if (data && typeof data.token === "string" && data.token.length >= 32) {
        return data.token;
      }
    }
  } catch (err) {
    logger.warn("Failed to read existing local token, generating a new one:", err.message);
  }

  const newToken = crypto.randomBytes(32).toString("hex");
  const payload = {
    token: newToken,
    createdAt: new Date().toISOString(),
  };

  try {
    fs.writeFileSync(tokenFile, JSON.stringify(payload, null, 2), { mode: 0o600 });
    logger.info("Generated new local security token at:", tokenFile);
  } catch (err) {
    logger.error("Failed to write local token file:", err.message);
  }

  return newToken;
}

/**
 * Timing-safe comparison to prevent timing attacks
 */
function verifyToken(providedToken, expectedToken) {
  if (!providedToken || !expectedToken) return false;
  if (typeof providedToken !== "string" || typeof expectedToken !== "string") return false;

  const bufProvided = Buffer.from(providedToken, "utf8");
  const bufExpected = Buffer.from(expectedToken, "utf8");

  if (bufProvided.length !== bufExpected.length) {
    return false;
  }

  return crypto.timingSafeEqual(bufProvided, bufExpected);
}

module.exports = {
  TOKEN_FILENAME,
  getOrCreateLocalToken,
  verifyToken,
};
