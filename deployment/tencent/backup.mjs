import { backup, DatabaseSync } from 'node:sqlite';
import { mkdir, readdir, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getAccountGallery, closeDatabases } from './database.mjs';
import { platformDatabase } from './platform-database.mjs';
import { dataDirectory } from './config.mjs';

const directory = resolve(dataDirectory, 'backups');
const stamp = new Date().toISOString().replaceAll(':', '-');
async function backupDatabase(database, name) {
  const folder = resolve(directory,name);
  await mkdir(folder,{recursive:true});
  const snapshot=resolve(folder,`snapshot-${stamp}.sqlite`);
  await backup(database,snapshot);
  const files=(await readdir(folder)).filter(file=>/^snapshot-.*\.sqlite$/.test(file)).sort().reverse();
  for(const file of files.slice(14)) await unlink(resolve(folder,file));
  return snapshot;
}
const catalogSnapshot=await backupDatabase(platformDatabase,'platform');
const catalog=new DatabaseSync(catalogSnapshot,{readOnly:true});
const accounts=catalog.prepare('SELECT id,storage_id FROM users').all();
catalog.close();
for(const account of accounts) await backupDatabase(getAccountGallery(account.id,account.storage_id).sqlite,account.id === 1 ? 'photographer-1' : `photographer-${account.storage_id}`);
closeDatabases();
platformDatabase.close();
console.log('Platform and photographer databases backed up; retained 14 snapshots per database.');
