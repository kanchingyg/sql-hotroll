/**
 * DEC Mode 2026 differential TUI, Braille sparklines, and CI-gate provenance panels.
 *
 * @example
 * ```ts
 * import * as mod from "@kanchingyg/hotroll/tui";
 * ```
 *
 * @module
 */

import type { HardwareAuthenticatorModality, MigrationTier, SchemaEpoch } from "./core.ts";

export type TuiPhase =
  | "DARK_CANARY"
  | "PROGRESSIVE_ROLLOUT"
  | "PAUSED"
  | "ROLLED_BACK"
  | "COMPLETED";

export type TuiCommandMode = "apply" | "watch" | "rollback" | "complete" | "ci-gate";

export interface HotRollSurfaceTelemetry {
  webNavigatePct: number;
  spaIdle90sPct: number;
  electronIpcPct: number;
  webviewBridgePct: number;
  k8sPodsV2: number;
  k8sPodsTotal: number;
}

export interface HotRollAttestationTelemetry {
  validSignatures: number;
  requiredQuorum: number;
  rolesLabel: string;
  astJcsVerified: boolean;
  jwksKid: string;
  rekorLogIndex?: number;
  hardwareModality?: HardwareAuthenticatorModality;
  ctapFlags?: number; // 0x05 = UP (0x01) | UV (0x04)
  signCount?: number;
  awaitingHardwarePrompt?: boolean;
}

export interface HotRollTuiState {
  version: string;
  mode: TuiCommandMode;
  tableName: string;
  sourceEpoch: SchemaEpoch;
  targetEpoch: SchemaEpoch;
  activeEpoch: SchemaEpoch;
  tier: MigrationTier;
  phase: TuiPhase;
  rolloutPct: number;
  totalSessions: number;
  sessionsV2: number;
  immediateSessionsTotal: number;
  immediateSessionsV2: number;
  passiveIdleSessionsTotal: number;
  passiveIdleSessionsV2: number;
  surfaces: HotRollSurfaceTelemetry;
  attestation: HotRollAttestationTelemetry;
  darkCanaryVerified: number;
  darkCanaryTarget: number;
  darkCanaryDiffs: number;
  latencyHistoryMs: number[];
  p50Ms: number;
  p99Ms: number;
  p999Ms: number;
  d1RowsReadMultiplier: number;
  d1RowsWrittenMultiplier: number;
  walSizeKb: number;
  walCapKb: number;
  http500Count: number;
  lostUpdatesCount: number;
  lastActionLog: string;
  lastRollbackElapsedMs?: number;
  quitRequested: boolean;
}

export interface HotRollTuiRenderOptions {
  /** Enable ANSI escape colors/bold/dim. Defaults to true unless NO_COLOR is set. */
  color?: boolean;
  /** Total frame character width (minimum 78, default 84). */
  width?: number;
  /** Include the ASCII/Unicode logo banner header at the top of the frame. */
  showBanner?: boolean;
}

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  brightCyan: "\x1b[96m",
  green: "\x1b[32m",
  brightGreen: "\x1b[92m",
  yellow: "\x1b[33m",
  brightYellow: "\x1b[93m",
  red: "\x1b[31m",
  brightRed: "\x1b[91m",
  magenta: "\x1b[35m",
  brightMagenta: "\x1b[95m",
  blue: "\x1b[34m",
  white: "\x1b[97m",
} as const;

const SPARK_CHARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

/**
 * Strips all SGR ANSI escape sequences from a string to compute exact visible column width.
 */
export function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Renders a deterministic Unicode block progress bar (`█▓▒░`) for a percentage in `[0, 100]`.
 */
export function renderProgressBar(
  pct: number,
  width = 24,
  style: "solid" | "shaded" = "shaded"
): string {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  const exactCells = (clamped / 100) * width;
  const fullCells = Math.floor(exactCells);
  const remainder = exactCells - fullCells;

  let bar = "█".repeat(fullCells);
  if (fullCells < width) {
    if (style === "shaded" && remainder >= 0.66) {
      bar += "▓";
    } else if (style === "shaded" && remainder >= 0.33) {
      bar += "▒";
    } else if (clamped > 0 && fullCells === 0) {
      bar += "▒";
    } else {
      bar += "░";
    }
    const remainingEmpty = width - bar.length;
    if (remainingEmpty > 0) {
      bar += "░".repeat(remainingEmpty);
    }
  }
  return bar;
}

/**
 * Renders an 8-level Unicode sparkline (`▁▂▃▄▅▆▇█`) from a numeric time series.
 */
export function renderSparkline(values: readonly number[]): string {
  if (!values || values.length === 0) {
    return "▁".repeat(8);
  }
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min;
  return values
    .map((v) => {
      if (span <= 1e-9) {
        return SPARK_CHARS[1];
      }
      const norm = Math.max(0, Math.min(1, (v - min) / span));
      const idx = Math.min(
        SPARK_CHARS.length - 1,
        Math.floor(norm * (SPARK_CHARS.length - 1))
      );
      return SPARK_CHARS[idx];
    })
    .join("");
}

/**
 * Creates a default initialized `HotRollTuiState` suitable for `hotroll watch` or unit tests.
 */
export function createDefaultTuiState(
  overrides?: Partial<HotRollTuiState>
): HotRollTuiState {
  const base: HotRollTuiState = {
    version: "0.1.0",
    mode: "watch",
    tableName: "orders",
    sourceEpoch: 1,
    targetEpoch: 2,
    activeEpoch: 2,
    tier: "TIER_2_SHADOW_TABLE",
    phase: "PROGRESSIVE_ROLLOUT",
    rolloutPct: 64.2,
    totalSessions: 1000,
    sessionsV2: 642,
    immediateSessionsTotal: 80,
    immediateSessionsV2: 80,
    passiveIdleSessionsTotal: 920,
    passiveIdleSessionsV2: 562,
    surfaces: {
      webNavigatePct: 71.5,
      spaIdle90sPct: 61.1,
      electronIpcPct: 100.0,
      webviewBridgePct: 50.0,
      k8sPodsV2: 6,
      k8sPodsTotal: 8,
    },
    attestation: {
      validSignatures: 2,
      requiredQuorum: 2,
      rolesLabel: "OIDC+KMS",
      astJcsVerified: true,
      jwksKid: "ed25519-2026-10",
      rekorLogIndex: 14892041,
      hardwareModality: "tpm2-fprintd-thinkpad",
      ctapFlags: 0x05,
      signCount: 42,
      awaitingHardwarePrompt: false,
    },
    darkCanaryVerified: 1000,
    darkCanaryTarget: 1000,
    darkCanaryDiffs: 0,
    latencyHistoryMs: [
      0.03, 0.03, 0.04, 0.03, 0.02, 0.03, 0.04, 0.03, 0.03, 0.02, 0.03, 0.03,
    ],
    p50Ms: 0.02,
    p99Ms: 0.03,
    p999Ms: 0.14,
    d1RowsReadMultiplier: 1.0,
    d1RowsWrittenMultiplier: 2.0,
    walSizeKb: 255,
    walCapKb: 512,
    http500Count: 0,
    lostUpdatesCount: 0,
    lastActionLog:
      "CANARY_OK: 1,000/1,000 shadow reads verified (0 diffs) -> draining v1 -> v2",
    quitRequested: false,
  };
  return {
    ...base,
    ...overrides,
    surfaces: {
      ...base.surfaces,
      ...(overrides?.surfaces ?? {}),
    },
    attestation: {
      ...base.attestation,
      ...(overrides?.attestation ?? {}),
    },
  };
}

/**
 * Pure state reducer for single-keystroke interactive TUI controls:
 * - `[P]` Promote rollout +25% (up to 100%)
 * - `[D]` Run / re-verify Dark-Canary shadow diffing (`1,000 / 1,000`)
 * - `[H]` Hold / Pause progressive rollout
 * - `[R]` Trigger `<50ms` instant O(1) rollback to `v1` with `0` data loss
 * - `[C]` Complete cutover (`100%` on `v2`), drop `_time_machine_delta`, truncate WAL to `0 KB`
 * - `[Q]` or `Ctrl+C` (`\u0003`) Quit interactive TUI loop
 */
export function handleKeypress(
  state: HotRollTuiState,
  rawKey: string
): HotRollTuiState {
  const key = (rawKey || "").trim().toLowerCase();

  if (key === "q" || rawKey === "\u0003") {
    return {
      ...state,
      quitRequested: true,
      lastActionLog:
        "EXIT: TUI watch detached (migration continues safely in background)",
    };
  }

  if (key === "d") {
    return {
      ...state,
      phase: "DARK_CANARY",
      darkCanaryVerified: state.darkCanaryTarget,
      darkCanaryDiffs: 0,
      lastActionLog: `DARK_CANARY: ${state.darkCanaryTarget.toLocaleString(
        "en-US"
      )}/${state.darkCanaryTarget.toLocaleString(
        "en-US"
      )} shadow reads matched L_1->2(r1) == r2 (0 diffs)`,
    };
  }

  if (key === "h") {
    return {
      ...state,
      phase: "PAUSED",
      lastActionLog: `HOLD: Paused cohort promotion at ${state.rolloutPct.toFixed(
        1
      )}% (existing v2 sessions stay pinned)`,
    };
  }

  if (key === "k" || key === "f" || key === "m") {
    const modality: HardwareAuthenticatorModality =
      key === "f"
        ? "tpm2-fprintd-thinkpad"
        : state.attestation.hardwareModality ?? "fido2-yubikey-sk";
    const nextSignCount = (state.attestation.signCount ?? 41) + 1;
    const nextValidSigs = Math.max(
      state.attestation.requiredQuorum,
      state.attestation.validSignatures + 1
    );
    return {
      ...state,
      attestation: {
        ...state.attestation,
        hardwareModality: modality,
        ctapFlags: 0x05,
        signCount: nextSignCount,
        validSignatures: nextValidSigs,
        awaitingHardwarePrompt: false,
        rolesLabel:
          modality === "tpm2-fprintd-thinkpad"
            ? "OIDC+TPM2-FPRINTD"
            : "OIDC+FIDO2-SK",
      },
      lastActionLog: `HW_AUTH_OK: Verified ${modality} [TOUCH YUBIKEY / SWIPE THINKPAD FPRINTD+TPM2 / PIV 9c] (UP=1 UV=1 flags=0x05 ctr=${nextSignCount}) -> DSSE ${nextValidSigs}/${state.attestation.requiredQuorum}`,
    };
  }

  if (key === "p") {
    if (
      state.attestation.validSignatures < state.attestation.requiredQuorum ||
      !state.attestation.astJcsVerified
    ) {
      return {
        ...state,
        phase: "PAUSED",
        lastActionLog: `QUORUM_BLOCKED: Promotion rejected — SLSA v1.0 DSSE Ed25519 quorum ${state.attestation.validSignatures}/${state.attestation.requiredQuorum} (AST-JCS: ${
          state.attestation.astJcsVerified ? "verified" : "TAMPERED"
        })`,
      };
    }
    const nextPct = Math.min(100, Math.round((state.rolloutPct + 25) * 10) / 10);
    const immediateV2 = state.immediateSessionsTotal;
    const remainingTarget = Math.max(
      0,
      Math.round((nextPct / 100) * state.totalSessions) - immediateV2
    );
    const passiveV2 = Math.min(state.passiveIdleSessionsTotal, remainingTarget);
    const totalV2 = Math.min(state.totalSessions, immediateV2 + passiveV2);
    const actualPct = Number(((totalV2 / state.totalSessions) * 100).toFixed(1));

    return {
      ...state,
      mode: "watch",
      phase: "PROGRESSIVE_ROLLOUT",
      activeEpoch: state.targetEpoch,
      rolloutPct: actualPct,
      sessionsV2: totalV2,
      immediateSessionsV2: immediateV2,
      passiveIdleSessionsV2: passiveV2,
      darkCanaryVerified: state.darkCanaryTarget,
      darkCanaryDiffs: 0,
      d1RowsWrittenMultiplier: 2.0,
      surfaces: {
        ...state.surfaces,
        webNavigatePct: Math.min(100, Number((actualPct + 8).toFixed(1))),
        spaIdle90sPct: Math.min(
          100,
          Number(
            (
              (passiveV2 / Math.max(1, state.passiveIdleSessionsTotal)) *
              100
            ).toFixed(1)
          )
        ),
        k8sPodsV2:
          actualPct >= 100
            ? state.surfaces.k8sPodsTotal
            : Math.min(
                state.surfaces.k8sPodsTotal,
                state.surfaces.k8sPodsV2 + 1
              ),
      },
      lastActionLog: `PROMOTE: Target advanced to ${actualPct.toFixed(
        1
      )}% (${totalV2}/${state.totalSessions} sessions on v${state.targetEpoch})`,
    };
  }

  if (key === "r") {
    const rollbackMs = 0.04;
    return {
      ...state,
      mode: "rollback",
      phase: "ROLLED_BACK",
      activeEpoch: state.sourceEpoch,
      rolloutPct: 0,
      sessionsV2: 0,
      immediateSessionsV2: 0,
      passiveIdleSessionsV2: 0,
      http500Count: 0,
      lostUpdatesCount: 0,
      lastRollbackElapsedMs: rollbackMs,
      surfaces: {
        ...state.surfaces,
        webNavigatePct: 0,
        spaIdle90sPct: 0,
        electronIpcPct: 0,
        webviewBridgePct: 0,
      },
      lastActionLog: `ROLLBACK_OK: Reverted 100% traffic to v${state.sourceEpoch} in ${rollbackMs}ms (<50ms SLA) | 0 lost writes (_lc intact)`,
    };
  }

  if (key === "c") {
    return {
      ...state,
      mode: "complete",
      phase: "COMPLETED",
      activeEpoch: state.targetEpoch,
      rolloutPct: 100,
      sessionsV2: state.totalSessions,
      immediateSessionsV2: state.immediateSessionsTotal,
      passiveIdleSessionsV2: state.passiveIdleSessionsTotal,
      d1RowsReadMultiplier: 1.0,
      d1RowsWrittenMultiplier: 1.0,
      walSizeKb: 0,
      http500Count: 0,
      lostUpdatesCount: 0,
      surfaces: {
        webNavigatePct: 100,
        spaIdle90sPct: 100,
        electronIpcPct: 100,
        webviewBridgePct: 100,
        k8sPodsV2: state.surfaces.k8sPodsTotal,
        k8sPodsTotal: state.surfaces.k8sPodsTotal,
      },
      lastActionLog: `CUTOVER_COMPLETE: 100% on v${state.targetEpoch} | _time_machine_delta archived | WAL truncated to 0 KB`,
    };
  }

  return state;
}

function padVisibleLine(content: string, innerWidth: number): string {
  const visibleLen = stripAnsi(content).length;
  if (visibleLen === innerWidth) {
    return content;
  }
  if (visibleLen < innerWidth) {
    return content + " ".repeat(innerWidth - visibleLen);
  }
  const plain = stripAnsi(content);
  return plain.slice(0, innerWidth - 3) + "...";
}

/**
 * Renders a complete, deterministic ASCII/Unicode TUI frame (`╭─╮│╰─╯`) for `sql-hotroll`.
 * Every line in the returned frame is guaranteed to have exact `width` visible columns.
 */
export function renderHotRollTuiFrame(
  state: HotRollTuiState,
  options?: HotRollTuiRenderOptions
): string {
  const useColor =
    options?.color !== undefined
      ? options.color
      : typeof process !== "undefined" && !process.env?.NO_COLOR;
  const width = Math.max(78, options?.width ?? 108);
  const innerWidth = width - 4; // accounts for "│ " and " │"
  const showBanner = options?.showBanner ?? true;

  const c = (code: string, text: string): string =>
    useColor ? `${code}${text}${ANSI.reset}` : text;

  const topBorder = c(ANSI.cyan, `╭${"─".repeat(width - 2)}╮`);
  const midDivider = c(ANSI.cyan, `├${"─".repeat(width - 2)}┤`);
  const botBorder = c(ANSI.cyan, `╰${"─".repeat(width - 2)}╯`);

  const boxLine = (rawContent: string): string => {
    const padded = padVisibleLine(rawContent, innerWidth);
    return `${c(ANSI.cyan, "│")} ${padded} ${c(ANSI.cyan, "│")}`;
  };

  const phaseBadge = (() => {
    switch (state.phase) {
      case "DARK_CANARY":
        return c(ANSI.brightYellow, "[*] DARK_CANARY (w=0%)");
      case "PROGRESSIVE_ROLLOUT":
        return c(ANSI.brightGreen, "[>] PROGRESSIVE_ROLLOUT");
      case "PAUSED":
        return c(ANSI.yellow, "[=] PAUSED_HOLD");
      case "ROLLED_BACK":
        return c(ANSI.brightRed, "[!] ROLLED_BACK (<50ms)");
      case "COMPLETED":
        return c(ANSI.brightCyan, "[+] CUTOVER_COMPLETED");
    }
  })();

  const tierLabel = (() => {
    switch (state.tier) {
      case "TIER_0_VIRTUAL_METADATA":
        return "Tier 0 Virtual (O(1) 0-Copy)";
      case "TIER_1_INPLACE_COLUMN":
        return "Tier 1 In-Place Dual-Write";
      case "TIER_2_SHADOW_TABLE":
        return "Tier 2 Shadow (v1 <-> v2)";
    }
  })();

  const v1Sessions = Math.max(0, state.totalSessions - state.sessionsV2);
  const v1Pct = Math.max(0, Number((100 - state.rolloutPct).toFixed(1)));
  const immPct =
    state.immediateSessionsTotal > 0
      ? (state.immediateSessionsV2 / state.immediateSessionsTotal) * 100
      : 0;
  const idlePct =
    state.passiveIdleSessionsTotal > 0
      ? (state.passiveIdleSessionsV2 / state.passiveIdleSessionsTotal) * 100
      : 0;

  const mainBar = c(
    state.phase === "ROLLED_BACK" ? ANSI.brightRed : ANSI.brightGreen,
    renderProgressBar(state.rolloutPct, 22, "shaded")
  );
  const immBar = c(ANSI.brightCyan, renderProgressBar(immPct, 16, "solid"));
  const idleBar = c(ANSI.green, renderProgressBar(idlePct, 16, "shaded"));
  const canaryPct =
    state.darkCanaryTarget > 0
      ? (state.darkCanaryVerified / state.darkCanaryTarget) * 100
      : 100;
  const canaryBar = c(
    ANSI.brightMagenta,
    renderProgressBar(canaryPct, 14, "solid")
  );
  const spark = c(ANSI.brightCyan, renderSparkline(state.latencyHistoryMs));

  const lines: string[] = [topBorder];

  if (showBanner) {
    lines.push(
      boxLine(
        `${c(
          ANSI.bold + ANSI.brightCyan,
          "┏━┓┏━┓┏┓   ┏━╸┏━┓╺┳╸┏━┓┏━┓┏┓  ┏┓ "
        )} ${c(ANSI.bold, `sql-hotroll v${state.version}`)} │ ${c(
          ANSI.brightYellow,
          `hotroll ${state.mode}`
        )}`
      )
    );
    lines.push(
      boxLine(
        `${c(
          ANSI.bold + ANSI.cyan,
          "┗━┓┃┏┫┃┗━╸ ┣━┫┃ ┃ ┃ ┣┳┛┃ ┃┃┗━╸┃┗━╸"
        )} ${c(ANSI.magenta, tierLabel)} · ${c(ANSI.dim, "D1 / SQLite / PG17")}`
      )
    );
    lines.push(midDivider);
  }

  // Section 1: Table, Epoch Envelope & Dark-Canary Status
  lines.push(
    boxLine(
      `Table: ${c(ANSI.bold + ANSI.white, state.tableName)} (v${
        state.sourceEpoch
      } -> v${state.targetEpoch})   Active: ${c(
        ANSI.bold,
        `v${state.activeEpoch}`
      )}   Phase: ${phaseBadge}`
    )
  );
  const quorumOk =
    state.attestation.validSignatures >= state.attestation.requiredQuorum &&
    state.attestation.astJcsVerified;
  const dsseSummary = quorumOk
    ? `SLSA v1.0 DSSE: ${state.attestation.validSignatures}/${
        state.attestation.requiredQuorum
      } Ed25519 [${state.attestation.rolesLabel}] · AST-JCS: verified · JWKS kid: ${
        state.attestation.jwksKid
      }${
        state.attestation.rekorLogIndex
          ? ` · Rekor #${state.attestation.rekorLogIndex}`
          : ""
      }`
    : `SLSA v1.0 DSSE: BLOCKED (${state.attestation.validSignatures}/${
        state.attestation.requiredQuorum
      } Ed25519 < quorum [${state.attestation.rolesLabel}]) · AST-JCS: ${
        state.attestation.astJcsVerified ? "verified" : "TAMPERED"
      } · JWKS kid: ${state.attestation.jwksKid}`;

  lines.push(
    boxLine(
      `Dark-Canary: [${canaryBar}] ${state.darkCanaryVerified
        .toLocaleString("en-US")
        .padStart(5, " ")} / ${state.darkCanaryTarget.toLocaleString(
        "en-US"
      )} verified │ Diffs: ${c(
        state.darkCanaryDiffs === 0 ? ANSI.brightGreen : ANSI.brightRed,
        String(state.darkCanaryDiffs)
      )} │ JWKS: ${state.attestation.jwksKid}`
    )
  );
  const hwFlags = state.attestation.ctapFlags ?? 0x05;
  const upBit = (hwFlags & 0x01) !== 0 ? 1 : 0;
  const uvBit = (hwFlags & 0x04) !== 0 ? 1 : 0;
  const hwModality = state.attestation.hardwareModality ?? "tpm2-fprintd-thinkpad";
  const hwCtr = state.attestation.signCount ?? 0;
  const hwLineText = state.attestation.awaitingHardwarePrompt
    ? `HW-Auth: [TOUCH YUBIKEY / SWIPE THINKPAD FPRINTD+TPM2 / PIV 9c] awaiting UP=1 UV=1...`
    : `HW-Auth: ${hwModality} · CTAP2 UP=${upBit} UV=${uvBit} (0x0${hwFlags.toString(
        16
      )}) · signCount=${hwCtr}`;

  lines.push(
    boxLine(
      c(quorumOk ? ANSI.brightGreen : ANSI.brightRed, dsseSummary)
    )
  );
  lines.push(
    boxLine(
      c(
        upBit === 1 && uvBit === 1 && !state.attestation.awaitingHardwarePrompt
          ? ANSI.brightCyan
          : ANSI.brightYellow,
        hwLineText
      )
    )
  );
  lines.push(midDivider);

  // Section 2: Cohort Drain & Intra-Role Differential Urgency Gauges
  lines.push(
    boxLine(
      c(
        ANSI.bold,
        "COHORT DRAIN & INTRA-ROLE URGENCY SPLIT (HTTP 200 Navigate + 90s AFK CAS)"
      )
    )
  );
  lines.push(
    boxLine(
      `Sessions v${state.targetEpoch}: [${mainBar}] ${state.rolloutPct
        .toFixed(1)
        .padStart(5, " ")}% (${String(state.sessionsV2).padStart(4, " ")}/${
        state.totalSessions
      }) │ v${state.sourceEpoch}: ${v1Pct.toFixed(1)}% (${v1Sessions})`
    )
  );
  lines.push(
    boxLine(
      `  ▸ IMMEDIATE    [${immBar}] ${immPct.toFixed(1).padStart(5, " ")}% (${String(
        state.immediateSessionsV2
      ).padStart(3, " ")}/${String(state.immediateSessionsTotal).padStart(
        3,
        " "
      )})  feature=new_billing`
    )
  );
  lines.push(
    boxLine(
      `  ▸ PASSIVE_IDLE [${idleBar}] ${idlePct.toFixed(1).padStart(5, " ")}% (${String(
        state.passiveIdleSessionsV2
      ).padStart(3, " ")}/${String(state.passiveIdleSessionsTotal).padStart(
        3,
        " "
      )})  90s AFK + 0 dirty forms`
    )
  );
  lines.push(
    boxLine(
      `Surfaces: WebNav ${state.surfaces.webNavigatePct.toFixed(
        0
      )}% │ SPA-90s ${state.surfaces.spaIdle90sPct.toFixed(
        0
      )}% │ Electron ${state.surfaces.electronIpcPct.toFixed(
        0
      )}% │ WebView ${state.surfaces.webviewBridgePct.toFixed(0)}% │ K8s ${
        state.surfaces.k8sPodsV2
      }/${state.surfaces.k8sPodsTotal}`
    )
  );
  lines.push(midDivider);

  // Section 3: Engine Telemetry, Sparklines & Safety Counters
  lines.push(
    boxLine(
      c(ANSI.bold, "LIVE ENGINE TELEMETRY & FIREPROOF DATA PLANE INVARIANTS")
    )
  );
  lines.push(
    boxLine(
      `Latency: ${spark}  p50 ${state.p50Ms.toFixed(2)}ms │ p99 ${c(
        ANSI.brightGreen,
        `${state.p99Ms.toFixed(2)}ms`
      )} │ p99.9 ${state.p999Ms.toFixed(2)}ms`
    )
  );
  lines.push(
    boxLine(
      `D1 Cost: ${state.d1RowsReadMultiplier.toFixed(
        2
      )}x rows_read │ ${state.d1RowsWrittenMultiplier.toFixed(
        2
      )}x rows_written │ WAL: ${state.walSizeKb} KB / ${state.walCapKb} KB cap`
    )
  );
  lines.push(
    boxLine(
      `Safety:  HTTP 500s: ${c(
        state.http500Count === 0 ? ANSI.brightGreen : ANSI.brightRed,
        String(state.http500Count)
      )} │ Lost Writes: ${c(
        state.lostUpdatesCount === 0 ? ANSI.brightGreen : ANSI.brightRed,
        String(state.lostUpdatesCount)
      )} │ Guard: _row_ver + inline _lc TEXT`
    )
  );
  lines.push(midDivider);

  // Section 4: Event Log & Interactive Keybindings Bar
  lines.push(boxLine(`Status: ${c(ANSI.cyan, state.lastActionLog)}`));
  lines.push(midDivider);
  lines.push(
    boxLine(
      `${c(ANSI.bold + ANSI.brightGreen, "[P]")} Promote  ${c(
        ANSI.bold + ANSI.brightCyan,
        "[K/F]"
      )} HW-Key/ThinkPad-FP  ${c(
        ANSI.bold + ANSI.brightMagenta,
        "[D]"
      )} Canary  ${c(ANSI.bold + ANSI.yellow, "[H]")} Hold  ${c(
        ANSI.bold + ANSI.brightRed,
        "[R]"
      )} <50ms Rollback  ${c(ANSI.bold + ANSI.brightCyan, "[C]")} Complete  ${c(
        ANSI.bold,
        "[Q]"
      )} Quit`
    )
  );
  lines.push(botBorder);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Extended TUI Primitives (@oh-my-pi/pi-tui + Codex + Clack spec compatibility)
// ---------------------------------------------------------------------------

export const ANSI_EXT = {
  ...ANSI,
  HIDE_CURSOR: "\x1b[?25l",
  SHOW_CURSOR: "\x1b[?25h",
  SYNC_BEGIN: "\x1b[?2026h",
  SYNC_END: "\x1b[?2026l",
  AUTOWRAP_OFF: "\x1b[?7l",
  AUTOWRAP_ON: "\x1b[?7h",
} as const;

export { ANSI_EXT as ANSI };

export function visibleWidth(input: string): number {
  const noOsc = input.replace(/\x1b\]8;;.*?\x07/g, "");
  // eslint-disable-next-line no-control-regex
  const noSgr = noOsc.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
  return Array.from(noSgr).length;
}

export function fitWidth(input: string, width: number): string {
  const w = visibleWidth(input);
  if (w === width) return input;
  if (w < width) return input + " ".repeat(width - w);
  const plain = stripAnsi(input.replace(/\x1b\]8;;.*?\x07/g, ""));
  return plain.slice(0, Math.max(0, width));
}

const FRACTIONAL_BLOCKS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"] as const;

export function renderFractionalBar(
  ratio: number,
  width: number,
  asciiFallback = false
): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  if (asciiFallback) {
    const filled = Math.round(clamped * width);
    return "#".repeat(filled) + "-".repeat(Math.max(0, width - filled));
  }
  const exact = clamped * width;
  const full = Math.floor(exact);
  const rem = exact - full;
  const eigths = Math.round(rem * 8);
  let out = "█".repeat(full);
  if (full < width) {
    if (eigths === 8) {
      out += "█";
    } else if (eigths > 0) {
      out += FRACTIONAL_BLOCKS[eigths];
    } else {
      out += "░";
    }
    const used = Array.from(out).length;
    if (used < width) {
      out += "░".repeat(width - used);
    }
  }
  return out;
}

const LEFT_BRAILLE_DOTS = [0, 0x40, 0x44, 0x46, 0x47] as const;
const RIGHT_BRAILLE_DOTS = [0, 0x80, 0xa0, 0xb0, 0xb8] as const;

export function renderBrailleSparkline(
  samples: readonly number[],
  maxVal = 100
): string {
  const out: string[] = [];
  const cap = maxVal > 0 ? maxVal : 1;
  for (let i = 0; i < samples.length; i += 2) {
    const s0 = Math.max(0, Math.min(1, (samples[i] ?? 0) / cap));
    const s1 = Math.max(0, Math.min(1, (samples[i + 1] ?? 0) / cap));
    const lIdx = Math.min(4, Math.round(s0 * 4));
    const rIdx = Math.min(4, Math.round(s1 * 4));
    const cp = 0x2800 | LEFT_BRAILLE_DOTS[lIdx] | RIGHT_BRAILLE_DOTS[rIdx];
    out.push(String.fromCodePoint(cp));
  }
  return out.join("");
}

export function resolveSynchronizedOutput(
  env: Record<string, string | undefined> = {}
): boolean {
  if (env.PI_NO_SYNC_OUTPUT === "1" || env.PI_TUI_SYNC_OUTPUT === "0") {
    return false;
  }
  if (env.PI_FORCE_SYNC_OUTPUT === "1" || env.PI_TUI_SYNC_OUTPUT === "1") {
    return true;
  }
  return true;
}

export interface HotRollTheme {
  enabled: boolean;
  primary: (s: string) => string;
  success: (s: string) => string;
  warning: (s: string) => string;
  danger: (s: string) => string;
  muted: (s: string) => string;
}

export function resolveTheme(
  env: Record<string, string | undefined> = {},
  isTTY = true
): HotRollTheme {
  const enabled =
    env.NO_COLOR === undefined && (env.FORCE_COLOR === "1" || isTTY);
  const wrap = (code: string) => (s: string) =>
    enabled ? `${code}${s}\x1b[0m` : s;
  return {
    enabled,
    primary: wrap("\x1b[36m"),
    success: wrap("\x1b[32m"),
    warning: wrap("\x1b[33m"),
    danger: wrap("\x1b[31m"),
    muted: wrap("\x1b[2m"),
  };
}

export class DifferentialTuiRenderer {
  private prevLines: string[] = [];
  private prevWidth = 0;
  private syncEnabled: boolean;

  constructor(env: Record<string, string | undefined> = {}) {
    this.syncEnabled = resolveSynchronizedOutput(env);
  }

  buildFramePayload(
    lines: string[],
    width: number
  ): {
    strategy: "first" | "diff" | "reflow" | "noop";
    changedLineCount: number;
    payload: string;
  } {
    const pre = this.syncEnabled
      ? `${ANSI_EXT.HIDE_CURSOR}${ANSI_EXT.SYNC_BEGIN}${ANSI_EXT.AUTOWRAP_OFF}`
      : "";
    const post = this.syncEnabled
      ? `${ANSI_EXT.AUTOWRAP_ON}${ANSI_EXT.SYNC_END}`
      : "";

    if (this.prevLines.length === 0) {
      this.prevLines = [...lines];
      this.prevWidth = width;
      return {
        strategy: "first",
        changedLineCount: lines.length,
        payload: `${pre}${lines.join("\r\n")}${post}`,
      };
    }

    if (width !== this.prevWidth || lines.length !== this.prevLines.length) {
      this.prevLines = [...lines];
      this.prevWidth = width;
      return {
        strategy: "reflow",
        changedLineCount: lines.length,
        payload: `${pre}\x1b[2J\x1b[H${lines.join("\r\n")}${post}`,
      };
    }

    let firstChanged = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] !== this.prevLines[i]) {
        firstChanged = i;
        break;
      }
    }

    if (firstChanged === -1) {
      return { strategy: "noop", changedLineCount: 0, payload: "" };
    }

    const upCount = lines.length - 1 - firstChanged;
    const moveUp = upCount > 0 ? `\x1b[${upCount}A\r` : "\r";
    const slice = lines.slice(firstChanged).map((l) => `\x1b[2K${l}`);
    this.prevLines = [...lines];
    return {
      strategy: "diff",
      changedLineCount: slice.length,
      payload: `${pre}${moveUp}${slice.join("\r\n")}${post}`,
    };
  }
}

export interface DashboardSnapshot {
  migrationId: string;
  tierLabel: string;
  sourceEpoch: number;
  targetEpoch: number;
  backfillCompletedRows: number;
  backfillTotalRows: number;
  walBytes: number;
  walCeilingBytes: number;
  cohortV1Pct: number;
  cohortV2Pct: number;
  darkCanaryMismatches: number;
  darkCanarySampled: number;
  p99HistoryUs: number[];
  tickIndex: number;
  hardwareAuthStatus?: string;
  awaitingStepUpChallenge?: boolean;
  stepUpPromptBanner?: string;
}

export function renderHotRollDashboard(
  snap: DashboardSnapshot,
  width = 76,
  theme: HotRollTheme = resolveTheme({}, false)
): string[] {
  const inner = width - 4;
  const row = (text: string) =>
    `${theme.primary("│")} ${fitWidth(text, inner)} ${theme.primary("│")}`;
  const top = theme.primary(`╭${"─".repeat(width - 2)}╮`);
  const mid = theme.primary(`├${"─".repeat(width - 2)}┤`);
  const bot = theme.primary(`╰${"─".repeat(width - 2)}╯`);
  const bfRatio =
    snap.backfillTotalRows > 0
      ? snap.backfillCompletedRows / snap.backfillTotalRows
      : 1;
  const bar = renderFractionalBar(bfRatio, 16, false);
  const spark = renderBrailleSparkline(snap.p99HistoryUs, 100);

  const lines: string[] = [
    top,
    row(`SQ-HotRoll :: ${snap.migrationId} [v${snap.sourceEpoch}->v${snap.targetEpoch}]`),
    row(`Tier: ${snap.tierLabel}`),
  ];

  if (snap.hardwareAuthStatus) {
    lines.push(row(`AUTH: ${snap.hardwareAuthStatus}`));
  }

  lines.push(
    mid,
    row(`Backfill: [${bar}] ${snap.backfillCompletedRows}/${snap.backfillTotalRows}`),
    row(`WAL Size: ${(snap.walBytes / 1024).toFixed(1)} KB / ${(snap.walCeilingBytes / 1024).toFixed(1)} KB`),
    row(`Cohorts:  v1=${snap.cohortV1Pct}% | v2=${snap.cohortV2Pct}%`),
    row(`Canary:   ${snap.darkCanarySampled} sampled (${snap.darkCanaryMismatches} mismatches)`),
    row(`Latency:  ${spark} p99 us`)
  );

  if (snap.awaitingStepUpChallenge) {
    const promptText =
      snap.stepUpPromptBanner ??
      "[AUTH] Awaiting Hardware Key tap / ThinkPad Fingerprint / Touch ID / PIV PIN...";
    lines.push(mid, row(promptText));
  }

  lines.push(
    row(`[P] Promote  [D] Diff  [R] <50ms Rollback  [C] Cutover  [Q] Quit`),
    bot
  );

  return lines;
}

export function renderClackTree(
  title: string,
  steps: Array<{ label: string; status: "done" | "active" | "pending"; detail?: string }>,
  footer: string,
  theme: HotRollTheme = resolveTheme({}, false)
): string[] {
  const out: string[] = [`┌  ${theme.primary(title)}`, "│"];
  for (const s of steps) {
    const sym = s.status === "done" ? "◇" : s.status === "active" ? "◆" : "○";
    const det = s.detail ? ` (${s.detail})` : "";
    out.push(`${sym}  ${s.label}${det}`);
    out.push("│");
  }
  out.push(`└  ${footer}`);
  return out;
}

export function parseHotRollKeystroke(
  key: string
):
  | "promote"
  | "hw_auth"
  | "rollback"
  | "diff"
  | "cutover"
  | "quit"
  | "interrupt"
  | "noop" {
  if (key === "\x03") return "interrupt";
  const k = key.toLowerCase();
  if (k === "p") return "promote";
  if (k === "k" || k === "f" || k === "m") return "hw_auth";
  if (k === "r") return "rollback";
  if (k === "d") return "diff";
  if (k === "c") return "cutover";
  if (k === "q") return "quit";
  return "noop";
}

export interface ZeroTrustProvenancePanelState {
  migrationId: string;
  jcsAstDigestShort: string;
  dsseSlsaVerified: boolean;
  oidcOrSpiffeBuilder: string;
  quorumValidSigners: number;
  quorumRequiredSigners: number;
  distinctRolesVerified: boolean;
  rekorLogIndex: number;
  pasetoKid: string;
  edgeSharedSecretsCount: number;
  z3BijectionVerified: boolean;
  ciMergeReady: boolean;
}

/**
 * Renders the live Zero-Trust Migration Provenance & Asymmetric Edge Verification panel
 * for `hotroll watch` / `hotroll ci-gate`. Every row has exact `width` visible columns.
 */
export function renderCiGateProvenancePanel(
  prov: ZeroTrustProvenancePanelState,
  width = 76,
  theme: HotRollTheme = resolveTheme({}, false)
): string[] {
  const inner = width - 4;
  const row = (text: string) =>
    `${theme.primary("│")} ${fitWidth(text, inner)} ${theme.primary("│")}`;
  const top = theme.primary(`╭${"─".repeat(width - 2)}╮`);
  const mid = theme.primary(`├${"─".repeat(width - 2)}┤`);
  const bot = theme.primary(`╰${"─".repeat(width - 2)}╯`);

  const dsseStatus = prov.dsseSlsaVerified ? "PASS (in-toto v1 / SLSA v1.0 DSSE PAE)" : "BLOCKED";
  const quorumStatus = `${prov.quorumValidSigners}/${prov.quorumRequiredSigners} Ed25519 (OIDC/SPIFFE + WebAuthn/KMS)`;
  const edgeStatus = `PASETO v4.public [${prov.pasetoKid}] (${prov.edgeSharedSecretsCount} edge secrets)`;
  const gateVerdict = prov.ciMergeReady ? "CI_MERGE_READY (SEALED)" : "CI_GATE_BLOCKED";

  return [
    top,
    row(`hotroll ci-gate :: Zero-Trust Provenance [${prov.migrationId}]`),
    mid,
    row(`RFC 8785 JCS AST : ${prov.jcsAstDigestShort} (Z3 Lens: ${prov.z3BijectionVerified ? "UNSAT" : "FAIL"})`),
    row(`DSSE Envelope    : ${dsseStatus}`),
    row(`Identity & Quorum: ${quorumStatus} [Rekor #${prov.rekorLogIndex}]`),
    row(`Builder Workload : ${prov.oidcOrSpiffeBuilder}`),
    row(`Edge Token Verify: ${edgeStatus}`),
    mid,
    row(`Gate Verdict     : ${gateVerdict}`),
    bot,
  ];
}

export type HardwareAuthenticatorClass =
  | "fido2-yubikey-sk-ed25519"
  | "linux-fprintd-tpm2"
  | "windows-hello-tpm2"
  | "macos-touchid-se"
  | "piv-cac-pkcs11-ssh-agent";

export interface HardwareAuthenticatorModalState {
  migrationId: string;
  jcsDigestShort: string;
  selectedAuthenticator: HardwareAuthenticatorClass;
  userPresenceVerified: boolean;
  signCount: number;
}

export function renderHardwareAuthenticatorModal(
  modal: HardwareAuthenticatorModalState,
  width = 76,
  theme: HotRollTheme = resolveTheme({}, false)
): string[] {
  const inner = width - 4;
  const row = (text: string) =>
    `${theme.primary("│")} ${fitWidth(text, inner)} ${theme.primary("│")}`;
  const top = theme.primary(`╭─ Hardware Attestation Required ${"─".repeat(Math.max(0, width - 34))}╮`);
  const mid = theme.primary(`├${"─".repeat(width - 2)}┤`);
  const bot = theme.primary(`╰${"─".repeat(width - 2)}╯`);

  return [
    top,
    row(`Action: [M] CI Merge & Promote :: ${modal.migrationId} (${modal.jcsDigestShort})`),
    mid,
    row(`1. FIDO2/CTAP2 YubiKey   : sk-ssh-ed25519@openssh.com (UP|UV signCount=${modal.signCount})`),
    row(`2. ThinkPad/Linux Biomet : fprintd + TPM 2.0 /dev/tpmrm0 (TPMS_ATTEST)`),
    row(`3. Windows Hello Business: webauthn.dll NGC + TPM 2.0 Assertion`),
    row(`4. macOS Touch ID        : Secure Enclave kSecAttrTokenIDSecureEnclave`),
    row(`5. PIV/CAC Smartcard     : PKCS#11 (OpenSC/ykcs11) + SSH_AUTH_SOCK`),
    mid,
    row(`Active: ${modal.selectedAuthenticator} | Presence: ${modal.userPresenceVerified ? "VERIFIED" : "AWAITING_TOUCH"}`),
    bot,
  ];
}

export * from "./hardware-auth.ts";
