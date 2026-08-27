import type { MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";

import { createAuth, type AuthRuntimeEnv } from "./better-auth.js";

export const SESSION_AUTH_CONTEXT_KEY = "sessionAuth" as const;

/** The owner identity exposed by the browser-session boundary. */
export interface SessionAuthContext {
  readonly userId: string;
}

export interface SessionAuthVariables {
  readonly [SESSION_AUTH_CONTEXT_KEY]: SessionAuthContext;
}

export interface SessionAuthEnv {
  readonly Bindings: AuthRuntimeEnv;
  readonly Variables: SessionAuthVariables;
}

/** Resolve the browser cookie boundary without attaching framework context. */
export async function authenticateSession(
  request: Request,
  env: AuthRuntimeEnv,
): Promise<SessionAuthContext | null> {
  const session = await createAuth(env).api.getSession({ headers: request.headers });
  return session === null ? null : { userId: session.user.id };
}

/** Resolve a Better Auth session and expose only the opaque owner ID. */
export const sessionAuthMiddleware: MiddlewareHandler<SessionAuthEnv> = createMiddleware(
  async (context, next) => {
    const session = await authenticateSession(context.req.raw, context.env);
    if (session === null) {
      return context.json({ error: "session_authentication_required" }, 401, {
        "Cache-Control": "no-store",
      });
    }

    context.set(SESSION_AUTH_CONTEXT_KEY, session);
    await next();
  },
);
