import type { SQLiteDriver, SQLiteQueryResult } from '../../src/adapters/sqlite/driver.js';

interface NodeStatement {
  all(...params: unknown[]): Record<string, unknown>[];
  run(...params: unknown[]): { changes?: number | bigint };
}

interface NodeDatabase {
  prepare(sql: string): NodeStatement;
  exec(sql: string): void;
  close(): void;
}

export interface RealSQLiteHandle {
  readonly driver: SQLiteDriver;
  readonly database: NodeDatabase;
}

export async function createRealSQLiteDriver(): Promise<RealSQLiteHandle | undefined> {
  let DatabaseSync: new (path: string) => NodeDatabase;
  try {
    ({ DatabaseSync } = (await import('node:sqlite')) as unknown as {
      DatabaseSync: new (path: string) => NodeDatabase;
    });
  } catch {
    return undefined;
  }

  const database = new DatabaseSync(':memory:');

  const driver: SQLiteDriver = {
    async execute(sql: string, params: readonly unknown[] = []): Promise<SQLiteQueryResult> {
      const statement = database.prepare(sql);
      if (/^\s*(select|pragma|explain|with)/i.test(sql)) {
        return { rows: statement.all(...params) };
      }
      const info = statement.run(...params);
      return { rows: [], rowsAffected: Number(info.changes ?? 0) };
    },
    async transaction<T>(fn: (tx: SQLiteDriver) => Promise<T>): Promise<T> {
      database.exec('BEGIN');
      try {
        const result = await fn(driver);
        database.exec('COMMIT');
        return result;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
    async close(): Promise<void> {
      database.close();
    },
  };

  return { driver, database };
}
