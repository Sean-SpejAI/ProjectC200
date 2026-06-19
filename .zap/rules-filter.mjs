// Apply .zap/rules.tsv IGNORE rules to a ZAP JSON report.
//
// ZAP's --config flag honors rules.tsv when computing the action's
// PASS/FAIL exit status, but report_json.json (and report_md.md /
// report_html.html) still include every alert. To make our email
// + GitHub-issue summaries match the workflow's view of "real"
// findings, we re-apply the IGNORE rules here.
//
// rules.tsv format (tab-separated, comments via '#'):
//   <rule_id>  IGNORE|WARN|FAIL|OFF  <url_regex>  <comment>
//
// Only IGNORE rules are honored here — WARN/FAIL just affect ZAP's
// exit status, not what we'd show in an email.

import { existsSync, readFileSync } from "node:fs";

function loadIgnoreRules(rulesPath) {
  if (!rulesPath || !existsSync(rulesPath)) return [];
  const lines = readFileSync(rulesPath, "utf8").split(/\r?\n/);
  const out = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const cols = line.split(/\t+/);
    if (cols.length < 3) continue;
    const [id, action, urlRegex] = cols;
    if (action !== "IGNORE") continue;
    let re;
    try { re = new RegExp(urlRegex); } catch { continue; }
    out.push({ id: String(id), re });
  }
  return out;
}

/**
 * Strip IGNOREd alert blocks from ZAP's report_html.html body.
 *
 * Scope of mutation:
 *   - Removes each `<tr>...<a href="#PLUGINID">...</tr>` row from the
 *     "Alerts" summary table at the top.
 *   - Removes each `<table class="results">` Alert Detail block that
 *     contains `<a id="PLUGINID">`, plus the trailing spacer div.
 *   - Replaces ZAP's own "Summary of Alerts" counts table with a small
 *     "(see summary table above)" note — the email's header already
 *     shows the filtered totals, so leaving ZAP's unfiltered counts
 *     here is what confused readers in the first place.
 *
 * Per-URL scoping is ignored here: in practice the inline report only
 * shows alerts where ZAP found at least one instance matching the
 * IGNORE rule's URL regex (otherwise the alert wouldn't be IGNOREd).
 * So removing the whole block per plugin id is consistent with what
 * filterIgnored() does for the JSON tally.
 */
export function filterIgnoredHtml(htmlBody, rulesPath) {
  const rules = loadIgnoreRules(rulesPath);
  const ignoredIds = new Set(rules.filter((r) => r.id !== "0").map((r) => r.id));
  if (ignoredIds.size === 0) return htmlBody;
  let html = htmlBody;

  for (const id of ignoredIds) {
    // 1. Remove the row in the Alerts summary table that links to #ID.
    const rowRe = new RegExp(
      `<tr>(?:(?!<tr>|</tr>)[\\s\\S])*?<a href="#${id}">[\\s\\S]*?</tr>`,
      "g",
    );
    html = html.replace(rowRe, "");

    // 2. Remove each Alert Detail block containing <a id="ID">. There
    //    can be more than one block per plugin id (ZAP sometimes emits
    //    multiple alert variants under one id), so loop.
    const anchorRe = new RegExp(`<a\\s+id=["']?${id}["']?[^>]*>`);
    while (true) {
      const m = anchorRe.exec(html);
      if (!m) break;
      const tableStart = html.lastIndexOf('<table class="results">', m.index);
      const tableEnd = html.indexOf("</table>", m.index);
      if (tableStart < 0 || tableEnd < 0) break;
      let endPos = tableEnd + "</table>".length;
      const spacerMatch = html.slice(endPos).match(/^\s*<div class="spacer(?:-lg)?"><\/div>/);
      if (spacerMatch) endPos += spacerMatch[0].length;
      html = html.slice(0, tableStart) + html.slice(endPos);
    }
  }

  // 3. Replace ZAP's "Summary of Alerts" section with a redirect note —
  //    the unfiltered counts here were the source of confusion. Header
  //    can be `<h3>` or `<h3 class="...">`.
  html = html.replace(
    /<h3(?:\s+[^>]*)?>Summary of Alerts<\/h3>\s*<table[\s\S]*?<\/table>\s*(?:<div class="spacer-lg"><\/div>)?/i,
    '<p style="color:#6b7280;font-size:13px;"><em>(ZAP\'s native Summary of Alerts removed — see the summary table at the top of this email for filtered counts.)</em></p>',
  );

  return html;
}

/**
 * Returns a new ZAP report object with IGNOREd alerts (and instances)
 * stripped. Mutates nothing; safe to call multiple times.
 *
 * Per-instance handling: if SOME instance URLs match an IGNORE for the
 * alert's rule_id and others don't, only matching instances are stripped.
 * If all instances are stripped, the whole alert is removed.
 */
export function filterIgnored(report, rulesPath) {
  const rules = loadIgnoreRules(rulesPath);
  if (rules.length === 0) return report;

  const filteredSites = [];
  for (const site of report.site || []) {
    const filteredAlerts = [];
    for (const alert of site.alerts || []) {
      const pluginId = String(alert.pluginid || "");
      const ignoresForRule = rules.filter((r) => r.id === pluginId);
      if (ignoresForRule.length === 0) {
        filteredAlerts.push(alert);
        continue;
      }
      // Some IGNORE rules in the file use rule_id "0" to indicate
      // "any rule on this URL", matching ZAP's wildcard convention.
      const wildcardZeroRules = rules.filter((r) => r.id === "0");
      const allRules = ignoresForRule.concat(wildcardZeroRules);
      const survivingInstances = (alert.instances || []).filter(
        (inst) => !allRules.some((r) => r.re.test(inst.uri || ""))
      );
      if (survivingInstances.length === 0) continue;
      if (survivingInstances.length === (alert.instances || []).length) {
        filteredAlerts.push(alert);
      } else {
        filteredAlerts.push({ ...alert, instances: survivingInstances });
      }
    }
    filteredSites.push({ ...site, alerts: filteredAlerts });
  }
  return { ...report, site: filteredSites };
}
