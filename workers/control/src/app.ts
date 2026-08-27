import { Hono } from "hono";

import {
  MACHINE_AUTH_PUBLISH_PATH,
  machineAuthMiddleware,
  type MachineAuthEnv,
} from "./auth/machine-auth.js";
import {
  hasSameOrigin,
  LoginFormError,
  loginPageResponse,
  readLoginForm,
  safeReturnTo,
} from "./auth/login-page.js";
import { projectsRouter } from "./projects/index.js";
import {
  createPublicationContractsRouter,
  type PublicationContractsRouterOptions,
} from "./publication/contracts/index.js";
import { publicationCommitRouter } from "./publication/commit/index.js";
import {
  createPublicationPrepareRouter,
  type PublicationPrepareRouterOptions,
} from "./publication/prepare/index.js";
import { healthRouter } from "./routes/health.js";

export interface ControlAppOptions {
  readonly prepare?: PublicationPrepareRouterOptions;
  readonly contracts?: PublicationContractsRouterOptions;
}

/** Build the control app with deployment-owned publication dependencies. */
export function createControlApp(options: ControlAppOptions = {}): Hono<MachineAuthEnv> {
  const app = new Hono<MachineAuthEnv>();
  const publicationPrepareRouter = createPublicationPrepareRouter(options.prepare);
  const publicationContractsRouter = createPublicationContractsRouter(options.contracts);

  app.route("/", healthRouter);
  app.get("/login", (context) => loginPageResponse(safeReturnTo(context.req.query("returnTo"))));
  app.post("/login", async (context) => {
    if (!hasSameOrigin(context.req.raw)) {
      return loginPageResponse("/", "Invalid login request", 403);
    }
    let form: URLSearchParams;
    try {
      form = await readLoginForm(context.req.raw);
    } catch (error) {
      if (error instanceof LoginFormError) {
        return loginPageResponse("/", "Invalid login request", error.status);
      }
      throw error;
    }
    const returnTo = safeReturnTo(form.get("returnTo"));
    const email = form.get("email");
    const password = form.get("password");
    if (email === null || password === null) {
      return loginPageResponse(returnTo, "Email and password are required", 400);
    }

    const { createAuth } = await import("./auth/better-auth.js");
    const headers = new Headers({
      "content-type": "application/json",
      origin: context.req.header("origin") ?? "",
    });
    const connectingIp = context.req.header("cf-connecting-ip");
    if (connectingIp) headers.set("cf-connecting-ip", connectingIp);
    const response = await createAuth(context.env).handler(
      new Request(new URL("/api/auth/sign-in/email", context.req.url), {
        method: "POST",
        headers,
        body: JSON.stringify({ email, password }),
      }),
    );
    if (!response.ok)
      return loginPageResponse(
        returnTo,
        "Invalid email or password",
        response.status === 429 ? 429 : 401,
      );

    const redirect = new Response(null, {
      status: 303,
      headers: { location: returnTo, "cache-control": "no-store" },
    });
    for (const cookie of response.headers.getSetCookie())
      redirect.headers.append("set-cookie", cookie);
    return redirect;
  });
  app.all("/api/auth/*", async (context) => {
    const { createAuth } = await import("./auth/better-auth.js");
    const url = new URL(context.req.url);
    const enableInvitedEmailSignUp =
      context.req.method === "POST" && url.pathname === "/api/auth/sign-up/email";
    return createAuth(context.env, { enableInvitedEmailSignUp }).handler(context.req.raw);
  });
  app.use("/projects", machineAuthMiddleware);
  app.use("/projects/*", machineAuthMiddleware);
  app.route("/projects", projectsRouter);
  app.use(MACHINE_AUTH_PUBLISH_PATH, machineAuthMiddleware);
  app.route("/api/projects/:projectId/publish", publicationPrepareRouter);
  app.route("/api/projects/:projectId/publish", publicationContractsRouter);
  app.route("/api/projects/:projectId/publish", publicationCommitRouter);
  return app;
}

export const app = createControlApp();
