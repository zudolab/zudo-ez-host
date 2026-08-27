import {
  MAX_ACTIVE_PUBLISHED_BYTES_PER_ACCOUNT,
  MAX_OPEN_ATTEMPTS_PER_ACCOUNT,
  MAX_OPEN_ATTEMPTS_PER_PROJECT,
  MAX_RETAINED_AND_STAGED_BYTES_PER_ACCOUNT,
  decodeManifest,
  validateManifest,
  type ManifestValidationReason,
} from "@zudo-ez-host/core";

import { GuardedBatchError, executeGuardedBatch } from "../../db/guarded-batch.js";
import { stagedManifestKey, type UploadUrlSigner } from "../../storage/index.js";
import {
  UploadContractsError,
  issueUploadContracts,
  normalizeTransportEnvelope,
  type UploadContractPage,
  type UploadContractTransport,
} from "../contracts/index.js";

/** Attempts outlive one ten-minute upload URL so clients can refresh it once. */
export const PUBLICATION_ATTEMPT_LIFETIME_MS = 20 * 60 * 1_000;

export type PreparePublicationErrorReason =
  | "invalid_owner_context"
  | "invalid_request"
  | "invalid_manifest"
  | ManifestValidationReason
  | "invalid_transport_metadata"
  | "envelope_hash_mismatch"
  | "content_size_conflict"
  | "inventory_size_conflict"
  | "project_not_found"
  | "project_unavailable"
  | "project_attempt_limit_exceeded"
  | "account_attempt_limit_exceeded"
  | "active_quota_exceeded"
  | "physical_quota_exceeded"
  | "reservation_conflict"
  | "manifest_staging_failed"
  | "upload_signer_unavailable";

const STATUS_BY_REASON: Partial<Record<PreparePublicationErrorReason, number>> = {
  invalid_owner_context: 401,
  invalid_request: 400,
  invalid_manifest: 400,
  invalid_transport_metadata: 400,
  envelope_hash_mismatch: 422,
  content_size_conflict: 422,
  inventory_size_conflict: 409,
  project_not_found: 404,
  project_unavailable: 409,
  project_attempt_limit_exceeded: 409,
  account_attempt_limit_exceeded: 409,
  active_quota_exceeded: 409,
  physical_quota_exceeded: 409,
  reservation_conflict: 409,
  manifest_staging_failed: 503,
  upload_signer_unavailable: 503,
};

export class PreparePublicationError extends Error {
  readonly reason: PreparePublicationErrorReason;
  readonly status: number;

  constructor(reason: PreparePublicationErrorReason, message: string, status?: number) {
    super(message);
    this.name = "PreparePublicationError";
    this.reason = reason;
    this.status = status ?? STATUS_BY_REASON[reason] ?? 400;
  }
}

export interface PreparePublicationInput {
  readonly database: D1Database;
  readonly bucket: R2Bucket;
  readonly signer: UploadUrlSigner;
  readonly ownerId: string | { readonly userId: string };
  readonly machineId: string;
  readonly projectId: string;
  readonly manifestBytes: Uint8Array | ArrayBuffer;
  readonly transport: unknown;
  readonly now?: number;
  readonly attemptId?: string;
}

export interface PreparedAttempt {
  readonly id: string;
  readonly projectId: string;
  readonly baseGeneration: number;
  readonly manifestHash: string;
  readonly stagedManifestR2Key: string;
  readonly logicalBytes: number;
  readonly fileCount: number;
  readonly reservedActiveDeltaBytes: number;
  readonly reservedPhysicalUploadBytes: number;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface PreparePublicationResult {
  readonly attempt: PreparedAttempt;
  readonly contracts: UploadContractPage;
  readonly created: boolean;
}

interface ProjectSnapshot {
  readonly projectId: string;
  readonly status: string;
  readonly baseGeneration: number;
  readonly baseLogicalBytes: number;
}

interface AttemptRow {
  readonly id: string;
  readonly projectId: string;
  readonly baseGeneration: number;
  readonly manifestHash: string;
  readonly stagedManifestR2Key: string;
  readonly logicalBytes: number;
  readonly fileCount: number;
  readonly reservedActiveDeltaBytes: number;
  readonly reservedPhysicalUploadBytes: number;
  readonly createdAt: number;
  readonly expiresAt: number;
}

interface InventoryRow {
  readonly contentHash: string;
  readonly sizeBytes: number;
}

interface UserCounters {
  readonly activeLogicalBytes: number;
  readonly reservedActiveDeltaBytes: number;
  readonly retainedStagedPhysicalBytes: number;
  readonly reservedPhysicalUploadBytes: number;
}

interface ExpiredAttemptRow {
  readonly id: string;
  readonly reservedActiveDeltaBytes: number;
  readonly reservedPhysicalUploadBytes: number;
}

interface AttemptObjectSeed {
  readonly contentHash: string;
  readonly sizeBytes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireIdentifier(name: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new PreparePublicationError("invalid_request", `${name} must be a non-empty string`);
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
  throw new PreparePublicationError(
    "invalid_owner_context",
    "An authenticated owner context is required",
  );
}

function requireNow(value: number | undefined): number {
  const now = value ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new PreparePublicationError("invalid_request", "now must be a non-negative integer");
  }
  return now;
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digestInput = Uint8Array.from(bytes).buffer;
  return hex(await crypto.subtle.digest("SHA-256", digestInput));
}

function validateMd5(value: string): void {
  let decoded: string;
  try {
    decoded = atob(value);
  } catch {
    throw new PreparePublicationError(
      "invalid_transport_metadata",
      "contentMd5 must be canonical base64",
    );
  }
  if (decoded.length !== 16 || btoa(decoded) !== value) {
    throw new PreparePublicationError(
      "invalid_transport_metadata",
      "contentMd5 must encode exactly 16 bytes",
    );
  }
}

function normalizeEnvelope(
  input: unknown,
  objects: ReadonlyMap<string, number>,
  uploadContentTypes: ReadonlyMap<string, string>,
): Map<string, UploadContractTransport> {
  let envelope: Map<string, UploadContractTransport>;
  try {
    envelope = normalizeTransportEnvelope(input);
  } catch (error) {
    if (error instanceof UploadContractsError) {
      throw new PreparePublicationError("invalid_transport_metadata", error.message);
    }
    throw error;
  }

  if (envelope.size !== objects.size) {
    throw new PreparePublicationError(
      "envelope_hash_mismatch",
      "Transport envelope must contain exactly the manifest hash set",
    );
  }
  for (const [contentHash, metadata] of envelope) {
    if (!objects.has(contentHash)) {
      throw new PreparePublicationError(
        "envelope_hash_mismatch",
        `Transport envelope contains an unknown hash: ${contentHash}`,
      );
    }
    if (metadata.contentType.length > 1_024) {
      throw new PreparePublicationError(
        "invalid_transport_metadata",
        `contentType is too long for ${contentHash}`,
      );
    }
    if (metadata.contentType !== uploadContentTypes.get(contentHash)) {
      throw new PreparePublicationError(
        "invalid_transport_metadata",
        `contentType does not match the deterministic manifest value for ${contentHash}`,
      );
    }
    validateMd5(metadata.contentMd5);
  }
  return envelope;
}

function asPreparedAttempt(row: AttemptRow): PreparedAttempt {
  return row;
}

async function stageManifest(
  bucket: R2Bucket,
  key: string,
  bytes: Uint8Array,
  manifestHash: string,
): Promise<void> {
  const staged = await bucket.put(key, bytes, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { sha256: manifestHash },
  });
  if (staged === null) {
    throw new Error("R2 returned no staged manifest object");
  }
}

async function restageIdempotentManifest(
  bucket: R2Bucket,
  attempt: PreparedAttempt,
  bytes: Uint8Array,
  manifestHash: string,
): Promise<void> {
  try {
    await stageManifest(bucket, attempt.stagedManifestR2Key, bytes, manifestHash);
  } catch (error) {
    throw new PreparePublicationError(
      "manifest_staging_failed",
      error instanceof Error ? error.message : "Manifest staging failed",
      503,
    );
  }
}

async function findIdempotentAttempt(
  database: D1Database,
  ownerId: string,
  projectId: string,
  manifestHash: string,
  now: number,
): Promise<PreparedAttempt | null> {
  const row = await database
    .prepare(
      `SELECT id, project_id AS projectId, base_generation AS baseGeneration,
              manifest_hash AS manifestHash, staged_manifest_r2_key AS stagedManifestR2Key,
              logical_bytes AS logicalBytes, file_count AS fileCount,
              reserved_active_delta_bytes AS reservedActiveDeltaBytes,
              reserved_physical_upload_bytes AS reservedPhysicalUploadBytes,
              created_at AS createdAt, expires_at AS expiresAt
       FROM publication_attempts
       WHERE project_id = ? AND user_id = ? AND manifest_hash = ?
         AND state = 'open' AND expires_at > ?
       ORDER BY created_at ASC, id ASC
       LIMIT 1`,
    )
    .bind(projectId, ownerId, manifestHash, now)
    .first<AttemptRow>();
  return row === null ? null : asPreparedAttempt(row);
}

async function releaseExpiredAttempts(
  database: D1Database,
  ownerId: string,
  now: number,
): Promise<void> {
  const expired = await database
    .prepare(
      `SELECT id, reserved_active_delta_bytes AS reservedActiveDeltaBytes,
              reserved_physical_upload_bytes AS reservedPhysicalUploadBytes
       FROM publication_attempts
       WHERE user_id = ? AND state = 'open' AND expires_at <= ?
       ORDER BY expires_at ASC, id ASC`,
    )
    .bind(ownerId, now)
    .all<ExpiredAttemptRow>();

  if (expired.results.length === 0) {
    return;
  }

  try {
    await executeGuardedBatch(
      database,
      expired.results.flatMap((attempt) => [
        {
          name: `release expired reservation ${attempt.id}`,
          expectedChanges: 1,
          statement: database
            .prepare(
              `UPDATE user
               SET reserved_active_delta_bytes = reserved_active_delta_bytes - ?,
                   reserved_physical_upload_bytes = reserved_physical_upload_bytes - ?
               WHERE id = ?
                 AND reserved_active_delta_bytes >= ?
                 AND reserved_physical_upload_bytes >= ?
                 AND EXISTS (
                   SELECT 1 FROM publication_attempts
                   WHERE id = ? AND user_id = ? AND state = 'open' AND expires_at <= ?
                     AND reserved_active_delta_bytes = ?
                     AND reserved_physical_upload_bytes = ?
                 )`,
            )
            .bind(
              attempt.reservedActiveDeltaBytes,
              attempt.reservedPhysicalUploadBytes,
              ownerId,
              attempt.reservedActiveDeltaBytes,
              attempt.reservedPhysicalUploadBytes,
              attempt.id,
              ownerId,
              now,
              attempt.reservedActiveDeltaBytes,
              attempt.reservedPhysicalUploadBytes,
            ),
        },
        {
          name: `expire attempt ${attempt.id}`,
          expectedChanges: 1,
          statement: database
            .prepare(
              `UPDATE publication_attempts
               SET state = 'expired', settled_at = ?
               WHERE id = ? AND user_id = ? AND state = 'open' AND expires_at <= ?
                 AND reserved_active_delta_bytes = ?
                 AND reserved_physical_upload_bytes = ?`,
            )
            .bind(
              now,
              attempt.id,
              ownerId,
              now,
              attempt.reservedActiveDeltaBytes,
              attempt.reservedPhysicalUploadBytes,
            ),
        },
      ]),
    );
  } catch (error) {
    // A concurrent prepare may have completed the same lazy sweep. Every
    // release is conditional on the attempt still being open, so zero-change
    // guards mean there is nothing left for this request to release.
    if (!(error instanceof GuardedBatchError)) {
      throw error;
    }
  }
}

async function projectSnapshot(
  database: D1Database,
  ownerId: string,
  projectId: string,
): Promise<ProjectSnapshot> {
  const row = await database
    .prepare(
      `SELECT p.id AS projectId, p.status, ph.generation AS baseGeneration,
              COALESCE(pub.logical_bytes, 0) AS baseLogicalBytes
       FROM projects AS p
       INNER JOIN project_heads AS ph ON ph.project_id = p.id
       LEFT JOIN publications AS pub ON pub.id = ph.publication_id AND pub.project_id = p.id
       WHERE p.id = ? AND p.user_id = ?`,
    )
    .bind(projectId, ownerId)
    .first<ProjectSnapshot>();
  if (row === null) {
    throw new PreparePublicationError(
      "project_not_found",
      "The project was not found for this owner",
      404,
    );
  }
  if (row.status !== "active") {
    throw new PreparePublicationError("project_unavailable", "The project is not active", 409);
  }
  return row;
}

async function inventoryFor(
  database: D1Database,
  projectId: string,
  seedsJson: string,
): Promise<Map<string, number>> {
  const inventory = await database
    .prepare(
      `SELECT vo.content_hash AS contentHash, vo.size_bytes AS sizeBytes
       FROM verified_objects AS vo
       INNER JOIN json_each(?) AS required
         ON json_extract(required.value, '$.contentHash') = vo.content_hash
       WHERE vo.project_id = ?`,
    )
    .bind(seedsJson, projectId)
    .all<InventoryRow>();
  return new Map(inventory.results.map((row) => [row.contentHash, row.sizeBytes]));
}

async function userCounters(database: D1Database, ownerId: string): Promise<UserCounters> {
  const counters = await database
    .prepare(
      `SELECT active_logical_bytes AS activeLogicalBytes,
              reserved_active_delta_bytes AS reservedActiveDeltaBytes,
              retained_staged_physical_bytes AS retainedStagedPhysicalBytes,
              reserved_physical_upload_bytes AS reservedPhysicalUploadBytes
       FROM user WHERE id = ?`,
    )
    .bind(ownerId)
    .first<UserCounters>();
  if (counters === null) {
    throw new PreparePublicationError("invalid_owner_context", "The owner no longer exists", 401);
  }
  return counters;
}

async function classifyReservationFailure(
  database: D1Database,
  ownerId: string,
  projectId: string,
  activeDelta: number,
  physicalBytes: number,
  now: number,
): Promise<never> {
  const counts = await database
    .prepare(
      `SELECT
         SUM(CASE WHEN project_id = ? THEN 1 ELSE 0 END) AS projectCount,
         COUNT(*) AS accountCount
       FROM publication_attempts
       WHERE user_id = ? AND state = 'open' AND expires_at > ?`,
    )
    .bind(projectId, ownerId, now)
    .first<{ projectCount: number; accountCount: number }>();
  if ((counts?.projectCount ?? 0) >= MAX_OPEN_ATTEMPTS_PER_PROJECT) {
    throw new PreparePublicationError(
      "project_attempt_limit_exceeded",
      "The project already has the maximum number of open attempts",
    );
  }
  if ((counts?.accountCount ?? 0) >= MAX_OPEN_ATTEMPTS_PER_ACCOUNT) {
    throw new PreparePublicationError(
      "account_attempt_limit_exceeded",
      "The account already has the maximum number of open attempts",
    );
  }
  const counters = await userCounters(database, ownerId);
  if (
    counters.activeLogicalBytes + counters.reservedActiveDeltaBytes + activeDelta >
    MAX_ACTIVE_PUBLISHED_BYTES_PER_ACCOUNT
  ) {
    throw new PreparePublicationError(
      "active_quota_exceeded",
      "The publication would exceed the active logical-byte quota",
    );
  }
  if (
    counters.retainedStagedPhysicalBytes + counters.reservedPhysicalUploadBytes + physicalBytes >
    MAX_RETAINED_AND_STAGED_BYTES_PER_ACCOUNT
  ) {
    throw new PreparePublicationError(
      "physical_quota_exceeded",
      "The publication would exceed the retained and staged physical-byte quota",
    );
  }
  throw new PreparePublicationError(
    "reservation_conflict",
    "The prepare reservation lost a concurrent guard",
  );
}

async function abandonFailedStaging(
  database: D1Database,
  ownerId: string,
  attemptId: string,
  activeDelta: number,
  physicalBytes: number,
  now: number,
): Promise<void> {
  try {
    await executeGuardedBatch(database, [
      {
        name: "release failed staging reservation",
        expectedChanges: 1,
        statement: database
          .prepare(
            `UPDATE user
             SET reserved_active_delta_bytes = reserved_active_delta_bytes - ?,
                 reserved_physical_upload_bytes = reserved_physical_upload_bytes - ?
             WHERE id = ?
               AND reserved_active_delta_bytes >= ?
               AND reserved_physical_upload_bytes >= ?
               AND EXISTS (
                 SELECT 1 FROM publication_attempts
                 WHERE id = ? AND user_id = ? AND state = 'open'
               )`,
          )
          .bind(
            activeDelta,
            physicalBytes,
            ownerId,
            activeDelta,
            physicalBytes,
            attemptId,
            ownerId,
          ),
      },
      {
        name: "abandon failed staging attempt",
        expectedChanges: 1,
        statement: database
          .prepare(
            `UPDATE publication_attempts SET state = 'abandoned', settled_at = ?
             WHERE id = ? AND user_id = ? AND state = 'open'`,
          )
          .bind(now, attemptId, ownerId),
      },
    ]);
  } catch {
    // Preserve the staging failure as the stable outward error. A later lazy
    // expiry remains a safe fallback if an infrastructure failure also blocks
    // compensation.
  }
}

function mapContractsError(error: UploadContractsError): PreparePublicationError {
  if (error.reason === "upload_signer_unavailable") {
    return new PreparePublicationError("upload_signer_unavailable", error.message, error.status);
  }
  return new PreparePublicationError(
    error.reason === "invalid_transport_metadata" || error.reason === "missing_transport_metadata"
      ? "invalid_transport_metadata"
      : "reservation_conflict",
    error.message,
    error.status,
  );
}

/**
 * Validate, reserve, and stage one immutable publication attempt.
 *
 * Expiry cleanup is deliberately lazy: the next prepare by an account settles
 * all of that account's expired open attempts before idempotency, caps, and
 * quota are evaluated. Per-minute abuse damping is deliberately outside this
 * endpoint's exact D1 accounting contract and is not enforced here.
 */
export async function preparePublication(
  input: PreparePublicationInput,
): Promise<PreparePublicationResult> {
  const ownerId = requireOwnerId(input.ownerId);
  const machineId = requireIdentifier("machineId", input.machineId);
  const projectId = requireIdentifier("projectId", input.projectId);
  const now = requireNow(input.now);
  const manifestBytes =
    input.manifestBytes instanceof Uint8Array
      ? input.manifestBytes
      : new Uint8Array(input.manifestBytes);
  const decoded = decodeManifest(manifestBytes);
  if (!decoded.ok) {
    throw new PreparePublicationError(decoded.reason, `Manifest rejected: ${decoded.reason}`);
  }
  // Keep the public contract explicit even though decodeManifest currently
  // performs validation itself.
  const validated = validateManifest(decoded.value);
  if (!validated.ok) {
    throw new PreparePublicationError(validated.reason, `Manifest rejected: ${validated.reason}`);
  }

  const objects = new Map<string, number>();
  const uploadContentTypes = new Map<string, string>();
  let logicalBytes = 0;
  for (const entry of validated.value.entries) {
    const existingSize = objects.get(entry.sha256);
    if (existingSize !== undefined && existingSize !== entry.size) {
      throw new PreparePublicationError(
        "content_size_conflict",
        `Manifest hash ${entry.sha256} appears with inconsistent sizes`,
      );
    }
    objects.set(entry.sha256, entry.size);
    // Validated entries are in canonical path order. When multiple paths use
    // the same bytes with different serving metadata, the first canonical
    // path supplies the one stable Content-Type signed for the R2 upload.
    if (!uploadContentTypes.has(entry.sha256)) {
      uploadContentTypes.set(entry.sha256, entry.contentType);
    }
    logicalBytes += entry.size;
  }
  const envelope = normalizeEnvelope(input.transport, objects, uploadContentTypes);
  const manifestHash = await sha256(manifestBytes);

  await releaseExpiredAttempts(input.database, ownerId, now);
  const existing = await findIdempotentAttempt(
    input.database,
    ownerId,
    projectId,
    manifestHash,
    now,
  );
  if (existing !== null) {
    // The creating request may still be between its guarded D1 batch and R2
    // put. Re-staging identical canonical bytes closes that race without
    // changing attempt identity or reservations.
    await restageIdempotentManifest(input.bucket, existing, manifestBytes, manifestHash);
    try {
      return {
        attempt: existing,
        contracts: await issueUploadContracts({
          database: input.database,
          signer: input.signer,
          ownerId,
          projectId,
          attemptId: existing.id,
          transport: envelope,
          now,
        }),
        created: false,
      };
    } catch (error) {
      if (error instanceof UploadContractsError) {
        throw mapContractsError(error);
      }
      throw error;
    }
  }

  const project = await projectSnapshot(input.database, ownerId, projectId);
  const seeds: AttemptObjectSeed[] = [...objects].map(([contentHash, sizeBytes]) => ({
    contentHash,
    sizeBytes,
  }));
  const seedsJson = JSON.stringify(seeds);
  const inventory = await inventoryFor(input.database, projectId, seedsJson);
  let reservedPhysicalUploadBytes = 0;
  for (const seed of seeds) {
    const inventorySize = inventory.get(seed.contentHash);
    if (inventorySize !== undefined && inventorySize !== seed.sizeBytes) {
      throw new PreparePublicationError(
        "inventory_size_conflict",
        `Verified inventory has a conflicting size for ${seed.contentHash}`,
      );
    }
    if (inventorySize === undefined) {
      reservedPhysicalUploadBytes += seed.sizeBytes;
    }
  }
  const reservedActiveDeltaBytes = Math.max(0, logicalBytes - project.baseLogicalBytes);
  const attemptId = input.attemptId ?? crypto.randomUUID();
  requireIdentifier("attemptId", attemptId);
  const expiresAt = now + PUBLICATION_ATTEMPT_LIFETIME_MS;
  const stagedKey = stagedManifestKey(projectId, attemptId);

  try {
    await executeGuardedBatch(input.database, [
      {
        name: "create publication attempt",
        expectedChanges: 1,
        statement: input.database
          .prepare(
            `INSERT INTO publication_attempts
               (id, project_id, user_id, machine_id, state, base_generation,
                base_logical_bytes, staged_manifest_r2_key, manifest_hash,
                logical_bytes, file_count, reserved_active_delta_bytes,
                reserved_physical_upload_bytes, created_at, expires_at, settled_at)
             SELECT ?, p.id, p.user_id, ?, 'open', ph.generation, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL
             FROM projects AS p
             INNER JOIN project_heads AS ph ON ph.project_id = p.id
             INNER JOIN user AS u ON u.id = p.user_id
             WHERE p.id = ? AND p.user_id = ? AND p.status = 'active'
               AND ph.generation = ?
               AND NOT EXISTS (
                 SELECT 1 FROM publication_attempts
                 WHERE project_id = p.id AND user_id = p.user_id AND manifest_hash = ?
                   AND state = 'open' AND expires_at > ?
               )
               AND (SELECT COUNT(*) FROM publication_attempts
                    WHERE project_id = p.id AND state = 'open' AND expires_at > ?) < ?
               AND (SELECT COUNT(*) FROM publication_attempts
                    WHERE user_id = p.user_id AND state = 'open' AND expires_at > ?) < ?
               AND u.active_logical_bytes + u.reserved_active_delta_bytes + ? <= ?
               AND u.retained_staged_physical_bytes + u.reserved_physical_upload_bytes + ? <= ?
               AND (
                 SELECT COALESCE(SUM(json_extract(required.value, '$.sizeBytes')), 0)
                 FROM json_each(?) AS required
                 LEFT JOIN verified_objects AS vo
                   ON vo.project_id = p.id
                  AND vo.content_hash = json_extract(required.value, '$.contentHash')
                  AND vo.size_bytes = json_extract(required.value, '$.sizeBytes')
                 WHERE vo.content_hash IS NULL
               ) = ?`,
          )
          .bind(
            attemptId,
            machineId,
            project.baseLogicalBytes,
            stagedKey,
            manifestHash,
            logicalBytes,
            validated.value.entries.length,
            reservedActiveDeltaBytes,
            reservedPhysicalUploadBytes,
            now,
            expiresAt,
            projectId,
            ownerId,
            project.baseGeneration,
            manifestHash,
            now,
            now,
            MAX_OPEN_ATTEMPTS_PER_PROJECT,
            now,
            MAX_OPEN_ATTEMPTS_PER_ACCOUNT,
            reservedActiveDeltaBytes,
            MAX_ACTIVE_PUBLISHED_BYTES_PER_ACCOUNT,
            reservedPhysicalUploadBytes,
            MAX_RETAINED_AND_STAGED_BYTES_PER_ACCOUNT,
            seedsJson,
            reservedPhysicalUploadBytes,
          ),
      },
      {
        name: "reserve account publication quota",
        expectedChanges: 1,
        statement: input.database
          .prepare(
            `UPDATE user
             SET reserved_active_delta_bytes = reserved_active_delta_bytes + ?,
                 reserved_physical_upload_bytes = reserved_physical_upload_bytes + ?
             WHERE id = ?
               AND active_logical_bytes + reserved_active_delta_bytes + ? <= ?
               AND retained_staged_physical_bytes + reserved_physical_upload_bytes + ? <= ?
               AND EXISTS (
                 SELECT 1 FROM publication_attempts
                 WHERE id = ? AND project_id = ? AND user_id = ? AND machine_id = ?
                   AND state = 'open' AND created_at = ? AND expires_at = ?
                   AND reserved_active_delta_bytes = ?
                   AND reserved_physical_upload_bytes = ?
               )`,
          )
          .bind(
            reservedActiveDeltaBytes,
            reservedPhysicalUploadBytes,
            ownerId,
            reservedActiveDeltaBytes,
            MAX_ACTIVE_PUBLISHED_BYTES_PER_ACCOUNT,
            reservedPhysicalUploadBytes,
            MAX_RETAINED_AND_STAGED_BYTES_PER_ACCOUNT,
            attemptId,
            projectId,
            ownerId,
            machineId,
            now,
            expiresAt,
            reservedActiveDeltaBytes,
            reservedPhysicalUploadBytes,
          ),
      },
      {
        name: "record publication attempt objects",
        expectedChanges: seeds.length,
        statement: input.database
          .prepare(
            `INSERT INTO publication_attempt_objects
               (attempt_id, content_hash, size_bytes, requires_upload, verified)
             SELECT pa.id,
                    json_extract(required.value, '$.contentHash'),
                    json_extract(required.value, '$.sizeBytes'),
                    CASE WHEN vo.content_hash IS NULL THEN 1 ELSE 0 END,
                    CASE WHEN vo.content_hash IS NULL THEN 0 ELSE 1 END
             FROM publication_attempts AS pa
             INNER JOIN json_each(?) AS required
             LEFT JOIN verified_objects AS vo
               ON vo.project_id = pa.project_id
              AND vo.content_hash = json_extract(required.value, '$.contentHash')
              AND vo.size_bytes = json_extract(required.value, '$.sizeBytes')
             WHERE pa.id = ? AND pa.project_id = ? AND pa.user_id = ? AND pa.machine_id = ?
               AND pa.state = 'open' AND pa.created_at = ? AND pa.expires_at = ?`,
          )
          .bind(seedsJson, attemptId, projectId, ownerId, machineId, now, expiresAt),
      },
    ]);
  } catch (error) {
    if (!(error instanceof GuardedBatchError)) {
      throw error;
    }
    const racedExisting = await findIdempotentAttempt(
      input.database,
      ownerId,
      projectId,
      manifestHash,
      now,
    );
    if (racedExisting !== null) {
      await restageIdempotentManifest(input.bucket, racedExisting, manifestBytes, manifestHash);
      try {
        return {
          attempt: racedExisting,
          contracts: await issueUploadContracts({
            database: input.database,
            signer: input.signer,
            ownerId,
            projectId,
            attemptId: racedExisting.id,
            transport: envelope,
            now,
          }),
          created: false,
        };
      } catch (contractsError) {
        if (contractsError instanceof UploadContractsError) {
          throw mapContractsError(contractsError);
        }
        throw contractsError;
      }
    }
    await classifyReservationFailure(
      input.database,
      ownerId,
      projectId,
      reservedActiveDeltaBytes,
      reservedPhysicalUploadBytes,
      now,
    );
  }

  try {
    await stageManifest(input.bucket, stagedKey, manifestBytes, manifestHash);
  } catch (error) {
    // An identical concurrent re-prepare may have closed the D1-to-R2 window
    // by staging the same immutable bytes. R2 is strongly consistent, so that
    // object makes this attempt usable despite this request's failed put.
    let concurrentlyStaged: R2Object | null = null;
    try {
      concurrentlyStaged = await input.bucket.head(stagedKey);
    } catch {
      // The original staging error remains the stable outward failure.
    }
    if (concurrentlyStaged?.customMetadata?.sha256 === manifestHash) {
      // Continue to contract issuance below.
    } else {
      await abandonFailedStaging(
        input.database,
        ownerId,
        attemptId,
        reservedActiveDeltaBytes,
        reservedPhysicalUploadBytes,
        now,
      );
      throw new PreparePublicationError(
        "manifest_staging_failed",
        error instanceof Error ? error.message : "Manifest staging failed",
        503,
      );
    }
  }

  const attempt: PreparedAttempt = {
    id: attemptId,
    projectId,
    baseGeneration: project.baseGeneration,
    manifestHash,
    stagedManifestR2Key: stagedKey,
    logicalBytes,
    fileCount: validated.value.entries.length,
    reservedActiveDeltaBytes,
    reservedPhysicalUploadBytes,
    createdAt: now,
    expiresAt,
  };
  try {
    return {
      attempt,
      contracts: await issueUploadContracts({
        database: input.database,
        signer: input.signer,
        ownerId,
        projectId,
        attemptId,
        transport: envelope,
        now,
      }),
      created: true,
    };
  } catch (error) {
    if (error instanceof UploadContractsError) {
      throw mapContractsError(error);
    }
    throw error;
  }
}
