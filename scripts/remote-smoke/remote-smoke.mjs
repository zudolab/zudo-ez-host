import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const STEP_NAMES = [
  "configuration",
  "signup",
  "handle",
  "project",
  "authorization",
  "token",
  "prepare",
  "upload",
  "verify",
  "commit",
  "serving",
  "cleanup",
];

class SmokeFailure extends Error {
  constructor(code) {
    super(code);
    this.name = "SmokeFailure";
    this.code = code;
  }
}

function requireString(env, name, { secret = false } = {}) {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new SmokeFailure(secret ? "required_secret_missing" : `required_setting_missing:${name}`);
  }
  return value;
}

function readConfig(env) {
  if (env.EZ_HOST_REMOTE_SMOKE !== "1") return null;
  const environment = requireString(env, "EZ_HOST_REMOTE_SMOKE_ENVIRONMENT");
  if (environment !== "staging") throw new SmokeFailure("environment_must_be_staging");
  const controlUrl = new URL(requireString(env, "EZ_HOST_REMOTE_SMOKE_CONTROL_URL"));
  if (
    controlUrl.protocol !== "https:" ||
    controlUrl.username !== "" ||
    controlUrl.password !== "" ||
    controlUrl.pathname !== "/" ||
    controlUrl.search !== "" ||
    controlUrl.hash !== ""
  ) {
    throw new SmokeFailure("control_url_must_be_an_https_origin");
  }
  const handle = requireString(env, "EZ_HOST_REMOTE_SMOKE_HANDLE");
  const slug = requireString(env, "EZ_HOST_REMOTE_SMOKE_SLUG");
  const publicUrlValue = env.EZ_HOST_REMOTE_SMOKE_PUBLIC_URL;
  const publicUrl = publicUrlValue ? new URL(publicUrlValue) : null;
  if (publicUrl !== null) {
    if (
      publicUrl.protocol !== "https:" ||
      publicUrl.hostname.split(".")[0] !== `${slug}--${handle}`
    ) {
      throw new SmokeFailure("public_url_project_label_mismatch");
    }
  }
  return {
    environment,
    controlUrl,
    publicUrl,
    email: requireString(env, "EZ_HOST_REMOTE_SMOKE_EMAIL"),
    password: requireString(env, "EZ_HOST_REMOTE_SMOKE_PASSWORD", { secret: true }),
    handle,
    slug,
    d1Database: requireString(env, "EZ_HOST_REMOTE_SMOKE_D1_DATABASE"),
    r2Bucket: requireString(env, "EZ_HOST_REMOTE_SMOKE_R2_BUCKET"),
    apiToken: requireString(env, "CLOUDFLARE_API_TOKEN", { secret: true }),
    accountId: requireString(env, "CLOUDFLARE_ACCOUNT_ID"),
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function md5(bytes) {
  return createHash("md5").update(bytes).digest("base64");
}

function canonicalManifest(contentHash, size) {
  return JSON.stringify({
    version: 1,
    servingSemanticsVersion: 1,
    entries: [
      {
        path: "index.html",
        sha256: contentHash,
        size,
        contentType: "text/html; charset=utf-8",
      },
    ],
  });
}

function closedError(error) {
  return error instanceof SmokeFailure ? error.code : "unexpected_failure";
}

function jsonRecord(value, code) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SmokeFailure(code);
  }
  return value;
}

async function request(fetchImpl, url, options, expected, code) {
  let response;
  try {
    response = await fetchImpl(url, options);
  } catch {
    throw new SmokeFailure(`${code}_network_failed`);
  }
  if (!expected.includes(response.status))
    throw new SmokeFailure(`${code}_http_${response.status}`);
  return response;
}

async function jsonResponse(fetchImpl, url, options, expected, code) {
  const response = await request(fetchImpl, url, options, expected, code);
  try {
    return { response, body: jsonRecord(await response.json(), `${code}_invalid_response`) };
  } catch (error) {
    if (error instanceof SmokeFailure) throw error;
    throw new SmokeFailure(`${code}_invalid_response`);
  }
}

function cookieFrom(response) {
  const values = response.headers.getSetCookie?.() ?? [];
  const session = values.find((value) => value.includes("session_token="));
  if (session === undefined) throw new SmokeFailure("signup_session_missing");
  return session.split(";", 1)[0];
}

function bearer(token) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

function sqlLiteral(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value.includes("\0")
  ) {
    throw new SmokeFailure("cleanup_identity_invalid");
  }
  return `'${value.replaceAll("'", "''")}'`;
}

function cleanupSql(state, config) {
  const email = sqlLiteral(config.email);
  const users = `(SELECT id FROM user WHERE email = ${email})`;
  const startedAt = Number.isSafeInteger(state.startedAt) ? state.startedAt : Date.now();
  const cleanupAt = Number.isSafeInteger(state.cleanupAt) ? state.cleanupAt : Date.now();
  return `DROP TRIGGER IF EXISTS hostname_allocations_permanent_delete;
DROP TRIGGER IF EXISTS publications_immutable_delete;
DROP TRIGGER IF EXISTS publication_objects_immutable_delete;
DELETE FROM project_heads WHERE project_id IN (SELECT id FROM projects WHERE user_id IN ${users});
DELETE FROM publication_objects WHERE publication_id IN (SELECT id FROM publications WHERE project_id IN (SELECT id FROM projects WHERE user_id IN ${users}));
DELETE FROM publications WHERE project_id IN (SELECT id FROM projects WHERE user_id IN ${users});
DELETE FROM publication_attempt_objects WHERE attempt_id IN (SELECT id FROM publication_attempts WHERE user_id IN ${users});
DELETE FROM verified_objects WHERE project_id IN (SELECT id FROM projects WHERE user_id IN ${users});
DELETE FROM publication_attempts WHERE user_id IN ${users};
DELETE FROM hostname_allocations WHERE user_id IN ${users};
DELETE FROM projects WHERE user_id IN ${users};
DELETE FROM desktop_authorization_codes WHERE user_id IN ${users};
DELETE FROM machines WHERE user_id IN ${users};
DELETE FROM session WHERE user_id IN ${users};
DELETE FROM account WHERE user_id IN ${users};
DELETE FROM verification WHERE identifier = ${email};
DELETE FROM user WHERE email = ${email};
DELETE FROM rateLimit WHERE key LIKE '%|/sign-up/email' AND last_request BETWEEN ${startedAt} AND ${cleanupAt};
CREATE TRIGGER hostname_allocations_permanent_delete BEFORE DELETE ON hostname_allocations BEGIN SELECT RAISE(ABORT, 'hostname allocations are permanent'); END;
CREATE TRIGGER publications_immutable_delete BEFORE DELETE ON publications BEGIN SELECT RAISE(ABORT, 'publications are immutable'); END;
CREATE TRIGGER publication_objects_immutable_delete BEFORE DELETE ON publication_objects BEGIN SELECT RAISE(ABORT, 'publication objects are immutable'); END;`;
}

function defaultCommandRunner(args, env) {
  const result = spawnSync("pnpm", ["--dir", "workers/control", "exec", "wrangler", ...args], {
    cwd: new URL("../..", import.meta.url),
    env,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    // Only the explicitly requested count-only JSON is retained. Wrangler's
    // authored diagnostic output is discarded at the process boundary.
    stdout: result.status === 0 && args.includes("--json") ? result.stdout : "",
  };
}

function remainingCount(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    const visit = (value) => {
      if (typeof value !== "object" || value === null) return null;
      if ("remaining" in value && Number.isSafeInteger(value.remaining)) return value.remaining;
      for (const child of Array.isArray(value) ? value : Object.values(value)) {
        const found = visit(child);
        if (found !== null) return found;
      }
      return null;
    };
    return visit(parsed);
  } catch {
    return null;
  }
}

function cleanupKeys(stdout) {
  const keys = new Set();
  try {
    const parsed = JSON.parse(stdout);
    const visit = (value) => {
      if (typeof value !== "object" || value === null) return;
      if (
        "key" in value &&
        typeof value.key === "string" &&
        /^projects\/[^/]+\/(?:content|staged|artifacts)\/[^/]+$/u.test(value.key)
      ) {
        keys.add(value.key);
      }
      for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child);
    };
    visit(parsed);
  } catch {
    return null;
  }
  return keys;
}

async function cleanup(state, config, commandRunner, env) {
  state.cleanupAt = Date.now();
  let ok = true;
  const email = sqlLiteral(config.email);
  const inventory = commandRunner(
    [
      "d1",
      "execute",
      config.d1Database,
      "--remote",
      "--env",
      "staging",
      "--json",
      "--command",
      `SELECT pa.staged_manifest_r2_key AS key FROM publication_attempts pa INNER JOIN user u ON u.id = pa.user_id WHERE u.email = ${email} UNION SELECT 'projects/' || p.id || '/content/' || pao.content_hash AS key FROM publication_attempt_objects pao INNER JOIN publication_attempts pa ON pa.id = pao.attempt_id INNER JOIN projects p ON p.id = pa.project_id INNER JOIN user u ON u.id = pa.user_id WHERE u.email = ${email} UNION SELECT 'projects/' || p.id || '/artifacts/' || pub.artifact_hash AS key FROM publications pub INNER JOIN projects p ON p.id = pub.project_id INNER JOIN user u ON u.id = p.user_id WHERE u.email = ${email}`,
    ],
    env,
  );
  const discoveredKeys = inventory.ok ? cleanupKeys(inventory.stdout) : null;
  if (discoveredKeys === null) ok = false;
  else for (const key of discoveredKeys) state.r2Keys.add(key);
  for (const key of [...state.r2Keys].reverse()) {
    const result = commandRunner(
      [
        "r2",
        "object",
        "delete",
        `${config.r2Bucket}/${key}`,
        "--remote",
        "--env",
        "staging",
        "--force",
      ],
      env,
    );
    if (!result.ok) ok = false;
  }
  const directory = await mkdtemp(join(tmpdir(), "ez-host-remote-smoke-"));
  try {
    const file = join(directory, "cleanup.sql");
    await writeFile(file, cleanupSql(state, config), { mode: 0o600 });
    const deletion = commandRunner(
      ["d1", "execute", config.d1Database, "--remote", "--env", "staging", "--yes", "--file", file],
      env,
    );
    if (!deletion.ok) ok = false;
    const verification = commandRunner(
      [
        "d1",
        "execute",
        config.d1Database,
        "--remote",
        "--env",
        "staging",
        "--json",
        "--command",
        `SELECT COUNT(*) AS remaining FROM user WHERE email = ${sqlLiteral(config.email)}`,
      ],
      env,
    );
    if (!verification.ok || remainingCount(verification.stdout) !== 0) ok = false;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  return {
    ok,
    reason: ok ? "direct_r2_deletes_and_d1_absence_confirmed" : "operator_cleanup_unproven",
  };
}

export async function runRemoteSmoke({
  env = process.env,
  fetchImpl = globalThis.fetch,
  commandRunner = defaultCommandRunner,
  output = console.log,
  uuid = randomUUID,
  entropy = randomBytes,
} = {}) {
  const results = new Map(
    STEP_NAMES.map((name) => [name, { verdict: "SKIPPED", reason: "prerequisite_not_reached" }]),
  );
  if (env.EZ_HOST_REMOTE_SMOKE !== "1") {
    output("REMOTE SMOKE: SKIPPED, NOT RUN (set EZ_HOST_REMOTE_SMOKE=1 to opt in)");
    return 0;
  }

  const state = { r2Keys: new Set() };
  let config;
  let failed = false;
  const pass = (name, reason = "completed") => results.set(name, { verdict: "PASSED", reason });
  const fail = (name, reason) => {
    failed = true;
    results.set(name, { verdict: "FAILED", reason });
  };
  const step = async (name, operation) => {
    try {
      const value = await operation();
      pass(name);
      return value;
    } catch (error) {
      fail(name, closedError(error));
      throw error;
    }
  };

  try {
    config = await step("configuration", async () => readConfig(env));
    const origin = config.controlUrl.origin;
    state.startedAt = Date.now();
    const signup = await step("signup", async () => {
      const response = await request(
        fetchImpl,
        new URL("/api/auth/sign-up/email", origin),
        {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify({
            name: "Remote Smoke",
            email: config.email,
            password: config.password,
          }),
        },
        [200],
        "signup",
      );
      let signupBody;
      try {
        signupBody = jsonRecord(await response.json(), "signup_invalid_response");
      } catch (error) {
        if (error instanceof SmokeFailure) throw error;
        throw new SmokeFailure("signup_invalid_response");
      }
      const signupUser = jsonRecord(signupBody.user, "signup_invalid_response");
      if (typeof signupUser.id !== "string") throw new SmokeFailure("signup_invalid_response");
      state.userId = signupUser.id;
      const cookie = cookieFrom(response);
      const profile = await jsonResponse(
        fetchImpl,
        new URL("/api/account/me", origin),
        { headers: { cookie } },
        [200],
        "signup_profile",
      );
      if (profile.body.id !== state.userId)
        throw new SmokeFailure("signup_profile_invalid_response");
      return { cookie };
    });
    await step("handle", async () => {
      const { body } = await jsonResponse(
        fetchImpl,
        new URL("/api/account/handle", origin),
        {
          method: "POST",
          headers: { cookie: signup.cookie, origin, "content-type": "application/json" },
          body: JSON.stringify({ handle: config.handle }),
        },
        [200],
        "handle",
      );
      if (body.handle !== config.handle) throw new SmokeFailure("handle_response_mismatch");
    });
    const project = await step("project", async () => {
      const { body } = await jsonResponse(
        fetchImpl,
        new URL("/api/projects", origin),
        {
          method: "POST",
          headers: { cookie: signup.cookie, origin, "content-type": "application/json" },
          body: JSON.stringify({ slug: config.slug, displayName: "Remote smoke" }),
        },
        [201],
        "project",
      );
      const value = jsonRecord(body.project, "project_invalid_response");
      if (typeof value.id !== "string") throw new SmokeFailure("project_invalid_response");
      state.projectId = value.id;
      return value;
    });
    const verifier = entropy(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const redirectUri = "http://127.0.0.1:49152/callback";
    const authorization = await step("authorization", async () => {
      const parameters = new URLSearchParams({
        redirect_uri: redirectUri,
        code_challenge: challenge,
        code_challenge_method: "S256",
        scope: "publish",
        state: uuid(),
        machine_name: "Remote smoke",
      });
      await request(
        fetchImpl,
        new URL(`/desktop/authorize?${parameters}`, origin),
        { headers: { cookie: signup.cookie }, redirect: "manual" },
        [200],
        "authorization_get",
      );
      const response = await request(
        fetchImpl,
        new URL("/desktop/authorize", origin),
        {
          method: "POST",
          headers: {
            cookie: signup.cookie,
            origin,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: parameters,
          redirect: "manual",
        },
        [303],
        "authorization_post",
      );
      const location = response.headers.get("location");
      if (location === null) throw new SmokeFailure("authorization_code_missing");
      const callback = new URL(location);
      const code = callback.searchParams.get("code");
      if (code === null) throw new SmokeFailure("authorization_code_missing");
      return code;
    });
    const machineToken = await step("token", async () => {
      const { body } = await jsonResponse(
        fetchImpl,
        new URL("/desktop/token", origin),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            code: authorization,
            code_verifier: verifier,
            redirect_uri: redirectUri,
          }),
        },
        [200],
        "token",
      );
      const machine = jsonRecord(body.machine, "token_invalid_response");
      if (
        typeof body.token !== "string" ||
        !body.token.startsWith("zeh_machine_v1_") ||
        typeof machine.id !== "string"
      ) {
        throw new SmokeFailure("token_invalid_response");
      }
      state.machineId = machine.id;
      return body.token;
    });
    const bytes = Buffer.from(
      `<!doctype html><meta charset="utf-8"><p>remote-smoke-${uuid()}-${Date.now()}-${entropy(32).toString("hex")}</p>`,
    );
    const contentHash = sha256(bytes);
    const contentMd5 = md5(bytes);
    const transport = [{ contentHash, contentType: "text/html; charset=utf-8", contentMd5 }];
    const prepared = await step("prepare", async () => {
      const { body } = await jsonResponse(
        fetchImpl,
        new URL(`/api/projects/${project.id}/publish/prepare`, origin),
        {
          method: "POST",
          headers: bearer(machineToken),
          body: JSON.stringify({
            manifest: canonicalManifest(contentHash, bytes.length),
            transport,
          }),
        },
        [201],
        "prepare",
      );
      const attempt = jsonRecord(body.attempt, "prepare_invalid_response");
      const page = jsonRecord(body.contracts, "prepare_invalid_response");
      if (
        typeof attempt.id !== "string" ||
        typeof attempt.stagedManifestR2Key !== "string" ||
        !Array.isArray(page.contracts)
      ) {
        throw new SmokeFailure("prepare_invalid_response");
      }
      state.attemptId = attempt.id;
      state.r2Keys.add(attempt.stagedManifestR2Key);
      return { attempt, contracts: page.contracts };
    });
    await step("upload", async () => {
      if (prepared.contracts.length < 1) throw new SmokeFailure("upload_contract_missing");
      let used = 0;
      for (const raw of prepared.contracts) {
        const contract = jsonRecord(raw, "upload_contract_invalid");
        if (
          contract.contentHash !== contentHash ||
          contract.sizeBytes !== bytes.length ||
          contract.contentType !== transport[0].contentType ||
          contract.contentMd5 !== contentMd5 ||
          typeof contract.key !== "string" ||
          typeof contract.uploadUrl !== "string"
        )
          throw new SmokeFailure("upload_contract_invalid");
        state.r2Keys.add(contract.key);
        const uploadUrl = contract.uploadUrl;
        delete contract.uploadUrl;
        const response = await request(
          fetchImpl,
          uploadUrl,
          {
            method: "PUT",
            headers: {
              "content-type": contract.contentType,
              "content-md5": contract.contentMd5,
              "if-none-match": "*",
            },
            body: bytes,
          },
          [200],
          "presigned_put",
        );
        void response;
        used += 1;
      }
      if (used < 1) throw new SmokeFailure("upload_contract_unused");
    });
    await step("verify", async () => {
      const { body } = await jsonResponse(
        fetchImpl,
        new URL(`/api/projects/${project.id}/publish/${prepared.attempt.id}/verify`, origin),
        {
          method: "POST",
          headers: bearer(machineToken),
          body: JSON.stringify({
            objects: [{ contentHash, expectedSize: bytes.length, expectedMd5: contentMd5 }],
          }),
        },
        [200],
        "verify",
      );
      if (body.ok !== true || body.verifiedCount < 1)
        throw new SmokeFailure("verification_not_proven");
    });
    await step("commit", async () => {
      const { body } = await jsonResponse(
        fetchImpl,
        new URL(`/api/projects/${project.id}/publish/commit`, origin),
        {
          method: "POST",
          headers: bearer(machineToken),
          body: JSON.stringify({ attemptId: prepared.attempt.id }),
        },
        [200],
        "commit",
      );
      const publication = jsonRecord(body.publication, "commit_invalid_response");
      if (typeof publication.id !== "string" || typeof publication.artifactHash !== "string")
        throw new SmokeFailure("commit_invalid_response");
      state.publicationId = publication.id;
      state.r2Keys.add(`projects/${project.id}/artifacts/${publication.artifactHash}`);
    });
    if (config.publicUrl === null) {
      results.set("serving", { verdict: "SKIPPED", reason: "public_url_not_configured" });
    } else {
      await step("serving", async () => {
        const target = new URL("/index.html", config.publicUrl);
        const response = await request(fetchImpl, target, {}, [200], "serving");
        const served = Buffer.from(await response.arrayBuffer());
        if (!served.equals(bytes)) throw new SmokeFailure("served_bytes_mismatch");
        // Negative control: the comparison must reject a perturbed candidate.
        if (!served.equals(Buffer.concat([bytes, Buffer.from("negative-control")]))) return;
        throw new SmokeFailure("serving_negative_control_failed");
      });
    }
  } catch {
    // The failing step already recorded its closed, non-sensitive reason.
  } finally {
    if (config === undefined) {
      results.set("cleanup", { verdict: "SKIPPED", reason: "no_created_state" });
    } else {
      try {
        const verdict = await cleanup(state, config, commandRunner, {
          ...env,
          CLOUDFLARE_API_TOKEN: config.apiToken,
          CLOUDFLARE_ACCOUNT_ID: config.accountId,
        });
        if (verdict.ok) pass("cleanup", verdict.reason);
        else fail("cleanup", verdict.reason);
      } catch (error) {
        fail("cleanup", closedError(error));
      }
    }
  }

  output("REMOTE SMOKE SUMMARY");
  for (const name of STEP_NAMES) {
    const result = results.get(name);
    output(`STEP ${name}: ${result.verdict} - ${result.reason}`);
  }
  const serving = results.get("serving");
  if (serving.verdict === "SKIPPED") output(`SERVING ASSERTION SKIPPED: ${serving.reason}`);
  return failed ? 1 : 0;
}

export const testing = { canonicalManifest, cleanupKeys, cleanupSql, readConfig, remainingCount };
