export interface SQLiteQueryResult {
  readonly rows: readonly Record<string, unknown>[];
  readonly rowsAffected?: number;
}

export interface SQLiteDriver {
  execute(sql: string, params?: readonly unknown[]): Promise<SQLiteQueryResult>;
  transaction<T>(fn: (tx: SQLiteDriver) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}

export interface SQLiteUploadStorageOptions {
  readonly databaseName?: string;
  readonly driver?: SQLiteDriver;
  readonly openDriver?: (databaseName: string) => Promise<SQLiteDriver> | SQLiteDriver;
}
