import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { beforeEach, describe, expect, inject, it } from "vitest";

import { createControlDatabase } from "../../db/database.js";
import { seedMachine, seedProject, seedUser } from "../../db/seeds.js";
import { applyControlMigrations } from "../../db/testing.js";
import { MACHINE_AUTH_CONTEXT_KEY, type MachineAuthEnv } from "../../auth/index.js";
import { app } from "../../app.js";
import { contentKey, type UploadUrlRequest, type UploadUrlSigner } from "../../storage/index.js";
import {
  UPLOAD_CONTRACT_PAGE_SIZE,
  createPublicationContractsRouter,
  issueUploadContracts,
  refreshUploadContracts,
  verifyUploadBatch,
  type UploadContractTransport,
} from "./index.js";

const NOW = 2_000_000_000_000;
const YEAR_MS = 365 * 24 * 60 * 60 * 1_000;

interface SeedObject {
  readonly contentHash: string;
  readonly sizeBytes: number;
  readonly requiresUpload?: boolean;
  readonly verified?: boolean;
}

interface SeedAttemptOptions {
  readonly attemptId: string;
  readonly projectId: string;
  readonly userId: string;
  readonly machineId: string;
  readonly objects: readonly SeedObject[];
  readonly state?: "open" | "expired" | "committed" | "abandoned";
  readonly expiresAt?: number;
  readonly createdAt?: number;
}

async function seedOwner(
  userId: string,
  projectId: string,
  machineId: string,
  handle = userId.replace(/^usr_/, "owner"),
) {
  const database = createControlDatabase(env.DB);
  const user = await seedUser(database, { id: userId, canonicalHandle: handle, createdAt: NOW });
  const machine = await seedMachine(database, {
    id: machineId,
    userId,
    name: `${handle} Mac`,
    credentialHashSha256: `${machineId}-credential-hash`,
    credentialPrefix: "zeh_machine_v1_",
    credentialVersion: 1,
    createdAt: NOW,
    expiresAt: NOW + YEAR_MS,
  });
  const project = await seedProject(database, {
    id: projectId,
    userId,
    slug: `${handle}-site`,
    displayName: `${handle} site`,
    createdAt: NOW,
    updatedAt: NOW,
  });
  return { database, user, machine, project };
}

async function seedAttempt(options: SeedAttemptOptions) {
  const createdAt = options.createdAt ?? NOW;
  const expiresAt = options.expiresAt ?? NOW + 10 * 60 * 1_000;
  const state = options.state ?? "open";
  const reservedPhysicalUploadBytes = options.objects
    .filter((object) => object.requiresUpload ?? true)
    .filter((object) => !(object.verified ?? false))
    .reduce((total, object) => total + object.sizeBytes, 0);

  await env.DB.prepare(
    `INSERT INTO publication_attempts
       (id, project_id, user_id, machine_id, state, base_generation,
        base_logical_bytes, staged_manifest_r2_key, manifest_hash,
        logical_bytes, file_count, reserved_active_delta_bytes,
        reserved_physical_upload_bytes, created_at, expires_at, settled_at)
     VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, 0, ?, 0, ?, ?, ?, ?)`,
  )
    .bind(
      options.attemptId,
      options.projectId,
      options.userId,
      options.machineId,
      state,
      `projects/${options.projectId}/staged/${options.attemptId}`,
      `${options.attemptId}-manifest`,
      options.objects.length,
      reservedPhysicalUploadBytes,
      createdAt,
      expiresAt,
      state === "open" ? null : NOW + 1,
    )
    .run();

  if (reservedPhysicalUploadBytes > 0) {
    await env.DB.prepare(
      "UPDATE user SET reserved_physical_upload_bytes = reserved_physical_upload_bytes + ? WHERE id = ?",
    )
      .bind(reservedPhysicalUploadBytes, options.userId)
      .run();
  }

  await env.DB.batch(
    options.objects.map((object) =>
      env.DB.prepare(
        `INSERT INTO publication_attempt_objects
             (attempt_id, content_hash, size_bytes, requires_upload, verified)
           VALUES (?, ?, ?, ?, ?)`,
      ).bind(
        options.attemptId,
        object.contentHash,
        object.sizeBytes,
        (object.requiresUpload ?? true) ? 1 : 0,
        (object.verified ?? false) ? 1 : 0,
      ),
    ),
  );
}

function transportFor(objects: readonly SeedObject[]): readonly UploadContractTransport[] {
  return objects.map((object, index) => ({
    contentHash: object.contentHash,
    contentType: index % 2 === 0 ? "application/octet-stream" : "text/plain",
    contentMd5: `md5-${index}`,
  }));
}

function fakeSigner() {
  const calls: UploadUrlRequest[] = [];
  const signer: UploadUrlSigner = {
    async signUpload(input) {
      calls.push(input);
      return `https://upload.test/${encodeURIComponent(input.key)}`;
    },
  };
  return { calls, signer };
}

function md5Base64(bytes: ArrayBuffer): string {
  return globalThis.btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

beforeEach(async () => {
  await reset();
  await applyControlMigrations(env.DB, inject("controlMigrations"));
});

describe("paged upload contracts", () => {
  it("never signs more than the fixed page size and paginates deterministically", async () => {
    const owner = await seedOwner("usr_paging", "prj_paging", "mch_paging");
    const objects = Array.from({ length: UPLOAD_CONTRACT_PAGE_SIZE * 2 + 5 }, (_, index) => ({
      contentHash: `hash-${String(index).padStart(3, "0")}`,
      sizeBytes: index + 1,
    }));
    await seedAttempt({
      attemptId: "att_paging",
      projectId: owner.project.id,
      userId: owner.user.id,
      machineId: owner.machine.id,
      objects,
    });

    const { calls, signer } = fakeSigner();
    const first = await issueUploadContracts({
      database: env.DB,
      signer,
      ownerId: owner.user.id,
      projectId: owner.project.id,
      attemptId: "att_paging",
      transport: transportFor(objects),
      page: 0,
      now: NOW,
    });
    expect(first.contracts).toHaveLength(UPLOAD_CONTRACT_PAGE_SIZE);
    expect(calls).toHaveLength(UPLOAD_CONTRACT_PAGE_SIZE);
    expect(first.contracts[0]?.contentHash).toBe("hash-000");
    expect(first.contracts.at(-1)?.contentHash).toBe("hash-024");
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBe("hash-024");

    const second = await issueUploadContracts({
      database: env.DB,
      signer,
      ownerId: owner.user.id,
      projectId: owner.project.id,
      attemptId: "att_paging",
      transport: transportFor(objects),
      cursor: first.nextCursor,
      now: NOW,
    });
    expect(second.contracts).toHaveLength(UPLOAD_CONTRACT_PAGE_SIZE);
    expect(second.contracts[0]?.contentHash).toBe("hash-025");
    expect(second.contracts.at(-1)?.contentHash).toBe("hash-049");

    const third = await issueUploadContracts({
      database: env.DB,
      signer,
      ownerId: owner.user.id,
      projectId: owner.project.id,
      attemptId: "att_paging",
      cursor: second.nextCursor,
      transport: transportFor(objects),
      now: NOW,
    });
    expect(third.contracts).toHaveLength(5);
    expect(third.hasMore).toBe(false);
    expect(
      new Set(
        [...first.contracts, ...second.contracts, ...third.contracts].map(
          (item) => item.contentHash,
        ),
      ).size,
    ).toBe(objects.length);
    expect(calls).toHaveLength(objects.length);
  });

  it("omits hashes that became verified before a refresh", async () => {
    const owner = await seedOwner("usr_refresh", "prj_refresh", "mch_refresh");
    const objects = [
      { contentHash: "refresh-a", sizeBytes: 3 },
      { contentHash: "refresh-b", sizeBytes: 4 },
      { contentHash: "refresh-c", sizeBytes: 5 },
    ];
    await seedAttempt({
      attemptId: "att_refresh",
      projectId: owner.project.id,
      userId: owner.user.id,
      machineId: owner.machine.id,
      objects,
    });
    await env.ARTIFACTS.put(contentKey(owner.project.id, "refresh-a"), "one");

    const verification = await verifyUploadBatch({
      database: env.DB,
      bucket: env.ARTIFACTS,
      ownerId: owner.user.id,
      projectId: owner.project.id,
      attemptId: "att_refresh",
      requests: [{ contentHash: "refresh-a" }],
      now: NOW,
    });
    expect(verification.ok).toBe(true);

    const { signer } = fakeSigner();
    const refreshed = await refreshUploadContracts({
      database: env.DB,
      signer,
      ownerId: owner.user.id,
      projectId: owner.project.id,
      attemptId: "att_refresh",
      transport: transportFor(objects),
      now: NOW,
    });
    expect(refreshed.contracts.map((contract) => contract.contentHash)).toEqual([
      "refresh-b",
      "refresh-c",
    ]);
  });
});

describe("batched upload verification", () => {
  it("records valid objects and rejects missing, short, and oversized objects", async () => {
    const owner = await seedOwner("usr_verify", "prj_verify", "mch_verify");
    const objects = [
      { contentHash: "verify-valid", sizeBytes: 5 },
      { contentHash: "verify-short", sizeBytes: 5 },
      { contentHash: "verify-large", sizeBytes: 5 },
      { contentHash: "verify-missing", sizeBytes: 5 },
    ];
    await seedAttempt({
      attemptId: "att_verify",
      projectId: owner.project.id,
      userId: owner.user.id,
      machineId: owner.machine.id,
      objects,
    });
    await env.ARTIFACTS.put(contentKey(owner.project.id, "verify-valid"), "valid");
    await env.ARTIFACTS.put(contentKey(owner.project.id, "verify-short"), "no");
    await env.ARTIFACTS.put(contentKey(owner.project.id, "verify-large"), "too-large");
    const validHead = await env.ARTIFACTS.head(contentKey(owner.project.id, "verify-valid"));
    if (validHead?.checksums.md5 === undefined) {
      throw new Error("workerd R2 did not expose a checksum for the verification fixture");
    }

    const result = await verifyUploadBatch({
      database: env.DB,
      bucket: env.ARTIFACTS,
      ownerId: owner.user.id,
      projectId: owner.project.id,
      attemptId: "att_verify",
      requests: [
        { contentHash: "verify-valid", expectedMd5: md5Base64(validHead.checksums.md5) },
        { contentHash: "verify-short" },
        { contentHash: "verify-large" },
        { contentHash: "verify-missing" },
      ],
      now: NOW,
    });

    expect(result.ok).toBe(false);
    expect(result.verifiedCount).toBe(1);
    expect(result.results).toMatchObject([
      { contentHash: "verify-valid", verified: true },
      { contentHash: "verify-short", verified: false, reason: "size_mismatch" },
      { contentHash: "verify-large", verified: false, reason: "size_mismatch" },
      { contentHash: "verify-missing", verified: false, reason: "missing" },
    ]);

    await expect(
      env.DB.prepare(
        "SELECT size_bytes AS sizeBytes FROM verified_objects WHERE project_id = ? AND content_hash = ?",
      )
        .bind(owner.project.id, "verify-valid")
        .first(),
    ).resolves.toEqual({ sizeBytes: 5 });
    await expect(
      env.DB.prepare(
        "SELECT verified FROM publication_attempt_objects WHERE attempt_id = ? AND content_hash = ?",
      )
        .bind("att_verify", "verify-valid")
        .first(),
    ).resolves.toEqual({ verified: 1 });
    await expect(
      env.DB.prepare(
        "SELECT reserved_physical_upload_bytes AS reserved, retained_staged_physical_bytes AS retained FROM user WHERE id = ?",
      )
        .bind(owner.user.id)
        .first(),
    ).resolves.toEqual({ reserved: 15, retained: 5 });
    await expect(
      env.DB.prepare(
        "SELECT reserved_physical_upload_bytes AS reserved FROM publication_attempts WHERE id = ?",
      )
        .bind("att_verify")
        .first(),
    ).resolves.toEqual({ reserved: 15 });
  });

  it("rejects hashes outside the attempt without touching R2 or inventory", async () => {
    const owner = await seedOwner("usr_scope", "prj_scope", "mch_scope");
    const object = { contentHash: "scope-known", sizeBytes: 2 };
    await seedAttempt({
      attemptId: "att_scope",
      projectId: owner.project.id,
      userId: owner.user.id,
      machineId: owner.machine.id,
      objects: [object],
    });

    const result = await verifyUploadBatch({
      database: env.DB,
      bucket: env.ARTIFACTS,
      ownerId: owner.user.id,
      projectId: owner.project.id,
      attemptId: "att_scope",
      requests: [{ contentHash: "scope-foreign" }],
      now: NOW,
    });
    expect(result).toMatchObject({
      ok: false,
      results: [
        { contentHash: "scope-foreign", verified: false, reason: "content_not_in_attempt" },
      ],
    });
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM verified_objects").first(),
    ).resolves.toEqual({ count: 0 });
  });

  it("rejects a checksum mismatch and keeps successful verification idempotent", async () => {
    const owner = await seedOwner("usr_checksum", "prj_checksum", "mch_checksum");
    const object = { contentHash: "checksum-hash", sizeBytes: 5 };
    await seedAttempt({
      attemptId: "att_checksum",
      projectId: owner.project.id,
      userId: owner.user.id,
      machineId: owner.machine.id,
      objects: [object],
    });
    const key = contentKey(owner.project.id, object.contentHash);
    await env.ARTIFACTS.put(key, "valid");
    const head = await env.ARTIFACTS.head(key);
    if (head?.checksums.md5 === undefined) {
      throw new Error("workerd R2 did not expose a checksum for the checksum fixture");
    }

    await expect(
      verifyUploadBatch({
        database: env.DB,
        bucket: env.ARTIFACTS,
        ownerId: owner.user.id,
        projectId: owner.project.id,
        attemptId: "att_checksum",
        requests: [{ contentHash: object.contentHash, expectedMd5: "AAAAAAAAAAAAAAAAAAAAAA==" }],
        now: NOW,
      }),
    ).resolves.toMatchObject({
      ok: false,
      results: [{ verified: false, reason: "md5_mismatch" }],
    });
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM verified_objects").first(),
    ).resolves.toEqual({ count: 0 });

    const verified = await verifyUploadBatch({
      database: env.DB,
      bucket: env.ARTIFACTS,
      ownerId: owner.user.id,
      projectId: owner.project.id,
      attemptId: "att_checksum",
      requests: [{ contentHash: object.contentHash, expectedMd5: md5Base64(head.checksums.md5) }],
      now: NOW,
    });
    expect(verified).toMatchObject({ ok: true, verifiedCount: 1 });

    await expect(
      verifyUploadBatch({
        database: env.DB,
        bucket: env.ARTIFACTS,
        ownerId: owner.user.id,
        projectId: owner.project.id,
        attemptId: "att_checksum",
        requests: [{ contentHash: object.contentHash }],
        now: NOW,
      }),
    ).resolves.toMatchObject({
      ok: true,
      results: [{ verified: true, alreadyVerified: true }],
    });
    await expect(
      env.DB.prepare(
        "SELECT reserved_physical_upload_bytes AS reserved, retained_staged_physical_bytes AS retained FROM user WHERE id = ?",
      )
        .bind(owner.user.id)
        .first(),
    ).resolves.toEqual({ reserved: 0, retained: 5 });
  });

  it("does not double-move reservations when two verifiers race", async () => {
    const owner = await seedOwner("usr_race", "prj_race", "mch_race");
    const object = { contentHash: "race-hash", sizeBytes: 4 };
    await seedAttempt({
      attemptId: "att_race",
      projectId: owner.project.id,
      userId: owner.user.id,
      machineId: owner.machine.id,
      objects: [object],
    });
    await env.ARTIFACTS.put(contentKey(owner.project.id, object.contentHash), "race");

    const results = await Promise.all([
      verifyUploadBatch({
        database: env.DB,
        bucket: env.ARTIFACTS,
        ownerId: owner.user.id,
        projectId: owner.project.id,
        attemptId: "att_race",
        requests: [{ contentHash: object.contentHash }],
        now: NOW,
      }),
      verifyUploadBatch({
        database: env.DB,
        bucket: env.ARTIFACTS,
        ownerId: owner.user.id,
        projectId: owner.project.id,
        attemptId: "att_race",
        requests: [{ contentHash: object.contentHash }],
        now: NOW,
      }),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    await expect(
      env.DB.prepare(
        "SELECT COUNT(*) AS count FROM verified_objects WHERE project_id = ? AND content_hash = ?",
      )
        .bind(owner.project.id, object.contentHash)
        .first(),
    ).resolves.toEqual({ count: 1 });
    await expect(
      env.DB.prepare(
        "SELECT reserved_physical_upload_bytes AS reserved, retained_staged_physical_bytes AS retained FROM user WHERE id = ?",
      )
        .bind(owner.user.id)
        .first(),
    ).resolves.toEqual({ reserved: 0, retained: 4 });
  });
});

describe("attempt ownership and lifecycle", () => {
  it("rejects expired, closed, and foreign attempts with stable reasons", async () => {
    const owner = await seedOwner("usr_lifecycle", "prj_lifecycle", "mch_lifecycle");
    const object = { contentHash: "lifecycle-hash", sizeBytes: 1 };
    await seedAttempt({
      attemptId: "att_expired",
      projectId: owner.project.id,
      userId: owner.user.id,
      machineId: owner.machine.id,
      objects: [object],
      expiresAt: NOW,
      createdAt: NOW - 1_000,
    });
    await seedAttempt({
      attemptId: "att_closed",
      projectId: owner.project.id,
      userId: owner.user.id,
      machineId: owner.machine.id,
      objects: [object],
      state: "abandoned",
    });

    const { signer } = fakeSigner();
    await expect(
      issueUploadContracts({
        database: env.DB,
        signer,
        ownerId: owner.user.id,
        projectId: owner.project.id,
        attemptId: "att_expired",
        transport: transportFor([object]),
        now: NOW,
      }),
    ).rejects.toMatchObject({ reason: "attempt_expired" });
    await expect(
      issueUploadContracts({
        database: env.DB,
        signer,
        ownerId: owner.user.id,
        projectId: owner.project.id,
        attemptId: "att_closed",
        transport: transportFor([object]),
        now: NOW,
      }),
    ).rejects.toMatchObject({ reason: "attempt_closed" });

    const foreign = await seedOwner("usr_foreign", "prj_foreign", "mch_foreign", "foreign");
    await seedAttempt({
      attemptId: "att_foreign",
      projectId: foreign.project.id,
      userId: foreign.user.id,
      machineId: foreign.machine.id,
      objects: [object],
    });
    await expect(
      issueUploadContracts({
        database: env.DB,
        signer,
        ownerId: owner.user.id,
        projectId: foreign.project.id,
        attemptId: "att_foreign",
        transport: transportFor([object]),
        now: NOW,
      }),
    ).rejects.toMatchObject({ reason: "attempt_not_found" });
    await expect(
      verifyUploadBatch({
        database: env.DB,
        bucket: env.ARTIFACTS,
        ownerId: owner.user.id,
        projectId: foreign.project.id,
        attemptId: "att_foreign",
        requests: [{ contentHash: object.contentHash }],
        now: NOW,
      }),
    ).rejects.toMatchObject({ reason: "attempt_not_found" });
  });
});

describe("authenticated client route surface", () => {
  it("keeps the publication routes behind machine authentication", async () => {
    const response = await app.fetch(
      new Request("https://control.test/api/projects/prj_missing/publish/att_missing/verify", {
        method: "POST",
        body: "[]",
      }),
      env,
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "machine_authentication_failed",
      reason: "missing_authorization",
    });
  });

  it("allows an authenticated caller to use an injected signer", async () => {
    const owner = await seedOwner("usr_route", "prj_route", "mch_route");
    const object = { contentHash: "route-hash", sizeBytes: 3 };
    await seedAttempt({
      attemptId: "att_route",
      projectId: owner.project.id,
      userId: owner.user.id,
      machineId: owner.machine.id,
      objects: [object],
    });
    const { signer } = fakeSigner();
    const routeApp = new Hono<MachineAuthEnv>();
    routeApp.use(
      "*",
      createMiddleware<MachineAuthEnv>(async (context, next) => {
        context.set(MACHINE_AUTH_CONTEXT_KEY, {
          userId: owner.user.id,
          canonicalHandle: owner.user.canonicalHandle,
          machineId: owner.machine.id,
        });
        await next();
      }),
    );
    routeApp.route(
      "/api/projects/:projectId/publish",
      createPublicationContractsRouter({ signer, now: () => NOW }),
    );

    const response = await routeApp.fetch(
      new Request(
        `https://control.test/api/projects/${owner.project.id}/publish/att_route/contracts`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ transport: transportFor([object]) }),
        },
      ),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      attemptId: "att_route",
      projectId: owner.project.id,
      contracts: [{ contentHash: object.contentHash, sizeBytes: object.sizeBytes }],
    });
  });
});
