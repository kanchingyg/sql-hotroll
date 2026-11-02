/**
 * `sql-hotroll lint`: finds data loss and failure risks in SQLite and Cloudflare D1 migration files
 * by applying them to seeded in-memory databases. Nothing touches a real database.
 *
 * @module
 */
export { discoverMigrations } from "./discover.ts";
export { type LintOptions, lintMigrations, type MigrationFile } from "./engine.ts";
export { type FileFacts, factsOf } from "./facts.ts";
export { type Format, formatReport } from "./report.ts";
export type { FileReport, Finding, Mode, Rule, Severity, Status } from "./types.ts";
