#!/usr/bin/env node
// Send a ZAP scan report by email via Resend. The body is a per-severity
// summary table (markdown→HTML) and the full ZAP HTML report is attached.
//
// Env vars:
//   RESEND_API_KEY        Resend API key (sender uses info.spej.dev domain)
//   ZAP_REPORT_TO         recipient(s) — comma-separated for multiple
//                         (e.g. "sb@spej.ai")
//   SCAN_KIND             baseline | full | api  (label only)
//   SCAN_ENV              dev | stage | prod  (label only)
//   SCAN_TARGET           URL or OpenAPI path that was scanned (label only)
//   GITHUB_RUN_URL        link back to the workflow run (label only)
//
// Args:
//   $1  path to report_json.json (required)
//   $2  path to report_html.html (attached when present)
//
// Exits 0 even on Resend failure — sending email shouldn't fail the CI run.

import { existsSync, readFileSync, statSync } from "node:fs";
import { filterIgnored, filterIgnoredHtml } from "./rules-filter.mjs";

const REQUIRED = ["RESEND_API_KEY", "ZAP_REPORT_TO"];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error("send-report: missing env: " + missing.join(", ") + " — skipping email.");
  process.exit(0);
}

const [, , jsonPath, htmlPath] = process.argv;
const kind = process.env.SCAN_KIND || "scan";
const env = process.env.SCAN_ENV || "(env)";
const target = process.env.SCAN_TARGET || "(target)";
const runUrl = process.env.GITHUB_RUN_URL || "";
// Defaults to .zap/rules.tsv relative to GH workspace; override via env.
const rulesPath = process.env.RULES_PATH || ".zap/rules.tsv";

// ---------- 1. Parse JSON, build per-severity counts + alert table ----------
// Counts are by ALERT TYPE, matching ZAP's own summary page. An alert
// that fires on 4 URLs counts as 1 alert with 4 instances, not 4 alerts.
let alerts    = { total: 0, high: 0, medium: 0, low: 0, info: 0 };
let instances = { total: 0, high: 0, medium: 0, low: 0, info: 0 };
let alertRows = [];

if (jsonPath && existsSync(jsonPath)) {
  try {
    const raw = JSON.parse(readFileSync(jsonPath, "utf8"));
    // Apply .zap/rules.tsv IGNOREs so the email matches ZAP's own
    // PASS/IGNORE/WARN/FAIL accounting in the workflow log.
    const j = filterIgnored(raw, rulesPath);
    for (const site of j.site || []) {
      for (const alert of site.alerts || []) {
        const inst = (alert.instances || []).length || 1;
        alerts.total += 1;
        instances.total += inst;
        const risk = String(alert.riskcode);
        if (risk === "3")      { alerts.high += 1;   instances.high   += inst; }
        else if (risk === "2") { alerts.medium += 1; instances.medium += inst; }
        else if (risk === "1") { alerts.low += 1;    instances.low    += inst; }
        else                   { alerts.info += 1;   instances.info   += inst; }
        alertRows.push({
          name: alert.name || "(unnamed)",
          risk: ["Info", "Low", "Medium", "High"][Number(alert.riskcode) || 0],
          riskRank: Number(alert.riskcode) || 0,
          instances: inst,
          confidence: alert.confidence || "",
          pluginId: alert.pluginid || "",
        });
      }
    }
    alertRows.sort((a, b) => (b.riskRank - a.riskRank) || (b.instances - a.instances));
  } catch (err) {
    console.error("send-report: failed to parse JSON: " + err.message);
  }
} else {
  console.error("send-report: report JSON not found at " + jsonPath + " — sending header-only email");
}

const severityBanner =
  alerts.high > 0 ? "🔴 HIGH-severity findings present"
  : alerts.medium > 0 ? "🟡 Medium-severity findings present"
  : alerts.total > 0 ? "🟢 Only Low/Info findings"
  :                    "✅ Clean — no findings";

// ---------- 2. HTML body ----------
const subject = `ZAP ${kind} scan (${env}) — ${alerts.total} alert(s), ${instances.total} instance(s)`;

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const rowsHtml = alertRows
  .slice(0, 30)
  .map(
    (r) =>
      `<tr><td>${escapeHtml(r.risk)}</td><td>${escapeHtml(r.name)}</td><td style="text-align:right">${r.instances}</td><td>${escapeHtml(r.confidence)}</td><td>${escapeHtml(r.pluginId)}</td></tr>`,
  )
  .join("\n");

const moreRows = alertRows.length > 30 ? `<p><em>… and ${alertRows.length - 30} more alert types. See the full ZAP report below.</em></p>` : "";

const bodyHtml = `<!doctype html><html><body style="font-family:Helvetica,Arial,sans-serif;color:#1f2937;">
<h2 style="margin-bottom:4px;">ZAP ${escapeHtml(kind)} scan — ${escapeHtml(env)}</h2>
<p style="color:#6b7280;margin-top:0;">Target: ${escapeHtml(target)}</p>
<p><strong>${escapeHtml(severityBanner)}</strong></p>

<table style="border-collapse:collapse;border:1px solid #e5e7eb;margin-bottom:18px;">
  <thead>
    <tr style="background:#f3f4f6;">
      <th style="padding:6px 12px;text-align:left;border:1px solid #e5e7eb;">Metric</th>
      <th style="padding:6px 12px;text-align:right;border:1px solid #e5e7eb;">Total</th>
      <th style="padding:6px 12px;text-align:right;border:1px solid #e5e7eb;">High</th>
      <th style="padding:6px 12px;text-align:right;border:1px solid #e5e7eb;">Medium</th>
      <th style="padding:6px 12px;text-align:right;border:1px solid #e5e7eb;">Low</th>
      <th style="padding:6px 12px;text-align:right;border:1px solid #e5e7eb;">Info</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td style="padding:6px 12px;border:1px solid #e5e7eb;">Alerts</td>
      <td style="padding:6px 12px;text-align:right;border:1px solid #e5e7eb;"><strong>${alerts.total}</strong></td>
      <td style="padding:6px 12px;text-align:right;border:1px solid #e5e7eb;color:#bb0021;"><strong>${alerts.high}</strong></td>
      <td style="padding:6px 12px;text-align:right;border:1px solid #e5e7eb;color:#b45309;"><strong>${alerts.medium}</strong></td>
      <td style="padding:6px 12px;text-align:right;border:1px solid #e5e7eb;">${alerts.low}</td>
      <td style="padding:6px 12px;text-align:right;border:1px solid #e5e7eb;color:#6b7280;">${alerts.info}</td>
    </tr>
    <tr>
      <td style="padding:6px 12px;border:1px solid #e5e7eb;color:#6b7280;">Instances</td>
      <td style="padding:6px 12px;text-align:right;border:1px solid #e5e7eb;color:#6b7280;">${instances.total}</td>
      <td style="padding:6px 12px;text-align:right;border:1px solid #e5e7eb;color:#6b7280;">${instances.high}</td>
      <td style="padding:6px 12px;text-align:right;border:1px solid #e5e7eb;color:#6b7280;">${instances.medium}</td>
      <td style="padding:6px 12px;text-align:right;border:1px solid #e5e7eb;color:#6b7280;">${instances.low}</td>
      <td style="padding:6px 12px;text-align:right;border:1px solid #e5e7eb;color:#6b7280;">${instances.info}</td>
    </tr>
  </tbody>
</table>
<p style="color:#6b7280;font-size:12px;margin-top:0;"><em>One alert can fire on multiple URLs — "Medium: 1" + "Instances: 4" means the same Medium alert (Proxy Disclosure) was found at 4 different URLs.</em></p>

<h3 style="margin-bottom:4px;">Alerts by severity</h3>
<table style="border-collapse:collapse;border:1px solid #e5e7eb;width:100%;font-size:13px;">
  <thead>
    <tr style="background:#f3f4f6;">
      <th style="padding:6px 8px;border:1px solid #e5e7eb;text-align:left;">Risk</th>
      <th style="padding:6px 8px;border:1px solid #e5e7eb;text-align:left;">Alert</th>
      <th style="padding:6px 8px;border:1px solid #e5e7eb;text-align:right;">Instances</th>
      <th style="padding:6px 8px;border:1px solid #e5e7eb;text-align:left;">Confidence</th>
      <th style="padding:6px 8px;border:1px solid #e5e7eb;text-align:left;">Plugin&nbsp;ID</th>
    </tr>
  </thead>
  <tbody>
${rowsHtml}
  </tbody>
</table>
${moreRows}

${runUrl ? `<p style="margin-top:18px;">Workflow run: <a href="${escapeHtml(runUrl)}">${escapeHtml(runUrl)}</a></p>` : ""}

<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;" />
<h3 style="margin-bottom:4px;">Full ZAP report</h3>
<p style="color:#6b7280;font-size:12px;margin-top:0;"><em>Note: alerts listed in <code>.zap/rules.tsv</code> as IGNORE are stripped from this inline report. The full unfiltered ZAP HTML is available as a workflow artifact at the GitHub run linked above.</em></p>`;

// ---------- 3. Inline the full ZAP HTML report body ----------
// Pull the body out of ZAP's report (strip <html>/<head>/<body> shells),
// and drop the giant base64 ZAP logo image at the top to shrink the
// email. Resulting inline body is roughly 25-30 KB — well below Gmail's
// ~102 KB clipping threshold.
let inlineReport = "";
if (htmlPath && existsSync(htmlPath)) {
  const size = statSync(htmlPath).size;
  if (size > 800 * 1024) {
    inlineReport = `<p><em>Full report omitted from email body — ${Math.round(size / 1024)} KB exceeds inline cap. See workflow artifacts.</em></p>`;
  } else {
    let raw = readFileSync(htmlPath, "utf8");
    const bodyMatch = raw.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    let body = bodyMatch ? bodyMatch[1] : raw;
    // Strip the embedded ZAP-logo data URI (16 KB of base64 noise).
    body = body.replace(/<img[^>]*src="data:image\/[^"]+"[^>]*\/?>/gi, "");
    // Strip <h1>ZAP Scanning Report</h1>-style header (redundant with our subject).
    body = body.replace(/<h1[\s\S]*?<\/h1>/i, "");
    // Apply rules.tsv IGNOREs so the inline report matches the filtered
    // summary at the top — otherwise the per-alert detail blocks
    // contradict the headline counts and confuse the reader.
    body = filterIgnoredHtml(body, rulesPath);
    inlineReport = body;
  }
} else {
  inlineReport = `<p><em>No report HTML was produced — see workflow log.</em></p>`;
}

const finalBody = bodyHtml + inlineReport + "</body></html>";

// ---------- 4. Send via Resend ----------
const payload = {
  from: "Spej ZAP Scanner <noreply@info.spej.dev>",
  // Split comma-separated recipient list so the same secret can target
  // one or many addresses without a workflow change.
  to: process.env.ZAP_REPORT_TO.split(",").map((s) => s.trim()).filter(Boolean),
  subject,
  html: finalBody,
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
  process.exit(0); // never fail CI over email
}

console.log("send-report: sent — " + respTxt.slice(0, 200));
