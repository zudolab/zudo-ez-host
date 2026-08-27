import { describe, expect, it } from "vitest";

import canonicalizationVectors from "../../fixtures/paths/canonicalization.json";
import collisionVectors from "../../fixtures/paths/collisions.json";
import {
  PORTABLE_PATH_COLLISION_ALGORITHM_VERSION,
  canonicalizePath,
  findPortablePathCollisionV1,
} from "./index.js";
import type { CanonicalPath, PathRejectionReason } from "./index.js";

describe("canonicalizePath", () => {
  for (const vector of canonicalizationVectors.accepted) {
    it(`accepts ${JSON.stringify(vector.input)}`, () => {
      const result = canonicalizePath(vector.input);

      expect(result).toEqual({ ok: true, value: vector.output });
      if (result.ok) {
        expect(canonicalizePath(result.value)).toEqual(result);
      }
    });
  }

  for (const vector of canonicalizationVectors.rejected) {
    it(`rejects ${JSON.stringify(vector.input)} with ${vector.reason}`, () => {
      expect(canonicalizePath(vector.input)).toEqual({
        ok: false,
        reason: vector.reason as PathRejectionReason,
      });
    });
  }
});

describe("findPortablePathCollisionV1", () => {
  it("publishes the collision algorithm version", () => {
    expect(PORTABLE_PATH_COLLISION_ALGORITHM_VERSION).toBe(1);
  });

  for (const vector of collisionVectors.cases) {
    it(vector.name, () => {
      const canonicalPaths = vector.paths.map((path) => {
        const result = canonicalizePath(path);
        expect(result.ok).toBe(true);

        if (!result.ok) {
          throw new Error(`Invalid collision fixture path: ${path}`);
        }

        return result.value;
      });
      const collision = findPortablePathCollisionV1(canonicalPaths);
      const collisionPair = collision ? [collision.first, collision.second] : null;

      expect(collisionPair).toEqual(vector.collision as [CanonicalPath, CanonicalPath] | null);
    });
  }
});
