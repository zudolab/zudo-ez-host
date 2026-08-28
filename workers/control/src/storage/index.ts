import { createAws4FetchUploadUrlSigner, type UploadUrlSigner } from "./signer.js";

export {
  artifactManifestKey,
  contentKey,
  immutableContentKey,
  promotedArtifactManifestKey,
  stagedManifestKey,
} from "@zudo-ez-host/core";
export type { ReadOnlyR2Bucket, R2Reader } from "@zudo-ez-host/core";
export { createReadOnlyR2Bucket, createReadOnlyR2Facade } from "@zudo-ez-host/core";
export {
  Aws4FetchUploadUrlSigner,
  UPLOAD_URL_EXPIRY_SECONDS,
  createAws4FetchUploadUrlSigner,
} from "./signer.js";
export type {
  Aws4FetchUploadUrlSignerOptions,
  UploadUrlRequest,
  UploadUrlSigner,
} from "./signer.js";
export {
  MAX_VERIFICATION_BATCH_SIZE,
  verifyObject,
  verifyObjects,
  verifyR2Object,
  verifyR2Objects,
} from "./verify.js";
export type {
  Md5Value,
  R2ObjectVerificationRequest,
  R2ObjectVerificationResult,
} from "./verify.js";

export type UploadSignerEnv = Pick<
  ControlEnv,
  "R2_ACCOUNT_ID" | "R2_BUCKET_NAME" | "R2_ACCESS_KEY_ID" | "R2_SECRET_ACCESS_KEY"
>;

/**
 * Build a request-scoped signer when every required R2 S3 setting is valid.
 * Invalid configuration remains a readiness failure instead of preventing the
 * Worker from serving its health endpoint.
 */
export function createUploadUrlSignerFromEnv(env: UploadSignerEnv): UploadUrlSigner | undefined {
  const { R2_ACCOUNT_ID, R2_BUCKET_NAME, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = env;
  if (
    R2_ACCOUNT_ID === undefined ||
    R2_BUCKET_NAME === undefined ||
    R2_ACCESS_KEY_ID === undefined ||
    R2_SECRET_ACCESS_KEY === undefined
  ) {
    return undefined;
  }

  try {
    return createAws4FetchUploadUrlSigner({
      accountId: R2_ACCOUNT_ID,
      bucketName: R2_BUCKET_NAME,
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    });
  } catch {
    return undefined;
  }
}
