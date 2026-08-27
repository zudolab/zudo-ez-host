import { encodeCanonical, type Manifest } from "@zudo-ez-host/core";
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { beforeEach, describe, expect, inject, it } from "vitest";

import { MACHINE_AUTH_CONTEXT_KEY, type MachineAuthEnv } from "../../auth/index.js";
import { createControlDatabase } from "../../db/database.js";
import { seedMachine, seedProject, seedUser } from "../../db/seeds.js";
import { applyControlMigrations } from "../../db/testing.js";
import { artifactManifestKey, stagedManifestKey } from "../../storage/index.js";
import {
  CommitPublicationError,
  commitPublication,
  type CommitPublicationInput,
} from "./commit.js";
import { createPublicationCommitRouter } from "./router.js";

const NOW = 2_000_000_000_000;
const YEAR_MS = 365 * 24 * 60 * 60 * 1_000;

function hash(index: number): string {
  return index.toString(16).padStart(64, "0");
}

function manifest(
  entries: readonly { readonly path: string; readonly sha256: string; readonly size: number }[],
): Manifest {
  return {
    version: 1,
    servingSemanticsVersion: 1,
    entries: entries.map((entry) => ({
      ...entry,
      contentType: "application/octet-stream",
    })),
  };
}

async function digest(bytes: Uint8Array): Promise<string> {
  const value = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function seedOwner(options: {
  readonly userId: string;
  readonly projectId: string;
  readonly machines: readonly { readonly id: string; readonly name: string }[];
}) {
  const database = createControlDatabase(env.DB);
  const user = await seedUser(database, {
    id: options.userId,
    canonicalHandle: options.userId.replaceAll("_", "").slice(0, 20),
    createdAt: NOW,
  });
  const machines = [];
  for (const machine of options.machines) {
    machines.push(
      await seedMachine(database, {
        id: machine.id,
        userId: user.id,
        name: machine.name,
        credentialHashSha256: `${machine.id}-credential`,
        credentialPrefix: "zeh_machine_v1_",
        credentialVersion: 1,
        createdAt: NOW,
        expiresAt: NOW + YEAR_MS,
      }),
    );
  }
  const project = await seedProject(database, {
    id: options.projectId,
    userId: user.id,
    slug: options.projectId.replaceAll("_", "-").slice(0, 41),
    displayName: options.projectId,
    createdAt: NOW,
    updatedAt: NOW,
  });
  return { user, machines, project };
}

interface SeedAttemptOptions {
  readonly id: string;
  readonly ownerId: string;
  readonly projectId: string;
  readonly machineId: string;
  readonly value: Manifest;
  readonly baseGeneration?: number;
  readonly baseLogicalBytes?: number;
  readonly verified?: boolean;
  readonly expiresAt?: number;
}

async function seedAttempt(options: SeedAttemptOptions): Promise<void> {
  const bytes = encodeCanonical(options.value);
  const manifestHash = await digest(bytes);
  const baseGeneration = options.baseGeneration ?? 0;
  const baseLogicalBytes = options.baseLogicalBytes ?? 0;
  const logicalBytes = options.value.entries.reduce((total, entry) => total + entry.size, 0);
  const distinctObjects = new Map<string, number>();
  for (const entry of options.value.entries) {
    distinctObjects.set(entry.sha256, entry.size);
  }
  const reservedActive = Math.max(0, logicalBytes - baseLogicalBytes);
  await env.DB.prepare(
    `INSERT INTO publication_attempts
       (id, project_id, user_id, machine_id, state, base_generation,
        base_logical_bytes, staged_manifest_r2_key, manifest_hash,
        logical_bytes, file_count, reserved_active_delta_bytes,
        reserved_physical_upload_bytes, created_at, expires_at, settled_at)
     VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL)`,
  )
    .bind(
      options.id,
      options.projectId,
      options.ownerId,
      options.machineId,
      baseGeneration,
      baseLogicalBytes,
      stagedManifestKey(options.projectId, options.id),
      manifestHash,
      logicalBytes,
      options.value.entries.length,
      reservedActive,
      NOW,
      options.expiresAt ?? NOW + 60_000,
    )
    .run();
  await env.DB.prepare(
    `UPDATE user
     SET reserved_active_delta_bytes = reserved_active_delta_bytes + ?
     WHERE id = ?`,
  )
    .bind(reservedActive, options.ownerId)
    .run();
  for (const [contentHash, size] of distinctObjects) {
    const inserted = await env.DB.prepare(
      `INSERT OR IGNORE INTO verified_objects
         (project_id, content_hash, size_bytes, verified_at)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(options.projectId, contentHash, size, NOW)
      .run();
    if (inserted.meta.changes === 1) {
      await env.DB.prepare(
        `UPDATE user
         SET retained_staged_physical_bytes = retained_staged_physical_bytes + ?
         WHERE id = ?`,
      )
        .bind(size, options.ownerId)
        .run();
    }
    await env.DB.prepare(
      `INSERT INTO publication_attempt_objects
         (attempt_id, content_hash, size_bytes, requires_upload, verified)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(
        options.id,
        contentHash,
        size,
        options.verified === false ? 1 : 0,
        options.verified === false ? 0 : 1,
      )
      .run();
  }
  await env.ARTIFACTS.put(stagedManifestKey(options.projectId, options.id), bytes);
}

function commitInput(
  owner: Awaited<ReturnType<typeof seedOwner>>,
  attemptId: string,
  overrides: Partial<CommitPublicationInput> = {},
): CommitPublicationInput {
  return {
    database: env.DB,
    bucket: env.ARTIFACTS,
    ownerId: owner.user.id,
    projectId: owner.project.id,
    attemptId,
    now: NOW + 1,
    ...overrides,
  };
}

beforeEach(async () => {
  await reset();
  await applyControlMigrations(env.DB, inject("controlMigrations"));
});

describe("publication commit", () => {
  it("promotes a complete attempt and records immutable head and history", async () => {
    const owner = await seedOwner({
      userId: "usr_happy",
      projectId: "prj_happy",
      machines: [{ id: "mch_happy", name: "Studio Mac" }],
    });
    const value = manifest([
      { path: "index.html", sha256: hash(1), size: 5 },
      { path: "assets/app.js", sha256: hash(2), size: 7 },
    ]);
    await seedAttempt({
      id: "att_happy",
      ownerId: owner.user.id,
      projectId: owner.project.id,
      machineId: owner.machines[0]!.id,
      value,
    });

    const result = await commitPublication(
      commitInput(owner, "att_happy", { publicationId: "pub_happy" }),
    );

    expect(result).toMatchObject({
      committed: true,
      publication: {
        id: "pub_happy",
        generation: 1,
        machineName: "Studio Mac",
        logicalBytes: 12,
        physicalBytes: 12,
        fileCount: 2,
        objectCount: 2,
      },
    });
    await expect(
      env.DB.prepare(
        "SELECT generation, publication_id AS publicationId FROM project_heads WHERE project_id = ?",
      )
        .bind(owner.project.id)
        .first(),
    ).resolves.toEqual({ generation: 1, publicationId: "pub_happy" });
    await expect(
      env.DB.prepare("SELECT state, settled_at AS settledAt FROM publication_attempts WHERE id = ?")
        .bind("att_happy")
        .first(),
    ).resolves.toEqual({ state: "committed", settledAt: NOW + 1 });
    await expect(
      env.DB.prepare(
        `SELECT active_logical_bytes AS active,
                reserved_active_delta_bytes AS reserved,
                retained_staged_physical_bytes AS retained
         FROM user WHERE id = ?`,
      )
        .bind(owner.user.id)
        .first(),
    ).resolves.toEqual({ active: 12, reserved: 0, retained: 12 });
    const promoted = await env.ARTIFACTS.get(
      artifactManifestKey(owner.project.id, result.publication.artifactHash),
    );
    await expect(promoted?.arrayBuffer()).resolves.toEqual(encodeCanonical(value).buffer);
  });

  it("returns a stable stale-head payload with the publishing machine snapshot", async () => {
    const owner = await seedOwner({
      userId: "usr_stale",
      projectId: "prj_stale",
      machines: [
        { id: "mch_old", name: "Old Mac" },
        { id: "mch_new", name: "New Mac" },
      ],
    });
    await seedAttempt({
      id: "att_old",
      ownerId: owner.user.id,
      projectId: owner.project.id,
      machineId: owner.machines[0]!.id,
      value: manifest([{ path: "old", sha256: hash(3), size: 3 }]),
    });
    await seedAttempt({
      id: "att_new",
      ownerId: owner.user.id,
      projectId: owner.project.id,
      machineId: owner.machines[1]!.id,
      value: manifest([{ path: "new", sha256: hash(4), size: 4 }]),
    });
    await commitPublication(
      commitInput(owner, "att_new", { publicationId: "pub_new", now: NOW + 2 }),
    );

    const routeApp = new Hono<MachineAuthEnv>();
    routeApp.use(
      "*",
      createMiddleware<MachineAuthEnv>(async (context, next) => {
        context.set(MACHINE_AUTH_CONTEXT_KEY, {
          userId: owner.user.id,
          machineId: owner.machines[0]!.id,
          canonicalHandle: owner.user.canonicalHandle,
        });
        await next();
      }),
    );
    routeApp.route(
      "/api/projects/:projectId/publish",
      createPublicationCommitRouter({ now: () => NOW + 3 }),
    );
    const response = await routeApp.fetch(
      new Request("https://control.test/api/projects/prj_stale/publish/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attemptId: "att_old" }),
      }),
      env,
    );

    expect(response.status).toBe(409);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      error: "publication_commit_failed",
      reason: "publication_head_changed",
      generation: 1,
      machineName: "New Mac",
    });
  });

  it("re-commits the original publication idempotently after a newer generation", async () => {
    const owner = await seedOwner({
      userId: "usr_retry",
      projectId: "prj_retry",
      machines: [{ id: "mch_retry", name: "Retry Mac" }],
    });
    const firstValue = manifest([{ path: "first", sha256: hash(5), size: 5 }]);
    await seedAttempt({
      id: "att_first",
      ownerId: owner.user.id,
      projectId: owner.project.id,
      machineId: owner.machines[0]!.id,
      value: firstValue,
    });
    const first = await commitPublication(
      commitInput(owner, "att_first", { publicationId: "pub_first", now: NOW + 1 }),
    );
    await seedAttempt({
      id: "att_second",
      ownerId: owner.user.id,
      projectId: owner.project.id,
      machineId: owner.machines[0]!.id,
      value: manifest([{ path: "second", sha256: hash(6), size: 6 }]),
      baseGeneration: 1,
      baseLogicalBytes: 5,
    });
    await commitPublication(
      commitInput(owner, "att_second", { publicationId: "pub_second", now: NOW + 2 }),
    );

    const retry = await commitPublication(commitInput(owner, "att_first", { now: NOW + 3 }));

    expect(retry).toEqual({ publication: first.publication, committed: false });
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM publications").first(),
    ).resolves.toEqual({ count: 2 });
  });

  it("allows exactly one promotion for two attempts prepared from one head", async () => {
    const owner = await seedOwner({
      userId: "usr_race",
      projectId: "prj_race",
      machines: [
        { id: "mch_race_a", name: "Race A" },
        { id: "mch_race_b", name: "Race B" },
      ],
    });
    await seedAttempt({
      id: "att_race_a",
      ownerId: owner.user.id,
      projectId: owner.project.id,
      machineId: owner.machines[0]!.id,
      value: manifest([{ path: "a", sha256: hash(7), size: 7 }]),
    });
    await seedAttempt({
      id: "att_race_b",
      ownerId: owner.user.id,
      projectId: owner.project.id,
      machineId: owner.machines[1]!.id,
      value: manifest([{ path: "b", sha256: hash(8), size: 8 }]),
    });

    const outcomes = await Promise.allSettled([
      commitPublication(
        commitInput(owner, "att_race_a", { publicationId: "pub_race_a", now: NOW + 1 }),
      ),
      commitPublication(
        commitInput(owner, "att_race_b", { publicationId: "pub_race_b", now: NOW + 1 }),
      ),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ reason: "publication_head_changed" }),
    });
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM publications").first(),
    ).resolves.toEqual({ count: 1 });
    await expect(
      env.DB.prepare("SELECT generation FROM project_heads WHERE project_id = ?")
        .bind(owner.project.id)
        .first(),
    ).resolves.toEqual({ generation: 1 });
  });

  it("settles replacement, retained hash reuse, and duplicate-path accounting", async () => {
    const owner = await seedOwner({
      userId: "usr_quota",
      projectId: "prj_quota",
      machines: [{ id: "mch_quota", name: "Quota Mac" }],
    });
    await seedAttempt({
      id: "att_quota_1",
      ownerId: owner.user.id,
      projectId: owner.project.id,
      machineId: owner.machines[0]!.id,
      value: manifest([{ path: "one", sha256: hash(9), size: 10 }]),
    });
    await commitPublication(
      commitInput(owner, "att_quota_1", { publicationId: "pub_quota_1", now: NOW + 1 }),
    );
    await seedAttempt({
      id: "att_quota_2",
      ownerId: owner.user.id,
      projectId: owner.project.id,
      machineId: owner.machines[0]!.id,
      value: manifest([
        { path: "copy-a", sha256: hash(9), size: 10 },
        { path: "copy-b", sha256: hash(9), size: 10 },
      ]),
      baseGeneration: 1,
      baseLogicalBytes: 10,
    });

    const result = await commitPublication(
      commitInput(owner, "att_quota_2", { publicationId: "pub_quota_2", now: NOW + 2 }),
    );

    expect(result.publication).toMatchObject({
      generation: 2,
      logicalBytes: 20,
      physicalBytes: 10,
      fileCount: 2,
      objectCount: 1,
    });
    await expect(
      env.DB.prepare(
        `SELECT active_logical_bytes AS active,
                reserved_active_delta_bytes AS reserved,
                retained_staged_physical_bytes AS retained
         FROM user WHERE id = ?`,
      )
        .bind(owner.user.id)
        .first(),
    ).resolves.toEqual({ active: 20, reserved: 0, retained: 10 });
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM publication_objects").first(),
    ).resolves.toEqual({ count: 2 });
  });

  it("rejects incomplete inventory without reading content objects from R2", async () => {
    const owner = await seedOwner({
      userId: "usr_incomplete",
      projectId: "prj_incomplete",
      machines: [{ id: "mch_incomplete", name: "Incomplete Mac" }],
    });
    await seedAttempt({
      id: "att_incomplete",
      ownerId: owner.user.id,
      projectId: owner.project.id,
      machineId: owner.machines[0]!.id,
      value: manifest([{ path: "pending", sha256: hash(10), size: 10 }]),
      verified: false,
    });

    await expect(commitPublication(commitInput(owner, "att_incomplete"))).rejects.toMatchObject({
      reason: "publication_incomplete",
    });
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM publications").first(),
    ).resolves.toEqual({ count: 0 });
  });

  it("rejects expired and terminal attempts before promotion", async () => {
    const owner = await seedOwner({
      userId: "usr_state",
      projectId: "prj_state",
      machines: [{ id: "mch_state", name: "State Mac" }],
    });
    const value = manifest([{ path: "state", sha256: hash(12), size: 12 }]);
    await seedAttempt({
      id: "att_expired",
      ownerId: owner.user.id,
      projectId: owner.project.id,
      machineId: owner.machines[0]!.id,
      value,
      expiresAt: NOW + 1,
    });
    await seedAttempt({
      id: "att_abandoned",
      ownerId: owner.user.id,
      projectId: owner.project.id,
      machineId: owner.machines[0]!.id,
      value,
    });
    await env.DB.prepare(
      "UPDATE publication_attempts SET state = 'abandoned', settled_at = ? WHERE id = ?",
    )
      .bind(NOW, "att_abandoned")
      .run();

    await expect(commitPublication(commitInput(owner, "att_expired"))).rejects.toMatchObject({
      reason: "attempt_expired",
    });
    await expect(commitPublication(commitInput(owner, "att_abandoned"))).rejects.toMatchObject({
      reason: "attempt_closed",
    });
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM publications").first(),
    ).resolves.toEqual({ count: 0 });
  });

  it("refuses staged bytes that no longer match the recorded manifest hash", async () => {
    const owner = await seedOwner({
      userId: "usr_tamper",
      projectId: "prj_tamper",
      machines: [{ id: "mch_tamper", name: "Tamper Mac" }],
    });
    await seedAttempt({
      id: "att_tamper",
      ownerId: owner.user.id,
      projectId: owner.project.id,
      machineId: owner.machines[0]!.id,
      value: manifest([{ path: "original", sha256: hash(13), size: 13 }]),
    });
    await env.ARTIFACTS.put(
      stagedManifestKey(owner.project.id, "att_tamper"),
      encodeCanonical(manifest([{ path: "changed", sha256: hash(13), size: 13 }])),
    );

    await expect(commitPublication(commitInput(owner, "att_tamper"))).rejects.toMatchObject({
      reason: "staged_manifest_hash_mismatch",
    });
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM publications").first(),
    ).resolves.toEqual({ count: 0 });
  });

  it("does not reveal or commit another owner's attempt", async () => {
    const owner = await seedOwner({
      userId: "usr_owner",
      projectId: "prj_owner",
      machines: [{ id: "mch_owner", name: "Owner Mac" }],
    });
    const stranger = await seedOwner({
      userId: "usr_stranger",
      projectId: "prj_stranger",
      machines: [{ id: "mch_stranger", name: "Stranger Mac" }],
    });
    await seedAttempt({
      id: "att_private",
      ownerId: owner.user.id,
      projectId: owner.project.id,
      machineId: owner.machines[0]!.id,
      value: manifest([{ path: "private", sha256: hash(11), size: 11 }]),
    });

    await expect(
      commitPublication({
        ...commitInput(owner, "att_private"),
        ownerId: stranger.user.id,
      }),
    ).rejects.toBeInstanceOf(CommitPublicationError);
    await expect(
      commitPublication({
        ...commitInput(owner, "att_private"),
        ownerId: stranger.user.id,
      }),
    ).rejects.toMatchObject({ reason: "attempt_not_found", status: 404 });
  });
});
