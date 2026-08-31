import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { beforeEach, describe, expect, inject, it } from "vitest";

import {
  MACHINE_TOKEN_PREFIX,
  MACHINE_TOKEN_VERSION,
  generateMachineToken,
  hashMachineToken,
} from "@zudo-ez-host/core";

import { createControlApp } from "../app.js";
import { createAuth, type AuthRuntimeEnv } from "../auth/better-auth.js";
import { createControlDatabase } from "../db/database.js";
import { seedMachine, seedProject, seedUser } from "../db/seeds.js";
import { applyControlMigrations } from "../db/testing.js";
import type { MachineSummary } from "./queries.js";

const BASE_URL = "https://control.test";
const YEAR_MS = 365 * 24 * 60 * 60 * 1_000;

type MachineFixture = {
  readonly machine: Awaited<ReturnType<typeof seedMachine>>;
  readonly token: string;
};

type BrowserSession = {
  readonly cookie: string;
  readonly userId: string;
  readonly authEnv: ControlEnv & AuthRuntimeEnv;
};

beforeEach(async () => {
  await reset();
  await applyControlMigrations(env.DB, inject("controlMigrations"));
});

function runtimeEnv(email: string): ControlEnv & AuthRuntimeEnv {
  return {
    DB: env.DB,
    ARTIFACTS: env.ARTIFACTS,
    PUBLICATION_RESOLVER: env.PUBLICATION_RESOLVER,
    BETTER_AUTH_SECRET: `${crypto.randomUUID()}${crypto.randomUUID()}`,
    BETTER_AUTH_BASE_URL: BASE_URL,
    BETTER_AUTH_TRUSTED_ORIGINS: BASE_URL,
    PUBLIC_CONTENT_DOMAIN: "public.test",
    SIGNUP_ALLOWED_EMAILS: email,
  };
}

async function createBrowserSession(email: string, name: string): Promise<BrowserSession> {
  const authEnv = runtimeEnv(email);
  const response = await createAuth(authEnv, { enableInvitedEmailSignUp: true }).handler(
    new Request(`${BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL },
      body: JSON.stringify({ name, email, password: "correct horse battery staple" }),
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
  return { cookie: cookieHeader.split(";", 1)[0] ?? "", userId: user.id, authEnv };
}

async function seedMachineForUser(
  userId: string,
  machineId: string,
  name: string,
  options: { readonly createdAt?: number; readonly revoked?: boolean } = {},
): Promise<MachineFixture> {
  const token = generateMachineToken();
  const createdAt = options.createdAt ?? Date.now();
  const database = createControlDatabase(env.DB);
  const machine = await seedMachine(database, {
    id: machineId,
    userId,
    name,
    credentialHashSha256: await hashMachineToken(token),
    credentialPrefix: MACHINE_TOKEN_PREFIX,
    credentialVersion: MACHINE_TOKEN_VERSION,
    revoked: options.revoked ?? false,
    createdAt,
    expiresAt: createdAt + YEAR_MS,
  });
  return { machine, token };
}

async function seedOwner(userId: string, canonicalHandle: string) {
  const database = createControlDatabase(env.DB);
  return seedUser(database, { id: userId, canonicalHandle, createdAt: Date.now() });
}

function sessionRequest(session: BrowserSession, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cookie", session.cookie);
  return createControlApp().request(`${BASE_URL}${path}`, { ...init, headers }, session.authEnv);
}

async function machineRequest(
  authEnv: ControlEnv & AuthRuntimeEnv,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return await createControlApp().request(`${BASE_URL}${path}`, { ...init, headers }, authEnv);
}

function expectNoCredentialHash(serialized: string, hash: string): void {
  expect(serialized).not.toContain(hash);
  expect(serialized).not.toContain("credential_hash_sha256");
  expect(serialized).not.toContain("credentialHashSha256");
}

describe("machine management API", () => {
  it("lists only owned machines and never serializes credential hashes", async () => {
    const session = await createBrowserSession("machine-owner@example.test", "Machine Owner");
    const other = await seedOwner("usr_machine_other", "machineother");
    const owned = await seedMachineForUser(session.userId, "mch_owned", "Studio Mac");
    await seedMachineForUser(other.id, "mch_other", "Other Mac");

    const response = await sessionRequest(session, "/api/machines");
    expect(response.status).toBe(200);
    const serialized = await response.text();
    expectNoCredentialHash(serialized, owned.machine.credentialHashSha256);
    expect(JSON.parse(serialized) as { machines: MachineSummary[] }).toEqual({
      machines: [
        {
          id: owned.machine.id,
          name: owned.machine.name,
          createdAt: owned.machine.createdAt,
          expiresAt: owned.machine.expiresAt,
          revoked: false,
          credentialPrefix: owned.machine.credentialPrefix,
          credentialVersion: owned.machine.credentialVersion,
        },
      ],
    });

    const read = await sessionRequest(session, `/api/machines/${owned.machine.id}`);
    expect(read.status).toBe(200);
    const readSerialized = await read.text();
    expectNoCredentialHash(readSerialized, owned.machine.credentialHashSha256);
    expect(JSON.parse(readSerialized) as { machine: MachineSummary }).toMatchObject({
      machine: { id: owned.machine.id, name: owned.machine.name },
    });
  });

  it("returns not-found for another owner's machine on read, rename, and revoke", async () => {
    const ownerB = await seedOwner("usr_machine_b", "machineb");
    const foreign = await seedMachineForUser(ownerB.id, "mch_foreign", "Foreign Mac");
    const session = await createBrowserSession("machine-a@example.test", "Machine A");

    const list = await sessionRequest(session, "/api/machines");
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toEqual({ machines: [] });

    const read = await sessionRequest(session, `/api/machines/${foreign.machine.id}`);
    expect(read.status).toBe(404);
    await expect(read.json()).resolves.toEqual({ error: "machine_not_found" });

    const rename = await sessionRequest(session, `/api/machines/${foreign.machine.id}`, {
      method: "PATCH",
      headers: { origin: BASE_URL, "content-type": "application/json" },
      body: JSON.stringify({ name: "Attempted takeover" }),
    });
    expect(rename.status).toBe(404);
    await expect(rename.json()).resolves.toEqual({ error: "machine_not_found" });

    const revoke = await sessionRequest(session, `/api/machines/${foreign.machine.id}/revoke`, {
      method: "POST",
      headers: { origin: BASE_URL },
    });
    expect(revoke.status).toBe(404);
    await expect(revoke.json()).resolves.toEqual({ error: "machine_not_found" });

    const row = await env.DB.prepare(
      "SELECT name, revoked FROM machines WHERE id = ? AND user_id = ?",
    )
      .bind(foreign.machine.id, ownerB.id)
      .first<{ name: string; revoked: number }>();
    expect(row).toEqual({ name: "Foreign Mac", revoked: 0 });
  });

  it("renames only the machine row and preserves publication name snapshots", async () => {
    const session = await createBrowserSession("machine-rename@example.test", "Machine Rename");
    const machine = await seedMachineForUser(session.userId, "mch_rename", "Before Rename");
    const database = createControlDatabase(env.DB);
    const project = await seedProject(database, {
      id: "prj_machine_rename",
      userId: session.userId,
      slug: "rename-site",
      displayName: "Rename Site",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await env.DB.prepare(
      `INSERT INTO publication_attempts
         (id, project_id, user_id, machine_id, state, base_generation,
          base_logical_bytes, staged_manifest_r2_key, manifest_hash,
          logical_bytes, file_count, reserved_active_delta_bytes,
          reserved_physical_upload_bytes, created_at, expires_at, settled_at)
       VALUES (?, ?, ?, ?, 'committed', 0, 0, ?, ?, 0, 0, 0, 0, ?, ?, ?)`,
    )
      .bind(
        "att_machine_rename",
        project.id,
        session.userId,
        machine.machine.id,
        "staging/machine-rename.json",
        "machine-rename-manifest",
        Date.now(),
        Date.now() + 1_000,
        Date.now() + 1,
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
        "pub_machine_rename",
        project.id,
        "att_machine_rename",
        "machine-rename-artifact",
        machine.machine.id,
        "Before Rename",
        Date.now(),
      )
      .run();

    const response = await sessionRequest(session, `/api/machines/${machine.machine.id}`, {
      method: "PATCH",
      headers: { origin: BASE_URL, "content-type": "application/json" },
      body: JSON.stringify({ name: "After Rename" }),
    });
    expect(response.status).toBe(200);
    const serialized = await response.text();
    expectNoCredentialHash(serialized, machine.machine.credentialHashSha256);
    expect(JSON.parse(serialized) as { machine: MachineSummary }).toMatchObject({
      machine: { id: machine.machine.id, name: "After Rename" },
    });

    const rows = await env.DB.prepare(
      `SELECT m.name AS machineName, p.machine_name_snapshot AS snapshot
       FROM machines AS m
       INNER JOIN publications AS p ON p.machine_id = m.id
       WHERE m.id = ? AND p.id = ?`,
    )
      .bind(machine.machine.id, "pub_machine_rename")
      .first<{ machineName: string; snapshot: string }>();
    expect(rows).toEqual({ machineName: "After Rename", snapshot: "Before Rename" });
  });

  it("revoke is idempotent, invalidates only that machine, and leaves sessions working", async () => {
    const session = await createBrowserSession("machine-revoke@example.test", "Machine Revoke");
    const revoked = await seedMachineForUser(session.userId, "mch_revoke", "Revoke Me");
    const other = await seedMachineForUser(session.userId, "mch_keep", "Keep Me");

    const first = await sessionRequest(session, `/api/machines/${revoked.machine.id}/revoke`, {
      method: "POST",
      headers: { origin: BASE_URL },
    });
    expect(first.status).toBe(200);
    const firstSerialized = await first.text();
    expectNoCredentialHash(firstSerialized, revoked.machine.credentialHashSha256);
    expect(JSON.parse(firstSerialized) as { machine: MachineSummary }).toMatchObject({
      machine: { id: revoked.machine.id, revoked: true },
    });

    const second = await sessionRequest(session, `/api/machines/${revoked.machine.id}/revoke`, {
      method: "POST",
      headers: { origin: BASE_URL },
    });
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({
      machine: { id: revoked.machine.id, revoked: true },
    });

    const list = await sessionRequest(session, "/api/machines");
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({
      machines: [
        { id: revoked.machine.id, revoked: true },
        { id: other.machine.id, revoked: false },
      ],
    });

    const revokedPublish = await machineRequest(
      session.authEnv,
      revoked.token,
      "/api/projects/prj_machine_revoke/publish/prepare",
      { method: "POST", body: "{}" },
    );
    expect(revokedPublish.status).toBe(401);
    await expect(revokedPublish.json()).resolves.toEqual({
      error: "machine_authentication_failed",
      reason: "revoked_credential",
    });

    const otherPublish = await machineRequest(
      session.authEnv,
      other.token,
      "/api/projects/prj_machine_revoke/publish/prepare",
      { method: "POST", body: "{}" },
    );
    expect(otherPublish.status).not.toBe(401);

    const browserStillWorks = await sessionRequest(session, "/api/machines");
    expect(browserStillWorks.status).toBe(200);
  });

  it("rejects machine credentials on every management route", async () => {
    const owner = await seedOwner("usr_machine_boundary", "machineboundary");
    const machine = await seedMachineForUser(owner.id, "mch_boundary", "Boundary Mac");
    const authEnv = runtimeEnv("machine-boundary@example.test");

    const requests: Promise<Response>[] = [
      machineRequest(authEnv, machine.token, "/api/machines"),
      machineRequest(authEnv, machine.token, "/api/machines/mch_boundary", {
        method: "PATCH",
        headers: { origin: BASE_URL, "content-type": "application/json" },
        body: JSON.stringify({ name: "Nope" }),
      }),
      machineRequest(authEnv, machine.token, "/api/machines/mch_boundary/revoke", {
        method: "POST",
        headers: { origin: BASE_URL },
      }),
    ];

    for (const response of await Promise.all(requests)) {
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        error: "session_authentication_required",
      });
    }
  });
});
