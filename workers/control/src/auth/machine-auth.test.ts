import { Hono } from "hono";
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { beforeEach, describe, expect, inject, it } from "vitest";

import {
  MACHINE_TOKEN_PREFIX,
  MACHINE_TOKEN_VERSION,
  MACHINE_TOKEN_WIRE_PREFIX,
  generateMachineToken,
  hashMachineToken,
} from "@zudo-ez-host/core";

import { app } from "../app.js";
import { createControlDatabase } from "../db/database.js";
import { seedMachine, seedProject, seedUser } from "../db/seeds.js";
import { applyControlMigrations } from "../db/testing.js";
import {
  MACHINE_AUTH_CONTEXT_KEY,
  createMachineAuthMiddleware,
  type MachineAuthEnv,
} from "./machine-auth.js";

const NOW = 2_000_000_000_000;
const YEAR_MS = 365 * 24 * 60 * 60 * 1_000;

const authProbe = new Hono<MachineAuthEnv>();
authProbe.use("*", createMachineAuthMiddleware({ now: () => NOW }));
authProbe.get("*", (context) => context.json(context.get(MACHINE_AUTH_CONTEXT_KEY)));

beforeEach(async () => {
  await reset();
  await applyControlMigrations(env.DB, inject("controlMigrations"));
});

async function seedAuthenticatedMachine(options: {
  readonly machineId: string;
  readonly userId: string;
  readonly canonicalHandle: string;
  readonly credentialPrefix?: typeof MACHINE_TOKEN_PREFIX | typeof MACHINE_TOKEN_WIRE_PREFIX;
  readonly revoked?: boolean;
  readonly expiresAt?: number;
}) {
  const database = createControlDatabase(env.DB);
  const user = await seedUser(database, {
    id: options.userId,
    canonicalHandle: options.canonicalHandle,
    createdAt: NOW - YEAR_MS,
  });
  const token = generateMachineToken();
  const expiresAt = options.expiresAt ?? NOW + YEAR_MS;
  const machine = await seedMachine(database, {
    id: options.machineId,
    userId: user.id,
    name: `${options.canonicalHandle} machine`,
    credentialHashSha256: await hashMachineToken(token),
    credentialPrefix: options.credentialPrefix ?? MACHINE_TOKEN_PREFIX,
    credentialVersion: MACHINE_TOKEN_VERSION,
    revoked: options.revoked ?? false,
    createdAt: expiresAt === NOW ? NOW - 1_000 : NOW,
    expiresAt,
  });
  return { database, machine, token, user };
}

async function request(token: string | undefined, path = "/api/projects/prj_owner/publish") {
  const headers = new Headers();
  if (token !== undefined) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return authProbe.fetch(new Request(`https://control.test${path}`, { headers }), env);
}

async function expectAuthError(
  response: Response,
  reason:
    | "missing_authorization"
    | "malformed_authorization"
    | "malformed_token"
    | "unknown_credential"
    | "revoked_credential"
    | "expired_credential",
  tokenReason?: string,
) {
  expect(response.status).toBe(401);
  await expect(response.json()).resolves.toEqual({
    error: "machine_authentication_failed",
    reason,
    ...(tokenReason === undefined ? {} : { tokenReason }),
  });
}

describe("machine publish authentication", () => {
  it("mounts machine authentication only on the publish path", async () => {
    await expectAuthError(
      await app.fetch(new Request("https://control.test/api/projects/prj_owner/publish"), env),
      "missing_authorization",
    );

    const healthResponse = await app.fetch(new Request("https://control.test/health"), env);
    expect(healthResponse.status).toBe(200);
  });

  it("accepts a valid token and derives every identity field from D1", async () => {
    const { token, user, machine } = await seedAuthenticatedMachine({
      machineId: "mch_valid",
      userId: "usr_valid",
      canonicalHandle: "owner",
      credentialPrefix: MACHINE_TOKEN_WIRE_PREFIX,
    });

    const response = await request(token);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      userId: user.id,
      machineId: machine.id,
    });
  });

  it("does not require the separate canonical-handle claim", async () => {
    const { token, user, machine } = await seedAuthenticatedMachine({
      machineId: "mch_unclaimed",
      userId: "usr_unclaimed",
      canonicalHandle: "temporary",
    });
    await env.DB.prepare("UPDATE user SET canonical_handle = NULL WHERE id = ?")
      .bind(user.id)
      .run();

    const response = await request(token);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      userId: user.id,
      machineId: machine.id,
    });
  });

  it("rejects a well-formed but unknown token without querying request-owned identity", async () => {
    await seedAuthenticatedMachine({
      machineId: "mch_known",
      userId: "usr_known",
      canonicalHandle: "known",
    });

    await expectAuthError(await request(generateMachineToken()), "unknown_credential");
  });

  it("rejects malformed wire credentials with the core parser reason", async () => {
    await expectAuthError(
      await request("not-a-machine-token"),
      "malformed_token",
      "invalid_prefix",
    );
  });

  it("rejects missing and malformed Authorization headers", async () => {
    await expectAuthError(await request(undefined), "missing_authorization");

    const response = await authProbe.fetch(
      new Request("https://control.test/api/projects/prj_owner/publish", {
        headers: { Authorization: "Basic credentials" },
      }),
      env,
    );
    await expectAuthError(response, "malformed_authorization");
  });

  it("rejects revoked credentials", async () => {
    const { token } = await seedAuthenticatedMachine({
      machineId: "mch_revoked",
      userId: "usr_revoked",
      canonicalHandle: "revoked",
      revoked: true,
    });

    await expectAuthError(await request(token), "revoked_credential");
  });

  it("rejects credentials at their expiration boundary", async () => {
    const { token } = await seedAuthenticatedMachine({
      machineId: "mch_expired",
      userId: "usr_expired",
      canonicalHandle: "expired",
      expiresAt: NOW,
    });

    await expectAuthError(await request(token), "expired_credential");
  });

  it("never lets a machine token adopt another owner's context", async () => {
    const ownerA = await seedAuthenticatedMachine({
      machineId: "mch_owner_a",
      userId: "usr_owner_a",
      canonicalHandle: "owner_a",
    });
    const database = ownerA.database;
    const ownerB = await seedAuthenticatedMachine({
      machineId: "mch_owner_b",
      userId: "usr_owner_b",
      canonicalHandle: "owner_b",
    });
    await seedProject(database, {
      id: "prj_owner_b",
      userId: ownerB.user.id,
      slug: "owner-b-project",
      displayName: "Owner B project",
      createdAt: NOW,
      updatedAt: NOW,
    });

    const response = await request(ownerA.token, "/api/projects/prj_owner_b/publish/commit");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      userId: ownerA.user.id,
      machineId: ownerA.machine.id,
    });
  });
});
