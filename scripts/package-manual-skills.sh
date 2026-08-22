#!/usr/bin/env bash
set -euo pipefail

# Create one uploadable ZIP per distributable Skill.
# The ZIP root is the Skill directory itself, so SKILL.md is at archive root.

usage() {
  cat <<'EOF'
Usage:
  ./scripts/package-manual-skills.sh [output-dir]

Description:
  Package every Skill under the distribution roots into one ZIP per Skill for
  Aily SkillHub and other manual-upload platforms.
  The default output directory is tmp/manual-skill-packages/ inside this project.
  Existing files in that generated directory are removed before packaging.

Environment variables:
  PACKAGE_OUTPUT_DIR  Override the output directory.
  SKILL_ROOTS         Space-separated Skill roots. Default:
                      "distribution-skills distribution-skills-zh-CN"
  SKILL_VALIDATE      Run the repository-wide Skill validation first (default: 1).

Examples:
  ./scripts/package-manual-skills.sh
  SKILL_VALIDATE=0 ./scripts/package-manual-skills.sh
  SKILL_ROOTS="skills skills-zh-CN" ./scripts/package-manual-skills.sh
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" || "${1:-}" == "help" ]]; then
  usage
  exit 0
fi

if [[ "$#" -gt 1 ]]; then
  echo "Only one optional output directory is supported." >&2
  usage >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEFAULT_OUTPUT_DIR="$PROJECT_ROOT/tmp/manual-skill-packages"
OUTPUT_DIR="${PACKAGE_OUTPUT_DIR:-${1:-$DEFAULT_OUTPUT_DIR}}"
SKILL_ROOTS="${SKILL_ROOTS:-distribution-skills distribution-skills-zh-CN}"
SKILL_VALIDATE="${SKILL_VALIDATE:-1}"

if [[ "$OUTPUT_DIR" != /* ]]; then
  OUTPUT_DIR="$PROJECT_ROOT/$OUTPUT_DIR"
fi

case "$SKILL_VALIDATE" in
  0|1)
    ;;
  *)
    echo "SKILL_VALIDATE must be 0 or 1 (got: $SKILL_VALIDATE)." >&2
    exit 1
    ;;
esac

for command_name in node zip unzip; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "$command_name is required but was not found." >&2
    exit 1
  fi
done

resolve_path() {
  local value="$1"
  if [[ "$value" == /* ]]; then
    printf '%s\n' "$value"
  else
    printf '%s/%s\n' "$PROJECT_ROOT" "$value"
  fi
}

read_version() {
  local metadata_path="$1"
  METADATA_PATH="$metadata_path" node <<'NODE'
const fs = require("fs");

const metadataPath = process.env.METADATA_PATH;
let metadata;
try {
  metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
} catch (error) {
  console.error(`Invalid _meta.json: ${metadataPath}: ${error.message}`);
  process.exit(1);
}

if (typeof metadata.version !== "string" || metadata.version.length === 0) {
  console.error(`Missing version in _meta.json: ${metadataPath}`);
  process.exit(1);
}

process.stdout.write(metadata.version);
NODE
}

if [[ "$SKILL_VALIDATE" == "1" ]]; then
  echo "Running Skill validation..."
  node "$PROJECT_ROOT/scripts/validate-skills.js"
fi

echo "Output directory: $OUTPUT_DIR"
echo "Skill roots:      $SKILL_ROOTS"

# This directory is generated output. It is intentionally cleaned and rebuilt
# so the manifest and ZIPs always describe the current source tree.
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

manifest_path="$OUTPUT_DIR/manifest.tsv"
printf 'source_root\tslug\tlocale\tversion\tarchive\n' > "$manifest_path"

# Keep duplicate tracking compatible with macOS's default Bash 3, which does
# not support associative arrays.
seen_records=""
package_count=0

for source_root in $SKILL_ROOTS; do
  source_dir="$(resolve_path "$source_root")"
  if [[ ! -d "$source_dir" ]]; then
    echo "Skill root not found: $source_root" >&2
    exit 1
  fi

  root_label="$(basename "$source_dir")"
  locale="en"
  if [[ "$root_label" == *-zh-CN ]]; then
    locale="zh-CN"
  fi

  for skill_dir in "$source_dir"/*; do
    [[ -d "$skill_dir" ]] || continue
    [[ -f "$skill_dir/SKILL.md" ]] || continue

    slug="$(basename "$skill_dir")"
    skill_key="$locale/$slug"
    previous_source="$(printf '%s' "$seen_records" | awk -F '\t' -v key="$skill_key" '$1 == key { print $2; exit }')"
    if [[ -n "$previous_source" ]]; then
      echo "Skipping duplicate $source_root/$slug (already packaged from $previous_source)."
      continue
    fi

    metadata_path="$skill_dir/_meta.json"
    if [[ ! -f "$metadata_path" ]]; then
      echo "Missing _meta.json: $skill_dir" >&2
      exit 1
    fi
    version="$(read_version "$metadata_path")"
    archive_name="${slug}-${locale}-v${version}.zip"
    archive_path="$OUTPUT_DIR/$archive_name"

    # Run zip from inside the Skill directory so SKILL.md and all supporting
    # files are placed at the archive root rather than under a parent folder.
    (
      cd "$skill_dir"
      zip -q -X -r "$archive_path" . \
        -x '.DS_Store' '*/.DS_Store' \
        -x '.skillatlas-*' '*/.skillatlas-*' \
        -x 'publish.json' '*/publish.json' \
        -x 'skillhub-publish.json' '*/skillhub-publish.json' \
        -x '*.zip' '*/.zip'
    )

    unzip -t "$archive_path" >/dev/null
    if ! unzip -Z1 "$archive_path" | awk '$0 == "SKILL.md" { found = 1 } END { exit found ? 0 : 1 }'; then
      echo "SKILL.md is not at the archive root: $archive_path" >&2
      exit 1
    fi

    seen_records="${seen_records}${skill_key}"$'\t'"${source_root}/${slug}"$'\n'
    printf '%s\t%s\t%s\t%s\t%s\n' \
      "$source_root" "$slug" "$locale" "$version" "$archive_name" >> "$manifest_path"
    package_count=$((package_count + 1))
    echo "Packaged $source_root/$slug -> $archive_name"
  done
done

if [[ "$package_count" -eq 0 ]]; then
  echo "No Skill directories were packaged." >&2
  exit 1
fi

echo
echo "Created $package_count Skill ZIPs."
echo "Manifest: $manifest_path"
echo "Directory: $OUTPUT_DIR"
