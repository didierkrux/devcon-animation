// SQLite state: what each talk looked like last run, what was rendered and
// uploaded, and a log of every change so each run is a diff of the last.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type TalkRow = {
  code: string;
  session_id: string;
  title: string;
  room: string;
  start_ms: number;
  do_not_record: number;
  session_hash: string;
  card_md5: string | null;
  first_seen: string;
  last_seen: string;
  removed_at: string | null;
  // consecutive runs the talk was absent from the API; removal needs 2
  missing_runs: number;
  // last problem (cleared on success); logged only when it changes
  status: string | null;
};

/** One rendered file per talk and size (1080p, plus the stage screen size). */
export type OutputRow = {
  code: string;
  // "1920x1080", "4032x1512", ...
  size: string;
  render_key: string | null;
  rendered_at: string | null;
  out_file: string | null;
  out_md5: string | null;
  drive_file_id: string | null;
  drive_path: string | null;
  drive_md5: string | null;
  uploaded_at: string | null;
};

export type LogKind =
  | "added"
  | "removed"
  | "restored"
  | "title"
  | "room"
  | "time"
  | "do_not_record"
  | "card"
  | "rendered"
  | "uploaded"
  | "moved"
  | "trashed"
  | "problem"
  | "resolved";

export type LogRow = {
  id: number;
  run_id: number;
  code: string | null;
  kind: LogKind;
  before: string | null;
  after: string | null;
  at: string;
};

export type RunRow = {
  id: number;
  started_at: string;
  finished_at: string | null;
  status: "running" | "ok" | "failed";
  summary: string | null;
  error: string | null;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS talks (
  code TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  title TEXT NOT NULL,
  room TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  do_not_record INTEGER NOT NULL DEFAULT 0,
  session_hash TEXT NOT NULL,
  card_md5 TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  removed_at TEXT,
  missing_runs INTEGER NOT NULL DEFAULT 0,
  status TEXT
);
CREATE TABLE IF NOT EXISTS outputs (
  code TEXT NOT NULL REFERENCES talks(code),
  size TEXT NOT NULL,
  render_key TEXT,
  rendered_at TEXT,
  out_file TEXT,
  out_md5 TEXT,
  drive_file_id TEXT,
  drive_path TEXT,
  drive_md5 TEXT,
  uploaded_at TEXT,
  PRIMARY KEY (code, size)
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  summary TEXT,
  error TEXT
);
CREATE TABLE IF NOT EXISTS log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  code TEXT,
  kind TEXT NOT NULL,
  before TEXT,
  after TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS log_run ON log(run_id);
CREATE INDEX IF NOT EXISTS log_code ON log(code);
`;

const now = () => new Date().toISOString();

export class Db {
  readonly sql: DatabaseSync;

  constructor(file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.sql = new DatabaseSync(file);
    this.sql.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.sql.exec(SCHEMA);
    this.migrate();
    // Early runs stored the API's ISO start strings; keep start_ms numeric.
    this.sql.exec(
      "UPDATE talks SET start_ms = CAST(strftime('%s', start_ms) AS INTEGER) * 1000 WHERE typeof(start_ms) = 'text'",
    );
  }

  /** Databases from before per-size outputs kept one render/upload per talk on the talks table. */
  private migrate() {
    const cols = (this.sql.prepare("PRAGMA table_info(talks)").all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("missing_runs")) this.sql.exec("ALTER TABLE talks ADD COLUMN missing_runs INTEGER NOT NULL DEFAULT 0");
    if (!cols.includes("render_key")) return;
    this.sql.exec(`
      BEGIN;
      INSERT OR IGNORE INTO outputs (code, size, render_key, rendered_at, out_file, out_md5, drive_file_id, drive_path, drive_md5, uploaded_at)
        SELECT code, '1920x1080', render_key, rendered_at, out_file, out_md5, drive_file_id, drive_path, drive_md5, uploaded_at
        FROM talks WHERE render_key IS NOT NULL OR drive_file_id IS NOT NULL;
      ALTER TABLE talks DROP COLUMN render_key;
      ALTER TABLE talks DROP COLUMN rendered_at;
      ALTER TABLE talks DROP COLUMN out_file;
      ALTER TABLE talks DROP COLUMN out_md5;
      ALTER TABLE talks DROP COLUMN drive_file_id;
      ALTER TABLE talks DROP COLUMN drive_path;
      ALTER TABLE talks DROP COLUMN drive_md5;
      ALTER TABLE talks DROP COLUMN uploaded_at;
      COMMIT;
    `);
  }

  outputs(code?: string): OutputRow[] {
    return (code
      ? this.sql.prepare("SELECT * FROM outputs WHERE code = ?").all(code)
      : this.sql.prepare("SELECT * FROM outputs").all()) as unknown as OutputRow[];
  }

  output(code: string, size: string): OutputRow | undefined {
    return this.sql.prepare("SELECT * FROM outputs WHERE code = ? AND size = ?").get(code, size) as unknown as OutputRow | undefined;
  }

  upsertOutput(code: string, size: string, fields: Partial<Omit<OutputRow, "code" | "size">>) {
    this.sql.prepare("INSERT OR IGNORE INTO outputs (code, size) VALUES (?, ?)").run(code, size);
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (keys.length === 0) return;
    this.sql
      .prepare(`UPDATE outputs SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE code = ? AND size = ?`)
      .run(...keys.map((k) => (fields[k] ?? null) as string | number | null), code, size);
  }

  deleteOutput(code: string, size: string) {
    this.sql.prepare("DELETE FROM outputs WHERE code = ? AND size = ?").run(code, size);
  }

  startRun(): number {
    const r = this.sql
      .prepare("INSERT INTO runs (started_at, status) VALUES (?, 'running')")
      .run(now());
    return Number(r.lastInsertRowid);
  }

  finishRun(id: number, status: "ok" | "failed", summary: object, error?: string) {
    this.sql
      .prepare("UPDATE runs SET finished_at = ?, status = ?, summary = ?, error = ? WHERE id = ?")
      .run(now(), status, JSON.stringify(summary), error ?? null, id);
  }

  log(runId: number, code: string | null, kind: LogKind, before?: unknown, after?: unknown) {
    const s = (v: unknown) => (v === undefined || v === null ? null : typeof v === "string" ? v : JSON.stringify(v));
    this.sql
      .prepare("INSERT INTO log (run_id, code, kind, before, after, at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(runId, code, kind, s(before), s(after), now());
  }

  talks(): TalkRow[] {
    return this.sql.prepare("SELECT * FROM talks").all() as unknown as TalkRow[];
  }

  talk(code: string): TalkRow | undefined {
    return this.sql.prepare("SELECT * FROM talks WHERE code = ?").get(code) as unknown as TalkRow | undefined;
  }

  insertTalk(t: Pick<TalkRow, "code" | "session_id" | "title" | "room" | "start_ms" | "do_not_record" | "session_hash">) {
    const ts = now();
    this.sql
      .prepare(
        `INSERT INTO talks (code, session_id, title, room, start_ms, do_not_record, session_hash, first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(t.code, t.session_id, t.title, t.room, t.start_ms, t.do_not_record, t.session_hash, ts, ts);
  }

  /** Partial update; `last_seen` is not touched unless passed. */
  updateTalk(code: string, fields: Partial<Omit<TalkRow, "code">>) {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (keys.length === 0) return;
    this.sql
      .prepare(`UPDATE talks SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE code = ?`)
      .run(...keys.map((k) => (fields[k] ?? null) as string | number | null), code);
  }

  /** Records a problem only when it differs from the talk's current one. */
  setStatus(runId: number, code: string, status: string | null) {
    const prev = this.talk(code)?.status ?? null;
    if (prev === status) return;
    this.updateTalk(code, { status });
    if (status) this.log(runId, code, "problem", prev, status);
    else this.log(runId, code, "resolved", prev, null);
  }

  runs(limit: number): RunRow[] {
    return this.sql.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT ?").all(limit) as unknown as RunRow[];
  }

  logFor(where: { runId?: number; code?: string }, limit = 500): LogRow[] {
    if (where.runId !== undefined) {
      return this.sql.prepare("SELECT * FROM log WHERE run_id = ? ORDER BY id LIMIT ?").all(where.runId, limit) as unknown as LogRow[];
    }
    if (where.code !== undefined) {
      return this.sql.prepare("SELECT * FROM log WHERE code = ? ORDER BY id DESC LIMIT ?").all(where.code, limit) as unknown as LogRow[];
    }
    return this.sql.prepare("SELECT * FROM log ORDER BY id DESC LIMIT ?").all(limit) as unknown as LogRow[];
  }

  close() {
    this.sql.close();
  }
}

export const nowIso = now;
