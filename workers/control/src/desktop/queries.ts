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

export interface DesktopAuthorizationCodeRecord {
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
  readonly consumedAt: number | null;
}

export interface RedeemDesktopAuthorizationCode {
  readonly codeHash: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly credentialHashSha256: string;
  readonly credentialPrefix: string;
  readonly credentialVersion: number;
  readonly redeemedAt: number;
  readonly machineExpiresAt: number;
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

/** Look up an authorization grant by the digest of its one-time wire code. */
export async function getDesktopAuthorizationCodeByHash(
  database: D1Database,
  codeHash: string,
): Promise<DesktopAuthorizationCodeRecord | null> {
  return database
    .prepare(
      `SELECT
        code_hash AS codeHash, user_id AS userId, redirect_uri AS redirectUri,
        code_challenge AS codeChallenge, code_challenge_method AS codeChallengeMethod,
        scope, machine_name AS machineName, machine_id AS machineId,
        created_at AS createdAt, expires_at AS expiresAt, consumed_at AS consumedAt
      FROM desktop_authorization_codes
      WHERE code_hash = ?1`,
    )
    .bind(codeHash)
    .first<DesktopAuthorizationCodeRecord>();
}

/**
 * Atomically mint the preassigned machine and consume its one-time grant.
 *
 * The INSERT repeats every mutable redemption predicate. A losing racer thus
 * inserts zero rows even though affected-row inspection happens after commit.
 * The machine primary key and credential-hash unique index are the SQL-error
 * backstops that make D1 roll the batch back if concurrent snapshots race.
 */
export async function redeemDesktopAuthorizationCode(
  database: D1Database,
  input: RedeemDesktopAuthorizationCode,
): Promise<boolean> {
  const predicate = `code_hash = ?1
    AND consumed_at IS NULL
    AND expires_at > ?2
    AND redirect_uri = ?3
    AND code_challenge = ?4
    AND code_challenge_method = 'S256'
    AND scope = 'publish'`;
  const insert = database
    .prepare(
      `INSERT INTO machines (
        id, user_id, name, credential_hash_sha256, credential_prefix,
        credential_version, revoked, created_at, expires_at
      )
      SELECT
        machine_id, user_id, machine_name, ?5, ?6, ?7, 0, ?8, ?9
      FROM desktop_authorization_codes
      WHERE ${predicate}`,
    )
    .bind(
      input.codeHash,
      input.redeemedAt,
      input.redirectUri,
      input.codeChallenge,
      input.credentialHashSha256,
      input.credentialPrefix,
      input.credentialVersion,
      input.redeemedAt,
      input.machineExpiresAt,
    );
  const consume = database
    .prepare(
      `UPDATE desktop_authorization_codes
       SET consumed_at = ?5
       WHERE ${predicate}`,
    )
    .bind(
      input.codeHash,
      input.redeemedAt,
      input.redirectUri,
      input.codeChallenge,
      input.redeemedAt,
    );

  try {
    const [insertResult, consumeResult] = await database.batch([insert, consume]);
    return insertResult?.meta.changes === 1 && consumeResult?.meta.changes === 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (
      message.includes("UNIQUE constraint failed: machines.id") ||
      message.includes("machines_credential_hash_sha256_unique") ||
      message.includes("UNIQUE constraint failed: machines.credential_hash_sha256")
    ) {
      return false;
    }
    throw error;
  }
}
