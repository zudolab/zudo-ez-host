import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { MACHINE_AUTH_CONTEXT_KEY, type MachineAuthEnv } from "../../auth/index.js";
import { readBoundedJsonRequest, RequestBodyError } from "../../http/request-body.js";
import { CommitPublicationError, commitPublication } from "./commit.js";

export interface PublicationCommitRouterOptions {
  readonly now?: () => number;
}

/** Commit carries only an opaque attempt ID; keep request buffering tightly bounded. */
export const MAX_COMMIT_REQUEST_BYTES = 16 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function attemptIdFromRequest(request: Request): Promise<string> {
  let body: unknown;
  try {
    body = await readBoundedJsonRequest(request, MAX_COMMIT_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyError) {
      throw new CommitPublicationError("invalid_request", error.message, {
        status: error.status,
      });
    }
    throw new CommitPublicationError("invalid_request", "Request body must be valid JSON");
  }
  if (!isRecord(body) || typeof body.attemptId !== "string" || body.attemptId.length === 0) {
    throw new CommitPublicationError("invalid_request", "attemptId is required");
  }
  return body.attemptId;
}

export function createPublicationCommitRouter(
  options: PublicationCommitRouterOptions = {},
): Hono<MachineAuthEnv> {
  return new Hono<MachineAuthEnv>().post("/commit", async (context) => {
    try {
      const owner = context.get(MACHINE_AUTH_CONTEXT_KEY);
      if (owner === undefined || owner === null) {
        throw new CommitPublicationError(
          "invalid_owner_context",
          "An authenticated owner context is required",
        );
      }
      const projectId = context.req.param("projectId");
      if (projectId === undefined || projectId.length === 0) {
        throw new CommitPublicationError("invalid_request", "projectId is required");
      }
      const result = await commitPublication({
        database: context.env.DB,
        bucket: context.env.ARTIFACTS,
        ownerId: owner.userId,
        projectId,
        attemptId: await attemptIdFromRequest(context.req.raw),
        ...(options.now === undefined ? {} : { now: options.now() }),
      });
      return context.json(result, 200, { "Cache-Control": "no-store" });
    } catch (error) {
      if (error instanceof CommitPublicationError) {
        return context.json(
          {
            error: "publication_commit_failed",
            reason: error.reason,
            ...(error.head === undefined
              ? {}
              : {
                  generation: error.head.generation,
                  machineName: error.head.machineName,
                }),
          },
          error.status as ContentfulStatusCode,
          { "Cache-Control": "no-store" },
        );
      }
      return context.json({ error: "publication_commit_failed", reason: "internal_error" }, 500, {
        "Cache-Control": "no-store",
      });
    }
  });
}

export const publicationCommitRouter = createPublicationCommitRouter();
