import assert from "node:assert/strict";
import test from "node:test";

import { runRemoteSmoke } from "./remote-smoke.mjs";

const SECRET = "never-print-password";
const TOKEN = "zeh_machine_v1_never-print-token";
const SIGNED_URL = "https://signed-upload.invalid/object?X-Amz-Signature=never-print-signature";

function enabledEnv(overrides = {}) {
  return {
    EZ_HOST_REMOTE_SMOKE: "1",
    EZ_HOST_REMOTE_SMOKE_ENVIRONMENT: "staging",
    EZ_HOST_REMOTE_SMOKE_CONTROL_URL: "https://control.invalid",
    EZ_HOST_REMOTE_SMOKE_EMAIL: "remote-smoke@example.test",
    EZ_HOST_REMOTE_SMOKE_PASSWORD: SECRET,
    EZ_HOST_REMOTE_SMOKE_HANDLE: "operator",
    EZ_HOST_REMOTE_SMOKE_SLUG: "smoke",
    EZ_HOST_REMOTE_SMOKE_D1_DATABASE: "zudo-ez-host-control-staging",
    EZ_HOST_REMOTE_SMOKE_R2_BUCKET: "zudo-ez-host-artifacts-staging",
    CLOUDFLARE_API_TOKEN: "never-print-api-token",
    CLOUDFLARE_ACCOUNT_ID: "account-id",
    ...overrides,
  };
}

function commandBoundary(calls, { cleanupRemaining = 0 } = {}) {
  return (args) => {
    calls.push(args);
    if (args.includes("--json")) {
      return { ok: true, stdout: JSON.stringify([{ results: [{ remaining: cleanupRemaining }] }]) };
    }
    return { ok: true, stdout: "" };
  };
}

function lifecycleBoundary({ contracts = true, serve = false } = {}) {
  const observations = { putHeaders: null, putBytes: null, requestPaths: [] };
  let publicationBytes;
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    observations.requestPaths.push(url.pathname);
    if (url.origin === "https://signed-upload.invalid") {
      observations.putHeaders = new Headers(options.headers);
      observations.putBytes = Buffer.from(options.body);
      publicationBytes = observations.putBytes;
      return new Response(null, { status: 200 });
    }
    if (serve && url.origin === "https://smoke--operator.public.invalid") {
      return new Response(publicationBytes, { status: 200 });
    }
    if (url.pathname === "/api/auth/sign-up/email") {
      return new Response(JSON.stringify({ user: { id: "usr_remote" } }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "set-cookie": "__Host-zudo.session_token=never-print-cookie; Secure; HttpOnly; Path=/",
        },
      });
    }
    if (url.pathname === "/api/account/me")
      return Response.json({ id: "usr_remote", handle: null });
    if (url.pathname === "/api/account/handle")
      return Response.json({ id: "usr_remote", handle: "operator" });
    if (url.pathname === "/api/projects") {
      return Response.json(
        {
          project: { id: "prj_remote", slug: "smoke" },
          hostname: "smoke--operator",
          created: true,
        },
        { status: 201 },
      );
    }
    if (url.pathname === "/desktop/authorize" && (options.method ?? "GET") === "GET") {
      return new Response("consent", { status: 200 });
    }
    if (url.pathname === "/desktop/authorize") {
      return new Response(null, {
        status: 303,
        headers: { location: "http://127.0.0.1:49152/callback?code=one-time-code&state=state" },
      });
    }
    if (url.pathname === "/desktop/token")
      return Response.json({
        token: TOKEN,
        machine: { id: "mch_remote", name: "Remote smoke", expiresAt: 2_000_000_000_000 },
      });
    if (url.pathname.endsWith("/publish/prepare")) {
      const request = JSON.parse(options.body);
      const manifest = JSON.parse(request.manifest);
      const transport = request.transport[0];
      return Response.json(
        {
          created: true,
          attempt: {
            id: "att_remote",
            projectId: "prj_remote",
            stagedManifestR2Key: "projects/prj_remote/staged/att_remote",
          },
          contracts: {
            contracts: contracts
              ? [
                  {
                    ...transport,
                    key: `projects/prj_remote/content/${transport.contentHash}`,
                    sizeBytes: manifest.entries[0].size,
                    uploadUrl: SIGNED_URL,
                  },
                ]
              : [],
            hasMore: false,
          },
        },
        { status: 201 },
      );
    }
    if (url.pathname.endsWith("/verify"))
      return Response.json({ ok: true, verifiedCount: 1, results: [{ verified: true }] });
    if (url.pathname.endsWith("/publish/commit"))
      return Response.json({
        publication: { id: "pub_remote", artifactHash: "artifact-hash" },
        committed: true,
      });
    throw new Error(`Unexpected mock path: ${url.pathname}`);
  };
  return { fetchImpl, observations };
}

test("disabled gate exits zero and says it was skipped, not run", async () => {
  const lines = [];
  const exitCode = await runRemoteSmoke({ env: {}, output: (line) => lines.push(line) });
  assert.equal(exitCode, 0);
  assert.deepEqual(lines, [
    "REMOTE SMOKE: SKIPPED, NOT RUN (set EZ_HOST_REMOTE_SMOKE=1 to opt in)",
  ]);
});

test("drives the lifecycle, uses a real PUT contract, and reports serving separately", async () => {
  const lines = [];
  const commands = [];
  const { fetchImpl, observations } = lifecycleBoundary();
  const exitCode = await runRemoteSmoke({
    env: enabledEnv(),
    fetchImpl,
    commandRunner: commandBoundary(commands),
    output: (line) => lines.push(line),
    uuid: () => "unique-run",
    entropy: (size) => Buffer.alloc(size, 7),
  });

  assert.equal(exitCode, 0);
  assert.equal(observations.putHeaders.get("content-type"), "text/html; charset=utf-8");
  assert.match(observations.putHeaders.get("content-md5"), /^[A-Za-z0-9+/]{22}==$/u);
  assert.equal(observations.putHeaders.get("if-none-match"), "*");
  assert.ok(observations.putBytes.length > 0);
  assert.ok(lines.includes("STEP upload: PASSED - completed"));
  assert.ok(lines.includes("STEP serving: SKIPPED - public_url_not_configured"));
  assert.ok(lines.includes("SERVING ASSERTION SKIPPED: public_url_not_configured"));
  assert.ok(lines.includes("STEP cleanup: PASSED - direct_r2_deletes_and_d1_absence_confirmed"));
  assert.ok(commands.some((args) => args[0] === "r2" && args.includes("--remote")));
  assert.ok(commands.some((args) => args[0] === "d1" && args.includes("--remote")));

  const output = lines.join("\n");
  for (const sensitive of [
    SECRET,
    TOKEN,
    SIGNED_URL,
    "never-print-cookie",
    "never-print-api-token",
  ]) {
    assert.equal(output.includes(sensitive), false);
  }
});

test("proves serving bytes and its negative control when a project URL is configured", async () => {
  const lines = [];
  const { fetchImpl } = lifecycleBoundary({ serve: true });
  const exitCode = await runRemoteSmoke({
    env: enabledEnv({ EZ_HOST_REMOTE_SMOKE_PUBLIC_URL: "https://smoke--operator.public.invalid/" }),
    fetchImpl,
    commandRunner: commandBoundary([]),
    output: (line) => lines.push(line),
    uuid: () => "unique-run",
    entropy: (size) => Buffer.alloc(size, 9),
  });
  assert.equal(exitCode, 0);
  assert.ok(lines.includes("STEP serving: PASSED - completed"));
});

test("fails closed when prepare does not prove a missing upload and still cleans up", async () => {
  const lines = [];
  const { fetchImpl } = lifecycleBoundary({ contracts: false });
  const exitCode = await runRemoteSmoke({
    env: enabledEnv(),
    fetchImpl,
    commandRunner: commandBoundary([]),
    output: (line) => lines.push(line),
    uuid: () => "unique-run",
    entropy: (size) => Buffer.alloc(size, 11),
  });
  assert.equal(exitCode, 1);
  assert.ok(lines.includes("STEP upload: FAILED - upload_contract_missing"));
  assert.ok(lines.includes("STEP cleanup: PASSED - direct_r2_deletes_and_d1_absence_confirmed"));
  assert.equal(
    lines.some((line) => line === "STEP verify: PASSED - completed"),
    false,
  );
});

test("cleanup is an independent failure verdict", async () => {
  const lines = [];
  const { fetchImpl } = lifecycleBoundary();
  const exitCode = await runRemoteSmoke({
    env: enabledEnv(),
    fetchImpl,
    commandRunner: commandBoundary([], { cleanupRemaining: 1 }),
    output: (line) => lines.push(line),
    uuid: () => "unique-run",
    entropy: (size) => Buffer.alloc(size, 13),
  });
  assert.equal(exitCode, 1);
  assert.ok(lines.includes("STEP commit: PASSED - completed"));
  assert.ok(lines.includes("STEP cleanup: FAILED - operator_cleanup_unproven"));
});
