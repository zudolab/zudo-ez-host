import { describe, expect, it } from "vitest";

import {
  deriveS256CodeChallenge,
  isValidPkceCodeVerifier,
  verifyS256CodeChallenge,
} from "./pkce.js";

const RFC_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const RFC_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

describe("PKCE S256", () => {
  it("matches the RFC 7636 example", async () => {
    await expect(deriveS256CodeChallenge(RFC_VERIFIER)).resolves.toBe(RFC_CHALLENGE);
    await expect(verifyS256CodeChallenge(RFC_VERIFIER, RFC_CHALLENGE)).resolves.toBe(true);
  });

  it("accepts only 43 to 128 RFC 3986 unreserved characters", () => {
    expect(isValidPkceCodeVerifier("a".repeat(43))).toBe(true);
    expect(isValidPkceCodeVerifier(`A0-._~${"z".repeat(122)}`)).toBe(true);
    expect(isValidPkceCodeVerifier("a".repeat(42))).toBe(false);
    expect(isValidPkceCodeVerifier("a".repeat(129))).toBe(false);
    expect(isValidPkceCodeVerifier(`${"a".repeat(42)}=`)).toBe(false);
    expect(isValidPkceCodeVerifier(`${"a".repeat(42)}!`)).toBe(false);
    expect(isValidPkceCodeVerifier(new String("a".repeat(43)))).toBe(false);
  });

  it("rejects the wrong verifier and malformed expected challenge", async () => {
    await expect(verifyS256CodeChallenge("x".repeat(43), RFC_CHALLENGE)).resolves.toBe(false);
    await expect(verifyS256CodeChallenge(RFC_VERIFIER, `${RFC_CHALLENGE}x`)).resolves.toBe(false);
  });
});
