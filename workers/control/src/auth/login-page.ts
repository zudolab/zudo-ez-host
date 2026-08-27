const DEFAULT_RETURN_TO = "/";

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
