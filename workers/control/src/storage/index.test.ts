import { describe, expect, it } from "vitest";

import { Aws4FetchUploadUrlSigner, createUploadUrlSignerFromEnv } from "./index.js";

const configuredEnv = {
  R2_ACCOUNT_ID: "account-id",
  R2_BUCKET_NAME: "artifacts",
  R2_ACCESS_KEY_ID: "access-key",
  R2_SECRET_ACCESS_KEY: "secret-key",
} as const;

describe("upload signer environment configuration", () => {
  it("constructs a real signer that issues R2 upload contracts", async () => {
    const signer = createUploadUrlSignerFromEnv(configuredEnv);
    expect(signer).toBeInstanceOf(Aws4FetchUploadUrlSigner);

    const signed = await signer?.signUpload({
      key: "projects/prj_test/content/hash",
      contentType: "text/plain",
      contentMd5: "1B2M2Y8AsgTpgAmY7PhCfg==",
    });

    expect(signed).toContain("https://account-id.r2.cloudflarestorage.com/artifacts/");
    expect(signed).toContain("X-Amz-Signature=");
  });

  it.each(Object.keys(configuredEnv) as (keyof typeof configuredEnv)[])(
    "is unconfigured when %s is absent",
    (missing) => {
      expect(
        createUploadUrlSignerFromEnv({ ...configuredEnv, [missing]: undefined }),
      ).toBeUndefined();
    },
  );

  it("treats malformed signer settings as unconfigured without throwing", () => {
    expect(
      createUploadUrlSignerFromEnv({ ...configuredEnv, R2_ACCOUNT_ID: "not/a/segment" }),
    ).toBeUndefined();
  });
});
