import { DatabaseSync, backup } from 'node:sqlite';
import { chmod } from 'node:fs/promises';
import { resolve } from 'node:path';

// Run once with the application stopped. Runtime code accepts only schema version 4.
const path = process.argv[2];
if (!path) throw new Error('Usage: node ops/migrate-email-delivery.mjs <database>');
process.umask(0o077);
const db = new DatabaseSync(resolve(path), { open: true });
try {
  const version = Number(db.prepare('PRAGMA user_version').get().user_version);
  if (version !== 3) throw new Error('Migration requires schema version 3.');
  const backupPath = `${resolve(path)}.before-schema-4-${Date.now()}`;
  await backup(db, backupPath);
  await chmod(backupPath, 0o600);
  db.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE');
  try {
    db.exec(`
      ALTER TABLE request_links ADD COLUMN delivery TEXT NOT NULL DEFAULT 'self' CHECK (delivery IN ('self', 'email'));
      ALTER TABLE request_links ADD COLUMN recipient_email TEXT;
      CREATE TABLE link_optouts (email TEXT PRIMARY KEY, at INTEGER NOT NULL) STRICT;
      PRAGMA user_version = 4;
    `);
    if (db.prepare('PRAGMA foreign_key_check').all().length)
      throw new Error('Invalid references after migration.');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  console.log('Schema upgraded to version 4. Existing links are marked as handed over by their senders.');
} finally {
  db.close();
}
