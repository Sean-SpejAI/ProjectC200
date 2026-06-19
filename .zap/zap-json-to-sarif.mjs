#!/usr/bin/env node
// Convert a ZAP JSON report to minimal SARIF 2.1.0 so findings can be
// uploaded to GitHub Code Scanning. ZAP itself can emit several formats
// via the `reports` add-on, but SARIF isn't one of the built-in templates
// at this version, and the `@microsoft/sarif-multitool` CLI is a .NET
// binary. So we inline a small converter here.
//
// Usage:  node zap-json-to-sarif.mjs <input.json> <output.sarif> [tool-name]
//
// SARIF spec: https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html
// ZAP JSON report shape: site[].alerts[] with riskcode 0-3.

import { readFileSync, writeFileSync } from "node:fs";

const [, , inputPath, outputPath, toolName = "OWASP-ZAP"] = process.argv;
if (!inputPath || !outputPath) {
  console.error("usage: zap-json-to-sarif.mjs <input.json> <output.sarif> [tool-name]");
  process.exit(2);
}

const raw = readFileSync(inputPath, "utf8");
let zap;
try {
  zap = JSON.parse(raw);
} catch (err) {
  console.error("input is not valid JSON: " + err.message);
  // Emit an empty SARIF so downstream upload step still has something.
  writeFileSync(outputPath, JSON.stringify({ version: "2.1.0", runs: [] }, null, 2));
  process.exit(0);
}

const riskToLevel = { "0": "note", "1": "note", "2": "warning", "3": "error" };
const riskToSeverity = { "0": "1.0", "1": "3.0", "2": "5.0", "3": "8.0" };

const rules = new Map();
const results = [];

for (const site of zap.site || []) {
  const siteName = site["@name"] || "";
  for (const alert of site.alerts || []) {
    const ruleId = "ZAP-" + (alert.pluginid || alert.alertRef || "unknown");
    if (!rules.has(ruleId)) {
      // ZAP's `reference` field often wraps multiple URIs in <p> tags.
      // Strip HTML, split on whitespace, take the first URL-shaped token.
      const refRaw = stripHtml(alert.reference || "");
      const refMatch = refRaw.match(/https?:\/\/\S+/);
      rules.set(ruleId, {
        id: ruleId,
        name: (alert.name || ruleId).replace(/[^A-Za-z0-9_]/g, ""),
        shortDescription: { text: alert.name || ruleId },
        fullDescription: { text: stripHtml(alert.desc || alert.description || alert.name || "") },
        helpUri: refMatch ? refMatch[0] : undefined,
        help: { text: stripHtml(alert.solution || "See ZAP docs.") },
        defaultConfiguration: {
          level: riskToLevel[String(alert.riskcode)] || "warning",
        },
        properties: {
          "security-severity": riskToSeverity[String(alert.riskcode)] || "5.0",
          tags: ["security", "zap"],
        },
      });
    }
    for (const inst of alert.instances || [{}]) {
      results.push({
        ruleId,
        level: riskToLevel[String(alert.riskcode)] || "warning",
        message: { text: stripHtml(alert.name || ruleId) },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: inst.uri || siteName },
            },
          },
        ],
        properties: {
          method: inst.method,
          param: inst.param,
          evidence: inst.evidence,
          confidence: alert.confidence,
        },
      });
    }
  }
}

const sarif = {
  version: "2.1.0",
  $schema: "https://json.schemastore.org/sarif-2.1.0.json",
  runs: [
    {
      tool: {
        driver: {
          name: toolName,
          version: zap["@version"] || "stable",
          informationUri: "https://www.zaproxy.org/",
          rules: [...rules.values()],
        },
      },
      results,
    },
  ],
};

writeFileSync(outputPath, JSON.stringify(sarif, null, 2));
console.log("Wrote " + outputPath + " with " + results.length + " results across " + rules.size + " rules.");

function stripHtml(s) {
  return String(s).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
