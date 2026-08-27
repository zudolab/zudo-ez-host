const DEFAULT_RETURN_TO = "/";
const MAX_LOGIN_FORM_BYTES = 16 * 1024;

export class LoginFormError extends Error {
  readonly status: 400 | 413;

  constructor(message: string, status: 400 | 413 = 400) {
    super(message);
    this.name = "LoginFormError";
    this.status = status;
  }
}

export function hasSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && origin === new URL(request.url).origin;
}

export async function readLoginForm(request: Request): Promise<URLSearchParams> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") {
    throw new LoginFormError("Login form must be URL encoded");
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/u.test(declaredLength)) throw new LoginFormError("Invalid Content-Length");
    if (Number(declaredLength) > MAX_LOGIN_FORM_BYTES) {
      throw new LoginFormError("Login form is too large", 413);
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
      if (received > MAX_LOGIN_FORM_BYTES) {
        try {
          await reader.cancel("Login form is too large");
        } catch {
          // Preserve the stable size error if stream cancellation itself fails.
        }
        throw new LoginFormError("Login form is too large", 413);
      }
      try {
        chunks.push(decoder.decode(value, { stream: true }));
      } catch {
        throw new LoginFormError("Login form must be valid UTF-8");
      }
    }
    try {
      chunks.push(decoder.decode());
    } catch {
      throw new LoginFormError("Login form must be valid UTF-8");
    }
  } finally {
    reader.releaseLock();
  }
  return new URLSearchParams(chunks.join(""));
}

export function safeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) {
    return DEFAULT_RETURN_TO;
  }
  try {
    const parsed = new URL(value, "https://return.invalid");
    return parsed.origin === "https://return.invalid"
      ? `${parsed.pathname}${parsed.search}${parsed.hash}`
      : DEFAULT_RETURN_TO;
  } catch {
    return DEFAULT_RETURN_TO;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character] ?? character;
  });
}

export function renderLoginPage(returnTo: string, error?: string): string {
  const destination = escapeHtml(safeReturnTo(returnTo));
  const errorMessage = error ? `<p role="alert">${escapeHtml(error)}</p>` : "";
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in — zudo ez host</title></head>
<body>
<main>
<h1>Sign in</h1>
${errorMessage}
<form method="post" action="/login">
<input type="hidden" name="returnTo" value="${destination}">
<label>Email <input name="email" type="email" autocomplete="email" required></label>
<label>Password <input name="password" type="password" autocomplete="current-password" required></label>
<button type="submit">Sign in</button>
</form>
</main>
</body>
</html>`;
}

export function loginPageResponse(returnTo: string, error?: string, status = 200): Response {
  return new Response(renderLoginPage(returnTo, error), {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}
