import { sqlite } from './database.mjs';
import { platformDatabase, defaultQuotaBytes } from './platform-database.mjs';
import { hashPassword } from './auth.mjs';

let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 4096) throw new Error('Administrator input is too large.');
}
const { username, password } = JSON.parse(input);
if (typeof username !== 'string' || !username.trim() || username.length > 80 || typeof password !== 'string' || password.length < 12 || password.length > 256) throw new Error('Use an account name and a password of 12–256 characters.');
const passwordHash = hashPassword(password);
sqlite.exec('BEGIN IMMEDIATE');
try {
  sqlite.prepare('INSERT INTO admin_account (id, username, password_hash) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET username = excluded.username, password_hash = excluded.password_hash').run(username.trim(), passwordHash);
  sqlite.exec('DELETE FROM admin_sessions');
  sqlite.exec('COMMIT');
} catch (error) {
  sqlite.exec('ROLLBACK');
  throw error;
}
platformDatabase.exec('BEGIN IMMEDIATE');
try {
  platformDatabase.prepare("INSERT INTO users (id,login_id,public_id,storage_id,password_hash,display_name,site_name,role,quota_bytes,created_at) VALUES (1,?,'yangyu','legacy-owner',?,'旸隅','旸隅','admin',?,?) ON CONFLICT(id) DO UPDATE SET login_id=excluded.login_id,password_hash=excluded.password_hash,is_active=1,deleted_at=NULL")
    .run(username.trim(),passwordHash,defaultQuotaBytes,new Date().toISOString());
  platformDatabase.prepare('DELETE FROM sessions WHERE user_id=1').run();
  platformDatabase.exec('COMMIT');
} catch (error) { platformDatabase.exec('ROLLBACK'); throw error; }
sqlite.close();
platformDatabase.close();
console.log('Administrator configured. Existing sessions have been signed out.');
