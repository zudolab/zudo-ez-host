import { describe, expect, it } from "vitest";

import {
  artifactManifestKey,
  contentKey,
  immutableContentKey,
  promotedArtifactManifestKey,
  stagedManifestKey,
} from "./keys.js";

describe("R2 key layout", () => {
  it("uses the exact project-scoped content, staged, and artifact prefixes", () => {
    expect(contentKey("project-1", "a".repeat(64))).toBe(
      `projects/project-1/content/${"a".repeat(64)}`,
    );
    expect(stagedManifestKey("project-1", "attempt-7")).toBe("projects/project-1/staged/attempt-7");
    expect(artifactManifestKey("project-1", "artifact-hash")).toBe(
      "projects/project-1/artifacts/artifact-hash",
    );
  });

  it("keeps the descriptive key aliases equivalent to their canonical helpers", () => {
    expect(immutableContentKey).toBe(contentKey);
    expect(promotedArtifactManifestKey).toBe(artifactManifestKey);
  });

  it("rejects path traversal and empty key segments", () => {
    expect(() => contentKey("project/1", "hash")).toThrow(TypeError);
    expect(() => stagedManifestKey("project-1", "../attempt")).toThrow(TypeError);
    expect(() => artifactManifestKey("project-1", "")).toThrow(TypeError);
  });
});
