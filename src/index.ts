/**
 * Session-quiescence-gated progressive SQL schema evolution with bijective inline
 * complement lenses, zero-trust SLSA v1.0 DSSE hardware quorum, and DEC Mode 2026 TUI
 * for Cloudflare D1, SQLite, and PostgreSQL 17.
 *
 * @example
 * ```ts
 * import {
 *   HotRollEngine,
 *   serializeCompositeToken,
 *   parseCompositeToken,
 * } from "@kanchingyg/hotroll";
 *
 * const token = serializeCompositeToken({ bookmark: "00000010", epoch: 2 });
 * const engine = new HotRollEngine();
 * ```
 *
 * @module
 */
export * from "./core.ts";
export * from "./lenses.ts";
export * from "./ast-rewriter.ts";
export * from "./d1-adapter.ts";
export * from "./postgres-adapter.ts";
export * from "./client-quiescence.ts";
export {
  IN_TOTO_STATEMENT_V1_TYPE,
  SLSA_PROVENANCE_V1_PREDICATE_TYPE,
  DSSE_PAYLOAD_TYPE_IN_TOTO,
  type FleetAuthenticatorModality,
  type HardwareTouchState,
  type Ed25519JwkPublic,
  type Ed25519SignerKeypair,
  type Ed25519JwksKeyset,
  type KeylessOidcWorkloadClaim,
  type HardwareBiometricAssertionMeta,
  type SqlAstStructuralSpec,
  type InTotoSlsaMigrationStatement,
  type DsseEnvelope,
  type SlsaCiMergeVerificationResult,
  type PasetoV4PublicEpochClaims,
  type PasetoV4Footer,
  generateFleetHardwareKeypair,
  canonicalizeRfc8785Jcs,
  parseSqlDdlStructuralAst,
  createSignedDsseMigrationEnvelope,
  verifyDsseMigrationEnvelope,
  mintPasetoV4PublicEpochToken,
  verifyPasetoV4PublicEpochToken,
  createDefaultFleetHardwareSetup,
} from "./attestation.ts";
export * from "./hardware-auth.ts";
export * from "./tui.ts";
