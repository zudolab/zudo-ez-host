export type RequestBodyErrorReason =
  "invalid_content_length" | "body_too_large" | "invalid_utf8" | "invalid_json";

export class RequestBodyError extends Error {
  readonly reason: RequestBodyErrorReason;
  readonly status: 400 | 413;

  constructor(reason: RequestBodyErrorReason, message: string, status: 400 | 413 = 400) {
    super(message);
    this.name = "RequestBodyError";
    this.reason = reason;
    this.status = status;
  }
}

function declaredBodyLength(request: Request): number | undefined {
  const header = request.headers.get("Content-Length");
  if (header === null) {
    return undefined;
  }
  if (!/^\d+$/u.test(header)) {
    throw new RequestBodyError(
      "invalid_content_length",
      "Content-Length must be a non-negative integer",
    );
  }

  const length = Number(header);
  if (!Number.isSafeInteger(length)) {
    throw new RequestBodyError("invalid_content_length", "Content-Length must be a safe integer");
  }
  return length;
}

async function readBoundedRequestText(request: Request, maxBytes: number): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError("maxBytes must be a non-negative safe integer");
  }

  const declaredLength = declaredBodyLength(request);
  if (declaredLength !== undefined && declaredLength > maxBytes) {
    throw new RequestBodyError("body_too_large", "Request body is too large", 413);
  }
  if (request.body === null) {
    return "";
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const textParts: string[] = [];
  let receivedBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      receivedBytes += value.byteLength;
      if (receivedBytes > maxBytes) {
        try {
          await reader.cancel("Request body is too large");
        } catch {
          // Preserve the stable size error when stream cancellation itself fails.
        }
        throw new RequestBodyError("body_too_large", "Request body is too large", 413);
      }

      try {
        textParts.push(decoder.decode(value, { stream: true }));
      } catch {
        throw new RequestBodyError("invalid_utf8", "Request body must be valid UTF-8");
      }
    }

    try {
      textParts.push(decoder.decode());
    } catch {
      throw new RequestBodyError("invalid_utf8", "Request body must be valid UTF-8");
    }
  } finally {
    reader.releaseLock();
  }

  return textParts.join("");
}

/** Read and parse a JSON request without buffering beyond the caller's byte ceiling. */
export async function readBoundedJsonRequest(request: Request, maxBytes: number): Promise<unknown> {
  const text = await readBoundedRequestText(request, maxBytes);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RequestBodyError("invalid_json", "Request body must be valid JSON");
  }
}
