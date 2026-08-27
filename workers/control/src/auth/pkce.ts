const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/u;
const encoder = new TextEncoder();

interface WorkersSubtleCrypto extends SubtleCrypto {
  timingSafeEqual(a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView): boolean;
}

// Cloudflare implements this documented extension, but the DOM lib's global
// declaration can win over the Workers declaration during interface merging.
const subtle = globalThis.crypto.subtle as WorkersSubtleCrypto;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

/** Return whether a value has RFC 7636's exact code-verifier syntax. */
export function isValidPkceCodeVerifier(value: unknown): value is string {
  return typeof value === "string" && CODE_VERIFIER_PATTERN.test(value);
}

/** Derive the RFC 7636 S256 challenge for a syntactically valid verifier. */
export async function deriveS256CodeChallenge(codeVerifier: string): Promise<string> {
  const digest = await subtle.digest("SHA-256", encoder.encode(codeVerifier));
  return base64Url(new Uint8Array(digest));
}

/** Validate verifier syntax and compare its S256 challenge without string short-circuiting. */
export async function verifyS256CodeChallenge(
  codeVerifier: unknown,
  expectedChallenge: string,
): Promise<boolean> {
  if (!isValidPkceCodeVerifier(codeVerifier)) return false;

  const actualBytes = encoder.encode(await deriveS256CodeChallenge(codeVerifier));
  const expectedBytes = encoder.encode(expectedChallenge);
  const lengthsMatch = actualBytes.byteLength === expectedBytes.byteLength;

  return lengthsMatch
    ? subtle.timingSafeEqual(actualBytes, expectedBytes)
    : !subtle.timingSafeEqual(actualBytes, actualBytes);
}
