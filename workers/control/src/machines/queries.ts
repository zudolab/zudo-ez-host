/** The only machine fields that may cross the management API boundary. */
export interface MachineSummary {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly revoked: boolean;
  readonly credentialPrefix: string;
  readonly credentialVersion: number;
}

interface MachineSummaryRow {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly revoked: number;
  readonly credentialPrefix: string;
  readonly credentialVersion: number;
}

function machineSummary(row: MachineSummaryRow): MachineSummary {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    revoked: row.revoked !== 0,
    credentialPrefix: row.credentialPrefix,
    credentialVersion: row.credentialVersion,
  };
}

const MACHINE_SUMMARY_COLUMNS = `
  id, name, created_at AS createdAt, expires_at AS expiresAt,
  revoked, credential_prefix AS credentialPrefix,
  credential_version AS credentialVersion`;

/** Return only this owner's machines, with no credential hash in the projection. */
export async function listOwnedMachines(
  database: D1Database,
  userId: string,
): Promise<readonly MachineSummary[]> {
  const result = await database
    .prepare(
      `SELECT ${MACHINE_SUMMARY_COLUMNS}
       FROM machines
       WHERE user_id = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .bind(userId)
    .all<MachineSummaryRow>();
  return result.results.map(machineSummary);
}

/** Read one machine only when both its ID and owner match. */
export async function getOwnedMachine(
  database: D1Database,
  userId: string,
  machineId: string,
): Promise<MachineSummary | undefined> {
  const row = await database
    .prepare(
      `SELECT ${MACHINE_SUMMARY_COLUMNS}
       FROM machines
       WHERE id = ? AND user_id = ?`,
    )
    .bind(machineId, userId)
    .first<MachineSummaryRow>();
  return row === null ? undefined : machineSummary(row);
}

/** Rename a machine in place; publication snapshots are separate immutable rows. */
export async function renameOwnedMachine(
  database: D1Database,
  userId: string,
  machineId: string,
  name: string,
): Promise<MachineSummary | undefined> {
  const row = await database
    .prepare(
      `UPDATE machines
       SET name = ?
       WHERE id = ? AND user_id = ?
       RETURNING ${MACHINE_SUMMARY_COLUMNS}`,
    )
    .bind(name, machineId, userId)
    .first<MachineSummaryRow>();
  return row === null ? undefined : machineSummary(row);
}

/** Revoke exactly one owned machine; updating an already-revoked row is harmless. */
export async function revokeOwnedMachine(
  database: D1Database,
  userId: string,
  machineId: string,
): Promise<MachineSummary | undefined> {
  const row = await database
    .prepare(
      `UPDATE machines
       SET revoked = 1
       WHERE id = ? AND user_id = ?
       RETURNING ${MACHINE_SUMMARY_COLUMNS}`,
    )
    .bind(machineId, userId)
    .first<MachineSummaryRow>();
  return row === null ? undefined : machineSummary(row);
}
