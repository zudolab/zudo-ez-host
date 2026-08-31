import { describe, expect, it } from "vitest";

import { createHealthRouter } from "./health.js";

const credentialValues = {
  BETTER_AUTH_SECRET: "auth-secret-must-not-leak",
  R2_ACCESS_KEY_ID: "access-key-must-not-leak",
  R2_SECRET_ACCESS_KEY: "r2-secret-must-not-leak",
  R2_ACCOUNT_ID: "account-id-must-not-leak",
  R2_BUCKET_NAME: "bucket-name-must-not-leak",
} as const;
const publicationResolverValue = "test-only-binding-must-not-be-reported";

describe("control health readiness", () => {
  it("reports only readiness booleans when every deployment dependency is configured", async () => {
    const response = await createHealthRouter({ uploadSignerConfigured: true }).request(
      "https://control.test/health",
      undefined,
      {
        DB: {},
        ARTIFACTS: {},
        PUBLICATION_RESOLVER: publicationResolverValue,
        ...credentialValues,
      } as unknown as ControlEnv,
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(body)).toEqual({
      service: "control",
      status: "ready",
      checks: { d1: true, r2: true, betterAuthSecret: true, uploadSigner: true },
    });
    for (const value of [
      ...Object.values(credentialValues),
      "PUBLICATION_RESOLVER",
      publicationResolverValue,
    ]) {
      expect(body).not.toContain(value);
    }
  });

  it("returns an actionable not-ready response when dependencies are missing", async () => {
    const response = await createHealthRouter().request(
      "https://control.test/health",
      undefined,
      {} as ControlEnv,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      service: "control",
      status: "not_ready",
      checks: { d1: false, r2: false, betterAuthSecret: false, uploadSigner: false },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
