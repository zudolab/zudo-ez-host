export interface GuardedStatement {
  readonly name: string;
  readonly statement: D1PreparedStatement;
  readonly expectedChanges: number;
}

export interface GuardFailure {
  readonly name: string;
  readonly expectedChanges: number;
  readonly actualChanges: number;
}

export class GuardedBatchError extends Error {
  readonly failures: readonly GuardFailure[];

  constructor(failures: readonly GuardFailure[]) {
    super(
      `D1 guarded batch rejected: ${failures
        .map(
          ({ name, expectedChanges, actualChanges }) =>
            `${name} expected ${expectedChanges} change(s), received ${actualChanges}`,
        )
        .join("; ")}`,
    );
    this.name = "GuardedBatchError";
    this.failures = failures;
  }
}

/**
 * Run a D1 batch and reject its logical outcome when any statement reports an
 * unexpected affected-row count. Every statement is checked deliberately so
 * callers cannot accidentally forget the zero-row conditional-write case.
 *
 * D1 can only roll a batch back for SQL errors. Dependent mutations must repeat
 * their own SQL predicates instead of relying on this post-batch inspection.
 */
export async function executeGuardedBatch(
  database: D1Database,
  statements: readonly GuardedStatement[],
): Promise<readonly D1Result[]> {
  if (statements.length === 0) {
    throw new TypeError("A guarded D1 batch must contain at least one statement");
  }

  for (const { expectedChanges, name } of statements) {
    if (!Number.isSafeInteger(expectedChanges) || expectedChanges < 0) {
      throw new TypeError(`Invalid expectedChanges for ${name}`);
    }
  }

  const results = await database.batch(statements.map(({ statement }) => statement));
  if (results.length !== statements.length) {
    throw new Error(
      `D1 guarded batch returned ${results.length} result(s) for ${statements.length} statement(s)`,
    );
  }
  const failures: GuardFailure[] = [];

  for (const [index, result] of results.entries()) {
    const guard = statements[index];
    if (guard !== undefined && result.meta.changes !== guard.expectedChanges) {
      failures.push({
        name: guard.name,
        expectedChanges: guard.expectedChanges,
        actualChanges: result.meta.changes,
      });
    }
  }

  if (failures.length > 0) {
    throw new GuardedBatchError(failures);
  }

  return results;
}
