import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { createReadOnlyR2Bucket, type ReadOnlyR2Bucket } from "./readonly.js";

type Assert<T extends true> = T;
type HasOnlyReadMethods<T> = Exclude<keyof T, "get" | "head"> extends never ? true : false;

// Compile-time proof: a serving consumer cannot call a write-capable method.
type ReadOnlyFacadeHasNoWriteMethods = Assert<HasOnlyReadMethods<ReadOnlyR2Bucket>>;
const readOnlyFacadeHasNoWriteMethods: ReadOnlyFacadeHasNoWriteMethods = true;
void readOnlyFacadeHasNoWriteMethods;

describe("read-only R2 facade", () => {
  it("exposes only bound get/head methods at runtime", async () => {
    const key = "read-only-facade-probe";
    await env.ARTIFACTS.put(key, "facade-ok");

    const facade = createReadOnlyR2Bucket(env.ARTIFACTS);
    expect(Object.keys(facade).sort()).toEqual(["get", "head"]);
    expect("put" in facade).toBe(false);
    expect("delete" in facade).toBe(false);
    await expect((await facade.get(key))?.text()).resolves.toBe("facade-ok");
    await expect(facade.head(key)).resolves.toMatchObject({ key, size: 9 });
  });
});
