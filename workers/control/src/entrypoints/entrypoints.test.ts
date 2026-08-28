import { describe, expect, it } from "vitest";

type SourceModules = Record<string, string>;

interface ImportMetaWithGlob extends ImportMeta {
  glob(pattern: string, options: { eager: true; import: "default"; query: string }): SourceModules;
}

// Vite resolves this at test-build time, so the guard can inspect source while
// still running in the same workerd pool as the control-worker tests.
const rawSourceModules = (import.meta as ImportMetaWithGlob).glob("../**/*.ts", {
  eager: true,
  import: "default",
  query: "?raw",
}) as SourceModules;

function sourcePath(globPath: string): string {
  const normalizedPath = globPath.replaceAll("\\", "/");
  return normalizedPath.startsWith("./")
    ? `entrypoints/${normalizedPath.slice(2)}`
    : normalizedPath.replace(/^\.\.\//, "");
}

const sourceModules = Object.fromEntries(
  Object.entries(rawSourceModules).map(([globPath, source]) => [sourcePath(globPath), source]),
) as SourceModules;

const workerEntryModules = ["index.ts", "test-auxiliary.ts"];

function normalizeModulePath(modulePath: string): string {
  return modulePath.replaceAll("\\", "/");
}

function resolveSourceModule(
  importer: string,
  specifier: string,
  modules: SourceModules,
): string | undefined {
  if (!specifier.startsWith(".")) {
    return undefined;
  }

  const importerParts = normalizeModulePath(importer).split("/");
  importerParts.pop();
  const specifierParts = specifier.split("/");
  const resolvedParts = [...importerParts, ...specifierParts];
  const normalizedParts: string[] = [];

  for (const part of resolvedParts) {
    if (part === "." || part === "") {
      continue;
    }
    if (part === "..") {
      normalizedParts.pop();
    } else {
      normalizedParts.push(part);
    }
  }

  const resolved = normalizedParts.join("/");
  const candidates = [
    resolved,
    `${resolved}.ts`,
    resolved.replace(/\.js$/, ".ts"),
    `${resolved}/index.ts`,
  ];

  return candidates.find((candidate) => candidate in modules);
}

function importedSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const staticImport = /(?:import|export)\s+(?:type\s+)?(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']/g;
  const dynamicImport = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

  for (const match of source.matchAll(staticImport)) {
    const specifier = match[1];
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }
  for (const match of source.matchAll(dynamicImport)) {
    const specifier = match[1];
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }

  return specifiers;
}

function reachableModules(modules: SourceModules): Set<string> {
  const reachable = new Set<string>();
  const pending = workerEntryModules.filter((entry) => entry in modules);

  while (pending.length > 0) {
    const modulePath = pending.pop();
    if (modulePath === undefined || reachable.has(modulePath)) {
      continue;
    }

    reachable.add(modulePath);
    const source = modules[modulePath];
    if (source === undefined) {
      continue;
    }

    for (const specifier of importedSpecifiers(source)) {
      const importedModule = resolveSourceModule(modulePath, specifier, modules);
      if (importedModule !== undefined && !reachable.has(importedModule)) {
        pending.push(importedModule);
      }
    }
  }

  return reachable;
}

function workerEntrypointModules(modules: SourceModules): string[] {
  const workerEntrypointClass =
    /\bexport\s+(?:default\s+)?class\s+\w+\s+extends\s+WorkerEntrypoint\b/;

  return Object.entries(modules)
    .filter(
      ([modulePath, source]) =>
        !modulePath.endsWith(".test.ts") && workerEntrypointClass.test(source),
    )
    .map(([modulePath]) => modulePath);
}

describe("Worker entrypoint source graph", () => {
  it("keeps every exported WorkerEntrypoint subclass reachable from a Worker entry", () => {
    const reachable = reachableModules(sourceModules);
    const orphaned = workerEntrypointModules(sourceModules).filter(
      (modulePath) => !reachable.has(modulePath),
    );

    expect(orphaned, "Every WorkerEntrypoint subclass must be imported by a Worker entry").toEqual(
      [],
    );
  });
});
