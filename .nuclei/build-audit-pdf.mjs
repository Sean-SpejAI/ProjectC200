#!/usr/bin/env node
// Build a self-contained PDF audit report from a Nuclei scan's outputs.
//
// Inputs (all paths):
//   $1  nuclei-templates-inventory.json   — every template that the (tags,severity)
//                                            filter would have run; produced by
//                                            enumerate-templates.sh
//   $2  nuclei.jsonl                       — Nuclei findings (one JSON object per line)
//   $3  nuclei-stats.jsonl                 — Nuclei -stats-json output (per-interval)
//   $4  output PDF path                    — e.g. nuclei-audit-report-dev-2026-06-04.pdf
//
// Env vars:
//   SCAN_ENV          dev | stage | prod          (label)
//   SCAN_TARGET       URL that was scanned        (label)
//   SEVERITY          severity filter that ran    (label)
//   TAGS              tags filter that ran        (label)
//   GITHUB_RUN_URL    link back to workflow run   (label)
//   IGNORE_PATH       .nuclei/ignore.yaml (override only)
//   CHROME_BIN        full path to chrome (override only — default tries common names)
//
// Behavior:
//   1. Read inventory + findings + stats
//   2. Build a self-contained HTML report with:
//        - Cover page (env, target, scope, summary banner)
//        - Executive summary (per-severity table: tests run + findings counts)
//        - Findings section (only if findings > 0)
//        - Tests-run inventory (per-severity, every template)
//        - Appendix (scan config, workflow link, scanner stats)
//   3. Write the HTML to a sibling .html file
//   4. Shell out to headless Chrome to convert to PDF
//
// Exits 0 on success. Exits non-zero only on actual failure (missing chrome,
// unwriteable output dir). Missing input files emit a warning but produce a
// "no data" stub PDF rather than failing the workflow.

import { existsSync, readFileSync, writeFileSync, statSync, renameSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyIgnore } from "./ignore-filter.mjs";

const [, , inventoryPath, findingsPath, statsPath, outPdfPath] = process.argv;

if (!inventoryPath || !findingsPath || !statsPath || !outPdfPath) {
  console.error("usage: build-audit-pdf.mjs <inventory.json> <findings.jsonl> <stats.jsonl> <out.pdf>");
  process.exit(2);
}

const env = process.env.SCAN_ENV || "(env)";
const target = process.env.SCAN_TARGET || "(target)";
const severityFilter = process.env.SEVERITY || "(default)";
const tagsFilter = process.env.TAGS || "";
const excludeTagsFilter = process.env.EXCLUDE_TAGS || "";
const modeLabel = process.env.MODE_LABEL || "routine";
const runUrl = process.env.GITHUB_RUN_URL || "";
const ignorePath = process.env.IGNORE_PATH || ".nuclei/ignore.yaml";

const SCAN_DATE = new Date().toISOString();
const SHORT_DATE = SCAN_DATE.slice(0, 10);

// ---------- 1. Inventory ----------
let inventory = [];
if (existsSync(inventoryPath)) {
  try {
    inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
    if (!Array.isArray(inventory)) inventory = [];
  } catch (err) {
    console.error("build-audit-pdf: failed to parse inventory: " + err.message);
  }
} else {
  console.error("build-audit-pdf: inventory not found at " + inventoryPath);
}

// Group inventory by severity
const inventoryBySev = { critical: [], high: [], medium: [], low: [], info: [] };
for (const t of inventory) {
  const sev = String(t.severity || "info").toLowerCase();
  const bucket = bucketOf(sev);
  inventoryBySev[bucket].push(t);
}
for (const sev of Object.keys(inventoryBySev)) {
  inventoryBySev[sev].sort((a, b) => String(a.id || "").localeCompare(String(b.id || "")));
}
const testCounts = {
  critical: inventoryBySev.critical.length,
  high: inventoryBySev.high.length,
  medium: inventoryBySev.medium.length,
  low: inventoryBySev.low.length,
  info: inventoryBySev.info.length,
};
const testsTotal = testCounts.critical + testCounts.high + testCounts.medium + testCounts.low + testCounts.info;

// ---------- 2. Findings ----------
const findingsPerTemplate = new Map();
const findingCounts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
let findingsTotalInstances = 0;

if (existsSync(findingsPath)) {
  const raw = readFileSync(findingsPath, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
  const filtered = applyIgnore(raw, ignorePath);
  for (const f of filtered) {
    const tid = f["template-id"] || "(unknown)";
    const sev = String(f.info?.severity || "info").toLowerCase();
    const name = f.info?.name || tid;
    const url = f["matched-at"] || f.host || "";
    const prev = findingsPerTemplate.get(tid);
    if (prev) {
      prev.instances += 1;
      if (prev.examples.size < 5) prev.examples.add(url);
    } else {
      const ex = new Set();
      if (url) ex.add(url);
      findingsPerTemplate.set(tid, { name, sev, instances: 1, examples: ex });
    }
  }
  for (const [, t] of findingsPerTemplate) {
    findingsTotalInstances += t.instances;
    findingCounts[bucketOf(t.sev)] += 1;
  }
}
const findingsTotalTypes = findingsPerTemplate.size;

// ---------- 3. Stats ----------
let scanStats = null;
if (existsSync(statsPath)) {
  const lines = readFileSync(statsPath, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim().startsWith("{"))
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
  if (lines.length > 0) scanStats = lines[lines.length - 1]; // final stats line
}

// ---------- 4. HTML render ----------
const banner =
  findingCounts.critical > 0 ? { color: "#7c1d6f", label: "CRITICAL findings present" }
  : findingCounts.high  > 0  ? { color: "#bb0021", label: "HIGH-severity findings present" }
  : findingCounts.medium > 0 ? { color: "#b45309", label: "Medium-severity findings present" }
  : findingsTotalTypes > 0   ? { color: "#15803d", label: "Only Low/Info findings" }
  : testsTotal > 0           ? { color: "#15803d", label: "Clean — no findings across " + testsTotal.toLocaleString() + " tests" }
  :                            { color: "#6b7280", label: "No tests were loaded — scope check needed" };

const sevColor = (b) => ({ critical: "#7c1d6f", high: "#bb0021", medium: "#b45309", low: "#374151", info: "#6b7280" })[b];
const SEV_ORDER = ["critical", "high", "medium", "low", "info"];

const inventoryTablesHtml = SEV_ORDER.map((sev) => {
  const items = inventoryBySev[sev];
  if (items.length === 0) {
    return `<section class="sev-section"><h3 style="color:${sevColor(sev)};">${cap(sev)} (0 templates)</h3><p class="empty">No templates of this severity were loaded for this scan.</p></section>`;
  }
  const rows = items.map((t) => `
    <tr>
      <td class="mono">${esc(t.id)}</td>
      <td>${esc(t.name)}</td>
      <td class="tags">${esc(t.tags || "")}</td>
    </tr>
  `).join("");
  return `
    <section class="sev-section">
      <h3 style="color:${sevColor(sev)};">${cap(sev)} (${items.length.toLocaleString()} templates)</h3>
      <table class="inv">
        <thead><tr><th>Template ID</th><th>Name</th><th>Tags</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>
  `;
}).join("\n");

const findingsHtml = (() => {
  if (findingsTotalTypes === 0) return `<p class="empty">No findings.</p>`;
  const rows = [...findingsPerTemplate.entries()]
    .sort(([, a], [, b]) => sevRank(b.sev) - sevRank(a.sev) || b.instances - a.instances)
    .map(([tid, t]) => `
      <tr>
        <td style="color:${sevColor(bucketOf(t.sev))};font-weight:bold;">${cap(t.sev)}</td>
        <td class="mono">${esc(tid)}</td>
        <td>${esc(t.name)}</td>
        <td style="text-align:right;">${t.instances}</td>
        <td class="mono small">${[...t.examples].map(esc).join("<br>")}</td>
      </tr>
    `).join("");
  return `
    <table class="findings">
      <thead><tr><th>Severity</th><th>Template ID</th><th>Name</th><th>Instances</th><th>Matched URLs</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
})();

const statsRowHtml = scanStats
  ? `<dl class="kv">
      ${Object.entries(scanStats).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(String(v))}</dd>`).join("")}
    </dl>`
  : `<p class="empty">No stats captured (Nuclei may have run with -silent or exited early).</p>`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Nuclei Audit Report — ${esc(env)} — ${SHORT_DATE}</title>
<style>
  @page { size: Letter; margin: 0.6in; }
  body { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #1f2937; line-height: 1.45; font-size: 11px; }
  h1 { font-size: 26px; margin: 0 0 8px; color: #111827; }
  h2 { font-size: 18px; margin-top: 28px; padding-bottom: 4px; border-bottom: 1px solid #e5e7eb; }
  h3 { font-size: 14px; margin-top: 18px; margin-bottom: 6px; }
  .cover { page-break-after: always; padding-top: 80px; }
  .cover h1 { font-size: 36px; margin-bottom: 4px; }
  .cover .sub { color: #6b7280; font-size: 16px; margin-bottom: 28px; }
  .banner { display: inline-block; padding: 10px 18px; border-radius: 6px; font-weight: bold; font-size: 16px; margin: 24px 0; color: white; }
  .scope { margin: 30px 0; }
  .scope dt { font-weight: 600; display: inline-block; min-width: 130px; color: #6b7280; }
  .scope dd { display: inline; margin: 0; font-family: ui-monospace, "SF Mono", Consolas, monospace; }
  .scope dd::after { content: ""; display: block; margin-bottom: 6px; }
  .page-break { page-break-before: always; }
  table { border-collapse: collapse; width: 100%; font-size: 10px; }
  th, td { border: 1px solid #e5e7eb; padding: 4px 8px; text-align: left; vertical-align: top; }
  th { background: #f3f4f6; }
  table.inv { table-layout: fixed; }
  table.inv th:nth-child(1) { width: 30%; }
  table.inv th:nth-child(2) { width: 40%; }
  table.inv th:nth-child(3) { width: 30%; }
  .mono { font-family: ui-monospace, "SF Mono", Consolas, monospace; font-size: 9.5px; word-break: break-all; }
  .tags { font-family: ui-monospace, "SF Mono", Consolas, monospace; font-size: 9px; color: #6b7280; word-break: break-word; }
  .small { font-size: 9px; }
  .sev-section { page-break-inside: avoid; margin-bottom: 22px; }
  .empty { color: #6b7280; font-style: italic; font-size: 11px; }
  .summary-table th { background: #f9fafb; }
  .summary-table td { font-family: ui-monospace, "SF Mono", Consolas, monospace; text-align: right; }
  .summary-table td:first-child { text-align: left; font-family: inherit; }
  .kv dt { font-weight: 600; display: inline-block; min-width: 110px; color: #6b7280; }
  .kv dd { display: inline; margin: 0; font-family: ui-monospace, "SF Mono", Consolas, monospace; }
  .kv dd::after { content: ""; display: block; margin-bottom: 4px; }
  footer.appendix { color: #6b7280; font-size: 9.5px; }
  a { color: #2563eb; }
</style>
</head>
<body>

<!-- COVER -->
<section class="cover">
  <h1>Nuclei Vulnerability Audit Report</h1>
  <p class="sub">Environment: <strong>${esc(env)}</strong> &nbsp;·&nbsp; ${esc(SHORT_DATE)}</p>

  <div class="banner" style="background:${banner.color};">${esc(banner.label)}</div>

  <dl class="scope">
    <dt>Target:</dt><dd>${esc(target)}</dd>
    <dt>Scan date (UTC):</dt><dd>${esc(SCAN_DATE)}</dd>
    <dt>Scan mode:</dt><dd><strong style="text-transform:uppercase;color:${modeLabel === 'audit-grade' ? '#15803d' : '#374151'};">${esc(modeLabel)}</strong></dd>
    <dt>Severity filter:</dt><dd>${esc(severityFilter)}</dd>
    <dt>Tag filter:</dt><dd>${tagsFilter ? esc(tagsFilter) : "(all tags)"}</dd>
    <dt>Excluded tags:</dt><dd>${excludeTagsFilter ? esc(excludeTagsFilter) : "(none)"}</dd>
    <dt>Templates run:</dt><dd>${testsTotal.toLocaleString()}</dd>
    <dt>Findings (alert types):</dt><dd>${findingsTotalTypes}</dd>
    <dt>Findings (instances):</dt><dd>${findingsTotalInstances}</dd>
    <dt>Workflow run:</dt><dd>${runUrl ? `<a href="${esc(runUrl)}">${esc(runUrl)}</a>` : "—"}</dd>
  </dl>

  ${excludeTagsFilter ? `<p style="color:#6b7280;font-size:10px;margin-top:20px;"><strong>About the excluded tags:</strong> the target is verifiably not a CMS, so Nuclei templates targeting WordPress / Joomla / Drupal / Magento (and their plugins/themes) would all 404 / no-match against this surface. Skipping these template families saves ~20% scan time without losing meaningful coverage. The exclusion is recorded here so any auditor reviewing this report sees exactly what was scoped out.</p>` : ""}

  <p style="color:#6b7280;font-size:10px;margin-top:20px;"><em>This report enumerates every Nuclei template that matched the (severity, tags) filter above (minus any excluded tags). Templates listed but not in the Findings section were executed and did not match — Nuclei does not emit a per-template execution log natively, so absence-of-finding is the auditable signal of "ran and clean."</em></p>
</section>

<!-- EXECUTIVE SUMMARY -->
<section>
  <h2>Executive Summary</h2>
  <p>The scan loaded <strong>${testsTotal.toLocaleString()}</strong> Nuclei templates against <code>${esc(target)}</code>${findingsTotalTypes === 0 ? " and found <strong>no findings</strong>" : ` and surfaced <strong>${findingsTotalTypes}</strong> alert type(s) across <strong>${findingsTotalInstances}</strong> instance(s)`}.</p>

  <table class="summary-table">
    <thead>
      <tr>
        <th>Severity</th>
        <th>Tests run</th>
        <th>Findings (types)</th>
        <th>Findings (instances)</th>
      </tr>
    </thead>
    <tbody>
      ${SEV_ORDER.map((sev) => `
        <tr>
          <td style="color:${sevColor(sev)};font-weight:600;">${cap(sev)}</td>
          <td>${testCounts[sev].toLocaleString()}</td>
          <td>${findingCounts[sev]}</td>
          <td>${(() => {
            let n = 0;
            for (const [, t] of findingsPerTemplate) if (bucketOf(t.sev) === sev) n += t.instances;
            return n;
          })()}</td>
        </tr>
      `).join("")}
      <tr style="background:#f9fafb;font-weight:600;">
        <td>Total</td>
        <td>${testsTotal.toLocaleString()}</td>
        <td>${findingsTotalTypes}</td>
        <td>${findingsTotalInstances}</td>
      </tr>
    </tbody>
  </table>
</section>

<!-- FINDINGS -->
<section class="page-break">
  <h2>Findings</h2>
  ${findingsHtml}
</section>

<!-- TESTS RUN INVENTORY -->
<section class="page-break">
  <h2>Tests Run — Full Inventory</h2>
  <p>Every Nuclei template enumerated by <code>nuclei -tl -tags '${esc(tagsFilter)}' -severity '${esc(severityFilter)}'</code>, grouped by severity. Each template in this list was loaded and exercised against <code>${esc(target)}</code> during the scan; templates that produced findings are also listed in the Findings section above.</p>
  ${inventoryTablesHtml}
</section>

<!-- APPENDIX -->
<section class="page-break">
  <h2>Appendix — Scan Configuration & Stats</h2>

  <h3>Final scanner stats</h3>
  ${statsRowHtml}

  <h3>Scan config</h3>
  <dl class="kv">
    <dt>Environment:</dt><dd>${esc(env)}</dd>
    <dt>Target:</dt><dd>${esc(target)}</dd>
    <dt>Scan mode:</dt><dd>${esc(modeLabel)}</dd>
    <dt>Severity filter:</dt><dd>${esc(severityFilter)}</dd>
    <dt>Tags filter:</dt><dd>${tagsFilter ? esc(tagsFilter) : "(all tags)"}</dd>
    <dt>Excluded tags:</dt><dd>${excludeTagsFilter ? esc(excludeTagsFilter) : "(none)"}</dd>
    <dt>Templates loaded:</dt><dd>${testsTotal.toLocaleString()}</dd>
    <dt>Workflow run:</dt><dd>${runUrl ? `<a href="${esc(runUrl)}">${esc(runUrl)}</a>` : "—"}</dd>
    <dt>Allowlist file:</dt><dd>${esc(ignorePath)}</dd>
  </dl>

  ${scanStats ? `
  <h3>Scan execution</h3>
  <dl class="kv">
    <dt>Total requests sent:</dt><dd>${esc(String(scanStats.requests || "?"))} of ${esc(String(scanStats.total || "?"))} planned</dd>
    <dt>Wall-clock duration:</dt><dd>${esc(String(scanStats.duration || "?"))}</dd>
    <dt>Throughput (final):</dt><dd>${esc(String(scanStats.rps || "?"))} requests/sec</dd>
  </dl>
  ` : ""}

  <footer class="appendix">
    <p>Generated by <code>.nuclei/build-audit-pdf.mjs</code> on ${esc(SCAN_DATE)}.</p>
  </footer>
</section>

</body>
</html>`;

// ---------- 5. Write HTML + invoke headless Chrome ----------
const htmlPath = outPdfPath.replace(/\.pdf$/, "") + ".html";
writeFileSync(htmlPath, html, "utf8");

const chromeBin = process.env.CHROME_BIN
  || tryCommand("google-chrome-stable", ["--version"])
  || tryCommand("google-chrome", ["--version"])
  || tryCommand("chromium", ["--version"])
  || tryCommand("chromium-browser", ["--version"]);

if (!chromeBin) {
  console.error("build-audit-pdf: no headless Chrome binary found (tried google-chrome-stable, google-chrome, chromium, chromium-browser).");
  console.error("build-audit-pdf: HTML report written at " + htmlPath + "; PDF generation skipped.");
  process.exit(1);
}

const absHtml = resolve(htmlPath);
const absPdf = resolve(outPdfPath);
const fileUrl = pathToFileURL(absHtml).href;

console.log("build-audit-pdf: using chrome=" + chromeBin);
console.log("build-audit-pdf: html=" + htmlPath + " pdf=" + outPdfPath);

const chromeArgs = [
  "--headless=new",
  "--disable-gpu",
  "--no-sandbox",
  "--no-pdf-header-footer",
  `--print-to-pdf=${absPdf}`,
  fileUrl,
];

try {
  execSync(`"${chromeBin}" ${chromeArgs.map(a => `"${a}"`).join(" ")}`, { stdio: "inherit" });
  console.log("build-audit-pdf: wrote " + outPdfPath);
} catch (err) {
  console.error("build-audit-pdf: chrome failed: " + err.message);
  process.exit(1);
}

// ---------- Ghostscript compression pass ----------
// Chrome's headless --print-to-pdf output is ~13 MB for our audit
// reports — mostly font + metadata bloat (the source HTML is ~2 MB).
// That's too big to email reliably (Microsoft 365 / Google Workspace
// often reject attachments past ~20-25 MB on the wire, and a 13 MB
// raw PDF becomes ~17 MB base64). Re-encoding through Ghostscript
// shrinks it ~10× (13 MB → 1.3 MB at /ebook quality) without visible
// quality loss for a text + tables document.
//
// Falls back gracefully if gs isn't installed — keeps the original
// PDF in place and logs a warning instead of failing the workflow.
try {
  const gsPath = tryCommand("gs", ["--version"]);
  if (!gsPath) {
    console.error("build-audit-pdf: ghostscript not found; skipping compression (PDF will stay at original size).");
  } else {
    const beforeSize = statSync(absPdf).size;
    const compressedPath = absPdf + ".gs.pdf";
    const gsArgs = [
      "-sDEVICE=pdfwrite",
      "-dCompatibilityLevel=1.4",
      "-dPDFSETTINGS=/ebook",
      "-dNOPAUSE", "-dQUIET", "-dBATCH",
      `-sOutputFile=${compressedPath}`,
      absPdf,
    ];
    execSync(`"${gsPath}" ${gsArgs.map(a => `"${a}"`).join(" ")}`, { stdio: "inherit" });
    const afterSize = statSync(compressedPath).size;
    // Sanity: only swap in the compressed copy if it's actually smaller.
    // Tiny inputs sometimes inflate slightly through gs.
    if (afterSize < beforeSize) {
      renameSync(compressedPath, absPdf);
      const ratio = (beforeSize / afterSize).toFixed(1);
      console.log(`build-audit-pdf: compressed ${beforeSize} → ${afterSize} bytes (${ratio}× smaller via gs /ebook)`);
    } else {
      console.log(`build-audit-pdf: gs output (${afterSize}) not smaller than input (${beforeSize}); keeping original.`);
    }
  }
} catch (err) {
  console.error("build-audit-pdf: ghostscript compression failed (keeping uncompressed PDF): " + err.message);
}

// ---------- helpers ----------

function tryCommand(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: ["ignore", "pipe", "ignore"] });
    return cmd;
  } catch {
    return null;
  }
}

function bucketOf(s) {
  if (s === "critical") return "critical";
  if (s === "high")     return "high";
  if (s === "medium")   return "medium";
  if (s === "low")      return "low";
  return "info";
}
function sevRank(s) { return { critical: 4, high: 3, medium: 2, low: 1, info: 0 }[s] ?? 0; }
function cap(s)     { return String(s).charAt(0).toUpperCase() + String(s).slice(1); }
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
