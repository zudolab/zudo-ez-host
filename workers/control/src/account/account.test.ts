import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { beforeEach, describe, expect, inject, it } from "vitest";

import { app, createControlApp } from "../app.js";
import { createAuth, type AuthRuntimeEnv } from "../auth/better-auth.js";
import { createControlDatabase } from "../db/database.js";
import { seedUser } from "../db/seeds.js";
import { applyControlMigrations } from "../db/testing.js";
import { claimHandle, HandleClaimError } from "./handle.js";

const BASE_URL = "https://control.test";
const PASSWORD = "correct horse battery staple";
const NOW = 1_700_000_000_000;

function runtimeEnv(allowlist: string): ControlEnv & AuthRuntimeEnv {
  return {
    DB: env.DB,
    ARTIFACTS: env.ARTIFACTS,
    PUBLICATION_RESOLVER: env.PUBLICATION_RESOLVER,
    BETTER_AUTH_SECRET: `${crypto.randomUUID()}${crypto.randomUUID()}`,
    BETTER_AUTH_BASE_URL: BASE_URL,
    BETTER_AUTH_TRUSTED_ORIGINS: BASE_URL,
    PUBLIC_CONTENT_DOMAIN: "public.test",
    SIGNUP_ALLOWED_EMAILS: allowlist,
  };
}

function sessionCookie(response: Response): string {
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith("__Host-zudo.session_token="));
  if (!cookie) throw new Error("Expected Better Auth to set a session cookie");
  return cookie.split(";", 1)[0] ?? "";
}

async function createBrowserSession(authEnv: AuthRuntimeEnv, email: string, name: string) {
  const response = await createAuth(authEnv, { enableInvitedEmailSignUp: true }).handler(
    new Request(`${BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL },
      body: JSON.stringify({ name, email, password: PASSWORD }),
    }),
  );
  expect(response.status).toBe(200);
  const user = await env.DB.prepare("SELECT id FROM user WHERE email = ?")
    .bind(email)
    .first<{ id: string }>();
  if (user === null) throw new Error("Expected Better Auth to create a user");
  return { cookie: sessionCookie(response), userId: user.id };
}

beforeEach(async () => {
  await reset();
  await applyControlMigrations(env.DB, inject("controlMigrations"));
});

describe("account handle claim", () => {
  it("validates through the shared hostname grammar and returns stable errors", async () => {
    const authEnv = runtimeEnv("invalid@example.test");
    const browser = await createBrowserSession(authEnv, "invalid@example.test", "Invalid User");
    const request = (handle: unknown) =>
      createControlApp().request(
        `${BASE_URL}/api/account/handle`,
        {
          method: "POST",
          headers: {
            cookie: browser.cookie,
            origin: BASE_URL,
            "content-type": "application/json",
          },
          body: JSON.stringify({ handle }),
        },
        authEnv,
      );

    const invalid = await request("bad--handle");
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({
      error: "invalid_handle",
      reason: "contains_delimiter",
    });

    const reserved = await request("admin");
    expect(reserved.status).toBe(400);
    await expect(reserved.json()).resolves.toEqual({
      error: "invalid_handle",
      reason: "reserved_name",
    });
  });

  it("claims once, canonicalizes the value, and exposes only the session user", async () => {
    const authEnv = runtimeEnv("claim@example.test");
    const browser = await createBrowserSession(authEnv, "claim@example.test", "Claim User");

    const beforeClaim = await createControlApp().request(
      `${BASE_URL}/api/account/me`,
      { headers: { cookie: browser.cookie } },
      authEnv,
    );
    expect(beforeClaim.status).toBe(200);
    await expect(beforeClaim.json()).resolves.toMatchObject({
      id: browser.userId,
      handle: null,
    });

    const claimed = await createControlApp().request(
      `${BASE_URL}/api/account/handle`,
      {
        method: "POST",
        headers: {
          cookie: browser.cookie,
          origin: BASE_URL,
          "content-type": "application/json",
        },
        body: JSON.stringify({ handle: "Claim-User" }),
      },
      authEnv,
    );
    expect(claimed.status).toBe(200);
    await expect(claimed.json()).resolves.toMatchObject({
      id: browser.userId,
      email: "claim@example.test",
      name: "Claim User",
      handle: "claim-user",
    });

    const secondClaim = await createControlApp().request(
      `${BASE_URL}/api/account/handle`,
      {
        method: "POST",
        headers: {
          cookie: browser.cookie,
          origin: BASE_URL,
          "content-type": "application/json",
        },
        body: JSON.stringify({ handle: "another-name" }),
      },
      authEnv,
    );
    expect(secondClaim.status).toBe(409);
    await expect(secondClaim.json()).resolves.toEqual({ error: "handle_already_claimed" });

    await expect(
      env.DB.prepare("SELECT canonical_handle AS handle FROM user WHERE id = ?")
        .bind(browser.userId)
        .first(),
    ).resolves.toEqual({ handle: "claim-user" });

    const withIgnoredId = await createControlApp().request(
      `${BASE_URL}/api/account/me?userId=another-user`,
      { headers: { cookie: browser.cookie } },
      authEnv,
    );
    expect(withIgnoredId.status).toBe(200);
    await expect(withIgnoredId.json()).resolves.toMatchObject({ id: browser.userId });
  });

  it("uses the unique index as the authority for concurrent claims", async () => {
    const database = createControlDatabase(env.DB);
    await seedUser(database, {
      id: "usr_race_a",
      canonicalHandle: null,
      email: "race-a@example.test",
      name: "Race A",
      createdAt: NOW,
    });
    await seedUser(database, {
      id: "usr_race_b",
      canonicalHandle: null,
      email: "race-b@example.test",
      name: "Race B",
      createdAt: NOW,
    });

    const outcomes = await Promise.allSettled([
      claimHandle(env.DB, { userId: "usr_race_a" }, "same-handle", { now: NOW }),
      claimHandle(env.DB, { userId: "usr_race_b" }, "same-handle", { now: NOW }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : undefined).toBeInstanceOf(
      HandleClaimError,
    );
    expect(
      rejected?.status === "rejected" ? (rejected.reason as HandleClaimError).code : undefined,
    ).toBe("handle_taken");

    const rows = await env.DB.prepare(
      "SELECT id, canonical_handle AS handle FROM user WHERE canonical_handle = ?",
    )
      .bind("same-handle")
      .all<{ id: string; handle: string }>();
    expect(rows.results).toHaveLength(1);
    expect(["usr_race_a", "usr_race_b"]).toContain(rows.results[0]?.id);
  });

  it("reports a handle owned by another account as a conflict", async () => {
    const database = createControlDatabase(env.DB);
    await seedUser(database, {
      id: "usr_taken",
      canonicalHandle: "taken-handle",
      email: "taken@example.test",
      name: "Taken User",
      createdAt: NOW,
    });
    await seedUser(database, {
      id: "usr_claiming",
      canonicalHandle: null,
      email: "claiming@example.test",
      name: "Claiming User",
      createdAt: NOW,
    });

    await expect(
      claimHandle(env.DB, { userId: "usr_claiming" }, "TAKEN-HANDLE", { now: NOW }),
    ).rejects.toMatchObject({ code: "handle_taken", status: 409 });
    await expect(
      env.DB.prepare("SELECT canonical_handle AS handle FROM user WHERE id = ?")
        .bind("usr_claiming")
        .first(),
    ).resolves.toEqual({ handle: null });
  });

  it("requires a session for the own-profile routes", async () => {
    const authEnv = runtimeEnv("anonymous@example.test");
    const response = await app.request(`${BASE_URL}/api/account/me`, {}, authEnv);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "session_authentication_required",
    });
  });
});
