import type { SQLiteDriver, SQLiteQueryResult } from '../../src/adapters/sqlite/driver.js';

interface StoredRow {
  [key: string]: string | number | null;
  id: string;
  file_uri: string;
  file_name: string;
  mime_type: string | null;
  file_size: number | null;
  destination: string;
  method: string;
  status: string;
  attempts: number;
  max_attempts: number;
  idempotency_key: string;
  progress: number;
  bytes_uploaded: number | null;
  total_bytes: number | null;
  metadata: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  next_attempt_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  processing_token: string | null;
  processing_started_at: string | null;
  remote_id: string | null;
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

function cloneRow(row: StoredRow): StoredRow {
  return { ...row };
}

export function createFakeSQLiteDriver(): SQLiteDriver & { dump(): StoredRow[] } {
  const meta = new Map<string, string>();
  const rows = new Map<string, StoredRow>();

  const execute = async (
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<SQLiteQueryResult> => {
    const normalized = normalizeSql(sql);

    if (normalized.startsWith('create table') || normalized.startsWith('create index')) {
      return { rows: [], rowsAffected: 0 };
    }

    if (normalized.startsWith('insert into upload_meta')) {
      meta.set(String(params[0]), String(params[1]));
      return { rows: [], rowsAffected: 1 };
    }

    if (normalized.startsWith('select value from upload_meta')) {
      const value = meta.get(String(params[0]));
      return { rows: value === undefined ? [] : [{ value }] };
    }

    if (normalized.startsWith('insert into upload_queue')) {
      if (rows.has(String(params[0]))) {
        throw new Error('UNIQUE constraint failed: upload_queue.id');
      }

      const row: StoredRow = {
        id: String(params[0]),
        file_uri: String(params[1]),
        file_name: String(params[2]),
        mime_type: params[3] == null ? null : String(params[3]),
        file_size: params[4] == null ? null : Number(params[4]),
        destination: String(params[5]),
        method: String(params[6]),
        status: String(params[7]),
        attempts: Number(params[8]),
        max_attempts: Number(params[9]),
        idempotency_key: String(params[10]),
        progress: Number(params[11]),
        bytes_uploaded: params[12] == null ? null : Number(params[12]),
        total_bytes: params[13] == null ? null : Number(params[13]),
        metadata: params[14] == null ? null : String(params[14]),
        last_error: params[15] == null ? null : String(params[15]),
        created_at: String(params[16]),
        updated_at: String(params[17]),
        next_attempt_at: params[18] == null ? null : String(params[18]),
        started_at: params[19] == null ? null : String(params[19]),
        completed_at: params[20] == null ? null : String(params[20]),
        processing_token: params[21] == null ? null : String(params[21]),
        processing_started_at: params[22] == null ? null : String(params[22]),
        remote_id: params[23] == null ? null : String(params[23]),
      };
      rows.set(row.id, row);
      return { rows: [], rowsAffected: 1 };
    }

    if (normalized.startsWith('select * from upload_queue where id = ?')) {
      const row = rows.get(String(params[0]));
      return { rows: row ? [cloneRow(row)] : [] };
    }

    if (normalized.includes("where status = 'pending'")) {
      const nowIso = String(params[0]);
      const limit = Number(params[1] ?? 100);
      const pending = [...rows.values()]
        .filter((row) => {
          if (row.status !== 'pending') {
            return false;
          }
          if (row.next_attempt_at == null) {
            return true;
          }
          return row.next_attempt_at <= nowIso;
        })
        .sort((left, right) => left.created_at.localeCompare(right.created_at))
        .slice(0, limit)
        .map(cloneRow);
      return { rows: pending };
    }

    if (normalized.includes("where status = 'uploading'")) {
      const staleBefore = String(params[0]);
      const recoverable = [...rows.values()]
        .filter(
          (row) =>
            row.status === 'uploading' &&
            row.processing_started_at != null &&
            row.processing_started_at <= staleBefore,
        )
        .map(cloneRow);
      return { rows: recoverable };
    }

    if (normalized.startsWith('select * from upload_queue order by created_at')) {
      return {
        rows: [...rows.values()]
          .sort((left, right) => left.created_at.localeCompare(right.created_at))
          .map(cloneRow),
      };
    }

    if (normalized.startsWith("update upload_queue set status = 'uploading'")) {
      const id = String(params[4]);
      const current = rows.get(id);
      if (!current || current.status !== 'pending') {
        return { rows: [], rowsAffected: 0 };
      }

      current.status = 'uploading';
      current.processing_token = String(params[0]);
      current.processing_started_at = String(params[1]);
      current.started_at = current.started_at ?? String(params[2]);
      current.updated_at = String(params[3]);
      current.next_attempt_at = null;
      current.progress = 0;
      current.bytes_uploaded = 0;
      return { rows: [], rowsAffected: 1 };
    }

    if (normalized.startsWith('update upload_queue set file_uri')) {
      const id = String(params[23]);
      const current = rows.get(id);
      if (!current) {
        return { rows: [], rowsAffected: 0 };
      }

      current.file_uri = String(params[0]);
      current.file_name = String(params[1]);
      current.mime_type = params[2] == null ? null : String(params[2]);
      current.file_size = params[3] == null ? null : Number(params[3]);
      current.destination = String(params[4]);
      current.method = String(params[5]);
      current.status = String(params[6]);
      current.attempts = Number(params[7]);
      current.max_attempts = Number(params[8]);
      current.idempotency_key = String(params[9]);
      current.progress = Number(params[10]);
      current.bytes_uploaded = params[11] == null ? null : Number(params[11]);
      current.total_bytes = params[12] == null ? null : Number(params[12]);
      current.metadata = params[13] == null ? null : String(params[13]);
      current.last_error = params[14] == null ? null : String(params[14]);
      current.created_at = String(params[15]);
      current.updated_at = String(params[16]);
      current.next_attempt_at = params[17] == null ? null : String(params[17]);
      current.started_at = params[18] == null ? null : String(params[18]);
      current.completed_at = params[19] == null ? null : String(params[19]);
      current.processing_token = params[20] == null ? null : String(params[20]);
      current.processing_started_at = params[21] == null ? null : String(params[21]);
      current.remote_id = params[22] == null ? null : String(params[22]);
      return { rows: [], rowsAffected: 1 };
    }

    if (normalized.startsWith('delete from upload_queue where id = ?')) {
      const existed = rows.delete(String(params[0]));
      return { rows: [], rowsAffected: existed ? 1 : 0 };
    }

    if (normalized.startsWith("delete from upload_queue where status = 'completed' and updated_at")) {
      let deleted = 0;
      for (const [id, row] of rows.entries()) {
        if (row.status === 'completed' && row.updated_at <= String(params[0])) {
          rows.delete(id);
          deleted += 1;
        }
      }
      return { rows: [], rowsAffected: deleted };
    }

    if (normalized.startsWith("delete from upload_queue where status = 'completed'")) {
      let deleted = 0;
      for (const [id, row] of rows.entries()) {
        if (row.status === 'completed') {
          rows.delete(id);
          deleted += 1;
        }
      }
      return { rows: [], rowsAffected: deleted };
    }

    throw new Error(`Unsupported SQL in fake driver: ${sql}`);
  };

  return {
    execute,
    async transaction<T>(fn: (tx: SQLiteDriver) => Promise<T>): Promise<T> {
      return fn({ execute, transaction: this.transaction });
    },
    dump(): StoredRow[] {
      return [...rows.values()].map(cloneRow);
    },
  };
}
