import type { CanonicalPath } from "../paths/index.js";

/**
 * Version of the publish-eligibility policy and its ignore-file matcher.
 *
 * The version is part of the conformance contract. A change to matching
 * semantics must increment it so that another implementation (notably the
 * Rust scanner) cannot silently drift from the TypeScript implementation.
 */
export const PUBLISH_ELIGIBILITY_ALGORITHM_VERSION = 1 as const;

/** File names that are never publishable, at any path depth. */
export const HARD_IGNORE_FILE_NAMES = Object.freeze([
  ".DS_Store",
  "Icon\r",
  ".Spotlight-V100",
  ".Trashes",
  "Thumbs.db",
  "desktop.ini",
] as const);

/** Directory names whose contents are never publishable, at any path depth. */
export const HARD_IGNORE_DIRECTORY_NAMES = Object.freeze([".git", ".hg", ".svn"] as const);

/** The AppleDouble file-name pattern used by the hard-ignore policy. */
export const HARD_IGNORE_APPLEDOUBLE_PREFIX = "._*" as const;

/**
 * The future exact dot-prefix allowlist hook. V1 intentionally has no
 * entries. Any future entry must be reviewed as an exact safe path and must
 * not weaken hard ignores or admit repository, environment, editor, or
 * credential files.
 */
export const DOT_PREFIX_ALLOWLIST_V1: readonly string[] = Object.freeze([]);

/** Whether a path can be included in a publication. */
export type PublishEligibilityDecision = "publish" | "ignore";

/** The policy layer that produced a publish-eligibility result. */
export type PublishEligibilityRule =
  "default_allow" | "hard_ignore" | "dot_prefix" | "ezhostignore";

/**
 * Result of evaluating one already-canonical relative path.
 *
 * `pattern` and `line` are present when an ignore-file rule decided the
 * result. For hard and dot-prefix rules, `pattern` identifies the matching
 * policy token. The default result has no deciding pattern.
 */
export interface PublishEligibilityResult {
  readonly eligible: boolean;
  readonly decision: PublishEligibilityDecision;
  readonly rule: PublishEligibilityRule;
  readonly pattern?: string;
  readonly line?: number;
}

interface ParsedIgnoreRule {
  readonly raw: string;
  readonly pattern: string;
  readonly line: number;
  readonly negated: boolean;
  readonly anchored: boolean;
  readonly directoryOnly: boolean;
  readonly segments: readonly string[];
}

const SEGMENT_REGEX_CACHE = new Map<string, RegExp>();

function result(
  eligible: boolean,
  rule: PublishEligibilityRule,
  pattern?: string,
  line?: number,
): PublishEligibilityResult {
  return {
    eligible,
    decision: eligible ? "publish" : "ignore",
    rule,
    ...(pattern === undefined ? {} : { pattern }),
    ...(line === undefined ? {} : { line }),
  };
}

function findHardIgnore(path: CanonicalPath): string | undefined {
  for (const segment of path.split("/")) {
    if ((HARD_IGNORE_DIRECTORY_NAMES as readonly string[]).includes(segment)) {
      return `${segment}/`;
    }

    if ((HARD_IGNORE_FILE_NAMES as readonly string[]).includes(segment)) {
      return segment;
    }

    if (segment.startsWith("._")) {
      return HARD_IGNORE_APPLEDOUBLE_PREFIX;
    }
  }

  return undefined;
}

function isDotPrefixAllowlisted(path: CanonicalPath): boolean {
  // This exact-match hook remains empty in V1. Hard ignores are checked before
  // this function, so a future safe allowlist cannot resurrect one of them.
  return DOT_PREFIX_ALLOWLIST_V1.includes(path);
}

function hasDotPrefixedSegment(path: CanonicalPath): string | undefined {
  for (const segment of path.split("/")) {
    if (segment.startsWith(".")) {
      return segment;
    }
  }

  return undefined;
}

function escapeRegexCharacter(character: string): string {
  return character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Translates one non-`**` path segment to a regular expression.
 *
 * Only `*` and `?` have wildcard meaning. A backslash is not an escape in
 * this V1 subset: it, and the character following it, are emitted literally.
 * Character classes and other gitignore extensions are likewise escaped as
 * ordinary text.
 */
function segmentRegex(segment: string): RegExp {
  const cached = SEGMENT_REGEX_CACHE.get(segment);
  if (cached !== undefined) {
    return cached;
  }

  let source = "^";
  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index];
    if (character === undefined) {
      continue;
    }

    if (character === "\\") {
      source += escapeRegexCharacter(character);
      const following = segment[index + 1];
      if (following !== undefined) {
        source += escapeRegexCharacter(following);
        index += 1;
      }
      continue;
    }

    if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += escapeRegexCharacter(character);
    }
  }
  source += "$";

  const compiled = new RegExp(source, "u");
  SEGMENT_REGEX_CACHE.set(segment, compiled);
  return compiled;
}

function matchesSegment(pattern: string, pathSegment: string): boolean {
  return segmentRegex(pattern).test(pathSegment);
}

function matchesSegments(
  pathSegments: readonly string[],
  patternSegments: readonly string[],
): boolean {
  const memo = new Map<string, boolean>();

  function visit(pathIndex: number, patternIndex: number): boolean {
    const key = `${pathIndex}:${patternIndex}`;
    const cached = memo.get(key);
    if (cached !== undefined) {
      return cached;
    }

    let matched: boolean;
    if (patternIndex === patternSegments.length) {
      matched = pathIndex === pathSegments.length;
    } else if (patternSegments[patternIndex] === "**") {
      // A globstar consumes zero or more complete path segments.
      matched =
        visit(pathIndex, patternIndex + 1) ||
        (pathIndex < pathSegments.length && visit(pathIndex + 1, patternIndex));
    } else {
      matched =
        pathIndex < pathSegments.length &&
        matchesSegment(patternSegments[patternIndex] ?? "", pathSegments[pathIndex] ?? "") &&
        visit(pathIndex + 1, patternIndex + 1);
    }

    memo.set(key, matched);
    return matched;
  }

  return visit(0, 0);
}

function parseIgnoreRules(ignoreFile: string): readonly ParsedIgnoreRule[] {
  const rules: ParsedIgnoreRule[] = [];

  // Split CRLF and old-style CR files while retaining the original line
  // numbers reported to callers.
  const lines = ignoreFile.split(/\r\n?|\n/);
  for (const [lineIndex, line] of lines.entries()) {
    if (line.trim().length === 0 || line.startsWith("#")) {
      continue;
    }

    const lineNumber = lineIndex + 1;
    const negated = line.startsWith("!");
    let pattern = negated ? line.slice(1) : line;
    if (pattern.length === 0) {
      // A bare negation has no pattern in the documented subset and is
      // ignored rather than becoming an accidental match-all rule.
      continue;
    }

    const anchored = pattern.startsWith("/");
    if (anchored) {
      pattern = pattern.slice(1);
    }

    const directoryOnly = pattern.endsWith("/");
    if (directoryOnly) {
      pattern = pattern.slice(0, -1);
    }
    if (pattern.length === 0) {
      continue;
    }

    rules.push({
      raw: line,
      pattern,
      line: lineNumber,
      negated,
      // In the root .ezhostignore, a slash-bearing pattern is relative to the
      // root, as in gitignore. A leading slash makes that intent explicit.
      anchored: anchored || pattern.includes("/"),
      directoryOnly,
      segments: pattern.split("/"),
    });
  }

  return rules;
}

function matchesRule(pathSegments: readonly string[], rule: ParsedIgnoreRule): boolean {
  if (rule.directoryOnly) {
    // A trailing slash matches the named directory and anything below it. The
    // path API has no file-vs-directory bit, so matching the exact directory
    // path is the useful lexical interpretation for a canonical path.
    if (!rule.anchored && rule.segments.length === 1 && rule.segments[0] !== "**") {
      return pathSegments.some((pathSegment) =>
        matchesSegment(rule.segments[0] ?? "", pathSegment),
      );
    }

    for (let prefixLength = 0; prefixLength <= pathSegments.length; prefixLength += 1) {
      if (matchesSegments(pathSegments.slice(0, prefixLength), rule.segments)) {
        return true;
      }
    }
    return false;
  }

  if (!rule.anchored && rule.segments.length === 1 && rule.segments[0] !== "**") {
    return matchesSegment(rule.segments[0] ?? "", pathSegments[pathSegments.length - 1] ?? "");
  }

  return matchesSegments(pathSegments, rule.segments);
}

/**
 * Evaluate whether a canonical relative path can be published.
 *
 * The matcher deliberately implements only the documented V1 subset:
 * comments and blank lines, `*` within one segment, `**` between segments,
 * `?`, a trailing slash for directory matches, a leading slash for a root
 * anchor, and leading-`!` negation. Escapes, character classes, brace
 * expansion, alternation, and every other gitignore extension are literal
 * text. Symlinks are a client-side filesystem concern and are not represented
 * by this pure path evaluator.
 */
export function evaluatePublishEligibility(
  path: CanonicalPath,
  ignoreFile = "",
): PublishEligibilityResult {
  const hardPattern = findHardIgnore(path);
  if (hardPattern !== undefined) {
    return result(false, "hard_ignore", hardPattern);
  }

  const dotSegment = hasDotPrefixedSegment(path);
  if (dotSegment !== undefined && !isDotPrefixAllowlisted(path)) {
    return result(false, "dot_prefix", dotSegment);
  }

  const pathSegments = path.split("/");
  let lastMatch: ParsedIgnoreRule | undefined;
  for (const rule of parseIgnoreRules(ignoreFile)) {
    if (matchesRule(pathSegments, rule)) {
      lastMatch = rule;
    }
  }

  if (lastMatch !== undefined) {
    return result(lastMatch.negated, "ezhostignore", lastMatch.raw, lastMatch.line);
  }

  return result(true, "default_allow");
}

/** Convenience boolean form for callers scanning many paths. */
export function isPublishEligible(path: CanonicalPath, ignoreFile = ""): boolean {
  return evaluatePublishEligibility(path, ignoreFile).eligible;
}
