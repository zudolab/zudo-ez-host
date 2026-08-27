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
    // This integration project starts/imports a real workerd Worker; keep the
    // default 5s guardrail for pure-unit projects while budgeting that startup.
    testTimeout: 15_000,
    provide: { controlMigrations },
  },
});
