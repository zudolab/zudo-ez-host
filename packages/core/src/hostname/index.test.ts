import { describe, expect, it } from "vitest";

import vectorsJson from "../../fixtures/hostname/vectors.json";
import { composeLabel, parseLabel, RESERVED_NAMES, validateHandle, validateSlug } from "./index.js";
import type { HostnameValidationOptions } from "./index.js";

type Operation = "validateHandle" | "validateSlug" | "composeLabel" | "parseLabel";

interface Vector {
  readonly id: string;
  readonly operation: Operation;
  readonly args: readonly unknown[];
  readonly options?: HostnameValidationOptions;
  readonly expected: unknown;
}

interface VectorFile {
  readonly version: number;
  readonly valid: readonly Vector[];
  readonly invalid: readonly Vector[];
}

const vectors = vectorsJson as VectorFile;

function runVector(vector: Vector): unknown {
  const [first, second] = vector.args;
  switch (vector.operation) {
    case "validateHandle":
      return validateHandle(first, vector.options);
    case "validateSlug":
      return validateSlug(first, vector.options);
    case "composeLabel":
      return composeLabel(first, second, vector.options);
    case "parseLabel":
      return parseLabel(first, vector.options);
  }
}

describe("hostname conformance vectors", () => {
  it("ships a versioned, non-empty fixture set", () => {
    expect(vectors.version).toBe(1);
    expect(vectors.valid.length).toBeGreaterThan(0);
    expect(vectors.invalid.length).toBeGreaterThan(0);
  });

  for (const vector of vectors.valid) {
    it(`accepts ${vector.id}`, () => {
      expect(runVector(vector)).toEqual(vector.expected);
    });
  }

  for (const vector of vectors.invalid) {
    it(`rejects ${vector.id} with its reason`, () => {
      expect(runVector(vector)).toEqual(vector.expected);
    });
  }

  it("keeps every ADR minimum reserved name in the central policy", () => {
    expect(RESERVED_NAMES).toEqual(
      expect.arrayContaining([
        "www",
        "api",
        "app",
        "admin",
        "auth",
        "login",
        "logout",
        "account",
        "billing",
        "support",
        "status",
        "docs",
        "cdn",
        "assets",
        "static",
        "mail",
        "ftp",
        "localhost",
        "staging",
        "preview",
        "internal",
        "root",
        "system",
      ]),
    );
  });

  it("round-trips composed labels through the parser", () => {
    const composed = composeLabel("Project-7", "User-Handle");
    expect(composed).toEqual({ ok: true, value: "project-7--user-handle" });

    if (composed.ok) {
      expect(parseLabel(composed.value)).toEqual({
        ok: true,
        value: { slug: "project-7", handle: "user-handle" },
      });
    }
  });
});
