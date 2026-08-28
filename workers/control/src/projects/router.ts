import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";

import {
  authenticateMachineRequest,
  authenticateSession,
  exactControlCorsMiddleware,
  hasExactTrustedOrigin,
  type MachineAuthError,
} from "../auth/index.js";
import { createControlDatabase } from "../db/database.js";
import { getOwnedProject } from "../db/queries.js";
import { readBoundedJsonRequest, RequestBodyError } from "../http/request-body.js";
import { listOwnedProjects, toOwnedProjectVisibility } from "./queries.js";
import {
  ProjectRegistrationError,
  registerProject,
  type ProjectOwnerContext,
  type ProjectRegistrationInput,
} from "./registration.js";

export const PROJECT_AUTH_CONTEXT_KEY = "projectAuth" as const;
export const AUTHENTICATED_OWNER_CONTEXT = PROJECT_AUTH_CONTEXT_KEY;
export const MAX_PROJECT_REGISTRATION_REQUEST_BYTES = 64 * 1024;

const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

export interface ProjectRouteVariables {
  readonly [PROJECT_AUTH_CONTEXT_KEY]: ProjectOwnerContext;
}

type ProjectRouteEnv = {
  Bindings: ControlEnv;
  Variables: ProjectRouteVariables;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseRegistrationInput(value: unknown): ProjectRegistrationInput | null {
  if (!isRecord(value) || !("slug" in value)) return null;
  return {
    slug: value.slug,
    displayName: value.displayName,
    description: value.description,
  };
}

function machineUnauthorized(
  context: Parameters<MiddlewareHandler<ProjectRouteEnv>>[0],
  error: MachineAuthError,
) {
  return context.json(error, 401, {
    "Cache-Control": "no-store",
    "WWW-Authenticate": "Bearer",
  });
}

/** Select exactly one authority: an explicit bearer credential, otherwise a session. */
const projectAuthMiddleware: MiddlewareHandler<ProjectRouteEnv> = createMiddleware(
  async (context, next) => {
    if (context.req.header("authorization") !== undefined) {
      const result = await authenticateMachineRequest(context.req.raw, context.env.DB);
      if (!result.ok) return machineUnauthorized(context, result.error);
      context.set(PROJECT_AUTH_CONTEXT_KEY, { userId: result.value.userId });
      await next();
      return;
    }

    if (
      context.req.method !== "GET" &&
      context.req.method !== "HEAD" &&
      !hasExactTrustedOrigin(context.req.raw, context.env.BETTER_AUTH_TRUSTED_ORIGINS)
    ) {
      return context.json({ error: "invalid_origin" }, 403, NO_STORE_HEADERS);
    }

    const session = await authenticateSession(context.req.raw, context.env);
    if (session === null) {
      return context.json({ error: "session_authentication_required" }, 401, NO_STORE_HEADERS);
    }
    context.set(PROJECT_AUTH_CONTEXT_KEY, session);
    await next();
  },
);

const router = new Hono<ProjectRouteEnv>();

router.get("/", exactControlCorsMiddleware, async (context) => {
  const session = await authenticateSession(context.req.raw, context.env);
  if (session === null) {
    return context.json({ error: "session_authentication_required" }, 401, NO_STORE_HEADERS);
  }
  const projects = await listOwnedProjects(
    context.env.DB,
    session.userId,
    context.env.PUBLIC_CONTENT_DOMAIN,
  );
  return context.json({ projects }, 200, NO_STORE_HEADERS);
});

router.post("/", exactControlCorsMiddleware, projectAuthMiddleware, async (context) => {
  const owner = context.get(PROJECT_AUTH_CONTEXT_KEY);

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
        error.code === "owner_not_found" || error.code === "invalid_owner_context"
          ? 401
          : error.code === "owner_handle_unclaimed"
            ? 409
            : 400,
        NO_STORE_HEADERS,
      );
    }
    return context.json({ error: "project_registration_failed" }, 500, NO_STORE_HEADERS);
  }
});

router.get("/:projectId", exactControlCorsMiddleware, projectAuthMiddleware, async (context) => {
  const owner = context.get(PROJECT_AUTH_CONTEXT_KEY);
  const project = await getOwnedProject(
    createControlDatabase(context.env.DB),
    owner.userId,
    context.req.param("projectId"),
  );
  if (project === undefined) {
    return context.json({ error: "project_not_found" }, 404, NO_STORE_HEADERS);
  }
  return context.json(
    { project: toOwnedProjectVisibility(project, context.env.PUBLIC_CONTENT_DOMAIN) },
    200,
    NO_STORE_HEADERS,
  );
});

export const projectsRouter = router;
