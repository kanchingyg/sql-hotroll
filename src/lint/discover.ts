/**
 * Finds migration files the way `wrangler d1 migrations apply` does.
 *
 * Given a directory, in order of preference:
 * 1. every D1 binding's `migrations_dir` and `migrations_pattern` in its `wrangler.jsonc`,
 *    `wrangler.json` or `wrangler.toml`, with wrangler's default `migrations`;
 * 2. its `migrations/` folder;
 * 3. `.sql` files directly in it (plus drizzle-kit's `<name>/migration.sql` folders).
 * A loose `schema.sql` next to `migrations/` (the D1 tutorial layout) is not a migration.
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
  if (!isDirectory(path)) return [singleFile(path)];
  const bindings = readD1Bindings(path);
  if (bindings.length > 0) return wranglerMigrations(path, bindings).map((files) => ({ files, from: 0 }));
  const nested = join(path, "migrations");
  if (isDirectory(nested)) return discoverMigrations(nested);
  const here = listMigrations(path);
  return here.length > 0 ? [{ files: here, from: 0 }] : [];
}

const isDirectory = (path: string) => existsSync(path) && statSync(path).isDirectory();

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

function wranglerMigrations(root: string, bindings: D1Binding[]): MigrationFile[][] {
  const sets = new Map<string, MigrationFile[]>();
  for (const db of bindings) {
    const dir = db.migrations_dir ?? "migrations";
    const key = `${dir}\0${db.migrations_pattern ?? ""}`;
    if (sets.has(key)) continue;
    if (!isDirectory(join(root, dir))) {
      // A binding without migrations yet is fine; a configured folder that is missing is a typo.
      if (db.migrations_dir === undefined) continue;
      throw new PathError(`migrations_dir "${dir}" in the wrangler config of ${root} does not exist`);
    }
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

/**
 * Reads `migrations_dir` / `migrations_pattern` from each `[[...d1_databases]]` table and from
 * inline `d1_databases = [{ ... }]` arrays. Nothing else.
 */
function tomlD1Bindings(text: string): D1Binding[] {
  const out: D1Binding[] = [];
  for (const [, body] of text.matchAll(/^\s*d1_databases\s*=\s*\[([\s\S]*?)\]\s*$/gm)) {
    for (const [, table] of (body as string).matchAll(/\{([^}]*)\}/g)) out.push(tomlKeys(table as string));
  }
  let current: D1Binding | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      current = /^\[\[\s*(?:env\.[\w-]+\.)?d1_databases\s*\]\]$/.test(line) ? {} : null;
      if (current) out.push(current);
      continue;
    }
    if (current) Object.assign(current, tomlKeys(line));
  }
  return out;
}

function tomlKeys(text: string): D1Binding {
  const binding: D1Binding = {};
  for (const [, key, , value] of text.matchAll(/\b(migrations_dir|migrations_pattern)\s*=\s*(["'])(.*?)\2/g)) {
    binding[key as keyof D1Binding] = value as string;
  }
  return binding;
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
