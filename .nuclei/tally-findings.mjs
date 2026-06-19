#!/usr/bin/env node
// Count Nuclei findings by severity from a JSONL file. Output format matches
// `.zap/tally-findings.mjs` so the workflow YAML can stay symmetric (same
// $GITHUB_OUTPUT keys, same shape).
//
// Nuclei JSONL: one line per finding instance, e.g.
//   {"template-id":"http-missing-security-headers","info":{"severity":"info","name":"…"},"matched-at":"https://…"}
//
// "Alert types" = distinct template-ids (matches ZAP's per-alert summary).
// "Instances" = total lines.
//
// Severity rank: critical > high > medium > low > info. Each level is emitted
// to its own $GITHUB_OUTPUT key — `critical` is its own bucket, not collapsed
// into `high`. (ZAP has no critical level; that's the only schema delta.)
//
// Usage:
//   node tally-findings.mjs <nuclei.jsonl> [<inventory.json>] [<ignore.yaml>]
//
// The optional inventory path adds `tests_loaded` + per-severity `tests_*`
// keys to $GITHUB_OUTPUT, which the audit email + PDF need to show the
// "ran N tests / found 0 findings" framing.

import { existsSync, readFileSync } from "node:fs";
import { applyIgnore } from "./ignore-filter.mjs";

const path = process.argv[2];
const inventoryPath = process.argv[3];
const ignorePath = process.argv[4] || ".nuclei/ignore.yaml";

const alerts    = { total: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 };
const instances = { total: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 };
const perTemplate = new Map(); // template-id -> {name, sev, sevRank, instances}

if (path && existsSync(path)) {
  const raw = readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean);

  const filtered = applyIgnore(raw, ignorePath);

  for (const f of filtered) {
    const tid = f["template-id"] || "(unknown)";
    const sev = String(f.info?.severity || "info").toLowerCase();
    const name = f.info?.name || tid;
    const prev = perTemplate.get(tid);
    if (prev) {
      prev.instances += 1;
    } else {
      perTemplate.set(tid, { name, sev, sevRank: sevRank(sev), instances: 1 });
    }
  }

  for (const [, t] of perTemplate) {
    alerts.total += 1;
    instances.total += t.instances;
    const bucket = t.sev === "critical" ? "critical"
                 : t.sev === "high"     ? "high"
                 : t.sev === "medium"   ? "medium"
                 : t.sev === "low"      ? "low"
                 :                        "info";
    alerts[bucket] += 1;
    instances[bucket] += t.instances;
  }
}

// Sort templates by severity rank desc, then instances desc.
const templates = [...perTemplate.values()].sort((a, b) => (b.sevRank - a.sevRank) || (b.instances - a.instances));
const top = templates.slice(0, 5).map((t) => t.name.replace(/[;\n]/g, " ")).join(";");

// Inventory: count templates that were loaded for the scan (the universe
// of tests). Allows the email/PDF to render "ran N tests / found 0 findings"
// instead of an ambiguous "0 findings" that's indistinguishable from
// "no templates loaded".
const tests = { total: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 };
if (inventoryPath && existsSync(inventoryPath)) {
  try {
    const inv = JSON.parse(readFileSync(inventoryPath, "utf8"));
    if (Array.isArray(inv)) {
      for (const t of inv) {
        const sev = String(t.severity || "info").toLowerCase();
        const bucket = sev === "critical" ? "critical"
                     : sev === "high"     ? "high"
                     : sev === "medium"   ? "medium"
                     : sev === "low"      ? "low"
                     :                      "info";
        tests[bucket] += 1;
        tests.total += 1;
      }
    }
  } catch (err) {
    process.stderr.write("tally-findings: failed to parse inventory: " + err.message + "\n");
  }
}

process.stdout.write("alerts="             + alerts.total + "\n");
process.stdout.write("instances="          + instances.total + "\n");
process.stdout.write("critical="           + alerts.critical + "\n");
process.stdout.write("high="               + alerts.high + "\n");
process.stdout.write("medium="             + alerts.medium + "\n");
process.stdout.write("low="                + alerts.low + "\n");
process.stdout.write("info="               + alerts.info + "\n");
process.stdout.write("instances_critical=" + instances.critical + "\n");
process.stdout.write("instances_high="     + instances.high + "\n");
process.stdout.write("instances_medium="   + instances.medium + "\n");
process.stdout.write("instances_low="      + instances.low + "\n");
process.stdout.write("instances_info="     + instances.info + "\n");
process.stdout.write("total="              + alerts.total + "\n");
process.stdout.write("top="                + top + "\n");
process.stdout.write("tests_loaded="       + tests.total + "\n");
process.stdout.write("tests_critical="     + tests.critical + "\n");
process.stdout.write("tests_high="         + tests.high + "\n");
process.stdout.write("tests_medium="       + tests.medium + "\n");
process.stdout.write("tests_low="          + tests.low + "\n");
process.stdout.write("tests_info="         + tests.info + "\n");

function sevRank(s) {
  return { critical: 4, high: 3, medium: 2, low: 1, info: 0, unknown: 0 }[s] ?? 0;
}
