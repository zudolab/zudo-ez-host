import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { betterAuth } from "better-auth/minimal";

import { authSchema } from "../db/auth-schema.js";
import { createControlDatabase } from "../db/database.js";
import { assertInvitedSignup } from "./invite.js";

export interface AuthRuntimeEnv {
  readonly DB: D1Database;
  readonly BETTER_AUTH_SECRET?: string;
  readonly BETTER_AUTH_BASE_URL?: string;
  readonly BETTER_AUTH_TRUSTED_ORIGINS?: string;
  readonly SIGNUP_ALLOWED_EMAILS?: string;
  readonly GOOGLE_CLIENT_ID?: string;
  readonly GOOGLE_CLIENT_SECRET?: string;
  readonly GOOGLE_CALLBACK_URL?: string;
}

export interface CreateAuthOptions {
  /** Only the exact mounted email-signup request may opt into the invited path. */
  readonly enableInvitedEmailSignUp?: boolean;
}

const HOST_COOKIE_NAMES = {
  session_token: "__Host-zudo.session_token",
  session_data: "__Host-zudo.session_data",
  account_data: "__Host-zudo.account_data",
  dont_remember: "__Host-zudo.dont_remember",
} as const;

function commaSeparated(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function requiredSetting(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required for authentication`);
  return normalized;
}

function googleProvider(env: AuthRuntimeEnv, baseURL: string) {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  const callbackURL = env.GOOGLE_CALLBACK_URL?.trim();
  const expectedCallback = `${baseURL.replace(/\/$/, "")}/api/auth/callback/google`;

  if (!clientId || !clientSecret || !callbackURL || callbackURL !== expectedCallback) return {};
  return {
    google: {
      clientId,
      clientSecret,
      redirectURI: callbackURL,
      // Google remains dark in M1 even when credentials are staged.
      disableSignUp: true,
    },
  };
}

/**
 * Construct Better Auth per request because the D1 binding is request-scoped.
 *
 * Better Auth 1.7.2 rejects `disableSignUp: true` before database hooks run.
 * The default factory therefore stays disabled, while the app opts in only for
 * the exact built-in email-signup request. The mandatory user-create hook is
 * still the authority and covers every user-creation path.
 */
export function createAuth(env: AuthRuntimeEnv, options: CreateAuthOptions = {}) {
  const secret = requiredSetting(env.BETTER_AUTH_SECRET, "BETTER_AUTH_SECRET");
  const baseURL = requiredSetting(env.BETTER_AUTH_BASE_URL, "BETTER_AUTH_BASE_URL");
  const trustedOrigins = commaSeparated(
    requiredSetting(env.BETTER_AUTH_TRUSTED_ORIGINS, "BETTER_AUTH_TRUSTED_ORIGINS"),
  );
  return betterAuth({
    secret,
    baseURL,
    trustedOrigins,
    database: drizzleAdapter(createControlDatabase(env.DB), {
      provider: "sqlite",
      schema: authSchema,
    }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: !options.enableInvitedEmailSignUp,
      requireEmailVerification: false,
    },
    socialProviders: googleProvider(env, baseURL),
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            assertInvitedSignup(user.email, env.SIGNUP_ALLOWED_EMAILS);
          },
        },
      },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
    },
    advanced: {
      useSecureCookies: false,
      defaultCookieAttributes: {
        secure: true,
        httpOnly: true,
        path: "/",
        sameSite: "lax",
      },
      cookies: Object.fromEntries(
        Object.entries(HOST_COOKIE_NAMES).map(([key, name]) => [key, { name }]),
      ),
      // OAuth's dynamic state/PKCE/nonce cookies inherit these secure attrs.
      // The epic that actually enables Google must decide their final names.
      ipAddress: {
        ipAddressHeaders: ["cf-connecting-ip"],
      },
    },
  });
}
