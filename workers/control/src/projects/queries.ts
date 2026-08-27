export interface OwnedProjectVisibility {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly status: "active" | "taken_down";
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly hostname: string | null;
  readonly generation: number;
  readonly machineNameSnapshot: string | null;
  readonly publishedAt: number | null;
}

interface OwnedProjectVisibilityRow {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly status: "active" | "taken_down";
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly hostname: string | null;
  readonly generation: number | null;
  readonly machineNameSnapshot: string | null;
  readonly publishedAt: number | null;
}

/**
 * List only the projects owned by one authenticated opaque user ID.
 *
 * The publication join follows `project_heads.publication_id`, so historical
 * publications cannot be mistaken for the current public head. Left joins
 * preserve generation-zero projects, whose publication fields are null.
 */
export async function listOwnedProjects(
  database: D1Database,
  userId: string,
): Promise<readonly OwnedProjectVisibility[]> {
  const result = await database
    .prepare(
      `SELECT p.id, p.slug, p.display_name AS displayName,
              p.description, p.status,
              p.created_at AS createdAt, p.updated_at AS updatedAt,
              h.label AS hostname,
              ph.generation AS generation,
              pub.machine_name_snapshot AS machineNameSnapshot,
              pub.published_at AS publishedAt
       FROM projects AS p
       LEFT JOIN hostname_allocations AS h
         ON h.project_id = p.id AND h.user_id = p.user_id
       LEFT JOIN project_heads AS ph
         ON ph.project_id = p.id
       LEFT JOIN publications AS pub
         ON pub.id = ph.publication_id
        AND pub.project_id = p.id
        AND pub.generation = ph.generation
       WHERE p.user_id = ?
       ORDER BY p.created_at ASC, p.id ASC`,
    )
    .bind(userId)
    .all<OwnedProjectVisibilityRow>();

  return result.results.map((row) => ({
    id: row.id,
    slug: row.slug,
    displayName: row.displayName,
    description: row.description,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    hostname: row.hostname,
    generation: row.generation ?? 0,
    machineNameSnapshot: row.machineNameSnapshot,
    publishedAt: row.publishedAt,
  }));
}

/** Descriptive alias for callers that prefer the project noun first. */
export const getOwnedProjects = listOwnedProjects;
