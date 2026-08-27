import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node-unit",
          environment: "node",
          include: ["packages/*/src/**/*.test.ts"],
        },
      },
      "./workers/control/vitest.config.ts",
      "./workers/public/vitest.config.ts",
    ],
  },
});
