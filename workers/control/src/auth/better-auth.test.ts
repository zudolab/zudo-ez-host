import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { beforeEach, describe, expect, inject, it } from "vitest";

import { createControlApp } from "../app.js";
import { applyControlMigrations } from "../db/testing.js";
import { createAuth, type AuthRuntimeEnv } from "./better-auth.js";
import { renderLoginPage, safeReturnTo } from "./login-page.js";

const BASE_URL = "https://control.test";
const INVITED_EMAIL = "invited@example.test";

function runtimeEnv(allowlist: string | undefined): AuthRuntimeEnv {
  return {
    DB: env.DB,
    BETTER_AUTH_SECRET: `${crypto.randomUUID()}${crypto.randomUUID()}`,
    BETTER_AUTH_BASE_URL: BASE_URL,
    BETTER_AUTH_TRUSTED_ORIGINS: BASE_URL,
    SIGNUP_ALLOWED_EMAILS: allowlist,
  };
}

async function authRequest(
  auth: ReturnType<typeof createAuth>,
  path: string,
  body?: Record<string, unknown>,
  cookie?: string,
): Promise<Response> {
  const headers = new Headers({ origin: BASE_URL, "cf-connecting-ip": "192.0.2.69" });
  if (body) headers.set("content-type", "application/json");
  if (cookie) headers.set("cookie", cookie);
  return auth.handler(
    new Request(`${BASE_URL}/api/auth${path}`, {
      method: body ? "POST" : "GET",
      headers,
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
}

function sessionCookie(response: Response): string {
  const header = response.headers
    .getSetCookie()
    .find((value) => value.startsWith("__Host-zudo.session_token="));
  if (!header) throw new Error("Expected Better Auth to set a session cookie");
  return header.split(";", 1)[0] ?? "";
}

beforeEach(async () => {
  await reset();
  await applyControlMigrations(env.DB, inject("controlMigrations"));
});

describe("Better Auth runtime", () => {
  it("keeps the default/public factory disabled while admitting an invited mounted signup", async () => {
    const authEnv = runtimeEnv("  INVITED@example.test  ");
    const disabled = await authRequest(createAuth(authEnv), "/sign-up/email", {
      name: "Invited User",
      email: INVITED_EMAIL,
      password: "correct horse battery staple",
    });
    expect(disabled.status).toBe(400);
    await expect(disabled.json()).resolves.toMatchObject({
      code: "EMAIL_PASSWORD_SIGN_UP_DISABLED",
    });

    const response = await createControlApp().request(
      `${BASE_URL}/api/auth/sign-up/email`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: BASE_URL,
          "cf-connecting-ip": "192.0.2.69",
        },
        body: JSON.stringify({
          name: "Invited User",
          email: INVITED_EMAIL,
          password: "correct horse battery staple",
        }),
      },
      authEnv as ControlEnv,
    );
    expect(response.status).toBe(200);

    const cookieHeader = response.headers.getSetCookie().join(", ");
    expect(cookieHeader).toContain("__Host-zudo.session_token=");
    expect(cookieHeader).not.toContain("__Secure-__Host-");
    expect(cookieHeader).toMatch(/;\s*Secure/i);
    expect(cookieHeader).toMatch(/;\s*HttpOnly/i);
    expect(cookieHeader).toMatch(/;\s*Path=\//i);
    expect(cookieHeader).not.toMatch(/;\s*Domain=/i);

    const signIn = await authRequest(createAuth(authEnv), "/sign-in/email", {
      email: INVITED_EMAIL,
      password: "correct horse battery staple",
    });
    expect(signIn.status).toBe(200);
    const session = await authRequest(
      createAuth(authEnv),
      "/get-session",
      undefined,
      sessionCookie(signIn),
    );
    expect(session.status).toBe(200);
    await expect(session.json()).resolves.toMatchObject({ user: { email: INVITED_EMAIL } });
  });

  it("rejects non-invited signup and fails closed for unset or empty allowlists", async () => {
    for (const [allowlist, email] of [
      [INVITED_EMAIL, "outsider@example.test"],
      [undefined, INVITED_EMAIL],
      ["  , ", INVITED_EMAIL],
    ] as const) {
      const response = await authRequest(
        createAuth(runtimeEnv(allowlist), { enableInvitedEmailSignUp: true }),
        "/sign-up/email",
        {
          name: "Not Invited",
          email,
          password: "correct horse battery staple",
        },
      );
      expect(response.status).toBe(403);
    }
    const users = await env.DB.prepare("SELECT COUNT(*) AS count FROM user").first<{
      count: number;
    }>();
    expect(users?.count).toBe(0);
  });

  it("enforces the user-create hook outside the email signup route", async () => {
    const context = await createAuth(runtimeEnv(INVITED_EMAIL)).$context;
    await expect(
      context.internalAdapter.createUser(
        {
          name: "Other Path",
          email: "other-path@example.test",
          emailVerified: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        { method: "admin" },
      ),
    ).rejects.toMatchObject({ status: "FORBIDDEN" });
  });

  it("does not register Google without the complete exact callback configuration", () => {
    const absent = createAuth(runtimeEnv(INVITED_EMAIL));
    expect(absent.options.socialProviders).toEqual({});

    const mismatched = createAuth({
      ...runtimeEnv(INVITED_EMAIL),
      GOOGLE_CLIENT_ID: "client-id",
      GOOGLE_CLIENT_SECRET: "client-secret",
      GOOGLE_CALLBACK_URL: "https://other.test/api/auth/callback/google",
    });
    expect(mismatched.options.socialProviders).toEqual({});

    const complete = createAuth({
      ...runtimeEnv(INVITED_EMAIL),
      GOOGLE_CLIENT_ID: "client-id",
      GOOGLE_CLIENT_SECRET: "client-secret",
      GOOGLE_CALLBACK_URL: `${BASE_URL}/api/auth/callback/google`,
    });
    expect(complete.options.socialProviders?.google).toMatchObject({
      redirectURI: `${BASE_URL}/api/auth/callback/google`,
      disableSignUp: true,
    });
  });

  it("stores throttling in D1 and throttles repeated failed sign-ins", async () => {
    const authEnv = runtimeEnv(INVITED_EMAIL);
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      statuses.push(
        (
          await authRequest(createAuth(authEnv), "/sign-in/email", {
            email: "missing@example.test",
            password: "definitely incorrect",
          })
        ).status,
      );
    }
    expect(statuses).toContain(429);
    const stored = await env.DB.prepare('SELECT COUNT(*) AS count FROM "rateLimit"').first<{
      count: number;
    }>();
    expect(stored?.count).toBeGreaterThan(0);
    expect(createAuth(authEnv).options.rateLimit?.storage).toBe("database");
  });

  it("renders and authenticates the login form with a same-origin return-to", async () => {
    const authEnv = runtimeEnv(INVITED_EMAIL);
    await authRequest(createAuth(authEnv, { enableInvitedEmailSignUp: true }), "/sign-up/email", {
      name: "Invited User",
      email: INVITED_EMAIL,
      password: "correct horse battery staple",
    });

    const form = new URLSearchParams();
    form.set("email", INVITED_EMAIL);
    form.set("password", "correct horse battery staple");
    form.set("returnTo", "/desktop/authorize?request=ok");
    const response = await createControlApp().request(
      `${BASE_URL}/login`,
      {
        method: "POST",
        body: form,
        headers: { origin: BASE_URL, "cf-connecting-ip": "192.0.2.70" },
      },
      authEnv as ControlEnv,
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/desktop/authorize?request=ok");
    expect(response.headers.getSetCookie().join(", ")).toContain("__Host-zudo.session_token=");

    const crossOrigin = await createControlApp().request(
      `${BASE_URL}/login`,
      { method: "POST", body: form, headers: { origin: "https://evil.test" } },
      authEnv as ControlEnv,
    );
    expect(crossOrigin.status).toBe(403);
    expect(crossOrigin.headers.getSetCookie()).toEqual([]);

    const oversized = new URLSearchParams({
      email: `${"x".repeat(17_000)}@example.test`,
      password: "password",
    });
    const oversizedResponse = await createControlApp().request(
      `${BASE_URL}/login`,
      { method: "POST", body: oversized, headers: { origin: BASE_URL } },
      authEnv as ControlEnv,
    );
    expect(oversizedResponse.status).toBe(413);
  });
});

describe("login page", () => {
  it("renders a server-only form and rejects open redirects", () => {
    expect(renderLoginPage("/desktop/authorize")).toContain('<form method="post" action="/login">');
    expect(renderLoginPage("/desktop/authorize")).not.toContain("<script");
    expect(safeReturnTo("https://evil.test/steal")).toBe("/");
    expect(safeReturnTo("//evil.test/steal")).toBe("/");
    expect(safeReturnTo("/\\evil.test/steal")).toBe("/");
    expect(safeReturnTo("/desktop/authorize?request=ok")).toBe("/desktop/authorize?request=ok");
  });
});
