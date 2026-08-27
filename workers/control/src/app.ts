import { Hono } from "hono";

import {
  MACHINE_AUTH_PUBLISH_PATH,
  machineAuthMiddleware,
  type MachineAuthEnv,
} from "./auth/index.js";
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
