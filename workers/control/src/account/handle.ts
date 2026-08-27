import { validateHandle, type HostnameValidationReason } from "@zudo-ez-host/core";

import { getAccountProfile, type AccountProfile } from "./queries.js";

export interface AccountOwnerContext {
  readonly userId: string;
}

export interface HandleClaimOptions {
  /** Injectable clock for deterministic tests; production defaults to Date.now. */
  readonly now?: number;
}

export type HandleClaimErrorCode =
  | "invalid_owner_context"
  | "owner_not_found"
  | "invalid_handle"
  | "handle_taken"
  | "handle_already_claimed";

const STATUS_BY_CODE: Readonly<Record<HandleClaimErrorCode, number>> = {
  invalid_owner_context: 401,
  owner_not_found: 401,
  invalid_handle: 400,
  handle_taken: 409,
  handle_already_claimed: 409,
};

export class HandleClaimError extends Error {
  readonly code: HandleClaimErrorCode;
  readonly status: number;
  readonly reason?: HostnameValidationReason;

  constructor(code: HandleClaimErrorCode, message: string, reason?: HostnameValidationReason) {
    super(message);
    this.name = "HandleClaimError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    if (reason !== undefined) this.reason = reason;
  }
}

function ownerIdFromContext(owner: AccountOwnerContext | string | null | undefined): string {
  if (typeof owner === "string" && owner.length > 0) return owner;
  if (
    owner !== null &&
    owner !== undefined &&
    typeof owner !== "string" &&
    typeof owner.userId === "string" &&
    owner.userId.length > 0
  ) {
    return owner.userId;
  }
  throw new HandleClaimError(
    "invalid_owner_context",
    "An authenticated owner context with a user ID is required",
  );
}

function handleInput(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  return "handle" in value ? value.handle : undefined;
}

function requireNow(value: number | undefined): number {
  const now = value ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new TypeError("Handle claim time must be a non-negative safe integer");
  }
  return now;
}

function isUniqueConstraintViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(unique|constraint)\b/i.test(message);
}

async function classifyRejectedClaim(database: D1Database, userId: string): Promise<never> {
  const owner = await getAccountProfile(database, userId);
  if (owner === null) {
    throw new HandleClaimError("owner_not_found", "Authenticated owner was not found");
  }
  if (owner.handle !== null) {
    throw new HandleClaimError(
      "handle_already_claimed",
      "A canonical handle can only be claimed once",
    );
  }

  // The conditional UPDATE is the authority. A zero-change result with an
  // unclaimed owner means the requested value lost the unique-index race.
  throw new HandleClaimError("handle_taken", "The requested handle is already taken");
}

/**
 * Atomically claim an owner's canonical handle.
 *
 * The `canonical_handle IS NULL` predicate makes claiming permanent, while
 * `user_canonical_handle_unique` is the database arbiter for cross-user races.
 * No read is used to decide whether a handle is available before the UPDATE.
 */
export async function claimHandle(
  database: D1Database,
  owner: AccountOwnerContext | string | null | undefined,
  input: unknown,
  options: HandleClaimOptions = {},
): Promise<AccountProfile> {
  const userId = ownerIdFromContext(owner);
  const parsed = validateHandle(handleInput(input));
  if (!parsed.ok) {
    throw new HandleClaimError("invalid_handle", "Handle is not valid", parsed.reason);
  }
  const now = requireNow(options.now);

  let result: D1Result;
  try {
    result = await database
      .prepare(
        `UPDATE user
         SET canonical_handle = ?, updated_at = ?
         WHERE id = ? AND canonical_handle IS NULL`,
      )
      .bind(parsed.value, now, userId)
      .run();
  } catch (error) {
    if (!isUniqueConstraintViolation(error)) throw error;
    return classifyRejectedClaim(database, userId);
  }

  if (result.meta.changes !== 1) {
    return classifyRejectedClaim(database, userId);
  }

  const profile = await getAccountProfile(database, userId);
  if (profile === null) {
    throw new Error("Claimed account disappeared after atomic handle update");
  }
  if (profile.handle !== parsed.value) {
    throw new Error("Claimed account returned an unexpected canonical handle");
  }
  return profile;
}

/** Explicit name for code that wants to emphasize the persisted column. */
export const claimCanonicalHandle = claimHandle;
