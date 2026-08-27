import type { MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { createMiddleware } from "hono/factory";

import type { AuthRuntimeEnv } from "./better-auth.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface OriginPolicyEnv {
  readonly Bindings: AuthRuntimeEnv;
}

/** Parse the deployment allowlist as exact serialized HTTP(S) origins. */
export function trustedControlOrigins(value: string | undefined): readonly string[] {
  const origins = (value ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (origins.length === 0) {
    throw new Error("BETTER_AUTH_TRUSTED_ORIGINS must contain at least one exact origin");
  }

  for (const origin of origins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error("BETTER_AUTH_TRUSTED_ORIGINS contains a malformed origin");
    }
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.origin !== origin ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      throw new Error("BETTER_AUTH_TRUSTED_ORIGINS must contain exact HTTP(S) origins");
    }
  }

  return [...new Set(origins)];
}

/** True only for one present, canonical Origin value in the deployment allowlist. */
export function hasExactTrustedOrigin(request: Request, configuredOrigins: string | undefined) {
  const origin = request.headers.get("Origin");
  if (origin === null || origin === "null" || origin.includes(",")) return false;
  return trustedControlOrigins(configuredOrigins).includes(origin);
}

/** Credentialed CORS with an exact, deployment-owned origin allowlist. */
export const exactControlCorsMiddleware: MiddlewareHandler<OriginPolicyEnv> = createMiddleware(
  async (context, next) => {
    const middleware = cors({
      origin: [...trustedControlOrigins(context.env.BETTER_AUTH_TRUSTED_ORIGINS)],
      credentials: true,
      allowMethods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    });
    return middleware(context, next);
  },
);

/**
 * Require an explicit trusted Origin for application cookie mutations.
 *
 * CORS must run before this middleware so a valid preflight can terminate
 * without being mistaken for an application mutation.
 */
export const requireTrustedOriginMiddleware: MiddlewareHandler<OriginPolicyEnv> = createMiddleware(
  async (context, next) => {
    if (
      !SAFE_METHODS.has(context.req.method) &&
      !hasExactTrustedOrigin(context.req.raw, context.env.BETTER_AUTH_TRUSTED_ORIGINS)
    ) {
      return context.json({ error: "invalid_origin" }, 403, { "Cache-Control": "no-store" });
    }
    await next();
  },
);
