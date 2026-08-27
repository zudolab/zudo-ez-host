export {
  HOSTNAME_COMPONENT_PATTERN,
  HOSTNAME_GRAMMAR_VERSION,
  HOSTNAME_LABEL_DELIMITER,
  MAX_HANDLE_LENGTH,
  MAX_HOSTNAME_LABEL_OCTETS,
  MAX_LABEL_OCTETS,
  MAX_PROJECT_SLUG_LENGTH,
  MAX_SLUG_LENGTH,
  MIN_HANDLE_LENGTH,
  MIN_PROJECT_SLUG_LENGTH,
  MIN_SLUG_LENGTH,
} from "./constants.js";
export { canonicalizeAsciiUppercase, isAscii, utf8ByteLength } from "./canonicalize.js";
export {
  getReservedNameReason,
  isReservedName,
  PERMANENT_ID_PREFIXES,
  RESERVED_NAME_VERSION,
  RESERVED_NAMES,
} from "./reserved.js";
export { composeLabel, parseLabel, validateHandle, validateSlug } from "./validation.js";

export type {
  ComponentValidationResult,
  HostnameLabelParts,
  HostnameValidationOptions,
  HostnameValidationReason,
  HostnameValidationResult,
  ReservedNameReason,
} from "./types.js";
