/**
 * Finds migration files: `<dir>/*.sql` (wrangler) and `<dir>/<name>/migration.sql`
 * (drizzle-kit folder layout), ordered the way `wrangler d1 migrations apply` orders them.
 *
 * @module
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { MigrationFile } from "./engine.ts";

export function discoverMigrations(path: string): MigrationFile[] {
  if (!statSync(path).isDirectory()) return [{ path, sql: readFileSync(path, "utf8") }];
  const found: string[] = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".sql")) found.push(entry.name);
    if (entry.isDirectory()) {
      const nested = join(entry.name, "migration.sql");
      if (exists(join(path, nested))) found.push(nested);
    }
  }
  return found.sort(compareMigrationPaths).map((rel) => {
    const full = join(path, rel);
    return { path: relative(process.cwd(), full) || full, sql: readFileSync(full, "utf8") };
  });
}

/** Numeric order on the first segment's leading integer, then lexical (wrangler's rule). */
export function compareMigrationPaths(a: string, b: string): number {
  const lead = (p: string) => {
    const m = p.match(/^(\d+)/);
    return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
  };
  return lead(a) - lead(b) || (a < b ? -1 : a > b ? 1 : 0);
}

function exists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
