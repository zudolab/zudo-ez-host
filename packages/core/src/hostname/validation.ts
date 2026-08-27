import {
  HOSTNAME_COMPONENT_PATTERN,
  HOSTNAME_LABEL_DELIMITER,
  MAX_HANDLE_LENGTH,
  MAX_LABEL_OCTETS,
  MAX_SLUG_LENGTH,
  MIN_HANDLE_LENGTH,
  MIN_SLUG_LENGTH,
} from "./constants.js";
import { canonicalizeAsciiUppercase, isAscii, utf8ByteLength } from "./canonicalize.js";
import { getReservedNameReason } from "./reserved.js";
import type {
  ComponentValidationResult,
  HostnameLabelParts,
  HostnameValidationOptions,
  HostnameValidationReason,
  HostnameValidationResult,
} from "./types.js";

const success = <Value>(value: Value): HostnameValidationResult<Value> => ({ ok: true, value });
const failure = (reason: HostnameValidationReason): HostnameValidationResult<never> => ({
  ok: false,
  reason,
});

function canonicalizeInput(input: unknown): HostnameValidationResult<string> {
  return typeof input === "string"
    ? success(canonicalizeAsciiUppercase(input))
    : failure("not_string");
}

function validateComponent(
  input: unknown,
  minLength: number,
  maxLength: number,
  options: HostnameValidationOptions,
): ComponentValidationResult {
  const canonicalized = canonicalizeInput(input);
  if (!canonicalized.ok) {
    return canonicalized;
  }

  const value = canonicalized.value;
  if (value.length === 0) {
    return failure("empty");
  }
  if (!isAscii(value)) {
    return failure("invalid_character");
  }
  if (value.length < minLength) {
    return failure("too_short");
  }
  if (value.length > maxLength) {
    return failure("too_long");
  }
  if (value.startsWith("xn--")) {
    return failure("punycode_prefix");
  }
  if (value.startsWith("-")) {
    return failure("leading_hyphen");
  }
  if (value.endsWith("-")) {
    return failure("trailing_hyphen");
  }
  if (value.includes(HOSTNAME_LABEL_DELIMITER)) {
    return failure("contains_delimiter");
  }
  if (!HOSTNAME_COMPONENT_PATTERN.test(value)) {
    return failure("invalid_character");
  }

  const reservedReason = getReservedNameReason(value, options);
  return reservedReason === undefined ? success(value) : failure(reservedReason);
}

/** Validate and canonicalize a user handle. */
export function validateHandle(
  input: unknown,
  options: HostnameValidationOptions = {},
): ComponentValidationResult {
  return validateComponent(input, MIN_HANDLE_LENGTH, MAX_HANDLE_LENGTH, options);
}

/** Validate and canonicalize a project slug. */
export function validateSlug(
  input: unknown,
  options: HostnameValidationOptions = {},
): ComponentValidationResult {
  return validateComponent(input, MIN_SLUG_LENGTH, MAX_SLUG_LENGTH, options);
}

/**
 * Validate both components and compose their canonical public label.
 *
 * The argument order follows the public URL spelling: project slug, then user
 * handle.
 */
export function composeLabel(
  slugInput: unknown,
  handleInput: unknown,
  options: HostnameValidationOptions = {},
): HostnameValidationResult<string> {
  const slug = validateSlug(slugInput, options);
  if (!slug.ok) {
    return slug;
  }

  const handle = validateHandle(handleInput, options);
  if (!handle.ok) {
    return handle;
  }

  const label = `${slug.value}${HOSTNAME_LABEL_DELIMITER}${handle.value}`;
  return utf8ByteLength(label) <= MAX_LABEL_OCTETS ? success(label) : failure("label_too_long");
}

/** Validate and split a canonical or mixed-case public label. */
export function parseLabel(
  input: unknown,
  options: HostnameValidationOptions = {},
): HostnameValidationResult<HostnameLabelParts> {
  const canonicalized = canonicalizeInput(input);
  if (!canonicalized.ok) {
    return canonicalized;
  }

  const label = canonicalized.value;
  if (label.length === 0) {
    return failure("empty");
  }
  if (!isAscii(label)) {
    return failure("invalid_character");
  }
  if (utf8ByteLength(label) > MAX_LABEL_OCTETS) {
    return failure("label_too_long");
  }

  const delimiterIndex = label.indexOf(HOSTNAME_LABEL_DELIMITER);
  if (delimiterIndex < 0) {
    return failure("missing_delimiter");
  }
  if (
    label.indexOf(HOSTNAME_LABEL_DELIMITER, delimiterIndex + HOSTNAME_LABEL_DELIMITER.length) >= 0
  ) {
    return failure("contains_delimiter");
  }

  const slug = validateSlug(label.slice(0, delimiterIndex), options);
  if (!slug.ok) {
    return slug;
  }

  const handle = validateHandle(
    label.slice(delimiterIndex + HOSTNAME_LABEL_DELIMITER.length),
    options,
  );
  if (!handle.ok) {
    return handle;
  }

  return success({ slug: slug.value, handle: handle.value });
}
