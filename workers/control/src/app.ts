import { Hono } from "hono";

import {
  MACHINE_AUTH_PUBLISH_PATH,
  machineAuthMiddleware,
  type MachineAuthEnv,
} from "./auth/index.js";
import { projectsRouter } from "./projects/index.js";
import { publicationContractsRouter } from "./publication/contracts/index.js";
import { publicationCommitRouter } from "./publication/commit/index.js";
import { publicationPrepareRouter } from "./publication/prepare/index.js";
import { healthRouter } from "./routes/health.js";

export const app = new Hono<MachineAuthEnv>();

app.route("/", healthRouter);
app.use("/projects", machineAuthMiddleware);
app.use("/projects/*", machineAuthMiddleware);
app.route("/projects", projectsRouter);
app.use(MACHINE_AUTH_PUBLISH_PATH, machineAuthMiddleware);
app.route("/api/projects/:projectId/publish", publicationPrepareRouter);
app.route("/api/projects/:projectId/publish", publicationContractsRouter);
app.route("/api/projects/:projectId/publish", publicationCommitRouter);
