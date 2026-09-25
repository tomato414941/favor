import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { settlementSchema } from '../src/server/settlement-schema.ts';

const path = process.argv[2];
if (!path || !existsSync(path)) throw new Error('Usage: node scripts/migrate-v10.mjs <database>');
process.umask(0o077);
const db = new DatabaseSync(resolve(path));
try {
  if (db.prepare('PRAGMA user_version').get().user_version !== 9)
    throw new Error('Expected schema version 9.');
  const backup = `${resolve(path)}.v9.${Date.now()}.sqlite`;
  db.prepare('VACUUM INTO ?').run(backup);
  db.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE');
  try {
    db.exec(settlementSchema);
    db.exec('PRAGMA user_version = 10; COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  console.log(`Schema 10 ready. Backup: ${backup}`);
} finally {
  db.close();
}
