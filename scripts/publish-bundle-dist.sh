#!/usr/bin/env bash
set -euo pipefail

# Builds the self-contained dist artifacts, stages a clean publish directory,
# rewrites the MCP entry to point at dist/, and optionally publishes the result.
# This is the preferred release path because it avoids shipping node_modules.
usage() {
  cat <<'EOF'
Usage:
  ./scripts/publish-bundle-dist.sh [publish|stage]

Description:
  Build self-contained dist artifacts, stage a bundle-friendly directory,
  rewrite .mcp.json to use dist/mcp-client.cjs, then optionally publish it.

Environment variables:
  STAGE_DIR             Override the temp staging directory
  CLAWHUB_NAME          Override the ClawHub package name for this publish only
  CLAWHUB_OWNER         Override the ClawHub owner/publisher handle
  CLAWHUB_VERSION       Override the ClawHub version for this publish only
  CLAWHUB_DISPLAY_NAME  Override the ClawHub display name for this publish only
  CLAWHUB_FAMILY        Override the ClawHub family (default: bundle-plugin)

Examples:
  ./scripts/publish-bundle-dist.sh stage
  ./scripts/publish-bundle-dist.sh publish
EOF
}

MODE="${1:-publish}"

case "$MODE" in
  publish|stage)
    ;;
  -h|--help|help)
    usage
    exit 0
    ;;
  *)
    echo "Unknown mode: $MODE" >&2
    usage >&2
    exit 1
    ;;
esac

if ! command -v rsync >/dev/null 2>&1; then
  echo "rsync is required but not found." >&2
  exit 1
fi

if [[ "$MODE" == "publish" ]] && ! command -v clawhub >/dev/null 2>&1; then
  echo "clawhub is required but not found." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
STAGE_DIR="${STAGE_DIR:-/tmp/clean_publish_gecho_bridge_dist}"
CLAWHUB_FAMILY="${CLAWHUB_FAMILY:-bundle-plugin}"

echo "Project root: $PROJECT_ROOT"
echo "Stage dir:    $STAGE_DIR"
echo "Mode:         $MODE"

echo
echo "Building dist artifacts..."
# Bundle runtime dependencies into dist/ before staging for ClawHub.
(cd "$PROJECT_ROOT" && npm run build:bundle)

# Recreate a clean staging folder so each publish starts from known contents.
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"

# Copy the repo, but drop local-only folders that should not ship.
rsync -a \
  --delete \
  --exclude '.git/' \
  --exclude 'data/' \
  --exclude 'node_modules/' \
  --exclude '.openclaw/' \
  "$PROJECT_ROOT"/ "$STAGE_DIR"/

# Override the staged MCP entry to launch the bundled dist client instead of
# the source file, so installed bundle plugins can run without node_modules.
cat > "$STAGE_DIR/.mcp.json" <<'EOF'
{
  "mcpServers": {
    "gecho-tiktok-search": {
      "command": "node",
      "args": ["./dist/mcp-client.cjs"],
      "timeout": 600000,
      "retries": 0
    }
  }
}
EOF

echo
echo "Preparing staged ClawHub metadata..."
# Rewrite only the staged metadata so ClawHub naming can diverge from npm.
node "$PROJECT_ROOT/scripts/prepare-clawhub-stage.js" "$STAGE_DIR"

echo
echo "Staged files:"
find "$STAGE_DIR" -maxdepth 2 | sed "s#^$STAGE_DIR#.#" | sort

if [[ "$MODE" == "stage" ]]; then
  echo
  echo "Stage completed. Review the bundle at: $STAGE_DIR"
  exit 0
fi

echo
echo "Publishing bundle to ClawHub..."
# Build the publish command incrementally so optional overrides are easy to add.
publish_args=("$STAGE_DIR" "--family" "$CLAWHUB_FAMILY")

if [[ -n "${CLAWHUB_NAME:-}" ]]; then
  publish_args+=("--name" "$CLAWHUB_NAME")
fi

if [[ -n "${CLAWHUB_OWNER:-}" ]]; then
  publish_args+=("--owner" "$CLAWHUB_OWNER")
fi

if [[ -n "${CLAWHUB_VERSION:-}" ]]; then
  publish_args+=("--version" "$CLAWHUB_VERSION")
fi

if [[ -n "${CLAWHUB_DISPLAY_NAME:-}" ]]; then
  publish_args+=("--display-name" "$CLAWHUB_DISPLAY_NAME")
fi

printf 'clawhub package publish'
printf ' %q' "${publish_args[@]}"
printf '\n'

clawhub package publish "${publish_args[@]}"
