import { AwsClient } from "aws4fetch";

/** The ADR-defined lifetime of an upload URL. */
export const UPLOAD_URL_EXPIRY_SECONDS = 10 * 60;

/** Inputs that are bound to one direct-to-R2 immutable object upload. */
export interface UploadUrlRequest {
  /** The complete project-scoped R2 object key. */
  readonly key: string;
  /** The exact Content-Type value the uploader must send. */
  readonly contentType: string;
  /** The base64-encoded MD5 value for the uploaded bytes. */
  readonly contentMd5: string;
}

/** A small seam that lets control-plane policy remain independent of SigV4. */
export interface UploadUrlSigner {
  signUpload(input: UploadUrlRequest): Promise<string>;
}

/** Explicit R2 S3 credentials required by the production signer. */
export interface Aws4FetchUploadUrlSignerOptions {
  /** Cloudflare account ID used to construct the R2 S3 endpoint. */
  readonly accountId: string;
  /** R2 bucket receiving uploads. */
  readonly bucketName: string;
  /** R2 API token access key. Keep this in a Worker secret/secret store. */
  readonly accessKeyId: string;
  /** R2 API token secret key. Keep this in a Worker secret/secret store. */
  readonly secretAccessKey: string;
  /** Injectable clock for deterministic tests; production uses the current time. */
  readonly now?: () => Date;
}

function assertNonEmpty(name: string, value: string): void {
  if (value.length === 0 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${name} must be a non-empty single-line value`);
  }
}

function assertPathSegment(name: string, value: string): void {
  assertNonEmpty(name, value);
  if (
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    throw new TypeError(`${name} must be one non-empty URL path segment`);
  }
}

function assertObjectKey(key: string): void {
  assertNonEmpty("key", key);
  if (
    key.startsWith("/") ||
    key.endsWith("/") ||
    key.includes("\\") ||
    key.includes("\0") ||
    key.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new TypeError("key must be a normalized, relative R2 object key");
  }
}

function encodeObjectKey(key: string): string {
  return key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function awsDatetime(now: Date): string {
  if (Number.isNaN(now.getTime())) {
    throw new TypeError("now must return a valid Date");
  }

  return now.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

/**
 * Signs a project-scoped PUT against the R2 S3 endpoint with aws4fetch.
 *
 * `allHeaders: true` is deliberate: aws4fetch otherwise treats
 * `Content-Type` as unsignable, and the custom `Content-MD5` and
 * `If-None-Match` constraints would not be guaranteed to participate in the
 * signature. The returned URL is a bearer capability; callers must not log
 * its query string. The optional clock is test-only injection and does not
 * retain request-scoped state.
 */
export class Aws4FetchUploadUrlSigner implements UploadUrlSigner {
  private readonly bucketName: string;
  private readonly endpoint: string;
  private readonly now: () => Date;
  private readonly client: AwsClient;

  constructor(options: Aws4FetchUploadUrlSignerOptions) {
    assertPathSegment("accountId", options.accountId);
    assertPathSegment("bucketName", options.bucketName);
    assertNonEmpty("accessKeyId", options.accessKeyId);
    assertNonEmpty("secretAccessKey", options.secretAccessKey);

    this.bucketName = options.bucketName;
    this.endpoint = `https://${options.accountId}.r2.cloudflarestorage.com`;
    this.now = options.now ?? (() => new Date());
    this.client = new AwsClient({
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      service: "s3",
      region: "auto",
    });
  }

  async signUpload(input: UploadUrlRequest): Promise<string> {
    assertObjectKey(input.key);
    assertNonEmpty("contentType", input.contentType);
    assertNonEmpty("contentMd5", input.contentMd5);

    const url = new URL(
      `${this.endpoint}/${encodeURIComponent(this.bucketName)}/${encodeObjectKey(input.key)}`,
    );
    url.searchParams.set("X-Amz-Expires", String(UPLOAD_URL_EXPIRY_SECONDS));

    const signed = await this.client.sign(url, {
      method: "PUT",
      headers: {
        "Content-Type": input.contentType,
        "Content-MD5": input.contentMd5,
        "If-None-Match": "*",
      },
      aws: {
        signQuery: true,
        allHeaders: true,
        datetime: awsDatetime(this.now()),
      },
    });

    return signed.url.toString();
  }

  /** Method-shaped alias for callers that use the underlying SigV4 wording. */
  sign(input: UploadUrlRequest): Promise<string> {
    return this.signUpload(input);
  }
}

/** Factory kept explicit so credentials always come from the caller's env. */
export function createAws4FetchUploadUrlSigner(
  options: Aws4FetchUploadUrlSignerOptions,
): UploadUrlSigner {
  return new Aws4FetchUploadUrlSigner(options);
}
