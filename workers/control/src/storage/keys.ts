/**
 * The project-scoped R2 key layout used by both the control and public
 * storage planes.
 *
 * Keep the identifiers as individual path segments. Apart from making the
 * layout easy to inspect, this prevents a caller from accidentally escaping a
 * project prefix with a leading slash or a `..` segment.
 */

function assertKeySegment(name: string, value: string): void {
  if (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw new TypeError(`${name} must be one non-empty R2 key segment`);
  }
}

function projectKey(projectId: string, category: string, identifier: string): string {
  assertKeySegment("projectId", projectId);
  assertKeySegment("identifier", identifier);
  return `projects/${projectId}/${category}/${identifier}`;
}

/** Immutable, project-scoped content-addressed bytes. */
export function contentKey(projectId: string, sha256: string): string {
  return projectKey(projectId, "content", sha256);
}

/** Canonical manifest bytes held by an in-flight publication attempt. */
export function stagedManifestKey(projectId: string, attemptId: string): string {
  return projectKey(projectId, "staged", attemptId);
}

/** Canonical manifest bytes after successful artifact promotion. */
export function artifactManifestKey(projectId: string, artifactHash: string): string {
  return projectKey(projectId, "artifacts", artifactHash);
}

/** Descriptive alias for callers that want to emphasize immutability. */
export const immutableContentKey = contentKey;

/** Descriptive alias for the promoted-manifest key. */
export const promotedArtifactManifestKey = artifactManifestKey;
