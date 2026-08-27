import { describe, expect, it } from "vitest";

import {
  MAX_ACTIVE_PUBLISHED_BYTES_PER_ACCOUNT,
  MAX_ARTIFACT_BYTES,
  MAX_CANONICAL_MANIFEST_BYTES,
  MAX_COMMITS_PER_PROJECT_PER_MINUTE,
  MAX_FILE_BYTES,
  MAX_FILES_PER_ARTIFACT,
  MAX_OPEN_ATTEMPTS_PER_ACCOUNT,
  MAX_OPEN_ATTEMPTS_PER_PROJECT,
  MAX_PREPARES_PER_ACCOUNT_PER_MINUTE,
  MAX_PRESIGNED_URL_ISSUANCES_PER_ACCOUNT_PER_MINUTE,
  MAX_RETAINED_AND_STAGED_BYTES_PER_ACCOUNT,
  MAX_UPLOAD_CONCURRENCY_PER_MACHINE,
  MACHINE_TOKEN_PREFIX,
  MACHINE_TOKEN_VERSION,
  generateMachineToken,
  parseMachineToken,
} from "./index.js";
import type { PublicationResolution } from "./index.js";

describe("@zudo-ez-host/core", () => {
  it("exports the publication resolution contract", () => {
    const resolution: PublicationResolution = {
      projectId: "project-fixture",
      artifactHash: "sha256:fixture",
      servingFlags: { spaFallback: true, gated: false },
    };

    expect(resolution.servingFlags).toEqual({ spaFallback: true, gated: false });
  });

  it("executes in the root test lane", () => {
    expect({
      MAX_FILE_BYTES,
      MAX_FILES_PER_ARTIFACT,
      MAX_ARTIFACT_BYTES,
      MAX_ACTIVE_PUBLISHED_BYTES_PER_ACCOUNT,
      MAX_RETAINED_AND_STAGED_BYTES_PER_ACCOUNT,
      MAX_CANONICAL_MANIFEST_BYTES,
      MAX_OPEN_ATTEMPTS_PER_PROJECT,
      MAX_OPEN_ATTEMPTS_PER_ACCOUNT,
      MAX_UPLOAD_CONCURRENCY_PER_MACHINE,
      MAX_PREPARES_PER_ACCOUNT_PER_MINUTE,
      MAX_COMMITS_PER_PROJECT_PER_MINUTE,
      MAX_PRESIGNED_URL_ISSUANCES_PER_ACCOUNT_PER_MINUTE,
    }).toEqual({
      MAX_FILE_BYTES: 100 * 1024 * 1024,
      MAX_FILES_PER_ARTIFACT: 20_000,
      MAX_ARTIFACT_BYTES: 2 * 1024 * 1024 * 1024,
      MAX_ACTIVE_PUBLISHED_BYTES_PER_ACCOUNT: 10 * 1024 * 1024 * 1024,
      MAX_RETAINED_AND_STAGED_BYTES_PER_ACCOUNT: 20 * 1024 * 1024 * 1024,
      MAX_CANONICAL_MANIFEST_BYTES: 10 * 1024 * 1024,
      MAX_OPEN_ATTEMPTS_PER_PROJECT: 3,
      MAX_OPEN_ATTEMPTS_PER_ACCOUNT: 20,
      MAX_UPLOAD_CONCURRENCY_PER_MACHINE: 8,
      MAX_PREPARES_PER_ACCOUNT_PER_MINUTE: 5,
      MAX_COMMITS_PER_PROJECT_PER_MINUTE: 10,
      MAX_PRESIGNED_URL_ISSUANCES_PER_ACCOUNT_PER_MINUTE: 1_000,
    });
  });

  it("exports the machine-token wire helpers from the core barrel", () => {
    const parsed = parseMachineToken(generateMachineToken());

    expect(parsed).toEqual({
      ok: true,
      value: { prefix: MACHINE_TOKEN_PREFIX, version: MACHINE_TOKEN_VERSION },
    });
  });
});
