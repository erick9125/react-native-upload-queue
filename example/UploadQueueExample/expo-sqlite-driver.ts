import * as SQLite from 'expo-sqlite';
import type { SQLiteDriver } from '@erickmorales91/react-native-upload-queue';

/**
 * Adapts `expo-sqlite` to the driver the queue expects.
 *
 * Only `execute` is required: the storage adapter issues one atomic statement
 * per write and never opens a transaction, so there is no BEGIN/COMMIT to
 * manage and no way for concurrent claims to collide on a single connection.
 */
export async function openExpoSQLiteDriver(databaseName: string): Promise<SQLiteDriver> {
  const database = await SQLite.openDatabaseAsync(databaseName);

  return {
    async execute(sql, params = []) {
      const bindings = params as SQLite.SQLiteBindValue[];

      if (/^\s*(select|pragma|with)/i.test(sql)) {
        const rows = await database.getAllAsync<Record<string, unknown>>(sql, bindings);
        return { rows };
      }

      const result = await database.runAsync(sql, bindings);
      return { rows: [], rowsAffected: result.changes };
    },

    async close() {
      await database.closeAsync();
    },
  };
}
