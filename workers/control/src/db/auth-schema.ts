import { accounts, rateLimits, sessions, users, verifications } from "./schema.js";

/**
 * Better Auth's Drizzle adapter resolves models with exact schema-object keys.
 * Keep that contract isolated from the plural exports in the application schema.
 */
export const authSchema = {
  user: users,
  session: sessions,
  account: accounts,
  verification: verifications,
  rateLimit: rateLimits,
};
