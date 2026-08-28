#!/usr/bin/env bash
set -uo pipefail

# The manifest is the single source of required names. This credential-free
# check compares each manifest entry with the selected Wrangler environment;
# Wrangler performs the final remote-secret-value check during deployment.

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <staging|production>" >&2
  exit 2
fi

ENVIRONMENT="$1"
case "$ENVIRONMENT" in
  staging|production) ;;
  *)
    echo "Unsupported environment: $ENVIRONMENT (expected staging or production)" >&2
    exit 2
    ;;
esac

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${EZ_HOST_ROOT:-$(cd -- "$SCRIPT_DIR/.." && pwd)}"
MANIFEST_PATH="${EZ_HOST_ENV_MANIFEST:-$REPO_ROOT/scripts/env-requirements.json}"

export EZ_HOST_PREFLIGHT_ENV="$ENVIRONMENT"
export EZ_HOST_PREFLIGHT_ROOT="$REPO_ROOT"
export EZ_HOST_PREFLIGHT_MANIFEST="$MANIFEST_PATH"

node --input-type=module <<'NODE'
import { readFile } from "node:fs/promises";
import path from "node:path";

const environment = process.env.EZ_HOST_PREFLIGHT_ENV;
const repoRoot = process.env.EZ_HOST_PREFLIGHT_ROOT;
const manifestPath = process.env.EZ_HOST_PREFLIGHT_MANIFEST;

const missing = [];
const errors = [];

function stripComment(rawLine) {
  let quote = false;
  let escaped = false;

  for (let index = 0; index < rawLine.length; index += 1) {
    const character = rawLine[index];
    if (character === "\\" && quote) {
      escaped = !escaped;
      continue;
    }
    if (character === '"' && !escaped) quote = !quote;
    if (character === "#" && !quote) return rawLine.slice(0, index);
    escaped = false;
  }

  return rawLine;
}

function parseValue(rawValue) {
  const value = rawValue.trim();
  if (value.startsWith('"')) return JSON.parse(value);

  if (value.startsWith("[")) {
    if (!value.endsWith("]")) throw new Error(`invalid TOML array: ${value}`);
    return [...value.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) =>
      JSON.parse(`"${match[1]}"`),
    );
  }

  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

function parseToml(source) {
  const sections = new Map();
  let section = "";

  for (const rawLine of source.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (line === "") continue;

    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      section = header[1];
      if (!sections.has(section)) sections.set(section, new Map());
      continue;
    }

    const assignment = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
    if (!assignment) continue;
    const [, key, rawValue] = assignment;
    const values = sections.get(section) ?? new Map();
    values.set(key, parseValue(rawValue));
    sections.set(section, values);
  }

  return sections;
}

function isPlaceholder(value) {
  if (typeof value !== "string") return true;
  return (
    value.trim() === "" ||
    /YOUR_[A-Z0-9_]+/.test(value) ||
    /GENERATE_[A-Z0-9_]+/.test(value) ||
    /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value.trim())
  );
}

function addMissing(worker, kind, name, reason, purpose) {
  missing.push({ worker, kind, name, reason, purpose });
}

async function main() {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    errors.push(`cannot read manifest ${manifestPath}: ${error.message}`);
    return;
  }

  if (!manifest || typeof manifest !== "object" || !manifest.workers) {
    errors.push("manifest must contain a workers object");
    return;
  }

  const requirements = [];
  for (const [worker, entries] of Object.entries(manifest.workers)) {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(worker)) {
      errors.push(`manifest worker ${worker} is not a valid Worker directory`);
      continue;
    }
    if (!Array.isArray(entries)) {
      errors.push(`manifest worker ${worker} must contain an array`);
      continue;
    }

    for (const [index, entry] of entries.entries()) {
      if (!entry || typeof entry !== "object") {
        errors.push(`manifest ${worker}[${index}] must be an object`);
        continue;
      }
      if (
        typeof entry.name !== "string" ||
        entry.name.trim() === "" ||
        entry.name !== entry.name.trim()
      ) {
        errors.push(`manifest ${worker}[${index}] is missing a name`);
        continue;
      }
      if (entry.kind !== "var" && entry.kind !== "secret") {
        errors.push(`manifest ${worker}/${entry.name} has unsupported kind ${entry.kind}`);
        continue;
      }
      if (!Array.isArray(entry.environments)) {
        errors.push(`manifest ${worker}/${entry.name} is missing environments`);
        continue;
      }
      if (entry.environments.includes(environment)) {
        requirements.push({ ...entry, worker });
      }
    }
  }

  const requirementsByWorker = new Map();
  for (const requirement of requirements) {
    const workerRequirements = requirementsByWorker.get(requirement.worker) ?? [];
    workerRequirements.push(requirement);
    requirementsByWorker.set(requirement.worker, workerRequirements);
  }

  for (const [worker, workerRequirements] of requirementsByWorker) {
    const configPath = path.join(repoRoot, "workers", worker, "wrangler.toml");
    let sections;
    try {
      sections = parseToml(await readFile(configPath, "utf8"));
    } catch (error) {
      errors.push(`cannot read ${configPath}: ${error.message}`);
      for (const requirement of workerRequirements) {
        addMissing(
          worker,
          requirement.kind,
          requirement.name,
          "Worker configuration could not be read",
          requirement.purpose,
        );
      }
      continue;
    }

    const vars = sections.get(`env.${environment}.vars`) ?? new Map();
    const secretSection = sections.get(`env.${environment}.secrets`) ?? new Map();
    const declaredSecrets = new Set(
      Array.isArray(secretSection.get("required")) ? secretSection.get("required") : [],
    );

    for (const requirement of workerRequirements) {
      if (requirement.kind === "var") {
        const value = vars.get(requirement.name);
        if (isPlaceholder(value)) {
          addMissing(
            worker,
            requirement.kind,
            requirement.name,
            value === undefined ? "not declared in Wrangler environment" : "empty or unresolved placeholder",
            requirement.purpose,
          );
        }
      } else if (!declaredSecrets.has(requirement.name)) {
        addMissing(
          worker,
          requirement.kind,
          requirement.name,
          "not declared in Wrangler environment",
          requirement.purpose,
        );
      }
    }
  }

  if (errors.length > 0 || missing.length > 0) {
    console.error(`Configuration preflight failed for ${environment}.`);
    for (const error of errors) console.error(`  - ${error}`);
    for (const requirement of missing) {
      const purpose = requirement.purpose ? ` (${requirement.purpose})` : "";
      console.error(
        `  - ${requirement.worker}/${environment}: missing ${requirement.kind} ${requirement.name} — ${requirement.reason}${purpose}`,
      );
    }
    console.error(
      `${missing.length} required value(s) missing; no Worker deploy was started.`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `Configuration preflight passed for ${environment} (${requirements.length} manifest requirement(s)).`,
  );
}

try {
  await main();
} catch (error) {
  console.error(`Configuration preflight failed: ${error.message}`);
  process.exitCode = 2;
}
NODE
