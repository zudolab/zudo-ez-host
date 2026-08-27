import type { ValidationResult } from "../contracts.js";

/** Stable machine-readable reasons returned by hostname validation. */
export type HostnameValidationReason =
  | "not_string"
  | "empty"
  | "too_short"
  | "too_long"
  | "invalid_character"
  | "leading_hyphen"
  | "trailing_hyphen"
  | "contains_delimiter"
  | "punycode_prefix"
  | "reserved_name"
  | "reserved_prefix"
  | "missing_delimiter"
  | "label_too_long";

/** The subset of reasons produced by the reserved-name policy helper. */
export type ReservedNameReason = "reserved_name" | "reserved_prefix";

/** Options for the intentionally narrow reserved-name extension point. */
export interface HostnameValidationOptions {
  /**
   * Deployment-owned permanent-ID prefixes. Prefixes are canonicalized with
   * the same ASCII-only mapping as components and cannot replace the central
   * V1 reserved-name list.
   */
  readonly permanentIdPrefixes?: readonly string[];
}

/** A successful or failed hostname validation result. */
export type HostnameValidationResult<Value> = ValidationResult<Value, HostnameValidationReason>;

/** The canonical components represented by a complete public label. */
export interface HostnameLabelParts {
  readonly slug: string;
  readonly handle: string;
}

/** Result returned by component validators. */
export type ComponentValidationResult = HostnameValidationResult<string>;
