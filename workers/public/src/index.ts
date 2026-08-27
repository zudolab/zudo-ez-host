import type {
  ManifestEntryLookup,
  PublicationResolution,
  ServingDecision,
} from "@zudo-ez-host/core";
import {
  MAX_CANONICAL_MANIFEST_BYTES,
  createManifestLookup,
  decodeManifest,
  parseLabel,
  resolveServing,
} from "@zudo-ez-host/core";

import { artifactManifestKey, contentKey } from "../../control/src/storage/keys.js";
import {
  createReadOnlyR2Facade,
  type ReadOnlyR2Bucket,
} from "../../control/src/storage/readonly.js";

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

function responseHeaders(decision: HttpServingDecision, artifactHash?: string): Headers {
  const headers = new Headers(decision.headers);
  headers.set("Cache-Control", cacheControlFor(decision));

  if (decision.kind === "serve" && artifactHash !== undefined) {
    headers.set("ETag", createArtifactEtag(artifactHash, decision.path));
    headers.set("Content-Length", String(decision.entry.size));
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
): Response {
  return new Response(request.method === "HEAD" ? null : body, {
    status: decision.status,
    headers: responseHeaders(decision, artifactHash),
  });
}

async function loadManifest(
  artifacts: ReadOnlyR2Bucket,
  projectId: string,
  artifactHash: string,
): Promise<ManifestEntryLookup | undefined> {
  let object: Awaited<ReturnType<ReadOnlyR2Bucket["get"]>>;
  try {
    object = await artifacts.get(artifactManifestKey(projectId, artifactHash));
  } catch {
    return undefined;
  }

  if (object === null) {
    return undefined;
  }
  if (object.size > MAX_CANONICAL_MANIFEST_BYTES) {
    return undefined;
  }

  let bytes: ArrayBuffer;
  try {
    bytes = await object.arrayBuffer();
  } catch {
    return undefined;
  }

  const decoded = decodeManifest(new Uint8Array(bytes));
  if (!decoded.ok) {
    return undefined;
  }

  // Core validates the manifest field type and canonical bytes. HTTP header
  // safety is an edge concern, so reject control characters before constructing
  // a response header from stored metadata.
  if (decoded.value.entries.some((entry) => /[\u0000-\u001f\u007f]/.test(entry.contentType))) {
    return undefined;
  }

  return createManifestLookup(decoded.value);
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
      return platformNotFound();
    }

    if (object === null) {
      return platformNotFound();
    }

    return responseForDecision(request, decision, null, resolution.artifactHash);
  }

  let object: Awaited<ReturnType<ReadOnlyR2Bucket["get"]>>;
  try {
    object = await dependencies.artifacts.get(key);
  } catch {
    return platformNotFound();
  }

  if (object === null || object.body === undefined) {
    return platformNotFound();
  }

  const response = responseForDecision(request, decision, object.body, resolution.artifactHash);
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
    return platformNotFound();
  }

  // Null covers unknown, unpublished, and suspended hosts. Do not touch either
  // cache or R2 before this authorization result is known.
  if (resolution === null || !isPublicationResolution(resolution)) {
    return platformNotFound();
  }

  // Gate authorization is a separate future seam. Never expose a gated
  // publication while this secrets-free responder has no gate verifier.
  if (resolution.servingFlags.gated) {
    return platformNotFound();
  }

  const manifest = await loadManifest(
    dependencies.artifacts,
    resolution.projectId,
    resolution.artifactHash,
  );
  if (manifest === undefined) {
    return platformNotFound();
  }

  try {
    const decision = resolveServing(
      {
        method: request.method,
        rawPath: `${url.pathname}${url.search}`,
        isHtmlNavigation: isHtmlNavigation(request),
      },
      manifest,
      // These contract fields are reserved for later gate/SPA work. The public
      // responder keeps both features hard-off until their dedicated seams land.
      { spaFallback: false, gated: false },
    );

    return await serveDecision(request, dependencies, decision, resolution, ctx);
  } catch {
    // A malformed stored MIME/path value must not turn into an edge exception.
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
