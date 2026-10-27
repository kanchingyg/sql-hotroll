/**
 * SQ-HotRoll Drop-In Submodule: `sql-hotroll/cdn-range-gate`.
 * Enforces Extended Stream-Aware Quiescence, Epoch-Qualified Strong ETag ("<hash>-e<epoch>"),
 * If-Range & X-SQ-Stream-Lease pinning, and Two-Tier Cache Separation.
 * Polyglot SQL DDL lives in `sql-hotroll/polyglot-sql`.
 * @module
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { hasNoActiveStreamsOrMultipartLeases, type HotRollContext, type SchemaEpoch } from "./core.ts";

export interface StreamLeaseClaims {
  fileId: string;
  contentHash: string;
  epoch: SchemaEpoch;
  repVer: number;
  bookmark: string;
  expiresAtMs: number;
}

export function formatEpochETag(contentHash: string, epoch: SchemaEpoch, repVer = 1): string {
  const clean = contentHash.trim().toLowerCase().slice(0, 32);
  return repVer === 1 ? `"${clean}-e${epoch}"` : `"${clean}-e${epoch}-rep${repVer}"`;
}

export function parseEpochETag(etag?: string | null): { contentHash: string; epoch: SchemaEpoch; repVer: number } | null {
  if (!etag) return null;
  const m = /^"(?:v(\d+)-([a-f0-9]{8,64})|([a-f0-9]{8,64})-e(\d+)(?:-rep(\d+))?)"$/i.exec(etag.trim());
  if (!m) return null;
  if (m[1] && m[2]) {
    // Legacy `"v<epoch>-<hash>"` has no rep field; keep repVer=1.
    return { contentHash: m[2].toLowerCase(), epoch: Number.parseInt(m[1], 10), repVer: 1 };
  }
  return {
    contentHash: m[3].toLowerCase(),
    epoch: Number.parseInt(m[4], 10),
    repVer: m[5] ? Number.parseInt(m[5], 10) : 1,
  };
}

export function isStreamAwareQuiescent(ctx: HotRollContext): boolean {
  return (
    ctx.inFlightUserMutations === 0 &&
    ctx.dirtyFormInputs === 0 &&
    hasNoActiveStreamsOrMultipartLeases(ctx) &&
    (ctx.secFetchMode === "navigate" || ctx.explicitCheckpointReady === true || (ctx.idleSeconds >= 90 && ctx.preloadReady))
  );
}

/** Token form: `<claimsJsonBase64Url>.<hmacSha256Hex32>`. Base64url avoids `.` in fileId/bookmark. */
export function mintStreamLease(claims: StreamLeaseClaims, secret: string): string {
  const payloadB64Url = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const mac = createHmac("sha256", secret).update(payloadB64Url).digest("hex").slice(0, 32);
  return `${payloadB64Url}.${mac}`;
}

export function verifyStreamLease(token: string | undefined, secret: string, nowMs: number, expectedFileId?: string): StreamLeaseClaims | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const payloadB64Url = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expectedSig = createHmac("sha256", secret).update(payloadB64Url).digest("hex").slice(0, 32);
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expectedSig, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let claims: StreamLeaseClaims;
  try {
    claims = JSON.parse(Buffer.from(payloadB64Url, "base64url").toString("utf8")) as StreamLeaseClaims;
  } catch {
    return null;
  }
  if (
    typeof claims.fileId !== "string" ||
    typeof claims.contentHash !== "string" ||
    typeof claims.bookmark !== "string" ||
    !Number.isSafeInteger(claims.epoch) ||
    !Number.isSafeInteger(claims.repVer) ||
    !Number.isSafeInteger(claims.expiresAtMs) ||
    nowMs > claims.expiresAtMs
  ) {
    return null;
  }
  if (expectedFileId && claims.fileId !== expectedFileId) return null;
  return claims;
}
