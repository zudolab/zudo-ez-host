const AUTHORIZATION_FIELDS = [
  "redirect_uri",
  "code_challenge",
  "code_challenge_method",
  "scope",
  "state",
  "machine_name",
] as const;
const PKCE_CHALLENGE = /^[A-Za-z0-9._~-]{43,128}$/u;
const LOOPBACK_REDIRECT =
  /^http:\/\/(127\.0\.0\.1|\[::1\]):([0-9]+)(?:\/(?:[A-Za-z0-9._~!$&'()*+,;=:@-]|%[0-9A-Fa-f]{2})*)*$/u;
const MAX_FORM_BYTES = 16 * 1024;

export interface DesktopAuthorizationRequest {
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: "S256";
  readonly scope: "publish";
  readonly state: string;
  readonly machineName: string;
}

export class DesktopAuthorizationError extends Error {
  readonly status: 400 | 413 | 415;

  constructor(message: string, status: 400 | 413 | 415 = 400) {
    super(message);
    this.name = "DesktopAuthorizationError";
    this.status = status;
  }
}

function requiredSingleValue(parameters: URLSearchParams, name: string): string {
  const values = parameters.getAll(name);
  if (values.length !== 1 || values[0] === "") {
    throw new DesktopAuthorizationError(`Invalid ${name}`);
  }
  return values[0] as string;
}

/** Validate and preserve an ephemeral native-app loopback redirect verbatim. */
export function validateLoopbackRedirect(redirectUri: string): string {
  if (redirectUri.includes("?") || redirectUri.includes("#")) {
    throw new DesktopAuthorizationError("Invalid redirect_uri");
  }
  const authority = LOOPBACK_REDIRECT.exec(redirectUri);
  if (!authority) throw new DesktopAuthorizationError("Invalid redirect_uri");
  const port = Number(authority[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new DesktopAuthorizationError("Invalid redirect_uri");
  }

  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    throw new DesktopAuthorizationError("Invalid redirect_uri");
  }
  const expectedHostname = authority[1] === "127.0.0.1" ? "127.0.0.1" : "[::1]";
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== expectedHostname ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new DesktopAuthorizationError("Invalid redirect_uri");
  }
  return redirectUri;
}

/** Parse the exact V1 desktop authorization parameter contract. */
export function parseDesktopAuthorization(
  parameters: URLSearchParams,
): DesktopAuthorizationRequest {
  const values = Object.fromEntries(
    AUTHORIZATION_FIELDS.map((name) => [name, requiredSingleValue(parameters, name)]),
  ) as Record<(typeof AUTHORIZATION_FIELDS)[number], string>;

  if (values.code_challenge_method !== "S256") {
    throw new DesktopAuthorizationError("Invalid code_challenge_method");
  }
  if (!PKCE_CHALLENGE.test(values.code_challenge)) {
    throw new DesktopAuthorizationError("Invalid code_challenge");
  }
  if (values.scope !== "publish") throw new DesktopAuthorizationError("Invalid scope");
  if (values.machine_name.length > 100) {
    throw new DesktopAuthorizationError("Invalid machine_name");
  }

  return {
    redirectUri: validateLoopbackRedirect(values.redirect_uri),
    codeChallenge: values.code_challenge,
    codeChallengeMethod: "S256",
    scope: "publish",
    state: values.state,
    machineName: values.machine_name,
  };
}

/** Read a small URL-encoded consent POST without unbounded body buffering. */
export async function readDesktopAuthorizationForm(request: Request): Promise<URLSearchParams> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") {
    throw new DesktopAuthorizationError("Form must be URL encoded", 415);
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/u.test(declaredLength)) throw new DesktopAuthorizationError("Invalid form");
    if (Number(declaredLength) > MAX_FORM_BYTES) {
      throw new DesktopAuthorizationError("Form is too large", 413);
    }
  }
  if (request.body === null) return new URLSearchParams();

  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: string[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_FORM_BYTES) {
        try {
          await reader.cancel("Form is too large");
        } catch {
          // Keep the stable size error if cancellation itself fails.
        }
        throw new DesktopAuthorizationError("Form is too large", 413);
      }
      try {
        chunks.push(decoder.decode(value, { stream: true }));
      } catch {
        throw new DesktopAuthorizationError("Form must be valid UTF-8");
      }
    }
    try {
      chunks.push(decoder.decode());
    } catch {
      throw new DesktopAuthorizationError("Form must be valid UTF-8");
    }
  } finally {
    reader.releaseLock();
  }
  return new URLSearchParams(chunks.join(""));
}
