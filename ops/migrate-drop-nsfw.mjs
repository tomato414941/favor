import { DatabaseSync, backup } from 'node:sqlite';
import { chmod } from 'node:fs/promises';
import { resolve } from 'node:path';

// Run once with the application stopped. Runtime code accepts only schema version 3.
const path = process.argv[2];
if (!path) throw new Error('Usage: node ops/migrate-drop-nsfw.mjs <database>');
process.umask(0o077);
const db = new DatabaseSync(resolve(path), { open: true });
try {
  const version = Number(db.prepare('PRAGMA user_version').get().user_version);
  if (version !== 2) throw new Error('Migration requires schema version 2.');
  const backupPath = `${resolve(path)}.before-schema-3-${Date.now()}`;
  await backup(db, backupPath);
  await chmod(backupPath, 0o600);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON; BEGIN IMMEDIATE');
  try {
    db.exec(`
      ALTER TABLE requests DROP COLUMN nsfw;
      ALTER TABLE request_links DROP COLUMN nsfw;
      PRAGMA user_version = 3;
    `);
    if (db.prepare('PRAGMA foreign_key_check').all().length)
      throw new Error('Invalid references after migration.');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');
  console.log('Schema upgraded to version 3. Existing requests and links retained.');
} finally {
  db.close();
}
