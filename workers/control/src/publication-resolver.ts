import type { PublicationResolution } from "@zudo-ez-host/core";
import { WorkerEntrypoint } from "cloudflare:workers";

export class PublicationResolver extends WorkerEntrypoint<ControlEnv> {
  resolvePublication(projectId: string): PublicationResolution {
    return {
      projectId,
      artifactHash: "sha256:publication-resolution-fixture",
      servingFlags: {
        spaFallback: true,
        gated: false,
      },
    };
  }
}

export default {
  fetch(): Response {
    return new Response("Control publication resolver");
  },
} satisfies ExportedHandler<ControlEnv>;
