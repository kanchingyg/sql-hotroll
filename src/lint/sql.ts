/**
 * Splits a migration file into statements and reads the few statement shapes the lint rules need.
 *
 * @module
 */

/** One SQL statement from a migration file. */
export interface Statement {
  /** 1-based line of the statement's first token. */
  line: number;
  /** The statement with comments removed and string literal contents blanked, whitespace collapsed. */
  code: string;
  /** The statement exactly as written, without the closing `;`, for executing it on its own. */
  sql: string;
}

/**
 * Splits on `;` outside string literals, quoted identifiers, and comments. A CREATE TRIGGER
 * statement runs until the `END` that closes its BEGIN, counting CASE ... END pairs inside it.
 */
export function splitStatements(source: string): Statement[] {
  const out: Statement[] = [];
  let code = "";
  let start = 0;
  let from = 0;
  let line = 1;
  let i = 0;
  const flush = () => {
    const text = code.replace(/\s+/g, " ").trim();
    if (text) out.push({ line: start, code: text, sql: source.slice(from, i) });
    code = "";
    start = 0;
  };
  while (i < source.length) {
    const ch = source[i] as string;
    const next = source[i + 1];
    if (ch === "-" && next === "-") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end < 0 ? source.length : end + 2;
      line += countLines(source, i, stop);
      i = stop;
      code += " ";
      continue;
    }
    if (ch === "\n") line++;
    if (start === 0 && !/\s/.test(ch)) {
      start = line;
      from = i;
    }
    if (ch === "'" || ch === '"' || ch === "`" || ch === "[") {
      const close = ch === "[" ? "]" : ch;
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === close) {
          if (close !== "]" && source[j + 1] === close) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      line += countLines(source, i, j);
      // String literal contents never matter to the rules; identifiers do.
      code += ch === "'" ? "''" : source.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === ";" && !insideTrigger(code)) {
      flush();
      i++;
      continue;
    }
    code += ch;
    i++;
  }
  flush();
  return out;
}

function countLines(source: string, from: number, to: number): number {
  let n = 0;
  for (let k = from; k < to; k++) if (source[k] === "\n") n++;
  return n;
}

function insideTrigger(code: string): boolean {
  if (!/^\s*CREATE\s+(TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i.test(code)) return false;
  // A column named "begin" or "end" is not a keyword.
  const bare = code.replace(QUOTED, " ");
  const words = (re: RegExp) => bare.match(re)?.length ?? 0;
  const opened = words(/\bBEGIN\b/gi) + words(/\bCASE\b/gi);
  return opened === 0 || words(/\bEND\b/gi) < opened;
}

const QUOTED = /"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|'(?:[^']|'')*'/g;

/** Unquotes `"x"`, `` `x` ``, `[x]`, and drops a `main.` / `temp.` schema prefix. */
export function unquote(name: string): string {
  const last = name.match(/(?:"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|[^."`[\s]+)$/)?.[0] ?? name;
  const q = last[0];
  if (q === '"' || q === "`") return last.slice(1, -1).replaceAll(q + q, q);
  if (q === "[") return last.slice(1, -1);
  return last;
}

const NAME = String.raw`((?:(?:"(?:[^"]|"")*"|\x60(?:[^\x60]|\x60\x60)*\x60|\[[^\]]*\]|\w+)\s*\.\s*)?(?:"(?:[^"]|"")*"|\x60(?:[^\x60]|\x60\x60)*\x60|\[[^\]]*\]|\w+))`;

const DROP_TABLE = new RegExp(String.raw`^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?${NAME}`, "i");
const DROP_COLUMN = new RegExp(String.raw`^ALTER\s+TABLE\s+${NAME}\s+DROP\s+(?:COLUMN\s+)?${NAME}`, "i");
const RENAME_TABLE = new RegExp(String.raw`^ALTER\s+TABLE\s+${NAME}\s+RENAME\s+TO\s+${NAME}`, "i");
const CREATE_TABLE = new RegExp(
  String.raw`^CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${NAME}`,
  "i",
);
const DROP_TRIGGER = new RegExp(String.raw`^DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?${NAME}`, "i");
const ALTER_TABLE = new RegExp(String.raw`^ALTER\s+TABLE\s+${NAME}`, "i");
const DELETE_FROM = new RegExp(String.raw`^DELETE\s+FROM\s+${NAME}`, "i");
const UPDATE = new RegExp(String.raw`^UPDATE\s+(?:OR\s+\w+\s+)?${NAME}`, "i");
const COPIES_FROM = new RegExp(String.raw`^(?:INSERT|REPLACE|CREATE)\b.*\bSELECT\b.*\bFROM\s+${NAME}`, "i");
const BEGIN = /^BEGIN\b/i;
const END_TRANSACTION = /^(?:COMMIT|END|ROLLBACK)\b(?!\s+TO\b)(?!.*\bTO\s+SAVEPOINT\b)/i;
const PRAGMA = /^PRAGMA\s+(?:\w+\.)?(\w+)\s*(?:=\s*|\(\s*)['"]?(\w+)/i;

/** What one statement does, as far as the rules care. */
export type Action =
  | { kind: "drop-table"; table: string }
  | { kind: "drop-column"; table: string; column: string }
  | { kind: "rename-table"; from: string; to: string }
  | { kind: "create-table"; table: string }
  | { kind: "alter-table"; table: string }
  | { kind: "drop-trigger"; trigger: string }
  | { kind: "delete"; table: string }
  | { kind: "update"; table: string }
  | { kind: "copy"; from: string }
  | { kind: "pragma"; name: string; value: string }
  | { kind: "begin" }
  | { kind: "end-transaction" }
  | { kind: "other" };

const n = (m: RegExpMatchArray, i: number) => unquote(m[i] as string);

/** First match wins, so the specific ALTER TABLE forms come before the generic one. */
const SHAPES: [RegExp, (m: RegExpMatchArray) => Action][] = [
  [DROP_TABLE, (m) => ({ kind: "drop-table", table: n(m, 1) })],
  [DROP_COLUMN, (m) => ({ kind: "drop-column", table: n(m, 1), column: n(m, 2) })],
  [RENAME_TABLE, (m) => ({ kind: "rename-table", from: n(m, 1), to: n(m, 2) })],
  [ALTER_TABLE, (m) => ({ kind: "alter-table", table: n(m, 1) })],
  [DROP_TRIGGER, (m) => ({ kind: "drop-trigger", trigger: n(m, 1) })],
  [COPIES_FROM, (m) => ({ kind: "copy", from: n(m, 1) })],
  [CREATE_TABLE, (m) => ({ kind: "create-table", table: n(m, 1) })],
  [DELETE_FROM, (m) => ({ kind: "delete", table: n(m, 1) })],
  [UPDATE, (m) => ({ kind: "update", table: n(m, 1) })],
  [BEGIN, () => ({ kind: "begin" })],
  [END_TRANSACTION, () => ({ kind: "end-transaction" })],
  [PRAGMA, (m) => ({ kind: "pragma", name: (m[1] as string).toLowerCase(), value: (m[2] as string).toLowerCase() })],
];

/** Classifies a statement produced by {@link splitStatements}. */
export function classify(code: string): Action {
  for (const [re, build] of SHAPES) {
    const m = code.match(re);
    if (m) return build(m);
  }
  return { kind: "other" };
}
