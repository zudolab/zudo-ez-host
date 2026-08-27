import {
  MAX_ACTIVE_PUBLISHED_BYTES_PER_ACCOUNT,
  MAX_ARTIFACT_BYTES,
  MAX_CANONICAL_MANIFEST_BYTES,
  MAX_FILE_BYTES,
  MAX_FILES_PER_ARTIFACT,
  MAX_OPEN_ATTEMPTS_PER_ACCOUNT,
  MAX_OPEN_ATTEMPTS_PER_PROJECT,
  MAX_RETAINED_AND_STAGED_BYTES_PER_ACCOUNT,
  encodeCanonical,
  type Manifest,
} from "@zudo-ez-host/core";
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { beforeEach, describe, expect, inject, it } from "vitest";

import { createControlDatabase } from "../../db/database.js";
import { MACHINE_AUTH_CONTEXT_KEY, type MachineAuthEnv } from "../../auth/index.js";
import { seedMachine, seedProject, seedUser } from "../../db/seeds.js";
import { applyControlMigrations } from "../../db/testing.js";
import { contentKey, type UploadUrlSigner } from "../../storage/index.js";
import {
  PUBLICATION_ATTEMPT_LIFETIME_MS,
  preparePublication,
  type PreparePublicationInput,
} from "./prepare.js";
import { createPublicationPrepareRouter } from "./router.js";

const NOW = 2_000_000_000_000;
const YEAR_MS = 365 * 24 * 60 * 60 * 1_000;
const MD5_EMPTY = "1B2M2Y8AsgTpgAmY7PhCfg==";

const signer: UploadUrlSigner = {
  async signUpload(input) {
    return `https://upload.test/${encodeURIComponent(input.key)}`;
  },
};

function hash(index: number): string {
  return index.toString(16).padStart(64, "0");
}

function manifest(
  entries: readonly {
    readonly path: string;
    readonly sha256: string;
    readonly size: number;
    readonly contentType?: string;
  }[],
): Manifest {
  return {
    version: 1,
    servingSemanticsVersion: 1,
    entries: entries.map((entry) => ({
      ...entry,
      contentType: entry.contentType ?? "application/octet-stream",
    })),
  };
}

function transportFor(value: Manifest) {
  const contentTypes = new Map<string, string>();
  for (const entry of [...value.entries].sort((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    if (!contentTypes.has(entry.sha256)) {
      contentTypes.set(entry.sha256, entry.contentType);
    }
  }
  return [...contentTypes].map(([contentHash, contentType]) => ({
    contentHash,
    contentType,
    contentMd5: MD5_EMPTY,
  }));
}

async function seedOwner(options: {
  readonly userId: string;
  readonly machineId: string;
  readonly projectIds: readonly string[];
}) {
  const database = createControlDatabase(env.DB);
  const user = await seedUser(database, {
    id: options.userId,
    canonicalHandle: options.userId.replaceAll("_", "").slice(0, 20),
    createdAt: NOW,
  });
  const machine = await seedMachine(database, {
    id: options.machineId,
    userId: user.id,
    name: "Test Mac",
    credentialHashSha256: `${options.machineId}-credential`,
    credentialPrefix: "zeh_machine_v1_",
    credentialVersion: 1,
    createdAt: NOW,
    expiresAt: NOW + YEAR_MS,
  });
  const projects = [];
  for (const [index, projectId] of options.projectIds.entries()) {
    projects.push(
      await seedProject(database, {
        id: projectId,
        userId: user.id,
        slug: `site-${index}`,
        displayName: `Site ${index}`,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
  }
  return { user, machine, projects };
}

function prepareInput(
  owner: Awaited<ReturnType<typeof seedOwner>>,
  projectId: string,
  value: Manifest,
  overrides: Partial<PreparePublicationInput> = {},
): PreparePublicationInput {
  return {
    database: env.DB,
    bucket: env.ARTIFACTS,
    signer,
    ownerId: owner.user.id,
    machineId: owner.machine.id,
    projectId,
    manifestBytes: encodeCanonical(value),
    transport: transportFor(value),
    now: NOW,
    ...overrides,
  };
}

async function seedOpenAttempt(options: {
  readonly id: string;
  readonly ownerId: string;
  readonly machineId: string;
  readonly projectId: string;
  readonly createdAt?: number;
  readonly expiresAt?: number;
  readonly activeReservation?: number;
  readonly physicalReservation?: number;
}) {
  const createdAt = options.createdAt ?? NOW - 1_000;
  const activeReservation = options.activeReservation ?? 0;
  const physicalReservation = options.physicalReservation ?? 0;
  await env.DB.prepare(
    `INSERT INTO publication_attempts
       (id, project_id, user_id, machine_id, state, base_generation,
        base_logical_bytes, staged_manifest_r2_key, manifest_hash,
        logical_bytes, file_count, reserved_active_delta_bytes,
        reserved_physical_upload_bytes, created_at, expires_at, settled_at)
     VALUES (?, ?, ?, ?, 'open', 0, 0, ?, ?, ?, 0, ?, ?, ?, ?, NULL)`,
  )
    .bind(
      options.id,
      options.projectId,
      options.ownerId,
      options.machineId,
      `projects/${options.projectId}/staged/${options.id}`,
      `${options.id}-manifest`,
      activeReservation,
      activeReservation,
      physicalReservation,
      createdAt,
      options.expiresAt ?? NOW + PUBLICATION_ATTEMPT_LIFETIME_MS,
    )
    .run();
}

beforeEach(async () => {
  await reset();
  await applyControlMigrations(env.DB, inject("controlMigrations"));
});

describe("publication prepare", () => {
  it("exposes the prepare operation through the authenticated route seam", async () => {
    const owner = await seedOwner({
      userId: "usr_route",
      machineId: "mch_route",
      projectIds: ["prj_route"],
    });
    const value = manifest([{ path: "route", sha256: hash(0), size: 0 }]);
    const routeApp = new Hono<MachineAuthEnv>();
    routeApp.use(
      "*",
      createMiddleware<MachineAuthEnv>(async (context, next) => {
        context.set(MACHINE_AUTH_CONTEXT_KEY, {
          userId: owner.user.id,
          machineId: owner.machine.id,
          canonicalHandle: owner.user.canonicalHandle,
        });
        await next();
      }),
    );
    routeApp.route(
      "/api/projects/:projectId/publish",
      createPublicationPrepareRouter({ signer, now: () => NOW }),
    );

    const response = await routeApp.fetch(
      new Request("https://control.test/api/projects/prj_route/publish/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          manifest: new TextDecoder().decode(encodeCanonical(value)),
          transport: transportFor(value),
        }),
      }),
      env,
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      created: true,
      attempt: { projectId: "prj_route", baseGeneration: 0 },
      contracts: { contracts: [{ contentHash: hash(0), sizeBytes: 0 }] },
    });
  });

  it("stages canonical bytes and returns contracts only for missing hashes", async () => {
    const owner = await seedOwner({
      userId: "usr_valid",
      machineId: "mch_valid",
      projectIds: ["prj_valid"],
    });
    const value = manifest([
      { path: "a.txt", sha256: hash(1), size: 3, contentType: "text/plain" },
      { path: "b.txt", sha256: hash(2), size: 5, contentType: "text/plain" },
      { path: "copy.txt", sha256: hash(2), size: 5, contentType: "text/plain" },
    ]);
    await env.DB.prepare(
      "INSERT INTO verified_objects (project_id, content_hash, size_bytes, verified_at) VALUES (?, ?, ?, ?)",
    )
      .bind("prj_valid", hash(1), 3, NOW)
      .run();
    await env.ARTIFACTS.put(contentKey("prj_valid", hash(1)), "old");

    const result = await preparePublication(prepareInput(owner, "prj_valid", value));

    expect(result.created).toBe(true);
    expect(result.attempt).toMatchObject({
      projectId: "prj_valid",
      baseGeneration: 0,
      logicalBytes: 13,
      fileCount: 3,
      reservedActiveDeltaBytes: 13,
      reservedPhysicalUploadBytes: 5,
      createdAt: NOW,
      expiresAt: NOW + PUBLICATION_ATTEMPT_LIFETIME_MS,
    });
    expect(result.contracts.contracts.map((contract) => contract.contentHash)).toEqual([hash(2)]);
    const staged = await env.ARTIFACTS.get(result.attempt.stagedManifestR2Key);
    expect(staged?.customMetadata?.sha256).toBe(result.attempt.manifestHash);
    await expect(staged?.arrayBuffer()).resolves.toEqual(encodeCanonical(value).buffer);
    await expect(
      env.DB.prepare(
        "SELECT reserved_active_delta_bytes AS active, reserved_physical_upload_bytes AS physical FROM user WHERE id = ?",
      )
        .bind(owner.user.id)
        .first(),
    ).resolves.toEqual({ active: 13, physical: 5 });
  });

  it("is idempotent for an identical open manifest without stacking reservations", async () => {
    const owner = await seedOwner({
      userId: "usr_idempotent",
      machineId: "mch_idempotent",
      projectIds: ["prj_idempotent"],
    });
    const value = manifest([{ path: "index.html", sha256: hash(3), size: 7 }]);
    const input = prepareInput(owner, "prj_idempotent", value);

    const first = await preparePublication(input);
    const second = await preparePublication(input);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.attempt.id).toBe(first.attempt.id);
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM publication_attempts").first(),
    ).resolves.toEqual({ count: 1 });
    await expect(
      env.DB.prepare(
        "SELECT reserved_active_delta_bytes AS active, reserved_physical_upload_bytes AS physical FROM user WHERE id = ?",
      )
        .bind(owner.user.id)
        .first(),
    ).resolves.toEqual({ active: 7, physical: 7 });
  });

  it("lazily expires attempts and releases their reservations before preparing", async () => {
    const owner = await seedOwner({
      userId: "usr_expiry",
      machineId: "mch_expiry",
      projectIds: ["prj_expiry"],
    });
    await seedOpenAttempt({
      id: "att_expired",
      ownerId: owner.user.id,
      machineId: owner.machine.id,
      projectId: "prj_expiry",
      expiresAt: NOW,
      activeReservation: 11,
      physicalReservation: 13,
    });
    await env.DB.prepare(
      "UPDATE user SET reserved_active_delta_bytes = 11, reserved_physical_upload_bytes = 13 WHERE id = ?",
    )
      .bind(owner.user.id)
      .run();
    const value = manifest([{ path: "fresh", sha256: hash(4), size: 2 }]);

    const result = await preparePublication(prepareInput(owner, "prj_expiry", value));

    expect(result.created).toBe(true);
    await expect(
      env.DB.prepare("SELECT state, settled_at AS settledAt FROM publication_attempts WHERE id = ?")
        .bind("att_expired")
        .first(),
    ).resolves.toEqual({ state: "expired", settledAt: NOW });
    await expect(
      env.DB.prepare(
        "SELECT reserved_active_delta_bytes AS active, reserved_physical_upload_bytes AS physical FROM user WHERE id = ?",
      )
        .bind(owner.user.id)
        .first(),
    ).resolves.toEqual({ active: 2, physical: 2 });
  });

  it("proves the guarded account row prevents concurrent over-reservation", async () => {
    const owner = await seedOwner({
      userId: "usr_race",
      machineId: "mch_race",
      projectIds: ["prj_race"],
    });
    await env.DB.prepare("UPDATE user SET retained_staged_physical_bytes = ? WHERE id = ?")
      .bind(MAX_RETAINED_AND_STAGED_BYTES_PER_ACCOUNT - 10, owner.user.id)
      .run();
    const first = manifest([{ path: "first", sha256: hash(5), size: 10 }]);
    const second = manifest([{ path: "second", sha256: hash(6), size: 10 }]);

    const settled = await Promise.allSettled([
      preparePublication(prepareInput(owner, "prj_race", first, { attemptId: "att_race_a" })),
      preparePublication(prepareInput(owner, "prj_race", second, { attemptId: "att_race_b" })),
    ]);

    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ reason: { reason: "physical_quota_exceeded" } });
    await expect(
      env.DB.prepare(
        "SELECT COUNT(*) AS count FROM publication_attempts WHERE state = 'open'",
      ).first(),
    ).resolves.toEqual({ count: 1 });
    await expect(
      env.DB.prepare(
        "SELECT retained_staged_physical_bytes + reserved_physical_upload_bytes AS total FROM user WHERE id = ?",
      )
        .bind(owner.user.id)
        .first(),
    ).resolves.toEqual({ total: MAX_RETAINED_AND_STAGED_BYTES_PER_ACCOUNT });
  });

  it("rejects manifest body, file, file-count, and artifact size limits", async () => {
    const owner = await seedOwner({
      userId: "usr_limits",
      machineId: "mch_limits",
      projectIds: ["prj_limits"],
    });
    await expect(
      preparePublication(
        prepareInput(owner, "prj_limits", manifest([]), {
          manifestBytes: new Uint8Array(MAX_CANONICAL_MANIFEST_BYTES + 1),
        }),
      ),
    ).rejects.toMatchObject({ reason: "manifest_body_limit_exceeded" });

    const oversizedFile = manifest([{ path: "large", sha256: hash(7), size: MAX_FILE_BYTES + 1 }]);
    await expect(
      preparePublication(prepareInput(owner, "prj_limits", oversizedFile)),
    ).rejects.toMatchObject({ reason: "file_size_limit_exceeded" });

    const tooManyFiles = manifest(
      Array.from({ length: MAX_FILES_PER_ARTIFACT + 1 }, (_, index) => ({
        path: `file-${String(index).padStart(5, "0")}`,
        sha256: hash(8),
        size: 0,
      })),
    );
    await expect(
      preparePublication(prepareInput(owner, "prj_limits", tooManyFiles)),
    ).rejects.toMatchObject({ reason: "file_count_limit_exceeded" });

    const artifactTooLarge = manifest(
      Array.from({ length: Math.floor(MAX_ARTIFACT_BYTES / MAX_FILE_BYTES) + 1 }, (_, index) => ({
        path: `chunk-${index}`,
        sha256: hash(100 + index),
        size: MAX_FILE_BYTES,
      })),
    );
    await expect(
      preparePublication(prepareInput(owner, "prj_limits", artifactTooLarge)),
    ).rejects.toMatchObject({ reason: "artifact_size_limit_exceeded" });
  });

  it("rejects project and account attempt caps", async () => {
    const projectOwner = await seedOwner({
      userId: "usr_projectcap",
      machineId: "mch_projectcap",
      projectIds: ["prj_projectcap"],
    });
    for (let index = 0; index < MAX_OPEN_ATTEMPTS_PER_PROJECT; index += 1) {
      await seedOpenAttempt({
        id: `att_project_${index}`,
        ownerId: projectOwner.user.id,
        machineId: projectOwner.machine.id,
        projectId: "prj_projectcap",
      });
    }
    const value = manifest([{ path: "cap", sha256: hash(200), size: 0 }]);
    await expect(
      preparePublication(prepareInput(projectOwner, "prj_projectcap", value)),
    ).rejects.toMatchObject({ reason: "project_attempt_limit_exceeded" });

    await reset();
    await applyControlMigrations(env.DB, inject("controlMigrations"));
    const projectIds = Array.from({ length: 7 }, (_, index) => `prj_account_${index}`);
    const accountOwner = await seedOwner({
      userId: "usr_accountcap",
      machineId: "mch_accountcap",
      projectIds,
    });
    for (let index = 0; index < MAX_OPEN_ATTEMPTS_PER_ACCOUNT; index += 1) {
      await seedOpenAttempt({
        id: `att_account_${index}`,
        ownerId: accountOwner.user.id,
        machineId: accountOwner.machine.id,
        projectId: projectIds[Math.floor(index / MAX_OPEN_ATTEMPTS_PER_PROJECT)] as string,
      });
    }
    await expect(
      preparePublication(prepareInput(accountOwner, projectIds.at(-1) as string, value)),
    ).rejects.toMatchObject({ reason: "account_attempt_limit_exceeded" });
  });

  it("rejects active and physical account quota overflow", async () => {
    const owner = await seedOwner({
      userId: "usr_quota",
      machineId: "mch_quota",
      projectIds: ["prj_quota"],
    });
    const value = manifest([{ path: "quota", sha256: hash(300), size: 1 }]);
    await env.DB.prepare("UPDATE user SET active_logical_bytes = ? WHERE id = ?")
      .bind(MAX_ACTIVE_PUBLISHED_BYTES_PER_ACCOUNT, owner.user.id)
      .run();
    await expect(preparePublication(prepareInput(owner, "prj_quota", value))).rejects.toMatchObject(
      { reason: "active_quota_exceeded" },
    );

    await env.DB.prepare(
      "UPDATE user SET active_logical_bytes = 0, retained_staged_physical_bytes = ? WHERE id = ?",
    )
      .bind(MAX_RETAINED_AND_STAGED_BYTES_PER_ACCOUNT, owner.user.id)
      .run();
    await expect(preparePublication(prepareInput(owner, "prj_quota", value))).rejects.toMatchObject(
      { reason: "physical_quota_exceeded" },
    );
  });

  it("rejects inconsistent sizes and envelope hash-set mismatches", async () => {
    const owner = await seedOwner({
      userId: "usr_integrity",
      machineId: "mch_integrity",
      projectIds: ["prj_integrity"],
    });
    const inconsistent = manifest([
      { path: "one", sha256: hash(400), size: 1 },
      { path: "two", sha256: hash(400), size: 2 },
    ]);
    await expect(
      preparePublication(prepareInput(owner, "prj_integrity", inconsistent)),
    ).rejects.toMatchObject({ reason: "content_size_conflict" });

    const value = manifest([{ path: "one", sha256: hash(401), size: 1 }]);
    await expect(
      preparePublication(
        prepareInput(owner, "prj_integrity", value, {
          transport: [
            ...transportFor(value),
            { contentHash: hash(402), contentType: "text/plain", contentMd5: MD5_EMPTY },
          ],
        }),
      ),
    ).rejects.toMatchObject({ reason: "envelope_hash_mismatch" });

    await expect(
      preparePublication(
        prepareInput(owner, "prj_integrity", value, {
          transport: [{ contentHash: hash(401), contentType: "text/plain", contentMd5: MD5_EMPTY }],
        }),
      ),
    ).rejects.toMatchObject({ reason: "invalid_transport_metadata" });
  });

  it("does not reveal or mutate another owner's project", async () => {
    const ownerA = await seedOwner({
      userId: "usr_owner_a",
      machineId: "mch_owner_a",
      projectIds: ["prj_owner_a"],
    });
    const ownerB = await seedOwner({
      userId: "usr_owner_b",
      machineId: "mch_owner_b",
      projectIds: ["prj_owner_b"],
    });
    const value = manifest([{ path: "secret", sha256: hash(500), size: 1 }]);

    await expect(
      preparePublication(prepareInput(ownerA, ownerB.projects[0]?.id ?? "prj_owner_b", value)),
    ).rejects.toMatchObject({ reason: "project_not_found", status: 404 });
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM publication_attempts").first(),
    ).resolves.toEqual({ count: 0 });
  });
});
