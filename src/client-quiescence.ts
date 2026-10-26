/**
 * Client quiescence detector: idle AFK swap, navigate HTTP 200, and visibility-hidden cutover.
 *
 * @example
 * `	s
 * import * as mod from "@kanchingyg/hotroll/client-quiescence";
 * `
 *
 * @module
 */
/**
 * SQ-HotRoll Client-Side Quiescence SDK (`QuiescenceDetector`).
 * Implements:
 *  - Universal Quiescence Definition (\mathcal{Q}) via 4 deterministic browser events:
 *    1. Top-level HTML navigation (`Sec-Fetch-Mode: navigate` with HTTP 200)
 *    2. Client idle timeout (`>= 90 s` AFK) guarded by CAS input-abort (`QuiescentIdleSwap`)
 *    3. Tab visibility backgrounding (`visibilitychange -> hidden` with 0 pending fetches)
 *    4. Explicit workflow boundary (`hotRoll.checkpoint()`)
 *  - Two-Channel Navigation-Scoped Epoch Isolation:
 *    BroadcastChannel notifies open tabs of a new available bundle (`pendingUpgradeEpoch`)
 *    while each tab pins its active `tabSchemaEpoch` in tab-local memory until its own
 *    quiescence predicate \mathcal{Q}(c, t) holds.
 */

import {
  isClientQuiescent,
  type HotRollContext,
  type SchemaEpoch,
} from "./core.ts";

export interface QuiescenceSwapResult {
  upgraded: boolean;
  previousEpoch: SchemaEpoch;
  activeEpoch: SchemaEpoch;
  reason:
    | "NAVIGATE_200"
    | "IDLE_CAS_COMMIT"
    | "IDLE_ABORTED_BY_INPUT_OR_DIRTY_FORM"
    | "VISIBILITY_HIDDEN"
    | "EXPLICIT_CHECKPOINT"
    | "ELECTRON_IPC_QUIESCENT"
    | "WEBVIEW_HOST_BRIDGE_FREEZE"
    | "CAPPED_BY_HOST_BRIDGE_VERSION"
    | "NO_PENDING_UPGRADE"
    | "IN_FLIGHT_REQUESTS_BLOCKED";
}

export class QuiescenceDetector {
  private tabSchemaEpoch: SchemaEpoch;
  private pendingUpgradeEpoch: SchemaEpoch | null = null;
  private inFlightRequests = 0;
  private dirtyFormFields = 0;
  private idleDurationMs = 0;
  private visibilityHidden = false;
  private keystrokeDuringPrewarm = false;
  private maxHostSupportedEpoch?: SchemaEpoch;

  constructor(initialEpoch: SchemaEpoch = 1, maxHostSupportedEpoch?: SchemaEpoch) {
    this.tabSchemaEpoch = initialEpoch;
    this.maxHostSupportedEpoch = maxHostSupportedEpoch;
  }

  public setMaxHostSupportedEpoch(maxEpoch: SchemaEpoch): void {
    this.maxHostSupportedEpoch = maxEpoch;
  }

  public getActiveEpoch(): SchemaEpoch {
    return this.tabSchemaEpoch;
  }

  public getPendingUpgradeEpoch(): SchemaEpoch | null {
    return this.pendingUpgradeEpoch;
  }

  /**
   * Simulates receiving a `BroadcastChannel` notification from another tab (e.g., Tab 2)
   * that discovered a newer schema epoch on `Sec-Fetch-Mode: navigate`.
   * Crucially does NOT mutate `this.tabSchemaEpoch` while requests or forms are active!
   */
  public onCrossTabBroadcast(newEpoch: SchemaEpoch): void {
    if (newEpoch > this.tabSchemaEpoch) {
      this.pendingUpgradeEpoch = Math.max(
        this.pendingUpgradeEpoch ?? newEpoch,
        newEpoch
      );
    }
  }

  public beginRequest(): { requestEpochHeader: SchemaEpoch } {
    this.inFlightRequests += 1;
    return { requestEpochHeader: this.tabSchemaEpoch };
  }

  public endRequest(): void {
    this.inFlightRequests = Math.max(0, this.inFlightRequests - 1);
  }

  public setDirtyFormFields(count: number): void {
    this.dirtyFormFields = Math.max(0, count);
  }

  public recordUserKeystroke(): void {
    this.idleDurationMs = 0;
    this.keystrokeDuringPrewarm = true;
  }

  public advanceIdleClock(deltaMs: number): void {
    this.idleDurationMs += Math.max(0, deltaMs);
  }

  /**
   * Condition 1: Top-level HTML navigation (`Sec-Fetch-Mode: navigate` with HTTP 200).
   */
  public onHttp200Navigate(targetEpoch: SchemaEpoch): QuiescenceSwapResult {
    const prev = this.tabSchemaEpoch;
    this.inFlightRequests = 0;
    this.dirtyFormFields = 0;
    this.tabSchemaEpoch = targetEpoch;
    this.pendingUpgradeEpoch = null;
    return {
      upgraded: targetEpoch !== prev,
      previousEpoch: prev,
      activeEpoch: this.tabSchemaEpoch,
      reason: "NAVIGATE_200",
    };
  }

  /**
   * Condition 2: `QuiescentIdleSwap` with Compare-And-Swap (CAS) input-abort guard.
   * Pre-warms the `v+1` bundle in the background and aborts if any `keydown`/`pointerdown`
   * or dirty form field occurred during pre-warm.
   */
  public attemptQuiescentIdleSwap(
    simulateKeystrokeDuringPrewarm = false
  ): QuiescenceSwapResult {
    const prev = this.tabSchemaEpoch;
    if (
      this.pendingUpgradeEpoch === null ||
      this.pendingUpgradeEpoch <= this.tabSchemaEpoch
    ) {
      return {
        upgraded: false,
        previousEpoch: prev,
        activeEpoch: prev,
        reason: "NO_PENDING_UPGRADE",
      };
    }

    this.keystrokeDuringPrewarm = simulateKeystrokeDuringPrewarm;

    // CAS Commit check against HotRollContext:
    const ctx: HotRollContext = {
      sessionId: "tab-local",
      role: "user",
      region: "us-east",
      tenantId: "default",
      entitledFeatures: [],
      secFetchMode: "cors",
      headerEpoch: this.tabSchemaEpoch,
      idleSeconds: Math.floor(this.idleDurationMs / 1000),
      dirtyFormInputs: this.dirtyFormFields,
      inFlightUserMutations: this.inFlightRequests,
      preloadReady: !this.keystrokeDuringPrewarm,
    };

    if (this.keystrokeDuringPrewarm || !isClientQuiescent(ctx)) {
      return {
        upgraded: false,
        previousEpoch: prev,
        activeEpoch: prev,
        reason: "IDLE_ABORTED_BY_INPUT_OR_DIRTY_FORM",
      };
    }

    this.tabSchemaEpoch = this.pendingUpgradeEpoch;
    this.pendingUpgradeEpoch = null;
    return {
      upgraded: true,
      previousEpoch: prev,
      activeEpoch: this.tabSchemaEpoch,
      reason: "IDLE_CAS_COMMIT",
    };
  }

  /**
   * Condition 3: Tab visibility backgrounding (`visibilitychange -> hidden` with 0 in-flight requests).
   */
  public onVisibilityHidden(): QuiescenceSwapResult {
    const prev = this.tabSchemaEpoch;
    this.visibilityHidden = true;
    if (
      this.pendingUpgradeEpoch === null ||
      this.pendingUpgradeEpoch <= this.tabSchemaEpoch
    ) {
      return {
        upgraded: false,
        previousEpoch: prev,
        activeEpoch: prev,
        reason: "NO_PENDING_UPGRADE",
      };
    }
    if (this.inFlightRequests > 0 || this.dirtyFormFields > 0) {
      return {
        upgraded: false,
        previousEpoch: prev,
        activeEpoch: prev,
        reason: "IN_FLIGHT_REQUESTS_BLOCKED",
      };
    }
    this.tabSchemaEpoch = this.pendingUpgradeEpoch;
    this.pendingUpgradeEpoch = null;
    return {
      upgraded: true,
      previousEpoch: prev,
      activeEpoch: this.tabSchemaEpoch,
      reason: "VISIBILITY_HIDDEN",
    };
  }

  /**
   * Condition 4: Explicit workflow boundary (`hotRoll.checkpoint()`).
   */
  public checkpoint(): QuiescenceSwapResult {
    const prev = this.tabSchemaEpoch;
    if (
      this.pendingUpgradeEpoch === null ||
      this.pendingUpgradeEpoch <= this.tabSchemaEpoch
    ) {
      return {
        upgraded: false,
        previousEpoch: prev,
        activeEpoch: prev,
        reason: "NO_PENDING_UPGRADE",
      };
    }
    if (this.inFlightRequests > 0) {
      return {
        upgraded: false,
        previousEpoch: prev,
        activeEpoch: prev,
        reason: "IN_FLIGHT_REQUESTS_BLOCKED",
      };
    }
    this.tabSchemaEpoch = this.pendingUpgradeEpoch;
    this.pendingUpgradeEpoch = null;
    return {
      upgraded: true,
      previousEpoch: prev,
      activeEpoch: this.tabSchemaEpoch,
      reason: "EXPLICIT_CHECKPOINT",
    };
  }

  /**
   * Condition 5: Electron Desktop Main <-> Renderer IPC Quiescence (`powerMonitor.suspend`,
   * `lock-screen`, or window blur/idle with `inFlightIpc == 0 && dirtyEditors == 0`).
   * Atomically advances Main + all BrowserWindow renderers via IPC broadcast without HTML reload.
   */
  public onElectronIpcIdleOrBlur(): QuiescenceSwapResult {
    const prev = this.tabSchemaEpoch;
    if (
      this.pendingUpgradeEpoch === null ||
      this.pendingUpgradeEpoch <= this.tabSchemaEpoch
    ) {
      return {
        upgraded: false,
        previousEpoch: prev,
        activeEpoch: prev,
        reason: "NO_PENDING_UPGRADE",
      };
    }
    if (this.inFlightRequests > 0 || this.dirtyFormFields > 0) {
      return {
        upgraded: false,
        previousEpoch: prev,
        activeEpoch: prev,
        reason: "IN_FLIGHT_REQUESTS_BLOCKED",
      };
    }
    const target =
      this.maxHostSupportedEpoch !== undefined
        ? Math.min(this.pendingUpgradeEpoch, this.maxHostSupportedEpoch)
        : this.pendingUpgradeEpoch;
    if (target <= prev) {
      return {
        upgraded: false,
        previousEpoch: prev,
        activeEpoch: prev,
        reason: "CAPPED_BY_HOST_BRIDGE_VERSION",
      };
    }
    this.tabSchemaEpoch = target;
    this.pendingUpgradeEpoch = null;
    return {
      upgraded: true,
      previousEpoch: prev,
      activeEpoch: this.tabSchemaEpoch,
      reason: "ELECTRON_IPC_QUIESCENT",
    };
  }

  /**
   * Condition 6: In-App WebView (`WKWebView` / Android `WebView`) Native Host-Bridge Freeze Quiescence.
   * Caps target epoch at `min(hostSupportedEpoch, serverTargetEpoch)` so the WebView never emits
   * a schema version that the native iOS/Android host bridge binary cannot parse.
   */
  public onWebViewHostBridgeFreeze(hostSupportedEpoch: SchemaEpoch): QuiescenceSwapResult {
    this.maxHostSupportedEpoch = hostSupportedEpoch;
    const prev = this.tabSchemaEpoch;
    if (
      this.pendingUpgradeEpoch === null ||
      this.pendingUpgradeEpoch <= this.tabSchemaEpoch
    ) {
      return {
        upgraded: false,
        previousEpoch: prev,
        activeEpoch: prev,
        reason: "NO_PENDING_UPGRADE",
      };
    }
    if (this.inFlightRequests > 0 || this.dirtyFormFields > 0) {
      return {
        upgraded: false,
        previousEpoch: prev,
        activeEpoch: prev,
        reason: "IN_FLIGHT_REQUESTS_BLOCKED",
      };
    }
    const cappedEpoch = Math.min(this.pendingUpgradeEpoch, hostSupportedEpoch);
    if (cappedEpoch <= prev) {
      return {
        upgraded: false,
        previousEpoch: prev,
        activeEpoch: prev,
        reason: "CAPPED_BY_HOST_BRIDGE_VERSION",
      };
    }
    this.tabSchemaEpoch = cappedEpoch;
    this.pendingUpgradeEpoch = null;
    return {
      upgraded: true,
      previousEpoch: prev,
      activeEpoch: this.tabSchemaEpoch,
      reason: "WEBVIEW_HOST_BRIDGE_FREEZE",
    };
  }
}
