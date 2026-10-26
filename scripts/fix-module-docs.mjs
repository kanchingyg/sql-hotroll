import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

const modules = {
  "core.ts":
    "HotRoll core: composite session tokens, cohort selection, quiescence, and DSSE quorum helpers.",
  "lenses.ts":
    "Cambria-style bidirectional lenses with inline _lc complement for v1/v2 dual-table sync.",
  "ast-rewriter.ts":
    "Scoped symbol-table SQL AST rewriter for epoch-aware FROM rewrite and DDL tier classification.",
  "d1-adapter.ts":
    "Cloudflare D1 / SQLite adapter with last_insert_rowid dual-insert and monotonic _row_ver triggers.",
  "postgres-adapter.ts":
    "PostgreSQL 17 adapter with pg_trigger_depth guards and DDL lock-hazard classification.",
  "client-quiescence.ts":
    "Client quiescence detector: idle AFK swap, navigate HTTP 200, and visibility-hidden cutover.",
  "attestation.ts":
    "SLSA DSSE envelopes, RFC 8785 JCS digests, and fleet hardware authenticator attestation.",
  "crypto-handshake.ts":
    "Crypto handshake helpers for epoch tokens and edge verification.",
  "hardware-auth.ts":
    "Fleet hardware authenticators: YubiKey FIDO2, TPM2, Windows Hello, Touch ID, and PIV.",
  "tui.ts":
    "DEC Mode 2026 differential TUI, Braille sparklines, and CI-gate provenance panels.",
};

for (const [file, title] of Object.entries(modules)) {
  const p = path.join(dir, file);
  let src = fs.readFileSync(p, "utf8").replace(/^\uFEFF/, "");

  // Drop every leading module-style docblock (and BOM/whitespace between them)
  // until the first import/export/declaration.
  while (true) {
    const trimmed = src.replace(/^\uFEFF/, "").replace(/^\s+/, "");
    if (!trimmed.startsWith("/**")) {
      src = trimmed;
      break;
    }
    const end = trimmed.indexOf("*/");
    if (end < 0) break;
    const block = trimmed.slice(0, end + 2);
    // Only strip if it looks like a file-level @module doc (or a corrupted prior attempt)
    if (block.includes("@module") || block.includes("@kanchingyg/hotroll/")) {
      src = trimmed.slice(end + 2);
      continue;
    }
    src = trimmed;
    break;
  }

  const sub = file.replace(/\.ts$/, "");
  const header = `/**
 * ${title}
 *
 * @example
 * \`\`\`ts
 * import * as mod from "@kanchingyg/hotroll/${sub}";
 * \`\`\`
 *
 * @module
 */

`;
  fs.writeFileSync(p, header + src.replace(/^\uFEFF/, "").replace(/^\s+/, ""));
  console.log("fixed", file);
}
