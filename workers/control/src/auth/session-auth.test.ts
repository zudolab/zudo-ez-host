import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { Hono } from "hono";
import { beforeEach, describe, expect, inject, it } from "vitest";

import { applyControlMigrations } from "../db/testing.js";
import { createAuth, type AuthRuntimeEnv } from "./better-auth.js";
import {
  SESSION_AUTH_CONTEXT_KEY,
  sessionAuthMiddleware,
  type SessionAuthEnv,
} from "./session-auth.js";

const BASE_URL = "https://control.test";
const EMAIL = "session@example.test";

function runtimeEnv(): AuthRuntimeEnv {
  return {
    DB: env.DB,
    BETTER_AUTH_SECRET: `${crypto.randomUUID()}${crypto.randomUUID()}`,
    BETTER_AUTH_BASE_URL: BASE_URL,
    BETTER_AUTH_TRUSTED_ORIGINS: BASE_URL,
    SIGNUP_ALLOWED_EMAILS: EMAIL,
  };
}

function cookieFrom(response: Response): string {
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith("__Host-zudo.session_token="));
  if (!cookie) throw new Error("Expected a session cookie");
  return cookie.split(";", 1)[0] ?? "";
}

async function createSession(authEnv: AuthRuntimeEnv) {
  const response = await createAuth(authEnv, { enableInvitedEmailSignUp: true }).handler(
    new Request(`${BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL },
      body: JSON.stringify({
        name: "Session User",
        email: EMAIL,
        password: "correct horse battery staple",
      }),
    }),
  );
  expect(response.status).toBe(200);
  return cookieFrom(response);
}

beforeEach(async () => {
  await reset();
  await applyControlMigrations(env.DB, inject("controlMigrations"));
});

describe("session authentication", () => {
  it("returns the stable no-store 401 when no Better Auth session exists", async () => {
    const probe = new Hono<SessionAuthEnv>();
    probe.use("*", sessionAuthMiddleware);
    probe.get("/", (context) => context.json(context.get(SESSION_AUTH_CONTEXT_KEY)));

    const response = await probe.fetch(new Request(BASE_URL), runtimeEnv());

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      error: "session_authentication_required",
    });
  });

  it("exposes only the opaque user ID from a valid session", async () => {
    const authEnv = runtimeEnv();
    const cookie = await createSession(authEnv);
    const user = await env.DB.prepare("SELECT id FROM user WHERE email = ?")
      .bind(EMAIL)
      .first<{ id: string }>();
    const probe = new Hono<SessionAuthEnv>();
    probe.use("*", sessionAuthMiddleware);
    probe.get("/", (context) => context.json(context.get(SESSION_AUTH_CONTEXT_KEY)));

    const response = await probe.fetch(new Request(BASE_URL, { headers: { cookie } }), authEnv);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ userId: user?.id });
  });
});
