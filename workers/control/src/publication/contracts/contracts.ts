import { MAX_FILES_PER_ARTIFACT } from "@zudo-ez-host/core";

import { GuardedBatchError, executeGuardedBatch } from "../../db/guarded-batch.js";
import {
  contentKey,
  MAX_VERIFICATION_BATCH_SIZE,
  verifyR2Objects,
  type Md5Value,
  type ReadOnlyR2Bucket,
  type R2ObjectVerificationRequest,
  type UploadUrlSigner,
} from "../../storage/index.js";

/**
 * Keep one page comfortably below the smallest historical Worker subrequest
 * budget. Signing is not an R2 request, but a bounded page also keeps URL
 * issuance and response size predictable for callers.
 */
export const UPLOAD_CONTRACT_PAGE_SIZE = 25;

/** Descriptive aliases used by callers that name this a contract page. */
export const MAX_UPLOAD_CONTRACT_PAGE_SIZE = UPLOAD_CONTRACT_PAGE_SIZE;
export const UPLOAD_URL_CONTRACT_PAGE_SIZE = UPLOAD_CONTRACT_PAGE_SIZE;

export type UploadContractsErrorReason =
  | "invalid_owner_context"
  | "invalid_request"
  | "invalid_page"
  | "invalid_cursor"
  | "invalid_content_hash"
  | "invalid_transport_metadata"
  | "missing_transport_metadata"
  | "attempt_not_found"
  | "attempt_expired"
  | "attempt_closed"
  | "content_not_in_attempt"
  | "content_size_mismatch"
  | "inventory_size_conflict"
  | "inventory_missing"
  | "verification_batch_too_large"
  | "missing"
  | "size_mismatch"
  | "md5_mismatch"
  | "verification_invariant"
  | "upload_signer_unavailable";

const HTTP_STATUS_BY_REASON: Partial<Record<UploadContractsErrorReason, number>> = {
  invalid_owner_context: 401,
  invalid_request: 400,
  invalid_page: 400,
  invalid_cursor: 400,
  invalid_content_hash: 400,
  invalid_transport_metadata: 400,
  missing_transport_metadata: 400,
  attempt_not_found: 404,
  attempt_expired: 409,
  attempt_closed: 409,
  content_not_in_attempt: 422,
  content_size_mismatch: 422,
  inventory_size_conflict: 500,
  inventory_missing: 500,
  verification_batch_too_large: 400,
  missing: 422,
  size_mismatch: 422,
  md5_mismatch: 422,
  verification_invariant: 500,
  upload_signer_unavailable: 503,
};

/** Stable, machine-readable error thrown by the callable contract seams. */
export class UploadContractsError extends Error {
  readonly code: UploadContractsErrorReason;
  readonly reason: UploadContractsErrorReason;
  readonly status: number;

  constructor(code: UploadContractsErrorReason, message: string, status?: number) {
    super(message);
    this.name = "UploadContractsError";
    this.code = code;
    this.reason = code;
    this.status = status ?? HTTP_STATUS_BY_REASON[code] ?? 400;
  }
}

/** Per-hash transport metadata supplied by prepare or a refresh caller. */
export interface UploadContractTransport {
  readonly contentHash: string;
  readonly contentType: string;
  readonly contentMd5: string;
}

/** Wire aliases accepted when a caller uses manifest terminology. */
export type UploadContractTransportInput = {
  readonly contentHash?: unknown;
  readonly sha256?: unknown;
  readonly hash?: unknown;
  readonly contentType?: unknown;
  readonly contentMd5?: unknown;
  readonly md5?: unknown;
};

interface AttemptRow {
  readonly id: string;
  readonly projectId: string;
  readonly userId: string;
  readonly state: string;
  readonly expiresAt: number;
}

interface AttemptObjectRow {
  readonly contentHash: string;
  readonly sizeBytes: number;
  readonly requiresUpload: number;
  readonly verified: number;
}

interface InventoryConflictRow {
  readonly contentHash: string;
  readonly sizeBytes: number;
  readonly inventorySizeBytes: number;
}

interface InventoryRow {
  readonly projectId: string;
  readonly contentHash: string;
  readonly sizeBytes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(record: Record<string, unknown>, ...names: readonly string[]): unknown {
  for (const name of names) {
    if (name in record) {
      return record[name];
    }
  }
  return undefined;
}

function requireNonEmptyString(name: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new UploadContractsError("invalid_request", `${name} must be a non-empty string`);
  }
  return value;
}

function requireOwnerId(value: unknown): string {
  if (typeof value === "string" && value.length > 0 && !/[\u0000-\u001f\u007f]/u.test(value)) {
    return value;
  }

  if (isRecord(value) && typeof value.userId === "string" && value.userId.length > 0) {
    return requireOwnerId(value.userId);
  }

  throw new UploadContractsError(
    "invalid_owner_context",
    "An authenticated owner context with a user ID is required",
    401,
  );
}

function requireNow(value: number | undefined): number {
  const now = value ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new UploadContractsError(
      "invalid_request",
      "Operation time must be a non-negative integer",
    );
  }
  return now;
}

/** Validate only what is needed to safely construct a project-scoped key. */
function requireContentHash(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    /[\\/\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new UploadContractsError(
      "invalid_content_hash",
      "contentHash is not a valid object hash",
    );
  }
  return value;
}

function requireTransportLine(name: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new UploadContractsError(
      "invalid_transport_metadata",
      `${name} must be a non-empty line`,
    );
  }
  return value;
}

function parseTransportEntry(value: unknown, fallbackHash?: string): UploadContractTransport {
  if (!isRecord(value)) {
    throw new UploadContractsError(
      "invalid_transport_metadata",
      "Each transport entry must be an object",
    );
  }

  const explicitHash = field(value, "contentHash", "sha256", "hash");
  if (fallbackHash !== undefined && explicitHash !== undefined && explicitHash !== fallbackHash) {
    throw new UploadContractsError(
      "invalid_transport_metadata",
      "Transport map key and content hash do not match",
    );
  }
  const contentHash = requireContentHash(fallbackHash ?? explicitHash);
  const contentType = requireTransportLine("contentType", field(value, "contentType"));
  const contentMd5 = requireTransportLine("contentMd5", field(value, "contentMd5", "md5"));
  return { contentHash, contentType, contentMd5 };
}

/**
 * Normalize both the prepare-friendly array form and the compact hash map
 * form. Extra entries are retained in the map so a full manifest envelope can
 * be reused for every page without changing the page's D1 query.
 */
export function normalizeTransportEnvelope(value: unknown): Map<string, UploadContractTransport> {
  if (value === undefined || value === null) {
    return new Map();
  }

  if (Array.isArray(value)) {
    const entries = new Map<string, UploadContractTransport>();
    for (const item of value) {
      const parsed = parseTransportEntry(item);
      if (entries.has(parsed.contentHash)) {
        throw new UploadContractsError(
          "invalid_transport_metadata",
          `Transport metadata repeats ${parsed.contentHash}`,
        );
      }
      entries.set(parsed.contentHash, parsed);
    }
    return entries;
  }

  if (value instanceof Map) {
    const entries = new Map<string, UploadContractTransport>();
    for (const [hash, metadata] of value.entries()) {
      if (typeof hash !== "string") {
        throw new UploadContractsError(
          "invalid_transport_metadata",
          "Transport map keys must be strings",
        );
      }
      const parsed = parseTransportEntry(metadata, hash);
      if (entries.has(parsed.contentHash)) {
        throw new UploadContractsError(
          "invalid_transport_metadata",
          `Transport metadata repeats ${parsed.contentHash}`,
        );
      }
      entries.set(parsed.contentHash, parsed);
    }
    return entries;
  }

  if (!isRecord(value)) {
    throw new UploadContractsError(
      "invalid_transport_metadata",
      "Transport envelope must be an array or object",
    );
  }

  // Accept a named array wrapper without accepting arbitrary nested request
  // data as authority.
  for (const key of ["entries", "objects", "transport"] as const) {
    const nested = value[key];
    if (Array.isArray(nested)) {
      return normalizeTransportEnvelope(nested);
    }
  }

  const entries = new Map<string, UploadContractTransport>();
  for (const [hash, metadata] of Object.entries(value)) {
    const parsed = parseTransportEntry(metadata, hash);
    if (entries.has(parsed.contentHash)) {
      throw new UploadContractsError(
        "invalid_transport_metadata",
        `Transport metadata repeats ${parsed.contentHash}`,
      );
    }
    entries.set(parsed.contentHash, parsed);
  }
  return entries;
}

function requirePageNumber(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new UploadContractsError("invalid_page", "page must be a non-negative integer");
  }
  const page = value as number;
  if (page * UPLOAD_CONTRACT_PAGE_SIZE > MAX_FILES_PER_ARTIFACT) {
    throw new UploadContractsError("invalid_page", "page is outside the artifact entry range");
  }
  return page;
}

function requireOffset(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new UploadContractsError("invalid_page", "offset must be a non-negative integer");
  }
  const offset = value as number;
  if (offset > MAX_FILES_PER_ARTIFACT) {
    throw new UploadContractsError("invalid_page", "offset is outside the artifact entry range");
  }
  return offset;
}

function requireCursor(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return requireContentHash(value);
}

async function getAttempt(
  database: D1Database,
  ownerId: string,
  projectId: string,
  attemptId: string,
  now: number,
): Promise<AttemptRow> {
  const row = await database
    .prepare(
      `SELECT id, project_id AS projectId, user_id AS userId, state,
              expires_at AS expiresAt
       FROM publication_attempts
       WHERE id = ? AND project_id = ? AND user_id = ?`,
    )
    .bind(attemptId, projectId, ownerId)
    .first<AttemptRow>();

  // A foreign attempt is deliberately indistinguishable from an unknown one.
  if (row === null) {
    throw new UploadContractsError(
      "attempt_not_found",
      "The publication attempt was not found for this owner and project",
      404,
    );
  }
  if (row.state === "expired" || (row.state === "open" && now >= row.expiresAt)) {
    throw new UploadContractsError("attempt_expired", "The publication attempt has expired", 409);
  }
  if (row.state !== "open") {
    throw new UploadContractsError("attempt_closed", "The publication attempt is closed", 409);
  }
  return row;
}

async function assertAttemptStillOpen(
  database: D1Database,
  ownerId: string,
  projectId: string,
  attemptId: string,
  now: number,
): Promise<void> {
  await getAttempt(database, ownerId, projectId, attemptId, now);
}

async function assertNoInventorySizeConflict(
  database: D1Database,
  ownerId: string,
  projectId: string,
  attemptId: string,
): Promise<void> {
  const conflict = await database
    .prepare(
      `SELECT pao.content_hash AS contentHash,
              pao.size_bytes AS sizeBytes,
              vo.size_bytes AS inventorySizeBytes
       FROM publication_attempt_objects AS pao
       INNER JOIN publication_attempts AS pa
         ON pa.id = pao.attempt_id
        AND pa.project_id = ? AND pa.user_id = ?
       INNER JOIN verified_objects AS vo
         ON vo.project_id = pa.project_id
        AND vo.content_hash = pao.content_hash
       WHERE pao.attempt_id = ?
         AND pao.requires_upload = 1
         AND vo.size_bytes <> pao.size_bytes
       LIMIT 1`,
    )
    .bind(projectId, ownerId, attemptId)
    .first<InventoryConflictRow>();
  if (conflict !== null) {
    throw new UploadContractsError(
      "inventory_size_conflict",
      `Verified inventory has an unexpected size for ${conflict.contentHash}`,
      500,
    );
  }
}

export interface IssueUploadContractsInput {
  readonly database: D1Database;
  readonly signer: UploadUrlSigner;
  /** May be an opaque owner ID or the machine-auth context itself. */
  readonly ownerId: string | { readonly userId: string };
  readonly projectId: string;
  readonly attemptId: string;
  readonly transport?: unknown;
  readonly transportEnvelope?: unknown;
  readonly envelope?: unknown;
  /** Keyset cursor returned by a previous page. */
  readonly cursor?: unknown;
  /** Zero-based page number; cursor is preferred when inventory changes. */
  readonly page?: unknown;
  /** Explicit offset alias for callers that page by rows. */
  readonly offset?: unknown;
  /** Accepted for wire compatibility; server always uses the fixed page size. */
  readonly pageSize?: unknown;
  readonly now?: number;
}

export interface UploadContract {
  readonly contentHash: string;
  readonly key: string;
  readonly sizeBytes: number;
  readonly contentType: string;
  readonly contentMd5: string;
  readonly uploadUrl: string;
}

export interface UploadContractPage {
  readonly attemptId: string;
  readonly projectId: string;
  readonly pageSize: typeof UPLOAD_CONTRACT_PAGE_SIZE;
  readonly cursor?: string;
  readonly nextCursor?: string;
  readonly hasMore: boolean;
  readonly contracts: readonly UploadContract[];
}

/**
 * Issue at most one fixed-size page of signed PUT contracts. The SQL query is
 * attempt- and owner-scoped and excludes any hash already present in the
 * project inventory, including hashes verified by another open attempt.
 */
export async function issueUploadContracts(
  input: IssueUploadContractsInput,
): Promise<UploadContractPage> {
  const ownerId = requireOwnerId(input.ownerId);
  const projectId = requireNonEmptyString("projectId", input.projectId);
  const attemptId = requireNonEmptyString("attemptId", input.attemptId);
  const now = requireNow(input.now);
  const cursor = requireCursor(input.cursor);
  if (input.page !== undefined && input.offset !== undefined) {
    throw new UploadContractsError("invalid_page", "page and offset cannot be used together");
  }
  const page = input.page === undefined ? undefined : requirePageNumber(input.page);
  const offset =
    input.offset === undefined
      ? page === undefined
        ? 0
        : page * UPLOAD_CONTRACT_PAGE_SIZE
      : requireOffset(input.offset);
  const transport = normalizeTransportEnvelope(
    input.transport ?? input.transportEnvelope ?? input.envelope,
  );

  await getAttempt(input.database, ownerId, projectId, attemptId, now);
  await assertNoInventorySizeConflict(input.database, ownerId, projectId, attemptId);

  const result =
    cursor === undefined
      ? await input.database
          .prepare(
            `SELECT pao.content_hash AS contentHash,
                    pao.size_bytes AS sizeBytes,
                    pao.requires_upload AS requiresUpload,
                    pao.verified
             FROM publication_attempt_objects AS pao
             INNER JOIN publication_attempts AS pa
               ON pa.id = pao.attempt_id
              AND pa.project_id = ?
              AND pa.user_id = ?
              AND pa.state = 'open'
              AND pa.expires_at > ?
             WHERE pao.attempt_id = ?
               AND pao.requires_upload = 1
               AND pao.verified = 0
               AND NOT EXISTS (
                 SELECT 1 FROM verified_objects AS vo
                 WHERE vo.project_id = pa.project_id
                   AND vo.content_hash = pao.content_hash
               )
             ORDER BY pao.content_hash ASC
             LIMIT ? OFFSET ?`,
          )
          .bind(projectId, ownerId, now, attemptId, UPLOAD_CONTRACT_PAGE_SIZE + 1, offset)
          .all<AttemptObjectRow>()
      : await input.database
          .prepare(
            `SELECT pao.content_hash AS contentHash,
                    pao.size_bytes AS sizeBytes,
                    pao.requires_upload AS requiresUpload,
                    pao.verified
             FROM publication_attempt_objects AS pao
             INNER JOIN publication_attempts AS pa
               ON pa.id = pao.attempt_id
              AND pa.project_id = ?
              AND pa.user_id = ?
              AND pa.state = 'open'
              AND pa.expires_at > ?
             WHERE pao.attempt_id = ?
               AND pao.content_hash > ?
               AND pao.requires_upload = 1
               AND pao.verified = 0
               AND NOT EXISTS (
                 SELECT 1 FROM verified_objects AS vo
                 WHERE vo.project_id = pa.project_id
                   AND vo.content_hash = pao.content_hash
               )
             ORDER BY pao.content_hash ASC
             LIMIT ?`,
          )
          .bind(projectId, ownerId, now, attemptId, cursor, UPLOAD_CONTRACT_PAGE_SIZE + 1)
          .all<AttemptObjectRow>();

  const rows = result.results;
  const pageRows = rows.slice(0, UPLOAD_CONTRACT_PAGE_SIZE);
  const hasMore = rows.length > UPLOAD_CONTRACT_PAGE_SIZE;
  const contracts: UploadContract[] = [];

  for (const row of pageRows) {
    const metadata = transport.get(row.contentHash);
    if (metadata === undefined) {
      throw new UploadContractsError(
        "missing_transport_metadata",
        `No transport metadata was supplied for ${row.contentHash}`,
      );
    }

    let uploadUrl: string;
    try {
      uploadUrl = await input.signer.signUpload({
        key: contentKey(projectId, row.contentHash),
        contentType: metadata.contentType,
        contentMd5: metadata.contentMd5,
      });
    } catch (cause) {
      if (cause instanceof UploadContractsError) {
        throw cause;
      }
      throw new UploadContractsError(
        "upload_signer_unavailable",
        cause instanceof Error ? cause.message : "Upload URL signing failed",
        503,
      );
    }
    if (typeof uploadUrl !== "string" || uploadUrl.length === 0) {
      throw new UploadContractsError(
        "upload_signer_unavailable",
        "Upload URL signer returned an empty URL",
        503,
      );
    }

    contracts.push({
      contentHash: row.contentHash,
      key: contentKey(projectId, row.contentHash),
      sizeBytes: row.sizeBytes,
      contentType: metadata.contentType,
      contentMd5: metadata.contentMd5,
      uploadUrl,
    });
  }

  // Do not return a successful page after a concurrent expiry/abandon/commit.
  await assertAttemptStillOpen(input.database, ownerId, projectId, attemptId, now);

  const nextCursor = hasMore ? contracts.at(-1)?.contentHash : undefined;
  return {
    attemptId,
    projectId,
    pageSize: UPLOAD_CONTRACT_PAGE_SIZE,
    ...(cursor === undefined ? {} : { cursor }),
    ...(nextCursor === undefined ? {} : { nextCursor }),
    hasMore,
    contracts,
  };
}

/** Refresh only hashes still absent from the project-scoped inventory. */
export async function refreshUploadContracts(
  input: IssueUploadContractsInput,
): Promise<UploadContractPage> {
  return issueUploadContracts(input);
}

/** Descriptive aliases for prepare and client integrations. */
export const issueUploadContractPage = issueUploadContracts;
export const issueUploadContractsPage = issueUploadContracts;
export const refreshContracts = refreshUploadContracts;
export const getUploadContracts = issueUploadContracts;

export interface UploadVerificationRequest {
  readonly contentHash?: unknown;
  readonly sha256?: unknown;
  readonly hash?: unknown;
  readonly expectedSize?: unknown;
  readonly sizeBytes?: unknown;
  readonly size?: unknown;
  readonly expectedMd5?: unknown;
  readonly contentMd5?: unknown;
  readonly md5?: unknown;
}

interface NormalizedVerificationRequest {
  readonly contentHash: string;
  readonly expectedSize?: number;
  readonly expectedMd5?: Md5Value;
}

function isMd5Value(value: unknown): value is Md5Value {
  return typeof value === "string" || value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

function normalizeVerificationRequest(value: unknown): NormalizedVerificationRequest {
  if (!isRecord(value)) {
    throw new UploadContractsError("invalid_request", "Each verification item must be an object");
  }
  const contentHash = requireContentHash(field(value, "contentHash", "sha256", "hash"));
  const expectedSizeValue = field(value, "expectedSize", "sizeBytes", "size");
  let expectedSize: number | undefined;
  if (expectedSizeValue !== undefined) {
    if (!Number.isSafeInteger(expectedSizeValue) || (expectedSizeValue as number) < 0) {
      throw new UploadContractsError(
        "invalid_request",
        `expectedSize for ${contentHash} must be a non-negative integer`,
      );
    }
    expectedSize = expectedSizeValue as number;
  }

  const expectedMd5Value = field(value, "expectedMd5", "contentMd5", "md5");
  if (expectedMd5Value !== undefined && !isMd5Value(expectedMd5Value)) {
    throw new UploadContractsError(
      "invalid_request",
      `expectedMd5 for ${contentHash} must be a string or byte array`,
    );
  }

  return {
    contentHash,
    ...(expectedSize === undefined ? {} : { expectedSize }),
    ...(expectedMd5Value === undefined ? {} : { expectedMd5: expectedMd5Value }),
  };
}

function normalizeVerificationRequests(value: unknown): NormalizedVerificationRequest[] {
  if (!Array.isArray(value)) {
    throw new UploadContractsError("invalid_request", "Verification items must be an array");
  }
  if (value.length > MAX_VERIFICATION_BATCH_SIZE) {
    throw new UploadContractsError(
      "verification_batch_too_large",
      `Verification batch cannot exceed ${MAX_VERIFICATION_BATCH_SIZE} objects`,
    );
  }

  const requests: NormalizedVerificationRequest[] = [];
  const hashes = new Set<string>();
  for (const item of value) {
    const request = normalizeVerificationRequest(item);
    if (hashes.has(request.contentHash)) {
      throw new UploadContractsError(
        "invalid_request",
        `Verification batch repeats ${request.contentHash}`,
      );
    }
    hashes.add(request.contentHash);
    requests.push(request);
  }
  return requests;
}

export interface VerifyUploadBatchInput {
  readonly database: D1Database;
  readonly bucket: ReadOnlyR2Bucket;
  /** May be an opaque owner ID or the machine-auth context itself. */
  readonly ownerId: string | { readonly userId: string };
  readonly projectId: string;
  readonly attemptId: string;
  readonly requests: readonly UploadVerificationRequest[] | unknown;
  readonly now?: number;
}

export type UploadVerificationFailureReason =
  | "content_not_in_attempt"
  | "content_size_mismatch"
  | "inventory_missing"
  | "missing"
  | "size_mismatch"
  | "md5_mismatch";

export interface UploadVerificationResult {
  readonly contentHash: string;
  readonly expectedSize?: number;
  readonly actualSize?: number;
  readonly exists?: boolean;
  readonly md5Available?: boolean;
  readonly md5Matches?: boolean;
  readonly verified: boolean;
  readonly alreadyVerified?: boolean;
  readonly reason?: UploadVerificationFailureReason;
}

export interface UploadVerificationBatchResult {
  readonly attemptId: string;
  readonly projectId: string;
  readonly results: readonly UploadVerificationResult[];
  readonly verifiedCount: number;
  readonly rejectedCount: number;
  readonly ok: boolean;
}

async function getInventory(
  database: D1Database,
  projectId: string,
  contentHash: string,
): Promise<InventoryRow | null> {
  return database
    .prepare(
      `SELECT project_id AS projectId, content_hash AS contentHash,
              size_bytes AS sizeBytes
       FROM verified_objects
       WHERE project_id = ? AND content_hash = ?`,
    )
    .bind(projectId, contentHash)
    .first<InventoryRow>();
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Error && /unique|constraint failed/i.test(error.message);
}

async function getAttemptObject(
  database: D1Database,
  ownerId: string,
  projectId: string,
  attemptId: string,
  contentHash: string,
): Promise<AttemptObjectRow | null> {
  return database
    .prepare(
      `SELECT pao.content_hash AS contentHash, pao.size_bytes AS sizeBytes,
              pao.requires_upload AS requiresUpload, pao.verified
       FROM publication_attempt_objects AS pao
       INNER JOIN publication_attempts AS pa
         ON pa.id = pao.attempt_id
        AND pa.project_id = ? AND pa.user_id = ?
       WHERE pao.attempt_id = ? AND pao.content_hash = ?`,
    )
    .bind(projectId, ownerId, attemptId, contentHash)
    .first<AttemptObjectRow>();
}

async function persistNewlyVerifiedObject(
  database: D1Database,
  ownerId: string,
  projectId: string,
  attemptId: string,
  contentHash: string,
  sizeBytes: number,
  now: number,
): Promise<void> {
  // Keep insertion and the reservation movement in one D1 transaction. The
  // conflict-free branch is the only branch allowed to move physical bytes.
  try {
    await executeGuardedBatch(database, [
      {
        name: "record verified object",
        statement: database
          .prepare(
            `INSERT INTO verified_objects (project_id, content_hash, size_bytes, verified_at)
             VALUES (?, ?, ?, ?)`,
          )
          .bind(projectId, contentHash, sizeBytes, now),
        expectedChanges: 1,
      },
      {
        name: "mark upload object verified",
        statement: database
          .prepare(
            `UPDATE publication_attempt_objects
             SET verified = 1
             WHERE attempt_id = ? AND content_hash = ?
               AND requires_upload = 1 AND verified = 0
               AND EXISTS (
                 SELECT 1 FROM publication_attempts
                 WHERE id = ? AND project_id = ? AND user_id = ?
                   AND state = 'open' AND expires_at > ?
               )
               AND EXISTS (
                 SELECT 1 FROM verified_objects
                 WHERE project_id = ? AND content_hash = ? AND size_bytes = ?
               )`,
          )
          .bind(
            attemptId,
            contentHash,
            attemptId,
            projectId,
            ownerId,
            now,
            projectId,
            contentHash,
            sizeBytes,
          ),
        expectedChanges: 1,
      },
      {
        name: "settle attempt physical reservation",
        statement: database
          .prepare(
            `UPDATE publication_attempts
             SET reserved_physical_upload_bytes = reserved_physical_upload_bytes - ?
             WHERE id = ? AND project_id = ? AND user_id = ?
               AND state = 'open' AND expires_at > ?
               AND reserved_physical_upload_bytes >= ?`,
          )
          .bind(sizeBytes, attemptId, projectId, ownerId, now, sizeBytes),
        expectedChanges: 1,
      },
      {
        name: "move owner physical reservation to retained bytes",
        statement: database
          .prepare(
            `UPDATE user
             SET reserved_physical_upload_bytes = reserved_physical_upload_bytes - ?,
                 retained_staged_physical_bytes = retained_staged_physical_bytes + ?
             WHERE id = ? AND reserved_physical_upload_bytes >= ?`,
          )
          .bind(sizeBytes, sizeBytes, ownerId, sizeBytes),
        expectedChanges: 1,
      },
    ]);
  } catch (cause) {
    if (!isUniqueConstraintViolation(cause)) {
      throw cause;
    }

    // Another request may have inserted the same immutable inventory row. No
    // retained bytes are added in this branch; release this attempt's upload
    // reservation as reuse after checking the immutable size.
    const existing = await getInventory(database, projectId, contentHash);
    if (existing === null || existing.sizeBytes !== sizeBytes) {
      throw new UploadContractsError(
        "inventory_size_conflict",
        `Verified inventory has an unexpected size for ${contentHash}`,
        500,
      );
    }
    await persistReusedObject(
      database,
      ownerId,
      projectId,
      attemptId,
      contentHash,
      sizeBytes,
      true,
      now,
    );
  }
}

async function persistReusedObject(
  database: D1Database,
  ownerId: string,
  projectId: string,
  attemptId: string,
  contentHash: string,
  sizeBytes: number,
  attemptWasPending: boolean,
  now: number,
): Promise<void> {
  if (!attemptWasPending) {
    return;
  }

  try {
    // Marking the attempt object and releasing both reservation counters are
    // one guarded transaction. A zero-row mark means another verifier won;
    // the whole batch rolls back and is then safely treated as idempotent.
    await executeGuardedBatch(database, [
      {
        name: "mark reused upload object verified",
        statement: database
          .prepare(
            `UPDATE publication_attempt_objects
             SET verified = 1
             WHERE attempt_id = ? AND content_hash = ?
               AND requires_upload = 1 AND verified = 0
               AND EXISTS (
                 SELECT 1 FROM publication_attempts
                 WHERE id = ? AND project_id = ? AND user_id = ?
                   AND state = 'open' AND expires_at > ?
               )
               AND EXISTS (
                 SELECT 1 FROM verified_objects
                 WHERE project_id = ? AND content_hash = ? AND size_bytes = ?
               )`,
          )
          .bind(
            attemptId,
            contentHash,
            attemptId,
            projectId,
            ownerId,
            now,
            projectId,
            contentHash,
            sizeBytes,
          ),
        expectedChanges: 1,
      },
      {
        name: "release reused attempt physical reservation",
        statement: database
          .prepare(
            `UPDATE publication_attempts
             SET reserved_physical_upload_bytes = reserved_physical_upload_bytes - ?
             WHERE id = ? AND project_id = ? AND user_id = ?
               AND state = 'open' AND expires_at > ?
               AND reserved_physical_upload_bytes >= ?`,
          )
          .bind(sizeBytes, attemptId, projectId, ownerId, now, sizeBytes),
        expectedChanges: 1,
      },
      {
        name: "release owner reused physical reservation",
        statement: database
          .prepare(
            `UPDATE user
             SET reserved_physical_upload_bytes = reserved_physical_upload_bytes - ?
             WHERE id = ? AND reserved_physical_upload_bytes >= ?`,
          )
          .bind(sizeBytes, ownerId, sizeBytes),
        expectedChanges: 1,
      },
    ]);
  } catch (cause) {
    if (!(cause instanceof GuardedBatchError)) {
      throw cause;
    }
    const current = await getAttemptObject(database, ownerId, projectId, attemptId, contentHash);
    if (current?.verified !== 1) {
      throw cause;
    }
  }
}

function resultFromR2(
  request: NormalizedVerificationRequest,
  result: Awaited<ReturnType<typeof verifyR2Objects>>[number],
): UploadVerificationResult {
  return {
    contentHash: request.contentHash,
    expectedSize: request.expectedSize,
    ...(result.actualSize === undefined ? {} : { actualSize: result.actualSize }),
    exists: result.exists,
    md5Available: result.md5Available,
    ...(result.md5Matches === undefined ? {} : { md5Matches: result.md5Matches }),
    verified: result.verified,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
  };
}

/**
 * Verify one bounded batch with the storage helper and settle only successful
 * objects into the project-scoped D1 inventory. Commit can therefore use D1
 * alone for completeness and never needs an R2 listing/sweep.
 */
export async function verifyUploadBatch(
  input: VerifyUploadBatchInput,
): Promise<UploadVerificationBatchResult> {
  const ownerId = requireOwnerId(input.ownerId);
  const projectId = requireNonEmptyString("projectId", input.projectId);
  const attemptId = requireNonEmptyString("attemptId", input.attemptId);
  const now = requireNow(input.now);
  const requests = normalizeVerificationRequests(input.requests);
  await getAttempt(input.database, ownerId, projectId, attemptId, now);

  if (requests.length === 0) {
    return { attemptId, projectId, results: [], verifiedCount: 0, rejectedCount: 0, ok: true };
  }

  const placeholders = requests.map(() => "?").join(", ");
  const attemptRows = await input.database
    .prepare(
      `SELECT content_hash AS contentHash, size_bytes AS sizeBytes,
              requires_upload AS requiresUpload, verified
       FROM publication_attempt_objects
       WHERE attempt_id = ? AND content_hash IN (${placeholders})`,
    )
    .bind(attemptId, ...requests.map((request) => request.contentHash))
    .all<AttemptObjectRow>();
  const attemptObjects = new Map(attemptRows.results.map((row) => [row.contentHash, row]));

  const resultsByHash = new Map<string, UploadVerificationResult>();
  const r2Requests: R2ObjectVerificationRequest[] = [];
  const pendingRequests: NormalizedVerificationRequest[] = [];
  const pendingRows: AttemptObjectRow[] = [];

  for (const request of requests) {
    const attemptObject = attemptObjects.get(request.contentHash);
    if (attemptObject === undefined) {
      resultsByHash.set(request.contentHash, {
        contentHash: request.contentHash,
        verified: false,
        reason: "content_not_in_attempt",
      });
      continue;
    }

    if (request.expectedSize !== undefined && request.expectedSize !== attemptObject.sizeBytes) {
      resultsByHash.set(request.contentHash, {
        contentHash: request.contentHash,
        expectedSize: attemptObject.sizeBytes,
        actualSize: request.expectedSize,
        verified: false,
        reason: "content_size_mismatch",
      });
      continue;
    }

    const inventory = await getInventory(input.database, projectId, request.contentHash);
    if (inventory !== null) {
      if (inventory.sizeBytes !== attemptObject.sizeBytes) {
        throw new UploadContractsError(
          "inventory_size_conflict",
          `Verified inventory has an unexpected size for ${request.contentHash}`,
          500,
        );
      }
      if (attemptObject.verified === 1 || attemptObject.requiresUpload === 0) {
        resultsByHash.set(request.contentHash, {
          contentHash: request.contentHash,
          expectedSize: attemptObject.sizeBytes,
          verified: true,
          alreadyVerified: true,
        });
        continue;
      }

      await persistReusedObject(
        input.database,
        ownerId,
        projectId,
        attemptId,
        request.contentHash,
        attemptObject.sizeBytes,
        true,
        now,
      );
      resultsByHash.set(request.contentHash, {
        contentHash: request.contentHash,
        expectedSize: attemptObject.sizeBytes,
        verified: true,
        alreadyVerified: true,
      });
      continue;
    }

    if (attemptObject.verified === 1 || attemptObject.requiresUpload === 0) {
      resultsByHash.set(request.contentHash, {
        contentHash: request.contentHash,
        expectedSize: attemptObject.sizeBytes,
        verified: false,
        reason: "inventory_missing",
      });
      continue;
    }

    const verificationRequest: R2ObjectVerificationRequest = {
      key: contentKey(projectId, request.contentHash),
      expectedSize: attemptObject.sizeBytes,
      ...(request.expectedMd5 === undefined ? {} : { expectedMd5: request.expectedMd5 }),
    };
    r2Requests.push(verificationRequest);
    pendingRequests.push(request);
    pendingRows.push(attemptObject);
  }

  let r2Results: Awaited<ReturnType<typeof verifyR2Objects>>;
  try {
    r2Results = await verifyR2Objects(input.bucket, r2Requests);
  } catch (cause) {
    if (!(cause instanceof TypeError) && !(cause instanceof RangeError)) {
      throw cause;
    }
    throw new UploadContractsError(
      "invalid_request",
      cause instanceof Error ? cause.message : "R2 verification request was invalid",
    );
  }
  for (const [index, r2Result] of r2Results.entries()) {
    const request = pendingRequests[index];
    const row = pendingRows[index];
    if (request === undefined || row === undefined) {
      throw new UploadContractsError(
        "verification_invariant",
        "R2 verification result count did not match the request batch",
        500,
      );
    }

    const mapped = resultFromR2({ ...request, expectedSize: row.sizeBytes }, r2Result);
    if (mapped.verified) {
      await persistNewlyVerifiedObject(
        input.database,
        ownerId,
        projectId,
        attemptId,
        request.contentHash,
        row.sizeBytes,
        now,
      );
    }
    resultsByHash.set(request.contentHash, mapped);
  }

  await assertAttemptStillOpen(input.database, ownerId, projectId, attemptId, now);
  const results = requests.map((request) => {
    const result = resultsByHash.get(request.contentHash);
    if (result === undefined) {
      throw new UploadContractsError(
        "verification_invariant",
        `No verification result was produced for ${request.contentHash}`,
        500,
      );
    }
    return result;
  });
  const verifiedCount = results.filter((result) => result.verified).length;
  return {
    attemptId,
    projectId,
    results,
    verifiedCount,
    rejectedCount: results.length - verifiedCount,
    ok: verifiedCount === results.length,
  };
}

/** Descriptive aliases for client and commit integrations. */
export const verifyUploadObjects = verifyUploadBatch;
export const verifyUploadCompletion = verifyUploadBatch;
export const verifyUploadCompletionBatch = verifyUploadBatch;
export const verifyPublicationObjects = verifyUploadBatch;

/** Map a storage helper result to a stable public rejection reason. */
export function verificationReason(
  result: Awaited<ReturnType<typeof verifyR2Objects>>[number],
): UploadVerificationFailureReason | undefined {
  return result.reason;
}
