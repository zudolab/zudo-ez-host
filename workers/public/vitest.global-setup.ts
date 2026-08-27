import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const controlDirectory = fileURLToPath(new URL("../control", import.meta.url));

export default function buildControlAuxiliary(): void {
  execFileSync("pnpm", ["run", "build:test-auxiliary"], {
    cwd: controlDirectory,
    stdio: "inherit",
    timeout: 60_000,
  });
}
