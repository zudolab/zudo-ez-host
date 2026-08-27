import { Hono } from "hono";

export const healthRouter = new Hono<{ Bindings: ControlEnv }>().get("/health", (context) =>
  context.json({ service: "control", status: "ok" }),
);
