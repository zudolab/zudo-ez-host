import { Hono } from "hono";

import { projectsRouter } from "./projects/index.js";
import { healthRouter } from "./routes/health.js";

export const app = new Hono<{ Bindings: ControlEnv }>();

app.route("/", healthRouter);
app.route("/projects", projectsRouter);
