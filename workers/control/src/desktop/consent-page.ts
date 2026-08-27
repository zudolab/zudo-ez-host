import type { DesktopAuthorizationRequest } from "./authorize.js";

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

export function renderDesktopConsentPage(input: DesktopAuthorizationRequest): string {
  const field = (name: string, value: string) =>
    `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize Mac — zudo ez host</title></head>
<body>
<main>
<h1>Authorize this Mac</h1>
<p>Allow <strong>${escapeHtml(input.machineName)}</strong> to publish through zudo ez host?</p>
<p>The authorization will return to <code>${escapeHtml(input.redirectUri)}</code>.</p>
<form method="post" action="/desktop/authorize">
${field("redirect_uri", input.redirectUri)}
${field("code_challenge", input.codeChallenge)}
${field("code_challenge_method", input.codeChallengeMethod)}
${field("scope", input.scope)}
${field("state", input.state)}
${field("machine_name", input.machineName)}
<button type="submit">Authorize</button>
</form>
</main>
</body>
</html>`;
}

export function desktopConsentPageResponse(input: DesktopAuthorizationRequest): Response {
  return new Response(renderDesktopConsentPage(input), {
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
