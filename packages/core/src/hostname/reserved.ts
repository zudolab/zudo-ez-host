import { canonicalizeAsciiUppercase } from "./canonicalize.js";
import type { HostnameValidationOptions, ReservedNameReason } from "./types.js";

/** The version of the centrally maintained V1 reserved-name policy. */
export const RESERVED_NAME_VERSION = 1 as const;

/**
 * Names that cannot be allocated as either a project slug or a user handle.
 * Additions are a versioned compatibility change because they affect future
 * allocations.
 */
export const RESERVED_NAMES = [
  "www",
  "api",
  "app",
  "admin",
  "auth",
  "login",
  "logout",
  "account",
  "billing",
  "support",
  "status",
  "docs",
  "cdn",
  "assets",
  "static",
  "mail",
  "ftp",
  "localhost",
  "staging",
  "preview",
  "internal",
  "root",
  "system",
] as const;

/**
 * The default prefix extension is intentionally empty: deployments can pass
 * permanent-ID prefixes through `HostnameValidationOptions` as they acquire
 * IDs, while this shared V1 module remains independent of an ID format.
 */
export const PERMANENT_ID_PREFIXES: readonly string[] = [];

/**
 * Return the reserved-name reason, if any. Callers should pass canonical
 * values, but ASCII uppercase is normalized here as a defensive convenience.
 */
export function getReservedNameReason(
  value: string,
  options: HostnameValidationOptions = {},
): ReservedNameReason | undefined {
  const canonical = canonicalizeAsciiUppercase(value);

  if ((RESERVED_NAMES as readonly string[]).includes(canonical)) {
    return "reserved_name";
  }

  const configuredPrefixes = options.permanentIdPrefixes ?? PERMANENT_ID_PREFIXES;
  for (const prefix of configuredPrefixes) {
    const canonicalPrefix = canonicalizeAsciiUppercase(prefix);
    if (canonicalPrefix.length > 0 && canonical.startsWith(canonicalPrefix)) {
      return "reserved_prefix";
    }
  }

  return undefined;
}

/** Check whether a value is reserved by the central list or an ID prefix. */
export function isReservedName(value: string, options: HostnameValidationOptions = {}): boolean {
  return getReservedNameReason(value, options) !== undefined;
}
