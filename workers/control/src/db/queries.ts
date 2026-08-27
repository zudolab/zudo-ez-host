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

export async function getOwnedProject(
  database: ControlDatabase,
  userId: string,
  projectId: string,
) {
  const query = database
    .select()
    .from(projects)
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

  return binding
    .prepare(
      "SELECT label, user_id AS userId, project_id AS projectId, created_at AS createdAt FROM hostname_allocations WHERE project_id = ?",
    )
    .bind(projectId)
    .first<{ label: string; userId: string; projectId: string; createdAt: number }>();
}

export async function getHostnameAllocation(database: ControlDatabase, projectId: string) {
  const query = database
    .select()
    .from(hostnameAllocations)
    .where(eq(hostnameAllocations.projectId, sql.placeholder("projectId")))
    .prepare();
  return query.get({ projectId });
}
