import { describe, expect, it } from "vitest";

import conformanceVectors from "../../fixtures/manifest/conformance.json";
import {
  DEFAULT_CONTENT_TYPE,
  MANIFEST_SCHEMA_VERSION,
  SERVING_SEMANTICS_VERSION,
  createManifestLookup,
  decodeCanonical,
  encodeCanonical,
  validateManifest,
} from "./index.js";
import type { Manifest, ManifestEntry } from "./index.js";
import {
  MAX_ARTIFACT_BYTES,
  MAX_CANONICAL_MANIFEST_BYTES,
  MAX_FILE_BYTES,
  MAX_FILES_PER_ARTIFACT,
} from "../limits.js";

const textDecoder = new TextDecoder();
const SHA = "a".repeat(64);

function manifest(entries: readonly ManifestEntry[]): Manifest {
  return {
    version: MANIFEST_SCHEMA_VERSION,
    servingSemanticsVersion: SERVING_SEMANTICS_VERSION,
    entries,
  };
}

function entry(path: string, size = 0): ManifestEntry {
  return {
    path,
    sha256: SHA,
    size,
    contentType: "application/octet-stream",
  };
}

function validationReason(input: unknown): string {
  const result = validateManifest(input);
  if (result.ok) {
    throw new Error("Expected manifest validation to fail");
  }
  return result.reason;
}

describe("manifest conformance vectors", () => {
  for (const vector of conformanceVectors.accepted) {
    it(`encodes ${vector.name}`, () => {
      const result = validateManifest(vector.input);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error(`Expected accepted vector to validate: ${result.reason}`);
      }

      expect(textDecoder.decode(encodeCanonical(result.value))).toBe(vector.canonical);
      const decoded = decodeCanonical(new TextEncoder().encode(vector.canonical));
      expect(decoded.ok).toBe(true);
      if (decoded.ok) {
        expect(decoded.value.entries).toEqual(result.value.entries);
      }
    });
  }

  for (const vector of conformanceVectors.rejected) {
    it(vector.name, () => {
      expect(validationReason(vector.input)).toBe(vector.reason);
    });
  }
});

describe("manifest validation boundaries", () => {
  it("produces identical bytes for different entry orders", () => {
    const first = manifest([entry("z.txt", 2), entry("a.txt", 1)]);
    const second = manifest([entry("a.txt", 1), entry("z.txt", 2)]);

    expect(encodeCanonical(first)).toEqual(encodeCanonical(second));
  });

  it("accepts exactly MAX_FILE_BYTES and rejects one byte over", () => {
    expect(validateManifest(manifest([entry("exact.bin", MAX_FILE_BYTES)])).ok).toBe(true);
    expect(validationReason(manifest([entry("over.bin", MAX_FILE_BYTES + 1)]))).toBe(
      "file_size_limit_exceeded",
    );
  });

  it("accepts exactly MAX_FILES_PER_ARTIFACT and rejects one entry over", () => {
    const entries = Array.from({ length: MAX_FILES_PER_ARTIFACT }, (_, index) =>
      entry(`files/${index}.bin`),
    );
    expect(validateManifest(manifest(entries)).ok).toBe(true);
    expect(validationReason(manifest([...entries, entry("files/one-over.bin")]))).toBe(
      "file_count_limit_exceeded",
    );
  });

  it("accepts exactly MAX_ARTIFACT_BYTES and rejects one byte over", () => {
    const fullFileCount = Math.floor(MAX_ARTIFACT_BYTES / MAX_FILE_BYTES);
    const remainder = MAX_ARTIFACT_BYTES % MAX_FILE_BYTES;
    const entries = Array.from({ length: fullFileCount }, (_, index) =>
      entry(`artifact/${index}.bin`, MAX_FILE_BYTES),
    );
    if (remainder > 0) {
      entries.push(entry(`artifact/${fullFileCount}.bin`, remainder));
    }

    expect(validateManifest(manifest(entries)).ok).toBe(true);
    const oneOver = [...entries];
    const last = oneOver.length - 1;
    const lastEntry = oneOver[last];
    if (lastEntry === undefined) {
      throw new Error("Expected an artifact boundary entry");
    }
    oneOver[last] = { ...lastEntry, size: lastEntry.size + 1 };
    expect(validationReason(manifest(oneOver))).toBe("artifact_size_limit_exceeded");
  });

  it("accepts exactly MAX_CANONICAL_MANIFEST_BYTES and rejects one byte over", () => {
    const withPath = (path: string): Manifest => manifest([entry(path)]);
    const oneCharacterLength = encodeCanonical(withPath("a")).byteLength;
    const pathLength = MAX_CANONICAL_MANIFEST_BYTES - oneCharacterLength + 1;
    const exact = withPath("a".repeat(pathLength));

    expect(encodeCanonical(exact).byteLength).toBe(MAX_CANONICAL_MANIFEST_BYTES);
    expect(validateManifest(exact).ok).toBe(true);

    const over = withPath(`${"a".repeat(pathLength)}a`);
    expect(encodeCanonical(over).byteLength).toBe(MAX_CANONICAL_MANIFEST_BYTES + 1);
    expect(validationReason(over)).toBe("manifest_body_limit_exceeded");
  });
});

describe("manifest lookup and decoder safety", () => {
  it("looks up only exact validated paths", () => {
    const result = validateManifest(
      manifest([
        { ...entry("index.html", 10), contentType: "text/html" },
        { ...entry("Logo.png", 20), contentType: "image/png" },
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.reason);
    }

    expect(result.value.lookup("index.html")).toEqual(
      result.value.entries.find((entry) => entry.path === "index.html"),
    );
    expect(result.value.lookup("INDEX.HTML")).toBeUndefined();
    expect(createManifestLookup(result.value).lookup("Logo.png")).toEqual(
      result.value.entries.find((entry) => entry.path === "Logo.png"),
    );
  });

  it("rejects non-canonical whitespace and malformed UTF-8", () => {
    const valid = manifest([entry("index.html")]);
    const canonical = encodeCanonical(valid);
    const withWhitespace = new TextEncoder().encode(` ${textDecoder.decode(canonical)}`);
    const nonCanonical = decodeCanonical(withWhitespace);
    expect(nonCanonical.ok ? "ok" : nonCanonical.reason).toBe("non_canonical_encoding");
    expect(decodeCanonical(Uint8Array.from([0xff, 0xfe])).ok).toBe(false);
    const invalidJson = decodeCanonical(Uint8Array.from([0x7b, 0x7d]));
    expect(invalidJson.ok ? "ok" : invalidJson.reason).toBe("invalid_schema_version");
  });

  it("normalizes an empty content type to the safe fallback", () => {
    const result = validateManifest(manifest([{ ...entry("unknown"), contentType: "" }]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.entries[0]?.contentType).toBe(DEFAULT_CONTENT_TYPE);
    }
  });
});
