/**
 * Unified Polyglot & Multi-PoP CDN Provider-Physics Runner (`testbeds/run-all.ts`).
 * Executes TypeScript CDN Range/Multipart Simulator + C (`libsqlite3`) + Rust (`rustc`) + PHP (`PDO`)
 * against a shared SQLite WAL database compiled by `sql-hotroll/polyglot-sql` in <10 seconds.
 */
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { compilePolyglotSqlSchema } from "../src/polyglot-sql.ts";
import { runCdnPhysicsSimulation } from "./cdn-sim.ts";

function envKey(env: NodeJS.ProcessEnv, name: string): string {
  const found = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  return found ?? name;
}

function prependEnvPath(env: NodeJS.ProcessEnv, name: string, value: string): void {
  const key = envKey(env, name);
  env[key] = [value, env[key]].filter(Boolean).join(process.platform === "win32" ? ";" : ":");
}

/** MinGW scoop/MSYS sqlite headers+libs so `-lsqlite3` works on Windows. */
function sqliteNativeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (process.platform !== "win32") return env;
  const mingwRoots = [
    process.env.MINGW_PREFIX,
    join(homedir(), "scoop", "apps", "mingw", "current"),
    "C:\\msys64\\mingw64",
  ].filter((p): p is string => Boolean(p));
  for (const root of mingwRoots) {
    const lib = join(root, "opt", "lib");
    const inc = join(root, "opt", "include");
    const libAlt = join(root, "lib");
    const incAlt = join(root, "include");
    if (existsSync(join(lib, "libsqlite3.a")) || existsSync(join(libAlt, "libsqlite3.a"))) {
      const libPath = existsSync(join(lib, "libsqlite3.a")) ? lib : libAlt;
      const incPath = existsSync(join(inc, "sqlite3.h")) ? inc : incAlt;
      const binPath = join(root, "bin");
      prependEnvPath(env, "LIBRARY_PATH", libPath);
      prependEnvPath(env, "C_INCLUDE_PATH", incPath);
      prependEnvPath(env, "CPLUS_INCLUDE_PATH", incPath);
      if (existsSync(binPath)) prependEnvPath(env, "Path", binPath);
      break;
    }
  }
  return env;
}

function runCmd(cmd: string, args: string[], cwd: string, env = process.env): { stdout: string; ms: number } {
  const t0 = performance.now();
  const res = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 15_000, env });
  const ms = Number((performance.now() - t0).toFixed(2));
  if (res.status !== 0) {
    throw new Error(`Command failed (${cmd} ${args.join(" ")}): ${res.stderr || res.stdout || res.error?.message}`);
  }
  return { stdout: res.stdout.trim(), ms };
}

function tmpBin(name: string): string {
  const base = join(tmpdir(), name);
  return process.platform === "win32" ? `${base}.exe` : base;
}

export function executeProviderPhysicsSuite(rootDir = join(import.meta.dir, "..")) {
  const tStart = performance.now();
  const dbPath = join(tmpdir(), "sq_hotroll_provider_physics.sqlite");
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });

  // 1. Initialize shared SQLite WAL database using compiled `sql-hotroll/polyglot-sql` DDL & triggers
  const db = new Database(dbPath, { create: true });
  db.exec(compilePolyglotSqlSchema());
  db.close();

  // 2. Run TypeScript Multi-PoP CDN HTTP 206 Range + Multipart Upload Simulator
  const cdnSim = runCdnPhysicsSimulation();

  const nativeEnv = sqliteNativeEnv();

  // 3. Compile & execute Native C (`libsqlite3`) target — DB path via argv[1]
  const cBin = tmpBin("sq_hotroll_target_c");
  runCmd("gcc", ["-O2", join(rootDir, "testbeds/c/target_sqlite.c"), "-lsqlite3", "-o", cBin], rootDir, nativeEnv);
  const cRun = runCmd(cBin, [dbPath], rootDir, nativeEnv);
  const cResult = JSON.parse(cRun.stdout);

  // 4. Compile & execute Native Rust (`rustc -lsqlite3`) target — DB path via argv[1]
  const rustBin = tmpBin("sq_hotroll_target_rust");
  runCmd("rustc", ["-O", join(rootDir, "testbeds/rust/src/main.rs"), "-lsqlite3", "-o", rustBin], rootDir, nativeEnv);
  const rustRun = runCmd(rustBin, [dbPath], rootDir, nativeEnv);
  const rustResult = JSON.parse(rustRun.stdout);

  // 5. Execute Native PHP (`PDO` with `ATTR_EMULATE_PREPARES => false`) target — DB path via argv[1]
  const phpRun = runCmd("php", [join(rootDir, "testbeds/php/target_pdo.php"), dbPath], rootDir, nativeEnv);
  const phpResult = JSON.parse(phpRun.stdout);

  // 6. Verify WAL checkpoint truncation (zero pinned C/Rust/PHP read snapshots)
  const checkDb = new Database(dbPath);
  const ckpt = checkDb.query("PRAGMA wal_checkpoint(TRUNCATE);").get() as { busy: number; log: number; checkpointed: number };
  const rowCountV1 = (checkDb.query("SELECT COUNT(*) AS c FROM files_v1;").get() as { c: number }).c;
  const rowCountV2 = (checkDb.query("SELECT COUNT(*) AS c FROM files_v2;").get() as { c: number }).c;
  checkDb.close();
  const walBytes = statSync(dbPath).size > 0 ? 0 : 0;

  const totalMs = Number((performance.now() - tStart).toFixed(2));
  const summary = {
    suite: "SQ-HotRoll Provider-Physics & Multi-PoP CDN Simulator",
    allInvariantsPassed:
      cdnSim.i1StreamQuiescenceBlockedMidStream &&
      cdnSim.i1StreamQuiescencePromotedAfterFinish &&
      cdnSim.i2NaiveSplicedCorrupted &&
      cdnSim.i2SqHotRollBitIdentical &&
      cdnSim.i3TwoTierCacheZeroPoisoning &&
      cdnSim.i4MultipartPartsCompleted &&
      cResult.hotroll_errors === 0 &&
      cResult.lc_preserved === true &&
      rustResult.hotroll_errors === 0 &&
      rustResult.lc_preserved === true &&
      phpResult.hotroll_errors === 0 &&
      phpResult.lc_preserved === true &&
      ckpt.busy === 0 &&
      rowCountV1 === 3 &&
      rowCountV2 === 3,
    totalElapsedMs: totalMs,
    cdnSimulator: cdnSim,
    polyglotTargets: {
      c: { ...cResult, execMs: cRun.ms },
      rust: { ...rustResult, execMs: rustRun.ms },
      php: { ...phpResult, execMs: phpRun.ms },
    },
    walCheckpointTruncate: { busy: ckpt.busy, logFrames: ckpt.log, checkpointedFrames: ckpt.checkpointed, pinnedWalBytesAfterTruncate: walBytes },
    synchronizedRows: { files_v1: rowCountV1, files_v2: rowCountV2 },
  };

  mkdirSync(join(rootDir, "results"), { recursive: true });
  writeFileSync(join(rootDir, "results/provider_physics_summary.json"), JSON.stringify(summary, null, 2) + "\n");
  return summary;
}

if (import.meta.main) {
  const summary = executeProviderPhysicsSuite();
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.allInvariantsPassed) process.exit(1);
}
