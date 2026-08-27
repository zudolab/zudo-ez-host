import {
  MAX_ACTIVE_PUBLISHED_BYTES_PER_ACCOUNT,
  MAX_CANONICAL_MANIFEST_BYTES,
  decodeManifest,
  encodeCanonical,
  type ManifestValidationReason,
} from "@zudo-ez-host/core";

import { GuardedBatchError, executeGuardedBatch } from "../../db/guarded-batch.js";
import { artifactManifestKey } from "../../storage/index.js";

export type CommitPublicationErrorReason =
  | "invalid_owner_context"
  | "invalid_request"
  | "attempt_not_found"
  | "attempt_expired"
  | "attempt_closed"
  | "publication_incomplete"
  | "staged_manifest_missing"
  | "staged_manifest_too_large"
  | "staged_manifest_hash_mismatch"
  | "staged_manifest_invalid"
  | ManifestValidationReason
  | "publication_head_changed"
  | "commit_invariant";

const STATUS_BY_REASON: Partial<Record<CommitPublicationErrorReason, number>> = {
  invalid_owner_context: 401,
  invalid_request: 400,
  attempt_not_found: 404,
  attempt_expired: 409,
  attempt_closed: 409,
  publication_incomplete: 422,
  staged_manifest_missing: 422,
  staged_manifest_too_large: 422,
  staged_manifest_hash_mismatch: 422,
  staged_manifest_invalid: 422,
  publication_head_changed: 409,
  commit_invariant: 500,
};

export interface PublicationHeadChangedDetails {
  readonly generation: number;
  readonly machineName: string | null;
}

export class CommitPublicationError extends Error {
  readonly reason: CommitPublicationErrorReason;
  readonly status: number;
  readonly head?: PublicationHeadChangedDetails;

  constructor(
    reason: CommitPublicationErrorReason,
    message: string,
    options: { readonly status?: number; readonly head?: PublicationHeadChangedDetails } = {},
  ) {
    super(message);
    this.name = "CommitPublicationError";
    this.reason = reason;
    this.status = options.status ?? STATUS_BY_REASON[reason] ?? 400;
    if (options.head !== undefined) {
      this.head = options.head;
    }
  }
}

export interface CommitPublicationInput {
  readonly database: D1Database;
  readonly bucket: R2Bucket;
  readonly ownerId: string | { readonly userId: string };
  readonly projectId: string;
  readonly attemptId: string;
  readonly now?: number;
  readonly publicationId?: string;
}

export interface CommittedPublication {
  readonly id: string;
  readonly attemptId: string;
  readonly projectId: string;
  readonly generation: number;
  readonly artifactHash: string;
  readonly machineId: string;
  readonly machineName: string;
  readonly logicalBytes: number;
  readonly physicalBytes: number;
  readonly fileCount: number;
  readonly objectCount: number;
  readonly publishedAt: number;
}

export interface CommitPublicationResult {
  readonly publication: CommittedPublication;
  readonly committed: boolean;
}

interface AttemptSnapshot {
  readonly id: string;
  readonly projectId: string;
  readonly userId: string;
  readonly machineId: string;
  readonly state: string;
  readonly baseGeneration: number;
  readonly baseLogicalBytes: number;
  readonly stagedManifestR2Key: string;
  readonly manifestHash: string;
  readonly logicalBytes: number;
  readonly fileCount: number;
  readonly reservedActiveDeltaBytes: number;
  readonly reservedPhysicalUploadBytes: number;
  readonly expiresAt: number;
}

interface InventorySummary {
  readonly objectCount: number;
  readonly physicalBytes: number;
  readonly incompleteCount: number;
}

interface PublicationRow {
  readonly id: string;
  readonly attemptId: string;
  readonly projectId: string;
  readonly generation: number;
  readonly artifactHash: string;
  readonly machineId: string;
  readonly machineName: string;
  readonly logicalBytes: number;
  readonly physicalBytes: number;
  readonly fileCount: number;
  readonly objectCount: number;
  readonly publishedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireIdentifier(name: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new CommitPublicationError("invalid_request", `${name} must be a non-empty string`);
  }
  return value;
}

function requireOwnerId(value: unknown): string {
  if (typeof value === "string") {
    return requireIdentifier("ownerId", value);
  }
  if (isRecord(value)) {
    return requireOwnerId(value.userId);
  }
  throw new CommitPublicationError(
    "invalid_owner_context",
    "An authenticated owner context is required",
  );
}

function requireNow(value: number | undefined): number {
  const now = value ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new CommitPublicationError("invalid_request", "now must be a non-negative integer");
  }
  return now;
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer));
}

function asPublication(row: PublicationRow): CommittedPublication {
  return row;
}

async function publicationForAttempt(
  database: D1Database,
  ownerId: string,
  projectId: string,
  attemptId: string,
): Promise<CommittedPublication | null> {
  const row = await database
    .prepare(
      `SELECT pub.id, pub.attempt_id AS attemptId, pub.project_id AS projectId,
              pub.generation, pub.artifact_hash AS artifactHash,
              pub.machine_id AS machineId, pub.machine_name_snapshot AS machineName,
              pub.logical_bytes AS logicalBytes, pub.physical_bytes AS physicalBytes,
              pub.file_count AS fileCount, pub.object_count AS objectCount,
              pub.published_at AS publishedAt
       FROM publications AS pub
       INNER JOIN projects AS p ON p.id = pub.project_id AND p.user_id = ?
       WHERE pub.attempt_id = ? AND pub.project_id = ?`,
    )
    .bind(ownerId, attemptId, projectId)
    .first<PublicationRow>();
  return row === null ? null : asPublication(row);
}

async function attemptSnapshot(
  database: D1Database,
  ownerId: string,
  projectId: string,
  attemptId: string,
): Promise<AttemptSnapshot> {
  const row = await database
    .prepare(
      `SELECT pa.id, pa.project_id AS projectId, pa.user_id AS userId,
              pa.machine_id AS machineId, pa.state,
              pa.base_generation AS baseGeneration,
              pa.base_logical_bytes AS baseLogicalBytes,
              pa.staged_manifest_r2_key AS stagedManifestR2Key,
              pa.manifest_hash AS manifestHash,
              pa.logical_bytes AS logicalBytes, pa.file_count AS fileCount,
              pa.reserved_active_delta_bytes AS reservedActiveDeltaBytes,
              pa.reserved_physical_upload_bytes AS reservedPhysicalUploadBytes,
              pa.expires_at AS expiresAt
       FROM publication_attempts AS pa
       INNER JOIN projects AS p
         ON p.id = pa.project_id AND p.user_id = pa.user_id
       WHERE pa.id = ? AND pa.project_id = ? AND pa.user_id = ?`,
    )
    .bind(attemptId, projectId, ownerId)
    .first<AttemptSnapshot>();
  if (row === null) {
    throw new CommitPublicationError(
      "attempt_not_found",
      "The publication attempt was not found for this owner",
      { status: 404 },
    );
  }
  return row;
}

async function inventorySummary(
  database: D1Database,
  projectId: string,
  attemptId: string,
): Promise<InventorySummary> {
  const row = await database
    .prepare(
      `SELECT COUNT(*) AS objectCount,
              COALESCE(SUM(pao.size_bytes), 0) AS physicalBytes,
              COALESCE(SUM(CASE
                WHEN pao.verified = 0 OR vo.content_hash IS NULL OR vo.size_bytes <> pao.size_bytes
                THEN 1 ELSE 0 END), 0) AS incompleteCount
       FROM publication_attempt_objects AS pao
       LEFT JOIN verified_objects AS vo
         ON vo.project_id = ? AND vo.content_hash = pao.content_hash
       WHERE pao.attempt_id = ?`,
    )
    .bind(projectId, attemptId)
    .first<InventorySummary>();
  if (row === null) {
    throw new CommitPublicationError("commit_invariant", "Inventory summary was unavailable");
  }
  return row;
}

async function currentHeadDetails(
  database: D1Database,
  projectId: string,
): Promise<PublicationHeadChangedDetails> {
  const row = await database
    .prepare(
      `SELECT ph.generation,
              pub.machine_name_snapshot AS machineName
       FROM project_heads AS ph
       LEFT JOIN publications AS pub
         ON pub.id = ph.publication_id AND pub.project_id = ph.project_id
       WHERE ph.project_id = ?`,
    )
    .bind(projectId)
    .first<PublicationHeadChangedDetails>();
  if (row === null) {
    throw new CommitPublicationError("commit_invariant", "The project head is missing");
  }
  return row;
}

async function throwHeadChanged(database: D1Database, projectId: string): Promise<never> {
  const head = await currentHeadDetails(database, projectId);
  throw new CommitPublicationError(
    "publication_head_changed",
    "The project head changed after this publication attempt was prepared",
    { head },
  );
}

/**
 * Promote one fully verified attempt with a D1 compare-and-swap.
 *
 * Uploads never hold a lease. The promoted R2 manifest is content-addressed
 * and written immediately before the guarded D1 batch. A lost CAS can leave
 * only those immutable bytes behind; deletion is deliberately deferred to GC.
 */
export async function commitPublication(
  input: CommitPublicationInput,
): Promise<CommitPublicationResult> {
  const ownerId = requireOwnerId(input.ownerId);
  const projectId = requireIdentifier("projectId", input.projectId);
  const attemptId = requireIdentifier("attemptId", input.attemptId);
  const now = requireNow(input.now);

  const priorPublication = await publicationForAttempt(
    input.database,
    ownerId,
    projectId,
    attemptId,
  );
  if (priorPublication !== null) {
    return { publication: priorPublication, committed: false };
  }

  const attempt = await attemptSnapshot(input.database, ownerId, projectId, attemptId);
  if (attempt.state !== "open") {
    throw new CommitPublicationError("attempt_closed", "The publication attempt is closed");
  }
  if (attempt.expiresAt <= now) {
    throw new CommitPublicationError("attempt_expired", "The publication attempt has expired");
  }

  const headBeforePromotion = await currentHeadDetails(input.database, projectId);
  if (headBeforePromotion.generation !== attempt.baseGeneration) {
    await throwHeadChanged(input.database, projectId);
  }

  const inventory = await inventorySummary(input.database, projectId, attemptId);
  if (inventory.incompleteCount !== 0) {
    throw new CommitPublicationError(
      "publication_incomplete",
      "Every distinct attempt object must be verified in the D1 inventory",
    );
  }

  const staged = await input.bucket.get(attempt.stagedManifestR2Key);
  if (staged === null) {
    throw new CommitPublicationError("staged_manifest_missing", "The staged manifest is missing");
  }
  if (staged.size > MAX_CANONICAL_MANIFEST_BYTES) {
    throw new CommitPublicationError(
      "staged_manifest_too_large",
      "The staged manifest exceeds the canonical manifest limit",
    );
  }
  const stagedBytes = new Uint8Array(await staged.arrayBuffer());
  const stagedHash = await sha256(stagedBytes);
  if (stagedHash !== attempt.manifestHash) {
    throw new CommitPublicationError(
      "staged_manifest_hash_mismatch",
      "The staged manifest no longer matches the attempt hash",
    );
  }
  const decoded = decodeManifest(stagedBytes);
  if (!decoded.ok) {
    throw new CommitPublicationError(
      decoded.reason,
      `Staged manifest rejected: ${decoded.reason}`,
      {
        status: 422,
      },
    );
  }
  const canonicalBytes = encodeCanonical(decoded.value);
  const artifactHash = await sha256(canonicalBytes);
  if (artifactHash !== stagedHash) {
    throw new CommitPublicationError(
      "staged_manifest_invalid",
      "The staged manifest is not the canonical artifact encoding",
    );
  }
  if (
    decoded.value.entries.length !== attempt.fileCount ||
    decoded.value.entries.reduce((total, entry) => total + entry.size, 0) !== attempt.logicalBytes
  ) {
    throw new CommitPublicationError(
      "commit_invariant",
      "Attempt counts do not match the canonical manifest",
    );
  }

  const promotedKey = artifactManifestKey(projectId, artifactHash);
  const promoted = await input.bucket.put(promotedKey, canonicalBytes, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { sha256: artifactHash },
  });
  if (promoted === null) {
    throw new CommitPublicationError("commit_invariant", "R2 did not promote the manifest");
  }

  const publicationId = requireIdentifier(
    "publicationId",
    input.publicationId ?? crypto.randomUUID(),
  );
  const generation = attempt.baseGeneration + 1;

  try {
    await executeGuardedBatch(input.database, [
      {
        name: "insert immutable publication",
        expectedChanges: 1,
        statement: input.database
          .prepare(
            `INSERT INTO publications
               (id, project_id, attempt_id, generation, artifact_hash,
                machine_id, machine_name_snapshot, logical_bytes, physical_bytes,
                file_count, object_count, published_at)
             SELECT ?, pa.project_id, pa.id, ?, ?, pa.machine_id, m.name,
                    pa.logical_bytes, ?, pa.file_count, ?, ?
             FROM publication_attempts AS pa
             INNER JOIN machines AS m
               ON m.id = pa.machine_id AND m.user_id = pa.user_id
             INNER JOIN project_heads AS ph ON ph.project_id = pa.project_id
             INNER JOIN user AS u ON u.id = pa.user_id
             LEFT JOIN publications AS old_pub
               ON old_pub.id = ph.publication_id AND old_pub.project_id = ph.project_id
             WHERE pa.id = ? AND pa.project_id = ? AND pa.user_id = ?
               AND pa.state = 'open' AND pa.expires_at > ?
               AND pa.base_generation = ? AND ph.generation = pa.base_generation
               AND COALESCE(old_pub.logical_bytes, 0) = pa.base_logical_bytes
               AND u.reserved_active_delta_bytes >= pa.reserved_active_delta_bytes
               AND u.reserved_physical_upload_bytes >= pa.reserved_physical_upload_bytes
               AND u.active_logical_bytes + pa.logical_bytes - pa.base_logical_bytes >= 0
               AND u.active_logical_bytes + pa.logical_bytes - pa.base_logical_bytes <= ?
               AND NOT EXISTS (
                 SELECT 1
                 FROM publication_attempt_objects AS pao
                 LEFT JOIN verified_objects AS vo
                   ON vo.project_id = pa.project_id
                  AND vo.content_hash = pao.content_hash
                  AND vo.size_bytes = pao.size_bytes
                 WHERE pao.attempt_id = pa.id
                   AND (pao.verified = 0 OR vo.content_hash IS NULL)
               )`,
          )
          .bind(
            publicationId,
            generation,
            artifactHash,
            inventory.physicalBytes,
            inventory.objectCount,
            now,
            attemptId,
            projectId,
            ownerId,
            now,
            attempt.baseGeneration,
            MAX_ACTIVE_PUBLISHED_BYTES_PER_ACCOUNT,
          ),
      },
      {
        name: "insert immutable publication objects",
        expectedChanges: inventory.objectCount,
        statement: input.database
          .prepare(
            `INSERT INTO publication_objects (publication_id, content_hash, size_bytes)
             SELECT ?, pao.content_hash, pao.size_bytes
             FROM publication_attempt_objects AS pao
             WHERE pao.attempt_id = ?
               AND EXISTS (
                 SELECT 1 FROM publications
                 WHERE id = ? AND attempt_id = ? AND project_id = ?
               )
               AND EXISTS (
                 SELECT 1
                 FROM publication_attempts AS pa
                 INNER JOIN project_heads AS ph ON ph.project_id = pa.project_id
                 WHERE pa.id = ? AND pa.project_id = ? AND pa.user_id = ?
                   AND pa.state = 'open' AND pa.expires_at > ?
                   AND ph.generation = pa.base_generation
               )`,
          )
          .bind(
            publicationId,
            attemptId,
            publicationId,
            attemptId,
            projectId,
            attemptId,
            projectId,
            ownerId,
            now,
          ),
      },
      {
        name: "compare-and-swap project head",
        expectedChanges: 1,
        statement: input.database
          .prepare(
            `UPDATE project_heads
             SET generation = ?, publication_id = ?, updated_at = ?
             WHERE project_id = ? AND generation = ?
               AND EXISTS (
                 SELECT 1 FROM publications
                 WHERE id = ? AND attempt_id = ? AND project_id = ?
               )
               AND EXISTS (
                 SELECT 1 FROM publication_attempts
                 WHERE id = ? AND project_id = ? AND user_id = ?
                   AND state = 'open' AND expires_at > ?
                   AND base_generation = ?
               )`,
          )
          .bind(
            generation,
            publicationId,
            now,
            projectId,
            attempt.baseGeneration,
            publicationId,
            attemptId,
            projectId,
            attemptId,
            projectId,
            ownerId,
            now,
            attempt.baseGeneration,
          ),
      },
      {
        name: "settle owner publication quota",
        expectedChanges: 1,
        statement: input.database
          .prepare(
            `UPDATE user
             SET active_logical_bytes = active_logical_bytes + ? - ?,
                 reserved_active_delta_bytes = reserved_active_delta_bytes - ?,
                 reserved_physical_upload_bytes = reserved_physical_upload_bytes - ?
             WHERE id = ?
               AND reserved_active_delta_bytes >= ?
               AND reserved_physical_upload_bytes >= ?
               AND active_logical_bytes + ? - ? >= 0
               AND active_logical_bytes + ? - ? <= ?
               AND EXISTS (
                 SELECT 1 FROM project_heads
                 WHERE project_id = ? AND generation = ? AND publication_id = ?
               )
               AND EXISTS (
                 SELECT 1 FROM publication_attempts
                 WHERE id = ? AND project_id = ? AND user_id = ?
                   AND state = 'open' AND expires_at > ?
               )`,
          )
          .bind(
            attempt.logicalBytes,
            attempt.baseLogicalBytes,
            attempt.reservedActiveDeltaBytes,
            attempt.reservedPhysicalUploadBytes,
            ownerId,
            attempt.reservedActiveDeltaBytes,
            attempt.reservedPhysicalUploadBytes,
            attempt.logicalBytes,
            attempt.baseLogicalBytes,
            attempt.logicalBytes,
            attempt.baseLogicalBytes,
            MAX_ACTIVE_PUBLISHED_BYTES_PER_ACCOUNT,
            projectId,
            generation,
            publicationId,
            attemptId,
            projectId,
            ownerId,
            now,
          ),
      },
      {
        name: "mark publication attempt committed",
        expectedChanges: 1,
        statement: input.database
          .prepare(
            `UPDATE publication_attempts
             SET state = 'committed', settled_at = ?
             WHERE id = ? AND project_id = ? AND user_id = ?
               AND state = 'open' AND expires_at > ?
               AND EXISTS (
                 SELECT 1 FROM project_heads
                 WHERE project_id = ? AND generation = ? AND publication_id = ?
               )`,
          )
          .bind(now, attemptId, projectId, ownerId, now, projectId, generation, publicationId),
      },
    ]);
  } catch (error) {
    if (!(error instanceof GuardedBatchError)) {
      throw error;
    }
    const concurrentlyCommitted = await publicationForAttempt(
      input.database,
      ownerId,
      projectId,
      attemptId,
    );
    if (concurrentlyCommitted !== null) {
      return { publication: concurrentlyCommitted, committed: false };
    }
    const currentHead = await currentHeadDetails(input.database, projectId);
    if (currentHead.generation !== attempt.baseGeneration) {
      throw new CommitPublicationError(
        "publication_head_changed",
        "The project head changed after this publication attempt was prepared",
        { head: currentHead },
      );
    }
    throw new CommitPublicationError(
      "commit_invariant",
      "The guarded publication commit lost a required invariant",
    );
  }

  const publication = await publicationForAttempt(input.database, ownerId, projectId, attemptId);
  if (publication === null) {
    throw new CommitPublicationError(
      "commit_invariant",
      "The committed publication could not be read back",
    );
  }
  return { publication, committed: true };
}
