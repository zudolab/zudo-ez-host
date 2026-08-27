import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { contentKey } from "./keys.js";
import { createReadOnlyR2Bucket } from "./readonly.js";
import { MAX_VERIFICATION_BATCH_SIZE, verifyR2Object, verifyR2Objects } from "./verify.js";

function base64(bytes: ArrayBuffer): string {
  return globalThis.btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

describe("R2 object verification", () => {
  it("detects missing, short, oversized, and wrong-MD5 objects in workerd", async () => {
    const bucket = createReadOnlyR2Bucket(env.ARTIFACTS);
    const body = "verification fixture";
    const key = contentKey("verification-project", "a".repeat(64));
    await env.ARTIFACTS.put(key, body);
    const object = await env.ARTIFACTS.head(key);
    const md5 = object?.checksums.md5;

    if (md5 === undefined) {
      throw new Error("workerd R2 did not expose the default non-multipart MD5 checksum");
    }
    const expectedMd5 = base64(md5);
    await expect(
      verifyR2Object(bucket, {
        key,
        expectedSize: new TextEncoder().encode(body).byteLength,
        expectedMd5,
      }),
    ).resolves.toMatchObject({
      exists: true,
      sizeMatches: true,
      md5Available: true,
      md5Matches: true,
      verified: true,
      ok: true,
    });

    await expect(
      verifyR2Object(bucket, { key, expectedSize: body.length - 1 }),
    ).resolves.toMatchObject({
      exists: true,
      sizeMatches: false,
      verified: false,
      reason: "size_mismatch",
    });
    await expect(
      verifyR2Object(bucket, { key, expectedSize: body.length + 1 }),
    ).resolves.toMatchObject({
      exists: true,
      sizeMatches: false,
      verified: false,
      reason: "size_mismatch",
    });
    await expect(
      verifyR2Object(bucket, {
        key,
        expectedSize: body.length,
        expectedMd5: "AAAAAAAAAAAAAAAAAAAAAA==",
      }),
    ).resolves.toMatchObject({
      exists: true,
      sizeMatches: true,
      md5Matches: false,
      verified: false,
      reason: "md5_mismatch",
    });
    await expect(
      verifyR2Object(bucket, { key: `${key}-missing`, expectedSize: body.length }),
    ).resolves.toMatchObject({
      exists: false,
      sizeMatches: false,
      verified: false,
      reason: "missing",
    });
  });

  it("checks a bounded batch without silently paging it", async () => {
    const bucket = createReadOnlyR2Bucket(env.ARTIFACTS);
    const key = contentKey("verification-batch", "b".repeat(64));
    await env.ARTIFACTS.put(key, "batch");

    await expect(
      verifyR2Objects(bucket, [
        { key, expectedSize: 5 },
        { key: `${key}-missing`, expectedSize: 5 },
      ]),
    ).resolves.toMatchObject([
      { key, exists: true, sizeMatches: true, verified: true },
      { key: `${key}-missing`, exists: false, verified: false },
    ]);

    const tooMany = Array.from({ length: MAX_VERIFICATION_BATCH_SIZE + 1 }, (_, index) => ({
      key: `${key}-${index}`,
      expectedSize: 0,
    }));
    await expect(verifyR2Objects(bucket, tooMany)).rejects.toThrow(
      `verification batch cannot exceed ${MAX_VERIFICATION_BATCH_SIZE} R2 head requests`,
    );
  });
});
