import { Hono } from "hono";

import { MACHINE_AUTH_CONTEXT_KEY, type MachineAuthContext } from "../auth/index.js";
import { readBoundedJsonRequest, RequestBodyError } from "../http/request-body.js";
import {
  ProjectRegistrationError,
  registerProject,
  type ProjectRegistrationInput,
} from "./registration.js";

export const AUTHENTICATED_OWNER_CONTEXT = MACHINE_AUTH_CONTEXT_KEY;
export const MAX_PROJECT_REGISTRATION_REQUEST_BYTES = 64 * 1024;

const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

export interface ProjectRouteVariables {
  /** Set by machine-auth middleware before this router is reached. */
  readonly [MACHINE_AUTH_CONTEXT_KEY]?: MachineAuthContext;
}

type ProjectRouteEnv = {
  Bindings: ControlEnv;
  Variables: ProjectRouteVariables;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseRegistrationInput(value: unknown): ProjectRegistrationInput | null {
  if (!isRecord(value) || !("slug" in value)) {
    return null;
  }
  return {
    slug: value.slug,
    displayName: value.displayName,
    description: value.description,
  };
}

export const projectsRouter = new Hono<ProjectRouteEnv>().post("/", async (context) => {
  const owner = context.get(MACHINE_AUTH_CONTEXT_KEY);
  if (owner === undefined || owner === null) {
    return context.json({ error: "machine_auth_required" }, 401, NO_STORE_HEADERS);
  }

  let body: unknown;
  try {
    body = await readBoundedJsonRequest(context.req.raw, MAX_PROJECT_REGISTRATION_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return context.json(
        { error: error.reason === "body_too_large" ? "request_body_too_large" : "invalid_json" },
        error.status,
        NO_STORE_HEADERS,
      );
    }
    return context.json({ error: "project_registration_failed" }, 500, NO_STORE_HEADERS);
  }
  const input = parseRegistrationInput(body);
  if (input === null) {
    return context.json({ error: "invalid_request" }, 400, NO_STORE_HEADERS);
  }

  try {
    const result = await registerProject(context.env.DB, owner, input);
    return context.json(
      {
        project: result.project,
        hostname: result.hostname.label,
        created: result.created,
      },
      result.created ? 201 : 200,
      NO_STORE_HEADERS,
    );
  } catch (error) {
    if (error instanceof ProjectRegistrationError) {
      if (error.code === "registration_invariant") {
        return context.json({ error: "project_registration_failed" }, 500, NO_STORE_HEADERS);
      }
      return context.json(
        { error: error.code, reason: error.reason },
        error.code === "owner_not_found" || error.code === "invalid_owner_context" ? 401 : 400,
        NO_STORE_HEADERS,
      );
    }
    return context.json({ error: "project_registration_failed" }, 500, NO_STORE_HEADERS);
  }
});
