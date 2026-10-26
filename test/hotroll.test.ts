import {
  createDefaultFleetHardwareSetup,
  createSignedDsseMigrationEnvelope,
  verifyDsseMigrationEnvelope,
  mintPasetoV4PublicEpochToken,
  verifyPasetoV4PublicEpochToken,
} from "../src/attestation.ts";
import { renderCiGateProvenancePanel, visibleWidth } from "../src/tui.ts";
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SQL } from "bun";
import { generateKeyPairSync } from "node:crypto";
import {
  CTAP2_FLAG_UP,
  CTAP2_FLAG_UP_AND_UV,
  type CanonicalMigrationAstDescriptor,
  HotRollEngine,
  advanceCompositeToken,
  computeAffinityHash,
  computeCanonicalAstDigest,
  createMigrationDsseEnvelope,
  encodeEpochEnvelope,
  parseCompositeToken,
  serializeCompositeToken,
  signAsymmetricEpochToken,
  signPortableEpochToken,
  verifyAsymmetricEpochToken,
  verifyEpochEnvelope,
  verifyMigrationDsseQuorum,
  verifyPortableEpochToken,
} from "../src/core.ts";
import {
  SymbolicFusedHubLens,
  composeLenses,
  createRenameAndEnrichLens,
  createSplitMergeLens,
} from "../src/lenses.ts";
import {
  classifyMigrationTier,
  generateTier0VirtualColumnDdl,
  rewriteSqlForEpoch,
  stripLeadingSqlComments,
} from "../src/ast-rewriter.ts";
import {
  D1StorageAdapter,
  generateD1BidirectionalTriggersSql,
  introspectVirtualColumns,
} from "../src/d1-adapter.ts";
import {
  classifyPostgresDdlLockHazard,
  generatePostgresBidirectionalTriggersSql,
} from "../src/postgres-adapter.ts";
import { QuiescenceDetector } from "../src/client-quiescence.ts";

const LIVE_PG_URL =
  process.env.HOTROLL_PG_URL ?? "postgres://box@localhost:5432/postgres";

async function connectLivePostgres(): Promise<SQL | null> {
  try {
    const pg = new SQL({ url: LIVE_PG_URL, max: 1 });
    await pg.unsafe("SELECT 1 AS ok");
    return pg;
  } catch (error) {
    const requirePg =
      process.env.CI === "true" || process.env.HOTROLL_REQUIRE_PG === "1";
    if (requirePg) {
      throw new Error(
        `Live PostgreSQL required at ${LIVE_PG_URL} but connection failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    console.warn(
      `[skip] Live PostgreSQL unavailable at ${LIVE_PG_URL}; set HOTROLL_REQUIRE_PG=1 to fail instead`,
    );
    return null;
  }
}

describe("SQ-HotRoll Core Engine, Lenses, AST Rewriter, D1 & PostgreSQL 17 Adapters", () => {
  test("Composite causal token <d1_bookmark>@<schema_epoch> enforces monotonic causal barriers", () => {
    const tok1 = serializeCompositeToken({ bookmark: "00000010", epoch: 2 });
    expect(tok1).toBe("00000010@2");
    const parsed = parseCompositeToken(tok1);
    expect(parsed).toEqual({
      bookmark: "00000010",
      epoch: 2,
    });

    // Monotonic barrier must never regress below 00000010 or epoch 2
    const nextTok = advanceCompositeToken(parsed, "00000009", 1, false);
    expect(serializeCompositeToken(nextTok)).toBe("00000010@2");
  });

  test("Wave 2 Upgrade 1: 3-Tier DDL AST Migration Classifier & Zero-Copy VIRTUAL Column Fast-Path", () => {
    const tier0Spec = {
      sourceTable: "orders",
      targetTable: "orders",
      addedColumns: [
        {
          name: "display_tag",
          sqlType: "TEXT",
          nullableOrConstDefault: true,
          virtualExpr: "UPPER(role) || ':' || CAST(id AS TEXT)",
        },
      ],
      droppedColumns: [],
      mutatedPrimaryKey: false,
      narrowedTypesOrStrictNotNull: false,
    };
    expect(classifyMigrationTier(tier0Spec)).toBe("TIER_0_VIRTUAL_METADATA");

    const db = new Database(":memory:");
    db.exec(
      "CREATE TABLE orders (id INTEGER PRIMARY KEY, role TEXT NOT NULL, amount_cents INTEGER NOT NULL);"
    );
    db.exec("INSERT INTO orders (id, role, amount_cents) VALUES (42, 'vip', 9900);");

    // Verify SQLite rejects STORED columns on ALTER TABLE ADD COLUMN
    expect(() =>
      db.exec(
        "ALTER TABLE orders ADD COLUMN bad_stored TEXT GENERATED ALWAYS AS (role) STORED;"
      )
    ).toThrow();

    // Verify Tier 0 VIRTUAL column executes in O(1) metadata-only time
    for (const ddl of generateTier0VirtualColumnDdl(tier0Spec)) {
      db.exec(ddl);
    }
    const row = db
      .query("SELECT id, display_tag FROM orders WHERE id = 42")
      .get() as { id: number; display_tag: string };
    expect(row.display_tag).toBe("VIP:42");

    // Verify official SQLite gencol.html §2.3 #9: PRAGMA table_info hides VIRTUAL generated columns,
    // whereas PRAGMA table_xinfo exposes them with hidden == 2
    const stdCols = db.query("PRAGMA table_info(orders);").all() as Array<{ name: string }>;
    expect(stdCols.some((c) => c.name === "display_tag")).toBe(false);
    const xCols = db.query("PRAGMA table_xinfo(orders);").all() as Array<{ name: string; hidden: number }>;
    const virtCol = xCols.find((c) => c.name === "display_tag");
    expect(virtCol).toBeDefined();
    expect(virtCol!.hidden).toBe(2);
    const helperCols = introspectVirtualColumns(db, "orders");
    expect(helperCols.find((c) => c.name === "display_tag")?.isVirtual).toBe(true);
    db.close();
  });

  test("Scoped Symbol-Table SQL AST Rewriter preserves CTE scope, strips comments, and injects _row_ver", () => {
    const commentedUpdate = `-- leading comment (workers-sdk#16319)\nUPDATE orders SET stock_qty = stock_qty - ? WHERE id = ?`;
    expect(stripLeadingSqlComments(commentedUpdate)).toBe(
      "UPDATE orders SET stock_qty = stock_qty - ? WHERE id = ?"
    );

    const rewrittenUpd = rewriteSqlForEpoch(commentedUpdate, "orders", 2, {
      injectRowVerIncrement: true,
    });
    expect(rewrittenUpd).toBe(
      "UPDATE orders_v2 SET _row_ver = _row_ver + 1, stock_qty = stock_qty - ? WHERE id = ?"
    );

    // Must NOT rewrite CTE shadow table named `orders`
    const cteQuery =
      "WITH orders AS (SELECT 1 AS id) SELECT orders.id FROM orders";
    expect(rewriteSqlForEpoch(cteQuery, "orders", 2)).toBe(cteQuery);
  });

  test("Wave 2 Upgrade 3: SymbolicFusedHubLens v1 <-> v2 <-> v3 round-trip PutGet/GetPut/PutPut with inline _lc", () => {
    const lens12 = createSplitMergeLens({
      fromEpoch: 1,
      toEpoch: 2,
      sourceCol: "full_name",
      targetFirstCol: "first_name",
      targetLastCol: "last_name",
      addedDefaults: { billing_meta: "{}" },
    });
    const lens23 = createRenameAndEnrichLens({
      fromEpoch: 2,
      toEpoch: 3,
      renames: { first_name: "given_name", last_name: "family_name" },
      addedDefaults: { currency_code: "USD", tax_jurisdiction: "US-CA" },
    });
    const composed13 = composeLenses(lens12, lens23);
    const hub = new SymbolicFusedHubLens([lens12, lens23]);

    const v3Row = {
      id: 7,
      given_name: "Ada",
      family_name: "Lovelace",
      stock_qty: 15,
      amount_cents: 25000,
      role: "enterprise",
      billing_meta: '{"tier":"platinum"}',
      currency_code: "EUR",
      tax_jurisdiction: "EU-IE",
      _row_ver: 4,
      _lc: "{}",
    };

    const fanoutFrom3 = hub.fanOutMutation(3, v3Row, 4);
    const v1Projected = fanoutFrom3.get(1)!;
    expect(v1Projected.full_name).toBe("Ada Lovelace");

    // Project down to v1 and back up to v3 without losing billing_meta, currency_code, or tax_jurisdiction
    const restoredFromV1 = hub.fanOutMutation(1, v1Projected, 4);
    expect(restoredFromV1.get(3)).toEqual(v3Row);
    expect(composed13.forward(v1Projected)).toEqual(v3Row);
  });

  test("D1StorageAdapter: atomic last_insert_rowid() dual-insert, bidirectional _row_ver triggers, and WAL-paced keyset backfill", () => {
    const d1 = new D1StorageAdapter(":memory:");
    d1.db.exec(`
      CREATE TABLE orders_v1 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        full_name TEXT NOT NULL,
        stock_qty INTEGER NOT NULL,
        amount_cents INTEGER NOT NULL,
        role TEXT NOT NULL,
        _row_ver INTEGER NOT NULL DEFAULT 1,
        _lc TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE orders_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        stock_qty INTEGER NOT NULL,
        amount_cents INTEGER NOT NULL,
        role TEXT NOT NULL,
        billing_meta TEXT NOT NULL DEFAULT '{}',
        _row_ver INTEGER NOT NULL DEFAULT 1,
        _lc TEXT NOT NULL DEFAULT '{}'
      );
    `);

    // Seed 25 rows into orders_v1 and run WAL-paced keyset backfill
    const ins = d1.db.prepare(
      "INSERT INTO orders_v1 (full_name, stock_qty, amount_cents, role, _row_ver, _lc) VALUES (?, 50, 1200, 'user', 1, '{\"plan\":\"pro\"}')"
    );
    for (let i = 1; i <= 25; i++) {
      ins.run(`Customer ${i}`);
    }

    const backfillStats = d1.runKeysetBackfill({
      columnsCount: 9,
      maxUncheckpointedFrames: 5,
    });
    expect(backfillStats.rowsCopied).toBe(25);
    expect(backfillStats.batchesExecuted).toBe(3); // B = floor(100/9) = 11 -> 11 + 11 + 3 = 25

    // Install bidirectional triggers and test atomic dual insert + round-trip _lc preservation
    for (const trg of generateD1BidirectionalTriggersSql({
      tableV1: "orders_v1",
      tableV2: "orders_v2",
    })) {
      d1.db.exec(trg);
    }

    const dualIns = d1.insertDualAutoIncrementOrder({
      fullName: "Grace Hopper",
      firstName: "Grace",
      lastName: "Hopper",
      stockQty: 100,
      amountCents: 5000,
      role: "admin",
      billingMetaJson: '{"tax_exempt":true}',
    });
    expect(dualIns.insertedId).toBe(26);

    // v1 cohort updates stock_qty via relative delta; v2 must preserve billing_meta via _lc
    d1.db
      .prepare(
        "UPDATE orders_v1 SET stock_qty = stock_qty - 7 WHERE id = 26"
      )
      .run();
    const rowV2 = d1.db
      .query(
        "SELECT first_name, last_name, stock_qty, billing_meta, _row_ver FROM orders_v2 WHERE id = 26"
      )
      .get() as {
      first_name: string;
      last_name: string;
      stock_qty: number;
      billing_meta: string;
      _row_ver: number;
    };
    expect(rowV2.first_name).toBe("Grace");
    expect(rowV2.last_name).toBe("Hopper");
    expect(rowV2.stock_qty).toBe(93);
    expect(rowV2.billing_meta).toBe('{"tax_exempt":true}');
    expect(rowV2._row_ver).toBe(2);
    d1.db.close();
  });

  test("QuiescenceDetector: multi-tab isolation, CAS input-abort on keystroke/dirty form, and <50ms instant rollback", () => {
    const tab1 = new QuiescenceDetector(1);
    const tab2 = new QuiescenceDetector(1);

    // Tab 2 navigates and upgrades to v2, broadcasting to Tab 1
    const navRes = tab2.onHttp200Navigate(2);
    expect(navRes.upgraded).toBe(true);
    expect(tab2.getActiveEpoch()).toBe(2);

    tab1.onCrossTabBroadcast(2);
    // Tab 1 has an in-flight request and dirty form field -> must stay pinned to v1!
    const req1 = tab1.beginRequest();
    expect(req1.requestEpochHeader).toBe(1);
    tab1.setDirtyFormFields(1);
    tab1.advanceIdleClock(95_000);
    expect(tab1.attemptQuiescentIdleSwap().upgraded).toBe(false);
    expect(tab1.getActiveEpoch()).toBe(1);

    // Even when request finishes and form is clean, a keystroke during pre-warm aborts CAS swap
    tab1.endRequest();
    tab1.setDirtyFormFields(0);
    expect(tab1.attemptQuiescentIdleSwap(true).reason).toBe(
      "IDLE_ABORTED_BY_INPUT_OR_DIRTY_FORM"
    );
    expect(tab1.getActiveEpoch()).toBe(1);

    // Without keystroke, CAS idle swap commits cleanly
    const commitRes = tab1.attemptQuiescentIdleSwap(false);
    expect(commitRes.upgraded).toBe(true);
    expect(tab1.getActiveEpoch()).toBe(2);

    // Verify <50ms instant pointer-flip rollback on HotRollEngine and N_max = 3 admission policy
    const engine = new HotRollEngine();
    const adm3 = engine.admitNewEpoch(3);
    expect(adm3.activeEpochs).toEqual([1, 2, 3]);
    const adm4 = engine.admitNewEpoch(4);
    expect(adm4.activeEpochs).toEqual([2, 3, 4]);
    expect(adm4.retiredEpoch).toBe(1);

    const rb = engine.triggerInstantRollback();
    expect(rb.rolledBackTo).toBe(1);
    expect(rb.elapsedMs).toBeLessThan(50);
  });

  test("Live PostgreSQL 17.11 Adapter: pg_trigger_depth() bidirectional triggers & pg-lock-xray classification", async () => {
    const hazard = classifyPostgresDdlLockHazard(
      "ALTER TABLE orders ALTER COLUMN amount_cents TYPE BIGINT"
    );
    expect(hazard.severity).toBe("CRITICAL");
    expect(hazard.lockMode).toBe("AccessExclusiveLock");

    const trgSql = generatePostgresBidirectionalTriggersSql({
      tableV1: "test_hr_pg_v1",
      tableV2: "test_hr_pg_v2",
    });
    const pg = await connectLivePostgres();
    if (!pg) {
      expect(trgSql).toContain("fn_hotroll_bump_row_ver");
      expect(trgSql).toContain("BEFORE UPDATE ON test_hr_pg_v1");
      expect(trgSql).toContain("BEFORE UPDATE ON test_hr_pg_v2");
      expect(trgSql).toContain("pg_trigger_depth() > 1");
      expect(trgSql).toContain("WHERE test_hr_pg_v2._row_ver < EXCLUDED._row_ver");
      expect(trgSql).toContain("WHERE test_hr_pg_v1._row_ver < EXCLUDED._row_ver");
      expect(trgSql).toContain("ON CONFLICT (id) DO UPDATE");
      return;
    }
    await pg.unsafe(`
      DROP TABLE IF EXISTS test_hr_pg_v1 CASCADE;
      DROP TABLE IF EXISTS test_hr_pg_v2 CASCADE;
      CREATE TABLE test_hr_pg_v1 (
        id INT PRIMARY KEY,
        full_name TEXT NOT NULL,
        stock_qty INT NOT NULL,
        amount_cents INT NOT NULL,
        role TEXT NOT NULL,
        _row_ver INT NOT NULL DEFAULT 1,
        _lc TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE test_hr_pg_v2 (
        id INT PRIMARY KEY,
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        stock_qty INT NOT NULL,
        amount_cents INT NOT NULL,
        role TEXT NOT NULL,
        billing_meta TEXT NOT NULL DEFAULT '{}',
        _row_ver INT NOT NULL DEFAULT 1,
        _lc TEXT NOT NULL DEFAULT '{}'
      );
    `);

    await pg.unsafe(trgSql);

    // Insert on v2 -> replicates to v1 with _lc preserving billing_meta
    await pg.unsafe(`
      INSERT INTO test_hr_pg_v2 (id, first_name, last_name, stock_qty, amount_cents, role, billing_meta, _row_ver, _lc)
      VALUES (101, 'Barbara', 'Liskov', 40, 8800, 'vip', '{"sla":"99.999%"}', 1, '{}');
    `);

    // 1. AST-rewritten Update on v1 (explicit _row_ver + 1) -> replicates back to v2 without losing billing_meta
    await pg.unsafe(`
      UPDATE test_hr_pg_v1 SET stock_qty = stock_qty - 5, _row_ver = _row_ver + 1 WHERE id = 101;
    `);

    // 2. Raw unbumped Update on v1 (no explicit _row_ver increment) -> BEFORE UPDATE trigger bumps _row_ver to 3 and replicates to v2
    await pg.unsafe(`
      UPDATE test_hr_pg_v1 SET stock_qty = stock_qty - 3 WHERE id = 101;
    `);

    const rows = await pg.unsafe(
      `SELECT first_name, last_name, stock_qty, billing_meta, _row_ver FROM test_hr_pg_v2 WHERE id = 101;`
    );
    const rowsV1 = await pg.unsafe(
      `SELECT stock_qty, _row_ver FROM test_hr_pg_v1 WHERE id = 101;`
    );
    expect(rows[0].first_name).toBe("Barbara");
    expect(rows[0].last_name).toBe("Liskov");
    expect(Number(rows[0].stock_qty)).toBe(32);
    expect(rows[0].billing_meta).toBe('{"sla":"99.999%"}');
    expect(Number(rows[0]._row_ver)).toBe(3);
    expect(Number(rowsV1[0].stock_qty)).toBe(32);
    expect(Number(rowsV1[0]._row_ver)).toBe(3);

    await pg.unsafe(
      `DROP TABLE IF EXISTS test_hr_pg_v1 CASCADE; DROP TABLE IF EXISTS test_hr_pg_v2 CASCADE;`
    );
    await pg.close();
  });

  test("Wave 2 Vector 1 & 2: Safe Cutover Rename (legacy_alter_table FK preservation) and Backfill Zombie-Delete Prevention", () => {
    // 1. Prove default SQLite 3.26+ ALTER TABLE RENAME corrupts child FK references, while executeSafeCutoverRename preserves them
    const d1 = new D1StorageAdapter(":memory:");
    d1.db.exec(`
      CREATE TABLE orders_v1 (id INTEGER PRIMARY KEY, full_name TEXT NOT NULL);
      CREATE TABLE orders_v2 (id INTEGER PRIMARY KEY, first_name TEXT NOT NULL, last_name TEXT NOT NULL);
      CREATE TABLE order_items (
        item_id INTEGER PRIMARY KEY,
        order_id INTEGER NOT NULL REFERENCES orders_v1(id)
      );
      INSERT INTO orders_v1 VALUES (1, 'Ada Lovelace');
      INSERT INTO orders_v2 VALUES (1, 'Ada', 'Lovelace');
      INSERT INTO order_items VALUES (10, 1);
    `);

    const renameRes = d1.executeSafeCutoverRename({
      oldTable: "orders_v1",
      newTable: "orders_v2",
      archiveTable: "orders_v1_archive",
    });
    expect(renameRes.fkViolations).toBe(0);

    const itemSchema = d1.db
      .query("SELECT sql FROM sqlite_master WHERE type='table' AND name='order_items'")
      .get() as { sql: string };
    // Must still reference orders_v1(id), NOT orders_v1_archive(id)!
    expect(itemSchema.sql).toContain("REFERENCES orders_v1(id)");
    expect(itemSchema.sql).not.toContain("orders_v1_archive");
    d1.db.close();

    // 2. Prove bidirectional DELETE triggers + WHERE EXISTS guard prevent Zombie Row Resurrection
    const d2 = new D1StorageAdapter(":memory:");
    d2.db.exec(`
      CREATE TABLE orders_v1 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        full_name TEXT NOT NULL,
        stock_qty INTEGER NOT NULL,
        amount_cents INTEGER NOT NULL,
        role TEXT NOT NULL,
        _row_ver INTEGER NOT NULL DEFAULT 1,
        _lc TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE orders_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        stock_qty INTEGER NOT NULL,
        amount_cents INTEGER NOT NULL,
        role TEXT NOT NULL,
        billing_meta TEXT NOT NULL DEFAULT '{}',
        _row_ver INTEGER NOT NULL DEFAULT 1,
        _lc TEXT NOT NULL DEFAULT '{}'
      );
    `);
    for (const trg of generateD1BidirectionalTriggersSql({
      tableV1: "orders_v1",
      tableV2: "orders_v2",
    })) {
      d2.db.exec(trg);
    }
    d2.insertDualAutoIncrementOrder({
      fullName: "Alan Turing",
      firstName: "Alan",
      lastName: "Turing",
      stockQty: 10,
      amountCents: 1000,
      role: "user",
      billingMetaJson: '{"tier":"pro"}',
    });
    // Live v2 client deletes row 1 -> trigger deletes from orders_v1 -> backfill must NOT resurrect row 1
    d2.db.exec("DELETE FROM orders_v2 WHERE id = 1;");
    d2.runKeysetBackfill();
    const zombieCount = d2.db.query("SELECT count(*) AS c FROM orders_v2 WHERE id = 1").get() as { c: number };
    expect(zombieCount.c).toBe(0);
    d2.db.close();
  });

  test("Wave 2 Vector 6: Live PostgreSQL 17.11 Prepared Statement Plan-Cache Isolation (0A000 prevention)", async () => {
    const sqlV1 = rewriteSqlForEpoch("SELECT * FROM test_0a000 WHERE id = $1", "test_0a000", 1);
    const sqlV2 = rewriteSqlForEpoch("SELECT * FROM test_0a000 WHERE id = $1", "test_0a000", 2);
    const pg = await connectLivePostgres();
    if (!pg) {
      expect(sqlV1).toBe("SELECT * FROM test_0a000_v1 AS test_0a000 WHERE id = $1");
      expect(sqlV2).toBe("SELECT * FROM test_0a000_v2 AS test_0a000 WHERE id = $1");
      expect(sqlV1).not.toBe(sqlV2);
      expect(sqlV2).toContain("test_0a000_v2");
      return;
    }
    await pg.unsafe(`
      DROP VIEW IF EXISTS test_0a000_view CASCADE;
      DROP TABLE IF EXISTS test_0a000_v1 CASCADE;
      DROP TABLE IF EXISTS test_0a000_v2 CASCADE;
      CREATE TEMP TABLE test_0a000_v1 (id INT PRIMARY KEY, full_name TEXT NOT NULL);
      CREATE TEMP TABLE test_0a000_v2 (id INT PRIMARY KEY, first_name TEXT NOT NULL, last_name TEXT NOT NULL);
      INSERT INTO test_0a000_v1 VALUES (1, 'Grace Hopper');
      INSERT INTO test_0a000_v2 VALUES (1, 'Grace', 'Hopper');
      CREATE TEMP VIEW test_0a000_view AS SELECT * FROM test_0a000_v1;
      DEALLOCATE ALL;
      PREPARE stmt_view_star AS SELECT * FROM test_0a000_view WHERE id = $1;
    `);
    const r1 = await pg.unsafe("EXECUTE stmt_view_star(1);");
    expect(r1[0].full_name).toBe("Grace Hopper");

    // Mutating the underlying view/table structure triggers Postgres plancache.c 0A000 on SELECT *
    await pg.unsafe(`
      DROP VIEW test_0a000_view;
      CREATE TEMP VIEW test_0a000_view AS SELECT * FROM test_0a000_v2;
    `);
    let caught0A000 = false;
    try {
      await pg.unsafe("EXECUTE stmt_view_star(1);");
    } catch (err: any) {
      caught0A000 = String(err?.message ?? err).includes("cached plan must not change result type");
    }
    expect(caught0A000).toBe(true);

    // By contrast, SQ-HotRoll's AST-scoped physical table routing binds distinct prepared statements per epoch with 0 errors
    await pg.unsafe(`PREPARE stmt_sq_v1 AS ${sqlV1}; PREPARE stmt_sq_v2 AS ${sqlV2};`);
    const sq1 = await pg.unsafe("EXECUTE stmt_sq_v1(1);");
    const sq2 = await pg.unsafe("EXECUTE stmt_sq_v2(1);");
    expect(sq1[0].full_name).toBe("Grace Hopper");
    expect(sq2[0].first_name).toBe("Grace");
    await pg.unsafe("DEALLOCATE ALL;");
    await pg.close();
  });

  test("Enterprise Universal Architecture: Multi-CDN Portable Epoch Envelope, MAC/mTLS/Cell Breakpoint Affinity, K8s RollingUpdate, Sandbox Resume, Electron IPC & In-App WebView Host-Bridge", () => {
    const secret = "enterprise-multi-cdn-hmac-key-2026";
    const devHash = computeAffinityHash({
      cellId: "us-east-cell-04",
      deviceMacOui: "00:1A:2B",
      mtlsFingerprint: "sha256:9f86d081884c7d65",
      asnSubnet: "AS15169/203.0.113.0/24",
    });
    expect(devHash).toHaveLength(16);

    // 1. Mint PortableEpochToken on Fastly/Cloudflare CDN POP #1 and verify on Akamai/CloudFront/Envoy Origin POP #2
    const envelope = encodeEpochEnvelope(
      {
        epoch: 2,
        causalBookmark: "00000420",
        deviceFpHash: devHash,
      },
      secret
    );
    const verified = verifyEpochEnvelope(envelope, secret);
    expect(verified).not.toBeNull();
    expect(verified!.epoch).toBe(2);
    expect(verified!.causalBookmark).toBe("00000420");
    expect(verified!.deviceFpHash).toBe(devHash);
    // Tampered token must be rejected
    expect(verifyEpochEnvelope(envelope + "bad", secret)).toBeNull();

    // 2. Hardware / MAC OUI shift-freeze gate & deterministic cellular affinity
    const engine = new HotRollEngine({
      activeEpochs: [1, 2],
      targetEpoch: 2,
      backfillCompletedEpochs: new Set([1, 2]),
      rolloutPercentage: 100,
      hmacSecret: secret,
      blockedDeviceOuIs: new Set(["00:1A:2B"]), // Warehouse POS scanners frozen mid-shift
    });

    // Even if POS terminal sends explicitCheckpointReady, blockedDeviceOuIs holds it on v1 during shift
    const posHeldEpoch = engine.resolveEpoch({
      sessionId: "pos-scanner-01",
      role: "cashier",
      region: "us-east",
      tenantId: "retail-corp",
      entitledFeatures: [],
      secFetchMode: "none",
      explicitCheckpointReady: true,
      quiescenceSurface: "pos-mac-checkpoint",
      affinity: { deviceMacOui: "00:1A:2B", cellId: "store-104" },
      idleSeconds: 0,
      dirtyFormInputs: 0,
      inFlightUserMutations: 0,
      preloadReady: true,
    });
    expect(posHeldEpoch).toBe(1);

    // Once shift-freeze is lifted, POS terminal cuts over cleanly at explicit checkpoint
    engine.getState().blockedDeviceOuIs?.delete("00:1A:2B");
    const posPromotedEpoch = engine.resolveEpoch({
      sessionId: "pos-scanner-01",
      role: "cashier",
      region: "us-east",
      tenantId: "retail-corp",
      entitledFeatures: [],
      secFetchMode: "none",
      explicitCheckpointReady: true,
      quiescenceSurface: "pos-mac-checkpoint",
      affinity: { deviceMacOui: "00:1A:2B", cellId: "store-104" },
      idleSeconds: 0,
      dirtyFormInputs: 0,
      inFlightUserMutations: 0,
      preloadReady: true,
    });
    expect(posPromotedEpoch).toBe(2);

    // 3. Multi-CDN failover + Kubernetes RollingUpdate (Pod v1 & Pod v2 coexistence) & Sandbox Resume
    const cdnFailoverEpoch = engine.resolveEpoch({
      sessionId: "mobile-5g-roaming",
      role: "user",
      region: "eu-central",
      tenantId: "t1",
      entitledFeatures: [],
      secFetchMode: "cors",
      portableEpochToken: envelope, // Carries epoch=2 across DNS/CDN switch without cookies
      idleSeconds: 5,
      dirtyFormInputs: 1,
      inFlightUserMutations: 2,
      preloadReady: false,
    });
    expect(cdnFailoverEpoch).toBe(2);

    const sandboxResumeEpoch = engine.resolveEpoch({
      sessionId: "firecracker-vm-88",
      role: "agent",
      region: "us-west",
      tenantId: "t1",
      entitledFeatures: [],
      secFetchMode: "none",
      quiescenceSurface: "sandbox-resume",
      podSchemaEpoch: 2,
      idleSeconds: 0,
      dirtyFormInputs: 0,
      inFlightUserMutations: 0,
      preloadReady: true,
    });
    expect(sandboxResumeEpoch).toBe(2);

    // 4. Electron IPC Quiescence & In-App WebView Native Host-Bridge Version Ceiling
    const electronApp = new QuiescenceDetector(1);
    electronApp.onCrossTabBroadcast(2);
    expect(electronApp.onElectronIpcIdleOrBlur().reason).toBe("ELECTRON_IPC_QUIESCENT");
    expect(electronApp.getActiveEpoch()).toBe(2);

    // In-App WebView inside native iOS/Android shell whose host bridge only supports v1
    const miniAppWebView = new QuiescenceDetector(1);
    miniAppWebView.onCrossTabBroadcast(2);
    const cappedRes = miniAppWebView.onWebViewHostBridgeFreeze(1);
    expect(cappedRes.upgraded).toBe(false);
    expect(cappedRes.reason).toBe("CAPPED_BY_HOST_BRIDGE_VERSION");
    expect(miniAppWebView.getActiveEpoch()).toBe(1);

    // Once native host bridge supports v2, background freeze promotes cleanly
    const uncappedRes = miniAppWebView.onWebViewHostBridgeFreeze(2);
    expect(uncappedRes.upgraded).toBe(true);
    expect(uncappedRes.reason).toBe("WEBVIEW_HOST_BRIDGE_FREEZE");
    expect(miniAppWebView.getActiveEpoch()).toBe(2);
  });


  test("Enterprise Zero-Trust Cryptography: RFC 8785 (JCS) Canonical AST Digest, SLSA v1.0 DSSE M-of-N Ed25519 Quorum, Fleet Hardware Biometric/TPM2 Attestation & Public-Key JWKS Edge Tokens", () => {
    // 1. RFC 8785 (JCS) Canonical AST & Lens Graph Digest:
    // Must be invariant to SQL comments/whitespace/column order, and sensitive to semantic changes.
    const baseAst: CanonicalMigrationAstDescriptor = {
      tableName: "Orders",
      sourceEpoch: 1,
      targetEpoch: 2,
      tier: "TIER_2_SHADOW_TABLE",
      columnsV1: [
        { name: "full_name", sqlType: "TEXT", notNull: true },
        { name: "id", sqlType: "INTEGER", notNull: true },
      ],
      columnsV2: [
        { name: "id", sqlType: "INTEGER", notNull: true },
        { name: "first_name", sqlType: "TEXT", notNull: true },
        { name: "last_name", sqlType: "TEXT", notNull: true },
      ],
      lenses: [
        {
          kind: "SPLIT_MERGE",
          sourceColumns: ["full_name"],
          targetColumns: ["first_name", "last_name"],
          forwardSqlExpr: "substr(full_name, 1, instr(full_name, ' ') - 1)",
          backwardSqlExpr: "first_name || ' ' || last_name",
          complementDefaults: { billing_meta: "{}" },
        },
      ],
      rawDdlStatements: [
        "CREATE TABLE orders_v2 (id INTEGER PRIMARY KEY, first_name TEXT NOT NULL, last_name TEXT NOT NULL);",
      ],
      z3ProofObligationHash: "sha384:8f00b204e9800998ecf8427e",
      parentEpochDigest: "jcs-sha384:0000000000000000",
    };

    const commentedFormattedAst: CanonicalMigrationAstDescriptor = {
      ...baseAst,
      // Reordered columns + SQL comments + extra whitespace
      columnsV1: [
        { name: "id", sqlType: "  integer /* pk */ ", notNull: true },
        { name: "full_name", sqlType: "text -- customer name\n", notNull: true },
      ],
      lenses: [
        {
          ...baseAst.lenses[0],
          forwardSqlExpr:
            "/* split first */ substr( full_name , 1 , instr( full_name , ' ' ) - 1 ) -- end",
          backwardSqlExpr: "first_name   || ' ' ||   last_name /* merge */",
        },
      ],
      rawDdlStatements: [
        "-- comment header\nCREATE   TABLE  orders_v2 ( id INTEGER PRIMARY KEY , first_name TEXT NOT NULL , last_name TEXT NOT NULL ) ;",
      ],
    };

    const digest1 = computeCanonicalAstDigest(baseAst);
    const digest2 = computeCanonicalAstDigest(commentedFormattedAst);
    expect(digest1.startsWith("jcs-sha384:")).toBe(true);
    expect(digest1).toBe(digest2);

    // Any semantic modification (e.g., changing backward lens or column nullability) must change the digest
    const semanticTamperedAst: CanonicalMigrationAstDescriptor = {
      ...baseAst,
      lenses: [
        {
          ...baseAst.lenses[0],
          backwardSqlExpr: "first_name || '_' || last_name",
        },
      ],
    };
    expect(computeCanonicalAstDigest(semanticTamperedAst)).not.toBe(digest1);

    // 2. DSSE v1 (in-toto / SLSA v1.0) + Ed25519 M-of-N Quorum + Fleet Hardware Authenticator Verification
    const ciOidcKey = generateKeyPairSync("ed25519");
    const ciOidcKey2 = generateKeyPairSync("ed25519");
    const thinkpadTpmKey = generateKeyPairSync("ed25519");
    const yubikeyFidoKey = generateKeyPairSync("ed25519");

    const trustPolicy = {
      minQuorum: 2,
      requireDistinctRoles: true,
      requireRekorInclusion: true,
      requireHardwareUserVerification: true,
      expectedTableName: "orders",
      expectedTargetEpoch: 2,
      expectedCanonicalAstDigest: digest1,
      expectedParentEpochDigest: "jcs-sha384:0000000000000000",
      trustedKeys: {
        "fulcio-ci-runner-01": {
          publicKeyPemOrHex: ciOidcKey.publicKey,
          role: "ci-oidc-fulcio" as const,
        },
        "fulcio-ci-runner-02": {
          publicKeyPemOrHex: ciOidcKey2.publicKey,
          role: "ci-oidc-fulcio" as const,
        },
        "thinkpad-tpm2-fprintd-augusto": {
          publicKeyPemOrHex: thinkpadTpmKey.publicKey,
          role: "hardware-webauthn-kms" as const,
          lastSeenSignCount: 41,
          requireHardwareUv: true,
        },
        "yubikey-5-nano-piv9c": {
          publicKeyPemOrHex: yubikeyFidoKey.publicKey,
          role: "hardware-webauthn-kms" as const,
          lastSeenSignCount: 100,
          requireHardwareUv: true,
        },
      },
    };

    const dsseParams = {
      tableName: "orders",
      canonicalAstDigest: digest1,
      parentEpochDigest: "jcs-sha384:0000000000000000",
      targetEpoch: 2,
      z3ProofVerified: true,
      spiffeOrOidcSubject: "spiffe://github.com/kanchingyg/sql-hotroll/actions/runner-01",
      invocationId: "run-20261025-001",
      rekorLogIndex: 14892041,
    };

    // (a) Single compromised CI key (1-of-2) MUST fail when minQuorum = 2
    const envSingleCi = createMigrationDsseEnvelope(dsseParams, [
      { keyid: "fulcio-ci-runner-01", privateKey: ciOidcKey.privateKey },
    ]);
    const resSingleCi = verifyMigrationDsseQuorum(envSingleCi, trustPolicy);
    expect(resSingleCi.verified).toBe(false);
    expect(resSingleCi.reason).toBe("QUORUM_NOT_MET_1_OF_2");

    // (b) Duplicate signature from the same keyid MUST be deduplicated and rejected
    const envDupKey = createMigrationDsseEnvelope(dsseParams, [
      { keyid: "fulcio-ci-runner-01", privateKey: ciOidcKey.privateKey },
      { keyid: "fulcio-ci-runner-01", privateKey: ciOidcKey.privateKey },
    ]);
    expect(verifyMigrationDsseQuorum(envDupKey, trustPolicy).verified).toBe(false);

    // (c) Single-role collusion (2 distinct CI keys without hardware key) MUST fail when requireDistinctRoles = true
    const envRoleCollusion = createMigrationDsseEnvelope(dsseParams, [
      { keyid: "fulcio-ci-runner-01", privateKey: ciOidcKey.privateKey },
      { keyid: "fulcio-ci-runner-02", privateKey: ciOidcKey2.privateKey },
    ]);
    const resCollusion = verifyMigrationDsseQuorum(envRoleCollusion, trustPolicy);
    expect(resCollusion.verified).toBe(false);
    expect(resCollusion.reason).toBe(
      "ROLE_SEPARATION_VIOLATION_SINGLE_ROLE_COLLUSION"
    );

    // (d) Hardware signature missing biometric UV flag (UP=0x01 only, UV=0) MUST fail
    const envMissingUv = createMigrationDsseEnvelope(dsseParams, [
      { keyid: "fulcio-ci-runner-01", privateKey: ciOidcKey.privateKey },
      {
        keyid: "thinkpad-tpm2-fprintd-augusto",
        privateKey: thinkpadTpmKey.privateKey,
        hardwareAssertion: {
          authenticatorType: "tpm2-fprintd-thinkpad",
          ctapFlags: CTAP2_FLAG_UP, // 0x01 only (missing 0x04 biometric UV!)
          signCount: 42,
        },
      },
    ]);
    const resMissingUv = verifyMigrationDsseQuorum(envMissingUv, trustPolicy);
    expect(resMissingUv.verified).toBe(false);
    expect(resMissingUv.reason).toBe("HARDWARE_USER_VERIFICATION_UV_FLAG_MISSING");

    // (e) Userspace boolean/JSON spoofing: attacker mutates ctapFlags from 0x01 to 0x05 in JSON after signing
    // Must fail Ed25519 verification because ctapFlags is bound inside encodeHardwareBoundPae!
    const envSpoofedFlags = structuredClone(envMissingUv);
    envSpoofedFlags.signatures[1].hardwareAssertion!.ctapFlags = CTAP2_FLAG_UP_AND_UV;
    const resSpoofed = verifyMigrationDsseQuorum(envSpoofedFlags, trustPolicy);
    expect(resSpoofed.verified).toBe(false);
    expect(resSpoofed.reason).toBe("QUORUM_NOT_MET_1_OF_2");

    // (f) Cloned hardware token (signCount <= lastSeenSignCount = 41) MUST fail
    const envClonedCounter = createMigrationDsseEnvelope(dsseParams, [
      { keyid: "fulcio-ci-runner-01", privateKey: ciOidcKey.privateKey },
      {
        keyid: "thinkpad-tpm2-fprintd-augusto",
        privateKey: thinkpadTpmKey.privateKey,
        hardwareAssertion: {
          authenticatorType: "tpm2-fprintd-thinkpad",
          ctapFlags: CTAP2_FLAG_UP_AND_UV,
          signCount: 41, // Not strictly greater than lastSeenSignCount (41)!
        },
      },
    ]);
    const resCloned = verifyMigrationDsseQuorum(envClonedCounter, trustPolicy);
    expect(resCloned.verified).toBe(false);
    expect(resCloned.reason).toBe(
      "HARDWARE_SIGN_COUNTER_REPLAY_OR_CLONED_TOKEN"
    );

    // (g) Valid 2-of-2 Quorum (CI OIDC Fulcio + ThinkPad Synaptics fprintd + TPM 2.0 with UP|UV=0x05 & signCount=42) SUCCEEDS
    const envValidQuorum = createMigrationDsseEnvelope(dsseParams, [
      { keyid: "fulcio-ci-runner-01", privateKey: ciOidcKey.privateKey },
      {
        keyid: "thinkpad-tpm2-fprintd-augusto",
        privateKey: thinkpadTpmKey.privateKey,
        hardwareAssertion: {
          authenticatorType: "tpm2-fprintd-thinkpad",
          ctapFlags: CTAP2_FLAG_UP_AND_UV,
          signCount: 42,
          deviceModel: "ThinkPad X1 Carbon Gen 12 (Synaptics Match-on-Chip + TPM 2.0)",
        },
      },
    ]);
    const resValid = verifyMigrationDsseQuorum(envValidQuorum, trustPolicy);
    expect(resValid.verified).toBe(true);
    expect(resValid.reason).toBe("DSSE_SLSA_QUORUM_VERIFIED");
    expect(resValid.validSigners).toEqual([
      "fulcio-ci-runner-01",
      "thinkpad-tpm2-fprintd-augusto",
    ]);

    // (h) Replay of old epoch or tampered AST fails DSSE verification
    expect(
      verifyMigrationDsseQuorum(envValidQuorum, {
        ...trustPolicy,
        expectedTargetEpoch: 3,
      }).reason
    ).toBe("TARGET_EPOCH_MISMATCH_OR_REPLAY");
    expect(
      verifyMigrationDsseQuorum(envValidQuorum, {
        ...trustPolicy,
        expectedCanonicalAstDigest: "jcs-sha384:deadbeef",
      }).reason
    ).toBe("CANONICAL_AST_DIGEST_MISMATCH");

    // 3. Asymmetric Zero-Secret Edge Epoch Token (Ed25519 + JWKS `kid` rotation)
    const edgeSigningKey2026 = generateKeyPairSync("ed25519");
    const edgeSigningKeyRotated = generateKeyPairSync("ed25519");
    const jwksPublicOnly = {
      "ed25519-2026-10": edgeSigningKey2026.publicKey,
      "ed25519-2026-11": edgeSigningKeyRotated.publicKey,
    };

    const asymToken = signAsymmetricEpochToken(
      {
        kid: "ed25519-2026-10",
        epoch: 2,
        causalBookmark: "00000999",
        deviceFpHash: "a1b2c3d4e5f60718",
      },
      edgeSigningKey2026.privateKey
    );
    expect(asymToken.startsWith("v4.public.ed25519-2026-10.2.00000999.")).toBe(
      true
    );

    // Multi-CDN edge POP or untrusted K8s ingress verifies with PUBLIC JWKS only (zero shared secret)
    const verifiedAsym = verifyAsymmetricEpochToken(asymToken, jwksPublicOnly);
    expect(verifiedAsym).not.toBeNull();
    expect(verifiedAsym!.kid).toBe("ed25519-2026-10");
    expect(verifiedAsym!.epoch).toBe(2);
    expect(verifiedAsym!.causalBookmark).toBe("00000999");

    // Revoked/unknown kid or tampered epoch in token is rejected
    expect(
      verifyAsymmetricEpochToken(asymToken, {
        "ed25519-2026-11": edgeSigningKeyRotated.publicKey,
      })
    ).toBeNull();
    expect(
      verifyAsymmetricEpochToken(
        asymToken.replace(".2.00000999.", ".3.00000999."),
        jwksPublicOnly
      )
    ).toBeNull();
  });

  test("Fleet Hardware Attestation Module (src/attestation.ts) & CI-Gate Provenance TUI Panel (Windows Hello, macOS Touch ID, PIV/PKCS#11 + SSH_AUTH_SOCK, ThinkPad fprintd+TPM2, YubiKey FIDO2)", () => {
    const fleet = createDefaultFleetHardwareSetup();
    const ddlSql = "CREATE TABLE orders_v2 (id INTEGER PRIMARY KEY, first_name TEXT NOT NULL, last_name TEXT NOT NULL); /* v2 */";
    const lensSpec = {
      forward: "substr(full_name, 1, instr(full_name, ' ') - 1)",
      backward: "first_name || ' ' || last_name",
    };

    const astSpec = {
      tableName: "orders",
      sourceEpoch: 1,
      targetEpoch: 2,
      ddlSql,
      lensSpec,
    };

    // Sign a 2-of-3 quorum DSSE envelope using Keyless OIDC SPIFFE + ThinkPad X1 Carbon Gen 12 fprintd+TPM2 + YubiKey 5C FIDO2
    const signed = createSignedDsseMigrationEnvelope({
      astSpec,
      challengeNonce: "nonce-2026-10-25-fleet-001",
      prevEnvelopeDigest: "0000000000000000",
      oidcWorkloadIdentity: fleet.oidcClaim,
      hardwareAssertions: fleet.hardwareAssertions,
      signers: [
        fleet.oidcSigner,
        fleet.thinkpadFprintdTpmSigner,
        fleet.yubikeyFido2Signer,
      ],
    });

    const consumedNonces = new Set<string>();
    const verified = verifyDsseMigrationEnvelope({
      envelope: signed.envelope,
      expectedAstSpec: {
        ...astSpec,
        ddlSql: ddlSql + "\n-- trailing comment ignored by RFC 8785 JCS AST",
      },
      trustedJwks: fleet.trustedJwks,
      expectedChallengeNonce: "nonce-2026-10-25-fleet-001",
      expectedPrevEnvelopeDigest: "0000000000000000",
      consumedNonces,
      quorumRequired: 2,
    });
    expect(verified.verified).toBe(true);
    expect(verified.ciMergeReady).toBe(true);
    expect(verified.verifiedSigners.length).toBe(3);
    expect(verified.verifiedSigners.map((s) => s.modality)).toContain("thinkpad-fprintd-tpm2");
    expect(verified.verifiedSigners.map((s) => s.modality)).toContain("fido2-yubikey-ctap2");

    // Mint and verify PASETO v4.public token using only public JWKS
    const pasetoToken = mintPasetoV4PublicEpochToken(
      {
        epoch: 2,
        causalBookmark: "00000888",
        deviceFpHash: "thinkpad-x1g12-fp",
        envelopeDigestShort: verified.envelopeDigestShort,
        iatMs: 1761436800000,
        expMs: 1761523200000,
      },
      fleet.thinkpadFprintdTpmSigner
    );
    expect(pasetoToken.startsWith("v4.public.")).toBe(true);

    const pasetoVerified = verifyPasetoV4PublicEpochToken(
      pasetoToken,
      fleet.trustedJwks,
      1761436800000
    );
    expect(pasetoVerified).not.toBeNull();
    expect(pasetoVerified!.claims.epoch).toBe(2);

    // Verify CI-Gate Provenance TUI Panel exact line geometry
    const panelLines = renderCiGateProvenancePanel(
      {
        migrationId: "0002_split_orders_name",
        jcsAstDigestShort: verified.jcsAstDigestShort,
        dsseSlsaVerified: verified.verified,
        oidcOrSpiffeBuilder: "spiffe://prod.corp/ns/db-ops/sa/hotroll-operator",
        quorumValidSigners: verified.verifiedSigners.length,
        quorumRequiredSigners: 2,
        distinctRolesVerified: true,
        rekorLogIndex: 14892041,
        pasetoKid: fleet.thinkpadFprintdTpmSigner.kid,
        edgeSharedSecretsCount: 0,
        z3BijectionVerified: true,
        ciMergeReady: verified.ciMergeReady,
      },
      84
    );
    expect(panelLines.length).toBe(11);
    for (const line of panelLines) {
      expect(visibleWidth(line)).toBe(84);
    }
  });

  test("Audit Regression Suite: Lossless Split/Merge Edge Cases ('Ada', 'Ada ', 'Jean Luc' / 'Picard') and Unified D1 AFTER INSERT + _row_ver Protocol", () => {
    const lens12 = createSplitMergeLens({
      fromEpoch: 1,
      toEpoch: 2,
      sourceCol: "full_name",
      targetFirstCol: "first_name",
      targetLastCol: "last_name",
      addedDefaults: { billing_meta: "{}" },
    });

    // 1. Single-token name without delimiter ('Ada') round-trips v1 -> v2 -> v1 and v2 -> v1 -> v2
    const v1Ada = { id: 1, full_name: "Ada", _row_ver: 1, _lc: "{}" };
    const v2Ada = lens12.forward(v1Ada);
    expect(v2Ada.first_name).toBe("Ada");
    expect(v2Ada.last_name).toBe("");
    const v1AdaRt = lens12.backward(v2Ada);
    expect(v1AdaRt.full_name).toBe("Ada");
    expect(lens12.forward(v1AdaRt)).toEqual(v2Ada);

    // 2. Trailing delimiter ('Ada ') round-trips v1 -> v2 -> v1 without losing trailing space
    const v1AdaTrailing = { id: 2, full_name: "Ada ", _row_ver: 1, _lc: "{}" };
    const v2AdaTrailing = lens12.forward(v1AdaTrailing);
    expect(v2AdaTrailing.first_name).toBe("Ada");
    expect(v2AdaTrailing.last_name).toBe("");
    const v1AdaTrailingRt = lens12.backward(v2AdaTrailing);
    expect(v1AdaTrailingRt.full_name).toBe("Ada ");

    // 3. Embedded space in first_name ('Jean Luc', 'Picard') round-trips v2 -> v1 -> v2 via _lc._split_parts
    const v2Picard = {
      id: 3,
      first_name: "Jean Luc",
      last_name: "Picard",
      billing_meta: '{"ship":"Enterprise-D"}',
      _row_ver: 2,
      _lc: "{}",
    };
    const v1Picard = lens12.backward(v2Picard);
    expect(v1Picard.full_name).toBe("Jean Luc Picard");
    const v2PicardRt = lens12.forward(v1Picard);
    expect(v2PicardRt).toEqual(v2Picard);

    // 4. D1 AFTER INSERT triggers (raw v1 insert & raw v2 insert) + Unified _row_ver protocol (raw UPDATE & injectRowVerIncrement UPDATE)
    const d1 = new D1StorageAdapter(":memory:");
    d1.db.exec(`
      CREATE TABLE orders_v1 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        full_name TEXT NOT NULL,
        stock_qty INTEGER NOT NULL,
        amount_cents INTEGER NOT NULL,
        role TEXT NOT NULL,
        _row_ver INTEGER NOT NULL DEFAULT 1,
        _lc TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE orders_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        stock_qty INTEGER NOT NULL,
        amount_cents INTEGER NOT NULL,
        role TEXT NOT NULL,
        billing_meta TEXT NOT NULL DEFAULT '{}',
        _row_ver INTEGER NOT NULL DEFAULT 1,
        _lc TEXT NOT NULL DEFAULT '{}'
      );
    `);
    for (const trg of generateD1BidirectionalTriggersSql({
      tableV1: "orders_v1",
      tableV2: "orders_v2",
    })) {
      d1.db.exec(trg);
    }

    // Raw INSERT into orders_v1 (without insertDualAutoIncrementOrder) automatically propagates to orders_v2
    d1.db.exec(
      `INSERT INTO orders_v1 (id, full_name, stock_qty, amount_cents, role, _row_ver, _lc) VALUES (1, 'Ada Lovelace', 10, 5000, 'user', 1, '{"tier":"gold"}');`
    );
    const v2AfterRawIns = d1.db
      .query("SELECT first_name, last_name, stock_qty, billing_meta, _row_ver FROM orders_v2 WHERE id = 1")
      .get() as { first_name: string; last_name: string; stock_qty: number; billing_meta: string; _row_ver: number };
    expect(v2AfterRawIns.first_name).toBe("Ada");
    expect(v2AfterRawIns.last_name).toBe("Lovelace");
    expect(v2AfterRawIns.stock_qty).toBe(10);
    expect(v2AfterRawIns.billing_meta).toBe('{"tier":"gold"}');
    expect(v2AfterRawIns._row_ver).toBe(1);

    // AST-rewritten UPDATE (injectRowVerIncrement: true -> SET _row_ver = _row_ver + 1) propagates cleanly to v2 (no 6 vs 7 divergence!)
    const rewrittenUpdV1 = rewriteSqlForEpoch(
      "UPDATE orders SET stock_qty = stock_qty - 3 WHERE id = 1",
      "orders",
      1,
      { injectRowVerIncrement: true }
    );
    d1.db.exec(rewrittenUpdV1);

    const v1AfterRewritten = d1.db
      .query("SELECT stock_qty, _row_ver FROM orders_v1 WHERE id = 1")
      .get() as { stock_qty: number; _row_ver: number };
    const v2AfterRewritten = d1.db
      .query("SELECT stock_qty, _row_ver FROM orders_v2 WHERE id = 1")
      .get() as { stock_qty: number; _row_ver: number };
    expect(v1AfterRewritten.stock_qty).toBe(7);
    expect(v2AfterRewritten.stock_qty).toBe(7);
    expect(v1AfterRewritten._row_ver).toBe(2);
    expect(v2AfterRewritten._row_ver).toBe(2);

    // Raw UPDATE (without _row_ver increment) on v2 also increments _row_ver by +1 and propagates to v1
    d1.db.exec("UPDATE orders_v2 SET stock_qty = stock_qty - 1 WHERE id = 1");
    const v1AfterRawUpd = d1.db
      .query("SELECT stock_qty, _row_ver FROM orders_v1 WHERE id = 1")
      .get() as { stock_qty: number; _row_ver: number };
    const v2AfterRawUpd = d1.db
      .query("SELECT stock_qty, _row_ver FROM orders_v2 WHERE id = 1")
      .get() as { stock_qty: number; _row_ver: number };
    expect(v1AfterRawUpd.stock_qty).toBe(6);
    expect(v2AfterRawUpd.stock_qty).toBe(6);
    expect(v1AfterRawUpd._row_ver).toBe(3);
    expect(v2AfterRawUpd._row_ver).toBe(3);
    d1.db.close();
  });
});
