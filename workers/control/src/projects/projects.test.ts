import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { beforeEach, describe, expect, inject, it } from "vitest";

import { app } from "../app.js";
import { createControlDatabase } from "../db/database.js";
import { getOwnedProject } from "../db/queries.js";
import { seedMachine, seedUser } from "../db/seeds.js";
import { applyControlMigrations } from "../db/testing.js";
import {
  getOwnedProjectBySlug,
  registerProject,
  type ProjectOwnerContext,
  type ProjectRegistrationInput,
} from "./index.js";
import { resolveProjectByLabel } from "./resolution.js";

const NOW = 1_700_000_000_000;
const YEAR_MS = 365 * 24 * 60 * 60 * 1_000;

beforeEach(async () => {
  await reset();
  await applyControlMigrations(env.DB, inject("controlMigrations"));
});

async function seedOwner(id = "usr_test", canonicalHandle = "owner"): Promise<ProjectOwnerContext> {
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

describe("project registration", () => {
  it("rejects invalid grammar and reserved names for slug and stored handle", async () => {
    const owner = await seedOwner();

    await expect(
      registerProject(env.DB, owner, { slug: "API" }, { now: NOW }),
    ).rejects.toMatchObject({ code: "invalid_slug", reason: "reserved_name" });
    await expect(
      registerProject(env.DB, owner, { slug: "bad--slug" }, { now: NOW }),
    ).rejects.toMatchObject({ code: "invalid_slug", reason: "contains_delimiter" });

    const invalidHandleOwner = await seedOwner("usr_invalid_handle", "Admin");
    await expect(
      registerProject(env.DB, invalidHandleOwner, { slug: "site" }, { now: NOW }),
    ).rejects.toMatchObject({ code: "invalid_owner_handle", reason: "reserved_name" });
  });

  it("uses the owner row's canonical handle and creates all three rows atomically", async () => {
    const owner = await seedOwner();
    const contextWithUntrustedHandle = { userId: owner.userId, canonicalHandle: "attacker" };
    const inputWithUntrustedHandle = {
      slug: "My-Site",
      handle: "attacker",
    } as ProjectRegistrationInput & { handle: string };

    const result = await registerProject(
      env.DB,
      contextWithUntrustedHandle,
      inputWithUntrustedHandle,
      { now: NOW, projectIdFactory: () => "prj_atomic" },
    );

    expect(result.created).toBe(true);
    expect(result.project).toMatchObject({
      id: "prj_atomic",
      userId: owner.userId,
      slug: "my-site",
      displayName: "my-site",
      status: "active",
    });
    expect(result.hostname).toMatchObject({
      label: "my-site--owner",
      userId: owner.userId,
      projectId: "prj_atomic",
    });
    expect(result.head).toMatchObject({
      projectId: "prj_atomic",
      generation: 0,
      publicationId: null,
    });

    const counts = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS count FROM projects").first<{ count: number }>(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM hostname_allocations").first<{
        count: number;
      }>(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM project_heads").first<{ count: number }>(),
    ]);
    expect(counts.map((row) => row?.count)).toEqual([1, 1, 1]);
  });

  it("lets exactly one concurrent request win and leaves no partial rows", async () => {
    const owner = await seedOwner();
    const results = await Promise.all([
      registerProject(env.DB, owner, { slug: "race" }, { now: NOW }),
      registerProject(env.DB, owner, { slug: "race" }, { now: NOW }),
    ]);

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.project.id)).size).toBe(1);
    expect(new Set(results.map((result) => result.hostname.label))).toEqual(
      new Set(["race--owner"]),
    );

    const rows = await Promise.all([
      env.DB.prepare("SELECT id FROM projects").all<{ id: string }>(),
      env.DB.prepare("SELECT project_id AS projectId FROM hostname_allocations").all<{
        projectId: string;
      }>(),
      env.DB.prepare("SELECT project_id AS projectId FROM project_heads").all<{
        projectId: string;
      }>(),
    ]);
    expect(rows.map((result) => result.results)).toEqual([
      [{ id: results[0]?.project.id }],
      [{ projectId: results[0]?.project.id }],
      [{ projectId: results[0]?.project.id }],
    ]);
  });

  it("returns the existing project for same-owner re-registration", async () => {
    const owner = await seedOwner();
    const first = await registerProject(
      env.DB,
      owner,
      { slug: "portfolio", displayName: "First name" },
      { now: NOW },
    );
    const second = await registerProject(
      env.DB,
      owner,
      { slug: "PORTFOLIO", displayName: "Changed name" },
      { now: NOW + 1_000 },
    );

    expect(second.created).toBe(false);
    expect(second.project.id).toBe(first.project.id);
    expect(second.project.displayName).toBe("First name");
    expect(second.hostname.label).toBe(first.hostname.label);
    expect(second.head).toEqual(first.head);
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM projects").first<{ count: number }>(),
    ).resolves.toMatchObject({ count: 1 });
  });

  it("does not allow one owner to address another owner's project", async () => {
    const ownerA = await seedOwner("usr_a", "alice");
    const ownerB = await seedOwner("usr_b", "bob");
    const projectA = await registerProject(env.DB, ownerA, { slug: "site" }, { now: NOW });
    const projectB = await registerProject(env.DB, ownerB, { slug: "site" }, { now: NOW });

    expect(projectB.project.id).not.toBe(projectA.project.id);
    expect(projectB.hostname.label).toBe("site--bob");
    expect(
      await getOwnedProject(createControlDatabase(env.DB), ownerB.userId, projectA.project.id),
    ).toBe(undefined);
    await expect(getOwnedProjectBySlug(env.DB, ownerB, "site")).resolves.toMatchObject({
      id: projectB.project.id,
    });
  });
});

describe("project label resolution", () => {
  it("resolves only an active project with a published current head", async () => {
    const owner = await seedOwner("usr_resolution", "resolver");
    const database = createControlDatabase(env.DB);
    const machine = await seedMachine(database, {
      id: "mch_resolution",
      userId: owner.userId,
      name: "Test Mac",
      credentialHashSha256: "resolution-machine-hash",
      credentialPrefix: "zeh_machine_v1_",
      credentialVersion: 1,
      createdAt: NOW,
      expiresAt: NOW + YEAR_MS,
    });
    const published = await registerProject(env.DB, owner, { slug: "published" }, { now: NOW });
    const unpublished = await registerProject(env.DB, owner, { slug: "draft" }, { now: NOW });
    await publishProject(published.project.id, owner.userId, machine.id);

    await expect(resolveProjectByLabel(env.DB, "PUBLISHED--RESOLVER")).resolves.toMatchObject({
      projectId: published.project.id,
      userId: owner.userId,
      label: "published--resolver",
      generation: 1,
      publicationId: `pub_${published.project.id}`,
    });
    await expect(resolveProjectByLabel(env.DB, "missing--resolver")).resolves.toBeNull();
    await expect(resolveProjectByLabel(env.DB, "draft--resolver")).resolves.toBeNull();
    await expect(resolveProjectByLabel(env.DB, "published--other")).resolves.toBeNull();
    await expect(resolveProjectByLabel(env.DB, "not-a-label")).resolves.toBeNull();

    await env.DB.prepare("UPDATE projects SET status = 'taken_down' WHERE id = ?")
      .bind(published.project.id)
      .run();
    await expect(resolveProjectByLabel(env.DB, "published--resolver")).resolves.toBeNull();

    expect(unpublished.head.generation).toBe(0);
  });
});

describe("project registration route", () => {
  it("requires the machine-authenticated owner context", async () => {
    const response = await app.request(
      new Request("https://control.test/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: "site" }),
      }),
      {},
      env,
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "machine_authentication_failed",
      reason: "missing_authorization",
    });
  });
});
