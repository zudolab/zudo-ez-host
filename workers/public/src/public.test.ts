import {
  MANIFEST_SCHEMA_VERSION,
  SERVING_SEMANTICS_VERSION,
  encodeCanonical,
  type Manifest,
  type ManifestEntry,
  type PublicationResolution,
} from "@zudo-ez-host/core";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import { artifactManifestKey, contentKey } from "../../control/src/storage/keys.js";
import {
  createReadOnlyR2Facade,
  type ReadOnlyR2Bucket,
} from "../../control/src/storage/readonly.js";
import {
  cacheControlFor,
  createArtifactCacheKey,
  createArtifactEtag,
  createPublicHandler,
  parsePublicHost,
  type PublicationResolverBinding,
} from "./index.js";

const PUBLIC_BASE_DOMAIN = "public.test";
const PUBLIC_LABEL = "site--owner";
const PROJECT_ID = "project-public-fixture";
const ARTIFACT_HASH = "artifact-public-fixture";
const ROOT_SHA = "a".repeat(64);
const DIRECTORY_SHA = "b".repeat(64);
const NOT_FOUND_SHA = "c".repeat(64);

class MemoryCache {
  readonly values = new Map<string, Response>();
  matchCount = 0;
  putCount = 0;

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    this.matchCount += 1;
    const key =
      request instanceof URL
        ? request.toString()
        : typeof request === "string"
          ? request
          : request.url;
    const response = this.values.get(key);
    return response?.clone();
  }

  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    this.putCount += 1;
    const key =
      request instanceof URL
        ? request.toString()
        : typeof request === "string"
          ? request
          : request.url;
    this.values.set(key, response.clone());
  }
}

function entry(path: string, sha256: string, contentType = "text/html"): ManifestEntry {
  return { path, sha256, size: 0, contentType };
}

function manifest(entries: readonly ManifestEntry[]): Manifest {
  return {
    version: MANIFEST_SCHEMA_VERSION,
    servingSemanticsVersion: SERVING_SEMANTICS_VERSION,
    entries,
  };
}

function publicRequest(path: string, init?: RequestInit): Request {
  return new Request(`https://${PUBLIC_LABEL}.${PUBLIC_BASE_DOMAIN}${path}`, init);
}

function fixtureResolution(): Exclude<PublicationResolution, null> {
  return {
    projectId: PROJECT_ID,
    artifactHash: ARTIFACT_HASH,
    servingFlags: { spaFallback: false, gated: false },
  };
}

async function seedArtifact(entries: readonly ManifestEntry[]): Promise<void> {
  await env.ARTIFACTS.put(
    artifactManifestKey(PROJECT_ID, ARTIFACT_HASH),
    encodeCanonical(manifest(entries)),
  );
  await env.ARTIFACTS.put(contentKey(PROJECT_ID, ROOT_SHA), "root");
  await env.ARTIFACTS.put(contentKey(PROJECT_ID, DIRECTORY_SHA), "directory");
  await env.ARTIFACTS.put(contentKey(PROJECT_ID, NOT_FOUND_SHA), "not found");
}

function fixtureResolver(): PublicationResolverBinding {
  return {
    resolvePublication: vi.fn(async (projectLabel: string) =>
      projectLabel === PUBLIC_LABEL ? fixtureResolution() : null,
    ),
  };
}

describe("public Worker", () => {
  it("uses the real local R2 binding", async () => {
    await env.ARTIFACTS.put("public-binding-probe", "r2-ok");
    const object = await env.ARTIFACTS.get("public-binding-probe");

    await expect(object?.text()).resolves.toBe("r2-ok");
  });

  it("calls the named control entrypoint over a real service binding", async () => {
    const response = await exports.default.fetch(
      "https://public.test/resolution/project-rpc-smoke",
    );
    const resolution = (await response.json()) as PublicationResolution;

    expect(response.status).toBe(200);
    expect(resolution).toEqual({
      projectId: "project-rpc-smoke",
      artifactHash: "sha256:publication-resolution-fixture",
      servingFlags: { spaFallback: true, gated: false },
    });
  });

  it("serves an authorized root index with policy headers and a streamed body", async () => {
    await seedArtifact([
      { ...entry("index.html", ROOT_SHA), size: 4 },
      { ...entry("dir/index.html", DIRECTORY_SHA), size: 9 },
      { ...entry("404.html", NOT_FOUND_SHA), size: 9 },
    ]);
    const cache = new MemoryCache();
    const resolver = fixtureResolver();
    const handler = createPublicHandler({
      publicBaseDomain: PUBLIC_BASE_DOMAIN,
      resolver,
      artifacts: createReadOnlyR2Facade(env.ARTIFACTS),
      cache,
    });

    const response = await handler.fetch(publicRequest("/"));

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("root");
    expect(response.headers.get("Content-Type")).toBe("text/html");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("ETag")).toBe(createArtifactEtag(ARTIFACT_HASH, "index.html"));
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate");
    expect(resolver.resolvePublication).toHaveBeenCalledWith(PUBLIC_LABEL);
    expect(cache.matchCount).toBe(1);
    expect(cache.putCount).toBe(1);
  });

  it("authorizes again before a cache hit and avoids a second content read", async () => {
    await seedArtifact([{ ...entry("index.html", ROOT_SHA), size: 4 }]);
    const cache = new MemoryCache();
    const resolver = fixtureResolver();
    const handler = createPublicHandler({
      publicBaseDomain: PUBLIC_BASE_DOMAIN,
      resolver,
      artifacts: createReadOnlyR2Facade(env.ARTIFACTS),
      cache,
    });

    await expect((await handler.fetch(publicRequest("/"))).text()).resolves.toBe("root");
    const second = await handler.fetch(publicRequest("/"));

    expect(second.status).toBe(200);
    await expect(second.text()).resolves.toBe("root");
    expect(resolver.resolvePublication).toHaveBeenCalledTimes(2);
    expect(cache.matchCount).toBe(2);
    expect(cache.putCount).toBe(1);
  });

  it("uses the real workerd Cache API only after resolver authorization", async () => {
    await seedArtifact([{ ...entry("index.html", ROOT_SHA), size: 4 }]);
    const runtimeCache = (globalThis.caches as CacheStorage & { default: Cache }).default;
    const cacheKey = createArtifactCacheKey(PROJECT_ID, ARTIFACT_HASH, "index.html");
    await runtimeCache.delete(cacheKey);
    const resolver = fixtureResolver();
    const handler = createPublicHandler({
      publicBaseDomain: PUBLIC_BASE_DOMAIN,
      resolver,
      artifacts: createReadOnlyR2Facade(env.ARTIFACTS),
    });

    const first = await handler.fetch(publicRequest("/"));
    const second = await handler.fetch(publicRequest("/"));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expect(first.text()).resolves.toBe("root");
    await expect(second.text()).resolves.toBe("root");
    expect(resolver.resolvePublication).toHaveBeenCalledTimes(2);
  });

  it("canonicalizes directories with 308 and preserves the query string", async () => {
    await seedArtifact([{ ...entry("dir/index.html", DIRECTORY_SHA), size: 9 }]);
    const handler = createPublicHandler({
      publicBaseDomain: PUBLIC_BASE_DOMAIN,
      resolver: fixtureResolver(),
      artifacts: createReadOnlyR2Facade(env.ARTIFACTS),
      cache: new MemoryCache(),
    });

    const response = await handler.fetch(publicRequest("/dir?from=home%2Fnav"));

    expect(response.status).toBe(308);
    expect(response.headers.get("Location")).toBe("/dir/?from=home%2Fnav");
  });

  it("keeps file lookup case-sensitive, serves custom 404, and rejects methods", async () => {
    await seedArtifact([
      { ...entry("about.html", ROOT_SHA), size: 4 },
      { ...entry("404.html", NOT_FOUND_SHA), size: 9 },
    ]);
    const handler = createPublicHandler({
      publicBaseDomain: PUBLIC_BASE_DOMAIN,
      resolver: fixtureResolver(),
      artifacts: createReadOnlyR2Facade(env.ARTIFACTS),
      cache: new MemoryCache(),
    });

    const missingCase = await handler.fetch(publicRequest("/About"));
    expect(missingCase.status).toBe(404);
    await expect(missingCase.text()).resolves.toBe("not found");

    const exactCustom404 = await handler.fetch(publicRequest("/404.html"));
    expect(exactCustom404.status).toBe(200);
    await expect(exactCustom404.text()).resolves.toBe("not found");

    const method = await handler.fetch(publicRequest("/about.html", { method: "PUT" }));
    expect(method.status).toBe(405);
    expect(method.headers.get("Allow")).toBe("GET, HEAD");
  });

  it("returns an empty HEAD body while retaining artifact headers", async () => {
    await seedArtifact([{ ...entry("dir/index.html", DIRECTORY_SHA), size: 9 }]);
    const handler = createPublicHandler({
      publicBaseDomain: PUBLIC_BASE_DOMAIN,
      resolver: fixtureResolver(),
      artifacts: createReadOnlyR2Facade(env.ARTIFACTS),
      cache: new MemoryCache(),
    });

    const response = await handler.fetch(publicRequest("/dir/", { method: "HEAD" }));

    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(response.headers.get("Content-Type")).toBe("text/html");
    expect(response.headers.get("Content-Length")).toBe("9");
    expect(response.headers.get("ETag")).toBe(createArtifactEtag(ARTIFACT_HASH, "dir/index.html"));
  });

  it("maps every cache policy category", () => {
    expect(cacheControlFor({ cachePolicy: "immutableCandidate" })).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(cacheControlFor({ cachePolicy: "revalidate" })).toBe(
      "public, max-age=0, must-revalidate",
    );
    expect(cacheControlFor({ cachePolicy: "noStore" })).toBe("no-store");
  });

  it("keeps the deferred SPA fallback seam hard-off", async () => {
    await seedArtifact([{ ...entry("index.html", ROOT_SHA), size: 4 }]);
    const handler = createPublicHandler({
      publicBaseDomain: PUBLIC_BASE_DOMAIN,
      resolver: {
        resolvePublication: vi.fn(async () => ({
          ...fixtureResolution(),
          servingFlags: { spaFallback: true, gated: false },
        })),
      },
      artifacts: createReadOnlyR2Facade(env.ARTIFACTS),
      cache: new MemoryCache(),
    });

    const response = await handler.fetch(
      publicRequest("/missing", { headers: { Accept: "text/html" } }),
    );

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("Not found");
  });

  it("rejects hosts outside the configured suffix or with nested labels", async () => {
    expect(parsePublicHost(`${PUBLIC_LABEL}.${PUBLIC_BASE_DOMAIN}`, PUBLIC_BASE_DOMAIN)).toBe(
      PUBLIC_LABEL,
    );
    expect(
      parsePublicHost(`nested.${PUBLIC_LABEL}.${PUBLIC_BASE_DOMAIN}`, PUBLIC_BASE_DOMAIN),
    ).toBe(undefined);
    expect(parsePublicHost(`${PUBLIC_LABEL}.other.test`, PUBLIC_BASE_DOMAIN)).toBeUndefined();
  });

  it("does not touch cache or R2 for an unknown host resolution", async () => {
    let getCount = 0;
    let headCount = 0;
    let cacheMatchCount = 0;
    let cachePutCount = 0;
    const artifacts: ReadOnlyR2Bucket = {
      async get() {
        getCount += 1;
        return null;
      },
      async head() {
        headCount += 1;
        return null;
      },
    };
    const resolver: PublicationResolverBinding = {
      resolvePublication: vi.fn(async () => null),
    };
    const cache = {
      async match() {
        cacheMatchCount += 1;
        return undefined;
      },
      async put() {
        cachePutCount += 1;
      },
    };
    const handler = createPublicHandler({
      publicBaseDomain: PUBLIC_BASE_DOMAIN,
      resolver,
      artifacts,
      cache,
    });

    const response = await handler.fetch(publicRequest("/"));

    expect(response.status).toBe(404);
    expect(resolver.resolvePublication).toHaveBeenCalledWith(PUBLIC_LABEL);
    expect(getCount).toBe(0);
    expect(headCount).toBe(0);
    expect(cacheMatchCount).toBe(0);
    expect(cachePutCount).toBe(0);
  });

  it("uses an artifact/hash/path cache key rather than a vanity host", () => {
    const key = createArtifactCacheKey(PROJECT_ID, ARTIFACT_HASH, "dir/index.html");

    expect(key.method).toBe("GET");
    expect(key.url).toContain(encodeURIComponent(ARTIFACT_HASH));
    expect(key.url).toContain("dir/index.html");
    expect(key.url).not.toContain(PUBLIC_LABEL);
  });
});
