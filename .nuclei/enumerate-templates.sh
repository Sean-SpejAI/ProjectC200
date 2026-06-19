#!/bin/sh
# Enumerate every Nuclei template that matches the given (tags, severity)
# filter and emit a JSON inventory with id, name, severity, tags per template.
#
# Designed to run INSIDE the projectdiscovery/nuclei:latest container via
# `--entrypoint sh`. Alpine-compatible — POSIX sh + busybox awk only,
# no jq / python / bash features.
#
# Usage (from outside docker):
#   docker run --rm -v $WS:/work -w /work --entrypoint sh \
#     projectdiscovery/nuclei:latest \
#     /work/.nuclei/enumerate-templates.sh "<tags>" "<severity>"
#
# Output: /work/nuclei-templates-inventory.json (single JSON array)
#
# Why this exists: Nuclei's -tl output is paths only — no severity/tags
# metadata per line. For audit reports we need to enumerate the would-run
# template set with structured metadata so the reader can see what was
# actually tested. We parse each template YAML's `info:` block (the schema
# is stable across the nuclei-templates repo).
#
# Limitations:
# - YAML `tags:` lists in expanded form (multi-line `- tag` syntax) are
#   not supported — only the common inline `tags: a,b,c` form. Templates
#   in the projectdiscovery repo overwhelmingly use the inline form.
# - JSON escaping is conservative (backslash + double-quote only); template
#   names with embedded newlines or other control chars would be malformed.
#   Haven't seen any in the wild but worth knowing.

set -eu

TAGS="${1:-}"
SEVERITY="${2:-}"
EXCLUDE_TAGS="${3:-}"
OUT="${OUT:-/work/nuclei-templates-inventory.json}"

if [ -z "$SEVERITY" ]; then
  echo "usage: enumerate-templates.sh <tags> <severity> [<exclude_tags>]" >&2
  echo "  tags         positive tag filter (comma-separated), or empty for all tags" >&2
  echo "  severity     severity filter (comma-separated), required" >&2
  echo "  exclude_tags tags to exclude (comma-separated), optional" >&2
  exit 2
fi

# Enumerate template paths.
TMP_PATHS="$(mktemp)"
trap 'rm -f "$TMP_PATHS"' EXIT

# Build nuclei -tl args. -tags is omitted when TAGS is empty (= all tags).
# -exclude-tags is omitted when EXCLUDE_TAGS is empty.
NUCLEI_TL_ARGS="-severity $SEVERITY -silent"
[ -n "$TAGS" ]         && NUCLEI_TL_ARGS="$NUCLEI_TL_ARGS -tags $TAGS"
[ -n "$EXCLUDE_TAGS" ] && NUCLEI_TL_ARGS="$NUCLEI_TL_ARGS -exclude-tags $EXCLUDE_TAGS"

# -tl prints one path per line; -silent strips the banner so we only get paths.
# shellcheck disable=SC2086
nuclei -tl $NUCLEI_TL_ARGS > "$TMP_PATHS" 2>/dev/null || true

COUNT=$(wc -l < "$TMP_PATHS" | tr -d ' ')
echo "enumerate-templates: $COUNT template paths matched filter (severity=$SEVERITY tags=${TAGS:-<all>} exclude-tags=${EXCLUDE_TAGS:-<none>})" >&2

# Locate the nuclei templates directory so we can resolve the relative paths
# that -tl returns. Try the standard install location first, fall back to
# searching common alternates. -tl outputs paths like "http/cves/2024/X.yaml"
# (relative to the templates dir), NOT absolute paths from /work.
TEMPLATES_DIR=""
for candidate in /root/nuclei-templates "$HOME/nuclei-templates" /opt/nuclei-templates; do
  if [ -d "$candidate" ]; then
    TEMPLATES_DIR="$candidate"
    break
  fi
done
echo "enumerate-templates: templates_dir=$TEMPLATES_DIR" >&2

# Show the first 3 path-as-listed lines so future debugging is easy when
# the format changes upstream.
echo "enumerate-templates: first 3 paths from -tl:" >&2
head -3 "$TMP_PATHS" | sed 's/^/  /' >&2

# Build a JSON array. We emit it line-by-line via awk on the path list,
# parsing each referenced YAML inline. Output is human-readable (one
# object per line + indentation) so a `diff` between runs is reviewable.
printf '[\n' > "$OUT"

resolve_path() {
  rp="$1"
  # Absolute and exists? use as-is.
  case "$rp" in
    /*)
      [ -f "$rp" ] && printf '%s' "$rp" && return 0
      return 1
      ;;
  esac
  # Strip a leading "./" if present.
  rp="${rp#./}"
  # Relative — try templates dir prefix first.
  if [ -n "$TEMPLATES_DIR" ] && [ -f "$TEMPLATES_DIR/$rp" ]; then
    printf '%s' "$TEMPLATES_DIR/$rp"
    return 0
  fi
  # Last resort: relative to cwd.
  if [ -f "$rp" ]; then
    printf '%s' "$rp"
    return 0
  fi
  return 1
}

SKIPPED=0
FIRST=1
while IFS= read -r p; do
  [ -z "$p" ] && continue
  full_path=$(resolve_path "$p") || { SKIPPED=$((SKIPPED + 1)); continue; }
  p="$full_path"

  # awk parses the YAML's `info:` block. Tracks state (top-level vs inside
  # info:). Extracts id (top-level), name, severity, tags (under info:).
  meta=$(awk '
    BEGIN { id=""; name=""; sev=""; tags=""; in_info=0 }
    /^id:[[:space:]]/  { sub(/^id:[[:space:]]*/, "", $0); id=$0; next }
    /^info:[[:space:]]*$/ { in_info=1; next }
    in_info && /^[^[:space:]]/ { in_info=0 }   # any unindented line ends info block
    in_info && /^  name:[[:space:]]/      { sub(/^  name:[[:space:]]*/, "", $0); name=$0; next }
    in_info && /^  severity:[[:space:]]/  { sub(/^  severity:[[:space:]]*/, "", $0); sev=$0; next }
    in_info && /^  tags:[[:space:]]/      { sub(/^  tags:[[:space:]]*/, "", $0); tags=$0; next }
    END {
      # Strip surrounding quotes if present (templates often quote name/tags)
      gsub(/^"|"$/, "", name)
      gsub(/^"|"$/, "", sev)
      gsub(/^"|"$/, "", tags)
      gsub(/^"|"$/, "", id)
      # Strip control characters (CR from CRLF templates, tabs, embedded
      # newlines from multi-line YAML scalars). These are not valid in JSON
      # string values without escaping, and stripping is safe because we
      # do not need fidelity for whitespace in template metadata.
      gsub(/[[:cntrl:]]/, "", name)
      gsub(/[[:cntrl:]]/, "", id)
      gsub(/[[:cntrl:]]/, "", tags)
      gsub(/[[:cntrl:]]/, "", sev)
      # JSON-escape: \ must become \\ and " must become \".
      # awk gsub interprets \\ in the replacement as a literal \, so to get
      # \\ in the output you need \\\\ in the replacement string, which is
      # 8 backslashes in the awk source string literal.
      gsub(/\\/, "\\\\\\\\", name); gsub(/"/, "\\\\\"", name)
      gsub(/\\/, "\\\\\\\\", id);   gsub(/"/, "\\\\\"", id)
      gsub(/\\/, "\\\\\\\\", tags); gsub(/"/, "\\\\\"", tags)
      gsub(/\\/, "\\\\\\\\", sev);  gsub(/"/, "\\\\\"", sev)
      printf "%s\t%s\t%s\t%s", id, name, sev, tags
    }
  ' "$p")

  # Split awk output by tab into shell vars.
  IFS='	' read -r T_ID T_NAME T_SEV T_TAGS <<EOF
$meta
EOF

  # JSON-escape the path too (paths are simple ASCII filesystem paths;
  # no embedded quotes/newlines expected).
  esc_path=$(printf '%s' "$p" | sed 's/\\/\\\\/g; s/"/\\"/g')

  if [ $FIRST -eq 1 ]; then
    FIRST=0
  else
    printf ',\n' >> "$OUT"
  fi
  printf '  {"path":"%s","id":"%s","name":"%s","severity":"%s","tags":"%s"}' \
    "$esc_path" "${T_ID:-}" "${T_NAME:-}" "${T_SEV:-info}" "${T_TAGS:-}" >> "$OUT"
done < "$TMP_PATHS"

printf '\n]\n' >> "$OUT"

WRITTEN=$((COUNT - SKIPPED))
echo "enumerate-templates: wrote $OUT ($WRITTEN templates; skipped $SKIPPED unresolvable paths)" >&2
