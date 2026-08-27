import { APIError } from "better-auth/api";

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function parseSignupAllowlist(value: string | undefined): ReadonlySet<string> {
  return new Set((value ?? "").split(",").map(normalizeEmail).filter(Boolean));
}

export function isSignupAllowed(email: string, value: string | undefined): boolean {
  return parseSignupAllowlist(value).has(normalizeEmail(email));
}

/**
 * M1 is deliberately invite-only and fails closed when the secret is absent.
 * M2 public signup replaces this gate outright rather than extending it.
 */
export function assertInvitedSignup(email: string, value: string | undefined): void {
  if (!isSignupAllowed(email, value)) {
    throw new APIError("FORBIDDEN", { message: "Signup is not available for this account" });
  }
}
