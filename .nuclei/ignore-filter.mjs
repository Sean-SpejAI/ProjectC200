// Apply .nuclei/ignore.yaml to a Nuclei findings list.
//
// ignore.yaml shape (intentionally tiny — extend as real findings demand
// filtering; don't preemptively populate):
//
//   template_ids:
//     - http-missing-security-headers   # comment why
//     - ...
//   tags:
//     - tech
//   match_url_patterns:
//     - "^https?://.*\\.vercel\\.app/_next/"  # vercel build asset fingerprints
//     - ...
//
// All matchers OR together; a finding is kept iff it matches none.

import { existsSync, readFileSync } from "node:fs";

export function applyIgnore(findings, ignorePath) {
  const rules = loadRules(ignorePath);
  if (!rules) return findings;
  return findings.filter((f) => !shouldIgnore(f, rules));
}

function loadRules(path) {
  if (!path || !existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  const out = { template_ids: new Set(), tags: new Set(), url_res: [] };
  // Tiny line-based YAML parser. We don't need real YAML for a single
  // shallow object with three string-array fields. Adding js-yaml just for
  // this would be overkill.
  let section = null;
  for (const line of raw.split(/\r?\n/)) {
    const stripped = line.replace(/#.*$/, "").trimEnd();
    if (!stripped.trim()) continue;
    if (/^template_ids:/.test(stripped))        { section = "template_ids"; continue; }
    if (/^tags:/.test(stripped))                { section = "tags"; continue; }
    if (/^match_url_patterns:/.test(stripped))  { section = "url_patterns"; continue; }
    if (!section) continue;
    const m = stripped.match(/^\s*-\s*"?([^"]+)"?\s*$/);
    if (!m) continue;
    const val = m[1].trim();
    if (section === "template_ids") out.template_ids.add(val);
    else if (section === "tags")    out.tags.add(val);
    else if (section === "url_patterns") {
      try { out.url_res.push(new RegExp(val)); }
      catch { /* skip malformed regex */ }
    }
  }
  return out;
}

function shouldIgnore(f, rules) {
  if (rules.template_ids.has(f["template-id"])) return true;
  const tags = Array.isArray(f.info?.tags) ? f.info.tags : String(f.info?.tags || "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const t of tags) {
    if (rules.tags.has(t)) return true;
  }
  const url = f["matched-at"] || f.host || "";
  for (const re of rules.url_res) {
    if (re.test(url)) return true;
  }
  return false;
}
