import {
  MACHINE_TOKEN_PREFIX,
  MACHINE_TOKEN_WIRE_PREFIX,
  hashMachineToken,
  parseMachineToken,
  type MachineTokenRejectionReason,
} from "@zudo-ez-host/core";
import type { MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";

import { createControlDatabase } from "../db/database.js";
import { getMachineByCredentialHash } from "../db/queries.js";

/** The Hono context variable containing the authenticated machine owner. */
export const MACHINE_AUTH_CONTEXT_KEY = "machineAuth" as const;

/** The only scope granted by a machine credential in V1. */
export const MACHINE_AUTH_SCOPE = "project_publish" as const;

/**
 * Machine credentials are limited to project and publish operations. Account
 * and credential-management routes remain browser-session-only. See the
 * identity ADR and `doc/src/content/docs/sync/mac-client.mdx`.
 */
export const MACHINE_AUTH_PUBLISH_PATH = "/api/projects/:projectId/publish/*" as const;

/** The owner identity downstream project and publication code may consume. */
export interface MachineAuthContext {
  readonly userId: string;
  readonly machineId: string;
}

export interface MachineAuthVariables {
  readonly [MACHINE_AUTH_CONTEXT_KEY]: MachineAuthContext;
}

export interface MachineAuthEnv {
  readonly Bindings: ControlEnv;
  readonly Variables: MachineAuthVariables;
}

/** Stable reasons returned by the HTTP machine-auth boundary. */
export type MachineAuthRejectionReason =
  | "missing_authorization"
  | "malformed_authorization"
  | "malformed_token"
  | "unknown_credential"
  | "revoked_credential"
  | "expired_credential";

export interface MachineAuthError {
  readonly error: "machine_authentication_failed";
  readonly reason: MachineAuthRejectionReason;
  /** The core parser reason, present only when `reason` is `malformed_token`. */
  readonly tokenReason?: MachineTokenRejectionReason;
}

export type MachineAuthResult =
  | { readonly ok: true; readonly value: MachineAuthContext }
  | { readonly ok: false; readonly error: MachineAuthError };

export interface MachineAuthMiddlewareOptions {
  /** Injected clock used by tests; production uses the Worker clock. */
  readonly now?: () => number;
}

type AuthorizationResult =
  | { readonly ok: true; readonly token: string }
  | { readonly ok: false; readonly reason: "missing_authorization" | "malformed_authorization" };

function errorResult(
  reason: MachineAuthRejectionReason,
  tokenReason?: MachineTokenRejectionReason,
): MachineAuthResult {
  return {
    ok: false,
    error: {
      error: "machine_authentication_failed",
      reason,
      ...(tokenReason === undefined ? {} : { tokenReason }),
    },
  };
}

function parseAuthorization(request: Request): AuthorizationResult {
  const header = request.headers.get("Authorization");
  if (header === null) {
    return { ok: false, reason: "missing_authorization" };
  }

  // Authentication schemes are case-insensitive, but the separator is exact:
  // accepting arbitrary whitespace or multiple credentials makes the boundary
  // ambiguous and can disagree with an upstream proxy.
  const separator = header.slice(0, "Bearer ".length);
  if (separator.toLowerCase() !== "bearer ") {
    return { ok: false, reason: "malformed_authorization" };
  }

  const token = header.slice("Bearer ".length);
  if (token.length === 0 || /\s/u.test(token)) {
    return { ok: false, reason: "malformed_authorization" };
  }

  return { ok: true, token };
}

/**
 * Authenticate one raw machine credential against the control D1 database.
 *
 * The token is parsed and hashed in request memory only. The database stores
 * and receives the digest, never the bearer value itself. The returned context
 * intentionally contains no request-owned project, handle, or credential
 * data; all identity fields come from the machine row.
 */
export async function authenticateMachineToken(
  token: unknown,
  binding: D1Database,
  now = Date.now(),
): Promise<MachineAuthResult> {
  if (typeof token !== "string") {
    return errorResult("malformed_token", "not_string");
  }

  const parsed = parseMachineToken(token);
  if (!parsed.ok) {
    return errorResult("malformed_token", parsed.reason);
  }

  // Hash the complete wire value, including the non-secret family prefix and
  // version. Looking up only the random suffix would authenticate a different
  // representation of the same bytes.
  const credentialHashSha256 = await hashMachineToken(token);
  const database = createControlDatabase(binding);
  const machine = await getMachineByCredentialHash(database, credentialHashSha256);

  if (machine === undefined) {
    return errorResult("unknown_credential");
  }

  // The digest lookup identifies the row, while the non-secret version keeps a
  // row minted for another credential version from being accepted here. Both
  // prefix representations exist in schema fixtures: the family prefix is
  // the core metadata value, while older rows record the exact wire prefix.
  if (
    machine.credentialVersion !== parsed.value.version ||
    (machine.credentialPrefix !== MACHINE_TOKEN_PREFIX &&
      machine.credentialPrefix !== MACHINE_TOKEN_WIRE_PREFIX)
  ) {
    return errorResult("unknown_credential");
  }

  if (machine.revoked) {
    return errorResult("revoked_credential");
  }

  if (now >= machine.expiresAt) {
    return errorResult("expired_credential");
  }

  return {
    ok: true,
    value: {
      userId: machine.userId,
      machineId: machine.id,
    },
  };
}

/** Authenticate the complete HTTP bearer boundary without falling back to cookies. */
export async function authenticateMachineRequest(
  request: Request,
  binding: D1Database,
  now = Date.now(),
): Promise<MachineAuthResult> {
  const authorization = parseAuthorization(request);
  if (!authorization.ok) return errorResult(authorization.reason);
  return authenticateMachineToken(authorization.token, binding, now);
}

function unauthorizedResponse(
  context: Parameters<MiddlewareHandler<MachineAuthEnv>>[0],
  error: MachineAuthError,
): Response {
  return context.json(error, 401, {
    "Cache-Control": "no-store",
    "WWW-Authenticate": "Bearer",
  });
}

/** Create the publish-scoped middleware, optionally with a deterministic clock. */
export function createMachineAuthMiddleware(
  options: MachineAuthMiddlewareOptions = {},
): MiddlewareHandler<MachineAuthEnv> {
  const now = options.now ?? (() => Date.now());

  return createMiddleware<MachineAuthEnv>(async (context, next) => {
    const result = await authenticateMachineRequest(context.req.raw, context.env.DB, now());
    if (!result.ok) {
      return unauthorizedResponse(context, result.error);
    }

    context.set(MACHINE_AUTH_CONTEXT_KEY, result.value);
    await next();
  });
}

/** The production middleware used by the publish route mount. */
export const machineAuthMiddleware = createMachineAuthMiddleware();
