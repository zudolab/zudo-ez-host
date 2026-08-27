/** The version of the public hostname grammar implemented by this module. */
export const HOSTNAME_GRAMMAR_VERSION = 1 as const;

/** The separator between a project slug and a user handle. */
export const HOSTNAME_LABEL_DELIMITER = "--" as const;

/** The shortest and longest accepted user handle lengths. */
export const MIN_HANDLE_LENGTH = 3 as const;
export const MAX_HANDLE_LENGTH = 20 as const;

/** The shortest and longest accepted project slug lengths. */
export const MIN_SLUG_LENGTH = 1 as const;
export const MAX_SLUG_LENGTH = 41 as const;

/** The maximum UTF-8 length of a complete public hostname label. */
export const MAX_LABEL_OCTETS = 63 as const;

/**
 * The V1 component grammar. Uppercase ASCII is canonicalized before this
 * expression is applied; all other non-ASCII characters remain invalid.
 */
export const HOSTNAME_COMPONENT_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

// Descriptive aliases make the component/label terminology explicit to
// callers without introducing a second set of limits.
export const MIN_PROJECT_SLUG_LENGTH = MIN_SLUG_LENGTH;
export const MAX_PROJECT_SLUG_LENGTH = MAX_SLUG_LENGTH;
export const MAX_HOSTNAME_LABEL_OCTETS = MAX_LABEL_OCTETS;
