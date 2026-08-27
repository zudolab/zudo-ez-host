/**
 * The shared result shape for validation in the core package.
 *
 * Callers provide a string-literal union for `Reason` so each rule module can
 * expose stable, machine-readable failure codes without throwing for expected
 * invalid input. The default keeps the contract convenient for generic code;
 * concrete validators should narrow it to their own reason union.
 */
export type ValidationResult<Value, Reason extends string = string> =
  { readonly ok: true; readonly value: Value } | { readonly ok: false; readonly reason: Reason };

/**
 * The smallest manifest entry needed by serving and publication code.
 *
 * `path` is an already-canonical relative path. Lookup implementations must
 * compare it exactly; normalization and request-path parsing belong to their
 * respective callers.
 */
export interface ManifestEntry {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly contentType: string;
}

/**
 * Exact canonical-path lookup used by the pure serving resolver.
 *
 * A missing path is represented by `undefined`; the lookup must not apply
 * case folding, extension inference, or directory-index rules itself.
 */
export interface ManifestEntryLookup {
  lookup(canonicalPath: string): ManifestEntry | undefined;
}
