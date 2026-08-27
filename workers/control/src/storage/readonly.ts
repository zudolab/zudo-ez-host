/**
 * Read-only capability for the R2 serving path.
 *
 * R2 bindings do not have a read-only Wrangler mode. This wrapper keeps the
 * write-capable binding private to the control-plane module and gives later
 * serving code a value whose public type and runtime shape contain only
 * `get` and `head`.
 */
export type ReadOnlyR2Bucket = Pick<R2Bucket, "get" | "head">;

/** Alias emphasizing that this is a serving/storage reader rather than a bucket. */
export type R2Reader = ReadOnlyR2Bucket;

/**
 * Wrap an R2 binding without leaking `put`, `delete`, list, or multipart
 * methods. Binding methods are explicitly bound so the returned facade is
 * safe to pass through service boundaries.
 */
export function createReadOnlyR2Bucket(bucket: Pick<R2Bucket, "get" | "head">): ReadOnlyR2Bucket {
  return Object.freeze({
    get: bucket.get.bind(bucket),
    head: bucket.head.bind(bucket),
  });
}

/** Descriptive alias for consumers that call this a facade. */
export const createReadOnlyR2Facade = createReadOnlyR2Bucket;
