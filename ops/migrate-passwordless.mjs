import { DatabaseSync, backup } from 'node:sqlite';
import { chmod } from 'node:fs/promises';
import { resolve } from 'node:path';

// Run once with the application stopped. Runtime code accepts only schema version 2.
const path = process.argv[2];
if (!path) throw new Error('Usage: node ops/migrate-passwordless.mjs <database>');
process.umask(0o077);
const db = new DatabaseSync(resolve(path), { open: true });
try {
  const version = Number(db.prepare('PRAGMA user_version').get().user_version);
  if (version !== 1) throw new Error('Migration requires schema version 1.');
  const backupPath = `${resolve(path)}.before-passwordless-${Date.now()}`;
  await backup(db, backupPath);
  await chmod(backupPath, 0o600);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON; BEGIN IMMEDIATE');
  try {
    db.exec(`
      CREATE TABLE email_accounts (email TEXT PRIMARY KEY, subject TEXT NOT NULL UNIQUE) STRICT;
      INSERT INTO email_accounts (email, subject)
        SELECT email, subject FROM local_credentials WHERE instr(email, '@') > 1;
      DELETE FROM sessions WHERE provider = 'local';
      UPDATE social_accounts SET provider = 'email' WHERE provider = 'local';
      UPDATE request_links SET recipient_provider = 'email' WHERE recipient_provider = 'local';
      CREATE TABLE email_challenges (
        token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, code_hash TEXT NOT NULL,
        expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      DROP TABLE local_credentials;
      PRAGMA user_version = 2;
    `);
    if (db.prepare('PRAGMA foreign_key_check').all().length)
      throw new Error('Invalid references after migration.');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');
  console.log('Schema upgraded to version 2. Existing requests and accounts retained.');
  console.log(`Private backup: ${backupPath}`);
} finally {
  db.close();
}
