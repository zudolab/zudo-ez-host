import { Hono } from "hono";

import {
  MACHINE_AUTH_PUBLISH_PATH,
  machineAuthMiddleware,
  type MachineAuthEnv,
} from "./auth/index.js";
import { healthRouter } from "./routes/health.js";

export const app = new Hono<MachineAuthEnv>();

app.route("/", healthRouter);
app.use(MACHINE_AUTH_PUBLISH_PATH, machineAuthMiddleware);
