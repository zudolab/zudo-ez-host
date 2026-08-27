import { MAX_CANONICAL_MANIFEST_BYTES } from "@zudo-ez-host/core";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { MACHINE_AUTH_CONTEXT_KEY, type MachineAuthEnv } from "../../auth/index.js";
import type { UploadUrlSigner } from "../../storage/index.js";
import { PreparePublicationError, preparePublication } from "./prepare.js";

/** Bounded JSON wrapper for a 10 MiB canonical manifest plus its hash envelope. */
export const MAX_PREPARE_REQUEST_BYTES = 32 * 1024 * 1024;

export interface PublicationPrepareRouterOptions {
  readonly signer?: UploadUrlSigner;
  readonly now?: () => number;
}

const unavailableSigner: UploadUrlSigner = {
  async signUpload() {
    throw new PreparePublicationError(
      "upload_signer_unavailable",
      "Upload URL signing is not configured",
      503,
    );
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeBase64(value: unknown): Uint8Array {
  if (typeof value !== "string") {
    throw new PreparePublicationError("invalid_request", "manifestBase64 must be a string");
  }
  let decoded: string;
  try {
    decoded = atob(value);
  } catch {
    throw new PreparePublicationError("invalid_request", "manifestBase64 is invalid base64");
  }
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  if (btoa(decoded) !== value) {
    throw new PreparePublicationError("invalid_request", "manifestBase64 is not canonical base64");
  }
  return bytes;
}

function manifestBytes(body: Record<string, unknown>): Uint8Array {
  if (typeof body.manifest === "string") {
    return new TextEncoder().encode(body.manifest);
  }
  if (body.manifestBase64 !== undefined) {
    return decodeBase64(body.manifestBase64);
  }
  if (Array.isArray(body.manifestBytes)) {
    if (
      body.manifestBytes.some(
        (byte) => !Number.isInteger(byte) || (byte as number) < 0 || (byte as number) > 255,
      )
    ) {
      throw new PreparePublicationError(
        "invalid_request",
        "manifestBytes must contain only byte values",
      );
    }
    return Uint8Array.from(body.manifestBytes as number[]);
  }
  throw new PreparePublicationError(
    "invalid_request",
    "A canonical manifest string, manifestBase64, or manifestBytes is required",
  );
}

async function parseRequest(request: Request): Promise<Record<string, unknown>> {
  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_PREPARE_REQUEST_BYTES) {
      throw new PreparePublicationError(
        "invalid_request",
        "Prepare request body is too large",
        413,
      );
    }
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_PREPARE_REQUEST_BYTES) {
    throw new PreparePublicationError("invalid_request", "Prepare request body is too large", 413);
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new PreparePublicationError("invalid_request", "Request body must be valid JSON");
  }
  if (!isRecord(value)) {
    throw new PreparePublicationError("invalid_request", "Request body must be an object");
  }
  return value;
}

export function createPublicationPrepareRouter(
  options: PublicationPrepareRouterOptions = {},
): Hono<MachineAuthEnv> {
  return new Hono<MachineAuthEnv>().post("/prepare", async (context) => {
    try {
      const owner = context.get(MACHINE_AUTH_CONTEXT_KEY);
      if (owner === undefined || owner === null) {
        throw new PreparePublicationError(
          "invalid_owner_context",
          "An authenticated owner context is required",
          401,
        );
      }
      const body = await parseRequest(context.req.raw);
      const bytes = manifestBytes(body);
      const projectId = context.req.param("projectId");
      if (projectId === undefined || projectId.length === 0) {
        throw new PreparePublicationError("invalid_request", "projectId is required");
      }
      // Fast route-level rejection avoids carrying an oversized byte array any
      // farther. Core decode remains the authoritative limit check.
      if (bytes.byteLength > MAX_CANONICAL_MANIFEST_BYTES) {
        throw new PreparePublicationError(
          "manifest_body_limit_exceeded",
          "Canonical manifest exceeds 10 MiB",
          413,
        );
      }
      const result = await preparePublication({
        database: context.env.DB,
        bucket: context.env.ARTIFACTS,
        signer: options.signer ?? unavailableSigner,
        ownerId: owner.userId,
        machineId: owner.machineId,
        projectId,
        manifestBytes: bytes,
        transport: body.transport ?? body.transportEnvelope ?? body.envelope,
        ...(options.now === undefined ? {} : { now: options.now() }),
      });
      return context.json(result, result.created ? 201 : 200, { "Cache-Control": "no-store" });
    } catch (error) {
      if (error instanceof PreparePublicationError) {
        return context.json(
          { error: "publication_prepare_failed", reason: error.reason },
          error.status as ContentfulStatusCode,
          { "Cache-Control": "no-store" },
        );
      }
      return context.json({ error: "publication_prepare_failed", reason: "internal_error" }, 500, {
        "Cache-Control": "no-store",
      });
    }
  });
}

export const publicationPrepareRouter = createPublicationPrepareRouter();
