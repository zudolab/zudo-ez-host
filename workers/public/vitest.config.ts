import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

const controlAuxiliaryScript = fileURLToPath(
  new URL("../control/.vitest/control/publication-resolver.js", import.meta.url),
);
const controlAuxiliaryRoot = fileURLToPath(new URL("../control/.vitest/control", import.meta.url));

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
        },
        workers: [
          {
            name: "control-test-auxiliary",
            modules: true,
            scriptPath: controlAuxiliaryScript,
            modulesRoot: controlAuxiliaryRoot,
            compatibilityDate: "2026-08-27",
          },
        ],
      },
    }),
  ],
  test: {
    name: "public-worker",
    globalSetup: ["./vitest.global-setup.ts"],
    include: ["src/**/*.test.ts"],
  },
});
