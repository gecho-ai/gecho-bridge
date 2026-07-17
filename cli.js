#!/usr/bin/env node

// Keep the package's MCP behaviour unchanged while reserving a small, explicit
// local administration surface for macOS wake scheduling.
const args = process.argv.slice(2);

if (args[0] === "wake") {
  require("./wake-cli").main(args.slice(1)).catch((error) => {
    console.error(`gecho-bridge wake: ${error.message || error}`);
    process.exitCode = 1;
  });
} else {
  require("./mcp-client");
}
