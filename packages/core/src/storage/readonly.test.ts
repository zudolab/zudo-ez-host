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
    const bucket = {
      marker: "bound",
      async get(this: { marker: string }, key: string) {
        return {
          size: key.length,
          arrayBuffer: async () => new ArrayBuffer(0),
          body: undefined,
        };
      },
      async head(this: { marker: string }, key: string) {
        return { size: key.length + this.marker.length };
      },
      async put() {
        return null;
      },
    };

    const facade = createReadOnlyR2Bucket(bucket);

    expect(Object.keys(facade).sort()).toEqual(["get", "head"]);
    expect("put" in facade).toBe(false);
    const object = await facade.get("key");
    expect(object).not.toBeNull();
    if (object === null) throw new Error("Expected the fixture object");
    await expect(object.arrayBuffer()).resolves.toEqual(new ArrayBuffer(0));
    await expect(facade.head("key")).resolves.toEqual({ size: 8 });
  });
});
