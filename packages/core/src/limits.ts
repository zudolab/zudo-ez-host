/**
 * ADR 0001 V1 limits. These values are provisional but binding until a later
 * architecture decision deliberately supersedes them.
 */

/** Provisional-but-binding maximum size of one published file, in bytes (100 MiB). */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;

/** Provisional-but-binding maximum number of files in one artifact. */
export const MAX_FILES_PER_ARTIFACT = 20_000;

/** Provisional-but-binding maximum logical size of one artifact, in bytes (2 GiB). */
export const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;

/** Provisional-but-binding active published-data limit per account, in bytes (10 GiB). */
export const MAX_ACTIVE_PUBLISHED_BYTES_PER_ACCOUNT = 10 * 1024 * 1024 * 1024;

/**
 * Provisional-but-binding retained plus staged physical-data limit per account,
 * in bytes (20 GiB).
 */
export const MAX_RETAINED_AND_STAGED_BYTES_PER_ACCOUNT = 20 * 1024 * 1024 * 1024;

/** Provisional-but-binding maximum canonical manifest body, in bytes (10 MiB). */
export const MAX_CANONICAL_MANIFEST_BYTES = 10 * 1024 * 1024;

/** Provisional-but-binding maximum number of open publication attempts per project. */
export const MAX_OPEN_ATTEMPTS_PER_PROJECT = 3;

/** Provisional-but-binding maximum number of open publication attempts per account. */
export const MAX_OPEN_ATTEMPTS_PER_ACCOUNT = 20;

/** Provisional-but-binding maximum concurrent client PUT uploads per machine. */
export const MAX_UPLOAD_CONCURRENCY_PER_MACHINE = 8;

/** Provisional-but-binding prepare rate ceiling per account per minute. */
export const MAX_PREPARES_PER_ACCOUNT_PER_MINUTE = 5;

/** Provisional-but-binding commit rate ceiling per project per minute. */
export const MAX_COMMITS_PER_PROJECT_PER_MINUTE = 10;

/** Provisional-but-binding presigned-URL issuance ceiling per account per minute. */
export const MAX_PRESIGNED_URL_ISSUANCES_PER_ACCOUNT_PER_MINUTE = 1_000;
