import { Hono } from "hono";

/** Wave-4 mount point; unmatched account routes have one stable empty response. */
export const accountRouter = new Hono<{ Bindings: ControlEnv }>().all("*", (context) =>
  context.json({ error: "route_not_implemented" }, 404, { "Cache-Control": "no-store" }),
);
