import { parseLabel } from "@zudo-ez-host/core";

export interface ProjectLabelResolution {
  readonly projectId: string;
  readonly userId: string;
  readonly label: string;
  readonly generation: number;
  readonly publicationId: string;
}

interface ProjectLabelResolutionRow {
  readonly projectId: string;
  readonly userId: string;
  readonly label: string;
  readonly generation: number;
  readonly publicationId: string;
}

/**
 * Resolve a public host label to a currently published project.
 *
 * `parseLabel` performs the only canonicalization allowed at this boundary.
 * The SQL query then matches the canonical label and both canonical components
 * exactly, and joins the current head to an immutable publication. Takedowns,
 * generation-zero heads, and missing publications consequently resolve to null.
 */
export async function resolveProjectByLabel(
  database: D1Database,
  labelInput: unknown,
): Promise<ProjectLabelResolution | null> {
  const parsed = parseLabel(labelInput);
  if (!parsed.ok) {
    return null;
  }
  const canonicalLabel = `${parsed.value.slug}--${parsed.value.handle}`;

  const row = await database
    .prepare(
      `SELECT h.project_id AS projectId,
              h.user_id AS userId,
              h.label AS label,
              ph.generation AS generation,
              ph.publication_id AS publicationId
       FROM hostname_allocations AS h
       INNER JOIN projects AS p
         ON p.id = h.project_id AND p.user_id = h.user_id
       INNER JOIN user AS u
         ON u.id = h.user_id
       INNER JOIN project_heads AS ph
         ON ph.project_id = p.id
       INNER JOIN publications AS pub
         ON pub.id = ph.publication_id
        AND pub.project_id = p.id
        AND pub.generation = ph.generation
       WHERE h.label = ?
         AND p.slug = ?
         AND u.canonical_handle = ?
         AND p.status = 'active'
         AND ph.generation > 0`,
    )
    .bind(canonicalLabel, parsed.value.slug, parsed.value.handle)
    .first<ProjectLabelResolutionRow>();

  return row;
}

// Descriptive aliases keep the query easy to discover at integration seams.
export const resolveProjectByHostname = resolveProjectByLabel;
export const resolveProjectLabel = resolveProjectByLabel;
