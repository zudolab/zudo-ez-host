#!/usr/bin/env node

/**
 * Ensure the hand-written English and Japanese doc trees stay route-parity
 * compatible. Generated Claude resource pages are deliberately English-only;
 * their URL prefixes are listed explicitly below and must also match
 * `defaultLocaleOnlyPrefixes` in doc/zfb.config.ts.
 */

import { readdir } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const docRoot = join(repoRoot, "doc");
const englishRoot = join(docRoot, "src/content/docs");
const japaneseRoot = join(docRoot, "src/content/docs-ja");

// These are URL prefixes, not filesystem paths. They intentionally mirror
// zudo-doc's generated `defaultLocaleOnlyPrefixes` configuration.
const defaultLocaleOnlyPrefixes = [
  "/docs/claude-md/",
  "/docs/claude-skills/",
  "/docs/claude-agents/",
  "/docs/claude-commands/",
];

// The Claude landing page is generated into the default-locale tree during a
// docs build, while its hand-written JA mirror is tracked. Treat that expected
// generated counterpart as present so the standalone parity command also works
// on a clean checkout before the first build.
const generatedEnglishPageKeys = new Set(["claude/index"]);

const contentExtensions = new Set([".md", ".mdx"]);

async function collectPageKeys(rootDir) {
  const files = [];

  async function walk(currentDir) {
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }

    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile() || !contentExtensions.has(extname(entry.name))) continue;

      const key = relative(rootDir, fullPath)
        .replaceAll("\\", "/")
        .replace(/\.(?:md|mdx)$/, "");
      files.push({ key, file: relative(repoRoot, fullPath).replaceAll("\\", "/") });
    }
  }

  await walk(rootDir);
  files.sort((a, b) => a.key.localeCompare(b.key));
  return files;
}

function pageUrl(key) {
  return `/docs/${key.replace(/\/index$/, "")}`;
}

function isDefaultLocaleOnly(key) {
  const url = `${pageUrl(key)}/`;
  return defaultLocaleOnlyPrefixes.some((prefix) => url.startsWith(prefix));
}

function formatEntry(entry) {
  return `${entry.file} (route ${pageUrl(entry.key)})`;
}

const [englishPages, japanesePages] = await Promise.all([
  collectPageKeys(englishRoot),
  collectPageKeys(japaneseRoot),
]);

const englishByKey = new Map();
const japaneseByKey = new Map();
for (const entry of englishPages) englishByKey.set(entry.key, entry);
for (const entry of japanesePages) japaneseByKey.set(entry.key, entry);

const missingJapanese = englishPages.filter(
  (entry) => !japaneseByKey.has(entry.key) && !isDefaultLocaleOnly(entry.key),
);
const missingEnglish = japanesePages.filter(
  (entry) => !englishByKey.has(entry.key) && !generatedEnglishPageKeys.has(entry.key),
);

const duplicateEnglish = englishPages.filter(
  (entry, index, pages) => index > 0 && pages[index - 1].key === entry.key,
);
const duplicateJapanese = japanesePages.filter(
  (entry, index, pages) => index > 0 && pages[index - 1].key === entry.key,
);

console.log(`i18n parity: ${englishPages.length} EN page(s), ${japanesePages.length} JA page(s)`);

if (
  duplicateEnglish.length ||
  duplicateJapanese.length ||
  missingJapanese.length ||
  missingEnglish.length
) {
  if (duplicateEnglish.length) {
    console.error("\nDuplicate EN page routes:");
    for (const entry of duplicateEnglish) console.error(`  - ${formatEntry(entry)}`);
  }
  if (duplicateJapanese.length) {
    console.error("\nDuplicate JA page routes:");
    for (const entry of duplicateJapanese) console.error(`  - ${formatEntry(entry)}`);
  }
  if (missingJapanese.length) {
    console.error("\nEN pages missing a JA mirror:");
    for (const entry of missingJapanese) console.error(`  - ${formatEntry(entry)}`);
  }
  if (missingEnglish.length) {
    console.error("\nJA pages missing an EN mirror:");
    for (const entry of missingEnglish) console.error(`  - ${formatEntry(entry)}`);
  }
  process.exitCode = 1;
} else {
  console.log("✓ EN/JA page paths are in parity (with explicit default-locale-only exemptions)");
}
