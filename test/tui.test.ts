import { describe, expect, test } from "bun:test";
import {
  ANSI,
  DifferentialTuiRenderer,
  applyTuiKeypress,
  createDefaultTuiState,
  createInitialTuiState,
  fitWidth,
  handleKeypress,
  parseHotRollKeystroke,
  renderBrailleSparkline,
  renderCiGateProvenancePanel,
  renderClackTree,
  renderFractionalBar,
  renderHardwareAuthenticatorModal,
  renderHotRollDashboard,
  renderHotRollTuiFrame,
  resolveSynchronizedOutput,
  resolveTheme,
  stripAnsi,
  visibleWidth,
  buildMigrationSignPayload,
  createOpenSshSkSignatureEnvelope,
  detectFleetAuthenticators,
  evaluateFprintdTpm2StepUp,
  generateOpenSshSkKeyPair,
  parseOpenSshSignatureEnvelope,
  runBoxSshSigRoundtripBenchmark,
  verifyOpenSshSkSignatureEnvelope,
  verifyWithSystemOpenSshKeygen,
} from "../src/tui";

describe("SQ-HotRoll ASCII/Unicode TUI Engine (@oh-my-pi/pi-tui + Codex + Clack spec)", () => {
  test("visibleWidth strips ANSI SGR & OSC-8 sequences and handles Unicode box/Braille glyphs", () => {
    const styled = "\x1b[38;2;56;189;248m╭── SQ-HotRoll ──╮\x1b[0m\x1b]8;;https://example.com\x07\x1b]8;;\x07";
    expect(visibleWidth(styled)).toBe(18);
    expect(visibleWidth("⠋⠙⠹⠸████")).toBe(8);
  });

  test("renderFractionalBar achieves 1/8th sub-cell precision and supports ASCII fallback", () => {
    const bar50 = renderFractionalBar(0.5, 10, false);
    expect(visibleWidth(bar50)).toBe(10);
    expect(bar50).toBe("█████░░░░░");

    const bar5625 = renderFractionalBar(0.5625, 10, false); // 5.625 cells = 5 full + 5/8 ('▋') + 4 empty
    expect(visibleWidth(bar5625)).toBe(10);
    expect(bar5625).toBe("█████▋░░░░");

    const asciiBar = renderFractionalBar(0.5, 10, true);
    expect(asciiBar).toBe("#####-----");
  });

  test("renderBrailleSparkline encodes pairs of samples into U+2800..U+28FF 2x4 dot matrices", () => {
    const spark = renderBrailleSparkline([0, 25, 50, 75, 100, 100], 100);
    expect(visibleWidth(spark)).toBe(3);
    for (const ch of spark) {
      const cp = ch.codePointAt(0)!;
      expect(cp).toBeGreaterThanOrEqual(0x2800);
      expect(cp).toBeLessThanOrEqual(0x28ff);
    }
  });

  test("DifferentialTuiRenderer wraps frames in DEC 2026 synchronized output and diffs mutated rows", () => {
    const renderer = new DifferentialTuiRenderer({ PI_FORCE_SYNC_OUTPUT: "1" });
    const frame1 = ["Row 0: Header", "Row 1: Progress 10%", "Row 2: Footer"];
    const r1 = renderer.buildFramePayload(frame1, 80);
    expect(r1.strategy).toBe("first");
    expect(r1.changedLineCount).toBe(3);
    expect(r1.payload.startsWith(`${ANSI.HIDE_CURSOR}${ANSI.SYNC_BEGIN}${ANSI.AUTOWRAP_OFF}`)).toBe(true);
    expect(r1.payload.endsWith(`${ANSI.AUTOWRAP_ON}${ANSI.SYNC_END}`)).toBe(true);

    // Identical frame produces zero bytes written to stdout
    const rSame = renderer.buildFramePayload(frame1, 80);
    expect(rSame.changedLineCount).toBe(0);
    expect(rSame.payload).toBe("");

    // Mutate only Row 1 -> only 2 lines (from firstChanged=1 to end) are repainted
    const frame2 = ["Row 0: Header", "Row 1: Progress 25%", "Row 2: Footer"];
    const r2 = renderer.buildFramePayload(frame2, 80);
    expect(r2.strategy).toBe("diff");
    expect(r2.changedLineCount).toBe(2);
    expect(r2.payload.includes("\x1b[1A")).toBe(true);

    // Width change triggers full reflow
    const r3 = renderer.buildFramePayload(frame2, 100);
    expect(r3.strategy).toBe("reflow");
    expect(r3.changedLineCount).toBe(3);
  });

  test("NO_COLOR and PI_NO_SYNC_OUTPUT overrides are strictly honored", () => {
    const noColorTheme = resolveTheme({ NO_COLOR: "1" }, true);
    expect(noColorTheme.enabled).toBe(false);
    expect(noColorTheme.primary("hello")).toBe("hello");

    expect(resolveSynchronizedOutput({ PI_NO_SYNC_OUTPUT: "1" })).toBe(false);
    expect(resolveSynchronizedOutput({ PI_TUI_SYNC_OUTPUT: "0" })).toBe(false);
    expect(resolveSynchronizedOutput({ PI_FORCE_SYNC_OUTPUT: "1" })).toBe(true);
  });

  test("renderHotRollDashboard and renderClackTree maintain exact column alignment", () => {
    const theme = resolveTheme({ FORCE_COLOR: "1" }, true);
    const lines = renderHotRollDashboard(
      {
        migrationId: "20261025_split_full_name",
        tierLabel: "Tier 1 (Lazy Backfill + _lc)",
        sourceEpoch: 1,
        targetEpoch: 2,
        backfillCompletedRows: 75000,
        backfillTotalRows: 100000,
        walBytes: 255470,
        walCeilingBytes: 1048576,
        cohortV1Pct: 25,
        cohortV2Pct: 75,
        darkCanaryMismatches: 0,
        darkCanarySampled: 500,
        p99HistoryUs: [42, 45, 48, 51, 49, 47, 44, 46],
        tickIndex: 3,
      },
      76,
      theme
    );
    expect(lines.length).toBe(11);
    for (const line of lines) {
      expect(visibleWidth(line)).toBe(76);
    }

    const tree = renderClackTree(
      "hotroll apply 20261025_split_full_name",
      [
        { label: "AST Classification: Tier 1 (Bijective Lens + _lc)", status: "done" },
        { label: "Dark-Read Canary Verification (500/500 rows)", status: "active", detail: "0 mismatches" },
      ],
      "Press [P] to promote next 25% cohort",
      theme
    );
    expect(tree.length).toBe(7);
  });

  test("parseHotRollKeystroke maps raw-mode single keys deterministically", () => {
    expect(parseHotRollKeystroke("p")).toBe("promote");
    expect(parseHotRollKeystroke("R")).toBe("rollback");
    expect(parseHotRollKeystroke("d")).toBe("diff");
    expect(parseHotRollKeystroke("c")).toBe("cutover");
    expect(parseHotRollKeystroke("q")).toBe("quit");
    expect(parseHotRollKeystroke("\x03")).toBe("interrupt");
  });

  test("Zero-Trust SLSA v1.0 DSSE M-of-N Ed25519 Quorum, JWKS kid, and Fleet Hardware Authenticator (ThinkPad fprintd+TPM2 / YubiKey FIDO2) TUI bar", () => {
    const stateOk = createDefaultTuiState();
    const frameOk = stripAnsi(renderHotRollTuiFrame(stateOk, { color: false, width: 112 }));
    expect(frameOk).toContain(
      "SLSA v1.0 DSSE: 2/2 Ed25519 [OIDC+KMS] · AST-JCS: verified · JWKS kid: ed25519-2026-10 · Rekor #14892041"
    );
    expect(frameOk).toContain(
      "HW-Auth: tpm2-fprintd-thinkpad · CTAP2 UP=1 UV=1 (0x05) · signCount=42"
    );

    // When < M signatures are present (1/2), TUI displays BLOCKED warning and [P] Promote refuses to advance
    const stateUnderQuorum = createDefaultTuiState({
      rolloutPct: 25.0,
      attestation: {
        validSignatures: 1,
        requiredQuorum: 2,
        rolesLabel: "OIDC-ONLY",
        astJcsVerified: true,
        jwksKid: "ed25519-2026-10",
        hardwareModality: "tpm2-fprintd-thinkpad",
        ctapFlags: 0x01,
        signCount: 42,
        awaitingHardwarePrompt: true,
      },
    });
    const frameBlocked = stripAnsi(
      renderHotRollTuiFrame(stateUnderQuorum, { color: false, width: 112 })
    );
    expect(frameBlocked).toContain(
      "SLSA v1.0 DSSE: BLOCKED (1/2 Ed25519 < quorum [OIDC-ONLY]) · AST-JCS: verified · JWKS kid: ed25519-2026-10"
    );
    expect(frameBlocked).toContain(
      "HW-Auth: [TOUCH YUBIKEY / SWIPE THINKPAD FPRINTD+TPM2 / PIV 9c] awaiting UP=1 UV=1..."
    );

    const blockedPromote = handleKeypress(stateUnderQuorum, "p");
    expect(blockedPromote.rolloutPct).toBe(25.0);
    expect(blockedPromote.phase).toBe("PAUSED");
    expect(blockedPromote.lastActionLog).toContain("QUORUM_BLOCKED");

    // Pressing [F] (Swipe ThinkPad fprintd+TPM2) or [K] (Touch YubiKey FIDO2) completes 2/2 hardware-bound quorum
    expect(parseHotRollKeystroke("f")).toBe("hw_auth");
    expect(parseHotRollKeystroke("k")).toBe("hw_auth");
    const afterFingerprint = handleKeypress(blockedPromote, "f");
    expect(afterFingerprint.attestation.validSignatures).toBe(2);
    expect(afterFingerprint.attestation.ctapFlags).toBe(0x05);
    expect(afterFingerprint.attestation.signCount).toBe(43);
    expect(afterFingerprint.lastActionLog).toContain("HW_AUTH_OK");

    // Now [P] Promote succeeds!
    const promoted = handleKeypress(afterFingerprint, "p");
    expect(promoted.phase).toBe("PROGRESSIVE_ROLLOUT");
    expect(promoted.rolloutPct).toBeGreaterThan(25.0);
  });

  test("hotkey [M] and renderHardwareAuthenticatorModal / renderCiGateProvenancePanel cover all 5 enterprise hardware authenticators", () => {
    expect(parseHotRollKeystroke("M")).toBe("hw_auth");
    expect(parseHotRollKeystroke("m")).toBe("hw_auth");
    const theme = resolveTheme({ FORCE_COLOR: "1" }, true);
    const modal = renderHardwareAuthenticatorModal(
      {
        migrationId: "20261025_split_full_name",
        jcsDigestShort: "jcs-sha384:9b74c989",
        selectedAuthenticator: "linux-fprintd-tpm2",
        userPresenceVerified: true,
        signCount: 42,
      },
      76,
      theme
    );
    expect(modal.length).toBe(11);
    for (const line of modal) {
      expect(visibleWidth(line)).toBe(76);
    }
    const joined = modal.join("\n");
    expect(joined).toContain("sk-ssh-ed25519@openssh.com");
    expect(joined).toContain("fprintd + TPM 2.0 /dev/tpmrm0");
    expect(joined).toContain("Windows Hello Business");
    expect(joined).toContain("Secure Enclave");
    expect(joined).toContain("PKCS#11 (OpenSC/ykcs11) + SSH_AUTH_SOCK");

    const panel = renderCiGateProvenancePanel(
      {
        migrationId: "20261025_split_full_name",
        jcsAstDigestShort: "jcs-sha384:9b74c9897bac770",
        dsseSlsaVerified: true,
        oidcOrSpiffeBuilder: "spiffe://prod.hotroll.internal/ns/ci/sa/runner",
        quorumValidSigners: 2,
        quorumRequiredSigners: 2,
        distinctRolesVerified: true,
        rekorLogIndex: 148920311,
        pasetoKid: "ed25519-origin-2026-10",
        edgeSharedSecretsCount: 0,
        z3BijectionVerified: true,
        ciMergeReady: true,
      },
      76,
      theme
    );
    expect(panel.length).toBe(11);
    for (const line of panel) {
      expect(visibleWidth(line)).toBe(76);
    }
  });

  test("OpenSSH PROTOCOL.sshsig + PROTOCOL.u2f binary verifier (sk-ssh-ed25519@openssh.com & sk-ecdsa-sha2-nistp256@openssh.com) and live OpenSSH 10.0p2 ssh-keygen -Y verify interoperability", () => {
    const payload = buildMigrationSignPayload({
      migrationId: "20261025_split_full_name",
      action: "promote",
      tableName: "orders",
      fromEpoch: 1,
      toEpoch: 2,
      cohortPct: 75.0,
      timestampMs: 1792983600000,
      nonce: "nonce-fido2-001",
    });

    // 1. sk-ssh-ed25519@openssh.com (YubiKey 5 / Bio / SoloKey v2) with UP=1 (0x01) + UV=1 (0x04) = 0x05
    const edSk = generateOpenSshSkKeyPair("sk-ssh-ed25519@openssh.com");
    const attEd = createOpenSshSkSignatureEnvelope({
      message: payload,
      privateKeyPem: edSk.privateKeyPem,
      rawPublicKey: edSk.rawPublicKey,
      keyType: "sk-ssh-ed25519@openssh.com",
      flags: 0x05,
      counter: 42,
      method: "fido2-sk",
    });

    const parsedEd = parseOpenSshSignatureEnvelope(attEd.armoredSignature);
    expect(parsedEd.magicPreamble).toBe("SSHSIG");
    expect(parsedEd.version).toBe(1);
    expect(parsedEd.keyType).toBe("sk-ssh-ed25519@openssh.com");
    expect(parsedEd.namespace).toBe("sql-hotroll@v1");
    expect(parsedEd.flags).toBe(0x05);
    expect(parsedEd.userPresence).toBe(true);
    expect(parsedEd.userVerification).toBe(true);
    expect(parsedEd.counter).toBe(42);

    const consumedNonces = new Set<string>();
    const verEd = verifyOpenSshSkSignatureEnvelope({
      armoredSignature: attEd.armoredSignature,
      message: payload,
      requireUserPresence: true,
      requireUserVerification: true,
      lastSeenCounter: 41,
      consumedNonces,
      nonce: "nonce-fido2-001",
    });
    expect(verEd.verified).toBe(true);

    // Replay of same nonce must be blocked
    const replayRes = verifyOpenSshSkSignatureEnvelope({
      armoredSignature: attEd.armoredSignature,
      message: payload,
      requireUserPresence: true,
      requireUserVerification: true,
      lastSeenCounter: 41,
      consumedNonces,
      nonce: "nonce-fido2-001",
    });
    expect(replayRes.verified).toBe(false);
    expect(replayRes.failureReason).toBe("NONCE_REPLAY_DETECTED");

    // Cloned / regressed counter (counter <= lastSeenCounter) must be blocked
    const cloneRes = verifyOpenSshSkSignatureEnvelope({
      armoredSignature: attEd.armoredSignature,
      message: payload,
      requireUserPresence: true,
      requireUserVerification: true,
      lastSeenCounter: 42,
    });
    expect(cloneRes.verified).toBe(false);
    expect(cloneRes.failureReason).toBe("SIGNATURE_COUNTER_REGRESSION_OR_CLONE");

    // Downgraded flags=0x01 (UP=1, UV=0) must be blocked when requireUserVerification=true
    const attNoUv = createOpenSshSkSignatureEnvelope({
      message: payload,
      privateKeyPem: edSk.privateKeyPem,
      rawPublicKey: edSk.rawPublicKey,
      keyType: "sk-ssh-ed25519@openssh.com",
      flags: 0x01,
      counter: 43,
    });
    const noUvRes = verifyOpenSshSkSignatureEnvelope({
      armoredSignature: attNoUv.armoredSignature,
      message: payload,
      requireUserPresence: true,
      requireUserVerification: true,
      lastSeenCounter: 42,
    });
    expect(noUvRes.verified).toBe(false);
    expect(noUvRes.failureReason).toBe("USER_VERIFICATION_FLAG_MISSING");

    // Verify wire compatibility with real /usr/bin/ssh-keygen -Y verify (OpenSSH 10.0p2)
    const sysEd = verifyWithSystemOpenSshKeygen({
      attestation: attEd,
      message: payload,
    });
    expect(sysEd.exitCode).toBe(0);
    expect(sysEd.verifiedByOpenSsh).toBe(true);
    expect(sysEd.stdout).toContain("ED25519-SK");

    // 2. sk-ecdsa-sha2-nistp256@openssh.com (Windows Hello TPM 2.0 / macOS Secure Enclave / YubiKey FIPS)
    const ecSk = generateOpenSshSkKeyPair("sk-ecdsa-sha2-nistp256@openssh.com");
    const attEc = createOpenSshSkSignatureEnvelope({
      message: payload,
      privateKeyPem: ecSk.privateKeyPem,
      rawPublicKey: ecSk.rawPublicKey,
      keyType: "sk-ecdsa-sha2-nistp256@openssh.com",
      flags: 0x05,
      counter: 100,
      method: "windows-hello",
    });
    const verEc = verifyOpenSshSkSignatureEnvelope({
      armoredSignature: attEc.armoredSignature,
      message: payload,
      requireUserPresence: true,
      requireUserVerification: true,
      lastSeenCounter: 99,
    });
    expect(verEc.verified).toBe(true);

    const sysEc = verifyWithSystemOpenSshKeygen({
      attestation: attEc,
      message: payload,
    });
    expect(sysEc.exitCode).toBe(0);
    expect(sysEc.verifiedByOpenSsh).toBe(true);
    expect(sysEc.stdout).toContain("ECDSA-SK");

    // 3. Full box roundtrip benchmark (ssh-keygen -Y sign + ssh-keygen -Y verify + native verifier)
    const bench = runBoxSshSigRoundtripBenchmark({ message: payload });
    expect(bench.sshKeygenSignMs).toBeGreaterThan(0);
    expect(bench.sshKeygenVerifyMs).toBeGreaterThan(0);
    expect(bench.openSshStdout).toContain("Good");
  });

  test("detectFleetAuthenticators, ThinkPad fprintd D-Bus anti-spoofing blindaje, and renderHotRollDashboard step-up banner", () => {
    const fleet = detectFleetAuthenticators({
      env: {
        SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
        HOTROLL_ASSUME_THINKPAD_FPRINTD: "1",
        HOTROLL_ASSUME_TPM2: "1",
      },
      platform: "linux",
    });
    expect(fleet.length).toBe(6);
    expect(fleet.find((f) => f.method === "fido2-sk")?.available).toBe(true);
    expect(fleet.find((f) => f.method === "thinkpad-fprintd")?.available).toBe(true);
    expect(fleet.find((f) => f.method === "tpm2-pkcs11")?.available).toBe(true);

    // ThinkPad fprintd transient retry scan keeps sensor claimed
    const retryStep = evaluateFprintdTpm2StepUp({
      dbusResult: "verify-retry-scan",
      done: false,
    });
    expect(retryStep.status).toBe("RETRY_SCAN");
    expect(retryStep.shouldCallVerifyStop).toBe(false);

    // Red Team Blindaje: raw D-Bus "verify-match" boolean WITHOUT cryptographic TPM2/SSHSIG envelope is rejected
    const spoofAttempt = evaluateFprintdTpm2StepUp({
      dbusResult: "verify-match",
      done: true,
    });
    expect(spoofAttempt.status).toBe("SPOOF_BLOCKED");
    expect(spoofAttempt.detail).toContain("FPRINTD_BOOLEAN_SPOOF_BLOCKED");

    // Valid fprintd "verify-match" + TPM2/SSHSIG hardware signature succeeds
    const msg = "sql-hotroll@v1|cutover|orders|1->2|100";
    const tpKey = generateOpenSshSkKeyPair("sk-ecdsa-sha2-nistp256@openssh.com");
    const tpAtt = createOpenSshSkSignatureEnvelope({
      message: msg,
      privateKeyPem: tpKey.privateKeyPem,
      rawPublicKey: tpKey.rawPublicKey,
      keyType: "sk-ecdsa-sha2-nistp256@openssh.com",
      flags: 0x05,
      counter: 12,
      method: "thinkpad-fprintd",
      fprintdResult: "verify-match",
      tpmDevicePath: "/dev/tpmrm0",
    });
    const validTp = evaluateFprintdTpm2StepUp({
      dbusResult: "verify-match",
      done: true,
      attestation: tpAtt,
      expectedMessage: msg,
      lastSeenCounter: 11,
    });
    expect(validTp.status).toBe("MATCH_AND_SIGNED");

    // Dashboard step-up banner alignment
    const dashWithStepUp = renderHotRollDashboard(
      {
        migrationId: "20261025_split_full_name",
        tierLabel: "Tier 1 (Lazy Backfill + _lc)",
        sourceEpoch: 1,
        targetEpoch: 2,
        backfillCompletedRows: 100000,
        backfillTotalRows: 100000,
        walBytes: 128000,
        walCeilingBytes: 1048576,
        cohortV1Pct: 0,
        cohortV2Pct: 100,
        darkCanaryMismatches: 0,
        darkCanarySampled: 1000,
        p99HistoryUs: [40, 41, 42, 40],
        tickIndex: 8,
        hardwareAuthStatus: "YubiKey FIDO2 (UP+UV) | ThinkPad FP",
        awaitingStepUpChallenge: true,
      },
      76
    );
    expect(dashWithStepUp.length).toBe(14);
    for (const line of dashWithStepUp) {
      expect(visibleWidth(line)).toBe(76);
    }
  });

  test("Audit Regression: Rejects software ssh-ed25519 public key paired with forged sk-ssh-ed25519@openssh.com 0x05 trailer, caps TUI quorum at 2/2, and checks win32 paths", () => {
    const { createHash, createPrivateKey, generateKeyPairSync, sign: cryptoSign } = require("node:crypto");
    const writeSshStr = (d: Buffer | string) => {
      const b = typeof d === "string" ? Buffer.from(d, "utf8") : d;
      const l = Buffer.alloc(4);
      l.writeUInt32BE(b.byteLength, 0);
      return Buffer.concat([l, b]);
    };

    // Reproduce exact PoC: software ssh-ed25519 public key + signature blob claiming sk-ssh-ed25519@openssh.com with 0x05 trailer
    const kp = generateKeyPairSync("ed25519");
    const spki = kp.publicKey.export({ type: "spki", format: "der" }) as Buffer;
    const rawPub32 = Buffer.from(spki.subarray(spki.byteLength - 32));
    const pubKeyBlob = Buffer.concat([
      writeSshStr("ssh-ed25519"),
      writeSshStr(rawPub32),
    ]);

    const message = "sql-hotroll@v1|action=promote|migration=m1";
    const namespace = "sql-hotroll@v1";
    const msgHash = createHash("sha512").update(Buffer.from(message, "utf8")).digest();
    const sshsigSignedData = Buffer.concat([
      Buffer.from("SSHSIG", "ascii"),
      writeSshStr(namespace),
      writeSshStr(""),
      writeSshStr("sha512"),
      writeSshStr(msgHash),
    ]);
    const rawSig64 = cryptoSign(null, sshsigSignedData, kp.privateKey);
    const forgedTrailer = Buffer.from([0x05, 0x00, 0x00, 0x00, 0x2a]);
    const forgedSigBlob = Buffer.concat([
      writeSshStr("sk-ssh-ed25519@openssh.com"),
      writeSshStr(rawSig64),
      forgedTrailer,
    ]);
    const outerBlob = Buffer.concat([
      Buffer.from("SSHSIG", "ascii"),
      Buffer.from([0x00, 0x00, 0x00, 0x01]),
      writeSshStr(pubKeyBlob),
      writeSshStr(namespace),
      writeSshStr(""),
      writeSshStr("sha512"),
      writeSshStr(forgedSigBlob),
    ]);
    const forgedArmored = [
      "-----BEGIN SSH SIGNATURE-----",
      outerBlob.toString("base64"),
      "-----END SSH SIGNATURE-----",
    ].join("\n");

    const pocResult = verifyOpenSshSkSignatureEnvelope({
      armoredSignature: forgedArmored,
      message,
      expectedNamespace: namespace,
      requireUserPresence: true,
      requireUserVerification: true,
      lastSeenCounter: 10,
    });
    expect(pocResult.verified).toBe(false);
    expect(pocResult.userPresence).toBe(false);
    expect(pocResult.userVerification).toBe(false);
    expect(pocResult.failureReason).toBe("KEY_TYPE_MISMATCH_OR_NON_SK_KEY");

    // Verify createInitialTuiState & applyTuiKeypress aliases + pressing [M] keeps quorum at 2/2 (not 3/2)
    const init = createInitialTuiState();
    const afterM = applyTuiKeypress(init, "M");
    expect(afterM.attestation.validSignatures).toBe(2);
    expect(afterM.attestation.requiredQuorum).toBe(2);
    const renderedAfterM = stripAnsi(
      renderHotRollTuiFrame(afterM, { color: false, asciiOnly: true, width: 112 })
    );
    expect(renderedAfterM).toContain("2/2 Ed25519");
    expect(renderedAfterM).not.toContain("3/2");

    // Verify win32 detectFleetAuthenticators requires webauthn.dll / WinBioDatabase rather than unconditional true
    const winNoPaths = detectFleetAuthenticators({
      platform: "win32",
      env: {},
      probePaths: [],
    });
    expect(winNoPaths.find((f) => f.method === "windows-hello")?.available).toBe(false);
    const winWithWebauthn = detectFleetAuthenticators({
      platform: "win32",
      env: {},
      probePaths: [
        "C:\\Windows\\System32\\webauthn.dll",
        "C:\\Windows\\System32\\OpenSSH\\ssh-sk-helper.exe",
      ],
    });
    expect(winWithWebauthn.find((f) => f.method === "windows-hello")?.available).toBe(true);
    expect(winWithWebauthn.find((f) => f.method === "fido2-sk")?.available).toBe(true);
  });
});
