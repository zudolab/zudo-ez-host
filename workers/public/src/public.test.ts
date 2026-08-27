import type { PublicationResolution } from "@zudo-ez-host/core";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("public Worker", () => {
  it("uses the real local R2 binding", async () => {
    await env.ARTIFACTS.put("public-binding-probe", "r2-ok");
    const object = await env.ARTIFACTS.get("public-binding-probe");

    await expect(object?.text()).resolves.toBe("r2-ok");
  });

  it("calls the named control entrypoint over a real service binding", async () => {
    const response = await exports.default.fetch(
      "https://public.test/resolution/project-rpc-smoke",
    );
    const resolution = (await response.json()) as PublicationResolution;

    expect(response.status).toBe(200);
    expect(resolution).toEqual({
      projectId: "project-rpc-smoke",
      artifactHash: "sha256:publication-resolution-fixture",
      servingFlags: { spaFallback: true, gated: false },
    });
  });
});
