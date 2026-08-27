import { Hono } from "hono";
import type { Context, Handler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { MACHINE_AUTH_CONTEXT_KEY, type MachineAuthEnv } from "../../auth/index.js";
import { readBoundedJsonRequest, RequestBodyError } from "../../http/request-body.js";
import { createReadOnlyR2Bucket } from "../../storage/index.js";
import type { UploadUrlSigner } from "../../storage/index.js";
import {
  UploadContractsError,
  issueUploadContracts,
  refreshUploadContracts,
  verifyUploadBatch,
  type IssueUploadContractsInput,
  type UploadVerificationRequest,
} from "./contracts.js";

export interface PublicationContractsRouterOptions {
  /** The production application supplies the R2 SigV4 signer here. */
  readonly signer?: UploadUrlSigner;
  /** Injectable clock for workerd tests; production uses Date.now. */
  readonly now?: () => number;
}

export const MAX_PUBLICATION_CONTRACTS_REQUEST_BYTES = 16 * 1024 * 1024;

const unconfiguredSigner: UploadUrlSigner = {
  async signUpload() {
    throw new UploadContractsError(
      "upload_signer_unavailable",
      "Upload URL signing is not configured",
      503,
    );
  },
};

const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function parseBody(request: Request): Promise<unknown> {
  try {
    return await readBoundedJsonRequest(request, MAX_PUBLICATION_CONTRACTS_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyError) {
      throw new UploadContractsError("invalid_request", error.message, error.status);
    }
    throw new UploadContractsError("invalid_request", "Request body must be valid JSON");
  }
}

function bodyField(body: unknown, ...names: readonly string[]): unknown {
  if (!isRecord(body)) {
    return undefined;
  }
  for (const name of names) {
    if (name in body) {
      return body[name];
    }
  }
  return undefined;
}

function bodyTransport(body: unknown): unknown {
  const named = bodyField(body, "transport", "transportEnvelope", "envelope", "metadata");
  if (named !== undefined) {
    return named;
  }
  return body;
}

function bodyVerificationItems(body: unknown): readonly UploadVerificationRequest[] | unknown {
  const named = bodyField(body, "objects", "items", "requests", "verification");
  if (named !== undefined) {
    return named;
  }
  return body;
}

function pathParam(context: Context<MachineAuthEnv>, name: string): string {
  const value = context.req.param(name);
  if (value === undefined || value.length === 0) {
    throw new UploadContractsError("invalid_request", `${name} path parameter is required`);
  }
  return value;
}

function operationInput(
  context: Context<MachineAuthEnv>,
  attemptId: string,
  options: PublicationContractsRouterOptions,
  body: unknown,
): IssueUploadContractsInput {
  const owner = context.get(MACHINE_AUTH_CONTEXT_KEY);
  if (owner === undefined || owner === null) {
    throw new UploadContractsError(
      "invalid_owner_context",
      "An authenticated owner context is required",
      401,
    );
  }
  return {
    database: context.env.DB,
    signer: options.signer ?? unconfiguredSigner,
    ownerId: owner.userId,
    projectId: pathParam(context, "projectId"),
    attemptId,
    transport: bodyTransport(body),
    cursor: bodyField(body, "cursor"),
    page: bodyField(body, "page"),
    offset: bodyField(body, "offset"),
    ...(options.now === undefined ? {} : { now: options.now() }),
  };
}

function errorResponse(context: Context<MachineAuthEnv>, error: unknown): Response {
  if (error instanceof UploadContractsError) {
    return context.json(
      { error: "publication_contracts_failed", reason: error.reason },
      error.status as ContentfulStatusCode,
      NO_STORE_HEADERS,
    );
  }
  return context.json(
    { error: "publication_contracts_failed", reason: "internal_error" },
    500,
    NO_STORE_HEADERS,
  );
}

/**
 * Build the authenticated upload-contract routes. Keeping the signer as an
 * explicit seam lets prepare and workerd tests use the same callable policy
 * without placing credentials in Wrangler vars or module-level state.
 */
export function createPublicationContractsRouter(
  options: PublicationContractsRouterOptions = {},
): Hono<MachineAuthEnv> {
  const router = new Hono<MachineAuthEnv>();

  const issue: Handler<MachineAuthEnv> = async (context) => {
    try {
      const attemptId = pathParam(context, "attemptId");
      const body = await parseBody(context.req.raw);
      const result = await issueUploadContracts(operationInput(context, attemptId, options, body));
      return context.json(result, 200, NO_STORE_HEADERS);
    } catch (error) {
      return errorResponse(context, error);
    }
  };

  const refresh: Handler<MachineAuthEnv> = async (context) => {
    try {
      const attemptId = pathParam(context, "attemptId");
      const body = await parseBody(context.req.raw);
      const result = await refreshUploadContracts(
        operationInput(context, attemptId, options, body),
      );
      return context.json(result, 200, NO_STORE_HEADERS);
    } catch (error) {
      return errorResponse(context, error);
    }
  };

  const verify: Handler<MachineAuthEnv> = async (context) => {
    try {
      const attemptId = pathParam(context, "attemptId");
      const body = await parseBody(context.req.raw);
      const owner = context.get(MACHINE_AUTH_CONTEXT_KEY);
      if (owner === undefined || owner === null) {
        throw new UploadContractsError(
          "invalid_owner_context",
          "An authenticated owner context is required",
          401,
        );
      }
      const result = await verifyUploadBatch({
        database: context.env.DB,
        bucket: createReadOnlyR2Bucket(context.env.ARTIFACTS),
        ownerId: owner.userId,
        projectId: pathParam(context, "projectId"),
        attemptId,
        requests: bodyVerificationItems(body),
        ...(options.now === undefined ? {} : { now: options.now() }),
      });
      return context.json(result, result.ok ? 200 : 422, NO_STORE_HEADERS);
    } catch (error) {
      return errorResponse(context, error);
    }
  };

  router.post("/:attemptId/contracts", issue);
  router.post("/:attemptId/contracts/refresh", refresh);
  router.post("/:attemptId/refresh", refresh);
  router.post("/:attemptId/verify", verify);
  router.post("/:attemptId/verification", verify);
  return router;
}

/** Default route surface used by the Worker app; production wiring can supply a signer factory. */
export const publicationContractsRouter = createPublicationContractsRouter();
