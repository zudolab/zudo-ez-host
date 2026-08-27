import {
  composeLabel,
  validateHandle,
  validateSlug,
  type HostnameValidationReason,
} from "@zudo-ez-host/core";

import { GuardedBatchError, executeGuardedBatch } from "../db/guarded-batch.js";
import type { HostnameAllocation, Project, ProjectHead } from "../db/schema.js";

/**
 * The smallest owner context that project operations need from auth.
 *
 * Authentication may attach additional machine information, but project
 * registration deliberately consumes only this opaque user ID. In
 * particular, a request cannot supply or override a canonical handle.
 */
export interface ProjectOwnerContext {
  readonly userId: string;
}

export interface ProjectRegistrationInput {
  readonly slug: unknown;
  readonly displayName?: unknown;
  readonly description?: unknown;
}

export interface ProjectRegistrationOptions {
  /** Injectable clock for deterministic tests; production defaults to Date.now. */
  readonly now?: number;
  /** Injectable ID source for deterministic tests; production uses Web Crypto. */
  readonly projectIdFactory?: () => string;
}

export type ProjectRegistrationErrorCode =
  | "invalid_owner_context"
  | "owner_not_found"
  | "invalid_slug"
  | "invalid_owner_handle"
  | "invalid_display_name"
  | "invalid_description"
  | "registration_invariant";

export class ProjectRegistrationError extends Error {
  readonly code: ProjectRegistrationErrorCode;
  readonly reason?: HostnameValidationReason;

  constructor(
    code: ProjectRegistrationErrorCode,
    message: string,
    reason?: HostnameValidationReason,
  ) {
    super(message);
    this.name = "ProjectRegistrationError";
    this.code = code;
    this.reason = reason;
  }
}

export interface ProjectRegistrationResult {
  readonly project: Project;
  readonly hostname: HostnameAllocation;
  readonly head: ProjectHead;
  /** True only for the request that won the initial project allocation. */
  readonly created: boolean;
}

interface UserRow {
  readonly id: string;
  readonly canonicalHandle: string;
}

function registrationInvariant(message: string): ProjectRegistrationError {
  return new ProjectRegistrationError("registration_invariant", message);
}

function requireOwnerId(owner: ProjectOwnerContext | null | undefined): string {
  if (owner === null || owner === undefined) {
    throw new ProjectRegistrationError(
      "invalid_owner_context",
      "An authenticated owner context with a user ID is required",
    );
  }
  if (typeof owner.userId !== "string" || owner.userId.length === 0) {
    throw new ProjectRegistrationError(
      "invalid_owner_context",
      "An authenticated owner context with a user ID is required",
    );
  }
  return owner.userId;
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    /\b(unique|constraint)\b/i.test(error.message) &&
    !error.message.startsWith("D1 guarded batch")
  );
}

function requireNow(now: number | undefined): number {
  const value = now ?? Date.now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Project registration time must be a non-negative safe integer");
  }
  return value;
}

function requireProjectId(projectIdFactory: (() => string) | undefined): string {
  const projectId = projectIdFactory?.() ?? globalThis.crypto.randomUUID();
  if (typeof projectId !== "string" || projectId.length === 0) {
    throw new TypeError("Project ID factory must return a non-empty string");
  }
  return projectId;
}

function parseProjectFields(input: ProjectRegistrationInput): {
  slug: string;
  displayName: string;
  description: string | null;
} {
  const slug = validateSlug(input.slug);
  if (!slug.ok) {
    throw new ProjectRegistrationError("invalid_slug", "Project slug is not valid", slug.reason);
  }

  // Display names are metadata, not hostname identity. Omitting one keeps the
  // machine registration contract small while still satisfying the required
  // database column with the canonical slug.
  const displayName = input.displayName === undefined ? slug.value : input.displayName;
  if (
    typeof displayName !== "string" ||
    displayName.length === 0 ||
    Array.from(displayName).length > 100
  ) {
    throw new ProjectRegistrationError(
      "invalid_display_name",
      "Project display name must contain between 1 and 100 characters",
    );
  }

  const description = input.description ?? null;
  if (description !== null && typeof description !== "string") {
    throw new ProjectRegistrationError(
      "invalid_description",
      "Project description must be a string or null",
    );
  }

  return { slug: slug.value, displayName, description };
}

async function findUser(database: D1Database, userId: string): Promise<UserRow | null> {
  return database
    .prepare("SELECT id, canonical_handle AS canonicalHandle FROM user WHERE id = ?")
    .bind(userId)
    .first<UserRow>();
}

async function findProjectByOwnerAndSlug(
  database: D1Database,
  userId: string,
  slug: string,
): Promise<Project | null> {
  return database
    .prepare(
      `SELECT id, user_id AS userId, slug, display_name AS displayName,
              description, status, created_at AS createdAt, updated_at AS updatedAt
       FROM projects
       WHERE user_id = ? AND slug = ?`,
    )
    .bind(userId, slug)
    .first<Project>();
}

async function readRegistrationResult(
  database: D1Database,
  project: Project,
  created: boolean,
): Promise<ProjectRegistrationResult> {
  const [hostname, head] = await Promise.all([
    database
      .prepare(
        `SELECT label, user_id AS userId, project_id AS projectId, created_at AS createdAt
         FROM hostname_allocations
         WHERE project_id = ?`,
      )
      .bind(project.id)
      .first<HostnameAllocation>(),
    database
      .prepare(
        `SELECT project_id AS projectId, generation, publication_id AS publicationId,
                updated_at AS updatedAt
         FROM project_heads
         WHERE project_id = ?`,
      )
      .bind(project.id)
      .first<ProjectHead>(),
  ]);

  if (hostname === null || head === null) {
    throw registrationInvariant(
      "A registered project must have one permanent hostname and one project head",
    );
  }
  if (hostname.userId !== project.userId || hostname.projectId !== project.id) {
    throw registrationInvariant("Project hostname ownership does not match its project");
  }

  return { project, hostname, head, created };
}

/**
 * Register a project for the authenticated owner and allocate its permanent
 * public label. The project, label, and empty generation-0 head are created
 * by one guarded D1 batch. No allocation read is used to decide whether a
 * label is available; the primary-key/unique constraints are the arbiter.
 */
export async function registerProject(
  database: D1Database,
  owner: ProjectOwnerContext,
  input: ProjectRegistrationInput,
  options: ProjectRegistrationOptions = {},
): Promise<ProjectRegistrationResult> {
  const userId = requireOwnerId(owner);
  const fields = parseProjectFields(input);
  const now = requireNow(options.now);
  const user = await findUser(database, userId);

  if (user === null) {
    throw new ProjectRegistrationError("owner_not_found", "Authenticated owner was not found");
  }

  // The canonical handle is loaded from the owner row. Any extra handle-like
  // field on the request or context is intentionally ignored.
  const handle = validateHandle(user.canonicalHandle);
  if (!handle.ok) {
    throw new ProjectRegistrationError(
      "invalid_owner_handle",
      "Authenticated owner has an invalid canonical handle",
      handle.reason,
    );
  }
  const label = composeLabel(fields.slug, handle.value);
  if (!label.ok) {
    throw new ProjectRegistrationError(
      "invalid_slug",
      "Project slug and owner handle cannot form a public label",
      label.reason,
    );
  }

  // This read is only for idempotent replay. It does not inspect hostname
  // allocation state or decide whether the label is available.
  const existing = await findProjectByOwnerAndSlug(database, user.id, fields.slug);
  if (existing !== null) {
    return readRegistrationResult(database, existing, false);
  }

  const projectId = requireProjectId(options.projectIdFactory);
  const projectInsert = database
    .prepare(
      `INSERT INTO projects
         (id, user_id, slug, display_name, description, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
    )
    .bind(projectId, user.id, fields.slug, fields.displayName, fields.description, now, now);
  const hostnameInsert = database
    .prepare(
      `INSERT INTO hostname_allocations (label, user_id, project_id, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(label.value, user.id, projectId, now);
  const headInsert = database
    .prepare(
      `INSERT INTO project_heads (project_id, generation, publication_id, updated_at)
       VALUES (?, 0, NULL, ?)`,
    )
    .bind(projectId, now);

  try {
    // Keep these unconditional inserts. A unique conflict is a SQL error and
    // therefore rolls the whole D1 batch back, including the project row.
    await executeGuardedBatch(database, [
      { name: "create project", statement: projectInsert, expectedChanges: 1 },
      { name: "allocate permanent hostname", statement: hostnameInsert, expectedChanges: 1 },
      { name: "create empty project head", statement: headInsert, expectedChanges: 1 },
    ]);
  } catch (cause) {
    // If another request won the same owner+slug race, return that committed
    // project. A different SQL failure is preserved and never treated as an
    // ownership or hostname match.
    if (cause instanceof GuardedBatchError || !isUniqueConstraintViolation(cause)) {
      throw cause;
    }
    const winner = await findProjectByOwnerAndSlug(database, user.id, fields.slug);
    if (winner !== null) {
      return readRegistrationResult(database, winner, false);
    }
    throw cause;
  }

  const created = await findProjectByOwnerAndSlug(database, user.id, fields.slug);
  if (created === null || created.id !== projectId) {
    throw registrationInvariant("Project disappeared after guarded registration batch");
  }
  const result = await readRegistrationResult(database, created, true);
  if (result.head.generation !== 0 || result.head.publicationId !== null) {
    throw registrationInvariant("A newly registered project must start at empty generation zero");
  }
  return result;
}

/** Find a project by owner and canonical slug without using a hostname as authority. */
export async function getOwnedProjectBySlug(
  database: D1Database,
  owner: ProjectOwnerContext,
  slugInput: unknown,
): Promise<Project | null> {
  const userId = requireOwnerId(owner);
  const slug = validateSlug(slugInput);
  if (!slug.ok) {
    return null;
  }
  return findProjectByOwnerAndSlug(database, userId, slug.value);
}
