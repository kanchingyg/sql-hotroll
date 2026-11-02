/**
 * Finds migration files the way `wrangler d1 migrations apply` does.
 *
 * Given a directory, in order of preference:
 * 1. `.sql` files directly in it (plus drizzle-kit's `<name>/migration.sql` folders);
 * 2. every D1 binding's `migrations_dir` and `migrations_pattern` in its `wrangler.toml`,
 *    `wrangler.jsonc` or `wrangler.json`, with wrangler's default `migrations`;
 * 3. its `migrations/` folder.
 *
 * Given one `.sql` file, the files before it in the same folder are replayed first.
 * https://developers.cloudflare.com/d1/reference/migrations/
 *
 * @module
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { MigrationFile } from "./engine.ts";

/** Files to replay in order; reports start at `from`. */
export interface MigrationSet {
  files: MigrationFile[];
  from: number;
}

export class PathError extends Error {}

export function discoverMigrations(path: string): MigrationSet[] {
  if (!existsSync(path)) throw new PathError(`path not found: ${path}`);
  if (!statSync(path).isDirectory()) return [singleFile(path)];
  const here = listMigrations(path);
  if (here.length > 0) return [{ files: here, from: 0 }];
  const configured = wranglerMigrations(path);
  if (configured.length > 0) return configured.map((files) => ({ files, from: 0 }));
  const nested = join(path, "migrations");
  if (existsSync(nested) && statSync(nested).isDirectory()) return discoverMigrations(nested);
  return [];
}

function singleFile(path: string): MigrationSet {
  const siblings = listMigrations(dirname(path));
  const at = siblings.findIndex((f) => resolve(f.path) === resolve(path));
  return at < 0 ? { files: [load(path)], from: 0 } : { files: siblings.slice(0, at + 1), from: at };
}

/** `<dir>/*.sql` and `<dir>/<name>/migration.sql`. */
function listMigrations(dir: string): MigrationFile[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".sql")) found.push(entry.name);
    if (entry.isDirectory() && existsSync(join(dir, entry.name, "migration.sql"))) {
      found.push(join(entry.name, "migration.sql"));
    }
  }
  return found.sort(compareMigrationPaths).map((rel) => load(join(dir, rel)));
}

function wranglerMigrations(root: string): MigrationFile[][] {
  const sets = new Map<string, MigrationFile[]>();
  for (const db of readD1Bindings(root)) {
    const dir = db.migrations_dir ?? "migrations";
    const key = `${dir}\0${db.migrations_pattern ?? ""}`;
    if (sets.has(key) || !existsSync(join(root, dir))) continue;
    sets.set(
      key,
      db.migrations_pattern ? globMigrations(root, dir, db.migrations_pattern) : listMigrations(join(root, dir)),
    );
  }
  return [...sets.values()].filter((files) => files.length > 0);
}

interface D1Binding {
  migrations_dir?: string;
  migrations_pattern?: string;
}

/** D1 bindings from the top level and every `env.*` of the first wrangler config found. */
function readD1Bindings(root: string): D1Binding[] {
  for (const name of ["wrangler.jsonc", "wrangler.json", "wrangler.toml"]) {
    const file = join(root, name);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    if (name.endsWith(".toml")) return tomlD1Bindings(text);
    const config = JSON.parse(stripJsonc(text)) as {
      d1_databases?: D1Binding[];
      env?: Record<string, { d1_databases?: D1Binding[] }>;
    };
    return [config, ...Object.values(config.env ?? {})].flatMap((c) => c.d1_databases ?? []);
  }
  return [];
}

/** Reads `migrations_dir` / `migrations_pattern` from each `[[...d1_databases]]` table. Nothing else. */
function tomlD1Bindings(text: string): D1Binding[] {
  const out: D1Binding[] = [];
  let current: D1Binding | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      current = /^\[\[\s*(?:env\.[\w-]+\.)?d1_databases\s*\]\]$/.test(line) ? {} : null;
      if (current) out.push(current);
      continue;
    }
    const m = line.match(/^(migrations_dir|migrations_pattern)\s*=\s*(["'])(.*?)\2/);
    if (current && m) current[m[1] as keyof D1Binding] = m[3] as string;
  }
  return out;
}

/** Removes comments and trailing commas outside strings. */
function stripJsonc(text: string): string {
  return text
    .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_, str: string | undefined) => str ?? "")
    .replace(
      /("(?:[^"\\]|\\.)*")|,(\s*[}\]])/g,
      (_, str: string | undefined, close: string | undefined) => str ?? close ?? "",
    );
}

/** `*` matches one path segment and `**` any number, as in wrangler's `migrations_pattern`. */
function globMigrations(root: string, dir: string, pattern: string): MigrationFile[] {
  const re = new RegExp(
    `^${pattern
      .split("/")
      .map((seg) =>
        seg === "**"
          ? "(?:.+/)?"
          : `${seg
              .replace(/[.+^${}()|[\]\\]/g, "\\$&")
              .replaceAll("*", "[^/]*")
              .replaceAll("?", "[^/]")}/`,
      )
      .join("")
      .replace(/\/$/, "")}$`,
  );
  const base = join(root, dir);
  return walk(base)
    .map((full) => relative(root, full).split(sep).join("/"))
    .filter((rel) => re.test(rel))
    .map((rel) => relative(base, join(root, rel)).split(sep).join("/"))
    .sort(compareMigrationPaths)
    .map((rel) => load(join(base, rel)));
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.isFile() ? [join(dir, e.name)] : [],
  );
}

function load(full: string): MigrationFile {
  const shown = relative(process.cwd(), full) || full;
  return { path: shown.split(sep).join("/"), sql: readFileSync(full, "utf8") };
}

/** Numeric order on the first segment's leading integer, then lexical (wrangler's rule). */
function compareMigrationPaths(a: string, b: string): number {
  const lead = (p: string) => {
    const m = p.match(/^(\d+)/);
    return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
  };
  return lead(a) - lead(b) || (a < b ? -1 : a > b ? 1 : 0);
}
