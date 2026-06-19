#!/usr/bin/env node
// Count ZAP findings by severity from a report_json.json file. Output is
// formatted for `>> $GITHUB_OUTPUT` consumption (one `key=value` per line).
// All keys are emitted even when the file is missing so downstream
// conditionals don't have to special-case undefined.
//
// Severity counts are by ALERT (not instance), matching ZAP's own summary
// page — so a single "Proxy Disclosure (Medium)" alert that fired on 4
// URLs counts as `medium=1` with `instances=4`. This keeps "Medium: 4"
// from being mistaken for "4 distinct Medium-severity issues".
//
// Usage:  node tally-findings.mjs <report_json.json>
//
// Emits:
//   alerts=N             unique alert types across all severities
//   instances=N          sum of all instance counts
//   high=N medium=N low=N info=N      alert-type counts per severity
//   instances_high=N ... instances_info=N    instance counts per severity
//   top=NameOne;NameTwo;...            top 5 alert names by severity rank

import { existsSync, readFileSync } from "node:fs";
import { filterIgnored } from "./rules-filter.mjs";

const path = process.argv[2];
// Default rules.tsv lives next to this script in the repo. Override via
// arg 3 (mostly for tests).
const rulesPath = process.argv[3] || ".zap/rules.tsv";
let alerts = { total: 0, high: 0, medium: 0, low: 0, info: 0 };
let instances = { total: 0, high: 0, medium: 0, low: 0, info: 0 };
const names = [];

if (path && existsSync(path)) {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const j = filterIgnored(raw, rulesPath);
    for (const site of j.site || []) {
      for (const alert of site.alerts || []) {
        const instCount = (alert.instances || []).length || 1;
        alerts.total += 1;
        instances.total += instCount;
        switch (String(alert.riskcode)) {
          case "3": alerts.high += 1;   instances.high   += instCount; break;
          case "2": alerts.medium += 1; instances.medium += instCount; break;
          case "1": alerts.low += 1;    instances.low    += instCount; break;
          default:  alerts.info += 1;   instances.info   += instCount; break;
        }
        names.push({ name: alert.name || "(unnamed)", risk: Number(alert.riskcode) || 0, instances: instCount });
      }
    }
  } catch (err) {
    process.stderr.write("tally-findings: " + err.message + "\n");
  }
}

// Top 5 by severity then by instances
names.sort((a, b) => (b.risk - a.risk) || (b.instances - a.instances));
const top = names.slice(0, 5).map((n) => n.name.replace(/[;\n]/g, " ")).join(";");

process.stdout.write("alerts=" + alerts.total + "\n");
process.stdout.write("instances=" + instances.total + "\n");
process.stdout.write("high=" + alerts.high + "\n");
process.stdout.write("medium=" + alerts.medium + "\n");
process.stdout.write("low=" + alerts.low + "\n");
process.stdout.write("info=" + alerts.info + "\n");
process.stdout.write("instances_high=" + instances.high + "\n");
process.stdout.write("instances_medium=" + instances.medium + "\n");
process.stdout.write("instances_low=" + instances.low + "\n");
process.stdout.write("instances_info=" + instances.info + "\n");
// Back-compat: existing `summary-issue` job references `total`. Keep it
// emitting the alert count (matches the new per-severity numbers).
process.stdout.write("total=" + alerts.total + "\n");
process.stdout.write("top=" + top + "\n");
