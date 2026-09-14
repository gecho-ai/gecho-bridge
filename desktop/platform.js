"use strict";

const zlib = require("node:zlib");

function loginItemOptions(platform, executable) {
  return platform === "win32" ? { path: executable, args: ["--hidden"] } : {};
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuffer, data]);
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  body.copy(output, 4);
  output.writeUInt32BE(crc32(body), 8 + data.length);
  return output;
}

const fs = require("node:fs");
const path = require("node:path");

// Return the branded small tray icon, falling back to a generated icon.
function createTrayPng(platform = process.platform) {
  const assetName = platform === "win32" ? "tray-win-16.png" : "tray-iconTemplate.png";
  const assetPath = path.join(__dirname, "assets", assetName);
  if (fs.existsSync(assetPath)) {
    return fs.readFileSync(assetPath);
  }

  const raw = Buffer.alloc(16 * (1 + 16 * 4));
  for (let y = 0; y < 16; y += 1) {
    raw[y * 65] = 0;
    for (let x = 0; x < 16; x += 1) {
      const glyph = (x >= 4 && x <= 11 && (y === 3 || y === 12))
        || (x === 3 && y >= 4 && y <= 11)
        || (y === 8 && x >= 8 && x <= 12)
        || (x === 12 && y >= 8 && y <= 11);
      const offset = y * 65 + 1 + x * 4;
      raw.set(glyph ? [255, 255, 255, 255] : [220, 110, 55, 255], offset);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(16, 0);
  header.writeUInt32BE(16, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

module.exports = { loginItemOptions, createTrayPng };
