import { Hono } from "hono";
import type { Context } from "hono";

import {
  SESSION_AUTH_CONTEXT_KEY,
  type SessionAuthContext,
  type SessionAuthEnv,
} from "../auth/index.js";
import { readBoundedJsonRequest, RequestBodyError } from "../http/request-body.js";
import {
  getOwnedMachine,
  listOwnedMachines,
  renameOwnedMachine,
  revokeOwnedMachine,
} from "./queries.js";

/** Keep machine-management request bodies small and bounded. */
export const MAX_MACHINE_RENAME_REQUEST_BYTES = 16 * 1024;

const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validMachineName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 100 &&
    !/^\s*$/u.test(value) &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

type MachineNameParseResult =
  | { readonly ok: true; readonly name: string }
  | {
      readonly ok: false;
      readonly error: "invalid_json" | "request_body_too_large" | "invalid_request";
      readonly status: 400 | 413;
    };

async function machineNameFromRequest(request: Request): Promise<MachineNameParseResult> {
  let body: unknown;
  try {
    body = await readBoundedJsonRequest(request, MAX_MACHINE_RENAME_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return {
        ok: false,
        error: error.reason === "body_too_large" ? "request_body_too_large" : "invalid_json",
        status: error.status,
      };
    }
    return { ok: false, error: "invalid_json", status: 400 };
  }

  if (!isRecord(body) || !validMachineName(body.name)) {
    return { ok: false, error: "invalid_request", status: 400 };
  }
  return { ok: true, name: body.name };
}

function sessionFromContext(context: Context<SessionAuthEnv>): SessionAuthContext | null {
  const session = context.get(SESSION_AUTH_CONTEXT_KEY);
  return session === undefined || session === null ? null : session;
}

/** Session-only machine management routes. */
const router = new Hono<SessionAuthEnv>();

router.get("/", async (context) => {
  const session = sessionFromContext(context);
  if (session === null) {
    return context.json({ error: "session_authentication_required" }, 401, NO_STORE_HEADERS);
  }
  const machines = await listOwnedMachines(context.env.DB, session.userId);
  return context.json({ machines }, 200, NO_STORE_HEADERS);
});

router.get("/:machineId", async (context) => {
  const session = sessionFromContext(context);
  if (session === null) {
    return context.json({ error: "session_authentication_required" }, 401, NO_STORE_HEADERS);
  }
  const machine = await getOwnedMachine(
    context.env.DB,
    session.userId,
    context.req.param("machineId"),
  );
  if (machine === undefined) {
    return context.json({ error: "machine_not_found" }, 404, NO_STORE_HEADERS);
  }
  return context.json({ machine }, 200, NO_STORE_HEADERS);
});

router.patch("/:machineId", async (context) => {
  const session = sessionFromContext(context);
  if (session === null) {
    return context.json({ error: "session_authentication_required" }, 401, NO_STORE_HEADERS);
  }
  const parsedName = await machineNameFromRequest(context.req.raw);
  if (!parsedName.ok)
    return context.json({ error: parsedName.error }, parsedName.status, NO_STORE_HEADERS);

  const machine = await renameOwnedMachine(
    context.env.DB,
    session.userId,
    context.req.param("machineId"),
    parsedName.name,
  );
  if (machine === undefined) {
    return context.json({ error: "machine_not_found" }, 404, NO_STORE_HEADERS);
  }
  return context.json({ machine }, 200, NO_STORE_HEADERS);
});

router.post("/:machineId/revoke", async (context) => {
  const session = sessionFromContext(context);
  if (session === null) {
    return context.json({ error: "session_authentication_required" }, 401, NO_STORE_HEADERS);
  }
  const machine = await revokeOwnedMachine(
    context.env.DB,
    session.userId,
    context.req.param("machineId"),
  );
  if (machine === undefined) {
    return context.json({ error: "machine_not_found" }, 404, NO_STORE_HEADERS);
  }
  return context.json({ machine }, 200, NO_STORE_HEADERS);
});

/** Preserve the stable empty-route behavior for future machine endpoints. */
router.all("*", (context) =>
  context.json({ error: "route_not_implemented" }, 404, NO_STORE_HEADERS),
);

export const machinesRouter = router;
