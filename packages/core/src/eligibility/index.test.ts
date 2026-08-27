import { describe, expect, it } from "vitest";

import vectorsJson from "../../fixtures/eligibility/vectors.json";
import { canonicalizePath } from "../paths/index.js";
import {
  DOT_PREFIX_ALLOWLIST_V1,
  PUBLISH_ELIGIBILITY_ALGORITHM_VERSION,
  evaluatePublishEligibility,
  isPublishEligible,
} from "./index.js";
import type { CanonicalPath } from "../paths/index.js";
import type { PublishEligibilityResult } from "./index.js";

interface EligibilityVector {
  readonly id: string;
  readonly path: string;
  readonly ignoreFile?: string;
  readonly expected: PublishEligibilityResult;
}

interface EligibilityVectorFile {
  readonly version: number;
  readonly cases: readonly EligibilityVector[];
}

const vectors = vectorsJson as EligibilityVectorFile;

function canonicalPath(input: string): CanonicalPath {
  const result = canonicalizePath(input);
  if (!result.ok) {
    throw new Error(`Invalid eligibility fixture path ${JSON.stringify(input)}: ${result.reason}`);
  }
  return result.value;
}

describe("publish eligibility conformance vectors", () => {
  it("publishes a versioned, non-empty fixture set", () => {
    expect(PUBLISH_ELIGIBILITY_ALGORITHM_VERSION).toBe(1);
    expect(vectors.version).toBe(PUBLISH_ELIGIBILITY_ALGORITHM_VERSION);
    expect(vectors.cases.length).toBeGreaterThan(0);
    expect(DOT_PREFIX_ALLOWLIST_V1).toEqual([]);
  });

  for (const vector of vectors.cases) {
    it(vector.id, () => {
      const path = canonicalPath(vector.path);
      const ignoreFile = vector.ignoreFile ?? "";
      const result = evaluatePublishEligibility(path, ignoreFile);

      expect(result).toEqual(vector.expected);
      expect(isPublishEligible(path, ignoreFile)).toBe(vector.expected.eligible);
    });
  }
});
