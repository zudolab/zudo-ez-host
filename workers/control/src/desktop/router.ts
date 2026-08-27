import { Hono } from "hono";

/**
 * Wave-4 desktop mount point. Cookie middleware is deliberately applied only
 * to `/desktop/authorize` by the parent app; `/desktop/token` stays cookie-free.
 */
export const desktopRouter = new Hono<{ Bindings: ControlEnv }>().all("*", (context) =>
  context.json({ error: "route_not_implemented" }, 404, { "Cache-Control": "no-store" }),
);
