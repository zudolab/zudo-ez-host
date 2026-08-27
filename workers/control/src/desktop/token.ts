import {
  MACHINE_TOKEN_PREFIX,
  MACHINE_TOKEN_VERSION,
  generateMachineToken,
  hashMachineToken,
} from "@zudo-ez-host/core";

import { verifyS256CodeChallenge } from "../auth/pkce.js";
import { readBoundedJsonRequest, RequestBodyError } from "../http/request-body.js";
import { getDesktopAuthorizationCodeByHash, redeemDesktopAuthorizationCode } from "./queries.js";
import { hashAuthorizationCode } from "./codes.js";

const MAX_TOKEN_REQUEST_BYTES = 16 * 1024;
const MACHINE_LIFETIME_MS = 365 * 24 * 60 * 60 * 1_000;

export interface DesktopTokenExchangeOptions {
  readonly now?: () => number;
}

type TokenExchangeError = "invalid_request" | "invalid_grant" | "server_error";

function errorResponse(error: TokenExchangeError, status: 400 | 500): Response {
  return Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function performDesktopTokenExchange(
  request: Request,
  database: D1Database,
  options: DesktopTokenExchangeOptions,
): Promise<Response> {
  let body: unknown;
  try {
    body = await readBoundedJsonRequest(request, MAX_TOKEN_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyError) return errorResponse("invalid_request", 400);
    throw error;
  }
  if (!isRecord(body)) return errorResponse("invalid_request", 400);

  const code = body.code;
  const codeVerifier = body.code_verifier;
  const redirectUri = body.redirect_uri;
  if (typeof code !== "string" || typeof redirectUri !== "string") {
    return errorResponse("invalid_request", 400);
  }

  const codeHash = await hashAuthorizationCode(code);
  const grant = await getDesktopAuthorizationCodeByHash(database, codeHash);
  const now = options.now?.() ?? Date.now();
  if (
    grant === null ||
    grant.consumedAt !== null ||
    grant.expiresAt <= now ||
    redirectUri !== grant.redirectUri ||
    !(await verifyS256CodeChallenge(codeVerifier, grant.codeChallenge))
  ) {
    return errorResponse("invalid_grant", 400);
  }

  const token = generateMachineToken();
  const expiresAt = now + MACHINE_LIFETIME_MS;
  const redeemed = await redeemDesktopAuthorizationCode(database, {
    codeHash,
    redirectUri,
    codeChallenge: grant.codeChallenge,
    credentialHashSha256: await hashMachineToken(token),
    credentialPrefix: MACHINE_TOKEN_PREFIX,
    credentialVersion: MACHINE_TOKEN_VERSION,
    redeemedAt: now,
    machineExpiresAt: expiresAt,
  });
  if (!redeemed) return errorResponse("invalid_grant", 400);

  return Response.json(
    {
      token,
      machine: { id: grant.machineId, name: grant.machineName, expiresAt },
    },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}

/** Exchange one PKCE-bound desktop authorization code without cookie authority. */
export async function exchangeDesktopToken(
  request: Request,
  database: D1Database,
  options: DesktopTokenExchangeOptions = {},
): Promise<Response> {
  try {
    return await performDesktopTokenExchange(request, database, options);
  } catch {
    return errorResponse("server_error", 500);
  }
}
