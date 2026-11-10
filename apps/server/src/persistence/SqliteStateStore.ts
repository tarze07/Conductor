import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface SqliteStateStoreOptions {
  /**
   * Path to `statev2.sqlite`, or `":memory:"` for in-memory test databases.
   */
  readonly dbPath: string;
}

export class SqliteStateStore {
  public readonly db: DatabaseSync;
  public readonly dbPath: string;

  constructor(options: SqliteStateStoreOptions) {
    this.dbPath = options.dbPath;
    if (options.dbPath !== ":memory:") {
      mkdirSync(dirname(options.dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(options.dbPath);
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        stream_id TEXT NOT NULL,
        stream_version INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_events_stream_seq
        ON events(stream_id, seq);

      CREATE TABLE IF NOT EXISTS command_receipts (
        command_id TEXT PRIMARY KEY,
        stream_id TEXT NOT NULL,
        result_seq INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS outbox (
        effect_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        stream_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_outbox_status_created
        ON outbox(status, created_at);

      CREATE TABLE IF NOT EXISTS projections_projects (
        project_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL,
        default_branch TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projections_threads (
        thread_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        provider_instance_id TEXT NOT NULL,
        model TEXT NOT NULL,
        runtime_mode TEXT NOT NULL,
        status TEXT NOT NULL,
        last_event_seq INTEGER NOT NULL DEFAULT 0,
        pruned_through_seq INTEGER NOT NULL DEFAULT 0,
        pull_requests_json TEXT NOT NULL DEFAULT '[]',
        worktree_branch TEXT,
        link_origin_json TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projections_turns (
        turn_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        checkpoint_ref TEXT,
        diff_summary_json TEXT,
        error_message TEXT,
        started_at TEXT NOT NULL,
        finalized_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_projections_turns_thread
        ON projections_turns(thread_id, started_at);

      CREATE TABLE IF NOT EXISTS projections_runtime_requests (
        request_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        question TEXT NOT NULL,
        options_json TEXT NOT NULL,
        status TEXT NOT NULL,
        selected_option_id TEXT,
        message_reply TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );

      CREATE TABLE IF NOT EXISTS auth_sessions (
        session_id TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        dpop_jkt TEXT,
        scopes_json TEXT NOT NULL,
        mode_ceiling TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS pairing_grants (
        pairing_id TEXT PRIMARY KEY,
        code_hash TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        mode_ceiling TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  public inTransaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Ignore rollback failure if transaction already closed
      }
      throw error;
    }
  }

  public close(): void {
    this.db.close();
  }
}
