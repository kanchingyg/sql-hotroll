/**
 * @module crypto-handshake
 * @description Re-exports the Enterprise & FOSS Web-Infrastructure Cryptographic Provenance suite (`./attestation.ts`):
 *  - RFC 8785 (JCS) Canonical SQL AST & Bidirectional Lens Structural Digest
 *  - `in-toto` v1.0 / SLSA v1.0 Provenance inside a DSSE (Dead Simple Signing Envelope, PAE encoding)
 *  - Keyless CI OIDC / SPIFFE SVID Workload Attestation + M-of-N Enterprise Fleet Hardware Authenticators
 *    (YubiKey FIDO2/CTAP2 `sk-ssh-ed25519@openssh.com`, ThinkPad `fprintd` + TPM 2.0 `/dev/tpmrm0`,
 *     Windows Hello TPM 2.0 NGC, macOS Touch ID Secure Enclave, PIV/PKCS#11 Smartcards & `SSH_AUTH_SOCK`)
 *  - Asymmetric `PASETO v4.public` (Ed25519 + JWKS `kid`) Edge Epoch Tokens with zero shared secrets at the edge.
 */

export * from "./attestation.ts";
