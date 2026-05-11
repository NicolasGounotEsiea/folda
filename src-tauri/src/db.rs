use anyhow::Result;
use rusqlite::Connection;
use std::path::Path;

pub fn init(db_path: &Path) -> Result<Connection> {
    let conn = Connection::open(db_path)?;
    create_tables(&conn)?;
    Ok(conn)
}

fn has_column(conn: &Connection, table: &str, column: &str) -> bool {
    conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info(?1) WHERE name = ?2",
        rusqlite::params![table, column],
        |r| r.get::<_, i64>(0),
    ).unwrap_or(0) > 0
}

fn create_tables(conn: &Connection) -> Result<()> {
    // ── 1. Create all base tables first (idempotent) ──────────────────────────
    conn.execute_batch(
        "
        PRAGMA journal_mode=WAL;
        PRAGMA foreign_keys=ON;

        CREATE TABLE IF NOT EXISTS files (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            path         TEXT    UNIQUE NOT NULL,
            name         TEXT    NOT NULL,
            extension    TEXT    NOT NULL DEFAULT '',
            size         INTEGER NOT NULL DEFAULT 0,
            created_at   INTEGER NOT NULL DEFAULT 0,
            modified_at  INTEGER NOT NULL DEFAULT 0,
            accessed_at  INTEGER NOT NULL DEFAULT 0,
            indexed_at   INTEGER NOT NULL DEFAULT (unixepoch())
        );

        CREATE TABLE IF NOT EXISTS tags (
            id      INTEGER PRIMARY KEY AUTOINCREMENT,
            name    TEXT    UNIQUE NOT NULL,
            color   TEXT    NOT NULL DEFAULT '#6366f1',
            is_auto INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS file_tags (
            file_id    INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
            tag_id     INTEGER NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
            context_id INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL DEFAULT (unixepoch()),
            PRIMARY KEY (file_id, tag_id, context_id)
        );

        CREATE TABLE IF NOT EXISTS contexts (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            name            TEXT    NOT NULL,
            icon            TEXT    NOT NULL DEFAULT '📁',
            watched_paths   TEXT    NOT NULL DEFAULT '[]',
            pinned_tag_ids  TEXT    NOT NULL DEFAULT '[]',
            is_active       INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS activity (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            file_id   INTEGER REFERENCES files(id) ON DELETE SET NULL,
            file_path TEXT    NOT NULL,
            file_name TEXT    NOT NULL DEFAULT '',
            action    TEXT    NOT NULL,
            timestamp INTEGER NOT NULL DEFAULT (unixepoch()),
            app_name  TEXT
        );

        CREATE INDEX IF NOT EXISTS activity_timestamp_idx ON activity(timestamp DESC);
        CREATE INDEX IF NOT EXISTS activity_path_idx      ON activity(file_path);

        CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS watched_paths (
            path TEXT PRIMARY KEY,
            added_at INTEGER NOT NULL DEFAULT (unixepoch())
        );

        CREATE TABLE IF NOT EXISTS directories (
            path        TEXT    PRIMARY KEY,
            name        TEXT    NOT NULL,
            modified_at INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_directories_name
            ON directories (name COLLATE NOCASE);

        CREATE TABLE IF NOT EXISTS pinned_items (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            path       TEXT    NOT NULL,
            name       TEXT    NOT NULL,
            is_dir     INTEGER NOT NULL DEFAULT 0,
            context_id INTEGER NOT NULL DEFAULT 0,
            added_at   INTEGER NOT NULL DEFAULT (unixepoch()),
            UNIQUE(path, context_id)
        );

        CREATE TABLE IF NOT EXISTS folder_tags (
            folder_path TEXT    NOT NULL,
            tag_id      INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
            context_id  INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (folder_path, tag_id, context_id)
        );

        CREATE TABLE IF NOT EXISTS tag_rules (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            tag_id     INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
            context_id INTEGER NOT NULL DEFAULT 0,
            rule_type  TEXT    NOT NULL,
            rule_value TEXT    NOT NULL,
            created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );

        CREATE TABLE IF NOT EXISTS saved_views (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT    NOT NULL,
            icon       TEXT    NOT NULL DEFAULT '🔖',
            tag_ids    TEXT    NOT NULL DEFAULT '[]',
            context_id INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );

        CREATE TABLE IF NOT EXISTS snapshots (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            file_path TEXT    NOT NULL,
            timestamp INTEGER NOT NULL DEFAULT (unixepoch()),
            size      INTEGER NOT NULL DEFAULT 0,
            content   BLOB    NOT NULL
        );

        CREATE INDEX IF NOT EXISTS snapshots_path_ts ON snapshots(file_path, timestamp DESC);

        CREATE TABLE IF NOT EXISTS share_permissions (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            context_id  INTEGER NOT NULL,
            path        TEXT    NOT NULL DEFAULT '',
            can_list    INTEGER NOT NULL DEFAULT 1,
            can_read    INTEGER NOT NULL DEFAULT 1,
            can_create  INTEGER NOT NULL DEFAULT 1,
            can_update  INTEGER NOT NULL DEFAULT 1,
            can_delete  INTEGER NOT NULL DEFAULT 1,
            guest_id    TEXT    DEFAULT NULL,
            UNIQUE(context_id, path)
        );

        CREATE TABLE IF NOT EXISTS trash_items (
            id            TEXT    PRIMARY KEY,
            original_path TEXT    NOT NULL,
            name          TEXT    NOT NULL,
            is_dir        INTEGER NOT NULL DEFAULT 0,
            deleted_at    INTEGER NOT NULL DEFAULT (unixepoch()),
            size          INTEGER NOT NULL DEFAULT 0
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
            name,
            extension,
            content=files,
            content_rowid=id
        );

        CREATE TRIGGER IF NOT EXISTS files_ai AFTER INSERT ON files BEGIN
            INSERT INTO files_fts(rowid, name, extension)
            VALUES (new.id, new.name, new.extension);
        END;

        CREATE TRIGGER IF NOT EXISTS files_ad AFTER DELETE ON files BEGIN
            INSERT INTO files_fts(files_fts, rowid, name, extension)
            VALUES ('delete', old.id, old.name, old.extension);
        END;

        CREATE TRIGGER IF NOT EXISTS files_au AFTER UPDATE ON files BEGIN
            INSERT INTO files_fts(files_fts, rowid, name, extension)
            VALUES ('delete', old.id, old.name, old.extension);
            INSERT INTO files_fts(rowid, name, extension)
            VALUES (new.id, new.name, new.extension);
        END;
        ",
    )?;

    // ── 2. Additive column migrations (safe to run on existing DBs) ───────────
    let _ = conn.execute_batch(
        "ALTER TABLE contexts ADD COLUMN last_path TEXT NOT NULL DEFAULT '';",
    );
    let _ = conn.execute_batch(
        "ALTER TABLE contexts ADD COLUMN open_tabs TEXT NOT NULL DEFAULT '[]';",
    );
    let _ = conn.execute_batch(
        "ALTER TABLE contexts ADD COLUMN open_file_tabs TEXT NOT NULL DEFAULT '[]';",
    );

    // Migration: add context_id to pinned_items (old DBs had UNIQUE on path only)
    if !has_column(conn, "pinned_items", "context_id") {
        conn.execute_batch("
            BEGIN;
            CREATE TABLE pinned_items_new (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                path       TEXT    NOT NULL,
                name       TEXT    NOT NULL,
                is_dir     INTEGER NOT NULL DEFAULT 0,
                context_id INTEGER NOT NULL DEFAULT 0,
                added_at   INTEGER NOT NULL DEFAULT (unixepoch()),
                UNIQUE(path, context_id)
            );
            INSERT OR IGNORE INTO pinned_items_new (id, path, name, is_dir, added_at)
                SELECT id, path, name, is_dir, added_at FROM pinned_items;
            DROP TABLE pinned_items;
            ALTER TABLE pinned_items_new RENAME TO pinned_items;
            COMMIT;
        ")?;
    }

    // Migration: add context_id to file_tags
    if !has_column(conn, "file_tags", "context_id") {
        conn.execute_batch("
            BEGIN;
            CREATE TABLE file_tags_new (
                file_id    INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
                tag_id     INTEGER NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
                context_id INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL DEFAULT (unixepoch()),
                PRIMARY KEY (file_id, tag_id, context_id)
            );
            INSERT OR IGNORE INTO file_tags_new (file_id, tag_id, created_at)
                SELECT file_id, tag_id, created_at FROM file_tags;
            DROP TABLE file_tags;
            ALTER TABLE file_tags_new RENAME TO file_tags;
            COMMIT;
        ")?;
    }

    // Migration: add context_id to folder_tags
    if !has_column(conn, "folder_tags", "context_id") {
        conn.execute_batch("
            BEGIN;
            CREATE TABLE folder_tags_new (
                folder_path TEXT    NOT NULL,
                tag_id      INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
                context_id  INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (folder_path, tag_id, context_id)
            );
            INSERT OR IGNORE INTO folder_tags_new (folder_path, tag_id)
                SELECT folder_path, tag_id FROM folder_tags;
            DROP TABLE folder_tags;
            ALTER TABLE folder_tags_new RENAME TO folder_tags;
            COMMIT;
        ")?;
    }

    Ok(())
}
