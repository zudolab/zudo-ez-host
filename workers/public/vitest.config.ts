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
            bindings: {
              BETTER_AUTH_BASE_URL: "https://control.test",
              BETTER_AUTH_TRUSTED_ORIGINS: "https://control.test",
              // Test-only values; production secrets stay out of Wrangler vars.
              BETTER_AUTH_SECRET: "identity-flow-test-secret-0123456789abcdef0123456789abcdef",
              SIGNUP_ALLOWED_EMAILS: "identity-flow@example.test",
            },
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
    // The topology test drives several real control-Worker publication calls.
    // Keep a workerd-specific budget like the control integration project.
    testTimeout: 30_000,
    provide: { controlMigrations },
  },
});
