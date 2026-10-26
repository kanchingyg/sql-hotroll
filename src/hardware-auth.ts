/**
 * Fleet hardware authenticators: YubiKey FIDO2, TPM2, Windows Hello, Touch ID, and PIV.
 *
 * @example
 * ```ts
 * import * as mod from "@kanchingyg/hotroll/hardware-auth";
 * ```
 *
 * @module
 */
/**
 * @module hardware-auth
 * @description Enterprise Fleet Hardware Authenticator Auto-Detection, Policy Engine,
 * and OpenSSH `PROTOCOL.sshsig` + `PROTOCOL.u2f` (`sk-ssh-ed25519@openssh.com` &
 * `sk-ecdsa-sha2-nistp256@openssh.com`) Binary Envelope Verifier for `sql-hotroll`.
 *
 * Covers the 6 enterprise fleet hardware authentication methods:
 *  1. `'fido2-sk'`: OpenSSH 8.2+ FIDO2/CTAP2 Security Keys (`sk-ssh-ed25519@openssh.com`,
 *     `sk-ecdsa-sha2-nistp256@openssh.com`) via `ssh-sk-helper` / `libfido2` & `SSH_AUTH_SOCK`.
 *  2. `'thinkpad-fprintd'`: ThinkPad / Enterprise Linux Match-on-Chip Fingerprint Sensors
 *     (Synaptics / Goodix / Elan) via D-Bus `net.reactivated.Fprint` (`/net/reactivated/Fprint/Device/0`)
 *     paired with TPM 2.0 (`/dev/tpmrm0`) or `SSHSIG` cryptographic co-signing.
 *  3. `'tpm2-pkcs11'`: Enterprise Linux & Windows Discrete TPM 2.0 (Nuvoton / STMicro / Infineon)
 *     via `/dev/tpmrm0` and `libtpm2_pkcs11.so` (`ssh-keygen -D libtpm2_pkcs11.so.1`).
 *  4. `'windows-hello'`: Windows 11 Enterprise `Windows Hello for Business` (`webauthn.dll`
 *     `WebAuthNAuthenticatorGetAssertion` + `Microsoft Passport Key Storage Provider` + `ssh-sk-helper.exe`).
 *  5. `'macos-touchid'`: macOS Apple Silicon / T2 Secure Enclave (`kSecAttrTokenIDSecureEnclave` P-256
 *     + `LAContext.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics)` + `Secretive` `SSH_AUTH_SOCK`).
 *  6. `'piv-pkcs11'`: Enterprise Smartcards & NIST SP 800-73-4 PIV / DoD CAC / YubiKey PIV
 *     Slot `9a` (PIV Auth) & Slot `9c` (Digital Signature, PIN/touch per sign) via `libykcs11.so` / `opensc-pkcs11.so`.
 */

import {
  KeyObject,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** `SSHSIG_MAGIC_PREAMBLE` — exported SQ-HotRoll API symbol. */
export const SSHSIG_MAGIC_PREAMBLE = "SSHSIG";
/** `SSHSIG_VERSION` — exported SQ-HotRoll API symbol. */
export const SSHSIG_VERSION = 0x01;
/** `DEFAULT_HOTROLL_NAMESPACE` — exported SQ-HotRoll API symbol. */
export const DEFAULT_HOTROLL_NAMESPACE = "sql-hotroll@v1";
/** `DEFAULT_SK_APPLICATION` — exported SQ-HotRoll API symbol. */
export const DEFAULT_SK_APPLICATION = "ssh:sql-hotroll";

/** OpenSSH `PROTOCOL.u2f` / `sk-api.h` bitmasks */
export const SSH_SK_USER_PRESENCE_REQD = 0x01;
/** `SSH_SK_USER_VERIFICATION_REQD` — exported SQ-HotRoll API symbol. */
export const SSH_SK_USER_VERIFICATION_REQD = 0x04;
/** `SSH_SK_RESIDENT_KEY` — exported SQ-HotRoll API symbol. */
export const SSH_SK_RESIDENT_KEY = 0x20;

/** `HardwareAuthMethod` — exported SQ-HotRoll API symbol. */
export type HardwareAuthMethod =
  | "fido2-sk"
  | "thinkpad-fprintd"
  | "tpm2-pkcs11"
  | "windows-hello"
  | "macos-touchid"
  | "piv-pkcs11";

/** `OpenSshSkKeyType` — exported SQ-HotRoll API symbol. */
export type OpenSshSkKeyType =
  | "sk-ssh-ed25519@openssh.com"
  | "sk-ecdsa-sha2-nistp256@openssh.com"
  | "ssh-ed25519";

/** `RollbackAuthPolicy` — exported SQ-HotRoll API symbol. */
export type RollbackAuthPolicy = "instant" | "step-up";

/** `FprintdVerifyStatusResult` — exported SQ-HotRoll API symbol. */
export type FprintdVerifyStatusResult =
  | "verify-match"
  | "verify-no-match"
  | "verify-retry-scan"
  | "verify-swipe-too-short"
  | "verify-finger-not-centered"
  | "verify-remove-and-retry"
  | "verify-too-fast"
  | "verify-disconnected"
  | "verify-unknown-error";

/** `FleetAuthenticatorDescriptor` — exported SQ-HotRoll API symbol. */
export interface FleetAuthenticatorDescriptor {
  /** `method` property/member. */
  method: HardwareAuthMethod;
  /** `available` property/member. */
  available: boolean;
  /** `displayName` property/member. */
  displayName: string;
  /** `hardwareBacking` property/member. */
  hardwareBacking: string;
  /** `officialSpec` property/member. */
  officialSpec: string;
  /** `sshKeyType` property/member. */
  sshKeyType: OpenSshSkKeyType | "ecdsa-sha2-nistp256" | "ssh-rsa-cert-v01@openssh.com";
  /** `supportsUserPresence` property/member. */
  supportsUserPresence: boolean;
  /** `supportsUserVerification` property/member. */
  supportsUserVerification: boolean;
  /** `supportsSshAgentForwarding` property/member. */
  supportsSshAgentForwarding: boolean;
  /** `supportsAirGappedOffline` property/member. */
  supportsAirGappedOffline: boolean;
  /** `detectedVia` property/member. */
  detectedVia: string;
}

/** `MigrationSignPayloadSpec` — exported SQ-HotRoll API symbol. */
export interface MigrationSignPayloadSpec {
  /** `migrationId` property/member. */
  migrationId: string;
  /** `action` property/member. */
  action: "promote" | "cutover" | "rollback";
  /** `tableName` property/member. */
  tableName: string;
  /** `fromEpoch` property/member. */
  fromEpoch: number;
  /** `toEpoch` property/member. */
  toEpoch: number;
  /** `cohortPct` property/member. */
  cohortPct: number;
  /** `timestampMs` property/member. */
  timestampMs: number;
  /** `nonce` property/member. */
  nonce: string;
  /** `namespace` property/member. */
  namespace?: string;
}

/** `HardwareAuthAttestation` — exported SQ-HotRoll API symbol. */
export interface HardwareAuthAttestation {
  /** `method` property/member. */
  method: HardwareAuthMethod;
  /** `keyType` property/member. */
  keyType: OpenSshSkKeyType;
  /** `application` property/member. */
  application: string;
  /** `namespace` property/member. */
  namespace: string;
  /** `hashAlgorithm` property/member. */
  hashAlgorithm: "sha512" | "sha256";
  /** `flags` property/member. */
  flags: number;
  /** `userPresence` property/member. */
  userPresence: boolean;
  /** `userVerification` property/member. */
  userVerification: boolean;
  /** `counter` property/member. */
  counter: number;
  /** `armoredSignature` property/member. */
  armoredSignature: string;
  /** `publicKeyBlobBase64` property/member. */
  publicKeyBlobBase64: string;
  /** `principal` property/member. */
  principal: string;
  /** `fprintdResult` property/member. */
  fprintdResult?: FprintdVerifyStatusResult;
  /** `tpmDevicePath` property/member. */
  tpmDevicePath?: string;
  /** `pivSlot` property/member. */
  pivSlot?: "9a" | "9c";
  /** `viaSshAgentForwarding` property/member. */
  viaSshAgentForwarding?: boolean;
}

/** `ParsedOpenSshSigEnvelope` — exported SQ-HotRoll API symbol. */
export interface ParsedOpenSshSigEnvelope {
  /** `magicPreamble` property/member. */
  magicPreamble: string;
  /** `version` property/member. */
  version: number;
  /** `keyType` property/member. */
  keyType: OpenSshSkKeyType;
  /** `publicKeyBlob` property/member. */
  publicKeyBlob: Buffer;
  /** `rawPublicKey` property/member. */
  rawPublicKey: Buffer;
  /** `ecdsaCurveName` property/member. */
  ecdsaCurveName?: string;
  /** `application` property/member. */
  application: string;
  /** `namespace` property/member. */
  namespace: string;
  /** `reserved` property/member. */
  reserved: string;
  /** `hashAlgorithm` property/member. */
  hashAlgorithm: "sha512" | "sha256";
  /** `signatureKeyType` property/member. */
  signatureKeyType: string;
  /** `rawSignature` property/member. */
  rawSignature: Buffer;
  /** `flags` property/member. */
  flags: number;
  /** `userPresence` property/member. */
  userPresence: boolean;
  /** `userVerification` property/member. */
  userVerification: boolean;
  /** `counter` property/member. */
  counter: number;
}

/** `VerifyOpenSshSkResult` — exported SQ-HotRoll API symbol. */
export interface VerifyOpenSshSkResult {
  /** `verified` property/member. */
  verified: boolean;
  /** `keyType` property/member. */
  keyType?: OpenSshSkKeyType;
  /** `application` property/member. */
  application?: string;
  /** `namespace` property/member. */
  namespace?: string;
  /** `flags` property/member. */
  flags: number;
  /** `userPresence` property/member. */
  userPresence: boolean;
  /** `userVerification` property/member. */
  userVerification: boolean;
  /** `counter` property/member. */
  counter: number;
  /** `failureReason` property/member. */
  failureReason?:
    | "MALFORMED_SSHSIG_ARMOR"
    | "INVALID_SSHSIG_PREAMBLE_OR_VERSION"
    | "EMPTY_OR_MISMATCHED_NAMESPACE"
    | "UNSUPPORTED_HASH_OR_KEY_TYPE"
    | "KEY_TYPE_MISMATCH_OR_NON_SK_KEY"
    | "USER_PRESENCE_FLAG_MISSING"
    | "USER_VERIFICATION_FLAG_MISSING"
    | "SIGNATURE_COUNTER_REGRESSION_OR_CLONE"
    | "NONCE_REPLAY_DETECTED"
    | "CRYPTOGRAPHIC_SIGNATURE_INVALID"
    | "FPRINTD_BOOLEAN_SPOOF_BLOCKED";
}

function writeSshString(data: Buffer | string): Buffer {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.byteLength, 0);
  return Buffer.concat([len, buf]);
}

function readSshString(
  buf: Buffer,
  offset: number
): { value: Buffer; nextOffset: number } {
  if (offset + 4 > buf.byteLength) {
    throw new Error("Truncated SSH string length prefix");
  }
  const len = buf.readUInt32BE(offset);
  const start = offset + 4;
  const end = start + len;
  if (end > buf.byteLength) {
    throw new Error("Truncated SSH string body");
  }
  return {
    value: buf.subarray(start, end),
    nextOffset: end,
  };
}

function unsignedToMpint(rawUnsigned: Buffer): Buffer {
  let b = rawUnsigned;
  while (b.byteLength > 1 && b[0] === 0x00 && (b[1]! & 0x80) === 0) {
    b = b.subarray(1);
  }
  if (b.byteLength > 0 && (b[0]! & 0x80) !== 0) {
    b = Buffer.concat([Buffer.from([0x00]), b]);
  }
  return writeSshString(b);
}

function mpintToFixed32(mpintBytes: Buffer): Buffer {
  let b = mpintBytes;
  while (b.byteLength > 32 && b[0] === 0x00) {
    b = b.subarray(1);
  }
  if (b.byteLength > 32) {
    throw new Error("Invalid P-256 mpint length > 32 bytes");
  }
  if (b.byteLength < 32) {
    const pad = Buffer.alloc(32 - b.byteLength, 0);
    return Buffer.concat([pad, b]);
  }
  return Buffer.from(b);
}

/**
 * Builds a canonical, deterministic signing payload for TUI / CLI schema mutations
 * (`hotroll promote`, `hotroll cutover`, `hotroll rollback`).
 * Binds namespace, action, migrationId, tableName, source/target epochs, cohortPct,
 * timestampMs, and a 128-bit challenge nonce to defeat cross-command or cross-epoch replay.
 */
export function buildMigrationSignPayload(
  spec: MigrationSignPayloadSpec
): string {
  const ns = (spec.namespace ?? DEFAULT_HOTROLL_NAMESPACE).trim();
  if (!ns) {
    throw new Error("SSHSIG namespace must not be empty");
  }
  return [
    ns,
    `action=${spec.action}`,
    `migration=${spec.migrationId.trim()}`,
    `table=${spec.tableName.trim()}`,
    `epochs=${spec.fromEpoch}->${spec.toEpoch}`,
    `cohortPct=${spec.cohortPct.toFixed(1)}`,
    `ts=${spec.timestampMs}`,
    `nonce=${spec.nonce.trim()}`,
  ].join("|");
}

/**
 * Auto-detects enterprise fleet hardware authenticators available on the current host or
 * forwarded via `SSH_AUTH_SOCK`. Supports deterministic probing for unit/integration testing.
 */
export function detectFleetAuthenticators(options?: {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform | "linux" | "darwin" | "win32";
  probeOverrides?: Partial<Record<string, boolean>>;
  probePaths?: readonly string[];
}): FleetAuthenticatorDescriptor[] {
  const env = options?.env ?? (typeof process !== "undefined" ? process.env : {});
  const platform =
    options?.platform ?? (typeof process !== "undefined" ? process.platform : "linux");

  const checkPath = (p: string): boolean => {
    if (options?.probeOverrides && p in options.probeOverrides) {
      return Boolean(options.probeOverrides[p]);
    }
    if (options?.probePaths !== undefined) {
      return options.probePaths.includes(p);
    }
    try {
      return existsSync(p);
    } catch {
      return false;
    }
  };

  const hasSshAuthSock = Boolean(env.SSH_AUTH_SOCK && env.SSH_AUTH_SOCK.length > 0);
  const hasSshSkHelper =
    checkPath("/usr/lib/openssh/ssh-sk-helper") ||
    checkPath("/usr/libexec/ssh-sk-helper") ||
    checkPath("C:\\Windows\\System32\\OpenSSH\\ssh-sk-helper.exe") ||
    Boolean(env.SSH_SK_HELPER || env.SSH_SK_PROVIDER);

  const hasFprintd =
    platform === "linux" &&
    (checkPath("/usr/bin/fprintd-verify") ||
      checkPath("/usr/libexec/fprintd") ||
      checkPath("/etc/dbus-1/system.d/net.reactivated.Fprint.conf") ||
      Boolean(env.HOTROLL_ASSUME_THINKPAD_FPRINTD === "1"));

  const hasTpm2 =
    checkPath("/dev/tpmrm0") ||
    checkPath("/dev/tpm0") ||
    checkPath("/usr/lib/x86_64-linux-gnu/pkcs11/libtpm2_pkcs11.so") ||
    checkPath("/usr/lib/x86_64-linux-gnu/libtpm2_pkcs11.so.1") ||
    Boolean(env.HOTROLL_ASSUME_TPM2 === "1");

  const hasWindowsHello =
    (platform === "win32" &&
      (checkPath("C:\\Windows\\System32\\WinBioDatabase") ||
        checkPath("C:\\Windows\\System32\\WinBioPlugIns") ||
        checkPath("C:\\Windows\\System32\\webauthn.dll"))) ||
    checkPath("C:\\Windows\\System32\\webauthn.dll") ||
    Boolean(env.SSH_SK_PROVIDER?.toLowerCase().includes("winhello")) ||
    Boolean(env.HOTROLL_ASSUME_WINDOWS_HELLO === "1");

  const hasMacOsTouchId =
    (platform === "darwin" && checkPath("/usr/lib/pam/pam_tid.so.2")) ||
    checkPath("/usr/lib/pam/pam_tid.so.2") ||
    Boolean(env.SSH_AUTH_SOCK?.includes("com.maxgoedjen.Secretive")) ||
    Boolean(env.HOTROLL_ASSUME_MACOS_TOUCHID === "1");

  const hasPivPkcs11 =
    checkPath("/usr/lib/x86_64-linux-gnu/opensc-pkcs11.so") ||
    checkPath("/usr/local/lib/libykcs11.so") ||
    checkPath("/opt/homebrew/lib/libykcs11.dylib") ||
    checkPath("/usr/lib/openssh/ssh-pkcs11-helper") ||
    Boolean(env.HOTROLL_PKCS11_PROVIDER);

  return [
    {
      method: "fido2-sk",
      available: hasSshSkHelper || hasSshAuthSock,
      displayName: "FIDO2 / CTAP2 Security Key (YubiKey 5 / Bio / SoloKey v2 / Titan)",
      hardwareBacking: "USB-HID / NFC FIDO2 Secure Element (CTAP 2.1)",
      officialSpec: "OpenSSH PROTOCOL.sshsig + PROTOCOL.u2f (SSH_SK_VERSION_MAJOR 0x00050000)",
      sshKeyType: "sk-ssh-ed25519@openssh.com",
      supportsUserPresence: true,
      supportsUserVerification: true,
      supportsSshAgentForwarding: true,
      supportsAirGappedOffline: true,
      detectedVia: hasSshSkHelper
        ? "ssh-sk-helper + libfido2"
        : hasSshAuthSock
        ? "SSH_AUTH_SOCK agent forwarding"
        : "none",
    },
    {
      method: "thinkpad-fprintd",
      available: hasFprintd,
      displayName: "ThinkPad Match-on-Chip Fingerprint (Synaptics / Goodix / Elan) + TPM 2.0",
      hardwareBacking: "fprintd D-Bus net.reactivated.Fprint + Discrete TPM 2.0 /dev/tpmrm0",
      officialSpec: "freedesktop.org fprintd Device.Claim/VerifyStart + TCG TPM 2.0",
      sshKeyType: "sk-ecdsa-sha2-nistp256@openssh.com",
      supportsUserPresence: true,
      supportsUserVerification: true,
      supportsSshAgentForwarding: true,
      supportsAirGappedOffline: true,
      detectedVia: hasFprintd
        ? "net.reactivated.Fprint (/net/reactivated/Fprint/Device/0)"
        : "none",
    },
    {
      method: "tpm2-pkcs11",
      available: hasTpm2,
      displayName: "Enterprise Discrete TPM 2.0 (Nuvoton / Infineon / STMicro PKCS#11)",
      hardwareBacking: "Linux /dev/tpmrm0 Kernel Resource Manager + libtpm2_pkcs11.so",
      officialSpec: "OASIS PKCS#11 v2.40 + tpm2-pkcs11 + RFC 7512 PKCS#11 URI",
      sshKeyType: "ecdsa-sha2-nistp256",
      supportsUserPresence: false,
      supportsUserVerification: true,
      supportsSshAgentForwarding: true,
      supportsAirGappedOffline: true,
      detectedVia: hasTpm2 ? "/dev/tpmrm0 or ssh-pkcs11-helper" : "none",
    },
    {
      method: "windows-hello",
      available: hasWindowsHello,
      displayName: "Windows Hello for Business (TPM 2.0 NGC + Biometric Fingerprint / IR Face)",
      hardwareBacking: "Microsoft Passport Key Storage Provider (TPM 2.0) + WinBio",
      officialSpec: "Microsoft webauthn.dll API v1..v7 + Windows OpenSSH 8.9+ ssh-sk-helper.exe",
      sshKeyType: "sk-ecdsa-sha2-nistp256@openssh.com",
      supportsUserPresence: true,
      supportsUserVerification: true,
      supportsSshAgentForwarding: true,
      supportsAirGappedOffline: true,
      detectedVia: hasWindowsHello ? "webauthn.dll + ssh-sk-helper.exe" : "none",
    },
    {
      method: "macos-touchid",
      available: hasMacOsTouchId,
      displayName: "macOS Touch ID + Apple Secure Enclave (Secretive / LocalAuthentication)",
      hardwareBacking: "Apple Silicon / T2 Secure Enclave Processor (kSecAttrTokenIDSecureEnclave)",
      officialSpec: "Apple LocalAuthentication LAContext (.deviceOwnerAuthenticationWithBiometrics)",
      sshKeyType: "sk-ecdsa-sha2-nistp256@openssh.com",
      supportsUserPresence: true,
      supportsUserVerification: true,
      supportsSshAgentForwarding: true,
      supportsAirGappedOffline: true,
      detectedVia: hasMacOsTouchId
        ? "Secure Enclave + pam_tid.so.2 / Secretive SSH_AUTH_SOCK"
        : "none",
    },
    {
      method: "piv-pkcs11",
      available: hasPivPkcs11,
      displayName: "Enterprise PIV / DoD CAC Smartcard (Slot 9a Auth / Slot 9c Digital Signature)",
      hardwareBacking: "Hardware Smartcard / YubiKey PIV Applet (libykcs11.so / opensc-pkcs11.so)",
      officialSpec: "NIST SP 800-73-4 PIV + OpenSSH PKCS#11 URI (pkcs11:id=%9c)",
      sshKeyType: "ecdsa-sha2-nistp256",
      supportsUserPresence: true,
      supportsUserVerification: true,
      supportsSshAgentForwarding: true,
      supportsAirGappedOffline: true,
      detectedVia: hasPivPkcs11 ? "ssh-pkcs11-helper + libykcs11/opensc" : "none",
    },
  ];
}

/**
 * Generates an ephemeral keypair suitable for creating OpenSSH `SSHSIG` hardware-backed
 * (`sk-ssh-ed25519@openssh.com` or `sk-ecdsa-sha2-nistp256@openssh.com`) envelopes in tests and CLI benchmarks.
 */
export function generateOpenSshSkKeyPair(
  keyType: OpenSshSkKeyType = "sk-ssh-ed25519@openssh.com"
): {
  keyType: OpenSshSkKeyType;
  publicKeyPem: string;
  privateKeyPem: string;
  rawPublicKey: Buffer;
} {
  if (keyType === "sk-ecdsa-sha2-nistp256@openssh.com") {
    const { publicKey, privateKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
    const rawPoint65 = Buffer.concat([
      Buffer.from([0x04]),
      Buffer.from(jwk.x, "base64url"),
      Buffer.from(jwk.y, "base64url"),
    ]);
    return {
      keyType,
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) as string,
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
      rawPublicKey: rawPoint65,
    };
  }

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spkiDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const rawPub32 = Buffer.from(spkiDer.subarray(spkiDer.byteLength - 32));
  return {
    keyType,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) as string,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    rawPublicKey: rawPub32,
  };
}

/**
 * Constructs a binary-exact OpenSSH `PROTOCOL.sshsig` + `PROTOCOL.u2f` armored signature
 * (`-----BEGIN SSH SIGNATURE----- ... -----END SSH SIGNATURE-----`) that is 100% compatible
 * with `ssh-keygen -Y verify` in OpenSSH 8.2..10.0+.
 */
export function createOpenSshSkSignatureEnvelope(params: {
  message: string | Uint8Array;
  privateKeyPem: string;
  rawPublicKey: Buffer;
  keyType?: OpenSshSkKeyType;
  application?: string;
  namespace?: string;
  hashAlgorithm?: "sha512" | "sha256";
  flags?: number;
  counter?: number;
  method?: HardwareAuthMethod;
  principal?: string;
  fprintdResult?: FprintdVerifyStatusResult;
  tpmDevicePath?: string;
  pivSlot?: "9a" | "9c";
  viaSshAgentForwarding?: boolean;
}): HardwareAuthAttestation {
  const keyType = params.keyType ?? "sk-ssh-ed25519@openssh.com";
  const application = params.application ?? DEFAULT_SK_APPLICATION;
  const namespace = params.namespace ?? DEFAULT_HOTROLL_NAMESPACE;
  const hashAlgorithm = params.hashAlgorithm ?? "sha512";
  const flags =
    params.flags ??
    (SSH_SK_USER_PRESENCE_REQD | SSH_SK_USER_VERIFICATION_REQD); // 0x05 (UP + UV)
  const counter = params.counter ?? 1;
  const msgBuf =
    typeof params.message === "string"
      ? Buffer.from(params.message, "utf8")
      : Buffer.from(params.message);

  // 1. Serialize SSH publickey blob per RFC 4253 / RFC 5656 / PROTOCOL.u2f
  let pubBlob: Buffer;
  if (keyType === "sk-ssh-ed25519@openssh.com") {
    pubBlob = Buffer.concat([
      writeSshString("sk-ssh-ed25519@openssh.com"),
      writeSshString(params.rawPublicKey),
      writeSshString(application),
    ]);
  } else if (keyType === "sk-ecdsa-sha2-nistp256@openssh.com") {
    pubBlob = Buffer.concat([
      writeSshString("sk-ecdsa-sha2-nistp256@openssh.com"),
      writeSshString("nistp256"),
      writeSshString(params.rawPublicKey),
      writeSshString(application),
    ]);
  } else {
    pubBlob = Buffer.concat([
      writeSshString("ssh-ed25519"),
      writeSshString(params.rawPublicKey),
    ]);
  }

  // 2. Build PROTOCOL.sshsig Section 3 Signed Data:
  // "SSHSIG" || string(namespace) || string(reserved) || string(hash_algorithm) || string(H(message))
  const msgHash = createHash(hashAlgorithm).update(msgBuf).digest();
  const sshsigSignedData = Buffer.concat([
    Buffer.from(SSHSIG_MAGIC_PREAMBLE, "ascii"),
    writeSshString(namespace),
    writeSshString(""),
    writeSshString(hashAlgorithm),
    writeSshString(msgHash),
  ]);

  // 3. Build signature blob per PROTOCOL.u2f or RFC 8709
  const privKey = createPrivateKey(params.privateKeyPem);
  let sigBlob: Buffer;

  if (
    keyType === "sk-ssh-ed25519@openssh.com" ||
    keyType === "sk-ecdsa-sha2-nistp256@openssh.com"
  ) {
    const appHash = createHash("sha256").update(application, "utf8").digest();
    const dataHash = createHash("sha256").update(sshsigSignedData).digest();
    const fidoFooter = Buffer.alloc(5);
    fidoFooter.writeUInt8(flags & 0xff, 0);
    fidoFooter.writeUInt32BE(counter >>> 0, 1);

    const u2fAssertionBlob = Buffer.concat([appHash, fidoFooter, dataHash]);

    if (keyType === "sk-ssh-ed25519@openssh.com") {
      const rawEdSig = cryptoSign(null, u2fAssertionBlob, privKey);
      sigBlob = Buffer.concat([
        writeSshString("sk-ssh-ed25519@openssh.com"),
        writeSshString(rawEdSig),
        fidoFooter,
      ]);
    } else {
      const ieeeSig = cryptoSign("sha256", u2fAssertionBlob, {
        key: privKey,
        dsaEncoding: "ieee-p1363",
      });
      const rMpint = unsignedToMpint(ieeeSig.subarray(0, 32));
      const sMpint = unsignedToMpint(ieeeSig.subarray(32, 64));
      const ecdsaInner = Buffer.concat([rMpint, sMpint]);
      sigBlob = Buffer.concat([
        writeSshString("sk-ecdsa-sha2-nistp256@openssh.com"),
        writeSshString(ecdsaInner),
        fidoFooter,
      ]);
    }
  } else {
    const rawEdSig = cryptoSign(null, sshsigSignedData, privKey);
    sigBlob = Buffer.concat([
      writeSshString("ssh-ed25519"),
      writeSshString(rawEdSig),
    ]);
  }

  // 4. Assemble full PROTOCOL.sshsig Section 2 binary blob
  const verBuf = Buffer.alloc(4);
  verBuf.writeUInt32BE(SSHSIG_VERSION, 0);
  const fullBlob = Buffer.concat([
    Buffer.from(SSHSIG_MAGIC_PREAMBLE, "ascii"),
    verBuf,
    writeSshString(pubBlob),
    writeSshString(namespace),
    writeSshString(""),
    writeSshString(hashAlgorithm),
    writeSshString(sigBlob),
  ]);

  const wrappedBase64 = fullBlob
    .toString("base64")
    .replace(/(.{76})/g, "$1\n")
    .trim();
  const armoredSignature = `-----BEGIN SSH SIGNATURE-----\n${wrappedBase64}\n-----END SSH SIGNATURE-----\n`;

  return {
    method: params.method ?? "fido2-sk",
    keyType,
    application,
    namespace,
    hashAlgorithm,
    flags,
    userPresence: (flags & SSH_SK_USER_PRESENCE_REQD) !== 0,
    userVerification: (flags & SSH_SK_USER_VERIFICATION_REQD) !== 0,
    counter: counter >>> 0,
    armoredSignature,
    publicKeyBlobBase64: pubBlob.toString("base64"),
    principal: params.principal ?? "augusto@fleet.internal",
    fprintdResult: params.fprintdResult,
    tpmDevicePath: params.tpmDevicePath,
    pivSlot: params.pivSlot,
    viaSshAgentForwarding: params.viaSshAgentForwarding ?? false,
  };
}

/**
 * Parses an armored OpenSSH `SSHSIG` signature (`-----BEGIN SSH SIGNATURE-----`) into its
 * constituent `PROTOCOL.sshsig` and `PROTOCOL.u2f` binary fields (`flags`, `counter`, `namespace`, etc.).
 */
export function parseOpenSshSignatureEnvelope(
  armoredSignature: string
): ParsedOpenSshSigEnvelope {
  const trimmed = (armoredSignature ?? "").replace(/\r\n/g, "\n").trim();
  const header = "-----BEGIN SSH SIGNATURE-----";
  const footer = "-----END SSH SIGNATURE-----";
  if (!trimmed.startsWith(header) || !trimmed.endsWith(footer)) {
    throw new Error("MALFORMED_SSHSIG_ARMOR");
  }
  const b64Body = trimmed
    .slice(header.length, trimmed.length - footer.length)
    .replace(/\s+/g, "");
  if (!b64Body) {
    throw new Error("MALFORMED_SSHSIG_ARMOR");
  }
  const blob = Buffer.from(b64Body, "base64");
  if (blob.byteLength < 14) {
    throw new Error("INVALID_SSHSIG_PREAMBLE_OR_VERSION");
  }

  const magicPreamble = blob.subarray(0, 6).toString("ascii");
  const version = blob.readUInt32BE(6);
  if (magicPreamble !== SSHSIG_MAGIC_PREAMBLE || version !== SSHSIG_VERSION) {
    throw new Error("INVALID_SSHSIG_PREAMBLE_OR_VERSION");
  }

  let offset = 10;
  const pubKeyField = readSshString(blob, offset);
  offset = pubKeyField.nextOffset;
  const namespaceField = readSshString(blob, offset);
  offset = namespaceField.nextOffset;
  const reservedField = readSshString(blob, offset);
  offset = reservedField.nextOffset;
  const hashAlgField = readSshString(blob, offset);
  offset = hashAlgField.nextOffset;
  const sigField = readSshString(blob, offset);

  // Parse public key blob
  const pubBlob = pubKeyField.value;
  let pubOffset = 0;
  const pubKeyTypeStr = readSshString(pubBlob, pubOffset);
  pubOffset = pubKeyTypeStr.nextOffset;
  const keyType = pubKeyTypeStr.value.toString("utf8") as OpenSshSkKeyType;

  let rawPublicKey: Buffer;
  let ecdsaCurveName: string | undefined;
  let application = "";

  if (keyType === "sk-ssh-ed25519@openssh.com") {
    const rawPub = readSshString(pubBlob, pubOffset);
    pubOffset = rawPub.nextOffset;
    const appStr = readSshString(pubBlob, pubOffset);
    rawPublicKey = rawPub.value;
    application = appStr.value.toString("utf8");
  } else if (keyType === "sk-ecdsa-sha2-nistp256@openssh.com") {
    const curveStr = readSshString(pubBlob, pubOffset);
    pubOffset = curveStr.nextOffset;
    const qPoint = readSshString(pubBlob, pubOffset);
    pubOffset = qPoint.nextOffset;
    const appStr = readSshString(pubBlob, pubOffset);
    ecdsaCurveName = curveStr.value.toString("utf8");
    rawPublicKey = qPoint.value;
    application = appStr.value.toString("utf8");
  } else if (keyType === "ssh-ed25519") {
    const rawPub = readSshString(pubBlob, pubOffset);
    rawPublicKey = rawPub.value;
  } else {
    throw new Error("UNSUPPORTED_HASH_OR_KEY_TYPE");
  }

  // Parse signature blob
  const sigBlob = sigField.value;
  let sigOffset = 0;
  const sigKeyTypeField = readSshString(sigBlob, sigOffset);
  sigOffset = sigKeyTypeField.nextOffset;
  const signatureKeyType = sigKeyTypeField.value.toString("utf8");
  const rawSigField = readSshString(sigBlob, sigOffset);
  sigOffset = rawSigField.nextOffset;

  let flags = 0x00;
  let counter = 0;
  const isConsistentSkKey =
    signatureKeyType === keyType &&
    (keyType === "sk-ssh-ed25519@openssh.com" ||
      keyType === "sk-ecdsa-sha2-nistp256@openssh.com");
  if (isConsistentSkKey) {
    if (sigOffset + 5 > sigBlob.byteLength) {
      throw new Error("Truncated PROTOCOL.u2f sk-* flags/counter trailer");
    }
    flags = sigBlob.readUInt8(sigOffset);
    counter = sigBlob.readUInt32BE(sigOffset + 1);
  } else {
    // Software ssh-ed25519 or mismatched signatureKeyType !== keyType never carry valid hardware CTAP2 flags/counter
    flags = 0x00;
    counter = 0;
  }

  const hashAlgorithm = hashAlgField.value.toString("utf8") as "sha512" | "sha256";
  if (hashAlgorithm !== "sha512" && hashAlgorithm !== "sha256") {
    throw new Error("UNSUPPORTED_HASH_OR_KEY_TYPE");
  }

  return {
    magicPreamble,
    version,
    keyType,
    publicKeyBlob: pubBlob,
    rawPublicKey,
    ecdsaCurveName,
    application,
    namespace: namespaceField.value.toString("utf8"),
    reserved: reservedField.value.toString("utf8"),
    hashAlgorithm,
    signatureKeyType,
    rawSignature: rawSigField.value,
    flags,
    userPresence: (flags & SSH_SK_USER_PRESENCE_REQD) !== 0,
    userVerification: (flags & SSH_SK_USER_VERIFICATION_REQD) !== 0,
    counter,
  };
}

function reconstructNodePublicKey(parsed: ParsedOpenSshSigEnvelope): KeyObject {
  if (
    parsed.keyType === "sk-ssh-ed25519@openssh.com" ||
    parsed.keyType === "ssh-ed25519"
  ) {
    // ASN.1 DER SubjectPublicKeyInfo prefix for Ed25519 (OID 1.3.101.112)
    const ed25519SpkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
    return createPublicKey({
      key: Buffer.concat([ed25519SpkiPrefix, parsed.rawPublicKey]),
      format: "der",
      type: "spki",
    });
  }
  if (
    parsed.keyType === "sk-ecdsa-sha2-nistp256@openssh.com" &&
    parsed.rawPublicKey.byteLength === 65 &&
    parsed.rawPublicKey[0] === 0x04
  ) {
    const x = parsed.rawPublicKey.subarray(1, 33).toString("base64url");
    const y = parsed.rawPublicKey.subarray(33, 65).toString("base64url");
    return createPublicKey({
      key: { kty: "EC", crv: "P-256", x, y },
      format: "jwk",
    });
  }
  throw new Error("UNSUPPORTED_HASH_OR_KEY_TYPE");
}

/**
 * Cryptographically verifies an OpenSSH `SSHSIG` (`sk-ssh-ed25519@openssh.com`,
 * `sk-ecdsa-sha2-nistp256@openssh.com`, or `ssh-ed25519`) envelope AND enforces the
 * Red Team hardware invariants (`UP=0x01`, `UV=0x04`, monotonic `counter > lastSeenCounter`,
 * namespace binding, and anti-replay nonce consumption) that `ssh-keygen -Y verify` omits.
 */
export function verifyOpenSshSkSignatureEnvelope(params: {
  armoredSignature: string;
  message: string | Uint8Array;
  expectedNamespace?: string;
  requireUserPresence?: boolean;
  requireUserVerification?: boolean;
  lastSeenCounter?: number;
  consumedNonces?: Set<string>;
  nonce?: string;
}): VerifyOpenSshSkResult {
  let parsed: ParsedOpenSshSigEnvelope;
  try {
    parsed = parseOpenSshSignatureEnvelope(params.armoredSignature);
  } catch (err: any) {
    const msg = String(err?.message ?? "");
    const reason =
      msg === "INVALID_SSHSIG_PREAMBLE_OR_VERSION"
        ? "INVALID_SSHSIG_PREAMBLE_OR_VERSION"
        : msg === "UNSUPPORTED_HASH_OR_KEY_TYPE"
        ? "UNSUPPORTED_HASH_OR_KEY_TYPE"
        : "MALFORMED_SSHSIG_ARMOR";
    return {
      verified: false,
      flags: 0,
      userPresence: false,
      userVerification: false,
      counter: 0,
      failureReason: reason,
    };
  }

  const isHardwareSkKey =
    parsed.keyType === "sk-ssh-ed25519@openssh.com" ||
    parsed.keyType === "sk-ecdsa-sha2-nistp256@openssh.com";
  if (parsed.signatureKeyType !== parsed.keyType || !isHardwareSkKey) {
    return {
      verified: false,
      keyType: parsed.keyType,
      application: parsed.application,
      namespace: parsed.namespace,
      flags: 0,
      userPresence: false,
      userVerification: false,
      counter: 0,
      failureReason: "KEY_TYPE_MISMATCH_OR_NON_SK_KEY",
    };
  }

  const expectedNs = params.expectedNamespace ?? DEFAULT_HOTROLL_NAMESPACE;
  if (!parsed.namespace || parsed.namespace !== expectedNs) {
    return {
      verified: false,
      keyType: parsed.keyType,
      application: parsed.application,
      namespace: parsed.namespace,
      flags: parsed.flags,
      userPresence: parsed.userPresence,
      userVerification: parsed.userVerification,
      counter: parsed.counter,
      failureReason: "EMPTY_OR_MISMATCHED_NAMESPACE",
    };
  }

  if (params.nonce && params.consumedNonces?.has(params.nonce)) {
    return {
      verified: false,
      keyType: parsed.keyType,
      application: parsed.application,
      namespace: parsed.namespace,
      flags: parsed.flags,
      userPresence: parsed.userPresence,
      userVerification: parsed.userVerification,
      counter: parsed.counter,
      failureReason: "NONCE_REPLAY_DETECTED",
    };
  }

  const requireUp = params.requireUserPresence ?? true;
  const requireUv = params.requireUserVerification ?? true;

  if (requireUp && !parsed.userPresence) {
    return {
      verified: false,
      keyType: parsed.keyType,
      application: parsed.application,
      namespace: parsed.namespace,
      flags: parsed.flags,
      userPresence: parsed.userPresence,
      userVerification: parsed.userVerification,
      counter: parsed.counter,
      failureReason: "USER_PRESENCE_FLAG_MISSING",
    };
  }

  if (requireUv && !parsed.userVerification) {
    return {
      verified: false,
      keyType: parsed.keyType,
      application: parsed.application,
      namespace: parsed.namespace,
      flags: parsed.flags,
      userPresence: parsed.userPresence,
      userVerification: parsed.userVerification,
      counter: parsed.counter,
      failureReason: "USER_VERIFICATION_FLAG_MISSING",
    };
  }

  if (
    params.lastSeenCounter !== undefined &&
    parsed.counter <= params.lastSeenCounter
  ) {
    return {
      verified: false,
      keyType: parsed.keyType,
      application: parsed.application,
      namespace: parsed.namespace,
      flags: parsed.flags,
      userPresence: parsed.userPresence,
      userVerification: parsed.userVerification,
      counter: parsed.counter,
      failureReason: "SIGNATURE_COUNTER_REGRESSION_OR_CLONE",
    };
  }

  // Reconstruct PROTOCOL.sshsig Section 3 Signed Data
  const msgBuf =
    typeof params.message === "string"
      ? Buffer.from(params.message, "utf8")
      : Buffer.from(params.message);
  const msgHash = createHash(parsed.hashAlgorithm).update(msgBuf).digest();
  const sshsigSignedData = Buffer.concat([
    Buffer.from(SSHSIG_MAGIC_PREAMBLE, "ascii"),
    writeSshString(parsed.namespace),
    writeSshString(parsed.reserved),
    writeSshString(parsed.hashAlgorithm),
    writeSshString(msgHash),
  ]);

  let cryptoOk = false;
  try {
    const pubKeyObj = reconstructNodePublicKey(parsed);
    if (
      parsed.keyType === "sk-ssh-ed25519@openssh.com" ||
      parsed.keyType === "sk-ecdsa-sha2-nistp256@openssh.com"
    ) {
      const appHash = createHash("sha256")
        .update(parsed.application, "utf8")
        .digest();
      const dataHash = createHash("sha256").update(sshsigSignedData).digest();
      const fidoFooter = Buffer.alloc(5);
      fidoFooter.writeUInt8(parsed.flags & 0xff, 0);
      fidoFooter.writeUInt32BE(parsed.counter >>> 0, 1);
      const u2fAssertionBlob = Buffer.concat([appHash, fidoFooter, dataHash]);

      if (parsed.keyType === "sk-ssh-ed25519@openssh.com") {
        cryptoOk = cryptoVerify(
          null,
          u2fAssertionBlob,
          pubKeyObj,
          parsed.rawSignature
        );
      } else {
        const rField = readSshString(parsed.rawSignature, 0);
        const sField = readSshString(parsed.rawSignature, rField.nextOffset);
        const ieeeSig = Buffer.concat([
          mpintToFixed32(rField.value),
          mpintToFixed32(sField.value),
        ]);
        cryptoOk = cryptoVerify(
          "sha256",
          u2fAssertionBlob,
          { key: pubKeyObj, dsaEncoding: "ieee-p1363" },
          ieeeSig
        );
      }
    } else {
      cryptoOk = cryptoVerify(
        null,
        sshsigSignedData,
        pubKeyObj,
        parsed.rawSignature
      );
    }
  } catch {
    cryptoOk = false;
  }

  if (!cryptoOk) {
    return {
      verified: false,
      keyType: parsed.keyType,
      application: parsed.application,
      namespace: parsed.namespace,
      flags: parsed.flags,
      userPresence: parsed.userPresence,
      userVerification: parsed.userVerification,
      counter: parsed.counter,
      failureReason: "CRYPTOGRAPHIC_SIGNATURE_INVALID",
    };
  }

  if (params.nonce && params.consumedNonces) {
    params.consumedNonces.add(params.nonce);
  }

  return {
    verified: true,
    keyType: parsed.keyType,
    application: parsed.application,
    namespace: parsed.namespace,
    flags: parsed.flags,
    userPresence: parsed.userPresence,
    userVerification: parsed.userVerification,
    counter: parsed.counter,
  };
}

/**
 * Evaluates a ThinkPad / Linux `fprintd` D-Bus `VerifyStatus(result, done)` signal and enforces
 * the Red Team anti-spoofing blindaje: a D-Bus `"verify-match"` boolean signal ALONE is never
 * sufficient to authorize a schema promotion or cutover unless paired with a valid cryptographic
 * TPM 2.0 (`/dev/tpmrm0` / `libtpm2_pkcs11.so`) or `SSHSIG` hardware signature envelope.
 */
export function evaluateFprintdTpm2StepUp(params: {
  dbusResult: FprintdVerifyStatusResult;
  done: boolean;
  attestation?: HardwareAuthAttestation;
  expectedMessage?: string;
  lastSeenCounter?: number;
}): {
  status: "MATCH_AND_SIGNED" | "RETRY_SCAN" | "FAILED" | "SPOOF_BLOCKED";
  shouldCallVerifyStop: boolean;
  detail: string;
} {
  if (
    params.dbusResult === "verify-retry-scan" ||
    params.dbusResult === "verify-swipe-too-short" ||
    params.dbusResult === "verify-finger-not-centered" ||
    params.dbusResult === "verify-remove-and-retry" ||
    params.dbusResult === "verify-too-fast"
  ) {
    return {
      status: "RETRY_SCAN",
      shouldCallVerifyStop: false,
      detail: `fprintd transient scan status: ${params.dbusResult} (keep sensor claimed)`,
    };
  }

  if (params.dbusResult !== "verify-match") {
    return {
      status: "FAILED",
      shouldCallVerifyStop: true,
      detail: `fprintd verification failed: ${params.dbusResult} (call Device.VerifyStop + Release)`,
    };
  }

  // Red Team Blindaje: Reject boolean D-Bus "verify-match" if no cryptographic TPM 2.0 / SSHSIG envelope is attached
  if (!params.attestation || !params.expectedMessage) {
    return {
      status: "SPOOF_BLOCKED",
      shouldCallVerifyStop: true,
      detail:
        "FPRINTD_BOOLEAN_SPOOF_BLOCKED: D-Bus net.reactivated.Fprint VerifyStatus('verify-match') rejected without TPM 2.0 / SSHSIG cryptographic signature",
    };
  }

  const verifyRes = verifyOpenSshSkSignatureEnvelope({
    armoredSignature: params.attestation.armoredSignature,
    message: params.expectedMessage,
    expectedNamespace: params.attestation.namespace,
    requireUserPresence: true,
    requireUserVerification: true,
    lastSeenCounter: params.lastSeenCounter,
  });

  if (!verifyRes.verified) {
    return {
      status: "SPOOF_BLOCKED",
      shouldCallVerifyStop: true,
      detail: `FPRINTD_BOOLEAN_SPOOF_BLOCKED: Cryptographic co-signature failed (${verifyRes.failureReason})`,
    };
  }

  return {
    status: "MATCH_AND_SIGNED",
    shouldCallVerifyStop: true,
    detail: `ThinkPad fprintd verify-match + ${params.attestation.keyType} (flags=0x0${verifyRes.flags.toString(
      16
    )}, ctr=${verifyRes.counter}) verified`,
  };
}

/**
 * Executes real `/usr/bin/ssh-keygen -Y verify` (OpenSSH 10.0p2 on the box) against an
 * `HardwareAuthAttestation` envelope (`sk-ssh-ed25519@openssh.com` or `sk-ecdsa-sha2-nistp256@openssh.com`)
 * to prove wire-level interoperability with standard OpenSSH `allowed_signers`.
 */
export function verifyWithSystemOpenSshKeygen(params: {
  attestation: HardwareAuthAttestation;
  message: string | Uint8Array;
}): {
  exitCode: number;
  verifiedByOpenSsh: boolean;
  stdout: string;
  stderr: string;
  elapsedMs: number;
} {
  const dir = mkdtempSync(join(tmpdir(), "hotroll-sshsig-"));
  try {
    const allowedSignersPath = join(dir, "allowed_signers");
    const sigPath = join(dir, "payload.sig");
    const allowedLine = `${params.attestation.principal} namespaces="${params.attestation.namespace}" ${params.attestation.keyType} ${params.attestation.publicKeyBlobBase64}\n`;
    writeFileSync(allowedSignersPath, allowedLine, "utf8");
    writeFileSync(sigPath, params.attestation.armoredSignature, "utf8");

    const t0 = performance.now();
    const res = spawnSync(
      "ssh-keygen",
      [
        "-Y",
        "verify",
        "-f",
        allowedSignersPath,
        "-I",
        params.attestation.principal,
        "-n",
        params.attestation.namespace,
        "-s",
        sigPath,
      ],
      {
        input:
          typeof params.message === "string"
            ? Buffer.from(params.message, "utf8")
            : Buffer.from(params.message),
        encoding: "utf8",
      }
    );
    const elapsedMs = Number((performance.now() - t0).toFixed(3));
    const stdout = (res.stdout ?? "").trim();
    const stderr = (res.stderr ?? "").trim();
    return {
      exitCode: res.status ?? -1,
      verifiedByOpenSsh: res.status === 0 && stdout.includes("Good"),
      stdout,
      stderr,
      elapsedMs,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Benchmarks native `ssh-keygen -Y sign` + `ssh-keygen -Y verify` vs. `verifyOpenSshSkSignatureEnvelope`
 * on the local box.
 */
export function runBoxSshSigRoundtripBenchmark(params?: {
  message?: string;
  namespace?: string;
}): {
  sshKeygenSignMs: number;
  sshKeygenVerifyMs: number;
  nativeSkVerifyMs: number;
  armoredSignature: string;
  openSshStdout: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "hotroll-keygen-sign-"));
  try {
    const namespace = params?.namespace ?? DEFAULT_HOTROLL_NAMESPACE;
    const message =
      params?.message ??
      buildMigrationSignPayload({
        migrationId: "20261025_split_full_name",
        action: "promote",
        tableName: "orders",
        fromEpoch: 1,
        toEpoch: 2,
        cohortPct: 75.0,
        timestampMs: 1792983600000,
        nonce: "9f86d081884c7d659a2feaa0c55ad015",
        namespace,
      });

    const keyPath = join(dir, "id_ed25519");
    const msgPath = join(dir, "payload.txt");
    const allowedSignersPath = join(dir, "allowed_signers");
    spawnSync("ssh-keygen", [
      "-t",
      "ed25519",
      "-N",
      "",
      "-f",
      keyPath,
      "-C",
      "augusto@fleet.internal",
    ]);
    writeFileSync(msgPath, message, "utf8");
    const pubKeyLine = readFileSync(`${keyPath}.pub`, "utf8").trim();
    writeFileSync(
      allowedSignersPath,
      `augusto@fleet.internal namespaces="${namespace}" ${pubKeyLine}\n`,
      "utf8"
    );

    const tSign0 = performance.now();
    spawnSync("ssh-keygen", [
      "-Y",
      "sign",
      "-f",
      keyPath,
      "-n",
      namespace,
      msgPath,
    ]);
    const sshKeygenSignMs = Number((performance.now() - tSign0).toFixed(3));
    const armoredSignature = readFileSync(`${msgPath}.sig`, "utf8");

    const tVer0 = performance.now();
    const verRes = spawnSync(
      "ssh-keygen",
      [
        "-Y",
        "verify",
        "-f",
        allowedSignersPath,
        "-I",
        "augusto@fleet.internal",
        "-n",
        namespace,
        "-s",
        `${msgPath}.sig`,
      ],
      { input: message, encoding: "utf8" }
    );
    const sshKeygenVerifyMs = Number((performance.now() - tVer0).toFixed(3));

    const skPair = generateOpenSshSkKeyPair("sk-ssh-ed25519@openssh.com");
    const skAtt = createOpenSshSkSignatureEnvelope({
      message,
      privateKeyPem: skPair.privateKeyPem,
      rawPublicKey: skPair.rawPublicKey,
      keyType: "sk-ssh-ed25519@openssh.com",
      namespace,
      flags: 0x05,
      counter: 42,
    });
    const tNative0 = performance.now();
    const nativeRes = verifyOpenSshSkSignatureEnvelope({
      armoredSignature: skAtt.armoredSignature,
      message,
      expectedNamespace: namespace,
      requireUserPresence: true,
      requireUserVerification: true,
      lastSeenCounter: 41,
    });
    const nativeSkVerifyMs = Number((performance.now() - tNative0).toFixed(3));
    if (!nativeRes.verified) {
      throw new Error("Native sk-ssh-ed25519@openssh.com verification failed");
    }

    return {
      sshKeygenSignMs,
      sshKeygenVerifyMs,
      nativeSkVerifyMs,
      armoredSignature,
      openSshStdout: (verRes.stdout ?? "").trim(),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
