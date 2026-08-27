import type { ReadOnlyR2Bucket } from "./readonly.js";

/**
 * Keep one inventory request below the Workers Free plan's 50-subrequest
 * limit. Callers own paging across larger inventories; this helper never
 * lists a bucket or silently splits a request into additional pages.
 */
export const MAX_VERIFICATION_BATCH_SIZE = 50;

/** MD5 values accepted by the verification helper. Strings may be base64 or hexadecimal. */
export type Md5Value = string | ArrayBuffer | ArrayBufferView;

/** The metadata a caller expects for one immutable R2 object. */
export interface R2ObjectVerificationRequest {
  readonly key: string;
  readonly expectedSize: number;
  readonly expectedMd5?: Md5Value;
}

/**
 * The result of one metadata-only verification. `verified`/`ok` are true when
 * the object exists, has the exact expected size, and has no observed MD5
 * mismatch. MD5 comparison is opportunistic because R2 may not expose a
 * checksum for every object kind (for example, a multipart object).
 */
export interface R2ObjectVerificationResult {
  readonly key: string;
  readonly expectedSize: number;
  readonly actualSize?: number;
  readonly exists: boolean;
  readonly sizeMatches: boolean;
  readonly md5Available: boolean;
  readonly md5Matches?: boolean;
  readonly verified: boolean;
  readonly ok: boolean;
  readonly reason?: "missing" | "size_mismatch" | "md5_mismatch";
}

function assertVerificationRequest(request: R2ObjectVerificationRequest): void {
  if (typeof request.key !== "string" || request.key.length === 0) {
    throw new TypeError("key must be a non-empty R2 object key");
  }

  if (!Number.isSafeInteger(request.expectedSize) || request.expectedSize < 0) {
    throw new TypeError("expectedSize must be a non-negative safe integer");
  }
}

function bytesForMd5(value: Md5Value): Uint8Array {
  if (typeof value === "string") {
    const normalized = value.trim();
    if (/^[0-9a-f]{32}$/i.test(normalized)) {
      const bytes = new Uint8Array(16);
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
      }
      return bytes;
    }

    // Content-MD5 is transported as base64. Keep decoding local to the
    // Worker-compatible Web APIs rather than importing Node's Buffer.
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(normalized)) {
      throw new TypeError("expectedMd5 must be base64 or hexadecimal MD5");
    }

    const decoded = globalThis.atob(normalized);
    const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    if (bytes.length !== 16) {
      throw new TypeError("expectedMd5 must decode to 16 bytes");
    }
    return bytes;
  }

  const bytes = ArrayBuffer.isView(value)
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : new Uint8Array(value);
  if (bytes.length !== 16) {
    throw new TypeError("expectedMd5 must contain 16 bytes");
  }
  return bytes;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }

  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] as number) ^ (right[index] as number);
  }
  return difference === 0;
}

/** Verify one object with a metadata-only R2 `head()` call. */
export async function verifyR2Object(
  bucket: ReadOnlyR2Bucket,
  request: R2ObjectVerificationRequest,
): Promise<R2ObjectVerificationResult> {
  assertVerificationRequest(request);
  const expectedMd5 =
    request.expectedMd5 === undefined ? undefined : bytesForMd5(request.expectedMd5);
  const object = await bucket.head(request.key);
  if (object === null) {
    return {
      key: request.key,
      expectedSize: request.expectedSize,
      exists: false,
      sizeMatches: false,
      md5Available: false,
      verified: false,
      ok: false,
      reason: "missing",
    };
  }

  const sizeMatches = object.size === request.expectedSize;
  const checksum = object.checksums?.md5;
  const md5Available = checksum !== undefined;
  const md5Matches =
    expectedMd5 === undefined || checksum === undefined
      ? undefined
      : bytesEqual(new Uint8Array(checksum), expectedMd5);
  const verified = sizeMatches && md5Matches !== false;

  return {
    key: request.key,
    expectedSize: request.expectedSize,
    actualSize: object.size,
    exists: true,
    sizeMatches,
    md5Available,
    ...(md5Matches === undefined ? {} : { md5Matches }),
    verified,
    ok: verified,
    reason: !sizeMatches ? "size_mismatch" : md5Matches === false ? "md5_mismatch" : undefined,
  };
}

/**
 * Verify a bounded batch with one sequential `head()` per target. The
 * sequential loop makes the subrequest bound obvious and avoids adding a
 * burst of concurrent R2 calls to the caller's request budget.
 */
export async function verifyR2Objects(
  bucket: ReadOnlyR2Bucket,
  requests: readonly R2ObjectVerificationRequest[],
): Promise<R2ObjectVerificationResult[]> {
  if (requests.length > MAX_VERIFICATION_BATCH_SIZE) {
    throw new RangeError(
      `verification batch cannot exceed ${MAX_VERIFICATION_BATCH_SIZE} R2 head requests`,
    );
  }

  const results: R2ObjectVerificationResult[] = [];
  for (const request of requests) {
    results.push(await verifyR2Object(bucket, request));
  }
  return results;
}

/** Descriptive aliases for callers that call this operation an inventory check. */
export const verifyObject = verifyR2Object;
export const verifyObjects = verifyR2Objects;
