import {
  MACHINE_TOKEN_PREFIX,
  MACHINE_TOKEN_VERSION,
  encodeCanonical,
  hashMachineToken,
  parseMachineToken,
  type Manifest,
} from "@zudo-ez-host/core";
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { beforeEach, describe, expect, inject, it } from "vitest";

import { createControlApp } from "../app.js";
import { createAuth, type AuthRuntimeEnv } from "../auth/better-auth.js";
import { deriveS256CodeChallenge } from "../auth/pkce.js";
import { createControlDatabase } from "../db/database.js";
import { seedProject, seedUser } from "../db/seeds.js";
import { applyControlMigrations } from "../db/testing.js";
import type { UploadUrlSigner } from "../storage/index.js";
import { generateAuthorizationCode, hashAuthorizationCode } from "./codes.js";
import { insertDesktopAuthorizationCode } from "./queries.js";

const BASE_URL = "https://control.test";
const REDIRECT_URI = "http://127.0.0.1:49152/callback";
const VERIFIER = "desktop-verifier-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const YEAR_MS = 365 * 24 * 60 * 60 * 1_000;

interface Grant {
  readonly code: string;
  readonly verifier: string;
  readonly redirectUri: string;
  readonly machineId: string;
  readonly machineName: string;
  readonly userId: string;
}

beforeEach(async () => {
  await reset();
  await applyControlMigrations(env.DB, inject("controlMigrations"));
});

async function seedGrant(
  overrides: Partial<{
    code: string;
    verifier: string;
    redirectUri: string;
    machineId: string;
    machineName: string;
    userId: string;
    createdAt: number;
    expiresAt: number;
  }> = {},
): Promise<Grant> {
  const now = Date.now();
  const userId = overrides.userId ?? `usr_${crypto.randomUUID()}`;
  const code = overrides.code ?? generateAuthorizationCode();
  const verifier = overrides.verifier ?? VERIFIER;
  const redirectUri = overrides.redirectUri ?? REDIRECT_URI;
  const machineId = overrides.machineId ?? `mch_${crypto.randomUUID()}`;
  const machineName = overrides.machineName ?? "Studio Mac";
  const database = createControlDatabase(env.DB);
  await seedUser(database, {
    id: userId,
    canonicalHandle: `user${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
    createdAt: now,
  });
  await insertDesktopAuthorizationCode(env.DB, {
    codeHash: await hashAuthorizationCode(code),
    userId,
    redirectUri,
    codeChallenge: await deriveS256CodeChallenge(verifier),
    codeChallengeMethod: "S256",
    scope: "publish",
    machineName,
    machineId,
    createdAt: overrides.createdAt ?? now,
    expiresAt: overrides.expiresAt ?? now + 60_000,
  });
  return { code, verifier, redirectUri, machineId, machineName, userId };
}

async function exchangeRequest(
  grant: Grant,
  overrides: Partial<{ code: string; codeVerifier: unknown; redirectUri: string }> = {},
  cookie?: string,
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookie !== undefined) headers.cookie = cookie;
  return await createControlApp().request(
    `${BASE_URL}/desktop/token`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        code: overrides.code ?? grant.code,
        code_verifier: overrides.codeVerifier ?? grant.verifier,
        redirect_uri: overrides.redirectUri ?? grant.redirectUri,
      }),
    },
    env,
  );
}

async function expectInvalidGrant(response: Response): Promise<void> {
  expect(response.status).toBe(400);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  await expect(response.json()).resolves.toEqual({ error: "invalid_grant" });
}

async function createValidSessionCookie(): Promise<string> {
  const email = `session-${crypto.randomUUID()}@example.test`;
  const authEnv: ControlEnv & AuthRuntimeEnv = {
    DB: env.DB,
    ARTIFACTS: env.ARTIFACTS,
    PUBLICATION_RESOLVER: env.PUBLICATION_RESOLVER,
    BETTER_AUTH_SECRET: `${crypto.randomUUID()}${crypto.randomUUID()}`,
    BETTER_AUTH_BASE_URL: BASE_URL,
    BETTER_AUTH_TRUSTED_ORIGINS: BASE_URL,
    SIGNUP_ALLOWED_EMAILS: email,
  };
  const response = await createAuth(authEnv, { enableInvitedEmailSignUp: true }).handler(
    new Request(`${BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: BASE_URL },
      body: JSON.stringify({
        name: "Session User",
        email,
        password: "correct horse battery staple",
      }),
    }),
  );
  expect(response.status).toBe(200);
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith("__Host-zudo.session_token="));
  if (cookie === undefined) throw new Error("Expected Better Auth to create a session cookie");
  return cookie.split(";", 1)[0] as string;
}

describe("desktop machine-token exchange", () => {
  it("mints one hash-only V1 credential with at most a one-year lifetime", async () => {
    const grant = await seedGrant();
    const response = await exchangeRequest(grant);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json<{
      token: string;
      machine: { id: string; name: string; expiresAt: number };
    }>();
    expect(parseMachineToken(body.token).ok).toBe(true);
    expect(body.machine).toEqual({
      id: grant.machineId,
      name: grant.machineName,
      expiresAt: expect.any(Number),
    });

    const machine = await env.DB.prepare(
      `SELECT id, user_id AS userId, name, credential_hash_sha256 AS credentialHash,
        credential_prefix AS credentialPrefix, credential_version AS credentialVersion,
        created_at AS createdAt, expires_at AS expiresAt
       FROM machines WHERE id = ?`,
    )
      .bind(grant.machineId)
      .first<{
        id: string;
        userId: string;
        name: string;
        credentialHash: string;
        credentialPrefix: string;
        credentialVersion: number;
        createdAt: number;
        expiresAt: number;
      }>();
    expect(machine).toMatchObject({
      id: grant.machineId,
      userId: grant.userId,
      name: grant.machineName,
      credentialHash: await hashMachineToken(body.token),
      credentialPrefix: MACHINE_TOKEN_PREFIX,
      credentialVersion: MACHINE_TOKEN_VERSION,
    });
    expect((machine?.expiresAt ?? 0) - (machine?.createdAt ?? 0)).toBeLessThanOrEqual(YEAR_MS);
    expect(JSON.stringify(await env.DB.prepare("SELECT * FROM machines").all())).not.toContain(
      body.token,
    );
    expect(
      JSON.stringify(await env.DB.prepare("SELECT * FROM desktop_authorization_codes").all()),
    ).not.toContain(body.token);
  });

  it("lets the minted bearer authenticate a real publication prepare request", async () => {
    const grant = await seedGrant();
    const exchange = await exchangeRequest(grant);
    const { token } = await exchange.json<{ token: string }>();
    const database = createControlDatabase(env.DB);
    await seedProject(database, {
      id: "prj_minted",
      userId: grant.userId,
      slug: "minted-project",
      displayName: "Minted project",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const signer: UploadUrlSigner = {
      async signUpload(input) {
        return `https://uploads.test/${input.key}`;
      },
    };
    const manifest: Manifest = { version: 1, servingSemanticsVersion: 1, entries: [] };
    const response = await createControlApp({ prepare: { signer } }).request(
      `${BASE_URL}/api/projects/prj_minted/publish/prepare`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          manifest: new TextDecoder().decode(encodeCanonical(manifest)),
          transport: [],
        }),
      },
      env,
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      created: true,
      attempt: { projectId: "prj_minted" },
    });
    const attempt = await env.DB.prepare(
      "SELECT machine_id AS machineId FROM publication_attempts WHERE project_id = ?",
    )
      .bind("prj_minted")
      .first<{ machineId: string }>();
    expect(attempt?.machineId).toBe(grant.machineId);
  });

  it("allows exactly one of two simultaneous exchanges to mint", async () => {
    const grant = await seedGrant();
    const responses = await Promise.all([exchangeRequest(grant), exchangeRequest(grant)]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
    await expectInvalidGrant(responses.find((response) => response.status === 400) as Response);
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM machines").first<{
      count: number;
    }>();
    expect(count?.count).toBe(1);
    const code = await env.DB.prepare(
      "SELECT consumed_at AS consumedAt FROM desktop_authorization_codes",
    ).first<{ consumedAt: number | null }>();
    expect(code?.consumedAt).not.toBeNull();
  });

  it("rejects unknown, verifier, redirect, expiry, and replay failures stably", async () => {
    const unknown = await seedGrant();
    await expectInvalidGrant(await exchangeRequest(unknown, { code: generateAuthorizationCode() }));

    const wrongVerifier = await seedGrant();
    await expectInvalidGrant(
      await exchangeRequest(wrongVerifier, { codeVerifier: "x".repeat(43) }),
    );

    for (const malformed of ["x".repeat(42), "x".repeat(129), `${"x".repeat(42)}!`]) {
      const grant = await seedGrant();
      await expectInvalidGrant(await exchangeRequest(grant, { codeVerifier: malformed }));
    }

    const wrongRedirect = await seedGrant({
      redirectUri: "http://127.0.0.1:49152/%63allback",
    });
    await expectInvalidGrant(await exchangeRequest(wrongRedirect, { redirectUri: REDIRECT_URI }));

    const now = Date.now();
    const expired = await seedGrant({ createdAt: now - 60_001, expiresAt: now - 1 });
    await expectInvalidGrant(await exchangeRequest(expired));

    const replay = await seedGrant();
    expect((await exchangeRequest(replay)).status).toBe(200);
    await expectInvalidGrant(await exchangeRequest(replay));
  });

  it("does not accept a session cookie in place of PKCE proof", async () => {
    const cookie = await createValidSessionCookie();
    const grant = await seedGrant();
    const withoutCookie = await exchangeRequest(grant, { codeVerifier: "x".repeat(43) });
    const withCookie = await exchangeRequest(grant, { codeVerifier: "x".repeat(43) }, cookie);

    await expectInvalidGrant(withoutCookie);
    await expectInvalidGrant(withCookie);
  });

  it("returns a bounded stable invalid-request error for malformed JSON", async () => {
    const response = await createControlApp().request(
      `${BASE_URL}/desktop/token`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" },
      env,
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
  });
});
