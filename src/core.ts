/**
 * HotRoll core: composite session tokens, cohort selection, quiescence, and DSSE quorum helpers.
 *
 * @example
 * `	s
 * import * as mod from "@kanchingyg/hotroll/core";
 * `
 *
 * @module
 */
import {
  KeyObject,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  timingSafeEqual,
} from "node:crypto";

/**
 * SQ-HotRoll Core Engine, Composite Token (<d1_bookmark>@<schema_epoch>),
 * CDN-Agnostic Portable Epoch Envelope (`PortableEpochToken`),
 * Universal Quiescence Signals (`Sec-Fetch-Mode: navigate`, 90s AFK CAS, `X-SQ-Checkpoint: ready`),
 * Hardware / Network / Cellular Breakpoint Affinity (`deviceMacOui`, `mtlsFingerprint`, `asnSubnet`, `cellId`),
 * and 5-Axis CohortSelector.
 */

export type SchemaEpoch = number; // e.g., 1, 2, 3 (bounded by N_max = 3)
export type UrgencyClass = "IMMEDIATE" | "ACTIVE_POLL" | "PASSIVE_IDLE" | "HOLD";
export type QuiescenceSurface =
  | "web-navigate"
  | "spa-idle-90s"
  | "electron-ipc-idle"
  | "webview-bridge-freeze"
  | "k8s-pod-drain"
  | "sandbox-resume"
  | "pos-mac-checkpoint";

export type MigrationTier =
  | "TIER_0_VIRTUAL_METADATA"
  | "TIER_1_INPLACE_COLUMN"
  | "TIER_2_SHADOW_TABLE";

export interface CompositeBookmarkToken {
  bookmark: string;
  epoch: SchemaEpoch;
}

/**
 * Enterprise Hardware / Network / Cellular Breakpoint Affinity.
 * Pins all devices on the same corporate LAN/POS MAC OUI, mTLS certificate cohort,
 * BGP/ASN subnet, or Amazon-style cellular shuffle-shard to the same deterministic rollout bucket.
 */
export interface EnterpriseBreakpointAffinity {
  deviceMacOui?: string;      // e.g., "00:1A:2B" POS / warehouse scanner hardware OUI
  mtlsFingerprint?: string;   // Zero-Trust mTLS device certificate SHA-256 fingerprint
  asnSubnet?: string;         // Corporate gateway / split-horizon DNS subnet or ASN
  cellId?: string;            // Cellular architecture / shuffle-shard cell identifier
}

/**
 * Stateless, HMAC-signed, CDN-agnostic Portable Epoch Envelope:
 * Wire format: `<version>.<epoch>.<causal_hlc_or_bookmark>.<device_fp_hash>.<hmac>`
 * Travels across Akamai, Fastly, CloudFront, Envoy/Borg/A1, and Cloudflare via
 * `X-SQ-Epoch-Token` HTTP header, cookie fallback, or gRPC/JSON metadata.
 */
export interface PortableEpochToken {
  version: number;
  epoch: SchemaEpoch;
  causalBookmark: string;
  deviceFpHash: string;
  hmac: string;
}

export interface HotRollContext {
  sessionId: string;
  userId?: string;
  role: string;
  region: string;
  tenantId: string;
  entitledFeatures: string[];
  secFetchMode: "navigate" | "cors" | "same-origin" | "no-cors" | "none";
  headerEpoch?: SchemaEpoch;
  cookieToken?: string;
  portableEpochToken?: string;       // `X-SQ-Epoch-Token` header or gRPC metadata
  explicitCheckpointReady?: boolean; // `X-SQ-Checkpoint: ready` (POS, YouTube chunk boundary, native mobile/IoT)
  quiescenceSurface?: QuiescenceSurface;
  maxClientSupportedEpoch?: SchemaEpoch; // Native host bridge / Electron / mobile binary schema ceiling
  podSchemaEpoch?: SchemaEpoch; // Kubernetes Pod / Container / Sandbox image schema epoch
  affinity?: EnterpriseBreakpointAffinity;
  idleSeconds: number;
  dirtyFormInputs: number;
  inFlightUserMutations: number;
  preloadReady: boolean;
  highWaterMarkEpoch?: SchemaEpoch;
}

export interface HotRollSystemState {
  activeEpochs: SchemaEpoch[]; // Sliding window, max length N_max = 3
  targetEpoch: SchemaEpoch;
  rollbackFlagActive: boolean;
  backfillCompletedEpochs: Set<SchemaEpoch>;
  rolloutPercentage: number; // 0..100
  requiredEntitlement?: string;
  hmacSecret?: string;
  jwksPublicKeys?: JwksKeyset; // Zero-Secret Edge Public Keyring (kid -> Ed25519 public key)
  blockedDeviceOuIs?: Set<string>; // Hardware OUI / POS shift-freeze hold list
}

export type CohortSelector = (ctx: HotRollContext, sys: HotRollSystemState) => SchemaEpoch;

/**
 * Computes a deterministic 16-hex-char device/network affinity hash from
 * (`deviceMacOui`, `mtlsFingerprint`, `asnSubnet`, `cellId`) or falls back to `sessionId`.
 */
export function computeAffinityHash(
  affinity?: EnterpriseBreakpointAffinity,
  fallbackId = "anon"
): string {
  const raw = [
    affinity?.cellId ?? "",
    affinity?.deviceMacOui ?? "",
    affinity?.mtlsFingerprint ?? "",
    affinity?.asnSubnet ?? "",
  ]
    .filter(Boolean)
    .join("|");
  const key = raw.length > 0 ? raw : fallbackId;
  return createHmac("sha256", "sq-hotroll-affinity-v1")
    .update(key)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Mints and HMAC-SHA256 signs a CDN-agnostic `PortableEpochToken`:
 * `<version>.<epoch>.<causal_hlc_or_bookmark>.<device_fp_hash>.<hmac>`
 */
export function signPortableEpochToken(
  params: {
    epoch: SchemaEpoch;
    causalBookmark: string;
    deviceFpHash: string;
    version?: number;
  },
  secret = "sq-hotroll-enterprise-default-secret"
): string {
  const version = params.version ?? 1;
  const safeBookmark = (params.causalBookmark || "00000000").replace(/\./g, "_");
  const safeFp = (params.deviceFpHash || "0000000000000000").replace(/\./g, "_");
  const payload = `${version}.${params.epoch}.${safeBookmark}.${safeFp}`;
  const mac = createHmac("sha256", secret).update(payload).digest("hex").slice(0, 24);
  return `${payload}.${mac}`;
}

/**
 * Verifies and parses a `PortableEpochToken` at any CDN edge or Origin Database Proxy.
 * Returns `null` if tampered, malformed, or signed with an invalid key.
 */
export function verifyPortableEpochToken(
  rawToken?: string | null,
  secret = "sq-hotroll-enterprise-default-secret"
): PortableEpochToken | null {
  if (!rawToken || typeof rawToken !== "string") {
    return null;
  }
  const parts = rawToken.trim().split(".");
  if (parts.length !== 5) {
    return null;
  }
  const [verStr, epochStr, causalBookmark, deviceFpHash, providedMac] = parts;
  const version = Number.parseInt(verStr, 10);
  const epoch = Number.parseInt(epochStr, 10);
  if (!Number.isFinite(version) || !Number.isFinite(epoch) || epoch < 1) {
    return null;
  }
  const payload = `${version}.${epoch}.${causalBookmark}.${deviceFpHash}`;
  const expectedMac = createHmac("sha256", secret).update(payload).digest("hex").slice(0, 24);
  const a = Buffer.from(providedMac, "utf8");
  const b = Buffer.from(expectedMac, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return null;
  }
  return {
    version,
    epoch,
    causalBookmark,
    deviceFpHash,
    hmac: providedMac,
  };
}
/**
 * Parses a composite `<d1_bookmark>@<schema_epoch>` token.
 * Defaults to `00000000@1` if malformed or absent.
 */

export const encodeEpochEnvelope = signPortableEpochToken;
export const verifyEpochEnvelope = verifyPortableEpochToken;

export function parseCompositeToken(raw?: string | null): CompositeBookmarkToken {
  if (!raw || typeof raw !== "string") {
    return { bookmark: "00000000", epoch: 1 };
  }
  const atIdx = raw.lastIndexOf("@");
  if (atIdx <= 0 || atIdx === raw.length - 1) {
    return { bookmark: raw.trim() || "00000000", epoch: 1 };
  }
  const bookmark = raw.slice(0, atIdx).trim() || "00000000";
  const parsedEpoch = Number.parseInt(raw.slice(atIdx + 1).trim(), 10);
  const epoch = Number.isFinite(parsedEpoch) && parsedEpoch >= 1 ? parsedEpoch : 1;
  return { bookmark, epoch };
}

/**
 * Serializes a composite `<d1_bookmark>@<schema_epoch>` token.
 */
export function serializeCompositeToken(token: CompositeBookmarkToken): string {
  return `${token.bookmark}@${token.epoch}`;
}

/**
 * Advances a composite token monotonically in both causal bookmark and schema epoch
 * unless an emergency 1-flag rollback is active.
 */
export function advanceCompositeToken(
  prev: CompositeBookmarkToken,
  nextBookmark: string,
  assignedEpoch: SchemaEpoch,
  rollbackActive = false
): CompositeBookmarkToken {
  const bookmark = nextBookmark > prev.bookmark ? nextBookmark : prev.bookmark;
  const epoch = rollbackActive ? 1 : Math.max(prev.epoch, assignedEpoch);
  return { bookmark, epoch };
}

/**
 * Computes the intra-role urgency class U(req) for a caller.
 */
export function classifyUrgency(
  ctx: HotRollContext,
  sys: HotRollSystemState
): UrgencyClass {
  if (sys.rollbackFlagActive) {
    return "HOLD";
  }
  if (
    sys.requiredEntitlement &&
    ctx.entitledFeatures.includes(sys.requiredEntitlement)
  ) {
    return "IMMEDIATE";
  }
  if (ctx.idleSeconds >= 90 && ctx.dirtyFormInputs === 0 && ctx.inFlightUserMutations === 0) {
    return "PASSIVE_IDLE";
  }
  if (ctx.secFetchMode === "navigate") {
    return "ACTIVE_POLL";
  }
  return "HOLD";
}

/**
 * Evaluates Universal Quiescence Q(ctx) for safe client epoch transition.
 */
/**
 * Evaluates Universal Quiescence Q(ctx) across Web SPAs, Multi-CDN APIs, Streaming Media,
 * and Hardware/POS/mTLS Native Clients:
 *  1. Web Navigation Quiescence: `Sec-Fetch-Mode: navigate` (+ HTTP 200)
 *  2. SPA / Streaming Idle Quiescence: `idle >= 90s` + `inFlight == 0` + `dirtyForms == 0` (`AbortController` CAS)
 *  3. Explicit Transaction / Device Checkpoint Boundary (`X-SQ-Checkpoint: ready` with 0 in-flight mutations)
 */
export function isClientQuiescent(ctx: HotRollContext): boolean {
  if (ctx.secFetchMode === "navigate" || ctx.quiescenceSurface === "web-navigate") {
    return true;
  }
  if (
    ctx.quiescenceSurface === "k8s-pod-drain" ||
    ctx.quiescenceSurface === "sandbox-resume"
  ) {
    return ctx.inFlightUserMutations === 0;
  }
  if (
    (ctx.explicitCheckpointReady ||
      ctx.quiescenceSurface === "pos-mac-checkpoint" ||
      ctx.quiescenceSurface === "electron-ipc-idle" ||
      ctx.quiescenceSurface === "webview-bridge-freeze") &&
    ctx.inFlightUserMutations === 0 &&
    ctx.dirtyFormInputs === 0
  ) {
    return true;
  }
  return (
    ctx.idleSeconds >= 90 &&
    ctx.dirtyFormInputs === 0 &&
    ctx.inFlightUserMutations === 0 &&
    ctx.preloadReady
  );
}

/**
 * Deterministic 25-line Composable 5-Axis CohortSelector.
 * Combines (1) Rollback & Backfill Readiness Gate, (2) Sub-Resource Header Isolation,
 * (3) Monotonic High-Water-Mark Stickiness, (4) Intra-Role Urgency Entitlement,
 * and (5) Quiescence-Gated Cohort Hash Promotion.
 */
export const defaultCohortSelector: CohortSelector = (ctx, sys) => {
  if (sys.rollbackFlagActive || !sys.backfillCompletedEpochs.has(sys.targetEpoch)) {
    return 1;
  }
  const verifiedAsym =
    ctx.portableEpochToken &&
    (ctx.portableEpochToken.startsWith("v2.public.") || ctx.portableEpochToken.startsWith("v4.public.")) &&
    sys.jwksPublicKeys
      ? verifyAsymmetricEpochToken(ctx.portableEpochToken, sys.jwksPublicKeys)
      : null;
  const verifiedPortable =
    verifiedAsym ??
    verifyPortableEpochToken(ctx.portableEpochToken, sys.hmacSecret);
  const cookieParsed = parseCompositeToken(ctx.cookieToken);
  const currentEpoch =
    verifiedPortable?.epoch ?? ctx.headerEpoch ?? cookieParsed.epoch;
  const hwm = Math.max(currentEpoch, ctx.highWaterMarkEpoch ?? 1);

  // Hardware / MAC OUI shift-freeze hold gate (e.g., POS terminals mid-shift)
  if (
    ctx.affinity?.deviceMacOui &&
    sys.blockedDeviceOuIs?.has(ctx.affinity.deviceMacOui)
  ) {
    return currentEpoch;
  }

  // Cap target epoch by native host bridge / Electron main / container binary ceiling if specified
  const effectiveTarget =
    ctx.maxClientSupportedEpoch !== undefined
      ? Math.min(sys.targetEpoch, ctx.maxClientSupportedEpoch)
      : sys.targetEpoch;

  const urgency = classifyUrgency(ctx, sys);
  if (urgency === "IMMEDIATE") {
    return Math.max(hwm, effectiveTarget);
  }
  if (!isClientQuiescent(ctx)) {
    return Math.min(currentEpoch, effectiveTarget);
  }

  // Deterministic hash bucket over hardware/cell/subnet breakpoint affinity (or sessionId fallback)
  const affinityKey =
    ctx.affinity?.cellId ||
    ctx.affinity?.deviceMacOui ||
    ctx.affinity?.mtlsFingerprint ||
    ctx.affinity?.asnSubnet ||
    ctx.sessionId;
  let hash = 2166136261;
  for (let i = 0; i < affinityKey.length; i++) {
    hash = Math.imul(hash ^ affinityKey.charCodeAt(i), 16777619);
  }
  const bucket = (hash >>> 0) % 100;
  const eligible =
    bucket < sys.rolloutPercentage ||
    urgency === "PASSIVE_IDLE" ||
    Boolean(ctx.explicitCheckpointReady && bucket < sys.rolloutPercentage);
  return eligible ? Math.max(hwm, effectiveTarget) : Math.min(hwm, effectiveTarget);
};

/**
 * Enforces the Wave 2 Sliding Version Window Admission Policy (N_max = 3).
 */
export class HotRollEngine {
  public readonly maxWindowSize = 3;
  private state: HotRollSystemState;
  private selector: CohortSelector;

  constructor(
    initialState?: Partial<HotRollSystemState>,
    selector: CohortSelector = defaultCohortSelector
  ) {
    this.state = {
      activeEpochs: initialState?.activeEpochs ?? [1, 2],
      targetEpoch: initialState?.targetEpoch ?? 2,
      rollbackFlagActive: initialState?.rollbackFlagActive ?? false,
      backfillCompletedEpochs: initialState?.backfillCompletedEpochs ?? new Set([1, 2]),
      rolloutPercentage: initialState?.rolloutPercentage ?? 100,
      requiredEntitlement: initialState?.requiredEntitlement,
      hmacSecret: initialState?.hmacSecret,
      jwksPublicKeys: initialState?.jwksPublicKeys,
      blockedDeviceOuIs: initialState?.blockedDeviceOuIs,
    };
    this.selector = selector;
  }

  public getState(): HotRollSystemState {
    return this.state;
  }

  public resolveEpoch(ctx: HotRollContext): SchemaEpoch {
    return this.selector(ctx, this.state);
  }

  /**
   * Triggers <50ms O(1) single-flag rollback to epoch 1.
   */
  public triggerInstantRollback(): { rolledBackTo: SchemaEpoch; elapsedMs: number } {
    const t0 = performance.now();
    this.state.rollbackFlagActive = true;
    this.state.targetEpoch = 1;
    return { rolledBackTo: 1, elapsedMs: performance.now() - t0 };
  }

  public clearRollback(targetEpoch: SchemaEpoch = 2): void {
    this.state.rollbackFlagActive = false;
    this.state.targetEpoch = targetEpoch;
  }

  /**
   * Registers a new schema epoch under the N_max = 3 Sliding Window Admission Policy.
   * If admitting the new epoch would exceed N_max = 3, the oldest epoch is retired.
   */
  public admitNewEpoch(newEpoch: SchemaEpoch): {
    activeEpochs: SchemaEpoch[];
    retiredEpoch?: SchemaEpoch;
  } {
    let retiredEpoch: SchemaEpoch | undefined;
    if (!this.state.activeEpochs.includes(newEpoch)) {
      if (this.state.activeEpochs.length >= this.maxWindowSize) {
        this.state.activeEpochs.sort((a, b) => a - b);
        retiredEpoch = this.state.activeEpochs.shift();
      }
      this.state.activeEpochs.push(newEpoch);
    }
    this.state.backfillCompletedEpochs.add(newEpoch);
    this.state.targetEpoch = newEpoch;
    return { activeEpochs: [...this.state.activeEpochs], retiredEpoch };
  }
}

// ============================================================================
// Enterprise Zero-Trust Cryptographic Attestation & Public-Key Edge Tokens
// 1. RFC 8785 (JCS) Canonical AST & Lens Graph SHA-384 Digest
// 2. DSSE v1 (in-toto Statement v1 / SLSA v1.0) + Ed25519 M-of-N Quorum
// 3. Asymmetric Ed25519 + JWKS `kid` Edge Epoch Token (`v2.public.<kid>...`)
// ============================================================================

export interface CanonicalColumnAst {
  name: string;
  sqlType: string;
  notNull: boolean;
  defaultExpr?: string | null;
  virtualExpr?: string | null;
}

export interface CanonicalLensTransformAst {
  kind: "IDENTITY" | "SPLIT_MERGE" | "RENAME_ENRICH" | "COMPUTED_VIRTUAL" | "CUSTOM";
  sourceColumns: string[];
  targetColumns: string[];
  forwardSqlExpr: string;
  backwardSqlExpr: string;
  complementDefaults?: Record<string, unknown>;
}

export interface CanonicalMigrationAstDescriptor {
  tableName: string;
  sourceEpoch: SchemaEpoch;
  targetEpoch: SchemaEpoch;
  tier: MigrationTier;
  columnsV1: CanonicalColumnAst[];
  columnsV2: CanonicalColumnAst[];
  lenses: CanonicalLensTransformAst[];
  rawDdlStatements?: string[];
  z3ProofObligationHash: string;
  parentEpochDigest: string;
}

/**
 * Strips SQL comments (`-- ...` and `/* ... * /`) and normalizes token whitespace/casing
 * so cosmetic formatting or comment changes never alter the canonical AST digest,
 * whereas any semantic change to identifiers, types, or expressions alters the digest.
 */
export function normalizeSqlAstTokenStream(sql: string): string {
  if (!sql) return "";
  // Strip block comments and line comments
  const withoutComments = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\r\n]*/g, " ");
  // Collapse whitespace and trim around punctuation
  return withoutComments
    .replace(/\s+/g, " ")
    .replace(/\s*([(),;=<>+\-*/])\s*/g, "$1")
    .trim();
}

/**
 * Implements RFC 8785 JSON Canonicalization Scheme (JCS):
 * - Lexicographically sorts object keys by UTF-16 code units recursively
 * - Serializes primitives using ES2015/JSON standard number/string encoding without whitespace
 */
export function canonicalizeJsonRfc8785(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("RFC 8785 JCS forbids NaN or Infinite numbers");
    }
    if (Object.is(value, -0)) {
      return "0";
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((item) => canonicalizeJsonRfc8785(item)).join(",") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    const pairs = keys.map(
      (k) => `${JSON.stringify(k)}:${canonicalizeJsonRfc8785(obj[k])}`
    );
    return "{" + pairs.join(",") + "}";
  }
  throw new Error(`Unsupported JCS type: ${typeof value}`);
}

/**
 * Computes a domain-separated `jcs-sha384:<hex>` digest over the RFC 8785 (JCS)
 * normalized Schema Migration AST & Lens Graph descriptor.
 */
export function computeCanonicalAstDigest(
  descriptor: CanonicalMigrationAstDescriptor
): string {
  const normalized = {
    schema: "https://hotroll.dev/ast-jcs/v1",
    tableName: descriptor.tableName.trim().toLowerCase(),
    sourceEpoch: descriptor.sourceEpoch,
    targetEpoch: descriptor.targetEpoch,
    tier: descriptor.tier,
    columnsV1: [...descriptor.columnsV1]
      .map((c) => ({
        name: c.name.trim().toLowerCase(),
        sqlType: normalizeSqlAstTokenStream(c.sqlType).toUpperCase(),
        notNull: Boolean(c.notNull),
        defaultExpr: c.defaultExpr ? normalizeSqlAstTokenStream(c.defaultExpr) : null,
        virtualExpr: c.virtualExpr ? normalizeSqlAstTokenStream(c.virtualExpr) : null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    columnsV2: [...descriptor.columnsV2]
      .map((c) => ({
        name: c.name.trim().toLowerCase(),
        sqlType: normalizeSqlAstTokenStream(c.sqlType).toUpperCase(),
        notNull: Boolean(c.notNull),
        defaultExpr: c.defaultExpr ? normalizeSqlAstTokenStream(c.defaultExpr) : null,
        virtualExpr: c.virtualExpr ? normalizeSqlAstTokenStream(c.virtualExpr) : null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    lenses: descriptor.lenses.map((l) => ({
      kind: l.kind,
      sourceColumns: l.sourceColumns.map((s) => s.trim().toLowerCase()),
      targetColumns: l.targetColumns.map((t) => t.trim().toLowerCase()),
      forwardSqlExpr: normalizeSqlAstTokenStream(l.forwardSqlExpr),
      backwardSqlExpr: normalizeSqlAstTokenStream(l.backwardSqlExpr),
      complementDefaults: l.complementDefaults ?? {},
    })),
    normalizedDdlStatements: (descriptor.rawDdlStatements ?? [])
      .map((s) => normalizeSqlAstTokenStream(s))
      .filter((s) => s.length > 0),
    z3ProofObligationHash: descriptor.z3ProofObligationHash.trim().toLowerCase(),
    parentEpochDigest: descriptor.parentEpochDigest.trim().toLowerCase(),
  };

  const jcsBytes = Buffer.from(canonicalizeJsonRfc8785(normalized), "utf8");
  const hashHex = createHash("sha384")
    .update("SQ-HOTROLL-AST-JCS-V1\0", "utf8")
    .update(jcsBytes)
    .digest("hex");
  return `jcs-sha384:${hashHex}`;
}

export type AttestationSignerRole =
  | "ci-oidc-fulcio"
  | "spiffe-workload"
  | "hardware-webauthn-kms";

export interface InTotoSlsaProvenanceStatement {
  _type: "https://in-toto.io/Statement/v1";
  subject: Array<{
    name: string;
    digest: {
      jcs_sha384: string;
      parent_epoch_digest: string;
    };
  }>;
  predicateType: "https://slsa.dev/provenance/v1";
  predicate: {
    buildDefinition: {
      targetEpoch: SchemaEpoch;
      z3ProofVerified: boolean;
    };
    runDetails: {
      builder: {
        id: string;
      };
      metadata: {
        invocationId: string;
        rekorLogIndex?: number;
      };
    };
  };
}

export type HardwareAuthenticatorModality =
  | "fido2-yubikey-sk"
  | "tpm2-fprintd-thinkpad"
  | "windows-hello-tpm2"
  | "macos-secure-enclave-touchid"
  | "piv-pkcs11-slot9c"
  | "ssh-agent-sk-forwarded"
  | "ci-oidc-fulcio";

export const CTAP2_FLAG_UP = 0x01; // Bit 0: User Presence (physical key touch / TPM policy session)
export const CTAP2_FLAG_UV = 0x04; // Bit 2: User Verification (match-on-chip fingerprint / PIN)
export const CTAP2_FLAG_UP_AND_UV = 0x05; // Both UP (0x01) and UV (0x04)

/**
 * Cryptographic Hardware Authenticator Assertion (CTAP2 / OpenSSH `sk-ssh-ed25519@openssh.com` / TPM 2.0).
 * Crucially, `ctapFlags` and `signCount` are cryptographically bound into the signed authenticatorData
 * buffer before Ed25519 signing, preventing userspace boolean spoofing (`LD_PRELOAD` / `ptrace`).
 */
export interface HardwareAuthAssertion {
  authenticatorType: HardwareAuthenticatorModality;
  ctapFlags: number; // Must include 0x01 (UP) | 0x04 (UV) = 0x05 when hardware UV is required
  signCount: number; // Monotonically increasing hardware counter (detects cloned tokens)
  rpId?: string;     // Relying party / namespace, e.g., "hotroll.migration@v1"
  deviceModel?: string; // e.g., "ThinkPad X1 Carbon Gen 12 (Synaptics Match-on-Chip + TPM 2.0)"
}

export interface DsseSignatureEntry {
  keyid: string;
  sig: string; // base64url encoded Ed25519 signature over DSSEv1 PAE (+ bound HardwareAuthAssertion)
  hardwareAssertion?: HardwareAuthAssertion;
}

export interface MigrationDsseEnvelope {
  payloadType: "application/vnd.in-toto+json";
  payload: string; // base64url encoded RFC 8785 JCS canonical statement bytes
  signatures: DsseSignatureEntry[];
}

export interface TrustPolicy {
  minQuorum: number;
  trustedKeys: Record<
    string,
    {
      publicKeyPemOrHex: KeyObject | string;
      role: AttestationSignerRole;
      lastSeenSignCount?: number;
      requireHardwareUv?: boolean;
    }
  >;
  requireDistinctRoles?: boolean;
  requireRekorInclusion?: boolean;
  requireHardwareUserVerification?: boolean;
  expectedTableName?: string;
  expectedTargetEpoch?: SchemaEpoch;
  expectedCanonicalAstDigest?: string;
  expectedParentEpochDigest?: string;
}

/**
 * Encodes standard DSSE v1 Pre-Authentication Encoding (PAE):
 * `"DSSEv1 " + LEN(payloadType) + " " + payloadType + " " + LEN(payloadBytes) + " " + payloadBytes`
 */
export function encodeDssePae(
  payloadType: string,
  payloadBytes: Uint8Array
): Buffer {
  const typeBytes = Buffer.from(payloadType, "utf8");
  const prefix = Buffer.from(
    `DSSEv1 ${typeBytes.byteLength} ${payloadType} ${payloadBytes.byteLength} `,
    "utf8"
  );
  return Buffer.concat([prefix, Buffer.from(payloadBytes)]);
}

/**
 * Constructs the hardware-bound authenticatorData + DSSE PAE buffer signed by the
 * hardware security module (YubiKey FIDO2 SK, ThinkPad TPM 2.0 + fprintd, Touch ID Secure Enclave, PIV 9c).
 * Layout follows WebAuthn / OpenSSH `sk-ssh-ed25519@openssh.com`:
 * `SHA256(rpId || modality) [32B] || ctapFlags [1B] || signCount_BE [4B] || SHA384(DSSE_PAE) [48B]`
 * Because `ctapFlags` and `signCount` are inside the signed bytes, tampering with them in JSON
 * invalidates the Ed25519 signature.
 */
export function encodeHardwareBoundPae(
  pae: Uint8Array,
  hw?: HardwareAuthAssertion
): Buffer {
  if (!hw) {
    return Buffer.from(pae);
  }
  const rpId = hw.rpId ?? "hotroll.migration@v1";
  const rpHash = createHash("sha256")
    .update(`${rpId}:${hw.authenticatorType}`, "utf8")
    .digest();
  const flagsAndCounter = Buffer.alloc(5);
  flagsAndCounter.writeUInt8(hw.ctapFlags & 0xff, 0);
  flagsAndCounter.writeUInt32BE(Math.max(0, hw.signCount >>> 0), 1);
  const clientDataHash = createHash("sha384").update(pae).digest();
  return Buffer.concat([rpHash, flagsAndCounter, clientDataHash]);
}

function resolvePrivateKey(keyInput: KeyObject | string): KeyObject {
  if (typeof keyInput !== "string") {
    return keyInput;
  }
  if (keyInput.includes("BEGIN")) {
    return createPrivateKey(keyInput);
  }
  return createPrivateKey({
    key: Buffer.from(keyInput, "hex"),
    format: "der",
    type: "pkcs8",
  });
}

function resolvePublicKey(keyInput: KeyObject | string): KeyObject {
  if (typeof keyInput !== "string") {
    return keyInput;
  }
  if (keyInput.includes("BEGIN")) {
    return createPublicKey(keyInput);
  }
  return createPublicKey({
    key: Buffer.from(keyInput, "hex"),
    format: "der",
    type: "spki",
  });
}

/**
 * Creates a signed DSSE v1 (`application/vnd.in-toto+json`) SLSA v1.0 Provenance Envelope
 * signed by one or more asymmetric Ed25519 keys.
 */
export function createMigrationDsseEnvelope(
  params: {
    tableName: string;
    canonicalAstDigest: string;
    parentEpochDigest: string;
    targetEpoch: SchemaEpoch;
    z3ProofVerified: boolean;
    spiffeOrOidcSubject: string;
    invocationId: string;
    rekorLogIndex?: number;
  },
  signers: Array<{
    keyid: string;
    privateKey: KeyObject | string;
    hardwareAssertion?: HardwareAuthAssertion;
  }>
): MigrationDsseEnvelope {
  const statement: InTotoSlsaProvenanceStatement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [
      {
        name: params.tableName,
        digest: {
          jcs_sha384: params.canonicalAstDigest,
          parent_epoch_digest: params.parentEpochDigest,
        },
      },
    ],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        targetEpoch: params.targetEpoch,
        z3ProofVerified: params.z3ProofVerified,
      },
      runDetails: {
        builder: {
          id: params.spiffeOrOidcSubject,
        },
        metadata: {
          invocationId: params.invocationId,
          ...(params.rekorLogIndex !== undefined
            ? { rekorLogIndex: params.rekorLogIndex }
            : {}),
        },
      },
    },
  };

  const payloadType = "application/vnd.in-toto+json" as const;
  const canonicalPayloadStr = canonicalizeJsonRfc8785(statement);
  const payloadBytes = Buffer.from(canonicalPayloadStr, "utf8");
  const pae = encodeDssePae(payloadType, payloadBytes);

  const signatures: DsseSignatureEntry[] = signers.map((s) => {
    const privKey = resolvePrivateKey(s.privateKey);
    const toSign = encodeHardwareBoundPae(pae, s.hardwareAssertion);
    const sigBuf = cryptoSign(null, toSign, privKey);
    return {
      keyid: s.keyid,
      sig: sigBuf.toString("base64url"),
      ...(s.hardwareAssertion ? { hardwareAssertion: { ...s.hardwareAssertion } } : {}),
    };
  });

  return {
    payloadType,
    payload: payloadBytes.toString("base64url"),
    signatures,
  };
}

/**
 * Verifies a `MigrationDsseEnvelope` against an M-of-N Ed25519 `TrustPolicy`.
 * Enforces DSSE v1 PAE signature validity, unique `keyid` signers, distinct role separation
 * (`ci-oidc-fulcio` + `hardware-webauthn-kms` / `spiffe-workload`), Z3 proof bit, Rekor log index,
 * and exact binding to targetEpoch, canonicalAstDigest, and parentEpochDigest.
 */
export function verifyMigrationDsseQuorum(
  envelope: MigrationDsseEnvelope,
  policy: TrustPolicy
): {
  verified: boolean;
  reason: string;
  validSigners: string[];
  roles: AttestationSignerRole[];
  statement?: InTotoSlsaProvenanceStatement;
} {
  if (
    !envelope ||
    envelope.payloadType !== "application/vnd.in-toto+json" ||
    typeof envelope.payload !== "string" ||
    !Array.isArray(envelope.signatures)
  ) {
    return {
      verified: false,
      reason: "INVALID_DSSE_ENVELOPE_FORMAT",
      validSigners: [],
      roles: [],
    };
  }

  let payloadBytes: Buffer;
  let statement: InTotoSlsaProvenanceStatement;
  try {
    payloadBytes = Buffer.from(envelope.payload, "base64url");
    statement = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    return {
      verified: false,
      reason: "MALFORMED_DSSE_PAYLOAD_JSON",
      validSigners: [],
      roles: [],
    };
  }

  if (
    statement._type !== "https://in-toto.io/Statement/v1" ||
    statement.predicateType !== "https://slsa.dev/provenance/v1" ||
    !statement.subject?.[0]
  ) {
    return {
      verified: false,
      reason: "INVALID_IN_TOTO_SLSA_STATEMENT",
      validSigners: [],
      roles: [],
    };
  }

  const subj = statement.subject[0];
  if (
    policy.expectedTableName !== undefined &&
    subj.name !== policy.expectedTableName
  ) {
    return {
      verified: false,
      reason: "SUBJECT_TABLE_MISMATCH",
      validSigners: [],
      roles: [],
    };
  }
  if (
    policy.expectedCanonicalAstDigest !== undefined &&
    subj.digest?.jcs_sha384 !== policy.expectedCanonicalAstDigest
  ) {
    return {
      verified: false,
      reason: "CANONICAL_AST_DIGEST_MISMATCH",
      validSigners: [],
      roles: [],
    };
  }
  if (
    policy.expectedParentEpochDigest !== undefined &&
    subj.digest?.parent_epoch_digest !== policy.expectedParentEpochDigest
  ) {
    return {
      verified: false,
      reason: "PARENT_EPOCH_DIGEST_MISMATCH",
      validSigners: [],
      roles: [],
    };
  }
  if (
    policy.expectedTargetEpoch !== undefined &&
    statement.predicate?.buildDefinition?.targetEpoch !==
      policy.expectedTargetEpoch
  ) {
    return {
      verified: false,
      reason: "TARGET_EPOCH_MISMATCH_OR_REPLAY",
      validSigners: [],
      roles: [],
    };
  }
  if (!statement.predicate?.buildDefinition?.z3ProofVerified) {
    return {
      verified: false,
      reason: "Z3_PROOF_NOT_VERIFIED",
      validSigners: [],
      roles: [],
    };
  }
  if (
    policy.requireRekorInclusion &&
    (typeof statement.predicate?.runDetails?.metadata?.rekorLogIndex !==
      "number" ||
      statement.predicate.runDetails.metadata.rekorLogIndex <= 0)
  ) {
    return {
      verified: false,
      reason: "MISSING_REKOR_TRANSPARENCY_LOG_INDEX",
      validSigners: [],
      roles: [],
    };
  }

  const pae = encodeDssePae(envelope.payloadType, payloadBytes);
  const seenKeyIds = new Set<string>();
  const validSigners: string[] = [];
  const validRoles: AttestationSignerRole[] = [];
  let hardwareRejectReason: string | null = null;

  for (const sigEntry of envelope.signatures) {
    if (!sigEntry?.keyid || !sigEntry?.sig) continue;
    // Reject duplicate signatures from the same keyid
    if (seenKeyIds.has(sigEntry.keyid)) continue;
    const trusted = policy.trustedKeys[sigEntry.keyid];
    if (!trusted) continue;

    try {
      const pubKey = resolvePublicKey(trusted.publicKeyPemOrHex);
      const sigBuf = Buffer.from(sigEntry.sig, "base64url");
      const toVerify = encodeHardwareBoundPae(pae, sigEntry.hardwareAssertion);
      const ok = cryptoVerify(null, toVerify, pubKey, sigBuf);
      if (!ok) {
        continue;
      }

      // Enforce CTAP2 / OpenSSH-SK / TPM2 Hardware User Presence (UP=0x01) + Biometric/PIN User Verification (UV=0x04)
      // and monotonic signCount anti-cloning invariant whenever required by policy or hardware signer role
      const needsHwUv =
        Boolean(policy.requireHardwareUserVerification && trusted.role === "hardware-webauthn-kms") ||
        Boolean(trusted.requireHardwareUv) ||
        Boolean(sigEntry.hardwareAssertion && trusted.role === "hardware-webauthn-kms");

      if (needsHwUv) {
        const hw = sigEntry.hardwareAssertion;
        if (!hw) {
          hardwareRejectReason = "MISSING_HARDWARE_AUTHENTICATOR_ASSERTION";
          continue;
        }
        if ((hw.ctapFlags & CTAP2_FLAG_UP_AND_UV) !== CTAP2_FLAG_UP_AND_UV) {
          hardwareRejectReason = "HARDWARE_USER_VERIFICATION_UV_FLAG_MISSING";
          continue;
        }
        if (
          trusted.lastSeenSignCount !== undefined &&
          hw.signCount <= trusted.lastSeenSignCount
        ) {
          hardwareRejectReason = "HARDWARE_SIGN_COUNTER_REPLAY_OR_CLONED_TOKEN";
          continue;
        }
      }

      seenKeyIds.add(sigEntry.keyid);
      validSigners.push(sigEntry.keyid);
      validRoles.push(trusted.role);
    } catch {
      // Ignore invalid key/signature entry
    }
  }

  if (validSigners.length < policy.minQuorum && hardwareRejectReason) {
    return {
      verified: false,
      reason: hardwareRejectReason,
      validSigners,
      roles: validRoles,
      statement,
    };
  }

  const distinctRoles = new Set(validRoles);
  if (validSigners.length < policy.minQuorum) {
    return {
      verified: false,
      reason: `QUORUM_NOT_MET_${validSigners.length}_OF_${policy.minQuorum}`,
      validSigners,
      roles: validRoles,
      statement,
    };
  }

  if (
    policy.requireDistinctRoles &&
    policy.minQuorum > 1 &&
    distinctRoles.size < Math.min(policy.minQuorum, 2)
  ) {
    return {
      verified: false,
      reason: "ROLE_SEPARATION_VIOLATION_SINGLE_ROLE_COLLUSION",
      validSigners,
      roles: validRoles,
      statement,
    };
  }

  return {
    verified: true,
    reason: "DSSE_SLSA_QUORUM_VERIFIED",
    validSigners,
    roles: validRoles,
    statement,
  };
}

/**
 * Public Keyring (`kid` -> Ed25519 Public Key) distributed to Multi-CDN POPs
 * (Cloudflare, Akamai, Fastly, CloudFront) and untrusted K8s ingress pods.
 * Contains ZERO shared secrets.
 */
export type JwksKeyset = Record<string, KeyObject | string>;

export interface AsymmetricPortableEpochToken extends PortableEpochToken {
  kid: string;
  signature: string;
}

/**
 * Signs an Asymmetric Zero-Secret Edge Epoch Token (`v2.public`) using Ed25519:
 * Wire format: `v2.public.<kid>.<epoch>.<causal_bookmark>.<device_fp_hash>.<ed25519_sig_b64url>`
 */
export function signAsymmetricEpochToken(
  params: {
    kid: string;
    epoch: SchemaEpoch;
    causalBookmark: string;
    deviceFpHash: string;
    schemePrefix?: "v2.public" | "v4.public";
  },
  privateKey: KeyObject | string
): string {
  const prefix = params.schemePrefix ?? "v4.public";
  const safeKid = params.kid.replace(/\./g, "_");
  const safeBookmark = (params.causalBookmark || "00000000").replace(/\./g, "_");
  const safeFp = (params.deviceFpHash || "0000000000000000").replace(/\./g, "_");
  const signingInput = `${prefix}.${safeKid}.${params.epoch}.${safeBookmark}.${safeFp}`;
  const priv = resolvePrivateKey(privateKey);
  const sigB64 = cryptoSign(
    null,
    Buffer.from(`SQ-HOTROLL-TOKEN-V2\0${signingInput}`, "utf8"),
    priv
  ).toString("base64url");
  return `${signingInput}.${sigB64}`;
}

/**
 * Verifies a `v2.public` Ed25519 Asymmetric Epoch Token using ONLY the public `JwksKeyset`.
 * Edge CDN POPs and K8s pods never hold a private signing key or shared HMAC secret.
 */
export function verifyAsymmetricEpochToken(
  rawToken: string | null | undefined,
  jwks: JwksKeyset
): AsymmetricPortableEpochToken | null {
  if (!rawToken || typeof rawToken !== "string" || !jwks) {
    return null;
  }
  const parts = rawToken.trim().split(".");
  if (parts.length !== 7) {
    return null;
  }
  const [verPrefix, modePrefix, kid, epochStr, causalBookmark, deviceFpHash, sigB64] =
    parts;
  if ((verPrefix !== "v2" && verPrefix !== "v4") || modePrefix !== "public" || !kid || !sigB64) {
    return null;
  }
  const epoch = Number.parseInt(epochStr, 10);
  if (!Number.isFinite(epoch) || epoch < 1) {
    return null;
  }
  const pubKeyEntry = jwks[kid];
  if (!pubKeyEntry) {
    return null;
  }
  try {
    const pubKey = resolvePublicKey(pubKeyEntry);
    const signingInput = `${verPrefix}.public.${kid}.${epoch}.${causalBookmark}.${deviceFpHash}`;
    const sigBuf = Buffer.from(sigB64, "base64url");
    const ok = cryptoVerify(
      null,
      Buffer.from(`SQ-HOTROLL-TOKEN-V2\0${signingInput}`, "utf8"),
      pubKey,
      sigBuf
    );
    if (!ok) {
      return null;
    }
    return {
      version: 2,
      kid,
      epoch,
      causalBookmark,
      deviceFpHash,
      hmac: sigB64,
      signature: sigB64,
    };
  } catch {
    return null;
  }
}
