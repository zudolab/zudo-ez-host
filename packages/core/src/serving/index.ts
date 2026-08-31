import type { ManifestEntry, ManifestEntryLookup, ValidationResult } from "../contracts.js";
import { canonicalizePath } from "../paths/index.js";
import type { CanonicalPath } from "../paths/index.js";

/** The content type used when a manifest does not provide one. */
export const SERVING_DEFAULT_CONTENT_TYPE = "application/octet-stream" as const;

/** The only methods accepted by the V1 content responder. */
export const SERVING_ALLOW_HEADER = "GET, HEAD" as const;

/** V1 cache categories. TTL and fingerprint policy belong to the Worker. */
export type ServingCachePolicy = "immutableCandidate" | "revalidate" | "noStore";

/** The route that the Worker has selected before invoking the content resolver. */
export type ServingRoute = "content" | "gate-login";

/**
 * Project settings that affect serving. These are deliberately only flags;
 * request-derived facts, such as HTML navigation, live on ServingRequest.
 */
export interface ServingProjectFlags {
  /** Enable the root-index fallback for unmatched HTML navigations. */
  readonly spaFallback?: boolean;
  /** Mark every response as gated and therefore ineligible for shared cache. */
  readonly gated?: boolean;
}

/**
 * Request data needed by the resolver.
 *
 * `rawPath` is kept separate from the decoded path returned by
 * decodeRequestPath. The Worker must derive `isHtmlNavigation`; this module
 * never inspects Accept, Sec-Fetch-Mode, or any other browser header.
 */
export interface ServingRequest {
  readonly method: string;
  readonly rawPath: string;
  readonly isHtmlNavigation?: boolean;
  /** Set only when the Worker has already routed to its narrow gate endpoint. */
  readonly route?: ServingRoute;
}

/** Object form accepted by resolveServing and resolveServingRequest. */
export interface ServingResolverInput {
  readonly request: ServingRequest;
  readonly manifest: ManifestEntryLookup;
  readonly flags?: ServingProjectFlags;
}

/** Request-path rejection reasons owned by the HTTP request-path domain. */
export type ServingPathRejectionReason =
  | "invalid_path"
  | "malformed_encoding"
  | "encoded_separator"
  | "nul_byte"
  | "backslash"
  | "empty_segment"
  | "dot_segment"
  | "dot_prefixed_segment";

/**
 * A successfully decoded request path. `rawPathname` and `decodedPathname`
 * make the one-way raw-to-decoded boundary visible to callers and tests.
 * Query text is intentionally opaque and is not percent-decoded here.
 */
export interface DecodedRequestPath {
  readonly rawPath: string;
  readonly rawPathname: string;
  readonly decodedPathname: string;
  readonly query: string;
  readonly canonicalPath: CanonicalPath | undefined;
  readonly hasTrailingSlash: boolean;
}

export type RequestPathResult = ValidationResult<DecodedRequestPath, ServingPathRejectionReason>;

export type ServingHeaders = Readonly<Record<string, string>>;

interface ServingDecisionMetadata {
  readonly headers: ServingHeaders;
  readonly cachePolicy: ServingCachePolicy;
  /** Shared-cache bypass is explicit because noStore also affects the Worker. */
  readonly cacheBypass: boolean;
}

export type ServingArtifactSource =
  "exact" | "root_index" | "directory_index" | "spa_fallback" | "custom_404";

export interface ServeArtifactDecision extends ServingDecisionMetadata {
  readonly kind: "serve";
  readonly status: 200 | 404;
  readonly path: CanonicalPath;
  readonly entry: ManifestEntry;
  readonly contentType: string;
  readonly source: ServingArtifactSource;
}

export interface RedirectDecision extends ServingDecisionMetadata {
  readonly kind: "redirect";
  readonly status: 308;
  readonly location: string;
  readonly source: "directory_redirect";
}

export interface NotFoundDecision extends ServingDecisionMetadata {
  readonly kind: "not_found";
  readonly status: 404;
}

export interface MethodNotAllowedDecision extends ServingDecisionMetadata {
  readonly kind: "method_not_allowed";
  readonly status: 405;
  readonly allow: typeof SERVING_ALLOW_HEADER;
}

export interface RejectedPathDecision extends ServingDecisionMetadata {
  readonly kind: "rejected";
  readonly status: 404;
  readonly reason: ServingPathRejectionReason;
}

/** A gate-login POST is classified for the Worker but never resolved here. */
export interface PassThroughDecision extends ServingDecisionMetadata {
  readonly kind: "pass_through";
  readonly method: "POST";
  readonly route: "gate-login";
}

export type ServingDecision =
  | ServeArtifactDecision
  | RedirectDecision
  | NotFoundDecision
  | MethodNotAllowedDecision
  | RejectedPathDecision
  | PassThroughDecision;

const NOSNIFF_HEADER = "nosniff" as const;

function isGated(flags: ServingProjectFlags): boolean {
  return flags.gated === true;
}

function metadata(
  flags: ServingProjectFlags,
  headers: Record<string, string>,
  cachePolicy: ServingCachePolicy,
): ServingDecisionMetadata {
  const gated = isGated(flags);
  const effectiveCachePolicy = gated ? "noStore" : cachePolicy;

  return {
    headers,
    cachePolicy: effectiveCachePolicy,
    cacheBypass: gated || effectiveCachePolicy === "noStore",
  };
}

function headersWithNosniff(contentType?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Content-Type-Options": NOSNIFF_HEADER,
  };

  if (contentType !== undefined) {
    headers["Content-Type"] = contentType;
  }

  return headers;
}

function contentTypeFor(entry: ManifestEntry): string {
  return entry.contentType || SERVING_DEFAULT_CONTENT_TYPE;
}

function canonicalConstant(path: string): CanonicalPath {
  const result = canonicalizePath(path);

  if (!result.ok) {
    throw new Error(`Invalid serving path constant: ${path} (${result.reason})`);
  }

  return result.value;
}

const ROOT_INDEX_PATH = canonicalConstant("index.html");
const ROOT_NOT_FOUND_PATH = canonicalConstant("404.html");

function splitRawPath(rawPath: string): { rawPathname: string; query: string } | undefined {
  const queryStart = rawPath.indexOf("?");

  if (queryStart === -1) {
    return { rawPathname: rawPath, query: "" };
  }

  return {
    rawPathname: rawPath.slice(0, queryStart),
    query: rawPath.slice(queryStart),
  };
}

/**
 * Decode and validate an HTTP request pathname exactly once.
 *
 * Encoded separators are rejected before decoding so `%2f`/`%5c` cannot turn
 * one manifest segment into a different path. Query text is returned as-is;
 * it participates in redirects but never in manifest lookup.
 */
export function decodeRequestPath(rawPath: string): RequestPathResult {
  const split = splitRawPath(rawPath);

  if (split === undefined || !split.rawPathname.startsWith("/")) {
    return { ok: false, reason: "invalid_path" };
  }

  if (/%(?:2f|5c)/i.test(split.rawPathname)) {
    return { ok: false, reason: "encoded_separator" };
  }

  let decodedPathname: string;

  try {
    decodedPathname = decodeURIComponent(split.rawPathname);
  } catch {
    return { ok: false, reason: "malformed_encoding" };
  }

  if (decodedPathname.includes("\0")) {
    return { ok: false, reason: "nul_byte" };
  }

  if (decodedPathname.includes("\\")) {
    return { ok: false, reason: "backslash" };
  }

  if (!decodedPathname.startsWith("/")) {
    return { ok: false, reason: "invalid_path" };
  }

  const isRoot = decodedPathname === "/";
  const hasTrailingSlash = !isRoot && decodedPathname.endsWith("/");
  const pathnameWithoutLeadingSlash = decodedPathname.slice(1);
  const relativePath = hasTrailingSlash
    ? pathnameWithoutLeadingSlash.slice(0, -1)
    : pathnameWithoutLeadingSlash;

  if (isRoot) {
    return {
      ok: true,
      value: {
        rawPath,
        rawPathname: split.rawPathname,
        decodedPathname,
        query: split.query,
        canonicalPath: undefined,
        hasTrailingSlash: false,
      },
    };
  }

  const segments = relativePath.split("/");

  if (segments.some((segment) => segment.length === 0)) {
    return { ok: false, reason: "empty_segment" };
  }

  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      return { ok: false, reason: "dot_segment" };
    }

    if (segment.startsWith(".")) {
      return { ok: false, reason: "dot_prefixed_segment" };
    }
  }

  const canonical = canonicalizePath(relativePath);

  if (!canonical.ok) {
    switch (canonical.reason) {
      case "empty_path":
        return { ok: false, reason: "invalid_path" };
      case "absolute_path":
        return { ok: false, reason: "invalid_path" };
      case "empty_segment":
        return { ok: false, reason: "empty_segment" };
      case "dot_segment":
      case "parent_segment":
        return { ok: false, reason: "dot_segment" };
      case "backslash":
        return { ok: false, reason: "backslash" };
      case "nul_byte":
        return { ok: false, reason: "nul_byte" };
    }
  }

  return {
    ok: true,
    value: {
      rawPath,
      rawPathname: split.rawPathname,
      decodedPathname,
      query: split.query,
      canonicalPath: canonical.value,
      hasTrailingSlash,
    },
  };
}

/** Alias that makes the raw-to-canonical boundary discoverable by name. */
export const canonicalizeRequestPath = decodeRequestPath;

function lookupPath(manifest: ManifestEntryLookup, path: CanonicalPath): ManifestEntry | undefined {
  return manifest.lookup(path);
}

function artifactDecision(
  flags: ServingProjectFlags,
  status: 200 | 404,
  path: CanonicalPath,
  entry: ManifestEntry,
  source: ServingArtifactSource,
): ServeArtifactDecision {
  const contentType = contentTypeFor(entry);

  return {
    kind: "serve",
    status,
    path,
    entry,
    contentType,
    source,
    ...metadata(flags, headersWithNosniff(contentType), "revalidate"),
  };
}

function notFoundDecision(flags: ServingProjectFlags): NotFoundDecision {
  return {
    kind: "not_found",
    status: 404,
    ...metadata(flags, headersWithNosniff(), "noStore"),
  };
}

function methodNotAllowedDecision(flags: ServingProjectFlags): MethodNotAllowedDecision {
  return {
    kind: "method_not_allowed",
    status: 405,
    allow: SERVING_ALLOW_HEADER,
    ...metadata(flags, { ...headersWithNosniff(), Allow: SERVING_ALLOW_HEADER }, "noStore"),
  };
}

function rejectedPathDecision(
  flags: ServingProjectFlags,
  reason: ServingPathRejectionReason,
): RejectedPathDecision {
  return {
    kind: "rejected",
    status: 404,
    reason,
    ...metadata(flags, headersWithNosniff(), "noStore"),
  };
}

function passThroughDecision(flags: ServingProjectFlags): PassThroughDecision {
  return {
    kind: "pass_through",
    method: "POST",
    route: "gate-login",
    ...metadata(flags, headersWithNosniff(), "noStore"),
  };
}

function directoryIndexPath(path: CanonicalPath): CanonicalPath {
  return canonicalConstant(`${path}/index.html`);
}

function redirectLocation(path: CanonicalPath, query: string): string {
  const encodedPath = path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `/${encodedPath}/${query}`;
}

/**
 * Resolve a validated request against exact manifest entries.
 *
 * Resolution order is exact file, root/directory index, directory redirect,
 * SPA fallback for explicit HTML navigations, then custom or platform 404.
 * A custom 404 therefore does not suppress an enabled SPA navigation: the
 * SPA rule is the more specific unmatched-navigation rule.
 */
export function resolveServingRequest(input: ServingResolverInput): ServingDecision;
export function resolveServingRequest(
  request: ServingRequest,
  manifest: ManifestEntryLookup,
  flags?: ServingProjectFlags,
): ServingDecision;
export function resolveServingRequest(
  requestOrInput: ServingRequest | ServingResolverInput,
  manifest?: ManifestEntryLookup,
  flags: ServingProjectFlags = {},
): ServingDecision {
  if ("request" in requestOrInput) {
    return resolveServingRequest(
      requestOrInput.request,
      requestOrInput.manifest,
      requestOrInput.flags,
    );
  }

  if (manifest === undefined) {
    throw new TypeError("resolveServingRequest requires a manifest lookup");
  }

  const request = requestOrInput;
  const method = request.method;

  if (method === "POST" && request.route === "gate-login") {
    return passThroughDecision(flags);
  }

  if (method !== "GET" && method !== "HEAD") {
    return methodNotAllowedDecision(flags);
  }

  const pathResult = decodeRequestPath(request.rawPath);

  if (!pathResult.ok) {
    return rejectedPathDecision(flags, pathResult.reason);
  }

  const { canonicalPath, hasTrailingSlash, query } = pathResult.value;

  if (canonicalPath !== undefined && !hasTrailingSlash) {
    const exactEntry = lookupPath(manifest, canonicalPath);

    if (exactEntry !== undefined) {
      return artifactDecision(flags, 200, canonicalPath, exactEntry, "exact");
    }
  }

  if (canonicalPath === undefined) {
    const rootIndex = lookupPath(manifest, ROOT_INDEX_PATH);

    if (rootIndex !== undefined) {
      return artifactDecision(flags, 200, ROOT_INDEX_PATH, rootIndex, "root_index");
    }
  } else if (hasTrailingSlash) {
    const directoryIndex = directoryIndexPath(canonicalPath);
    const directoryIndexEntry = lookupPath(manifest, directoryIndex);

    if (directoryIndexEntry !== undefined) {
      return artifactDecision(flags, 200, directoryIndex, directoryIndexEntry, "directory_index");
    }
  } else {
    const directoryIndex = directoryIndexPath(canonicalPath);
    const directoryIndexEntry = lookupPath(manifest, directoryIndex);

    if (directoryIndexEntry !== undefined) {
      const location = redirectLocation(canonicalPath, query);

      return {
        kind: "redirect",
        status: 308,
        location,
        source: "directory_redirect",
        ...metadata(flags, { ...headersWithNosniff(), Location: location }, "revalidate"),
      };
    }
  }

  if (flags.spaFallback === true && request.isHtmlNavigation === true) {
    const rootIndex = lookupPath(manifest, ROOT_INDEX_PATH);

    if (rootIndex !== undefined) {
      return artifactDecision(flags, 200, ROOT_INDEX_PATH, rootIndex, "spa_fallback");
    }
  }

  const customNotFound = lookupPath(manifest, ROOT_NOT_FOUND_PATH);

  if (customNotFound !== undefined) {
    return artifactDecision(flags, 404, ROOT_NOT_FOUND_PATH, customNotFound, "custom_404");
  }

  return notFoundDecision(flags);
}

/**
 * Resolver entry point accepting the grouped object form or a positional
 * request/manifest/flags tuple. The latter keeps the Worker call site close
 * to the contract described in the ADR.
 */
export function resolveServing(input: ServingResolverInput): ServingDecision;
export function resolveServing(
  request: ServingRequest,
  manifest: ManifestEntryLookup,
  flags?: ServingProjectFlags,
): ServingDecision;
export function resolveServing(
  method: string,
  rawPath: string,
  manifest: ManifestEntryLookup,
  flags?: ServingProjectFlags,
  requestOptions?: Pick<ServingRequest, "isHtmlNavigation" | "route">,
): ServingDecision;
export function resolveServing(
  inputOrMethod: ServingResolverInput | ServingRequest | string,
  rawPathOrManifest?: string | ManifestEntryLookup,
  manifestOrFlags?: ManifestEntryLookup | ServingProjectFlags,
  flags?: ServingProjectFlags,
  requestOptions?: Pick<ServingRequest, "isHtmlNavigation" | "route">,
): ServingDecision {
  if (typeof inputOrMethod === "string") {
    if (typeof rawPathOrManifest !== "string" || manifestOrFlags === undefined) {
      throw new TypeError("resolveServing requires method, raw path, and manifest lookup");
    }

    return resolveServingRequest(
      {
        method: inputOrMethod,
        rawPath: rawPathOrManifest,
        ...requestOptions,
      },
      manifestOrFlags as ManifestEntryLookup,
      flags,
    );
  }

  if ("request" in inputOrMethod) {
    return resolveServingRequest(
      inputOrMethod.request,
      inputOrMethod.manifest,
      inputOrMethod.flags,
    );
  }

  return resolveServingRequest(
    inputOrMethod,
    rawPathOrManifest as ManifestEntryLookup,
    manifestOrFlags as ServingProjectFlags,
  );
}
