import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

export class Store {
  readonly db: DatabaseSync;
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL,
        points INTEGER NOT NULL CHECK (points >= 0)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES users(id),
        creator_id TEXT NOT NULL REFERENCES users(id), genre TEXT NOT NULL,
        brief TEXT NOT NULL, amount INTEGER NOT NULL CHECK (amount > 0),
        visibility TEXT NOT NULL, nsfw INTEGER NOT NULL, state TEXT NOT NULL,
        created_at INTEGER NOT NULL, accept_by INTEGER NOT NULL, deliver_by INTEGER NOT NULL,
        cancelled_reason TEXT, delivery_version INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE TABLE IF NOT EXISTS payments (
        request_id TEXT PRIMARY KEY REFERENCES requests(id), method TEXT NOT NULL,
        state TEXT NOT NULL, amount INTEGER NOT NULL,
        hold_until INTEGER NOT NULL, capture_requested INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE TABLE IF NOT EXISTS effects (
        request_id TEXT NOT NULL REFERENCES requests(id), operation TEXT NOT NULL,
        created_at INTEGER NOT NULL, PRIMARY KEY (request_id, operation)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS commands (
        actor_id TEXT NOT NULL, scope TEXT NOT NULL, key TEXT NOT NULL,
        fingerprint TEXT NOT NULL, request_id TEXT NOT NULL REFERENCES requests(id),
        PRIMARY KEY (actor_id, scope, key)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS payment_events (
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES requests(id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES requests(id),
        version INTEGER NOT NULL, name TEXT NOT NULL, data BLOB NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY, request_id TEXT NOT NULL REFERENCES requests(id),
        actor_id TEXT NOT NULL, action TEXT NOT NULL, at INTEGER NOT NULL
      ) STRICT;
    `);
    const add = this.db.prepare('INSERT OR IGNORE INTO users (id, name, role, points) VALUES (?, ?, ?, ?)');
    add.run('demo-client', '青葉 / aoba', 'client', 50000);
    add.run('demo-creator', '凪 / nagi', 'creator', 0);
    add.run('other-client', '別の依頼者', 'client', 50000);
    add.run('other-creator', '別の作り手', 'creator', 0);
  }
  transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  close() { this.db.close(); }
}
