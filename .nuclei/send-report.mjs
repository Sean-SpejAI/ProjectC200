#!/usr/bin/env node
// Send a Nuclei scan report by email via Resend. The body shows the scan's
// scope, a per-severity table with two columns ("Tests run" + "Findings"),
// any findings inline, top-20 templates per severity for audit spot-checks,
// and points the reader at the PDF audit report in the workflow artifacts
// for the full per-template inventory.
//
// Env vars:
//   RESEND_API_KEY        Resend API key (sender uses info.spej.dev domain)
//   NUCLEI_REPORT_TO      recipient(s) — comma-separated. Distinct from
//                         ZAP_REPORT_TO so Nuclei + ZAP can target different
//                         audiences.
//   SCAN_ENV              dev | stage | prod  (label only)
//   SCAN_TARGET           URL that was scanned (label only)
//   SEVERITY              the severity filter that ran (label only)
//   TAGS                  the tag filter that ran (label only)
//   EXCLUDE_TAGS          tags excluded via -exclude-tags (label only)
//   MODE_LABEL            "routine" or "audit-grade" (label only)
//   STATS_PATH            path to nuclei-stats.jsonl (optional; final line's
//                         numbers are surfaced as proof-of-execution stats)
//   GITHUB_RUN_URL        link back to the workflow run (label only)
//   IGNORE_PATH           override .nuclei/ignore.yaml
//
// Args:
//   $1  path to nuclei.jsonl (required)
//   $2  path to nuclei-templates-inventory.json (optional)
//   $3  path to the PDF audit report (optional) — attached to the email
//       so recipients don't have to download from the workflow artifact.
//       Skipped silently if missing or > 35 MB (Resend's per-attachment
//       limit is 40 MB; leave headroom for the base64 inflation overhead).
//
// Exits 0 even on Resend failure — sending email shouldn't fail the CI run.

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { applyIgnore } from "./ignore-filter.mjs";

const REQUIRED = ["RESEND_API_KEY", "NUCLEI_REPORT_TO"];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error("send-report: missing env: " + missing.join(", ") + " — skipping email.");
  process.exit(0);
}

const [, , jsonlPath, inventoryPath, pdfPath] = process.argv;
const env = process.env.SCAN_ENV || "(env)";
const target = process.env.SCAN_TARGET || "(target)";
const severityFilter = process.env.SEVERITY || "(default)";
const tagsFilter = process.env.TAGS || "";
const excludeTagsFilter = process.env.EXCLUDE_TAGS || "";
const modeLabel = process.env.MODE_LABEL || "routine";
const statsPath = process.env.STATS_PATH || "nuclei-stats.jsonl";
const runUrl = process.env.GITHUB_RUN_URL || "";
const ignorePath = process.env.IGNORE_PATH || ".nuclei/ignore.yaml";

// Load final stats line for proof-of-execution numbers (requests sent,
// errors, duration). Optional — emails still render if stats are missing.
let scanStats = null;
if (existsSync(statsPath)) {
  const lines = readFileSync(statsPath, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim().startsWith("{"))
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
  if (lines.length > 0) scanStats = lines[lines.length - 1];
}

// ---------- 1. Findings ----------
const alerts    = { total: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 };
const instances = { total: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 };
const perTemplate = new Map();

if (jsonlPath && existsSync(jsonlPath)) {
  const raw = readFileSync(jsonlPath, "utf8")
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
    const prev = perTemplate.get(tid);
    if (prev) {
      prev.instances += 1;
      if (prev.examples.size < 3) prev.examples.add(url);
    } else {
      const ex = new Set();
      if (url) ex.add(url);
      perTemplate.set(tid, { name, sev, instances: 1, examples: ex });
    }
  }
  for (const [, t] of perTemplate) {
    alerts.total += 1;
    instances.total += t.instances;
    alerts[bucketOf(t.sev)] += 1;
    instances[bucketOf(t.sev)] += t.instances;
  }
} else {
  console.error("send-report: JSONL not found at " + jsonlPath + " — sending header-only email");
}

// ---------- 2. Inventory (templates loaded by tags+severity filter) ----------
const inventoryBySev = { critical: [], high: [], medium: [], low: [], info: [] };
let testsTotal = 0;
if (inventoryPath && existsSync(inventoryPath)) {
  try {
    const inv = JSON.parse(readFileSync(inventoryPath, "utf8"));
    if (Array.isArray(inv)) {
      for (const t of inv) {
        const sev = String(t.severity || "info").toLowerCase();
        inventoryBySev[bucketOf(sev)].push(t);
        testsTotal += 1;
      }
      for (const sev of Object.keys(inventoryBySev)) {
        inventoryBySev[sev].sort((a, b) => String(a.id || "").localeCompare(String(b.id || "")));
      }
    }
  } catch (err) {
    console.error("send-report: failed to parse inventory: " + err.message);
  }
}

const testCounts = {
  critical: inventoryBySev.critical.length,
  high: inventoryBySev.high.length,
  medium: inventoryBySev.medium.length,
  low: inventoryBySev.low.length,
  info: inventoryBySev.info.length,
};

// ---------- 3. HTML ----------
const banner =
  alerts.critical > 0 ? { color: "#7c1d6f", label: "🔴 CRITICAL findings present" }
  : alerts.high > 0   ? { color: "#bb0021", label: "🔴 HIGH-severity findings present" }
  : alerts.medium > 0 ? { color: "#b45309", label: "🟡 Medium-severity findings present" }
  : alerts.total > 0  ? { color: "#15803d", label: "🟢 Only Low/Info findings" }
  : testsTotal > 0    ? { color: "#15803d", label: "✅ Clean — " + testsTotal.toLocaleString() + " tests run, 0 findings" }
  :                     { color: "#6b7280", label: "⚠️ No tests loaded — scope check needed" };

const sevColor = (b) => ({ critical: "#7c1d6f", high: "#bb0021", medium: "#b45309", low: "#374151", info: "#6b7280" })[b];
const SEV_ORDER = ["critical", "high", "medium", "low", "info"];

const subject = `Nuclei scan (${env}) — ${testsTotal.toLocaleString()} tests, ${alerts.total} finding type(s)`;

const findingRowsHtml = [...perTemplate.entries()]
  .sort(([, a], [, b]) => sevRank(b.sev) - sevRank(a.sev) || b.instances - a.instances)
  .slice(0, 30)
  .map(([tid, t]) => `
    <tr>
      <td style="color:${sevColor(bucketOf(t.sev))};font-weight:600;">${esc(cap(t.sev))}</td>
      <td style="font-family:monospace;font-size:11px;">${esc(tid)}</td>
      <td>${esc(t.name)}</td>
      <td style="text-align:right;">${t.instances}</td>
      <td style="font-family:monospace;font-size:10px;color:#6b7280;">${[...t.examples].slice(0, 2).map(esc).join("<br>")}</td>
    </tr>
  `).join("");

const findingsMoreNote = alerts.total > 30
  ? `<p style="color:#6b7280;font-size:12px;"><em>… and ${alerts.total - 30} more finding template-ids. See the JSONL artifact + PDF audit report.</em></p>`
  : "";

// Top 20 inventory templates per severity — for spot-checking that real
// Nuclei templates were exercised. Full list lives in the PDF artifact.
const topInventoryHtml = SEV_ORDER.map((sev) => {
  const list = inventoryBySev[sev];
  if (list.length === 0) return "";
  const top = list.slice(0, 20);
  const more = list.length > 20 ? ` <span style="color:#9ca3af;font-weight:normal;">(+ ${list.length - 20} more, see PDF)</span>` : "";
  const rows = top.map((t) => `
    <tr>
      <td style="font-family:monospace;font-size:11px;">${esc(t.id || "(?)")}</td>
      <td>${esc(t.name || "")}</td>
    </tr>
  `).join("");
  return `
    <h3 style="color:${sevColor(sev)};margin:14px 0 4px;font-size:14px;">${cap(sev)} — ${list.length.toLocaleString()} templates loaded${more}</h3>
    <table style="border-collapse:collapse;border:1px solid #e5e7eb;width:100%;font-size:12px;">
      <thead><tr style="background:#f9fafb;"><th style="padding:4px 8px;text-align:left;border:1px solid #e5e7eb;">Template ID</th><th style="padding:4px 8px;text-align:left;border:1px solid #e5e7eb;">Name</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}).join("");

const bodyHtml = `<!doctype html><html><body style="font-family:Helvetica,Arial,sans-serif;color:#1f2937;">
<h2 style="margin-bottom:4px;">Nuclei scan — ${esc(env)}</h2>
<p style="color:#6b7280;margin-top:0;">Target: <code>${esc(target)}</code></p>
<p style="margin:14px 0;"><span style="display:inline-block;padding:6px 14px;border-radius:5px;color:white;font-weight:bold;background:${banner.color};">${esc(banner.label)}</span></p>

<h3 style="margin:18px 0 4px;">Scope</h3>
<table style="border-collapse:collapse;border:1px solid #e5e7eb;font-size:12px;margin:6px 0 14px;">
  <tbody>
    <tr><td style="padding:4px 10px;color:#6b7280;border:1px solid #e5e7eb;">Scan mode</td><td style="padding:4px 10px;border:1px solid #e5e7eb;"><strong style="text-transform:uppercase;color:${modeLabel === 'audit-grade' ? '#15803d' : '#374151'};">${esc(modeLabel)}</strong></td></tr>
    <tr><td style="padding:4px 10px;color:#6b7280;border:1px solid #e5e7eb;">Severity filter</td><td style="padding:4px 10px;border:1px solid #e5e7eb;font-family:monospace;">${esc(severityFilter)}</td></tr>
    <tr><td style="padding:4px 10px;color:#6b7280;border:1px solid #e5e7eb;">Tags filter</td><td style="padding:4px 10px;border:1px solid #e5e7eb;font-family:monospace;">${tagsFilter ? esc(tagsFilter) : "<em>(all tags)</em>"}</td></tr>
    <tr><td style="padding:4px 10px;color:#6b7280;border:1px solid #e5e7eb;">Excluded tags</td><td style="padding:4px 10px;border:1px solid #e5e7eb;font-family:monospace;">${excludeTagsFilter ? esc(excludeTagsFilter) : "<em>(none)</em>"}</td></tr>
    <tr><td style="padding:4px 10px;color:#6b7280;border:1px solid #e5e7eb;">Tests loaded</td><td style="padding:4px 10px;border:1px solid #e5e7eb;"><strong>${testsTotal.toLocaleString()}</strong></td></tr>
    <tr><td style="padding:4px 10px;color:#6b7280;border:1px solid #e5e7eb;">Finding types</td><td style="padding:4px 10px;border:1px solid #e5e7eb;"><strong>${alerts.total}</strong></td></tr>
    <tr><td style="padding:4px 10px;color:#6b7280;border:1px solid #e5e7eb;">Finding instances</td><td style="padding:4px 10px;border:1px solid #e5e7eb;"><strong>${instances.total}</strong></td></tr>
  </tbody>
</table>
${excludeTagsFilter ? `<p style="color:#6b7280;font-size:11px;margin:0 0 14px;"><em>Excluded tags are template categories not relevant to this target (e.g. WordPress/Joomla/Drupal templates against a non-CMS frontend would all return 404 / no match). Skipping them saves scan time without losing coverage. Auditor: see the cover page of the attached PDF for the same scope block.</em></p>` : ""}
${scanStats ? `
<p style="color:#6b7280;font-size:11px;margin:0 0 18px;"><strong>Scan execution:</strong> sent <strong>${esc(String(scanStats.requests || "?"))}</strong> requests against <strong>${esc(String(scanStats.hosts || "?"))}</strong> host(s) over <strong>${esc(String(scanStats.duration || "?"))}</strong>.</p>
` : ""}

<h3 style="margin-bottom:4px;">Tests run vs findings, by severity</h3>
<table style="border-collapse:collapse;border:1px solid #e5e7eb;font-size:12px;width:100%;">
  <thead>
    <tr style="background:#f3f4f6;">
      <th style="padding:6px 12px;text-align:left;border:1px solid #e5e7eb;">Severity</th>
      <th style="padding:6px 12px;text-align:right;border:1px solid #e5e7eb;">Tests run</th>
      <th style="padding:6px 12px;text-align:right;border:1px solid #e5e7eb;">Findings (types)</th>
      <th style="padding:6px 12px;text-align:right;border:1px solid #e5e7eb;">Findings (instances)</th>
    </tr>
  </thead>
  <tbody>
    ${SEV_ORDER.map((sev) => `
      <tr>
        <td style="padding:6px 12px;border:1px solid #e5e7eb;color:${sevColor(sev)};font-weight:600;">${cap(sev)}</td>
        <td style="padding:6px 12px;text-align:right;border:1px solid #e5e7eb;">${testCounts[sev].toLocaleString()}</td>
        <td style="padding:6px 12px;text-align:right;border:1px solid #e5e7eb;">${alerts[sev]}</td>
        <td style="padding:6px 12px;text-align:right;border:1px solid #e5e7eb;">${instances[sev]}</td>
      </tr>
    `).join("")}
    <tr style="background:#f9fafb;font-weight:600;">
      <td style="padding:6px 12px;border:1px solid #e5e7eb;">Total</td>
      <td style="padding:6px 12px;text-align:right;border:1px solid #e5e7eb;">${testsTotal.toLocaleString()}</td>
      <td style="padding:6px 12px;text-align:right;border:1px solid #e5e7eb;">${alerts.total}</td>
      <td style="padding:6px 12px;text-align:right;border:1px solid #e5e7eb;">${instances.total}</td>
    </tr>
  </tbody>
</table>
<p style="color:#6b7280;font-size:11px;margin-top:6px;"><em>"Tests run" = unique Nuclei templates loaded by the (severity, tags) filter. "Findings (types)" = unique templates that matched. "Findings (instances)" = total matches (one template can fire on many URLs).</em></p>

${alerts.total > 0 ? `
<h3 style="margin-top:24px;margin-bottom:4px;">Findings detail</h3>
<table style="border-collapse:collapse;border:1px solid #e5e7eb;width:100%;font-size:12px;">
  <thead>
    <tr style="background:#f3f4f6;">
      <th style="padding:6px 8px;border:1px solid #e5e7eb;text-align:left;">Severity</th>
      <th style="padding:6px 8px;border:1px solid #e5e7eb;text-align:left;">Template ID</th>
      <th style="padding:6px 8px;border:1px solid #e5e7eb;text-align:left;">Name</th>
      <th style="padding:6px 8px;border:1px solid #e5e7eb;text-align:right;">Instances</th>
      <th style="padding:6px 8px;border:1px solid #e5e7eb;text-align:left;">Example URLs</th>
    </tr>
  </thead>
  <tbody>${findingRowsHtml}</tbody>
</table>
${findingsMoreNote}
` : ""}

${topInventoryHtml ? `
<h3 style="margin-top:24px;margin-bottom:6px;">Tests run — top 20 per severity</h3>
<p style="color:#6b7280;font-size:11px;margin-top:0;"><em>Spot-check sample of the Nuclei templates that were loaded and exercised. The full per-template inventory (every test, all severities) is in the PDF audit report attached to the workflow run.</em></p>
${topInventoryHtml}
` : ""}

${runUrl ? `<p style="margin-top:22px;">Workflow run: <a href="${esc(runUrl)}">${esc(runUrl)}</a></p>` : ""}

<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;" />
<p style="color:#6b7280;font-size:11px;"><strong>Audit deliverable:</strong> the full PDF report is attached to this email and also available on the workflow run as an artifact. It enumerates every template that was tested, grouped by severity, alongside this same summary. Use the attached PDF as the canonical audit artifact. JSONL findings + SARIF are in the artifact bundle on the workflow run. If GHAS is licensed, findings additionally appear under Security → Code scanning alerts (category <code>nuclei-${esc(env)}</code>). Allowlist entries (false positives / accepted risk) live in <code>.nuclei/ignore.yaml</code>.</p>
</body></html>`;

// ---------- 4. Build attachment (if PDF available) ----------
const attachments = [];
if (pdfPath && existsSync(pdfPath)) {
  const sizeBytes = statSync(pdfPath).size;
  // Resend per-attachment cap is 40 MB; leave headroom for base64 overhead.
  // 35 MB raw → ~47 MB base64, which would exceed the cap. Cap raw at 28 MB
  // so base64 lands under 40.
  const MAX_BYTES = 28 * 1024 * 1024;
  if (sizeBytes > MAX_BYTES) {
    console.error(`send-report: PDF is ${sizeBytes} bytes (> ${MAX_BYTES} cap); skipping attachment.`);
  } else {
    const content = readFileSync(pdfPath).toString("base64");
    attachments.push({ filename: basename(pdfPath), content });
    console.error(`send-report: attaching ${basename(pdfPath)} (${sizeBytes} bytes raw, ${content.length} base64)`);
  }
} else if (pdfPath) {
  console.error(`send-report: PDF path provided but not found at ${pdfPath}; sending without attachment.`);
}

// ---------- 5. Send via Resend ----------
const payload = {
  from: "Spej Nuclei Scanner <noreply@info.spej.dev>",
  to: process.env.NUCLEI_REPORT_TO.split(",").map((s) => s.trim()).filter(Boolean),
  subject,
  html: bodyHtml,
  ...(attachments.length > 0 ? { attachments } : {}),
};

const res = await fetch("https://api.resend.com/emails", {
  method: "POST",
  headers: {
    Authorization: "Bearer " + process.env.RESEND_API_KEY,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(payload),
});

const respTxt = await res.text();
if (!res.ok) {
  console.error("send-report: Resend " + res.status + ": " + respTxt.slice(0, 500));
  process.exit(0);
}

console.log("send-report: sent — " + respTxt.slice(0, 200));

// ---------- helpers ----------
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
