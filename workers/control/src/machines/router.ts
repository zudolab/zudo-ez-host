import { Hono } from "hono";

/** Wave-4 mount point; unmatched machine-management routes are stable. */
export const machinesRouter = new Hono<{ Bindings: ControlEnv }>().all("*", (context) =>
  context.json({ error: "route_not_implemented" }, 404, { "Cache-Control": "no-store" }),
);
