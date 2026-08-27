import type { ValidationResult } from "../contracts.js";

declare const canonicalPathBrand: unique symbol;

/** A manifest-side relative path that has passed the canonical path rules. */
export type CanonicalPath = string & { readonly [canonicalPathBrand]: true };

export type PathRejectionReason =
  | "empty_path"
  | "absolute_path"
  | "empty_segment"
  | "dot_segment"
  | "parent_segment"
  | "backslash"
  | "nul_byte";

export interface PortablePathCollision {
  readonly first: CanonicalPath;
  readonly second: CanonicalPath;
}

/**
 * Stable marker for the portable path collision algorithm implemented here.
 *
 * V1 compares each complete canonical path after applying Unicode NFC and then
 * JavaScript's locale-independent `toLowerCase()`. The order is normative:
 *
 *     path.normalize("NFC").toLowerCase()
 *
 * This is deliberately not locale-sensitive and must not be replaced with
 * `toLocaleLowerCase()`. Future changes require a new version so other
 * implementations, including the Rust implementation, can mirror V1 exactly.
 */
export const PORTABLE_PATH_COLLISION_ALGORITHM_VERSION = 1 as const;

/**
 * Validates a manifest-side path and returns its canonical representation.
 *
 * The local filesystem domain has no percent-decoding step. Accepted paths are
 * already canonical, so the returned string is unchanged. In particular,
 * Unicode normalization is preserved for collision detection rather than
 * silently choosing one local filename.
 */
export function canonicalizePath(
  input: string,
): ValidationResult<CanonicalPath, PathRejectionReason> {
  if (input.length === 0) {
    return { ok: false, reason: "empty_path" };
  }

  if (input.includes("\0")) {
    return { ok: false, reason: "nul_byte" };
  }

  if (input.includes("\\")) {
    return { ok: false, reason: "backslash" };
  }

  if (input.startsWith("/")) {
    return { ok: false, reason: "absolute_path" };
  }

  for (const segment of input.split("/")) {
    if (segment.length === 0) {
      return { ok: false, reason: "empty_segment" };
    }

    if (segment === ".") {
      return { ok: false, reason: "dot_segment" };
    }

    if (segment === "..") {
      return { ok: false, reason: "parent_segment" };
    }
  }

  return { ok: true, value: input as CanonicalPath };
}

/**
 * Finds the first pair of distinct canonical paths that collide under V1.
 *
 * Iteration order defines which pair is returned when a set contains multiple
 * collisions. Repeated copies of the exact same path are not a collision.
 */
export function findPortablePathCollisionV1(
  paths: readonly CanonicalPath[],
): PortablePathCollision | undefined {
  const pathsByComparisonKey = new Map<string, CanonicalPath>();

  for (const path of paths) {
    const comparisonKey = path.normalize("NFC").toLowerCase();
    const first = pathsByComparisonKey.get(comparisonKey);

    if (first !== undefined && first !== path) {
      return { first, second: path };
    }

    if (first === undefined) {
      pathsByComparisonKey.set(comparisonKey, path);
    }
  }

  return undefined;
}
