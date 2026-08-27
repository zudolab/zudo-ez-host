import type { PublicationResolution } from "@zudo-ez-host/core";

interface PublicationResolverBinding {
  resolvePublication(projectId: string): Promise<PublicationResolution>;
}

type PublicWorkerEnv = Omit<PublicEnv, "CONTROL"> & {
  CONTROL: PublicationResolverBinding;
};

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/resolution\/([^/]+)$/.exec(url.pathname);

    const encodedProjectId = match?.[1];
    if (encodedProjectId === undefined) {
      return new Response("Not found", { status: 404 });
    }

    const projectId = decodeURIComponent(encodedProjectId);
    const resolution = await env.CONTROL.resolvePublication(projectId);
    return Response.json(resolution);
  },
} satisfies ExportedHandler<PublicWorkerEnv>;
