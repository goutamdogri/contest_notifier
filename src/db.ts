import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface ContestRecord {
  key: string;
  platform: string;
  platform_id: string;
  name: string;
  start_utc: string;
  end_utc: string;
  url: string;
  content_hash: string;
  calendar_event_id: string | null;
  task_id: string | null;
  task_list_id: string | null;
  task_hash: string | null;
  created_at: string;
  updated_at: string;
}

export interface SourceFetchRecord {
  source: string;
  last_fetch_at: string | null;
  last_status: string | null;
  last_error: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS contests (
  key                TEXT PRIMARY KEY,
  platform           TEXT NOT NULL,
  platform_id        TEXT NOT NULL,
  name               TEXT NOT NULL,
  start_utc          TEXT NOT NULL,
  end_utc            TEXT NOT NULL,
  url                TEXT NOT NULL,
  content_hash       TEXT NOT NULL,
  calendar_event_id  TEXT,
  task_id            TEXT,
  task_list_id       TEXT,
  task_hash          TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_state (
  source        TEXT PRIMARY KEY,
  last_fetch_at TEXT,
  last_status   TEXT,
  last_error    TEXT
);

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
`;

export class Store {
  private readonly db: DatabaseSync;

  constructor(dbFile: string) {
    mkdirSync(dirname(dbFile), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(dbFile);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /**
   * Additive migrations for databases created by an older version. SQLite has no
   * "ADD COLUMN IF NOT EXISTS", so the column list is inspected first.
   */
  private migrate(): void {
    const columns = new Set(
      (
        this.db.prepare('PRAGMA table_info(contests)').all() as unknown as Array<{ name: string }>
      ).map((c) => c.name),
    );
    if (!columns.has('task_hash')) {
      this.db.exec('ALTER TABLE contests ADD COLUMN task_hash TEXT');
    }
  }

  close(): void {
    this.db.close();
  }

  getContest(key: string): ContestRecord | undefined {
    const row = this.db.prepare('SELECT * FROM contests WHERE key = ?').get(key) as
      | Record<string, unknown>
      | undefined;
    return row ? (row as unknown as ContestRecord) : undefined;
  }

  allContests(): ContestRecord[] {
    return this.db.prepare('SELECT * FROM contests').all() as unknown as ContestRecord[];
  }

  upsertContest(record: Omit<ContestRecord, 'created_at' | 'updated_at'>): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO contests
           (key, platform, platform_id, name, start_utc, end_utc, url, content_hash,
            calendar_event_id, task_id, task_list_id, task_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           name = excluded.name,
           start_utc = excluded.start_utc,
           end_utc = excluded.end_utc,
           url = excluded.url,
           content_hash = excluded.content_hash,
           calendar_event_id = excluded.calendar_event_id,
           task_id = excluded.task_id,
           task_list_id = excluded.task_list_id,
           task_hash = excluded.task_hash,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.key,
        record.platform,
        record.platform_id,
        record.name,
        record.start_utc,
        record.end_utc,
        record.url,
        record.content_hash,
        record.calendar_event_id,
        record.task_id,
        record.task_list_id,
        record.task_hash,
        now,
        now,
      );
  }

  setCalendarEventId(key: string, eventId: string): void {
    this.db
      .prepare('UPDATE contests SET calendar_event_id = ?, updated_at = ? WHERE key = ?')
      .run(eventId, new Date().toISOString(), key);
  }

  setTaskRef(key: string, taskId: string, taskListId: string, taskHash: string): void {
    this.db
      .prepare(
        `UPDATE contests
            SET task_id = ?, task_list_id = ?, task_hash = ?, updated_at = ?
          WHERE key = ?`,
      )
      .run(taskId, taskListId, taskHash, new Date().toISOString(), key);
  }

  deleteContest(key: string): void {
    this.db.prepare('DELETE FROM contests WHERE key = ?').run(key);
  }

  /**
   * Keys for contests that have not finished yet.
   *
   * The task prune keeps everything in this set rather than only what the current run
   * happened to fetch. Otherwise a source skipped by its poll interval would look
   * "absent" and its still-future tasks would be deleted.
   */
  unendedContestKeys(nowUtc: string): string[] {
    return (
      this.db
        .prepare('SELECT key FROM contests WHERE end_utc >= ?')
        .all(nowUtc) as unknown as Array<{ key: string }>
    ).map((r) => r.key);
  }

  setContentHash(key: string, hash: string): void {
    this.db
      .prepare('UPDATE contests SET content_hash = ?, updated_at = ? WHERE key = ?')
      .run(hash, new Date().toISOString(), key);
  }

  /** Keys the platform no longer reports as upcoming and that have already started. */
  staleStartedKeys(nowUtc: string): string[] {
    return (
      this.db
        .prepare('SELECT key FROM contests WHERE end_utc < ?')
        .all(nowUtc) as unknown as Array<{ key: string }>
    ).map((r) => r.key);
  }

  getSourceState(source: string): SourceFetchRecord {
    const row = this.db.prepare('SELECT * FROM source_state WHERE source = ?').get(source) as
      | Record<string, unknown>
      | undefined;
    return {
      source,
      last_fetch_at: (row?.last_fetch_at as string | undefined) ?? null,
      last_status: (row?.last_status as string | undefined) ?? null,
      last_error: (row?.last_error as string | undefined) ?? null,
    };
  }

  setSourceState(source: string, status: string, error?: string): void {
    this.db
      .prepare(
        `INSERT INTO source_state (source, last_fetch_at, last_status, last_error)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(source) DO UPDATE SET
           last_fetch_at = excluded.last_fetch_at,
           last_status = excluded.last_status,
           last_error = excluded.last_error`,
      )
      .run(source, new Date().toISOString(), status, error ?? null);
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT v FROM meta WHERE k = ?').get(key) as
      | { v: string }
      | undefined;
    return row?.v;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .run(key, value);
  }
}
