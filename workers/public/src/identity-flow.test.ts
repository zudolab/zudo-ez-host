import {
  MANIFEST_SCHEMA_VERSION,
  SERVING_SEMANTICS_VERSION,
  contentKey,
  encodeCanonical,
  parseMachineToken,
  type ManifestEntry,
} from "@zudo-ez-host/core";
import { env, exports } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import { beforeEach, describe, expect, inject, it } from "vitest";

const CONTROL_ORIGIN = "https://control.test";
const PUBLIC_BASE_DOMAIN = "public.test";
const INVITED_EMAIL = "identity-flow@example.test";
const PASSWORD = "correct horse battery staple";
const HANDLE = "identityflow";
const PROJECT_SLUG = "identity-site";
const REDIRECT_URI = "http://127.0.0.1:49152/callback";
const MACHINE_NAME = "Identity E2E Mac";
const CONTENT = "identity-e2e-home\n";
const CONTENT_MD5 = "v7kV9Jqfw4QR+hwLB7+KLg==";

type IdentityTestEnv = PublicEnv & {
  readonly DB: D1Database;
  readonly CONTROL_HTTP: Fetcher;
};

const testEnv = env as IdentityTestEnv;

interface AccountProfile {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly handle: string | null;
}

interface ProjectRegistration {
  readonly project: { readonly id: string; readonly status: string };
  readonly hostname: string;
  readonly created: boolean;
}

interface DesktopTokenResponse {
  readonly token: string;
  readonly machine: { readonly id: string; readonly name: string; readonly expiresAt: number };
}

interface PublicationContract {
  readonly contentHash: string;
  readonly key: string;
  readonly sizeBytes: number;
  readonly contentType: string;
  readonly contentMd5: string;
  readonly uploadUrl: string;
}

interface PrepareResponse {
  readonly attempt: { readonly id: string };
  readonly contracts: {
    readonly contracts: readonly PublicationContract[];
    readonly hasMore: boolean;
  };
  readonly created: boolean;
}

interface CommitResponse {
  readonly committed: boolean;
  readonly publication: { readonly artifactHash: string; readonly generation: number };
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function browserCookies(response: Response): string {
  const cookies = response.headers.getSetCookie();
  const session = cookies.find((cookie) => cookie.startsWith("__Host-zudo.session_token="));
  if (session === undefined) throw new Error("Expected invited signup to create a session cookie");
  return cookies.map((cookie) => cookie.split(";", 1)[0] ?? "").join("; ");
}

async function controlRequest(
  path: string,
  init: RequestInit = {},
  cookie?: string,
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("origin", CONTROL_ORIGIN);
  headers.set("cf-connecting-ip", "192.0.2.75");
  if (cookie !== undefined) headers.set("cookie", cookie);
  return testEnv.CONTROL_HTTP.fetch(new Request(`${CONTROL_ORIGIN}${path}`, { ...init, headers }));
}

async function pkcePair(): Promise<{ readonly verifier: string; readonly challenge: string }> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const verifier = base64Url(bytes);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(testEnv.DB, inject("controlMigrations"), "control_d1_migrations");
});

describe("identity-to-public publication flow", () => {
  it("completes invited enrollment, PKCE authorization, publication, serving, and revocation", async () => {
    const signup = await controlRequest("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Identity Flow User",
        email: INVITED_EMAIL,
        password: PASSWORD,
      }),
    });
    expect(signup.status).toBe(200);
    const sessionCookie = browserCookies(signup);

    const ownProfileResponse = await controlRequest("/api/account/me", {}, sessionCookie);
    expect(ownProfileResponse.status).toBe(200);
    await expect(ownProfileResponse.json<AccountProfile>()).resolves.toMatchObject({
      email: INVITED_EMAIL,
      name: "Identity Flow User",
      handle: null,
    });

    const claim = await controlRequest(
      "/api/account/handle",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle: HANDLE }),
      },
      sessionCookie,
    );
    expect(claim.status).toBe(200);
    await expect(claim.json<AccountProfile>()).resolves.toMatchObject({ handle: HANDLE });

    const registration = await controlRequest(
      "/api/projects",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: PROJECT_SLUG, displayName: "Identity flow site" }),
      },
      sessionCookie,
    );
    expect(registration.status).toBe(201);
    const registered = await registration.json<ProjectRegistration>();
    expect(registered.created).toBe(true);
    expect(registered.project.status).toBe("active");
    expect(registered.hostname).toBe(`${PROJECT_SLUG}--${HANDLE}`);

    const { verifier, challenge } = await pkcePair();
    const state = `identity-flow-${crypto.randomUUID()}`;
    const authorization = new URLSearchParams({
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "publish",
      state,
      machine_name: MACHINE_NAME,
    });
    const consent = await controlRequest(
      `/desktop/authorize?${authorization.toString()}`,
      {},
      sessionCookie,
    );
    expect(consent.status).toBe(200);
    const consentHtml = await consent.text();
    expect(consentHtml).toContain('<form method="post" action="/desktop/authorize">');
    expect(consentHtml).toContain(MACHINE_NAME);
    expect(consentHtml).toContain(REDIRECT_URI);

    const authorizationResult = await controlRequest(
      "/desktop/authorize",
      {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: authorization.toString(),
      },
      sessionCookie,
    );
    expect(authorizationResult.status, await authorizationResult.clone().text()).toBe(303);
    const callback = new URL(authorizationResult.headers.get("location") ?? "", REDIRECT_URI);
    expect(callback.origin + callback.pathname).toBe(REDIRECT_URI);
    expect(callback.searchParams.get("state")).toBe(state);
    const code = callback.searchParams.get("code");
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(authorizationResult.headers.get("location")).not.toMatch(/token|bearer|session/iu);

    const tokenExchange = await controlRequest("/desktop/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, code_verifier: verifier, redirect_uri: REDIRECT_URI }),
    });
    expect(tokenExchange.status).toBe(200);
    expect(tokenExchange.headers.get("cache-control")).toBe("no-store");
    expect(tokenExchange.headers.getSetCookie()).toEqual([]);
    const tokenResult = await tokenExchange.json<DesktopTokenResponse>();
    expect(parseMachineToken(tokenResult.token).ok).toBe(true);
    expect(tokenResult.token).toMatch(/^zeh_machine_v1_[A-Za-z0-9_-]{43}$/u);
    expect(tokenResult.machine.name).toBe(MACHINE_NAME);
    expect(tokenResult.machine.expiresAt).toBeGreaterThan(Date.now());

    const machines = await controlRequest("/api/machines", {}, sessionCookie);
    expect(machines.status).toBe(200);
    await expect(
      machines.json<{
        machines: readonly { id: string; name: string; revoked: boolean }[];
      }>(),
    ).resolves.toMatchObject({
      machines: [{ id: tokenResult.machine.id, name: MACHINE_NAME }],
    });

    const contentHash = await sha256Hex(CONTENT);
    const entry = {
      path: "index.html",
      sha256: contentHash,
      size: new TextEncoder().encode(CONTENT).byteLength,
      contentType: "text/html",
    } satisfies ManifestEntry;
    const manifest = {
      version: MANIFEST_SCHEMA_VERSION,
      servingSemanticsVersion: SERVING_SEMANTICS_VERSION,
      entries: [entry],
    };
    const manifestBytes = encodeCanonical(manifest);
    const prepare = await controlRequest(`/api/projects/${registered.project.id}/publish/prepare`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokenResult.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        manifestBase64: base64(manifestBytes),
        transport: [{ contentHash, contentType: entry.contentType, contentMd5: CONTENT_MD5 }],
      }),
    });
    expect(prepare.status).toBe(201);
    const prepared = await prepare.json<PrepareResponse>();
    expect(prepared.created).toBe(true);
    expect(prepared.contracts.hasMore).toBe(false);
    const contract = prepared.contracts.contracts[0];
    expect(contract).toMatchObject({
      contentHash,
      sizeBytes: entry.size,
      contentType: entry.contentType,
      contentMd5: CONTENT_MD5,
    });
    expect(contract?.uploadUrl).toMatch(/^https:\/\/upload\.test\//u);
    if (contract === undefined) throw new Error("Expected one upload contract");

    // The auxiliary signer deliberately returns a non-routable URL. Put the
    // object through the shared real R2 binding that the signed upload targets.
    await testEnv.ARTIFACTS.put(contract.key, CONTENT, {
      httpMetadata: { contentType: contract.contentType },
    });
    expect(contract.key).toBe(contentKey(registered.project.id, contentHash));

    const verification = await controlRequest(
      `/api/projects/${registered.project.id}/publish/${prepared.attempt.id}/verify`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokenResult.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          objects: [
            {
              contentHash,
              expectedSize: contract.sizeBytes,
              expectedMd5: contract.contentMd5,
            },
          ],
        }),
      },
    );
    expect(verification.status).toBe(200);
    await expect(verification.json()).resolves.toMatchObject({
      ok: true,
      verifiedCount: 1,
      rejectedCount: 0,
    });

    const commit = await controlRequest(`/api/projects/${registered.project.id}/publish/commit`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokenResult.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ attemptId: prepared.attempt.id }),
    });
    expect(commit.status).toBe(200);
    const committed = await commit.json<CommitResponse>();
    expect(committed.committed).toBe(true);
    expect(committed.publication.generation).toBe(1);

    const served = await exports.default.fetch(
      new Request(`https://${registered.hostname}.${PUBLIC_BASE_DOMAIN}/`),
    );
    expect(served.status).toBe(200);
    await expect(served.text()).resolves.toBe(CONTENT);
    expect(served.headers.get("content-type")).toBe("text/html");

    const revoke = await controlRequest(
      `/api/machines/${tokenResult.machine.id}/revoke`,
      { method: "POST" },
      sessionCookie,
    );
    expect(revoke.status).toBe(200);
    await expect(revoke.json()).resolves.toMatchObject({
      machine: { id: tokenResult.machine.id, revoked: true },
    });

    const rejectedPublish = await controlRequest(
      `/api/projects/${registered.project.id}/publish/prepare`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokenResult.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          manifestBase64: base64(manifestBytes),
          transport: [{ contentHash, contentType: entry.contentType, contentMd5: CONTENT_MD5 }],
        }),
      },
    );
    expect(rejectedPublish.status).toBe(401);
    await expect(rejectedPublish.json()).resolves.toEqual({
      error: "machine_authentication_failed",
      reason: "revoked_credential",
    });
  });
});
