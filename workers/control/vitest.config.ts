import { cloudflareTest, readD1Migrations, type D1Migration } from "@cloudflare/vitest-plugin";
import { defineProject } from "vitest/config";

declare module "vitest" {
  export interface ProvidedContext {
    controlMigrations: D1Migration[];
  }
}

const controlMigrations = await readD1Migrations(new URL("./migrations", import.meta.url).pathname);

export default defineProject({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
    }),
  ],
  test: {
    name: "control-worker",
    include: ["src/**/*.test.ts"],
    provide: { controlMigrations },
  },
});
