// Dry-run wrapper for send-report.mjs — patches fetch to log instead of POST.
import { writeFileSync } from "node:fs";

const calls = [];
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  calls.push({ url, body });
  writeFileSync("/tmp/send-report-dry.html", body.html, "utf8");
  console.log("dry-fetch: subject=" + body.subject);
  console.log("dry-fetch: to=" + JSON.stringify(body.to));
  console.log("dry-fetch: html_bytes=" + body.html.length);
  return { ok: true, status: 200, text: async () => '{"id":"dry-run"}' };
};

await import("../send-report.mjs");
