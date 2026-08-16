export interface SQLiteQueryResult {
  readonly rows: readonly Record<string, unknown>[];
  readonly rowsAffected?: number;
}

export interface SQLiteDriver {
  execute(sql: string, params?: readonly unknown[]): Promise<SQLiteQueryResult>;
  /**
   * Optional. The storage adapter never opens a transaction: every write it
   * issues is a single atomic statement, so a driver only needs `execute`.
   * Requiring `transaction()` used to invite implementations that emit a bare
   * BEGIN, which then failed once two claims overlapped under `concurrency > 1`.
   */
  transaction?<T>(fn: (tx: SQLiteDriver) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}

export interface SQLiteUploadStorageOptions {
  readonly databaseName?: string;
  readonly driver?: SQLiteDriver;
  readonly openDriver?: (databaseName: string) => Promise<SQLiteDriver> | SQLiteDriver;
}
