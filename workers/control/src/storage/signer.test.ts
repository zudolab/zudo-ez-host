import { describe, expect, it } from "vitest";

import { Aws4FetchUploadUrlSigner, UPLOAD_URL_EXPIRY_SECONDS } from "./signer.js";

const SIGNING_TIME = new Date("2026-01-01T00:00:00.000Z");

describe("Aws4FetchUploadUrlSigner", () => {
  it("matches the known PUT SigV4 vector including MD5 and If-None-Match", async () => {
    const signer = new Aws4FetchUploadUrlSigner({
      accountId: "1234567890abcdef1234567890abcdef",
      bucketName: "bucket",
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      now: () => SIGNING_TIME,
    });

    const signedUrl = await signer.signUpload({
      key: `projects/project-1/content/${"0123456789abcdef".repeat(4)}`,
      contentType: "application/octet-stream",
      contentMd5: "1B2M2Y8AsgTpgAmY7PhCfg==",
    });

    expect(signedUrl).toBe(
      "https://1234567890abcdef1234567890abcdef.r2.cloudflarestorage.com/bucket/projects/project-1/content/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef?X-Amz-Expires=600&X-Amz-Date=20260101T000000Z&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIDEXAMPLE%2F20260101%2Fauto%2Fs3%2Faws4_request&X-Amz-SignedHeaders=content-md5%3Bcontent-type%3Bhost%3Bif-none-match&X-Amz-Signature=cb16e9af43adfcde2b80aa254ee74df51f35128bfe31a6aca892c50a485f6b19",
    );

    const parsed = new URL(signedUrl);
    expect(parsed.searchParams.get("X-Amz-Expires")).toBe(String(UPLOAD_URL_EXPIRY_SECONDS));
    expect(parsed.searchParams.get("X-Amz-SignedHeaders")).toBe(
      "content-md5;content-type;host;if-none-match",
    );
  });

  it("changes the known answer when the transport MD5 changes", async () => {
    const signer = new Aws4FetchUploadUrlSigner({
      accountId: "1234567890abcdef1234567890abcdef",
      bucketName: "bucket",
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      now: () => SIGNING_TIME,
    });
    const input = {
      key: "projects/project-1/content/hash",
      contentType: "application/octet-stream",
    };

    const first = await signer.signUpload({ ...input, contentMd5: "1B2M2Y8AsgTpgAmY7PhCfg==" });
    const second = await signer.signUpload({ ...input, contentMd5: "XrY7u+Ae7tCTyyK7j1rNww==" });

    expect(new URL(first).searchParams.get("X-Amz-Signature")).not.toBe(
      new URL(second).searchParams.get("X-Amz-Signature"),
    );
  });
});
