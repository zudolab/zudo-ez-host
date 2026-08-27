import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { beforeEach, describe, expect, inject, it } from "vitest";

import { createControlApp } from "../app.js";
import { createAuth, type AuthRuntimeEnv } from "../auth/better-auth.js";
import { applyControlMigrations } from "../db/testing.js";
import { hashAuthorizationCode } from "./codes.js";

const BASE_URL = "https://control.test";
const EMAIL = "desktop-authorize@example.test";
const VALID_CHALLENGE = "a".repeat(43);

function runtimeEnv(): ControlEnv & AuthRuntimeEnv {
  return {
    DB: env.DB,
    ARTIFACTS: env.ARTIFACTS,
    PUBLICATION_RESOLVER: env.PUBLICATION_RESOLVER,
    BETTER_AUTH_SECRET: `${crypto.randomUUID()}${crypto.randomUUID()}`,
    BETTER_AUTH_BASE_URL: BASE_URL,
    BETTER_AUTH_TRUSTED_ORIGINS: BASE_URL,
    SIGNUP_ALLOWED_EMAILS: EMAIL,
  };
}

function authorizationParameters(
  overrides: Readonly<Record<string, string>> = {},
): URLSearchParams {
  return new URLSearchParams({
    redirect_uri: "http://127.0.0.1:49152/callback",
    code_challenge: VALID_CHALLENGE,
    code_challenge_method: "S256",
    scope: "publish",
    state: "desktop-state",
    machine_name: "Studio Mac",
    ...overrides,
  });
}

async function createSession(authEnv: AuthRuntimeEnv): Promise<string> {
  const response = await createAuth(authEnv, { enableInvitedEmailSignUp: true }).handler(
    new Request(`${BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL },
      body: JSON.stringify({
        name: "Desktop User",
        email: EMAIL,
        password: "correct horse battery staple",
      }),
    }),
  );
  expect(response.status).toBe(200);
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith("__Host-zudo.session_token="));
  if (!cookie) throw new Error("Expected a session cookie");
  return cookie.split(";", 1)[0] ?? "";
}

async function codeCount(): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM desktop_authorization_codes",
  ).first<{ count: number }>();
  return row?.count ?? -1;
}

async function postAuthorization(
  authEnv: ControlEnv,
  cookie: string,
  parameters: URLSearchParams,
): Promise<Response> {
  return createControlApp().request(
    `${BASE_URL}/desktop/authorize`,
    {
      method: "POST",
      headers: { cookie, origin: BASE_URL },
      body: parameters,
    },
    authEnv,
  );
}

beforeEach(async () => {
  await reset();
  await applyControlMigrations(env.DB, inject("controlMigrations"));
});

describe("desktop authorization validation", () => {
  it("redirects an unauthenticated GET through login without creating a code", async () => {
    const authEnv = runtimeEnv();
    const parameters = authorizationParameters();
    const response = await createControlApp().request(
      `${BASE_URL}/desktop/authorize?${parameters}`,
      {},
      authEnv,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const login = new URL(location ?? "", BASE_URL);
    expect(login.pathname).toBe("/login");
    expect(login.searchParams.get("returnTo")).toBe(`/desktop/authorize?${parameters}`);
    expect(await codeCount()).toBe(0);
  });

  it("rejects every non-ephemeral redirect before inserting a code", async () => {
    const authEnv = runtimeEnv();
    const cookie = await createSession(authEnv);
    const rejected = [
      "https://evil.example",
      "http://10.0.0.1:1234/",
      "http://localhost:1234/",
      "zudo-ez-host://callback",
      "http://127.0.0.1/callback",
      "http://user@127.0.0.1:1234/",
      "http://127.0.0.1:1234/#fragment",
      "http://127.0.0.1:1234/?existing=query",
      "http://127.0.0.1:1234/raw space",
      "http://127.0.0.1:1234/raw-雪",
      "http://127.0.0.1:1234/%zz",
      "http://127.0.0.1:1234/back\\slash",
    ];

    for (const redirectUri of rejected) {
      const response = await postAuthorization(
        authEnv,
        cookie,
        authorizationParameters({ redirect_uri: redirectUri }),
      );
      expect(response.status, redirectUri).toBe(400);
      expect(response.headers.get("cache-control"), redirectUri).toBe("no-store");
    }
    expect(await codeCount()).toBe(0);
  });

  it("accepts literal IPv4 and IPv6 callbacks with explicit nonzero ports", async () => {
    const authEnv = runtimeEnv();
    const cookie = await createSession(authEnv);
    for (const redirectUri of [
      "http://127.0.0.1:80/callback",
      "http://[::1]:61023/oauth2redirect/zudo",
    ]) {
      const response = await postAuthorization(
        authEnv,
        cookie,
        authorizationParameters({ redirect_uri: redirectUri }),
      );
      expect(response.status, redirectUri).toBe(303);
      expect(response.headers.get("location"), redirectUri).toMatch(
        new RegExp(`^${redirectUri.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\?`),
      );
    }
  });

  it("rejects missing, plain, malformed, and out-of-range PKCE challenges", async () => {
    const authEnv = runtimeEnv();
    const cookie = await createSession(authEnv);
    const rejected = [
      authorizationParameters({ code_challenge_method: "plain" }),
      authorizationParameters({ code_challenge: "" }),
      authorizationParameters({ code_challenge: "a".repeat(42) }),
      authorizationParameters({ code_challenge: "a".repeat(129) }),
      authorizationParameters({ code_challenge: `${"a".repeat(42)}!` }),
    ];
    rejected.push(authorizationParameters());
    rejected.at(-1)?.delete("code_challenge");

    for (const parameters of rejected) {
      const response = await postAuthorization(authEnv, cookie, parameters);
      expect(response.status).toBe(400);
    }
    expect(await codeCount()).toBe(0);
  });

  it("rejects a non-publish scope and fully revalidates a changed POST", async () => {
    const authEnv = runtimeEnv();
    const cookie = await createSession(authEnv);
    const valid = authorizationParameters();
    const consent = await createControlApp().request(
      `${BASE_URL}/desktop/authorize?${valid}`,
      { headers: { cookie } },
      authEnv,
    );
    expect(consent.status).toBe(200);

    const changed = authorizationParameters({ scope: "admin" });
    const response = await postAuthorization(authEnv, cookie, changed);
    expect(response.status).toBe(400);
    expect(await codeCount()).toBe(0);
  });

  it("escapes attacker-controlled consent-page content", async () => {
    const authEnv = runtimeEnv();
    const cookie = await createSession(authEnv);
    const parameters = authorizationParameters({
      machine_name: '<script>alert("machine")</script>',
      redirect_uri: "http://127.0.0.1:49152/callback%22%3E%3Cscript%3E",
    });
    const response = await createControlApp().request(
      `${BASE_URL}/desktop/authorize?${parameters}`,
      { headers: { cookie } },
      authEnv,
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(html).toContain("&lt;script&gt;alert(&quot;machine&quot;)&lt;/script&gt;");
    expect(html).not.toContain('<script>alert("machine")</script>');
    expect(html).not.toContain("<script>");
  });
});

describe("desktop authorization issuance", () => {
  it("stores only a 60-second hash-bound code with a preassigned machine ID", async () => {
    const authEnv = runtimeEnv();
    const cookie = await createSession(authEnv);
    const redirectUri = "http://127.0.0.1:49152/exact/%7Ecallback";
    const state = "state &= unicode-雪";
    const response = await postAuthorization(
      authEnv,
      cookie,
      authorizationParameters({ redirect_uri: redirectUri, state }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.getSetCookie()).toEqual([]);
    const location = response.headers.get("location") ?? "";
    expect(location.startsWith(`${redirectUri}?`)).toBe(true);
    const callback = new URL(location);
    expect([...callback.searchParams.keys()]).toEqual(["code", "state"]);
    expect(callback.searchParams.get("state")).toBe(state);
    expect(location).not.toMatch(/(?:cookie|bearer|token|session)/iu);
    const rawCode = callback.searchParams.get("code");
    expect(rawCode).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    const stored = await env.DB.prepare(
      `SELECT code_hash AS codeHash, user_id AS userId, redirect_uri AS redirectUri,
        code_challenge AS codeChallenge, code_challenge_method AS codeChallengeMethod,
        scope, machine_name AS machineName, machine_id AS machineId,
        created_at AS createdAt, expires_at AS expiresAt, consumed_at AS consumedAt
       FROM desktop_authorization_codes`,
    ).first<{
      codeHash: string;
      userId: string;
      redirectUri: string;
      codeChallenge: string;
      codeChallengeMethod: string;
      scope: string;
      machineName: string;
      machineId: string;
      createdAt: number;
      expiresAt: number;
      consumedAt: number | null;
    }>();
    expect(stored).not.toBeNull();
    expect(stored?.codeHash).toBe(await hashAuthorizationCode(rawCode ?? ""));
    expect(stored?.codeHash).not.toBe(rawCode);
    expect(JSON.stringify(stored)).not.toContain(rawCode ?? "raw-code-missing");
    expect(stored).toMatchObject({
      redirectUri,
      codeChallenge: VALID_CHALLENGE,
      codeChallengeMethod: "S256",
      scope: "publish",
      machineName: "Studio Mac",
      consumedAt: null,
    });
    expect((stored?.expiresAt ?? 0) - (stored?.createdAt ?? 0)).toBe(60_000);
    expect(stored?.machineId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });

  it("requires a valid session on direct POST and inserts nothing", async () => {
    const authEnv = runtimeEnv();
    const response = await createControlApp().request(
      `${BASE_URL}/desktop/authorize`,
      { method: "POST", headers: { origin: BASE_URL }, body: authorizationParameters() },
      authEnv,
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await codeCount()).toBe(0);
  });

  it("commits the database-level method, scope, and lifetime invariants", async () => {
    const definition = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'desktop_authorization_codes'",
    ).first<{ sql: string }>();
    expect(definition?.sql).toContain("desktop_authorization_codes_method_s256");
    expect(definition?.sql).toContain("desktop_authorization_codes_scope_publish");
    expect(definition?.sql).toContain("desktop_authorization_codes_expiry");
  });
});
