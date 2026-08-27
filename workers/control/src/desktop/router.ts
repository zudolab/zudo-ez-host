import { Hono } from "hono";

import { authenticateSession } from "../auth/session-auth.js";
import {
  DesktopAuthorizationError,
  parseDesktopAuthorization,
  readDesktopAuthorizationForm,
} from "./authorize.js";
import { generateAuthorizationCode, hashAuthorizationCode } from "./codes.js";
import { desktopConsentPageResponse } from "./consent-page.js";
import { insertDesktopAuthorizationCode } from "./queries.js";
import { exchangeDesktopToken } from "./token.js";

const CODE_LIFETIME_MS = 60_000;

function invalidAuthorizationResponse(error: DesktopAuthorizationError): Response {
  return Response.json(
    { error: "invalid_authorization_request" },
    { status: error.status, headers: { "cache-control": "no-store" } },
  );
}

function loginRedirect(request: Request): Response {
  const url = new URL(request.url);
  const returnTo = `${url.pathname}${url.search}`;
  return new Response(null, {
    status: 302,
    headers: {
      location: `/login?returnTo=${encodeURIComponent(returnTo)}`,
      "cache-control": "no-store",
    },
  });
}

export const desktopRouter = new Hono<{ Bindings: ControlEnv }>();

desktopRouter.get("/authorize", async (context) => {
  const session = await authenticateSession(context.req.raw, context.env);
  if (session === null) return loginRedirect(context.req.raw);

  try {
    return desktopConsentPageResponse(
      parseDesktopAuthorization(new URL(context.req.url).searchParams),
    );
  } catch (error) {
    if (error instanceof DesktopAuthorizationError) return invalidAuthorizationResponse(error);
    throw error;
  }
});

desktopRouter.post("/authorize", async (context) => {
  const session = await authenticateSession(context.req.raw, context.env);
  if (session === null) {
    return context.json({ error: "session_authentication_required" }, 401, {
      "Cache-Control": "no-store",
    });
  }

  try {
    const input = parseDesktopAuthorization(await readDesktopAuthorizationForm(context.req.raw));
    const code = generateAuthorizationCode();
    const codeHash = await hashAuthorizationCode(code);
    const createdAt = Date.now();
    await insertDesktopAuthorizationCode(context.env.DB, {
      codeHash,
      userId: session.userId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      codeChallengeMethod: input.codeChallengeMethod,
      scope: input.scope,
      machineName: input.machineName,
      machineId: crypto.randomUUID(),
      createdAt,
      expiresAt: createdAt + CODE_LIFETIME_MS,
    });

    const callback = `${input.redirectUri}?${new URLSearchParams({ code, state: input.state })}`;
    return new Response(null, {
      status: 303,
      headers: { location: callback, "cache-control": "no-store" },
    });
  } catch (error) {
    if (error instanceof DesktopAuthorizationError) return invalidAuthorizationResponse(error);
    throw error;
  }
});

desktopRouter.post("/token", (context) => exchangeDesktopToken(context.req.raw, context.env.DB));

desktopRouter.all("*", (context) =>
  context.json({ error: "route_not_implemented" }, 404, { "Cache-Control": "no-store" }),
);
