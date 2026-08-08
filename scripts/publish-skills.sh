#!/usr/bin/env bash
set -euo pipefail

# Stages the repository's standalone ClawHub skills and optionally publishes
# only the new/changed skills through `clawhub sync`.
usage() {
  cat <<'EOF'
Usage:
  ./scripts/publish-skills.sh [publish|stage|dry-run]

Description:
  Copy standalone skills into a clean staging directory, then optionally run
  ClawHub sync against that directory. The staging flow keeps local OpenClaw
  skill directories from being included by accident.

Environment variables:
  STAGE_DIR             Override the temporary staging directory
  SKILL_ROOTS           Space-separated source roots (default: "skills distribution-skills")
  CLAWHUB_REGISTRY      Override the ClawHub registry URL
  CLAWHUB_CLI           ClawHub command (default: "npx -y clawhub@latest")
  CLAWHUB_BUMP          Version bump for changed skills (default: patch)
  CLAWHUB_TAGS          Comma-separated ClawHub tags (default: latest)
  CLAWHUB_CHANGELOG     Changelog used for every published skill
  CLAWHUB_DISABLE_TELEMETRY  Set to 0 to keep ClawHub sync telemetry enabled

Examples:
  ./scripts/publish-skills.sh stage
  ./scripts/publish-skills.sh dry-run
  ./scripts/publish-skills.sh publish
EOF
}

MODE="${1:-publish}"

case "$MODE" in
  publish|stage|dry-run)
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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
STAGE_DIR="${STAGE_DIR:-/tmp/clean_publish_gecho_bridge_skills}"
SKILL_ROOTS="${SKILL_ROOTS:-skills distribution-skills}"
CLAWHUB_REGISTRY="${CLAWHUB_REGISTRY:-}"
# Skills for this repository are owned by the Gecho AI team. Keep this fixed
# so a shell-level environment variable cannot redirect a release to a
# personal account by accident.
CLAWHUB_OWNER="gecho-ai"
CLAWHUB_CLI="${CLAWHUB_CLI:-npx -y clawhub@latest}"
CLAWHUB_BUMP="${CLAWHUB_BUMP:-patch}"
CLAWHUB_TAGS="${CLAWHUB_TAGS:-latest}"
CLAWHUB_CHANGELOG="${CLAWHUB_CHANGELOG:-}"

case "$CLAWHUB_BUMP" in
  patch|minor|major)
    ;;
  *)
    echo "CLAWHUB_BUMP must be patch, minor, or major (got: $CLAWHUB_BUMP)." >&2
    exit 1
    ;;
esac

echo "Project root: $PROJECT_ROOT"
echo "Stage dir:    $STAGE_DIR"
echo "Mode:         $MODE"
echo "Skill roots:  $SKILL_ROOTS"
echo "ClawHub owner: $CLAWHUB_OWNER"

echo
echo "Preparing staged skills..."
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"

skill_count=0
stage_roots=()
for source_root in $SKILL_ROOTS; do
  source_dir="$PROJECT_ROOT/$source_root"
  if [[ ! -d "$source_dir" ]]; then
    echo "Skill root not found: $source_root" >&2
    exit 1
  fi

  stage_root="$STAGE_DIR/$(basename "$source_root")"
  mkdir -p "$stage_root"
  stage_roots+=("$stage_root")

  for skill_dir in "$source_dir"/*; do
    [[ -d "$skill_dir" ]] || continue
    if [[ ! -f "$skill_dir/SKILL.md" && ! -f "$skill_dir/skill.md" ]]; then
      continue
    fi

    slug="$(basename "$skill_dir")"
    destination="$stage_root/$slug"
    mkdir -p "$destination"
    rsync -a --delete "$skill_dir/" "$destination/"
    skill_count=$((skill_count + 1))
    echo "  staged $source_root/$slug"
  done
done

if [[ "$skill_count" -eq 0 ]]; then
  echo "No skill folders found in: $SKILL_ROOTS" >&2
  exit 1
fi

echo
echo "Staged $skill_count skill(s)."
if [[ "$MODE" == "stage" ]]; then
  echo "Stage completed. Review the skills at: $STAGE_DIR"
  exit 0
fi

# Keep the sync isolated from the developer's OpenClaw/Clawdbot skill roots.
# The user's ClawHub auth config is intentionally not overridden, so a prior
# `clawhub login` continues to work.
export CLAWDBOT_STATE_DIR="$STAGE_DIR/.clawdbot-state"
export OPENCLAW_STATE_DIR="$STAGE_DIR/.openclaw-state"
export CLAWHUB_DISABLE_TELEMETRY="${CLAWHUB_DISABLE_TELEMETRY:-1}"

read -r -a clawhub_command <<< "$CLAWHUB_CLI"
if ! command -v "${clawhub_command[0]}" >/dev/null 2>&1; then
  echo "ClawHub command not found: $CLAWHUB_CLI" >&2
  exit 1
fi

sync_help="$("${clawhub_command[@]}" sync --help 2>&1)"
if [[ "$sync_help" != *"--owner"* ]]; then
  echo "The configured ClawHub CLI does not support sync --owner." >&2
  echo "Use the default latest CLI or set CLAWHUB_CLI='npx -y clawhub@latest'." >&2
  exit 1
fi

sync_args=(
  --no-input
  --workdir "$STAGE_DIR"
  --dir "$(basename "${stage_roots[0]}")"
  sync
  --all
  --owner "$CLAWHUB_OWNER"
  --bump "$CLAWHUB_BUMP"
  --tags "$CLAWHUB_TAGS"
)

for stage_root in "${stage_roots[@]:1}"; do
  sync_args+=(--root "$stage_root")
done

if [[ -n "$CLAWHUB_CHANGELOG" ]]; then
  sync_args+=(--changelog "$CLAWHUB_CHANGELOG")
fi

if [[ -n "$CLAWHUB_REGISTRY" ]]; then
  sync_args=(--registry "$CLAWHUB_REGISTRY" "${sync_args[@]}")
fi

echo
if [[ "$MODE" == "dry-run" ]]; then
  echo "Previewing ClawHub skill publication..."
  sync_args+=(--dry-run)
else
  echo "Publishing changed skills to ClawHub..."
fi

printf '%q' "${clawhub_command[0]}"
if [[ "${#clawhub_command[@]}" -gt 1 ]]; then
  printf ' %q' "${clawhub_command[@]:1}"
fi
printf ' %q' "${sync_args[@]}"
printf '\n'

"${clawhub_command[@]}" "${sync_args[@]}"
