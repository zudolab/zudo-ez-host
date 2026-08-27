import { cloudflareTest, readD1Migrations, type D1Migration } from "@cloudflare/vitest-plugin";
import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

declare module "vitest" {
  export interface ProvidedContext {
    controlMigrations: D1Migration[];
  }
}

const controlAuxiliaryScript = fileURLToPath(
  new URL("../control/.vitest/control/test-auxiliary.js", import.meta.url),
);
const controlAuxiliaryRoot = fileURLToPath(new URL("../control/.vitest/control", import.meta.url));
const controlMigrations = await readD1Migrations(
  fileURLToPath(new URL("../control/migrations", import.meta.url)),
);

export default defineProject({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        serviceBindings: {
          CONTROL: {
            name: "control-test-auxiliary",
            entrypoint: "PublicationResolver",
          },
          CONTROL_HTTP: { name: "control-test-auxiliary" },
        },
        workers: [
          {
            name: "control-test-auxiliary",
            modules: true,
            scriptPath: controlAuxiliaryScript,
            modulesRoot: controlAuxiliaryRoot,
            compatibilityDate: "2026-08-27",
            compatibilityFlags: ["nodejs_compat"],
            d1Databases: { DB: "zudo-ez-host-control-local" },
            r2Buckets: { ARTIFACTS: "zudo-ez-host-artifacts-local" },
          },
        ],
        d1Databases: { DB: "zudo-ez-host-control-local" },
      },
    }),
  ],
  test: {
    name: "public-worker",
    globalSetup: ["./vitest.global-setup.ts"],
    include: ["src/**/*.test.ts"],
    provide: { controlMigrations },
  },
});
