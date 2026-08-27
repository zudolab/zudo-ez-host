import type { PublicationResolution } from "@zudo-ez-host/core";
import { WorkerEntrypoint } from "cloudflare:workers";

import { resolveProjectByLabel } from "../projects/resolution.js";

interface PromotedPublicationRow {
  readonly artifactHash: string;
}

/**
 * Public-plane lookup for the currently promoted publication behind a host
 * label. The project lookup owns hostname parsing and the status/publication
 * predicates; this entrypoint only projects the opaque serving contract.
 */
export class PublicationResolver extends WorkerEntrypoint<ControlEnv> {
  async resolvePublication(hostLabel: unknown): Promise<PublicationResolution> {
    const project = await resolveProjectByLabel(this.env.DB, hostLabel);
    if (project === null) {
      return null;
    }

    // Re-check the promoted head while reading the immutable artifact hash.
    // This keeps a republish or takedown between the two reads from returning
    // an older publication that is no longer the public head.
    const publication = await this.env.DB.prepare(
      `SELECT pub.artifact_hash AS artifactHash
         FROM project_heads AS ph
         INNER JOIN publications AS pub
           ON pub.id = ph.publication_id
          AND pub.project_id = ph.project_id
          AND pub.generation = ph.generation
         INNER JOIN projects AS p
           ON p.id = ph.project_id
         WHERE ph.project_id = ?
           AND ph.generation = ?
           AND ph.publication_id = ?
           AND p.status = 'active'`,
    )
      .bind(project.projectId, project.generation, project.publicationId)
      .first<PromotedPublicationRow>();

    if (publication === null) {
      return null;
    }

    return {
      projectId: project.projectId,
      artifactHash: publication.artifactHash,
      servingFlags: {
        spaFallback: false,
        gated: false,
      },
    };
  }

  // A named entrypoint still needs a fetch handler for local/runtime wiring;
  // the public API is the RPC method above, not this HTTP fallback.
  fetch(): Response {
    return new Response(null, { status: 404 });
  }
}
