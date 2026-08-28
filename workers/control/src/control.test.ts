import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("control Worker", () => {
  it("dispatches through the Hono app", async () => {
    const response = await exports.default.fetch("https://control.test/health");

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      service: "control",
      status: "not_ready",
      checks: {
        d1: true,
        r2: true,
        betterAuthSecret: false,
        uploadSigner: false,
      },
    });
  });

  it("uses the real local D1 and R2 bindings", async () => {
    await env.DB.exec("CREATE TABLE binding_probe (value TEXT NOT NULL)");
    await env.DB.prepare("INSERT INTO binding_probe (value) VALUES (?)").bind("d1-ok").run();
    const row = await env.DB.prepare("SELECT value FROM binding_probe").first<{ value: string }>();

    await env.ARTIFACTS.put("binding-probe", "r2-ok");
    const object = await env.ARTIFACTS.get("binding-probe");

    expect(row?.value).toBe("d1-ok");
    await expect(object?.text()).resolves.toBe("r2-ok");
  });
});
