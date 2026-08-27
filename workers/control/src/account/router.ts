import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { SESSION_AUTH_CONTEXT_KEY, type SessionAuthVariables } from "../auth/session-auth.js";
import { readBoundedJsonRequest, RequestBodyError } from "../http/request-body.js";
import { claimHandle, HandleClaimError } from "./handle.js";
import { getAccountProfile } from "./queries.js";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;
export const MAX_HANDLE_CLAIM_REQUEST_BYTES = 4 * 1024;

type AccountRouteEnv = {
  Bindings: ControlEnv;
  Variables: SessionAuthVariables;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function handleFromBody(value: unknown): unknown {
  return isRecord(value) && "handle" in value ? value.handle : undefined;
}

function hasHandleField(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && "handle" in value;
}

function handleErrorResponse(context: Context<AccountRouteEnv>, error: HandleClaimError) {
  return context.json(
    {
      error: error.code,
      ...(error.reason === undefined ? {} : { reason: error.reason }),
    },
    error.status as ContentfulStatusCode,
    NO_STORE_HEADERS,
  );
}

/** Session-authenticated own-account routes; unmatched paths stay stable. */
export const accountRouter = new Hono<AccountRouteEnv>();

accountRouter.get("/me", async (context) => {
  const owner = context.get(SESSION_AUTH_CONTEXT_KEY);
  if (owner === undefined || owner === null) {
    return context.json({ error: "session_authentication_required" }, 401, NO_STORE_HEADERS);
  }
  const profile = await getAccountProfile(context.env.DB, owner.userId);
  if (profile === null) {
    return context.json({ error: "account_not_found" }, 404, NO_STORE_HEADERS);
  }
  return context.json(profile, 200, NO_STORE_HEADERS);
});

accountRouter.post("/handle", async (context) => {
  const owner = context.get(SESSION_AUTH_CONTEXT_KEY);
  if (owner === undefined || owner === null) {
    return context.json({ error: "session_authentication_required" }, 401, NO_STORE_HEADERS);
  }
  let body: unknown;
  try {
    body = await readBoundedJsonRequest(context.req.raw, MAX_HANDLE_CLAIM_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return context.json(
        { error: error.reason === "body_too_large" ? "request_body_too_large" : "invalid_json" },
        error.status,
        NO_STORE_HEADERS,
      );
    }
    return context.json({ error: "invalid_json" }, 400, NO_STORE_HEADERS);
  }
  if (!hasHandleField(body)) {
    return context.json({ error: "invalid_request" }, 400, NO_STORE_HEADERS);
  }

  try {
    const profile = await claimHandle(context.env.DB, owner, handleFromBody(body));
    return context.json(profile, 200, NO_STORE_HEADERS);
  } catch (error) {
    if (error instanceof HandleClaimError) return handleErrorResponse(context, error);
    return context.json({ error: "handle_claim_failed" }, 500, NO_STORE_HEADERS);
  }
});

accountRouter.all("*", (context) =>
  context.json({ error: "route_not_implemented" }, 404, NO_STORE_HEADERS),
);
