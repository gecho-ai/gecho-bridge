#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const esbuild = require("esbuild");

// This script produces self-contained Node bundles for ClawHub publishing.
// The published bundle cannot rely on node_modules existing after install,
// so both the MCP entrypoint and the service are bundled into dist/.
const projectRoot = path.resolve(__dirname, "..");
const distDir = path.join(projectRoot, "dist");

async function build() {
  // Start from a clean dist/ so old artifacts never leak into a release.
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });

  // Shared build options for both runtime entrypoints.
  const shared = {
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    sourcemap: false,
    legalComments: "none"
  };

  // MCP stdio entry used by OpenClaw / ClawHub at runtime.
  await esbuild.build({
    ...shared,
    entryPoints: [path.join(projectRoot, "mcp-client.js")],
    outfile: path.join(distDir, "mcp-client.cjs")
  });

  // Background service that talks to the browser extension.
  await esbuild.build({
    ...shared,
    entryPoints: [path.join(projectRoot, "server.js")],
    outfile: path.join(distDir, "server.cjs")
  });

  // Keep the generated files directly executable for local verification.
  fs.chmodSync(path.join(distDir, "mcp-client.cjs"), 0o755);
  fs.chmodSync(path.join(distDir, "server.cjs"), 0o755);

  console.log(`Built bundle artifacts in ${distDir}`);
}

build().catch((error) => {
  console.error(error);
  process.exit(1);
});
