import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { beforeEach, describe, expect, inject, it } from "vitest";

import { createControlDatabase } from "./database.js";
import { executeGuardedBatch } from "./guarded-batch.js";
import type { GuardedBatchError } from "./guarded-batch.js";
import {
  allocatePermanentHostname,
  getAttemptForOwner,
  getHostnameAllocation,
  getMachineByCredentialHash,
  getOwnedProject,
  getProjectHead,
  getPublicationByAttemptId,
  getUserById,
  getVerifiedObject,
} from "./queries.js";
import {
  hostnameAllocations,
  machines,
  projectHeads,
  projects,
  publicationAttemptObjects,
  publicationAttempts,
  publicationObjects,
  publications,
  users,
  verifiedObjects,
} from "./schema.js";
import { seedMachine, seedProject, seedUser } from "./seeds.js";
import { applyControlMigrations } from "./testing.js";

const NOW = 1_700_000_000_000;
const YEAR_MS = 365 * 24 * 60 * 60 * 1_000;

beforeEach(async () => {
  await reset();
  await applyControlMigrations(env.DB, inject("controlMigrations"));
});

async function seedOwnershipGraph() {
  const database = createControlDatabase(env.DB);
  const user = await seedUser(database, {
    id: "usr_test",
    canonicalHandle: "owner",
    createdAt: NOW,
  });
  const machine = await seedMachine(database, {
    id: "mch_test",
    userId: user.id,
    name: "Studio Mac",
    credentialHashSha256: "machine-credential-sha256",
    credentialPrefix: "zeh_machine_v1_",
    credentialVersion: 1,
    createdAt: NOW,
    expiresAt: NOW + YEAR_MS,
  });
  const project = await seedProject(database, {
    id: "prj_test",
    userId: user.id,
    slug: "portfolio",
    displayName: "Portfolio",
    description: "A bounded test project",
    createdAt: NOW,
    updatedAt: NOW,
  });
  return { database, machine, project, user };
}

describe("control D1 schema", () => {
  it("applies committed migrations idempotently", async () => {
    await applyControlMigrations(env.DB, inject("controlMigrations"));
    const table = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'publication_attempts'",
    ).first<{ name: string }>();
    expect(table?.name).toBe("publication_attempts");
  });

  it("round-trips every accounting table with Drizzle types", async () => {
    const { database, machine, project, user } = await seedOwnershipGraph();
    const hostname = await allocatePermanentHostname(env.DB, project.id, NOW);

    await database.insert(publicationAttempts).values({
      id: "att_test",
      projectId: project.id,
      userId: user.id,
      machineId: machine.id,
      state: "committed",
      baseGeneration: 0,
      baseLogicalBytes: 0,
      stagedManifestR2Key: "projects/prj_test/attempts/att_test/manifest.json",
      manifestHash: "manifest-sha256",
      logicalBytes: 200,
      fileCount: 2,
      reservedActiveDeltaBytes: 200,
      reservedPhysicalUploadBytes: 100,
      createdAt: NOW,
      expiresAt: NOW + 10 * 60 * 1_000,
      settledAt: NOW + 1,
    });
    await database.insert(verifiedObjects).values({
      projectId: project.id,
      contentHash: "content-sha256",
      sizeBytes: 100,
      verifiedAt: NOW,
    });
    await database.insert(publicationAttemptObjects).values({
      attemptId: "att_test",
      contentHash: "content-sha256",
      sizeBytes: 100,
      requiresUpload: true,
      verified: true,
    });
    await database.insert(publications).values({
      id: "pub_test",
      projectId: project.id,
      attemptId: "att_test",
      generation: 1,
      artifactHash: "artifact-sha256",
      machineId: machine.id,
      machineNameSnapshot: machine.name,
      logicalBytes: 200,
      physicalBytes: 100,
      fileCount: 2,
      objectCount: 1,
      publishedAt: NOW + 1,
    });
    await database.insert(publicationObjects).values({
      publicationId: "pub_test",
      contentHash: "content-sha256",
      sizeBytes: 100,
    });
    await database
      .update(projectHeads)
      .set({ generation: 1, publicationId: "pub_test", updatedAt: NOW + 1 });

    expect(await database.select().from(users)).toEqual([user]);
    expect(await database.select().from(machines)).toEqual([machine]);
    expect(await database.select().from(projects)).toEqual([project]);
    expect(await database.select().from(hostnameAllocations)).toEqual([hostname]);
    expect(await database.select().from(publicationAttempts)).toHaveLength(1);
    expect(await database.select().from(verifiedObjects)).toHaveLength(1);
    expect(await database.select().from(publicationAttemptObjects)).toHaveLength(1);
    expect(await database.select().from(publications)).toMatchObject([
      { machineNameSnapshot: "Studio Mac", generation: 1 },
    ]);
    expect(await database.select().from(publicationObjects)).toHaveLength(1);
    expect(await database.select().from(projectHeads)).toMatchObject([
      { projectId: project.id, generation: 1, publicationId: "pub_test" },
    ]);
    await expect(
      env.DB.prepare("UPDATE publications SET artifact_hash = ? WHERE id = ?")
        .bind("rewritten-artifact", "pub_test")
        .run(),
    ).rejects.toThrow("publications are immutable");
  });

  it("provides prepared ownership, credential, head, attempt, publication, and inventory queries", async () => {
    const { database, machine, project, user } = await seedOwnershipGraph();
    await database.insert(publicationAttempts).values({
      id: "att_open",
      projectId: project.id,
      userId: user.id,
      machineId: machine.id,
      baseGeneration: 0,
      baseLogicalBytes: 0,
      stagedManifestR2Key: "staging/manifest.json",
      manifestHash: "manifest-hash",
      logicalBytes: 10,
      fileCount: 1,
      reservedActiveDeltaBytes: 10,
      reservedPhysicalUploadBytes: 10,
      createdAt: NOW,
      expiresAt: NOW + 1_000,
    });
    await database.insert(verifiedObjects).values({
      projectId: project.id,
      contentHash: "known-hash",
      sizeBytes: 10,
      verifiedAt: NOW,
    });

    expect((await getUserById(database, user.id))?.canonicalHandle).toBe("owner");
    expect((await getMachineByCredentialHash(database, machine.credentialHashSha256))?.id).toBe(
      machine.id,
    );
    expect((await getOwnedProject(database, user.id, project.id))?.id).toBe(project.id);
    expect(await getOwnedProject(database, "usr_other", project.id)).toBeUndefined();
    expect((await getProjectHead(database, project.id))?.generation).toBe(0);
    expect((await getAttemptForOwner(database, user.id, "att_open"))?.state).toBe("open");
    expect(await getPublicationByAttemptId(database, "att_open")).toBeUndefined();
    expect((await getVerifiedObject(database, project.id, "known-hash"))?.sizeBytes).toBe(10);
  });

  it("derives the permanent hostname from stored owner state", async () => {
    const { database, project } = await seedOwnershipGraph();
    const allocation = await allocatePermanentHostname(env.DB, project.id, NOW);

    expect(allocation?.label).toBe("portfolio--owner");
    expect((await getHostnameAllocation(database, project.id))?.label).toBe("portfolio--owner");
    await expect(
      env.DB.prepare("UPDATE hostname_allocations SET label = ? WHERE project_id = ?")
        .bind("stolen--label", project.id)
        .run(),
    ).rejects.toThrow("hostname allocations are permanent");
    await expect(
      env.DB.prepare("DELETE FROM hostname_allocations WHERE project_id = ?")
        .bind(project.id)
        .run(),
    ).rejects.toThrow("hostname allocations are permanent");
  });

  it("rejects machine credentials with more than a one-year lifetime", async () => {
    const { user } = await seedOwnershipGraph();
    await expect(
      env.DB.prepare(
        `INSERT INTO machines
         (id, user_id, name, credential_hash_sha256, credential_prefix,
          credential_version, revoked, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          "mch_too_long",
          user.id,
          "Impossible machine",
          "too-long-hash",
          "zeh_machine_v1_",
          1,
          0,
          NOW,
          NOW + YEAR_MS + 1,
        )
        .run(),
    ).rejects.toThrow("machines_one_year_max_lifetime");
  });

  it("rejects cross-owner attempt rows", async () => {
    const { machine, project } = await seedOwnershipGraph();
    const database = createControlDatabase(env.DB);
    await seedUser(database, {
      id: "usr_other",
      canonicalHandle: "other",
      createdAt: NOW,
    });

    await expect(
      env.DB.prepare(
        `INSERT INTO publication_attempts
         (id, project_id, user_id, machine_id, state, base_generation,
          base_logical_bytes, staged_manifest_r2_key, manifest_hash,
          logical_bytes, file_count, reserved_active_delta_bytes,
          reserved_physical_upload_bytes, created_at, expires_at, settled_at)
         VALUES (?, ?, ?, ?, 'open', 0, 0, ?, ?, 0, 0, 0, 0, ?, ?, NULL)`,
      )
        .bind(
          "att_cross_owner",
          project.id,
          "usr_other",
          machine.id,
          "staging/cross-owner.json",
          "cross-owner-hash",
          NOW,
          NOW + 1_000,
        )
        .run(),
    ).rejects.toThrow("FOREIGN KEY constraint failed");
  });
});

describe("guarded D1 batches", () => {
  it("rejects a zero-row conditional write even though D1 reports SQL success", async () => {
    await expect(
      executeGuardedBatch(env.DB, [
        {
          name: "reserve active quota",
          statement: env.DB.prepare(
            "UPDATE user SET reserved_active_delta_bytes = reserved_active_delta_bytes + ? WHERE id = ?",
          ).bind(10, "usr_missing"),
          expectedChanges: 1,
        },
      ]),
    ).rejects.toMatchObject({
      name: "GuardedBatchError",
      failures: [{ name: "reserve active quota", expectedChanges: 1, actualChanges: 0 }],
    } satisfies Partial<GuardedBatchError>);
  });

  it("returns results when every guarded statement changes exactly one row", async () => {
    const { user } = await seedOwnershipGraph();
    const results = await executeGuardedBatch(env.DB, [
      {
        name: "reserve active quota",
        statement: env.DB.prepare(
          "UPDATE user SET reserved_active_delta_bytes = reserved_active_delta_bytes + ? WHERE id = ?",
        ).bind(10, user.id),
        expectedChanges: 1,
      },
    ]);

    expect(results[0]?.meta.changes).toBe(1);
  });
});
