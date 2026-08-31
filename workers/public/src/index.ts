import type {
  ManifestEntryLookup,
  PublicationResolution,
  ReadOnlyR2Bucket,
  ServingDecision,
} from "@zudo-ez-host/core";
import {
  MAX_CANONICAL_MANIFEST_BYTES,
  artifactManifestKey,
  createManifestLookup,
  createReadOnlyR2Facade,
  decodeManifest,
  parseLabel,
  resolveServing,
  contentKey,
} from "@zudo-ez-host/core";

/** The narrow RPC surface consumed by the public responder. */
export interface PublicationResolverBinding {
  resolvePublication(projectLabel: string): Promise<PublicationResolution>;
}

/** Dependencies used by the serving handler, intentionally easy to fake in tests. */
export interface PublicHandlerDependencies {
  readonly publicBaseDomain: string;
  readonly resolver: PublicationResolverBinding;
  readonly artifacts: ReadOnlyR2Bucket;
  readonly cache?: Pick<Cache, "match" | "put">;
  readonly logDiagnostic?: (diagnostic: PublicServingDiagnostic) => void;
}

/** A handler returned by {@link createPublicHandler}. */
export interface PublicRequestHandler {
  fetch(request: Request, ctx?: ExecutionContext): Promise<Response>;
}

const PLATFORM_NOT_FOUND_BODY = "Not found" as const;
const PUBLIC_CACHE_ORIGIN = "https://zudo-ez-host-artifact-cache.invalid" as const;
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable" as const;
const REVALIDATE_CACHE_CONTROL = "public, max-age=0, must-revalidate" as const;
const NO_STORE_CACHE_CONTROL = "no-store" as const;
type HttpServingDecision = Extract<ServingDecision, { status: number }>;

export type PublicServingFailureCause =
  | "publication_resolver_error"
  | "publication_resolution_invalid"
  | "gate_verification_unavailable"
  | "manifest_read_error"
  | "manifest_missing"
  | "manifest_oversized"
  | "manifest_body_read_error"
  | "manifest_invalid"
  | "manifest_unsafe_content_type"
  | "path_rejected"
  | "path_not_found"
  | "content_metadata_read_error"
  | "content_read_error"
  | "content_missing"
  | "serving_resolution_error";

/** Structured, server-side-only failure detail for the public serving path. */
export interface PublicServingDiagnostic {
  readonly event: "public_serving_failure";
  readonly cause: PublicServingFailureCause;
  readonly pathRejectionReason?: Extract<ServingDecision, { kind: "rejected" }>["reason"];
}

function emitDiagnostic(
  dependencies: PublicHandlerDependencies,
  cause: PublicServingFailureCause,
  pathRejectionReason?: PublicServingDiagnostic["pathRejectionReason"],
): void {
  const diagnostic: PublicServingDiagnostic = {
    event: "public_serving_failure",
    cause,
    ...(pathRejectionReason === undefined ? {} : { pathRejectionReason }),
  };

  try {
    if (dependencies.logDiagnostic === undefined) {
      // eslint-disable-next-line no-console -- Workers Logs indexes structured object fields.
      console.error(diagnostic);
    } else {
      dependencies.logDiagnostic(diagnostic);
    }
  } catch {
    // Diagnostics must never alter the intentionally uniform public response.
  }
}

function defaultCache(): Pick<Cache, "match" | "put"> {
  return (globalThis.caches as CacheStorage & { default: Cache }).default;
}

function platformNotFound(): Response {
  return new Response(PLATFORM_NOT_FOUND_BODY, {
    status: 404,
    headers: {
      "Cache-Control": NO_STORE_CACHE_CONTROL,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function validKeySegment(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0")
  );
}

function isPublicationResolution(value: unknown): value is Exclude<PublicationResolution, null> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as {
    projectId?: unknown;
    artifactHash?: unknown;
    servingFlags?: unknown;
  };

  if (!validKeySegment(candidate.projectId) || !validKeySegment(candidate.artifactHash)) {
    return false;
  }

  if (
    typeof candidate.servingFlags !== "object" ||
    candidate.servingFlags === null ||
    Array.isArray(candidate.servingFlags)
  ) {
    return false;
  }

  const flags = candidate.servingFlags as {
    spaFallback?: unknown;
    gated?: unknown;
  };

  return typeof flags.spaFallback === "boolean" && typeof flags.gated === "boolean";
}

function normalizeBaseDomain(value: string): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    return undefined;
  }

  const labels = value.split(".");
  if (
    labels.length < 2 ||
    labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))
  ) {
    return undefined;
  }

  return value.toLowerCase();
}

/**
 * Extract and validate the one public label preceding the configured domain.
 * DNS is case-insensitive, but suffix boundaries and label count are exact.
 */
export function parsePublicHost(host: string, publicBaseDomain: string): string | undefined {
  const baseDomain = normalizeBaseDomain(publicBaseDomain);
  if (baseDomain === undefined || typeof host !== "string" || host.length === 0) {
    return undefined;
  }

  const normalizedHost = host.toLowerCase();
  const suffix = `.${baseDomain}`;
  if (!normalizedHost.endsWith(suffix)) {
    return undefined;
  }

  const label = normalizedHost.slice(0, -suffix.length);
  if (label.length === 0 || label.includes(".")) {
    return undefined;
  }

  return parseLabel(label).ok ? label : undefined;
}

function hostForRequest(request: Request, url: URL): string | undefined {
  // Incoming Workers requests carry Host. The URL fallback keeps the handler
  // directly testable with a standards Request, which does not synthesize it.
  return request.headers.has("Host") ? (request.headers.get("Host") ?? undefined) : url.host;
}

function rawPathForRequest(request: Request, url: URL): string {
  // Read the request target from the serialized URL instead of round-tripping
  // URL.pathname, whose parser removes encoded dot segments. The URL object is
  // still authoritative for the already-validated origin and host.
  const rawTarget = request.url.startsWith(url.origin)
    ? request.url.slice(url.origin.length)
    : `${url.pathname}${url.search}`;
  return rawTarget.length === 0 ? "/" : rawTarget;
}

function isHtmlNavigation(request: Request): boolean {
  const fetchMode = request.headers.get("Sec-Fetch-Mode");
  if (fetchMode?.toLowerCase() === "navigate") {
    return true;
  }

  const accept = request.headers.get("Accept");
  if (accept === null) {
    return false;
  }

  return accept
    .split(",")
    .some((value) => value.split(";", 1)[0]?.trim().toLowerCase() === "text/html");
}

export function cacheControlFor(decision: Pick<ServingDecision, "cachePolicy">): string {
  switch (decision.cachePolicy) {
    case "immutableCandidate":
      return IMMUTABLE_CACHE_CONTROL;
    case "revalidate":
      return REVALIDATE_CACHE_CONTROL;
    case "noStore":
      return NO_STORE_CACHE_CONTROL;
  }
}

/**
 * ETags are opaque quoted strings. JSON string encoding preserves the useful
 * artifact-hash/path shape while escaping any unusual but valid manifest path.
 */
export function createArtifactEtag(artifactHash: string, path: string): string {
  return JSON.stringify(`${artifactHash}:${path}`);
}

function encodedPath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

/** Build a cache key that cannot collide across projects or artifact versions. */
export function createArtifactCacheKey(
  projectId: string,
  artifactHash: string,
  path: string,
): Request {
  const key = [
    "projects",
    encodeURIComponent(projectId),
    "artifacts",
    encodeURIComponent(artifactHash),
    encodedPath(path),
  ].join("/");

  return new Request(`${PUBLIC_CACHE_ORIGIN}/${key}`, { method: "GET" });
}

function responseHeaders(
  decision: HttpServingDecision,
  artifactHash?: string,
  contentLength?: number,
): Headers {
  const headers = new Headers(decision.headers);
  headers.set("Cache-Control", cacheControlFor(decision));

  if (decision.kind === "serve" && artifactHash !== undefined) {
    headers.set("ETag", createArtifactEtag(artifactHash, decision.path));
    if (contentLength !== undefined) {
      headers.set("Content-Length", String(contentLength));
    }
  }

  return headers;
}

function emptyResponse(response: Response): Response {
  return new Response(null, {
    status: response.status,
    headers: new Headers(response.headers),
  });
}

function responseForDecision(
  request: Request,
  decision: HttpServingDecision,
  body: ReadableStream | null,
  artifactHash?: string,
  contentLength?: number,
): Response {
  return new Response(request.method === "HEAD" ? null : body, {
    status: decision.status,
    headers: responseHeaders(decision, artifactHash, contentLength),
  });
}

type ManifestLoadResult =
  | { readonly ok: true; readonly manifest: ManifestEntryLookup }
  | {
      readonly ok: false;
      readonly cause:
        | "manifest_read_error"
        | "manifest_missing"
        | "manifest_oversized"
        | "manifest_body_read_error"
        | "manifest_invalid"
        | "manifest_unsafe_content_type";
    };

async function loadManifest(
  artifacts: ReadOnlyR2Bucket,
  projectId: string,
  artifactHash: string,
): Promise<ManifestLoadResult> {
  let object: Awaited<ReturnType<ReadOnlyR2Bucket["get"]>>;
  try {
    object = await artifacts.get(artifactManifestKey(projectId, artifactHash));
  } catch {
    return { ok: false, cause: "manifest_read_error" };
  }

  if (object === null) {
    return { ok: false, cause: "manifest_missing" };
  }
  if (object.size > MAX_CANONICAL_MANIFEST_BYTES) {
    return { ok: false, cause: "manifest_oversized" };
  }

  let bytes: ArrayBuffer;
  try {
    bytes = await object.arrayBuffer();
  } catch {
    return { ok: false, cause: "manifest_body_read_error" };
  }

  let decoded: ReturnType<typeof decodeManifest>;
  try {
    decoded = decodeManifest(new Uint8Array(bytes));
  } catch {
    return { ok: false, cause: "manifest_invalid" };
  }
  if (!decoded.ok) {
    return { ok: false, cause: "manifest_invalid" };
  }

  // Core validates the manifest field type and canonical bytes. HTTP header
  // safety is an edge concern, so reject control characters before constructing
  // a response header from stored metadata.
  if (decoded.value.entries.some((entry) => /[\u0000-\u001f\u007f]/.test(entry.contentType))) {
    return { ok: false, cause: "manifest_unsafe_content_type" };
  }

  return { ok: true, manifest: createManifestLookup(decoded.value) };
}

async function cachePut(
  cache: Pick<Cache, "match" | "put">,
  key: Request,
  response: Response,
  ctx: ExecutionContext | undefined,
): Promise<void> {
  const put = cache.put(key, response.clone());
  if (ctx === undefined) {
    await put;
    return;
  }

  ctx.waitUntil(put);
}

async function serveDecision(
  request: Request,
  dependencies: PublicHandlerDependencies,
  decision: ServingDecision,
  resolution: Exclude<PublicationResolution, null>,
  ctx: ExecutionContext | undefined,
): Promise<Response> {
  if (decision.kind !== "serve") {
    if (decision.kind === "redirect") {
      return new Response(null, {
        status: decision.status,
        headers: responseHeaders(decision),
      });
    }

    if (decision.kind === "method_not_allowed") {
      return new Response(null, {
        status: decision.status,
        headers: responseHeaders(decision),
      });
    }

    if (decision.kind === "pass_through") {
      return platformNotFound();
    }

    if (decision.kind === "rejected") {
      emitDiagnostic(dependencies, "path_rejected", decision.reason);
    } else {
      emitDiagnostic(dependencies, "path_not_found");
    }

    return new Response(PLATFORM_NOT_FOUND_BODY, {
      status: decision.status,
      headers: responseHeaders(decision),
    });
  }

  const cachePath = decision.status === 404 ? `__status-404/${decision.path}` : decision.path;
  const cacheKey = decision.cacheBypass
    ? undefined
    : createArtifactCacheKey(resolution.projectId, resolution.artifactHash, cachePath);
  const cache = cacheKey === undefined ? undefined : (dependencies.cache ?? defaultCache());

  if (cache !== undefined && cacheKey !== undefined) {
    try {
      const cached = await cache.match(cacheKey);
      if (cached !== undefined) {
        return request.method === "HEAD" ? emptyResponse(cached) : cached;
      }
    } catch {
      // A cache outage must not make an authorized R2 response unavailable.
    }
  }

  const key = contentKey(resolution.projectId, decision.entry.sha256);
  if (request.method === "HEAD") {
    let object: Awaited<ReturnType<ReadOnlyR2Bucket["head"]>>;
    try {
      object = await dependencies.artifacts.head(key);
    } catch {
      emitDiagnostic(dependencies, "content_metadata_read_error");
      return platformNotFound();
    }

    if (object === null) {
      emitDiagnostic(dependencies, "content_missing");
      return platformNotFound();
    }

    return responseForDecision(request, decision, null, resolution.artifactHash, object.size);
  }

  let object: Awaited<ReturnType<ReadOnlyR2Bucket["get"]>>;
  try {
    object = await dependencies.artifacts.get(key);
  } catch {
    emitDiagnostic(dependencies, "content_read_error");
    return platformNotFound();
  }

  if (object === null || object.body === undefined) {
    emitDiagnostic(dependencies, "content_missing");
    return platformNotFound();
  }

  const response = responseForDecision(
    request,
    decision,
    object.body,
    resolution.artifactHash,
    object.size,
  );
  if (cache !== undefined && cacheKey !== undefined) {
    try {
      await cachePut(cache, cacheKey, response, ctx);
    } catch {
      // Cache writes are an optimization; the streamed R2 response is valid.
    }
  }

  return response;
}

async function handlePublicRequest(
  request: Request,
  dependencies: PublicHandlerDependencies,
  ctx: ExecutionContext | undefined,
): Promise<Response> {
  const url = new URL(request.url);
  const host = hostForRequest(request, url);
  const projectLabel =
    host === undefined ? undefined : parsePublicHost(host, dependencies.publicBaseDomain);
  if (projectLabel === undefined) {
    return platformNotFound();
  }

  let resolution: PublicationResolution;
  try {
    resolution = await dependencies.resolver.resolvePublication(projectLabel);
  } catch {
    emitDiagnostic(dependencies, "publication_resolver_error");
    return platformNotFound();
  }

  // Null covers unknown, unpublished, and suspended hosts. Do not touch either
  // cache or R2 before this authorization result is known.
  if (resolution === null) {
    return platformNotFound();
  }
  if (!isPublicationResolution(resolution)) {
    emitDiagnostic(dependencies, "publication_resolution_invalid");
    return platformNotFound();
  }

  // Gate authorization is a separate future seam. Never expose a gated
  // publication while this secrets-free responder has no gate verifier.
  if (resolution.servingFlags.gated) {
    emitDiagnostic(dependencies, "gate_verification_unavailable");
    return platformNotFound();
  }

  const manifestResult = await loadManifest(
    dependencies.artifacts,
    resolution.projectId,
    resolution.artifactHash,
  );
  if (!manifestResult.ok) {
    emitDiagnostic(dependencies, manifestResult.cause);
    return platformNotFound();
  }

  try {
    const decision = resolveServing(
      {
        method: request.method,
        rawPath: rawPathForRequest(request, url),
        isHtmlNavigation: isHtmlNavigation(request),
      },
      manifestResult.manifest,
      // These contract fields are reserved for later gate/SPA work. The public
      // responder keeps both features hard-off until their dedicated seams land.
      { spaFallback: false, gated: false },
    );

    return await serveDecision(request, dependencies, decision, resolution, ctx);
  } catch {
    // A malformed stored MIME/path value must not turn into an edge exception.
    emitDiagnostic(dependencies, "serving_resolution_error");
    return platformNotFound();
  }
}

/** Build the public serving handler around a typed resolver and read-only R2 facade. */
export function createPublicHandler(dependencies: PublicHandlerDependencies): PublicRequestHandler {
  return {
    fetch(request, ctx) {
      return handlePublicRequest(request, dependencies, ctx);
    },
  };
}

/** Alias emphasizing that this factory returns a request handler, not an app server. */
export const createPublicRequestHandler = createPublicHandler;

type PublicWorkerEnv = Omit<PublicEnv, "CONTROL"> & {
  CONTROL: PublicationResolverBinding;
  PUBLIC_BASE_DOMAIN: string;
};

export default {
  async fetch(request, env, ctx): Promise<Response> {
    return createPublicHandler({
      publicBaseDomain: env.PUBLIC_BASE_DOMAIN,
      resolver: env.CONTROL,
      artifacts: createReadOnlyR2Facade(env.ARTIFACTS),
    }).fetch(request, ctx);
  },
} satisfies ExportedHandler<PublicWorkerEnv>;
