import assert from "node:assert/strict";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptsDirectory, "..");
const preflightSource = path.join(scriptsDirectory, "preflight-env.sh");
const deploySource = path.join(scriptsDirectory, "deploy.sh");

function run(command, args, environment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: { ...process.env, ...environment },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "ez-host-preflight-"));
  await Promise.all([
    mkdir(path.join(root, "scripts"), { recursive: true }),
    mkdir(path.join(root, "workers/control"), { recursive: true }),
    mkdir(path.join(root, "workers/public"), { recursive: true }),
  ]);
  await cp(preflightSource, path.join(root, "scripts/preflight-env.sh"));
  await cp(deploySource, path.join(root, "scripts/deploy.sh"));
  await chmod(path.join(root, "scripts/preflight-env.sh"), 0o755);
  await chmod(path.join(root, "scripts/deploy.sh"), 0o755);

  const manifest = {
    $schemaVersion: 1,
    workers: {
      control: [
        {
          name: "CONTROL_BASE_URL",
          kind: "var",
          environments: ["staging"],
          purpose: "Control origin",
        },
        {
          name: "CONTROL_SECRET",
          kind: "secret",
          environments: ["staging"],
          purpose: "Control credential",
        },
      ],
      public: [
        {
          name: "PUBLIC_BASE_DOMAIN",
          kind: "var",
          environments: ["staging"],
          purpose: "Published-site suffix",
        },
      ],
    },
  };
  await writeFile(
    path.join(root, "scripts/env-requirements.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await writeFile(
    path.join(root, "workers/control/wrangler.toml"),
    `[env.staging.vars]\nCONTROL_BASE_URL = "https://control.example.test"\n\n[env.staging.secrets]\nrequired = ["CONTROL_SECRET"]\n`,
  );
  await writeFile(
    path.join(root, "workers/public/wrangler.toml"),
    `[env.staging.vars]\nPUBLIC_BASE_DOMAIN = "public.example.test"\n`,
  );

  return { root, manifest };
}

test("preflight aggregates missing manifest requirements without editing the script", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const scriptBefore = await readFile(preflightSource, "utf8");
  const initial = await run(
    "bash",
    [path.join(fixture.root, "scripts/preflight-env.sh"), "staging"],
    {
      EZ_HOST_ROOT: fixture.root,
    },
  );
  assert.equal(initial.code, 0, initial.stderr);
  assert.match(initial.stdout, /Configuration preflight passed for staging/);

  fixture.manifest.workers.control.push(
    {
      name: "NEW_REQUIRED_VAR",
      kind: "var",
      environments: ["staging"],
      purpose: "Added by the manifest test",
    },
    {
      name: "NEW_REQUIRED_SECRET",
      kind: "secret",
      environments: ["staging"],
      purpose: "Added secret by the manifest test",
    },
  );
  await writeFile(
    path.join(fixture.root, "scripts/env-requirements.json"),
    `${JSON.stringify(fixture.manifest, null, 2)}\n`,
  );

  const changed = await run(
    "bash",
    [path.join(fixture.root, "scripts/preflight-env.sh"), "staging"],
    {
      EZ_HOST_ROOT: fixture.root,
    },
  );
  assert.equal(changed.code, 1);
  assert.match(changed.stderr, /missing var NEW_REQUIRED_VAR/);
  assert.match(changed.stderr, /missing secret NEW_REQUIRED_SECRET/);
  assert.match(changed.stderr, /2 required value\(s\) missing/);
  assert.equal(await readFile(preflightSource, "utf8"), scriptBefore);
});

test("deploy script runs control before public and skips both when preflight fails", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const logPath = path.join(fixture.root, "wrangler.log");
  const wranglerPath = path.join(fixture.root, "mock-wrangler.sh");
  await writeFile(
    wranglerPath,
    '#!/usr/bin/env bash\nprintf "%s|%s\\n" "$PWD" "$*" >> "$EZ_HOST_WRANGLER_LOG"\n',
  );
  await chmod(wranglerPath, 0o755);

  const deployed = await run("bash", [path.join(fixture.root, "scripts/deploy.sh"), "staging"], {
    EZ_HOST_ROOT: fixture.root,
    EZ_HOST_WRANGLER_BIN: wranglerPath,
    EZ_HOST_WRANGLER_LOG: logPath,
  });
  assert.equal(deployed.code, 0, deployed.stderr);
  const deployLines = (await readFile(logPath, "utf8")).trim().split("\n");
  assert.equal(deployLines.length, 2);
  assert.match(deployLines[0], /workers\/control\|deploy --config wrangler\.toml --env staging$/);
  assert.match(deployLines[1], /workers\/public\|deploy --config wrangler\.toml --env staging$/);

  fixture.manifest.workers.public.push({
    name: "BLOCK_DEPLOY",
    kind: "var",
    environments: ["staging"],
    purpose: "The deploy must not start",
  });
  await writeFile(
    path.join(fixture.root, "scripts/env-requirements.json"),
    `${JSON.stringify(fixture.manifest, null, 2)}\n`,
  );
  await writeFile(logPath, "");

  const blocked = await run("bash", [path.join(fixture.root, "scripts/deploy.sh"), "staging"], {
    EZ_HOST_ROOT: fixture.root,
    EZ_HOST_WRANGLER_BIN: wranglerPath,
    EZ_HOST_WRANGLER_LOG: logPath,
  });
  assert.equal(blocked.code, 1);
  assert.match(blocked.stderr, /no Worker deploy was started/);
  assert.equal(await readFile(logPath, "utf8"), "");
});
