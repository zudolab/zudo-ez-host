/** The fields exposed by the signed-in user's own-profile surface. */
export interface AccountProfile {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly handle: string | null;
}

/** Read one account by its authenticated opaque ID. */
export async function getAccountProfile(
  database: D1Database,
  userId: string,
): Promise<AccountProfile | null> {
  return database
    .prepare(
      `SELECT id, email, name, canonical_handle AS handle
       FROM user
       WHERE id = ?`,
    )
    .bind(userId)
    .first<AccountProfile>();
}

/** Descriptive alias for callers at the /api/account/me boundary. */
export const getOwnProfile = getAccountProfile;
