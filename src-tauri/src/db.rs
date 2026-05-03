use anyhow::Result;
use rusqlite::Connection;
use std::path::Path;

pub fn init(db_path: &Path) -> Result<Connection> {
    let conn = Connection::open(db_path)?;
    create_tables(&conn)?;
    Ok(conn)
}

fn create_tables(conn: &Connection) -> Result<()> {
    // Idempotent migrations for columns added after initial schema
    let _ = conn.execute_batch(
        "ALTER TABLE contexts ADD COLUMN last_path TEXT NOT NULL DEFAULT '';",
    );
    let _ = conn.execute_batch(
        "ALTER TABLE contexts ADD COLUMN open_tabs TEXT NOT NULL DEFAULT '[]';",
    );
    let _ = conn.execute_batch(
        "ALTER TABLE contexts ADD COLUMN open_file_tabs TEXT NOT NULL DEFAULT '[]';",
    );

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
            created_at INTEGER NOT NULL DEFAULT (unixepoch()),
            PRIMARY KEY (file_id, tag_id)
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
            id       INTEGER PRIMARY KEY AUTOINCREMENT,
            path     TEXT    UNIQUE NOT NULL,
            name     TEXT    NOT NULL,
            is_dir   INTEGER NOT NULL DEFAULT 0,
            added_at INTEGER NOT NULL DEFAULT (unixepoch())
        );

        CREATE TABLE IF NOT EXISTS folder_tags (
            folder_path TEXT    NOT NULL,
            tag_id      INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
            PRIMARY KEY (folder_path, tag_id)
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
    Ok(())
}
