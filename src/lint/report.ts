/**
 * Formats lint results as text, JSON, or GitHub Actions workflow commands.
 *
 * @module
 */
import type { FileReport, Finding } from "./types.ts";

export type Format = "text" | "json" | "github";

export function formatReport(reports: FileReport[], format: Format): string {
  if (format === "json") return JSON.stringify({ version: 1, files: reports, summary: summarize(reports) }, null, 2);
  if (format === "github") return reports.flatMap((r) => r.findings.map((f) => annotation(r.file, f))).join("\n");
  return text(reports);
}

function summarize(reports: FileReport[]) {
  const by = (s: string) => reports.filter((r) => r.status === s).length;
  return {
    files: reports.length,
    fail: by("FAIL"),
    unseeded: by("UNSEEDED"),
    warn: by("WARN"),
    ok: by("OK"),
    skipped: by("SKIPPED"),
  };
}

function text(reports: FileReport[]): string {
  const lines: string[] = [];
  for (const r of reports) {
    lines.push(`${r.status.padEnd(8)} ${r.file}`);
    for (const f of r.findings) {
      lines.push(`  ${String(f.line).padStart(4)}  ${f.severity.padEnd(7)}  ${f.rule.padEnd(20)}  ${f.message}`);
    }
  }
  const s = summarize(reports);
  lines.push(
    "",
    `${s.files} file(s): ${s.fail} FAIL, ${s.unseeded} UNSEEDED, ${s.warn} WARN, ${s.ok} OK, ${s.skipped} SKIPPED`,
  );
  return lines.join("\n");
}

/** https://docs.github.com/actions/reference/workflows-and-actions/workflow-commands */
function annotation(file: string, f: Finding): string {
  const prop = (v: string) => escapeData(v).replaceAll(":", "%3A").replaceAll(",", "%2C");
  return `::${f.severity} file=${prop(file)},line=${f.line},title=${prop(f.rule)}::${escapeData(f.message)}`;
}

const escapeData = (v: string) => v.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
