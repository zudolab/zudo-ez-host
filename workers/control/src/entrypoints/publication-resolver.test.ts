import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { beforeEach, describe, expect, inject, it } from "vitest";

import { createControlDatabase } from "../db/database.js";
import { seedMachine, seedUser } from "../db/seeds.js";
import { applyControlMigrations } from "../db/testing.js";
import { registerProject, type ProjectOwnerContext } from "../projects/registration.js";

const NOW = 1_700_000_000_000;
const YEAR_MS = 365 * 24 * 60 * 60 * 1_000;

beforeEach(async () => {
  await reset();
  await applyControlMigrations(env.DB, inject("controlMigrations"));
});

async function seedOwner(
  id = "usr_resolution_entrypoint",
  canonicalHandle = "resolver",
): Promise<ProjectOwnerContext> {
  const database = createControlDatabase(env.DB);
  await seedUser(database, { id, canonicalHandle, createdAt: NOW });
  return { userId: id };
}

async function publishProject(projectId: string, ownerId: string, machineId: string) {
  await env.DB.prepare(
    `INSERT INTO publication_attempts
         (id, project_id, user_id, machine_id, state, base_generation,
          base_logical_bytes, staged_manifest_r2_key, manifest_hash,
          logical_bytes, file_count, reserved_active_delta_bytes,
          reserved_physical_upload_bytes, created_at, expires_at, settled_at)
       VALUES (?, ?, ?, ?, 'committed', 0, 0, ?, ?, 0, 0, 0, 0, ?, ?, ?)`,
  )
    .bind(
      `att_${projectId}`,
      projectId,
      ownerId,
      machineId,
      `staging/${projectId}.json`,
      `manifest-${projectId}`,
      NOW,
      NOW + 1_000,
      NOW + 1,
    )
    .run();
  await env.DB.prepare(
    `INSERT INTO publications
         (id, project_id, attempt_id, generation, artifact_hash, machine_id,
          machine_name_snapshot, logical_bytes, physical_bytes, file_count,
          object_count, published_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, 0, 0, 0, 0, ?)`,
  )
    .bind(
      `pub_${projectId}`,
      projectId,
      `att_${projectId}`,
      `artifact-${projectId}`,
      machineId,
      "Test Mac",
      NOW + 2,
    )
    .run();
  await env.DB.prepare(
    "UPDATE project_heads SET generation = 1, publication_id = ?, updated_at = ? WHERE project_id = ?",
  )
    .bind(`pub_${projectId}`, NOW + 2, projectId)
    .run();
}

async function seedResolutionFixtures() {
  const owner = await seedOwner();
  const database = createControlDatabase(env.DB);
  const machine = await seedMachine(database, {
    id: "mch_resolution_entrypoint",
    userId: owner.userId,
    name: "Test Mac",
    credentialHashSha256: "resolution-entrypoint-machine-hash",
    credentialPrefix: "zeh_machine_v1_",
    credentialVersion: 1,
    createdAt: NOW,
    expiresAt: NOW + YEAR_MS,
  });
  const published = await registerProject(env.DB, owner, { slug: "published" }, { now: NOW });
  const unpublished = await registerProject(env.DB, owner, { slug: "draft" }, { now: NOW });
  await publishProject(published.project.id, owner.userId, machine.id);

  return { owner, published, unpublished };
}

function publicationResolverService() {
  return env.PUBLICATION_RESOLVER;
}

describe("PublicationResolver service binding", () => {
  it("returns only the documented resolution fields for a published hit", async () => {
    const { published } = await seedResolutionFixtures();

    const resolution = await publicationResolverService().resolvePublication("PUBLISHED--RESOLVER");

    expect(resolution).toEqual({
      projectId: published.project.id,
      artifactHash: `artifact-${published.project.id}`,
      servingFlags: { spaFallback: false, gated: false },
    });
    expect(resolution).not.toBeNull();
    if (resolution === null) {
      return;
    }
    expect(Object.keys(resolution)).toEqual(["projectId", "artifactHash", "servingFlags"]);
    expect(Object.keys(resolution.servingFlags)).toEqual(["spaFallback", "gated"]);
  });

  it.each([
    ["invalid label", "not-a-label"],
    ["unknown label", "missing--resolver"],
    ["unpublished project", "draft--resolver"],
  ] as const)("returns null for an %s", async (_caseName, label) => {
    await seedResolutionFixtures();

    await expect(publicationResolverService().resolvePublication(label)).resolves.toBeNull();
  });

  it("returns null for a taken-down project just like every other miss", async () => {
    const { published } = await seedResolutionFixtures();
    await env.DB.prepare("UPDATE projects SET status = 'taken_down' WHERE id = ?")
      .bind(published.project.id)
      .run();

    await expect(
      publicationResolverService().resolvePublication("published--resolver"),
    ).resolves.toBeNull();
  });
});
