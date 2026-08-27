import { describe, expect, it } from "vitest";

import servingVectors from "../../fixtures/serving/vectors.json";
import type { ManifestEntry, ManifestEntryLookup } from "../contracts.js";
import { decodeRequestPath, resolveServing, resolveServingRequest } from "./index.js";

interface ServingVector {
  readonly name: string;
  readonly request: {
    readonly method: string;
    readonly rawPath: string;
    readonly isHtmlNavigation?: boolean;
    readonly route?: "content" | "gate-login";
  };
  readonly flags: { readonly spaFallback?: boolean; readonly gated?: boolean };
  readonly manifest: readonly ManifestEntry[];
  readonly expected: unknown;
}

interface ServingVectorFile {
  readonly cases: readonly ServingVector[];
}

const vectors = servingVectors as ServingVectorFile;

function lookupFor(entries: readonly ManifestEntry[]): ManifestEntryLookup {
  return {
    lookup(path) {
      return entries.find((entry) => entry.path === path);
    },
  };
}

describe("resolveServingRequest conformance vectors", () => {
  it("ships a non-empty fixture set consumed by this suite", () => {
    expect(vectors.cases.length).toBeGreaterThan(0);
  });

  for (const vector of vectors.cases) {
    it(vector.name, () => {
      const decision = resolveServingRequest(
        vector.request,
        lookupFor(vector.manifest),
        vector.flags,
      );

      expect(decision).toEqual(vector.expected);
    });
  }
});

describe("decodeRequestPath", () => {
  it("keeps the raw pathname and opaque query separate from decoded path", () => {
    expect(decodeRequestPath("/docs/%E3%81%82?next=%2Fdocs%2F")).toEqual({
      ok: true,
      value: {
        rawPath: "/docs/%E3%81%82?next=%2Fdocs%2F",
        rawPathname: "/docs/%E3%81%82",
        decodedPathname: "/docs/あ",
        query: "?next=%2Fdocs%2F",
        canonicalPath: "docs/あ",
        hasTrailingSlash: false,
      },
    });
  });

  it("rejects raw backslash and repeated separators", () => {
    expect(decodeRequestPath("/safe\\secret")).toEqual({ ok: false, reason: "backslash" });
    expect(decodeRequestPath("/safe//secret")).toEqual({ ok: false, reason: "empty_segment" });
  });

  it("allows one literal trailing slash but not a second one", () => {
    expect(decodeRequestPath("/docs/")).toMatchObject({
      ok: true,
      value: { canonicalPath: "docs", hasTrailingSlash: true },
    });
    expect(decodeRequestPath("/docs//")).toEqual({ ok: false, reason: "empty_segment" });
  });
});

describe("resolver entry points", () => {
  const manifest: ManifestEntry[] = [
    { path: "index.html", sha256: "root", size: 10, contentType: "text/html" },
  ];
  const lookup = lookupFor(manifest);

  it("accepts grouped and positional forms without changing the decision", () => {
    const request = { method: "GET", rawPath: "/" };
    const grouped = resolveServing({ request, manifest: lookup });
    const requestForm = resolveServing(request, lookup);
    const positional = resolveServing("GET", "/", lookup);

    expect(requestForm).toEqual(grouped);
    expect(positional).toEqual(grouped);
  });
});
