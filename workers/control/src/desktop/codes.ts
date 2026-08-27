const encoder = new TextEncoder();

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Generate a 256-bit authorization code suitable for one-time disclosure. */
export function generateAuthorizationCode(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

/** Return the lowercase SHA-256 digest persisted in place of the raw code. */
export async function hashAuthorizationCode(code: string): Promise<string> {
  return hex(await globalThis.crypto.subtle.digest("SHA-256", encoder.encode(code)));
}
