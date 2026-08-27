import type { ValidationResult } from "../contracts.js";

/** The non-secret family prefix shared by all machine credentials. */
export const MACHINE_TOKEN_PREFIX = "zeh_machine_" as const;

/** The machine-credential wire-format version implemented by this package. */
export const MACHINE_TOKEN_VERSION = 1 as const;

/** The exact prefix written before a machine credential's random bytes. */
export const MACHINE_TOKEN_WIRE_PREFIX =
  `${MACHINE_TOKEN_PREFIX}v${MACHINE_TOKEN_VERSION}_` as const;

/** The number of random bytes in a V1 machine credential. */
export const MACHINE_TOKEN_RANDOM_BYTES = 32 as const;

/** The unpadded base64url length of MACHINE_TOKEN_RANDOM_BYTES. */
export const MACHINE_TOKEN_RANDOM_LENGTH = 43 as const;

/** The complete length of a V1 machine credential. */
export const MACHINE_TOKEN_LENGTH = MACHINE_TOKEN_WIRE_PREFIX.length + MACHINE_TOKEN_RANDOM_LENGTH;

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const textEncoder = new TextEncoder();

/** Stable reasons returned when a machine credential has an invalid shape. */
export type MachineTokenRejectionReason =
  | "not_string"
  | "invalid_prefix"
  | "invalid_length"
  | "invalid_alphabet"
  | "non_canonical_encoding";

/** The non-secret data extracted from a validated machine credential. */
export interface MachineTokenMetadata {
  readonly prefix: typeof MACHINE_TOKEN_PREFIX;
  readonly version: typeof MACHINE_TOKEN_VERSION;
}

export type MachineTokenParseResult = ValidationResult<
  MachineTokenMetadata,
  MachineTokenRejectionReason
>;

function encodeBase64Url(bytes: Uint8Array): string {
  let encoded = "";

  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] as number;
    const second = bytes[index + 1];
    const third = bytes[index + 2];

    encoded += BASE64URL_ALPHABET[first >>> 2];
    encoded +=
      BASE64URL_ALPHABET[((first & 0x03) << 4) | (second === undefined ? 0 : second >>> 4)];

    if (second === undefined) {
      break;
    }

    encoded += BASE64URL_ALPHABET[((second & 0x0f) << 2) | (third === undefined ? 0 : third >>> 6)];

    if (third === undefined) {
      break;
    }

    encoded += BASE64URL_ALPHABET[third & 0x3f];
  }

  return encoded;
}

function base64UrlValue(character: string): number {
  return BASE64URL_ALPHABET.indexOf(character);
}

/**
 * Generate a V1 machine credential using 256 bits of cryptographically secure
 * randomness. The returned value is the only raw credential representation.
 */
export function generateMachineToken(): string {
  const randomBytes = new Uint8Array(MACHINE_TOKEN_RANDOM_BYTES);
  globalThis.crypto.getRandomValues(randomBytes);
  return `${MACHINE_TOKEN_WIRE_PREFIX}${encodeBase64Url(randomBytes)}`;
}

/**
 * Validate a machine credential's exact V1 wire shape and extract its
 * non-secret family prefix and version.
 *
 * Shape validation deliberately does not authenticate a token. A different
 * valid random suffix is still syntactically well-formed; the server's hash
 * lookup determines whether it was minted and has not been revoked.
 */
export function parseMachineToken(input: unknown): MachineTokenParseResult {
  if (typeof input !== "string") {
    return { ok: false, reason: "not_string" };
  }

  if (!input.startsWith(MACHINE_TOKEN_WIRE_PREFIX)) {
    return { ok: false, reason: "invalid_prefix" };
  }

  if (input.length !== MACHINE_TOKEN_LENGTH) {
    return { ok: false, reason: "invalid_length" };
  }

  const randomPart = input.slice(MACHINE_TOKEN_WIRE_PREFIX.length);
  if (!BASE64URL_PATTERN.test(randomPart)) {
    return { ok: false, reason: "invalid_alphabet" };
  }

  // 32 bytes produce 43 base64url characters. The final character contains
  // four data bits and two required zero pad bits in a canonical encoding.
  const finalValue = base64UrlValue(randomPart.at(-1) as string);
  if ((finalValue & 0x03) !== 0) {
    return { ok: false, reason: "non_canonical_encoding" };
  }

  return {
    ok: true,
    value: {
      prefix: MACHINE_TOKEN_PREFIX,
      version: MACHINE_TOKEN_VERSION,
    },
  };
}

/** Return the lowercase hexadecimal SHA-256 digest of the complete token. */
export async function hashMachineToken(token: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", textEncoder.encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
