import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { dataDirectory } from './config.mjs';
import photosMigration from '../../drizzle/0000_common_starhawk.sql?raw';
import seriesMigration from '../../drizzle/0001_majestic_vulture.sql?raw';
import uploadsMigration from '../../drizzle/0002_shiny_captain_cross.sql?raw';
import albumMigration from '../../drizzle/0003_photo_album.sql?raw';
import { defaultSeries } from '../../db/default-series.ts';

const accountContext = new AsyncLocalStorage();
const databases = new Map();

function openGallery(accountId, storageId, create) {
  const directory = accountId === 1 ? dataDirectory : resolve(dataDirectory, 'photographers', storageId);
  const filename = resolve(directory, 'gallery.sqlite');
  if(create && accountId !== 1 && existsSync(filename)) throw new Error('A gallery already exists for this new storage identifier.');
  if (!create && !existsSync(filename)) {
    console.error(`Gallery database is missing for account ${accountId}.`);
    throw new Error('Photographer database is missing. Restore a backup before starting the service.');
  }
  mkdirSync(directory, { recursive: true });
  const sqlite = new DatabaseSync(filename);
  sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  sqlite.exec('PRAGMA cache_size=-1024;');
  sqlite.exec('CREATE TABLE IF NOT EXISTS server_migrations (name TEXT PRIMARY KEY)');
  for (const [name, sql] of [['0000', photosMigration], ['0001', seriesMigration], ['0002', uploadsMigration], ['0003', albumMigration]]) {
    if (sqlite.prepare('SELECT name FROM server_migrations WHERE name = ?').get(name)) continue;
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      sqlite.exec(sql);
      sqlite.prepare('INSERT INTO server_migrations (name) VALUES (?)').run(name);
      sqlite.exec('COMMIT');
    } catch (error) {
      sqlite.exec('ROLLBACK');
      throw error;
    }
  }
  sqlite.exec(`CREATE TABLE IF NOT EXISTS admin_account (
    id INTEGER PRIMARY KEY CHECK (id = 1), username TEXT NOT NULL, password_hash TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS admin_sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);`);
  sqlite.exec(`CREATE TABLE IF NOT EXISTS object_sizes (photo_id TEXT PRIMARY KEY, size INTEGER NOT NULL CHECK (size >= 0));
  CREATE TRIGGER IF NOT EXISTS remove_object_size AFTER DELETE ON photos BEGIN DELETE FROM object_sizes WHERE photo_id = OLD.id; END;`);
  sqlite.exec(`CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    is_pinned INTEGER NOT NULL DEFAULT 0 CHECK (is_pinned IN (0,1)), sort_order INTEGER NOT NULL DEFAULT 0
  );`);
  if (!sqlite.prepare('PRAGMA table_info(notes)').all().some(column=>column.name === 'title')) {
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      sqlite.exec("ALTER TABLE notes ADD COLUMN title TEXT NOT NULL DEFAULT ''");
      const update = sqlite.prepare('UPDATE notes SET title=? WHERE id=?');
      for (const note of sqlite.prepare('SELECT id,content FROM notes').all()) {
        const title = note.content.split(/\r\n|\r|\n/,1)[0].trim().slice(0,80).trim();
        update.run(title,note.id);
      }
      sqlite.exec('COMMIT');
    } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  }
  const noteColumns = new Set(sqlite.prepare('PRAGMA table_info(notes)').all().map(column=>column.name));
  if (!noteColumns.has('is_pinned') || !noteColumns.has('sort_order')) {
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      if (!noteColumns.has('is_pinned')) sqlite.exec('ALTER TABLE notes ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0 CHECK (is_pinned IN (0,1))');
      if (!noteColumns.has('sort_order')) {
        sqlite.exec('ALTER TABLE notes ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
        const update = sqlite.prepare('UPDATE notes SET sort_order=? WHERE id=?');
        for (const [index,note] of sqlite.prepare('SELECT id FROM notes ORDER BY created_at DESC,id').all().entries()) update.run(index,note.id);
      }
      sqlite.exec('COMMIT');
    } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  }
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    if (!sqlite.prepare("SELECT value FROM settings WHERE key = 'series_initialized'").get()) {
      const insert = sqlite.prepare('INSERT INTO series (id,name,description,sort_order,created_at) VALUES (?,?,?,?,?)');
      for (const series of defaultSeries) insert.run(series.id, series.name, series.description, series.sortOrder, new Date().toISOString());
      sqlite.prepare("INSERT INTO settings VALUES ('series_initialized','1')").run();
    }
    sqlite.prepare("INSERT OR IGNORE INTO settings VALUES ('gallery_initialized','1')").run();
    sqlite.exec('COMMIT');
  } catch (error) { sqlite.exec('ROLLBACK'); throw error; }

  class PreparedStatement {
    constructor(sql, values = []) { this.sql = sql; this.values = values; }
    bind(...values) { return new PreparedStatement(this.sql, values); }
    async first() { return sqlite.prepare(this.sql).get(...this.values) ?? null; }
    async all() { return { results: sqlite.prepare(this.sql).all(...this.values) }; }
    run() {
      const result = sqlite.prepare(this.sql).run(...this.values);
      return { success: true, meta: { changes: Number(result.changes) } };
    }
  }

  // Preserve the existing route contracts and atomic D1 batches on a single SQLite connection.
  const database = {
    prepare(sql) { return new PreparedStatement(sql); },
    async batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map(statement => statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return { sqlite, database };
}

databases.set('legacy-owner', openGallery(1,'legacy-owner',!existsSync(resolve(dataDirectory,'platform.sqlite'))));
export const sqlite = databases.get('legacy-owner').sqlite;
export function getAccountGallery(accountId, storageId) {
  if(accountId !== 1 && !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(storageId)) throw new Error('Invalid photographer storage identifier.');
  const key=accountId === 1 ? 'legacy-owner' : storageId;
  if (!databases.has(key)) databases.set(key, openGallery(accountId,key,false));
  return databases.get(key);
}
export function getGalleryNotes(accountId, storageId) {
  const sqlite = getAccountGallery(accountId,storageId).sqlite;
  return sqlite.prepare('SELECT id,title,content,created_at AS createdAt,updated_at AS updatedAt,is_pinned AS isPinned,sort_order AS sortOrder FROM notes ORDER BY is_pinned DESC,sort_order,created_at DESC,id')
    .all().map(note=>({ ...note, isPinned: note.isPinned === 1 }));
}
export function createAccountGallery(accountId, storageId) { databases.set(storageId,openGallery(accountId,storageId,true)); }
export function getCurrentAccount() { return accountContext.getStore(); }
export function withAccount(account, callback) { return accountContext.run(account, callback); }
export function getDatabase() { const account=accountContext.getStore();return getAccountGallery(account?.id ?? 1,account?.storage_id).database; }
export function getSqlite() { const account=accountContext.getStore();return getAccountGallery(account?.id ?? 1,account?.storage_id).sqlite; }
export function closeDatabases() { for (const entry of databases.values()) entry.sqlite.close(); }
