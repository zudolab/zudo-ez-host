import { Hono } from "hono";

import { healthRouter } from "./routes/health.js";

export const app = new Hono<{ Bindings: ControlEnv }>();

app.route("/", healthRouter);
