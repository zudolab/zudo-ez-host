import { Hono } from "hono";

import { createControlApp } from "./app.js";
import { createUploadUrlSignerFromEnv } from "./storage/index.js";

export { PublicationResolver } from "./entrypoints/publication-resolver.js";

export function createControlAppFromEnv(env: ControlEnv) {
  const signer = createUploadUrlSignerFromEnv(env);
  return createControlApp({
    ...(signer === undefined
      ? {}
      : {
          prepare: { signer },
          contracts: { signer },
        }),
    health: { uploadSignerConfigured: signer !== undefined },
  });
}

const worker = new Hono<{ Bindings: ControlEnv }>().all("*", (context) =>
  createControlAppFromEnv(context.env).fetch(context.req.raw, context.env, context.executionCtx),
);

export default worker;
