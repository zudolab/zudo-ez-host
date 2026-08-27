import { Hono } from "hono";

import {
  ProjectRegistrationError,
  registerProject,
  type ProjectOwnerContext,
  type ProjectRegistrationInput,
} from "./registration.js";

export const AUTHENTICATED_OWNER_CONTEXT = "authenticatedOwner" as const;

export interface ProjectRouteVariables {
  /** Set by machine-auth middleware before this router is reached. */
  authenticatedOwner?: ProjectOwnerContext;
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
  const owner = context.get(AUTHENTICATED_OWNER_CONTEXT);
  if (owner === undefined || owner === null) {
    return context.json({ error: "machine_auth_required" }, 401);
  }

  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    return context.json({ error: "invalid_json" }, 400);
  }
  const input = parseRegistrationInput(body);
  if (input === null) {
    return context.json({ error: "invalid_request" }, 400);
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
    );
  } catch (error) {
    if (error instanceof ProjectRegistrationError) {
      if (error.code === "registration_invariant") {
        return context.json({ error: "project_registration_failed" }, 500);
      }
      return context.json(
        { error: error.code, reason: error.reason },
        error.code === "owner_not_found" || error.code === "invalid_owner_context" ? 401 : 400,
      );
    }
    return context.json({ error: "project_registration_failed" }, 500);
  }
});
