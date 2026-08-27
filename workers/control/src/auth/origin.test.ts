import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { beforeEach, describe, expect, inject, it } from "vitest";

import { createControlApp } from "../app.js";
import { applyControlMigrations } from "../db/testing.js";
import { createAuth, type AuthRuntimeEnv } from "./better-auth.js";
import { hasExactTrustedOrigin, trustedControlOrigins } from "./origin.js";

const BASE_URL = "https://control.test";
const EMAIL = "origin@example.test";

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

async function sessionCookie(authEnv: AuthRuntimeEnv) {
  const response = await createAuth(authEnv, { enableInvitedEmailSignUp: true }).handler(
    new Request(`${BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL },
      body: JSON.stringify({
        name: "Origin User",
        email: EMAIL,
        password: "correct horse battery staple",
      }),
    }),
  );
  const header = response.headers
    .getSetCookie()
    .find((value) => value.startsWith("__Host-zudo.session_token="));
  if (!header) throw new Error("Expected a session cookie");
  return header.split(";", 1)[0] ?? "";
}

beforeEach(async () => {
  await reset();
  await applyControlMigrations(env.DB, inject("controlMigrations"));
});

describe("exact control origins", () => {
  it("accepts only canonical configured HTTP(S) origins", () => {
    expect(trustedControlOrigins("https://control.test,http://localhost:3000")).toEqual([
      "https://control.test",
      "http://localhost:3000",
    ]);
    expect(
      hasExactTrustedOrigin(new Request(BASE_URL, { headers: { origin: BASE_URL } }), BASE_URL),
    ).toBe(true);
    for (const origin of [
      "null",
      "https://evil.test",
      "https://control.test.evil.test",
      "https://control.test, https://evil.test",
      "not an origin",
      "https://site.public-content.test",
    ]) {
      expect(hasExactTrustedOrigin(new Request(BASE_URL, { headers: { origin } }), BASE_URL)).toBe(
        false,
      );
    }
    expect(hasExactTrustedOrigin(new Request(BASE_URL), BASE_URL)).toBe(false);
  });

  it("enforces the mutation matrix at the mounted request boundary", async () => {
    const authEnv = runtimeEnv();
    const cookie = await sessionCookie(authEnv);
    const app = createControlApp();

    const allowed = await app.request(
      `${BASE_URL}/api/account/profile`,
      { method: "POST", headers: { cookie, origin: BASE_URL } },
      authEnv,
    );
    expect(allowed.status).toBe(404);
    await expect(allowed.json()).resolves.toEqual({ error: "route_not_implemented" });

    const rejectedOrigins: Array<string | undefined> = [
      undefined,
      "null",
      "https://evil.test",
      "https://control.test.evil.test",
      "https://control.test, https://evil.test",
      "not an origin",
      "https://site.public-content.test",
    ];
    for (const origin of rejectedOrigins) {
      const headers = new Headers({ cookie });
      if (origin !== undefined) headers.set("origin", origin);
      const response = await app.request(
        `${BASE_URL}/api/account/profile`,
        { method: "POST", headers },
        authEnv,
      );
      expect(response.status, origin).toBe(403);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toEqual({ error: "invalid_origin" });
    }

    const desktopForm = new URLSearchParams({
      redirect_uri: "http://127.0.0.1:49152/callback",
      code_challenge: "a".repeat(43),
      code_challenge_method: "S256",
      scope: "publish",
      state: "origin-test-state",
      machine_name: "Origin Mac",
    });
    const rejectedDesktopMutation = await app.request(
      `${BASE_URL}/desktop/authorize`,
      {
        method: "POST",
        headers: { cookie, origin: "https://evil.test" },
        body: desktopForm,
      },
      authEnv,
    );
    expect(rejectedDesktopMutation.status).toBe(403);
    expect(rejectedDesktopMutation.headers.get("cache-control")).toBe("no-store");
    await expect(rejectedDesktopMutation.json()).resolves.toEqual({ error: "invalid_origin" });
  });

  it("keeps account and machine session mounts while desktop authorization owns login return", async () => {
    const authEnv = runtimeEnv();
    const cookie = await sessionCookie(authEnv);
    const app = createControlApp();

    for (const path of ["/api/account", "/api/machines"]) {
      const anonymous = await app.request(`${BASE_URL}${path}`, {}, authEnv);
      expect(anonymous.status, path).toBe(401);
      await expect(anonymous.json()).resolves.toEqual({
        error: "session_authentication_required",
      });

      const safe = await app.request(`${BASE_URL}${path}`, { headers: { cookie } }, authEnv);
      expect(safe.status, path).toBe(404);
      await expect(safe.json()).resolves.toEqual({ error: "route_not_implemented" });
    }

    const desktopParameters = new URLSearchParams({
      redirect_uri: "http://127.0.0.1:49152/callback",
      code_challenge: "a".repeat(43),
      code_challenge_method: "S256",
      scope: "publish",
      state: "origin-test-state",
      machine_name: "Origin Mac",
    });
    const anonymousDesktop = await app.request(
      `${BASE_URL}/desktop/authorize?${desktopParameters}`,
      {},
      authEnv,
    );
    expect(anonymousDesktop.status).toBe(302);
    expect(anonymousDesktop.headers.get("location")).toContain("/login?returnTo=");
    const sessionDesktop = await app.request(
      `${BASE_URL}/desktop/authorize?${desktopParameters}`,
      { headers: { cookie } },
      authEnv,
    );
    expect(sessionDesktop.status).toBe(200);
    expect(sessionDesktop.headers.get("content-type")).toContain("text/html");

    const anonymousToken = await app.request(`${BASE_URL}/desktop/token`, {}, authEnv);
    const cookieToken = await app.request(
      `${BASE_URL}/desktop/token`,
      { headers: { cookie } },
      authEnv,
    );
    expect(cookieToken.status).toBe(anonymousToken.status);
    expect(cookieToken.headers.get("cache-control")).toBe("no-store");
    expect(anonymousToken.headers.get("cache-control")).toBe("no-store");
    await expect(cookieToken.json()).resolves.toEqual(await anonymousToken.json());
  });

  it("runs exact credentialed CORS before Better Auth", async () => {
    const authEnv = runtimeEnv();
    const app = createControlApp();
    const trusted = await app.request(
      `${BASE_URL}/api/auth/get-session`,
      { method: "OPTIONS", headers: { origin: BASE_URL } },
      authEnv,
    );
    expect(trusted.headers.get("access-control-allow-origin")).toBe(BASE_URL);
    expect(trusted.headers.get("access-control-allow-credentials")).toBe("true");

    const unknown = await app.request(
      `${BASE_URL}/api/auth/get-session`,
      { method: "OPTIONS", headers: { origin: "https://evil.test" } },
      authEnv,
    );
    expect(unknown.headers.get("access-control-allow-origin")).toBeNull();

    const rejectedMutation = await app.request(
      `${BASE_URL}/api/auth/sign-in/email`,
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://evil.test" },
        body: JSON.stringify({ email: EMAIL, password: "irrelevant" }),
      },
      authEnv,
    );
    expect(rejectedMutation.status).toBe(403);
    expect(rejectedMutation.headers.get("access-control-allow-origin")).toBeNull();
  });
});
