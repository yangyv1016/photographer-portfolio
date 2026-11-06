import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { sqlite as legacy } from './database.mjs';
import { dataDirectory } from './config.mjs';

export const defaultQuotaBytes = 5 * 1024 ** 3;
export const platformDatabase = new DatabaseSync(resolve(dataDirectory, 'platform.sqlite'));
platformDatabase.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  login_id TEXT NOT NULL UNIQUE COLLATE NOCASE,
  public_id TEXT NOT NULL UNIQUE COLLATE NOCASE,
  storage_id TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK (role IN ('admin','photographer')),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  listed INTEGER NOT NULL DEFAULT 1 CHECK (listed IN (0,1)),
  quota_bytes INTEGER NOT NULL DEFAULT ${defaultQuotaBytes} CHECK (quota_bytes >= 0),
  avatar_key TEXT,
  avatar_size INTEGER NOT NULL DEFAULT 0 CHECK (avatar_size >= 0),
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS invitations (
  id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, hint TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '', quota_bytes INTEGER NOT NULL CHECK (quota_bytes >= 0),
  created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
  expires_at INTEGER, revoked_at TEXT, used_at TEXT, used_by INTEGER REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS platform_migrations (name TEXT PRIMARY KEY);`);

if (!platformDatabase.prepare("SELECT name FROM platform_migrations WHERE name='legacy-owner'").get()) {
  const account = legacy.prepare('SELECT username,password_hash FROM admin_account WHERE id=1').get();
  platformDatabase.exec('BEGIN IMMEDIATE');
  try {
    if (account) {
      platformDatabase.prepare("INSERT INTO users (id,login_id,public_id,storage_id,password_hash,display_name,role,quota_bytes,created_at) VALUES (1,?,'yangyu','legacy-owner',?,'旸隅','admin',?,?)")
        .run(account.username, account.password_hash, defaultQuotaBytes, new Date().toISOString());
      const insert = platformDatabase.prepare('INSERT OR IGNORE INTO sessions VALUES (?,1,?)');
      for (const session of legacy.prepare('SELECT token_hash,expires_at FROM admin_sessions').all()) insert.run(session.token_hash, session.expires_at);
    }
    platformDatabase.prepare("INSERT INTO platform_migrations VALUES ('legacy-owner')").run();
    platformDatabase.exec('COMMIT');
  } catch (error) { platformDatabase.exec('ROLLBACK'); throw error; }
}
legacy.exec('DELETE FROM admin_sessions');

if (!platformDatabase.prepare("SELECT name FROM platform_migrations WHERE name='finite-storage-quotas'").get()) {
  platformDatabase.exec('BEGIN IMMEDIATE');
  try {
    platformDatabase.prepare('UPDATE users SET quota_bytes=? WHERE quota_bytes=0').run(defaultQuotaBytes);
    platformDatabase.prepare('UPDATE invitations SET quota_bytes=? WHERE quota_bytes=0').run(defaultQuotaBytes);
    platformDatabase.prepare("INSERT INTO platform_migrations VALUES ('finite-storage-quotas')").run();
    platformDatabase.exec('COMMIT');
  } catch (error) { platformDatabase.exec('ROLLBACK'); throw error; }
}

if (!platformDatabase.prepare("SELECT name FROM platform_migrations WHERE name='profile-cover'").get()) {
  platformDatabase.exec('BEGIN IMMEDIATE');
  try {
    platformDatabase.exec('ALTER TABLE users ADD COLUMN cover_key TEXT; ALTER TABLE users ADD COLUMN cover_size INTEGER NOT NULL DEFAULT 0 CHECK (cover_size >= 0)');
    platformDatabase.prepare("INSERT INTO platform_migrations VALUES ('profile-cover')").run();
    platformDatabase.exec('COMMIT');
  } catch (error) { platformDatabase.exec('ROLLBACK'); throw error; }
}

if (!platformDatabase.prepare("SELECT name FROM platform_migrations WHERE name='profile-site-and-aliases'").get()) {
  platformDatabase.exec('BEGIN IMMEDIATE');
  try {
    platformDatabase.exec(`ALTER TABLE users ADD COLUMN site_name TEXT NOT NULL DEFAULT '';
      UPDATE users SET site_name=display_name;
      CREATE TABLE public_id_aliases (public_id TEXT PRIMARY KEY COLLATE NOCASE, user_id INTEGER NOT NULL REFERENCES users(id));`);
    platformDatabase.prepare("INSERT INTO platform_migrations VALUES ('profile-site-and-aliases')").run();
    platformDatabase.exec('COMMIT');
  } catch (error) { platformDatabase.exec('ROLLBACK'); throw error; }
}

if (!platformDatabase.prepare("SELECT name FROM platform_migrations WHERE name='profile-introduction'").get()) {
  platformDatabase.exec('BEGIN IMMEDIATE');
  try {
    platformDatabase.exec("ALTER TABLE users ADD COLUMN introduction TEXT NOT NULL DEFAULT ''; ALTER TABLE users ADD COLUMN region TEXT NOT NULL DEFAULT ''");
    platformDatabase.prepare("INSERT INTO platform_migrations VALUES ('profile-introduction')").run();
    platformDatabase.exec('COMMIT');
  } catch (error) { platformDatabase.exec('ROLLBACK'); throw error; }
}

if (!platformDatabase.prepare("SELECT name FROM platform_migrations WHERE name='directory-cover'").get()) {
  platformDatabase.exec('BEGIN IMMEDIATE');
  try {
    platformDatabase.exec('ALTER TABLE users ADD COLUMN directory_cover_key TEXT; ALTER TABLE users ADD COLUMN directory_cover_size INTEGER NOT NULL DEFAULT 0 CHECK (directory_cover_size >= 0); ALTER TABLE users ADD COLUMN show_photo_names INTEGER NOT NULL DEFAULT 0 CHECK (show_photo_names IN (0,1))');
    platformDatabase.prepare("INSERT INTO platform_migrations VALUES ('directory-cover')").run();
    platformDatabase.exec('COMMIT');
  } catch (error) { platformDatabase.exec('ROLLBACK'); throw error; }
}

platformDatabase.exec('BEGIN IMMEDIATE');
try {
  if (!platformDatabase.prepare("SELECT name FROM platform_migrations WHERE name='subscriptions'").get()) {
    platformDatabase.exec(`ALTER TABLE users ADD COLUMN subscription_plan TEXT CHECK (subscription_plan IN ('monthly','quarterly','yearly'));
      ALTER TABLE users ADD COLUMN subscription_expires_at INTEGER;
      ALTER TABLE users ADD COLUMN subscription_reminded_on TEXT;
      ALTER TABLE invitations ADD COLUMN subscription_plan TEXT CHECK (subscription_plan IN ('monthly','quarterly','yearly'));
      ALTER TABLE invitations ADD COLUMN duration_days INTEGER CHECK (duration_days > 0);
      CREATE TABLE subscription_redemptions (
        invitation_id TEXT PRIMARY KEY REFERENCES invitations(id),
        user_id INTEGER NOT NULL REFERENCES users(id),
        plan_id TEXT NOT NULL,
        duration_days INTEGER NOT NULL CHECK (duration_days > 0),
        previous_plan TEXT,
        previous_expires_at INTEGER,
        expires_at INTEGER NOT NULL,
        previous_quota_bytes INTEGER NOT NULL,
        quota_bytes INTEGER NOT NULL,
        redeemed_at TEXT NOT NULL
      );
      CREATE INDEX subscription_redemptions_user ON subscription_redemptions(user_id,redeemed_at);
      INSERT INTO platform_migrations VALUES ('subscriptions');`);
  }
  platformDatabase.exec('COMMIT');
} catch (error) { platformDatabase.exec('ROLLBACK'); throw error; }

export function getPublicAccount(publicId) {
  return platformDatabase.prepare('SELECT * FROM users WHERE (public_id=? OR id=(SELECT user_id FROM public_id_aliases WHERE public_id=?)) AND is_active=1 AND deleted_at IS NULL').get(publicId, publicId);
}

export function publicAccount(account) {
  return {
    id: account.id, loginId: account.login_id, publicId: account.public_id,
    displayName: account.display_name, siteName: account.site_name, bio: account.bio, introduction: account.introduction, region: account.region, role: account.role,
    active: account.is_active === 1, listed: account.listed === 1,
    subscriptionPlan: account.subscription_plan, subscriptionExpiresAt: account.subscription_expires_at,
    quotaBytes: account.quota_bytes, avatarUrl: account.avatar_key ? `/api/avatars/${account.public_id}` : '',
    coverUrl: account.cover_key ? `/api/covers/${account.public_id}` : '',
    directoryCoverUrl: account.directory_cover_key ? `/api/directory-covers/${account.public_id}` : '',
    showPhotoNames: account.show_photo_names === 1,
    createdAt: account.created_at, deletedAt: account.deleted_at,
  };
}
