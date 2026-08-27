export interface InsertDesktopAuthorizationCode {
  readonly codeHash: string;
  readonly userId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: "S256";
  readonly scope: "publish";
  readonly machineName: string;
  readonly machineId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/** Persist only the digest and bindings needed for the one-time exchange. */
export async function insertDesktopAuthorizationCode(
  database: D1Database,
  input: InsertDesktopAuthorizationCode,
): Promise<void> {
  await database
    .prepare(
      `INSERT INTO desktop_authorization_codes (
        code_hash, user_id, redirect_uri, code_challenge, code_challenge_method,
        scope, machine_name, machine_id, created_at, expires_at, consumed_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL)`,
    )
    .bind(
      input.codeHash,
      input.userId,
      input.redirectUri,
      input.codeChallenge,
      input.codeChallengeMethod,
      input.scope,
      input.machineName,
      input.machineId,
      input.createdAt,
      input.expiresAt,
    )
    .run();
}
