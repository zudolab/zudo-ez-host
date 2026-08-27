import {
  MAX_CANONICAL_MANIFEST_BYTES,
  MANIFEST_SCHEMA_VERSION,
  SERVING_SEMANTICS_VERSION,
  encodeCanonical,
  generateMachineToken,
  hashMachineToken,
  MACHINE_TOKEN_PREFIX,
  MACHINE_TOKEN_VERSION,
  type Manifest,
  type ManifestEntry,
  type PublicationResolution,
} from "@zudo-ez-host/core";
import { env, exports } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import { describe, expect, inject, it, vi, beforeEach } from "vitest";

import { artifactManifestKey, contentKey } from "../../control/src/storage/keys.js";
import { createControlDatabase } from "../../control/src/db/database.js";
import { seedMachine, seedUser } from "../../control/src/db/seeds.js";
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
const REPUBLISH_SHA = "d".repeat(64);
const STALE_SHA = "e".repeat(64);
const WINNER_SHA = "f".repeat(64);
const MD5_EMPTY = "1B2M2Y8AsgTpgAmY7PhCfg==";
const E2E_OWNER_ID = "usr_public_e2e";
const E2E_OWNER_HANDLE = "e2eowner";
const E2E_MACHINE_ID = "mch_public_e2e";
const E2E_MACHINE_NAME = "E2E Mac";

type PublicTestEnv = PublicEnv & {
  readonly DB: D1Database;
  readonly CONTROL_HTTP: Fetcher;
};

const testEnv = env as PublicTestEnv;

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

function publicRequestFor(label: string, path: string, init?: RequestInit): Request {
  return new Request(`https://${label}.${PUBLIC_BASE_DOMAIN}${path}`, init);
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function e2eManifest(entries: readonly ManifestEntry[]): string {
  const bytes = encodeCanonical(manifest(entries));
  return JSON.stringify({
    manifestBase64: base64(bytes),
    transport: entries.map((entry) => ({
      contentHash: entry.sha256,
      contentType: entry.contentType,
      contentMd5: MD5_EMPTY,
    })),
  });
}

async function controlRequest(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return testEnv.CONTROL_HTTP.fetch(
    new Request(`https://control.test${path}`, { ...init, headers }),
  );
}

async function seedE2eMachine(): Promise<string> {
  const now = Date.now();
  const token = generateMachineToken();
  const database = createControlDatabase(testEnv.DB);
  const user = await seedUser(database, {
    id: E2E_OWNER_ID,
    canonicalHandle: E2E_OWNER_HANDLE,
    createdAt: now,
  });
  await seedMachine(database, {
    id: E2E_MACHINE_ID,
    userId: user.id,
    name: E2E_MACHINE_NAME,
    credentialHashSha256: await hashMachineToken(token),
    credentialPrefix: MACHINE_TOKEN_PREFIX,
    credentialVersion: MACHINE_TOKEN_VERSION,
    createdAt: now,
    expiresAt: now + 365 * 24 * 60 * 60 * 1_000,
  });
  return token;
}

async function prepareE2ePublication(
  token: string,
  projectId: string,
  entries: readonly ManifestEntry[],
): Promise<{
  readonly attempt: { readonly id: string };
  readonly contracts: readonly {
    readonly contentHash: string;
    readonly key: string;
    readonly sizeBytes: number;
    readonly uploadUrl: string;
  }[];
}> {
  const body = e2eManifest(entries);
  const response = await controlRequest(token, `/api/projects/${projectId}/publish/prepare`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  expect(response.status).toBe(201);
  const result = (await response.json()) as {
    attempt: { id: string };
    contracts: {
      contracts: readonly {
        contentHash: string;
        key: string;
        sizeBytes: number;
        uploadUrl: string;
      }[];
    };
  };
  return { attempt: result.attempt, contracts: result.contracts.contracts };
}

async function uploadAndVerifyE2e(
  token: string,
  projectId: string,
  prepared: Awaited<ReturnType<typeof prepareE2ePublication>>,
  contents: Readonly<Record<string, string>>,
): Promise<void> {
  for (const contract of prepared.contracts) {
    const content = contents[contract.contentHash];
    if (content === undefined) {
      throw new Error(`Missing test content for ${contract.contentHash}`);
    }
    await testEnv.ARTIFACTS.put(contract.key, content);
    expect(contract.uploadUrl).toMatch(/^https:\/\/upload\.test\//);
  }

  const response = await controlRequest(
    token,
    `/api/projects/${projectId}/publish/${prepared.attempt.id}/verify`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        objects: prepared.contracts.map((contract) => ({
          contentHash: contract.contentHash,
          expectedSize: contract.sizeBytes,
        })),
      }),
    },
  );
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    ok: true,
    verifiedCount: prepared.contracts.length,
    rejectedCount: 0,
  });
}

async function commitE2ePublication(
  token: string,
  projectId: string,
  attemptId: string,
): Promise<Response> {
  return controlRequest(token, `/api/projects/${projectId}/publish/commit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ attemptId }),
  });
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

  it("rejects an oversized promoted manifest before buffering its body", async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const artifacts = {
      get: vi.fn(async () => ({
        size: MAX_CANONICAL_MANIFEST_BYTES + 1,
        arrayBuffer,
      })),
      head: vi.fn(async () => null),
    } as unknown as ReadOnlyR2Bucket;
    const handler = createPublicHandler({
      publicBaseDomain: PUBLIC_BASE_DOMAIN,
      resolver: fixtureResolver(),
      artifacts,
      cache: new MemoryCache(),
    });

    const response = await handler.fetch(publicRequest("/"));

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("Not found");
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("uses an artifact/hash/path cache key rather than a vanity host", () => {
    const key = createArtifactCacheKey(PROJECT_ID, ARTIFACT_HASH, "dir/index.html");

    expect(key.method).toBe("GET");
    expect(key.url).toContain(encodeURIComponent(ARTIFACT_HASH));
    expect(key.url).toContain("dir/index.html");
    expect(key.url).not.toContain(PUBLIC_LABEL);
  });
});

describe("public Worker publication topology", () => {
  beforeEach(async () => {
    await reset();
    await applyD1Migrations(testEnv.DB, inject("controlMigrations"), "control_d1_migrations");
  });

  it("publishes, reuses, rejects stale commits, and serves through the real resolver", async () => {
    const token = await seedE2eMachine();
    const registration = await controlRequest(token, "/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "site", displayName: "E2E site" }),
    });
    expect(registration.status).toBe(201);
    expect(registration.headers.get("Cache-Control")).toBe("no-store");
    const registered = (await registration.json()) as {
      project: { id: string; status: string };
      hostname: string;
    };
    const projectId = registered.project.id;
    const publicLabel = registered.hostname;
    expect(registered.project.status).toBe("active");
    expect(publicLabel).toBe(`site--${E2E_OWNER_HANDLE}`);

    const firstEntry = {
      path: "index.html",
      sha256: ROOT_SHA,
      size: 7,
      contentType: "text/html",
    } satisfies ManifestEntry;
    const firstEntries = [
      firstEntry,
      { path: "assets/app.js", sha256: DIRECTORY_SHA, size: 6, contentType: "text/javascript" },
    ] satisfies readonly ManifestEntry[];
    const first = await prepareE2ePublication(token, projectId, firstEntries);
    expect(first.contracts.map((contract) => contract.contentHash)).toEqual([
      ROOT_SHA,
      DIRECTORY_SHA,
    ]);
    await uploadAndVerifyE2e(token, projectId, first, {
      [ROOT_SHA]: "home-v1",
      [DIRECTORY_SHA]: "app-v1",
    });

    const firstCommitResponse = await commitE2ePublication(token, projectId, first.attempt.id);
    expect(firstCommitResponse.status).toBe(200);
    const firstCommit = (await firstCommitResponse.json()) as {
      publication: {
        generation: number;
        artifactHash: string;
        logicalBytes: number;
        physicalBytes: number;
      };
      committed: boolean;
    };
    expect(firstCommit).toMatchObject({
      committed: true,
      publication: { generation: 1, logicalBytes: 13, physicalBytes: 13 },
    });

    const firstCounters = await testEnv.DB.prepare(
      `SELECT active_logical_bytes AS activeLogicalBytes,
              reserved_active_delta_bytes AS reservedActiveDeltaBytes,
              retained_staged_physical_bytes AS retainedStagedPhysicalBytes,
              reserved_physical_upload_bytes AS reservedPhysicalUploadBytes
       FROM user WHERE id = ?`,
    )
      .bind(E2E_OWNER_ID)
      .first<{
        activeLogicalBytes: number;
        reservedActiveDeltaBytes: number;
        retainedStagedPhysicalBytes: number;
        reservedPhysicalUploadBytes: number;
      }>();
    expect(firstCounters).toEqual({
      activeLogicalBytes: 13,
      reservedActiveDeltaBytes: 0,
      retainedStagedPhysicalBytes: 13,
      reservedPhysicalUploadBytes: 0,
    });

    const firstServed = await exports.default.fetch(publicRequestFor(publicLabel, "/"));
    expect(firstServed.status).toBe(200);
    await expect(firstServed.text()).resolves.toBe("home-v1");
    expect(firstServed.headers.get("Content-Type")).toBe("text/html");

    const rpcResolution = await (
      testEnv.CONTROL as unknown as PublicationResolverBinding
    ).resolvePublication(publicLabel);
    expect(rpcResolution).toMatchObject({
      projectId,
      artifactHash: firstCommit.publication.artifactHash,
      servingFlags: { spaFallback: false, gated: false },
    });

    const secondEntries = [
      firstEntry,
      { path: "about.html", sha256: REPUBLISH_SHA, size: 8, contentType: "text/html" },
    ] satisfies readonly ManifestEntry[];
    const second = await prepareE2ePublication(token, projectId, secondEntries);
    expect(second.contracts.map((contract) => contract.contentHash)).toEqual([REPUBLISH_SHA]);
    await uploadAndVerifyE2e(token, projectId, second, { [REPUBLISH_SHA]: "about-v2" });

    const secondCommitResponse = await commitE2ePublication(token, projectId, second.attempt.id);
    expect(secondCommitResponse.status).toBe(200);
    await expect(secondCommitResponse.json()).resolves.toMatchObject({
      committed: true,
      publication: { generation: 2, logicalBytes: 15, physicalBytes: 15 },
    });
    const republished = await exports.default.fetch(publicRequestFor(publicLabel, "/about.html"));
    expect(republished.status).toBe(200);
    await expect(republished.text()).resolves.toBe("about-v2");

    const secondCounters = await testEnv.DB.prepare(
      `SELECT active_logical_bytes AS activeLogicalBytes,
              reserved_active_delta_bytes AS reservedActiveDeltaBytes,
              retained_staged_physical_bytes AS retainedStagedPhysicalBytes,
              reserved_physical_upload_bytes AS reservedPhysicalUploadBytes
       FROM user WHERE id = ?`,
    )
      .bind(E2E_OWNER_ID)
      .first<{
        activeLogicalBytes: number;
        reservedActiveDeltaBytes: number;
        retainedStagedPhysicalBytes: number;
        reservedPhysicalUploadBytes: number;
      }>();
    expect(secondCounters).toEqual({
      activeLogicalBytes: 15,
      reservedActiveDeltaBytes: 0,
      retainedStagedPhysicalBytes: 21,
      reservedPhysicalUploadBytes: 0,
    });

    const stale = await prepareE2ePublication(token, projectId, [
      firstEntry,
      { path: "stale.html", sha256: STALE_SHA, size: 8, contentType: "text/html" },
    ]);
    const winner = await prepareE2ePublication(token, projectId, [
      firstEntry,
      { path: "winner.html", sha256: WINNER_SHA, size: 9, contentType: "text/html" },
    ]);
    await uploadAndVerifyE2e(token, projectId, winner, { [WINNER_SHA]: "winner-v3" });
    const winnerCommitResponse = await commitE2ePublication(token, projectId, winner.attempt.id);
    expect(winnerCommitResponse.status).toBe(200);
    await expect(winnerCommitResponse.json()).resolves.toMatchObject({
      committed: true,
      publication: { generation: 3, machineName: E2E_MACHINE_NAME },
    });

    const staleCommitResponse = await commitE2ePublication(token, projectId, stale.attempt.id);
    expect(staleCommitResponse.status).toBe(409);
    await expect(staleCommitResponse.json()).resolves.toEqual({
      error: "publication_commit_failed",
      reason: "publication_head_changed",
      generation: 3,
      machineName: E2E_MACHINE_NAME,
    });

    await testEnv.DB.prepare("UPDATE projects SET status = 'taken_down' WHERE id = ?")
      .bind(projectId)
      .run();
    const takenDown = await exports.default.fetch(publicRequestFor(publicLabel, "/"));
    expect(takenDown.status).toBe(404);
    await expect(takenDown.text()).resolves.toBe("Not found");
  });
});
