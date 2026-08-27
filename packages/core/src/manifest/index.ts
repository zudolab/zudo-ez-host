import type { ManifestEntry, ManifestEntryLookup, ValidationResult } from "../contracts.js";
import {
  MAX_ARTIFACT_BYTES,
  MAX_CANONICAL_MANIFEST_BYTES,
  MAX_FILE_BYTES,
  MAX_FILES_PER_ARTIFACT,
} from "../limits.js";
import { canonicalizePath, findPortablePathCollisionV1 } from "../paths/index.js";
import type { CanonicalPath, PathRejectionReason } from "../paths/index.js";

export type { ManifestEntry } from "../contracts.js";

/** The only manifest schema version understood by the V1 core package. */
export const MANIFEST_SCHEMA_VERSION = 1 as const;

/** The serving rules used to resolve paths in a V1 artifact. */
export const SERVING_SEMANTICS_VERSION = 1 as const;

/** The safe response type for files without a recognized content type. */
export const DEFAULT_CONTENT_TYPE = "application/octet-stream" as const;

/** A manifest entry after its path and metadata have passed validation. */
export interface CanonicalManifestEntry extends Omit<ManifestEntry, "path"> {
  readonly path: CanonicalPath;
}

/** The wire-level shape of a manifest before it is validated. */
export interface Manifest {
  readonly version: number;
  readonly servingSemanticsVersion: number;
  readonly entries: readonly ManifestEntry[];
}

/** A manifest with V1 fields, validated entries, and exact-path lookup. */
export interface ValidatedManifest
  extends Omit<Manifest, "version" | "servingSemanticsVersion" | "entries">, ManifestEntryLookup {
  readonly version: typeof MANIFEST_SCHEMA_VERSION;
  readonly servingSemanticsVersion: typeof SERVING_SEMANTICS_VERSION;
  readonly entries: readonly CanonicalManifestEntry[];
}

/** Backward-compatible descriptive alias for a validated serving manifest. */
export type ValidatedManifestLookup = ValidatedManifest;

/** Stable reason codes returned by manifest validation and decoding. */
export type ManifestValidationReason =
  | PathRejectionReason
  | "invalid_manifest"
  | "invalid_schema_version"
  | "unsupported_schema_version"
  | "invalid_serving_semantics_version"
  | "unsupported_serving_semantics_version"
  | "invalid_entries"
  | "invalid_entry"
  | "invalid_path"
  | "invalid_sha256"
  | "invalid_size"
  | "invalid_mtime_ms"
  | "invalid_content_type"
  | "duplicate_path"
  | "portable_path_collision"
  | "file_size_limit_exceeded"
  | "file_count_limit_exceeded"
  | "artifact_size_limit_exceeded"
  | "manifest_body_limit_exceeded"
  | "invalid_utf8"
  | "invalid_json"
  | "non_canonical_encoding";

type NormalizedManifest = {
  readonly version: typeof MANIFEST_SCHEMA_VERSION;
  readonly servingSemanticsVersion: typeof SERVING_SEMANTICS_VERSION;
  readonly entries: readonly CanonicalManifestEntry[];
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

const MANIFEST_KEYS = new Set(["version", "servingSemanticsVersion", "entries"]);
const ENTRY_KEYS = new Set(["path", "sha256", "size", "mtimeMs", "contentType"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/**
 * Converts absent, blank, or explicitly unknown content metadata to the V1
 * safe fallback. Other non-empty strings are trimmed and retained: MIME
 * metadata is versioned at scan time and may include parameters or vendor types.
 */
export function normalizeContentType(value: unknown): string {
  if (value === undefined || value === null) {
    return DEFAULT_CONTENT_TYPE;
  }

  if (typeof value !== "string") {
    return DEFAULT_CONTENT_TYPE;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.toLowerCase() === "unknown") {
    return DEFAULT_CONTENT_TYPE;
  }

  return trimmed;
}

function compareCanonicalPaths(
  left: CanonicalManifestEntry,
  right: CanonicalManifestEntry,
): number {
  // UTF-8 byte order is explicit and portable across JavaScript and Rust
  // implementations. It also keeps the sort independent of the host locale.
  const leftBytes = textEncoder.encode(left.path);
  const rightBytes = textEncoder.encode(right.path);
  const length = Math.min(leftBytes.length, rightBytes.length);

  for (let index = 0; index < length; index += 1) {
    const leftByte = leftBytes[index] as number;
    const rightByte = rightBytes[index] as number;
    if (leftByte !== rightByte) {
      return leftByte - rightByte;
    }
  }

  return leftBytes.length - rightBytes.length;
}

function entryForEncoding(entry: CanonicalManifestEntry): Record<string, unknown> {
  const encodedEntry: Record<string, unknown> = {
    path: entry.path,
    sha256: entry.sha256,
    size: entry.size,
  };

  if (entry.mtimeMs !== undefined) {
    encodedEntry.mtimeMs = entry.mtimeMs;
  }

  encodedEntry.contentType = entry.contentType;
  return encodedEntry;
}

function encodeNormalized(manifest: NormalizedManifest): Uint8Array {
  const sortedEntries = [...manifest.entries].sort(compareCanonicalPaths);
  const encodedManifest = {
    version: manifest.version,
    servingSemanticsVersion: manifest.servingSemanticsVersion,
    entries: sortedEntries.map(entryForEncoding),
  };

  // JSON.stringify's compact form is deliberate: these are the exact bytes
  // used for artifact hashing and the manifest-body limit.
  return textEncoder.encode(JSON.stringify(encodedManifest));
}

function normalizeManifest(
  input: unknown,
  enforceLimits: boolean,
): ValidationResult<NormalizedManifest, ManifestValidationReason> {
  if (!isRecord(input) || !hasOnlyKeys(input, MANIFEST_KEYS)) {
    return { ok: false, reason: "invalid_manifest" };
  }

  if (!isSafeNonNegativeInteger(input.version)) {
    return { ok: false, reason: "invalid_schema_version" };
  }
  if (input.version !== MANIFEST_SCHEMA_VERSION) {
    return { ok: false, reason: "unsupported_schema_version" };
  }

  if (!isSafeNonNegativeInteger(input.servingSemanticsVersion)) {
    return { ok: false, reason: "invalid_serving_semantics_version" };
  }
  if (input.servingSemanticsVersion !== SERVING_SEMANTICS_VERSION) {
    return { ok: false, reason: "unsupported_serving_semantics_version" };
  }

  if (!Array.isArray(input.entries)) {
    return { ok: false, reason: "invalid_entries" };
  }

  const normalizedEntries: CanonicalManifestEntry[] = [];
  const exactPaths = new Set<string>();
  const canonicalPaths: CanonicalPath[] = [];
  let totalBytes = 0;

  for (const inputEntry of input.entries) {
    if (!isRecord(inputEntry) || !hasOnlyKeys(inputEntry, ENTRY_KEYS)) {
      return { ok: false, reason: "invalid_entry" };
    }

    if (typeof inputEntry.path !== "string") {
      return { ok: false, reason: "invalid_path" };
    }

    const pathResult = canonicalizePath(inputEntry.path);
    if (!pathResult.ok) {
      return pathResult;
    }

    if (exactPaths.has(pathResult.value)) {
      return { ok: false, reason: "duplicate_path" };
    }
    exactPaths.add(pathResult.value);
    canonicalPaths.push(pathResult.value);

    if (typeof inputEntry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(inputEntry.sha256)) {
      return { ok: false, reason: "invalid_sha256" };
    }

    if (!isSafeNonNegativeInteger(inputEntry.size)) {
      return { ok: false, reason: "invalid_size" };
    }

    if (inputEntry.mtimeMs !== undefined && !isSafeInteger(inputEntry.mtimeMs)) {
      return { ok: false, reason: "invalid_mtime_ms" };
    }

    if (
      inputEntry.contentType !== undefined &&
      inputEntry.contentType !== null &&
      typeof inputEntry.contentType !== "string"
    ) {
      return { ok: false, reason: "invalid_content_type" };
    }

    const size = inputEntry.size === 0 ? 0 : inputEntry.size;
    const mtimeMs =
      inputEntry.mtimeMs === undefined || inputEntry.mtimeMs !== 0 ? inputEntry.mtimeMs : 0;

    const normalizedEntry: CanonicalManifestEntry =
      mtimeMs === undefined
        ? {
            path: pathResult.value,
            sha256: inputEntry.sha256,
            size,
            contentType: normalizeContentType(inputEntry.contentType),
          }
        : {
            path: pathResult.value,
            sha256: inputEntry.sha256,
            size,
            mtimeMs,
            contentType: normalizeContentType(inputEntry.contentType),
          };

    normalizedEntries.push(normalizedEntry);
    totalBytes += size;
  }

  const collision = findPortablePathCollisionV1(canonicalPaths);
  if (collision !== undefined) {
    return { ok: false, reason: "portable_path_collision" };
  }

  if (enforceLimits) {
    if (normalizedEntries.some((entry) => entry.size > MAX_FILE_BYTES)) {
      return { ok: false, reason: "file_size_limit_exceeded" };
    }

    if (normalizedEntries.length > MAX_FILES_PER_ARTIFACT) {
      return { ok: false, reason: "file_count_limit_exceeded" };
    }

    if (totalBytes > MAX_ARTIFACT_BYTES) {
      return { ok: false, reason: "artifact_size_limit_exceeded" };
    }
  }

  return {
    ok: true,
    value: {
      version: MANIFEST_SCHEMA_VERSION,
      servingSemanticsVersion: SERVING_SEMANTICS_VERSION,
      entries: normalizedEntries.sort(compareCanonicalPaths),
    },
  };
}

function attachLookup(manifest: NormalizedManifest): ValidatedManifestLookup {
  const entries = Object.freeze(manifest.entries.map((entry) => Object.freeze(entry)));
  const entriesByPath = new Map<string, CanonicalManifestEntry>();
  for (const entry of entries) {
    entriesByPath.set(entry.path, entry);
  }

  const validatedManifest = {
    version: manifest.version,
    servingSemanticsVersion: manifest.servingSemanticsVersion,
    entries,
  } as ValidatedManifestLookup;

  Object.defineProperty(validatedManifest, "lookup", {
    configurable: false,
    enumerable: false,
    value: (canonicalPath: string): ManifestEntry | undefined => entriesByPath.get(canonicalPath),
    writable: false,
  });

  return Object.freeze(validatedManifest);
}

/**
 * Validates and normalizes a manifest. The returned value is immutable and
 * exposes exact canonical-path lookup for the serving resolver.
 */
export function validateManifest(
  input: unknown,
): ValidationResult<ValidatedManifestLookup, ManifestValidationReason> {
  const normalized = normalizeManifest(input, true);
  if (!normalized.ok) {
    return normalized;
  }

  const bytes = encodeNormalized(normalized.value);
  if (bytes.byteLength > MAX_CANONICAL_MANIFEST_BYTES) {
    return { ok: false, reason: "manifest_body_limit_exceeded" };
  }

  return { ok: true, value: attachLookup(normalized.value) };
}

/**
 * Encodes a manifest in deterministic compact UTF-8 JSON.
 *
 * Structural validation is always applied. Quota/body limits are intentionally
 * left to `validateManifest`, so callers can encode a candidate to measure its
 * canonical byte length before deciding whether to publish it.
 */
export function encodeCanonical(manifest: Manifest): Uint8Array {
  const normalized = normalizeManifest(manifest, false);
  if (!normalized.ok) {
    throw new TypeError(`Cannot encode invalid manifest: ${normalized.reason}`);
  }

  return encodeNormalized(normalized.value);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }

  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

/**
 * Decodes only canonical UTF-8 JSON bytes and validates every field and V1
 * limit before returning a lookup-capable manifest.
 */
export function decodeCanonical(
  input: Uint8Array | ArrayBuffer,
): ValidationResult<ValidatedManifestLookup, ManifestValidationReason> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);

  if (bytes.byteLength > MAX_CANONICAL_MANIFEST_BYTES) {
    return { ok: false, reason: "manifest_body_limit_exceeded" };
  }

  let decodedText: string;
  try {
    decodedText = textDecoder.decode(bytes);
  } catch {
    return { ok: false, reason: "invalid_utf8" };
  }

  let decodedValue: unknown;
  try {
    decodedValue = JSON.parse(decodedText) as unknown;
  } catch {
    return { ok: false, reason: "invalid_json" };
  }

  const validated = validateManifest(decodedValue);
  if (!validated.ok) {
    return validated;
  }

  const canonicalBytes = encodeCanonical(validated.value);
  if (!bytesEqual(bytes, canonicalBytes)) {
    return { ok: false, reason: "non_canonical_encoding" };
  }

  return validated;
}

/** Builds the exact lookup interface expected by the serving resolver. */
export function createManifestLookup(manifest: Manifest): ManifestEntryLookup {
  const entriesByPath = new Map<string, ManifestEntry>();
  for (const entry of manifest.entries) {
    entriesByPath.set(entry.path, entry);
  }

  return {
    lookup(canonicalPath: string): ManifestEntry | undefined {
      return entriesByPath.get(canonicalPath);
    },
  };
}

/** Alias for callers that name the wire operation rather than its encoding. */
export const decodeManifest = decodeCanonical;
