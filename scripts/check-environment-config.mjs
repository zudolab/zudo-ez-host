import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const environments = ["staging", "production"];

function unquote(value) {
  const quoted = value.match(/^"(?:[^"\\]|\\.)*"/)?.[0];
  if (quoted) return JSON.parse(quoted);
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function parseStringArray(value) {
  return [...value.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => JSON.parse(`"${match[1]}"`));
}

function parseToml(source) {
  const scalarSections = new Map([["", {}]]);
  const arraySections = new Map();
  let current = scalarSections.get("");

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const arrayHeader = line.match(/^\[\[([^\]]+)\]\]$/);
    if (arrayHeader) {
      const entries = arraySections.get(arrayHeader[1]) ?? [];
      current = {};
      entries.push(current);
      arraySections.set(arrayHeader[1], entries);
      continue;
    }

    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      current = scalarSections.get(header[1]) ?? {};
      scalarSections.set(header[1], current);
      continue;
    }

    const assignment = line.match(/^([A-Z_a-z][A-Z_a-z0-9]*)\s*=\s*(.+)$/);
    if (!assignment) continue;
    const [, key, rawValue] = assignment;
    current[key] = rawValue.trimStart().startsWith("[")
      ? parseStringArray(rawValue)
      : unquote(rawValue);
  }

  return { scalarSections, arraySections };
}

function scalar(config, section, key) {
  const value = config.scalarSections.get(section)?.[key];
  assert.notEqual(value, undefined, `missing ${section}.${key}`);
  return value;
}

function binding(config, section, bindingName) {
  const value = config.arraySections.get(section)?.find((entry) => entry.binding === bindingName);
  assert.ok(value, `missing ${bindingName} binding in [[${section}]]`);
  return value;
}

const [controlSource, publicSource, manifestSource] = await Promise.all([
  readFile(path.join(root, "workers/control/wrangler.toml"), "utf8"),
  readFile(path.join(root, "workers/public/wrangler.toml"), "utf8"),
  readFile(path.join(root, "scripts/env-requirements.json"), "utf8"),
]);
const control = parseToml(controlSource);
const publicWorker = parseToml(publicSource);
const manifest = JSON.parse(manifestSource);

for (const environment of environments) {
  const prefix = `env.${environment}`;
  const controlVars = `${prefix}.vars`;
  const publicVars = `${prefix}.vars`;
  const controlName = scalar(control, prefix, "name");
  const publicName = scalar(publicWorker, prefix, "name");
  const controlBucket = binding(control, `${prefix}.r2_buckets`, "ARTIFACTS").bucket_name;
  const publicBucket = binding(publicWorker, `${prefix}.r2_buckets`, "ARTIFACTS").bucket_name;
  const controlService = binding(publicWorker, `${prefix}.services`, "CONTROL").service;
  const controlBaseDomain = scalar(control, controlVars, "CONTROL_BASE_DOMAIN");
  const publicBaseDomain = scalar(control, controlVars, "PUBLIC_BASE_DOMAIN");

  assert.equal(publicBucket, controlBucket, `${environment}: Worker R2 buckets diverged`);
  assert.equal(
    scalar(control, controlVars, "R2_BUCKET_NAME"),
    controlBucket,
    `${environment}: signer bucket and ARTIFACTS binding diverged`,
  );
  assert.equal(
    scalar(publicWorker, publicVars, "PUBLIC_BASE_DOMAIN"),
    publicBaseDomain,
    `${environment}: public base-domain vars diverged`,
  );
  assert.equal(
    scalar(control, controlVars, "BETTER_AUTH_BASE_URL"),
    `https://${controlBaseDomain}`,
    `${environment}: control base-domain vars diverged`,
  );
  assert.ok(
    scalar(control, controlVars, "BETTER_AUTH_TRUSTED_ORIGINS")
      .split(",")
      .map((origin) => origin.trim())
      .includes(`https://${controlBaseDomain}`),
    `${environment}: trusted origins omit the control base domain`,
  );
  assert.equal(
    controlService,
    controlName,
    `${environment}: public CONTROL service does not target the control Worker`,
  );
  assert.notEqual(publicName, controlName, `${environment}: Worker names must be distinct`);
  assert.equal(
    control.arraySections.get(`${prefix}.services`),
    undefined,
    `${environment}: control deploy environment contains the test-only self-binding`,
  );
  assert.deepEqual(
    scalar(control, prefix, "services"),
    [],
    `${environment}: control deploy services must be explicitly empty`,
  );
  assert.equal(scalar(control, `${prefix}.observability`, "enabled"), true);
  assert.equal(scalar(publicWorker, `${prefix}.observability`, "enabled"), true);
}

for (const [worker, config] of [
  ["control", control],
  ["public", publicWorker],
]) {
  const requirements = manifest.workers[worker];
  assert.ok(Array.isArray(requirements), `manifest is missing worker ${worker}`);
  for (const environment of environments) {
    const required = requirements.filter((entry) => entry.environments.includes(environment));
    const declaredVars = new Set(
      Object.keys(config.scalarSections.get(`env.${environment}.vars`) ?? {}),
    );
    const declaredSecrets = new Set(
      config.scalarSections.get(`env.${environment}.secrets`)?.required ?? [],
    );
    assert.deepEqual(
      [...declaredVars].sort(),
      required
        .filter((entry) => entry.kind === "var")
        .map((entry) => entry.name)
        .sort(),
      `${worker}/${environment}: manifest vars diverged from Wrangler config`,
    );
    assert.deepEqual(
      [...declaredSecrets].sort(),
      required
        .filter((entry) => entry.kind === "secret")
        .map((entry) => entry.name)
        .sort(),
      `${worker}/${environment}: manifest secrets diverged from Wrangler config`,
    );
  }
}

console.log("Environment configuration invariants are valid.");
