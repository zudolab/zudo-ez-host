import { and, eq, sql } from "drizzle-orm";

import type { ControlDatabase } from "./database.js";
import { executeGuardedBatch } from "./guarded-batch.js";
import {
  hostnameAllocations,
  machines,
  projectHeads,
  projects,
  publicationAttempts,
  publications,
  users,
  verifiedObjects,
} from "./schema.js";

export async function getUserById(database: ControlDatabase, userId: string) {
  const query = database
    .select()
    .from(users)
    .where(eq(users.id, sql.placeholder("userId")))
    .prepare();
  return query.get({ userId });
}

export async function getMachineByCredentialHash(
  database: ControlDatabase,
  credentialHashSha256: string,
) {
  const query = database
    .select()
    .from(machines)
    .where(eq(machines.credentialHashSha256, sql.placeholder("credentialHashSha256")))
    .prepare();
  return query.get({ credentialHashSha256 });
}

/**
 * The owner-scoped project fields that may cross the control-plane projects
 * read boundary. Keep this projection explicit: the database row also has an
 * internal user ID which must never be returned by a project visibility API.
 */
export interface OwnedProjectProjection {
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

export async function getOwnedProject(
  database: ControlDatabase,
  userId: string,
  projectId: string,
): Promise<OwnedProjectProjection | undefined> {
  const query = database
    .select({
      id: projects.id,
      slug: projects.slug,
      displayName: projects.displayName,
      description: projects.description,
      status: projects.status,
      createdAt: projects.createdAt,
      updatedAt: projects.updatedAt,
      hostname: hostnameAllocations.label,
      generation: projectHeads.generation,
      machineNameSnapshot: publications.machineNameSnapshot,
      publishedAt: publications.publishedAt,
    })
    .from(projects)
    .leftJoin(
      hostnameAllocations,
      and(
        eq(hostnameAllocations.projectId, projects.id),
        eq(hostnameAllocations.userId, projects.userId),
      ),
    )
    .leftJoin(projectHeads, eq(projectHeads.projectId, projects.id))
    .leftJoin(
      publications,
      and(
        eq(publications.id, projectHeads.publicationId),
        eq(publications.projectId, projects.id),
        eq(publications.generation, projectHeads.generation),
      ),
    )
    .where(
      and(
        eq(projects.id, sql.placeholder("projectId")),
        eq(projects.userId, sql.placeholder("userId")),
      ),
    )
    .prepare();
  return query.get({ projectId, userId });
}

export async function getProjectHead(database: ControlDatabase, projectId: string) {
  const query = database
    .select()
    .from(projectHeads)
    .where(eq(projectHeads.projectId, sql.placeholder("projectId")))
    .prepare();
  return query.get({ projectId });
}

export async function getAttemptForOwner(
  database: ControlDatabase,
  userId: string,
  attemptId: string,
) {
  const query = database
    .select()
    .from(publicationAttempts)
    .where(
      and(
        eq(publicationAttempts.id, sql.placeholder("attemptId")),
        eq(publicationAttempts.userId, sql.placeholder("userId")),
      ),
    )
    .prepare();
  return query.get({ attemptId, userId });
}

export async function getPublicationByAttemptId(database: ControlDatabase, attemptId: string) {
  const query = database
    .select()
    .from(publications)
    .where(eq(publications.attemptId, sql.placeholder("attemptId")))
    .prepare();
  return query.get({ attemptId });
}

export async function getVerifiedObject(
  database: ControlDatabase,
  projectId: string,
  contentHash: string,
) {
  const query = database
    .select()
    .from(verifiedObjects)
    .where(
      and(
        eq(verifiedObjects.projectId, sql.placeholder("projectId")),
        eq(verifiedObjects.contentHash, sql.placeholder("contentHash")),
      ),
    )
    .prepare();
  return query.get({ contentHash, projectId });
}

/** Allocate `<stored project slug>--<stored owner handle>` without request-owned identity data. */
export async function allocatePermanentHostname(
  binding: D1Database,
  projectId: string,
  createdAt: number,
) {
  const insert = binding
    .prepare(
      `INSERT INTO hostname_allocations (label, user_id, project_id, created_at)
       SELECT projects.slug || '--' || user.canonical_handle, user.id, projects.id, ?
       FROM projects
       INNER JOIN user ON user.id = projects.user_id
       WHERE projects.id = ?
         AND NOT EXISTS (
           SELECT 1 FROM hostname_allocations WHERE project_id = projects.id
         )`,
    )
    .bind(createdAt, projectId);

  await executeGuardedBatch(binding, [
    { name: "allocate permanent hostname", statement: insert, expectedChanges: 1 },
  ]);

  const allocation = await binding
    .prepare(
      "SELECT label, user_id AS userId, project_id AS projectId, created_at AS createdAt FROM hostname_allocations WHERE project_id = ?",
    )
    .bind(projectId)
    .first<{ label: string; userId: string; projectId: string; createdAt: number }>();
  if (allocation === null) {
    throw new Error("Permanent hostname allocation disappeared after guarded insert");
  }
  return allocation;
}

export async function getHostnameAllocation(database: ControlDatabase, projectId: string) {
  const query = database
    .select()
    .from(hostnameAllocations)
    .where(eq(hostnameAllocations.projectId, sql.placeholder("projectId")))
    .prepare();
  return query.get({ projectId });
}
