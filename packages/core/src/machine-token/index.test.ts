import { describe, expect, it } from "vitest";

import {
  MACHINE_TOKEN_LENGTH,
  MACHINE_TOKEN_PREFIX,
  MACHINE_TOKEN_RANDOM_LENGTH,
  MACHINE_TOKEN_VERSION,
  MACHINE_TOKEN_WIRE_PREFIX,
  generateMachineToken,
  hashMachineToken,
  parseMachineToken,
} from "./index.js";

const VALID_TOKEN = `${MACHINE_TOKEN_WIRE_PREFIX}${"A".repeat(MACHINE_TOKEN_RANDOM_LENGTH)}`;

function rejectionReason(input: unknown): string {
  const result = parseMachineToken(input);
  if (result.ok) {
    throw new Error("Expected machine token parsing to fail");
  }
  return result.reason;
}

describe("machine-token wire format", () => {
  it("generates 32 random bytes as an exact V1 token and parses its metadata", () => {
    const token = generateMachineToken();

    expect(token).toHaveLength(MACHINE_TOKEN_LENGTH);
    expect(token.startsWith(MACHINE_TOKEN_WIRE_PREFIX)).toBe(true);
    expect(parseMachineToken(token)).toEqual({
      ok: true,
      value: { prefix: MACHINE_TOKEN_PREFIX, version: MACHINE_TOKEN_VERSION },
    });
  });

  it("rejects a tampered token whose random portion leaves the wire alphabet", () => {
    const token = generateMachineToken();
    const tampered = `${token.slice(0, -1)}!`;

    expect(rejectionReason(tampered)).toBe("invalid_alphabet");
  });

  it("rejects a wrong prefix", () => {
    const wrongPrefix = `foo_machine_v1_${"A".repeat(MACHINE_TOKEN_RANDOM_LENGTH)}`;

    expect(rejectionReason(wrongPrefix)).toBe("invalid_prefix");
  });

  it.each([
    `${MACHINE_TOKEN_WIRE_PREFIX}${"A".repeat(MACHINE_TOKEN_RANDOM_LENGTH - 1)}`,
    `${MACHINE_TOKEN_WIRE_PREFIX}${"A".repeat(MACHINE_TOKEN_RANDOM_LENGTH + 1)}`,
  ])("rejects a wrong-length token: %s", (token) => {
    expect(rejectionReason(token)).toBe("invalid_length");
  });

  it("rejects characters outside the unpadded base64url alphabet", () => {
    const invalidAlphabet = `${MACHINE_TOKEN_WIRE_PREFIX}${"A".repeat(42)}!`;

    expect(rejectionReason(invalidAlphabet)).toBe("invalid_alphabet");
  });

  it("rejects a non-canonical final base64url character", () => {
    const nonCanonical = `${MACHINE_TOKEN_WIRE_PREFIX}${"A".repeat(42)}B`;

    expect(rejectionReason(nonCanonical)).toBe("non_canonical_encoding");
  });

  it("rejects non-string input", () => {
    expect(rejectionReason(undefined)).toBe("not_string");
  });
});

describe("hashMachineToken", () => {
  it("matches an independently computed SHA-256 known-answer vector", async () => {
    // Independent reference: printf %s '...' | shasum -a 256
    expect(await hashMachineToken(VALID_TOKEN)).toBe(
      "fd43e091b6ebcf38b883b124bc0b1ef321c826cfd87af2fdbfee31a9996422f6",
    );
  });
});
