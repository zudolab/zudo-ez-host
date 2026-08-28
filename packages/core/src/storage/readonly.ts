/**
 * The subset of R2 object metadata needed by shared serving and verification
 * logic. These interfaces deliberately describe the capability structurally;
 * the core package must not import Cloudflare's Worker types.
 */
export interface ReadOnlyR2Checksums {
  readonly md5?: ArrayBuffer;
}

export interface ReadOnlyR2Object {
  readonly size: number;
  readonly checksums?: ReadOnlyR2Checksums;
}

export interface ReadOnlyR2ObjectBody extends ReadOnlyR2Object {
  readonly body?: ReadableStream;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** The read-only R2 capability used by serving and metadata verification. */
export interface ReadOnlyR2Bucket {
  get(key: string): Promise<ReadOnlyR2ObjectBody | null>;
  head(key: string): Promise<ReadOnlyR2Object | null>;
}

/** Alias emphasizing that this is a serving/storage reader rather than a bucket. */
export type R2Reader = ReadOnlyR2Bucket;

/**
 * Wrap a bucket-like value without leaking write methods. Binding methods are
 * explicitly bound so the returned facade is safe to pass across service
 * boundaries.
 */
export function createReadOnlyR2Bucket(bucket: ReadOnlyR2Bucket): ReadOnlyR2Bucket {
  return Object.freeze({
    get: (key: string) => bucket.get(key),
    head: (key: string) => bucket.head(key),
  });
}

/** Descriptive alias for consumers that call this a facade. */
export const createReadOnlyR2Facade = createReadOnlyR2Bucket;
