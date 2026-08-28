import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { beforeEach, describe, expect, inject, it } from "vitest";

import {
  MACHINE_TOKEN_PREFIX,
  MACHINE_TOKEN_VERSION,
  generateMachineToken,
  hashMachineToken,
} from "@zudo-ez-host/core";

import { app, createControlApp } from "../app.js";
import { createAuth, type AuthRuntimeEnv } from "../auth/better-auth.js";
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
import { listOwnedProjects } from "./queries.js";
import { resolveProjectByLabel } from "./resolution.js";

const NOW = 1_700_000_000_000;
const YEAR_MS = 365 * 24 * 60 * 60 * 1_000;
const BASE_URL = "https://control.test";
const PUBLIC_CONTENT_DOMAIN = "public.test";

beforeEach(async () => {
  await reset();
  await applyControlMigrations(env.DB, inject("controlMigrations"));
});

async function seedOwner(
  id = "usr_test",
  canonicalHandle: string | null = "owner",
): Promise<ProjectOwnerContext> {
  const database = createControlDatabase(env.DB);
  await seedUser(database, { id, canonicalHandle, createdAt: NOW });
  return { userId: id };
}

async function seedMachineCredential(userId: string, canonicalHandle: string) {
  const database = createControlDatabase(env.DB);
  await seedUser(database, { id: userId, canonicalHandle, createdAt: NOW });
  const token = generateMachineToken();
  await seedMachine(database, {
    id: `mch_${userId}`,
    userId,
    name: `${canonicalHandle} Mac`,
    credentialHashSha256: await hashMachineToken(token),
    credentialPrefix: MACHINE_TOKEN_PREFIX,
    credentialVersion: MACHINE_TOKEN_VERSION,
    createdAt: Date.now(),
    expiresAt: Date.now() + YEAR_MS,
  });
  return token;
}

function sessionRuntimeEnv(email: string): ControlEnv & AuthRuntimeEnv {
  return {
    DB: env.DB,
    ARTIFACTS: env.ARTIFACTS,
    PUBLICATION_RESOLVER: env.PUBLICATION_RESOLVER,
    BETTER_AUTH_SECRET: `${crypto.randomUUID()}${crypto.randomUUID()}`,
    BETTER_AUTH_BASE_URL: BASE_URL,
    BETTER_AUTH_TRUSTED_ORIGINS: BASE_URL,
    PUBLIC_CONTENT_DOMAIN,
    SIGNUP_ALLOWED_EMAILS: email,
  };
}

async function createBrowserSession(authEnv: AuthRuntimeEnv, email: string, handle: string) {
  const response = await createAuth(authEnv, { enableInvitedEmailSignUp: true }).handler(
    new Request(`${BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL },
      body: JSON.stringify({
        name: handle,
        email,
        password: "correct horse battery staple",
      }),
    }),
  );
  expect(response.status).toBe(200);
  const cookieHeader = response.headers
    .getSetCookie()
    .find((value) => value.startsWith("__Host-zudo.session_token="));
  if (!cookieHeader) throw new Error("Expected browser session cookie");
  const user = await env.DB.prepare("SELECT id FROM user WHERE email = ?")
    .bind(email)
    .first<{ id: string }>();
  if (!user) throw new Error("Expected browser session user");
  await env.DB.prepare("UPDATE user SET canonical_handle = ? WHERE id = ?")
    .bind(handle, user.id)
    .run();
  return { cookie: cookieHeader.split(";", 1)[0] ?? "", userId: user.id };
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

describe("project visibility", () => {
  it("lists only the owner projects with current head and publication attribution", async () => {
    const owner = await seedOwner("usr_visibility", "visibility");
    const other = await seedOwner("usr_visibility_other", "other");
    const published = await registerProject(env.DB, owner, { slug: "published" }, { now: NOW });
    const draft = await registerProject(env.DB, owner, { slug: "draft" }, { now: NOW + 1 });
    await registerProject(env.DB, other, { slug: "private" }, { now: NOW });
    const database = createControlDatabase(env.DB);
    const machine = await seedMachine(database, {
      id: "mch_visibility",
      userId: owner.userId,
      name: "Visibility Mac",
      credentialHashSha256: "visibility-machine-hash",
      credentialPrefix: "zeh_machine_v1_",
      credentialVersion: 1,
      createdAt: NOW,
      expiresAt: NOW + YEAR_MS,
    });
    await publishProject(published.project.id, owner.userId, machine.id);

    await expect(listOwnedProjects(env.DB, owner.userId, PUBLIC_CONTENT_DOMAIN)).resolves.toEqual([
      {
        id: published.project.id,
        slug: "published",
        displayName: "published",
        description: null,
        status: "active",
        createdAt: NOW,
        updatedAt: NOW,
        hostname: "published--visibility",
        publicUrl: "https://published--visibility.public.test/",
        generation: 1,
        machineNameSnapshot: "Test Mac",
        publishedAt: NOW + 2,
      },
      {
        id: draft.project.id,
        slug: "draft",
        displayName: "draft",
        description: null,
        status: "active",
        createdAt: NOW + 1,
        updatedAt: NOW + 1,
        hostname: "draft--visibility",
        publicUrl: "https://draft--visibility.public.test/",
        generation: 0,
        machineNameSnapshot: null,
        publishedAt: null,
      },
    ]);
  });

  it("rejects registration for an account without a claimed handle", async () => {
    const owner = await seedOwner("usr_unclaimed", null);

    await expect(
      registerProject(env.DB, owner, { slug: "site" }, { now: NOW }),
    ).rejects.toMatchObject({
      code: "owner_handle_unclaimed",
    });
  });
});

describe("project registration route", () => {
  it("requires an exact Origin before attempting browser-session authentication", async () => {
    const response = await app.request(
      new Request("https://control.test/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: "site" }),
      }),
      {},
      env,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_origin",
    });
  });

  it("allows a machine credential to register and read only its owner's project", async () => {
    const tokenA = await seedMachineCredential("usr_machine_a", "machinea");
    const tokenB = await seedMachineCredential("usr_machine_b", "machineb");
    const response = await app.request(
      `${BASE_URL}/api/projects`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokenA}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ slug: "site", userId: "usr_machine_b" }),
      },
      env,
    );

    expect(response.status).toBe(201);
    const body = await response.json<{ project: { id: string; userId: string } }>();
    expect(body.project.userId).toBe("usr_machine_a");

    const ownRead = await app.request(
      `${BASE_URL}/api/projects/${body.project.id}`,
      {
        headers: { authorization: `Bearer ${tokenA}` },
      },
      env,
    );
    expect(ownRead.status).toBe(200);

    const otherRead = await app.request(
      `${BASE_URL}/api/projects/${body.project.id}`,
      {
        headers: { authorization: `Bearer ${tokenB}` },
      },
      env,
    );
    expect(otherRead.status).toBe(404);
  });

  it("allows a browser session to register for itself but not read another owner's data", async () => {
    const authEnv = sessionRuntimeEnv("browser@example.test");
    const browser = await createBrowserSession(authEnv, "browser@example.test", "browser");
    const other = await seedOwner("usr_other_browser", "otherbrowser");
    const otherProject = await registerProject(env.DB, other, { slug: "private" }, { now: NOW });
    const response = await createControlApp().request(
      `${BASE_URL}/api/projects`,
      {
        method: "POST",
        headers: {
          cookie: browser.cookie,
          origin: BASE_URL,
          "content-type": "application/json",
        },
        body: JSON.stringify({ slug: "browser-site", userId: other.userId }),
      },
      authEnv,
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      project: { userId: browser.userId },
    });

    const otherRead = await createControlApp().request(
      `${BASE_URL}/api/projects/${otherProject.project.id}`,
      { headers: { cookie: browser.cookie } },
      authEnv,
    );
    expect(otherRead.status).toBe(404);
  });

  it("lists only the browser session owner's projects", async () => {
    const authEnv = sessionRuntimeEnv("list-browser@example.test");
    const browser = await createBrowserSession(authEnv, "list-browser@example.test", "listbrowser");
    const own = await registerProject(
      env.DB,
      { userId: browser.userId },
      { slug: "visible" },
      { now: NOW },
    );
    const other = await seedOwner("usr_list_other", "listother");
    const otherProject = await registerProject(env.DB, other, { slug: "hidden" }, { now: NOW });

    const response = await createControlApp().request(
      `${BASE_URL}/api/projects`,
      { headers: { cookie: browser.cookie } },
      authEnv,
    );
    expect(response.status).toBe(200);
    const body = await response.json<{
      projects: Array<{
        id: string;
        hostname: string | null;
        publicUrl: string | null;
        generation: number;
        userId?: string;
      }>;
    }>();
    expect(body.projects).toEqual([
      expect.objectContaining({
        id: own.project.id,
        hostname: "visible--listbrowser",
        publicUrl: "https://visible--listbrowser.public.test/",
        generation: 0,
      }),
    ]);
    expect(body.projects[0]).not.toHaveProperty("userId");
    expect(body.projects.some(({ id }) => id === otherProject.project.id)).toBe(false);

    const detailResponse = await createControlApp().request(
      `${BASE_URL}/api/projects/${own.project.id}`,
      { headers: { cookie: browser.cookie } },
      authEnv,
    );
    expect(detailResponse.status).toBe(200);
    const detailBody = await detailResponse.json<{
      project: {
        id: string;
        hostname: string | null;
        publicUrl: string | null;
        generation: number;
        userId?: string;
      };
    }>();
    expect(detailBody.project).toEqual(expect.objectContaining(body.projects[0]));
    expect(detailBody.project).not.toHaveProperty("userId");
  });

  it("returns a stable conflict when the browser owner has not claimed a handle", async () => {
    const authEnv = sessionRuntimeEnv("unclaimed-browser@example.test");
    const browser = await createBrowserSession(
      authEnv,
      "unclaimed-browser@example.test",
      "Unclaimed User",
    );
    await env.DB.prepare("UPDATE user SET canonical_handle = NULL WHERE id = ?")
      .bind(browser.userId)
      .run();
    const response = await createControlApp().request(
      `${BASE_URL}/api/projects`,
      {
        method: "POST",
        headers: {
          cookie: browser.cookie,
          origin: BASE_URL,
          "content-type": "application/json",
        },
        body: JSON.stringify({ slug: "site" }),
      },
      authEnv,
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "owner_handle_unclaimed" });
  });

  it("does not let a browser session cross the machine-only publish boundary", async () => {
    const authEnv = sessionRuntimeEnv("publisher@example.test");
    const browser = await createBrowserSession(authEnv, "publisher@example.test", "publisher");
    const response = await createControlApp().request(
      `${BASE_URL}/api/projects/prj_browser/publish/commit`,
      {
        method: "POST",
        headers: { cookie: browser.cookie, origin: BASE_URL },
        body: JSON.stringify({ attemptId: "att_browser" }),
      },
      authEnv,
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "machine_authentication_failed",
      reason: "missing_authorization",
    });
  });
});
